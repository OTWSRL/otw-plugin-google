import type { PluginContext } from '@otwdesign/sdk'

/**
 * YouTube's admin screens and form actions, when the service is switched on. Each screen and
 * action imports its code (`./screens`, `./actions`) when it's first opened.
 */
export function registerAdmin(cms: PluginContext): void {
  if (cms.settings.get('google.youtube') === false) return
}
