/**
 * Text-level comparison between a proposition and the entry a citation points at.
 *
 * The scoring lives in `@deepseek-ai/dsh-law-core`, the statute-citation library
 * both the legal and the patent domains consume; this module keeps the legal-law
 * entry point and the legal-domain names.
 * @module @deepseek-ai/dsh-legal-law/support
 */

export {
  createOverlapIndex as createLegalOverlapIndex,
  PROPOSITION_SUPPORT_DEFAULT as LEGAL_PROPOSITION_SUPPORT_DEFAULT,
  textOverlap as legalTextOverlap,
  topicOverlap as legalTopicOverlap,
} from '@deepseek-ai/dsh-law-core'
export type {
  ComparableEntry as LegalComparableEntry,
  OverlapIndex as LegalOverlapIndex,
} from '@deepseek-ai/dsh-law-core'
