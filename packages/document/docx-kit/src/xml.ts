/**
 * Minimal XML reader and writer for OOXML parts. The supported subset is the
 * one Word writes: elements, quoted attributes, character data, comments, CDATA
 * sections, processing instructions, and the DOCTYPE declaration.
 *
 * The escaper is ported from `domains/doctmpl/renderer_docx.go` (`docxXMLEscape`)
 * of the Go project Mady; the reader side has no upstream counterpart because
 * the Go reader unmarshalled through `encoding/xml`.
 */

import { assertNever } from './types.ts'

/** Whether one character counts as XML whitespace for attribute scanning. */
const XML_SPACE = /\s/u

/** Characters that end an attribute name inside a start tag. */
const XML_NAME_END = /[\s=/>]/u

/** One entity reference, named or numeric. */
const ENTITY_REFERENCE = /&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/gu

/** Decimal character reference. */
const DECIMAL_ENTITY = /^&#(\d+);$/u

/** Hexadecimal character reference. */
const HEX_ENTITY = /^&#x([0-9a-fA-F]+);$/u

/** Highest Unicode code point a numeric reference may name. */
const MAX_CODE_POINT = 0x10ffff

/** Opening delimiter of a CDATA section. */
const CDATA_OPEN = '<![CDATA['

/**
 * Escaped form of one character of XML text.
 * @param character - one character.
 * @returns the entity reference for the five predefined entities, otherwise the character.
 */
function escapedCharacter(character: string): string {
  switch (character) {
    case '&':
      return '&amp;'
    case '<':
      return '&lt;'
    case '>':
      return '&gt;'
    case '"':
      return '&quot;'
    case "'":
      return '&apos;'
    default:
      return character
  }
}

/**
 * Escape XML text and quoted attribute values.
 * @param value - raw text.
 * @returns the text with the five predefined entities escaped.
 */
export function escapeXmlText(value: string): string {
  let escaped = ''
  for (const character of value) escaped += escapedCharacter(character)
  return escaped
}

/**
 * Resolve one numeric character reference.
 * @param entity - the reference, opening `&` through closing `;`.
 * @returns the referenced character, or the reference unchanged when it names no code point.
 */
function decodeNumericEntity(entity: string): string {
  const hex = HEX_ENTITY.exec(entity)
  const decimal = hex === null ? DECIMAL_ENTITY.exec(entity) : null
  const digits = hex === null ? decimal?.[1] : hex[1]
  if (digits === undefined) return entity
  const codePoint = Number.parseInt(digits, hex === null ? 10 : 16)
  return codePoint <= MAX_CODE_POINT ? String.fromCodePoint(codePoint) : entity
}

/**
 * Resolve one entity reference.
 * @param entity - the reference, opening `&` through closing `;`.
 * @returns the referenced character, or the reference unchanged when it is unknown.
 */
function decodeXmlEntity(entity: string): string {
  switch (entity) {
    case '&amp;':
      return '&'
    case '&lt;':
      return '<'
    case '&gt;':
      return '>'
    case '&quot;':
      return '"'
    case '&apos;':
      return "'"
    default:
      return decodeNumericEntity(entity)
  }
}

/**
 * Resolve the entity references of XML text and quoted attribute values.
 * @param value - text carrying entity references.
 * @returns the text with named and numeric references resolved; unknown references survive verbatim.
 */
export function decodeXmlText(value: string): string {
  return value.replace(ENTITY_REFERENCE, decodeXmlEntity)
}

/** An opening tag. */
interface XmlStartTag {
  /** Element name, namespace prefix included. */
  readonly kind: 'start'
  readonly name: string
  /** Quoted attributes; an unquoted or unterminated value ends attribute parsing for the tag. */
  readonly attributes: ReadonlyMap<string, string>
  /** Whether the tag closed itself with `/>`. */
  readonly selfClosing: boolean
}

/** A closing tag. */
interface XmlEndTag {
  /** Element name, namespace prefix included. */
  readonly kind: 'end'
  readonly name: string
}

/** Character data between tags, with entity references already resolved. */
interface XmlTextNode {
  readonly kind: 'text'
  /** Decoded character data. */
  readonly value: string
}

/** One lexical token of an XML document. */
export type XmlToken = XmlStartTag | XmlEndTag | XmlTextNode

/** One scanned document. */
interface XmlScan {
  /** Tokens in document order. */
  readonly tokens: readonly XmlToken[]
  /** Whether the whole source parsed and every element it opened was closed. */
  readonly wellFormed: boolean
}

/**
 * Append decoded character data, dropping empty runs.
 * @param tokens - token list under construction.
 * @param raw - raw character data.
 */
function pushTextNode(tokens: XmlToken[], raw: string): void {
  if (raw === '') return
  tokens.push({ kind: 'text', value: decodeXmlText(raw) })
}

/**
 * Read the quoted attributes of one start tag.
 * @param body - the tag between its angle brackets, without a trailing `/`.
 * @returns the attributes; an unquoted or unterminated value ends the scan.
 */
function parseAttributes(body: string): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>()
  let cursor = 0
  while (cursor < body.length) {
    while (cursor < body.length && XML_SPACE.test(body.charAt(cursor))) cursor += 1
    const nameStart = cursor
    while (cursor < body.length && !XML_NAME_END.test(body.charAt(cursor))) cursor += 1
    if (cursor === nameStart) {
      cursor += 1
      continue
    }
    const name = body.slice(nameStart, cursor)
    while (cursor < body.length && XML_SPACE.test(body.charAt(cursor))) cursor += 1
    if (body.charAt(cursor) !== '=') continue
    cursor += 1
    while (cursor < body.length && XML_SPACE.test(body.charAt(cursor))) cursor += 1
    const quote = body.charAt(cursor)
    if (quote !== '"' && quote !== "'") break
    const end = body.indexOf(quote, cursor + 1)
    if (end < 0) break
    attributes.set(name, decodeXmlText(body.slice(cursor + 1, end)))
    cursor = end + 1
  }
  return attributes
}

/**
 * Scan XML source into tokens.
 * @param source - the XML text.
 * @returns the tokens read before any malformed markup, and whether the whole source is well formed.
 */
export function scanXml(source: string): XmlScan {
  const tokens: XmlToken[] = []
  const open: string[] = []
  let wellFormed = true
  let cursor = 0
  while (cursor < source.length) {
    const tag = source.indexOf('<', cursor)
    if (tag < 0) {
      pushTextNode(tokens, source.slice(cursor))
      break
    }
    pushTextNode(tokens, source.slice(cursor, tag))
    if (source.startsWith('<!--', tag)) {
      const end = source.indexOf('-->', tag + 4)
      if (end < 0) {
        wellFormed = false
        break
      }
      cursor = end + 3
      continue
    }
    if (source.startsWith(CDATA_OPEN, tag)) {
      const end = source.indexOf(']]>', tag + CDATA_OPEN.length)
      if (end < 0) {
        wellFormed = false
        break
      }
      tokens.push({ kind: 'text', value: source.slice(tag + CDATA_OPEN.length, end) })
      cursor = end + 3
      continue
    }
    if (source.startsWith('<?', tag)) {
      const end = source.indexOf('?>', tag + 2)
      if (end < 0) {
        wellFormed = false
        break
      }
      cursor = end + 2
      continue
    }
    if (source.startsWith('<!', tag)) {
      const end = source.indexOf('>', tag + 2)
      if (end < 0) {
        wellFormed = false
        break
      }
      cursor = end + 1
      continue
    }
    const close = source.indexOf('>', tag + 1)
    if (close < 0) {
      wellFormed = false
      break
    }
    const body = source.slice(tag + 1, close)
    if (body.startsWith('/')) {
      const name = body.slice(1).trim()
      if (open.pop() !== name) {
        wellFormed = false
        break
      }
      tokens.push({ kind: 'end', name })
      cursor = close + 1
      continue
    }
    const selfClosing = body.endsWith('/')
    const inner = selfClosing ? body.slice(0, -1) : body
    const nameEnd = inner.search(XML_NAME_END)
    const name = nameEnd < 0 ? inner : inner.slice(0, nameEnd)
    if (name === '') {
      wellFormed = false
      break
    }
    const attributes = parseAttributes(nameEnd < 0 ? '' : inner.slice(nameEnd))
    tokens.push({ kind: 'start', name, attributes, selfClosing })
    if (!selfClosing) open.push(name)
    cursor = close + 1
  }
  if (open.length > 0) wellFormed = false
  return { tokens, wellFormed }
}

/** One element of a scanned document. */
export interface XmlNode {
  /** Element name, namespace prefix included. */
  readonly name: string
  /** Quoted attributes. */
  readonly attributes: ReadonlyMap<string, string>
  /** Character data directly inside the element, with entity references resolved. */
  readonly text: string
  /** Child elements in document order. */
  readonly children: readonly XmlNode[]
}

/** A node under construction, linked to the element that holds it. */
interface MutableXmlNode extends XmlNode {
  readonly parent: MutableXmlNode | undefined
  text: string
  readonly children: MutableXmlNode[]
}

/**
 * Build the element tree of a token stream.
 * @param tokens - tokens of one document.
 * @returns the synthetic root element; a stray closing tag is ignored and an unclosed element keeps its children.
 */
export function buildXmlTree(tokens: readonly XmlToken[]): XmlNode {
  const root: MutableXmlNode = { name: '', attributes: new Map(), text: '', children: [], parent: undefined }
  let current = root
  for (const token of tokens) {
    switch (token.kind) {
      case 'text':
        current.text += token.value
        break
      case 'end':
        if (current.parent !== undefined) current = current.parent
        break
      case 'start': {
        const node: MutableXmlNode = {
          name: token.name,
          attributes: token.attributes,
          text: '',
          children: [],
          parent: current,
        }
        current.children.push(node)
        if (!token.selfClosing) current = node
        break
      }
      /* v8 ignore next 2 -- XmlToken is closed and every variant is handled above. */
      default:
        assertNever(token)
    }
  }
  return root
}
