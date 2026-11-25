import type { PluginContext } from '@otwdesign/sdk'

/**
 * Gmail's API routes. The main entry imports this file on every request, so it only names the
 * routes: each handler imports its code (`./api`) when it's first called.
 */
export function registerRoutes(cms: PluginContext): void {
  // A message's HTML, sanitised, for the sandboxed frame the thread screen shows it in.
  cms.routes.api({
    method: 'GET',
    path: '/gmail/html',
    handler: async (request, context) => (await import('./api')).messageHtml(cms, request, context),
  })
  // One attachment, as a download.
  cms.routes.api({
    method: 'GET',
    path: '/gmail/attachment',
    handler: async (request, context) => (await import('./api')).attachment(cms, request, context),
  })
}
