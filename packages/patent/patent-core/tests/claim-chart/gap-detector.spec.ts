import { expect, it } from 'vitest'
import { detectGaps } from '../../src/claim-chart/runtime/gap-detector.ts'
import type { ChartTarget } from '@deepseek-ai/dsh-patent-core'
import type { ChartRow, ClaimElement } from '../../src/claim-chart/protocol/types.ts'

function row(elementId: string, targetId: string, mapping: ChartRow['mapping']): ChartRow {
  return { elementId, targetId, quote: '', pinCite: '', mapping, state: mapping, verified: false }
}

function element(id: string): ClaimElement {
  return { id, claimNo: Number(id.slice(0, 1)), text: `要素 ${id}`, kind: 'limitation' }
}

function target(id: string): ChartTarget {
  return { id, kind: 'prior-art' }
}

it('无缺口时返回空列表', () => {
  const rows = [row('1a', 'D1', 'literal'), row('1b', 'D1', 'anticipation')]
  expect(detectGaps(rows)).toEqual([])
})

it('聚合缺口并按优先级排序（not-found > needs-evidence > partial）', () => {
  const rows = [
    row('1a', 'D1', 'partial'),
    row('1b', 'D1', 'needs-evidence'),
    row('1c', 'D1', 'not-found'),
    row('1c', 'D2', 'literal'),
  ]
  const gaps = detectGaps(rows)
  expect(gaps.map(g => `${g.elementId}:${g.kind}`)).toEqual(['1c:not-found', '1b:needs-evidence', '1a:partial'])
})

it('缺口条目带建议动作', () => {
  const gaps = detectGaps([row('1a', 'D1', 'not-found'), row('1b', 'D1', 'needs-evidence')])
  expect(gaps[0]!.suggestion).toBe('补充检索或论证等同替换')
  expect(gaps[1]!.suggestion).toBe('证据固化（全文引用/附图标记）')
})

it('给出要素与目标后，缺少映射行的组合记为未评估', () => {
  const rows = [row('1a', 'D1', 'literal'), row('1b', 'D1', 'literal')]
  const gaps = detectGaps(rows, [element('1a'), element('1b'), element('1c')], [target('D1')])
  expect(gaps).toEqual([
    {
      elementId: '1c',
      targetId: 'D1',
      kind: 'unevaluated',
      reason: '要素 1c 在 D1 上未评估（没有映射行）',
      suggestion: '补出该要素对该目标的映射行（未找到对应内容时写 not-found 并说明检索范围）',
    },
  ])
})

it('未评估优先于证据薄弱：缺行的格子排在最前', () => {
  const rows = [row('1a', 'D1', 'partial'), row('1b', 'D1', 'not-found')]
  const gaps = detectGaps(rows, [element('1a'), element('1b'), element('1c')], [target('D1')])
  expect(gaps.map(g => `${g.elementId}:${g.kind}`)).toEqual(['1c:unevaluated', '1b:not-found', '1a:partial'])
})

it('逐目标检查完整性：每个目标各自要求全部要素有行', () => {
  const rows = [row('1a', 'D1', 'literal'), row('1a', 'D2', 'literal'), row('1b', 'D1', 'literal')]
  const gaps = detectGaps(rows, [element('1a'), element('1b')], [target('D1'), target('D2')])
  expect(gaps.map(g => `${g.elementId}→${g.targetId}`)).toEqual(['1b→D2'])
})

it('不传要素与目标时保持行级检查（只拆要素模式）', () => {
  expect(detectGaps([row('1a', 'D1', 'literal')], [element('1a'), element('1b')], [])).toEqual([])
})
