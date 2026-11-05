/**
 * Four-state validity citator: maps the six-state {@link CitationDecision} to
 * the coarser validity states (active / revised / repealed / unverified) a
 * legal-compliance layer needs.
 *
 * The mapping is fail-closed: every data gap — unverified transcription,
 * missing index, out-of-range article — reports `unverified` rather than
 * guessing at validity. A provision is `active` only when the shipped index
 * affirmatively shows it is in force; `revised` only when the index carries a
 * staleness or supersession record; `repealed` when an explicit repeal record
 * exists (currently none, reserved for M5-T1 snapshots).
 * @module @deepseek-ai/dsh-patent-law/citator
 */

import { findArticle, findSection } from './baseline.ts'
import { coversSection } from './section-path.ts'
import { parseLawReference } from './reference.ts'
import { queryArticleLineage } from './lineage.ts'
import type {
  LawBaseline,
  LawLineageSnapshot,
  LawName,
  LawReference,
  SectionEntry,
  StaleSection,
  ValidityQuery,
  ValidityResult,
} from './types.ts'

/**
 * Decide the four-state validity of a provision against the loaded index.
 *
 * The function first resolves the provision text to a parsed reference, then
 * walks the index to determine whether the provision is active, revised,
 * repealed, or unverified. A null return from the parser means the provision
 * text is not a recognised citation form, which is reported as unverified.
 * @param query - the provision text and optional temporal/revision narrowing.
 * @param baselines - the loaded law index, keyed by law name.
 * @param lineage - optional lineage snapshot whose article status overrides the baseline.
 * @returns the validity result.
 */
export function queryValidity(
  query: ValidityQuery,
  baselines: Map<LawName, LawBaseline>,
  lineage?: LawLineageSnapshot,
): ValidityResult {
  const reference = parseLawReference(query.provision)
  if (reference === null) {
    return {
      reference: fallbackReference(query.provision),
      state: 'unverified',
      reason: `无法将「${query.provision}」解析为已索引的法条引用形式`,
    }
  }
  return decideValidity(reference, baselines, query, lineage)
}

/**
 * Decide the four-state validity of a parsed reference.
 *
 * This is the lower-level entry point when the caller has already parsed the
 * reference. The mapping rules are:
 *
 * | State       | Rule |
 * |-------------|------|
 * | `active`    | Entry found, transcribed, not stale, not superseded, and its listed paragraphs contain the cited paragraph. |
 * | `revised`   | Entry found but in `staleSections`, or baseline `supersededBy` covers it, or a later version overrides it. |
 * | `repealed`  | Explicit repeal record (reserved; no current data path). |
 * | `unverified`| Entry missing, untranscribed, out of range, law not indexed, unknown revision, or an absent paragraph. |
 *
 * @param reference - the parsed law reference.
 * @param baselines - the loaded law index, keyed by law name.
 * @param query - optional temporal/revision narrowing.
 * @param lineage - optional lineage snapshot for statute article status override.
 * @returns the validity result.
 */
export function decideValidity(
  reference: LawReference,
  baselines: Map<LawName, LawBaseline>,
  query: Pick<ValidityQuery, 'revision' | 'asOf'> = {},
  lineage?: LawLineageSnapshot,
): ValidityResult {
  const baseline = baselines.get(reference.law)
  if (baseline === undefined) {
    return {
      reference,
      state: 'unverified',
      reason: `本次部署没有随包索引《${reference.law}》，该法条有效性无法判定`,
    }
  }
  if (reference.kind === 'guideline-section') {
    return decideSectionValidity(reference, baseline, query)
  }
  return decideArticleValidity(reference, baseline, lineage)
}

/**
 * Decide the validity of a statute article.
 *
 * A statute article is `active` when it is indexed and its text is transcribed.
 * It is `unverified` when the entry is missing, not transcribed, or beyond the
 * article ceiling. The `revised` and `repealed` states do not currently arise
 * for statutes because the index does not carry repeal records for them; when
 * such records are added (M5-T1), this function will map them.
 * When a lineage snapshot is provided, the article's status is overridden from
 * the lineage record and the revision history is reported.
 */
function decideArticleValidity(
  reference: Extract<LawReference, { kind: 'law-article' }>,
  baseline: LawBaseline,
  lineage?: LawLineageSnapshot,
): ValidityResult {
  const entry = findArticle(baseline, reference.article)
  if (entry === undefined) {
    // A ceiling (verified or not) proves the article is out of range;
    // a verified ceiling gives a stronger reason.
    if (baseline.maxArticle !== null && reference.article > baseline.maxArticle) {
      if (baseline.maxVerifiedOn !== null) {
        return {
          reference,
          state: 'unverified',
          reason: `《${baseline.law}》共 ${baseline.maxArticle} 条，第 ${reference.article} 条不存在`,
        }
      }
      return {
        reference,
        state: 'unverified',
        reason: `第 ${reference.article} 条超出索引声明的上限 ${baseline.maxArticle} 条，但该上限本身尚未核验`,
      }
    }
    return {
      reference,
      state: 'unverified',
      reason: `《${baseline.law}》第 ${reference.article} 条不在索引中`,
    }
  }
  // When lineage data is provided, check it before the transcription gate so
  // that a lineage record can override the unverified state from missing
  // transcription (e.g. a repealed article that was never transcribed).
  if (lineage !== undefined) {
    const articleLineage = queryArticleLineage(lineage, reference.article)
    if (articleLineage !== null) {
      const revisionHistory = articleLineage.revisionHistory.map(r => ({
        revision: r.revision,
        effectiveDate: r.effectiveDate,
      }))
      // An active article still cannot vouch for a paragraph the index knows does
      // not exist; the other lineage states already answer for the article.
      const gap = articleLineage.currentStatus === 'active' ? paragraphGap(reference, entry, baseline.law) : null
      if (gap !== null) return { reference, state: 'unverified', reason: gap, entry, revisionHistory }
      return {
        reference,
        state: articleLineage.currentStatus,
        reason: buildLineageReason(baseline.law, reference.article, articleLineage.currentStatus),
        entry,
        revisionHistory,
      }
    }
  }
  if (entry.text === null || entry.sourceDoc === null || entry.verifiedOn === null) {
    return {
      reference,
      state: 'unverified',
      reason: `《${baseline.law}》第 ${reference.article} 条已索引，但条文尚未转录核验`,
      entry,
    }
  }
  const gap = paragraphGap(reference, entry, baseline.law)
  if (gap !== null) return { reference, state: 'unverified', reason: gap, entry }

  return {
    reference,
    state: 'active',
    reason: `《${baseline.law}》第 ${reference.article} 条现行有效（来源：${entry.sourceDoc}）`,
    entry,
  }
}

/**
 * The reason a cited paragraph the entry knows to be absent cannot be accepted,
 * or null when the paragraph exists or the entry does not list its paragraphs.
 * @param reference - the parsed article reference.
 * @param entry - the indexed article.
 * @param law - the law name, as the reason states it.
 * @returns the reason, or null.
 */
function paragraphGap(
  reference: { paragraph?: number },
  entry: { article: number; paragraphs?: number[] },
  law: string,
): string | null {
  if (reference.paragraph === undefined || entry.paragraphs === undefined) return null
  if (entry.paragraphs.includes(reference.paragraph)) return null
  return `《${law}》第 ${entry.article} 条索引载明共 ${String(entry.paragraphs.length)} 款，不含第 ${String(reference.paragraph)} 款`
}

/**
 * Decide the validity of a guideline section.
 *
 * A section is `revised` when the baseline's `staleSections` cover it, or when
 * `supersededBy` is set and no transcribed version overrides the staleness. A
 * section is `active` when it is indexed, transcribed, and not stale. The
 * revision history is reported from the baseline's `versions` when any exist.
 */
function decideSectionValidity(
  reference: Extract<LawReference, { kind: 'guideline-section' }>,
  baseline: LawBaseline,
  query: Pick<ValidityQuery, 'revision'>,
): ValidityResult {
  // Resolve the version-aware view once and use it for all subsequent checks,
  // so the stale-section and supersededBy checks see the same sections the
  // verifier would see.
  const view = resolveGuidelineView(baseline, query.revision)
  if (view === null) {
    return {
      reference,
      state: 'unverified',
      reason: `索引中没有《专利审查指南》${query.revision} 的节正文，无法按该版本核验`,
    }
  }
  const entry = findSection(view, reference.path)

  // A section covered by staleSections is revised, regardless of whether the
  // text is transcribed.
  const stale = findStaleCoverage(view, reference.path)
  if (stale !== undefined) {
    return {
      reference,
      state: 'revised',
      reason: `《专利审查指南》${reference.path} 已被修改（${stale.reason}）`,
      ...(entry !== undefined ? { entry } : {}),
      ...historyRecord(baseline),
    }
  }

  // When supersededBy is set and no version overrides the stale mark, the
  // section is revised even if the entry itself is transcribed.
  if (view.supersededBy !== null && !hasVersionOverride(baseline, reference.path)) {
    return {
      reference,
      state: 'revised',
      reason: `《专利审查指南》${reference.path} 所属版本已被${view.supersededBy}取代`,
      ...(entry !== undefined ? { entry } : {}),
      ...historyRecord(baseline),
    }
  }

  // When the entry is not found in the resolved view, the section is not
  // indexed (for this revision).
  if (entry === undefined) {
    return {
      reference,
      state: 'unverified',
      reason: `《专利审查指南》${reference.path} 不在索引中`,
    }
  }
  if (entry.text === null || entry.sourceDoc === null || entry.verifiedOn === null) {
    return {
      reference,
      state: 'unverified',
      reason: `《专利审查指南》${reference.path} 已索引，但正文尚未转录核验`,
      entry,
    }
  }
  return {
    reference,
    state: 'active',
    reason: `《专利审查指南》${reference.path} 现行有效（来源：${entry.sourceDoc}）`,
    entry,
    ...historyRecord(baseline),
  }
}

/**
 * Resolve the guideline baseline view for a revision, mirroring the logic in
 * verify.ts but returning the baseline itself when no version merge is needed.
 *
 * When no revision is specified, the latest transcribed override is applied
 * automatically, matching the verifier's default behaviour. When the current
 * revision is transcribed, every version up to it is merged; when it is not,
 * the superseded revision is targeted instead. A revision the caller names but
 * the index does not carry selects nothing, so the citation is reported as
 * unverified rather than decided against the base text.
 * @returns the merged view, the base baseline, or null when the named revision is unknown.
 */
function resolveGuidelineView(baseline: LawBaseline, revision: string | undefined): LawBaseline | null {
  const current = baseline.supersededBy
  const transcribed = current === null || baseline.versions.some(v => v.revision === current)
  const target = revision ?? (transcribed ? baseline.versions.at(-1)?.revision : current) ?? null
  if (target === null || target === baseline.revision) return baseline
  const targetIndex = baseline.versions.findIndex(v => v.revision === target)
  if (targetIndex < 0) return revision === undefined ? baseline : null
  const applied = baseline.versions.slice(0, targetIndex + 1)
  const overridden = new Map<string, SectionEntry>()
  const added = new Map<string, SectionEntry>()
  const basePaths = new Set(baseline.sections.map(s => s.path))
  for (const version of applied) {
    for (const section of version.sections) {
      overridden.set(section.path, section)
      if (!basePaths.has(section.path)) added.set(section.path, section)
    }
  }
  return {
    ...baseline,
    sections: [
      ...baseline.sections.map(s => overridden.get(s.path) ?? s),
      ...added.values(),
    ].sort((a, b) => a.path.localeCompare(b.path)),
    // Intentionally cleared: the resolved view targets a single revision,
    // so downstream consumers should not recurse into version history.
    staleSections: baseline.staleSections.filter(s => !overridden.has(s.path)),
    versions: [],
  }
}

/** Find a stale-section record covering the path (parent or child). */
function findStaleCoverage(baseline: LawBaseline, path: string): StaleSection | undefined {
  return baseline.staleSections.find(stale =>
    coversSection(path, stale.path) || coversSection(stale.path, path))
}

/** Whether a version override touches the path or a parent of it. */
function hasVersionOverride(baseline: LawBaseline, path: string): boolean {
  return baseline.versions.some(version =>
    version.sections.some(s => coversSection(path, s.path) || coversSection(s.path, path)))
}

/** Build the revision history spread record; empty when no versions exist. */
function historyRecord(baseline: LawBaseline): { revisionHistory: Array<{ revision: string; effectiveDate: string }> } | {} {
  const history = buildRevisionHistory(baseline)
  return history !== undefined ? { revisionHistory: history } : {}
}

/** Build the revision history from a baseline's versions, when any exist. */
function buildRevisionHistory(baseline: LawBaseline): Array<{ revision: string; effectiveDate: string }> | undefined {
  if (baseline.versions.length === 0) return undefined
  return baseline.versions.map(version => ({
    revision: version.revision,
    effectiveDate: extractEffectiveDate(version.revision),
  }))
}

/**
 * Extract an effective date from a revision label, e.g.
 * `2026 年修订版（2026-01-01 施行）` → `2026-01-01`. Falls back to the revision
 * string itself when no date is embedded.
 */
function extractEffectiveDate(revision: string): string {
  const match = revision.match(/(\d{4}-\d{2}-\d{2})/u)
  return match !== null ? (match[1] as string) : revision
}

/**
 * Build a placeholder reference for a provision string the parser could not
 * resolve, so the result still carries a usable `raw` field.
 */
function fallbackReference(provision: string): LawReference {
  return {
    kind: 'guideline-section',
    law: '专利审查指南',
    path: provision,
    raw: provision,
  }
}

/**
 * Build a human-readable reason string for a lineage-derived status.
 */
function buildLineageReason(law: string, article: number, status: string): string {
  switch (status) {
    case 'active':
      return `《${law}》第 ${article} 条经沿革数据确认现行有效`
    case 'revised':
      return `《${law}》第 ${article} 条经沿革数据确认已被修订`
    case 'repealed':
      return `《${law}》第 ${article} 条经沿革数据确认已被废止`
    default:
      return `《${law}》第 ${article} 条沿革状态为${status}`
  }
}
