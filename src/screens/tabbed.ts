import type { PluginContext, User } from '@otwdesign/sdk'
import type { ReactNode } from 'react'

/**
 * A Google screen with Google's tabs above it, for a `component` of `cms.admin.page()`. The tabs'
 * code is imported with the screen's, when it's first opened: only the admin entry imports this.
 */
export async function withTabs(
  cms: PluginContext,
  user: User,
  current: string,
  screen: Promise<ReactNode>,
): Promise<ReactNode> {
  const [{ createElement, Fragment }, { GoogleTabs }, body] = await Promise.all([
    import('react'),
    import('./tabs'),
    screen,
  ])
  return createElement(Fragment, null, createElement(GoogleTabs, { cms, user, current }), body)
}
