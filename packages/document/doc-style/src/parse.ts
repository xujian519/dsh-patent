/**
 * Parsing of one style asset, rewritten from `LoadStyle` in
 * `domains/config/style.go` of the Go project Mady.
 *
 * A style asset is a file boundary, so a malformed or self-contradictory value
 * fails loud instead of degrading to a style that silently omits a section.
 * @module @deepseek-ai/dsh-doc-style/parse
 */

import { parse as parseYaml } from 'yaml'
import {
  ANTI_PATTERN_SEVERITIES,
  CITATION_STYLES,
  DocumentStyleError,
  FORMALITY_LEVELS,
  PERSPECTIVES,
  type AntiPattern,
  type CitationSection,
  type DocumentStyle,
  type Formality,
  type OutputConventionsSection,
  type Perspective,
  type StyleSections,
  type ToneSection,
  type VoiceSection,
} from './types.ts'
import { isRecord } from '@deepseek-ai/dsh-value'

/** Formality values accepted for a declared tone, including "not declared". */
const TONE_FORMALITIES = ['', ...FORMALITY_LEVELS] as const

/** Perspective values accepted for a declared tone, including "not declared". */
const TONE_PERSPECTIVES = ['', ...PERSPECTIVES] as const

/**
 * Whether a parsed YAML value is a plain mapping.
 * @param value - the parsed value.
 * @returns true when the value can be read as a string-keyed mapping.
 */
/**
 * Read one value that must be a string.
 * @param value - the raw value.
 * @param label - field path for the error message.
 * @returns the string.
 * @throws DocumentStyleError when the value is not a string.
 */
function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new DocumentStyleError(`${label} 必须是字符串。`)
  return value
}

/**
 * Read one value that must be a non-blank string.
 * @param value - the raw value.
 * @param label - field path for the error message.
 * @returns the string.
 * @throws DocumentStyleError when the value is not a non-blank string.
 */
function requireText(value: unknown, label: string): string {
  const text = expectString(value, label)
  if (text.trim() === '') throw new DocumentStyleError(`${label} 不能为空。`)
  return text
}

/**
 * Read one optional string field; an absent field is the empty string.
 * @param value - the raw value.
 * @param label - field path for the error message.
 * @returns the string, or the empty string when the field is absent.
 * @throws DocumentStyleError when the value is present and not a string.
 */
function optionalText(value: unknown, label: string): string {
  return value === undefined || value === null ? '' : expectString(value, label)
}

/**
 * Read one value drawn from a closed set; an absent field takes the empty string.
 * @param value - the raw value.
 * @param allowed - the accepted values.
 * @param label - field path for the error message.
 * @returns the matching value.
 * @throws DocumentStyleError when no accepted value matches.
 */
function parseMember<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const text = optionalText(value, label)
  const matched = allowed.find(entry => entry === text)
  if (matched === undefined) {
    throw new DocumentStyleError(`${label} 必须是 ${allowed.join('/')} 之一（空字符串表示未声明），实际值 ${JSON.stringify(text)}。`)
  }
  return matched
}

/**
 * Read one optional boolean field; an absent field is false.
 * @param value - the raw value.
 * @param label - field path for the error message.
 * @returns the boolean.
 * @throws DocumentStyleError when the value is present and not a boolean.
 */
function parseBoolean(value: unknown, label: string): boolean {
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') throw new DocumentStyleError(`${label} 必须是布尔值。`)
  return value
}

/**
 * Read one optional list of non-blank strings; an absent field is empty.
 * @param value - the raw value.
 * @param label - field path for the error message.
 * @returns the texts in asset order.
 * @throws DocumentStyleError when the value is present and not a list of non-blank strings.
 */
function parseTextList(value: unknown, label: string): readonly string[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new DocumentStyleError(`${label} 必须是字符串数组。`)
  return value.map(entry => requireText(entry, label))
}

/**
 * Read the tone section; every parameter is optional.
 * @param raw - the raw tone mapping.
 * @param source - asset label for error messages.
 * @returns the tone section.
 */
function parseTone(raw: Record<string, unknown>, source: string): ToneSection {
  const label = `${source}: sections.tone`
  return {
    formality: parseMember<Formality | ''>(raw['formality'], TONE_FORMALITIES, `${label}.formality`),
    perspective: parseMember<Perspective | ''>(raw['perspective'], TONE_PERSPECTIVES, `${label}.perspective`),
    language: optionalText(raw['language'], `${label}.language`),
  }
}

/**
 * Read the voice section.
 * @param raw - the raw voice mapping.
 * @param source - asset label for error messages.
 * @returns the voice section.
 */
function parseVoice(raw: Record<string, unknown>, source: string): VoiceSection {
  return { principles: parseTextList(raw['principles'], `${source}: sections.voice.principles`) }
}

/**
 * Read the anti-pattern list; an absent list is empty.
 * @param value - the raw list.
 * @param source - asset label for error messages.
 * @returns the anti-patterns in asset order.
 */
function parseAntiPatterns(value: unknown, source: string): readonly AntiPattern[] {
  const label = `${source}: sections.anti_patterns`
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new DocumentStyleError(`${label} 必须是数组。`)
  return value.map((entry, index) => {
    const entryLabel = `${label}[${String(index)}]`
    if (!isRecord(entry)) throw new DocumentStyleError(`${entryLabel} 必须是对象。`)
    return {
      word: requireText(entry['word'], `${entryLabel}.word`),
      replace: requireText(entry['replace'], `${entryLabel}.replace`),
      severity: parseMember(entry['severity'], ANTI_PATTERN_SEVERITIES, `${entryLabel}.severity`),
    }
  })
}

/**
 * Read the disclaimer map; an absent map is empty.
 * @param value - the raw mapping.
 * @param source - asset label for error messages.
 * @returns the disclaimers keyed by category key, in asset order.
 */
function parseDisclaimers(value: unknown, source: string): ReadonlyMap<string, string> {
  const label = `${source}: sections.disclaimers`
  if (value === undefined || value === null) return new Map<string, string>()
  if (!isRecord(value)) throw new DocumentStyleError(`${label} 必须是「键: 文本」对象。`)
  const pairs = Object.entries(value).map(([key, text]) => [
    requireText(key, label),
    requireText(text, `${label}.${key}`),
  ] as const)
  return new Map(pairs)
}

/**
 * Read the citation section.
 * @param raw - the raw citation mapping.
 * @param source - asset label for error messages.
 * @returns the citation section.
 */
function parseCitation(raw: Record<string, unknown>, source: string): CitationSection {
  const label = `${source}: sections.citation`
  return {
    style: parseMember(raw['style'], CITATION_STYLES, `${label}.style`),
    format: optionalText(raw['format'], `${label}.format`),
  }
}

/**
 * Read the output-conventions section; every flag defaults to false.
 * @param raw - the raw conventions mapping.
 * @param source - asset label for error messages.
 * @returns the output conventions.
 */
function parseOutputConventions(raw: Record<string, unknown>, source: string): OutputConventionsSection {
  const label = `${source}: sections.output_conventions`
  return {
    confidenceLabel: parseBoolean(raw['confidence_label'], `${label}.confidence_label`),
    weakVisual: parseBoolean(raw['weak_visual'], `${label}.weak_visual`),
  }
}

/**
 * Read the sections of a style. An absent `sections` mapping keeps every empty
 * value, as the upstream zero-value struct did; a present-but-wrong one is a defect.
 * @param value - the raw sections mapping.
 * @param source - asset label for error messages.
 * @returns the sections.
 * @throws DocumentStyleError when `sections` is present and not a mapping.
 */
function parseSections(value: unknown, source: string): StyleSections {
  const sections = value === undefined || value === null ? {} : requireSections(value, source)
  return {
    tone: parseTone(sectionOf(sections, 'tone'), source),
    voice: parseVoice(sectionOf(sections, 'voice'), source),
    antiPatterns: parseAntiPatterns(sections['anti_patterns'], source),
    disclaimers: parseDisclaimers(sections['disclaimers'], source),
    citation: parseCitation(sectionOf(sections, 'citation'), source),
    outputConventions: parseOutputConventions(sectionOf(sections, 'output_conventions'), source),
  }
}

/**
 * Read the declared sections mapping.
 * @param value - the raw `sections` value.
 * @param source - asset label for error messages.
 * @returns the mapping.
 * @throws DocumentStyleError when the value is not a mapping.
 */
function requireSections(value: unknown, source: string): Record<string, unknown> {
  if (!isRecord(value)) throw new DocumentStyleError(`${source}: 缺少 sections 对象。`)
  return value
}

/**
 * Read one optional sub-section mapping; an absent section is empty.
 * @param sections - the raw sections mapping.
 * @param key - sub-section key.
 * @returns the sub-section mapping, or an empty mapping when absent.
 * @throws DocumentStyleError when the sub-section is present and not a mapping.
 */
function sectionOf(sections: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = sections[key]
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) throw new DocumentStyleError(`sections.${key} 必须是对象。`)
  return value
}

/**
 * Parse one style asset from YAML text. `name` and `domain` are required: the
 * name is how a template selects the style, and the domain selects the
 * disclaimer fallback.
 * @param text - the YAML asset text.
 * @param source - asset label used in error messages, usually its path.
 * @returns the parsed style.
 * @throws DocumentStyleError when the asset is not valid YAML or violates the style contract.
 */
export function parseStyleAsset(text: string, source: string): DocumentStyle {
  const raw: unknown = parseYaml(text)
  if (!isRecord(raw)) throw new DocumentStyleError(`${source}: 样式资产必须是 YAML 对象。`)
  return {
    name: requireText(raw['name'], `${source}: name`),
    domain: requireText(raw['domain'], `${source}: domain`),
    version: optionalText(raw['version'], `${source}: version`),
    sections: parseSections(raw['sections'], source),
  }
}
