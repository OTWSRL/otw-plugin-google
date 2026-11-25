import type { PluginContext } from '@otwdesign/sdk'
import { USE } from '../../config'

/**
 * YouTube's admin screens and form actions, when the service is switched on. Each screen and
 * action imports its code (`./screens`, `./actions`) when it's first opened.
 */
export function registerAdmin(cms: PluginContext): void {
  if (cms.settings.get('google.youtube') === false) return

  cms.admin.page({
    name: 'youtube',
    path: '/youtube',
    capability: USE,
    menu: { label: 'YouTube', order: 10 },
    load: async (context) => (await import('./screens')).loadVideos(cms, context),
    title: 'YouTube',
    titleAction: ({ data }) =>
      data.channel
        ? { label: 'Upload video', url: `${cms.admin.url('/youtube/upload')}${data.query}` }
        : null,
    component: async (props) => (await import('./screens')).VideosScreen({ cms, ...props }),
  })
  cms.admin.page({
    name: 'youtube-video',
    path: '/youtube/video/:id',
    capability: USE,
    load: async (context) => (await import('./screens')).loadVideo(cms, context),
    title: ({ data }) => (data.video ? `Edit “${data.video.title}”` : 'Edit video'),
    component: async (props) => (await import('./screens')).VideoScreen({ cms, ...props }),
  })
  cms.admin.page({
    name: 'youtube-upload',
    path: '/youtube/upload',
    capability: USE,
    load: async (context) => (await import('./screens')).loadUpload(cms, context),
    title: 'Upload video',
    component: async (props) => (await import('./screens')).UploadScreen({ cms, ...props }),
  })
  cms.admin.page({
    name: 'youtube-playlists',
    path: '/youtube/playlists',
    capability: USE,
    load: async (context) => (await import('./screens')).loadPlaylists(cms, context),
    title: 'Playlists',
    component: async (props) => (await import('./screens')).PlaylistsScreen({ cms, ...props }),
  })

  for (const name of [
    'youtube-save',
    'youtube-delete',
    'youtube-playlist-add',
    'youtube-playlist-create',
  ] as const) {
    cms.admin.action({
      name,
      capability: USE,
      handler: async (context) => (await import('./actions'))[name](cms, context),
    })
  }
}
