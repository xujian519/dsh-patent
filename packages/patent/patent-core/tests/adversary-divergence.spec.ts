import { describe, expect, it } from 'vitest'
import { computeOverallConfidence, detectDivergence } from '../src/adversary/divergence.ts'
import type { AdversaryDispute } from '@deepseek-ai/dsh-patent-core'
import type { AdversaryPlanEntry } from '../src/adversary/types.ts'

describe('分歧检测', () => {
  const makeDispute = (statute: string, relation: AdversaryDispute['relation']): AdversaryDispute => ({
    statute,
    claims: [1],
    point: `测试争议点 ${statute}`,
    relation,
    confidence: 0.8,
    tag: 'heuristic',
  })

  it('空输入返回空', () => {
    expect(detectDivergence([], undefined)).toEqual([])
    expect(detectDivergence([], [])).toEqual([])
  })

  it('基线覆盖的法条标记为 agreement', () => {
    const disputes: AdversaryDispute[] = [
      makeDispute('A22.3', 'missed_by_baseline'),
      makeDispute('A26.4', 'missed_by_baseline'),
    ]
    const responsePlan: AdversaryPlanEntry[] = [
      { ground: 'inventiveness', strategy: 'amend', claims: [1] },
      { ground: 'claim-clarity', strategy: 'amend', claims: [1] },
    ]
    const marked = detectDivergence(disputes, responsePlan)
    expect(marked[0]?.relation).toBe('agreement')
    expect(marked[1]?.relation).toBe('agreement')
  })

  it('基线未覆盖的法条标记为 missed_by_baseline', () => {
    const disputes: AdversaryDispute[] = [
      makeDispute('A22.2', 'missed_by_baseline'),
    ]
    const responsePlan: AdversaryPlanEntry[] = [
      { ground: 'inventiveness', strategy: 'amend', claims: [1] },
    ]
    const marked = detectDivergence(disputes, responsePlan)
    expect(marked[0]?.relation).toBe('missed_by_baseline')
  })

  it('已标记的 disagreement 保持不变', () => {
    const disputes: AdversaryDispute[] = [
      {
        statute: 'A22.3',
        claims: [3],
        point: '权项不对齐',
        relation: 'disagreement',
        divergenceReason: '策略权项与通知书涉及权项不对齐',
        confidence: 0.7,
        tag: 'heuristic',
      },
    ]
    const responsePlan: AdversaryPlanEntry[] = [
      { ground: 'inventiveness', strategy: 'amend', claims: [1, 2] },
    ]
    const marked = detectDivergence(disputes, responsePlan)
    expect(marked[0]?.relation).toBe('disagreement')
    expect(marked[0]?.divergenceReason).toBe('策略权项与通知书涉及权项不对齐')
  })

  it('无 responsePlan 时全部标记为 missed_by_baseline', () => {
    const disputes: AdversaryDispute[] = [
      makeDispute('A22.3', 'missed_by_baseline'),
      makeDispute('A22.2', 'missed_by_baseline'),
    ]
    const marked = detectDivergence(disputes, undefined)
    expect(marked.every(d => d.relation === 'missed_by_baseline')).toBe(true)
  })

  it('未知 ground 的法条不影响标记', () => {
    const disputes: AdversaryDispute[] = [
      makeDispute('A22.3', 'missed_by_baseline'),
    ]
    const responsePlan: AdversaryPlanEntry[] = [
      { ground: 'unknown-ground', strategy: 'amend', claims: [1] },
    ]
    const marked = detectDivergence(disputes, responsePlan)
    expect(marked[0]?.relation).toBe('missed_by_baseline')
  })
})

describe('整体置信度计算', () => {
  it('空列表返回 0', () => {
    expect(computeOverallConfidence([])).toBe(0)
  })

  it('单条争议点返回其置信度', () => {
    const disputes: AdversaryDispute[] = [
      { statute: 'A22.3', claims: [1], point: '', relation: 'agreement', confidence: 0.8, tag: 'heuristic' },
    ]
    expect(computeOverallConfidence(disputes)).toBeCloseTo(0.8, 5)
  })

  it('加权平均：高置信度争议点权重更大', () => {
    const disputes: AdversaryDispute[] = [
      { statute: 'A22.3', claims: [1], point: '', relation: 'agreement', confidence: 0.9, tag: 'heuristic' },
      { statute: 'A26.4', claims: [2], point: '', relation: 'agreement', confidence: 0.3, tag: 'heuristic' },
    ]
    // (0.9^2 + 0.3^2) / (0.9 + 0.3) = (0.81 + 0.09) / 1.2 = 0.9 / 1.2 = 0.75
    expect(computeOverallConfidence(disputes)).toBeCloseTo(0.75, 5)
  })

  it('全部零置信度返回 0', () => {
    const disputes: AdversaryDispute[] = [
      { statute: 'A22.3', claims: [1], point: '', relation: 'agreement', confidence: 0, tag: 'heuristic' },
    ]
    expect(computeOverallConfidence(disputes)).toBe(0)
  })
})
