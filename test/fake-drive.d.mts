// Types for fake-drive.mjs, which is plain JavaScript so node can run it for the browser tests.
import type { FakeGoogle } from './fake-google.mjs'

/** A file as the stand-in keeps it: Drive's fields, and its bytes as base64 in `content`. */
export interface FakeDriveFile {
  id: string
  name: string
  mimeType: string
  parents: string[]
  trashed: boolean
  modifiedTime: string
  ownedByMe: boolean
  owners: { displayName: string; emailAddress: string }[]
  webViewLink?: string
  size?: string
  content?: string
}

/** One person's Drive on the stand-in, under `fake.data.drive[who]`. */
export interface FakeDrive {
  root: string
  quota: { usage: string; limit?: string }
  files: Record<string, FakeDriveFile>
}

export const FOLDER: string
/** `size` bytes, each the low byte of its position. */
export function pattern(size: number): Buffer
/** Adds Drive's API to the stand-in and fills Ada's and Grace's Drives. */
export function fakeDrive(fake: FakeGoogle): void
