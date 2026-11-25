import { FormField, FormTable, SubmitButton } from '@otwdesign/admin-ui'
import type { AdminPageContext, AdminPageProps, ApiContext, PluginContext } from '@otwdesign/sdk'
import { USE } from '../../config'
import { GoogleError } from '../../google'
import { siteOrigin } from '../../runtime'
import { AccountSwitch, GoogleProblem, GoogleStyles } from '../../screens/parts'
import { NoAccount, requireAccount, serviceAccounts, type ServiceAccounts } from '../shared'
import {
  cleanName,
  DRIVE,
  FILE_ID,
  getFile,
  MAX_UPLOAD_BYTES,
  openUpload,
  ROOT,
  type DriveFile,
} from './client'

// Uploading from the person's computer into a Drive folder: the screen with the form, and the
// two requests its script makes. The file goes from the browser to Drive itself; this site opens
// the upload, checks whose it is, and never holds a byte of it.

const MAX_BODY_BYTES = 16 * 1024
/** A media type as browsers send it, or none at all for a file they don't know. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,100}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,100}$/i

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

const refuse = (status: number, error: string) =>
  Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } })

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** The request's JSON object, read up to a size; `null` for anything else. */
async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) return null
  if (Number(request.headers.get('content-length') ?? '0') > MAX_BODY_BYTES) return null
  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) return null
  try {
    const body: unknown = JSON.parse(raw)
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** The signed-in person's own account and the folder the request names, or the answer that refuses it. */
async function asked(cms: PluginContext, context: ApiContext, body: Record<string, unknown>) {
  const user = await context.user()
  if (!user || !cms.auth.can(user, USE)) return refuse(403, 'Sign in again to upload.')
  const account = await requireAccount(cms, user, DRIVE, text(body.account))
  if (!account) return refuse(404, 'That Google account can’t use Drive here any more.')
  const folder = text(body.folder) || ROOT
  if (!FILE_ID.test(folder)) return refuse(400, 'That folder isn’t there any more.')
  return { user, account, folder }
}

/** `POST /drive/uploads`: opens an upload for a file the browser is about to send to Drive. */
export async function openRoute(
  cms: PluginContext,
  request: Request,
  context: ApiContext,
): Promise<Response> {
  const body = await jsonBody(request)
  if (!body) return refuse(415, 'Send JSON.')
  const who = await asked(cms, context, body)
  if (who instanceof Response) return who
  const name = cleanName(text(body.name))
  if (!name) return refuse(400, 'The file needs a name.')
  const bytes = typeof body.bytes === 'number' ? body.bytes : NaN
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_UPLOAD_BYTES) {
    return refuse(400, 'Drive takes files up to 5 TB, and not empty ones.')
  }
  // A browser sends no type for a file it doesn't know: Drive then works it out itself.
  const type = text(body.type) || 'application/octet-stream'
  if (!MEDIA_TYPE.test(type)) return refuse(400, 'That file’s type can’t be read.')
  try {
    const url = await openUpload(cms, who.user.id, who.account.id, {
      name,
      parent: who.folder,
      bytes,
      type,
      origin: siteOrigin(cms, request),
    })
    cms.logger.info('A Drive upload was opened', { by: who.user.id, bytes })
    return Response.json({ url }, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    if (!(error instanceof GoogleError)) throw error
    return refuse(error.kind === 'not_found' ? 404 : 502, error.message)
  }
}

/** `POST /drive/uploads/done`: where the browser goes once Drive has the file: back to its folder. */
export async function doneRoute(
  cms: PluginContext,
  request: Request,
  context: ApiContext,
): Promise<Response> {
  const body = await jsonBody(request)
  if (!body) return refuse(415, 'Send JSON.')
  const who = await asked(cms, context, body)
  if (who instanceof Response) return who
  const query = new URLSearchParams({ account: who.account.id, folder: who.folder, uploaded: '1' })
  return Response.json(
    { redirect: `${cms.admin.url('/drive')}?${query}` },
    { headers: { 'cache-control': 'no-store' } },
  )
}
