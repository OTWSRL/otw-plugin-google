import { randomBytes } from 'node:crypto'
import type { PluginContext } from '@otwdesign/sdk'
import { googleFetch, googleJson } from '../../accounts'
import { apiAnswer, GoogleError, googleUrl, type ApiRequest } from '../../google'

// Gmail's API as the mail screens use it. Every call names whose account it is, and nothing is
// kept: a list or a message is read from Google each time it's shown.

/** Whose mailbox a call is for: the signed-in person, and one of their accounts. */
export interface Mailbox {
  cms: PluginContext
  userId: string
  accountId: string
}

/** Gmail's ids for messages, threads, labels and drafts: letters, digits, `_` and `-`. */
export const GMAIL_ID = /^[A-Za-z0-9_-]{1,512}$/
/** A part's place in its message: `0`, `1.2`. */
export const PART_ID = /^\d{1,3}(?:\.\d{1,3}){0,9}$/

/** Threads on a page of a list: each costs Gmail ten quota units to describe. */
export const PAGE_SIZE = 15
/** How many of a person's own labels get an unread count; the rest are listed without one. */
const COUNTED_LABELS = 30
/** The most one attachment may be to be handed on: Gmail's own limit for a message. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
/** A message goes as JSON up to this size, and through Gmail's upload address beyond it. */
const JSON_SEND_LIMIT = 3 * 1024 * 1024
const BATCH_LIMIT_BYTES = 8 * 1024 * 1024
const MAX_BODY_BYTES = 2 * 1024 * 1024

const path = (rest: string) => `/gmail/v1/users/me${rest}`
const url = (rest: string) => googleUrl('gmail.googleapis.com', path(rest))

const call = <T>(box: Mailbox, rest: string, request: ApiRequest = {}): Promise<T> =>
  googleJson<T>(box.cms, box.userId, box.accountId, url(rest), request)

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const id = (value: unknown): string => (GMAIL_ID.test(text(value)) ? text(value) : '')

// ── Reading what Gmail returns ─────────────────────────────────────────────────

/** A body read up to `limit` bytes: an answer larger than expected is refused, not held. */
async function readBytes(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => undefined)
      throw new GoogleError('unavailable', 'Google’s answer was larger than expected.')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/** A header's value with RFC 2047 encoded words read, should Gmail hand one over as it came. */
export function decodeHeader(value: string): string {
  return value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(
      /=\?([\w-]+)\?([bBqQ])\?([^?]*)\?=/g,
      (whole, charset: string, kind: string, data: string) => {
        try {
          const bytes =
            kind.toLowerCase() === 'b'
              ? Buffer.from(data, 'base64')
              : Buffer.from(
                  data
                    .replace(/_/g, ' ')
                    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
                      String.fromCharCode(parseInt(hex, 16)),
                    ),
                  'latin1',
                )
          return new TextDecoder(charset).decode(bytes)
        } catch {
          return whole
        }
      },
    )
    .replace(/\p{Cc}+/gu, ' ')
    .trim()
}

type Headers = ReadonlyMap<string, string>

function headersOf(payload: unknown): Headers {
  const headers = new Map<string, string>()
  for (const entry of list(record(payload).headers)) {
    const name = text(record(entry).name).toLowerCase()
    // The first of a repeated header is the one mail readers show.
    if (name && !headers.has(name)) headers.set(name, decodeHeader(text(record(entry).value)))
  }
  return headers
}

const dateOf = (message: Record<string, unknown>): Date | null => {
  const ms = Number(text(message.internalDate))
  return Number.isFinite(ms) && ms > 0 ? new Date(ms) : null
}

const labelIdsOf = (message: Record<string, unknown>): string[] =>
  list(message.labelIds).map(id).filter(Boolean)

/** The charset a part says its text is in; UTF-8 when it doesn't, or names one nobody knows. */
function decodeBody(data: string, contentType: string): string {
  const bytes = Buffer.from(data, 'base64url')
  const charset = /charset\s*=\s*"?([\w.:-]+)"?/i.exec(contentType)?.[1] ?? 'utf-8'
  try {
    return new TextDecoder(charset).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

// ── Labels ─────────────────────────────────────────────────────────────────────

export interface MailLabel {
  id: string
  name: string
  /** One of Gmail's own (Inbox, Sent, …), which can't be renamed or deleted. */
  system: boolean
  /** Unread threads, where it was asked for. */
  unread: number | null
}

/** Gmail's own labels the screen lists, in its order, under the names people know. */
const SYSTEM_LABELS: readonly [string, string][] = [
  ['INBOX', 'Inbox'],
  ['STARRED', 'Starred'],
  ['SENT', 'Sent'],
  ['DRAFT', 'Drafts'],
  ['SPAM', 'Spam'],
  ['TRASH', 'Trash'],
]
/** The pseudo-label for everything but Spam and Trash. */
export const ALL_MAIL = 'all'
/** System labels whose unread count is worth a call. */
const COUNTED_SYSTEM = ['INBOX', 'DRAFT', 'SPAM']

/** The labels to list: Gmail's own first, then the person's by name. No counts yet. */
export async function listLabels(box: Mailbox): Promise<MailLabel[]> {
  const answer = record(await call(box, '/labels'))
  const own: MailLabel[] = []
  const present = new Set<string>()
  for (const entry of list(answer.labels)) {
    const label = record(entry)
    const labelId = id(label.id)
    if (!labelId) continue
    present.add(labelId)
    if (text(label.type) === 'user') {
      own.push({ id: labelId, name: text(label.name).slice(0, 200), system: false, unread: null })
    }
  }
  own.sort((a, b) => a.name.localeCompare(b.name))
  return [
    ...SYSTEM_LABELS.filter(([labelId]) => present.has(labelId)).map(([labelId, name]) => ({
      id: labelId,
      name,
      system: true,
      unread: null,
    })),
    ...own,
  ]
}

export async function createLabel(box: Mailbox, name: string): Promise<void> {
  await call(box, '/labels', {
    method: 'POST',
    json: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
  })
}

export async function renameLabel(box: Mailbox, labelId: string, name: string): Promise<void> {
  await call(box, `/labels/${labelId}`, { method: 'PATCH', json: { name } })
}

export async function deleteLabel(box: Mailbox, labelId: string): Promise<void> {
  await call(box, `/labels/${labelId}`, { method: 'DELETE' })
}

// ── Several reads in one request ───────────────────────────────────────────────

/** What Google's batch endpoint said for each read, in the order asked; `null` for one that failed. */
async function batchOnce(box: Mailbox, paths: readonly string[]): Promise<(unknown | null)[]> {
  const boundary = `batch_${randomBytes(12).toString('hex')}`
  const body = `${paths
    .map(
      (item, index) =>
        `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <item-${index}>\r\n\r\nGET ${item}\r\n\r\n`,
    )
    .join('')}--${boundary}--\r\n`
  const response = await googleFetch(
    box.cms,
    box.userId,
    box.accountId,
    googleUrl('gmail.googleapis.com', '/batch/gmail/v1'),
    { method: 'POST', body, headers: { 'content-type': `multipart/mixed; boundary=${boundary}` } },
  )
  if (!response.ok) {
    // The whole batch refused: the reason is the same one a single read would give.
    await apiAnswer(response)
    throw new GoogleError('unavailable', 'Google had a problem. Try again in a moment.')
  }
  const mark = /boundary="?([^";]+)"?/i.exec(response.headers.get('content-type') ?? '')?.[1]
  if (!mark) throw new GoogleError('unavailable', 'Google’s answer couldn’t be read.')
  const whole = (await readBytes(response, BATCH_LIMIT_BYTES)).toString('utf8')
  const results: (unknown | null)[] = paths.map(() => null)
  let seen = 0
  for (const part of whole.split(`--${mark}`)) {
    const index = /content-id:\s*<response-item-(\d+)>/i.exec(part)?.[1]
    const status = /^HTTP\/[\d.]+ (\d{3})/m.exec(part)?.[1]
    if (index === undefined || !status) continue
    seen++
    const start = part.indexOf('{')
    if (status !== '200' || start < 0 || Number(index) >= paths.length) continue
    try {
      results[Number(index)] = JSON.parse(part.slice(start, part.lastIndexOf('}') + 1)) as unknown
    } catch {
      // That one read stays `null`: missing from the list rather than breaking it.
    }
  }
  if (seen !== paths.length)
    throw new GoogleError('unavailable', 'Google’s answer couldn’t be read.')
  return results
}

/**
 * Several reads as one request to Google, so a page of a list costs one trip rather than one
 * per row. Should the batch itself not work, the same reads go one by one, a few at a time.
 */
async function readMany(box: Mailbox, paths: readonly string[]): Promise<(unknown | null)[]> {
  if (paths.length === 0) return []
  try {
    return await batchOnce(box, paths)
  } catch (error) {
    // An ended connection, a missing permission or a used-up limit would meet each single read
    // too: only a batch that itself didn't work is worth doing the long way.
    const single = ['unavailable', 'not_found', 'refused']
    if (!(error instanceof GoogleError) || !single.includes(error.kind)) throw error
  }
  const results: (unknown | null)[] = []
  for (let from = 0; from < paths.length; from += 5) {
    const some = await Promise.all(
      paths.slice(from, from + 5).map((item) =>
        googleJson(
          box.cms,
          box.userId,
          box.accountId,
          googleUrl('gmail.googleapis.com', item),
        ).catch((error: unknown) => {
          if (error instanceof GoogleError && error.kind === 'not_found') return null
          throw error
        }),
      ),
    )
    results.push(...some)
  }
  return results
}

// ── Lists ──────────────────────────────────────────────────────────────────────

/** A thread as a row of the list. */
export interface ThreadSummary {
  id: string
  subject: string
  /** Who wrote in it, by name, the first few. */
  from: string
  snippet: string
  date: Date | null
  /** How many messages it has. */
  count: number
  unread: boolean
  starred: boolean
  /** For a draft: the draft's id, which opens it for writing. */
  draftId?: string
}

export interface MailPage {
  labels: MailLabel[]
  threads: ThreadSummary[]
  /** The next page's token, or `null` on the last. */
  next: string | null
}

const METADATA = 'format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=To'

/** A sender's name as a row shows it: the name, else the address before its `@`. */
function senderName(from: string): string {
  const match = /^\s*"?([^"<]*?)"?\s*<([^<>]+)>\s*$/.exec(from)
  const name = match ? match[1]!.trim() || match[2]! : from.trim()
  return name.includes('@') ? name.slice(0, name.indexOf('@')) : name
}

function summaryOf(threadId: string, messages: Record<string, unknown>[]): ThreadSummary {
  const first = messages[0] ?? {}
  const last = messages.at(-1) ?? {}
  const labels = messages.flatMap(labelIdsOf)
  const names = [
    ...new Set(
      messages.map((message) =>
        labelIdsOf(message).includes('SENT') && !labelIdsOf(message).includes('INBOX')
          ? 'me'
          : senderName(headersOf(message.payload).get('from') ?? ''),
      ),
    ),
  ].filter(Boolean)
  return {
    id: threadId,
    subject: (headersOf(first.payload).get('subject') ?? '').slice(0, 300) || '(no subject)',
    from: names.slice(0, 3).join(', ').slice(0, 120) || '(unknown)',
    snippet: text(last.snippet).slice(0, 200),
    date: dateOf(last),
    count: messages.length,
    unread: labels.includes('UNREAD'),
    starred: labels.includes('STARRED'),
  }
}

/**
 * One page of a label's threads (or of a search), with the labels and their unread counts.
 * Three requests to Google: the labels and the thread ids together, then one batch that
 * describes the threads and counts the labels.
 */
export async function listMail(
  box: Mailbox,
  query: { label: string; q: string; pageToken: string | null },
): Promise<MailPage> {
  const drafts = query.label === 'DRAFT' && !query.q
  const [labels, found] = await Promise.all([
    listLabels(box),
    call<unknown>(box, drafts ? '/drafts' : '/threads', {
      query: {
        maxResults: PAGE_SIZE,
        pageToken: query.pageToken ?? undefined,
        q: query.q || undefined,
        labelIds: drafts || query.label === ALL_MAIL ? undefined : query.label,
      },
    }).then(record),
  ])

  // Drafts are listed by their own ids, each with the message it holds.
  const rows = list(drafts ? found.drafts : found.threads)
    .map((entry) => {
      const row = record(entry)
      return drafts
        ? { key: id(record(row.message).id), draftId: id(row.id) }
        : { key: id(row.id), draftId: undefined }
    })
    .filter((row) => row.key && (!drafts || row.draftId))
    .slice(0, PAGE_SIZE)
  const counted = labels
    .filter((label) => (label.system ? COUNTED_SYSTEM.includes(label.id) : true))
    .slice(0, COUNTED_SYSTEM.length + COUNTED_LABELS)

  const answers = await readMany(box, [
    ...rows.map((row) => path(`/${drafts ? 'messages' : 'threads'}/${row.key}?${METADATA}`)),
    ...counted.map((label) => path(`/labels/${label.id}`)),
  ])
  const threads: ThreadSummary[] = []
  rows.forEach((row, index) => {
    const answer = answers[index]
    if (!answer) return
    const messages = drafts ? [record(answer)] : list(record(answer).messages).map(record)
    if (messages.length === 0) return
    threads.push({ ...summaryOf(row.key, messages), draftId: row.draftId })
  })
  counted.forEach((label, index) => {
    const answer = record(answers[rows.length + index])
    const unread = answer.threadsUnread
    // Drafts are counted whole: none of them is "unread".
    const total = label.id === 'DRAFT' ? answer.threadsTotal : unread
    label.unread = typeof total === 'number' && total >= 0 ? total : null
  })
  return { labels, threads, next: id(found.nextPageToken) || null }
}

// ── A thread, a message ────────────────────────────────────────────────────────

export interface MailAttachment {
  /** Where the part is in its message: what its download is asked for by. */
  partId: string
  filename: string
  type: string
  size: number
}

export interface MailMessage {
  id: string
  threadId: string
  labelIds: string[]
  from: string
  to: string
  cc: string
  replyTo: string
  subject: string
  date: Date | null
  /** The `Message-ID` header, which an answer names in `In-Reply-To`. */
  messageId: string
  /** The `Message-ID` it answers itself, when it's a reply. */
  inReplyTo: string
  references: string
  snippet: string
  /** The plain-text part, when there is one. */
  text: string | null
  /** Whether it has an HTML part, shown apart in a sandboxed frame. */
  hasHtml: boolean
  attachments: MailAttachment[]
}

interface Parts {
  text: Record<string, unknown> | null
  html: Record<string, unknown> | null
  attachments: { part: Record<string, unknown>; shown: MailAttachment }[]
}

/** A message's parts, walked once: its text, its HTML, and what is attached. */
function partsOf(payload: unknown): Parts {
  const found: Parts = { text: null, html: null, attachments: [] }
  const walk = (value: unknown, depth: number) => {
    const part = record(value)
    const type = text(part.mimeType).toLowerCase()
    const filename = text(part.filename)
    const body = record(part.body)
    if (filename) {
      const partId = text(part.partId)
      if (PART_ID.test(partId)) {
        found.attachments.push({
          part,
          shown: {
            partId,
            filename: filename.replace(/\p{Cc}/gu, '').slice(0, 200) || 'attachment',
            type: type.slice(0, 100),
            size: typeof body.size === 'number' && body.size >= 0 ? body.size : 0,
          },
        })
      }
    } else if (type === 'text/plain') {
      found.text ??= part
    } else if (type === 'text/html') {
      found.html ??= part
    }
    // Deeper than any honest message goes: a message built to nest without end stops here.
    if (depth < 12) for (const child of list(part.parts)) walk(child, depth + 1)
  }
  walk(payload, 0)
  return found
}

const contentTypeOf = (part: Record<string, unknown>): string =>
  headersOf(part).get('content-type') ?? ''

/** A text part's content, when Gmail sent it along and it isn't beyond what a screen shows. */
function inlineText(part: Record<string, unknown> | null): string | null {
  if (!part) return null
  const data = text(record(part.body).data)
  if (!data || data.length > (MAX_BODY_BYTES * 4) / 3) return null
  return decodeBody(data, contentTypeOf(part))
}

function messageOf(value: unknown): MailMessage | null {
  const message = record(value)
  const messageId = id(message.id)
  if (!messageId) return null
  const headers = headersOf(message.payload)
  const parts = partsOf(message.payload)
  return {
    id: messageId,
    threadId: id(message.threadId),
    labelIds: labelIdsOf(message),
    from: headers.get('from') ?? '',
    to: headers.get('to') ?? '',
    cc: headers.get('cc') ?? '',
    replyTo: headers.get('reply-to') ?? '',
    subject: (headers.get('subject') ?? '').slice(0, 500),
    date: dateOf(message),
    messageId: headers.get('message-id') ?? '',
    inReplyTo: headers.get('in-reply-to') ?? '',
    references: headers.get('references') ?? '',
    snippet: text(message.snippet).slice(0, 300),
    text: inlineText(parts.text),
    hasHtml: parts.html !== null,
    attachments: parts.attachments.map((entry) => entry.shown),
  }
}

/** A thread with its messages in full, oldest first: one request. `null` when it's gone. */
export async function getThread(box: Mailbox, threadId: string): Promise<MailMessage[] | null> {
  try {
    const answer = record(await call(box, `/threads/${threadId}`, { query: { format: 'full' } }))
    return list(answer.messages)
      .map(messageOf)
      .filter((message): message is MailMessage => message !== null)
      .slice(0, 100)
  } catch (error) {
    if (error instanceof GoogleError && error.kind === 'not_found') return null
    throw error
  }
}

async function rawMessage(
  box: Mailbox,
  messageId: string,
): Promise<Record<string, unknown> | null> {
  try {
    return record(await call(box, `/messages/${messageId}`, { query: { format: 'full' } }))
  } catch (error) {
    if (error instanceof GoogleError && error.kind === 'not_found') return null
    throw error
  }
}

/** One message in full. `null` when it's gone. */
export async function getMessage(box: Mailbox, messageId: string): Promise<MailMessage | null> {
  const message = await rawMessage(box, messageId)
  return message ? messageOf(message) : null
}

/** An attachment's bytes by Gmail's id for them, which is good for this one request only. */
async function attachmentBytes(
  box: Mailbox,
  messageId: string,
  attachmentId: string,
): Promise<Buffer> {
  // Not `googleJson`: an attachment is larger than any other answer, and has a limit of its own.
  const response = await googleFetch(
    box.cms,
    box.userId,
    box.accountId,
    url(`/messages/${messageId}/attachments/${encodeURIComponent(attachmentId)}`),
  )
  if (!response.ok) {
    await apiAnswer(response)
    throw new GoogleError('unavailable', 'Google had a problem. Try again in a moment.')
  }
  // Base64 in JSON: four characters for three bytes, and a little around them.
  const body = await readBytes(response, Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 4096)
  try {
    return Buffer.from(text(record(JSON.parse(body.toString('utf8'))).data), 'base64url')
  } catch {
    throw new GoogleError('unavailable', 'Google’s answer couldn’t be read.')
  }
}

/** A message's HTML part as text, for the sandboxed frame. `null` when it has none. */
export async function getHtml(box: Mailbox, messageId: string): Promise<string | null> {
  const message = await rawMessage(box, messageId)
  const part = message ? partsOf(message.payload).html : null
  if (!part) return null
  const body = record(part.body)
  const inline = text(body.data)
  if (inline) {
    return inline.length > (MAX_BODY_BYTES * 4) / 3 ? null : decodeBody(inline, contentTypeOf(part))
  }
  // A long body comes apart from the message, like an attachment.
  const attachmentId = text(body.attachmentId)
  if (!attachmentId || (typeof body.size === 'number' && body.size > MAX_BODY_BYTES)) return null
  const bytes = await attachmentBytes(box, messageId, attachmentId)
  return decodeBody(bytes.toString('base64url'), contentTypeOf(part))
}

export interface AttachmentFile extends MailAttachment {
  content: Buffer
}

/**
 * One of a message's attachments, found by its place in the message: Gmail's own id for an
 * attachment changes from one reading of the message to the next. `null` when there's no such
 * part; refuses one too large to hand on.
 */
export async function getAttachment(
  box: Mailbox,
  messageId: string,
  partId: string,
): Promise<AttachmentFile | null> {
  const message = await rawMessage(box, messageId)
  const entry = message
    ? partsOf(message.payload).attachments.find((candidate) => candidate.shown.partId === partId)
    : undefined
  if (!entry) return null
  if (entry.shown.size > MAX_ATTACHMENT_BYTES) {
    throw new GoogleError('refused', 'That attachment is too large to download here.')
  }
  const body = record(entry.part.body)
  const inline = text(body.data)
  const content = inline
    ? Buffer.from(inline, 'base64url')
    : await attachmentBytes(box, messageId, text(body.attachmentId))
  return { ...entry.shown, content }
}

// ── Changing threads ───────────────────────────────────────────────────────────

/** Adds and removes labels on a whole thread: archive, read, star, a label of the person's. */
export async function modifyThread(
  box: Mailbox,
  threadId: string,
  change: { add?: readonly string[]; remove?: readonly string[] },
): Promise<void> {
  await call(box, `/threads/${threadId}/modify`, {
    method: 'POST',
    json: { addLabelIds: change.add ?? [], removeLabelIds: change.remove ?? [] },
  })
}

/** Moves a thread to Trash, where Gmail keeps it for thirty days. Nothing here deletes for good. */
export async function trashThread(box: Mailbox, threadId: string): Promise<void> {
  await call(box, `/threads/${threadId}/trash`, { method: 'POST' })
}

export async function untrashThread(box: Mailbox, threadId: string): Promise<void> {
  await call(box, `/threads/${threadId}/untrash`, { method: 'POST' })
}

// ── Writing ────────────────────────────────────────────────────────────────────

export interface SendAs {
  email: string
  name: string
  primary: boolean
}

/** The addresses the account may send from: its own, and the aliases Gmail has verified. */
export async function listSendAs(box: Mailbox): Promise<SendAs[]> {
  const answer = record(await call(box, '/settings/sendAs'))
  return list(answer.sendAs)
    .map(record)
    .filter((entry) => entry.isPrimary === true || text(entry.verificationStatus) === 'accepted')
    .map((entry) => ({
      email: text(entry.sendAsEmail).toLowerCase(),
      name: text(entry.displayName)
        .replace(/\p{Cc}/gu, '')
        .slice(0, 100),
      primary: entry.isPrimary === true,
    }))
    .filter((entry) => entry.email)
    .slice(0, 50)
}

/** What a reply needs of the message it answers: taken from Gmail, never from the form. */
export interface ReplyTarget {
  threadId: string
  messageId: string
  references: string
}

export async function replyTarget(box: Mailbox, messageId: string): Promise<ReplyTarget | null> {
  try {
    const message = record(
      await call(box, `/messages/${messageId}`, {
        query: { format: 'metadata', metadataHeaders: ['Message-ID', 'References'] },
      }),
    )
    const headers = headersOf(message.payload)
    return {
      threadId: id(message.threadId),
      messageId: headers.get('message-id') ?? '',
      references: headers.get('references') ?? '',
    }
  } catch (error) {
    if (error instanceof GoogleError && error.kind === 'not_found') return null
    throw error
  }
}

/**
 * A message and what goes with it (the thread it joins) to one of Gmail's writing addresses:
 * as JSON while it's small, through the upload address once attachments make it large.
 */
async function write(
  box: Mailbox,
  method: 'POST' | 'PUT',
  rest: string,
  mime: string,
  wrap: (message: Record<string, unknown>) => Record<string, unknown>,
  threadId: string | null,
): Promise<unknown> {
  const thread = threadId ? { threadId } : {}
  if (Buffer.byteLength(mime) <= JSON_SEND_LIMIT) {
    return call(box, rest, {
      method,
      json: wrap({ raw: Buffer.from(mime).toString('base64url'), ...thread }),
    })
  }
  const boundary = `upload_${randomBytes(12).toString('hex')}`
  const body = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(wrap(thread)),
    `--${boundary}`,
    'Content-Type: message/rfc822',
    '',
    mime,
    `--${boundary}--`,
    '',
  ].join('\r\n')
  return googleJson(
    box.cms,
    box.userId,
    box.accountId,
    googleUrl('gmail.googleapis.com', `/upload${path(rest)}`),
    {
      method,
      query: { uploadType: 'multipart' },
      body,
      headers: { 'content-type': `multipart/related; boundary=${boundary}` },
      timeoutMs: 120_000,
    },
  )
}

/** Sends a message as the account, into `threadId` when it answers one. */
export async function sendMessage(
  box: Mailbox,
  mime: string,
  threadId: string | null,
): Promise<void> {
  await write(box, 'POST', '/messages/send', mime, (message) => message, threadId)
}

/** Saves a draft: a new one, or `draftId`'s new content. Its id. */
export async function saveDraft(
  box: Mailbox,
  mime: string,
  threadId: string | null,
  draftId: string | null,
): Promise<string> {
  const answer = record(
    await write(
      box,
      draftId ? 'PUT' : 'POST',
      draftId ? `/drafts/${draftId}` : '/drafts',
      mime,
      (message) => ({ message }),
      threadId,
    ),
  )
  return id(answer.id)
}

export async function deleteDraft(box: Mailbox, draftId: string): Promise<void> {
  try {
    await call(box, `/drafts/${draftId}`, { method: 'DELETE' })
  } catch (error) {
    // Already gone is what was wanted.
    if (!(error instanceof GoogleError) || error.kind !== 'not_found') throw error
  }
}

/** A draft's message, to fill the writing form with. `null` when it's gone. */
export async function getDraft(box: Mailbox, draftId: string): Promise<MailMessage | null> {
  try {
    const answer = record(await call(box, `/drafts/${draftId}`, { query: { format: 'full' } }))
    return messageOf(answer.message)
  } catch (error) {
    if (error instanceof GoogleError && error.kind === 'not_found') return null
    throw error
  }
}
