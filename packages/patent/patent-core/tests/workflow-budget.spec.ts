import { describe, expect, it } from 'vitest'
import {
  AtomRegistry,
  countWorkflowLlmStages,
  validateWorkflowBudget,
  type WorkflowManifest,
  type WorkflowStage,
} from '@deepseek-ai/dsh-patent-core'
import { compareAtom } from '../src/atoms/handlers/builtin/compare.ts'
import { searchAtom } from '../src/atoms/handlers/builtin/search.ts'
import { timeBaselineAtom } from '../src/atoms/handlers/builtin/time-baseline.ts'
import type { WorkflowStageBudget } from '../src/workflow/budget.ts'

function stage(id: string, atom?: string): WorkflowStage {
  return { id, strategy: 'chain', description: id, ...(atom !== undefined ? { atom } : {}) }
}

function manifest(stages: WorkflowStage[], id = 'test_manifest'): WorkflowManifest {
  return { id, name: '测试', caseType: 'test', stages }
}

function atoms(): AtomRegistry {
  const registry = new AtomRegistry()
  registry.register(compareAtom)
  registry.register(searchAtom)
  registry.register(timeBaselineAtom)
  return registry
}

function expectRejected(
  stages: WorkflowStage[],
  budget: WorkflowStageBudget,
  pattern: RegExp,
): void {
  expect(() => {
    validateWorkflowBudget(manifest(stages), budget, atoms())
  }).toThrow(pattern)
}

describe('workflow stage budget', () => {
  it('counts atom-less stages and atoms whose contract calls the model', () => {
    const stages = [
      stage('parse'),
      stage('compare', 'compare'),
      stage('search', 'search'),
      stage('time_baseline', 'time-baseline'),
      stage('conclude'),
    ]
    expect(countWorkflowLlmStages(manifest(stages), atoms())).toBe(3)
  })

  it('accepts a manifest exactly at both limits', () => {
    expect(() => {
      validateWorkflowBudget(
        manifest([stage('parse'), stage('compare', 'compare')]),
        { maxStages: 2, maxLlmStages: 2 },
        atoms(),
      )
    }).not.toThrow()
  })

  it('rejects a manifest over the stage limit', () => {
    expectRejected(
      [stage('a'), stage('b'), stage('c')],
      { maxStages: 2, maxLlmStages: 3 },
      /test_manifest 的阶段数 3 超出预算 2/,
    )
  })

  it('rejects a manifest over the model-calling stage limit', () => {
    expectRejected(
      [stage('parse'), stage('compare', 'compare')],
      { maxStages: 5, maxLlmStages: 1 },
      /test_manifest 的模型调用阶段数 2 超出预算 1/,
    )
  })

  it('rejects an unregistered atom instead of guessing its cost', () => {
    expect(() => countWorkflowLlmStages(manifest([stage('mystery', 'missing-atom')]), atoms()))
      .toThrow(/阶段 mystery 声明了未知 atom: missing-atom/)
  })

  it('rejects non-positive or non-finite limits', () => {
    const budget: WorkflowStageBudget = { maxStages: 10, maxLlmStages: 10 }
    expectRejected([stage('a')], { ...budget, maxStages: 0 }, /maxStages 必须为有限正数/)
    expectRejected([stage('a')], { ...budget, maxStages: Number.NaN }, /maxStages 必须为有限正数/)
    expectRejected([stage('a')], { ...budget, maxLlmStages: 0 }, /maxLlmStages 必须为有限正数/)
    expectRejected(
      [stage('a')],
      { ...budget, maxLlmStages: Number.POSITIVE_INFINITY },
      /maxLlmStages 必须为有限正数/,
    )
  })
})
