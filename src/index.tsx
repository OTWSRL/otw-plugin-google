import { definePlugin, type AdminIcon, type PluginContext } from '@otwdesign/sdk'
import { sql } from 'drizzle-orm'
import type { GoogleAccount } from './accounts'
import { GOOGLE_USER_ROLE, MANAGE, PROVIDER, signInOn, USE, type GoogleService } from './config'
import type { ApiRequest } from './google'
import { migrations, TABLES } from './migrations'
import { registerRoutes as driveRoutes } from './services/drive/routes'
import { registerRoutes as gmailRoutes } from './services/gmail/routes'
import { registerRoutes as youtubeRoutes } from './services/youtube/routes'
import { settings } from './settings'

// The main entry. Every site with the plugin loads this file on every kind of request, so it
// only says what exists: settings, roles, addresses. The code behind each is imported the first
// time someone uses it, and a site where nobody opens a Google screen never loads it.

export type { GoogleAccount } from './accounts'
export type { GoogleService } from './config'
export type { ApiRequest } from './google'

/** What other plugins ask of the Google plugin, with `cms.services.get('google')`. */
export interface GoogleApi {
  /** The Google accounts a person connected, without their tokens. */
  accounts(userId: string): Promise<GoogleAccount[]>
  /**
   * One request to a Google API as one of a person's accounts: the token is added, renewed when
   * it has run out, and never handed over. An account that isn't `userId`'s is refused.
   */
  fetch(userId: string, accountId: string, url: string, request?: ApiRequest): Promise<Response>
}

declare module '@otwdesign/sdk' {
  interface Services {
    /** Google accounts and requests to Google's APIs, from the Google plugin. */
    google: GoogleApi
  }
}

const contexts = new WeakMap<GoogleApi, PluginContext>()

/** The plugin's own `cms` on this site, by its service: for the plugin's tests. */
export function contextOf(service: GoogleApi): PluginContext {
  const cms = contexts.get(service)
  if (!cms) throw new Error('Google has not set up')
  return cms
}

const svg = (markup: string) => `data:image/svg+xml;base64,${btoa(markup)}`

/** The menu's mark: a "G", drawn in the menu's own colour. */
const ICON = svg(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M10 2a8 8 0 1 0 7.8 9.8V8.7H10v2.900h4.600A5 5 0 1 1 10 5c1.300 0 2.400.5 3.300 1.200l2.100-2.100A8 8 0 0 0 10 2Z"/></svg>',
) as AdminIcon

/** Google's own mark, as its sign-in button carries it. */
const GOOGLE_MARK = svg(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.500c3.500 0 6.600 1.200 9.100 3.600l6.800-6.800C35.800 2.400 30.300 0 24 0 14.600 0 6.500 5.400 2.600 13.200l7.900 6.200C12.400 13.700 17.700 9.500 24 9.500z"/><path fill="#4285F4" d="M46.600 24.600c0-1.600-.2-3.100-.4-4.600H24v9.100h12.700c-.6 3-2.200 5.500-4.700 7.200l7.700 6c4.500-4.100 6.900-10.200 6.900-17.700z"/><path fill="#FBBC05" d="M10.500 28.600c-.5-1.400-.8-3-.8-4.600s.3-3.200.8-4.600l-7.900-6.200C1 16.500 0 20.100 0 24s1 7.500 2.600 10.800l7.900-6.200z"/><path fill="#34A853" d="M24 48c6.500 0 11.900-2.100 15.900-5.800l-7.700-6c-2.200 1.400-4.900 2.300-8.200 2.300-6.300 0-11.600-4.200-13.500-9.900l-7.900 6.200C6.500 42.600 14.600 48 24 48z"/></svg>',
)

export default definePlugin({
  id: 'google',
  version: '1.0.0',
  name: 'Google',
  description:
    'Sign in with Google, and each person’s own YouTube, Drive and Gmail in the admin. The site’s email can go out through Gmail.',
  icon: ICON,
  requires: { core: '^1.10.0' },
  optional: { mailer: '*' },
  migrations,
  settings,

  setup(cms) {
    cms.auth.role(GOOGLE_USER_ROLE, { label: 'Google user', capabilities: ['core.access_admin'] })
    cms.auth.capability(USE, {
      label: 'Connect Google accounts and use them',
      roles: cms.settings.get('google.roles') ?? [],
    })
    cms.auth.capability(MANAGE, { label: 'Manage Google and its settings' })

    // Google's services: each a small description here, its code in a folder of its own. The
    // next one (Calendar, Contacts, …) is one more entry, from this plugin or another.
    const services = cms.registries.define('google.services')
    const builtIn: [
      string,
      string,
      string,
      string,
      'google.youtube' | 'google.drive' | 'google.gmail',
    ][] = [
      [
        'youtube',
        'YouTube',
        'manage your YouTube account',
        'https://www.googleapis.com/auth/youtube',
        'google.youtube',
      ],
      [
        'drive',
        'Drive',
        'see, edit, create and delete your Google Drive files',
        'https://www.googleapis.com/auth/drive',
        'google.drive',
      ],
      [
        'gmail',
        'Gmail',
        'read, compose and send your email',
        'https://www.googleapis.com/auth/gmail.modify',
        'google.gmail',
      ],
    ]
    for (const [id, label, asks, scope, setting] of builtIn) {
      const service: GoogleService = {
        id,
        label,
        asks,
        scopes: [scope],
        enabled: () => cms.settings.get(setting) !== false,
      }
      services.add(service)
    }

    const api: GoogleApi = {
      accounts: async (userId) => (await import('./accounts')).listAccounts(cms, userId),
      fetch: async (userId, accountId, url, request) =>
        (await import('./accounts')).googleFetch(cms, userId, accountId, url, request),
    }
    contexts.set(api, cms)
    cms.services.provide('google', api)

    // "Continue with Google", once the client is set up and unless it's switched off.
    if (signInOn(cms)) {
      cms.auth.signInProvider({
        id: PROVIDER,
        label: 'Continue with Google',
        name: 'Google',
        image: GOOGLE_MARK,
        start: async (request) => (await import('./sign-in')).startSignIn(cms, request),
        finish: async (request) => (await import('./sign-in')).finishSignIn(cms, request),
        newAccountRole: () =>
          cms.settings.get('google.new_accounts') === false
            ? null
            : (cms.settings.get('google.new_role') ?? GOOGLE_USER_ROLE),
      })
    }

    // Connecting an account leaves for Google and comes back by these two addresses.
    cms.routes.api({
      method: 'GET',
      path: '/oauth/start',
      handler: async (request, context) =>
        (await import('./oauth')).startConnect(cms, request, context),
    })
    cms.routes.api({
      method: 'GET',
      path: '/oauth/callback',
      handler: async (request, context) =>
        (await import('./oauth')).finishConnect(cms, request, context),
    })

    // The upload screens' script: the plugin's only browser code, fetched by those screens alone.
    cms.routes.api({
      method: 'GET',
      path: '/upload.js',
      handler: async () =>
        new Response((await import('./upload-script')).UPLOAD_SCRIPT, {
          headers: {
            'content-type': 'text/javascript; charset=utf-8',
            'x-content-type-options': 'nosniff',
            'cache-control': 'public, max-age=3600',
          },
        }),
    })

    // Each service's own addresses, for what a form post can't do: an upload, a download.
    youtubeRoutes(cms)
    driveRoutes(cms)
    gmailRoutes(cms)

    // A video from Drive to YouTube, on the server, for "Send to YouTube": queued by a form,
    // run in pieces. Defining it costs nothing until one is queued.
    cms.jobs.define('google.youtube_from_drive', {
      label: 'Copy a video from Drive to YouTube',
      attempts: 4,
      timeoutSeconds: 180,
      handler: async (args) => (await import('./services/youtube/copy')).runCopy(cms, args),
    })

    // The site's email through Gmail. One plugin sends the site's email: Mailer does when it's
    // active, whatever this setting says.
    if (cms.settings.get('google.site_mail') === true && !cms.isActive('mailer')) {
      cms.mail.transport({
        send: async (message) => (await import('./mail')).sendSiteMail(cms, message),
      })
    }
  },

  async uninstall({ db }) {
    for (const table of TABLES) await db.execute(sql.raw(`DROP TABLE IF EXISTS ${table}`))
  },
})
