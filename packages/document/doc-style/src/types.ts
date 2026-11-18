/**
 * Vocabulary of `@deepseek-ai/dsh-doc-style`: the document writing-style model
 * rewritten from `domains/config/style.go` of the Go project Mady, its closed
 * value sets and asset tables, and the projection types the loader and the
 * prompt builders exchange.
 *
 * `src/types.ts` is the one module exempt from the per-file coverage gate, so it
 * holds types, constants, and the package's error class only.
 * @module @deepseek-ai/dsh-doc-style/types
 */

/** Formality levels a style asset may declare for its tone section. */
export const FORMALITY_LEVELS = ['casual', 'professional', 'academic'] as const

/** Writing formality of a style. */
export type Formality = (typeof FORMALITY_LEVELS)[number]

/** Narrative perspectives a style asset may declare for its tone section. */
export const PERSPECTIVES = ['first', 'second', 'third'] as const

/** Narrative perspective of a style. */
export type Perspective = (typeof PERSPECTIVES)[number]

/** Severities an anti-pattern entry may declare. */
export const ANTI_PATTERN_SEVERITIES = ['block', 'warn'] as const

/** Whether an anti-pattern forbids its word outright or only discourages it. */
export type AntiPatternSeverity = (typeof ANTI_PATTERN_SEVERITIES)[number]

/** Citation styles a style asset may declare; the empty string declares none. */
export const CITATION_STYLES = ['', 'inline', 'footnote', 'endnote'] as const

/** Citation placement of a style. */
export type CitationStyle = (typeof CITATION_STYLES)[number]

/** Category of a rendered document to the disclaimer key that applies to it. */
export const DISCLAIMER_CATEGORY_KEYS: Readonly<Record<string, string>> = {
  specification: 'patent_drafting',
  claims: 'patent_drafting',
  'patent-report': 'patent_drafting',
  'oa-response': 'patent_analysis',
  disclosure: 'patent_analysis',
}

/** Suffix of the style assets this package loads. */
export const STYLE_FILE_SUFFIX = '.yaml'

/** Tone parameters of a style; an empty formality or perspective is not declared. */
export interface ToneSection {
  /** Writing formality, or the empty string when the asset declares none. */
  readonly formality: Formality | ''
  /** Narrative perspective, or the empty string when the asset declares none. */
  readonly perspective: Perspective | ''
  /** Language tag the style writes in, or the empty string when undeclared. */
  readonly language: string
}

/** Voice principles of a style. */
export interface VoiceSection {
  /** One imperative principle per entry, quoted verbatim into the system prompt. */
  readonly principles: readonly string[]
}

/** One forbidden or discouraged word with its replacement. */
export interface AntiPattern {
  /** The forbidden word or phrase. */
  readonly word: string
  /** The suggested replacement. */
  readonly replace: string
  /** `block` forbids the word outright; `warn` discourages it. */
  readonly severity: AntiPatternSeverity
}

/** Citation formatting rules of a style. */
export interface CitationSection {
  /** Citation placement. */
  readonly style: CitationStyle
  /** Citation format template, e.g. `[{id}]`; empty when the style declares none. */
  readonly format: string
}

/** Output formatting conventions of a style. */
export interface OutputConventionsSection {
  /** Attach a confidence label to every analytical conclusion. */
  readonly confidenceLabel: boolean
  /** De-emphasize low-confidence content visually. */
  readonly weakVisual: boolean
}

/** The sections of one writing style. */
export interface StyleSections {
  /** Tone parameters. */
  readonly tone: ToneSection
  /** Voice principles. */
  readonly voice: VoiceSection
  /** Forbidden or discouraged words, in asset order. */
  readonly antiPatterns: readonly AntiPattern[]
  /** Disclaimer texts by key, in asset order. */
  readonly disclaimers: ReadonlyMap<string, string>
  /** Citation rules. */
  readonly citation: CitationSection
  /** Output conventions. */
  readonly outputConventions: OutputConventionsSection
}

/**
 * A machine-readable writing style guide: the tone, voice, anti-patterns,
 * disclaimers, and citation conventions an agent follows before generating any
 * user-facing content.
 */
export interface DocumentStyle {
  /** Style name, unique within a loaded set; templates name it in their front-matter. */
  readonly name: string
  /** Domain the style belongs to, e.g. `patent` or `legal`. */
  readonly domain: string
  /** Style version, or the empty string when the asset declares none. */
  readonly version: string
  /** The style's sections. */
  readonly sections: StyleSections
}

/**
 * The render-time projection of a style: the two fields a renderer needs.
 * `@deepseek-ai/dsh-doc-template` declares the same record as its render
 * metadata, so the two packages meet structurally rather than by import.
 */
export interface RenderStyle {
  /** Style name, which selects the renderer's stylesheet. */
  readonly name: string
  /** Disclaimer that applies to the rendered document; empty when none does. */
  readonly disclaimer: string
}

/** Thrown when a style asset is missing, unreadable, or invalid. */
export class DocumentStyleError extends Error {
  /**
   * @param message - what is wrong with the asset or the directories holding it.
   */
  constructor(message: string) {
    super(message)
    this.name = 'DocumentStyleError'
  }
}
