// An email's HTML, made safe to show. Nothing of the message's own markup is passed through:
// it's read tag by tag, and only tags and attributes on the lists below are written out again,
// with every value escaped. What isn't on a list doesn't exist in the result, so a new trick in
// a tag nobody thought of has nowhere to go. The frame's sandbox and its Content-Security-Policy
// stand behind this, should it still miss something.

/** Tags written out again. Everything else is dropped; its text stays unless it's listed below. */
const ALLOWED = new Set([
  'a',
  'abbr',
  'b',
  'blockquote',
  'br',
  'caption',
  'center',
  'cite',
  'code',
  'col',
  'colgroup',
  'dd',
  'del',
  'div',
  'dl',
  'dt',
  'em',
  'font',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'ins',
  'li',
  'ol',
  'p',
  'pre',
  'q',
  's',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
])
const VOID = new Set(['br', 'col', 'hr', 'img'])

/** Tags whose content is text to the browser, never markup: skipped to their own closing tag. */
const RAW_TEXT = new Set([
  'script',
  'style',
  'title',
  'textarea',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
])
/** Tags dropped with everything inside them, however it nests. */
const DROPPED_WHOLE = new Set([
  'svg',
  'math',
  'template',
  'object',
  'embed',
  'applet',
  'select',
  'audio',
  'video',
  'canvas',
  'frameset',
])

const MAX_ATTRIBUTE_LENGTH = 2000
const MAX_DATA_IMAGE_LENGTH = 512 * 1024
const MAX_STYLE_VALUE_LENGTH = 200

const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  colon: ':',
  tab: '\t',
  newline: '\n',
  sol: '/',
  lpar: '(',
  rpar: ')',
  period: '.',
  comma: ',',
  semi: ';',
  num: '#',
  excl: '!',
  quest: '?',
  equals: '=',
  percnt: '%',
  lowbar: '_',
  commat: '@',
  bsol: '\\',
}

/**
 * An attribute's value as the browser would read it: character references turned into the
 * characters they stand for, with or without their `;`. The checks below judge this text, and
 * this text is what's written out, escaped, so the browser reads exactly what was judged.
 */
function decodeReferences(value: string): string {
  return value
    .replace(/&(?:#x([0-9a-f]{1,6})|#(\d{1,7})|([a-z]{2,8}));?/gi, (whole, hex, decimal, name) => {
      if (name) return NAMED[String(name).toLowerCase()] ?? whole
      const code = hex ? parseInt(String(hex), 16) : Number(decimal)
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : ''
    })
    .replace(/\0/g, '')
}

const escapeText = (value: string): string => value.replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttribute = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** A link's address, when it's one a person may follow from a message: the web, or mail. */
function linkAddress(value: string): string | null {
  let url: URL
  try {
    // The same parser browsers use: it drops the tabs, line breaks and leading control
    // characters that hide a scheme from a simpler reading. An address with no scheme has no
    // site to belong to here, and throws.
    url = new URL(value)
  } catch {
    return null
  }
  return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:'
    ? url.href
    : null
}

const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/

/** An image's address: a small picture carried in the message itself, or one on the web. */
function imageAddress(value: string): { kind: 'data' | 'remote'; src: string } | null {
  const compact = value.replace(/\s+/g, '')
  if (/^data:/i.test(compact)) {
    return compact.length <= MAX_DATA_IMAGE_LENGTH && DATA_IMAGE.test(compact)
      ? { kind: 'data', src: compact }
      : null
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  return url.protocol === 'https:' ? { kind: 'remote', src: url.href } : null
}

const STYLE_PROPERTIES = new Set([
  'background',
  'background-color',
  'border-collapse',
  'border-spacing',
  'clear',
  'color',
  'direction',
  'display',
  'float',
  'font',
  'font-family',
  'font-size',
  'font-style',
  'font-variant',
  'font-weight',
  'height',
  'letter-spacing',
  'line-height',
  'list-style-type',
  'max-height',
  'max-width',
  'min-height',
  'min-width',
  'table-layout',
  'text-align',
  'text-decoration',
  'text-indent',
  'text-transform',
  'vertical-align',
  'white-space',
  'width',
  'word-break',
])
const STYLE_PREFIXES = ['margin', 'padding', 'border']
/** What a style's value may be made of: no backslash, no `@`, no `:`, no comment. */
const STYLE_VALUE = /^[a-z0-9 #%.,()+\-'"!/]*$/i
/** The only functions a value may call: colours. Never `url()`, `expression()` or `var()`. */
const STYLE_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla'])
const DISPLAYS = new Set([
  'block',
  'inline',
  'inline-block',
  'none',
  'table',
  'table-row',
  'table-cell',
  'list-item',
])

/** An inline style with only the declarations that lay text out and colour it. */
function cleanStyle(value: string): string {
  const kept: string[] = []
  for (const declaration of value.split(';')) {
    const colon = declaration.indexOf(':')
    if (colon < 1) continue
    const property = declaration.slice(0, colon).trim().toLowerCase()
    const setting = declaration.slice(colon + 1).trim()
    if (
      !STYLE_PROPERTIES.has(property) &&
      !STYLE_PREFIXES.some((prefix) => property === prefix || property.startsWith(`${prefix}-`))
    ) {
      continue
    }
    if (!/^[a-z-]+$/.test(property)) continue
    if (!setting || setting.length > MAX_STYLE_VALUE_LENGTH || !STYLE_VALUE.test(setting)) continue
    const functions = [...setting.matchAll(/([a-z-]*)\(/gi)].map((match) => match[1]!.toLowerCase())
    if (!functions.every((name) => STYLE_FUNCTIONS.has(name))) continue
    if (property === 'display' && !DISPLAYS.has(setting.toLowerCase())) continue
    kept.push(`${property}: ${setting}`)
  }
  return kept.join('; ')
}

/** Attributes any allowed tag may carry, each with the shape its value must have. */
const PLAIN_ATTRIBUTES: Record<string, RegExp> = {
  align: /^(?:left|right|center|justify)$/i,
  valign: /^(?:top|middle|bottom|baseline)$/i,
  dir: /^(?:ltr|rtl|auto)$/i,
  lang: /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/i,
  width: /^\d{1,4}%?$/,
  height: /^\d{1,4}%?$/,
  border: /^\d{1,2}$/,
  cellpadding: /^\d{1,3}$/,
  cellspacing: /^\d{1,3}$/,
  colspan: /^\d{1,3}$/,
  rowspan: /^\d{1,3}$/,
  bgcolor: /^(?:#[0-9a-f]{3,8}|[a-z]{3,20})$/i,
  color: /^(?:#[0-9a-f]{3,8}|[a-z]{3,20})$/i,
  face: /^[a-z0-9 ,'-]{1,100}$/i,
  size: /^[+-]?\d$/,
}

interface Options {
  /** Whether pictures on the web are shown. Off, a sender doesn't learn the message was opened. */
  images: boolean
}

export interface SafeHtml {
  /** Markup for inside a `<body>`: only what the lists above allow. */
  html: string
  /** Pictures on the web that were left out, for offering to show them. */
  blockedImages: number
}

type Attributes = Map<string, string>

/** Reads a start tag's attributes from `index`, just past its name, to its `>`. */
function readAttributes(input: string, index: number): { attributes: Attributes; end: number } {
  const attributes: Attributes = new Map()
  const length = input.length
  let i = index
  for (;;) {
    while (i < length && /[\s/]/.test(input[i]!)) i++
    if (i >= length || input[i] === '>') return { attributes, end: Math.min(i + 1, length) }
    const start = i
    // A name ends at white space, `/`, `>` or `=`; a `=` standing first is part of the name.
    if (input[i] === '=') i++
    while (i < length && !/[\s/>=]/.test(input[i]!)) i++
    const name = input.slice(start, i).toLowerCase()
    while (i < length && /\s/.test(input[i]!)) i++
    let value = ''
    if (input[i] === '=') {
      i++
      while (i < length && /\s/.test(input[i]!)) i++
      const quote = input[i]
      if (quote === '"' || quote === "'") {
        const close = input.indexOf(quote, i + 1)
        value = input.slice(i + 1, close < 0 ? length : close)
        i = close < 0 ? length : close + 1
      } else {
        const from = i
        while (i < length && !/[\s>]/.test(input[i]!)) i++
        value = input.slice(from, i)
      }
    }
    // The first of a repeated attribute is the one a browser keeps.
    if (name && !attributes.has(name)) attributes.set(name, value)
  }
}

/** A start tag as it's written out: its allowed attributes, their values checked and escaped. */
function startTag(
  name: string,
  attributes: Attributes,
  options: Options,
  count: { blocked: number },
): string {
  const out: string[] = []
  const put = (attribute: string, value: string) =>
    out.push(` ${attribute}="${escapeAttribute(value)}"`)
  const read = (attribute: string): string | null => {
    const raw = attributes.get(attribute)
    if (raw === undefined || raw.length > MAX_ATTRIBUTE_LENGTH + MAX_DATA_IMAGE_LENGTH) return null
    return decodeReferences(raw)
  }

  if (name === 'img') {
    const address = imageAddress(read('src') ?? '')
    const alt = (read('alt') ?? '').slice(0, 300)
    if (!address || (address.kind === 'remote' && !options.images)) {
      if (address) count.blocked++
      // What the picture was of, in words, where the sender gave them.
      return alt.trim() ? `<span>[${escapeText(alt.replace(/&/g, '&amp;'))}]</span>` : ''
    }
    put('src', address.src)
    put('alt', alt)
  }
  if (name === 'a') {
    const address = linkAddress(read('href') ?? '')
    if (address) {
      put('href', address)
      // A new tab that knows nothing of this one, and tells the site nothing of where it came from.
      put('target', '_blank')
      put('rel', 'noopener noreferrer')
    }
  }
  for (const [attribute, shape] of Object.entries(PLAIN_ATTRIBUTES)) {
    const value = read(attribute)?.trim()
    if (value && value.length <= 100 && shape.test(value)) put(attribute, value)
  }
  const title = read('title')
  if (title) put('title', title.slice(0, 300))
  const style = cleanStyle((read('style') ?? '').slice(0, MAX_ATTRIBUTE_LENGTH))
  if (style) put('style', style)
  return `<${name}${out.join('')}>`
}

/**
 * Where the content dropped with a tag ends. Raw-text tags end at their own closing tag,
 * whatever lies between; the others end when as many of them have closed as opened.
 */
function endOfDropped(input: string, lower: string, name: string, from: number): number {
  if (RAW_TEXT.has(name)) {
    const close = lower.indexOf(`</${name}`, from)
    if (close < 0) return input.length
    const end = input.indexOf('>', close)
    return end < 0 ? input.length : end + 1
  }
  let depth = 1
  let i = from
  for (;;) {
    const next = lower.indexOf('<', i)
    if (next < 0) return input.length
    const closing = lower[next + 1] === '/'
    const at = next + (closing ? 2 : 1)
    if (lower.startsWith(name, at) && !/[a-z0-9]/.test(lower[at + name.length] ?? '')) {
      depth += closing ? -1 : 1
      const end = input.indexOf('>', at)
      if (end < 0) return input.length
      if (depth === 0) return end + 1
      i = end + 1
    } else {
      i = next + 1
    }
  }
}

/** An email's HTML with only the tags, attributes and addresses that are safe to show. */
export function sanitizeHtml(input: string, options: Options): SafeHtml {
  // Lower-cased once, for finding closing tags whatever their case: a message with a thousand
  // style blocks costs one copy, not a thousand.
  const lower = input.toLowerCase()
  const out: string[] = []
  const count = { blocked: 0 }
  const length = input.length
  let i = 0
  while (i < length) {
    const open = input.indexOf('<', i)
    if (open < 0) {
      out.push(escapeText(input.slice(i)))
      break
    }
    if (open > i) out.push(escapeText(input.slice(i, open)))
    const next = input[open + 1] ?? ''
    if (input.startsWith('<!--', open)) {
      const close = input.indexOf('-->', open + 4)
      i = close < 0 ? length : close + 3
    } else if (next === '!' || next === '?') {
      const close = input.indexOf('>', open)
      i = close < 0 ? length : close + 1
    } else if (next === '/') {
      const name = /^[a-z][a-z0-9]*/i.exec(input.slice(open + 2, open + 34))?.[0].toLowerCase()
      const close = input.indexOf('>', open)
      i = close < 0 ? length : close + 1
      if (name && ALLOWED.has(name) && !VOID.has(name)) out.push(`</${name}>`)
    } else if (/[a-z]/i.test(next)) {
      const name = /^[a-z][a-z0-9:-]*/i.exec(input.slice(open + 1, open + 65))![0].toLowerCase()
      const { attributes, end } = readAttributes(input, open + 1 + name.length)
      if (name === 'plaintext') {
        // To a browser, everything after it is text.
        out.push(escapeText(input.slice(end)))
        break
      }
      if (DROPPED_WHOLE.has(name) && input[end - 2] === '/') {
        // `<svg/>` closes itself: there is nothing inside it to drop.
        i = end
      } else if (RAW_TEXT.has(name) || DROPPED_WHOLE.has(name)) {
        i = endOfDropped(input, lower, name, end)
      } else {
        if (ALLOWED.has(name)) out.push(startTag(name, attributes, options, count))
        i = end
      }
    } else {
      // A `<` that starts no tag is a character of the text.
      out.push('&lt;')
      i = open + 1
    }
  }
  return { html: out.join(''), blockedImages: count.blocked }
}

/** Plain text for a page: the characters that would start markup, written as text. */
export const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
