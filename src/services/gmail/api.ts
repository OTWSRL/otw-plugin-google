import type { ApiContext, PluginContext } from '@otwdesign/sdk'
import { USE } from '../../config'
import { GoogleError } from '../../google'
import { UUID } from '../../runtime'
import { requireAccount } from '../shared'
import { getAttachment, getHtml, GMAIL_ID, PART_ID, type Mailbox } from './client'
import { escapeHtml, sanitizeHtml } from './html'

// The two things a mail screen can't do in its own page: show a message's HTML, which goes in a
// frame of its own so nothing in it can touch the admin, and hand over an attachment.

/**
 * How the frame's document is held, whatever is in it. `sandbox` makes it a document with no
 * origin and no scripts even when its address is opened on its own, outside the frame; popups
 * are allowed so a link can open in a new tab, which is an ordinary tab. Nothing loads but
 * inline styles and pictures: those carried in the message, and the web's only when asked.
 */
export const frameSecurity = (images: boolean): string =>
  [
    'sandbox allow-popups allow-popups-to-escape-sandbox',
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    `img-src data:${images ? ' https:' : ''}`,
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ].join('; ')

const guarded = (extra: Record<string, string>): Record<string, string> => ({
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'private, no-store',
  ...extra,
})

const FRAME_STYLE =
  'html{color-scheme:light}body{margin:12px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1d2327;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}a{color:#3858e9}blockquote{margin:0 0 0 8px;padding-left:10px;border-left:1px solid #c3c4c7}pre{white-space:pre-wrap}'

function frame(body: string, images: boolean, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Message</title><style>${FRAME_STYLE}</style></head><body>${body}</body></html>`,
    {
      status,
      headers: guarded({
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': frameSecurity(images),
      }),
    },
  )
}

/** A short message in the frame's own page: said in words chosen here, escaped. */
const said = (message: string, status: number) =>
  frame(`<p>${escapeHtml(message)}</p>`, false, status)

/** The mailbox a request names, when the person is signed in, may use Google, and owns it. */
async function mailbox(
  cms: PluginContext,
  url: URL,
  context: ApiContext,
): Promise<Mailbox | 401 | 404> {
  const user = await context.user()
  if (!user || !cms.auth.can(user, USE)) return 401
  const accountId = url.searchParams.get('account') ?? ''
  if (!UUID.test(accountId)) return 404
  const account = await requireAccount(cms, user, 'gmail', accountId)
  return account ? { cms, userId: user.id, accountId: account.id } : 404
}

/** `GET /gmail/html?account=&message=&images=1`: one message's HTML part, made safe, for a frame. */
export async function messageHtml(
  cms: PluginContext,
  request: Request,
  context: ApiContext,
): Promise<Response> {
  const url = new URL(request.url)
  const box = await mailbox(cms, url, context)
  if (box === 401) return said('Sign in to read this message.', 401)
  const messageId = url.searchParams.get('message') ?? ''
  if (box === 404 || !GMAIL_ID.test(messageId)) return said('That message can’t be found.', 404)
  const images = url.searchParams.get('images') === '1'
  try {
    const html = await getHtml(box, messageId)
    if (html === null) return said('This message has no formatted part to show.', 404)
    return frame(sanitizeHtml(html, { images }).html, images)
  } catch (error) {
    if (!(error instanceof GoogleError)) throw error
    return said(
      error.kind === 'not_found'
        ? 'That message can’t be found.'
        : 'Google couldn’t hand over this message just now. Try again in a moment.',
      error.kind === 'not_found' ? 404 : 502,
    )
  }
}

/** A file's name for a `Content-Disposition` header: a plain copy, and the real one beside it. */
function disposition(filename: string): string {
  const name = filename.replace(/[\p{Cc}\\/]/gu, '_').slice(0, 200) || 'attachment'
  const plain = name.replace(/[^\x20-\x7e]/g, '_').replace(/["%]/g, '_')
  return `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

const plain = (message: string, status: number) =>
  new Response(message, {
    status,
    headers: guarded({ 'content-type': 'text/plain; charset=utf-8' }),
  })

/**
 * `GET /gmail/attachment?account=&message=&part=`: one attachment, as a download. Its type is
 * never the sender's word for it: a browser saves it, and shows nothing of it in this site's name.
 */
export async function attachment(
  cms: PluginContext,
  request: Request,
  context: ApiContext,
): Promise<Response> {
  const url = new URL(request.url)
  const box = await mailbox(cms, url, context)
  if (box === 401) return plain('Sign in to download this.', 401)
  const messageId = url.searchParams.get('message') ?? ''
  const partId = url.searchParams.get('part') ?? ''
  if (box === 404 || !GMAIL_ID.test(messageId) || !PART_ID.test(partId)) {
    return plain('That attachment can’t be found.', 404)
  }
  try {
    const file = await getAttachment(box, messageId, partId)
    if (!file) return plain('That attachment can’t be found.', 404)
    return new Response(new Uint8Array(file.content), {
      headers: guarded({
        'content-type': 'application/octet-stream',
        'content-length': String(file.content.byteLength),
        'content-disposition': disposition(file.filename),
        'content-security-policy': "sandbox; default-src 'none'",
      }),
    })
  } catch (error) {
    if (!(error instanceof GoogleError)) throw error
    return error.kind === 'not_found'
      ? plain('That attachment can’t be found.', 404)
      : error.kind === 'refused'
        ? plain('That attachment is too large to download here.', 413)
        : plain('Google couldn’t hand over this attachment just now. Try again in a moment.', 502)
  }
}
