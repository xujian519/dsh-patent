/**
 * OOXML fragment construction for `word/document.xml` and the two package
 * parts, ported from `domains/doctmpl/renderer_docx.go` of the Go project Mady.
 * Fragments are the minimal WordprocessingML that renderer emitted.
 */

import { escapeXmlText } from './xml.ts'
import type { DocxInlineRun, DocxTableRow, HeadingLevel } from './types.ts'

/** XML declaration shared by every part. */
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

/** WordprocessingML namespace of the document part. */
const WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'

/** Package namespace of the content-types part. */
const CONTENT_TYPES_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/content-types'

/** Relationship namespace of the package relationships part. */
const RELATIONSHIP_NAMESPACE = 'http://schemas.openxmlformats.org/package/2006/relationships'

/** Relationship type linking the package to its document body. */
const OFFICE_DOCUMENT_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument'

/** Content type of the document body part. */
const DOCUMENT_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'

/** Table border edges OOXML draws. */
const TABLE_EDGES = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'] as const

/** Monospace font the upstream renderer used for code spans. */
const CODE_FONT = 'Consolas'

/** East Asian font named on a run that contains Han, kana, or Hangul text. */
const CJK_FONT = 'Noto Sans CJK SC'

/** Han, kana, or Hangul text, which needs an East Asian font in WordprocessingML. */
const CJK_TEXT = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u

/**
 * Font element of one run.
 * A code run keeps the monospace Latin fonts. A run that contains CJK text also
 * names {@link CJK_FONT} as `w:eastAsia`; a Latin run without code names no font.
 * @param text - the run text.
 * @param code - whether the run carries the monospace font.
 * @returns the `w:rFonts` element, or the empty string when the run names no font.
 */
function fontXml(text: string, code: boolean): string {
  const eastAsia = CJK_TEXT.test(text) ? ` w:eastAsia="${CJK_FONT}"` : ''
  if (code) return `<w:rFonts w:ascii="${CODE_FONT}" w:hAnsi="${CODE_FONT}"${eastAsia}/>`
  return eastAsia === '' ? '' : `<w:rFonts${eastAsia}/>`
}

/**
 * Half-point run size of a heading level.
 * @param level - heading level.
 * @returns the `w:sz` value the upstream renderer used for that level.
 */
function headingSize(level: HeadingLevel): number {
  if (level === 1) return 44
  if (level === 2) return 36
  if (level === 3) return 30
  return 26
}

/**
 * Render one run.
 * @param text - literal run text; an empty run emits nothing.
 * @param bold - whether the run carries bold.
 * @param code - whether the run carries the monospace font.
 * @returns the `w:r` fragment.
 */
function runXml(text: string, bold: boolean, code: boolean): string {
  if (text === '') return ''
  let properties = ''
  if (bold) properties += '<w:b/>'
  properties += fontXml(text, code)
  const opening = properties === '' ? '' : `<w:rPr>${properties}</w:rPr>`
  return `<w:r>${opening}<w:t xml:space="preserve">${escapeXmlText(text)}</w:t></w:r>`
}

/**
 * Render a span list.
 * @param runs - spans of one line or table cell.
 * @param forceBold - whether every run is bold regardless of its own marker.
 * @returns the concatenated `w:r` fragments.
 */
export function runsXml(runs: readonly DocxInlineRun[], forceBold: boolean): string {
  let xml = ''
  for (const run of runs) xml += runXml(run.text, run.bold || forceBold, run.code)
  return xml
}

/**
 * Render one heading paragraph.
 * @param text - heading text, escaped as a whole since the upstream renderer did not parse markers in it.
 * @param level - heading level, 1 through 6.
 * @returns the `w:p` fragment carrying the outline level Word maps to the heading style.
 */
export function headingXml(text: string, level: HeadingLevel): string {
  const size = headingSize(level)
  return `<w:p><w:pPr><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>`
    + `<w:r><w:rPr><w:b/>${fontXml(text, false)}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>`
    + `<w:t xml:space="preserve">${escapeXmlText(text)}</w:t></w:r></w:p>`
}

/**
 * Render one paragraph.
 * @param runs - spans of the paragraph.
 * @returns the `w:p` fragment.
 */
export function paragraphXml(runs: readonly DocxInlineRun[]): string {
  return `<w:p>${runsXml(runs, false)}</w:p>`
}

/**
 * Render one list item.
 * @param runs - spans of the item text.
 * @returns the indented `w:p` fragment prefixed with a bullet run.
 */
export function listItemXml(runs: readonly DocxInlineRun[]): string {
  return '<w:p><w:pPr><w:ind w:left="420"/></w:pPr>'
    + `<w:r><w:t xml:space="preserve">• </w:t></w:r>${runsXml(runs, false)}</w:p>`
}

/**
 * Render the cells of one table row.
 * @param row - the row's cells.
 * @param columns - column count of the table; a short row is padded with empty cells.
 * @param header - whether the row is the header row, which is bold throughout.
 * @returns the concatenated `w:tc` fragments.
 */
function cellsXml(row: DocxTableRow, columns: number, header: boolean): string {
  let xml = ''
  for (let index = 0; index < columns; index += 1) {
    const runs = row[index] ?? []
    xml += `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr><w:p>${runsXml(runs, header)}</w:p></w:tc>`
  }
  return xml
}

/**
 * Render one bordered table whose first row is its header.
 * @param rows - the table rows; widths are normalized to the widest row.
 * @returns the `w:tbl` fragment followed by the empty paragraph OOXML requires after a table.
 */
export function tableXml(rows: readonly DocxTableRow[]): string {
  if (rows.length === 0) return ''
  const columns = rows.reduce((count, row) => Math.max(count, row.length), 0)
  const borders = TABLE_EDGES.map(edge => `<w:${edge} w:val="single" w:sz="4" w:space="0" w:color="auto"/>`).join('')
  const body = rows.map((row, index) => `<w:tr>${cellsXml(row, columns, index === 0)}</w:tr>`).join('')
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr>`
    + `${body}</w:tbl><w:p/>`
}

/**
 * Wrap a body fragment into the document part.
 * @param body - concatenated block fragments.
 * @returns the complete `word/document.xml` text, ending in the empty section properties of the upstream renderer.
 */
export function wrapDocumentXml(body: string): string {
  return `${XML_DECLARATION}\n<w:document xmlns:w="${WORD_NAMESPACE}"><w:body>${body}<w:sectPr/></w:body></w:document>`
}

/** Content-types part of the minimal package, listing the three parts written. */
export const CONTENT_TYPES_XML = `${XML_DECLARATION}\n`
  + `<Types xmlns="${CONTENT_TYPES_NAMESPACE}">`
  + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
  + '<Default Extension="xml" ContentType="application/xml"/>'
  + `<Override PartName="/word/document.xml" ContentType="${DOCUMENT_CONTENT_TYPE}"/>`
  + '</Types>'

/** Package relationships part of the minimal package, pointing at the document body. */
export const ROOT_RELS_XML = `${XML_DECLARATION}\n`
  + `<Relationships xmlns="${RELATIONSHIP_NAMESPACE}">`
  + `<Relationship Id="rId1" Type="${OFFICE_DOCUMENT_RELATIONSHIP}" Target="word/document.xml"/>`
  + '</Relationships>'
