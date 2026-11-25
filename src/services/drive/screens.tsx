import { FormButton, ListTable, TableNav, Views } from '@otwdesign/admin-ui'
import type { AdminPageContext, AdminPageProps, PluginContext } from '@otwdesign/sdk'
import type { ReactNode } from 'react'
import { GoogleError } from '../../google'
import { AccountSwitch, GoogleProblem, GoogleStyles, longDate } from '../../screens/parts'
import { NoAccount } from '../../screens/no-account'
import { serviceAccounts, type ServiceAccounts } from '../shared'
import { previewable } from './api'
import {
  cleanQuery,
  DRIVE,
  FILE_ID,
  folderPath,
  formatBytes,
  listFiles,
  MAX_NAME_LENGTH,
  MAX_QUERY_LENGTH,
  problemText,
  ROOT,
  storageQuota,
  type DriveFile,
  type DriveListing,
  type DriveQuota,
} from './client'

// The Drive screen: one folder, a search or the trash of one of the person's Google accounts.
// Links and plain forms only, so it sends no script to the browser.

export interface DriveData {
  found: ServiceAccounts
  mode: 'folder' | 'search' | 'trash'
  /** The folder shown: an id, or `root`. */
  folder: string
  query: string
  /** Google's token for the page shown; `null` on the first. */
  page: string | null
  listing: DriveListing | null
  /** The folder and those above it, the top first; `null` at the top, in a search and in the trash. */
  path: { folders: DriveFile[]; complete: boolean } | null
  quota: DriveQuota | null
  /** What Google said instead of a listing. */
  error: GoogleError | null
  /** Whether the person may add files to the Media library. */
  canUpload: boolean
  /** Whether YouTube is switched on, for "Send to YouTube". */
  youtube: boolean
}

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

export async function loadDrive(
  cms: PluginContext,
  { user, searchParams }: AdminPageContext,
): Promise<DriveData | null> {
  const found = await serviceAccounts(cms, user, DRIVE, first(searchParams.account))
  if (!found) return null
  const asked = first(searchParams.folder) ?? ''
  const folder = FILE_ID.test(asked) ? asked : ROOT
  const query = cleanQuery(first(searchParams.q) ?? '')
  const mode = first(searchParams.view) === 'trash' ? 'trash' : query ? 'search' : 'folder'
  const page = first(searchParams.page) || null
  const data: DriveData = {
    found,
    mode,
    folder,
    query: mode === 'search' ? query : '',
    page,
    listing: null,
    path: null,
    quota: null,
    error: null,
    canUpload: cms.auth.can(user, 'core.upload_files'),
    youtube: cms.settings.get('google.youtube') !== false,
  }
  const account = found.current
  if (!account) return data
  try {
    const view =
      mode === 'trash' ? { trash: true as const } : query ? { search: query } : { in: folder }
    const [listing, path, quota] = await Promise.all([
      listFiles(cms, user.id, account.id, view, page),
      mode === 'folder' && folder !== ROOT ? folderPath(cms, user.id, account.id, folder) : null,
      // The storage line is a nicety: without it the screen still shows the files.
      storageQuota(cms, user.id, account.id).catch((error: unknown) => {
        if (error instanceof GoogleError) return null
        throw error
      }),
    ])
    return { ...data, listing, path, quota }
  } catch (error) {
    if (!(error instanceof GoogleError)) throw error
    return { ...data, error }
  }
}

function DriveStyles() {
  return (
    <style href="otw-google-drive" precedence="default">{`
.cms-admin .g-crumbs{margin:14px 0 0;font-size:14px}
.cms-admin .g-crumbs b{color:var(--wp-heading)}
.cms-admin .g-file{display:flex;align-items:center;gap:8px}
.cms-admin .g-file svg{flex:none;width:20px;height:20px}
.cms-admin .g-file .row-title{font-weight:600;text-decoration:none}
.cms-admin .g-new{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:12px 0 0}
.cms-admin .g-new input[type='text']{min-height:32px;line-height:30px}
.cms-admin .g-rename{display:inline-block}
.cms-admin .g-rename summary{display:inline;cursor:pointer;color:var(--wp-highlight)}
.cms-admin .g-rename form{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
.cms-admin .g-pages{display:flex;gap:8px;margin:10px 0 0}
.cms-admin .g-used{margin:10px 0 0;color:var(--wp-muted)}
`}</style>
  )
}

const ICONS = {
  folder: <path d="M2 5.500h5.500l1.600 2H18v8.500H2Z" fill="#8c8f94" />,
  google: <path d="M4 2h8l4 4v12H4Z" fill="#3858e9" />,
  video: (
    <path d="M2.500 4h15v12h-15ZM8.200 7.200v5.600L13 10Z" fill="#d63638" fillRule="evenodd" />
  ),
  image: (
    <path
      d="M2.500 4h15v12h-15ZM4.500 14l3.600-4.400 2.600 3 1.800-1.800 3 3.200Z"
      fill="#9a4d00"
      fillRule="evenodd"
    />
  ),
  file: <path d="M4 2h8l4 4v12H4Z" fill="#646970" />,
} as const

function icon(file: DriveFile): ReactNode {
  const kind =
    file.kind !== 'file'
      ? file.kind
      : file.mimeType.startsWith('video/')
        ? 'video'
        : file.mimeType.startsWith('image/')
          ? 'image'
          : 'file'
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
      {ICONS[kind]}
    </svg>
  )
}

export function DriveScreen({ cms, data }: AdminPageProps<DriveData> & { cms: PluginContext }) {
  const here = cms.admin.url('/drive')
  const account = data.found.current
  if (!account) {
    return (
      <>
        <GoogleStyles />
        <NoAccount cms={cms} found={data.found} here={here} />
      </>
    )
  }
  /** This screen's address for the account shown, with whatever else is asked for. */
  const link = (params: Record<string, string | undefined> = {}) => {
    const query = new URLSearchParams({ account: account.id })
    for (const [name, value] of Object.entries(params)) if (value) query.set(name, value)
    return `${here}?${query}`
  }
  const action = (name: string) => cms.admin.actionUrl(`drive-${name}`)
  const bytesUrl = (file: DriveFile, kind: 'download' | 'preview') =>
    `${cms.routes.apiUrl(`/drive/files/${file.id}/${kind}`)}?${new URLSearchParams({ account: account.id })}`
  const files = data.listing?.files ?? []
  const trash = data.mode === 'trash'
  const path = data.path

  const rowActions = (file: DriveFile): ReactNode[] => {
    if (trash) {
      return [
        <FormButton
          key="restore"
          action={action('restore')}
          fields={{ account: account.id, ids: file.id }}
          variant="link"
        >
          Restore
        </FormButton>,
      ]
    }
    return [
      ...(file.kind === 'folder'
        ? [
            <a key="open" href={link({ folder: file.id })}>
              Open
            </a>,
          ]
        : []),
      ...(file.kind === 'google' && file.viewLink
        ? [
            <a key="google" href={file.viewLink} target="_blank" rel="noopener noreferrer">
              Open in Google
            </a>,
          ]
        : []),
      ...(file.kind === 'file' && previewable(file.mimeType)
        ? [
            <a
              key="preview"
              href={bytesUrl(file, 'preview')}
              target="_blank"
              rel="noopener noreferrer"
            >
              Preview
            </a>,
          ]
        : []),
      ...(file.kind === 'file'
        ? [
            <a key="download" href={bytesUrl(file, 'download')}>
              Download
            </a>,
          ]
        : []),
      <details key="rename" className="g-rename">
        <summary>Rename</summary>
        <form method="post" action={action('rename')}>
          <input type="hidden" name="account" value={account.id} />
          <input type="hidden" name="id" value={file.id} />
          <label className="screen-reader-text" htmlFor={`g-name-${file.id}`}>
            New name for {file.name}
          </label>
          <input
            id={`g-name-${file.id}`}
            type="text"
            name="name"
            defaultValue={file.name}
            maxLength={MAX_NAME_LENGTH}
            required
          />
          <button type="submit" className="button button-small">
            Rename
          </button>
        </form>
      </details>,
      ...(file.kind === 'file' && file.mimeType.startsWith('video/') && data.youtube
        ? [
            <a
              key="youtube"
              href={`${cms.admin.url('/youtube/upload')}?${new URLSearchParams({ account: account.id, drive: file.id })}`}
            >
              Send to YouTube
            </a>,
          ]
        : []),
      ...(file.kind === 'file' && data.canUpload
        ? [
            <FormButton
              key="media"
              action={action('to-media')}
              fields={{ account: account.id, id: file.id }}
              variant="link"
            >
              Copy to Media library
            </FormButton>,
          ]
        : []),
      <FormButton
        key="trash"
        action={action('trash')}
        fields={{ account: account.id, ids: file.id }}
        variant="delete"
      >
        Move to trash
      </FormButton>,
    ]
  }

  return (
    <>
      <GoogleStyles />
      <DriveStyles />
      <AccountSwitch
        label="Account"
        action={here}
        current={account.id}
        accounts={data.found.accounts.map(({ account: item, usable }) => ({
          account: item,
          usable,
          label: usable ? item.email : `${item.email} (Drive not allowed yet)`,
        }))}
      >
        <p className="search-box">
          <label className="screen-reader-text" htmlFor="g-drive-search">
            Search Drive
          </label>
          <input
            id="g-drive-search"
            type="search"
            name="q"
            defaultValue={data.query}
            maxLength={MAX_QUERY_LENGTH}
          />{' '}
          <button type="submit" className="button button-compact">
            Search Drive
          </button>
        </p>
      </AccountSwitch>
      <Views
        label="Drive"
        views={[
          { label: 'My Drive', href: link(), current: !trash },
          { label: 'Trash', href: link({ view: 'trash' }), current: trash },
        ]}
      />

      {data.mode === 'folder' && (
        <p className="g-crumbs">
          {path ? (
            <>
              <a href={link()}>My Drive</a>
              {!path.complete && ' › …'}
              {/* The top folder is "My Drive" itself, which the first link already is. */}
              {path.folders.slice(path.complete ? 1 : 0).map((folder, index, shown) => (
                <span key={folder.id}>
                  {' › '}
                  {index === shown.length - 1 ? (
                    <b>{folder.name}</b>
                  ) : (
                    <a href={link({ folder: folder.id })}>{folder.name}</a>
                  )}
                </span>
              ))}
            </>
          ) : (
            <b>My Drive</b>
          )}
        </p>
      )}
      {data.mode === 'search' && (
        <p className="g-crumbs">
          Files whose name contains <b>{data.query}</b>. <a href={link()}>Back to My Drive</a>
        </p>
      )}

      {data.error ? (
        <GoogleProblem
          error={
            data.error.kind === 'refused'
              ? new GoogleError('refused', problemText(data.error), data.error.status)
              : data.error
          }
          reconnect={`${cms.routes.apiUrl('/oauth/start')}?${new URLSearchParams({ service: DRIVE, account: account.id, next: here })}`}
        />
      ) : (
        <>
          {data.mode === 'folder' && (
            <form method="post" action={action('new-folder')} className="g-new">
              <input type="hidden" name="account" value={account.id} />
              <input type="hidden" name="parent" value={data.folder} />
              <label htmlFor="g-new-folder">New folder</label>
              <input
                id="g-new-folder"
                type="text"
                name="name"
                maxLength={MAX_NAME_LENGTH}
                required
              />
              <button type="submit" className="button button-compact">
                Create
              </button>
            </form>
          )}
          {/* The ticked rows belong to this form by its id: the rows' own buttons are forms too,
              and a form can't sit inside another. */}
          <form id="g-drive-bulk" method="post" action={action(trash ? 'restore' : 'trash')}>
            <input type="hidden" name="account" value={account.id} />
            <TableNav total={files.length} noun={['item', 'items']}>
              <button type="submit" className="button">
                {trash ? 'Restore the ticked' : 'Move the ticked to trash'}
              </button>
            </TableNav>
          </form>
          <ListTable
            caption={trash ? 'Files in the trash' : 'Files'}
            rows={files}
            rowKey={(file) => file.id}
            rowActions={rowActions}
            columns={[
              {
                key: 'tick',
                label: 'Tick',
                render: (file) => (
                  <input
                    type="checkbox"
                    name="ids"
                    value={file.id}
                    form="g-drive-bulk"
                    aria-label={`Tick ${file.name}`}
                  />
                ),
              },
              {
                key: 'name',
                label: 'Name',
                primary: true,
                render: (file) => (
                  <div className="g-file">
                    {icon(file)}
                    {file.kind === 'folder' && !trash ? (
                      <a className="row-title" href={link({ folder: file.id })}>
                        {file.name}
                      </a>
                    ) : (
                      <span className="row-title">{file.name}</span>
                    )}
                  </div>
                ),
              },
              { key: 'owner', label: 'Owner', render: (file) => file.owner || '—' },
              {
                key: 'modified',
                label: 'Last modified',
                render: (file) =>
                  file.modified ? <span className="num">{longDate(file.modified)}</span> : '—',
              },
              {
                key: 'size',
                label: 'Size',
                numeric: true,
                render: (file) => (file.size === null ? '—' : formatBytes(file.size)),
              },
            ]}
            empty={
              trash
                ? 'The trash is empty.'
                : data.mode === 'search'
                  ? 'No file’s name contains that.'
                  : 'This folder is empty.'
            }
          />
          {(data.page || data.listing?.next) && (
            <p className="g-pages">
              {data.page && (
                <a
                  className="button"
                  href={link({
                    folder:
                      data.mode === 'folder' && data.folder !== ROOT ? data.folder : undefined,
                    q: data.query,
                    view: trash ? 'trash' : undefined,
                  })}
                >
                  First page
                </a>
              )}
              {data.listing?.next && (
                <a
                  className="button"
                  href={link({
                    folder:
                      data.mode === 'folder' && data.folder !== ROOT ? data.folder : undefined,
                    q: data.query,
                    view: trash ? 'trash' : undefined,
                    page: data.listing.next,
                  })}
                >
                  Next page
                </a>
              )}
            </p>
          )}
        </>
      )}
      {data.quota && (
        <p className="g-used num">
          {formatBytes(data.quota.used)}
          {data.quota.limit === null ? '' : ` of ${formatBytes(data.quota.limit)}`} used in this
          Google account.
        </p>
      )}
    </>
  )
}
