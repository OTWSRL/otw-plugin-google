import {
  ActionError,
  type AdminActionContext,
  type AdminActionResult,
  type PluginContext,
} from '@otwdesign/sdk'
import { GoogleError } from '../../google'
import { buildMime, splitAddress, type MimeAttachment } from '../../mime'
import { requireAccount } from '../shared'
import { splitList } from './address'
import {
  ALL_MAIL,
  createLabel,
  deleteDraft,
  deleteLabel,
  getAttachment,
  getDraft,
  GMAIL_ID,
  listLabels,
  listSendAs,
  modifyThread,
  PART_ID,
  renameLabel,
  replyTarget,
  saveDraft,
  sendMessage,
  trashThread,
  untrashThread,
  type Mailbox,
} from './client'

// What the mail screens' buttons do. The CMS has checked that the post came from this site and
// that the person may use Google; each action still finds the account among the person's own.

const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/
/** The most threads one press of a button changes: a page of the list, with room to spare. */
const MAX_THREADS = 50
const MAX_RECIPIENTS = 100
const MAX_SUBJECT = 500
const MAX_BODY = 1024 * 1024
const MAX_LABEL_NAME = 100
const MAX_FILES = 10
/** What a message's attachments may come to, new files and carried ones together. */
export const MAX_ATTACHED_BYTES = 10 * 1024 * 1024

function field(form: FormData, name: string): string {
  const value = form.get(name)
  return typeof value === 'string' ? value : ''
}

/** The person's mailbox the form names: one of their own accounts that has allowed Gmail. */
async function mailboxOf(cms: PluginContext, { user, form }: AdminActionContext): Promise<Mailbox> {
  const account = await requireAccount(cms, user, 'gmail', field(form, 'account'))
  if (!account) {
    throw new ActionError('That Google account isn’t connected, or hasn’t allowed Gmail.')
  }
  return { cms, userId: user.id, accountId: account.id }
}

/**
 * Runs what talks to Google, and says a problem there in words of this plugin's own: Google's
 * answer never reaches the page.
 */
async function atGoogle<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (!(error instanceof GoogleError)) throw error
    throw new ActionError(error.kind === 'refused' ? `Google refused to ${what}.` : error.message)
  }
}

/** The mail screen's address for a label, a search and an account, without an open thread. */
export function listPath(
  cms: PluginContext,
  view: { account: string; label?: string; q?: string; manage?: string },
): string {
  const query = new URLSearchParams({ account: view.account })
  if (view.label && view.label !== 'INBOX') query.set('label', view.label)
  if (view.q) query.set('q', view.q)
  if (view.manage) query.set('manage', view.manage)
  return `${cms.admin.url('/gmail')}?${query}`
}

const labelOf = (form: FormData): string => {
  const label = field(form, 'label')
  return label === ALL_MAIL || GMAIL_ID.test(label) ? label : 'INBOX'
}

// ── Threads ────────────────────────────────────────────────────────────────────

type ThreadChange = (box: Mailbox, threadId: string, form: FormData) => Promise<void>

interface ThreadOp {
  change: ThreadChange
  /** What happened, for one thread and for several. */
  done: [string, string]
  what: string
  /** Whether the thread leaves the list it was opened from. */
  leaves: boolean
}

const relabel =
  (add: string[], remove: string[]): ThreadChange =>
  (box, threadId) =>
    modifyThread(box, threadId, { add, remove })

/** One of the person's own labels by id: Gmail's own are changed by their buttons, not by name. */
async function ownLabel(box: Mailbox, labelId: string): Promise<string> {
  const labels = GMAIL_ID.test(labelId) ? await listLabels(box) : []
  const label = labels.find((candidate) => candidate.id === labelId && !candidate.system)
  if (!label) throw new ActionError('Choose one of your labels.')
  return label.id
}

const THREAD_OPS: Record<string, ThreadOp> = {
  archive: {
    change: relabel([], ['INBOX']),
    done: ['Conversation archived.', 'conversations archived.'],
    what: 'archive that',
    leaves: true,
  },
  trash: {
    change: (box, threadId) => trashThread(box, threadId),
    done: ['Conversation moved to Trash.', 'conversations moved to Trash.'],
    what: 'move that to Trash',
    leaves: true,
  },
  untrash: {
    change: (box, threadId) => untrashThread(box, threadId),
    done: ['Conversation restored from Trash.', 'conversations restored from Trash.'],
    what: 'restore that',
    leaves: true,
  },
  spam: {
    change: relabel(['SPAM'], ['INBOX']),
    done: ['Conversation reported as spam.', 'conversations reported as spam.'],
    what: 'report that as spam',
    leaves: true,
  },
  'not-spam': {
    change: relabel(['INBOX'], ['SPAM']),
    done: ['Conversation moved to the Inbox.', 'conversations moved to the Inbox.'],
    what: 'move that to the Inbox',
    leaves: true,
  },
  read: {
    change: relabel([], ['UNREAD']),
    done: ['Marked as read.', 'conversations marked as read.'],
    what: 'mark that as read',
    leaves: false,
  },
  unread: {
    change: relabel(['UNREAD'], []),
    done: ['Marked as unread.', 'conversations marked as unread.'],
    what: 'mark that as unread',
    leaves: true,
  },
  star: {
    change: relabel(['STARRED'], []),
    done: ['Starred.', 'conversations starred.'],
    what: 'star that',
    leaves: false,
  },
  unstar: {
    change: relabel([], ['STARRED']),
    done: ['Star removed.', 'conversations unstarred.'],
    what: 'remove that star',
    leaves: false,
  },
  'label-add': {
    change: async (box, threadId, form) =>
      modifyThread(box, threadId, { add: [field(form, 'apply')] }),
    done: ['Label applied.', 'conversations labelled.'],
    what: 'apply that label',
    leaves: false,
  },
  'label-remove': {
    change: async (box, threadId, form) =>
      modifyThread(box, threadId, { remove: [field(form, 'apply')] }),
    done: ['Label removed.', 'conversations had the label removed.'],
    what: 'remove that label',
    leaves: false,
  },
}

/** The threads a form names: the open one (`id`), or the list's ticked boxes (`ids`). */
function threadIds(form: FormData): { ids: string[]; single: boolean } {
  const one = field(form, 'id')
  const many = form.getAll('ids').filter((value): value is string => typeof value === 'string')
  const ids = [...new Set(one ? [one] : many)]
  if (ids.length === 0) throw new ActionError('Tick at least one conversation first.')
  if (ids.length > MAX_THREADS || !ids.every((value) => GMAIL_ID.test(value))) {
    throw new ActionError('Those conversations can’t be changed together. Try fewer.')
  }
  return { ids, single: Boolean(one) }
}

/** Archive, Trash, Spam, read, star, a label: one change to one thread or to the ticked ones. */
export async function thread(
  cms: PluginContext,
  op: string,
  context: AdminActionContext,
): Promise<AdminActionResult> {
  const change = THREAD_OPS[op]
  if (!change) throw new ActionError('That can’t be done here.')
  const { form } = context
  const box = await mailboxOf(cms, context)
  const { ids, single } = threadIds(form)
  await atGoogle(change.what, async () => {
    if (op === 'label-add' || op === 'label-remove') {
      // Checked against Gmail's own list: the id in the form is only a request.
      form.set('apply', await ownLabel(box, field(form, 'apply')))
    }
    // A few at a time: Gmail counts each change against the account's rate.
    for (let from = 0; from < ids.length; from += 5) {
      await Promise.all(ids.slice(from, from + 5).map((id) => change.change(box, id, form)))
    }
  })
  const notice = ids.length === 1 ? change.done[0] : `${ids.length} ${change.done[1]}`
  // The open thread is no longer where it was opened from: back to that list.
  return single && change.leaves
    ? {
        notice,
        redirect: listPath(cms, {
          account: box.accountId,
          label: labelOf(form),
          q: field(form, 'q').slice(0, 500),
        }),
      }
    : { notice }
}

// ── Labels ─────────────────────────────────────────────────────────────────────

function labelName(form: FormData): string {
  const name = field(form, 'name').trim()
  if (!name || name.length > MAX_LABEL_NAME || /\p{Cc}/u.test(name)) {
    throw new ActionError(`Give the label a name of up to ${MAX_LABEL_NAME} characters.`)
  }
  return name
}

export async function labelCreate(
  cms: PluginContext,
  context: AdminActionContext,
): Promise<AdminActionResult> {
  const box = await mailboxOf(cms, context)
  const name = labelName(context.form)
  await atGoogle('add that label; one with that name may exist already', () =>
    createLabel(box, name),
  )
  return { notice: `The label “${name}” was added.` }
}

export async function labelRename(
  cms: PluginContext,
  context: AdminActionContext,
): Promise<AdminActionResult> {
  const box = await mailboxOf(cms, context)
  const name = labelName(context.form)
  await atGoogle('rename that label; one with that name may exist already', async () =>
    renameLabel(box, await ownLabel(box, field(context.form, 'id')), name),
  )
  return { notice: `The label is now called “${name}”.` }
}

/** Deletes a label. Its conversations stay: they only lose the label. */
export async function labelDelete(
  cms: PluginContext,
  context: AdminActionContext,
): Promise<AdminActionResult> {
  const box = await mailboxOf(cms, context)
  await atGoogle('delete that label', async () =>
    deleteLabel(box, await ownLabel(box, field(context.form, 'id'))),
  )
  return { notice: 'The label was deleted. Its conversations are still in All mail.' }
}

// ── Writing ────────────────────────────────────────────────────────────────────

/** A line of the form that becomes a header: a line break in it is refused, never dropped. */
function oneLine(form: FormData, name: string, label: string): string {
  const value = field(form, name)
  if (/[\r\n\0]/.test(value)) throw new ActionError(`${label} can’t contain a line break.`)
  return value.trim()
}

/** The addresses of a To, Cc or Bcc line, each checked: `Name <address>` or a bare address. */
export function recipients(value: string, label: string): string[] {
  return splitList(value).map((part) => {
    const { name, address } = splitAddress(part)
    // A name that holds brackets of its own would show one address and send to another.
    if (!EMAIL.test(address) || address.length > 254 || name.length > 100 || /[<>]/.test(name)) {
      throw new ActionError(`${label}: “${part.slice(0, 80)}” isn’t an email address.`)
    }
    return name ? `${name} <${address}>` : address
  })
}

interface Draft {
  box: Mailbox
  mime: string
  threadId: string | null
  draftId: string | null
  to: number
}

/** The files chosen in the form, and how much they come to. */
function uploaded(form: FormData): File[] {
  const files = form
    .getAll('files')
    .filter((value): value is File => typeof value !== 'string' && value.size > 0)
  if (files.length > MAX_FILES) {
    throw new ActionError(`Attach up to ${MAX_FILES} files at a time.`)
  }
  return files
}

const tooLarge = () =>
  new ActionError(
    `Attachments can come to ${MAX_ATTACHED_BYTES / 1024 / 1024} MB at most. Send larger files as a link.`,
  )

/** The attachments of the message being written: files chosen now, and ones carried over. */
async function attachmentsOf(box: Mailbox, form: FormData): Promise<MimeAttachment[]> {
  const files = uploaded(form)
  let total = files.reduce((sum, file) => sum + file.size, 0)
  if (total > MAX_ATTACHED_BYTES) throw tooLarge()
  const attachments: MimeAttachment[] = []
  // Carried from the draft being edited, or from the message being forwarded: fetched from the
  // person's own mailbox by their place in that message, never taken from the form.
  const source = field(form, 'source')
  const keep = form.getAll('keep').filter((value): value is string => typeof value === 'string')
  if (keep.length > 0) {
    if (
      !GMAIL_ID.test(source) ||
      keep.length > MAX_FILES ||
      !keep.every((id) => PART_ID.test(id))
    ) {
      throw new ActionError('Those attachments can’t be carried over. Attach them again.')
    }
    for (const partId of new Set(keep)) {
      const file = await getAttachment(box, source, partId)
      if (!file) throw new ActionError('An attachment to carry over is no longer there.')
      total += file.content.byteLength
      if (total > MAX_ATTACHED_BYTES) throw tooLarge()
      attachments.push({ filename: file.filename, type: file.type, content: file.content })
    }
  }
  for (const file of files) {
    attachments.push({
      filename: file.name,
      type: file.type,
      content: new Uint8Array(await file.arrayBuffer()),
    })
  }
  return attachments
}

/** What the writing form holds, checked, as the message Gmail will be given. */
async function written(
  cms: PluginContext,
  context: AdminActionContext,
  sending: boolean,
): Promise<Draft> {
  const { form } = context
  const box = await mailboxOf(cms, context)
  const from = oneLine(form, 'from', 'From').toLowerCase()
  const to = recipients(oneLine(form, 'to', 'To'), 'To')
  const cc = recipients(oneLine(form, 'cc', 'Cc'), 'Cc')
  const bcc = recipients(oneLine(form, 'bcc', 'Bcc'), 'Bcc')
  const subject = oneLine(form, 'subject', 'The subject')
  const body = field(form, 'body')
  const reply = field(form, 'reply')
  const draftId = field(form, 'draft')
  if (sending && to.length + cc.length + bcc.length === 0) {
    throw new ActionError('Say who the message is to.')
  }
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) {
    throw new ActionError(`A message can go to ${MAX_RECIPIENTS} addresses at most.`)
  }
  if (subject.length > MAX_SUBJECT) {
    throw new ActionError(`The subject can have ${MAX_SUBJECT} characters at most.`)
  }
  if (body.length > MAX_BODY) throw new ActionError('The message is too long to send.')
  if ((reply && !GMAIL_ID.test(reply)) || (draftId && !GMAIL_ID.test(draftId))) {
    throw new ActionError('That message can’t be found any more.')
  }

  return atGoogle(sending ? 'send that' : 'save that', async () => {
    // The sender is one of the addresses Gmail lets this account send from, by Gmail's word.
    const sender = (await listSendAs(box)).find((candidate) => candidate.email === from)
    if (!sender) throw new ActionError('Choose one of the addresses this account sends from.')
    // What it answers comes from Gmail too: the message it replies to, or the draft's own headers.
    const answered = reply ? await replyTarget(box, reply) : null
    if (reply && !answered)
      throw new ActionError('The message you’re answering is no longer there.')
    const existing = !answered && draftId ? await getDraft(box, draftId) : null
    const target = answered
      ? {
          threadId: answered.threadId,
          inReplyTo: answered.messageId,
          references: `${answered.references} ${answered.messageId}`.trim(),
        }
      : existing?.inReplyTo
        ? {
            threadId: existing.threadId,
            inReplyTo: existing.inReplyTo,
            references: existing.references,
          }
        : null
    const mime = buildMime({
      from: sender.name ? `${sender.name} <${sender.email}>` : sender.email,
      to,
      cc,
      bcc,
      subject,
      text: body,
      inReplyTo: target?.inReplyTo || null,
      references: target?.references || null,
      attachments: await attachmentsOf(box, form),
    })
    return {
      box,
      mime,
      threadId: target?.threadId || null,
      draftId: draftId || null,
      to: to.length + cc.length + bcc.length,
    }
  })
}

/** Sends what the writing form holds. A draft it was written in is done with, and deleted. */
export async function send(
  cms: PluginContext,
  context: AdminActionContext,
): Promise<AdminActionResult> {
  const draft = await written(cms, context, true)
  await atGoogle('send that', async () => {
    await sendMessage(draft.box, draft.mime, draft.threadId)
    if (draft.draftId) await deleteDraft(draft.box, draft.draftId)
  })
  return {
    notice: 'Your message was sent.',
    redirect: listPath(cms, { account: draft.box.accountId }),
  }
}

/** Keeps what the writing form holds as a draft, a new one or the one being edited. */
export async function draftSave(
  cms: PluginContext,
  context: AdminActionContext,
): Promise<AdminActionResult> {
  const draft = await written(cms, context, false)
  const id = await atGoogle('save that', () =>
    saveDraft(draft.box, draft.mime, draft.threadId, draft.draftId),
  )
  const query = new URLSearchParams({ account: draft.box.accountId, ...(id ? { draft: id } : {}) })
  return { notice: 'Draft saved.', redirect: `${cms.admin.url('/gmail/compose')}?${query}` }
}

export async function draftDelete(
  cms: PluginContext,
  context: AdminActionContext,
): Promise<AdminActionResult> {
  const box = await mailboxOf(cms, context)
  const draftId = field(context.form, 'draft')
  if (GMAIL_ID.test(draftId)) await atGoogle('discard that', () => deleteDraft(box, draftId))
  return {
    notice: 'Draft discarded.',
    redirect: listPath(cms, { account: box.accountId, label: 'DRAFT' }),
  }
}

/** The changes `thread()` knows, for checking the admin entry registers each. */
export const THREAD_CHANGES = Object.keys(THREAD_OPS)
