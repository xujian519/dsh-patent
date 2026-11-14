/**
 * The closeout gates lock the corpus, the guideline currency, the amendment
 * rehearsal, and the Phase 0 comparison table.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { CoverageRow } from './patent-authority-metrics.ts'
import { rehearsalProblems } from './rehearse-patent-amendment.ts'
import {
  AUTHORITY_CLOSEOUT_REPORT_PATH,
  checkPatentAuthorityCloseout,
  closeoutRows,
} from './verify-patent-authority-closeout.ts'
import { coverageProblems } from './verify-patent-law-coverage.ts'
import { freshnessProblems, type FreshnessSnapshot } from './verify-patent-law-freshness.ts'

const root = join(import.meta.dirname, '..')

function row(document: string, extent: number, indexed: number, transcribed: number, coverage: string): CoverageRow {
  return { document, extent, indexed, transcribed, coverage, source: 'test' }
}

const completeRows: CoverageRow[] = [
  row('专利法', 82, 82, 82, '100.0%'),
  row('专利法实施细则', 149, 149, 149, '100.0%'),
  row('专利审查指南', 1335, 1335, 1145, '100.0%'),
  row('司法解释', 7, 7, 7, '100.0%'),
  row('部门规章', 8, 8, 8, '100.0%'),
]

const current: FreshnessSnapshot = {
  revision: '2023 年修订版（2024-01-20 施行）',
  supersededBy: '2026 年修订版（2026-01-01 施行）',
  stalePaths: [
    '第二部分第九章6.1.1',
    '第二部分第九章6.1.2',
    '第二部分第九章6.1.3',
    '第五部分第二章4.2.1.3',
    '第五部分第七章8.3',
    '第五部分第七章8.4',
  ],
  versionRevisions: ['2026 年修订版（2026-01-01 施行）'],
  staleDecision: 'unverified',
  currentDecision: 'valid',
}

describe('authority closeout', () => {
  it('rejects a statute that drops below the recorded extent', () => {
    const rows = completeRows.map(entry => entry.document === '专利法' ? { ...entry, indexed: 81, coverage: '98.8%' } : entry)
    expect(coverageProblems(rows, 0, 1335, 1145).some(problem => problem.includes('专利法'))).toBe(true)
  })

  it('rejects a freshness reading that drops the current revision', () => {
    expect(freshnessProblems({ ...current, supersededBy: null }).some(problem => problem.includes('现行修订'))).toBe(true)
  })

  it('names a failed amendment step', () => {
    expect(rehearsalProblems(['rules'])).toEqual(['修法步骤未通过：rules'])
  })

  it('keeps the eight Phase 0 rows in order', () => {
    const rows = closeoutRows({
      patentLaw: '100.0%',
      regulations: '100.0%',
      guideline: '100.0%',
      freshnessProblems: 0,
      citationProblems: 0,
      unstructured: 38,
      wrongFormulations: 0,
      tasks: 30,
      citationAccuracy: '100.0%',
    })
    expect(rows.map(entry => entry.id)).toEqual([
      'patent-law',
      'implementing-regulations',
      'guideline',
      'revision',
      'interpretations-regulations',
      'rule-references',
      'known-errors',
      'golden-tasks',
    ])
    expect(rows.find(entry => entry.id === 'rule-references')?.reading).toContain('38')
  })

  it('matches the packaged corpus, rehearsal, and committed report', () => {
    const { report, problems } = checkPatentAuthorityCloseout(root)
    expect(problems).toEqual([])
    expect(readFileSync(join(root, AUTHORITY_CLOSEOUT_REPORT_PATH), 'utf8')).toBe(report)
  }, 180_000)
})
