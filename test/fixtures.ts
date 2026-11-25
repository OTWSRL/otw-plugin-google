import type { PluginDefinition, User } from '@otwdesign/sdk'
import { createTestKernel, TEST_PASSWORD, type TestKernel } from '@otwdesign/testing'
import { sql } from 'drizzle-orm'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, vi } from 'vitest'
import googleAdmin from '../src/admin'
import google, { contextOf } from '../src/index'
import { CLIENT, startFakeGoogle, type FakeGoogle } from './fake-google.mjs'

export { CLIENT } from './fake-google.mjs'

export const YOUTUBE = 'https://www.googleapis.com/auth/youtube'
export const DRIVE = 'https://www.googleapis.com/auth/drive'
export const GMAIL = 'https://www.googleapis.com/auth/gmail.modify'
export const SEND = 'https://www.googleapis.com/auth/gmail.send'

let open: { harness: TestKernel; fake: FakeGoogle }[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await Promise.all(
    open.map(async ({ harness, fake }) => Promise.all([harness.close(), fake.close()])),
  )
  open = []
})

export interface BootOptions {
  settings?: Parameters<typeof createTestKernel>[0]['settings']
  plugins?: PluginDefinition[]
  /** The stand-in's extra APIs: the service files' routes. */
  routes?: ((fake: FakeGoogle) => void)[]
  /** Leave the client's id and secret out, as on a site that hasn't set Google up. */
  unconfigured?: boolean
}

export interface Person {
  user: User
  cookie: string
}

/** A site with the Google plugin, and a stand-in for Google that its requests go to. */
export async function bootGoogle(options: BootOptions = {}) {
  const fake = await startFakeGoogle({ routes: options.routes })
  vi.stubEnv('GOOGLE_API_URL', fake.url)
  const harness = await createTestKernel({
    plugins: [google, ...(options.plugins ?? [])],
    admin: [googleAdmin],
    settings: {
      'site.title': 'Shop',
      ...(options.unconfigured
        ? {}
        : { 'google.client_id': CLIENT.id, 'google.client_secret': CLIENT.secret }),
      ...options.settings,
    },
  })
  open.push({ harness, fake })

  const setCookie = (response: Response, name: string) =>
    response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0]!)
      .find((pair) => pair.startsWith(`${name}=`) && pair.length > name.length + 1) ?? null

  const flashOf = (response: Response) => {
    const url = new URL(response.headers.get('location') ?? '', 'http://cms.test')
    const flash = harness.kernel.readFlash(url.searchParams.get('flash') ?? undefined)
    url.searchParams.delete('flash')
    return { path: url.pathname + url.search, flash }
  }

  const get = (path: string, cookie = '') => harness.request('GET', path, cookie ? { cookie } : {})

  const extras = {
    fake,
    setCookie,
    get,
    /** A user with a password and a session. */
    async person(email: string, role = 'administrator'): Promise<Person> {
      const user = await harness.kernel.auth.createUser({ email, role, password: TEST_PASSWORD })
      return { user, cookie: `cms_session=${await harness.kernel.auth.createSession(user.id)}` }
    },
    /** Posts one of the plugin's admin forms as someone. */
    async act(cookie: string, name: string, form: Record<string, string> = {}) {
      const response = await harness.request('POST', `/api/p/google/actions/${name}`, {
        form,
        cookie,
      })
      return {
        status: response.status,
        location: response.headers.get('location'),
        ...flashOf(response),
      }
    },
    /**
     * Leaves for Google's consent screen as someone: where the browser is sent, and the cookie
     * it keeps meanwhile.
     */
    async leave(who: Person, query: Record<string, string> = {}) {
      const response = await get(
        `/api/p/google/oauth/start?${new URLSearchParams(query)}`,
        who.cookie,
      )
      return {
        response,
        location: response.headers.get('location') ?? '',
        cookie:
          setCookie(response, 'google_connect') ?? setCookie(response, '__Host-google_connect'),
      }
    },
    /** Comes back from Google's consent screen: the outcome word the accounts screen is given. */
    async back(who: Person | null, cookie: string | null, callbackUrl: string) {
      const url = new URL(callbackUrl)
      const response = await get(
        url.pathname + url.search,
        [who?.cookie, cookie].filter(Boolean).join('; '),
      )
      const location = new URL(response.headers.get('location') ?? '/', 'http://cms.test')
      return { response, path: location.pathname, outcome: location.searchParams.get('google') }
    },
    /** The whole trip: connects `google` (one of the stand-in's people) to `who`. */
    async connect(
      who: Person,
      googlePerson: string,
      options: { service?: string; account?: string; only?: string[]; deny?: boolean } = {},
    ) {
      const { service, account, ...consent } = options
      const left = await extras.leave(who, {
        ...(service ? { service } : {}),
        ...(account ? { account } : {}),
      })
      const callback = fake.authorize(left.location, googlePerson, consent)
      return extras.back(who, left.cookie, callback)
    },
    /** The plugin's own rows, as the database holds them. */
    async rows() {
      const result = (await harness.db.execute(
        sql`SELECT * FROM google_accounts ORDER BY created_at`,
      )) as unknown as { rows: Record<string, unknown>[] }
      return result.rows
    },
    /** One of the plugin's admin screens as someone, rendered. */
    async screen(path: string, user: User, searchParams: Record<string, string> = {}) {
      const resolution = await harness.kernel.resolveAdminPage(path, searchParams, user)
      if (resolution.kind !== 'page') return { kind: resolution.kind, html: '', title: '' }
      const element = (await resolution.Component(resolution.props)) as ReactElement
      return { kind: 'page' as const, html: renderToStaticMarkup(element), title: resolution.title }
    },
    service: () => harness.kernel.service('google'),
    /** The plugin's own `cms`, for calling its modules directly. */
    cms: () => contextOf(harness.kernel.service('google')),
  }
  return Object.assign(harness, extras)
}

export type GoogleSite = Awaited<ReturnType<typeof bootGoogle>>
