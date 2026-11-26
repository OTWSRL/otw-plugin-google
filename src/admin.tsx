import { defineAdmin } from '@otwdesign/sdk'
import { MANAGE, USE } from './config'
import google from './index'
import { withTabs } from './screens/tabbed'
import { registerAdmin as driveAdmin } from './services/drive/admin'
import { registerAdmin as gmailAdmin } from './services/gmail/admin'
import { registerAdmin as youtubeAdmin } from './services/youtube/admin'

// The admin entry: the screens' names, addresses and who may open them. Each screen's code is
// imported when that screen is opened, so the admin's other screens carry none of it. Google has
// one link in the menu, to Accounts; the services are tabs across its screens (`screens/tabs`),
// and its settings are under Settings, as a WordPress plugin's are.

export default defineAdmin(google, (cms) => {
  cms.admin.page({
    name: 'accounts',
    path: '/',
    capability: USE,
    menu: { label: 'Accounts', order: 1 },
    load: async (context) => (await import('./screens/accounts')).loadAccounts(cms, context),
    title: 'Google accounts',
    titleAction: () => ({ label: 'Connect an account', url: cms.routes.apiUrl('/oauth/start') }),
    component: async (props) =>
      withTabs(
        cms,
        props.user,
        'accounts',
        import('./screens/accounts').then(({ AccountsScreen }) => (
          <AccountsScreen cms={cms} {...props} />
        )),
      ),
  })

  for (const name of ['disconnect', 'sends-mail'] as const) {
    cms.admin.action({
      name,
      capability: USE,
      handler: async (context) => (await import('./actions'))[name](cms, context),
    })
  }
  for (const name of ['site-mail', 'site-mail-off', 'test-mail'] as const) {
    cms.admin.action({
      name,
      capability: MANAGE,
      handler: async (context) => (await import('./actions'))[name](cms, context),
    })
  }

  youtubeAdmin(cms)
  driveAdmin(cms)
  gmailAdmin(cms)

  cms.admin.settingsPage({
    name: 'settings',
    path: '/settings',
    title: 'Google settings',
    capability: MANAGE,
    menu: { label: 'Google', parent: 'settings' },
  })
  cms.admin.settingsSection({
    name: 'client',
    page: 'google.settings',
    title: 'The Google client',
    description:
      'Make an OAuth client of the type “Web application” in the Google Cloud console, and add the two redirect addresses shown under Google › Accounts.',
    fields: ['google.client_id', 'google.client_secret', 'google.token_key'],
    link: { label: 'Accounts and setup', url: cms.admin.url('/') },
  })
  cms.admin.settingsSection({
    name: 'services',
    page: 'google.settings',
    title: 'What people can use',
    description:
      'A service you switch off loses its tab, and nobody is asked for its permission. Each asks Google only for what it needs, the first time someone opens it.',
    fields: ['google.roles', 'google.youtube', 'google.drive', 'google.gmail'],
  })
  cms.admin.settingsSection({
    name: 'sign-in',
    page: 'google.settings',
    title: 'Signing in with Google',
    fields: ['google.sign_in', 'google.new_accounts', 'google.new_role', 'google.domains'],
  })
  cms.admin.settingsSection({
    name: 'mail',
    page: 'google.settings',
    title: 'The site’s email',
    fields: ['google.site_mail'],
  })
})
