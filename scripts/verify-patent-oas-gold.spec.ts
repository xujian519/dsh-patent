// `verify-patent-oas-gold` 是「有脚本 + verify-* 命名」的假绿候选：基线不在仓库里
// 曾是它的默认状态，因此它必须在缺基线时以非 0 退出，而不是打印「回归层休眠」并放行。
// 基线现在随仓提交，缺基线分支改由本条注入的读取结果驱动，不再依赖仓库当前状态。

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { main } from './verify-patent-oas-gold.ts'

const baselinePath = resolve(import.meta.dirname, '../packages/self-evolve/evaluation/patent-oas-baseline.json')

/** 缺基线已不再是仓库的默认状态,该分支由本例的注入驱动。 */
const state = vi.hoisted(() => ({ hideBaseline: false }))

vi.mock('./patent-oas-gate-core.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./patent-oas-gate-core.ts')>()
  return {
    ...actual,
    loadBaselineRecord: async (path: string) => {
      if (state.hideBaseline && path === baselinePath) return undefined
      return await actual.loadBaselineRecord(path)
    },
  }
})

afterEach(() => {
  state.hideBaseline = false
  vi.restoreAllMocks()
})

describe('verify-patent-oas-gold', () => {
  it('passes on the checked-in regression baseline', async () => {
    expect(existsSync(baselinePath)).toBe(true)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(main([])).resolves.toBe(0)
    expect(log.mock.calls.flat().join('\n')).toContain('基线已记录')
    expect(log.mock.calls.flat().join('\n')).toContain('公开授权文本 50 件，附图合计 230 幅；代理师改稿 0/5，未入库。')
    expect(error.mock.calls.flat().join('\n')).toBe('')
  })

  it('refuses to pass while the regression baseline is missing', async () => {
    state.hideBaseline = true
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await expect(main([])).resolves.toBe(1)
    expect(error.mock.calls.flat().join('\n')).toContain('基线未记录')
    expect(log.mock.calls.flat().join('\n')).not.toContain('回归层休眠')
  })
})
