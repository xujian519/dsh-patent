import { describe, expect, it } from 'vitest'
import { BenchmarkId, CaseId } from '../src/brand.ts'
import {
  ContaminationError,
  PRIVATE_FIELD_NAMES,
  assertNoPrivateLeak,
  publicBenchmarkView,
} from '../src/contamination.ts'
import type { BoundBenchmark } from '../src/types.ts'

describe('public benchmark view', () => {
  it('drops every private rubric from the optimizer-facing surface', () => {
    const benchmark: BoundBenchmark = {
      id: BenchmarkId('b'),
      title: 'Bench',
      optimizable: true,
      cases: [
        { caseId: CaseId('c1'), statement: 'Task', rubric: 'secret rubric' },
        { caseId: CaseId('c2'), statement: 'Task two' },
      ],
    }
    // optimizable 是引擎在优化前读取的元数据，不进 optimizer 面向的视图。
    expect(publicBenchmarkView(benchmark)).toEqual({
      id: BenchmarkId('b'),
      title: 'Bench',
      cases: [
        { caseId: CaseId('c1'), statement: 'Task' },
        { caseId: CaseId('c2'), statement: 'Task two' },
      ],
    })
  })
})

describe('contamination guard', () => {
  it('covers the private field vocabulary and constructs a labeled error', () => {
    expect(PRIVATE_FIELD_NAMES).toEqual(['rubric', 'rubrics', 'gold', 'goldAnswer', 'expectedAnswer'])
    const error = new ContaminationError('ctx', 'rubric')
    expect(error.name).toBe('ContaminationError')
    expect(error.message).toMatch(/ctx/)
    expect(error.message).toMatch(/rubric/)
  })

  it('passes scalar, null, and clean nested values', () => {
    expect(() => {
      assertNoPrivateLeak(null, 'ctx')
    }).not.toThrow()
    expect(() => {
      assertNoPrivateLeak(undefined, 'ctx')
    }).not.toThrow()
    expect(() => {
      assertNoPrivateLeak('text', 'ctx')
    }).not.toThrow()
    expect(() => {
      assertNoPrivateLeak(42, 'ctx')
    }).not.toThrow()
    expect(() => {
      assertNoPrivateLeak({ cases: [{ statement: 'a' }, { statement: 'b' }], meta: { notes: ['x'] } }, 'ctx')
    }).not.toThrow()
    expect(() => {
      assertNoPrivateLeak([{ a: 1 }, ['deep', { b: 2 }]], 'ctx')
    }).not.toThrow()
  })

  it('rejects a private field at the top level and at any depth', () => {
    expect(() => {
      assertNoPrivateLeak({ statement: 'a', rubric: 'secret' }, 'ctx')
    }).toThrow(ContaminationError)
    expect(() => {
      assertNoPrivateLeak({ cases: [{ statement: 'a' }, { goldAnswer: 'secret' }] }, 'ctx')
    }).toThrow(ContaminationError)
    expect(() => {
      assertNoPrivateLeak({ nested: { deeper: [{ expectedAnswer: 'secret' }] } }, 'ctx')
    }).toThrow(/expectedAnswer/)
  })
})
