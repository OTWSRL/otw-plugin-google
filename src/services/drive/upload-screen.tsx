import { FormField, FormTable, SubmitButton } from '@otwdesign/admin-ui'
import type { AdminPageContext, AdminPageProps, PluginContext } from '@otwdesign/sdk'
import { GoogleError } from '../../google'
import { NoAccount } from '../../screens/no-account'
import { AccountSwitch, GoogleProblem, GoogleStyles } from '../../screens/parts'
import { serviceAccounts, type ServiceAccounts } from '../shared'
import { DRIVE, FILE_ID, getFile, ROOT, type DriveFile } from './client'

// The screen that uploads from the person's computer into a Drive folder. The file goes from the
// browser to Drive itself, by the plugin's uploader script; `./upload-api` opens the upload.

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

export interface UploadData {
  found: ServiceAccounts
  /** The folder the file goes into, when Drive still has it. */
  folder: DriveFile | null
  folderId: string
  problem: GoogleError | null
}

export async function loadUpload(
  cms: PluginContext,
  { user, searchParams }: AdminPageContext,
): Promise<UploadData | null> {
  const found = await serviceAccounts(cms, user, DRIVE, first(searchParams.account))
  if (!found) return null
  const asked = first(searchParams.folder) ?? ''
  const folderId = FILE_ID.test(asked) ? asked : ROOT
  const data: UploadData = { found, folder: null, folderId, problem: null }
  if (!found.current) return data
  try {
    const folder = await getFile(cms, user.id, found.current.id, folderId)
    return folder.kind === 'folder' ? { ...data, folder } : null
  } catch (error) {
    if (!(error instanceof GoogleError)) throw error
    return { ...data, problem: error }
  }
}

export function UploadScreen({ cms, data }: AdminPageProps<UploadData> & { cms: PluginContext }) {
  const account = data.found.current
  const here = cms.admin.url('/drive/upload')
  const back = account
    ? `${cms.admin.url('/drive')}?${new URLSearchParams({ account: account.id, folder: data.folderId })}`
    : cms.admin.url('/drive')
  return (
    <>
      <GoogleStyles />
      {data.problem && <GoogleProblem error={data.problem} />}
      {!account ? (
        <NoAccount cms={cms} found={data.found} here={here} />
      ) : (
        <AccountSwitch
          label="Account"
          action={here}
          accounts={data.found.accounts}
          current={account.id}
        />
      )}
      <p>
        <a href={back}>← Drive</a>
      </p>
      {account && data.folder && (
        <>
          {/* No action: the script sends the file to Drive itself, then tells this site it's done. */}
          <form
            className="g-upload"
            data-google-upload=""
            data-open={cms.routes.apiUrl('/drive/uploads')}
            data-done={cms.routes.apiUrl('/drive/uploads/done')}
          >
            <input type="hidden" name="account" value={account.id} />
            <input type="hidden" name="folder" value={data.folderId} />
            <FormTable>
              <FormField label="Into">
                {data.folderId === ROOT ? 'My Drive' : data.folder.name}
              </FormField>
              <FormField
                label="The file"
                htmlFor="g-drive-file"
                description="It goes from your browser straight to Google Drive. This site never holds the file, so its upload limit doesn’t apply."
              >
                <input id="g-drive-file" type="file" required />
              </FormField>
            </FormTable>
            <progress hidden style={{ display: 'block', width: '100%', maxWidth: 420 }} />
            <p data-upload-status="" role="status" />
            <SubmitButton>Upload</SubmitButton>
            <noscript>
              <p>Uploading needs JavaScript, to send the file to Drive from your browser.</p>
            </noscript>
          </form>
          <script src={cms.routes.apiUrl('/upload.js')} async />
        </>
      )}
    </>
  )
}
