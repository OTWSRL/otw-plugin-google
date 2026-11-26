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
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><path d="M10 2a8 8 0 1 0 7.8 9.8V8.7H10v2.9h4.6A5 5 0 1 1 10 5c1.3 0 2.4.5 3.3 1.2l2.1-2.1A8 8 0 0 0 10 2Z"/></svg>',
) as AdminIcon

/** Google's own mark, as its sign-in button carries it. */
const GOOGLE_MARK = svg(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.2C12.4 13.7 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.6 24.6c0-1.6-.2-3.1-.4-4.6H24v9.1h12.7c-.6 3-2.2 5.5-4.7 7.2l7.7 6c4.5-4.1 6.9-10.2 6.9-17.7z"/><path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.2C1 16.5 0 20.1 0 24s1 7.5 2.6 10.8l7.9-6.2z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.7-6c-2.2 1.4-4.9 2.3-8.2 2.3-6.3 0-11.6-4.2-13.5-9.9l-7.9 6.2C6.5 42.6 14.6 48 24 48z"/></svg>',
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
