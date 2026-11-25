import type { FakeGoogle } from './fake-google.mjs'

export interface FakeVideo {
  id: string
  snippet: {
    title: string
    description: string
    tags: string[]
    categoryId: string
    channelId: string
  }
  status: {
    privacyStatus: string
    publishAt?: string
    selfDeclaredMadeForKids: boolean
    uploadStatus: string
  }
}

/** What the stand-in keeps for YouTube, under `fake.data.youtube`. */
export interface FakeYouTubeData {
  /** When set, opening an upload answers with this address instead of the stand-in's own. */
  location?: string
  videos: Map<string, FakeVideo>
  playlists: Map<
    string,
    { id: string; who: string; title: string; privacy: string; items: string[] }
  >
  uploads: Map<
    string,
    {
      who: string
      metadata: { snippet: { title: string }; status: Record<string, unknown> }
      size: number
      type: string
      origin: string | null
      received: number
    }
  >
}

export function fakeYouTube(fake: FakeGoogle): void
