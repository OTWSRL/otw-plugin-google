import type { PluginContext } from '@otwdesign/sdk'
import { googleFetch, googleJson } from '../../accounts'
import { apiAnswer, GoogleError, googleUrl, isGoogleUrl } from '../../google'

// YouTube's Data API, as much of it as the screens use. Every call is made as one of a person's
// own accounts, and every id that goes into an address was checked to look like one.

const api = (path: string) => googleUrl('www.googleapis.com', `/youtube/v3${path}`)
const uploadApi = (path: string) => googleUrl('www.googleapis.com', `/upload/youtube/v3${path}`)

export const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/
export const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,80}$/
export const PRIVACY = ['private', 'unlisted', 'public'] as const
export type Privacy = (typeof PRIVACY)[number]
export const PAGE_SIZE = 25
export const MAX_TITLE = 100
export const MAX_DESCRIPTION = 5000
/** YouTube's limit for all of a video's tags together. */
export const MAX_TAGS = 500
/** YouTube takes videos up to 256 GB. */
export const MAX_VIDEO_BYTES = 256 * 1024 ** 3

/** Who asks: the person and which of their accounts. */
export interface As {
  userId: string
  accountId: string
}

export interface Channel {
  id: string
  title: string
  subscribers: number | null
  /** The playlist that holds every upload, which is how the channel's videos are listed. */
  uploads: string
}

export interface Video {
  id: string
  title: string
  description: string
  tags: string[]
  categoryId: string
  privacy: Privacy
  /** When a private video goes public by itself. */
  publishAt: string | null
  madeForKids: boolean
  publishedAt: string | null
  thumbnail: string | null
  duration: string | null
  views: number | null
  comments: number | null
  /** `uploaded`, `processed`, `failed`, `rejected` or `deleted`. */
  uploadStatus: string | null
  channelId: string
}

export interface Playlist {
  id: string
  title: string
  privacy: Privacy
  count: number
}

type Json = Record<string, unknown>
const record = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const count = (value: unknown): number | null => {
  const parsed = Number(text(value) || value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}
const privacyOf = (value: unknown): Privacy =>
  (PRIVACY as readonly string[]).includes(text(value)) ? (text(value) as Privacy) : 'private'

/** A thumbnail's address, when it is one of YouTube's own image hosts over https. */
function thumbnailOf(thumbnails: unknown): string | null {
  const sizes = record(thumbnails)
  const url = text(record(sizes.medium ?? sizes.default).url)
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && /(^|\.)(ytimg\.com|ggpht\.com)$/.test(parsed.hostname)
      ? parsed.href
      : null
  } catch {
    return null
  }
}

function videoOf(item: unknown): Video {
  const { id, snippet, status, statistics, contentDetails } = record(item)
  const about = record(snippet)
  const state = record(status)
  const numbers = record(statistics)
  return {
    id: text(id),
    title: text(about.title),
    description: text(about.description),
    tags: list(about.tags).map(text).filter(Boolean),
    categoryId: text(about.categoryId),
    privacy: privacyOf(state.privacyStatus),
    publishAt: text(state.publishAt) || null,
    madeForKids: state.selfDeclaredMadeForKids === true || state.madeForKids === true,
    publishedAt: text(about.publishedAt) || null,
    thumbnail: thumbnailOf(about.thumbnails),
    duration: text(record(contentDetails).duration) || null,
    views: count(numbers.viewCount),
    comments: count(numbers.commentCount),
    uploadStatus: text(state.uploadStatus) || null,
    channelId: text(about.channelId),
  }
}

const call = <T = Json>(cms: PluginContext, as: As, url: string, request = {}) =>
  googleJson<T>(cms, as.userId, as.accountId, url, request)

/** The account's channel, or `null` for a Google account that has none. */
export async function myChannel(cms: PluginContext, as: As): Promise<Channel | null> {
  const answer = await call(cms, as, api('/channels'), {
    query: { part: ['snippet', 'statistics', 'contentDetails'], mine: true },
  })
  const [item] = list(answer.items)
  if (!item) return null
  const { id, snippet, statistics, contentDetails } = record(item)
  const uploads = text(record(record(contentDetails).relatedPlaylists).uploads)
  if (!PLAYLIST_ID.test(uploads)) return null
  return {
    id: text(id),
    title: text(record(snippet).title),
    subscribers:
      record(statistics).hiddenSubscriberCount === true
        ? null
        : count(record(statistics).subscriberCount),
    uploads,
  }
}

/** Videos by id, with everything the list and the edit form show. Ids YouTube doesn't know are left out. */
async function videosById(cms: PluginContext, as: As, ids: readonly string[]): Promise<Video[]> {
  const wanted = ids.filter((id) => VIDEO_ID.test(id)).slice(0, 50)
  if (wanted.length === 0) return []
  const answer = await call(cms, as, api('/videos'), {
    query: {
      part: ['snippet', 'status', 'statistics', 'contentDetails'],
      id: wanted.join(','),
      maxResults: 50,
    },
  })
  const found = new Map(list(answer.items).map((item) => [text(record(item).id), videoOf(item)]))
  // In the order asked for, which is the channel's: newest first.
  return wanted.flatMap((id) => found.get(id) ?? [])
}

export interface VideoPage {
  videos: Video[]
  next: string | null
  previous: string | null
}

const pageToken = (value: string | undefined) =>
  value && /^[A-Za-z0-9_-]{1,200}$/.test(value) ? value : undefined

/**
 * A page of the channel's videos, newest first: two calls, one for the page's ids and one for
 * the videos. A search costs YouTube's quota a hundred times a plain page, so it's only run when
 * someone types one.
 */
export async function listVideos(
  cms: PluginContext,
  as: As,
  channel: Channel,
  options: { page?: string; search?: string } = {},
): Promise<VideoPage> {
  const search = options.search?.trim().slice(0, 100)
  const page = search
    ? await call(cms, as, api('/search'), {
        query: {
          part: 'id',
          forMine: true,
          type: 'video',
          q: search,
          maxResults: PAGE_SIZE,
          pageToken: pageToken(options.page),
        },
      })
    : await call(cms, as, api('/playlistItems'), {
        query: {
          part: 'contentDetails',
          playlistId: channel.uploads,
          maxResults: PAGE_SIZE,
          pageToken: pageToken(options.page),
        },
      })
  const ids = list(page.items).map((item) => {
    const entry = record(item)
    return text(record(entry.contentDetails).videoId) || text(record(entry.id).videoId)
  })
  return {
    videos: await videosById(cms, as, ids),
    next: pageToken(text(page.nextPageToken)) ?? null,
    previous: pageToken(text(page.prevPageToken)) ?? null,
  }
}

/** One of the channel's own videos, or `null`: a video of someone else's channel isn't shown or changed. */
export async function getVideo(
  cms: PluginContext,
  as: As,
  channel: Channel,
  id: string,
): Promise<Video | null> {
  const [video] = await videosById(cms, as, [id])
  return video && video.channelId === channel.id ? video : null
}

export interface VideoChanges {
  title: string
  description: string
  tags: string[]
  categoryId: string
  privacy: Privacy
  publishAt: string | null
  madeForKids: boolean
}

const resource = (changes: VideoChanges) => ({
  snippet: {
    title: changes.title,
    description: changes.description,
    tags: changes.tags,
    categoryId: changes.categoryId,
  },
  status: {
    privacyStatus: changes.privacy,
    selfDeclaredMadeForKids: changes.madeForKids,
    // YouTube publishes a private video at this time; it means nothing for the others.
    ...(changes.publishAt && changes.privacy === 'private' ? { publishAt: changes.publishAt } : {}),
  },
})

export async function updateVideo(cms: PluginContext, as: As, id: string, changes: VideoChanges) {
  await call(cms, as, api('/videos'), {
    method: 'PUT',
    query: { part: ['snippet', 'status'] },
    json: { id, ...resource(changes) },
  })
}

export async function deleteVideo(cms: PluginContext, as: As, id: string): Promise<void> {
  await call(cms, as, api('/videos'), { method: 'DELETE', query: { id } })
}

export async function listPlaylists(cms: PluginContext, as: As): Promise<Playlist[]> {
  const answer = await call(cms, as, api('/playlists'), {
    query: { part: ['snippet', 'status', 'contentDetails'], mine: true, maxResults: 50 },
  })
  return list(answer.items).map((item) => {
    const { id, snippet, status, contentDetails } = record(item)
    return {
      id: text(id),
      title: text(record(snippet).title),
      privacy: privacyOf(record(status).privacyStatus),
      count: count(record(contentDetails).itemCount) ?? 0,
    }
  })
}

export async function createPlaylist(cms: PluginContext, as: As, title: string, privacy: Privacy) {
  await call(cms, as, api('/playlists'), {
    method: 'POST',
    query: { part: ['snippet', 'status'] },
    json: { snippet: { title }, status: { privacyStatus: privacy } },
  })
}

export async function addToPlaylist(
  cms: PluginContext,
  as: As,
  playlistId: string,
  videoId: string,
) {
  await call(cms, as, api('/playlistItems'), {
    method: 'POST',
    query: { part: 'snippet' },
    json: { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } } },
  })
}

export interface Category {
  id: string
  title: string
}

/** YouTube's video categories that a video can be given, the same for every account: kept a day. */
export function listCategories(cms: PluginContext, as: As): Promise<Category[]> {
  return cms.cache.remember(
    'google:youtube:categories',
    async () => {
      const answer = await call(cms, as, api('/videoCategories'), {
        query: { part: 'snippet', regionCode: 'US' },
      })
      return list(answer.items)
        .map((item) => record(item))
        .filter(
          (item) => record(item.snippet).assignable === true && /^\d{1,4}$/.test(text(item.id)),
        )
        .map((item) => ({ id: text(item.id), title: text(record(item.snippet).title) }))
    },
    { ttlSeconds: 24 * 60 * 60 },
  )
}

/**
 * Opens an upload at YouTube for a file the person's browser will send: YouTube answers with an
 * address that takes the bytes, good for that one file. The browser gets that address and never
 * a token; `origin` is the site's, which YouTube then lets send to it.
 */
export async function openUpload(
  cms: PluginContext,
  as: As,
  input: { changes: VideoChanges; bytes: number; type: string; origin: string },
): Promise<string> {
  const response = await googleFetch(cms, as.userId, as.accountId, uploadApi('/videos'), {
    method: 'POST',
    query: { uploadType: 'resumable', part: ['snippet', 'status'] },
    json: resource(input.changes),
    headers: {
      'x-upload-content-length': String(input.bytes),
      'x-upload-content-type': input.type,
      // The site's address when a browser will send the file; none when this server does.
      ...(input.origin ? { origin: input.origin } : {}),
    },
  })
  const session = response.headers.get('location') ?? ''
  if (!response.ok) await apiAnswer(response)
  await response.body?.cancel().catch(() => undefined)
  // Whatever the answer says, the browser is only ever sent to Google.
  if (!isGoogleUrl(session)) {
    throw new GoogleError('unavailable', 'YouTube didn’t open the upload. Try again.')
  }
  return session
}
