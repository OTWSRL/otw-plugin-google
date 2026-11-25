import type { ApiContext, PluginContext } from '@otwdesign/sdk'
import { USE } from '../../config'
import { GoogleError } from '../../google'
import { siteOrigin } from '../../runtime'
import { requireAccount } from '../shared'
import { cleanName, DRIVE, FILE_ID, MAX_UPLOAD_BYTES, openUpload, ROOT } from './client'

// The two requests the Drive upload screen's script makes. This site opens the upload at Drive,
// checks whose it is, and never holds a byte of the file.

const MAX_BODY_BYTES = 16 * 1024
/** A media type as browsers send it, or none at all for a file they don't know. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,100}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,100}$/i

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
