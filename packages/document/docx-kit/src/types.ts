/**
 * Vocabulary shared by both directions of the kit: the Markdown block model the
 * writer consumes, the text projection the reader returns, and the recoverable
 * problems a malformed document is reported as.
 *
 * Constants and the closed-union guard live here because they define that
 * vocabulary; the ported upstream files are `domains/doctmpl/renderer_docx.go`
 * and `knowledge/fileindex/reader_docx.go` of the Go project Mady.
 */

/** Heading levels the writer renders and the reader projects, 1 through 6. */
export const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const

/** One heading level. */
export type HeadingLevel = (typeof HEADING_LEVELS)[number]

/** Marker character prefixed to a projected heading line, repeated per level. */
export const HEADING_MARKER = '#'

/** Separator between the cells of one projected table row. */
export const TABLE_CELL_SEPARATOR = ' | '

/** Label marking the projected header block, taken from the upstream reader. */
export const HEADER_PART_LABEL = '[页眉]'

/** Label marking the projected footer block, taken from the upstream reader. */
export const FOOTER_PART_LABEL = '[页脚]'

/** Archive part holding the document body. */
export const DOCUMENT_PART = 'word/document.xml'

/** Archive part listing the content types of the parts the writer emits. */
export const CONTENT_TYPES_PART = '[Content_Types].xml'

/** Archive part relating the package to its document body. */
export const ROOT_RELS_PART = '_rels/.rels'

/** Part-name prefix of the header parts the reader projects. */
export const HEADER_PART_PREFIX = 'word/header'

/** Part-name prefix of the footer parts the reader projects. */
export const FOOTER_PART_PREFIX = 'word/footer'

/** Part-name suffix every header and footer part carries. */
export const XML_PART_SUFFIX = '.xml'

/** One decorated span of a Markdown line. */
export interface DocxInlineRun {
  /** Literal text, without its markers. */
  readonly text: string
  /** Whether the span was written as `**text**` or forced bold by its block. */
  readonly bold: boolean
  /** Whether the span was written as `` `text` ``. */
  readonly code: boolean
}

/** One table row, holding each cell's span list. */
export type DocxTableRow = readonly (readonly DocxInlineRun[])[]

/** One Markdown block the writer renders. */
export type DocxBlock =
  | { readonly kind: 'heading'; readonly level: HeadingLevel; readonly text: string }
  | { readonly kind: 'paragraph'; readonly runs: readonly DocxInlineRun[] }
  | { readonly kind: 'listItem'; readonly runs: readonly DocxInlineRun[] }
  | { readonly kind: 'table'; readonly rows: readonly DocxTableRow[] }

/** Metadata the writer injects before the Markdown body. */
export interface DocxRenderOptions {
  /** Document title, rendered as a level-1 heading before the body. */
  readonly title?: string
  /** Disclaimer text, prepended to the Markdown source in the upstream form. */
  readonly disclaimer?: string
}

/** Recoverable failure a byte stream is reported as instead of throwing. */
export type DocxProblemCode =
  /** The bytes hold no readable central directory. */
  | 'not-a-zip'
  /** The archive is ZIP64, which this reader does not decode. */
  | 'unsupported-archive'
  /** Entry data lies outside the archive bytes. */
  | 'truncated-entry'
  /** The archive or an entry exceeds a read budget. */
  | 'too-large'
  /** Entry compression is neither store nor deflate. */
  | 'unsupported-compression'
  /** Entry data fails to decompress or fails its CRC check. */
  | 'corrupt-entry'
  /** The archive holds no body part. */
  | 'missing-document'
  /** A part is not well-formed XML. */
  | 'malformed-xml'
  /** No paragraph text was projected. */
  | 'no-text'

/** One recoverable failure, reported in place of a thrown error. */
export interface DocxProblem {
  /** Stable failure kind. */
  readonly code: DocxProblemCode
  /** Archive part the failure belongs to; absent for archive-level failures. */
  readonly part?: string
  /** Human-readable detail, for diagnostics only. */
  readonly detail: string
}

/** One archive entry addressed by name. */
export interface ZipEntry {
  /** Part name, as stored in the archive. */
  readonly name: string
  /** Uncompressed bytes. */
  readonly data: Uint8Array
}

/**
 * Budgets one archive read applies while decompressing. Callers state them
 * explicitly: a single deflate stream can expand thousands of times its stored
 * size, so an unbounded reader turns a small file into an arbitrary allocation.
 */
export interface ZipReadLimits {
  /** Largest number of entries the central directory may declare. */
  readonly maxArchiveEntries: number
  /** Largest total uncompressed bytes the scan may collect. */
  readonly maxUncompressedBytes: number
}

/**
 * Default budgets for reading one OOXML package. Every deployment-facing
 * reader of the same threat model states its `ZipReadLimits` from this value
 * rather than restating the numbers, so a budget change reaches all of them.
 */
export const DEFAULT_ZIP_READ_LIMITS: ZipReadLimits = {
  maxArchiveEntries: 10_000,
  maxUncompressedBytes: 250 * 1024 * 1024,
}

/** Decompressed archive plus the entries that could not be read. */
export interface ZipArchive {
  /** Entries that decompressed; an unreadable entry is reported, not thrown. */
  readonly entries: readonly ZipEntry[]
  /** One failure per unreadable entry, plus archive-level failures. */
  readonly problems: readonly DocxProblem[]
}

/** One entry handed to the writer. */
export interface ZipEntryInput {
  /** Part name, stored verbatim as UTF-8. */
  readonly name: string
  /** Uncompressed bytes. */
  readonly data: Uint8Array
}

/** Compression the writer applies to entry data. */
export type ZipCompression = 'deflate' | 'store'

/** Writer options. */
export interface ZipWriteOptions {
  /** Applied to every entry; defaults to `deflate`. */
  readonly compression?: ZipCompression
}

/** One projected line of a document part, in document order. */
export interface DocxSection {
  /** The line exactly as it appears in the result text, heading marker included. */
  readonly text: string
  /** Projected heading level, `undefined` for a body paragraph. */
  readonly headingLevel: HeadingLevel | undefined
}

/** Result of projecting one document byte stream to text. */
export interface DocxTextResult {
  /** Every projected line, joined by a blank line. */
  readonly text: string
  /** The same lines individually, each carrying its heading level. */
  readonly sections: readonly DocxSection[]
  /** Recoverable failures; empty for a document that projected text cleanly. */
  readonly problems: readonly DocxProblem[]
}

/**
 * Mark an unreachable variant of a closed union.
 * @param value - the variant no branch handled.
 * @returns never; the call always throws.
 */
export function assertNever(value: never): never {
  throw new Error(`unreachable variant: ${JSON.stringify(value)}`)
}

/**
 * Convert a heading level number to the level vocabulary.
 * @param value - a candidate level.
 * @returns the matching level, or `undefined` when no level matches.
 */
export function headingLevelOf(value: number): HeadingLevel | undefined {
  return HEADING_LEVELS.find(level => level === value)
}
