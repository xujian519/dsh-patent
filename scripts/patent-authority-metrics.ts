/**
 * Measure how much of the authoritative patent corpus the shipped law index covers,
 * and where the repository cites a provision the index cannot decide.
 *
 * The report exists so every coverage number in prose can be reproduced. It reads
 * the packaged index through the same loader `law_verify` uses, reads the recorded
 * authority baseline for the denominators, and scans the shipped assets and source
 * for citations. A source root that is absent is reported as `unavailable`; the
 * measurement then keeps the baseline counts and marks the hashes unverified,
 * instead of silently passing.
 *
 * Usage:
 *   tsx scripts/patent-authority-metrics.ts [--out-dir reports] [--source-root DIR] [--check] [--verify-hashes]
 *
 * `--check` compares the regenerated files with the ones on disk and exits non-zero
 * when they differ. `--verify-hashes` recomputes the SHA-256 of every recorded
 * carrier; without a source root it reports the carriers as unavailable.
 * @module dsh-patent-authority-metrics
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import {
  extractLawReferences,
  findArticle,
  findSection,
  loadLawBaselines,
  type LawBaseline,
} from '@deepseek-ai/dsh-patent-law'
import { coversSection } from '../packages/patent/patent-law/src/section-path.ts'
import {
  IndexAssetError,
  parseYamlMapping,
  readCount,
  readMapping,
  readOptionalString,
  readString,
  type AssetFail,
} from '@deepseek-ai/dsh-patent-index-asset'

/** Repository root, resolved from this script's directory. */
const REPO_ROOT = resolve(import.meta.dirname, '..')

/** Recorded authority baseline, relative to the repository root. */
export const AUTHORITY_BASELINE_PATH = 'packages/patent/patent-law/assets/authority/authority-baseline.yaml'

/** Authority rank table, relative to the repository root. */
export const AUTHORITY_RANKS_PATH = 'packages/patent/patent-law/assets/authority/authority-ranks.yaml'

/** Recorded size of the guideline PDF's heading set, the coverage denominator, relative to the repository root. */
export const GUIDELINE_EXTENT_PATH = 'packages/patent/patent-law/assets/authority/guideline-extent.yaml'

/** Default directory the generated JSON and Markdown land in. */
const DEFAULT_OUT_DIR = 'reports'

/** Default knowledge-base root, used when no flag or environment variable names one. */
const DEFAULT_SOURCE_ROOT = join(homedir(), 'projects', '宝宸知识库_Raw')

/** Environment variable that overrides the knowledge-base root. */
const SOURCE_ROOT_ENV = 'DSH_LAW_SOURCE_ROOT'

/** Directory scanned for citations, matching `patent-law/tests/asset-scan.ts`. */
const SCAN_ROOTS: readonly string[] = ['packages/patent', 'packages/bundle/web-app']

/** Path fragments whose files are part of the shipped surface. */
const INCLUDED_SEGMENTS: readonly string[] = ['/assets/', '/src/', '/skills/', '/presets/']

/** Path fragments excluded from the citation scan. */
const EXCLUDED_SEGMENTS: readonly string[] = ['/lib/', '/node_modules/', '/tests/']

/** Index assets whose own transcribed text cites provisions; those are copies, not repository citations. */
const CITATION_SCAN_EXCLUDES: readonly string[] = [
  'packages/patent/patent-law/assets/law/',
  'packages/patent/patent-law/assets/authority/',
]

/** Text extensions the citation scan reads. */
const SCANNED_EXTENSIONS = new Set(['.ts', '.md', '.yaml', '.yml', '.json', '.html'])

/**
 * The guideline's countable extent, recorded from the official PDF by
 * `patent-law/tools/guideline-transcript.py --write-extent`. It is the coverage
 * denominator: a heading count stated in planning prose cannot be reproduced, and one
 * taken from the PDF can.
 */
export interface GuidelineExtent {
  /** Numbered headings in the PDF. */
  headings: number
  /** Headings that carry body text of their own. */
  headingsWithBody: number
  /** The PDF revision the count was taken from. */
  revision: string
}

/** The error factory the shared asset readers expect. */
const fail: AssetFail = message => new IndexAssetError(message, AUTHORITY_BASELINE_PATH)

/** One physical file a source was taken from. */
export interface AuthorityCarrier {
  /** Knowledge-base-relative path. */
  path: string
  /** What this carrier contributes, e.g. the base revision or an amendment table. */
  role: string | null
  /** Media type as recorded. */
  mediaType: string
  /** Recorded SHA-256 of the file contents. */
  sha256: string
  /** Recorded byte length. */
  bytes: number
}

/** One authoritative document recorded in the baseline. */
export interface AuthoritySource {
  /** Stable id the rank table references. */
  id: string
  /** Short law name used by the index. */
  law: string
  /** Full document title. */
  document: string
  /** Revision label. */
  revision: string
  /** Date the revision took effect, as `YYYY-MM-DD`. */
  effectiveDate: string
  /** Issuing body. */
  authority: string
  /** Files the text comes from. */
  carriers: AuthorityCarrier[]
}

/** A whole corpus whose denominator is recorded without indexing it entry by entry. */
export interface AuthorityExtent {
  /** Stable id. */
  id: string
  /** Document kind, e.g. 司法解释. */
  documentKind: string
  /** Number of documents in the corpus. */
  count: number
  /** Recorded document paths. */
  paths: string[]
}

/** The parsed authority baseline. */
export interface AuthorityBaseline {
  /** Baseline format version. */
  version: string
  /** Date the baseline was checked. */
  verifiedOn: string
  /** Logical name of the knowledge-base root. */
  sourceRoot: string
  /** The eight recorded core sources. */
  sources: AuthoritySource[]
  /** Corpora recorded by count rather than entry. */
  extents: AuthorityExtent[]
}

/** One row of the coverage matrix. */
export interface CoverageRow {
  /** Document or corpus name. */
  document: string
  /** Authoritative extent, or the reason no denominator is recorded. */
  extent: number | string
  /** Entries the shipped index holds. */
  indexed: number
  /** Indexed entries carrying transcribed text. */
  transcribed: number
  /** Share of the extent the index covers, as a percentage with one decimal. */
  coverage: string
  /** Where the indexed count came from. */
  source: string
}

/** One citation the index cannot decide. */
export interface UnresolvedCitation {
  /** Repository-relative file. */
  file: string
  /** One-based line number. */
  line: number
  /** The reference as written. */
  raw: string
  /** Why it cannot be decided. */
  reason: 'not-indexed' | 'untranscribed' | 'document-not-indexed'
}

/** One rule entry whose `legalBasis` names no article or guideline path. */
export interface UnstructuredBasis {
  /** Repository-relative file. */
  file: string
  /** One-based line number. */
  line: number
  /** The recorded basis text. */
  text: string
}

/** Hash check of one recorded carrier. */
export interface CarrierCheck {
  /** Source id. */
  source: string
  /** Knowledge-base-relative path. */
  path: string
  /** `match`, `mismatch`, or the reason the file could not be read. */
  status: 'match' | 'mismatch' | 'missing' | 'unavailable'
  /** Recorded digest. */
  recorded: string
  /** Recomputed digest when the file was read. */
  actual: string | null
}

/** The complete measurement. */
export interface AuthorityMetrics {
  /** Schema version of the generated report. */
  version: 1
  /** Logical knowledge-base name the baseline was recorded against. */
  sourceRoot: { name: string }
  /** Baseline the measurement used. */
  baseline: { version: string; verifiedOn: string; sources: number }
  /** Coverage of the shipped index against the recorded authority. */
  coverage: CoverageRow[]
  /** Citations the index cannot decide. */
  unresolved: UnresolvedCitation[]
  /** Rule entries whose basis names no article or path. */
  unstructured: UnstructuredBasis[]
}

/** Options parsed from the command line. */
export interface MetricsOptions {
  /** Directory the generated files land in, relative to the repository root. */
  outDir: string
  /** Knowledge-base root, or null to resolve the default. */
  sourceRoot: string | null
  /** Compare regenerated files with the ones on disk. */
  check: boolean
  /** Recompute recorded carrier hashes. */
  verifyHashes: boolean
}

/**
 * Parse the command line.
 * @param argv - arguments after the script name.
 * @returns the parsed options.
 * @throws Error when an unknown flag or a flag without a value appears.
 */
export function parseArgs(argv: readonly string[]): MetricsOptions {
  const options: MetricsOptions = { outDir: DEFAULT_OUT_DIR, sourceRoot: null, check: false, verifyHashes: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === undefined) break
    if (arg === '--check') {
      options.check = true
    } else if (arg === '--verify-hashes') {
      options.verifyHashes = true
    } else if (arg === '--out-dir' || arg === '--source-root') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 需要一个值`)
      if (arg === '--out-dir') options.outDir = value
      else options.sourceRoot = value
      index += 1
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }
  return options
}

/**
 * Resolve the knowledge-base root the run uses.
 * @param explicit - the `--source-root` value, or null.
 * @param environment - the process environment.
 * @returns the path and whether it exists.
 */
export function resolveSourceRoot(
  explicit: string | null,
  environment: NodeJS.ProcessEnv = process.env,
): { path: string; available: boolean } {
  const fromEnv = environment[SOURCE_ROOT_ENV]
  const candidate = explicit ?? (fromEnv !== undefined && fromEnv.trim() !== '' ? fromEnv : DEFAULT_SOURCE_ROOT)
  const path = resolve(candidate)
  return { path, available: existsSync(path) }
}

/**
 * Parse the recorded authority baseline.
 * @param text - the YAML file contents.
 * @returns the parsed baseline.
 * @throws Error when a field is missing or the wrong type.
 */
export function parseAuthorityBaseline(text: string): AuthorityBaseline {
  const root = parseYamlMapping(text, '权威基线', fail)
  const version = readString(root, 'version', fail)
  const verifiedOn = readString(root, 'verifiedOn', fail)
  const sourceRoot = readString(root, 'sourceRoot', fail)
  const rawSources = root.sources
  if (!Array.isArray(rawSources) || rawSources.length === 0) throw fail('sources 必须是非空数组')
  const sources = rawSources.map((entry, index) => {
    const where = `sources[${index}]`
    const record = readMapping(entry, where, fail)
    const rawCarriers = record.carriers
    if (!Array.isArray(rawCarriers) || rawCarriers.length === 0) throw fail(`${where}.carriers 必须是非空数组`)
    const carriers = rawCarriers.map((carrier, carrierIndex) => {
      const carrierWhere = `${where}.carriers[${carrierIndex}]`
      const mapping = readMapping(carrier, carrierWhere, fail)
      return {
        path: readString(mapping, 'path', fail),
        role: readOptionalString(mapping, 'role', fail),
        mediaType: readString(mapping, 'mediaType', fail),
        sha256: readString(mapping, 'sha256', fail),
        bytes: readCount(mapping.bytes, `${carrierWhere}.bytes`, fail),
      }
    })
    return {
      id: readString(record, 'id', fail),
      law: readString(record, 'law', fail),
      document: readString(record, 'document', fail),
      revision: readString(record, 'revision', fail),
      effectiveDate: readString(record, 'effectiveDate', fail),
      authority: readString(record, 'authority', fail),
      carriers,
    }
  })
  const rawExtents = root.extents
  if (!Array.isArray(rawExtents)) throw fail('extents 必须是数组')
  const extents = rawExtents.map((entry, index) => {
    const where = `extents[${index}]`
    const record = readMapping(entry, where, fail)
    const paths = record.paths
    if (!Array.isArray(paths) || paths.some(path => typeof path !== 'string' || path.trim() === '')) {
      throw fail(`${where}.paths 必须是非空字符串数组`)
    }
    return {
      id: readString(record, 'id', fail),
      documentKind: readString(record, 'documentKind', fail),
      count: readCount(record.count, `${where}.count`, fail),
      paths: paths as string[],
    }
  })
  return { version, verifiedOn, sourceRoot, sources, extents }
}

/**
 * Percentage with one decimal; an absent denominator is reported as `n/a`.
 * @param part - covered entries.
 * @param whole - authoritative extent.
 * @returns the formatted share.
 */
function percent(part: number, whole: number): string {
  if (whole <= 0) return 'n/a'
  return `${((part / whole) * 100).toFixed(1)}%`
}

/**
 * Parse the recorded guideline extent.
 * @param text - the extent asset's text.
 * @returns the recorded heading counts.
 * @throws IndexAssetError when a required field is missing or not a positive count.
 */
export function parseGuidelineExtent(text: string): GuidelineExtent {
  const root = parseYamlMapping(text, '指南规模', fail)
  const headings = readCount(root.headings, 'headings', fail)
  const headingsWithBody = readCount(root.headingsWithBody, 'headingsWithBody', fail)
  if (headingsWithBody > headings) throw fail('headingsWithBody 不能大于 headings')
  return { headings, headingsWithBody, revision: readString(root, 'revision', fail) }
}

/**
 * Build the coverage rows from the loaded index and the recorded baseline.
 * @param baselines - the shipped index, keyed by law name.
 * @param baseline - the recorded authority baseline.
 * @param guidelineExtent - the guideline's recorded extent, its coverage denominator.
 * @returns one row per indexed document plus one per recorded corpus.
 */
export function buildCoverage(
  baselines: ReadonlyMap<string, LawBaseline>,
  baseline: AuthorityBaseline,
  guidelineExtent: GuidelineExtent,
): CoverageRow[] {
  const rows: CoverageRow[] = []
  const statute = (name: string): CoverageRow => {
    const document = baselines.get(name)
    const articles = document?.articles ?? []
    const extent = document?.maxArticle ?? '未记录'
    return {
      document: name,
      extent,
      indexed: articles.length,
      transcribed: articles.filter(article => article.text !== null).length,
      coverage: typeof extent === 'number' ? percent(articles.length, extent) : 'n/a',
      source: '随包索引 maxArticle',
    }
  }
  rows.push(statute('专利法'), statute('专利法实施细则'))
  const guidelines = baselines.get('专利审查指南')
  // The extent counts numbered headings, so the part and chapter containers that
  // carry no heading of their own stay out of the numerator.
  const sections = (guidelines?.sections ?? []).filter(section => /\d/u.test(section.path))
  rows.push({
    document: '专利审查指南',
    extent: guidelineExtent.headings,
    indexed: sections.length,
    transcribed: sections.filter(section => section.text !== null).length,
    coverage: percent(sections.length, guidelineExtent.headings),
    source: `官方 PDF 编号标题数（guideline-extent.yaml：${guidelineExtent.headingsWithBody} 节带正文）`,
  })
  for (const extent of baseline.extents) {
    // The judicial interpretations are indexed one file per document; the
    // regulations are not indexed yet and stay at zero.
    const indexed = extent.documentKind === '司法解释'
      ? [...baselines.values()].filter(document => document.law.startsWith('最高人民法院'))
      : []
    const transcribed = indexed.filter(document =>
      document.articles.length > 0 && document.articles.every(article => article.text !== null))
    rows.push({
      document: extent.documentKind,
      extent: extent.count,
      indexed: indexed.length,
      transcribed: transcribed.length,
      coverage: percent(indexed.length, extent.count),
      source: indexed.length > 0 ? '随包索引（一件文书一个文件）' : '索引不含该文书种类',
    })
  }
  return rows
}

/** One scanned file: repository-relative path and text. */
interface ScannedFile {
  /** Repository-relative path. */
  file: string
  /** File text. */
  text: string
}

/**
 * Read every shipped asset and source file the citation scan covers.
 * @param root - repository root.
 * @returns the sorted file list.
 */
export function scanFiles(root: string): ScannedFile[] {
  const files: ScannedFile[] = []
  const collect = (directory: string): void => {
    let entries: string[]
    try {
      entries = readdirSync(directory)
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(directory, entry)
      if (EXCLUDED_SEGMENTS.some(segment => path.includes(segment))) continue
      if (statSync(path).isDirectory()) {
        collect(path)
        continue
      }
      const dot = entry.lastIndexOf('.')
      if (dot < 0 || !SCANNED_EXTENSIONS.has(entry.slice(dot))) continue
      const file = relative(root, path).split('\\').join('/')
      if (!INCLUDED_SEGMENTS.some(segment => file.includes(segment))) continue
      if (CITATION_SCAN_EXCLUDES.some(prefix => file.startsWith(prefix))) continue
      files.push({ file, text: readFileSync(path, 'utf8') })
    }
  }
  for (const scanRoot of SCAN_ROOTS) collect(join(root, scanRoot))
  return files.sort((left, right) => left.file.localeCompare(right.file))
}

/**
 * Find citations the shipped index cannot decide.
 * @param files - scanned files.
 * @param baselines - the shipped index.
 * @returns unresolved citations in file and line order.
 */
export function findUnresolved(
  files: readonly ScannedFile[],
  baselines: ReadonlyMap<string, LawBaseline>,
): UnresolvedCitation[] {
  const unresolved: UnresolvedCitation[] = []
  for (const { file, text } of files) {
    for (const reference of extractLawReferences(text)) {
      // The compact form (`A22`, `A22.3`) is also how IPC classes and template
      // placeholders read, so the report counts only written citations. A
      // countable phrase such as `专利法82 条` describes an extent, so it needs
      // the `第` a citation carries.
      if (/^A[0-9]/.test(reference.raw)) continue
      if (reference.kind === 'law-article' && !reference.raw.includes('第')) continue
      if (reference.kind === 'law-article') {
        const document = baselines.get(reference.law)
        if (document === undefined) {
          unresolved.push({ file, line: locateLine(text, reference.raw), raw: reference.raw, reason: 'document-not-indexed' })
          continue
        }
        const article = findArticle(document, reference.article)
        if (article === undefined) {
          unresolved.push({ file, line: locateLine(text, reference.raw), raw: reference.raw, reason: 'not-indexed' })
        } else if (article.text === null) {
          unresolved.push({ file, line: locateLine(text, reference.raw), raw: reference.raw, reason: 'untranscribed' })
        }
      } else {
        const document = baselines.get(reference.law)
        if (document === undefined) {
          unresolved.push({ file, line: locateLine(text, reference.raw), raw: reference.raw, reason: 'document-not-indexed' })
          continue
        }
        const section = findSection(document, reference.path)
        if (section === undefined) {
          unresolved.push({ file, line: locateLine(text, reference.raw), raw: reference.raw, reason: 'not-indexed' })
        } else if (section.text === null && !hasTranscribedDescendant(document, reference.path)) {
          unresolved.push({ file, line: locateLine(text, reference.raw), raw: reference.raw, reason: 'untranscribed' })
        }
      }
    }
  }
  const seen = new Set<string>()
  return unresolved
    .filter((item): boolean => {
      const key = `${item.file}#${item.line}#${item.raw}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
}

/**
 * Whether a section without text of its own is still decidable through its
 * subsections.
 *
 * A part, a chapter or a heading whose whole body is its subsections carries no
 * text of its own; the verifier decides such a citation against the transcribed
 * sections under it, so counting it as a gap would overstate the corpus.
 * @param document - the guideline baseline.
 * @param path - the cited normalized section path.
 * @returns true when at least one transcribed section sits under the path.
 */
function hasTranscribedDescendant(document: LawBaseline, path: string): boolean {
  return document.sections.some(section => section.text !== null && coversSection(path, section.path))
}

/**
 * One-based line of the first occurrence of a raw reference.
 * @param text - file text.
 * @param raw - the reference as written.
 * @returns the line number, or 0 when the text does not carry it verbatim.
 */
function locateLine(text: string, raw: string): number {
  const normalize = (value: string): string => value.replace(/[《》\s]/g, '')
  const target = normalize(raw)
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (normalize(lines[index] ?? '').includes(target)) return index + 1
  }
  return 0
}

/** Whether a `legalBasis` names an article, a guideline path, or neither. */
type BasisKind = 'article' | 'guideline-path' | 'unstructured'

/**
 * Classify one `legalBasis` value.
 * @param value - the recorded basis text.
 * @returns the kind of location it carries.
 */
export function classifyBasis(value: string): BasisKind {
  if (/第\s*[〇零一二三四五六七八九十百千0-9]+\s*[-–—~至]\s*[0-9]+\s*条/.test(value)) return 'article'
  if (/第\s*[〇零一二三四五六七八九十百千0-9]+\s*条/.test(value)) return 'article'
  if (/第[一二三四五六七八九十]+部分/.test(value)) return 'guideline-path'
  return 'unstructured'
}

/**
 * Find rule entries whose `legalBasis` names no article or guideline path.
 * @param files - scanned files.
 * @returns entries in file and line order.
 */
export function findUnstructuredBasis(files: readonly ScannedFile[]): UnstructuredBasis[] {
  const entries: UnstructuredBasis[] = []
  for (const { file, text } of files) {
    if (!file.includes('/assets/rules/')) continue
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      const match = /^\s*legalBasis:\s*(.*)$/.exec(line)
      if (match === null) continue
      const value = (match[1] ?? '').trim()
      if (value === '' || value.startsWith('|') || value.startsWith('>')) continue
      if (classifyBasis(value) !== 'unstructured') continue
      entries.push({ file, line: index + 1, text: value })
    }
  }
  return entries.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line)
}

/**
 * Recompute recorded carrier hashes.
 * @param baseline - the recorded baseline.
 * @param sourceRoot - resolved knowledge-base root.
 * @returns one check per carrier; without an available root every carrier is `unavailable`.
 */
export function verifyCarriers(baseline: AuthorityBaseline, sourceRoot: { path: string; available: boolean }): CarrierCheck[] {
  const checks: CarrierCheck[] = []
  for (const source of baseline.sources) {
    for (const carrier of source.carriers) {
      if (!sourceRoot.available) {
        checks.push({ source: source.id, path: carrier.path, status: 'unavailable', recorded: carrier.sha256, actual: null })
        continue
      }
      const path = join(sourceRoot.path, carrier.path)
      if (!existsSync(path)) {
        checks.push({ source: source.id, path: carrier.path, status: 'missing', recorded: carrier.sha256, actual: null })
        continue
      }
      const actual = createHash('sha256').update(readFileSync(path)).digest('hex')
      checks.push({ source: source.id, path: carrier.path, status: actual === carrier.sha256 ? 'match' : 'mismatch', recorded: carrier.sha256, actual })
    }
  }
  return checks
}

/**
 * Build the whole measurement.
 * @param root - repository root.
 * @returns the measurement.
 */
export function buildMetrics(root: string): AuthorityMetrics {
  const baseline = parseAuthorityBaseline(readFileSync(join(root, AUTHORITY_BASELINE_PATH), 'utf8'))
  const guidelineExtent = parseGuidelineExtent(readFileSync(join(root, GUIDELINE_EXTENT_PATH), 'utf8'))
  const baselines = loadLawBaselines()
  const files = scanFiles(root)
  return {
    version: 1,
    sourceRoot: { name: baseline.sourceRoot },
    baseline: { version: baseline.version, verifiedOn: baseline.verifiedOn, sources: baseline.sources.length },
    coverage: buildCoverage(baselines, baseline, guidelineExtent),
    unresolved: findUnresolved(files, baselines),
    unstructured: findUnstructuredBasis(files),
  }
}

/**
 * Render the measurement as Markdown.
 * @param metrics - the measurement.
 * @returns the Markdown report.
 */
export function renderMarkdown(metrics: AuthorityMetrics): string {
  const lines: string[] = []
  lines.push('# 专利法源覆盖与缺口度量', '')
  lines.push(`基线版本：${metrics.baseline.version}，核对于 ${metrics.baseline.verifiedOn}；登记 ${metrics.baseline.sources} 件核心法源。`, '')
  lines.push(`知识库源：\`${metrics.sourceRoot.name}\`；哈希校验由 \`--verify-hashes\` 另行报告。`, '')
  lines.push('## 覆盖矩阵', '')
  lines.push('| 文书 | 权威范围 | 索引条目 | 带正文 | 覆盖率 | 口径 |', '| --- | --- | --- | --- | --- | --- |')
  for (const row of metrics.coverage) {
    lines.push(`| ${row.document} | ${row.extent} | ${row.indexed} | ${row.transcribed} | ${row.coverage} | ${row.source} |`)
  }
  lines.push('', '## 无法判定的引用', '')
  lines.push(`共 ${metrics.unresolved.length} 处；紧凑写法 A22 / A22.3 未计入（IPC 分类号与模板占位符同形）。`, '')
  if (metrics.unresolved.length > 0) {
    lines.push('| 文件:行 | 引用 | 原因 |', '| --- | --- | --- |')
    for (const item of metrics.unresolved.slice(0, 200)) {
      lines.push(`| \`${item.file}:${item.line}\` | ${item.raw} | ${item.reason} |`)
    }
    if (metrics.unresolved.length > 200) lines.push(`| … | 其余 ${metrics.unresolved.length - 200} 处见 JSON | |`)
    lines.push('')
  }
  lines.push('## 无条号或无节路径的 legalBasis', '')
  lines.push(`共 ${metrics.unstructured.length} 处。`, '')
  if (metrics.unstructured.length > 0) {
    lines.push('| 文件:行 | 记录的依据 |', '| --- | --- |')
    for (const item of metrics.unstructured.slice(0, 200)) {
      lines.push(`| \`${item.file}:${item.line}\` | ${item.text} |`)
    }
    if (metrics.unstructured.length > 200) lines.push(`| … | 其余 ${metrics.unstructured.length - 200} 处见 JSON |`)
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * Run the measurement and write or compare the two output files.
 * @param options - parsed command-line options.
 * @param root - repository root.
 * @returns the process exit code.
 */
export function run(options: MetricsOptions, root: string): number {
  const sourceRoot = resolveSourceRoot(options.sourceRoot)
  const metrics = buildMetrics(root)
  const hashChecks = options.verifyHashes
    ? verifyCarriers(parseAuthorityBaseline(readFileSync(join(root, AUTHORITY_BASELINE_PATH), 'utf8')), sourceRoot)
    : []
  for (const check of hashChecks) {
    console.log(`patent-authority-metrics: 哈希 ${check.source} \`${check.path}\` ${check.status}`)
  }
  // An absent corpus is a stated limit of the run, not a hash mismatch: the
  // carriers are reported as unavailable and the measurement still reproduces.
  const hashFailure = hashChecks.some(check => check.status === 'mismatch' || check.status === 'missing')
  const markdown = renderMarkdown(metrics)
  const json = `${JSON.stringify(metrics, null, 2)}\n`
  const outDir = resolve(root, options.outDir)
  const jsonPath = join(outDir, 'patent-authority-metrics.json')
  const markdownPath = join(outDir, 'patent-authority-metrics.md')
  if (options.check) {
    const problems: string[] = []
    for (const [path, expected] of [[jsonPath, json], [markdownPath, markdown]] as const) {
      if (!existsSync(path)) problems.push(`${path} 不存在`)
      else if (readFileSync(path, 'utf8') !== expected) problems.push(`${path} 与重新生成的内容不一致`)
    }
    if (problems.length > 0) {
      for (const problem of problems) console.error(`patent-authority-metrics: ${problem}`)
      return 1
    }
    console.log('patent-authority-metrics: 生成物与记录一致')
    return hashFailure ? 1 : 0
  }
  mkdirSync(outDir, { recursive: true })
  writeFileSync(jsonPath, json)
  writeFileSync(markdownPath, markdown)
  const hashSummary = hashChecks.length === 0
    ? '哈希未校验（加 --verify-hashes）'
    : hashFailure ? '哈希存在不一致或缺失' : '哈希全部一致'
  console.log(
    `patent-authority-metrics: ${metrics.coverage.length} 行覆盖矩阵，${metrics.unresolved.length} 处无法判定的引用，`
    + `${metrics.unstructured.length} 处无条号 legalBasis；${hashSummary}；写入 ${relative(root, jsonPath)} 与 ${relative(root, markdownPath)}`,
  )
  return hashFailure ? 1 : 0
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)
if (invokedDirectly) {
  try {
    const options = parseArgs(process.argv.slice(2))
    process.exitCode = run(options, REPO_ROOT)
  } catch (error) {
    console.error(`patent-authority-metrics: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }
}
