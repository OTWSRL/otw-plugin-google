import { ActionError, type PluginContext, type User } from '@otwdesign/sdk'
import type { YouTubeCopy } from '../../config'
import { GoogleError, isGoogleUrl } from '../../google'
import { sealerOf } from '../../runtime'
import { downloadFile, getFile } from '../drive/client'
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
  type VideoChanges,
} from './client'

// A video from the person's Drive to their YouTube channel, on the server: Drive's bytes are
// read a piece at a time and sent on to YouTube, by a background job that picks up where it left
// off. The file never passes through a browser, and never sits whole in memory or on disk.

export const COPY_JOB = 'google.youtube_from_drive'
/** One piece: a multiple of 256 KB, as YouTube asks of every piece but the last. */
const PIECE_BYTES = 8 * 1024 * 1024
/** How long one run keeps sending before it hands over to the next: hosts limit a request's time. */
const RUN_BUDGET_MS = 20_000
const PIECE_TIMEOUT_MS = 60_000
/** What the sealed upload address is bound to, so it opens for nothing else. */
const BOUND = 'youtube-copy'

const pieceOf = (args: YouTubeCopy) =>
  Number.isSafeInteger(args.piece) && args.piece! > 0 && args.piece! % (256 * 1024) === 0
    ? args.piece!
    : PIECE_BYTES

/**
 * Checks the Drive file is a video of the person's own, on an account that may use both
 * services, and queues its copy. An `ActionError` says what's in the way.
 */
export async function startCopy(
  cms: PluginContext,
  user: User,
  input: { accountId: string; fileId: string; changes: VideoChanges; playlist: string | null },
): Promise<void> {
  const account = await requireAccount(cms, user, 'youtube', input.accountId)
  const drive = account ? await requireAccount(cms, user, 'drive', account.id) : null
  if (!account || !drive) {
    throw new ActionError('That Google account needs to allow both YouTube and Drive first.')
  }
  const file = await getFile(cms, user.id, account.id, input.fileId)
  if (file.kind !== 'file' || !file.mimeType.startsWith('video/') || file.trashed) {
    throw new ActionError('That Drive file isn’t a video.')
  }
  if (!file.size || file.size > MAX_VIDEO_BYTES) {
    throw new ActionError('YouTube takes videos up to 256 GB, and not empty ones.')
  }
  await cms.jobs.enqueue(COPY_JOB, {
    userId: user.id,
    accountId: account.id,
    fileId: file.id,
    changes: input.changes,
    playlist: input.playlist,
    bytes: file.size,
    type: file.mimeType.slice(0, 100),
  })
}

/** Where YouTube has got to, from its answer to a piece. */
function received(response: Response, fallback: number): number {
  const match = /^bytes=0-(\d{1,18})$/.exec(response.headers.get('range') ?? '')
  return match ? Number(match[1]) + 1 : fallback
}

async function finish(
  cms: PluginContext,
  as: As,
  args: YouTubeCopy,
  videoId: string,
): Promise<void> {
  cms.logger.info('A video was copied from Drive to YouTube', {
    by: args.userId,
    bytes: args.bytes,
  })
  if (!args.playlist || !VIDEO_ID.test(videoId)) return
  const channel = await myChannel(cms, as)
  const video = channel ? await getVideo(cms, as, channel, videoId) : null
  const mine = video
    ? (await listPlaylists(cms, as)).find((item) => item.id === args.playlist)
    : null
  if (video && mine) await addToPlaylist(cms, as, mine.id, video.id)
}

/**
 * One run of the copy: sends pieces until the file is whole at YouTube or the run's time is up,
 * then queues the rest. A piece that fails makes the job fail, and the queue tries it again from
 * the last piece YouTube confirmed.
 */
export async function runCopy(cms: PluginContext, args: YouTubeCopy): Promise<void> {
  const as = { userId: args.userId, accountId: args.accountId }
  const sealer = sealerOf(cms)
  const session = args.session
    ? sealer.open(args.session, BOUND)
    : await openUpload(cms, as, {
        changes: args.changes,
        bytes: args.bytes,
        type: args.type,
        // No browser sends this one: YouTube needs no origin to allow.
        origin: '',
      })
  if (!session || !isGoogleUrl(session)) {
    throw new GoogleError('unavailable', 'The copy’s upload address can’t be read any more.')
  }
  const piece = pieceOf(args)
  const budget = args.budgetMs ?? RUN_BUDGET_MS
  const started = Date.now()
  let offset = args.offset ?? 0

  while (offset < args.bytes) {
    const end = Math.min(offset + piece, args.bytes)
    const drive = await downloadFile(
      cms,
      args.userId,
      args.accountId,
      args.fileId,
      `bytes=${offset}-${end - 1}`,
    )
    const bytes = new Uint8Array(await drive.arrayBuffer())
    if (bytes.byteLength !== end - offset) {
      throw new GoogleError('unavailable', 'Drive sent a different piece than was asked for.')
    }
    const sent = await fetch(session, {
      method: 'PUT',
      headers: { 'content-range': `bytes ${offset}-${end - 1}/${args.bytes}` },
      body: bytes,
      // YouTube answers a piece with 308, "resume incomplete", which isn't a redirect to follow.
      redirect: 'manual',
      signal: AbortSignal.timeout(PIECE_TIMEOUT_MS),
    }).catch(() => {
      throw new GoogleError('unavailable', 'YouTube didn’t answer. The copy will be tried again.')
    })
    if (sent.status === 308) {
      await sent.body?.cancel().catch(() => undefined)
      offset = received(sent, end)
    } else if (sent.ok) {
      const made = (await sent.json().catch(() => ({}))) as { id?: unknown }
      await finish(cms, as, args, typeof made.id === 'string' ? made.id : '')
      return
    } else {
      await sent.body?.cancel().catch(() => undefined)
      throw new GoogleError(
        'unavailable',
        `YouTube refused a piece of the copy (${sent.status}).`,
        sent.status,
      )
    }
    if (offset < args.bytes && Date.now() - started >= budget) {
      // Time's up for this run: the next one carries on from here.
      await cms.jobs.enqueue(COPY_JOB, { ...args, session: sealer.seal(session, BOUND), offset })
      return
    }
  }
}
