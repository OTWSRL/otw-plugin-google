import { FormField, FormTable, ListTable, Notice, SubmitButton } from '@otwdesign/admin-ui'
import type { AdminPageContext, AdminPageProps, PluginContext } from '@otwdesign/sdk'
import { GoogleError } from '../../google'
import { AccountSwitch, GoogleProblem, GoogleStyles, longDate } from '../../screens/parts'
import { NoAccount, serviceAccounts, type ServiceAccounts } from '../shared'
import {
  getVideo,
  listCategories,
  listPlaylists,
  listVideos,
  MAX_DESCRIPTION,
  MAX_TITLE,
  myChannel,
  VIDEO_ID,
  type As,
  type Category,
  type Channel,
  type Playlist,
  type Video,
  type VideoPage,
} from './client'

// YouTube's screens. Server components with links and plain forms: the list, a video's details,
// the upload form (whose file the browser sends to YouTube itself) and the playlists.

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value)

/** What every YouTube screen starts from: the account, and its channel when it has one. */
interface Base {
  found: ServiceAccounts
  /** `?account=<id>` for this screen's links, so they stay with the chosen account. */
  query: string
  as: As | null
  channel: Channel | null
  /** What went wrong at Google, kept to say on the screen. */
  problem: GoogleError | null
}

async function base(
  cms: PluginContext,
  { user, searchParams }: AdminPageContext,
): Promise<Base | null> {
  const found = await serviceAccounts(cms, user, 'youtube', first(searchParams.account))
  if (!found) return null
  if (!found.current) return { found, query: '', as: null, channel: null, problem: null }
  const as = { userId: user.id, accountId: found.current.id }
  const query = `?account=${found.current.id}`
  try {
    return { found, query, as, channel: await myChannel(cms, as), problem: null }
  } catch (error) {
    if (!(error instanceof GoogleError)) throw error
    return { found, query, as, channel: null, problem: error }
  }
}

/** A screen's top: the styles, a problem at Google, the account chooser, or what to do first. */
function Top({
  cms,
  data,
  here,
  children,
}: {
  cms: PluginContext
  data: Base
  here: string
  children?: React.ReactNode
}) {
  const reconnect = data.as
    ? `${cms.routes.apiUrl('/oauth/start')}?${new URLSearchParams({ account: data.as.accountId, service: 'youtube', next: here })}`
    : undefined
  return (
    <>
      <GoogleStyles />
      <YouTubeStyles />
      {data.problem && <GoogleProblem error={data.problem} reconnect={reconnect} />}
      {!data.found.current ? (
        <NoAccount cms={cms} found={data.found} here={here} />
      ) : (
        <AccountSwitch
          label="Account"
          action={here}
          accounts={data.found.accounts}
          current={data.found.current.id}
        >
          {children}
        </AccountSwitch>
      )}
      {data.found.current && !data.channel && !data.problem && (
        <Notice type="info">
          {data.found.current.email} has no YouTube channel yet. Make one at youtube.com, then come
          back.
        </Notice>
      )}
    </>
  )
}

function YouTubeStyles() {
  return (
    <style href="otw-google-youtube" precedence="default">{`
.cms-admin .g-video{display:flex;gap:12px;align-items:flex-start}
.cms-admin .g-thumb{flex:none;position:relative;width:120px;aspect-ratio:16/9;background:#2c3338;overflow:hidden}
.cms-admin .g-thumb img{width:100%;height:100%;object-fit:cover;display:block}
.cms-admin .g-thumb time{position:absolute;right:4px;bottom:4px;padding:0 4px;background:rgb(0 0 0/80%);color:#fff;font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.cms-admin .g-video .row-title{font-weight:600;font-size:14px;text-decoration:none}
.cms-admin .g-upload progress{display:block;width:100%;max-width:420px;height:8px;margin:8px 0 4px}
.cms-admin .g-pages{display:flex;gap:8px;margin:12px 0}
@media (max-width:782px){.cms-admin .g-thumb{width:88px}}
`}</style>
  )
}

/** `PT1H2M3S` as `1:02:03`. */
export function clock(duration: string | null): string | null {
  const match = duration ? /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(duration) : null
  if (!match) return null
  const [hours, minutes, seconds] = [match[1], match[2], match[3]].map((part) => Number(part ?? 0))
  const pad = (value: number) => String(value).padStart(2, '0')
  return hours ? `${hours}:${pad(minutes!)}:${pad(seconds!)}` : `${minutes}:${pad(seconds!)}`
}

const number = (value: number | null) => (value === null ? '—' : value.toLocaleString('en-GB'))
const VISIBILITY = { public: 'Public', unlisted: 'Unlisted', private: 'Private' } as const
const day = (iso: string | null) =>
  iso && !Number.isNaN(Date.parse(iso)) ? longDate(new Date(iso)) : '—'

// ── The list ─────────────────────────────────────────────────────────────────

export interface VideosData extends Base {
  page: VideoPage | null
  search: string
  uploaded: boolean
}

export async function loadVideos(
  cms: PluginContext,
  context: AdminPageContext,
): Promise<VideosData | null> {
  const data = await base(cms, context)
  if (!data) return null
  const search = (first(context.searchParams.s) ?? '').trim().slice(0, 100)
  const uploaded = first(context.searchParams.uploaded) === '1'
  if (!data.as || !data.channel) return { ...data, page: null, search, uploaded }
  try {
    const page = await listVideos(cms, data.as, data.channel, {
      page: first(context.searchParams.page),
      search,
    })
    return { ...data, page, search, uploaded }
  } catch (error) {
    if (!(error instanceof GoogleError)) throw error
    return { ...data, page: null, search, uploaded, problem: error }
  }
}

export function VideosScreen({ cms, data }: AdminPageProps<VideosData> & { cms: PluginContext }) {
  const here = cms.admin.url('/youtube')
  const edit = (video: Video) =>
    `${cms.admin.url('/youtube/video/:id', { id: video.id })}${data.query}`
  const pageUrl = (token: string) =>
    `${here}${data.query}&page=${token}${data.search ? `&s=${encodeURIComponent(data.search)}` : ''}`
  return (
    <>
      {data.uploaded && (
        <Notice type="success" role="status">
          The video is at YouTube. It shows here once YouTube has finished processing it.
        </Notice>
      )}
      <Top cms={cms} data={data} here={here}>
        {data.channel && (
          <p className="search-box">
            <label className="screen-reader-text" htmlFor="g-yt-search">
              Search videos
            </label>
            <input type="search" id="g-yt-search" name="s" defaultValue={data.search} />
            <button type="submit" className="button button-compact">
              Search Videos
            </button>
          </p>
        )}
      </Top>
      {data.channel && (
        <p className="description">
          {data.channel.title}
          {data.channel.subscribers !== null && (
            <span className="num"> · {number(data.channel.subscribers)} subscribers</span>
          )}{' '}
          · <a href={`${cms.admin.url('/youtube/playlists')}${data.query}`}>Playlists</a>
        </p>
      )}
      {data.page && (
        <>
          <ListTable
            caption="Videos"
            rows={data.page.videos}
            rowKey={(video) => video.id}
            rowActions={(video) => [
              <a key="edit" href={edit(video)}>
                Edit
              </a>,
              <a
                key="view"
                href={`https://www.youtube.com/watch?v=${video.id}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                View on YouTube
              </a>,
            ]}
            columns={[
              {
                key: 'video',
                label: 'Video',
                render: (video) => (
                  <div className="g-video">
                    <span className="g-thumb">
                      {video.thumbnail && (
                        <img
                          src={video.thumbnail}
                          alt=""
                          loading="lazy"
                          referrerPolicy="no-referrer"
                        />
                      )}
                      {clock(video.duration) && <time>{clock(video.duration)}</time>}
                    </span>
                    <a className="row-title" href={edit(video)}>
                      {video.title || '(no title)'}
                    </a>
                  </div>
                ),
              },
              {
                key: 'visibility',
                label: 'Visibility',
                render: (video) => (
                  <>
                    {VISIBILITY[video.privacy]}
                    {video.publishAt && (
                      <>
                        <br />
                        <span className="description num">Goes public {day(video.publishAt)}</span>
                      </>
                    )}
                    {video.uploadStatus &&
                      !['processed', 'uploaded'].includes(video.uploadStatus) && (
                        <>
                          <br />
                          <span className="description">YouTube says: {video.uploadStatus}</span>
                        </>
                      )}
                  </>
                ),
              },
              {
                key: 'views',
                label: 'Views',
                numeric: true,
                render: (video) => number(video.views),
              },
              {
                key: 'comments',
                label: 'Comments',
                numeric: true,
                render: (video) => number(video.comments),
              },
              {
                key: 'published',
                label: 'Published',
                render: (video) => <span className="num">{day(video.publishedAt)}</span>,
              },
            ]}
            empty={data.search ? 'No videos found.' : 'This channel has no videos yet.'}
          />
          {(data.page.previous || data.page.next) && (
            <p className="g-pages">
              {data.page.previous && (
                <a className="button" href={pageUrl(data.page.previous)}>
                  ‹ Newer
                </a>
              )}
              {data.page.next && (
                <a className="button" href={pageUrl(data.page.next)}>
                  Older ›
                </a>
              )}
            </p>
          )}
        </>
      )}
    </>
  )
}

// ── A video's fields, on the edit and the upload forms ───────────────────────

/** `2026-12-01T09:00:00Z` as a `datetime-local` input takes it. */
const localTime = (iso: string | null) =>
  iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toISOString().slice(0, 16) : ''

function VideoFields({
  video,
  categories,
  playlists,
}: {
  video: Partial<Video>
  categories: Category[]
  /** Offered as "add to" on the upload form; left out on the edit form, which has its own. */
  playlists?: Playlist[]
}) {
  return (
    <FormTable>
      <FormField label="Title" htmlFor="g-title">
        <input
          id="g-title"
          name="title"
          className="regular-text"
          maxLength={MAX_TITLE}
          defaultValue={video.title ?? ''}
          required
        />
      </FormField>
      <FormField label="Description" htmlFor="g-description">
        <textarea
          id="g-description"
          name="description"
          className="large-text"
          rows={6}
          maxLength={MAX_DESCRIPTION}
          defaultValue={video.description ?? ''}
        />
      </FormField>
      <FormField
        label="Visibility"
        htmlFor="g-privacy"
        description="Private until you say otherwise."
      >
        <select id="g-privacy" name="privacy" defaultValue={video.privacy ?? 'private'}>
          <option value="private">Private</option>
          <option value="unlisted">Unlisted</option>
          <option value="public">Public</option>
        </select>
      </FormField>
      <FormField
        label="Goes public at"
        htmlFor="g-publish-at"
        description="For a private video only, in UTC. Leave empty to publish by hand."
      >
        <input
          id="g-publish-at"
          type="datetime-local"
          name="publish_at"
          defaultValue={localTime(video.publishAt ?? null)}
        />
      </FormField>
      {playlists && (
        <FormField label="Playlist" htmlFor="g-playlist">
          <select id="g-playlist" name="playlist" defaultValue="">
            <option value="">None</option>
            {playlists.map((playlist) => (
              <option key={playlist.id} value={playlist.id}>
                {playlist.title}
              </option>
            ))}
          </select>
        </FormField>
      )}
      <FormField label="Category" htmlFor="g-category">
        <select id="g-category" name="category" defaultValue={video.categoryId || '22'}>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.title}
            </option>
          ))}
        </select>
      </FormField>
      <FormField label="Audience">
        <label style={{ display: 'block' }}>
          <input type="radio" name="kids" value="no" defaultChecked={!video.madeForKids} /> Not made
          for kids
        </label>
        <label style={{ display: 'block' }}>
          <input type="radio" name="kids" value="yes" defaultChecked={video.madeForKids === true} />{' '}
          Made for kids
        </label>
      </FormField>
      <FormField label="Tags" htmlFor="g-tags" description="Separate tags with commas.">
        <input
          id="g-tags"
          name="tags"
          className="regular-text"
          defaultValue={(video.tags ?? []).join(', ')}
        />
      </FormField>
    </FormTable>
  )
}

// ── Editing a video ──────────────────────────────────────────────────────────

export interface VideoData extends Base {
  video: Video | null
  categories: Category[]
  playlists: Playlist[]
}

export async function loadVideo(
  cms: PluginContext,
  context: AdminPageContext,
): Promise<VideoData | null> {
  const id = context.params.id ?? ''
  if (!VIDEO_ID.test(id)) return null
  const data = await base(cms, context)
  if (!data) return null
  const empty = { ...data, video: null, categories: [], playlists: [] }
  if (!data.as || !data.channel) return empty
  try {
    const video = await getVideo(cms, data.as, data.channel, id)
    if (!video) return null
    const [categories, playlists] = await Promise.all([
      listCategories(cms, data.as),
      listPlaylists(cms, data.as),
    ])
    return { ...data, video, categories, playlists }
  } catch (error) {
    if (!(error instanceof GoogleError)) throw error
    return { ...empty, problem: error }
  }
}

export function VideoScreen({ cms, data }: AdminPageProps<VideoData> & { cms: PluginContext }) {
  const { video } = data
  const list = `${cms.admin.url('/youtube')}${data.query}`
  const hidden = video && data.as && (
    <>
      <input type="hidden" name="account" value={data.as.accountId} />
      <input type="hidden" name="video" value={video.id} />
    </>
  )
  return (
    <>
      <GoogleStyles />
      <YouTubeStyles />
      {data.problem && <GoogleProblem error={data.problem} />}
      <p>
        <a href={list}>← Videos</a>
      </p>
      {video && (
        <>
          <form method="post" action={cms.admin.actionUrl('youtube-save')}>
            {hidden}
            <VideoFields video={video} categories={data.categories} />
            <SubmitButton>Update</SubmitButton>
          </form>

          <h2>Playlists</h2>
          {data.playlists.length > 0 ? (
            <form method="post" action={cms.admin.actionUrl('youtube-playlist-add')}>
              {hidden}
              <label htmlFor="g-add-playlist">Add to </label>
              <select id="g-add-playlist" name="playlist">
                {data.playlists.map((playlist) => (
                  <option key={playlist.id} value={playlist.id}>
                    {playlist.title}
                  </option>
                ))}
              </select>{' '}
              <button type="submit" className="button">
                Add
              </button>
            </form>
          ) : (
            <p>
              This channel has no playlists.{' '}
              <a href={`${cms.admin.url('/youtube/playlists')}${data.query}`}>Make one</a>
            </p>
          )}

          <h2>Delete</h2>
          <form method="post" action={cms.admin.actionUrl('youtube-delete')}>
            {hidden}
            <p>
              <label>
                <input type="checkbox" name="sure" value="yes" required /> Delete this video from
                YouTube for good. It can’t be brought back.
              </label>
            </p>
            <button type="submit" className="button button-link-delete">
              Delete from YouTube
            </button>
          </form>
        </>
      )}
    </>
  )
}

// ── Uploading ────────────────────────────────────────────────────────────────

export interface UploadData extends Base {
  categories: Category[]
  playlists: Playlist[]
}

export async function loadUpload(
  cms: PluginContext,
  context: AdminPageContext,
): Promise<UploadData | null> {
  const data = await base(cms, context)
  if (!data) return null
  if (!data.as || !data.channel) return { ...data, categories: [], playlists: [] }
  try {
    const [categories, playlists] = await Promise.all([
      listCategories(cms, data.as),
      listPlaylists(cms, data.as),
    ])
    return { ...data, categories, playlists }
  } catch (error) {
    if (!(error instanceof GoogleError)) throw error
    return { ...data, categories: [], playlists: [], problem: error }
  }
}

export function UploadScreen({ cms, data }: AdminPageProps<UploadData> & { cms: PluginContext }) {
  const here = cms.admin.url('/youtube/upload')
  return (
    <>
      <Top cms={cms} data={data} here={here} />
      <p>
        <a href={`${cms.admin.url('/youtube')}${data.query}`}>← Videos</a>
      </p>
      {data.as && data.channel && data.categories.length > 0 && (
        <>
          {/* No action: the script sends the file to YouTube itself, then the form's fields here. */}
          <form
            className="g-upload"
            data-google-upload=""
            data-open={cms.routes.apiUrl('/youtube/uploads')}
            data-done={cms.routes.apiUrl('/youtube/uploads/done')}
          >
            <input type="hidden" name="account" value={data.as.accountId} />
            <FormTable>
              <FormField
                label="The file"
                htmlFor="g-file"
                description="It goes from your browser straight to YouTube. This site never holds the file, so its upload limit doesn’t apply."
              >
                <input id="g-file" type="file" accept="video/*" required />
              </FormField>
            </FormTable>
            <VideoFields video={{}} categories={data.categories} playlists={data.playlists} />
            <progress hidden />
            <p data-upload-status="" role="status" />
            <SubmitButton>Upload</SubmitButton>
            <noscript>
              <p>Uploading needs JavaScript, to send the file to YouTube from your browser.</p>
            </noscript>
          </form>
          <script src={cms.routes.apiUrl('/upload.js')} async />
        </>
      )}
    </>
  )
}

// ── Playlists ────────────────────────────────────────────────────────────────

export interface PlaylistsData extends Base {
  playlists: Playlist[]
}

export async function loadPlaylists(
  cms: PluginContext,
  context: AdminPageContext,
): Promise<PlaylistsData | null> {
  const data = await base(cms, context)
  if (!data) return null
  if (!data.as || !data.channel) return { ...data, playlists: [] }
  try {
    return { ...data, playlists: await listPlaylists(cms, data.as) }
  } catch (error) {
    if (!(error instanceof GoogleError)) throw error
    return { ...data, playlists: [], problem: error }
  }
}

export function PlaylistsScreen({
  cms,
  data,
}: AdminPageProps<PlaylistsData> & { cms: PluginContext }) {
  const here = cms.admin.url('/youtube/playlists')
  return (
    <>
      <Top cms={cms} data={data} here={here} />
      <p>
        <a href={`${cms.admin.url('/youtube')}${data.query}`}>← Videos</a>
      </p>
      {data.as && data.channel && (
        <>
          <ListTable
            caption="Playlists"
            rows={data.playlists}
            rowKey={(playlist) => playlist.id}
            columns={[
              {
                key: 'title',
                label: 'Playlist',
                render: (playlist) => (
                  <a
                    className="row-title"
                    href={`https://www.youtube.com/playlist?list=${playlist.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {playlist.title}
                  </a>
                ),
              },
              {
                key: 'privacy',
                label: 'Visibility',
                render: (playlist) => VISIBILITY[playlist.privacy],
              },
              {
                key: 'count',
                label: 'Videos',
                numeric: true,
                render: (playlist) => number(playlist.count),
              },
            ]}
            empty="This channel has no playlists yet."
          />
          <h2>Add a playlist</h2>
          <form method="post" action={cms.admin.actionUrl('youtube-playlist-create')}>
            <input type="hidden" name="account" value={data.as.accountId} />
            <FormTable>
              <FormField label="Title" htmlFor="g-playlist-title">
                <input
                  id="g-playlist-title"
                  name="title"
                  className="regular-text"
                  maxLength={150}
                  required
                />
              </FormField>
              <FormField label="Visibility" htmlFor="g-playlist-privacy">
                <select id="g-playlist-privacy" name="privacy" defaultValue="private">
                  <option value="private">Private</option>
                  <option value="unlisted">Unlisted</option>
                  <option value="public">Public</option>
                </select>
              </FormField>
            </FormTable>
            <SubmitButton>Add Playlist</SubmitButton>
          </form>
        </>
      )}
    </>
  )
}
