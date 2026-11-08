import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gateRenderedSvg } from '../src/figure/render-check-gate.ts'

/**
 * 生成时复核门禁的边界：净距 0 只关净距、不关穿字；strict 只在有阻断级发现时失败；
 * 读不回的路径只记警告。
 */

const HEAD = '<svg xmlns="http://www.w3.org/2000/svg" width="120mm" height="40mm" viewBox="0 0 120 40"><g fill="none" stroke="#000000">'
const TAIL = '</g></svg>'

/** 跨组线穿过文字：阻断级发现。 */
const CROSSED = `${HEAD}<line x1="60" y1="5" x2="60" y2="35" stroke-width="0.25"/><text x="60" y="22" text-anchor="middle">条件</text>${TAIL}`
/** 线离文字框上边约 1 毫米：净距不足，但不穿字。 */
const NEAR_MISS = `${HEAD}<line x1="40" y1="9" x2="80" y2="9" stroke-width="0.25"/><text x="60" y="22" text-anchor="middle">条件</text>${TAIL}`
/** 干净图：一条线与一个相距很远的文字。 */
const CLEAN = `${HEAD}<line x1="10" y1="35" x2="40" y2="35" stroke-width="0.25"/><text x="90" y="12" text-anchor="middle">条件</text>${TAIL}`

async function withSvg(content: string, run: (path: string, warnings: string[]) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gate-'))
  const path = join(dir, 'fig1.svg')
  writeFileSync(path, content)
  try {
    await run(path, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('gateRenderedSvg', () => {
  it('净距为 0 时只判穿字，不报贴靠', () => withSvg(NEAR_MISS, async (path, warnings) => {
    await gateRenderedSvg({ path, warnings, clearanceMm: 0, failOnFindings: false, tool: 'generate_patent_figure' })
    expect(warnings).toEqual([])

    await gateRenderedSvg({ path, warnings, clearanceMm: 1.5, failOnFindings: false, tool: 'generate_patent_figure' })
    expect(warnings.some(warning => warning.includes('不足 1.5 毫米净距'))).toBe(true)
  }))

  it('strict 且无阻断级发现时不失败', () => withSvg(CLEAN, async (path, warnings) => {
    await expect(gateRenderedSvg({
      path,
      warnings,
      clearanceMm: 1.5,
      failOnFindings: true,
      tool: 'generate_patent_figure',
    })).resolves.toBeUndefined()
  }))

  it('strict 命中时抛错，label 与路径都写进错误', () => withSvg(CROSSED, async (path, warnings) => {
    const failure = await gateRenderedSvg({
      path,
      warnings,
      clearanceMm: 1.5,
      failOnFindings: true,
      tool: 'generate_structure_figure',
      label: '图2 ',
    }).catch((caught: unknown) => caught)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('渲染复核未通过')
    expect((failure as Error).message).toContain('图2 ')
    expect((failure as Error).message).toContain(path)
  }))

  it('读不到的路径只记警告，不把已完成的生成判成失败', async () => {
    const warnings: string[] = []
    await gateRenderedSvg({
      path: join(tmpdir(), 'dsh-gate-does-not-exist', 'fig1.svg'),
      warnings,
      clearanceMm: 1.5,
      failOnFindings: true,
      tool: 'generate_patent_figure',
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('渲染复核被跳过')
  })
})

describe('gateRenderedSvg 版面利用率', () => {
  it('提示级发现不阻断 strict，只进警告', () => withSvg(CLEAN, async (path, warnings) => {
    // 干净图但内容只占画布约三分之一：strict 门禁仍须放行——撑不满纸面不是画错。
    await expect(gateRenderedSvg({
      path,
      warnings,
      clearanceMm: 1.5,
      failOnFindings: true,
      tool: 'generate_structure_figure',
      minSheetFillRatio: 0.9,
    })).resolves.toBeUndefined()
    expect(warnings.some(warning => warning.includes('撑不满纸面'))).toBe(true)
  }))

  it('不给下限时完全不判', () => withSvg(CLEAN, async (path, warnings) => {
    await gateRenderedSvg({
      path, warnings, clearanceMm: 1.5, failOnFindings: true, tool: 'generate_structure_figure',
    })
    expect(warnings).toEqual([])
  }))
})
