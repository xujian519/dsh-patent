import { describe, expect, it } from 'vitest'
import {
  ClaimChartHandler,
  LookupStageHandler,
  registerBuiltinAtoms,
  type StageProvider,
} from '@deepseek-ai/dsh-patent-core'
import { deriveOfficeActionTargets } from '../src/atoms/handlers/builtin/chart.ts'

registerBuiltinAtoms()

const run = async (name: string, state: Record<string, unknown>): Promise<Record<string, unknown>> => {
  const handler = LookupStageHandler(name)
  if (handler === undefined) throw new Error(`未注册的原子: ${name}`)
  return await handler.execute({ state })
}

const CLAIM = '1. 一种过滤装置，包括壳体和滤芯。'

const failingProvider: StageProvider = {
  callLLM: async () => {
    throw new Error('畸形输入应在调用模型前降级')
  },
}

describe('response-plan：畸形 office_action', () => {
  it.each(['null', '[]', '42'])('%s 不是 JSON 对象时降级', async (raw) => {
    const out = await run('response-plan', { office_action: raw })
    expect(String(out._error)).toContain('[response-plan]')
    expect(String(out._error)).toContain('不是 JSON 对象')
  })

  it('缺少 rejectionTypes 数组时降级', async () => {
    const out = await run('response-plan', {
      office_action: JSON.stringify({ rejectionType: 'inventiveness', affectedClaims: [1] }),
    })
    expect(String(out._error)).toContain('缺少 rejectionTypes 数组')
  })

  it('驳回理由不在取值域内时降级并带下标', async () => {
    const out = await run('response-plan', {
      office_action: JSON.stringify({
        rejectionType: 'inventiveness',
        rejectionTypes: ['inventiveness', 'bogus'],
        affectedClaims: [1],
      }),
    })
    expect(String(out._error)).toContain('rejectionTypes[1] 非法')
  })

  it('rejectionType 不在取值域内时降级', async () => {
    const out = await run('response-plan', {
      office_action: JSON.stringify({ rejectionType: 'bogus', rejectionTypes: [], affectedClaims: [] }),
    })
    expect(String(out._error)).toContain('缺少合法的 rejectionType')
  })

  it('受影响权项不是正整数时降级并带下标', async () => {
    const out = await run('response-plan', {
      office_action: JSON.stringify({
        rejectionType: 'inventiveness',
        rejectionTypes: ['inventiveness'],
        affectedClaims: [1, '2'],
      }),
    })
    expect(String(out._error)).toContain('affectedClaims[1] 不是正整数')
  })
})

describe('coverage：畸形 claim_chart_doc', () => {
  it('缺少 targets/elements/rows 时降级并指明字段', async () => {
    const out = await run('coverage', { claim_chart_doc: '{"mode":"infringement"}' })
    expect(String(out._error)).toContain('[coverage]')
    expect(String(out._error)).toContain('targets 不是数组')
  })

  it('rows 含 null 条目时降级并带下标', async () => {
    const out = await run('coverage', {
      claim_chart_doc: JSON.stringify({
        mode: 'infringement',
        targets: [{ id: '产品A', kind: 'accused-product' }],
        elements: [{ id: '1a', claimNo: 1 }],
        rows: [null],
      }),
    })
    expect(String(out._error)).toContain('rows[0] 不是对象')
  })

  it('target 含 null 条目时降级并带下标', async () => {
    const out = await run('coverage', {
      claim_chart_doc: JSON.stringify({ mode: 'infringement', targets: [null], elements: [], rows: [] }),
    })
    expect(String(out._error)).toContain('targets[0] 不是对象')
  })

  it('缺少 mode 或 target 字段非法时降级并指明位置', async () => {
    const noMode = await run('coverage', { claim_chart_doc: JSON.stringify({ targets: [], elements: [], rows: [] }) })
    expect(String(noMode._error)).toContain('mode 缺失')

    const noId = await run('coverage', {
      claim_chart_doc: JSON.stringify({ mode: 'infringement', targets: [{ kind: 'accused-product' }], elements: [], rows: [] }),
    })
    expect(String(noId._error)).toContain('targets[0] 缺少 id')

    const badKind = await run('coverage', {
      claim_chart_doc: JSON.stringify({ mode: 'infringement', targets: [{ id: 'X', kind: 'bogus' }], elements: [], rows: [] }),
    })
    expect(String(badKind._error)).toContain('targets[0] 的 kind 非法')
  })

  it('elements 与 rows 的非数组、非对象或缺字段条目逐项降级', async () => {
    const targets = [{ id: '产品A', kind: 'accused-product' }]
    const notArray = await run('coverage', {
      claim_chart_doc: JSON.stringify({ mode: 'infringement', targets, elements: {}, rows: [] }),
    })
    expect(String(notArray._error)).toContain('elements 不是数组')

    const elementNull = await run('coverage', {
      claim_chart_doc: JSON.stringify({ mode: 'infringement', targets, elements: [null], rows: [] }),
    })
    expect(String(elementNull._error)).toContain('elements[0] 不是对象')

    const elementNoId = await run('coverage', {
      claim_chart_doc: JSON.stringify({ mode: 'infringement', targets, elements: [{}], rows: [] }),
    })
    expect(String(elementNoId._error)).toContain('elements[0] 缺少 id')

    const rowsNotArray = await run('coverage', {
      claim_chart_doc: JSON.stringify({ mode: 'infringement', targets, elements: [], rows: null }),
    })
    expect(String(rowsNotArray._error)).toContain('rows 不是数组')

    const rowNoElement = await run('coverage', {
      claim_chart_doc: JSON.stringify({
        mode: 'infringement',
        targets,
        elements: [],
        rows: [{ targetId: '产品A', mapping: 'literal' }],
      }),
    })
    expect(String(rowNoElement._error)).toContain('rows[0] 缺少 elementId')

    const rowNoTarget = await run('coverage', {
      claim_chart_doc: JSON.stringify({
        mode: 'infringement',
        targets,
        elements: [],
        rows: [{ elementId: '1a', mapping: 'literal' }],
      }),
    })
    expect(String(rowNoTarget._error)).toContain('rows[0] 缺少 targetId')
  })

  it('row 的 mapping 非法时降级并带下标', async () => {
    const out = await run('coverage', {
      claim_chart_doc: JSON.stringify({
        mode: 'infringement',
        targets: [{ id: '产品A', kind: 'accused-product' }],
        elements: [{ id: '1a', claimNo: 1 }],
        rows: [{ elementId: '1a', targetId: '产品A', mapping: 'bogus' }],
      }),
    })
    expect(String(out._error)).toContain('rows[0] 的 mapping 非法')
  })
})

describe('claim-chart：畸形 chart_targets', () => {
  it('null 条目降级并带下标，且不调用模型', async () => {
    let calls = 0
    const provider: StageProvider = {
      callLLM: async () => {
        calls += 1
        throw new Error('不应调用模型')
      },
    }
    const handler = new ClaimChartHandler()
    const state = await handler.execute({
      state: { claim: CLAIM, chart_targets: JSON.stringify([null]), chart_mode: 'invalidity' },
      provider,
    })
    expect(String(state._error)).toContain('chart_targets[0] 不是对象')
    expect(calls).toBe(0)
  })

  it('缺 id 的条目降级并带下标', async () => {
    const handler = new ClaimChartHandler()
    const state = await handler.execute({
      state: { claim: CLAIM, chart_targets: JSON.stringify([{ kind: 'prior-art' }]), chart_mode: 'invalidity' },
      provider: failingProvider,
    })
    expect(String(state._error)).toContain('chart_targets[0] 缺少 id')
  })
})

describe('deriveOfficeActionTargets：畸形解析产出', () => {
  it('null / 数组 / 缺 citations 时返回空目标', () => {
    expect(deriveOfficeActionTargets('null')).toEqual([])
    expect(deriveOfficeActionTargets('[]')).toEqual([])
    expect(deriveOfficeActionTargets('{"citations":null}')).toEqual([])
    expect(deriveOfficeActionTargets('not-json')).toEqual([])
  })

  it('跳过 null 条目与缺失文献号的引用，保留合法文献', () => {
    const targets = deriveOfficeActionTargets(
      JSON.stringify({
        citations: [null, { relevancy: 'Y' }, { documentNumber: 'CN1' }, { documentNumber: ' CN1 ' }, 'x'],
      }),
    )
    expect(targets).toEqual([{ id: 'CN1', kind: 'prior-art' }])
  })
})
