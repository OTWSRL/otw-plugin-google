// Talking to Google: its addresses, its token endpoint, and requests to its APIs, each with a
// time limit and a size limit. Nothing here knows about accounts or the database.

/** For tests: an address that stands in for every Google host, as `{address}/{host}/{path}`. */
export const API_ENV = 'GOOGLE_API_URL'

const TOKEN_TIMEOUT_MS = 15_000
export const API_TIMEOUT_MS = 30_000
/** The most of an API answer that's read as JSON; Google's lists are far smaller. */
const MAX_JSON_BYTES = 8 * 1024 * 1024
const MAX_TOKEN_BYTES = 64 * 1024
const CLOCK_SKEW_SECONDS = 60
const SUBJECT = /^[\x21-\x7e]{1,255}$/

/** A stand-in is this machine's plain http, or https: never a way to reach a network's inside. */
function standIn(env: NodeJS.ProcessEnv): URL | null {
  const value = env[API_ENV]
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${API_ENV} isn’t an address`)
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error(`${API_ENV} must be https, or http on this machine`)
  }
  return url
}

/** Google's address for a host and path, or the stand-in's for it. */
export function googleUrl(
  host: string,
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const base = standIn(env)
  return base ? `${base.origin}/${host}${path}` : `https://${host}${path}`
}

/** Whether a Google address (an upload's, which Google hands out itself) is one of Google's. */
export function isGoogleUrl(value: string, env: NodeJS.ProcessEnv = process.env): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  const base = standIn(env)
  if (base) return url.origin === base.origin
  return url.protocol === 'https:' && /(^|\.)googleapis\.com$/.test(url.hostname)
}

/** What went wrong at Google, in words for the person and a kind for the code. */
export class GoogleError extends Error {
  readonly kind:
    | 'reconnect' // The connection ended: the person must connect again.
    | 'permission' // The account hasn't allowed this service.
    | 'limit' // Google's quota or rate limit.
    | 'not_found'
    | 'refused' // Google said no to this request: its message says why.
    | 'unavailable' // Google didn't answer, or answered with an error of its own.
  readonly status: number

  constructor(kind: GoogleError['kind'], message: string, status = 0) {
    super(message)
    this.name = 'GoogleError'
    this.kind = kind
    this.status = status
  }
}

/** A body read up to `limit` bytes; more than that is refused rather than held in memory. */
async function readText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
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
  return Buffer.concat(chunks).toString('utf8')
}

async function readJson(response: Response, limit: number): Promise<unknown> {
  const text = await readText(response, limit)
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new GoogleError('unavailable', 'Google’s answer couldn’t be read.', response.status)
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const text = (value: unknown): string => (typeof value === 'string' ? value : '')

async function send(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  // A read may be sent on to another of Google's hosts, as a file's bytes are: fetch follows it
  // and leaves the token behind when the host changes. Anything that writes is never sent on.
  const redirect = (init.method ?? 'GET') === 'GET' ? 'follow' : 'error'
  try {
    return await fetch(url, { ...init, redirect, signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    // Never the cause: a fetch error can carry the address, and a body, in its message.
    throw new GoogleError('unavailable', 'Google didn’t answer. Try again in a moment.')
  }
}

export interface GoogleClient {
  id: string
  secret: string
}

/** What Google's token endpoint returns for a code or a refresh token. */
export interface TokenGrant {
  accessToken: string
  /** Seconds the access token lasts. */
  expiresIn: number
  /** Only when Google issues a new one: on a first consent, or one asked for again. */
  refreshToken: string | null
  /** The scopes actually granted: a person can untick some. */
  scopes: string[]
  idToken: string | null
}

/**
 * Asks Google's token endpoint. `invalid_grant` means the code or the refresh token is no longer
 * good: the connection ended at Google's side.
 */
export async function requestToken(
  client: GoogleClient,
  params: Record<string, string>,
): Promise<TokenGrant> {
  const response = await send(
    googleUrl('oauth2.googleapis.com', '/token'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        ...params,
        client_id: client.id,
        client_secret: client.secret,
      }).toString(),
    },
    TOKEN_TIMEOUT_MS,
  )
  const body = record(await readJson(response, MAX_TOKEN_BYTES))
  if (!response.ok) {
    const code = text(body.error)
    if (code === 'invalid_grant') {
      throw new GoogleError(
        'reconnect',
        'Google ended this connection. Connect the account again.',
        400,
      )
    }
    if (code === 'invalid_client' || code === 'unauthorized_client') {
      throw new GoogleError(
        'refused',
        'Google doesn’t accept this site’s client ID and secret. Check them under Settings › Google.',
        response.status,
      )
    }
    throw new GoogleError(
      'unavailable',
      'Google couldn’t complete that. Try again.',
      response.status,
    )
  }
  const accessToken = text(body.access_token)
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 0
  if (!accessToken || !(expiresIn > 0)) {
    throw new GoogleError('unavailable', 'Google’s answer had no token.', response.status)
  }
  return {
    accessToken,
    expiresIn,
    refreshToken: text(body.refresh_token) || null,
    scopes: text(body.scope).split(' ').filter(Boolean),
    idToken: text(body.id_token) || null,
  }
}

/** Ends a grant at Google, with either of its tokens. Best effort: a failure is the caller's to log. */
export async function revokeToken(token: string): Promise<boolean> {
  const response = await send(
    googleUrl('oauth2.googleapis.com', '/revoke'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
    },
    TOKEN_TIMEOUT_MS,
  )
  await response.body?.cancel().catch(() => undefined)
  // 400 is "already revoked or expired": the grant is gone either way.
  return response.ok || response.status === 400
}

/** Who a Google ID token is about. */
export interface GoogleIdentity {
  subject: string
  email: string
  emailVerified: boolean
  name: string
  /** The Google Workspace domain the account belongs to, when it's one. */
  hostedDomain: string | null
}

/**
 * Reads an ID token that came straight from Google's token endpoint. Its signature isn't checked:
 * it arrived over TLS from Google itself, in answer to this site's secret, which is what the
 * signature would prove. It is still checked to be for this client, from Google, and current.
 */
export function readIdToken(
  idToken: string | null,
  clientId: string,
  now = Date.now(),
): GoogleIdentity {
  const refuse = () => new GoogleError('unavailable', 'Google didn’t say who signed in. Try again.')
  const payload = idToken?.split('.')[1]
  if (!payload || idToken!.length > MAX_TOKEN_BYTES) throw refuse()
  let claims: Record<string, unknown>
  try {
    claims = record(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')))
  } catch {
    throw refuse()
  }
  const issuer = text(claims.iss)
  const subject = text(claims.sub)
  const expires = typeof claims.exp === 'number' ? claims.exp : 0
  if (
    (issuer !== 'https://accounts.google.com' && issuer !== 'accounts.google.com') ||
    claims.aud !== clientId ||
    expires + CLOCK_SKEW_SECONDS < now / 1000 ||
    !SUBJECT.test(subject)
  ) {
    throw refuse()
  }
  return {
    subject,
    email: text(claims.email).trim().toLowerCase(),
    emailVerified: claims.email_verified === true,
    name: text(claims.name).slice(0, 100),
    hostedDomain: text(claims.hd).toLowerCase() || null,
  }
}

/** Google's own reason for an error, from the body of an API's error answer. */
function apiError(status: number, body: unknown): GoogleError {
  const error = record(record(body).error)
  const first = record(Array.isArray(error.errors) ? error.errors[0] : undefined)
  const reason = text(first.reason) || text(error.status)
  const said = text(error.message)
    .replace(/[\p{Cc}\s]+/gu, ' ')
    .slice(0, 300)
  if (status === 401) {
    return new GoogleError(
      'reconnect',
      'Google ended this connection. Connect the account again.',
      status,
    )
  }
  if (status === 404)
    return new GoogleError('not_found', 'Google can’t find that any more.', status)
  if (/quota|rateLimit|RESOURCE_EXHAUSTED|dailyLimit/i.test(reason) || status === 429) {
    return new GoogleError(
      'limit',
      'Google’s limit for this site’s project is used up for now. Try again later.',
      status,
    )
  }
  if (status === 403 && /insufficient|PERMISSION_DENIED|ACCESS_TOKEN_SCOPE/i.test(reason)) {
    return new GoogleError('permission', 'This account hasn’t allowed that yet.', status)
  }
  if (status >= 500) {
    return new GoogleError('unavailable', 'Google had a problem. Try again in a moment.', status)
  }
  return new GoogleError(
    'refused',
    said ? `Google refused: ${said}` : 'Google refused that.',
    status,
  )
}

export interface ApiRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Query parameters; lists repeat the name, and `undefined` leaves one out. */
  query?: Record<string, string | number | boolean | readonly string[] | undefined>
  /** Sent as JSON. */
  json?: unknown
  /** Sent as it is, with these headers: an upload's bytes, a multipart body. */
  body?: BodyInit
  headers?: Record<string, string>
  timeoutMs?: number
}

/** A Google API address with its query. */
export function apiUrl(url: string, query: ApiRequest['query'] = {}): string {
  const address = new URL(url)
  for (const [name, value] of Object.entries(query)) {
    if (value === undefined) continue
    for (const item of Array.isArray(value) ? value : [value]) {
      address.searchParams.append(name, String(item))
    }
  }
  return address.href
}

/** One request to a Google API with an access token. The answer, whatever its status. */
export function apiRequest(
  token: string,
  url: string,
  request: ApiRequest = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...request.headers,
    authorization: `Bearer ${token}`,
  }
  let body = request.body
  if (request.json !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(request.json)
  }
  return send(
    apiUrl(url, request.query),
    { method: request.method ?? 'GET', headers, body },
    request.timeoutMs ?? API_TIMEOUT_MS,
  )
}

/** A Google API's JSON answer, or the `GoogleError` its error answer means. */
export async function apiAnswer(response: Response): Promise<unknown> {
  if (response.status === 204) return null
  const body = await readJson(response, MAX_JSON_BYTES).catch((error: unknown) => {
    if (response.ok) throw error
    return null
  })
  if (!response.ok) throw apiError(response.status, body)
  return body
}

/** Whether Google asks for this answer to be tried again: its own trouble, or its rate limit. */
export const retryable = (status: number): boolean => status === 429 || status >= 500
