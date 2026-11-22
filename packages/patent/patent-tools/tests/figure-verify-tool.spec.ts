import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createGeneratePatentFigureTool } from '../src/tool/generate-patent-figure.ts'
import { createVerifyPatentFigureTool } from '../src/tool/verify-patent-figure.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const signal = new AbortController().signal

/** 工具执行结果里的可见文本。 */
function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

/** 建一个只挂了本工具的运行时。 */
async function ctxWith(cwd: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.tools.register(createVerifyPatentFigureTool({ cwd }))
  return ctx
}

/** 一张最小 SVG。 */
function svg(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg" width="120mm" height="40mm" viewBox="0 0 120 40">
  <g fill="none" stroke="#000000" stroke-width="0.35">
${body}
  </g>
</svg>`
}

describe('verify_patent_figure', () => {
  it('量测值随文本返回：画布、文字数、线宽与取向分布', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-verify-'))
    const ctx = await ctxWith(dir)
    try {
      writeFileSync(join(dir, 'fig1.svg'), svg([
        '<polygon points="10,10 50,10 50,30 10,30" stroke-width="0.5"/>',
        '<line x1="4" y1="20" x2="12" y2="20" stroke-width="0.25"/>',
        '<text x="60" y="20" font-size="3.5" text-anchor="middle" fill="#000000" stroke="none">1</text>',
      ].join('\n')))
      const result = await executeToolFixture(ctx, { signal, callId: ToolCallId('vf1'), name: 'verify_patent_figure', arguments: { svg_path: 'fig1.svg' } })
      expect(result.isError).toBe(false)
      const body = text(result)
      expect(body).toContain('附图渲染复核：fig1.svg')
      expect(body).toContain('绝对路径：')
      expect(body).toContain('画布 120×40 毫米')
      expect(body).toContain('文字元素 1 个')
      expect(body).toContain('0.25mm×1')
      expect(body).toContain('0.5mm×1')
      expect(body).toContain('未发现问题')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('文字被线条贯穿时在 findings 里报出，并给出量测口径', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-verify-'))
    const ctx = await ctxWith(dir)
    try {
      writeFileSync(join(dir, 'fig1.svg'), svg([
        '<polygon points="10,10 50,10 50,30 10,30" stroke-width="0.5"/>',
        '<line x1="30" y1="20" x2="80" y2="10" stroke-width="0.25"/>',
        '<text x="80" y="11.2" font-size="3.5" text-anchor="middle" fill="#000000" stroke="none">3</text>',
      ].join('\n')))
      const result = await executeToolFixture(ctx, { signal, callId: ToolCallId('vf2'), name: 'verify_patent_figure', arguments: { svg_path: 'fig1.svg' } })
      expect(result.isError).toBe(false)
      const value = result as { value: { findings: { check: string; message: string }[] } }
      expect(value.value.findings.map(finding => finding.check)).toEqual(['text-crossed-by-line'])
      expect(text(result)).toContain('[text-crossed-by-line]')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('delivery_review=true 时加查横向、框线与图面词语', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-verify-'))
    const ctx = await ctxWith(dir)
    try {
      writeFileSync(join(dir, 'fig1.svg'), svg([
        '<rect x="1" y="1" width="118" height="38" fill="none" stroke="#000"/>',
        '<text x="60" y="20" font-size="3.5" text-anchor="middle" fill="#000000" stroke="none">controller</text>',
      ].join('\n')))
      const result = await executeToolFixture(ctx, { signal, callId: ToolCallId('vf-delivery'), name: 'verify_patent_figure', arguments: { svg_path: 'fig1.svg', delivery_review: true } })
      expect(result.isError).toBe(false)
      const value = result as { value: { findings: { check: string }[] } }
      expect(value.value.findings.map(finding => finding.check)).toEqual(
        expect.arrayContaining(['figure-orientation', 'figure-frame', 'figure-wording']),
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('文件缺失报 file_not_found，不安全 SVG 报 invalid_tool_input', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-verify-'))
    const ctx = await ctxWith(dir)
    try {
      const missing = await executeToolFixture(ctx, { signal, callId: ToolCallId('vf3'), name: 'verify_patent_figure', arguments: { svg_path: 'nope.svg' } })
      expect(missing.isError).toBe(true)
      expect(text(missing)).toContain('SVG 文件不存在：nope.svg')

      // 目录当路径：读得出「存在」但读不出文本，报 invalid_tool_input 而不是 file_not_found。
      mkdirSync(join(dir, 'adir'))
      const asDirectory = await executeToolFixture(ctx, { signal, callId: ToolCallId('vf3b'), name: 'verify_patent_figure', arguments: { svg_path: 'adir' } })
      expect(asDirectory.isError).toBe(true)
      expect(text(asDirectory)).toContain('SVG 文件不可读：adir')

      writeFileSync(join(dir, 'unsafe.svg'), '<!ENTITY x "y"><svg></svg>')
      const unsafe = await executeToolFixture(ctx, { signal, callId: ToolCallId('vf4'), name: 'verify_patent_figure', arguments: { svg_path: 'unsafe.svg' } })
      expect(unsafe.isError).toBe(true)
      expect(text(unsafe)).toContain('SVG 复核被拒')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('verify_patent_figure 量测缺省', () => {
  it('未注入 cwd 时以 process.cwd 为基准解析绝对路径', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-verify-'))
    try {
      const file = join(dir, 'abs.svg')
      writeFileSync(file, svg('<text x="10" y="10" font-size="3.5" text-anchor="middle" fill="#000000" stroke="none">1</text>'))
      const ctx = new Context()
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      ctx.tools.register(createVerifyPatentFigureTool())
      const result = await executeToolFixture(ctx, { signal, callId: ToolCallId('vf-abs'), name: 'verify_patent_figure', arguments: { svg_path: file } })
      expect(result.isError).toBe(false)
      expect(text(result)).toContain('文字元素 1 个')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('画布尺寸缺失与无量测图元时给出缺省文本', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-verify-'))
    const ctx = await ctxWith(dir)
    try {
      writeFileSync(join(dir, 'bare.svg'), '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>')
      const result = await executeToolFixture(ctx, { signal, callId: ToolCallId('vf5'), name: 'verify_patent_figure', arguments: { svg_path: 'bare.svg' } })
      expect(result.isError).toBe(false)
      const value = result as { value: { widthMm?: number; strokeWidthMm: unknown[]; orientationDeg: unknown[] } }
      expect(value.value.widthMm).toBeUndefined()
      expect(value.value.strokeWidthMm).toEqual([])
      expect(value.value.orientationDeg).toEqual([])
      const body = text(result)
      expect(body).toContain('根元素未声明画布尺寸')
      expect(body).toContain('线宽分布：无')
      expect(body).toContain('线段取向（按线段数）：无')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('generate_patent_figure → verify_patent_figure 联合复核', () => {
  it('工具生成的剖视图通过独立复核：无缺陷（两个模块各自解析同一张图）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-verify-'))
    const outDir = join(dir, 'figs')
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.tools.register(createGeneratePatentFigureTool({
      render: () => Promise.resolve({ ok: false, code: 'render_failed', error: '矢量图型不应走 Graphviz 渲染' }),
      outputDir: outDir,
      cwd: dir,
    }))
    ctx.tools.register(createVerifyPatentFigureTool({ cwd: dir }))
    try {
      const generated = await executeToolFixture(ctx, {
        signal,
        callId: ToolCallId('gv1'),
        name: 'generate_patent_figure',
        arguments: {
          figure_type: 'cross_section',
          sections: {
            parts: [
              // 零件名（数字）画在轮廓右上角之外；中心线沿中高向两侧外延，不穿过数字占位框。
              { label: '1', outline: [[0, 0], [60, 0], [60, 24], [0, 24]], hatch: { angle_deg: 45, spacing_mm: 3, direction: 'forward' } },
              { outline: [[60, 0], [72, 0], [72, 24], [60, 24]], hatch: 'none' },
            ],
            // 第二个零件的标号在零件上方、由竖直引线引出。
            labels: [{ text: '2', at: [84, 34], from: [72, 12] }],
            centerlines: [{ from: [-14, 12], to: [56, 12] }],
          },
        },
      })
      expect(generated.isError).toBe(false)
      const verified = await executeToolFixture(ctx, { signal, callId: ToolCallId('gv2'), name: 'verify_patent_figure', arguments: { svg_path: 'figs/fig1.svg' } })
      expect(verified.isError).toBe(false)
      const value = verified as { value: { findings: unknown[]; textCount: number } }
      expect(value.value.findings).toEqual([])
      expect(value.value.textCount).toBe(2)
      expect(text(verified)).toContain('未发现问题')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('verify_patent_figure 标号净距', () => {
  /** 字号 4 的「3」：占位框 x∈[78.8,81.2]、y∈[17,20.48]；`y` 处的横线距框上边界 `y`−17 毫米。 */
  const figure = (y: number): string => svg([
    `<line x1="70" y1="${y}" x2="90" y2="${y}" stroke-width="0.25"/>`,
    '<text x="80" y="20" font-size="4" text-anchor="middle" fill="#000000" stroke="none">3</text>',
  ].join('\n'))

  /** 复核给定 SVG 文本的 findings。 */
  async function verify(dir: string, body: string, args: Record<string, unknown>): Promise<{ check: string; message: string }[]> {
    writeFileSync(join(dir, 'fig1.svg'), body)
    const result = await ctxWith(dir).then(ctx => executeToolFixture(ctx, {
      signal, callId: ToolCallId('vc1'), name: 'verify_patent_figure', arguments: { svg_path: 'fig1.svg', ...args },
    }))
    expect(result.isError).toBe(false)
    return (result as { value: { findings: { check: string; message: string }[] } }).value.findings
  }

  it('缺省净距 1.5 毫米：贴线 1 毫米报出并给出量测距离', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-verify-'))
    try {
      const findings = await verify(dir, figure(16), {})
      expect(findings.map(finding => finding.check)).toEqual(['text-clearance'])
      expect(findings[0]?.message).toContain('仅 1 毫米')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('text_clearance_mm 可收紧与放宽：0.5 不报、3 报出 2 毫米外的线', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-verify-'))
    try {
      expect(await verify(dir, figure(16), { text_clearance_mm: 0.5 })).toEqual([])
      const widened = await verify(dir, figure(15), { text_clearance_mm: 3 })
      expect(widened.map(finding => finding.check)).toEqual(['text-clearance'])
      expect(widened[0]?.message).toContain('不足 3 毫米净距')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('text_clearance_mm: 0 关闭该判据，其他判据不受影响', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-verify-'))
    try {
      expect(await verify(dir, figure(16), { text_clearance_mm: 0 })).toEqual([])
      const pierced = await verify(dir, svg([
        '<line x1="80" y1="10" x2="80" y2="30" stroke-width="0.25"/>',
        '<text x="80" y="20" font-size="4" text-anchor="middle" fill="#000000" stroke="none">3</text>',
      ].join('\n')), { text_clearance_mm: 0 })
      expect(pierced.map(finding => finding.check)).toEqual(['text-crossed-by-line'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('负净距被拒，并指明参数名', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-verify-'))
    const ctx = await ctxWith(dir)
    try {
      writeFileSync(join(dir, 'fig1.svg'), figure(16))
      const result = await executeToolFixture(ctx, {
        signal, callId: ToolCallId('vc2'), name: 'verify_patent_figure', arguments: { svg_path: 'fig1.svg', text_clearance_mm: -1 },
      })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('text_clearance_mm 必须是非负数')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('工具自己画的剖视图用同一缺省净距复核：不报', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-verify-'))
    const outDir = join(dir, 'figs')
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.tools.register(createGeneratePatentFigureTool({
      render: () => Promise.resolve({ ok: false, code: 'render_failed', error: '矢量图型不应走 Graphviz 渲染' }),
      outputDir: outDir,
      cwd: dir,
    }))
    ctx.tools.register(createVerifyPatentFigureTool({ cwd: dir }))
    try {
      const generated = await executeToolFixture(ctx, {
        signal,
        callId: ToolCallId('vc3'),
        name: 'generate_patent_figure',
        arguments: {
          figure_type: 'cross_section',
          sections: {
            parts: [{ outline: [[0, 0], [40, 0], [40, 20], [0, 20]], hatch: { angle_deg: 45, spacing_mm: 3 } }],
            labels: [{ text: '1', at: [52, 10], from: [40, 10] }],
          },
        },
      })
      expect(generated.isError).toBe(false)
      const verified = await executeToolFixture(ctx, { signal, callId: ToolCallId('vc4'), name: 'verify_patent_figure', arguments: { svg_path: 'figs/fig1.svg' } })
      const body = text(verified)
      expect(body).toContain('未发现问题')
      // 引线（data-dsh-role="leader"）止于数字外框：若把它算作图元，这里必报净距。
      expect(body).not.toContain('text-clearance')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('verify_patent_figure 图内层级 ↔ 权项', () => {
  const FIGURE = svg([
    '<rect x="10" y="10" width="30" height="12" stroke-width="0.5"/>',
    '<rect x="44" y="14" width="8" height="4" stroke-width="0.5"/>',
  ].join('\n'))

  it('同时给出 hierarchy 与 claims 时核对其一致性', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-verify-'))
    try {
      writeFileSync(join(dir, 'fig1.svg'), FIGURE)
      const result = await ctxWith(dir).then(ctx => executeToolFixture(ctx, {
        signal,
        callId: ToolCallId('vh1'),
        name: 'verify_patent_figure',
        arguments: {
          svg_path: 'fig1.svg',
          hierarchy: [{ parent: '3', child: '31' }, { parent: '3', child: '311' }],
          claims: '所述恒电位控制单元31的输入端311，其特征在于……',
        },
      }))
      expect(result.isError).toBe(false)
      const findings = (result as { value: { findings: { check: string; message: string }[] } }).value.findings
      expect(findings.map(finding => finding.check)).toEqual(['figure-hierarchy'])
      expect(findings[0]?.message).toContain('把 311 画在 3 之下')
      expect(text(result)).toContain('[figure-hierarchy]')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('只给 hierarchy 或只给 claims 时不判层级（无从核对）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-verify-'))
    try {
      writeFileSync(join(dir, 'fig1.svg'), FIGURE)
      const ctx = await ctxWith(dir)
      const onlyHierarchy = await executeToolFixture(ctx, {
        signal,
        callId: ToolCallId('vh2'),
        name: 'verify_patent_figure',
        arguments: { svg_path: 'fig1.svg', hierarchy: [{ parent: '3', child: '311' }] },
      })
      expect(onlyHierarchy.isError).toBe(false)
      expect((onlyHierarchy as { value: { findings: unknown[] } }).value.findings).toEqual([])
      const onlyClaims = await executeToolFixture(ctx, {
        signal,
        callId: ToolCallId('vh3'),
        name: 'verify_patent_figure',
        arguments: { svg_path: 'fig1.svg', claims: '所述恒电位控制单元31的输入端311，其特征在于……' },
      })
      expect(onlyClaims.isError).toBe(false)
      expect((onlyClaims as { value: { findings: unknown[] } }).value.findings).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('verify_patent_figure 字高下限', () => {
  const SMALL = svg([
    '<rect x="10" y="10" width="30" height="12" stroke-width="0.5"/>',
    '<text x="25" y="20" font-size="2" text-anchor="middle" fill="#000000" stroke="none">3</text>',
  ].join('\n'))

  it('min_font_mm 给出时低于下限的文字报出，量测值随结果返回', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-verify-'))
    try {
      writeFileSync(join(dir, 'fig1.svg'), SMALL)
      const result = await ctxWith(dir).then(ctx => executeToolFixture(ctx, {
        signal, callId: ToolCallId('vf-min'), name: 'verify_patent_figure', arguments: { svg_path: 'fig1.svg', min_font_mm: 3 },
      }))
      expect(result.isError).toBe(false)
      const value = result as { value: { minFontMm: number; findings: { check: string }[] } }
      expect(value.value.minFontMm).toBeGreaterThan(1)
      expect(value.value.findings.map(finding => finding.check)).toEqual(['font-below-minimum'])
      expect(text(result)).toContain('最小字高')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('部署内控下限（deps.minFontMm）在模型未传参时生效，模型传参覆盖它', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-verify-'))
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.tools.register(createVerifyPatentFigureTool({ cwd: dir, minFontMm: 3 }))
    try {
      writeFileSync(join(dir, 'fig1.svg'), SMALL)
      const byDefault = await executeToolFixture(ctx, { signal, callId: ToolCallId('vf-dflt'), name: 'verify_patent_figure', arguments: { svg_path: 'fig1.svg' } })
      expect((byDefault as { value: { findings: { check: string }[] } }).value.findings.map(finding => finding.check)).toEqual(['font-below-minimum'])
      const overridden = await executeToolFixture(ctx, { signal, callId: ToolCallId('vf-over'), name: 'verify_patent_figure', arguments: { svg_path: 'fig1.svg', min_font_mm: 1 } })
      expect((overridden as { value: { findings: unknown[] } }).value.findings).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('min_font_mm 非正数被拒，并指明参数名', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-verify-'))
    const ctx = await ctxWith(dir)
    try {
      writeFileSync(join(dir, 'fig1.svg'), SMALL)
      const result = await executeToolFixture(ctx, { signal, callId: ToolCallId('vf-bad'), name: 'verify_patent_figure', arguments: { svg_path: 'fig1.svg', min_font_mm: 0 } })
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('min_font_mm 必须是正数')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
