/**
 * 法源时效门禁。
 *
 * 指南的基础文本是 2023 年修订版，现行修订由 `supersededBy` 指向 2026 年修订版。
 * 六条旧编号路径留在 `staleSections`。其中未被现行覆盖替换的路径核验为未核验，
 * 已转录的现行节仍可判为成立。
 *
 * 用法：`pnpm exec tsx scripts/verify-patent-law-freshness.ts`
 */

import { loadLawBaselines, parseLawReference, verifyCitation } from '@deepseek-ai/dsh-patent-law'

/** The revision the index names as current. */
export const CURRENT_GUIDELINE_REVISION = '2026 年修订版（2026-01-01 施行）'

/** Old paths whose 2023 numbering no longer matches the current edition. */
export const STALE_GUIDELINE_PATHS = [
  '第二部分第九章6.1.1',
  '第二部分第九章6.1.2',
  '第二部分第九章6.1.3',
  '第五部分第二章4.2.1.3',
  '第五部分第七章8.3',
  '第五部分第七章8.4',
]

/** A path the default view must still refuse. */
export const UNVERIFIED_STALE_PATH = '第五部分第二章4.2.1.3'

/** A path the current revision has transcribed. */
export const CURRENT_SECTION_PATH = '第一部分第一章4.1.2'

/** One freshness reading. */
export type FreshnessSnapshot = {
  /** Base revision label. */
  revision: string
  /** Revision that supersedes the base, when the index names one. */
  supersededBy: string | null
  /** Stale section paths. */
  stalePaths: string[]
  /** Revision labels carried in `versions`. */
  versionRevisions: string[]
  /** Decision for the old path that must stay unverified. */
  staleDecision: string
  /** Decision for the transcribed current section. */
  currentDecision: string
}

/**
 * Problems in a freshness reading.
 * @param snapshot - the reading.
 * @returns the problems.
 */
export function freshnessProblems(snapshot: FreshnessSnapshot): string[] {
  const problems: string[] = []
  if (!snapshot.revision.includes('2023')) problems.push(`指南基础修订应为 2023 年修订版，实际 ${snapshot.revision}`)
  if (snapshot.supersededBy !== CURRENT_GUIDELINE_REVISION) {
    problems.push(`指南现行修订应为 ${CURRENT_GUIDELINE_REVISION}，实际 ${snapshot.supersededBy ?? '未声明'}`)
  }
  const stale = [...snapshot.stalePaths].sort()
  const expected = [...STALE_GUIDELINE_PATHS].sort()
  if (stale.join('\n') !== expected.join('\n')) {
    problems.push(`失效路径应为 ${expected.join('、')}，实际 ${stale.join('、')}`)
  }
  if (!snapshot.versionRevisions.includes(CURRENT_GUIDELINE_REVISION)) {
    problems.push(`versions 应包含 ${CURRENT_GUIDELINE_REVISION}`)
  }
  if (snapshot.staleDecision !== 'unverified') {
    problems.push(`${UNVERIFIED_STALE_PATH} 应为 unverified，实际 ${snapshot.staleDecision}`)
  }
  if (snapshot.currentDecision !== 'valid') {
    problems.push(`${CURRENT_SECTION_PATH} 应为 valid，实际 ${snapshot.currentDecision}`)
  }
  return problems
}

/**
 * Read the packaged guideline index.
 * @returns the freshness reading.
 */
export function readFreshnessSnapshot(): FreshnessSnapshot {
  const baselines = loadLawBaselines()
  const baseline = baselines.get('专利审查指南')
  if (baseline === undefined) {
    return {
      revision: '',
      supersededBy: null,
      stalePaths: [],
      versionRevisions: [],
      staleDecision: 'missing',
      currentDecision: 'missing',
    }
  }
  const staleReference = parseLawReference(`专利审查指南${UNVERIFIED_STALE_PATH}`)
  const currentReference = parseLawReference(`专利审查指南${CURRENT_SECTION_PATH}`)
  const staleDecision = staleReference === null
    ? 'unparsed'
    : verifyCitation(staleReference, baselines).decision
  const currentDecision = currentReference === null
    ? 'unparsed'
    : verifyCitation(currentReference, baselines, {
      proposition: '发明人是指对发明创造的实质性特点作出创造性贡献的人',
    }).decision
  return {
    revision: baseline.revision ?? '',
    supersededBy: baseline.supersededBy,
    stalePaths: baseline.staleSections.map(section => section.path),
    versionRevisions: baseline.versions.map(version => version.revision),
    staleDecision,
    currentDecision,
  }
}

/**
 * Check the packaged guideline index.
 * @returns the problems.
 */
export function checkPatentLawFreshness(): string[] {
  return freshnessProblems(readFreshnessSnapshot())
}

/**
 * Print the problems and exit non-zero when the currency invariant fails.
 */
function main(): void {
  const problems = checkPatentLawFreshness()
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem)
    process.exitCode = 1
    return
  }
  console.log('verify-patent-law-freshness: 2026 年修订为现行版，六条旧编号路径仍标为失效')
}

if (process.argv[1]?.endsWith('verify-patent-law-freshness.ts')) main()
