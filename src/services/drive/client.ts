import type { PluginContext } from '@otwdesign/sdk'
import { googleFetch, googleJson } from '../../accounts'
import { apiAnswer, GoogleError, googleUrl, isGoogleUrl } from '../../google'

// Google Drive's API, as the Drive screen uses it. Every call names the person and the account,
// so an account is used only by its owner. What Google returns is checked before it's used: an
// id, a name or a link from Drive is someone else's writing.

/** The service's id in the `google.services` registry. */
export const DRIVE = 'drive'
/** A Drive id as this plugin takes it: from an address, a form, or Google's own answer. */
export const FILE_ID = /^[A-Za-z0-9_-]{1,200}$/
/** Drive's name for a person's top folder. */
export const ROOT = 'root'
export const FOLDER_TYPE = 'application/vnd.google-apps.folder'
const GOOGLE_TYPE = 'application/vnd.google-apps.'

export const MAX_NAME_LENGTH = 255
export const MAX_QUERY_LENGTH = 200
const MAX_PAGE_TOKEN_LENGTH = 4000
export const PAGE_SIZE = 50
/** How far up a folder's parents are followed for its breadcrumbs: one request each. */
const MAX_DEPTH = 8
/** A download may take as long as its bytes need, within reason. */
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000

const FIELDS =
  'id,name,mimeType,size,modifiedTime,trashed,parents,webViewLink,ownedByMe,owners(displayName,emailAddress)'

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  /** A folder, one of Google's own documents (which have no bytes), or a file. */
  kind: 'folder' | 'google' | 'file'
  /** In bytes; `null` for folders and Google's documents. */
  size: number | null
  modified: Date | null
  /** Who owns it: "me", or their name. */
  owner: string
  ownedByMe: boolean
  parents: string[]
  trashed: boolean
  /** Where Google shows it, when that is one of Google's own https addresses. */
  viewLink: string | null
}

export interface DriveListing {
  files: DriveFile[]
  /** Google's token for the next page, or `null` on the last. */
  next: string | null
}

export interface DriveQuota {
  /** Bytes used in the Google account. */
  used: number
  /** The account's limit; `null` when it has none. */
  limit: number | null
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** A count of bytes from Google, which sends them as text; `null` for anything else. */
function bytes(value: unknown): number | null {
  const number = typeof value === 'string' && /^\d{1,18}$/.test(value) ? Number(value) : null
  return number !== null && Number.isSafeInteger(number) ? number : null
}

/** A name on one line: no control character, no more than a name's length. */
const oneLine = (value: string): string =>
  value
    .replace(/\p{Cc}+/gu, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH)

/** A link to one of Google's own pages over https, or `null`: a link from Drive is input too. */
export function googleLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  const google = url.hostname === 'google.com' || url.hostname.endsWith('.google.com')
  return url.protocol === 'https:' && google && !url.username && !url.password ? url.href : null
}

/** A file as Drive describes it, checked; `null` when it has no usable id. */
function fileOf(value: unknown): DriveFile | null {
  const raw = record(value)
  const id = text(raw.id)
  if (!FILE_ID.test(id)) return null
  const mimeType = text(raw.mimeType).slice(0, 200)
  const modified = new Date(text(raw.modifiedTime))
  const owner = record(Array.isArray(raw.owners) ? raw.owners[0] : undefined)
  const ownedByMe = raw.ownedByMe === true
  return {
    id,
    name: oneLine(text(raw.name)) || 'Untitled',
    mimeType,
    kind:
      mimeType === FOLDER_TYPE ? 'folder' : mimeType.startsWith(GOOGLE_TYPE) ? 'google' : 'file',
    size: bytes(raw.size),
    modified: Number.isNaN(modified.getTime()) ? null : modified,
    owner: ownedByMe
      ? 'me'
      : oneLine(text(owner.displayName) || text(owner.emailAddress)).slice(0, 100),
    ownedByMe,
    parents: (Array.isArray(raw.parents) ? raw.parents : []).filter(
      (parent): parent is string => typeof parent === 'string' && FILE_ID.test(parent),
    ),
    trashed: raw.trashed === true,
    viewLink: googleLink(raw.webViewLink),
  }
}

const filesUrl = (id = '') => googleUrl('www.googleapis.com', `/drive/v3/files${id && `/${id}`}`)

/** An id that can be one, or a `GoogleError` saying the file isn't there: never sent to Google. */
function checked(id: string): string {
  if (!FILE_ID.test(id)) throw new GoogleError('not_found', 'Google can’t find that any more.')
  return id
}

/** Text inside a quoted string of Drive's search language: its two special characters escaped. */
const quoted = (value: string): string => value.replace(/[\\']/g, '\\$&')

/** A search as typed, on one line and no longer than Drive needs. */
export const cleanQuery = (value: string): string =>
  value
    .replace(/\p{Cc}+/gu, ' ')
    .trim()
    .slice(0, MAX_QUERY_LENGTH)

/** A name as typed for a folder or a rename; empty when nothing usable is left. */
export const cleanName = (value: string): string => oneLine(value)

export type DriveView =
  | { in: string }
  /** Every file whose name contains the words, wherever it is. */
  | { search: string }
  | { trash: true }

function queryOf(view: DriveView): string {
  if ('trash' in view) return 'trashed = true'
  if ('search' in view)
    return `name contains '${quoted(cleanQuery(view.search))}' and trashed = false`
  return `'${checked(view.in)}' in parents and trashed = false`
}

/** One page of a folder, a search or the trash, folders first. */
export async function listFiles(
  cms: PluginContext,
  userId: string,
  accountId: string,
  view: DriveView,
  pageToken?: string | null,
): Promise<DriveListing> {
  const answer = record(
    await googleJson(cms, userId, accountId, filesUrl(), {
      query: {
        q: queryOf(view),
        fields: `nextPageToken,files(${FIELDS})`,
        orderBy: 'folder,name_natural',
        pageSize: PAGE_SIZE,
        spaces: 'drive',
        corpora: 'user',
        pageToken: pageToken && pageToken.length <= MAX_PAGE_TOKEN_LENGTH ? pageToken : undefined,
      },
    }),
  )
  const next = text(answer.nextPageToken)
  return {
    files: (Array.isArray(answer.files) ? answer.files : [])
      .map(fileOf)
      .filter((file): file is DriveFile => file !== null),
    next: next && next.length <= MAX_PAGE_TOKEN_LENGTH ? next : null,
  }
}

/** One file or folder by id. */
export async function getFile(
  cms: PluginContext,
  userId: string,
  accountId: string,
  id: string,
): Promise<DriveFile> {
  const file = fileOf(
    await googleJson(cms, userId, accountId, filesUrl(checked(id)), { query: { fields: FIELDS } }),
  )
  if (!file) throw new GoogleError('not_found', 'Google can’t find that any more.')
  return file
}

/**
 * A folder and the folders above it, the top one first, for breadcrumbs. Followed a few levels
 * up, one request each: `complete` says whether the top was reached.
 */
export async function folderPath(
  cms: PluginContext,
  userId: string,
  accountId: string,
  folderId: string,
): Promise<{ folders: DriveFile[]; complete: boolean }> {
  const folders: DriveFile[] = []
  let id: string | undefined = folderId
  for (let depth = 0; id && depth < MAX_DEPTH; depth++) {
    const folder: DriveFile = await getFile(cms, userId, accountId, id)
    folders.unshift(folder)
    id = folder.parents[0]
  }
  return { folders, complete: !id }
}

/** Makes a folder in `parent` (an id, or `root`). */
export async function createFolder(
  cms: PluginContext,
  userId: string,
  accountId: string,
  name: string,
  parent: string,
): Promise<DriveFile> {
  const made = fileOf(
    await googleJson(cms, userId, accountId, filesUrl(), {
      method: 'POST',
      query: { fields: FIELDS },
      json: { name: cleanName(name), mimeType: FOLDER_TYPE, parents: [checked(parent)] },
    }),
  )
  if (!made) throw new GoogleError('unavailable', 'Google’s answer couldn’t be read.')
  return made
}

async function patchFile(
  cms: PluginContext,
  userId: string,
  accountId: string,
  id: string,
  changes: { name?: string; trashed?: boolean },
): Promise<DriveFile> {
  const changed = fileOf(
    await googleJson(cms, userId, accountId, filesUrl(checked(id)), {
      method: 'PATCH',
      query: { fields: FIELDS },
      json: changes,
    }),
  )
  if (!changed) throw new GoogleError('unavailable', 'Google’s answer couldn’t be read.')
  return changed
}

export const renameFile = (
  cms: PluginContext,
  userId: string,
  accountId: string,
  id: string,
  name: string,
): Promise<DriveFile> => patchFile(cms, userId, accountId, id, { name: cleanName(name) })

/** Moves a file to Drive's trash, or back out of it. Nothing is deleted for good from here. */
export const setTrashed = (
  cms: PluginContext,
  userId: string,
  accountId: string,
  id: string,
  trashed: boolean,
): Promise<DriveFile> => patchFile(cms, userId, accountId, id, { trashed })

/** How much of the Google account's storage is used. */
export async function storageQuota(
  cms: PluginContext,
  userId: string,
  accountId: string,
): Promise<DriveQuota | null> {
  const answer = record(
    await googleJson(cms, userId, accountId, googleUrl('www.googleapis.com', '/drive/v3/about'), {
      query: { fields: 'storageQuota(limit,usage)' },
    }),
  )
  const quota = record(answer.storageQuota)
  const used = bytes(quota.usage)
  return used === null ? null : { used, limit: bytes(quota.limit) }
}

/** One range of bytes as a browser asks for it, or `null` for anything else. */
export function singleRange(header: string | null): string | null {
  return header && header.length <= 40 && /^bytes=(?:\d{1,15}-\d{0,15}|-\d{1,15})$/.test(header)
    ? header
    : null
}

/**
 * A file's bytes from Google, as a stream: the answer itself, so nothing is held in memory.
 * Google's error answers become a `GoogleError`.
 */
export async function downloadFile(
  cms: PluginContext,
  userId: string,
  accountId: string,
  id: string,
  range: string | null = null,
): Promise<Response> {
  const response = await googleFetch(cms, userId, accountId, filesUrl(checked(id)), {
    query: { alt: 'media' },
    headers: { accept: '*/*', ...(range ? { range } : {}) },
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
  })
  if (!response.ok) await apiAnswer(response)
  return response
}

/**
 * A file's bytes, whole, when there are no more than `limit` of them. The limit is kept while
 * reading, whatever size Google said: a longer answer is dropped, not held.
 */
export async function readFile(
  cms: PluginContext,
  userId: string,
  accountId: string,
  id: string,
  limit: number,
): Promise<Uint8Array | null> {
  const response = await downloadFile(cms, userId, accountId, id)
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/** A size as people read it: 512 MB, 1.8 MB, 240 KB. */
export function formatBytes(size: number): string {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB']
  let value = size
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  const shown = unit === 0 || value >= 100 ? Math.round(value) : Math.round(value * 10) / 10
  return `${shown} ${units[unit]}`
}

/** What a `GoogleError` means, in words that are this plugin's own: never Google's text. */
export function problemText(error: GoogleError): string {
  return error.kind === 'refused' ? 'Google refused that.' : error.message
}

/** Drive takes files up to 5 TB; this is the most a browser is let send from here. */
export const MAX_UPLOAD_BYTES = 5 * 1024 ** 4

/**
 * Opens an upload at Drive for a file the person's browser will send into `parent`: Drive answers
 * with an address that takes the bytes, good for that one file. The browser gets that address and
 * never a token; `origin` is the site's, which Drive then lets send to it.
 */
export async function openUpload(
  cms: PluginContext,
  userId: string,
  accountId: string,
  input: { name: string; parent: string; bytes: number; type: string; origin: string },
): Promise<string> {
  const response = await googleFetch(
    cms,
    userId,
    accountId,
    googleUrl('www.googleapis.com', '/upload/drive/v3/files'),
    {
      method: 'POST',
      query: { uploadType: 'resumable' },
      json: { name: cleanName(input.name), parents: [checked(input.parent)] },
      headers: {
        'x-upload-content-length': String(input.bytes),
        'x-upload-content-type': input.type,
        origin: input.origin,
      },
    },
  )
  const session = response.headers.get('location') ?? ''
  if (!response.ok) await apiAnswer(response)
  await response.body?.cancel().catch(() => undefined)
  // Whatever the answer says, the browser is only ever sent to Google.
  if (!isGoogleUrl(session)) {
    throw new GoogleError('unavailable', 'Drive didn’t open the upload. Try again.')
  }
  return session
}
