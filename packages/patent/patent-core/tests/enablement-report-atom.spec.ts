import { describe, expect, it } from 'vitest'
import {
  EnablementReportHandler,
  enablementReportAtom,
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
  '1. 一种检测装置，其特征在于，包括壳体，所述壳体内设有弹簧。',
  '2. 根据权利要求1所述的检测装置，其特征在于，所述弹簧为螺旋弹簧。',
].join('\n')

const SPEC = [
  '本实施例提供一种检测装置。',
  '实施例1中，检测装置包括壳体，壳体内设有弹簧，弹簧的刚度为 5 N/mm。',
].join('\n')

/** 两条记录全部命中原文的最小模型输出。 */
const CLEAN_RECORDS = JSON.stringify({
  records: [
    { feature_id: 'C1F1', quote: '检测装置包括壳体', embodiment_id: '实施例1', parameter_or_effect: '壳体壁厚 2 mm', enabled: true },
    { feature_id: 'C1F2', quote: '壳体内设有弹簧', embodiment_id: '实施例1', parameter_or_effect: '弹簧刚度 5 N/mm', enabled: true },
  ],
  notes: '实施例1 给出了结构、参数与效果。',
})

const handler = new EnablementReportHandler()

describe('enablement-report 原子', () => {
  it('声明 gate 边界、模型标记与主输出，两个判定键同时出现在输出契约', () => {
    expect(enablementReportAtom.name).toBe('enablement-report')
    expect(enablementReportAtom.category).toBe('gate')
    expect(enablementReportAtom.usesModel).toBe(true)
    expect(enablementReportAtom.outputSchema).toEqual([
      'enablement_report',
      'enablement_passed',
      'enablement_records',
      'enablement_missing',
    ])
    for (const key of ['specification', 'claims_draft', 'pfe_triples', 'figure_analysis', 'tech_domain']) {
      expect(enablementReportAtom.inputSchema).toContain(key)
    }
  })

  it('干净说明书：每条独权特征的摘录命中原文，报告与判定同时产出', async () => {
    const out = await handler.execute({
      state: { specification: SPEC, claims_draft: CLAIMS },
      provider: providerFor(CLEAN_RECORDS),
    })
    expect(out._error).toBeUndefined()
    expect(out.enablement_passed).toBe(true)
    expect(typeof out.enablement_report).toBe('string')
    expect(out.enablement_missing).toEqual([])
    const records = out.enablement_records as Array<{
      feature_id: string
      enabled: boolean
      anchor_reason: string
      anchor?: { start: number; end: number }
    }>
    expect(records.map(record => record.feature_id)).toEqual(['C1F1', 'C1F2'])
    expect(records.every(record => record.enabled)).toBe(true)
    expect(records.every(record => record.anchor_reason === 'exact')).toBe(true)
    // 命中区间指向说明书原文下标，切片可还原摘录。
    for (const record of records) {
      expect(SPEC.slice(record.anchor?.start, record.anchor?.end)).toContain('')
    }
    expect(records[0]?.anchor).toEqual({ start: SPEC.indexOf('检测装置包括壳体'), end: SPEC.indexOf('检测装置包括壳体') + '检测装置包括壳体'.length })
  })

  it('任一摘录未命中原文时判未通过（拒绝路径）', async () => {
    const out = await handler.execute({
      state: { specification: SPEC, claims_draft: CLAIMS },
      provider: providerFor(JSON.stringify({
        records: [
          { feature_id: 'C1F1', quote: '检测装置包括壳体', embodiment_id: '实施例1', parameter_or_effect: '壁厚 2 mm', enabled: true },
          { feature_id: 'C1F2', quote: '壳体内设有减震垫', embodiment_id: '实施例1', parameter_or_effect: '刚度 5 N/mm', enabled: true },
        ],
      })),
    })
    expect(out.enablement_passed).toBe(false)
    expect(out.enablement_missing).toEqual(['C1F2'])
    const records = out.enablement_records as Array<{ feature_id: string; enabled: boolean; anchor_reason: string }>
    expect(records.find(record => record.feature_id === 'C1F2')).toMatchObject({
      enabled: false,
      anchor_reason: 'not-found',
    })
    expect(out.enablement_report).toContain('未通过')
    expect(out.enablement_report).toContain('未覆盖的独立权利要求特征：C1F2')
  })

  it('说明书缺参数/缺实施例：模型判 false 时判未通过', async () => {
    const out = await handler.execute({
      state: {
        specification: '本实施例提供一种检测装置。实施例1中，检测装置包括壳体，壳体内设有弹簧。',
        claims_draft: CLAIMS,
        tech_domain: 'mechanical',
      },
      provider: providerFor(JSON.stringify({
        records: [
          { feature_id: 'C1F1', quote: '检测装置包括壳体', embodiment_id: '实施例1', parameter_or_effect: '未给出壳体参数', enabled: false },
          { feature_id: 'C1F2', quote: '壳体内设有弹簧', embodiment_id: '实施例1', parameter_or_effect: '未给出弹簧参数', enabled: false },
        ],
      })),
    })
    expect(out.enablement_passed).toBe(false)
    expect(out.enablement_missing).toEqual(['C1F1', 'C1F2'])
    expect(out.enablement_report).toContain('模型判定该特征无法实现')
  })

  it('缺少某条特征的记录时同样判未通过，并记录为空摘录', async () => {
    const out = await handler.execute({
      state: { specification: SPEC, claims_draft: CLAIMS },
      provider: providerFor(JSON.stringify({
        records: [
          { feature_id: 'C1F1', quote: '检测装置包括壳体', embodiment_id: '实施例1', parameter_or_effect: '壁厚 2 mm', enabled: true },
        ],
      })),
    })
    expect(out.enablement_passed).toBe(false)
    expect(out.enablement_missing).toEqual(['C1F2'])
    const records = out.enablement_records as Array<{ feature_id: string; quote: string; anchor_reason: string }>
    expect(records.find(record => record.feature_id === 'C1F2')).toMatchObject({
      quote: '',
      anchor_reason: 'empty',
    })
  })

  it('从属权利要求不进入特征派生；无编号权利要求按第 1 项处理', async () => {
    const out = await handler.execute({
      state: {
        specification: SPEC,
        claims_draft: '一种检测装置，其特征在于，包括壳体，所述壳体内设有弹簧。',
      },
      provider: providerFor(CLEAN_RECORDS),
    })
    expect(out.enablement_passed).toBe(true)
    expect((out.enablement_records as unknown[]).length).toBe(2)
  })

  it('无特征部标记时去掉前序分句，附图标记去重后进入提示词', async () => {
    const captured: { prompt?: string } = {}
    const out = await handler.execute({
      state: {
        specification: SPEC,
        claims_draft: '一种检测装置，包括壳体，所述壳体内设有弹簧。',
        figure_analysis: [
          null,
          { components: '未提供' },
          { components: [null, { refNumber: '' }, { refNumber: '10' }, { refNumber: '10' }] },
        ],
      },
      provider: providerFor(CLEAN_RECORDS, captured),
    })
    expect(out.enablement_passed).toBe(true)
    expect((out.enablement_records as unknown[]).length).toBe(2)
    expect(captured.prompt).toContain('【附图标记】')
    expect(captured.prompt).toContain('10')
  })

  it('无前序分句时保留全文；只有从属权利要求时降级', async () => {
    const captured: { prompt?: string } = {}
    const out = await handler.execute({
      state: { specification: '阀体包括壳体。壳体包括阀座。', claims_draft: '1. 阀体，包括壳体。' },
      provider: providerFor(JSON.stringify({
        records: [
          { feature_id: 'C1F1', quote: '阀体包括壳体', embodiment_id: '实施例1', parameter_or_effect: '铸钢', enabled: true },
          { feature_id: 'C1F2', quote: '壳体包括阀座', embodiment_id: '实施例1', parameter_or_effect: '不锈钢', enabled: true },
        ],
      }), captured),
    })
    expect(out.enablement_passed).toBe(true)
    expect(captured.prompt).toContain('阀体')

    const dependentOnly = await handler.execute({
      state: { specification: SPEC, claims_draft: '2. 根据权利要求1所述的装置，其特征在于，所述弹簧为螺旋弹簧。' },
      provider: providerFor(CLEAN_RECORDS),
    })
    expect(String(dependentOnly._error)).toContain('无法从 state.claims_draft 派生')
  })

  it('records 缺 parameter_or_effect 时降级', async () => {
    const out = await handler.execute({
      state: { specification: SPEC, claims_draft: CLAIMS },
      provider: providerFor(JSON.stringify({
        records: [
          { feature_id: 'C1F1', quote: '检测装置包括壳体', embodiment_id: '实施例1', parameter_or_effect: '', enabled: true },
        ],
      })),
    })
    expect(String(out._error)).toContain('parameter_or_effect')
  })

  it('records 各字段缺失或类型不符时逐项降级', async () => {
    const cases = [
      { record: { quote: '检测装置包括壳体', embodiment_id: '实施例1', parameter_or_effect: '壁厚', enabled: true }, message: 'feature_id' },
      { record: { feature_id: 'C1F1', quote: 1, embodiment_id: '实施例1', parameter_or_effect: '壁厚', enabled: true }, message: 'quote 不是字符串' },
      { record: { feature_id: 'C1F1', quote: '检测装置包括壳体', parameter_or_effect: '壁厚', enabled: true }, message: 'embodiment_id' },
      { record: { feature_id: 'C1F1', quote: '检测装置包括壳体', embodiment_id: '实施例1', parameter_or_effect: '壁厚', enabled: 'true' }, message: 'enabled 不是布尔值' },
    ]
    for (const { record, message } of cases) {
      const out = await handler.execute({
        state: { specification: SPEC, claims_draft: CLAIMS },
        provider: providerFor(JSON.stringify({ records: [record] })),
      })
      expect(String(out._error)).toContain(message)
    }
  })

  it('模型给出空摘录时判未通过，原因记为摘录为空', async () => {
    const out = await handler.execute({
      state: { specification: SPEC, claims_draft: CLAIMS },
      provider: providerFor(JSON.stringify({
        records: [
          { feature_id: 'C1F1', quote: '', embodiment_id: '实施例1', parameter_or_effect: '壁厚', enabled: true },
          { feature_id: 'C1F2', quote: '壳体内设有弹簧', embodiment_id: '实施例1', parameter_or_effect: '刚度', enabled: true },
        ],
      })),
    })
    expect(out.enablement_passed).toBe(false)
    expect(out.enablement_report).toContain('摘录为空')
  })

  it('空权利要求无法派生特征时降级', async () => {
    const out = await handler.execute({
      state: { specification: SPEC, claims_draft: '1. 。' },
      provider: providerFor(CLEAN_RECORDS),
    })
    expect(String(out._error)).toContain('无法从 state.claims_draft 派生')
  })

  it('领域分叉：软件按模块与输入输出，化学按制备例与效果例', async () => {
    const software: { prompt?: string } = {}
    await handler.execute({
      state: { specification: SPEC, claims_draft: CLAIMS, tech_domain: 'software' },
      provider: providerFor(CLEAN_RECORDS, software),
    })
    expect(software.prompt).toContain('模块')
    expect(software.prompt).toContain('输入输出')

    const chemical: { prompt?: string } = {}
    await handler.execute({
      state: { specification: SPEC, claims_draft: CLAIMS, tech_domain: 'chemical' },
      provider: providerFor(CLEAN_RECORDS, chemical),
    })
    expect(chemical.prompt).toContain('制备例')
    expect(chemical.prompt).toContain('效果例')

    const generic: { prompt?: string } = {}
    await handler.execute({
      state: { specification: SPEC, claims_draft: CLAIMS, tech_domain: 'mechanical' },
      provider: providerFor(CLEAN_RECORDS, generic),
    })
    expect(generic.prompt).toContain('具体实施例')
    expect(generic.prompt).toContain('实施例1')
  })

  it('无 LLM 时降级，不写业务键', async () => {
    const out = await handler.execute({
      state: { specification: SPEC, claims_draft: CLAIMS },
    })
    expect(String(out._error)).toContain('enablement-report')
    expect(out.enablement_report).toBeUndefined()
    expect(out.enablement_passed).toBeUndefined()
  })

  it('输入缺失或无法派生特征时降级', async () => {
    const missingSpec = await handler.execute({
      state: { claims_draft: CLAIMS },
      provider: providerFor(CLEAN_RECORDS),
    })
    expect(String(missingSpec._error)).toContain('specification')
    const missingClaims = await handler.execute({
      state: { specification: SPEC },
      provider: providerFor(CLEAN_RECORDS),
    })
    expect(String(missingClaims._error)).toContain('claims_draft')
  })

  it('模型输出结构错误时降级，不把半组记录当判定', async () => {
    const unknown = await handler.execute({
      state: { specification: SPEC, claims_draft: CLAIMS },
      provider: providerFor(JSON.stringify({
        records: [
          { feature_id: 'C9F1', quote: '检测装置包括壳体', embodiment_id: '实施例1', parameter_or_effect: '壁厚', enabled: true },
        ],
      })),
    })
    expect(String(unknown._error)).toContain('未知 feature_id')

    const duplicate = await handler.execute({
      state: { specification: SPEC, claims_draft: CLAIMS },
      provider: providerFor(JSON.stringify({
        records: [
          { feature_id: 'C1F1', quote: '检测装置包括壳体', embodiment_id: '实施例1', parameter_or_effect: '壁厚', enabled: true },
          { feature_id: 'C1F1', quote: '检测装置包括壳体', embodiment_id: '实施例1', parameter_or_effect: '壁厚', enabled: true },
        ],
      })),
    })
    expect(String(duplicate._error)).toContain('重复')

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
