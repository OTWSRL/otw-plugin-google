import {
  ActionError,
  MediaError,
  type AdminActionContext,
  type AdminActionResult,
  type PluginContext,
  type User,
} from '@otwdesign/sdk'
import type { GoogleAccount } from '../../accounts'
import { GoogleError } from '../../google'
import { requireAccount } from '../shared'
import {
  cleanName,
  createFolder,
  DRIVE,
  FILE_ID,
  formatBytes,
  getFile,
  problemText,
  readFile,
  renameFile,
  ROOT,
  setTrashed,
} from './client'

// What the Drive screen's forms do. The CMS has checked that the post came from this site and
// that the person may use Google; each action still checks that the account named is theirs.

/** The most files one post moves to the trash or back: a page of the list. */
const MAX_BULK = 50
/** The largest file copied to the Media library: it passes through this server's memory. */
export const MAX_COPY_BYTES = 32 * 1024 * 1024

function field(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value.trim() : ''
}

/** The person's own account named by the form, which has allowed Drive; nothing else passes. */
async function accountOf(cms: PluginContext, user: User, form: FormData): Promise<GoogleAccount> {
  const account = await requireAccount(cms, user, DRIVE, field(form, 'account'))
  if (!account) throw new ActionError('That Google account can’t use Drive here.')
  return account
}

function fileId(form: FormData, name = 'id'): string {
  const id = field(form, name)
  if (!FILE_ID.test(id)) throw new ActionError('That file isn’t in Drive any more.')
  return id
}

/** Runs a call to Drive, turning what Google says into a message for the person. */
async function drive<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!(error instanceof GoogleError)) throw error
    // The account has allowed Drive, or it wouldn't be here: Google refuses this one file.
    if (error.kind === 'permission') {
      throw new ActionError(
        'Google doesn’t let this account change that. It may belong to someone else.',
      )
    }
    throw new ActionError(problemText(error))
  }
}

async function newFolder(
  cms: PluginContext,
  { user, form }: AdminActionContext,
): Promise<AdminActionResult> {
  const account = await accountOf(cms, user, form)
  const name = cleanName(field(form, 'name'))
  if (!name) throw new ActionError('Give the folder a name.')
  const parent = field(form, 'parent') || ROOT
  if (!FILE_ID.test(parent)) throw new ActionError('That folder isn’t in Drive any more.')
  const folder = await drive(() => createFolder(cms, user.id, account.id, name, parent))
  return { notice: `The folder “${folder.name}” was made.` }
}

async function rename(
  cms: PluginContext,
  { user, form }: AdminActionContext,
): Promise<AdminActionResult> {
  const account = await accountOf(cms, user, form)
  const id = fileId(form)
  const name = cleanName(field(form, 'name'))
  if (!name) throw new ActionError('Give it a name.')
  const file = await drive(() => renameFile(cms, user.id, account.id, id, name))
  return { notice: `Renamed to “${file.name}”.` }
}

/** The ids a form names, once each: one row's button, or the ticked rows of the list. */
function fileIds(form: FormData): string[] {
  const ids = [...new Set(form.getAll('ids').filter((id): id is string => typeof id === 'string'))]
  if (ids.length === 0) throw new ActionError('Tick the files first.')
  if (ids.length > MAX_BULK) throw new ActionError(`Choose ${MAX_BULK} files or fewer at a time.`)
  if (!ids.every((id) => FILE_ID.test(id))) {
    throw new ActionError('One of those files isn’t in Drive any more.')
  }
  return ids
}

/** Moves the form's files to the trash or back, one after another, and says how it went. */
async function moveAll(
  cms: PluginContext,
  { user, form }: AdminActionContext,
  trashed: boolean,
): Promise<AdminActionResult> {
  const account = await accountOf(cms, user, form)
  const ids = fileIds(form)
  let moved = 0
  let problem: ActionError | null = null
  for (const id of ids) {
    try {
      await drive(() => setTrashed(cms, user.id, account.id, id, trashed))
      moved++
    } catch (error) {
      if (!(error instanceof ActionError)) throw error
      problem = error
    }
  }
  // Nothing moved: the reason is the answer. Some moved: say how many, and that some didn't.
  if (moved === 0 && problem) throw problem
  const files = moved === 1 ? '1 file' : `${moved} files`
  const where = trashed ? 'moved to the trash' : 'restored'
  const rest = ids.length - moved
  return {
    notice:
      rest === 0
        ? `${files} ${where}.`
        : `${files} ${where}; ${rest} couldn’t be: ${problem!.message}`,
  }
}

const trash = (cms: PluginContext, context: AdminActionContext) => moveAll(cms, context, true)
const restore = (cms: PluginContext, context: AdminActionContext) => moveAll(cms, context, false)

/** Copies one of Drive's files into the site's Media library, for people who may upload there. */
async function toMedia(
  cms: PluginContext,
  { user, form }: AdminActionContext,
): Promise<AdminActionResult> {
  if (!cms.auth.can(user, 'core.upload_files')) {
    throw new ActionError('You may not add files to the Media library.')
  }
  const account = await accountOf(cms, user, form)
  const id = fileId(form)
  const tooLarge = () =>
    new ActionError(
      `Only files up to ${formatBytes(MAX_COPY_BYTES)} can be copied to the Media library from here.`,
    )
  const file = await drive(() => getFile(cms, user.id, account.id, id))
  if (file.kind !== 'file') {
    throw new ActionError('Only files can be copied: a folder or a Google document has no file.')
  }
  if (file.size !== null && file.size > MAX_COPY_BYTES) throw tooLarge()
  // The limit holds while reading too: the size above is only what Google said.
  const data = await drive(() => readFile(cms, user.id, account.id, id, MAX_COPY_BYTES))
  if (!data) throw tooLarge()
  try {
    const item = await cms.media.upload({ name: file.name, data }, { by: user.id })
    return { notice: `“${item.filename}” is in the Media library now.` }
  } catch (error) {
    // The library's own refusal: a type it doesn't take, a file over the site's limit.
    if (error instanceof MediaError) throw new ActionError(error.message)
    throw error
  }
}

export {
  newFolder as 'drive-new-folder',
  rename as 'drive-rename',
  trash as 'drive-trash',
  restore as 'drive-restore',
  toMedia as 'drive-to-media',
}
