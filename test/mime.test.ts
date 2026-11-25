import { describe, expect, it } from 'vitest'
import { buildMime, formatAddress, rawMime, splitAddress } from '../src/mime'

const headersOf = (mime: string) => mime.slice(0, mime.indexOf('\r\n\r\n')).split('\r\n')
const decode = (part: string) => Buffer.from(part.replace(/\s/g, ''), 'base64').toString('utf8')

describe('an address', () => {
  it('splits into a name and an address', () => {
    expect(splitAddress('Ada Admin <ada@example.com>')).toEqual({
      name: 'Ada Admin',
      address: 'ada@example.com',
    })
    expect(splitAddress('"Admin, Ada" <ada@example.com>')).toEqual({
      name: 'Admin, Ada',
      address: 'ada@example.com',
    })
    expect(splitAddress('ada@example.com')).toEqual({ name: '', address: 'ada@example.com' })
  })

  it('is written with its name quoted, or encoded when it isn’t ASCII', () => {
    expect(formatAddress('ada@example.com')).toBe('ada@example.com')
    expect(formatAddress('Ada "the" Admin <ada@example.com>')).toBe(
      '"Ada \\"the\\" Admin" <ada@example.com>',
    )
    expect(formatAddress('Zoë <zoe@example.com>')).toBe(
      `=?UTF-8?B?${Buffer.from('Zoë').toString('base64')}?= <zoe@example.com>`,
    )
  })

  it('can’t carry a second address or a header in its own', () => {
    // A name with an address of its own in brackets would show one and send to another.
    expect(formatAddress('Grace <grace@example.com> <spy@evil.test>')).toBe(
      '"Grace grace@example.com" <spy@evil.test>',
    )
    expect(formatAddress('<> <a@example.com>')).toBe('a@example.com')
    expect(formatAddress('a@example.com>, <evil@example.com')).not.toContain(',')
    expect(formatAddress('Ada <a@example.com>\r\nBcc: evil@example.com')).not.toMatch(/[\r\n]/)
    expect(formatAddress('a@example.com\r\nBcc: evil@example.com')).toBe(
      'a@example.comBcc:evil@example.com',
    )
  })
})

describe('a message', () => {
  const base = {
    from: 'Shop <shop@example.com>',
    to: ['ada@example.com'],
    subject: 'Hello',
    text: 'Hi Ada.',
  }

  it('is plain text in base64, with the headers Gmail needs', () => {
    const mime = buildMime(base)
    expect(headersOf(mime)).toEqual([
      'From: "Shop" <shop@example.com>',
      'To: ada@example.com',
      'Subject: Hello',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
    ])
    expect(decode(mime.slice(mime.indexOf('\r\n\r\n')))).toBe('Hi Ada.')
    expect(Buffer.from(rawMime(base), 'base64url').toString()).toBe(mime)
  })

  it('keeps every header on one line, whatever a subject or an address holds', () => {
    const mime = buildMime({
      ...base,
      subject: 'Hello\r\nBcc: evil@example.com',
      replyTo: 'r@example.com\nX-Injected: 1',
      inReplyTo: '<id@mail>\r\nX-Other: 1',
    })
    const headers = headersOf(mime)
    expect(headers.filter((line) => /^(Bcc|X-Injected|X-Other):/i.test(line))).toEqual([])
    expect(headers).toContain('Subject: Hello Bcc: evil@example.com')
  })

  it('encodes a subject beyond ASCII in words of at most 75 characters', () => {
    const subject = 'Résumé – '.repeat(12)
    const lines = headersOf(buildMime({ ...base, subject })).filter((line) =>
      /^(Subject:| =\?)/.test(line),
    )
    expect(lines.length).toBeGreaterThan(1)
    for (const line of lines)
      expect(line.replace(/^Subject: | /, '').length).toBeLessThanOrEqual(75)
    const words = lines.join('').match(/=\?UTF-8\?B\?([^?]+)\?=/g)!
    expect(words.map((word) => decode(word.slice(10, -2))).join('')).toBe(subject.trim())
  })

  it('carries HTML beside the text, copies, a reply’s thread, and attachments', () => {
    const mime = buildMime({
      ...base,
      cc: ['Grace <grace@example.com>'],
      bcc: ['hidden@example.com'],
      html: '<p>Hi <b>Ada</b>.</p>',
      inReplyTo: '<a@mail>',
      references: '<z@mail> <a@mail>',
      attachments: [
        {
          filename: 'brief "final".pdf',
          type: 'application/pdf',
          content: new TextEncoder().encode('%PDF'),
        },
        { filename: 'été.txt', type: 'not a type', content: new Uint8Array([1, 2, 3]) },
      ],
    })
    expect(mime).toContain('Cc: "Grace" <grace@example.com>')
    expect(mime).toContain('Bcc: hidden@example.com')
    expect(mime).toContain('In-Reply-To: <a@mail>')
    expect(mime).toContain('References: <z@mail> <a@mail>')
    expect(mime).toMatch(/Content-Type: multipart\/mixed; boundary="=_[\w-]+"/)
    expect(mime).toMatch(/Content-Type: multipart\/alternative; boundary="=_[\w-]+"/)
    expect(mime).toContain('Content-Type: text/html; charset=UTF-8')
    expect(mime).toContain('Content-Disposition: attachment; filename="brief _final_.pdf"')
    expect(mime).toContain(`filename="_t_.txt"; filename*=UTF-8''${encodeURIComponent('été.txt')}`)
    // A type that isn't one is sent as bytes.
    expect(mime).toContain('Content-Type: application/octet-stream; name="_t_.txt"')
    expect(mime.endsWith('--\r\n')).toBe(true)
  })
})
