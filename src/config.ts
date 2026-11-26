import type { PluginContext } from '@otwdesign/sdk'

// What the main entry needs to know by name. Kept small: the site loads this file whether or
// not anyone uses Google today, and nothing here reaches for Google's code.

/** Connect Google accounts and use the services. */
export const USE = 'google.use'
/** The plugin's settings, and seeing that other people's accounts exist. */
export const MANAGE = 'google.manage'
/** The role a person gets who arrives by signing in with Google, when the site gives one. */
export const GOOGLE_USER_ROLE = 'google_user'
/** The sign-in provider's id: it's in the address Google calls back. */
export const PROVIDER = 'google'

/** Whether "Continue with Google" is offered: switched on, and the client is set up. */
export const signInOn = (cms: PluginContext): boolean =>
  cms.settings.get('google.sign_in') !== false &&
  Boolean(cms.settings.get('google.client_id') && cms.settings.get('google.client_secret'))

/** What signing in asks Google for. Google neither caps nor expires these. */
export const IDENTITY_SCOPES = ['openid', 'email', 'profile'] as const

/** Sending only: what the site's email needs when Gmail itself is switched off. */
export const SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send'

/**
 * One of Google's services as the plugin offers it. Add an entry to the `google.services`
 * registry and the accounts screen offers its permission, asks Google for its scopes the first
 * time it's needed, and hands its code a token.
 */
export interface GoogleService {
  /** Lowercase: `youtube`. It's in addresses. */
  id: string
  /** "YouTube". */
  label: string
  /** What it asks Google for, in the plain words of Google's consent screen. */
  asks: string
  /** Google's scopes for it, the narrowest that do the job. */
  scopes: readonly string[]
  /** Whether it's switched on, read each time: Settings › Google can switch a service off. */
  enabled(): boolean
  /** Its screen's address, for its tab across Google's screens. Without one, it has no tab. */
  screen?: string
}

/** What the job that copies a video from Drive to YouTube is given, and carries between its runs. */
export interface YouTubeCopy {
  userId: string
  accountId: string
  /** The Drive file. */
  fileId: string
  changes: {
    title: string
    description: string
    tags: string[]
    categoryId: string
    privacy: 'private' | 'unlisted' | 'public'
    publishAt: string | null
    madeForKids: boolean
  }
  playlist: string | null
  bytes: number
  type: string
  /** YouTube's address for the upload, encrypted, once a run has opened it. */
  session?: string
  /** How many bytes YouTube has confirmed. */
  offset?: number
  /** For tests: a smaller piece, and a shorter run. */
  piece?: number
  budgetMs?: number
}

declare module '@otwdesign/sdk' {
  interface Jobs {
    /** Copies a video from a person's Drive to their YouTube channel, a piece at a time. */
    'google.youtube_from_drive': YouTubeCopy
  }
  interface Registries {
    /** Google's services, for the accounts screen and for asking for their permission. */
    'google.services': GoogleService
  }
  interface Capabilities {
    /** Connect Google accounts and use YouTube, Drive and Gmail with them. */
    'google.use': true
    /** Change the Google settings, and see and disconnect everyone's accounts. */
    'google.manage': true
  }
}
