// A stand-in for Google's servers, for the tests: the consent screen, the token endpoint,
// revocation, and whatever APIs the service files add (fake-youtube.mjs, fake-drive.mjs,
// fake-gmail.mjs). It answers at `{address}/{google host}/{path}`, which is where the plugin sends
// its requests when GOOGLE_API_URL names it. Plain JavaScript, so the browser tests can run it
// with node alone.
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

export const CLIENT = { id: 'test-client.apps.googleusercontent.com', secret: 'test-client-secret' }

/** The people who have Google accounts, by a short key the tests name them with. */
export const PEOPLE = {
  ada: { sub: '1001', email: 'ada@gmail.com', email_verified: true, name: 'Ada Lovelace' },
  // A Google Workspace account: Google hosts example.com's mail.
  grace: {
    sub: '1002',
    email: 'grace@example.com',
    email_verified: true,
    name: 'Grace Hopper',
    hd: 'example.com',
  },
  // A Google account on an address Google doesn't host.
  linus: {
    sub: '1003',
    email: 'linus@elsewhere.test',
    email_verified: true,
    name: 'Linus Elsewhere',
  },
  unverified: {
    sub: '1004',
    email: 'new@elsewhere.test',
    email_verified: false,
    name: 'Not Verified',
  },
}

const token = (prefix) => `${prefix}.${randomBytes(24).toString('base64url')}`
const json = (status, body, headers = {}) => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
})
const html = (body) => ({
  status: 200,
  headers: { 'content-type': 'text/html; charset=utf-8' },
  body,
})
const escape = (value) => String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

/** Google's shape for an API error. */
export const apiError = (status, reason, message = reason) =>
  json(status, { error: { code: status, message, errors: [{ reason, message }], status: reason } })

/**
 * Starts the stand-in on `port` (0 picks a free one). `routes` are the service files' additions:
 * functions `(fake) => void` that call `fake.route()`.
 */
export async function startFakeGoogle({ port = 0, routes = [] } = {}) {
  const fake = {
    url: '',
    people: structuredClone(PEOPLE),
    /** Codes waiting to be exchanged, by code. */
    codes: new Map(),
    /** What each person granted this client: scopes, and the refresh tokens that are still good. */
    grants: new Map(),
    /** Access tokens: who, which scopes, until when. */
    access: new Map(),
    /** Every request received, for tests to count and to look at. */
    requests: [],
    /** Emails sent through Gmail's send, decoded. */
    sent: [],
    /** Answers to give instead of the real one, first in first out: `{ match, status, headers }`. */
    failures: [],
    handlers: [],
    /** Whatever the service files keep: videos, files, messages. */
    data: {},

    /** Adds an API: `handler({ url, method, headers, body, person, scopes, params })` returns a response. */
    route(method, host, pattern, scope, handler) {
      const names = []
      const source = pattern.replace(/:(\w+)/g, (_, name) => (names.push(name), '([^/]+)'))
      fake.handlers.push({
        method,
        host,
        pattern: new RegExp(`^${source}$`),
        names,
        scope,
        handler,
      })
    },

    /** Starts over: nobody has granted anything, nothing was sent. */
    reset() {
      fake.people = structuredClone(PEOPLE)
      for (const store of [fake.codes, fake.grants, fake.access]) store.clear()
      fake.requests.length = 0
      fake.sent.length = 0
      fake.failures.length = 0
      for (const key of Object.keys(fake.data)) delete fake.data[key]
      for (const seed of fake.seeds) seed()
    },
    seeds: [],

    /**
     * What Google's consent screen does once a person allows (or denies) what `authUrl` asks:
     * the address the browser is sent back to. `only` grants a subset of the scopes asked for,
     * as a person can untick a permission.
     */
    authorize(authUrl, who, { deny = false, only = null } = {}) {
      const asked = new URL(authUrl)
      const query = asked.searchParams
      const back = new URL(query.get('redirect_uri'))
      back.searchParams.set('state', query.get('state') ?? '')
      if (query.get('client_id') !== CLIENT.id) throw new Error('fake Google: unknown client_id')
      if (deny) {
        back.searchParams.set('error', 'access_denied')
        return back.href
      }
      const person = fake.people[who]
      if (!person) throw new Error(`fake Google: nobody called ${who}`)
      const scopes = (query.get('scope') ?? '').split(' ').filter(Boolean)
      const granted = only
        ? scopes.filter(
            (scope) => only.includes(scope) || ['openid', 'email', 'profile'].includes(scope),
          )
        : scopes
      const code = token('code')
      fake.codes.set(code, {
        who,
        scopes: granted,
        redirectUri: query.get('redirect_uri'),
        challenge: query.get('code_challenge'),
        offline: query.get('access_type') === 'offline',
        consent: query.get('prompt') === 'consent',
        keepGranted: query.get('include_granted_scopes') === 'true',
      })
      back.searchParams.set('code', code)
      return back.href
    },

    /** Google ends a person's grant: at their own request, or after a testing client's 7 days. */
    revoke(who) {
      fake.grants.delete(who)
      for (const [value, entry] of fake.access) if (entry.who === who) fake.access.delete(value)
    },

    /** Every access token stops working, as after an hour; refresh tokens still do. */
    expireAccessTokens() {
      fake.access.clear()
    },

    /** The next `times` requests whose path includes `match` get `status` instead of an answer. */
    failNext(match, status, { times = 1, headers = {} } = {}) {
      for (let index = 0; index < times; index++) fake.failures.push({ match, status, headers })
    },

    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }

  const issue = (who, scopes) => {
    const value = token('ya29')
    fake.access.set(value, { who, scopes, expires: Date.now() + 3599_000 })
    return value
  }

  const idToken = (person) => {
    const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const claims = {
      iss: 'https://accounts.google.com',
      aud: CLIENT.id,
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...person,
    }
    return `${part({ alg: 'none' })}.${part(claims)}.signature`
  }

  function tokenEndpoint(form) {
    if (form.get('client_id') !== CLIENT.id || form.get('client_secret') !== CLIENT.secret) {
      return json(401, { error: 'invalid_client' })
    }
    if (form.get('grant_type') === 'authorization_code') {
      const code = fake.codes.get(form.get('code'))
      fake.codes.delete(form.get('code'))
      const challenge = createHash('sha256')
        .update(form.get('code_verifier') ?? '')
        .digest('base64url')
      if (!code || code.redirectUri !== form.get('redirect_uri') || code.challenge !== challenge) {
        return json(400, { error: 'invalid_grant' })
      }
      const grant = fake.grants.get(code.who) ?? { scopes: [], refresh: new Set() }
      grant.scopes = [...new Set([...(code.keepGranted ? grant.scopes : []), ...code.scopes])]
      fake.grants.set(code.who, grant)
      const answer = {
        access_token: issue(code.who, grant.scopes),
        expires_in: 3599,
        scope: grant.scopes.join(' '),
        token_type: 'Bearer',
        id_token: idToken(fake.people[code.who]),
      }
      // As Google: a refresh token comes only for offline access, with a consent just given.
      if (code.offline && code.consent) {
        answer.refresh_token = token('1//refresh')
        grant.refresh.add(answer.refresh_token)
      }
      return json(200, answer)
    }
    if (form.get('grant_type') === 'refresh_token') {
      for (const [who, grant] of fake.grants) {
        if (grant.refresh.has(form.get('refresh_token'))) {
          return json(200, {
            access_token: issue(who, grant.scopes),
            expires_in: 3599,
            scope: grant.scopes.join(' '),
            token_type: 'Bearer',
          })
        }
      }
      return json(400, {
        error: 'invalid_grant',
        error_description: 'Token has been expired or revoked.',
      })
    }
    return json(400, { error: 'unsupported_grant_type' })
  }

  function revokeEndpoint(form) {
    const value = form.get('token')
    for (const [who, grant] of fake.grants) {
      if (grant.refresh.has(value) || fake.access.get(value)?.who === who) {
        fake.revoke(who)
        return json(200, {})
      }
    }
    return json(400, { error: 'invalid_token' })
  }

  /** The consent screen, for a browser: who are you, and do you allow it. */
  function consentPage(url) {
    const scopes = (url.searchParams.get('scope') ?? '').split(' ').filter(Boolean)
    const hint = url.searchParams.get('login_hint')
    return html(`<!doctype html><title>Sign in – Google Accounts (stand-in)</title>
<h1>Google (stand-in)</h1>
<form method="get" action="${escape(fake.url)}/__/consent">
<input type="hidden" name="asked" value="${escape(url.href)}">
<fieldset><legend>Choose an account</legend>
${Object.entries(fake.people)
  .map(
    ([key, person]) =>
      `<label><input type="radio" name="who" value="${escape(key)}"${person.email === hint ? ' checked' : ''} required> ${escape(person.email)}</label><br>`,
  )
  .join('\n')}
</fieldset>
<fieldset><legend>This site wants to</legend>
${scopes.map((scope) => `<label><input type="checkbox" name="only" value="${escape(scope)}" checked> ${escape(scope)}</label><br>`).join('\n')}
</fieldset>
<button name="answer" value="allow">Allow</button>
<button name="answer" value="deny" formnovalidate>Cancel</button>
</form>`)
  }

  function control(url, method, body) {
    if (url.pathname === '/__/health') return json(200, { ok: true })
    if (url.pathname === '/__/consent') {
      const location = fake.authorize(
        url.searchParams.get('asked'),
        url.searchParams.get('who') ?? 'ada',
        {
          deny: url.searchParams.get('answer') === 'deny',
          only: url.searchParams.getAll('only'),
        },
      )
      return { status: 302, headers: { location }, body: '' }
    }
    if (url.pathname === '/__/state') {
      return json(200, {
        sent: fake.sent,
        data: fake.data,
        requests: fake.requests.map(({ method, path }) => ({ method, path })),
      })
    }
    if (url.pathname === '/__/control' && method === 'POST') {
      const order = JSON.parse(body.toString('utf8') || '{}')
      if (order.do === 'reset') fake.reset()
      else if (order.do === 'expire') fake.expireAccessTokens()
      else if (order.do === 'revoke') fake.revoke(order.who)
      else if (order.do === 'fail') fake.failNext(order.match, order.status, order)
      else return json(400, { error: 'unknown order' })
      return json(200, { ok: true })
    }
    return null
  }

  async function answer(method, url, headers, body) {
    const made = control(url, method, body)
    if (made) return made
    const [, host, ...rest] = url.pathname.split('/')
    const path = `/${rest.join('/')}`
    fake.requests.push({ method, host, path, query: url.search, headers, body })

    const failing = fake.failures.findIndex((failure) => url.pathname.includes(failure.match))
    if (failing >= 0) {
      const [{ status, headers: extra }] = fake.failures.splice(failing, 1)
      const made = apiError(status, status === 429 ? 'rateLimitExceeded' : 'backendError')
      return { ...made, headers: { ...made.headers, ...extra } }
    }

    if (host === 'accounts.google.com' && path === '/o/oauth2/v2/auth') return consentPage(url)
    if (host === 'oauth2.googleapis.com') {
      const form = new URLSearchParams(body.toString('utf8'))
      if (path === '/token') return tokenEndpoint(form)
      if (path === '/revoke') return revokeEndpoint(form)
    }

    for (const handler of fake.handlers) {
      if (handler.method !== method || handler.host !== host) continue
      const match = handler.pattern.exec(path)
      if (!match) continue
      const params = Object.fromEntries(
        handler.names.map((name, index) => [name, decodeURIComponent(match[index + 1])]),
      )
      // An upload's own address takes bytes from whoever holds it: `scope: false` asks for no token.
      if (handler.scope === false) {
        return handler.handler({
          url,
          method,
          headers,
          body,
          params,
          who: null,
          person: null,
          scopes: [],
        })
      }
      const bearer = /^Bearer (.+)$/.exec(headers.authorization ?? '')?.[1]
      const session = bearer ? fake.access.get(bearer) : null
      if (!session || session.expires < Date.now())
        return apiError(401, 'UNAUTHENTICATED', 'Invalid Credentials')
      if (handler.scope && !handler.scope.some((scope) => session.scopes.includes(scope))) {
        return apiError(
          403,
          'insufficientPermissions',
          'Request had insufficient authentication scopes.',
        )
      }
      return handler.handler({
        url,
        method,
        headers,
        body,
        params,
        who: session.who,
        person: fake.people[session.who],
        scopes: session.scopes,
      })
    }
    return apiError(404, 'notFound', `The stand-in has no ${method} ${host}${path}`)
  }

  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', async () => {
      const url = new URL(request.url, fake.url)
      let made
      try {
        made = await answer(request.method, url, request.headers, Buffer.concat(chunks))
      } catch (error) {
        made = json(500, { error: String(error?.message ?? error) })
      }
      response.writeHead(made.status, made.headers)
      response.end(made.body)
    })
  })
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  fake.url = `http://127.0.0.1:${server.address().port}`

  // Sending email: every test of the site's email needs it, so it's part of the core.
  fake.route(
    'POST',
    'gmail.googleapis.com',
    '/gmail/v1/users/me/messages/send',
    [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://mail.google.com/',
    ],
    ({ body, person, who }) => {
      const { raw, threadId } = JSON.parse(body.toString('utf8'))
      const mime = Buffer.from(raw, 'base64url').toString('utf8')
      const id = `sent-${fake.sent.length + 1}`
      fake.sent.push({ id, who, from: person.email, mime, threadId: threadId ?? null })
      return json(200, { id, threadId: threadId ?? id, labelIds: ['SENT'] })
    },
  )

  for (const add of routes) add(fake)
  return fake
}

export { json as jsonAnswer }
