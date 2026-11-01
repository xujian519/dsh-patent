import { describe, expect, it } from 'vitest'
import {
  ClaimBreadthHandler,
  claimBreadthAtom,
  type StageProvider,
} from '@deepseek-ai/dsh-patent-core'

/** 构造只返回指定 JSON 的 provider，并捕获提示词与 schema。 */
function providerFor(raw: string, captured: { prompt?: string; schema?: unknown } = {}): StageProvider {
  return {
    callLLM: async (prompt, opts) => {
      captured.prompt = prompt
      captured.schema = opts?.jsonSchema
      return raw
    },
  }
}

const CLAIMS = [
  '1. 一种加热装置，其特征在于，包括任意形状的加热通道，所述加热通道内设有进液口。',
  '2. 根据权利要求1所述的加热装置，其特征在于，所述加热通道为螺旋形通道。',
].join('\n')

const SPEC = [
  '本实施例提供一种加热装置。',
  '实施例1中，加热通道为螺旋形通道，进液口设在加热通道的一端。',
].join('\n')

/** 有实施例支撑的上位概括。 */
const SUPPORTED_RECORD = JSON.stringify({
  records: [
    {
      claim_no: 1,
      generalization: '螺旋形加热通道',
      quote: '加热通道为螺旋形通道',
      parallel_lower_levels: ['螺旋形通道'],
      all_parallel_same_effect: true,
      defect: 'none',
      reason: '实施例1 公开了螺旋形通道与进液口位置。',
    },
  ],
  notes: '上位概括有对应实施例。',
})

/** 种植缺陷：把螺旋形通道概括为任意形状的加热通道。 */
const PLANTED_DEFECT_RECORD = JSON.stringify({
  records: [
    {
      claim_no: 1,
      generalization: '任意形状的加热通道',
      quote: '加热通道为螺旋形通道',
      parallel_lower_levels: ['螺旋形通道'],
      all_parallel_same_effect: true,
      defect: 'no-embodiment-support',
      reason: '说明书只给出螺旋形通道，没有支撑任意形状。',
    },
  ],
})

const handler = new ClaimBreadthHandler()

describe('claim-breadth 原子', () => {
  it('声明 gate 边界、模型标记与主输出，两个判定键同时出现在输出契约', () => {
    expect(claimBreadthAtom.name).toBe('claim-breadth')
    expect(claimBreadthAtom.category).toBe('gate')
    expect(claimBreadthAtom.usesModel).toBe(true)
    expect(claimBreadthAtom.outputSchema).toEqual([
      'claim_breadth_report',
      'claim_breadth_passed',
      'claim_breadth_records',
      'claim_breadth_failed',
    ])
    for (const key of ['specification', 'claims_draft', 'pfe_triples', 'tech_domain']) {
      expect(claimBreadthAtom.inputSchema).toContain(key)
    }
  })

  it('有实施例支撑的上位概括：摘录命中原文，报告与判定同时产出', async () => {
    const out = await handler.execute({
      state: { specification: SPEC, claims_draft: CLAIMS },
      provider: providerFor(SUPPORTED_RECORD),
    })
    expect(out._error).toBeUndefined()
    expect(out.claim_breadth_passed).toBe(true)
    expect(typeof out.claim_breadth_report).toBe('string')
    expect(out.claim_breadth_failed).toEqual([])
    const records = out.claim_breadth_records as Array<{
      claim_no: number
      passed: boolean
      anchor_reason: string
      anchor?: { start: number; end: number }
    }>
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ claim_no: 1, passed: true, anchor_reason: 'exact' })
    const start = SPEC.indexOf('加热通道为螺旋形通道')
    expect(records[0]?.anchor).toEqual({ start, end: start + '加热通道为螺旋形通道'.length })
  })

  it('种植缺陷「把螺旋形通道概括为任意形状」判未通过', async () => {
    const out = await handler.execute({
      state: { specification: SPEC, claims_draft: CLAIMS },
      provider: providerFor(PLANTED_DEFECT_RECORD),
    })
    expect(out.claim_breadth_passed).toBe(false)
    expect(out.claim_breadth_failed).toEqual(['C1「任意形状的加热通道」'])
    const records = out.claim_breadth_records as Array<{ defect: string; passed: boolean; anchor_reason: string }>
    expect(records[0]).toMatchObject({
      defect: 'no-embodiment-support',
      passed: false,
      anchor_reason: 'exact',
    })
    expect(out.claim_breadth_report).toContain('上位概括无实施例支撑')
    expect(out.claim_breadth_report).toContain('未通过的上位概括：C1「任意形状的加热通道」')
  })

  it('摘录与原文差一个字时锚点不复核通过', async () => {
    const out = await handler.execute({
      state: { specification: SPEC, claims_draft: CLAIMS },
      provider: providerFor(JSON.stringify({
        records: [
          {
            claim_no: 1,
            generalization: '螺旋形加热通道',
            quote: '加热通道为螺旋状通道',
            parallel_lower_levels: ['螺旋形通道'],
            all_parallel_same_effect: true,
            defect: 'none',
            reason: '实施例1 支持。',
          },
        ],
      })),
    })
    expect(out.claim_breadth_passed).toBe(false)
    const records = out.claim_breadth_records as Array<{ anchor_reason: string; anchor?: unknown }>
    expect(records[0]).toMatchObject({ anchor_reason: 'not-found' })
    expect(records[0]?.anchor).toBeUndefined()
  })

  it('空摘录按未通过处理，不允许降级为「通过但无依据」', async () => {
    const out = await handler.execute({
      state: { specification: SPEC, claims_draft: CLAIMS },
      provider: providerFor(JSON.stringify({
        records: [
          {
            claim_no: 1,
            generalization: '任意形状的加热通道',
            quote: '',
            parallel_lower_levels: [],
            all_parallel_same_effect: true,
            defect: 'none',
            reason: '未找到摘录。',
          },
        ],
      })),
    })
    expect(out.claim_breadth_passed).toBe(false)
    const records = out.claim_breadth_records as Array<{ anchor_reason: string }>
    expect(records[0]?.anchor_reason).toBe('empty')
  })

  it('缺某条独立权利要求的记录时降级，不把漏判当通过', async () => {
    const claims = [
      '1. 一种加热装置，其特征在于，包括加热通道。',
      '2. 一种加热装置的制造方法，其特征在于，包括成形加热通道。',
    ].join('\n')
    const out = await handler.execute({
      state: { specification: SPEC, claims_draft: claims },
      provider: providerFor(SUPPORTED_RECORD),
    })
    expect(String(out._error)).toContain('缺少独立权利要求 2')
    expect(out.claim_breadth_report).toBeUndefined()
    expect(out.claim_breadth_passed).toBeUndefined()
  })

  it('领域分叉：软件按模块与输入输出，化学按制备例与效果例', async () => {
    const software: { prompt?: string } = {}
    await handler.execute({
      state: { specification: SPEC, claims_draft: CLAIMS, tech_domain: 'software' },
      provider: providerFor(SUPPORTED_RECORD, software),
    })
    expect(software.prompt).toContain('输入输出')

    const chemical: { prompt?: string } = {}
    await handler.execute({
      state: { specification: SPEC, claims_draft: CLAIMS, tech_domain: 'chemical' },
      provider: providerFor(SUPPORTED_RECORD, chemical),
    })
    expect(chemical.prompt).toContain('制备例')

    const generic: { prompt?: string } = {}
    await handler.execute({
      state: { specification: SPEC, claims_draft: CLAIMS, tech_domain: 'mechanical' },
      provider: providerFor(SUPPORTED_RECORD, generic),
    })
    expect(generic.prompt).toContain('具体实施例')
  })

  it('无 LLM 时降级，不写业务键', async () => {
    const out = await handler.execute({
      state: { specification: SPEC, claims_draft: CLAIMS },
    })
    expect(String(out._error)).toContain('claim-breadth')
    expect(out.claim_breadth_report).toBeUndefined()
    expect(out.claim_breadth_passed).toBeUndefined()
  })

  it('输入缺失时降级', async () => {
    const missingSpec = await handler.execute({
      state: { claims_draft: CLAIMS },
      provider: providerFor(SUPPORTED_RECORD),
    })
    expect(String(missingSpec._error)).toContain('specification')
    const missingClaims = await handler.execute({
      state: { specification: SPEC },
      provider: providerFor(SUPPORTED_RECORD),
    })
    expect(String(missingClaims._error)).toContain('claims_draft')
  })

  it('无行首编号的单条权利要求按第 1 项处理', async () => {
    const out = await handler.execute({
      state: {
        specification: SPEC,
        claims_draft: '一种加热装置，其特征在于，包括螺旋形加热通道。',
      },
      provider: providerFor(SUPPORTED_RECORD),
    })
    expect(out._error).toBeUndefined()
    expect(out.claim_breadth_passed).toBe(true)
    expect((out.claim_breadth_records as Array<{ claim_no: number }>)[0]?.claim_no).toBe(1)
  })

  it('并列下位效果不一致时判未通过，报告如实写出「否」', async () => {
    const out = await handler.execute({
      state: { specification: SPEC, claims_draft: CLAIMS },
      provider: providerFor(JSON.stringify({
        records: [
          {
            claim_no: 1,
            generalization: '加热通道',
            quote: '加热通道为螺旋形通道',
            parallel_lower_levels: ['螺旋形通道', '蛇形通道'],
            all_parallel_same_effect: false,
            defect: 'none',
            reason: '蛇形通道未记载达到同一效果。',
          },
        ],
      })),
    })
    expect(out.claim_breadth_passed).toBe(false)
    expect(out.claim_breadth_report).toContain('效果一致：否')
  })

  it('模型记录字段缺失或类型不符时逐项降级', async () => {
    const base = {
      claim_no: 1,
      generalization: '螺旋形加热通道',
      quote: '加热通道为螺旋形通道',
      parallel_lower_levels: ['螺旋形通道'],
      all_parallel_same_effect: true,
      defect: 'none',
      reason: '实施例1 支持。',
    }
    const cases: Array<{ patch: Record<string, unknown>; expected: string }> = [
      { patch: { claim_no: '1' }, expected: 'claim_no 不是正整数' },
      { patch: { claim_no: 0 }, expected: 'claim_no 不是正整数' },
      { patch: { generalization: '' }, expected: '缺少非空 generalization' },
      { patch: { quote: 42 }, expected: 'quote 不是字符串' },
      { patch: { parallel_lower_levels: [1] }, expected: 'parallel_lower_levels' },
      { patch: { all_parallel_same_effect: 'yes' }, expected: 'all_parallel_same_effect 不是布尔值' },
      { patch: { reason: '' }, expected: '缺少非空 reason' },
    ]
    for (const item of cases) {
      const out = await handler.execute({
        state: { specification: SPEC, claims_draft: CLAIMS },
        provider: providerFor(JSON.stringify({ records: [{ ...base, ...item.patch }] })),
      })
      expect(String(out._error), item.expected).toContain(item.expected)
      expect(out.claim_breadth_passed).toBeUndefined()
    }
  })

  it('notes 不是字符串时降级', async () => {
    const out = await handler.execute({
      state: { specification: SPEC, claims_draft: CLAIMS },
      provider: providerFor(JSON.stringify({ records: [], notes: 42 })),
    })
    expect(String(out._error)).toContain('notes 不是字符串')
  })

  it('阶段参数非法时在调用模型前降级；显式上限生效', async () => {
    const badTemperature = await handler.execute({
      state: { specification: SPEC, claims_draft: CLAIMS, temperature: 3 },
      provider: providerFor(SUPPORTED_RECORD),
    })
    expect(String(badTemperature._error)).toContain('temperature')

    const captured: { prompt?: string } = {}
    const configured = await handler.execute({
      state: { specification: SPEC, claims_draft: CLAIMS, prompt_char_limit: 100 },
      provider: providerFor(SUPPORTED_RECORD, captured),
    })
    expect(configured._error).toBeUndefined()
    expect(captured.prompt).toBeDefined()
  })

  it('PFIE 参考特征优先取自四元组，其次特性数组', async () => {
    const triples: { prompt?: string } = {}
    await handler.execute({
      state: {
        specification: SPEC,
        claims_draft: CLAIMS,
        pfe_triples: [{ problem: '加热不均', feature: '螺旋通道', effect: '均匀加热' }],
      },
      provider: providerFor(SUPPORTED_RECORD, triples),
    })
    expect(triples.prompt).toContain('PFIE 参考特征')
    expect(triples.prompt).toContain('加热不均')

    const features: { prompt?: string } = {}
    await handler.execute({
      state: { specification: SPEC, claims_draft: CLAIMS, features: ['螺旋形加热通道'] },
      provider: providerFor(SUPPORTED_RECORD, features),
    })
    expect(features.prompt).toContain('螺旋形加热通道')
  })

  it('模型调用失败时降级', async () => {
    const out = await handler.execute({
      state: { specification: SPEC, claims_draft: CLAIMS },
      provider: {
        callLLM: async () => {
          throw new Error('连接中断')
        },
      },
    })
    expect(String(out._error)).toContain('LLM 调用失败')
  })

  it('模型输出结构错误时降级，不把半组记录当判定', async () => {
    const unknownClaim = await handler.execute({
      state: { specification: SPEC, claims_draft: CLAIMS },
      provider: providerFor(JSON.stringify({
        records: [
          {
            claim_no: 9,
            generalization: '任意形状的加热通道',
            quote: '加热通道为螺旋形通道',
            parallel_lower_levels: [],
            all_parallel_same_effect: true,
            defect: 'none',
            reason: '实施例1 支持。',
          },
        ],
      })),
    })
    expect(String(unknownClaim._error)).toContain('不在权利要求书中')

    const badDefect = await handler.execute({
      state: { specification: SPEC, claims_draft: CLAIMS },
      provider: providerFor(JSON.stringify({
        records: [
          {
            claim_no: 1,
            generalization: '任意形状的加热通道',
            quote: '加热通道为螺旋形通道',
            parallel_lower_levels: [],
            all_parallel_same_effect: true,
            defect: 'too-broad',
            reason: '实施例1 支持。',
          },
        ],
      })),
    })
    expect(String(badDefect._error)).toContain('defect')

    const notArray = await handler.execute({
      state: { specification: SPEC, claims_draft: CLAIMS },
      provider: providerFor(JSON.stringify({ records: {} })),
    })
    expect(String(notArray._error)).toContain('records 不是数组')

    const notJson = await handler.execute({
      state: { specification: SPEC, claims_draft: CLAIMS },
      provider: providerFor('不是 JSON'),
    })
    expect(String(notJson._error)).toContain('JSON')
  })
})
