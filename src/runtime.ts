import type { PluginContext } from '@otwdesign/sdk'
import { SEND_SCOPE, type GoogleService } from './config'
import type { GoogleClient } from './google'
import { createSealer, type Sealer } from './secrets'

// What the plugin's parts share once one of them runs: the client's id and secret, the keys,
// and the services that are switched on. Loaded with the first Google request, not with the site.

/** The OAuth client, or `null` until both its id and its secret are set. */
export function clientOf(cms: PluginContext): GoogleClient | null {
  const id = cms.settings.get('google.client_id')
  const secret = cms.settings.get('google.client_secret')
  return id && secret ? { id, secret } : null
}

/** The client, for code that can't go on without one. */
export function requireClient(cms: PluginContext): GoogleClient {
  const client = clientOf(cms)
  if (!client) throw new Error('Google isn’t set up: the client ID or secret is missing')
  return client
}

const sealers = new WeakMap<PluginContext, Sealer>()

/** The keys for tokens and signatures: from `GOOGLE_TOKEN_KEY`, else from the client secret. */
export function sealerOf(cms: PluginContext): Sealer {
  let sealer = sealers.get(cms)
  if (!sealer) {
    sealer = createSealer(cms.settings.get('google.token_key') || requireClient(cms).secret)
    sealers.set(cms, sealer)
  }
  return sealer
}

/** The site's public address: Settings › General's, else the one this request arrived on. */
export function siteOrigin(cms: PluginContext, request: Request): string {
  const configured = cms.settings.get('site.url')
  return new URL(configured || request.url).origin
}

/** Whether the site's address is https, so cookies can take the `__Host-` prefix. */
export const isSecure = (origin: string): boolean => origin.startsWith('https://')

/** The services that are switched on, in the order plugins added them. */
export function servicesOf(cms: PluginContext): GoogleService[] {
  return cms.registries
    .get('google.services')
    .list()
    .filter((service) => service.enabled())
}

/**
 * The pretend service behind "Use for the site's email": the one permission sending needs, for
 * an account whose owner hasn't allowed all of Gmail.
 */
export const MAIL_SERVICE: GoogleService = {
  id: 'mail',
  label: 'Sending email',
  asks: 'send email on your behalf',
  scopes: [SEND_SCOPE],
  enabled: () => true,
}

/** A service by id, the sending-only one included; `null` for one that's off or unknown. */
export function serviceOf(cms: PluginContext, id: string): GoogleService | null {
  if (id === MAIL_SERVICE.id) return MAIL_SERVICE
  return servicesOf(cms).find((service) => service.id === id) ?? null
}

/** A path on this site, or `null`: where someone goes back to is never another site. */
export function sitePath(value: string | null | undefined): string | null {
  if (!value || value.length > 2000 || !value.startsWith('/') || value.startsWith('//')) return null
  if (value.includes('\\')) return null
  try {
    const url = new URL(value, 'http://local')
    return url.origin === 'http://local' ? url.pathname + url.search : null
  } catch {
    return null
  }
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
