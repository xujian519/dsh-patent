/**
 * 法源覆盖门禁。
 *
 * 断言随包索引盖住记录的权威范围：专利法 82 条、细则 149 条、指南的编号标题、
 * 7 件司法解释与 8 件部门规章都有正文，且仓库里没有索引无法判定的引用。
 *
 * 用法：`pnpm exec tsx scripts/verify-patent-law-coverage.ts`
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  buildMetrics,
  parseGuidelineExtent,
  GUIDELINE_EXTENT_PATH,
  type CoverageRow,
} from './patent-authority-metrics.ts'

const ROOT = join(import.meta.dirname, '..')

const STATUTES: ReadonlyArray<readonly [string, number]> = [
  ['专利法', 82],
  ['专利法实施细则', 149],
]

const CORPORA: ReadonlyArray<readonly [string, number]> = [
  ['司法解释', 7],
  ['部门规章', 8],
]

/**
 * @param rows - coverage rows from the metrics measurement.
 * @param document - the row name.
 * @returns the row.
 */
function row(rows: readonly CoverageRow[], document: string): CoverageRow | undefined {
  return rows.find(candidate => candidate.document === document)
}

/**
 * Problems in a coverage measurement.
 * @param rows - the coverage rows.
 * @param unresolved - citations the index cannot decide.
 * @param guidelineHeadings - numbered headings recorded for the official PDF.
 * @param guidelineWithBody - headings recorded as carrying their own text.
 * @returns the problems.
 */
export function coverageProblems(
  rows: readonly CoverageRow[],
  unresolved: number,
  guidelineHeadings: number,
  guidelineWithBody: number,
): string[] {
  const problems: string[] = []
  requireFull(rows, STATUTES, problems, count => `${count}/${count} 且覆盖率 100.0%`)
  const guideline = row(rows, '专利审查指南')
  if (guideline === undefined) {
    problems.push('缺少专利审查指南的覆盖行')
  } else if (
    guideline.extent !== guidelineHeadings
    || guideline.indexed !== guidelineHeadings
    || guideline.transcribed !== guidelineWithBody
    || guideline.coverage !== '100.0%'
    || guidelineHeadings !== 1335
    || guidelineWithBody !== 1145
  ) {
    problems.push(`专利审查指南应为 1335 个编号标题、1145 节带正文、覆盖率 100.0%，实际范围 ${String(guideline.extent)}、索引 ${guideline.indexed}、正文 ${guideline.transcribed}、${guideline.coverage}`)
  }
  requireFull(rows, CORPORA, problems, count => `${count} 件且每件有正文`)
  if (unresolved !== 0) problems.push(`索引无法判定的引用应为 0，实际 ${unresolved}`)
  return problems
}

/**
 * @param rows - coverage rows.
 * @param expected - document name and required count.
 * @param problems - the problem list to append to.
 * @param label - how to describe the required count.
 */
function requireFull(
  rows: readonly CoverageRow[],
  expected: ReadonlyArray<readonly [string, number]>,
  problems: string[],
  label: (count: number) => string,
): void {
  for (const [document, count] of expected) {
    const found = row(rows, document)
    if (found === undefined) {
      problems.push(`缺少${document}的覆盖行`)
      continue
    }
    if (found.extent !== count || found.indexed !== count || found.transcribed !== count || found.coverage !== '100.0%') {
      problems.push(`${document} 应为 ${label(count)}，实际范围 ${String(found.extent)}、索引 ${found.indexed}、正文 ${found.transcribed}、${found.coverage}`)
    }
  }
}

/**
 * Check the packaged index.
 * @param root - repository root.
 * @returns the problems.
 */
export function checkPatentLawCoverage(root = ROOT): string[] {
  const extent = parseGuidelineExtent(readFileSync(join(root, GUIDELINE_EXTENT_PATH), 'utf8'))
  const metrics = buildMetrics(root)
  return coverageProblems(metrics.coverage, metrics.unresolved.length, extent.headings, extent.headingsWithBody)
}

/**
 * Print the problems and exit non-zero when the corpus invariant fails.
 */
function main(): void {
  const problems = checkPatentLawCoverage()
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem)
    process.exitCode = 1
    return
  }
  console.log('verify-patent-law-coverage: 专利法 82、细则 149、指南 1335、司法解释 7、部门规章 8')
}

if (process.argv[1]?.endsWith('verify-patent-law-coverage.ts')) main()
