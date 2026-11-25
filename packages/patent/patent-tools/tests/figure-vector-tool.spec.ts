import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createGeneratePatentFigureTool } from '../src/tool/generate-patent-figure.ts'
import type { GeneratePatentFigureIndexEntry } from '../src/tool/figure-input.ts'
import type { SectionSourcePorts } from '../src/figure/section-source.ts'
import type { SectionHatchSpec } from '../src/figure/freecad-renderer.ts'
import { readSectionGeometry, type SectionGeometry } from '../src/figure/freecad-section-geometry.ts'
import type { GraphvizRenderOutcome, GraphvizRenderSpec } from '../src/figure/graphviz-renderer.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const signal = new AbortController().signal

async function ctxWith(...tools: ToolDefinition[]): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  for (const t of tools) ctx.tools.register(t)
  return ctx
}

function execute(ctx: Context, name: string, args: unknown, label: string) {
  return executeToolFixture(ctx, { signal, callId: ToolCallId(label), name, arguments: args })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
}

/** 记录 DOT 的渲染器替身；矢量图型不得调用它。 */
function trackingRenderer(): { render: (spec: GraphvizRenderSpec) => Promise<GraphvizRenderOutcome>; calls: GraphvizRenderSpec[] } {
  const calls: GraphvizRenderSpec[] = []
  return {
    calls,
    render: (spec) => {
      calls.push(spec)
      return Promise.resolve({ ok: false, code: 'render_failed', error: '矢量图型不应走 Graphviz 渲染' })
    },
  }
}

const circuit = {
  components: [
    { id: 'v1', kind: 'voltage_source', label: '电源', col: 0, row: 0 },
    { id: 'r1', kind: 'resistor', label: '电阻', col: 1, row: 0 },
    { id: 'l1', kind: 'lamp', label: '灯泡', col: 2, row: 0 },
  ],
  connections: [
    { from: 'v1', to: 'r1' },
    { from: 'r1', to: 'l1' },
  ],
}

describe('generate_patent_figure：状态图（DOT 图型）', () => {
  it('初始伪状态不分配标号，终态为双圆，转移条件写在箭头上', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-state-'))
    const outDir = join(dir, 'figs')
    const tracker = trackingRenderer()
    const tool = createGeneratePatentFigureTool({
      render: async (spec) => {
        // 状态图走 DOT：渲染器写回空 SVG 即可。
        tracker.calls.push(spec)
        const out = join(spec.outputDir, `${spec.filename}.${spec.format}`)
        const outcome: GraphvizRenderOutcome = { ok: true, path: out }
        return outcome
      },
      outputDir: outDir,
      cwd: dir,
    })
    const ctx = await ctxWith(tool)
    try {
      const result = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'state_diagram',
        states: [
          { id: 'init', label: '', kind: 'initial' },
          { id: 'idle', label: '待机' },
          { id: 'run', label: '运行' },
          { id: 'done', label: '结束', kind: 'final' },
        ],
        transitions: [
          { from: 'init', to: 'idle' },
          { from: 'idle', to: 'run', label: '启动' },
          { from: 'run', to: 'done', label: '完成' },
        ],
      }, 'st1')
      expect(result.isError).toBe(false)
      const dot = tracker.calls[0]?.dot ?? ''
      expect(dot).toContain('"init" [label="", shape=circle, style=filled, fillcolor=black')
      expect(dot).toContain('"idle" [label="100. 待机", shape=box, style=rounded];')
      expect(dot).toContain('"run" [label="102. 运行", shape=box, style=rounded];')
      expect(dot).toContain('"done" [label="104. 结束", shape=doublecircle];')
      expect(dot).toContain('"idle" -> "run" [label="启动"];')
      const value = result as { value: { components: { name: string }[]; figureType: string; figureDescription: string } }
      expect(value.value.figureType).toBe('state_diagram')
      expect(value.value.components.map(c => c.name)).toEqual(['待机', '运行', '结束'])
      expect(value.value.figureDescription).toContain('状态图')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('状态为空或转移端点不存在时报 invalid_tool_input', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-state-'))
    const tracker = trackingRenderer()
    const tool = createGeneratePatentFigureTool({ render: tracker.render, outputDir: join(dir, 'figs'), cwd: dir })
    const ctx = await ctxWith(tool)
    try {
      const empty = await execute(ctx, 'generate_patent_figure', { figure_type: 'state_diagram' }, 'st2')
      expect(empty.isError).toBe(true)
      expect(text(empty)).toContain('state_diagram 需要 states')
      const dangling = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'state_diagram',
        states: [{ id: 'a', label: '甲' }],
        transitions: [{ from: 'a', to: 'b' }],
      }, 'st3')
      expect(dangling.isError).toBe(true)
      expect(text(dangling)).toContain('转移目标状态不存在')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('generate_patent_figure：矢量图型（直接绘制 SVG）', () => {
  it('电路图：不经 Graphviz，直接落 SVG 文件，T 形结点画实心点', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-vec-'))
    const outDir = join(dir, 'figs')
    const tracker = trackingRenderer()
    const tool = createGeneratePatentFigureTool({ render: tracker.render, outputDir: outDir, cwd: dir })
    const ctx = await ctxWith(tool)
    try {
      const result = await execute(ctx, 'generate_patent_figure', { figure_type: 'circuit', circuit }, 'v1')
      expect(result.isError).toBe(false)
      expect(tracker.calls).toHaveLength(0)
      const svg = readFileSync(join(outDir, 'fig1.svg'), 'utf8')
      expect(svg).toContain('width="')
      expect(svg).toContain('mm" height="')
      expect(svg).toContain('<title>电路图</title>')
      const value = result as { value: { figureType: string; warnings: string[] } }
      expect(value.value.figureType).toBe('circuit')
      // 元件名按 LABEL_GAP_MM 落在符号与走线旁（符号外框距文字外框 0.84 毫米），这是电路图
      // 的画法；「标号净距」判据只对机械剖视图开启，故这里不报贴线。
      expect(value.value.warnings).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('剖视图：break_lines 落成细实线折线，非法参数报 invalid_tool_input', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-vec-'))
    const outDir = join(dir, 'figs')
    const tracker = trackingRenderer()
    const tool = createGeneratePatentFigureTool({ render: tracker.render, outputDir: outDir, cwd: dir })
    const ctx = await ctxWith(tool)
    try {
      const parts = [{ outline: [[0, 0], [40, 0], [40, 20], [0, 20]], hatch: { angle_deg: 45, spacing_mm: 3 } }]
      const ok = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'cross_section',
        sections: {
          parts,
          break_lines: [
            { from: [0, -4], to: [40, -4] },
            { from: [0, 24], to: [40, 24], style: 'wavy', teeth: 3 },
          ],
        },
      }, 'br1')
      expect(ok.isError).toBe(false)
      const svg = readFileSync(join(outDir, 'fig1.svg'), 'utf8')
      // 剖面线与中心线是 <line>，只有断裂线是 0.25 毫米折线。
      expect(svg.match(/<polyline points="[^"]+" stroke-width="0.25"\/>/g) ?? []).toHaveLength(2)

      const bad = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'cross_section',
        sections: { parts, break_lines: [{ from: [0, -4], to: [40, -4], amplitude_mm: -1 }] },
      }, 'br2')
      expect(bad.isError).toBe(true)
      expect(text(bad)).toContain('断裂线 #1 齿高必须为正数')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('曲线图带实用新型「不得仅有性能图」提示；剖视图含剖面线', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-vec-'))
    const outDir = join(dir, 'figs')
    const tracker = trackingRenderer()
    const tool = createGeneratePatentFigureTool({ render: tracker.render, outputDir: outDir, cwd: dir })
    const ctx = await ctxWith(tool)
    try {
      const plot = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'plot',
        plot: { series: [{ name: '升温曲线', points: [[0, 20], [10, 60], [20, 95]] }], x_label: '时间', y_label: '温度', x_unit: 's', y_unit: '℃' },
      }, 'v2')
      expect(plot.isError).toBe(false)
      expect(text(plot)).toContain('7.3(10)')
      const section = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'cross_section',
        sections: { parts: [{ label: '底板', outline: [[0, 0], [40, 0], [40, 20], [0, 20]] }] },
      }, 'v3')
      expect(section.isError).toBe(false)
      const svg = readFileSync(join(outDir, 'fig1.svg'), 'utf8')
      expect(svg).toContain('#000000')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('时序图与外观设计排布：写出文件并透传图型提示', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-vec-'))
    const outDir = join(dir, 'figs')
    const tracker = trackingRenderer()
    const tool = createGeneratePatentFigureTool({ render: tracker.render, outputDir: outDir, cwd: dir })
    const ctx = await ctxWith(tool)
    try {
      const sequence = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'sequence_diagram',
        sequence: {
          participants: [{ id: 'u', label: '用户' }, { id: 's', label: '服务端' }],
          messages: [{ from: 'u', to: 's', label: '请求', activate: true }, { from: 's', to: 'u', label: '响应', kind: 'return' }],
        },
      }, 'v4')
      expect(sequence.isError).toBe(false)
      const appearance = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'appearance_view',
        appearance_views: {
          views: [
            { name: '主视图', body: '<rect x="0" y="0" width="10" height="10"/>', width_mm: 10, height_mm: 10, note: '省略仰视图：产品底面不常见' },
          ],
        },
      }, 'v5')
      expect(appearance.isError).toBe(false)
      const value = appearance as { value: { figureType: string; warnings: string[] } }
      expect(value.value.figureType).toBe('appearance_view')
      expect(value.value.warnings.join('\n')).toContain('省略仰视图：产品底面不常见')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('外观视图片段带可执行结构时拒绝落盘', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-vec-'))
    const outDir = join(dir, 'figs')
    const tracker = trackingRenderer()
    const tool = createGeneratePatentFigureTool({ render: tracker.render, outputDir: outDir, cwd: dir })
    const ctx = await ctxWith(tool)
    try {
      const result = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'appearance_view',
        appearance_views: {
          views: [{
            name: '主视图',
            body: '<!ENTITY x "y"><rect x="0" y="0" width="10" height="10"/>',
            width_mm: 10,
            height_mm: 10,
          }],
        },
      }, 'v11')
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('不安全结构')
      expect(existsSync(join(outDir, 'fig1.svg'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('矢量图型支持落版（图号入图）与非法输入/格式的错误映射', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-vec-'))
    const outDir = join(dir, 'figs')
    const tracker = trackingRenderer()
    const tool = createGeneratePatentFigureTool({ render: tracker.render, outputDir: outDir, cwd: dir })
    const ctx = await ctxWith(tool)
    try {
      const laid = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'circuit',
        circuit,
        target_office: 'cnipa',
        figure_count: 2,
      }, 'v6')
      const laidValue = laid as { value: { layout: { caption?: string } } }
      expect(laidValue.value.layout.caption).toBe('图1')
      expect(readFileSync(join(outDir, 'fig1.svg'), 'utf8')).toContain('>图1</text>')
      const png = await execute(ctx, 'generate_patent_figure', { figure_type: 'circuit', circuit, format: 'png' }, 'v7')
      expect(png.isError).toBe(true)
      expect(text(png)).toContain('仅支持 format="svg"')
      const emptyCircuit = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'circuit',
        circuit: { components: [], connections: [] },
      }, 'v8')
      expect(emptyCircuit.isError).toBe(true)
      expect(text(emptyCircuit)).toContain('circuit 输入校验失败')
      const missingInput = await execute(ctx, 'generate_patent_figure', { figure_type: 'plot' }, 'v9')
      expect(missingInput.isError).toBe(true)
      expect(text(missingInput)).toContain('plot 需要 plot 输入')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('panels 模式的 schema 只接受 DOT 图型', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-vec-'))
    const tracker = trackingRenderer()
    const tool = createGeneratePatentFigureTool({ render: tracker.render, outputDir: join(dir, 'figs'), cwd: dir })
    const ctx = await ctxWith(tool)
    try {
      const result = await execute(ctx, 'generate_patent_figure', {
        panels: [{ suffix: 'A', figure_type: 'circuit', circuit }],
      }, 'v10')
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('panels[0].figure_type')
      expect(text(result)).toContain('must be one of')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('generate_patent_figure：剖视图的引线标号、中心线、字号与文件输入', () => {
  /** 工具执行结果（文本内容用于断言错误消息，value 用于断言结构化输出）。 */
  type RunResult = { isError: boolean; value?: Record<string, unknown>; content: { type: string; text?: string }[] }

  /** 建一个只写不渲的工具上下文；返回执行器与输出目录。 */
  async function setup(): Promise<{ dir: string; outDir: string; run: (args: unknown, label: string) => Promise<RunResult> }> {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sec-'))
    const outDir = join(dir, 'figs')
    const tracker = trackingRenderer()
    const tool = createGeneratePatentFigureTool({ render: tracker.render, outputDir: outDir, cwd: dir })
    const ctx = await ctxWith(tool)
    return {
      dir,
      outDir,
      run: async (args, label) => await execute(ctx, 'generate_patent_figure', args, label) as RunResult,
    }
  }

  it('引线标号与中心线写进 SVG，输入检查与渲染复核都不报问题', async () => {
    const { dir, outDir, run } = await setup()
    try {
      const result = await run({
        figure_type: 'cross_section',
        sections: {
          parts: [{ outline: [[0, 0], [40, 0], [40, 20], [0, 20]], hatch: { angle_deg: 45, spacing_mm: 3, direction: 'forward' } }],
          labels: [{ text: '1', at: [44, 10], from: [40, 10] }],
          centerlines: [{ from: [-4, 10], to: [40, 10] }],
          label_font_size_mm: 5,
        },
      }, 's1')
      expect(result.isError).toBe(false)
      const svg = readFileSync(join(outDir, 'fig1.svg'), 'utf8')
      expect(svg).toContain('font-size="5"')
      // 中心线：至少 3 个「点」（≤1 毫米）与 2 个长划，且带 0.25 线宽。
      const thin = [...svg.matchAll(/<line x1="(-?[\d.]+)" y1="(-?[\d.]+)" x2="(-?[\d.]+)" y2="(-?[\d.]+)" stroke-width="0\.25"\/>/g)]
      expect(thin.length).toBeGreaterThan(4)
      const payload = result.value as { warnings: string[]; absolutePath: string }
      // 引线标号已由输入给出，引用渲染复核通过：只有「未指定剖面线」类的输入提示都不该出现。
      expect(payload.warnings).toEqual([])
      expect(payload.absolutePath.startsWith('/')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('零件未指定剖面线时给出「已套用默认」提示', async () => {
    const { dir, run } = await setup()
    try {
      const result = await run({
        figure_type: 'cross_section',
        sections: { parts: [{ outline: [[0, 0], [40, 0], [40, 20], [0, 20]] }] },
      }, 's2')
      const payload = result.value as { warnings: string[] }
      expect(payload.warnings.join('\n')).toContain('未指定剖面线')
      expect(payload.warnings.join('\n')).toContain('hatch: "none"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('require_explicit_hatch 开启时未给 hatch 即报错，并把未给的轮廓序号列出来', async () => {
    const { dir, run } = await setup()
    try {
      const result = await run({
        figure_type: 'cross_section',
        require_explicit_hatch: true,
        sections: {
          parts: [
            { outline: [[0, 0], [40, 0], [40, 20], [0, 20]], hatch: 'none' },
            { outline: [[50, 0], [90, 0], [90, 20], [50, 20]] },
          ],
        },
      }, 's2-strict')
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('require_explicit_hatch')
      expect(text(result)).toContain('零件 #2')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('require_explicit_hatch 下每个轮廓都给了 hatch（含 none）时正常出图', async () => {
    const { dir, run } = await setup()
    try {
      const result = await run({
        figure_type: 'cross_section',
        require_explicit_hatch: true,
        sections: {
          parts: [
            { outline: [[0, 0], [40, 0], [40, 20], [0, 20]], hatch: { angle_deg: 45, spacing_mm: 3 } },
            { outline: [[50, 0], [90, 0], [90, 20], [50, 20]], hatch: 'none' },
          ],
        },
      }, 's2-strict-ok')
      expect(result.isError).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('零件名画在轮廓右上角之外并带引线：压在剖面线与沿中线的中心线上都不报贯穿', async () => {
    const { dir, outDir, run } = await setup()
    try {
      const result = await run({
        figure_type: 'cross_section',
        sections: {
          parts: [{ label: '1', outline: [[0, 0], [40, 0], [40, 20], [0, 20]] }],
          centerlines: [{ from: [-6, 10], to: [46, 10] }],
        },
      }, 's11')
      expect(result.isError).toBe(false)
      const payload = result.value as { warnings: string[] }
      // 数字在包围盒左上角之外，剖面线与中高处的中心线都不穿过数字：只有输入侧的
      // 「未指定剖面线」提示，没有渲染复核的贯穿提示。
      expect(payload.warnings.join('\n')).not.toContain('渲染复核：标号')
      const svg = readFileSync(join(outDir, 'fig1.svg'), 'utf8')
      const text = /<text x="([\d.]+)"[^>]*>1<\/text>/.exec(svg)
      expect(text).not.toBeNull()
      expect(Number(text?.[1])).toBeGreaterThan(40)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('同名零件名落在多个轮廓上时提示改用 labels', async () => {
    const { dir, run } = await setup()
    try {
      const result = await run({
        figure_type: 'cross_section',
        sections: {
          parts: [
            { label: '插头柄', outline: [[0, 0], [10, 0], [10, 10], [0, 10]], hatch: 'none' },
            { label: '插头柄', outline: [[10, 0], [20, 0], [20, 10], [10, 10]], hatch: 'none' },
          ],
        },
      }, 's3')
      const payload = result.value as { warnings: string[] }
      expect(payload.warnings.join('\n')).toContain('零件名「插头柄」出现在 2 个轮廓上')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sections 文件解析抛出非 Error 时仍报 invalid_tool_input', async () => {
    const { dir, run } = await setup()
    writeFileSync(join(dir, 'fig5.json'), '{}')
    const spy = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw 'parse boom'
    })
    try {
      const result = await run({ figure_type: 'cross_section', sections: 'fig5.json' }, 's-json')
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('parse boom')
    } finally {
      spy.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leader_lines 对直绘图型给出「不生效」提示而不是静默忽略', async () => {
    const { dir, run } = await setup()
    try {
      const result = await run({
        figure_type: 'cross_section',
        leader_lines: true,
        sections: { parts: [{ outline: [[0, 0], [40, 0], [40, 20], [0, 20]], hatch: 'none' }] },
      }, 's4')
      const payload = result.value as { warnings: string[] }
      expect(payload.warnings.join('\n')).toContain('leader_lines')
      expect(payload.warnings.join('\n')).toContain('sections.labels')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('sections 传 JSON 文件路径：读入并渲染，缺文件与坏内容分别报错', async () => {
    const { dir, outDir, run } = await setup()
    try {
      writeFileSync(join(dir, 'fig4.json'), JSON.stringify({
        parts: [{ outline: [[0, 0], [30, 0], [30, 10], [0, 10]], hatch: 'none' }],
        labels: [{ text: '4', at: [34, 5], from: [30, 5] }],
      }))
      const fromFile = await run({ figure_type: 'cross_section', sections: 'fig4.json' }, 's5')
      expect(fromFile.isError).toBe(false)
      const svg = readFileSync(join(outDir, 'fig1.svg'), 'utf8')
      expect(svg).toContain('>4</text>')

      const missing = await run({ figure_type: 'cross_section', sections: 'nope.json' }, 's6')
      expect(missing.isError).toBe(true)
      expect(text(missing)).toContain('sections 文件不存在或不可读')

      writeFileSync(join(dir, 'bad.json'), '{ not json')
      const broken = await run({ figure_type: 'cross_section', sections: 'bad.json' }, 's7')
      expect(broken.isError).toBe(true)
      expect(text(broken)).toContain('不是合法 JSON')

      // 缺 required 字段：文件内容按同一套参数 schema 被拒。
      writeFileSync(join(dir, 'shape.json'), JSON.stringify({ outline: [] }))
      const wrong = await run({ figure_type: 'cross_section', sections: 'shape.json' }, 's8')
      expect(wrong.isError).toBe(true)
      expect(text(wrong)).toContain('sections 文件内容不符合剖视图输入')

      // schema 通过但语义不足：由构建层按内联输入同样的错误报出。
      writeFileSync(join(dir, 'empty.json'), JSON.stringify({ parts: [] }))
      const emptyParts = await run({ figure_type: 'cross_section', sections: 'empty.json' }, 's8b')
      expect(emptyParts.isError).toBe(true)
      expect(text(emptyParts)).toContain('剖视图至少需要一个被剖切零件')

      writeFileSync(join(dir, 'notobject.json'), JSON.stringify([1, 2]))
      const array = await run({ figure_type: 'cross_section', sections: 'notobject.json' }, 's9')
      expect(array.isError).toBe(true)
      expect(text(array)).toContain('不是 JSON 对象')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('给定 target_office 时复核量测的是落版后的附图页：页面级检查不误报', async () => {
    const { dir, outDir, run } = await setup()
    try {
      const result = await run({
        figure_type: 'cross_section',
        target_office: 'cnipa',
        sections: {
          parts: [{ outline: [[0, 0], [60, 0], [60, 24], [0, 24]], label: '1', hatch: { angle_deg: 45, spacing_mm: 3, direction: 'forward' } }],
          labels: [{ text: '2', at: [72, 32], from: [60, 12] }],
          centerlines: [{ from: [-6, 12], to: [66, 12] }],
        },
      }, 's12')
      const payload = result.value as { warnings: string[] }
      // 图形与图号都落在 210×297 页内：复核（在落版之后量测交付文件）不得报出越界或贯穿。
      expect(payload.warnings.filter(warning => warning.startsWith('渲染复核：'))).toEqual([])
      expect(readFileSync(join(outDir, 'fig1.svg'), 'utf8')).toContain('width="210mm"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('复核在文字转路径之前量测：转路径后仍保留贯穿提示', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-sec-'))
    const outDir = join(dir, 'figs')
    const tracker = trackingRenderer()
    // 模拟 Config.figureTextToPath 的产物：图面已无 <text>（等价于文字转成了轮廓）。
    const tool = createGeneratePatentFigureTool({
      render: tracker.render,
      outputDir: outDir,
      cwd: dir,
      outlineText: (spec) => {
        writeFileSync(spec.path, readFileSync(spec.path, 'utf8').replace(/<text[^>]*>[^<]*<\/text>/g, ''), 'utf8')
        return Promise.resolve({ ok: true })
      },
    })
    const ctx = await ctxWith(tool)
    try {
      const result = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'cross_section',
        sections: {
          parts: [{ outline: [[0, 0], [40, 0], [40, 20], [0, 20]], hatch: { angle_deg: 45, spacing_mm: 4, direction: 'forward' } }],
          labels: [{ text: '1', at: [20, 10], from: [20, 10] }],
        },
      }, 's11') as RunResult
      const payload = result.value as { warnings: string[] }
      expect(payload.warnings.join('\n')).toContain('渲染复核：图面文字「1」被线条贯穿')
      expect(readFileSync(join(outDir, 'fig1.svg'), 'utf8')).not.toContain('<text')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('渲染复核的发现随警告返回：文字被线条贯穿时给出提示', async () => {
    const { dir, run } = await setup()
    try {
      const result = await run({
        figure_type: 'cross_section',
        sections: {
          parts: [{ outline: [[0, 0], [40, 0], [40, 20], [0, 20]], hatch: { angle_deg: 45, spacing_mm: 4, direction: 'forward' } }],
          // 引线起点就是数字落点：复核会看到线条穿过数字占位框。
          labels: [{ text: '1', at: [20, 10], from: [20, 10] }],
        },
      }, 's10')
      const payload = result.value as { warnings: string[] }
      expect(payload.warnings.join('\n')).toContain('渲染复核：图面文字「1」被线条贯穿')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('generate_patent_figure：从 CAD 模型切出剖视图（sections.source）', () => {
  /** 工具执行结果（文本内容用于断言错误消息，value 用于断言结构化输出）。 */
  type RunResult = { isError: boolean; value?: Record<string, unknown>; content: { type: string; text?: string }[] }

  /** 切出的材料区域：60×30 底板 + 两个 r5 通孔（x = ±15），与真机 fixture 同形。 */
  function plateGeometry(): SectionGeometry {
    const circle = (centerX: number): number[][] => Array.from({ length: 240 }, (_, index) => {
      const angle = (2 * Math.PI * index) / 240
      return [centerX + 5 * Math.cos(angle), 5 * Math.sin(angle)]
    })
    return readSectionGeometry({
      model: { path: '/models/plate.step', solids: 1, bound_box_mm: { min: [-30, -15, 0], max: [30, 15, 8] } },
      plane: { origin: [0, 0, 4], normal: [0, 0, 1], right: [1, 0, 0], down: [0, 1, 0], distance: 4 },
      rings: [
        { points_mm: [[-30, -15], [30, -15], [30, 15], [-30, 15]], closed: true, area_mm2: 1800 },
        { points_mm: circle(-15), closed: true, area_mm2: Math.PI * 25 },
        { points_mm: circle(15), closed: true, area_mm2: Math.PI * 25 },
      ],
      slice_face_area_mm2: null,
    })
  }

  /** 假端口：切出底板，按请求的每个区域各给一条中央剖面线。 */
  function platePorts(overrides: Partial<SectionSourcePorts> = {}): { ports: SectionSourcePorts; hatchSpecs: SectionHatchSpec[] } {
    const hatchSpecs: SectionHatchSpec[] = []
    return {
      hatchSpecs,
      ports: {
        sectionGeometry: async () => ({ ok: true, geometry: plateGeometry() }),
        sectionHatch: async (spec) => {
          hatchSpecs.push(spec)
          const segments = spec.regions.map((region) => {
            const xs = region.outline.map(point => point[0])
            const center = (Math.min(...xs) + Math.max(...xs)) / 2
            return { from: [center - 1, 0] as const, to: [center + 1, 0] as const }
          })
          return {
            ok: true,
            geometry: { segments, regionCounts: spec.regions.map(() => 1), patAngleDeg: spec.angleDeg, patScale: spec.spacingMm },
          }
        },
        ...overrides,
      },
    }
  }

  /** 建一个写文件的工具上下文（模型占位文件只用于路径校验）。 */
  async function setup(
    model = true,
    ports?: SectionSourcePorts,
    index = false,
  ): Promise<{ dir: string; outDir: string; run: (args: unknown, label: string) => Promise<RunResult>; entries: unknown[] }> {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-src-'))
    const outDir = join(dir, 'figs')
    if (model) writeFileSync(join(dir, 'plate.step'), 'ISO-10303-21;\n')
    const entries: unknown[] = []
    const tool = createGeneratePatentFigureTool({
      render: trackingRenderer().render,
      ...(ports === undefined ? {} : { sectionSource: ports }),
      ...(index ? { upsertIndex: async (entry: GeneratePatentFigureIndexEntry) => { entries.push(entry) } } : {}),
      outputDir: outDir,
      cwd: dir,
    })
    const ctx = await ctxWith(tool)
    return {
      dir,
      outDir,
      entries,
      run: async (args, label) => await execute(ctx, 'generate_patent_figure', args, label) as RunResult,
    }
  }

  /** source 模式的剖视图输入。 */
  function sourceArgs(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      figure_type: 'cross_section',
      sections: {
        source: { model_path: 'plate.step', plane: { origin: [0, 0, 4], normal: [0, 0, 1] } },
        parts: [{ anchor: [0, 0], hatch: { angle_deg: 45, spacing_mm: 3 }, label: '1' }],
        ...extra,
      },
    }
  }

  it('切出轮廓与孔、按区域裁好的剖面线落图，复核不报文字贯穿', async () => {
    const { dir, outDir, run } = await setup(true, platePorts().ports)
    try {
      const result = await run(sourceArgs(), 'src1')
      expect(result.isError).toBe(false)
      const svg = readFileSync(join(outDir, 'fig1.svg'), 'utf8')
      // 底板轮廓 + 两个孔环各一个 <polygon>；剖面线只有端口给的那一条。
      expect(svg.match(/<polygon /g) ?? []).toHaveLength(3)
      const payload = result.value as { warnings: string[] }
      // 提示里给出材料区域清单（模型据此放标号），且没有渲染复核的文字贯穿发现。
      expect(payload.warnings.join('\n')).toContain('切出 1 个材料区域')
      expect(payload.warnings.join('\n')).toContain('净面积 1642.9')
      expect(payload.warnings.join('\n')).not.toContain('被线条贯穿')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('几何失败、剖面线失败、模型缺失各按码报错', async () => {
    const geometryFailed = await setup(true, platePorts({ sectionGeometry: async () => ({ ok: false, code: 'geometry_failed', error: '剖切面未与模型相交' }) }).ports)
    try {
      const result = await geometryFailed.run(sourceArgs(), 'src2')
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('剖切面未与模型相交')
    } finally {
      rmSync(geometryFailed.dir, { recursive: true, force: true })
    }
    const hatchFailed = await setup(true, platePorts({ sectionHatch: async () => ({ ok: false, code: 'hatch_failed', error: '剖面线为 0 条' }) }).ports)
    try {
      const result = await hatchFailed.run(sourceArgs(), 'src3')
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('剖面线为 0 条')
    } finally {
      rmSync(hatchFailed.dir, { recursive: true, force: true })
    }
    const missing = await setup(false, platePorts().ports)
    try {
      const result = await missing.run(sourceArgs(), 'src4')
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('model_path 不存在或不可读')
    } finally {
      rmSync(missing.dir, { recursive: true, force: true })
    }
  })

  it('宿主未注入剖切端口时给 setup_required 而不是静默画成示意图', async () => {
    const { dir, outDir, run } = await setup(true, undefined)
    try {
      const result = await run(sourceArgs(), 'src5')
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('FreeCAD')
      expect(existsSync(join(outDir, 'fig1.svg'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('剖切端口抛出非 SectionSourceError 时原样上抛', async () => {
    const ports: SectionSourcePorts = {
      sectionGeometry: async () => {
        throw new Error('port exploded')
      },
      sectionHatch: async () => {
        throw new Error('hatch must not run')
      },
    }
    const { dir, run } = await setup(true, ports)
    try {
      const result = await run(sourceArgs(), 'src-port-error')
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('port exploded')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('区域数与 parts 数不等时把切出的区域列给模型', async () => {
    const { dir, run } = await setup(true, platePorts().ports)
    try {
      const result = await run(sourceArgs({ parts: [{ anchor: [0, 0] }, { anchor: [30, 0] }] }), 'src6')
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('切出 1 个材料区域')
      expect(text(result)).toContain('parts 有 2 个')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('anchor 落在孔里时按输入错误拒绝', async () => {
    const { dir, run } = await setup(true, platePorts().ports)
    try {
      const result = await run(sourceArgs({ parts: [{ anchor: [15, 0], hatch: { angle_deg: 45 } }] }), 'src7')
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('不在任何材料区域内')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('落版与索引照常：source 只是几何来源，全链不变', async () => {
    const { dir, run, entries } = await setup(true, platePorts().ports, true)
    try {
      const result = await run({ ...sourceArgs(), target_office: 'cnipa' }, 'src8')
      expect(result.isError).toBe(false)
      const payload = result.value as { indexed: boolean; layout?: { office: string } }
      expect(payload.indexed).toBe(true)
      expect(entries).toHaveLength(1)
      expect(payload.layout?.office).toBe('cnipa')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('generate_patent_figure：自动复核的标号净距按图型开启', () => {
  /** 工具执行结果（文本内容用于断言错误消息，value 用于断言结构化输出）。 */
  type RunResult = { isError: boolean; value?: Record<string, unknown> }

  /** 建一个只写不渲的工具上下文；返回执行器与输出目录。 */
  async function setup(): Promise<{ dir: string; run: (args: unknown, label: string) => Promise<RunResult> }> {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gap-'))
    const tracker = trackingRenderer()
    const tool = createGeneratePatentFigureTool({ render: tracker.render, outputDir: join(dir, 'figs'), cwd: dir })
    const ctx = await ctxWith(tool)
    return {
      dir,
      run: async (args, label) => await execute(ctx, 'generate_patent_figure', args, label) as RunResult,
    }
  }

  it('剖视图：标号贴住中心线时按 1.5 毫米净距报出，并给出量测距离', async () => {
    const { dir, run } = await setup()
    try {
      const result = await run({
        figure_type: 'cross_section',
        sections: {
          parts: [{ outline: [[0, 0], [40, 0], [40, 20], [0, 20]], hatch: 'none' }],
          labels: [{ text: '1', at: [44, 10], from: [40, 10] }],
          // 中心线在数字外框（下边界 y=11.62）外约 1 毫米处通过：贯穿判据不报，净距判据报。
          centerlines: [{ from: [-4, 12.6], to: [46, 12.6] }],
        },
      }, 's12')
      expect(result.isError).toBe(false)
      const payload = result.value as { warnings: string[] }
      const renderWarnings = payload.warnings.filter(warning => warning.startsWith('渲染复核：'))
      expect(renderWarnings).toHaveLength(1)
      expect(renderWarnings[0]).toContain('图面文字「1」距最近的图线仅 1 毫米，不足 1.5 毫米净距')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('电路图：同一个 1.5 毫米净距不套用，元件名贴着符号放不报', async () => {
    const { dir, run } = await setup()
    try {
      const result = await run({ figure_type: 'circuit', circuit }, 'c1')
      expect(result.isError).toBe(false)
      const payload = result.value as { warnings: string[] }
      // 三条元件名距各自符号外框 0.84–1.2 毫米：套用净距会把这些画对的图报成缺陷。
      expect(payload.warnings.filter(warning => warning.includes('净距'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('generate_patent_figure：剖切符号的强制开关', () => {
  /** 一个不含剖切符号的最小剖视图输入。 */
  const NO_MARKS = {
    figure_type: 'cross_section',
    sections: { parts: [{ outline: [[0, 0], [40, 0], [40, 20], [0, 20]], hatch: { angle_deg: 45, spacing_mm: 3 } }] },
  }
  const WITH_MARKS = {
    figure_type: 'cross_section',
    sections: {
      parts: [{ outline: [[0, 0], [40, 0], [40, 20], [0, 20]], hatch: { angle_deg: 45, spacing_mm: 3 } }],
      cutting_marks: [{ id: 'A', from: [10, 24], to: [10, 34], arrow: 'down' }],
    },
  }

  async function setup(deps: { requireCuttingMarks?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-cut-'))
    const outDir = join(dir, 'figs')
    const tool = createGeneratePatentFigureTool({
      render: trackingRenderer().render,
      outputDir: outDir,
      cwd: dir,
      ...deps,
    })
    const ctx = await ctxWith(tool)
    return { dir, run: async (args: unknown, label: string) => await execute(ctx, 'generate_patent_figure', args, label) }
  }

  it('参数开启时未给剖切符号即报错，给了则正常出图', async () => {
    const { dir, run } = await setup()
    try {
      const missing = await run({ ...NO_MARKS, require_cutting_marks: true }, 'cut-strict')
      expect(missing.isError).toBe(true)
      expect(text(missing)).toContain('require_cutting_marks')
      const ok = await run({ ...WITH_MARKS, require_cutting_marks: true }, 'cut-strict-ok')
      expect(ok.isError).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('部署级 requireCuttingMarks 在模型未传参时生效，模型传 false 可覆盖', async () => {
    const { dir, run } = await setup({ requireCuttingMarks: true })
    try {
      const byDefault = await run(NO_MARKS, 'cut-dflt')
      expect(byDefault.isError).toBe(true)
      expect(text(byDefault)).toContain('require_cutting_marks')
      const overridden = await run({ ...NO_MARKS, require_cutting_marks: false }, 'cut-over')
      expect(overridden.isError).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('未开启时不要求剖切符号：缺省只出图', async () => {
    const { dir, run } = await setup()
    try {
      const result = await run(NO_MARKS, 'cut-off')
      expect(result.isError).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('generate_patent_figure：view_name', () => {
  const section = {
    figure_type: 'cross_section' as const,
    invention_name: '汇聚箱',
    sections: { parts: [{ outline: [[0, 0], [40, 0], [40, 20], [0, 20]], hatch: { angle_deg: 45, spacing_mm: 3 } }] },
  }
  const dotSvg = [
    '<svg xmlns="http://www.w3.org/2000/svg">',
    '<g id="graph0" class="graph">',
    '<title>G</title>',
    '<g id="node1" class="node"><title>a</title><polygon points="0,0 10,0 10,10 0,10"/><text>甲</text></g>',
    '</g>',
    '</svg>',
    '',
  ].join('\n')

  function writingRenderer(body: string): { render: (spec: GraphvizRenderSpec) => Promise<GraphvizRenderOutcome> } {
    return {
      render: (spec) => {
        const out = join(spec.outputDir, `${spec.filename}.${spec.format}`)
        writeFileSync(out, body)
        return Promise.resolve({ ok: true, path: out })
      },
    }
  }

  function withoutTitle(svg: string): string {
    return svg.replace(/\n  <title>[\s\S]*?<\/title>/, '')
  }

  async function setup(render: (spec: GraphvizRenderSpec) => Promise<GraphvizRenderOutcome>) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-view-'))
    const outDir = join(dir, 'figs')
    const indexed: GeneratePatentFigureIndexEntry[] = []
    const tool = createGeneratePatentFigureTool({
      render,
      outputDir: outDir,
      cwd: dir,
      upsertIndex: async (entry) => { indexed.push(entry) },
    })
    const ctx = await ctxWith(tool)
    return {
      dir,
      outDir,
      indexed,
      run: async (args: unknown, label: string) => await execute(ctx, 'generate_patent_figure', args, label),
    }
  }

  it('省略或空白 view_name 时剖视标题仍以剖视图结尾', async () => {
    const { dir, outDir, run } = await setup(trackingRenderer().render)
    try {
      const omitted = await run({ ...section, filename: 'plain' }, 'vn-omit')
      expect(omitted.isError).toBe(false)
      const blank = await run({ ...section, filename: 'blank', view_name: '   ' }, 'vn-blank')
      expect(blank.isError).toBe(false)
      const plain = readFileSync(join(outDir, 'plain.svg'), 'utf8')
      const blankSvg = readFileSync(join(outDir, 'blank.svg'), 'utf8')
      expect(plain).toContain('<title>汇聚箱的剖视图</title>')
      expect(blankSvg).toBe(plain)
      const omittedValue = (omitted as { value: { figureDescription: string; figureType: string } }).value
      expect(omittedValue.figureType).toBe('cross_section')
      expect(omittedValue.figureDescription).toContain('汇聚箱的剖视图')
      expect(omittedValue.figureDescription).not.toContain('主视半剖视图')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('传入视图名时只替换标题和附图说明，其余 SVG 字节不变', async () => {
    const { dir, outDir, indexed, run } = await setup(trackingRenderer().render)
    try {
      const named = await run({ ...section, filename: 'named', view_name: '  主视半剖视图  ' }, 'vn-named')
      const plain = await run({ ...section, filename: 'plain', persist_index: false }, 'vn-plain')
      expect(named.isError).toBe(false)
      expect(plain.isError).toBe(false)
      const namedSvg = readFileSync(join(outDir, 'named.svg'), 'utf8')
      const plainSvg = readFileSync(join(outDir, 'plain.svg'), 'utf8')
      expect(namedSvg).toContain('<title>汇聚箱的主视半剖视图</title>')
      expect(namedSvg).not.toContain('<title>汇聚箱的剖视图</title>')
      expect(withoutTitle(namedSvg)).toBe(withoutTitle(plainSvg))
      const value = (named as { value: { figureDescription: string; figureType: string } }).value
      expect(value.figureType).toBe('cross_section')
      expect(value.figureDescription).toContain('图1是本发明实施例提供的汇聚箱的主视半剖视图')
      expect(value.figureDescription).not.toContain('汇聚箱的剖视图')
      expect(indexed[0]?.analysis.figureType).toBe('cross_section')
      expect(indexed[0]?.analysis.figureDescription).toContain('主视半剖视图')
      expect(indexed[0]?.analysis.overallDescription).not.toContain('主视半剖视图')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('拒绝换行和超过 200 个字符的视图名，并转义标题里的 XML', async () => {
    const { dir, outDir, run } = await setup(trackingRenderer().render)
    try {
      const newline = await run({ ...section, view_name: '主视\n半剖' }, 'vn-nl')
      expect(newline.isError).toBe(true)
      expect(text(newline)).toContain('view_name 不能包含换行')
      const tooLong = await run({ ...section, view_name: '视'.repeat(201) }, 'vn-long')
      expect(tooLong.isError).toBe(true)
      expect(text(tooLong)).toContain('view_name 去掉首尾空白后不能超过 200 个字符')
      const escaped = await run({ ...section, filename: 'esc', view_name: 'A&B<C"' }, 'vn-xml')
      expect(escaped.isError).toBe(false)
      const svg = readFileSync(join(outDir, 'esc.svg'), 'utf8')
      expect(svg).toContain('<title>汇聚箱的A&amp;B&lt;C&quot;</title>')
      const value = (escaped as { value: { figureDescription: string } }).value
      expect(value.figureDescription).toContain('A&B<C"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('raw_dot 只在传入 view_name 时插入文档标题，节点标题保持原字节', async () => {
    const { dir, outDir, run } = await setup(writingRenderer(dotSvg).render)
    try {
      const omitted = await run({ figure_type: 'raw_dot', dot: 'digraph G { a [label="甲"] }', filename: 'plain' }, 'vn-dot')
      expect(omitted.isError).toBe(false)
      expect(readFileSync(join(outDir, 'plain.svg'), 'utf8')).toBe(dotSvg)
      const named = await run({
        figure_type: 'raw_dot',
        dot: 'digraph G { a [label="甲"] }',
        filename: 'named',
        invention_name: '一种方法',
        view_name: '主视半剖视图',
      }, 'vn-dot-named')
      expect(named.isError).toBe(false)
      const svg = readFileSync(join(outDir, 'named.svg'), 'utf8')
      expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg">\n  <title>一种方法的主视半剖视图</title>\n')
      expect(svg).toContain('<title>G</title>')
      expect(svg).toContain('<g id="node1" class="node"><title>a</title>')
      expect((named as { value: { figureType: string; figureDescription: string } }).value.figureType).toBe('unknown')
      expect((named as { value: { figureDescription: string } }).value.figureDescription).toContain('一种方法的主视半剖视图')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('多面板共用一个视图名，后缀仍写在图号上', async () => {
    const { dir, outDir, run } = await setup(writingRenderer(dotSvg).render)
    try {
      const named = await run({
        invention_name: '汇聚箱',
        view_name: '主视半剖视图',
        leader_lines: false,
        panels: [
          { suffix: 'A', blocks: [{ id: 'a', label: '壳体' }] },
          { suffix: 'B', blocks: [{ id: 'b', label: '端盖' }] },
        ],
      }, 'vn-panels')
      expect(named.isError).toBe(false)
      const value = (named as { value: { figureDescription: string } }).value
      expect(value.figureDescription).toContain('图1A是本发明实施例提供的汇聚箱的主视半剖视图')
      expect(value.figureDescription).toContain('图1B是本发明实施例提供的汇聚箱的主视半剖视图')
      expect(value.figureDescription).not.toContain('方框图')
      for (const name of ['fig1A.svg', 'fig1B.svg']) {
        const svg = readFileSync(join(outDir, name), 'utf8')
        expect(svg).toContain('<title>汇聚箱的主视半剖视图</title>')
        expect(svg).toContain('<g id="node1" class="node"><title>a</title>')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
