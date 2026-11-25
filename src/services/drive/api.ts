import type { ApiContext, PluginContext } from '@otwdesign/sdk'
import { USE } from '../../config'
import { GoogleError } from '../../google'
import { requireAccount } from '../shared'
import { downloadFile, DRIVE, getFile, problemText, singleRange } from './client'

// Drive's two addresses for a file's bytes: a download, and a preview in the browser. Both
// stream what Google sends, so a large file is never held in memory, and both are for the
// signed-in owner of the account only.

/**
 * The types a browser may show from this site's address: raster images, audio, video, PDF and
 * plain text. Anything else could run as this site (HTML, SVG, XML) and is only ever downloaded.
 */
const INLINE: ReadonlyMap<string, string> = new Map(
  [
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/avif',
    'audio/mpeg',
    'audio/mp4',
    'audio/aac',
    'audio/ogg',
    'audio/wav',
    'audio/x-wav',
    'audio/webm',
    'audio/flac',
    'video/mp4',
    'video/webm',
    'video/ogg',
    'video/quicktime',
    'application/pdf',
  ]
    .map((type): [string, string] => [type, type])
    .concat([['text/plain', 'text/plain; charset=utf-8']]),
)

/** Whether a file of this type can be shown in the browser from the preview address. */
export const previewable = (mimeType: string): boolean => INLINE.has(mimeType.toLowerCase())

const STATUS: Record<GoogleError['kind'], number> = {
  not_found: 404,
  permission: 403,
  reconnect: 409,
  limit: 429,
  refused: 400,
  unavailable: 502,
}

const refuse = (status: number, error: string): Response =>
  Response.json({ error }, { status, headers: { 'Cache-Control': 'no-store' } })

/** A file name for a `Content-Disposition` header: a plain copy, and the real one encoded. */
function disposition(kind: 'attachment' | 'inline', name: string): string {
  const clean = name.replace(/\p{Cc}/gu, '').replace(/[\\/]/g, '_') || 'download'
  const plain = clean.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(clean).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  )
  return `${kind}; filename="${plain}"; filename*=UTF-8''${encoded}`
}

/** A count from one of Google's headers, or `null`: only digits are passed on. */
const digits = (value: string | null): string | null =>
  value && /^\d{1,18}$/.test(value) ? value : null

const contentRange = (value: string | null): string | null =>
  value && /^bytes (?:\d{1,18}-\d{1,18}|\*)\/(?:\d{1,18}|\*)$/.test(value) ? value : null

async function serve(
  cms: PluginContext,
  request: Request,
  context: ApiContext,
  inline: boolean,
): Promise<Response> {
  const user = await context.user()
  if (!user) return refuse(401, 'Sign in first.')
  if (!cms.auth.can(user, USE)) return refuse(403, 'You may not use Google here.')
  const accountId = new URL(request.url).searchParams.get('account') ?? ''
  const account = await requireAccount(cms, user, DRIVE, accountId)
  if (!account) return refuse(404, 'Not found')

  try {
    // An id that can't be a file's is refused by `getFile` before anything is sent to Google.
    const file = await getFile(cms, user.id, account.id, context.params.id ?? '')
    if (file.kind !== 'file') {
      return refuse(400, 'That has no file to download. Open it in Google Drive.')
    }
    const shown = inline ? INLINE.get(file.mimeType.toLowerCase()) : undefined
    const range = singleRange(request.headers.get('range'))
    const google = await downloadFile(cms, user.id, account.id, file.id, range)
    const headers = new Headers({
      // The type is this site's choice from its own list, never the one Google or the file says.
      'Content-Type': shown ?? 'application/octet-stream',
      'Content-Disposition': disposition(shown ? 'inline' : 'attachment', file.name),
      'X-Content-Type-Options': 'nosniff',
      // Whatever the bytes are, they run nothing and load nothing in this site's name.
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': 'private, no-store',
      'Accept-Ranges': 'bytes',
    })
    const length = digits(google.headers.get('content-length'))
    if (length) headers.set('Content-Length', length)
    const partial = google.status === 206 ? contentRange(google.headers.get('content-range')) : null
    if (partial) headers.set('Content-Range', partial)
    return new Response(google.body, { status: partial ? 206 : 200, headers })
  } catch (error) {
    if (!(error instanceof GoogleError)) throw error
    return refuse(STATUS[error.kind], problemText(error))
  }
}

/** `GET /drive/files/:id/download?account=`: the file, saved rather than shown. */
export const download = (cms: PluginContext, request: Request, context: ApiContext) =>
  serve(cms, request, context, false)

/** `GET /drive/files/:id/preview?account=`: shown in the browser when its type is a safe one. */
export const preview = (cms: PluginContext, request: Request, context: ApiContext) =>
  serve(cms, request, context, true)
