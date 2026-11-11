/**
 * Decide one citation against the loaded law index.
 *
 * The decision never silently passes: an article that is indexed but whose text
 * has not been transcribed is `unverified`, not `valid`, and an article that is
 * beyond a *verified* article ceiling is `out-of-range`. What a deployment does
 * with each decision is a policy choice, so the decisions stay separate from the
 * policies that act on them.
 * @module @deepseek-ai/dsh-patent-law/verify
 */

import {
  decideArticleCitation,
  findCompetingLabels,
  formatPercent,
  missingIndexReason,
  renderCitationDecisionRows,
  resolveCitationDecisionPolicy,
  supportMismatchReason,
  transcribedText,
  truncateProposition,
} from '@deepseek-ai/dsh-patent-core'
import { findArticle, findSection } from './baseline.ts'
import { coversSection } from './section-path.ts'
import { extractLawReferences, formatLawReference } from './reference.ts'
import {
  createOverlapIndex,
  PROPOSITION_SUPPORT_DEFAULT,
  textOverlap,
  topicOverlap,
  type ComparableEntry,
  type OverlapIndex,
} from './support.ts'
import type {
  ArticleEntry,
  CitationDecision,
  CitationFinding,
  CitationPolicy,
  CitationPolicySet,
  LawBaseline,
  LawName,
  LawReference,
  SectionEntry,
  StaleSection,
} from './types.ts'

/**
 * Default policy: an article beyond a verified ceiling, or a proposition that
 * contradicts a verified article, blocks; an entry whose text is still awaiting
 * transcription, and a proposition no entry carries, are reported without
 * blocking, so a partially transcribed index stays usable while every gap in it
 * is visible.
 */
export const DEFAULT_CITATION_POLICY: CitationPolicySet = {
  mismatch: 'block',
  unmatched: 'warn',
  outOfRange: 'block',
  notIndexed: 'warn',
  unverified: 'warn',
}

/** Options for one verification call. */
export type VerifyOptions = {
  /** The proposition the citation is offered in support of, when the caller has one. */
  proposition?: string
  /** Overlap a proposition must reach before an entry's text supports it; defaults to {@link PROPOSITION_SUPPORT_DEFAULT}. */
  supportThreshold?: number
  /**
   * Guideline revision to decide against, e.g. `2026 年修订版（2026-01-01 施行）`.
   * Defaults to the last transcribed override when the current revision is
   * transcribed; when `supersededBy` names a revision the index has not
   * transcribed, the base text and its stale marks decide. Naming the base
   * revision decides against that base text.
   */
  revision?: string
}

/**
 * Verify one reference against the loaded index.
 * @param reference - the parsed reference.
 * @param baselines - the loaded index, keyed by law name.
 * @param options - the proposition the citation supports, when there is one.
 * @returns the finding, carrying the reason and the entry it used.
 */
export function verifyCitation(
  reference: LawReference,
  baselines: Map<LawName, LawBaseline>,
  options: VerifyOptions = {},
): CitationFinding {
  const baseline = baselines.get(reference.law)
  if (baseline === undefined) {
    return {
      raw: reference.raw,
      reference,
      decision: 'not-indexed',
      reason: missingIndexReason(reference.law),
    }
  }
  if (reference.kind === 'guideline-section') return verifySection(reference, baseline, options)
  return verifyArticle(reference, baseline, options)
}

/**
 * Verify every reference in a text.
 * @param text - the text to scan and verify.
 * @param baselines - the loaded index, keyed by law name.
 * @param options - the proposition the text supports, when there is one.
 * @returns the findings, in order of appearance.
 */
export function verifyCitations(
  text: string,
  baselines: Map<LawName, LawBaseline>,
  options: VerifyOptions = {},
): CitationFinding[] {
  return extractLawReferences(text).map(reference => verifyCitation(reference, baselines, options))
}

/**
 * Resolve how a finding is treated.
 *
 * The decision union is closed and the map below is exhaustive over it, so a new
 * decision fails to compile until it is given a policy.
 * @param finding - the finding.
 * @param policies - the deployment's per-decision policy.
 * @returns `allow`, `warn`, or `block`.
 */
export function resolveCitationPolicy(finding: CitationFinding, policies: CitationPolicySet): CitationPolicy {
  return resolveCitationDecisionPolicy(finding.decision, policies)
}

/**
 * Render the findings as a Markdown table for the model.
 * @param findings - the findings to render.
 * @param policies - the policy used, so each row states how it is treated.
 * @returns the Markdown report.
 */
export function renderCitationFindings(findings: CitationFinding[], policies: CitationPolicySet): string {
  return renderCitationRows(findings.map(finding => ({
    label: formatLawReference(finding.reference),
    decision: finding.decision,
    policy: resolveCitationPolicy(finding, policies),
    reason: finding.reason,
  })))
}

/** One rendered citation: what was cited, how it was decided, and how it is treated. */
export type CitationRow = {
  /** The citation as it should be shown. */
  label: string
  decision: CitationDecision
  policy: CitationPolicy
  reason: string
}

/**
 * Render citation rows as a Markdown table.
 * @param rows - the rows to render.
 * @returns the Markdown report.
 */
export function renderCitationRows(rows: CitationRow[]): string {
  return renderCitationDecisionRows(rows)
}

/** Build one finding, omitting the entry when the decision used none. */
function finding(
  reference: LawReference,
  decision: CitationDecision,
  reason: string,
  entry?: ArticleEntry | SectionEntry,
): CitationFinding {
  return {
    raw: reference.raw,
    reference,
    decision,
    reason,
    ...(entry === undefined ? {} : { entry }),
  }
}

/** Merged guideline views, keyed by baseline and the requested revision (empty for the default). */
const guidelineViews = new WeakMap<LawBaseline, Map<string, LawBaseline | null>>()

/**
 * Resolve the guideline baseline to the requested revision.
 *
 * Without a revision, the latest transcribed override is targeted and every
 * transcribed override up to it is applied oldest first; a version that names
 * only some sections leaves the rest at the text the previous version set.
 * With a revision,
 * the base revision selects the base text and an unknown revision selects
 * nothing, so the caller gets an unverified finding instead of a silent
 * fallback.
 * @param baseline - the loaded guideline baseline.
 * @param revision - the requested revision, or undefined for the latest.
 * @returns the merged baseline, the base baseline, or null when the revision is unknown.
 */
function guidelineView(baseline: LawBaseline, revision: string | undefined): LawBaseline | null {
  const key = revision === undefined ? '' : `revision:${revision}`
  let cached = guidelineViews.get(baseline)
  if (cached === undefined) {
    cached = new Map()
    guidelineViews.set(baseline, cached)
  }
  const cachedView = cached.get(key)
  if (cachedView !== undefined) return cachedView
  const view = buildGuidelineView(baseline, revision)
  cached.set(key, view)
  return view
}

/** Build one merged guideline view; see {@link guidelineView}. */
function buildGuidelineView(baseline: LawBaseline, revision: string | undefined): LawBaseline | null {
  // Use the newest transcription when the current revision is among the transcribed
  // ones. When `supersededBy` names a revision no version covers, target that
  // revision so the base text's stale marks stay in force.
  const latest = baseline.versions.at(-1)?.revision
  const current = baseline.supersededBy
  const transcribed = current === null || baseline.versions.some(version => version.revision === current)
  const target = revision ?? (transcribed ? latest : current) ?? null
  if (target === null || target === baseline.revision) return baseline
  const targetIndex = baseline.versions.findIndex(candidate => candidate.revision === target)
  if (targetIndex < 0) return revision === undefined ? baseline : null
  // Apply every transcribed override up to the target, oldest first. A later
  // revision that changes only some sections must not drop an earlier one's
  // changes.
  const applied = baseline.versions.slice(0, targetIndex + 1)
  const overridden = new Map<string, SectionEntry>()
  const added = new Map<string, SectionEntry>()
  const basePaths = new Set(baseline.sections.map(section => section.path))
  for (const version of applied) {
    for (const section of version.sections) {
      overridden.set(section.path, section)
      if (!basePaths.has(section.path)) added.set(section.path, section)
    }
  }
  const sections = [
    ...baseline.sections.map(section => overridden.get(section.path) ?? section),
    ...added.values(),
  ].sort((a, b) => a.path.localeCompare(b.path))
  return {
    ...baseline,
    sections,
    staleSections: baseline.staleSections.filter(stale => !overridden.has(stale.path)),
    versions: [],
  }
}

/** The overlap indices of the guideline baselines, so a baseline's texts are indexed once. */
const overlapIndices = new WeakMap<LawBaseline, OverlapIndex>()

/**
 * Get the overlap index of one baseline.
 * @param baseline - the loaded baseline.
 * @returns its index, built on first use.
 */
function overlapIndex(baseline: LawBaseline): OverlapIndex {
  const cached = overlapIndices.get(baseline)
  if (cached !== undefined) return cached
  const built = createOverlapIndex(comparableEntries(baseline))
  overlapIndices.set(baseline, built)
  return built
}

/**
 * List every entry of a baseline as a proposition candidate.
 * @param baseline - the loaded baseline.
 * @returns the law's articles or its guideline sections.
 */
function comparableEntries(baseline: LawBaseline): ComparableEntry[] {
  return baseline.sections.map(section => ({
    label: section.path,
    topics: section.topics,
    text: transcribedText(section),
  }))
}

/** Verify one statute-article reference. */
function verifyArticle(
  reference: Extract<LawReference, { kind: 'law-article' }>,
  baseline: LawBaseline,
  options: VerifyOptions,
): CitationFinding {
  const verdict = decideArticleCitation(
    reference,
    baseline,
    findArticle(baseline, reference.article),
    options,
  )
  return finding(reference, verdict.decision, verdict.reason, verdict.entry)
}

/** Verify one guideline-section reference. */
function verifySection(
  reference: Extract<LawReference, { kind: 'guideline-section' }>,
  baseline: LawBaseline,
  options: VerifyOptions,
): CitationFinding {
  const view = guidelineView(baseline, options.revision)
  if (view === null) {
    return finding(
      reference,
      'unverified',
      `索引中没有《专利审查指南》${options.revision} 的节正文，无法按该版本核验`,
    )
  }
  const entry = findSection(view, reference.path)
  if (entry === undefined) {
    return finding(reference, 'not-indexed', `《专利审查指南》${reference.path} 不在索引中`)
  }
  // A citation covering a section whose shipped text predates the current
  // revision cannot be verified against current law, even when its wording
  // matches the old text.
  const stale = staleSectionFor(view, reference.path)
  if (stale !== undefined) {
    const current = view.supersededBy ?? '新版《专利审查指南》'
    return finding(
      reference,
      'unverified',
      `《专利审查指南》${reference.path} 涉及已被${current}修改的 ${stale.path}（${stale.reason}），随包文本不能按现行条文核验`,
      entry,
    )
  }
  const candidates = sectionTexts(view, reference.path)
  if (candidates.length === 0) {
    return finding(
      reference,
      'unverified',
      `《专利审查指南》${reference.path} 已索引，但本节及其子节的正文尚未转录核验`,
      entry,
    )
  }
  return decideSection(reference, entry, candidates, view, options)
}

/**
 * The transcribed texts one guideline citation covers: the cited section's own
 * body and every subsection under it.
 *
 * A citation to a section covers what its subsections say, so the proposition is
 * matched against the whole section. A part or chapter carries no text of its own
 * and is decided by its sections alone.
 * @param baseline - the guideline baseline.
 * @param path - the cited normalized section path.
 * @returns the texts to match against, the cited section first when it has one.
 */
function sectionTexts(baseline: LawBaseline, path: string): Array<ComparableEntry & { text: string }> {
  return comparableEntries(baseline)
    .filter((entry): entry is ComparableEntry & { text: string } =>
      entry.text !== null && coversSection(path, entry.label))
}

/**
 * Find the stale-text record a citation covers.
 *
 * A citation to a parent section covers the stale subsection, and a citation to
 * a subsection inherits a stale ancestor, so both directions count. Returns
 * undefined when the index targets the current revision or the cited path is
 * unaffected.
 * @param baseline - the guideline baseline.
 * @param path - the cited normalized section path.
 * @returns the stale record covering or inherited by the path, when one exists.
 */
function staleSectionFor(baseline: LawBaseline, path: string): StaleSection | undefined {
  return baseline.staleSections.find(stale =>
    coversSection(path, stale.path) || coversSection(stale.path, path))
}

/**
 * Decide a guideline citation. A proposition its own section carries is supported;
 * so is one carried by a subsection, which the citation covers; so is one whose
 * subject the section's topic keywords name. Only when none of those hold, and an
 * unrelated entry of the guideline carries the proposition, is the citation
 * reported as a mismatch.
 * @param reference - the parsed reference.
 * @param entry - the indexed section the reference resolved to.
 * @param candidates - the transcribed texts of the section and its subsections.
 * @param baseline - the guideline's baseline, whose other entries are the competing homes.
 * @param options - the proposition and the support threshold.
 * @returns the finding.
 */
function decideSection(
  reference: Extract<LawReference, { kind: 'guideline-section' }>,
  entry: SectionEntry,
  candidates: readonly (ComparableEntry & { text: string })[],
  baseline: LawBaseline,
  options: VerifyOptions,
): CitationFinding {
  const proposition = options.proposition?.trim()
  const hasOwn = candidates.some(candidate => candidate.label === reference.path)
  if (proposition === undefined || proposition === '') {
    return finding(reference, 'valid', sectionReason(reference.path, entry, null, hasOwn), entry)
  }
  // A container has no text of its own, but its topic keywords still name the
  // subject; without this, a topic could make a citation fail as a competing
  // home yet never let the cited container pass.
  if (!hasOwn && topicOverlap(entry.topics, proposition)) {
    return finding(
      reference,
      'valid',
      `与《专利审查指南》${reference.path} 一致（本节正文未单独转录，本节主题词覆盖该命题）`,
      entry,
    )
  }
  const threshold = options.supportThreshold ?? PROPOSITION_SUPPORT_DEFAULT
  const index = overlapIndex(baseline)
  const scored = candidates.map(candidate => ({
    candidate,
    score: textOverlap(index, proposition, candidate.text),
  }))
  const carrier = scored.find(({ candidate, score }) =>
    score >= threshold || topicOverlap(candidate.topics, proposition))
  if (carrier !== undefined) {
    return finding(
      reference,
      'valid',
      sectionReason(reference.path, entry, carrier.candidate.label, hasOwn),
      entry,
    )
  }
  const elsewhere = findCompetingLabels(
    comparableEntries(baseline),
    index,
    proposition,
    threshold,
    reference.path,
    label => coversSection(reference.path, label),
  )
  if (elsewhere.length > 0) {
    return finding(reference, 'mismatch', supportMismatchReason(baseline.law, proposition, elsewhere), entry)
  }
  const best = Math.max(0, ...scored.map(candidate => candidate.score))
  return finding(
    reference,
    'unmatched',
    hasOwn
      ? `本节及其子节的文本与命题「${truncateProposition(proposition)}」的字面重合 ${formatPercent(best)}，低于支撑阈值 ${formatPercent(threshold)}，且本索引中没有条目支撑该命题——请核对节号或改写命题`
      : `《专利审查指南》${reference.path} 的节正文未转录，其下已转录的各节与命题「${truncateProposition(proposition)}」都不相符——请核对节号或改写命题`,
    entry,
  )
}

/** The reason a supported guideline citation reports. */
function sectionReason(path: string, entry: SectionEntry, carrier: string | null, hasOwn: boolean): string {
  if (!hasOwn) {
    return carrier === null
      ? `与《专利审查指南》${path} 一致（本节正文未单独转录，判定依据其下各节）`
      : `与《专利审查指南》${path} 一致（本节正文未单独转录，命题由其下的 ${carrier} 承载）`
  }
  if (carrier !== null && carrier !== path) {
    return `与《专利审查指南》${path} 一致（命题由本节下的 ${carrier} 承载）`
  }
  return `与《专利审查指南》${path} 一致（来源：${entry.sourceDoc as string}）`
}
