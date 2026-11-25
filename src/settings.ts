import type { SettingDefinitions } from '@otwdesign/sdk'
import { GOOGLE_USER_ROLE } from './config'

declare module '@otwdesign/sdk' {
  interface Settings {
    /** The OAuth client's id, from the Google Cloud console. */
    'google.client_id': string
    /** The OAuth client's secret, from `GOOGLE_CLIENT_SECRET` only. */
    'google.client_secret': string
    /** A key of its own for the stored tokens, from `GOOGLE_TOKEN_KEY` only; optional. */
    'google.token_key': string
    /** The roles that may connect Google accounts and use the services. */
    'google.roles': readonly string[]
    /** Whether YouTube is offered. */
    'google.youtube': boolean
    /** Whether Drive is offered. */
    'google.drive': boolean
    /** Whether Gmail is offered. */
    'google.gmail': boolean
    /** Whether the sign-in pages show "Continue with Google". */
    'google.sign_in': boolean
    /** Whether someone without an account gets one when they sign in with Google. */
    'google.new_accounts': boolean
    /** The role such a new account gets. */
    'google.new_role': string
    /** Domains whose Google accounts may sign in, separated by commas; empty for any. */
    'google.domains': string
    /** Whether the site's email goes out through a connected Gmail account. */
    'google.site_mail': boolean
  }
}

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** The domains of a comma-separated list, lowercase; `null` when one of them isn't a domain. */
export function domainsOf(value: string | undefined): string[] | null {
  const domains = (value ?? '')
    .split(',')
    .map((domain) => domain.trim().toLowerCase())
    .filter(Boolean)
  return domains.every((domain) => DOMAIN.test(domain)) ? domains : null
}

const SIGN_IN_ON = { setting: 'google.sign_in', is: true } as const

export const settings: SettingDefinitions = {
  'google.client_id': {
    type: 'text',
    label: 'Client ID',
    description:
      'From the Google Cloud console: APIs & Services › Credentials › your OAuth client.',
    env: 'GOOGLE_CLIENT_ID',
    maxLength: 200,
    validate: (value) =>
      value === '' || /^[\w.-]+$/.test(value) ? null : 'A client ID has no spaces',
  },
  'google.client_secret': {
    type: 'secret',
    label: 'Client secret',
    description: 'Read from the environment only. It is never stored in the database.',
    env: 'GOOGLE_CLIENT_SECRET',
  },
  'google.token_key': {
    type: 'secret',
    label: 'Token key',
    description:
      'Optional: a long random string that encrypts the stored tokens. Without it, the key is made from the client secret.',
    env: 'GOOGLE_TOKEN_KEY',
  },
  'google.roles': {
    type: 'roles',
    label: 'Who may connect',
    description: 'The roles that may connect Google accounts and use the services below.',
    default: ['administrator', 'editor', 'author', GOOGLE_USER_ROLE],
  },
  'google.youtube': { type: 'boolean', label: 'YouTube', default: true },
  'google.drive': { type: 'boolean', label: 'Drive', default: true },
  'google.gmail': { type: 'boolean', label: 'Gmail', default: true },
  'google.sign_in': {
    type: 'boolean',
    label: 'Show “Continue with Google” on the sign-in pages',
    default: true,
  },
  'google.new_accounts': {
    type: 'boolean',
    label: 'Someone new gets an account',
    description: 'Unticked, only people who already have an account here can sign in with Google.',
    default: true,
    showWhen: SIGN_IN_ON,
  },
  'google.new_role': {
    type: 'select',
    label: 'Role for a new account',
    description: 'A Google user may open the Google screens and their own profile, nothing else.',
    options: [
      { value: GOOGLE_USER_ROLE, label: 'Google user' },
      { value: 'customer', label: 'Customer (no admin access)' },
      { value: 'contributor', label: 'Contributor' },
      { value: 'author', label: 'Author' },
    ],
    default: GOOGLE_USER_ROLE,
    showWhen: [SIGN_IN_ON, { setting: 'google.new_accounts', is: true }],
  },
  'google.domains': {
    type: 'text',
    label: 'Only these domains',
    description: 'Such as example.com, studio.example. Empty lets any Google account sign in.',
    maxLength: 500,
    validate: (value) =>
      domainsOf(value) ? null : 'Write domains separated by commas, such as example.com',
    showWhen: SIGN_IN_ON,
  },
  'google.site_mail': {
    type: 'boolean',
    label: 'Send the site’s email through Gmail',
    description:
      'Password resets, receipts and notifications go out from the account chosen under Google › Accounts. Only one plugin sends the site’s email: leave this off while Mailer is active.',
    default: false,
  },
}
