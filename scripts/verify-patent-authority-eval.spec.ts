/**
 * The packaged authority evaluation scores thirty tasks against the index.
 *
 * A forbidden phrase in an answer, or a missing task, fails the exit. The
 * committed report is the same text the scorer renders.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  AUTHORITY_EVAL_REPORT_PATH,
  AUTHORITY_EVAL_TASKS_PATH,
  citationAccuracy,
  evalProblems,
  loadAuthorityEval,
  loadEvalContext,
  renderAuthorityEvalReport,
  scoreAuthorityEval,
} from './verify-patent-authority-eval.ts'

const root = join(import.meta.dirname, '..')
const doc = loadAuthorityEval(readFileSync(join(root, AUTHORITY_EVAL_TASKS_PATH), 'utf8'))
const ctx = loadEvalContext()

describe('authority evaluation', () => {
  it('scores the packaged thirty tasks at the exit thresholds', () => {
    const score = scoreAuthorityEval(doc, ctx)
    expect(evalProblems(doc, score, ctx)).toEqual([])
    expect(score.taskCount).toBe(30)
    expect(citationAccuracy(score)).toBe(1)
    expect(score.supportHit).toBe(score.supportTotal)
    expect(score.currencyHit).toBe(score.currencyTotal)
    expect(score.refusalHit).toBe(score.refusalTotal)
    expect(score.rankHit).toBe(score.rankTotal)
    expect(score.wrongFormulations).toBe(0)
    const withdrawal = score.probes.find(probe => probe.taskId === 'reexamination-04' && probe.role === 'refusal')
    expect(withdrawal?.actual).toBe('mismatch')
    const stale = score.probes.find(probe => probe.raw.includes('4.2.1.3') && probe.expect === 'unverified')
    expect(stale?.actual).toBe('unverified')
    const oldEvidence = score.probes.find(probe => probe.raw === '民事诉讼法第63条')
    expect(oldEvidence?.actual).toBe('mismatch')
  })

  it('rejects an answer that contains a forbidden formulation', () => {
    const mutated = structuredClone(doc)
    const task = mutated.tasks.find(candidate => candidate.id === 'drafting-01')
    if (task === undefined) throw new Error('drafting-01 不在清单中')
    task.answer += task.forbidden[0] ?? ''
    const score = scoreAuthorityEval(mutated, ctx)
    expect(evalProblems(mutated, score, ctx).some(problem => problem.includes('错误口径'))).toBe(true)
  })

  it('rejects an inventory that drops a task', () => {
    const mutated = structuredClone(doc)
    mutated.tasks.pop()
    const score = scoreAuthorityEval(mutated, ctx)
    expect(evalProblems(mutated, score, ctx).some(problem => problem.includes('必须是 30 个'))).toBe(true)
  })

  it('matches the committed report', () => {
    const score = scoreAuthorityEval(doc, ctx)
    const report = readFileSync(join(root, AUTHORITY_EVAL_REPORT_PATH), 'utf8')
    expect(report).toBe(renderAuthorityEvalReport(score))
  })
})
