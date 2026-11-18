/**
 * Entry point of `@deepseek-ai/dsh-doc-style`: the document writing-style model,
 * its asset loader, and its projections. The package is a pure library — it
 * takes no Cordis context, registers no tool and no section, and owns no
 * durable state — so a consumer loads the styles with explicit directories and
 * projects them itself.
 *
 * The three projections are `systemPrompt` (the whole guide), `toRenderStyle`
 * (what a renderer injects), and `disclaimerFor` (the disclaimer of one template
 * category).
 */

export {
  ANTI_PATTERN_SEVERITIES,
  CITATION_STYLES,
  DISCLAIMER_CATEGORY_KEYS,
  DocumentStyleError,
  FORMALITY_LEVELS,
  PERSPECTIVES,
  STYLE_FILE_SUFFIX,
} from './types.ts'
export type {
  AntiPattern,
  AntiPatternSeverity,
  CitationSection,
  CitationStyle,
  DocumentStyle,
  Formality,
  OutputConventionsSection,
  Perspective,
  RenderStyle,
  StyleSections,
  ToneSection,
  VoiceSection,
} from './types.ts'
export { PLACEHOLDER_MARKERS, placeholderBracePattern, residualPlaceholderPatterns } from './placeholders.ts'
export { parseStyleAsset } from './parse.ts'
export { loadStyleFile, loadStyles, styleDirectories } from './load.ts'
export { stylesDirectory } from './asset-location.ts'
export { disclaimerFor, findStyleByName, systemPrompt, toRenderStyle } from './projection.ts'
