import { ActionError, type ApiContext, type PluginContext, type User } from '@otwdesign/sdk'
import { ConnectError, findAccount, saveGrant } from './accounts'
import { IDENTITY_SCOPES, PROVIDER, signInOn, USE } from './config'
import { GoogleError, googleUrl, readIdToken, requestToken, type GoogleClient } from './google'
import { clientOf, isSecure, sealerOf, serviceOf, siteOrigin, sitePath, UUID } from './runtime'
import { challengeOf, randomToken, sameText } from './secrets'

// Connecting a Google account to the person who is signed in: out to Google's consent screen
// and back. The state that ties the way back to this browser and this person travels in a signed
// cookie, and the code is exchanged with a verifier only that cookie holds (PKCE).

const COOKIE_NAMES = ['__Host-google_connect', 'google_connect'] as const
const TTL_MS = 10 * 60 * 1000
const RANDOM = /^[A-Za-z0-9_-]{43}$/
const MAX_COOKIE_LENGTH = 4000

/** Why connecting ended, as the accounts screen is told in its address: a fixed word, never text. */
export type ConnectOutcome =
  | 'connected'
  | 'denied'
  | 'expired'
  | 'taken'
  | 'other-account'
  | 'no-offline'
  | 'unverified'
  | 'setup'
  | 'failed'

interface Pending {
  state: string
  verifier: string
  user: string
  /** The service whose permission is asked for, or '' for the account alone. */
  service: string
  /** The account being given more permissions, or reconnected; '' for a new one. */
  account: string
  next: string
  expires: number
}

/** Google's consent address for a set of scopes. */
export function consentUrl(
  client: GoogleClient,
  input: {
    redirectUri: string
    state: string
    verifier: string
    scopes: readonly string[]
    /** Ask for a refresh token: for accounts the site keeps using. */
    offline: boolean
    /** The address to preselect, or a domain to keep the choice within. */
    loginHint?: string
    hostedDomain?: string
  },
): string {
  const query = new URLSearchParams({
    client_id: client.id,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: input.scopes.join(' '),
    state: input.state,
    code_challenge: challengeOf(input.verifier),
    code_challenge_method: 'S256',
  })
  if (input.offline) {
    query.set('access_type', 'offline')
    // Permissions granted earlier stay; Google gives a refresh token only with a fresh consent.
    query.set('include_granted_scopes', 'true')
    query.set('prompt', 'consent')
  } else {
    query.set('prompt', 'select_account')
  }
  if (input.loginHint) query.set('login_hint', input.loginHint)
  if (input.hostedDomain) query.set('hd', input.hostedDomain)
  return `${googleUrl('accounts.google.com', '/o/oauth2/v2/auth')}?${query}`
}

function seal(cms: PluginContext, pending: Pending): string {
  const payload = Buffer.from(JSON.stringify(pending)).toString('base64url')
  return `${payload}.${sealerOf(cms).sign('connect', payload)}`
}

function open(cms: PluginContext, value: string | null): Pending | null {
  if (!value || value.length > MAX_COOKIE_LENGTH) return null
  const [payload, signature, ...rest] = value.split('.')
  if (!payload || !signature || rest.length > 0) return null
  if (!sealerOf(cms).verify('connect', payload, signature)) return null
  try {
    const pending = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Pending
    return typeof pending.expires === 'number' && pending.expires > Date.now() ? pending : null
  } catch {
    return null
  }
}

function cookie(value: string, secure: boolean, maxAgeSeconds: number): string {
  // Lax, not Strict: the person comes back by a link from Google's site.
  const attributes = `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`
  return secure
    ? `${COOKIE_NAMES[0]}=${value}; ${attributes}; Secure`
    : `${COOKIE_NAMES[1]}=${value}; ${attributes}`
}

function cookieOf(request: Request, secure: boolean): string | null {
  // On https only the `__Host-` cookie counts: a plain one can be planted from a subdomain.
  const name = secure ? COOKIE_NAMES[0] : COOKIE_NAMES[1]
  for (const part of request.headers.get('cookie')?.split(';') ?? []) {
    const index = part.indexOf('=')
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim()
  }
  return null
}

function redirect(location: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({
    Location: location,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  })
  for (const value of cookies) headers.append('Set-Cookie', value)
  return new Response(null, { status: 303, headers })
}

/** Back to a screen of this site with the outcome in its address, the connect cookie gone. */
function finished(path: string, outcome: ConnectOutcome): Response {
  const url = new URL(path, 'http://local')
  url.searchParams.set('google', outcome)
  return redirect(url.pathname + url.search, [cookie('', true, 0), cookie('', false, 0)])
}

const callbackPath = (cms: PluginContext) => cms.routes.apiUrl('/oauth/callback')
const accountsPath = (cms: PluginContext) => cms.admin.url('/')

/** Where Google sends people back after connecting an account, for the setup instructions. */
export const connectRedirectUri = (cms: PluginContext, origin: string): string =>
  origin + callbackPath(cms)

/** The signed-in person, when they may use Google here: `null` signed out, `false` when they may not. */
async function signedIn(cms: PluginContext, context: ApiContext): Promise<User | null | false> {
  const user = await context.user()
  if (!user) return null
  return cms.auth.can(user, USE) ? user : false
}

const forbidden = () =>
  Response.json({ error: 'You may not connect Google accounts here.' }, { status: 403 })

/**
 * `GET /oauth/start?service=&account=&next=`: sends the signed-in person to Google to connect
 * an account, or to give one of theirs a service's permission.
 */
export async function startConnect(
  cms: PluginContext,
  request: Request,
  context: ApiContext,
): Promise<Response> {
  const url = new URL(request.url)
  const user = await signedIn(cms, context)
  if (user === false) return forbidden()
  // The admin's own sign-in page, which comes back to the accounts screen.
  if (!user) return redirect(`/admin/login?next=${encodeURIComponent(accountsPath(cms))}`)
  const next = sitePath(url.searchParams.get('next')) ?? accountsPath(cms)
  const client = clientOf(cms)
  if (!client) return finished(next, 'setup')

  const serviceId = url.searchParams.get('service') ?? ''
  const service = serviceId ? serviceOf(cms, serviceId) : null
  if (serviceId && !service) return Response.json({ error: 'Not found' }, { status: 404 })
  const accountId = url.searchParams.get('account') ?? ''
  const account = accountId ? await findAccount(cms, user.id, accountId) : null
  if (accountId && !account) return Response.json({ error: 'Not found' }, { status: 404 })

  const origin = siteOrigin(cms, request)
  const pending: Pending = {
    state: randomToken(),
    verifier: randomToken(),
    user: user.id,
    service: service?.id ?? '',
    account: account?.id ?? '',
    next,
    expires: Date.now() + TTL_MS,
  }
  return redirect(
    consentUrl(client, {
      redirectUri: connectRedirectUri(cms, origin),
      state: pending.state,
      verifier: pending.verifier,
      scopes: [...IDENTITY_SCOPES, ...(service?.scopes ?? [])],
      offline: true,
      loginHint: account?.email,
    }),
    [cookie(seal(cms, pending), isSecure(origin), TTL_MS / 1000)],
  )
}

/** `GET /oauth/callback`: the way back from Google's consent screen. */
export async function finishConnect(
  cms: PluginContext,
  request: Request,
  context: ApiContext,
): Promise<Response> {
  const url = new URL(request.url)
  const origin = siteOrigin(cms, request)
  const client = clientOf(cms)
  if (!client) return finished(accountsPath(cms), 'setup')
  const pending = open(cms, cookieOf(request, isSecure(origin)))
  const state = url.searchParams.get('state') ?? ''
  const user = await signedIn(cms, context)
  if (
    !pending ||
    !RANDOM.test(state) ||
    !sameText(state, pending.state) ||
    // The person who left is the one who is back: a way back sent to someone else does nothing.
    !user ||
    user.id !== pending.user ||
    (pending.account !== '' && !UUID.test(pending.account))
  ) {
    return finished(accountsPath(cms), 'expired')
  }
  const next = sitePath(pending.next) ?? accountsPath(cms)
  const code = url.searchParams.get('code')
  if (url.searchParams.get('error') || !code) return finished(next, 'denied')

  try {
    const grant = await requestToken(client, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: connectRedirectUri(cms, origin),
      code_verifier: pending.verifier,
    })
    const identity = readIdToken(grant.idToken, client.id)
    await saveGrant(cms, user, identity, grant, pending.account || null)
    // The person's own address, proved at Google just now: it may sign them in from here on.
    if (signInOn(cms) && identity.email === user.email) {
      await cms.auth.linkIdentity(PROVIDER, user, identity.subject).catch((error: unknown) => {
        if (!(error instanceof ActionError)) throw error
      })
    }
    return finished(next, 'connected')
  } catch (error) {
    if (error instanceof ConnectError) return finished(next, error.reason)
    if (error instanceof GoogleError) {
      cms.logger.warn('Connecting a Google account failed', {
        kind: error.kind,
        status: error.status,
      })
      return finished(next, 'failed')
    }
    throw error
  }
}
