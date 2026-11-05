import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { DEFAULT_FEE_POLICY } from '../src/compute.ts'
import type { FeePolicy } from '../src/compute.ts'
import { loadFeeTable } from '../src/fees.ts'
import { createPatentFeesTool, type PatentFeesOutput } from '../src/tool/patent-fees.ts'
import type { FeeTable } from '../src/types.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

/** The packaged index: amounts transcribed from the official fee standard. */
const shipped = loadFeeTable()

/** One transcribed fee item, as a table. */
function tableOf(
  id: string,
  name: string,
  trigger: FeeTable['items'][number]['trigger'],
  extra: Partial<FeeTable['items'][number]> = {},
  reductions: FeeTable['reductions'] = [],
): FeeTable {
  return {
    document: 'fixture',
    revision: null,
    currency: 'CNY',
    sourceDoc: null,
    effectiveFrom: null,
    verifiedOn: null,
    reductions,
    items: [{
      id,
      name,
      trigger,
      patentTypes: null,
      basis: 'per-case',
      amount: '900',
      reducible: null,
      tiers: [],
      legalBasis: '专利法实施细则第110条',
      sourceDoc: '公告第 1 号',
      effectiveFrom: '2026-01-01',
      verifiedOn: '2026-01-01',
      ...extra,
    }],
  }
}

/** The transcribed table plus one item whose amount is still untranscribed. */
const partlyTranscribed: FeeTable = (() => {
  const base = tableOf('application-fee', '申请费', 'filing')
  return {
    ...base,
    items: [
      ...base.items,
      { ...base.items[0]!, id: 'record-copy-fee', name: '专利文件副本证明费', trigger: 'grant-registration', amount: null, verifiedOn: null },
    ],
  }
})()

async function host(table: FeeTable = shipped, policy: FeePolicy = DEFAULT_FEE_POLICY): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.tools.register(createPatentFeesTool({ table, policy }))
  return ctx
}

function execute(ctx: Context, args: unknown) {
  return executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId('patent-fees'),
    name: 'patent_fees',
    arguments: args,
  })
}

/** Execute and return the canonical output value. */
async function run(ctx: Context, args: unknown): Promise<PatentFeesOutput> {
  const result = await execute(ctx, args)
  expect(result.isError).toBe(false)
  return result.value as PatentFeesOutput
}

const rendered = (result: { content: unknown }): string => JSON.stringify(result.content)

describe('patent_fees tool', () => {
  it('prices the shipped index and refuses a total while one item has no amount', async () => {
    const result = await execute(await host(), {
      patentType: 'invention',
      triggers: ['filing'],
      specificationPages: 40,
    })
    const text = rendered(result)
    expect(text).toContain('| 费用项 | 计数依据 | 数量 | 单价(CNY) | 小计 | 应付 | 金额状态 | 依据 |')
    expect(text).toContain('| 申请费 | 每件 | 1 | 900 | 900.00 | 900.00 | 已核验 | 专利法实施细则第110条第1款第（一）项、第112条 |')
    expect(text).toContain('| 公布印刷费 | 每件 | 1 | 50 | 50.00 | 50.00 | 已核验 |')
    expect(text).toContain('| 说明书附加费 |')
    expect(text).toContain('金额未转录')
    expect(text).toContain('本次未给出合计')
    expect(text).toContain('缺少的金额或案件事实是未知，不是零')
    expect(text).toContain('**待补输入**')
    expect(text).toContain('- 权利要求附加费（claims-surcharge）：需要 claims——')
  })

  it('withholds the total while an applicable item is waiting for a case fact', async () => {
    const claims = tableOf('claims-surcharge', '权利要求附加费', 'filing', {
      basis: 'per-claim-beyond',
      freeUnits: 10,
      amount: '150',
    })
    const result = await execute(await host(claims), { patentType: 'invention', triggers: ['filing'] })
    const value = result.value as PatentFeesOutput
    expect(value.total).toEqual({ complete: false, unverifiedIds: ['claims-surcharge'] })
    expect(value.total.amount).toBeUndefined()
    expect(rendered(result)).toContain('本次未给出合计')
    expect(rendered(result)).toContain('- 权利要求附加费（claims-surcharge）：需要 claims——')
  })

  it('withholds the total and names a trigger the index does not carry', async () => {
    const result = await execute(await host(), {
      patentType: 'invention',
      triggers: ['grant-registration'],
    })
    expect(result.isError).toBe(false)
    const value = result.value as PatentFeesOutput
    expect(value.total).toEqual({
      complete: false,
      unverifiedIds: [],
      uncoveredTriggers: ['grant-registration'],
    })
    const text = rendered(result)
    expect(text).toContain('索引未收录收费阶段 grant-registration')
    expect(text).not.toContain('合计（全部已核验）')
  })

  it('omits every unrecorded field from the output value', async () => {
    const bare = tableOf('application-fee', '申请费', 'filing', {
      amount: null,
      legalBasis: null,
      sourceDoc: null,
      effectiveFrom: null,
      verifiedOn: null,
    })
    const value = await run(await host(bare), {
      patentType: 'invention',
      triggers: ['filing'],
      claims: 12,
      priorityClaims: 1,
    })
    // Nothing about this item is recorded, so only the shape of the count and
    // the status are left.
    const line = value.lines[0]
    expect(Object.keys(line ?? {}).sort()).toEqual([
      'basis',
      'id',
      'name',
      'notes',
      'quantity',
      'quantityBasis',
      'status',
    ])
    expect(value.total.amount).toBeUndefined()
    expect(value.reduction).toBeUndefined()
  })

  it('renders the total of a fully transcribed case', async () => {
    const result = await execute(await host(tableOf('application-fee', '申请费', 'filing')), {
      patentType: 'invention',
      triggers: ['filing'],
    })
    expect(rendered(result)).toContain('**合计（全部已核验）**：900.00 CNY')
  })

  it('renders a partial total of the verified lines when the policy allows it', async () => {
    const result = await execute(await host(partlyTranscribed, { failOnUnverified: false }), {
      patentType: 'invention',
      triggers: ['filing', 'grant-registration'],
    })
    expect(rendered(result)).toContain('**部分合计**：900.00 CNY（仅含已核验项；record-copy-fee 未计入）')

    const strict = await execute(await host(partlyTranscribed), {
      patentType: 'invention',
      triggers: ['filing', 'grant-registration'],
    })
    expect(rendered(strict)).toContain('本次未给出合计')
  })

  it('renders the pending inputs, the reduction outcome and the notes', async () => {
    const result = await execute(await host(), {
      patentType: 'invention',
      triggers: ['filing'],
      claims: 12,
      specificationPages: 40,
      reduction: { kind: 'individual', filed: false },
    })
    const text = rendered(result)
    expect(text).toContain('**费用减缴**：未办理费减备案：仅对不以此为前提的费种适用。')
    expect(text).toContain('- 优先权要求费（priority-claim-fee）：需要 priorityClaims')
    expect(text).toContain('**说明**')
    expect(text).toContain('- 本次减缴请求未办理费减备案。')
    expect(text).toContain('未办理费减备案：不得按减缴计算，本项按全额计。')
    expect(text).toContain('本项不属于费用减缴范围：按全额计。')
  })

  it('reports a reduction whose ratio the index does not record', async () => {
    const unrecordedRatio = tableOf(
      'application-fee',
      '申请费',
      'filing',
      { reducible: true },
      [{
        kind: 'individual',
        label: '个人',
        reductionPercent: null,
        requiresFiling: true,
        sourceDoc: null,
        effectiveFrom: null,
        verifiedOn: null,
      }],
    )
    const result = await execute(await host(unrecordedRatio), {
      patentType: 'invention',
      triggers: ['filing'],
      reduction: { kind: 'individual', filed: true },
    })
    const text = rendered(result)
    expect(text).toContain('**费用减缴**：减缴比例未转录：本次不给减缴后金额。')
    expect(text).toContain('减缴比例未转录：无法给出减缴后金额。')
    // The ratio is left out of the value rather than reported as absent.
    expect((result.value as { reduction?: { reductionPercent?: string } }).reduction?.reductionPercent)
      .toBeUndefined()
  })

  it('renders the notice for a case whose triggers match no indexed item', async () => {
    const result = await execute(await host(tableOf('application-fee', '申请费', 'filing')), {
      patentType: 'design',
      triggers: ['invalidation'],
    })
    expect(rendered(result)).toContain('本次没有可计价的费用条目')
  })

  it('renders the annual fee of each named year and the surcharge on it', async () => {
    const annual = tableOf('annual-fee', '年费', 'annual-fee', {
      basis: 'per-annuity-year',
      latePayment: {
        monthlyPercent: 5,
        maxMonths: 6,
        legalBasis: '专利法实施细则第115条',
        sourceDoc: null,
        effectiveFrom: null,
        verifiedOn: '2026-01-01',
      },
    })
    const result = await execute(await host(annual), {
      patentType: 'invention',
      triggers: ['annual-fee'],
      annuityYears: [4],
      lateMonths: 2,
    })
    const text = rendered(result)
    expect(text).toContain('| 年费（第 4 年度） | 第 4 年度 | 1 | 900 | 900.00 | 900.00 | 已核验 |')
    expect(text).toContain('| 年费滞纳金（第 4 年度） | 超期 2 个月，每月加收当年全额年费的 5% | 2 | 45.00 | 90.00 | 90.00 | 已核验 |')
    expect(text).toContain('**合计（全部已核验）**：990.00 CNY')
  })

  it('prices an extension and a reduction whose ratio is transcribed', async () => {
    const extension = tableOf('extension-fee', '延长期限请求费', 'extension', { basis: 'per-month', amount: '200' })
    const extended = await execute(await host(extension), {
      patentType: 'invention',
      triggers: ['extension'],
      extensionMonths: 2,
    })
    expect(rendered(extended)).toContain('| 延长期限请求费 | 2 个月 | 2 | 200 | 400.00 | 400.00 | 已核验 |')

    const reducible = tableOf(
      'application-fee',
      '申请费',
      'filing',
      { reducible: true },
      [{
        kind: 'individual',
        label: '个人',
        reductionPercent: 85,
        requiresFiling: true,
        sourceDoc: '公告第 2 号',
        effectiveFrom: null,
        verifiedOn: '2026-02-01',
      }],
    )
    const reduced = await execute(await host(reducible), {
      patentType: 'invention',
      triggers: ['filing'],
      reduction: { kind: 'individual', filed: true },
    })
    expect(rendered(reduced)).toContain('**费用减缴**：已按减缴 85% 计算适用费种。')
    expect(rendered(reduced)).toContain('**合计（全部已核验）**：135.00 CNY')
  })

  it('reports a call that names no step as an input error', async () => {
    const result = await execute(await host(), { patentType: 'invention', triggers: [] })
    expect(result.isError).toBe(true)
    expect(rendered(result)).toContain('triggers 不能为空')
  })

  it('reports a count that cannot be a quantity as an input error', async () => {
    expect(rendered(await execute(await host(), { patentType: 'invention', triggers: ['filing'], claims: -1 })))
      .toContain('claims 必须是非负整数，得到：-1')
    expect(rendered(await execute(await host(), { patentType: 'invention', triggers: ['filing'], claims: 1.5 })))
      .toContain('claims 必须是非负整数，得到：1.5')
  })

  it('reports a patent year that cannot exist as an input error', async () => {
    const result = await execute(await host(), { patentType: 'invention', triggers: ['annual-fee'], annuityYears: [0] })
    expect(result.isError).toBe(true)
    expect(rendered(result)).toContain('annuityYears 只能是正整数专利年度，得到：0')
  })
})
