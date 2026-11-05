/**
 * Statute-citation machinery shared by the legal and patent domains: citation
 * text normalization, reference extraction, proposition-overlap scoring, the
 * per-article citation decision, and the citation-verify tool scaffolding.
 * @module @deepseek-ai/dsh-law-core
 */

export { parseCnNumber } from './cn-number.ts'
export {
  articleReferenceIdentity,
  compactCitation,
  formatArticleCitation,
  formatCitationNumber,
  formatCnNumber,
  narrowed,
  normalizeCitationText,
  stripBookMarks,
  trimPunctuation,
} from './citation-text.ts'
export { ARTICLE_CONTINUATION_PATTERN, readArticleContinuations } from './continuation.ts'
export type { ArticleCandidate, ArticleReferenceLike } from './continuation.ts'
export {
  collectReferences,
  readStatuteArticleCandidate,
  scanUnrecognizedReferences,
} from './citation-extract.ts'
export type { StatuteArticleGroups } from './citation-extract.ts'
export {
  createOverlapIndex,
  PROPOSITION_SUPPORT_DEFAULT,
  textOverlap,
  topicOverlap,
} from './text-overlap.ts'
export type { ComparableEntry, OverlapIndex } from './text-overlap.ts'
export {
  articleComparableEntries,
  decideArticleCitation,
  findCompetingLabels,
  formatPercent,
  supportMismatchReason,
  transcribedText,
  truncateProposition,
} from './article-decision.ts'
export type {
  ArticleBaseline,
  ArticleDecision,
  ArticleProposition,
  ArticleVerdict,
  DecisionArticle,
} from './article-decision.ts'
export {
  CITATION_FINDING_DECISION_PROPERTIES,
  CITATION_REPORT_PROPERTIES,
  citationFindingSchema,
  citationInputProblem,
  citationReportLines,
  citationVerifyExecute,
  citationVerifyOutputSchema,
  citationVerifyParameters,
  citationVerifyRender,
  citationVerifyReport,
  citationVerifyToolOptions,
} from './citation-tool.ts'
export type {
  CitationInputProblem,
  CitationReportRow,
  CitationVerifyArgs,
} from './citation-tool.ts'
