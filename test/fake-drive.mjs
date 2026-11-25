// Google Drive on the stand-in: folders and files per person, the list with Drive's search
// language as the plugin writes it, a file's bytes with ranges, and the changes the Drive screen
// makes. Add it with `startFakeGoogle({ routes: [fakeDrive] })`.
import { apiError, jsonAnswer } from './fake-google.mjs'

const SCOPE = ['https://www.googleapis.com/auth/drive']
const HOST = 'www.googleapis.com'
export const FOLDER = 'application/vnd.google-apps.folder'

/** A file's bytes: `size` of them, each the low byte of its position, so ranges can be checked. */
export const pattern = (size) =>
  Buffer.from(Array.from({ length: size }, (_, index) => index % 256))

function seedFor(person, extra = []) {
  const root = `root-${person}`
  const me = { displayName: 'me', emailAddress: `${person}@example.test` }
  const file = (id, name, mimeType, parent, more = {}) => ({
    id,
    name,
    mimeType,
    parents: parent ? [parent] : [],
    trashed: false,
    modifiedTime: '2026-11-20T10:00:00.000Z',
    ownedByMe: true,
    owners: [me],
    ...more,
  })
  const text = (value) => Buffer.from(value).toString('base64')
  const files = [
    file(root, 'My Drive', FOLDER, null),
    ...extra.map((build) => build(file, root, text)),
  ]
  return {
    root,
    quota: { usage: '10522669875', limit: '16106127360' },
    files: Object.fromEntries(files.flat().map((entry) => [entry.id, entry])),
  }
}

/** What Ada's Drive holds when the stand-in starts. */
const ada = (file, root, text) => [
  file('clients', 'Clients', FOLDER, root),
  file('acme', 'Acme', FOLDER, 'clients'),
  file('raw', 'Raw footage', FOLDER, 'acme', { modifiedTime: '2026-11-24T09:00:00.000Z' }),
  file('episode12', 'Episode 12, final cut.mp4', 'video/mp4', 'acme', {
    content: pattern(2000).toString('base64'),
    modifiedTime: '2026-11-25T09:00:00.000Z',
  }),
  file('plan', 'Launch plan', 'application/vnd.google-apps.document', 'acme', {
    webViewLink: 'https://docs.google.com/document/d/plan/edit',
  }),
  // A link that isn't Google's: what a file someone shared could carry.
  file('trap', 'Hours, November', 'application/vnd.google-apps.spreadsheet', 'acme', {
    webViewLink: 'javascript:alert(document.domain)',
  }),
  file('thumb', 'Thumbnail, episode 12.png', 'image/png', 'acme', {
    content: pattern(300).toString('base64'),
  }),
  file('contract', 'Contract, signed.pdf', 'application/pdf', 'acme', {
    content: text('%PDF-1.7 pretend'),
  }),
  file('notes', 'notes.txt', 'text/plain', 'acme', { content: text('Call Grace on Thursday.') }),
  file('page', 'page.html', 'text/html', 'acme', {
    content: text('<script>alert(document.domain)</script>'),
  }),
  file('logo', 'logo.svg', 'image/svg+xml', 'acme', {
    content: text('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'),
  }),
  file('shared', 'From Grace.txt', 'text/plain', 'acme', {
    ownedByMe: false,
    owners: [{ displayName: 'Grace Hopper', emailAddress: 'grace@example.com' }],
    content: text('Shared with Ada.'),
  }),
  file('quote', "it's a file.txt", 'text/plain', root, { content: text('A name with a quote.') }),
  // Larger than the plugin copies to the Media library, by what Drive says of it.
  file('huge', 'huge.bin', 'application/octet-stream', root, {
    size: '50000000',
    content: text('not really'),
  }),
  file('old', 'old.txt', 'text/plain', root, { trashed: true, content: text('In the trash.') }),
  file('many', 'Many', FOLDER, root),
  ...Array.from({ length: 60 }, (_, index) =>
    file(
      `many-${String(index + 1).padStart(2, '0')}`,
      `file ${String(index + 1).padStart(2, '0')}.txt`,
      'text/plain',
      'many',
      {
        content: text(`File ${index + 1}`),
      },
    ),
  ),
]

const grace = (file, root, text) => [
  file('grace-private', 'Grace only.txt', 'text/plain', root, { content: text('Not Ada’s.') }),
]

const bytesOf = (entry) => Buffer.from(entry.content ?? '', 'base64')

/** A file as Drive's API describes it: sizes are text, and folders have none. */
function shown(entry) {
  const { content, ...rest } = entry
  const size = entry.size ?? (content === undefined ? undefined : String(bytesOf(entry).length))
  return size === undefined ? rest : { ...rest, size }
}

/** The three searches the plugin writes; anything else is refused, as Drive refuses bad syntax. */
function matcher(q) {
  if (q === 'trashed = true') return (entry) => entry.trashed
  const inFolder = /^'([A-Za-z0-9_-]+)' in parents and trashed = false$/.exec(q)
  if (inFolder)
    return (entry, root) =>
      !entry.trashed && entry.parents.includes(inFolder[1] === 'root' ? root : inFolder[1])
  const named = /^name contains '((?:[^'\\]|\\.)*)' and trashed = false$/.exec(q)
  if (named) {
    const words = named[1].replace(/\\(.)/g, '$1').toLowerCase()
    return (entry) => !entry.trashed && entry.name.toLowerCase().includes(words)
  }
  return null
}

function range(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header ?? '')
  if (!match || (match[1] === '' && match[2] === '')) return null
  const start = match[1] === '' ? Math.max(size - Number(match[2]), 0) : Number(match[1])
  const end = match[1] === '' || match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  return start <= end && start < size ? { start, end } : null
}

export function fakeDrive(fake) {
  const seed = () => {
    fake.data.drive = { ada: seedFor('ada', [ada]), grace: seedFor('grace', [grace]) }
  }
  fake.seeds.push(seed)
  seed()

  const drive = (who) => (fake.data.drive[who] ??= seedFor(who))
  const find = (who, id) => {
    const mine = drive(who)
    return mine.files[id === 'root' ? mine.root : id] ?? null
  }
  const missing = (id) => apiError(404, 'notFound', `File not found: ${id}.`)

  fake.route('GET', HOST, '/drive/v3/files', SCOPE, ({ url, who }) => {
    const matches = matcher(url.searchParams.get('q') ?? '')
    if (!matches) return apiError(400, 'invalid', 'Invalid Value')
    const mine = drive(who)
    const all = Object.values(mine.files)
      .filter((entry) => entry.id !== mine.root && matches(entry, mine.root))
      .sort(
        (a, b) =>
          Number(b.mimeType === FOLDER) - Number(a.mimeType === FOLDER) ||
          a.name.localeCompare(b.name),
      )
    const size = Number(url.searchParams.get('pageSize') ?? 100)
    const start = Number((url.searchParams.get('pageToken') ?? 'page:0').replace('page:', ''))
    if (!Number.isInteger(start) || start < 0) return apiError(400, 'invalid', 'Invalid page token')
    const page = all.slice(start, start + size)
    return jsonAnswer(200, {
      files: page.map(shown),
      ...(start + size < all.length ? { nextPageToken: `page:${start + size}` } : {}),
    })
  })

  fake.route('GET', HOST, '/drive/v3/files/:id', SCOPE, ({ url, who, params, headers }) => {
    const entry = find(who, params.id)
    if (!entry) return missing(params.id)
    if (url.searchParams.get('alt') !== 'media') return jsonAnswer(200, shown(entry))
    if (entry.content === undefined)
      return apiError(
        403,
        'fileNotDownloadable',
        'Only files with binary content can be downloaded.',
      )
    const bytes = bytesOf(entry)
    const part = range(headers.range, bytes.length)
    const body = part ? bytes.subarray(part.start, part.end + 1) : bytes
    return {
      status: part ? 206 : 200,
      headers: {
        // A header can't carry what a file may call itself; the JSON description still does.
        'content-type': entry.mimeType.replace(/[^\x20-\x7e]/g, ''),
        'content-length': String(body.length),
        ...(part ? { 'content-range': `bytes ${part.start}-${part.end}/${bytes.length}` } : {}),
      },
      body,
    }
  })

  fake.route('POST', HOST, '/drive/v3/files', SCOPE, ({ body, who, person }) => {
    const asked = JSON.parse(body.toString('utf8'))
    const mine = drive(who)
    const parent = find(who, asked.parents?.[0] ?? 'root')
    if (!parent || parent.mimeType !== FOLDER) return missing(asked.parents?.[0])
    const id = `new-${Object.keys(mine.files).length}`
    mine.files[id] = {
      id,
      name: asked.name,
      mimeType: asked.mimeType,
      parents: [parent.id],
      trashed: false,
      modifiedTime: new Date().toISOString(),
      ownedByMe: true,
      owners: [{ displayName: person.name, emailAddress: person.email }],
    }
    return jsonAnswer(200, shown(mine.files[id]))
  })

  fake.route('PATCH', HOST, '/drive/v3/files/:id', SCOPE, ({ body, who, params }) => {
    const entry = find(who, params.id)
    if (!entry) return missing(params.id)
    if (!entry.ownedByMe) {
      return apiError(
        403,
        'insufficientFilePermissions',
        'The user does not have sufficient permissions for this file.',
      )
    }
    const changes = JSON.parse(body.toString('utf8'))
    if (typeof changes.name === 'string') entry.name = changes.name
    if (typeof changes.trashed === 'boolean') entry.trashed = changes.trashed
    return jsonAnswer(200, shown(entry))
  })

  fake.route('GET', HOST, '/drive/v3/about', SCOPE, ({ who }) =>
    jsonAnswer(200, { storageQuota: drive(who).quota }),
  )

  // Opening an upload: Drive answers with the address that takes the file's bytes.
  const uploads = new Map()
  fake.data.driveUploads = uploads
  fake.seeds.push(() => {
    uploads.clear()
    fake.data.driveUploads = uploads
  })
  fake.route(
    'POST',
    HOST,
    '/upload/drive/v3/files',
    SCOPE,
    ({ who, person, body, headers, url }) => {
      if (url.searchParams.get('uploadType') !== 'resumable') return apiError(400, 'badRequest')
      const asked = JSON.parse(body.toString('utf8'))
      const parent = find(who, asked.parents?.[0] ?? 'root')
      if (!parent || parent.mimeType !== FOLDER) return missing(asked.parents?.[0])
      const id = `drive-upload-${uploads.size + 1}`
      uploads.set(id, {
        who,
        owner: { displayName: person.name, emailAddress: person.email },
        name: asked.name,
        parent: parent.id,
        size: Number(headers['x-upload-content-length']),
        type: headers['x-upload-content-type'],
        origin: headers.origin ?? null,
        chunks: [],
        received: 0,
      })
      return {
        status: 200,
        headers: {
          location: `${fake.url}/${HOST}/upload/drive/v3/files?uploadType=resumable&upload_id=${id}`,
        },
        body: '',
      }
    },
  )

  // The file's bytes, in pieces, from a browser that holds the address and no token.
  fake.route('PUT', HOST, '/upload/drive/v3/files', false, ({ url, headers, body }) => {
    const upload = uploads.get(url.searchParams.get('upload_id'))
    const cors = {
      'access-control-allow-origin': upload?.origin ?? '*',
      'access-control-expose-headers': 'Range',
    }
    if (!upload) return { ...apiError(404, 'notFound'), headers: cors }
    const range = /^bytes (?:(\d+)-(\d+)|\*)\/(\d+)$/.exec(headers['content-range'] ?? '')
    if (range?.[1] !== undefined && Number(range[1]) === upload.received) {
      upload.chunks.push(body)
      upload.received += body.length
    }
    if (upload.received < upload.size) {
      return {
        status: 308,
        headers: {
          ...cors,
          ...(upload.received > 0 ? { range: `bytes=0-${upload.received - 1}` } : {}),
        },
        body: '',
      }
    }
    const mine = drive(upload.who)
    const id = `uploaded-${Object.keys(mine.files).length}`
    mine.files[id] = {
      id,
      name: upload.name,
      mimeType: upload.type,
      parents: [upload.parent],
      trashed: false,
      modifiedTime: new Date().toISOString(),
      ownedByMe: true,
      owners: [upload.owner],
      content: Buffer.concat(upload.chunks).toString('base64'),
    }
    return {
      status: 200,
      headers: { ...cors, 'content-type': 'application/json' },
      body: JSON.stringify({ id, name: upload.name }),
    }
  })

  fake.route('OPTIONS', HOST, '/upload/drive/v3/files', false, ({ headers }) => ({
    status: 204,
    headers: {
      'access-control-allow-origin': headers.origin ?? '*',
      'access-control-allow-methods': 'PUT, OPTIONS',
      'access-control-allow-headers': 'content-range, content-type',
      'access-control-expose-headers': 'Range',
    },
    body: '',
  }))
}
