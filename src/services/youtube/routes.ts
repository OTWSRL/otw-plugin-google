import type { PluginContext } from '@otwdesign/sdk'

/**
 * YouTube's API routes. The main entry imports this file on every request, so it only names the
 * routes: each handler imports its code (`./api`) when it's first called.
 */
export function registerRoutes(cms: PluginContext): void {
  void cms
}
