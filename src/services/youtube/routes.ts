import type { PluginContext } from '@otwdesign/sdk'

/**
 * YouTube's API routes. The main entry imports this file on every request, so it only names the
 * routes: each handler imports its code (`./api`) when it's first called.
 */
export function registerRoutes(cms: PluginContext): void {
  // Opens an upload at YouTube for a file the browser then sends there itself.
  cms.routes.api({
    method: 'POST',
    path: '/youtube/uploads',
    handler: async (request, context) =>
      (await import('./api')).openUploadRoute(cms, request, context),
  })
  // The browser's word that the upload finished: adds the video to a playlist, and says where to go.
  cms.routes.api({
    method: 'POST',
    path: '/youtube/uploads/done',
    handler: async (request, context) =>
      (await import('./api')).uploadDoneRoute(cms, request, context),
  })
}
