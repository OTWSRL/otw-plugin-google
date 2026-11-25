import { randomBytes } from 'node:crypto'

// An email as Gmail's API takes it: RFC 5322 headers and a MIME body. Every value that becomes
// a header loses its line breaks first, so nothing typed into a field can add a header of its own.

export interface MimeAttachment {
  filename: string
  /** Such as `application/pdf`; anything unusable becomes `application/octet-stream`. */
  type: string
  content: Uint8Array
}

export interface MimeMessage {
  /** `Ada <ada@example.com>` or a bare address. */
  from: string
  to: readonly string[]
  cc?: readonly string[]
  bcc?: readonly string[]
  replyTo?: string | null
  subject: string
  text: string
  html?: string | null
  /** The Message-ID this answers, and the thread's ids before it. */
  inReplyTo?: string | null
  references?: string | null
  attachments?: readonly MimeAttachment[]
}

const ASCII = /^[\x20-\x7e]*$/
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,60}$/i

/** A header's value on one line: no line break survives, nor any other control character. */
const oneLine = (value: string): string => value.replace(/\p{Cc}+/gu, ' ').trim()

/** Text for a header that isn't plain ASCII, as RFC 2047 encoded words of at most 75 characters. */
function encodedWords(value: string): string {
  const words: string[] = []
  let chunk = ''
  for (const char of value) {
    // 45 bytes of UTF-8 make 60 base64 characters: with its frame, a 75-character word.
    if (Buffer.byteLength(chunk + char) > 45) {
      words.push(chunk)
      chunk = ''
    }
    chunk += char
  }
  if (chunk) words.push(chunk)
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word).toString('base64')}?=`).join('\r\n ')
}

const headerText = (value: string): string => {
  const line = oneLine(value)
  return ASCII.test(line) ? line : encodedWords(line)
}

/** `Name <address>` split up; a bare address has no name. */
export function splitAddress(value: string): { name: string; address: string } {
  const line = oneLine(value)
  const match = /^(.*)<([^<>]*)>\s*$/.exec(line)
  if (!match) return { name: '', address: line }
  return { name: match[1]!.trim().replace(/^"(.*)"$/, '$1'), address: match[2]!.trim() }
}

/** An address header's value: the name quoted or encoded, the address as it is. */
export function formatAddress(value: string): string {
  const { name, address } = splitAddress(value)
  // What could end the address early, or start another, never reaches the header.
  const clean = address.replace(/[\s<>,;"]/g, '')
  if (!name) return clean
  const shown = ASCII.test(name) ? `"${name.replace(/["\\]/g, '\\$&')}"` : encodedWords(name)
  return `${shown} <${clean}>`
}

const base64Lines = (content: Uint8Array | string): string =>
  (
    Buffer.from(content)
      .toString('base64')
      .match(/.{1,76}/g) ?? []
  ).join('\r\n')

const textPart = (type: 'plain' | 'html', content: string): string =>
  [
    `Content-Type: text/${type}; charset=UTF-8`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(content),
  ].join('\r\n')

const boundary = () => `=_${randomBytes(18).toString('base64url')}`

function multipart(kind: 'alternative' | 'mixed', parts: readonly string[]): string {
  const mark = boundary()
  return [
    `Content-Type: multipart/${kind}; boundary="${mark}"`,
    '',
    ...parts.map((part) => `--${mark}\r\n${part}`),
    `--${mark}--`,
  ].join('\r\n')
}

function attachmentPart(attachment: MimeAttachment): string {
  const type = MEDIA_TYPE.test(attachment.type) ? attachment.type : 'application/octet-stream'
  const name = oneLine(attachment.filename).replace(/[\\/]/g, '_') || 'attachment'
  // RFC 2231 for names beyond ASCII, with a plain copy for older readers.
  const plain = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const star = ASCII.test(name) ? '' : `; filename*=UTF-8''${encodeURIComponent(name)}`
  return [
    `Content-Type: ${type}; name="${plain}"`,
    `Content-Disposition: attachment; filename="${plain}"${star}`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(attachment.content),
  ].join('\r\n')
}

/** The whole message, headers and body, as text with CRLF line ends. */
export function buildMime(message: MimeMessage): string {
  const list = (addresses: readonly string[] | undefined) =>
    (addresses ?? []).map(formatAddress).filter(Boolean).join(', ')
  const headers = [
    `From: ${formatAddress(message.from)}`,
    `To: ${list(message.to)}`,
    ...(message.cc?.length ? [`Cc: ${list(message.cc)}`] : []),
    ...(message.bcc?.length ? [`Bcc: ${list(message.bcc)}`] : []),
    ...(message.replyTo ? [`Reply-To: ${formatAddress(message.replyTo)}`] : []),
    `Subject: ${headerText(message.subject)}`,
    ...(message.inReplyTo ? [`In-Reply-To: ${oneLine(message.inReplyTo)}`] : []),
    ...(message.references ? [`References: ${oneLine(message.references)}`] : []),
    'MIME-Version: 1.0',
  ]
  const body = message.html
    ? multipart('alternative', [textPart('plain', message.text), textPart('html', message.html)])
    : textPart('plain', message.text)
  const whole = message.attachments?.length
    ? multipart('mixed', [body, ...message.attachments.map(attachmentPart)])
    : body
  return `${headers.join('\r\n')}\r\n${whole}\r\n`
}

/** The message as Gmail's `raw` field wants it. */
export const rawMime = (message: MimeMessage): string =>
  Buffer.from(buildMime(message)).toString('base64url')
