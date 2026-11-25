import {
  ActionError,
  type AdminActionContext,
  type AdminActionResult,
  type PluginContext,
  type User,
} from '@otwdesign/sdk'
import { GoogleError } from '../../google'
import { requireAccount } from '../shared'
import {
  addToPlaylist,
  createPlaylist,
  deleteVideo,
  getVideo,
  listPlaylists,
  myChannel,
  PRIVACY,
  updateVideo,
  VIDEO_ID,
  type As,
  type Privacy,
} from './client'
import { formFields, readChanges, readPlaylist } from './forms'

// What the YouTube screens' forms do. Each names the account it's for, which must be the
// person's own and allowed to use YouTube, and the video, which must be on that account's channel.

const listUrl = (cms: PluginContext, as: As) =>
  `${cms.admin.url('/youtube')}?account=${as.accountId}`

/** What Google said went wrong, as a message on the form's page. */
async function atGoogle<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof GoogleError) throw new ActionError(error.message)
    throw error
  }
}

async function accountOf(cms: PluginContext, user: User, form: FormData): Promise<As> {
  const account = await requireAccount(cms, user, 'youtube', formFields(form)('account'))
  if (!account) throw new ActionError('That Google account can’t use YouTube here any more.')
  return { userId: user.id, accountId: account.id }
}

/** The account's channel and one of its own videos, named by the form. */
async function ownVideo(cms: PluginContext, as: As, form: FormData) {
  const id = formFields(form)('video')
  const channel = VIDEO_ID.test(id) ? await myChannel(cms, as) : null
  const video = channel ? await getVideo(cms, as, channel, id) : null
  if (!channel || !video) throw new ActionError('That video isn’t on this channel any more.')
  return { channel, video }
}

async function save(
  cms: PluginContext,
  { user, form }: AdminActionContext,
): Promise<AdminActionResult> {
  const changes = readChanges(formFields(form))
  const as = await accountOf(cms, user, form)
  return atGoogle(async () => {
    const { video } = await ownVideo(cms, as, form)
    await updateVideo(cms, as, video.id, changes)
    return { notice: 'Video updated.' }
  })
}

async function remove(
  cms: PluginContext,
  { user, form }: AdminActionContext,
): Promise<AdminActionResult> {
  if (formFields(form)('sure') !== 'yes') {
    throw new ActionError('Tick the box to say you want the video deleted for good.')
  }
  const as = await accountOf(cms, user, form)
  return atGoogle(async () => {
    const { video } = await ownVideo(cms, as, form)
    await deleteVideo(cms, as, video.id)
    cms.logger.info('A YouTube video was deleted', { video: video.id, by: user.id })
    return { redirect: listUrl(cms, as), notice: `“${video.title}” was deleted from YouTube.` }
  })
}

async function playlistAdd(
  cms: PluginContext,
  { user, form }: AdminActionContext,
): Promise<AdminActionResult> {
  const playlist = readPlaylist(formFields(form))
  if (!playlist) throw new ActionError('Choose one of your playlists.')
  const as = await accountOf(cms, user, form)
  return atGoogle(async () => {
    const { video } = await ownVideo(cms, as, form)
    // One of the account's own playlists: an id typed into the form adds to nobody else's.
    const mine = (await listPlaylists(cms, as)).find((item) => item.id === playlist)
    if (!mine) throw new ActionError('Choose one of your playlists.')
    await addToPlaylist(cms, as, mine.id, video.id)
    return { notice: `Added to “${mine.title}”.` }
  })
}

async function playlistCreate(
  cms: PluginContext,
  { user, form }: AdminActionContext,
): Promise<AdminActionResult> {
  const field = formFields(form)
  const title = field('title').trim()
  if (!title || title.length > 150 || /[<>]/.test(title)) {
    throw new ActionError('Give the playlist a title of up to 150 characters, without < or >.')
  }
  const privacy = field('privacy') as Privacy
  if (!PRIVACY.includes(privacy)) throw new ActionError('Choose who can see the playlist.')
  const as = await accountOf(cms, user, form)
  await atGoogle(() => createPlaylist(cms, as, title, privacy))
  return { notice: `The playlist “${title}” was made.` }
}

export {
  save as 'youtube-save',
  remove as 'youtube-delete',
  playlistAdd as 'youtube-playlist-add',
  playlistCreate as 'youtube-playlist-create',
}
