import { describe, expect, it } from 'vitest'
import {
  AtomRegistry,
  clearStageOutputs,
  extractAtom,
  type WorkflowStage,
} from '@deepseek-ai/dsh-patent-core'
import { approvalGateAtom } from '../../src/atoms/handlers/builtin/gate.ts'
import { claimChartAtom } from '../../src/atoms/handlers/builtin/chart.ts'
import { groundsAtom } from '../../src/atoms/handlers/builtin/notice.ts'

/**
 * 回退清理原语的直接单测。
 *
 * 存在的理由：这条语义被两处消费——声明式执行器（runWorkflow 的 retry 回退）与
 * 图适配器（manifestToGraph 的 retry 条件边 router）。两处原先各写一份
 * `Reflect.deleteProperty` 循环时都只删 stage-id 键，把语义钉在这里比只测两侧集成
 * 更能定位回归。
 */

/**
 * 构造含多输出键 atom（extract）与零输出键 atom（审批门）的注册表。
 *
 * 复用出厂 atom 定义而非手抄一份：手抄版曾漏掉 `extractAtom` 的
 * `extraction_result`，于是"重跑解析失败时旧一代提取结果残留、下游 merge 混用
 * 两代"这一本套用例要防的缺陷恰好不可发现——断言只覆盖手抄进 outputSchema 的键。
 */
function makeAtoms(): AtomRegistry {
  const registry = new AtomRegistry()
  registry.register(extractAtom)
  registry.register(approvalGateAtom)
  return registry
}

describe('clearStageOutputs', () => {
  it('删 stage-id 键 + 该 atom 的 outputSchema 全部键（不只 stage-id）', () => {
    const atoms = makeAtoms()
    const stages: WorkflowStage[] = [
      { id: 'extract_features', strategy: 'chain', description: '提取', atom: 'extract' },
      { id: 'check', strategy: 'chain', description: '检查', atom: 'approval-gate' },
    ]
    const state: Record<string, unknown> = {
      input: '交底书',
      extract_features: '旧输出',
      extraction_result: '旧一代原文（解析失败时残留的那份）',
      features: ['旧特征'],
      problems: ['旧问题'],
      effects: ['旧效果'],
      insight: ['旧认知'],
      problem_insight: [{ id: 'P1', problem: '旧问题', insight: '旧认知' }],
      revision_coverage: { 'time-baseline': ['旧事实'] },
      check: '旧一致性',
    }
    clearStageOutputs({ state, stages, atoms })
    expect(state).toEqual({ input: '交底书' })
  })

  it('条件输出的附加键（claim_chart_paths / patent_subject）也随回退清理', () => {
    const atoms = new AtomRegistry()
    atoms.register(claimChartAtom)
    atoms.register(groundsAtom)
    const stages: WorkflowStage[] = [
      { id: 'build_chart', strategy: 'chain', description: '构建图表', atom: 'claim-chart' },
      { id: 'identify_grounds', strategy: 'chain', description: '识别理由', atom: 'grounds' },
    ]
    const state: Record<string, unknown> = {
      claim_chart_doc: '{}',
      gap_list: '[]',
      claim_chart_paths: '{"jsonPath":"chart.json"}',
      grounds: '[]',
      grounds_summary: '未识别',
      patent_subject: 'invention',
    }
    clearStageOutputs({ state, stages, atoms })
    expect(state).toEqual({})
  })

  it('无 atom 阶段只删 stage-id 键；范围之外的阶段不受影响', () => {
    const atoms = makeAtoms()
    const stages: WorkflowStage[] = [
      { id: 'preprocess', strategy: 'chain', description: '预处理' },
      { id: 'extract_features', strategy: 'chain', description: '提取', atom: 'extract' },
    ]
    const state: Record<string, unknown> = {
      preprocess: '旧预处理',
      extract_features: '旧输出',
      features: ['旧特征'],
      report: '后续阶段输出（不在清理范围内）',
    }
    clearStageOutputs({ state, stages: [stages[0]!], atoms })
    expect(state).toEqual({
      extract_features: '旧输出',
      features: ['旧特征'],
      report: '后续阶段输出（不在清理范围内）',
    })
  })

  it('atom 未注册时不抛错（只清 stage-id 键）', () => {
    const atoms = makeAtoms()
    const state: Record<string, unknown> = { ghost: '输出', features: ['不该删'] }
    clearStageOutputs({
      state,
      stages: [{ id: 'ghost', strategy: 'chain', description: '未注册原子', atom: 'no-such-atom' }],
      atoms,
    })
    expect(state).toEqual({ features: ['不该删'] })
  })
})
