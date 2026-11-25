import { ActionError, type ApiContext, type PluginContext, type User } from '@otwdesign/sdk'
import { USE } from '../../config'
import { GoogleError } from '../../google'
import { siteOrigin } from '../../runtime'
import { requireAccount } from '../shared'
import {
  addToPlaylist,
  getVideo,
  listPlaylists,
  MAX_VIDEO_BYTES,
  myChannel,
  openUpload,
  VIDEO_ID,
  type As,
} from './client'
import { jsonFields, readChanges, readPlaylist } from './forms'

// The two requests the upload screen's script makes: open an upload at YouTube, and say it's
// done. JSON only: a page of another site can't send JSON here without the browser asking first.

const MAX_BODY_BYTES = 64 * 1024
const VIDEO_TYPE = /^video\/[a-z0-9][a-z0-9.+-]{0,60}$/i

const refuse = (status: number, error: string) => Response.json({ error }, { status })

/** The request's JSON object, read up to a size; `null` for anything else. */
async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) return null
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > MAX_BODY_BYTES) return null
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) return null
  try {
    const body: unknown = JSON.parse(text)
    return body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** The signed-in person and the account the request names, or the answer that refuses it. */
async function asker(
  cms: PluginContext,
  context: ApiContext,
  body: Record<string, unknown>,
): Promise<{ user: User; as: As } | Response> {
  const user = await context.user()
  if (!user || !cms.auth.can(user, USE)) return refuse(403, 'Sign in again to upload.')
  const account = await requireAccount(cms, user, 'youtube', jsonFields(body)('account'))
  if (!account) return refuse(404, 'That Google account can’t use YouTube here any more.')
  return { user, as: { userId: user.id, accountId: account.id } }
}

/** What went wrong, as the script shows it: the person's mistake or Google's trouble in words. */
function failure(cms: PluginContext, error: unknown): Response {
  if (error instanceof ActionError) return refuse(400, error.message)
  if (error instanceof GoogleError) return refuse(502, error.message)
  cms.logger.error('A YouTube upload request failed', { error })
  return refuse(500, 'Something went wrong. Check the server log.')
}

/** `POST /youtube/uploads`: opens an upload for a file the browser is about to send to YouTube. */
export async function openUploadRoute(
  cms: PluginContext,
  request: Request,
  context: ApiContext,
): Promise<Response> {
  const body = await jsonBody(request)
  if (!body) return refuse(415, 'Send JSON.')
  const who = await asker(cms, context, body)
  if (who instanceof Response) return who
  try {
    const field = jsonFields(body)
    const changes = readChanges(field)
    // Checked now, so a playlist that isn't the person's is refused before the upload, not after.
    readPlaylist(field)
    const bytes = typeof body.bytes === 'number' ? body.bytes : NaN
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_VIDEO_BYTES) {
      throw new ActionError('YouTube takes videos up to 256 GB.')
    }
    const type = field('type')
    if (!VIDEO_TYPE.test(type)) throw new ActionError('Choose a video file.')
    const url = await openUpload(cms, who.as, {
      changes,
      bytes,
      type,
      origin: siteOrigin(cms, request),
    })
    cms.logger.info('A YouTube upload was opened', { by: who.user.id, bytes })
    return Response.json({ url }, { headers: { 'cache-control': 'no-store' } })
  } catch (error) {
    return failure(cms, error)
  }
}

/**
 * `POST /youtube/uploads/done`: the browser says which video the upload became. It's only taken
 * as the account's own video once YouTube says so too; then it joins the playlist that was asked.
 */
export async function uploadDoneRoute(
  cms: PluginContext,
  request: Request,
  context: ApiContext,
): Promise<Response> {
  const body = await jsonBody(request)
  if (!body) return refuse(415, 'Send JSON.')
  const who = await asker(cms, context, body)
  if (who instanceof Response) return who
  const list = `${cms.admin.url('/youtube')}?account=${who.as.accountId}`
  try {
    const field = jsonFields(body)
    const id = field('id')
    const playlist = readPlaylist(field)
    if (playlist && VIDEO_ID.test(id)) {
      const channel = await myChannel(cms, who.as)
      const video = channel ? await getVideo(cms, who.as, channel, id) : null
      const mine = video
        ? (await listPlaylists(cms, who.as)).find((item) => item.id === playlist)
        : null
      if (video && mine) await addToPlaylist(cms, who.as, mine.id, video.id)
    }
    return Response.json(
      { redirect: `${list}&uploaded=1` },
      { headers: { 'cache-control': 'no-store' } },
    )
  } catch (error) {
    // The video is at YouTube whatever happened to the playlist: back to the list all the same.
    if (error instanceof GoogleError) return Response.json({ redirect: `${list}&uploaded=1` })
    return failure(cms, error)
  }
}
