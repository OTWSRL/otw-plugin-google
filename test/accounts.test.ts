import { describe, expect, it, vi } from 'vitest'
import {
  allows,
  canSend,
  findAccount,
  googleFetch,
  googleJson,
  listAccounts,
} from '../src/accounts'
import { GoogleError } from '../src/google'
import { bootGoogle, DRIVE, SEND, YOUTUBE } from './fixtures'
import { jsonAnswer, type FakeGoogle } from './fake-google.mjs'

/** A tiny API on the stand-in, to send requests to: it says who asked. */
const whoami = (fake: FakeGoogle) => {
  fake.route('GET', 'www.googleapis.com', '/test/me', null, ({ person }) =>
    jsonAnswer(200, { email: person.email }),
  )
  fake.route('POST', 'www.googleapis.com', '/test/me', null, ({ person }) =>
    jsonAnswer(200, { email: person.email }),
  )
}
const ME = (fake: FakeGoogle) => `${fake.url}/www.googleapis.com/test/me`

async function connected() {
  const site = await bootGoogle({ routes: [whoami] })
  const ada = await site.person('ada@gmail.com')
  expect((await site.connect(ada, 'ada')).outcome).toBe('connected')
  const [account] = await listAccounts(site.cms(), ada.user.id)
  return { site, ada, account: account!, cms: site.cms() }
}

describe('connecting an account', () => {
  it('keeps who it is and what it allowed, and never a token as it came', async () => {
    const { site, ada, account } = await connected()
    expect(account).toMatchObject({
      userId: ada.user.id,
      subject: '1001',
      email: 'ada@gmail.com',
      name: 'Ada Lovelace',
      state: 'ok',
      sendsMail: false,
      siteMail: false,
    })
    expect([...account.scopes].sort()).toEqual(['email', 'openid', 'profile'])
    const [row] = await site.rows()
    const issued = [...site.fake.access.keys(), ...site.fake.grants.get('ada')!.refresh]
    expect(issued).toHaveLength(2)
    for (const token of issued) expect(JSON.stringify(row)).not.toContain(token)
    expect(row!.refresh_token).toMatch(/^v1\./)
    expect(row!.access_token).toMatch(/^v1\./)
    // Nor in anything logged.
    for (const token of issued) expect(JSON.stringify(site.logger.entries)).not.toContain(token)
  })

  it('asks Google for the account alone at first, and for a service’s permission when asked', async () => {
    const { site, ada, account } = await connected()
    const left = await site.leave(ada, { service: 'youtube', account: account.id })
    const asked = new URL(left.location).searchParams
    expect(asked.get('scope')).toBe(`openid email profile ${YOUTUBE}`)
    expect(asked.get('access_type')).toBe('offline')
    expect(asked.get('include_granted_scopes')).toBe('true')
    expect(asked.get('prompt')).toBe('consent')
    expect(asked.get('login_hint')).toBe('ada@gmail.com')
    expect(asked.get('code_challenge_method')).toBe('S256')
    expect(asked.get('redirect_uri')).toBe('http://cms.test/api/p/google/oauth/callback')

    expect(
      (await site.connect(ada, 'ada', { service: 'youtube', account: account.id })).outcome,
    ).toBe('connected')
    expect(
      (await site.connect(ada, 'ada', { service: 'drive', account: account.id })).outcome,
    ).toBe('connected')
    const cms = site.cms()
    const after = (await findAccount(cms, ada.user.id, account.id))!
    expect(after.id).toBe(account.id)
    expect(allows(after, { scopes: [YOUTUBE] })).toBe(true)
    expect(allows(after, { scopes: [DRIVE] })).toBe(true)
    expect(await site.rows()).toHaveLength(1)
  })

  it('takes what Google granted, not what was asked: a permission can be unticked', async () => {
    const { site, ada, account, cms } = await connected()
    await site.connect(ada, 'ada', { service: 'youtube', account: account.id, only: [] })
    const after = (await findAccount(cms, ada.user.id, account.id))!
    expect(allows(after, { scopes: [YOUTUBE] })).toBe(false)
  })

  it('changes nothing when a different Google account comes back than the one being changed', async () => {
    const { site, ada, account, cms } = await connected()
    const done = await site.connect(ada, 'grace', { service: 'youtube', account: account.id })
    expect(done.outcome).toBe('other-account')
    expect(await site.rows()).toHaveLength(1)
    expect((await findAccount(cms, ada.user.id, account.id))!.email).toBe('ada@gmail.com')
  })

  it('gives a Google account to one person: another can’t connect it too', async () => {
    const { site } = await connected()
    const eve = await site.person('eve@cms.test', 'editor')
    expect((await site.connect(eve, 'ada')).outcome).toBe('taken')
    expect(await site.rows()).toHaveLength(1)
    // Their own is fine, and each sees only theirs.
    expect((await site.connect(eve, 'grace')).outcome).toBe('connected')
    const cms = site.cms()
    expect((await listAccounts(cms, eve.user.id)).map((account) => account.email)).toEqual([
      'grace@example.com',
    ])
  })

  it('turns away an account whose address Google hasn’t verified, and a cancelled consent', async () => {
    const site = await bootGoogle()
    const ada = await site.person('ada@cms.test')
    expect((await site.connect(ada, 'unverified')).outcome).toBe('unverified')
    expect((await site.connect(ada, 'ada', { deny: true })).outcome).toBe('denied')
    expect(await site.rows()).toEqual([])
  })

  it('is for people who may use Google: signed out goes to sign in, others are refused', async () => {
    const site = await bootGoogle()
    const out = await site.get('/api/p/google/oauth/start')
    expect(out.status).toBe(303)
    expect(out.headers.get('location')).toMatch(/^\/admin\/login\?next=/)
    const customer = await site.person('c@cms.test', 'customer')
    expect((await site.get('/api/p/google/oauth/start', customer.cookie)).status).toBe(403)
    // Someone else's account, or a service that doesn't exist: nothing to connect to.
    const ada = await site.person('ada@cms.test')
    const eve = await site.person('eve@cms.test', 'editor')
    await site.connect(ada, 'ada')
    const [account] = await listAccounts(site.cms(), ada.user.id)
    expect((await site.leave(eve, { account: account!.id })).response.status).toBe(404)
    expect((await site.leave(ada, { service: 'calendar' })).response.status).toBe(404)
  })

  it('says so when Google isn’t set up, without leaving the site', async () => {
    const site = await bootGoogle({ unconfigured: true })
    const ada = await site.person('ada@cms.test')
    const left = await site.leave(ada)
    expect(left.location).toBe('/admin/google?google=setup')
  })
})

describe('the way back', () => {
  it('needs the browser and the person that left: anything else is refused, with nothing kept', async () => {
    const site = await bootGoogle()
    const ada = await site.person('ada@cms.test')
    const eve = await site.person('eve@cms.test', 'editor')
    const left = await site.leave(ada)
    const callback = site.fake.authorize(left.location, 'ada')

    // Another person's session with the same cookie: a way back sent to someone else.
    expect((await site.back(eve, left.cookie, callback)).outcome).toBe('expired')
    // No session, no cookie, a cookie changed, another state.
    expect((await site.back(null, left.cookie, callback)).outcome).toBe('expired')
    expect((await site.back(ada, null, callback)).outcome).toBe('expired')
    // The signature's first character changed: other bytes, whatever the signature was.
    const at = left.cookie!.lastIndexOf('.') + 1
    const swapped = left.cookie![at] === 'A' ? 'Q' : 'A'
    const forged = left.cookie!.slice(0, at) + swapped + left.cookie!.slice(at + 1)
    expect((await site.back(ada, forged, callback)).outcome).toBe('expired')
    const other = new URL(callback)
    other.searchParams.set('state', 'x'.repeat(43))
    expect((await site.back(ada, left.cookie, other.href)).outcome).toBe('expired')
    expect(await site.rows()).toEqual([])
    // Google's code was never spent on them.
    expect(site.fake.requests.filter((request) => request.path === '/token')).toHaveLength(0)

    expect((await site.back(ada, left.cookie, callback)).outcome).toBe('connected')
  })

  it('runs out after ten minutes', async () => {
    const site = await bootGoogle()
    const ada = await site.person('ada@cms.test')
    const left = await site.leave(ada)
    const callback = site.fake.authorize(left.location, 'ada')
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10 * 60 * 1000 + 1000 })
    expect((await site.back(ada, left.cookie, callback)).outcome).toBe('expired')
    expect(await site.rows()).toEqual([])
  })

  it('goes back only to a path on this site', async () => {
    const site = await bootGoogle()
    const ada = await site.person('ada@cms.test')
    for (const next of ['https://evil.test/', '//evil.test', '/\\evil.test']) {
      const left = await site.leave(ada, { next })
      const done = await site.back(
        ada,
        left.cookie,
        site.fake.authorize(left.location, 'ada', { deny: true }),
      )
      expect({ next, path: done.path }).toEqual({ next, path: '/admin/google' })
    }
    const left = await site.leave(ada, { next: '/admin/google/youtube?account=1' })
    const done = await site.back(ada, left.cookie, site.fake.authorize(left.location, 'ada'))
    expect(done.response.headers.get('location')).toBe(
      '/admin/google/youtube?account=1&google=connected',
    )
  })

  it('uses the `__Host-` cookie on an https site, and takes no plain one there', async () => {
    const site = await bootGoogle({ settings: { 'site.url': 'https://shop.test' } })
    const ada = await site.person('ada@cms.test')
    const left = await site.leave(ada)
    expect(left.cookie!.startsWith('__Host-google_connect=')).toBe(true)
    expect(new URL(left.location).searchParams.get('redirect_uri')).toBe(
      'https://shop.test/api/p/google/oauth/callback',
    )
    const callback = site.fake.authorize(left.location, 'ada')
    const planted = left.cookie!.replace('__Host-', '')
    expect((await site.back(ada, planted, callback)).outcome).toBe('expired')
    expect((await site.back(ada, left.cookie, callback)).outcome).toBe('connected')
  })
})

describe('requests to Google', () => {
  it('carry the account’s token, and a new one once the old has run out', async () => {
    const { site, ada, account, cms } = await connected()
    expect(await googleJson(cms, ada.user.id, account.id, ME(site.fake))).toEqual({
      email: 'ada@gmail.com',
    })
    const before = site.fake.requests.filter((request) => request.path === '/token').length
    // The stored token is good for an hour: no second trip to the token endpoint.
    await googleJson(cms, ada.user.id, account.id, ME(site.fake))
    expect(site.fake.requests.filter((request) => request.path === '/token')).toHaveLength(before)

    site.fake.expireAccessTokens()
    expect(await googleJson(cms, ada.user.id, account.id, ME(site.fake))).toEqual({
      email: 'ada@gmail.com',
    })
    const tokens = site.fake.requests.filter((request) => request.path === '/token')
    expect(tokens).toHaveLength(before + 1)
    expect(new URLSearchParams(tokens.at(-1)!.body.toString()).get('grant_type')).toBe(
      'refresh_token',
    )
  })

  it('mark the account for reconnecting once Google has ended the connection', async () => {
    const { site, ada, account, cms } = await connected()
    site.fake.revoke('ada')
    await expect(googleJson(cms, ada.user.id, account.id, ME(site.fake))).rejects.toMatchObject({
      name: 'GoogleError',
      kind: 'reconnect',
    })
    const after = (await findAccount(cms, ada.user.id, account.id))!
    expect(after.state).toBe('reconnect')
    expect(after.problem).toMatch(/^Google ended this connection on \d+ \w+\.$/)
    const [row] = await site.rows()
    expect(row).toMatchObject({ refresh_token: null, access_token: null })
    // And asks Google nothing more until it's connected again.
    const asked = site.fake.requests.length
    await expect(googleJson(cms, ada.user.id, account.id, ME(site.fake))).rejects.toBeInstanceOf(
      GoogleError,
    )
    expect(site.fake.requests).toHaveLength(asked)
    // Connecting again mends the same account.
    expect((await site.connect(ada, 'ada', { account: account.id })).outcome).toBe('connected')
    expect((await findAccount(cms, ada.user.id, account.id))!.state).toBe('ok')
    expect(await googleJson(cms, ada.user.id, account.id, ME(site.fake))).toEqual({
      email: 'ada@gmail.com',
    })
  })

  it('are for the account’s owner: someone else’s id finds no account', async () => {
    const { site, account, cms } = await connected()
    const eve = await site.person('eve@cms.test', 'editor')
    await expect(googleFetch(cms, eve.user.id, account.id, ME(site.fake))).rejects.toMatchObject({
      kind: 'not_found',
    })
    await expect(googleFetch(cms, eve.user.id, 'not-a-uuid', ME(site.fake))).rejects.toMatchObject({
      kind: 'not_found',
    })
    expect(await findAccount(cms, eve.user.id, account.id)).toBeNull()
    expect(site.fake.requests.filter((request) => request.path === '/test/me')).toHaveLength(0)
  })

  it('try a read again when Google asks, and a POST never', async () => {
    const { site, ada, account, cms } = await connected()
    site.fake.failNext('/test/me', 503, { times: 2 })
    expect(await googleJson(cms, ada.user.id, account.id, ME(site.fake))).toEqual({
      email: 'ada@gmail.com',
    })
    expect(site.fake.requests.filter((request) => request.path === '/test/me')).toHaveLength(3)

    site.fake.failNext('/test/me', 503)
    await expect(
      googleJson(cms, ada.user.id, account.id, ME(site.fake), { method: 'POST', json: {} }),
    ).rejects.toMatchObject({ kind: 'unavailable', status: 503 })
    expect(site.fake.requests.filter((request) => request.path === '/test/me')).toHaveLength(4)

    // Three failures in a row are the answer.
    site.fake.failNext('/test/me', 429, { times: 3 })
    await expect(googleJson(cms, ada.user.id, account.id, ME(site.fake))).rejects.toMatchObject({
      kind: 'limit',
    })
  })

  it('renew a token Google withdrew early, once', async () => {
    const { site, ada, account, cms } = await connected()
    // The stored token is gone at Google while this site still thinks it's good.
    site.fake.access.clear()
    expect(await googleJson(cms, ada.user.id, account.id, ME(site.fake))).toEqual({
      email: 'ada@gmail.com',
    })
    expect(site.fake.requests.filter((request) => request.path === '/test/me')).toHaveLength(2)
  })

  it('never open a token moved to another row, or sealed with another key', async () => {
    const { site, ada, account, cms } = await connected()
    await site.connect(ada, 'grace')
    const [first, second] = await site.rows()
    expect(first!.id).toBe(account.id)
    await site.db.execute(
      // Grace's row gets Ada's tokens: whoever can write the database gains nothing by it.
      `UPDATE google_accounts SET refresh_token = '${String(first!.refresh_token)}', access_token = '${String(first!.access_token)}' WHERE id = '${String(second!.id)}'` as never,
    )
    await expect(
      googleJson(cms, ada.user.id, String(second!.id), ME(site.fake)),
    ).rejects.toMatchObject({ kind: 'reconnect' })
    expect((await findAccount(cms, ada.user.id, String(second!.id)))!.problem).toBe(
      'Its stored connection can’t be read any more.',
    )
  })

  it('know sending from all of Gmail, from sending alone, and from nothing', () => {
    const account = (scopes: string[]) => ({ scopes }) as never
    expect(canSend(account([SEND]))).toBe(true)
    expect(canSend(account(['https://www.googleapis.com/auth/gmail.modify']))).toBe(true)
    expect(canSend(account(['openid', YOUTUBE]))).toBe(false)
  })
})

describe('disconnecting', () => {
  it('ends the grant at Google and forgets the account', async () => {
    const { site, ada, account } = await connected()
    const done = await site.act(ada.cookie, 'disconnect', { id: account.id })
    expect(done.flash).toEqual({
      kind: 'notice',
      message: 'ada@gmail.com is disconnected. This site no longer has access to it.',
    })
    expect(await site.rows()).toEqual([])
    expect(site.fake.grants.has('ada')).toBe(false)
  })

  it('forgets the account even when Google can’t be told', async () => {
    const { site, ada, account } = await connected()
    site.fake.failNext('/revoke', 503)
    await site.act(ada.cookie, 'disconnect', { id: account.id })
    expect(await site.rows()).toEqual([])
    expect(site.logger.entries.some((entry) => entry.level === 'warn')).toBe(true)
  })

  it('is the owner’s to do, or a manager’s: nobody else’s', async () => {
    const { site, account } = await connected()
    const eve = await site.person('eve@cms.test', 'editor')
    const refused = await site.act(eve.cookie, 'disconnect', { id: account.id })
    expect(refused.flash).toEqual({
      kind: 'error',
      message: 'That Google account isn’t connected any more.',
    })
    expect(await site.rows()).toHaveLength(1)
    const boss = await site.person('boss@cms.test')
    await site.act(boss.cookie, 'disconnect', { id: account.id })
    expect(await site.rows()).toEqual([])
  })
})

describe('for other plugins', () => {
  it('lists a person’s accounts and sends requests as them, without a token in sight', async () => {
    const { site, ada, account } = await connected()
    const service = site.service()
    const accounts = await service.accounts(ada.user.id)
    expect(accounts.map((item) => item.email)).toEqual(['ada@gmail.com'])
    expect(JSON.stringify(accounts)).not.toMatch(/ya29|refresh/)
    const response = await service.fetch(ada.user.id, account.id, ME(site.fake))
    expect(await response.json()).toEqual({ email: 'ada@gmail.com' })
  })
})
