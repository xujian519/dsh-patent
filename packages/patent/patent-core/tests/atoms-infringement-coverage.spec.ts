import { describe, expect, it } from 'vitest'
import {
  LookupStageHandler,
  registerBuiltinAtoms,
  type ChartMode,
  type ChartTarget,
} from '@deepseek-ai/dsh-patent-core'
import { DRAFT_NOTICE } from '../src/claim-chart/protocol/types.ts'
import type { AllElementsCoverage } from '../src/infringement/all-elements.ts'
import type {
  ChartRow,
  ClaimElement,
  Mapping,
} from '../src/claim-chart/protocol/types.ts'
import type { EquivalenceContradiction } from '../src/infringement/equivalence.ts'

registerBuiltinAtoms()

const ELEMENTS: ClaimElement[] = [
  { id: '1a', claimNo: 1, text: '一种换热装置', kind: 'preamble' },
  { id: '1b', claimNo: 1, text: '包括壳体和位于壳体内的换热管', kind: 'limitation' },
]

const row = (elementId: string, mapping: Mapping, targetId = '产品A'): ChartRow => ({
  elementId,
  targetId,
  quote: '被诉产品对应内容',
  pinCite: '[产品A 第3页]',
  mapping,
  state: mapping,
  verified: false,
})

/** 组装图表文档：claim-chart 阶段写入 state 的正是这份 JSON。 */
const chartDoc = (
  rows: ChartRow[],
  targets: ChartTarget[] = [{ id: '产品A', kind: 'accused-product' }],
  mode: ChartMode = 'infringement',
): string =>
  JSON.stringify({
    chartId: `chart-${mode}`,
    mode,
    caseId: '',
    elements: ELEMENTS,
    claimNos: [1],
    targets,
    rows,
    gaps: [],
    draftNotice: DRAFT_NOTICE,
  })

const run = async (state: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const handler = LookupStageHandler('coverage')
  if (handler === undefined) throw new Error('未注册的原子: coverage')
  return await handler.execute({ state })
}

const reportOf = (out: Record<string, unknown>): AllElementsCoverage[] =>
  JSON.parse(String(out.coverage_report)) as AllElementsCoverage[]

const conflictsOf = (out: Record<string, unknown>): EquivalenceContradiction[] =>
  JSON.parse(String(out.coverage_conflicts)) as EquivalenceContradiction[]

describe('coverage 原子', () => {
  it('全部要素字面覆盖：结论 literal，无等同矛盾', async () => {
    const out = await run({ claim_chart_doc: chartDoc([row('1a', 'literal'), row('1b', 'literal')]) })
    const [coverage] = reportOf(out)
    expect(coverage).toEqual({
      targetId: '产品A',
      outcome: 'literal',
      claimNo: 1,
      elementCount: 2,
      literalElements: ['1a', '1b'],
      constructionDependentElements: [],
      equivalenceCandidates: [],
      missingElements: [],
      claims: [{
        claimNo: 1,
        elementCount: 2,
        outcome: 'literal',
        literalElements: ['1a', '1b'],
        constructionDependentElements: [],
        equivalenceCandidates: [],
        missingElements: [],
      }],
    })
    expect(conflictsOf(out)).toEqual([])
  })

  it('缺项即不落入保护范围，逐要素列出缺项', async () => {
    const out = await run({ claim_chart_doc: chartDoc([row('1a', 'literal')]) })
    const [coverage] = reportOf(out)
    expect(coverage?.outcome).toBe('not-covered')
    expect(coverage?.missingElements).toEqual(['1b'])
  })

  it('按等同落格的行：结论转 equivalence-required，并报等同未认定', async () => {
    const out = await run({
      claim_chart_doc: chartDoc([row('1a', 'literal'), row('1b', 'doe')]),
    })
    const [coverage] = reportOf(out)
    expect(coverage?.outcome).toBe('equivalence-required')
    expect(coverage?.equivalenceCandidates).toEqual(['1b'])
    expect(conflictsOf(out).map(c => [c.elementId, c.kind])).toEqual([['1b', 'doe-without-triplet']])
  })

  it('待解释要素单独成态，不计入字面结论', async () => {
    const out = await run({
      claim_chart_doc: chartDoc([row('1a', 'literal-construction-dependent'), row('1b', 'literal')]),
    })
    const [coverage] = reportOf(out)
    expect(coverage?.outcome).toBe('construction-dependent')
    expect(coverage?.constructionDependentElements).toEqual(['1a'])
  })

  it('多个被控产品逐目标出结论，互不串行', async () => {
    const targets: ChartTarget[] = [
      { id: '产品A', kind: 'accused-product' },
      { id: '产品B', kind: 'accused-product' },
    ]
    const out = await run({
      claim_chart_doc: chartDoc(
        [row('1a', 'literal'), row('1b', 'literal'), row('1a', 'literal', '产品B')],
        targets,
      ),
    })
    expect(reportOf(out).map(c => [c.targetId, c.outcome])).toEqual([
      ['产品A', 'literal'],
      ['产品B', 'not-covered'],
    ])
  })

  it('缺少图表文档时降级并指明前置阶段', async () => {
    const out = await run({})
    expect(String(out._error)).toContain('[coverage]')
    expect(String(out._error)).toContain('须先执行 claim-chart 阶段')
  })

  it('图表文档不是合法 JSON 时降级', async () => {
    const out = await run({ claim_chart_doc: 'not-json' })
    expect(String(out._error)).toContain('不是合法 JSON')
  })

  it('逐权项判定，整体结论取覆盖最佳的权项', async () => {
    const elements: ClaimElement[] = [
      { id: '1a', claimNo: 1, text: '一种换热装置', kind: 'preamble' },
      { id: '2a', claimNo: 2, text: '所述换热管为蛇形管', kind: 'limitation' },
    ]
    const out = await run({
      claim_chart_doc: JSON.stringify({
        chartId: 'chart-infringement',
        mode: 'infringement',
        caseId: '',
        elements,
        claimNos: [1, 2],
        targets: [{ id: '产品A', kind: 'accused-product' }],
        rows: [row('1a', 'not-found'), row('2a', 'literal')],
        gaps: [],
        draftNotice: DRAFT_NOTICE,
      }),
    })
    const [coverage] = reportOf(out)
    expect(coverage?.outcome).toBe('literal')
    expect(coverage?.claimNo).toBe(2)
    expect(coverage?.missingElements).toEqual([])
    expect(coverage?.claims.map(claim => [claim.claimNo, claim.outcome])).toEqual([
      [1, 'not-covered'],
      [2, 'literal'],
    ])
  })

  it.each([
    ['缺少 claimNo', { id: '1a' }],
    ['claimNo 不是整数', { id: '1a', claimNo: 1.5 }],
    ['claimNo 不为正', { id: '1a', claimNo: 0 }],
  ])('要素%s时降级并指明下标', async (_label, element) => {
    const out = await run({
      claim_chart_doc: JSON.stringify({
        mode: 'infringement',
        elements: [element],
        targets: [{ id: '产品A', kind: 'accused-product' }],
        rows: [],
      }),
    })
    expect(String(out._error)).toContain('[coverage]')
    expect(String(out._error)).toContain('elements[0] 的 claimNo 非法')
  })

  it('非侵权模式与非被控产品目标都不做覆盖核验', async () => {
    const otherMode = await run({ claim_chart_doc: chartDoc([row('1a', 'literal')], [], 'invalidity') })
    expect(String(otherMode._error)).toContain('当前 mode=invalidity')

    const priorArtOnly = await run({
      claim_chart_doc: chartDoc([row('1a', 'literal')], [{ id: 'D1', kind: 'prior-art' }]),
    })
    expect(String(priorArtOnly._error)).toContain('没有被控产品目标')
  })
})
