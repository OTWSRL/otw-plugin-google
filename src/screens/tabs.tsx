import { Tabs } from '@otwdesign/admin-ui'
import type { PluginContext, User } from '@otwdesign/sdk'
import { MANAGE } from '../config'
import { servicesOf } from '../runtime'

/**
 * Google keeps one link in the admin menu, to Accounts; its services and settings are tabs across
 * the top of each Google screen. A service switched off has no tab, and a service another plugin
 * adds gets one when it has a screen.
 */
export function GoogleTabs({
  cms,
  user,
  current,
}: {
  cms: PluginContext
  user: User
  current: string
}) {
  const tabs = [
    { id: 'accounts', label: 'Accounts', href: cms.admin.url('/') },
    ...servicesOf(cms).flatMap(({ id, label, screen }) =>
      screen ? [{ id, label, href: screen }] : [],
    ),
    ...(cms.auth.can(user, MANAGE)
      ? [{ id: 'settings', label: 'Settings', href: cms.admin.url('/settings') }]
      : []),
  ]
  return (
    <Tabs
      label="Google"
      tabs={tabs.map(({ id, label, href }) => ({ label, href, current: id === current }))}
    />
  )
}
