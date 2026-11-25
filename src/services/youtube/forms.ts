import { ActionError } from '@otwdesign/sdk'
import {
  MAX_DESCRIPTION,
  MAX_TAGS,
  MAX_TITLE,
  PLAYLIST_ID,
  PRIVACY,
  type Privacy,
  type VideoChanges,
} from './client'

// What a video's form sends, checked: the edit screen's post and the upload's JSON are the same
// fields, and both are typed by someone.

/** A field's text from a form, or from the upload's JSON: anything else is empty. */
export type Fields = (name: string) => string

export const formFields =
  (form: FormData): Fields =>
  (name) => {
    const value = form.get(name)
    return typeof value === 'string' ? value : ''
  }

export const jsonFields =
  (body: Record<string, unknown>): Fields =>
  (name) => {
    const value = body[name]
    return typeof value === 'string' ? value : ''
  }

/** A time typed into the form, which is in UTC: `2026-12-01T09:00`. */
const LOCAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/

/** A video's details from a form, or an `ActionError` that says which one to fix. */
export function readChanges(field: Fields, now = Date.now()): VideoChanges {
  const title = field('title').trim()
  // YouTube refuses a title with these two characters.
  if (!title || title.length > MAX_TITLE || /[<>]/.test(title)) {
    throw new ActionError(
      `Give the video a title of up to ${MAX_TITLE} characters, without < or >.`,
    )
  }
  const description = field('description').replace(/\r\n/g, '\n').trim()
  if (description.length > MAX_DESCRIPTION || /[<>]/.test(description)) {
    throw new ActionError(`A description has up to ${MAX_DESCRIPTION} characters, without < or >.`)
  }
  const tags = [
    ...new Set(
      field('tags')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ]
  if (tags.join(',').length > MAX_TAGS || tags.some((tag) => /[<>]/.test(tag))) {
    throw new ActionError(`Tags have up to ${MAX_TAGS} characters together, without < or >.`)
  }
  const categoryId = field('category')
  if (!/^\d{1,4}$/.test(categoryId)) throw new ActionError('Choose a category.')
  const privacy = field('privacy') as Privacy
  if (!PRIVACY.includes(privacy)) throw new ActionError('Choose who can see the video.')
  let publishAt: string | null = null
  const at = field('publish_at')
  if (at) {
    const time = LOCAL_TIME.test(at) ? Date.parse(`${at}:00Z`) : NaN
    if (Number.isNaN(time) || time <= now) {
      throw new ActionError('The time it goes public must be in the future.')
    }
    if (privacy !== 'private') {
      throw new ActionError('Only a private video can be set to go public later.')
    }
    publishAt = new Date(time).toISOString()
  }
  return {
    title,
    description,
    tags,
    categoryId,
    privacy,
    publishAt,
    madeForKids: field('kids') === 'yes',
  }
}

/** A playlist's id from a form: empty for none, or an `ActionError`. */
export function readPlaylist(field: Fields): string | null {
  const playlist = field('playlist')
  if (!playlist) return null
  if (!PLAYLIST_ID.test(playlist)) throw new ActionError('Choose one of your playlists.')
  return playlist
}
