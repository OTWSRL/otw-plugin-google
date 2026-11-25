// YouTube's Data API on the stand-in: channels, the uploads playlist, videos, playlists,
// categories, search, and uploads that a browser sends in pieces to an address of their own.
import { apiError, jsonAnswer } from './fake-google.mjs'

const SCOPE = ['https://www.googleapis.com/auth/youtube']
const HOST = 'www.googleapis.com'

const video = (id, title, extra = {}) => ({
  id,
  snippet: {
    title,
    description: `About ${title}`,
    tags: ['cms'],
    categoryId: '28',
    channelId: extra.channelId ?? 'UC-ada-channel',
    publishedAt: '2026-11-21T10:00:00Z',
    thumbnails: { medium: { url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` } },
  },
  status: {
    privacyStatus: extra.privacy ?? 'public',
    uploadStatus: 'processed',
    selfDeclaredMadeForKids: false,
    ...(extra.publishAt ? { publishAt: extra.publishAt } : {}),
  },
  statistics: { viewCount: '12480', commentCount: '214' },
  contentDetails: { duration: 'PT18M42S' },
})

/** Adds YouTube to the stand-in. Ada has a channel with videos; Grace has an empty one; Linus has none. */
export function fakeYouTube(fake) {
  const seed = () => {
    const videos = new Map()
    for (let index = 1; index <= 30; index++) {
      const id = `adaVideo${String(index).padStart(3, '0')}`
      videos.set(
        id,
        video(
          id,
          index === 1 ? 'Building a CMS in a weekend' : `Episode ${index}`,
          index === 2 ? { privacy: 'private', publishAt: '2026-12-01T09:00:00Z' } : {},
        ),
      )
    }
    // Somebody else's video: never listed for Ada, never hers to change.
    videos.set(
      'otherVideo001',
      video('otherVideo001', 'Not Ada’s video', { channelId: 'UC-someone-else' }),
    )
    fake.data.youtube = {
      channels: {
        ada: {
          id: 'UC-ada-channel',
          title: 'Ada Builds',
          subscribers: '1204',
          uploads: 'UU-ada-uploads',
        },
        grace: {
          id: 'UC-grace-channel',
          title: 'Studio Example',
          subscribers: '18930',
          uploads: 'UU-grace-uploads',
        },
      },
      videos,
      playlists: new Map([
        [
          'PL-ada-weekly-0001',
          {
            id: 'PL-ada-weekly-0001',
            who: 'ada',
            title: 'Weekly episodes',
            privacy: 'public',
            items: [],
          },
        ],
      ]),
      /** Uploads under way, by their id: who, the metadata, the bytes so far. */
      uploads: new Map(),
      next: 1,
    }
  }
  fake.seeds.push(seed)
  seed()

  const data = () => fake.data.youtube
  const channelOf = (who) => data().channels[who] ?? null
  const mine = (who) =>
    [...data().videos.values()].filter((item) => item.snippet.channelId === channelOf(who)?.id)
  const page = (items, url, size) => {
    const start = Number(url.searchParams.get('pageToken')?.replace('t', '') ?? 0)
    const max = Math.min(Number(url.searchParams.get('maxResults') ?? 5), size)
    return {
      items: items.slice(start, start + max),
      ...(start + max < items.length ? { nextPageToken: `t${start + max}` } : {}),
      ...(start > 0 ? { prevPageToken: `t${Math.max(0, start - max)}` } : {}),
    }
  }

  fake.route('GET', HOST, '/youtube/v3/channels', SCOPE, ({ who }) => {
    const channel = channelOf(who)
    return jsonAnswer(200, {
      items: channel
        ? [
            {
              id: channel.id,
              snippet: { title: channel.title },
              statistics: { subscriberCount: channel.subscribers },
              contentDetails: { relatedPlaylists: { uploads: channel.uploads } },
            },
          ]
        : [],
    })
  })

  fake.route('GET', HOST, '/youtube/v3/playlistItems', SCOPE, ({ who, url }) => {
    if (url.searchParams.get('playlistId') !== channelOf(who)?.uploads)
      return apiError(404, 'playlistNotFound')
    const { items, ...tokens } = page(mine(who), url, 50)
    return jsonAnswer(200, {
      items: items.map((item) => ({ contentDetails: { videoId: item.id } })),
      ...tokens,
    })
  })

  fake.route('GET', HOST, '/youtube/v3/search', SCOPE, ({ who, url }) => {
    const query = (url.searchParams.get('q') ?? '').toLowerCase()
    const { items, ...tokens } = page(
      mine(who).filter((item) => item.snippet.title.toLowerCase().includes(query)),
      url,
      50,
    )
    return jsonAnswer(200, {
      items: items.map((item) => ({ id: { kind: 'youtube#video', videoId: item.id } })),
      ...tokens,
    })
  })

  fake.route('GET', HOST, '/youtube/v3/videos', SCOPE, ({ url }) => {
    const ids = (url.searchParams.get('id') ?? '').split(',')
    // As YouTube: any public video by id, whoever's it is.
    return jsonAnswer(200, { items: ids.map((id) => data().videos.get(id)).filter(Boolean) })
  })

  fake.route('PUT', HOST, '/youtube/v3/videos', SCOPE, ({ who, body }) => {
    const change = JSON.parse(body.toString('utf8'))
    const existing = data().videos.get(change.id)
    if (!existing) return apiError(404, 'videoNotFound')
    if (existing.snippet.channelId !== channelOf(who)?.id) return apiError(403, 'forbidden')
    if (!change.snippet?.title)
      return apiError(
        400,
        'invalidTitle',
        'The request metadata specifies an invalid or empty video title.',
      )
    existing.snippet = { ...existing.snippet, ...change.snippet }
    existing.status = { ...existing.status, ...change.status }
    if (!change.status?.publishAt) delete existing.status.publishAt
    return jsonAnswer(200, existing)
  })

  fake.route('DELETE', HOST, '/youtube/v3/videos', SCOPE, ({ who, url }) => {
    const existing = data().videos.get(url.searchParams.get('id'))
    if (!existing) return apiError(404, 'videoNotFound')
    if (existing.snippet.channelId !== channelOf(who)?.id) return apiError(403, 'forbidden')
    data().videos.delete(existing.id)
    return { status: 204, headers: {}, body: '' }
  })

  fake.route('GET', HOST, '/youtube/v3/playlists', SCOPE, ({ who }) =>
    jsonAnswer(200, {
      items: [...data().playlists.values()]
        .filter((playlist) => playlist.who === who)
        .map((playlist) => ({
          id: playlist.id,
          snippet: { title: playlist.title },
          status: { privacyStatus: playlist.privacy },
          contentDetails: { itemCount: playlist.items.length },
        })),
    }),
  )

  fake.route('POST', HOST, '/youtube/v3/playlists', SCOPE, ({ who, body }) => {
    const made = JSON.parse(body.toString('utf8'))
    const id = `PL-made-${String(data().next++).padStart(8, '0')}`
    data().playlists.set(id, {
      id,
      who,
      title: made.snippet.title,
      privacy: made.status.privacyStatus,
      items: [],
    })
    return jsonAnswer(200, { id })
  })

  fake.route('POST', HOST, '/youtube/v3/playlistItems', SCOPE, ({ who, body }) => {
    const { snippet } = JSON.parse(body.toString('utf8'))
    const playlist = data().playlists.get(snippet.playlistId)
    if (!playlist || playlist.who !== who) return apiError(404, 'playlistNotFound')
    playlist.items.push(snippet.resourceId.videoId)
    return jsonAnswer(200, { id: 'item' })
  })

  fake.route('GET', HOST, '/youtube/v3/videoCategories', SCOPE, () =>
    jsonAnswer(200, {
      items: [
        { id: '22', snippet: { title: 'People & Blogs', assignable: true } },
        { id: '27', snippet: { title: 'Education', assignable: true } },
        { id: '28', snippet: { title: 'Science & Technology', assignable: true } },
        { id: '30', snippet: { title: 'Movies', assignable: false } },
      ],
    }),
  )

  // Opening an upload: YouTube answers with the address that takes the file's bytes.
  fake.route('POST', HOST, '/upload/youtube/v3/videos', SCOPE, ({ who, body, headers, url }) => {
    if (url.searchParams.get('uploadType') !== 'resumable') return apiError(400, 'badRequest')
    if (!channelOf(who)) return apiError(401, 'youtubeSignupRequired')
    // A test can make YouTube answer with an address that isn't its own.
    if (data().location) return { status: 200, headers: { location: data().location }, body: '' }
    const id = `upload${data().next++}`
    data().uploads.set(id, {
      who,
      metadata: JSON.parse(body.toString('utf8')),
      size: Number(headers['x-upload-content-length']),
      type: headers['x-upload-content-type'],
      origin: headers.origin ?? null,
      received: 0,
    })
    return {
      status: 200,
      headers: {
        location: `${fake.url}/${HOST}/upload/youtube/v3/videos?uploadType=resumable&upload_id=${id}`,
      },
      body: '',
    }
  })

  // The file's bytes, in pieces, from a browser that holds the address and no token.
  fake.route('PUT', HOST, '/upload/youtube/v3/videos', false, ({ url, headers, body }) => {
    const upload = data().uploads.get(url.searchParams.get('upload_id'))
    const cors = {
      'access-control-allow-origin': upload?.origin ?? '*',
      'access-control-expose-headers': 'Range',
    }
    if (!upload) return { ...apiError(404, 'notFound'), headers: cors }
    const range = /^bytes (?:(\d+)-(\d+)|\*)\/(\d+)$/.exec(headers['content-range'] ?? '')
    if (range?.[1] !== undefined) {
      if (Number(range[1]) !== upload.received)
        return {
          status: 308,
          headers: { ...cors, range: `bytes=0-${upload.received - 1}` },
          body: '',
        }
      upload.received += body.length
    }
    if (upload.received < upload.size) {
      return {
        status: 308,
        headers: {
          ...cors,
          ...(upload.received > 0 ? { range: `bytes=0-${upload.received - 1}` } : {}),
        },
        body: '',
      }
    }
    const id = `newVideo${String(data().next++).padStart(4, '0')}`
    const made = video(id, upload.metadata.snippet.title, {
      channelId: data().channels[upload.who].id,
      privacy: upload.metadata.status.privacyStatus,
      publishAt: upload.metadata.status.publishAt,
    })
    made.snippet = { ...made.snippet, ...upload.metadata.snippet }
    made.status.uploadStatus = 'uploaded'
    data().videos = new Map([[id, made], ...data().videos])
    return {
      status: 200,
      headers: { ...cors, 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    }
  })

  // A browser asks before sending to another site's address.
  fake.route('OPTIONS', HOST, '/upload/youtube/v3/videos', false, ({ headers }) => ({
    status: 204,
    headers: {
      'access-control-allow-origin': headers.origin ?? '*',
      'access-control-allow-methods': 'PUT, OPTIONS',
      'access-control-allow-headers': 'content-range, content-type',
      'access-control-expose-headers': 'Range',
    },
    body: '',
  }))
}
