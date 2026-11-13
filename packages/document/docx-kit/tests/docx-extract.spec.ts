// 上游来源：Mady 项目 `knowledge/fileindex/reader_test.go` 的 `TestReader_ReadDocx`
// （fixture 是 `knowledge/fileindex/testdata/test.docx`，本文件按该归档的
// `word/document.xml` 字节转写）、`reader_docx.go` 的 `extractDocxBodyText`、
// `parseDocxBody`、`extractDocxHeaderFooterText`（页眉页脚与 `[页眉]`/`[页脚]` 标记）。
// 上游 `Confidence` 与 `Metadata` 字段本包以结构化 problems 取代。

import { describe, expect, it } from 'vitest'
import { extractDocxText } from '../src/docx-read.ts'
import { renderDocx } from '../src/docx-write.ts'
import { writeZip } from '../src/zip.ts'
import type { DocxProblem, DocxTextResult, ZipEntryInput, ZipReadLimits } from '../src/types.ts'

/** 上游 testdata 的 `word/document.xml` 原文。 */
const UPSTREAM_DOCUMENT_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
  + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
  + '<w:p><w:r><w:t>第一段：专利权利要求分析</w:t></w:r></w:p>'
  + '<w:p><w:r><w:t>第二段：对比文件技术特征</w:t></w:r></w:p>'
  + '<w:p><w:r><w:t>第三段：新颖性判断结论</w:t></w:r></w:p>'
  + '</w:body></w:document>'

const STYLE_CASES: [value: string, level: number][] = [
  ['Heading2', 2],
  ['heading 3', 3],
  ['4', 4],
]

const BODY_PARAGRAPH_CASES: [name: string, properties: string][] = [
  ['an unknown style', '<w:pStyle w:val="Normal"/>'],
  ['a style without a value', '<w:pStyle/>'],
  ['an outline level without a value', '<w:outlineLvl/>'],
  ['a non-numeric outline level', '<w:outlineLvl w:val="deep"/>'],
  ['an outline level past level 6', '<w:outlineLvl w:val="9"/>'],
  ['empty paragraph properties', '<w:pPr/>'],
]

const TEXT_CODEC = new TextEncoder()

/** Read budgets wide enough that no fixture in this spec reaches them. */
const LIMITS: ZipReadLimits = { maxArchiveEntries: 1_000, maxUncompressedBytes: 8 << 20 }

/** One archive part holding the given text. */
function part(name: string, xml: string): ZipEntryInput {
  return { name, data: TEXT_CODEC.encode(xml) }
}

/** A document part whose body holds the given fragment. */
function documentPart(body: string): ZipEntryInput {
  return part('word/document.xml', '<?xml version="1.0" encoding="UTF-8"?>'
    + `<w:document xmlns:w="urn:w"><w:body>${body}</w:body></w:document>`)
}

/** Package bytes holding exactly the parts given, in archive order. */
function packageOf(parts: readonly ZipEntryInput[]): Uint8Array {
  return writeZip(parts)
}

/** Projection of one document body fragment. */
function project(body: string): DocxTextResult {
  return extractDocxText(packageOf([documentPart(body)]), LIMITS)
}

/** Projected lines of one document body fragment. */
function lines(body: string): string[] {
  return project(body).sections.map(section => section.text)
}

/** Problem codes of one extraction. */
function codes(problems: readonly DocxProblem[]): string[] {
  return problems.map(problem => problem.code)
}

describe('extractDocxText body projection', () => {
  it('reads the upstream testdata document', () => {
    const result = extractDocxText(packageOf([part('word/document.xml', UPSTREAM_DOCUMENT_XML)]), LIMITS)
    expect(result.problems).toEqual([])
    expect(result.text).toContain('专利权利要求')
    expect(result.sections.map(section => section.text)).toEqual([
      '第一段：专利权利要求分析',
      '第二段：对比文件技术特征',
      '第三段：新颖性判断结论',
    ])
    expect(result.text).toBe(result.sections.map(section => section.text).join('\n\n'))
  })

  it('joins the runs of one paragraph and resolves entities', () => {
    expect(lines('<w:p><w:r><w:t>a &amp; b</w:t></w:r><w:r><w:t xml:space="preserve"> c</w:t></w:r></w:p>'))
      .toEqual(['a & b c'])
  })

  it('drops paragraphs without text', () => {
    expect(lines('<w:p/><w:p><w:pPr/></w:p><w:p><w:r><w:t>kept</w:t></w:r></w:p>')).toEqual(['kept'])
  })

  it('reads a paragraph nested in a container element', () => {
    expect(lines('<w:sdt><w:sdtContent><w:p><w:r><w:t>nested</w:t></w:r></w:p></w:sdtContent></w:sdt>'))
      .toEqual(['nested'])
  })

  it('reads text under a hyperlink run', () => {
    expect(lines('<w:p><w:hyperlink r:id="rId1"><w:r><w:t>link</w:t></w:r></w:hyperlink></w:p>')).toEqual(['link'])
  })

  it.each(STYLE_CASES)('reads the style %s as a level %i heading', (value, level) => {
    const result = project(`<w:p><w:pPr><w:pStyle w:val="${value}"/></w:pPr><w:r><w:t>标题</w:t></w:r></w:p>`)
    expect(result.sections).toEqual([{ text: `${'#'.repeat(level)} 标题`, headingLevel: level }])
  })

  it('reads an inline outline level when no style names one', () => {
    expect(project('<w:p><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:r><w:t>标题</w:t></w:r></w:p>').sections)
      .toEqual([{ text: '### 标题', headingLevel: 3 }])
    expect(project('<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>x</w:t></w:r></w:p>').sections)
      .toEqual([{ text: '# x', headingLevel: 1 }])
  })

  it('prefers the style over the outline level', () => {
    const result = project('<w:p><w:pPr><w:pStyle w:val="Heading2"/><w:outlineLvl w:val="4"/></w:pPr>'
      + '<w:r><w:t>x</w:t></w:r></w:p>')
    expect(result.sections[0]?.headingLevel).toBe(2)
  })

  it.each(BODY_PARAGRAPH_CASES)('reads %s as a body paragraph', (_name, properties) => {
    expect(project(`<w:p><w:pPr>${properties}</w:pPr><w:r><w:t>x</w:t></w:r></w:p>`).sections)
      .toEqual([{ text: 'x', headingLevel: undefined }])
  })

  it('reads a paragraph without properties as a body paragraph', () => {
    expect(project('<w:p><w:r><w:t>x</w:t></w:r></w:p>').sections[0]?.headingLevel).toBeUndefined()
  })
})

describe('extractDocxText table projection', () => {
  it('reads one line per row, with the cells between pipes', () => {
    const table = '<w:tbl><w:tr>'
      + '<w:tc><w:p><w:r><w:t>名称</w:t></w:r></w:p></w:tc>'
      + '<w:tc><w:p><w:r><w:t>数值</w:t></w:r></w:p></w:tc>'
      + '</w:tr></w:tbl>'
    expect(lines(table)).toEqual(['| 名称 | 数值 |'])
  })

  it('joins the paragraphs of one cell and drops its empty ones', () => {
    const table = '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p><w:p/>'
      + '<w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    expect(lines(table)).toEqual(['| a b |'])
  })

  it('skips a row without cells', () => {
    expect(lines('<w:tbl><w:tr/><w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'))
      .toEqual(['| a |'])
  })

  it('projects a nested table as its cell text', () => {
    const table = '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>outer</w:t></w:r></w:p>'
      + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>inner</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
      + '</w:tc></w:tr></w:tbl>'
    expect(lines(table)).toEqual(['| outer inner |'])
  })

  it('projects the empty paragraph a rendered table is followed by as nothing', () => {
    expect(lines('<w:tbl><w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p/>'))
      .toEqual(['| a |'])
  })
})

describe('extractDocxText headers and footers', () => {
  it('labels and orders the header, body, and footer blocks', () => {
    const result = extractDocxText(packageOf([
      part('word/header1.xml', '<w:document><w:body><w:p><w:r><w:t>页眉一</w:t></w:r></w:p></w:body></w:document>'),
      part('word/header2.xml', '<w:document><w:body><w:p><w:r><w:t>页眉二</w:t></w:r></w:p></w:body></w:document>'),
      documentPart('<w:p><w:r><w:t>正文</w:t></w:r></w:p>'),
      part('word/footer1.xml', '<w:document><w:body><w:p><w:r><w:t>页脚</w:t></w:r></w:p></w:body></w:document>'),
      part('word/headerStyles.xml', '<w:document><w:body><w:p><w:r><w:t>前缀命中即计</w:t></w:r></w:p></w:body></w:document>'),
    ]), LIMITS)
    expect(result.text).toBe('[页眉]\n\n页眉一\n\n页眉二\n\n前缀命中即计\n\n正文\n\n[页脚]\n\n页脚')
    expect(result.problems).toEqual([])
  })

  it('keeps the heading level of a header paragraph', () => {
    const result = extractDocxText(packageOf([
      part('word/header1.xml', '<w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr>'
        + '<w:r><w:t>页眉标题</w:t></w:r></w:p></w:body></w:document>'),
      documentPart('<w:p><w:r><w:t>正文</w:t></w:r></w:p>'),
    ]), LIMITS)
    expect(result.sections.map(section => section.headingLevel)).toEqual([undefined, 2, undefined])
  })
})

describe('extractDocxText failures', () => {
  it('does not treat a part whose name leaves word/ as the document', () => {
    const result = extractDocxText(packageOf([
      part('../word/document.xml', '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>越界</w:t></w:r></w:p></w:body></w:document>'),
      part('word/document.xml/../secrets.xml', '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>机密</w:t></w:r></w:p></w:body></w:document>'),
    ]), LIMITS)
    expect(result.text).not.toContain('越界')
    expect(result.text).not.toContain('机密')
    expect(codes(result.problems)).toContain('missing-document')
  })

  it('reports a package without a document part', () => {
    const result = extractDocxText(packageOf([
      part('word/header1.xml', '<w:document><w:body><w:p><w:r><w:t>页眉</w:t></w:r></w:p></w:body></w:document>'),
    ]), LIMITS)
    expect(codes(result.problems)).toEqual(['missing-document'])
    expect(result.text).toBe('[页眉]\n\n页眉')
  })

  it('reports a document part that holds no text', () => {
    const result = project('<w:p/>')
    expect(codes(result.problems)).toEqual(['no-text'])
    expect(result.text).toBe('')
    expect(result.sections).toEqual([])
  })

  it('reports a part that is not well-formed XML', () => {
    const result = project('<w:p><w:r><w:t>open</w:t></w:r>')
    expect(result.problems[0]).toEqual({
      code: 'malformed-xml',
      part: 'word/document.xml',
      detail: 'the part is not well-formed XML',
    })
    expect(codes(result.problems)).toEqual(['malformed-xml', 'no-text'])
  })

  it('reports bytes that hold no package', () => {
    const result = extractDocxText(TEXT_CODEC.encode('not a package'), LIMITS)
    expect(codes(result.problems)).toEqual(['not-a-zip', 'missing-document', 'no-text'])
    expect(result.text).toBe('')
  })

  it('reports a document part written in another encoding as malformed', () => {
    const result = extractDocxText(packageOf([
      { name: 'word/document.xml', data: new Uint8Array([0xff, 0xfe, 0x3c, 0x00]) },
    ]), LIMITS)
    expect(codes(result.problems)).toEqual(['malformed-xml', 'no-text'])
  })
})

describe('round trip through renderDocx', () => {
  it('projects the rendered headings, paragraphs, list items, and table rows', () => {
    const source = '# 标题\n\n正文段落。\n\n- 列表项\n\n| a | b |\n| --- | --- |\n| c | d |'
    const result = extractDocxText(renderDocx(source), LIMITS)
    expect(result.problems).toEqual([])
    expect(result.text).toBe('# 标题\n\n正文段落。\n\n• 列表项\n\n| a | b |\n\n| c | d |')
    expect(result.sections.map(section => section.headingLevel)).toEqual([1, undefined, undefined, undefined, undefined])
  })

  it('drops the inline markers, which describe run properties rather than text', () => {
    expect(extractDocxText(renderDocx('**加粗**与`等宽`'), LIMITS).text).toBe('加粗与等宽')
  })

  it('re-renders the projection of headings and paragraphs byte for byte', () => {
    const source = '# 标题\n\n正文段落。\n\n## 二级标题\n\n又一段'
    const projected = extractDocxText(renderDocx(source), LIMITS).text
    expect(projected).toBe(source)
    expect([...renderDocx(projected)]).toEqual([...renderDocx(source)])
  })
})
