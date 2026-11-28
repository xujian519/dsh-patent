/**
 * Resolve a guideline baseline to the revision being decided, and find the
 * stale-text records a cited path covers.
 *
 * Both the citation verifier and the validity citator ask these two questions,
 * so the merge and coverage rules live here. The verifier adds its own cache on
 * top; the rules themselves stay in one place.
 * @module @deepseek-ai/dsh-patent-law/guideline-view
 */

import { coversSection } from './section-path.ts'
import type { LawBaseline, SectionEntry, StaleSection } from './types.ts'

/**
 * Resolve the guideline baseline view for a revision.
 *
 * Without a revision, the latest transcribed override is applied
 * automatically. When the current revision is transcribed, every version up to
 * it is merged oldest first; when it is not, the superseded revision is
 * targeted instead. A revision the caller names but the index does not carry
 * selects nothing, so the citation is reported as unverified rather than
 * decided against the base text.
 * @param baseline - the loaded guideline baseline.
 * @param revision - the requested revision, or undefined for the latest.
 * @returns the merged view, the base baseline, or null when the named revision is unknown.
 */
export function resolveGuidelineView(baseline: LawBaseline, revision: string | undefined): LawBaseline | null {
  const current = baseline.supersededBy
  const transcribed = current === null || baseline.versions.some(version => version.revision === current)
  const target = revision ?? (transcribed ? baseline.versions.at(-1)?.revision : current) ?? null
  if (target === null || target === baseline.revision) return baseline
  const targetIndex = baseline.versions.findIndex(version => version.revision === target)
  if (targetIndex < 0) return revision === undefined ? baseline : null
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
  return {
    ...baseline,
    sections: [
      ...baseline.sections.map(section => overridden.get(section.path) ?? section),
      ...added.values(),
    ].sort((a, b) => a.path.localeCompare(b.path)),
    // Intentionally cleared: the resolved view targets a single revision, so
    // downstream consumers should not recurse into version history.
    staleSections: baseline.staleSections.filter(stale => !overridden.has(stale.path)),
    versions: [],
  }
}

/**
 * Find the stale-text record a citation covers.
 *
 * A citation to a parent section covers the stale subsection, and a citation to
 * a subsection inherits a stale ancestor, so both directions count.
 * @param baseline - the guideline baseline.
 * @param path - the cited normalized section path.
 * @returns the stale record covering or inherited by the path, when one exists.
 */
export function staleSectionFor(baseline: LawBaseline, path: string): StaleSection | undefined {
  return baseline.staleSections.find(stale =>
    coversSection(path, stale.path) || coversSection(stale.path, path))
}
