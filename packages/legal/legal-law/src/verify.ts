/**
 * Decide one citation against the loaded legal-law index.
 *
 * The decision never silently passes: an article that is indexed but whose text
 * has not been transcribed is `unverified`, not `valid`. What a deployment does
 * with each decision is a policy choice.
 * @module @deepseek-ai/dsh-legal-law/verify
 */

import { decideArticleCitation } from '@deepseek-ai/dsh-law-core'
import { findLegalArticle } from './baseline.ts'
import { extractLegalLawReferences, formatLegalLawReference } from './reference.ts'
import type {
  LegalArticleEntry,
  LegalCitationDecision,
  LegalCitationFinding,
  LegalCitationPolicy,
  LegalCitationPolicySet,
  LegalLawBaseline,
  LegalLawName,
  LegalLawReference,
} from './types.ts'

/**
 * Default policy: a citation that cannot be checked blocks delivery. That
 * covers an article beyond the verified ceiling, a law or article the index
 * does not carry, and an indexed article whose text has not been transcribed.
 * `unmatched` stays a warning because no entry decides the proposition; a
 * deployment can relax any decision through `Config` when its corpus is
 * incomplete.
 */
export const DEFAULT_LEGAL_CITATION_POLICY: LegalCitationPolicySet = {
  mismatch: 'block',
  unmatched: 'warn',
  outOfRange: 'block',
  notIndexed: 'block',
  unverified: 'block',
}

/** Options for one verification call. */
export type LegalVerifyOptions = {
  /** The proposition the citation is offered in support of, when the caller has one. */
  proposition?: string
  /** Overlap a proposition must reach before an entry's text supports it. */
  supportThreshold?: number
}

/**
 * Verify one reference against the loaded index.
 * @param reference - the parsed reference.
 * @param baselines - the loaded index, keyed by law name.
 * @param options - the proposition the citation supports, when there is one.
 * @returns the finding, carrying the reason and the entry it used.
 */
export function verifyLegalCitation(
  reference: LegalLawReference,
  baselines: Map<LegalLawName, LegalLawBaseline>,
  options: LegalVerifyOptions = {},
): LegalCitationFinding {
  const baseline = baselines.get(reference.law)
  if (baseline === undefined) {
    return {
      raw: reference.raw,
      reference,
      decision: 'not-indexed',
      reason: `本次部署没有随包索引《${reference.law}》，该引用无法核验`,
    }
  }
  return verifyArticle(reference, baseline, options)
}

/**
 * Verify every reference in a text.
 * @param text - the text to scan and verify.
 * @param baselines - the loaded index, keyed by law name.
 * @param options - the proposition the text supports, when there is one.
 * @returns the findings, in order of appearance.
 */
export function verifyLegalCitations(
  text: string,
  baselines: Map<LegalLawName, LegalLawBaseline>,
  options: LegalVerifyOptions = {},
): LegalCitationFinding[] {
  return extractLegalLawReferences(text).map(reference => verifyLegalCitation(reference, baselines, options))
}

/**
 * Resolve how a finding is treated.
 * @param finding - the finding.
 * @param policies - the deployment's per-decision policy.
 * @returns `allow`, `warn`, or `block`.
 */
export function resolveLegalCitationPolicy(finding: LegalCitationFinding, policies: LegalCitationPolicySet): LegalCitationPolicy {
  if (finding.decision === 'valid') return 'allow'
  return policies[LEGAL_DECISION_POLICY_KEYS[finding.decision]]
}

/** Which policy field each non-`valid` decision reads. */
const LEGAL_DECISION_POLICY_KEYS: Record<Exclude<LegalCitationDecision, 'valid'>, keyof LegalCitationPolicySet> = {
  'mismatch': 'mismatch',
  'unmatched': 'unmatched',
  'out-of-range': 'outOfRange',
  'not-indexed': 'notIndexed',
  'unverified': 'unverified',
}

/**
 * Render the findings as a Markdown table for the model.
 * @param findings - the findings to render.
 * @param policies - the policy used, so each row states how it is treated.
 * @returns the Markdown report.
 */
export function renderLegalCitationFindings(findings: LegalCitationFinding[], policies: LegalCitationPolicySet): string {
  return renderLegalCitationRows(findings.map(finding => ({
    label: formatLegalLawReference(finding.reference),
    decision: finding.decision,
    policy: resolveLegalCitationPolicy(finding, policies),
    reason: finding.reason,
  })))
}

/** One rendered citation: what was cited, how it was decided, and how it is treated. */
export type LegalCitationRow = {
  /** The citation as it should be shown. */
  label: string
  decision: LegalCitationDecision
  policy: LegalCitationPolicy
  reason: string
}

/**
 * Render citation rows as a Markdown table.
 * @param rows - the rows to render.
 * @returns the Markdown report.
 */
export function renderLegalCitationRows(rows: LegalCitationRow[]): string {
  if (rows.length === 0) {
    return '未在文本中识别到法条引用。\n\n注意：没有引用不等于引用正确——结论性论断仍须给出可核验的来源。'
  }
  return [
    '| 引用 | 判定 | 处置 | 说明 |',
    '|---|---|---|---|',
    ...rows.map(row => `| ${cell(row.label)} | ${LEGAL_DECISION_LABELS[row.decision]} | ${LEGAL_POLICY_LABELS[row.policy]} | ${cell(row.reason)} |`),
  ].join('\n')
}

/** Escape a table cell so a proposition containing `|` cannot split the row. */
function cell(value: string): string {
  return value.replaceAll('|', '\\|')
}

const LEGAL_DECISION_LABELS: Record<LegalCitationDecision, string> = {
  'valid': '已核验',
  'mismatch': '与所引命题不符',
  'unmatched': '未与条文对应（未判定）',
  'out-of-range': '条号超出有效范围',
  'not-indexed': '索引中不存在',
  'unverified': '条文未转录（未核验）',
}

const LEGAL_POLICY_LABELS: Record<LegalCitationPolicy, string> = {
  block: '拦截',
  warn: '警告',
  allow: '放行',
}

/** Build one finding, omitting the entry when the decision used none. */
function finding(
  reference: LegalLawReference,
  decision: LegalCitationDecision,
  reason: string,
  entry?: LegalArticleEntry,
): LegalCitationFinding {
  return {
    raw: reference.raw,
    reference,
    decision,
    reason,
    ...(entry === undefined ? {} : { entry }),
  }
}

/** Verify one statute-article reference. */
function verifyArticle(
  reference: LegalLawReference,
  baseline: LegalLawBaseline,
  options: LegalVerifyOptions,
): LegalCitationFinding {
  const verdict = decideArticleCitation(
    reference,
    baseline,
    findLegalArticle(baseline, reference.article),
    options,
  )
  return finding(reference, verdict.decision, verdict.reason, verdict.entry)
}
