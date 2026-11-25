import type { PluginContext } from '@otwdesign/sdk'

/**
 * Drive's API routes. The main entry imports this file on every request, so it only names the
 * routes: each handler imports its code (`./api`) when it's first called.
 */
export function registerRoutes(cms: PluginContext): void {
  // Registered whether or not Drive is switched on: a route that is off answers 404 from `./api`,
  // where the service is looked up.
  cms.routes.api({
    method: 'GET',
    path: '/drive/files/:id/download',
    handler: async (request, context) => (await import('./api')).download(cms, request, context),
  })
  cms.routes.api({
    method: 'GET',
    path: '/drive/files/:id/preview',
    handler: async (request, context) => (await import('./api')).preview(cms, request, context),
  })
  // Opens an upload at Drive for a file the browser then sends there itself, and its ending.
  cms.routes.api({
    method: 'POST',
    path: '/drive/uploads',
    handler: async (request, context) =>
      (await import('./upload')).openRoute(cms, request, context),
  })
  cms.routes.api({
    method: 'POST',
    path: '/drive/uploads/done',
    handler: async (request, context) =>
      (await import('./upload')).doneRoute(cms, request, context),
  })
}
