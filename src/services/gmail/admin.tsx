import type { AdminActionContext, AdminActionResult, PluginContext } from '@otwdesign/sdk'
import { USE } from '../../config'
import { withTabs } from '../../screens/tabbed'
// A type only: the module itself is imported when one of its actions is first posted to.
import type * as ActionsModule from './actions'

/** The changes to threads, each an action `gmail-{change}`: as `./actions` knows them. */
export const THREAD_ACTIONS = [
  'archive',
  'trash',
  'untrash',
  'spam',
  'not-spam',
  'read',
  'unread',
  'star',
  'unstar',
  'label-add',
  'label-remove',
] as const

type Handler = (cms: PluginContext, context: AdminActionContext) => Promise<AdminActionResult>
type Actions = typeof ActionsModule

/**
 * Gmail's admin screens and form actions, when the service is switched on. Each screen and
 * action imports its code (`./screens`, `./actions`) when it's first opened.
 */
export function registerAdmin(cms: PluginContext): void {
  if (cms.settings.get('google.gmail') === false) return

  cms.admin.page({
    name: 'gmail',
    path: '/gmail',
    capability: USE,
    load: async (context) => (await import('./screens')).loadMail(cms, context),
    title: 'Gmail',
    titleAction: ({ data }) =>
      data.found?.current
        ? {
            label: 'Compose',
            url: `${cms.admin.url('/gmail/compose')}?${new URLSearchParams({ account: data.found.current.id })}`,
          }
        : null,
    component: async (props) =>
      withTabs(
        cms,
        props.user,
        'gmail',
        import('./screens').then(({ MailScreen }) => <MailScreen cms={cms} {...props} />),
      ),
  })

  cms.admin.page({
    name: 'gmail-compose',
    path: '/gmail/compose',
    capability: USE,
    load: async (context) => (await import('./screens')).loadCompose(cms, context),
    title: ({ data }) => data.heading,
    component: async (props) =>
      withTabs(
        cms,
        props.user,
        'gmail',
        import('./screens').then(({ ComposeScreen }) => <ComposeScreen cms={cms} {...props} />),
      ),
  })

  for (const change of THREAD_ACTIONS) {
    cms.admin.action({
      name: `gmail-${change}`,
      capability: USE,
      handler: async (context) => (await import('./actions')).thread(cms, change, context),
    })
  }
  const actions: [string, (module: Actions) => Handler][] = [
    ['gmail-label-create', (module) => module.labelCreate],
    ['gmail-label-rename', (module) => module.labelRename],
    ['gmail-label-delete', (module) => module.labelDelete],
    ['gmail-send', (module) => module.send],
    ['gmail-draft-save', (module) => module.draftSave],
    ['gmail-draft-delete', (module) => module.draftDelete],
  ]
  for (const [name, pick] of actions) {
    cms.admin.action({
      name,
      capability: USE,
      handler: async (context) => pick(await import('./actions'))(cms, context),
    })
  }
}
