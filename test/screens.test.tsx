import { sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { listAccounts } from '../src/accounts'
import google from '../src/index'
import { domainsOf } from '../src/settings'
import { createSealer } from '../src/secrets'
import { bootGoogle } from './fixtures'

describe('the accounts screen', () => {
  it('invites someone with no account to connect one', async () => {
    const site = await bootGoogle()
    const eve = await site.person('eve@cms.test', 'editor')
    const page = await site.screen('/admin/google', eve.user)
    expect(page.title).toBe('Google accounts')
    expect(page.html).toContain('You haven’t connected a Google account yet.')
    expect(page.html).toContain('href="/api/p/google/oauth/start"')
    expect(page.html).toContain('YouTube, Drive, Gmail')
    // Setup is for people who manage the plugin.
    expect(page.html).not.toContain('Redirect addresses')
    expect(page.html).not.toContain('Everyone’s')
  })

  it('shows each account, what it may use, and how to allow the rest', async () => {
    const site = await bootGoogle()
    const eve = await site.person('eve@cms.test', 'editor')
    await site.connect(eve, 'grace', { service: 'youtube' })
    const [account] = await listAccounts(site.cms(), eve.user.id)
    const { html } = await site.screen('/admin/google', eve.user, { google: 'connected' })
    expect(html).toContain('The Google account is connected.')
    expect(html).toContain('<strong>Grace Hopper</strong>')
    expect(html).toContain('grace@example.com')
    expect(html).toContain('YouTube<br/>')
    expect(html).toContain(
      `href="/api/p/google/oauth/start?account=${account!.id}&amp;service=drive">Allow Drive</a>`,
    )
    expect(html).toContain('Allow Gmail')
    expect(html).not.toContain('Allow YouTube')
    expect(html).toContain('<span class="g-state">Connected</span>')
    expect(html).toContain('action="/api/p/google/actions/disconnect"')
    expect(html).toContain('Let the site send email from it')
    // Choosing the site's sender is a manager's.
    expect(html).not.toContain('Use for the site’s email')
    // No token, sealed or not, is ever in a page.
    expect(html).not.toMatch(/v1\.[\w-]{20,}|ya29|1\/\/refresh/)
  })

  it('says only the outcomes it knows: nothing from the address is shown as it came', async () => {
    const site = await bootGoogle()
    const eve = await site.person('eve@cms.test', 'editor')
    const { html } = await site.screen('/admin/google', eve.user, {
      google: '<script>alert(1)</script>',
    })
    expect(html).not.toContain('alert(1)')
    expect(html).not.toContain('role="alert"')
    for (const [word, text] of [
      ['taken', 'connected by someone else on this site'],
      ['other-account', 'You chose a different Google account'],
      ['expired', 'That took too long'],
    ] as const) {
      expect((await site.screen('/admin/google', eve.user, { google: word })).html).toContain(text)
    }
  })

  it('tells an account that needs reconnecting, with the way to do it', async () => {
    const site = await bootGoogle()
    const eve = await site.person('eve@cms.test', 'editor')
    await site.connect(eve, 'grace')
    const [account] = await listAccounts(site.cms(), eve.user.id)
    await site.db.execute(
      sql`UPDATE google_accounts SET state = 'reconnect', problem = 'Google ended this connection on 27 November.'`,
    )
    const { html } = await site.screen('/admin/google', eve.user)
    expect(html).toContain('Needs reconnecting')
    expect(html).toContain('Google ended this connection on 27 November.')
    expect(html).toContain(`href="/api/p/google/oauth/start?account=${account!.id}">Reconnect</a>`)
    expect(html).not.toContain('Allow Drive')
  })

  it('gives a manager everyone’s accounts to see and disconnect, and the setup', async () => {
    const site = await bootGoogle({ settings: { 'site.url': 'https://shop.test' } })
    const eve = await site.person('eve@cms.test', 'editor')
    await site.connect(eve, 'grace')
    const boss = await site.person('boss@cms.test')
    const mine = await site.screen('/admin/google', boss.user)
    expect(mine.html).toContain('Mine <span class="count">(0)</span>')
    expect(mine.html).toContain('Everyone’s <span class="count">(1)</span>')
    expect(mine.html).toContain('<code>https://shop.test/api/p/google/oauth/callback</code>')
    expect(mine.html).toContain('<code>https://shop.test/api/p/core/sign-in/google/callback</code>')
    expect(mine.html).toContain('The sign-in pages show “Continue with Google”.')
    expect(mine.html).toContain('Not sent through Gmail.')

    const all = await site.screen('/admin/google', boss.user, { view: 'all' })
    expect(all.html).toContain('grace@example.com')
    expect(all.html).toContain('eve@cms.test')
    expect(all.html).toContain('action="/api/p/google/actions/disconnect"')
    // Somebody else's account: nothing to allow or to send from.
    expect(all.html).not.toContain('Allow Drive')
    expect(all.html).not.toContain('Let the site send email from it')
    // The view is a manager's: for anyone else it's their own list.
    const asEve = await site.screen('/admin/google', eve.user, { view: 'all' })
    expect(asEve.html).not.toContain('Connected by')
  })

  it('says what is missing on a site that hasn’t set Google up', async () => {
    const site = await bootGoogle({ unconfigured: true })
    const boss = await site.person('boss@cms.test')
    const { html } = await site.screen('/admin/google', boss.user)
    expect(html).toContain('Google isn’t set up yet.')
    expect(html).toContain('<code>GOOGLE_CLIENT_SECRET</code>')
    expect(html).toContain('with your site’s address in front')
  })

  it('is for people who may use Google', async () => {
    const site = await bootGoogle({ settings: { 'google.roles': ['editor'] } })
    const author = await site.person('a@cms.test', 'author')
    expect((await site.screen('/admin/google', author.user)).kind).toBe('forbidden')
    const editor = await site.person('e@cms.test', 'editor')
    expect((await site.screen('/admin/google', editor.user)).kind).toBe('page')
  })
})

describe('the settings', () => {
  it('place every setting on the Google settings page, for managers', async () => {
    const site = await bootGoogle()
    const boss = await site.person('boss@cms.test')
    const page = site.kernel.settingsPage('google.settings', boss.user)
    expect(page.kind).toBe('settings')
    const editor = await site.person('e@cms.test', 'editor')
    expect(site.kernel.settingsPage('google.settings', editor.user).kind).toBe('forbidden')
    expect(Object.keys(google.settings!).sort()).toEqual([
      'google.client_id',
      'google.client_secret',
      'google.domains',
      'google.drive',
      'google.gmail',
      'google.new_accounts',
      'google.new_role',
      'google.roles',
      'google.sign_in',
      'google.site_mail',
      'google.token_key',
      'google.youtube',
    ])
    // The two secrets come from the environment only.
    expect(google.settings!['google.client_secret']).toMatchObject({
      type: 'secret',
      env: 'GOOGLE_CLIENT_SECRET',
    })
    expect(google.settings!['google.token_key']).toMatchObject({
      type: 'secret',
      env: 'GOOGLE_TOKEN_KEY',
    })
  })

  it('read a list of domains, and refuse what isn’t one', () => {
    expect(domainsOf('')).toEqual([])
    expect(domainsOf(' Example.com , studio.example,')).toEqual(['example.com', 'studio.example'])
    for (const bad of ['example', 'http://example.com', 'a b.com', '*.example.com', '-a.com']) {
      expect(domainsOf(bad)).toBeNull()
    }
  })

  it('leave a service out everywhere once it is switched off', async () => {
    const site = await bootGoogle({ settings: { 'google.drive': false } })
    const eve = await site.person('eve@cms.test', 'editor')
    const { html } = await site.screen('/admin/google', eve.user)
    expect(html).toContain('YouTube, Gmail')
    expect((await site.leave(eve, { service: 'drive' })).response.status).toBe(404)
  })
})

describe('the keys', () => {
  it('open a token only for the row and column it was sealed for', () => {
    const sealer = createSealer('a client secret')
    const sealed = sealer.seal('refresh-token-value', 'row-1:refresh')
    expect(sealed).toMatch(/^v1\.[\w-]+$/)
    expect(sealed).not.toContain('refresh-token-value')
    expect(sealer.open(sealed, 'row-1:refresh')).toBe('refresh-token-value')
    expect(sealer.open(sealed, 'row-2:refresh')).toBeNull()
    expect(sealer.open(sealed, 'row-1:access')).toBeNull()
    expect(createSealer('another secret').open(sealed, 'row-1:refresh')).toBeNull()
    expect(sealer.open(`${sealed.slice(0, -2)}xx`, 'row-1:refresh')).toBeNull()
    for (const value of [null, '', 'v1.', 'plain.refresh-token-value', 'v2.abc']) {
      expect(sealer.open(value, 'row-1:refresh')).toBeNull()
    }
    // Two seals of one value differ: nothing tells that two rows hold the same token.
    expect(sealer.seal('refresh-token-value', 'row-1:refresh')).not.toBe(sealed)
  })

  it('sign for one purpose only', () => {
    const sealer = createSealer('a client secret')
    const signature = sealer.sign('connect', 'payload')
    expect(sealer.verify('connect', 'payload', signature)).toBe(true)
    expect(sealer.verify('other', 'payload', signature)).toBe(false)
    expect(sealer.verify('connect', 'payload2', signature)).toBe(false)
    expect(createSealer('another').verify('connect', 'payload', signature)).toBe(false)
    expect(() => createSealer('')).toThrow()
  })

  it('use a token key of their own when the site has one, so a new client secret loses nothing', async () => {
    const site = await bootGoogle({
      settings: { 'google.token_key': 'a long key just for the tokens' },
    })
    const eve = await site.person('eve@cms.test', 'editor')
    await site.connect(eve, 'grace')
    const [row] = await site.rows()
    const withKey = createSealer('a long key just for the tokens')
    expect(withKey.open(String(row!.refresh_token), `${String(row!.id)}:refresh`)).toMatch(
      /^1\/\/refresh\./,
    )
    expect(
      createSealer('test-client-secret').open(
        String(row!.refresh_token),
        `${String(row!.id)}:refresh`,
      ),
    ).toBeNull()
  })
})

describe('deleting the plugin’s data', () => {
  it('drops its table', async () => {
    const site = await bootGoogle()
    await google.uninstall!({
      plugin: { id: 'google', version: google.version },
      db: site.db,
      logger: site.logger,
    })
    await expect(site.db.execute(sql`SELECT 1 FROM google_accounts`)).rejects.toThrow()
  })
})
