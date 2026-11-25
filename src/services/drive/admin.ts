import type { PluginContext } from '@otwdesign/sdk'
import { USE } from '../../config'

const ACTIONS = [
  'drive-new-folder',
  'drive-rename',
  'drive-trash',
  'drive-restore',
  'drive-to-media',
] as const

/**
 * Drive's admin screens and form actions, when the service is switched on. Each screen and
 * action imports its code (`./screens`, `./actions`) when it's first opened.
 */
export function registerAdmin(cms: PluginContext): void {
  if (cms.settings.get('google.drive') === false) return

  cms.admin.page({
    name: 'drive',
    path: '/drive',
    capability: USE,
    menu: { label: 'Drive', order: 20 },
    load: async (context) => (await import('./screens')).loadDrive(cms, context),
    title: 'Drive',
    titleAction: ({ data }) =>
      data.found.current && data.mode === 'folder'
        ? {
            label: 'Upload',
            url: `${cms.admin.url('/drive/upload')}?${new URLSearchParams({ account: data.found.current.id, folder: data.folder })}`,
          }
        : null,
    component: async (props) => {
      const { createElement } = await import('react')
      const { DriveScreen } = await import('./screens')
      return createElement(DriveScreen, { cms, ...props })
    },
  })

  cms.admin.page({
    name: 'drive-upload',
    path: '/drive/upload',
    capability: USE,
    load: async (context) => (await import('./upload-screen')).loadUpload(cms, context),
    title: 'Upload to Drive',
    component: async (props) => (await import('./upload-screen')).UploadScreen({ cms, ...props }),
  })

  for (const name of ACTIONS) {
    cms.admin.action({
      name,
      capability: USE,
      handler: async (context) => (await import('./actions'))[name](cms, context),
    })
  }
}
