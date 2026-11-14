/**
 * Function plugin registering `law_verify`: citation checking against the law
 * index shipped with this package (《专利法》《专利法实施细则》《专利审查指南》).
 *
 * The index is loaded at plugin load, so a missing or malformed asset fails the
 * deployment instead of silently turning the gate into a no-op that reports every
 * citation as checked.
 * @module @deepseek-ai/dsh-patent-law
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { loadLawBaselines } from './baseline.ts'
import { lawLineageFile } from './asset-location.ts'
import { loadLawLineageFile } from './lineage.ts'
import {
  CNLAW_DECLARATION_SECTION,
  CNLAW_DECLARATION_SECTION_ORDER,
  DEFAULT_CNLAW_GRAPH_URL,
  DEFAULT_CNLAW_SEARCH_URL,
  renderCnlawDeclaration,
} from './cnlaw-declaration.ts'
import { PROPOSITION_SUPPORT_DEFAULT } from './support.ts'
import { createLawVerifyTool } from './tool/law-verify.ts'
import { DEFAULT_CITATION_POLICY } from './verify.ts'
import { ruleLockAtom, RuleLockHandler } from './rule-lock.ts'
import type { CitationPolicy, CitationPolicySet } from './types.ts'
import { globalAtomRegistry, globalStageHandlerRegistry } from '@deepseek-ai/dsh-patent-core'

// Public library API: the reference parser, the index loader, the verifier, and
// the tool factory.
export {
  findArticle,
  findSection,
  LAW_NAMES,
  LawBaselineError,
  loadLawBaselines,
  parseLawBaseline,
} from './baseline.ts'
export {
  lawBaselineDir,
  lawLineageFile,
  LAW_FILE_NAMES,
  LAW_LINEAGE_FILE_NAME,
  listLawFiles,
} from './asset-location.ts'
export {
  CNLAW_DECLARATION_SECTION,
  CNLAW_DECLARATION_SECTION_ORDER,
  DEFAULT_CNLAW_GRAPH_URL,
  DEFAULT_CNLAW_SEARCH_URL,
  renderCnlawDeclaration,
  type CnlawDeclaration,
} from './cnlaw-declaration.ts'
export {
  extractLawReferences,
  formatCnNumber,
  formatLawReference,
  parseCnNumber,
  parseLawReference,
  scanUnrecognizedCitations,
} from './reference.ts'
export {
  createOverlapIndex,
  PROPOSITION_SUPPORT_DEFAULT,
  textOverlap,
  topicOverlap,
  type ComparableEntry,
  type OverlapIndex,
} from './support.ts'
export {
  DEFAULT_CITATION_POLICY,
  renderCitationFindings,
  renderCitationRows,
  resolveCitationPolicy,
  verifyCitation,
  verifyCitations,
  type CitationRow,
  type VerifyOptions,
} from './verify.ts'
export {
  decideValidity,
  queryValidity,
} from './citator.ts'
export {
  LawLineageError,
  loadLawLineageFile,
  parseLawLineage,
  queryArticleAtDate,
  queryArticleLineage,
  queryDiffBetween,
  queryStatusSnapshot,
} from './lineage.ts'
export {
  ruleLockAtom,
  RuleLockHandler,
  lockProvisions,
  renderRuleLockReport,
  DEFAULT_RULE_LOCK_PROVISIONS_KEY,
  DEFAULT_RULE_LOCK_AS_OF_KEY,
  type RuleLockEntry,
  type RuleLockLevel,
  type RuleLockOutput,
} from './rule-lock.ts'
export {
  createLawVerifyTool,
  LawVerifyToolError,
  type LawVerifyFinding,
  type LawVerifyInput,
  type LawVerifyOutput,
  type LawVerifyToolOptions,
} from './tool/law-verify.ts'
export type {
  ArticleEntry,
  ArticleLineage,
  ArticleRevision,
  CitationDecision,
  CitationFinding,
  CitationPolicy,
  CitationPolicySet,
  GuidelineReference,
  GuidelineVersion,
  InterpretationName,
  LawArticleReference,
  LawBaseline,
  LawLineageSnapshot,
  LawName,
  LawReference,
  RegulationName,
  RevisionDescriptor,
  SectionEntry,
  StaleSection,
  StatuteName,
  ValidityQuery,
  ValidityResult,
  ValidityState,
} from './types.ts'

/** Cordis plugin name. */
export const name = 'patent-law'

/** Services the plugin requires before registration. */
export const inject = ['tools']

/** Model-facing patent-law plugin configuration. */
export interface Config {
  /** Directory holding the law-index YAML files; defaults to the packaged index. */
  baselineDir?: string
  /** Directory holding the statute-lineage snapshot; defaults to the packaged snapshot. */
  lineageDir?: string
  /** Whether this deployment runs the local cnlaw legal base. Defaults to `true`. */
  cnlawEnabled: boolean
  /** Semantic-search endpoint of the local cnlaw base; defaults to `http://127.0.0.1:8100`. */
  cnlawSearchUrl: string
  /** Graph/case endpoint of the local cnlaw base; defaults to `http://127.0.0.1:8001`. */
  cnlawGraphUrl: string
  /** Treatment of a citation whose proposition a verified article does not support, while another entry does. */
  onMismatch: CitationPolicy
  /** Treatment of a citation whose proposition no entry of the law supports, so nothing here decides it. */
  onUnmatched: CitationPolicy
  /** Treatment of a citation beyond a verified article ceiling. */
  onOutOfRange: CitationPolicy
  /** Treatment of a citation the index does not hold. */
  onNotIndexed: CitationPolicy
  /** Treatment of an indexed entry whose text has not been transcribed. */
  onUnverified: CitationPolicy
  /**
   * Share of a proposition's weighted character pairs an entry's text must carry
   * before it supports the proposition; greater than 0 and at most 1.
   */
  propositionSupport: number
}

/** Schemastery configuration: index override, the declared cnlaw base, and the per-decision citation policy. */
export const Config: z<Config> = z.object({
  baselineDir: z.string(),
  lineageDir: z.string(),
  cnlawEnabled: z.boolean().default(true),
  cnlawSearchUrl: z.string().default(DEFAULT_CNLAW_SEARCH_URL),
  cnlawGraphUrl: z.string().default(DEFAULT_CNLAW_GRAPH_URL),
  onMismatch: z.union(['block', 'warn', 'allow'] as const).default(DEFAULT_CITATION_POLICY.mismatch),
  onUnmatched: z.union(['block', 'warn', 'allow'] as const).default(DEFAULT_CITATION_POLICY.unmatched),
  onOutOfRange: z.union(['block', 'warn', 'allow'] as const).default(DEFAULT_CITATION_POLICY.outOfRange),
  onNotIndexed: z.union(['block', 'warn', 'allow'] as const).default(DEFAULT_CITATION_POLICY.notIndexed),
  onUnverified: z.union(['block', 'warn', 'allow'] as const).default(DEFAULT_CITATION_POLICY.unverified),
  propositionSupport: z.number().min(0.0001).max(1).default(PROPOSITION_SUPPORT_DEFAULT),
})

/**
 * Register the law_verify tool over the configured law index, and declare the
 * deployment's cnlaw legal base where a prompt registry is mounted.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - index override, the cnlaw base endpoints, and the per-decision citation policy.
 */
export function apply(ctx: Context, config: Config): void {
  const baselines = loadLawBaselines(config.baselineDir)
  // The lineage snapshot is a shipped asset like the index: a missing or
  // malformed file must fail the deployment rather than silently degrade
  // rule-lock to baseline-only validity.
  const lineage = loadLawLineageFile(lawLineageFile(config.lineageDir))
  // The schema defaults every policy field, so each one is resolved by the time it arrives.
  const policies: CitationPolicySet = {
    mismatch: config.onMismatch,
    unmatched: config.onUnmatched,
    outOfRange: config.onOutOfRange,
    notIndexed: config.onNotIndexed,
    unverified: config.onUnverified,
  }
  ctx.tools.register(createLawVerifyTool({ baselines, policies, supportThreshold: config.propositionSupport }))
  // Register the rule-lock atom and handler as one owned effect: plugin
  // disposal must withdraw both from the shared registries.
  ctx.effect(() => {
    const disposers = [
      globalAtomRegistry.register(ruleLockAtom),
      globalStageHandlerRegistry.register(new RuleLockHandler(baselines, lineage)),
    ]
    return () => {
      for (const dispose of disposers.reverse()) dispose()
    }
  }, 'patent-law: rule-lock atom')
  // Optional injection: without a prompt registry there is no model to declare
  // the base to, and the tool stands on its own.
  ctx.inject(['systemPrompt'], (scope) => {
    scope.systemPrompt.section({
      name: CNLAW_DECLARATION_SECTION,
      order: CNLAW_DECLARATION_SECTION_ORDER,
      text: renderCnlawDeclaration({
        enabled: config.cnlawEnabled,
        searchUrl: config.cnlawSearchUrl,
        graphUrl: config.cnlawGraphUrl,
      }),
    })
  })
}
