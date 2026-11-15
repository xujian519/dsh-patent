/**
 * Entry point of `@deepseek-ai/dsh-docx-kit`: Markdown to DOCX rendering and
 * DOCX to text projection, over Node's standard library only. The XML and ZIP
 * layers beneath them are reachable through the package's `./src/*` subpath.
 */

export { renderDocx } from './docx-write.ts'
export { extractDocxText } from './docx-read.ts'
export { parseInline, parseMarkdown } from './markdown.ts'
export {
  DEFAULT_ZIP_READ_LIMITS,
  DOCUMENT_PART,
  FOOTER_PART_LABEL,
  FOOTER_PART_PREFIX,
  HEADER_PART_LABEL,
  HEADER_PART_PREFIX,
  HEADING_LEVELS,
  HEADING_MARKER,
  headingLevelOf,
  TABLE_CELL_SEPARATOR,
  XML_PART_SUFFIX,
} from './types.ts'
export type {
  DocxBlock,
  DocxInlineRun,
  DocxProblem,
  DocxProblemCode,
  DocxRenderOptions,
  DocxSection,
  DocxTableRow,
  DocxTextResult,
  HeadingLevel,
  ZipReadLimits,
} from './types.ts'
