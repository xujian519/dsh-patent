/**
 * The pattern store: the packaged YAML corpus loaded into memory, plus the
 * lexical search and match that select patterns for a case.
 *
 * Matching is lexical and deterministic — token containment over authored
 * fields, weighted per field, multiplied by the pattern's quality. No model
 * call happens on this path, so the same query always selects the same
 * patterns.
 * @module @deepseek-ai/dsh-writing-patterns/pattern-store
 */

import { readFileSync, readdirSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { PATTERN_FILE_SUFFIXES, patternDir } from './asset-location.ts'
import {
  DEFAULT_PATTERN_QUALITY,
  isPatternCategory,
  PATTERN_CATEGORIES,
  PATTERN_CATEGORY_LABELS,
  PatternAssetError,
  type PatternCategory,
  type PatternExample,
  type PatternPrinciple,
  type PatternStep,
  type WritingPattern,
} from './types.ts'

/** Bounds of one lexical search. */
export type PatternSearchSpec = {
  /** Restrict candidates to a category (including patterns naming it as their sub-category). */
  category?: PatternCategory
  /** Maximum number of patterns returned; resolved by the caller, never defaulted here. */
  limit: number
}

/** Bounds of one case-feature match. */
export type PatternMatchSpec = {
  /**
   * Case type scored as a substring of a pattern's category, so `oa` scores all
   * three office-action categories.
   */
  caseType?: string
  /** Technical features or keywords of the case. */
  features?: readonly string[]
  /** Maximum number of patterns returned; resolved by the caller, never defaulted here. */
  limit: number
}

/** One scored candidate; only used inside the sort of a search or match. */
type Scored = { pattern: WritingPattern; score: number }

/** One query term and the weight its field hits carry. */
type SearchTerm = { text: string; weight: number }

/** Code-unit id comparison — locale-independent, so the order is identical on every machine. */
function compareIds(left: WritingPattern, right: WritingPattern): number {
  if (left.id === right.id) return 0
  return left.id < right.id ? -1 : 1
}

/** Descending score, then ascending id so equal scores stay deterministic. */
function compareScored(left: Scored, right: Scored): number {
  if (left.score !== right.score) return right.score - left.score
  return compareIds(left.pattern, right.pattern)
}

/** In-memory pattern store over one loaded corpus. */
export class PatternStore {
  private readonly patterns: readonly WritingPattern[]
  private readonly byId: ReadonlyMap<string, WritingPattern>
  private readonly idsByTag: ReadonlyMap<string, readonly WritingPattern[]>

  /**
   * @param patterns - the corpus; ids are already unique at the file boundary,
   * so a later duplicate would silently replace an earlier one and is not checked here.
   */
  constructor(patterns: readonly WritingPattern[]) {
    this.patterns = [...patterns].sort(compareIds)
    this.byId = new Map(this.patterns.map(pattern => [pattern.id, pattern]))
    const byTag = new Map<string, WritingPattern[]>()
    for (const pattern of this.patterns) {
      for (const tag of applicableTags(pattern)) {
        const bucket = byTag.get(tag)
        if (bucket === undefined) byTag.set(tag, [pattern])
        else bucket.push(pattern)
      }
    }
    this.idsByTag = byTag
  }

  /** Number of patterns in the corpus. */
  get size(): number {
    return this.patterns.length
  }

  /**
   * One pattern by id.
   * @param id - the pattern id.
   * @returns the pattern, or undefined when the corpus has no such id.
   */
  get(id: string): WritingPattern | undefined {
    return this.byId.get(id)
  }

  /**
   * The whole corpus in id order.
   * @returns every loaded pattern.
   */
  all(): readonly WritingPattern[] {
    return this.patterns
  }

  /**
   * Patterns tagged with a category or sub-category, in id order.
   * @param category - the category or sub-category to select.
   * @returns the matching patterns; empty when nothing carries that tag.
   */
  byCategory(category: string): readonly WritingPattern[] {
    return this.idsByTag.get(category) ?? []
  }

  /**
   * Search by free text and optional category, scoring each candidate on
   * containment of the query terms in its name, keywords, summary, context,
   * steps, and rules, multiplied by its quality.
   * @param query - search text; an empty query selects the candidates unscored.
   * @param spec - category restriction and result cap.
   * @returns up to `spec.limit` patterns, best score first.
   */
  search(query: string, spec: PatternSearchSpec): readonly WritingPattern[] {
    const candidates = spec.category === undefined ? this.patterns : this.byCategory(spec.category)
    const terms = searchTerms(query)
    if (terms.length === 0) return candidates.slice(0, spec.limit)
    const scored: Scored[] = []
    for (const pattern of candidates) {
      const score = scorePattern(pattern, terms)
      if (score > 0) scored.push({ pattern, score })
    }
    return scored.sort(compareScored).slice(0, spec.limit).map(entry => entry.pattern)
  }

  /**
   * Match patterns to a case type and its technical features. The case type
   * weighs most, then feature hits in the name, the keywords, the summary, and
   * step names; the score is multiplied by the pattern's quality.
   * @param spec - case type, features, and result cap.
   * @returns up to `spec.limit` patterns with a non-zero score, best first.
   */
  match(spec: PatternMatchSpec): readonly WritingPattern[] {
    const caseType = spec.caseType?.trim().toLowerCase() ?? ''
    const features = (spec.features ?? []).map(feature => feature.trim().toLowerCase()).filter(feature => feature !== '')
    const scored: Scored[] = []
    for (const pattern of this.patterns) {
      const score = scoreMatch(pattern, caseType, features)
      if (score > 0) scored.push({ pattern, score })
    }
    return scored.sort(compareScored).slice(0, spec.limit).map(entry => entry.pattern)
  }
}

/**
 * Load the packaged corpus, or the corpus at an explicit directory.
 * @param dir - optional directory override; the packaged one when omitted.
 * @returns the loaded store.
 * @throws PatternAssetError when the directory is unreadable or any asset is invalid.
 */
export function loadPatternStore(dir?: string): PatternStore {
  return new PatternStore(loadPatternCorpus(patternDir(dir)))
}

/**
 * Read and validate every YAML pattern file of a directory.
 * @param dir - the absolute pattern directory.
 * @returns the patterns in file-name order.
 * @throws PatternAssetError when the directory is unreadable, holds no pattern
 * file, or any file fails to parse or validate.
 */
export function loadPatternCorpus(dir: string): readonly WritingPattern[] {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    throw new PatternAssetError(dir, `无法读取写作模式资产目录：${errorMessage(error)}`)
  }
  const files = entries
    .filter(entry => entry.isFile() && PATTERN_FILE_SUFFIXES.some(suffix => entry.name.endsWith(suffix)))
    .map(entry => entry.name)
    .sort()
  if (files.length === 0) {
    throw new PatternAssetError(dir, `目录下没有 ${PATTERN_FILE_SUFFIXES.join(' / ')} 写作模式资产`)
  }
  const patterns: WritingPattern[] = []
  const seen = new Map<string, string>()
  for (const file of files) {
    const path = join(dir, file)
    for (const pattern of parsePatternFile(path)) {
      const previous = seen.get(pattern.id)
      if (previous !== undefined) {
        throw new PatternAssetError(path, `模式 id "${pattern.id}" 与 ${previous} 重复`)
      }
      seen.set(pattern.id, file)
      patterns.push(pattern)
    }
  }
  return patterns
}

/**
 * Parse one YAML asset into patterns: either a single pattern document, or a
 * document whose `patterns` list holds several.
 * @param path - the asset path, used in error messages.
 * @returns the patterns the file declares, in file order.
 * @throws PatternAssetError when the file cannot be read, parsed, or validated.
 */
export function parsePatternFile(path: string): readonly WritingPattern[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new PatternAssetError(path, `无法读取写作模式资产：${errorMessage(error)}`)
  }
  let document: unknown
  try {
    document = parseYaml(text)
  } catch (error) {
    throw new PatternAssetError(path, `YAML 解析失败：${errorMessage(error)}`)
  }
  const root = assertRecord(document, path, '根节点')
  const listed = root['patterns']
  if (listed === undefined) return [parsePattern(root, path, '根节点')]
  rejectUnknownFields(root, ROOT_FIELDS, path, '根节点')
  if (!Array.isArray(listed)) throw new PatternAssetError(path, '`patterns` 必须是模式数组')
  if (listed.length === 0) throw new PatternAssetError(path, '`patterns` 列表为空')
  return listed.map((entry, index) => parsePattern(entry, path, `patterns[${index}]`))
}

/**
 * Validate one pattern document.
 * @param raw - the parsed YAML value.
 * @param source - asset path for error messages.
 * @param field - field path within the asset for error messages.
 * @returns the validated pattern.
 * @throws PatternAssetError on any missing or mistyped field.
 */
function parsePattern(raw: unknown, source: string, field: string): WritingPattern {
  const record = assertRecord(raw, source, field)
  rejectUnknownFields(record, PATTERN_FIELDS, source, field)
  const id = requiredString(record, 'id', source, field)
  const category = requiredString(record, 'category', source, field)
  if (!isPatternCategory(category)) {
    throw new PatternAssetError(source, `${field}.category 不是已知类目：${category}（可用类目：${PATTERN_CATEGORIES.join('、')}）`)
  }
  const subCategory = optionalString(record, 'sub_category', source, field)
  const context = optionalString(record, 'context', source, field)
  const keywords = parseKeywords(record['keywords'], source, `${field}.keywords`)
  const sourceRef = optionalString(record, 'source_ref', source, field)
  return {
    id,
    name: requiredString(record, 'name', source, field),
    category,
    ...(subCategory !== undefined ? { subCategory } : {}),
    summary: requiredString(record, 'summary', source, field),
    ...(context !== undefined ? { context } : {}),
    ...(keywords.length > 0 ? { keywords } : {}),
    steps: parseSteps(record['steps'], source, `${field}.steps`),
    examples: parseExamples(record['examples'], source, `${field}.examples`),
    dos: parsePrinciples(record['dos'], source, `${field}.dos`),
    donts: parsePrinciples(record['donts'], source, `${field}.donts`),
    ...(sourceRef !== undefined ? { sourceRef } : {}),
    quality: parseQuality(record['quality'], source, field),
    ...(record['version'] !== undefined ? { version: parseVersion(record['version'], source, field) } : {}),
  }
}

/** Category and sub-category tags a pattern answers to. */
function applicableTags(pattern: WritingPattern): readonly string[] {
  if (pattern.subCategory === undefined || pattern.subCategory === pattern.category) return [pattern.category]
  return [pattern.category, pattern.subCategory]
}

/** Relevance score of one pattern against the weighted search terms, multiplied by its quality. */
function scorePattern(pattern: WritingPattern, terms: readonly SearchTerm[]): number {
  let score = 0
  const name = pattern.name.toLowerCase()
  const summary = pattern.summary.toLowerCase()
  const context = pattern.context?.toLowerCase() ?? ''
  const keywords = (pattern.keywords ?? []).map(keyword => keyword.toLowerCase())
  for (const term of terms) {
    if (name.includes(term.text)) score += 3 * term.weight
    if (keywords.some(keyword => keyword.includes(term.text))) score += 2.5 * term.weight
    if (summary.includes(term.text)) score += 2 * term.weight
    if (context.includes(term.text)) score += 1.5 * term.weight
    for (const step of pattern.steps) {
      if (step.name.toLowerCase().includes(term.text)) score += 1 * term.weight
      if (step.instruction.toLowerCase().includes(term.text)) score += 0.5 * term.weight
    }
    for (const principle of pattern.dos) {
      if (principle.rule.toLowerCase().includes(term.text)) score += 0.5 * term.weight
    }
    for (const principle of pattern.donts) {
      if (principle.rule.toLowerCase().includes(term.text)) score += 0.5 * term.weight
    }
  }
  return score * pattern.quality
}

/** Case-feature score: category, then feature hits in authored fields, multiplied by quality. */
function scoreMatch(pattern: WritingPattern, caseType: string, features: readonly string[]): number {
  let score = 0
  if (caseType !== '') {
    const category = pattern.category.toLowerCase()
    const label = PATTERN_CATEGORY_LABELS[pattern.category].toLowerCase()
    if (category.includes(caseType) || label.includes(caseType)) score += 5
  }
  if (features.length > 0) {
    const name = pattern.name.toLowerCase()
    const summary = pattern.summary.toLowerCase()
    const keywords = (pattern.keywords ?? []).map(keyword => keyword.toLowerCase())
    for (const feature of features) {
      if (name.includes(feature)) score += 3
      if (keywords.some(keyword => keyword.includes(feature))) score += 2.5
      if (summary.includes(feature)) score += 2
      for (const step of pattern.steps) {
        if (step.name.toLowerCase().includes(feature)) score += 1.5
      }
    }
  }
  return score * pattern.quality
}

/**
 * Searchable labels of a pattern: its authored keywords, name, category,
 * sub-category, and step names, deduplicated, keeping entries of at least two
 * characters. Rule text is excluded because a query almost never contains a
 * whole rule, so treating a rule as a keyword scored incidental substrings.
 * @param pattern - the pattern to extract from.
 * @returns the labels in extraction order.
 */
export function patternKeywords(pattern: WritingPattern): readonly string[] {
  const keywords: string[] = []
  const seen = new Set<string>()
  const add = (value: string): void => {
    const trimmed = value.trim()
    if (codePointLength(trimmed) < 2 || seen.has(trimmed)) return
    seen.add(trimmed)
    keywords.push(trimmed)
  }
  for (const keyword of pattern.keywords ?? []) add(keyword)
  add(pattern.name)
  add(pattern.category)
  if (pattern.subCategory !== undefined) add(pattern.subCategory)
  for (const step of pattern.steps) add(step.name)
  return keywords
}

/**
 * Weighted query terms. Latin words and the whole query keep full weight;
 * Chinese runs also contribute adjacent-character bigrams, because Chinese
 * does not delimit words with spaces and a multi-word query would otherwise
 * only match as one exact substring.
 */
function searchTerms(query: string): readonly SearchTerm[] {
  const normalized = query.trim().toLowerCase()
  if (normalized === '') return []
  const terms = new Map<string, number>()
  const add = (text: string, weight: number): void => {
    const trimmed = text.trim()
    /* v8 ignore next -- every caller passes a non-blank word, Han run, or the non-blank normalized query */
    if (trimmed === '') return
    const previous = terms.get(trimmed)
    if (previous === undefined || weight > previous) terms.set(trimmed, weight)
  }
  for (const word of normalized.match(/[a-z0-9][a-z0-9._-]*/gu) ?? []) add(word, 1)
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    const characters = Array.from(run)
    if (characters.length === 1) {
      add(run, 1)
      continue
    }
    for (let index = 0; index < characters.length - 1; index++) {
      const first = characters[index]
      const second = characters[index + 1]
      /* v8 ignore next -- the loop bound keeps both indices inside the run */
      if (first !== undefined && second !== undefined) add(first + second, 0.5)
    }
  }
  add(normalized, 1)
  return [...terms].map(([text, weight]) => ({ text, weight }))
}

/** Pattern fields the corpus format defines. */
const PATTERN_FIELDS: ReadonlySet<string> = new Set([
  'id', 'name', 'category', 'sub_category', 'summary', 'context', 'keywords',
  'steps', 'examples', 'dos', 'donts', 'source_ref', 'quality', 'version',
])

/** Root fields allowed beside a `patterns` list. */
const ROOT_FIELDS: ReadonlySet<string> = new Set(['patterns'])

/** Step fields the corpus format defines. */
const STEP_FIELDS: ReadonlySet<string> = new Set(['order', 'name', 'instruction', 'example'])

/** Example fields the corpus format defines. */
const EXAMPLE_FIELDS: ReadonlySet<string> = new Set(['text', 'context', 'note'])

/** Principle fields the corpus format defines. */
const PRINCIPLE_FIELDS: ReadonlySet<string> = new Set(['rule', 'example'])

/**
 * Reject keys the format does not define. A misspelled field would otherwise be
 * dropped silently, leaving the pattern without the behavior its author
 * intended; the known set is part of the error so the author can correct it.
 */
function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  source: string,
  field: string,
): void {
  const unknown = Object.keys(record).filter(key => !allowed.has(key)).sort()
  if (unknown.length === 0) return
  throw new PatternAssetError(
    source,
    `${field} 含未知字段：${unknown.join('、')}（可用字段：${[...allowed].join('、')}）`,
  )
}

/** A YAML mapping. */
function assertRecord(value: unknown, source: string, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PatternAssetError(source, `${field} 必须是映射（YAML 对象）`)
  }
  return value as Record<string, unknown>
}

/** A required non-empty string field. */
function requiredString(record: Record<string, unknown>, key: string, source: string, field: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PatternAssetError(source, `${field}.${key} 必须是非空字符串`)
  }
  return value
}

/** An optional string field; an empty value means absent. */
function optionalString(record: Record<string, unknown>, key: string, source: string, field: string): string | undefined {
  const value = record[key]
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') throw new PatternAssetError(source, `${field}.${key} 必须是字符串`)
  return value
}

/** An optional array field; an absent value means an empty list. */
function optionalList(value: unknown, source: string, field: string): readonly unknown[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new PatternAssetError(source, `${field} 必须是数组`)
  return value
}

/** Pattern steps: orders must be 1..n, unique; the result is in order. */
function parseSteps(value: unknown, source: string, field: string): readonly PatternStep[] {
  const steps = optionalList(value, source, field).map((entry, index) => {
    const at = `${field}[${index}]`
    const record = assertRecord(entry, source, at)
    rejectUnknownFields(record, STEP_FIELDS, source, at)
    const order = record['order']
    if (typeof order !== 'number' || !Number.isInteger(order) || order < 1) {
      throw new PatternAssetError(source, `${at}.order 必须是正整数`)
    }
    const example = optionalString(record, 'example', source, at)
    return {
      order,
      name: requiredString(record, 'name', source, at),
      instruction: requiredString(record, 'instruction', source, at),
      ...(example !== undefined ? { example } : {}),
    }
  })
  const orders = steps.map(step => step.order)
  if (new Set(orders).size !== orders.length) {
    throw new PatternAssetError(source, `${field} 的 order 必须唯一`)
  }
  const sorted = [...orders].sort((left, right) => left - right)
  for (const [index, order] of sorted.entries()) {
    if (order !== index + 1) {
      throw new PatternAssetError(source, `${field} 的 order 必须从 1 开始连续`)
    }
  }
  return [...steps].sort((left, right) => left.order - right.order)
}

/** Authored search synonyms: a list of non-empty strings. */
function parseKeywords(value: unknown, source: string, field: string): readonly string[] {
  return optionalList(value, source, field).map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new PatternAssetError(source, `${field}[${index}] 必须是非空字符串`)
    }
    return entry.trim()
  })
}

/** Pattern examples. */
function parseExamples(value: unknown, source: string, field: string): readonly PatternExample[] {
  return optionalList(value, source, field).map((entry, index) => {
    const at = `${field}[${index}]`
    const record = assertRecord(entry, source, at)
    rejectUnknownFields(record, EXAMPLE_FIELDS, source, at)
    const context = optionalString(record, 'context', source, at)
    const note = optionalString(record, 'note', source, at)
    return {
      text: requiredString(record, 'text', source, at),
      ...(context !== undefined ? { context } : {}),
      ...(note !== undefined ? { note } : {}),
    }
  })
}

/** Pattern rules to follow or avoid. */
function parsePrinciples(value: unknown, source: string, field: string): readonly PatternPrinciple[] {
  return optionalList(value, source, field).map((entry, index) => {
    const at = `${field}[${index}]`
    const record = assertRecord(entry, source, at)
    rejectUnknownFields(record, PRINCIPLE_FIELDS, source, at)
    const example = optionalString(record, 'example', source, at)
    return {
      rule: requiredString(record, 'rule', source, at),
      ...(example !== undefined ? { example } : {}),
    }
  })
}

/**
 * A pattern's quality: a weight in `(0, 1]`, with a missing or zero value
 * taking the corpus default. A weight outside that range would silently
 * reorder every search, so it fails the load instead.
 */
function parseQuality(value: unknown, source: string, field: string): number {
  if (value === undefined || value === null) return DEFAULT_PATTERN_QUALITY
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PatternAssetError(source, `${field}.quality 必须是数字`)
  }
  if (value === 0) return DEFAULT_PATTERN_QUALITY
  if (value < 0 || value > 1) {
    throw new PatternAssetError(source, `${field}.quality 必须在 0 与 1 之间：${String(value)}`)
  }
  return value
}

/** A pattern's version: a positive integer. */
function parseVersion(value: unknown, source: string, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new PatternAssetError(source, `${field}.version 必须是正整数`)
  }
  return value
}

/** Code-point length, the count the source's `[]rune` conversion produced. */
function codePointLength(value: string): number {
  return Array.from(value).length
}

/** Error text of an unknown thrown value. */
function errorMessage(error: unknown): string {
  /* v8 ignore next -- fs and YAML failures are always Error instances */
  return error instanceof Error ? error.message : String(error)
}
