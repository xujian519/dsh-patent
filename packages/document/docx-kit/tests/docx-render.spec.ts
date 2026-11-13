// 上游来源：Mady 项目 `domains/doctmpl/renderer_docx_test.go`：
// `TestDOCXRenderer_Format`（本包无 Format 概念，改用包部件断言）、
// `TestDOCXRenderer_Render`（标题注入、正文标题、加粗 run、表格内容与边框、列表项）、
// `TestDOCXRenderer_XMLEscape`（XML 特殊字符转义）。`TestDOCXRenderer_Nil`
// 针对 Go 的 nil 接收者，TS 侧无对应形态。

import { describe, expect, it } from 'vitest'
import { extractDocxText } from '../src/docx-read.ts'
import { renderDocx } from '../src/docx-write.ts'
import { readZip } from '../src/zip.ts'
import type { ZipReadLimits } from '../src/types.ts'

/** 上游 `TestDOCXRenderer_Render` 的 Markdown 正文。 */
const UPSTREAM_MARKDOWN = '# 技术标题\n\n这是一段**加粗**文字。\n\n- 列表项一\n- 列表项二\n\n'
  + '| 名称 | 数值 |\n| --- | --- |\n| A | 1 |\n| B | 2 |\n'

const TEXT_DECODER = new TextDecoder()

/** Read budgets wide enough that no rendered fixture reaches them. */
const LIMITS: ZipReadLimits = { maxArchiveEntries: 100, maxUncompressedBytes: 1 << 20 }

/** Part names of a rendered package, in archive order. */
function partNames(bytes: Uint8Array): string[] {
  return readZip(bytes, LIMITS).entries.map(entry => entry.name)
}

/** Text of one part of a rendered package. */
function partText(bytes: Uint8Array, name: string): string {
  const entry = readZip(bytes, LIMITS).entries.find(candidate => candidate.name === name)
  return entry === undefined ? '' : TEXT_DECODER.decode(entry.data)
}

/** The document body of a rendered package. */
function bodyXml(bytes: Uint8Array): string {
  return partText(bytes, 'word/document.xml')
}

describe('renderDocx', () => {
  it('writes the three parts of the upstream package', () => {
    expect(partNames(renderDocx(UPSTREAM_MARKDOWN))).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'word/document.xml',
    ])
    expect(readZip(renderDocx(UPSTREAM_MARKDOWN), LIMITS).problems).toEqual([])
  })

  it('renders the upstream sample with a title, headings, bold, bullets, and a table', () => {
    const xml = bodyXml(renderDocx(UPSTREAM_MARKDOWN, { title: '交底书报告' }))
    expect(xml).toContain('交底书报告')
    expect(xml).toContain('技术标题')
    expect(xml).toContain('<w:b/>')
    expect(xml).toContain('<w:tbl>')
    expect(xml).toContain('列表项一')
    expect(xml).toContain('•')
    for (const cell of ['名称', '数值']) expect(xml).toContain(cell)
    expect(xml).toContain('<w:outlineLvl w:val="0"/>')
  })

  it('escapes XML special characters instead of writing them raw', () => {
    const xml = bodyXml(renderDocx('a < b & c > d'))
    expect(xml).toContain('&lt;')
    expect(xml).toContain('&amp;')
    expect(xml).toContain('&gt;')
    expect(xml).not.toContain('a < b')
  })

  it('writes a well-formed document when the body mixes CJK text, markup, and illegal XML characters', () => {
    const bytes = renderDocx('甲\u0000乙 <丙>')
    const xml = bodyXml(bytes)
    expect(xml).not.toContain('\u0000')
    expect(xml).toContain('&lt;')
    expect(xml).toContain('<w:rFonts w:eastAsia="Noto Sans CJK SC"/>')
    const projected = extractDocxText(bytes, LIMITS)
    expect(projected.problems).toEqual([])
    expect(projected.text).toContain('甲乙 <丙>')
  })

  it('injects no title heading when the title is absent or empty', () => {
    expect(bodyXml(renderDocx('x'))).not.toContain('<w:outlineLvl w:val="0"/>')
    expect(bodyXml(renderDocx('x', { title: '' }))).not.toContain('<w:outlineLvl w:val="0"/>')
  })

  it('prepends the disclaimer in the upstream Markdown form', () => {
    const xml = bodyXml(renderDocx('正文', { disclaimer: '仅供参考' }))
    expect(xml).toContain('&gt; ⚠️ 仅供参考')
    expect(xml).toContain('---')
    expect(xml).toContain('正文')
    expect(bodyXml(renderDocx('正文', { disclaimer: '' }))).not.toContain('⚠️')
  })

  it('renders an empty document for empty Markdown', () => {
    const xml = bodyXml(renderDocx(''))
    expect(xml).not.toContain('<w:p>')
    expect(xml).toContain('<w:body><w:sectPr/></w:body>')
  })
})
