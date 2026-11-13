// 上游来源：Mady 项目 `domains/doctmpl/renderer_docx.go`：`docxHeadingXML`、
// `docxParagraphXML`、`docxListItemXML`、`docxTableXML`、`docxInlineRunsXML`、
// `docxRunXML`、`docxWrapDocument` 以及三个包部件常量。

import { describe, expect, it } from 'vitest'
import {
  CONTENT_TYPES_XML,
  headingXml,
  listItemXml,
  paragraphXml,
  ROOT_RELS_XML,
  runsXml,
  tableXml,
  wrapDocumentXml,
} from '../src/ooxml.ts'
import type { DocxInlineRun, HeadingLevel } from '../src/types.ts'

/** One plain span, the shape every unmarked text produces. */
const PLAIN_RUN: DocxInlineRun = { text: 'a', bold: false, code: false }

/** One table cell holding `PLAIN_RUN`. */
const PLAIN_CELL: readonly DocxInlineRun[] = [PLAIN_RUN]

/** One table cell holding a second plain run. */
const SECOND_CELL: readonly DocxInlineRun[] = [{ text: 'b', bold: false, code: false }]

const HEADING_SIZES: [level: HeadingLevel, size: number, outline: number][] = [
  [1, 44, 0],
  [2, 36, 1],
  [3, 30, 2],
  [4, 26, 3],
  [5, 26, 4],
  [6, 26, 5],
]

describe('run fragments', () => {
  it('emits nothing for a run without text', () => {
    expect(paragraphXml([{ text: '', bold: true, code: false }])).toBe('<w:p></w:p>')
    expect(runsXml([], false)).toBe('')
  })

  it('emits a plain run with preserved spaces and escaped text', () => {
    expect(paragraphXml([{ text: ' a < b', bold: false, code: false }]))
      .toBe('<w:p><w:r><w:t xml:space="preserve"> a &lt; b</w:t></w:r></w:p>')
  })

  it('emits a code run with the monospace font', () => {
    expect(paragraphXml([{ text: 'x', bold: false, code: true }]))
      .toBe('<w:p><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/></w:rPr>'
        + '<w:t xml:space="preserve">x</w:t></w:r></w:p>')
  })

  it('names an East Asian font on a run that contains CJK text', () => {
    expect(paragraphXml([{ text: '权利要求', bold: false, code: false }]))
      .toContain('<w:rFonts w:eastAsia="Noto Sans CJK SC"/>')
    expect(paragraphXml([{ text: '代码甲', bold: false, code: true }]))
      .toContain('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Noto Sans CJK SC"/>')
    expect(headingXml('标题', 1)).toContain('<w:rFonts w:eastAsia="Noto Sans CJK SC"/>')
  })

  it('forces every run bold for a header row', () => {
    expect(runsXml([PLAIN_RUN], true)).toBe('<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">a</w:t></w:r>')
  })
})

describe('block fragments', () => {
  it('renders a list item with an indented bullet run', () => {
    expect(listItemXml([PLAIN_RUN])).toBe('<w:p><w:pPr><w:ind w:left="420"/></w:pPr>'
      + '<w:r><w:t xml:space="preserve">• </w:t></w:r><w:r><w:t xml:space="preserve">a</w:t></w:r></w:p>')
  })

  it.each(HEADING_SIZES)('renders level %i at half-point size %i', (level, size, outline) => {
    const xml = headingXml('标题', level)
    expect(xml).toContain(`<w:outlineLvl w:val="${outline}"/>`)
    expect(xml).toContain(`<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`)
    expect(xml).toContain('<w:t xml:space="preserve">标题</w:t>')
  })

  it('renders no table for an empty row list', () => {
    expect(tableXml([])).toBe('')
  })

  it('pads a short row and bolds only the header row', () => {
    const xml = tableXml([[PLAIN_CELL], [PLAIN_CELL, SECOND_CELL]])
    expect(xml.match(/<w:tr>/gu)).toHaveLength(2)
    expect(xml.match(/<w:tc>/gu)).toHaveLength(4)
    expect(xml.match(/<w:b\/>/gu)).toHaveLength(1)
    expect(xml).toContain('<w:b/></w:rPr><w:t xml:space="preserve">a</w:t>')
    expect(xml).toContain('<w:r><w:t xml:space="preserve">b</w:t></w:r>')
    expect(xml).toContain('<w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/>')
    expect(xml.endsWith('</w:tbl><w:p/>')).toBe(true)
  })
})

describe('package parts', () => {
  it('wraps a body into the document part', () => {
    expect(wrapDocumentXml('<w:p/>')).toBe('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
      + '<w:body><w:p/><w:sectPr/></w:body></w:document>')
  })

  it('declares the content type of the document part', () => {
    expect(CONTENT_TYPES_XML).toContain('<Default Extension="rels"')
    expect(CONTENT_TYPES_XML).toContain('<Override PartName="/word/document.xml" '
      + 'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>')
  })

  it('relates the package to the document part', () => {
    expect(ROOT_RELS_XML).toContain('Target="word/document.xml"')
  })
})
