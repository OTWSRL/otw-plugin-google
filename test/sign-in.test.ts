import { describe, expect, it } from 'vitest'
import { listAccounts } from '../src/accounts'
import { bootGoogle, type BootOptions, type GoogleSite } from './fixtures'

/** "Continue with Google" from a sign-in page, as one of the stand-in's people. */
async function signIn(
  site: GoogleSite,
  who: string,
  options: { screen?: 'admin' | 'account'; deny?: boolean } = {},
) {
  const start = await site.get(`/api/p/core/sign-in/google?screen=${options.screen ?? 'admin'}`)
  const location = start.headers.get('location') ?? ''
  const cookie = site.setCookie(start, 'cms_sign_in_with')
  if (!location.includes('/accounts.google.com/'))
    return { start, location, session: null, user: null, path: '', flash: null }
  const callback = new URL(site.fake.authorize(location, who, { deny: options.deny }))
  const response = await site.get(callback.pathname + callback.search, cookie ?? '')
  const session = site.setCookie(response, 'cms_session')?.split('=')[1] ?? null
  const back = new URL(response.headers.get('location') ?? '/', 'http://cms.test')
  return {
    start,
    location,
    session,
    user: session ? await site.kernel.auth.userForSession(session) : null,
    path: back.pathname,
    flash: site.kernel.readFlash(back.searchParams.get('flash') ?? undefined),
  }
}

const boot = (options: BootOptions = {}) => bootGoogle(options)

describe('the sign-in pages', () => {
  it('offer Continue with Google once the client is set up, and not before or when switched off', async () => {
    const on = await boot()
    expect(on.kernel.signInProviders('admin', null)).toMatchObject([
      {
        id: 'google',
        label: 'Continue with Google',
        url: '/api/p/core/sign-in/google?screen=admin',
      },
    ])
    // Google's mark, from core's address for it, which browsers keep.
    const image = on.kernel.signInProviders('admin', null)[0]!.image!
    expect(image).toMatch(/^\/api\/p\/core\/sign-in\/google\/image\?v=[0-9a-f]{12}$/)
    const mark = await on.get(image)
    expect(mark.headers.get('content-type')).toBe('image/svg+xml')
    expect(await mark.text()).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/)
    expect((await boot({ unconfigured: true })).kernel.signInProviders('admin', null)).toEqual([])
    const off = await boot({ settings: { 'google.sign_in': false } })
    expect(off.kernel.signInProviders('admin', null)).toEqual([])
    expect((await off.get('/api/p/core/sign-in/google')).status).toBe(404)
  })

  it('ask Google for who the person is and nothing more', async () => {
    const site = await boot()
    const { location } = await signIn(site, 'ada', { deny: true })
    const asked = new URL(location).searchParams
    expect(asked.get('scope')).toBe('openid email profile')
    expect(asked.get('prompt')).toBe('select_account')
    expect(asked.get('access_type')).toBeNull()
    expect(asked.get('code_challenge_method')).toBe('S256')
    expect(asked.get('redirect_uri')).toBe('http://cms.test/api/p/core/sign-in/google/callback')
    expect(asked.get('client_id')).toBe('test-client.apps.googleusercontent.com')
  })
})

describe('signing in with Google', () => {
  it('gives someone new an account with the Google user role, which opens the Google screens only', async () => {
    const site = await boot()
    const done = await signIn(site, 'ada')
    expect(done.user).toMatchObject({
      email: 'ada@gmail.com',
      name: 'Ada Lovelace',
      role: 'google_user',
    })
    expect(done.path).toBe('/admin')
    expect(site.kernel.can(done.user, 'google.use')).toBe(true)
    expect(site.kernel.can(done.user, 'core.access_admin')).toBe(true)
    expect(site.kernel.can(done.user, 'google.manage')).toBe(false)
    expect(site.kernel.can(done.user, 'core.manage_settings')).toBe(false)
    const menu = site.kernel
      .adminMenu(done.user!)
      .flatMap((section) => section.items.map((item) => item.url))
    expect(menu).toContain('/admin/google')
    expect(
      menu.some((url) => url.startsWith('/admin/users') || url.startsWith('/admin/plugins')),
    ).toBe(false)
    // Signing in keeps no token: the person connects an account when they want to use it.
    expect(await site.rows()).toEqual([])
    // And finds the same account next time.
    expect((await signIn(site, 'ada')).user).toEqual(done.user)
  })

  it('opens the account that has the address when Google hosts the mailbox', async () => {
    const site = await boot()
    const ada = await site.person('ada@gmail.com')
    const grace = await site.person('grace@example.com', 'editor')
    expect((await signIn(site, 'ada')).user).toEqual(ada.user)
    // A Workspace account: Google hosts example.com.
    expect((await signIn(site, 'grace')).user).toEqual(grace.user)
  })

  it('doesn’t open an account by an address Google only checked once', async () => {
    const site = await boot()
    await site.person('linus@elsewhere.test', 'editor')
    const done = await signIn(site, 'linus')
    expect(done.session).toBeNull()
    expect(done.flash).toEqual({
      kind: 'error',
      message: 'An account here already uses linus@elsewhere.test. Sign in with its password.',
    })
  })

  it('lets that person in once they connected the account while signed in', async () => {
    const site = await boot()
    const linus = await site.person('linus@elsewhere.test', 'editor')
    expect((await site.connect(linus, 'linus')).outcome).toBe('connected')
    expect((await signIn(site, 'linus')).user).toEqual(linus.user)
    // An account connected under another address than the person's own signs nobody in.
    const eve = await site.person('eve@cms.test', 'editor')
    await site.connect(eve, 'grace')
    const grace = await signIn(site, 'grace')
    expect(grace.user).toMatchObject({ email: 'grace@example.com', role: 'google_user' })
    expect(grace.user!.id).not.toBe(eve.user.id)
    expect((await listAccounts(site.cms(), eve.user.id)).map((account) => account.email)).toEqual([
      'grace@example.com',
    ])
  })

  it('turns away an address Google hasn’t verified, and a cancelled consent', async () => {
    const site = await boot()
    const unverified = await signIn(site, 'unverified')
    expect(unverified.session).toBeNull()
    expect(unverified.flash!.message).toMatch(/Google hasn’t confirmed that email address/)
    const denied = await signIn(site, 'ada', { deny: true, screen: 'account' })
    expect(denied).toMatchObject({
      session: null,
      path: '/account',
      flash: { kind: 'error', message: 'You didn’t allow it at Google, so you aren’t signed in.' },
    })
  })

  it('makes no account when the site gives new people none, and gives the role it’s told to', async () => {
    const closed = await boot({ settings: { 'google.new_accounts': false } })
    const refused = await signIn(closed, 'ada')
    expect(refused.session).toBeNull()
    expect(refused.flash!.message).toBe('There’s no account for ada@gmail.com on this site.')
    // People who have an account still get in.
    const grace = await closed.person('grace@example.com', 'author')
    expect((await signIn(closed, 'grace')).user).toEqual(grace.user)

    const customers = await boot({ settings: { 'google.new_role': 'customer' } })
    const done = await signIn(customers, 'ada')
    expect(done.user!.role).toBe('customer')
    // No admin for a customer: their account page.
    expect(done.path).toBe('/account')
  })

  it('keeps to the domains it’s given', async () => {
    const site = await boot({ settings: { 'google.domains': 'example.com, Studio.Example' } })
    const start = await signIn(site, 'grace')
    expect(new URL(start.location).searchParams.get('hd')).toBeNull()
    expect(start.user).toMatchObject({ email: 'grace@example.com' })
    const outsider = await signIn(site, 'ada')
    expect(outsider.session).toBeNull()
    expect(outsider.flash!.message).toBe(
      'Only some organisations’ Google accounts can sign in here.',
    )
    // One domain is also a hint for Google's account chooser.
    const single = await boot({ settings: { 'google.domains': 'example.com' } })
    expect(new URL((await signIn(single, 'ada')).location).searchParams.get('hd')).toBe(
      'example.com',
    )
  })

  it('says little when Google refuses the code, and logs no secret', async () => {
    const site = await boot()
    const start = await site.get('/api/p/core/sign-in/google?screen=admin')
    const cookie = site.setCookie(start, 'cms_sign_in_with')
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!
    const response = await site.get(
      `/api/p/core/sign-in/google/callback?state=${state}&code=made-up`,
      cookie ?? '',
    )
    const back = new URL(response.headers.get('location')!, 'http://cms.test')
    expect(site.kernel.readFlash(back.searchParams.get('flash') ?? undefined)).toEqual({
      kind: 'error',
      message: 'Google couldn’t sign you in. Try again.',
    })
    expect(JSON.stringify(site.logger.entries)).not.toContain('test-client-secret')
  })
})
