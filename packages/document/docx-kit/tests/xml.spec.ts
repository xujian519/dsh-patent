// 上游来源：Mady 项目 `domains/doctmpl/renderer_docx.go` 的 `docxXMLEscape`
// 与 §"OOXML 片段构造"；读取侧无对应 Go 代码（上游用 encoding/xml 反序列化），
// 因此扫描器与元素树的用例按下文的本地契约编写。

import { describe, expect, it } from 'vitest'
import { buildXmlTree, decodeXmlText, escapeXmlText, scanXml, type XmlToken } from '../src/xml.ts'

/** Token outline, so one document's parse is asserted in a single comparison. */
function outline(tokens: readonly XmlToken[]): string[] {
  return tokens.map(token => (token.kind === 'text' ? `text:${token.value}` : `${token.kind}:${token.name}`))
}

describe('escapeXmlText', () => {
  it('escapes the five predefined entities', () => {
    expect(escapeXmlText('a < b & c > d "q" \'s\'')).toBe('a &lt; b &amp; c &gt; d &quot;q&quot; &apos;s&apos;')
  })

  it('leaves text without escapable characters unchanged', () => {
    expect(escapeXmlText('')).toBe('')
    expect(escapeXmlText('第一段 plain')).toBe('第一段 plain')
    expect(escapeXmlText('甲\t乙\n丙\r丁')).toBe('甲\t乙\n丙\r丁')
  })

  it('drops characters XML 1.0 forbids, including a NUL beside markup', () => {
    expect(escapeXmlText('甲\u0000乙\u0008丙\u000B丁\u000C戊\u000E己\uFFFE庚\uFFFF')).toBe('甲乙丙丁戊己庚')
    expect(escapeXmlText('\u0000<script>')).toBe('&lt;script&gt;')
  })
})

describe('decodeXmlText', () => {
  it('resolves named references', () => {
    expect(decodeXmlText('&amp;&lt;&gt;&quot;&apos;')).toBe('&<>"\'')
  })

  it('resolves decimal and hexadecimal character references', () => {
    expect(decodeXmlText('&#65;&#x42;&#x4e2d;')).toBe('AB中')
  })

  it('keeps unknown and out-of-range references verbatim', () => {
    expect(decodeXmlText('&nbsp;')).toBe('&nbsp;')
    expect(decodeXmlText('&#x110000;')).toBe('&#x110000;')
    expect(decodeXmlText('100 & 200')).toBe('100 & 200')
  })
})

describe('scanXml', () => {
  it('reads elements, attributes, text, comments, CDATA, and declarations', () => {
    const source = '<?xml version="1.0" encoding="UTF-8"?>'
      + '<!DOCTYPE w:document><w:document xmlns:w="urn:w" mode=\'plain\'>'
      + '<!-- a comment --><w:p>a &amp; b</w:p><w:br/><![CDATA[<raw>]]></w:document>'
    const scan = scanXml(source)
    expect(scan.wellFormed).toBe(true)
    expect(outline(scan.tokens)).toEqual([
      'start:w:document',
      'start:w:p',
      'text:a & b',
      'end:w:p',
      'start:w:br',
      'text:<raw>',
      'end:w:document',
    ])
    const document = scan.tokens[0]
    expect(document?.kind === 'start' ? document.attributes.get('xmlns:w') : undefined).toBe('urn:w')
    expect(document?.kind === 'start' ? document.attributes.get('mode') : undefined).toBe('plain')
  })

  it('reads a tag whose attribute has no value without inventing one', () => {
    const scan = scanXml('<w:t xml:space>text</w:t>')
    expect(scan.wellFormed).toBe(true)
    expect(outline(scan.tokens)).toEqual(['start:w:t', 'text:text', 'end:w:t'])
    const tag = scan.tokens[0]
    expect(tag?.kind === 'start' ? [...tag.attributes] : undefined).toEqual([])
  })

  it('reads attributes written with spaces around the equals sign', () => {
    const scan = scanXml('<w:p w:val = "a" />')
    expect(scan.wellFormed).toBe(true)
    const tag = scan.tokens[0]
    expect(tag?.kind === 'start' ? [...tag.attributes] : undefined).toEqual([['w:val', 'a']])
  })

  it('skips a stray separator between attributes', () => {
    const scan = scanXml('<w:p a/b="1"/>')
    expect(scan.wellFormed).toBe(true)
    const tag = scan.tokens[0]
    expect(tag?.kind === 'start' ? [...tag.attributes] : undefined).toEqual([['b', '1']])
  })

  it('ends attribute parsing at an unquoted value', () => {
    const scan = scanXml('<w:p w:val=1/>')
    expect(scan.wellFormed).toBe(true)
    const tag = scan.tokens[0]
    expect(tag?.kind === 'start' ? [...tag.attributes] : undefined).toEqual([])
  })

  it('ends attribute parsing at an unterminated value', () => {
    const scan = scanXml('<w:p w:val="1></w:p>')
    expect(scan.wellFormed).toBe(true)
    const tag = scan.tokens[0]
    expect(tag?.kind === 'start' ? [...tag.attributes] : undefined).toEqual([])
  })

  it('reads character data that follows the last tag', () => {
    const scan = scanXml('<w:p>a</w:p>tail')
    expect(scan.wellFormed).toBe(true)
    expect(outline(scan.tokens)).toEqual(['start:w:p', 'text:a', 'end:w:p', 'text:tail'])
  })

  it.each([
    ['an unterminated comment', '<w:p><!-- open</w:p>'],
    ['an unterminated CDATA section', '<w:p><![CDATA[open</w:p>'],
    ['an unterminated processing instruction', '<w:p><?open</w:p>'],
    ['an unterminated declaration', '<w:p><!DOCTYPE open'],
    ['an unterminated start tag', '<w:p'],
    ['a mismatched closing tag', '<w:p></w:r>'],
    ['an element left open', '<w:document><w:p></w:document>'],
    ['a nameless tag', '<>'],
  ])('reports %s as malformed', (_name, source) => {
    expect(scanXml(source).wellFormed).toBe(false)
  })
})

describe('buildXmlTree', () => {
  it('nests elements and collects their character data', () => {
    const root = buildXmlTree(scanXml('<w:body><w:p>a</w:p><w:p>b</w:p></w:body>').tokens)
    const body = root.children[0]
    expect(body?.name).toBe('w:body')
    expect(body?.children.map(child => child.text)).toEqual(['a', 'b'])
    expect(root.text).toBe('')
  })

  it('does not nest a self-closing element and ignores a stray closing tag', () => {
    const root = buildXmlTree([{ kind: 'end', name: 'w:p' }, { kind: 'text', value: 'x' }, { kind: 'start', name: 'w:br', attributes: new Map(), selfClosing: true }])
    expect(root.text).toBe('x')
    expect(root.children.map(child => child.name)).toEqual(['w:br'])
    expect(root.children[0]?.children).toEqual([])
  })
})
