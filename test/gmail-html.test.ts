import { describe, expect, it } from 'vitest'
import { sanitizeHtml } from '../src/services/gmail/html'
import { HOSTILE_HTML } from './fake-gmail.mjs'

const clean = (html: string, images = false) => sanitizeHtml(html, { images }).html

/** Nothing that runs, loads or posts may be left, whatever went in. */
function expectInert(html: string) {
  expect(html).not.toMatch(
    /<\s*(script|style|iframe|object|embed|form|input|button|svg|math|base|meta|link|frame)/i,
  )
  expect(html).not.toMatch(/\son[a-z]+\s*=/i)
  expect(html).not.toMatch(
    /(href|src|action|formaction|xlink:href)\s*=\s*"?\s*(javascript|data:text|vbscript)/i,
  )
  expect(html).not.toMatch(/url\s*\(/i)
  expect(html).not.toMatch(/expression\s*\(/i)
}

describe('the sanitiser', () => {
  it('keeps the text and the plain formatting of an honest message', () => {
    const html = clean(
      '<div dir="ltr"><p style="color: #333; font-size: 14px">Hi <b>Ada</b>,</p><ul><li>One</li></ul>' +
        '<table width="100%" cellpadding="4"><tr><td align="center" bgcolor="#eeeeee">Cell</td></tr></table>' +
        '<a href="https://example.com/a?x=1&amp;y=2" title="Go">link</a><br></div>',
    )
    expect(html).toBe(
      '<div dir="ltr"><p style="color: #333; font-size: 14px">Hi <b>Ada</b>,</p><ul><li>One</li></ul>' +
        '<table width="100%" cellpadding="4"><tr><td align="center" bgcolor="#eeeeee">Cell</td></tr></table>' +
        '<a href="https://example.com/a?x=1&amp;y=2" target="_blank" rel="noopener noreferrer" title="Go">link</a><br></div>',
    )
  })

  it('leaves nothing of a hostile message that runs, loads or posts', () => {
    const html = clean(HOSTILE_HTML)
    expectInert(html)
    expect(html).toContain('Security alert')
    expect(html).toContain('Review activity')
    // The honest link survives, pointed at a new tab that knows nothing of this one.
    expect(html).toContain(
      '<a href="https://example.com/account?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">',
    )
    expect(html).not.toContain('steal')
    expect(html).not.toContain('evil.test')
    expect(html).toContain('<p style="color: red">Act now</p>')
  })

  it('drops scripts however they are spelled, with what is inside them', () => {
    for (const hostile of [
      '<script>alert(1)</script>',
      '<SCRIPT SRC=//evil.test/x.js></SCRIPT>',
      '<scr<script>ipt>alert(1)</scr</script>ipt>',
      '<script\n>alert(1)</script\n>',
      '<script>alert(1)',
      '<svg><script>alert(1)</script></svg>',
      '<svg/onload=alert(1)>',
      '<math><mtext><script>alert(1)</script></mtext></math>',
      '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>',
      '<template><script>alert(1)</script></template>',
      '<object data="javascript:alert(1)"></object><embed src="javascript:alert(1)">',
      '<style>@import url(https://evil.test/x.css);</style>',
      '<style>p{background:url(javascript:alert(1))}</style>',
      '<xmp><script>alert(1)</script></xmp>',
      '<title><script>alert(1)</script></title>',
      '<textarea><script>alert(1)</script></textarea>',
      '<!--><script>alert(1)</script>-->',
      '<![CDATA[<script>alert(1)</script>]]>',
      '<plaintext><script>alert(1)</script>',
    ]) {
      const html = clean(hostile)
      expect({ hostile, html }).toEqual({ hostile, html: expect.not.stringMatching(/<\s*script/i) })
      expectInert(html)
      expect(html).not.toMatch(/<[a-z][^>]*alert\(1\)/i)
    }
  })

  it('writes no event handler and no attribute it doesn’t know, however it is spelled', () => {
    for (const hostile of [
      '<img src="https://example.com/a.png" onerror="alert(1)">',
      '<p onclick=alert(1)>x</p>',
      '<p ONMOUSEOVER="alert(1)">x</p>',
      '<p\tonclick\n=\n"alert(1)">x</p>',
      '<p/onclick=alert(1)>x</p>',
      '<p id=x class=y name=z data-x=1 contenteditable autofocus onfocus=alert(1)>x</p>',
      '<a href="https://example.com" onclick="alert(1)" ping="https://evil.test">x</a>',
      '<p style="x" style="color:red" onclick="alert(1)">x</p>',
      '<p title="a" title="b" on<click="alert(1)">x</p>',
      '<div style="width:expression(alert(1))">x</div>',
      '<img src=x onerror=alert(1)//',
    ]) {
      const html = clean(hostile, true)
      expectInert(html)
      expect(html).not.toMatch(/\s(id|class|name|ping|contenteditable|autofocus|data-x)=/)
    }
  })

  it('follows a link only to the web or to mail, read the way a browser reads it', () => {
    const href = (value: string) =>
      /href="([^"]*)"/.exec(clean(`<a href="${value}">x</a>`))?.[1] ?? null
    for (const hostile of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'java&#x0A;script:alert(1)',
      'jav&#x61;script:alert(1)',
      'javascript&colon;alert(1)',
      '&#106;avascript:alert(1)',
      '&#0000106avascript:alert(1)',
      '\u0001javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      '//evil.test/x',
      '/relative/path',
      'relative',
      '#fragment',
      'blob:https://evil.test/1',
    ]) {
      expect({ hostile, href: href(hostile) }).toEqual({ hostile, href: null })
    }
    expect(href('https://example.com/a b')).toBe('https://example.com/a%20b')
    expect(href('HTTP://Example.com')).toBe('http://example.com/')
    expect(href('mailto:ada@example.com')).toBe('mailto:ada@example.com')
    // Unquoted and single-quoted attributes are read too.
    expect(clean('<a href=javascript:alert(1)>x</a>')).toBe('<a>x</a>')
    expect(clean("<a href='javascript:alert(1)'>x</a>")).toBe('<a>x</a>')
    expect(clean('<a href=https://example.com/>x</a>')).toContain('href="https://example.com/"')
  })

  it('writes every value escaped, so nothing in one can end its attribute or start a tag', () => {
    expect(
      clean(
        '<a href="https://example.com/?q=&quot;&gt;&lt;script&gt;" title="&quot;><script>">x</a>',
      ),
    ).toBe(
      '<a href="https://example.com/?q=%22%3E%3Cscript%3E" target="_blank" rel="noopener noreferrer" title="&quot;&gt;&lt;script&gt;">x</a>',
    )
    expect(
      clean('<img alt="x&quot; onerror=&quot;alert(1)" src="https://example.com/a.png">', true),
    ).toBe('<img src="https://example.com/a.png" alt="x&quot; onerror=&quot;alert(1)">')
    // Text that looks like markup stays text.
    expect(clean('1 < 2 > 1 &lt;script&gt; <3')).toBe('1 &lt; 2 &gt; 1 &lt;script&gt; &lt;3')
    expect(clean('<p>a</p><')).toBe('<p>a</p>&lt;')
  })

  it('shows no picture from the web until asked, and only pictures then', () => {
    const message =
      '<img src="https://cdn.example.com/a.png" alt="A chart" width="200">' +
      '<img src="http://cdn.example.com/b.png">' +
      '<img src="cid:part1@mail">' +
      '<img src="data:image/png;base64,iVBORw0KGgo=" alt="inline">' +
      '<img src="data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+">' +
      '<img src="data:text/html;base64,PHNjcmlwdD4=">' +
      '<img src="javascript:alert(1)">'
    const off = sanitizeHtml(message, { images: false })
    expect(off.blockedImages).toBe(1)
    expect(off.html).toBe(
      '<span>[A chart]</span><img src="data:image/png;base64,iVBORw0KGgo=" alt="inline">',
    )
    const on = sanitizeHtml(message, { images: true })
    expect(on.blockedImages).toBe(0)
    expect(on.html).toBe(
      '<img src="https://cdn.example.com/a.png" alt="A chart" width="200">' +
        '<img src="data:image/png;base64,iVBORw0KGgo=" alt="inline">',
    )
  })

  it('keeps only styles that lay text out and colour it', () => {
    const style = (value: string) =>
      /style="([^"]*)"/.exec(clean(`<p style="${value}">x</p>`))?.[1] ?? null
    expect(
      style('color: red; font-weight: bold; margin-top: 4px; border-left: 1px solid #ccc'),
    ).toBe('color: red; font-weight: bold; margin-top: 4px; border-left: 1px solid #ccc')
    expect(style('color: rgb(10, 20, 30)')).toBe('color: rgb(10, 20, 30)')
    for (const hostile of [
      'background: url(https://evil.test/x.png)',
      'background-image: url(x)',
      'background: URL (x)',
      'width: expression(alert(1))',
      'color: var(--x)',
      'position: fixed; top: 0',
      'behavior: url(x.htc)',
      '-moz-binding: url(x)',
      'color: red\\9',
      'color: /* x */ red',
      'font-family: x; } body { color: red',
      '@import "x"',
      'display: flex',
      'content: attr(title)',
      'color: r\\65 d',
      'background: &#117;rl(x)',
    ]) {
      const kept = style(hostile)
      expect({ hostile, kept }).toEqual({
        hostile,
        kept:
          kept === null
            ? null
            : expect.not.stringMatching(
                /url|expression|var\(|position|behavior|binding|@|\\|\/\*|flex|attr/i,
              ),
      })
    }
    expect(style('position: fixed')).toBeNull()
  })

  it('keeps a layout attribute only in the shape it has, and treats what follows <plaintext> as text', () => {
    expect(
      clean(
        '<td width="100%;position:fixed" height="12" align="x&quot; onclick=&quot;y" bgcolor="url(x)" ' +
          'color="#fff" colspan="2" dir="sideways" lang="en-GB" size="+2" face="Arial, sans-serif">x</td>',
      ),
    ).toBe(
      '<td lang="en-GB" height="12" colspan="2" color="#fff" face="Arial, sans-serif" size="+2">x</td>',
    )
    expect(clean('a<plaintext><b>x</b>')).toBe('a&lt;b&gt;x&lt;/b&gt;')
  })

  it('reads a long hostile message in good time', () => {
    for (const piece of [
      '<',
      '<!',
      '</',
      '<style>',
      '<svg>',
      '<a href="',
      '<p style="color:red;',
      '&#',
      '<x ',
    ]) {
      const started = performance.now()
      clean(piece.repeat(100_000))
      expect({ piece, ms: performance.now() - started }).toEqual({ piece, ms: expect.any(Number) })
      expect(performance.now() - started).toBeLessThan(1500)
    }
  })
})
