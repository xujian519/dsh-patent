import { describe, expect, it } from 'vitest'
import type { PipelineState } from '@deepseek-ai/dsh-patent-core'
import { parseWorkCalendar } from '@deepseek-ai/dsh-patent-deadline'
import {
  AdmissibilityHandler,
  admissibilityAtom,
  type AdmissibilityPending,
  type AdmissibilityViolation,
} from '../src/atoms/admissibility.ts'

/** 一条被援引（未被否定）的理由。 */
const NOVELTY_GROUND = { ground: 'novelty', article: '专利法第22条第2款', label: '新颖性缺陷', negated: false, matched: '权利要求1不具备新颖性' }

/** 一条否定表述中的理由。 */
const NEGATED_GROUND = { ...NOVELTY_GROUND, negated: true }

/**
 * 构造一条复审的执行态。
 * @param overrides - 覆盖默认字段。
 * @returns 阶段执行态。
 */
function reexamination(overrides: PipelineState = {}): PipelineState {
  return {
    case_type: 'reexamination',
    grounds: JSON.stringify([NOVELTY_GROUND]),
    rejection_decision_date: '2026-03-01',
    request_date: '2026-05-01',
    requester: '某某公司',
    patentee: '某某公司',
    ...overrides,
  }
}

/**
 * 构造一条无效宣告的执行态。
 * @param overrides - 覆盖默认字段。
 * @returns 阶段执行态。
 */
function invalidation(overrides: PipelineState = {}): PipelineState {
  return {
    case_type: 'invalidation',
    grounds: JSON.stringify([NOVELTY_GROUND]),
    evidence: [{ id: 'D1', title: '对比文件1' }],
    ...overrides,
  }
}

/**
 * 执行原子并取出结果。
 * @param state - 阶段执行态。
 * @returns 报告、判定、违规与待核项。
 */
async function run(
  state: PipelineState,
  deps: { calendar?: import('@deepseek-ai/dsh-patent-deadline').WorkCalendar } = {},
): Promise<{
  report: string
  passed: boolean
  violations: AdmissibilityViolation[]
  pending: AdmissibilityPending[]
  degraded: boolean
  error: string
}> {
  const out = await new AdmissibilityHandler(deps).execute({ state })
  const report = out['admissibility_report']
  const error = out['_error']
  return {
    report: typeof report === 'string' ? report : '',
    passed: out['admissibility_passed'] === true,
    violations: (out['admissibility_violations'] ?? []) as AdmissibilityViolation[],
    pending: (out['admissibility_pending'] ?? []) as AdmissibilityPending[],
    degraded: typeof error === 'string',
    error: typeof error === 'string' ? error : '',
  }
}

describe('admissibility 原子契约', () => {
  it('声明确定性 gate 的输入与四项输出', () => {
    expect(admissibilityAtom.name).toBe('admissibility')
    expect(admissibilityAtom.category).toBe('gate')
    expect(admissibilityAtom.usesModel).toBeUndefined()
    expect(admissibilityAtom.outputSchema).toEqual([
      'admissibility_report',
      'admissibility_passed',
      'admissibility_violations',
      'admissibility_pending',
    ])
    expect(admissibilityAtom.inputSchema).toEqual([
      'case_type',
      'grounds',
      'rejection_decision_date',
      'request_date',
      'recovery_requested',
      'prior_invalidation_decision',
      'requester',
      'patentee',
      'evidence',
    ])
  })
})

describe('admissibility 输入边界', () => {
  it('未识别程序类型时降级，不猜程序', async () => {
    for (const caseType of [undefined, '', 'opposition', 42]) {
      const result = await run(reexamination({ case_type: caseType }))
      expect(result.degraded, String(caseType)).toBe(true)
    }
  })

  it('缺少 grounds 时报告未执行并放行', async () => {
    const result = await run(reexamination({ grounds: undefined }))
    expect(result.degraded).toBe(false)
    expect(result.report).toContain('未执行')
    expect(result.passed).toBe(true)
    expect(result.violations).toEqual([])
  })

  it('grounds 不是合法 JSON 时降级', async () => {
    const result = await run(reexamination({ grounds: '{不是 JSON' }))
    expect(result.degraded).toBe(true)
    expect(result.error).toContain('grounds')
  })

  it('日期格式非法时降级而不是当作缺失', async () => {
    const result = await run(reexamination({ rejection_decision_date: '2026-02-30' }))
    expect(result.degraded).toBe(true)
    expect(result.error).toContain('rejection_decision_date')
  })

  it('日期不是字符串时降级', async () => {
    const result = await run(reexamination({ rejection_decision_date: 20_260_301 }))
    expect(result.degraded).toBe(true)
    expect(result.error).toContain('必须是日期字符串')
  })

  it('接受工具边界放行的非 ISO 日期写法', async () => {
    const result = await run(
      reexamination({ rejection_decision_date: '2026年3月1日', request_date: '2026/06/01' }),
    )
    expect(result.degraded).toBe(false)
    expect(result.violations.filter(v => v.code === 'ADM-TIME-REQUEST')).toEqual([])
  })

  it('请求日格式非法时降级', async () => {
    const result = await run(reexamination({ request_date: '不是日期' }))
    expect(result.degraded).toBe(true)
    expect(result.error).toContain('request_date')
  })

  it('grounds 直接传数组时按同一口径解析', async () => {
    const result = await run(reexamination({ grounds: [NOVELTY_GROUND] }))
    expect(result.degraded).toBe(false)
    expect(result.violations.map(v => v.code)).not.toContain('ADM-GROUNDS-ABSENT')
  })

  it('grounds 不是数组、或条目缺 ground 时降级', async () => {
    for (const grounds of [{}, '{"a":1}', [{ negated: false }]]) {
      const result = await run(reexamination({ grounds }))
      expect(result.degraded, JSON.stringify(grounds)).toBe(true)
      expect(result.error, JSON.stringify(grounds)).toContain('grounds')
    }
  })

  it('无效程序缺 grounds 时同样报告未执行', async () => {
    const result = await run(invalidation({ grounds: undefined }))
    expect(result.report).toContain('未执行')
    expect(result.report).toContain('无效宣告')
    expect(result.passed).toBe(true)
  })

  it('主体资格输入为空白串或非字符串时按缺失处理并记未评估', async () => {
    for (const requester of ['   ', 42]) {
      const result = await run(reexamination({ requester }))
      expect(result.report, String(requester)).toContain('未评估（缺请求人或申请人信息）')
      expect(result.violations.filter(v => v.code === 'ADM-PARTY'), String(requester)).toEqual([])
    }
  })
})

describe('admissibility 理由援引', () => {
  it('理由清单为空时阻断', async () => {
    const result = await run(reexamination({ grounds: '[]' }))
    expect(result.passed).toBe(false)
    expect(result.violations.map(v => v.code)).toContain('ADM-GROUNDS-ABSENT')
  })

  it('理由全部处于否定表述中时阻断', async () => {
    const result = await run(reexamination({ grounds: JSON.stringify([NEGATED_GROUND]) }))
    expect(result.passed).toBe(false)
    expect(result.violations.map(v => v.code)).toContain('ADM-GROUNDS-NEGATED')
  })

  it('至少一条理由被实质援引即可通过该项', async () => {
    const result = await run(
      reexamination({ grounds: JSON.stringify([NEGATED_GROUND, NOVELTY_GROUND]) }),
    )
    const codes = result.violations.map(v => v.code)
    expect(codes).not.toContain('ADM-GROUNDS-ABSENT')
    expect(codes).not.toContain('ADM-GROUNDS-NEGATED')
  })
})

describe('admissibility 复审期限', () => {
  it('期限内不报违规', async () => {
    const result = await run(reexamination({ rejection_decision_date: '2026-03-01', request_date: '2026-06-01' }))
    expect(result.violations.filter(v => v.code === 'ADM-TIME-REQUEST')).toEqual([])
    expect(result.passed).toBe(true)
  })

  it('超过三个月阻断', async () => {
    const result = await run(reexamination({ rejection_decision_date: '2026-03-01', request_date: '2026-06-02' }))
    expect(result.passed).toBe(false)
    expect(result.violations.map(v => v.code)).toContain('ADM-TIME-REQUEST')
  })

  it('超期但办理了恢复权利手续时降为提示', async () => {
    const result = await run(
      reexamination({ rejection_decision_date: '2026-03-01', request_date: '2026-06-02', recovery_requested: true }),
    )
    const time = result.violations.filter(v => v.code === 'ADM-TIME-REQUEST')
    expect(time.map(v => v.severity)).toEqual(['warn'])
    expect(result.passed).toBe(true)
  })

  it('缺少送达日或提交日时进入待核，不判通过', async () => {
    const noDelivery = await run(reexamination({ rejection_decision_date: undefined }))
    expect(noDelivery.pending.map(p => p.code)).toContain('ADM-TIME-DECISION-DATE')
    const noRequest = await run(reexamination({ request_date: undefined }))
    expect(noRequest.pending.map(p => p.code)).toContain('ADM-TIME-REQUEST-DATE')
  })

  it('届满日落在休息日时按顺延后的首个工作日判定', async () => {
    // 2026-04-04 起 3 个月为 2026-07-04（周六），顺延到 2026-07-06（周一）。
    const onRolledDay = await run(
      reexamination({ rejection_decision_date: '2026-04-04', request_date: '2026-07-06' }),
    )
    expect(onRolledDay.violations.filter(v => v.code === 'ADM-TIME-REQUEST')).toEqual([])
    expect(onRolledDay.report).toContain('顺延')

    const afterRolledDay = await run(
      reexamination({ rejection_decision_date: '2026-04-04', request_date: '2026-07-07' }),
    )
    expect(afterRolledDay.violations.map(v => v.code)).toContain('ADM-TIME-REQUEST')
  })

  it('工作日历未覆盖该年度时记未评估，不判逾期', async () => {
    const calendar = parseWorkCalendar(
      [
        'years:',
        '  - year: 2025',
        '    source: test',
        '    holidays:',
        '      - 2025-01-01',
        '    workdays: []',
      ].join('\n'),
    )
    const result = await run(reexamination({ rejection_decision_date: '2026-03-01 ' }), { calendar })
    expect(result.pending.map(p => p.code)).toContain('ADM-TIME-CALENDAR')
    expect(result.violations.filter(v => v.code === 'ADM-TIME-REQUEST')).toEqual([])
    expect(result.passed).toBe(true)
  })

  it('日期只到年月时记未评估，不按 1 号推算', async () => {
    const noDeliveryDay = await run(reexamination({ rejection_decision_date: '2026-03' }))
    expect(noDeliveryDay.pending.map(p => p.code)).toContain('ADM-TIME-DECISION-DATE')
    expect(noDeliveryDay.report).toContain('未精确到日')

    const noRequestDay = await run(reexamination({ request_date: '2026-05' }))
    expect(noRequestDay.pending.map(p => p.code)).toContain('ADM-TIME-REQUEST-DATE')
    expect(noRequestDay.report).toContain('未精确到日')
    expect(noRequestDay.violations.filter(v => v.code === 'ADM-TIME-REQUEST')).toEqual([])
  })

  it('无效宣告不受请求期限约束，报告写明不适用', async () => {
    const result = await run(invalidation())
    expect(result.violations.filter(v => v.code.startsWith('ADM-TIME'))).toEqual([])
    expect(result.report).toContain('不适用')
  })
})

describe('admissibility 一事不再理', () => {
  it('未提供在先决定时进入待核', async () => {
    const result = await run(invalidation())
    expect(result.pending.map(p => p.code)).toContain('ADM-RES-JUDICATA')
  })

  it('在先决定未载明证据标识时，证据比对记为未评估而不是「证据不同」', async () => {
    const result = await run(invalidation({ prior_invalidation_decision: { grounds: ['novelty'] } }))
    expect(result.pending.map(p => p.code)).toContain('ADM-RES-JUDICATA-EVIDENCE')
    expect(result.passed).toBe(true)
    expect(result.report).toContain('未载明证据标识')
  })

  it('本次证据清单缺失时同样记为未评估', async () => {
    for (const evidence of [undefined, 'D1', [{ title: '' }], [null]]) {
      const label = JSON.stringify(evidence) ?? 'undefined'
      const result = await run(
        invalidation({
          evidence,
          prior_invalidation_decision: { grounds: ['novelty'], evidenceIds: ['D1'] },
        }),
      )
      expect(result.pending.map(p => p.code), label).toContain('ADM-RES-JUDICATA-EVIDENCE')
      expect(result.passed, label).toBe(true)
    }
  })

  it('证据标识数量不同即判「证据不同」，降为提示', async () => {
    const result = await run(
      invalidation({
        evidence: [{ id: 'D1' }],
        prior_invalidation_decision: { grounds: ['novelty'], evidenceIds: ['D1', 'D2'] },
      }),
    )
    const j = result.violations.filter(v => v.code === 'ADM-RES-JUDICATA')
    expect(j.map(v => v.severity)).toEqual(['warn'])
  })

  it('在先决定录入错误时降级，不当作提示放行', async () => {
    for (const prior of ['{不是 JSON', '[]', { grounds: 'novelty' }, { grounds: ['novelty'], evidenceIds: 'D1' }]) {
      const result = await run(invalidation({ prior_invalidation_decision: prior }))
      expect(result.degraded, JSON.stringify(prior)).toBe(true)
      expect(result.error).toContain('prior_invalidation_decision')
    }
  })

  it('空字符串在先决定按未提供处理', async () => {
    const result = await run(invalidation({ prior_invalidation_decision: '' }))
    expect(result.pending.map(p => p.code)).toContain('ADM-RES-JUDICATA')
  })

  it('理由与证据均相同时阻断', async () => {
    const result = await run(
      invalidation({
        prior_invalidation_decision: JSON.stringify({ grounds: ['novelty'], evidenceIds: ['D1'] }),
      }),
    )
    expect(result.passed).toBe(false)
    expect(result.violations.map(v => v.code)).toContain('ADM-RES-JUDICATA')
  })

  it('理由部分相同但证据相同时，报告行按实际差异渲染', async () => {
    const result = await run(
      invalidation({
        evidence: [{ id: 'D1', title: '对比文件1' }],
        prior_invalidation_decision: { grounds: ['novelty', 'inventiveness'], evidenceIds: ['D1'] },
      }),
    )
    expect(result.report).toContain('理由部分相同、证据相同')
  })

  it('理由与证据都只部分相同时，报告行按实际差异渲染', async () => {
    const result = await run(
      invalidation({
        evidence: [{ id: 'D2' }],
        prior_invalidation_decision: { grounds: ['novelty', 'inventiveness'], evidenceIds: ['D1'] },
      }),
    )
    expect(result.report).toContain('理由部分相同、证据不同')
    expect(result.passed).toBe(true)
  })

  it('证据标识取稳定 id 而非标题', async () => {
    const result = await run(
      invalidation({
        evidence: [{ id: 'D1', title: '对比文件1' }],
        prior_invalidation_decision: { grounds: ['novelty'], evidenceIds: ['D1'] },
      }),
    )
    expect(result.violations.map(v => v.code)).toContain('ADM-RES-JUDICATA')
    expect(result.violations.find(v => v.code === 'ADM-RES-JUDICATA')?.severity).toBe('block')
  })

  it('理由相同但证据不同时降为提示，由人工判断是否实质相同', async () => {
    const result = await run(
      invalidation({
        prior_invalidation_decision: { grounds: ['novelty'], evidenceIds: ['D9'] },
      }),
    )
    const j = result.violations.filter(v => v.code === 'ADM-RES-JUDICATA')
    expect(j.map(v => v.severity)).toEqual(['warn'])
    expect(result.passed).toBe(true)
  })

  it('理由不同时不报该项', async () => {
    const result = await run(
      invalidation({
        prior_invalidation_decision: { grounds: ['inventiveness'], evidenceIds: ['D1'] },
      }),
    )
    expect(result.violations.filter(v => v.code === 'ADM-RES-JUDICATA')).toEqual([])
  })
})

describe('admissibility 主体资格与报告', () => {
  it('复审请求人与申请人不一致时提示', async () => {
    const result = await run(reexamination({ requester: '甲公司', patentee: '乙公司' }))
    const party = result.violations.filter(v => v.code === 'ADM-PARTY')
    expect(party.map(v => v.severity)).toEqual(['warn'])
  })

  it('报告始终写明未评估事项与限制说明', async () => {
    const result = await run(invalidation())
    expect(result.report).toContain('形式文书')
    expect(result.report).toContain('限制说明')
  })
})
