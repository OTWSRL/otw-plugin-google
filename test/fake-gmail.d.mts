// Types for fake-gmail.mjs, which is plain JavaScript so node can run it for the browser tests.
import type { FakeGoogle } from './fake-google.mjs'

export interface FakeMailMessage {
  id: string
  threadId: string
  internalDate: string
  labelIds: string[]
  headers: Record<string, string>
  text: string | null
  html: string | null
  htmlApart: boolean
  /** `claimedSize` is the size Gmail states, when a test wants it to differ from the bytes. */
  attachments: { filename: string; mimeType: string; data: Buffer; claimedSize?: number }[]
}

/** One person's mailbox on the stand-in. */
export interface FakeMailbox {
  nextId: number
  /** `true` answers the batch address with an error, `'garbled'` with nonsense. */
  batchBroken: boolean | 'garbled'
  labels: { id: string; name: string }[]
  sendAs: {
    sendAsEmail: string
    displayName: string
    isPrimary?: boolean
    verificationStatus?: string
  }[]
  messages: FakeMailMessage[]
  drafts: { id: string; messageId: string }[]
}

/** What a hostile sender puts in a message: the seeded "Security alert" (`m5`) carries it. */
export const HOSTILE_HTML: string

/** Adds Gmail to the stand-in: pass it in `routes`. Mailboxes are at `fake.data.gmail[who]`. */
export function fakeGmail(fake: FakeGoogle): void
