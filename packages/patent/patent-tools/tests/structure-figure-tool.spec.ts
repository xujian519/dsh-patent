import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { StructureRenderOutcome, StructureRenderSpec } from '../src/figure/freecad-renderer.ts'
import { STRUCTURE_MANIFEST_FILENAME } from '../src/figure/freecad-structure-script.ts'
import { createGenerateStructureFigureTool, STRUCTURE_FIGURE_MODEL_USED } from '../src/tool/generate-structure-figure.ts'
import { structureAssembly } from '../src/tool/structure-render.ts'
import type { GenerateStructureFigureInput } from '../src/tool/generate-structure-figure.ts'
import type { FigureIndexEntry } from '../src/figure/index-store.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

/**
 * generate_structure_figure 工具规格：mock 渲染器（不依赖 FreeCAD），验证门禁、
 * 单模型/批量目录、件号 wording 告警、产物安全校验与索引持久化。
 */

const signal = new AbortController().signal
const exec = { signal } as never

async function ctxWith(...tools: ToolDefinition[]): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  for (const t of tools) ctx.tools.register(t)
  return ctx
}

function execute(ctx: Context, name: string, args: unknown, label: string) {
  return executeToolFixture(ctx, { signal, callId: ToolCallId(label), name, arguments: args })
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-structool-'))
}

/** 写一个占位模型文件（内容由 mock 渲染器忽略）。 */
function writeModel(dir: string, name: string): string {
  const path = join(dir, name)
  writeFileSync(path, 'ISO-10303-21;\nplaceholder\nEND-ISO-10303-21;')
  return path
}

type RenderOpts = {
  unsafe?: boolean
  emptyViews?: boolean
  svg?: string
  omitParts?: boolean
  /** 逐零件几何事实的覆盖值：喂出 manifest 读回的每条 fail-loud 分支。 */
  partsOverride?: unknown
  /** 视图级 warnings 的覆盖值：脚本的标号降级说明，或畸形类型。 */
  viewWarnings?: unknown
}

type MockRenderer = { render: (spec: StructureRenderSpec) => Promise<StructureRenderOutcome>; calls: StructureRenderSpec[] }

/** mock 渲染器：在 outputDir 写出各视图 SVG 与 manifest.json，返回 manifest 路径。 */
function okRenderer(opts: RenderOpts = {}): MockRenderer {
  const calls: StructureRenderSpec[] = []
  return {
    calls,
    render: (spec) => {
      calls.push(spec)
      mkdirSync(spec.outputDir, { recursive: true })
      const svg = opts.svg ?? (opts.unsafe
        ? '<!ENTITY x SYSTEM "file:///etc/passwd"><svg xmlns="http://www.w3.org/2000/svg"></svg>'
        : '<svg xmlns="http://www.w3.org/2000/svg"><g fill="none" stroke="#000000"><path d="M0 0 L10 10"/></g></svg>')
      // 脚本按模型列表逐零件量出投影占位；mock 与之一致（每个零件一个单位方框）。
      const parts = opts.omitParts === true
        ? undefined
        : opts.partsOverride === undefined
          ? spec.modelPaths.map((_, index) => ({
            index,
            bbox3d: [0, 0, 0, 10, 10, 10],
            volume: 1000,
            bounds: [0, 0, 10, 10],
          }))
          : opts.partsOverride
      const views = spec.views.map((name, order) => {
        const path = join(spec.outputDir, `fig${spec.figureNumber}_${name}.svg`)
        writeFileSync(path, svg)
        return {
          name,
          kind: 'view' as const,
          order,
          path,
          bbox: [0, 0, 10, 10],
          anchors: spec.callouts.map(c => ({
            numeral: c.numeral,
            label: c.label ?? '',
            model: c.model ?? null,
            modelPath: c.model === undefined ? null : (spec.modelPaths[c.model] ?? null),
            point3d: c.point3d === undefined ? [] : [...c.point3d],
            point2d: [0, 0],
          })),
          // undefined 在 JSON.stringify 时被丢弃，正好模拟没有该字段的旧版 manifest。
          parts,
          warnings: opts.viewWarnings,
        }
      })
      // 放大视图：脚本产出的一等视图条目（kind='detail' + 窗口元数据）。
      const details = (spec.details ?? []).map((detail, index) => {
        const name = `detail${index + 1}`
        const path = join(spec.outputDir, `fig${spec.figureNumber}_${name}.svg`)
        writeFileSync(path, svg)
        return {
          name,
          kind: 'detail' as const,
          order: views.length + index,
          path,
          bbox: [0, 0, 10, 10],
          anchors: [],
          parts: [],
          base: detail.base,
          center3d: [...detail.center],
          radiusMm: detail.radiusMm,
          scale: detail.scale,
          reference: detail.reference,
        }
      })
      const manifest = {
        figureNumber: spec.figureNumber,
        modelPaths: spec.modelPaths,
        scale: spec.scale,
        showHidden: spec.showHidden,
        generator: 'freecad-structure',
        views: opts.emptyViews ? [] : [...views, ...details],
      }
      const manifestPath = join(spec.outputDir, STRUCTURE_MANIFEST_FILENAME)
      writeFileSync(manifestPath, JSON.stringify(manifest))
      return Promise.resolve({ ok: true, manifestPath })
    },
  }
}

const twoCallouts = [
  { numeral: '100', point3d: [0, 0, 24] as [number, number, number], label: '立柱' },
  { numeral: '102', point3d: [20, -12, 8] as [number, number, number], label: '底板' },
]

describe('generate_structure_figure gate', () => {
  it('默认关闭时 fail-loud 为 setup_required（不静默降级）', async () => {
    const dir = tempDir()
    try {
      const { render } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, outputDir: dir, cwd: dir })
      await expect(tool.execute({ model_path: writeModel(dir, 'a.step') }, exec)).rejects.toMatchObject({ code: 'setup_required' })
      // enabled:false 同样门禁
      const off = createGenerateStructureFigureTool({ render, enabled: false, outputDir: dir, cwd: dir })
      await expect(off.execute({ model_path: join(dir, 'a.step') }, exec)).rejects.toMatchObject({ code: 'setup_required' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('generate_structure_figure 落版', () => {
  it('给定 target_office 时把每个视图 SVG 落版为 A4 附图页并返回尺寸', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    const model = writeModel(dir, 'bracket.step')
    // 带物理尺寸与 viewBox 的片段，供落版解析（相当于 freecad 脚本产出的视图 SVG）。
    const { render } = okRenderer({ svg: '<svg width="200pt" height="150pt" viewBox="0 0 200 150" xmlns="http://www.w3.org/2000/svg"><g fill="none" stroke="#000000"><path d="M0 0 L10 10"/></g></svg>' })
    try {
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: outDir, cwd: dir })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'generate_structure_figure', {
        model_path: model,
        views: ['iso'],
        figure_number: 3,
        target_office: 'cnipa',
        sheet_index: 1,
        sheet_total: 2,
      }, 's-layout') as { isError: boolean; value: { layout?: { office: string; sheetNumber: string; pageScale: number }; warnings: string[] } }
      expect(result.isError).toBe(false)
      expect(result.value.layout?.office).toBe('cnipa')
      expect(result.value.layout?.sheetNumber).toBe('第1页 共2页')
      expect(result.value.layout?.pageScale).toBeGreaterThan(0)
      const written = readFileSync(join(outDir, 'fig3', 'fig3_iso.svg'), 'utf8')
      expect(written).toContain('width="210mm" height="297mm"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('generate_structure_figure 文字转路径', () => {
  it('注入端口时逐视图转换：路径是视图文件的绝对路径，顺序与输出一致', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    const model = writeModel(dir, 'bracket.step')
    const outlined: string[] = []
    try {
      const tool = createGenerateStructureFigureTool({
        render: okRenderer().render,
        enabled: true,
        outputDir: outDir,
        cwd: dir,
        outlineText: (spec) => {
          outlined.push(spec.path)
          return Promise.resolve({ ok: true })
        },
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'generate_structure_figure', { model_path: model, views: ['iso', 'front'] }, 's-outline') as {
        isError: boolean
        value: { paths: string[] }
      }
      expect(result.isError).toBe(false)
      expect(outlined.every(path => isAbsolute(path))).toBe(true)
      expect(outlined.map(path => relative(dir, path))).toEqual(result.value.paths)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('转换失败按失败码映射：not_installed → setup_required，其余 → tool_execution_failed', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    const model = writeModel(dir, 'bracket.step')
    try {
      const missing = createGenerateStructureFigureTool({
        render: okRenderer().render,
        enabled: true,
        outputDir: outDir,
        cwd: dir,
        outlineText: () => Promise.resolve({ ok: false, code: 'not_installed', error: '未找到 Inkscape。' }),
      })
      await expect(missing.execute({ model_path: model, views: ['iso'] }, exec))
        .rejects.toMatchObject({ code: 'setup_required' })
      const failed = createGenerateStructureFigureTool({
        render: okRenderer().render,
        enabled: true,
        outputDir: outDir,
        cwd: dir,
        outlineText: () => Promise.resolve({ ok: false, code: 'render_failed', error: 'Inkscape 文字转路径失败' }),
      })
      await expect(failed.execute({ model_path: model, views: ['iso'] }, exec))
        .rejects.toMatchObject({ code: 'tool_execution_failed' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('generate_structure_figure success', () => {
  it('单模型：路径/标号表/组件/附图说明/索引闭环', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    const model = writeModel(dir, 'bracket.step')
    const upserted: FigureIndexEntry[] = []
    try {
      const { render, calls } = okRenderer()
      const tool = createGenerateStructureFigureTool({
        render,
        enabled: true,
        outputDir: outDir,
        cwd: dir,
        upsertIndex: async entry => void upserted.push(entry),
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'generate_structure_figure', {
        model_path: model,
        views: ['iso', 'front'],
        callouts: twoCallouts,
        figure_number: 1,
        invention_name: '一种支架',
        persist_index: true,
      }, 's1') as { isError: boolean; value: { paths: string[]; figures: unknown[]; figureDescription: string; numeralMap: { numeral: string; label: string; figure: number }[]; components: { refNumber: string; name: string; kind: string }[]; warnings: string[]; indexed: boolean } }
      expect(result.isError).toBe(false)
      const value = result.value
      expect(value.paths).toEqual(['figs/fig1/fig1_iso.svg', 'figs/fig1/fig1_front.svg'])
      expect(value.figures).toHaveLength(1)
      expect(value.figureDescription).toBe('图1是本发明实施例提供的一种支架的结构示意图；图中：100-立柱，102-底板。')
      expect(value.numeralMap).toEqual([
        { componentId: '100', label: '立柱', numeral: '100', figure: 1 },
        { componentId: '102', label: '底板', numeral: '102', figure: 1 },
      ])
      expect(value.components[0]).toEqual({ refNumber: '100', name: '立柱', description: '立柱', kind: 'mechanical' })
      expect(value.indexed).toBe(true)
      // 生成方式告警
      expect(value.warnings.some(w => w.includes('FreeCAD TechDraw'))).toBe(true)
      // 渲染 spec 传递
      expect(calls[0]?.views).toEqual(['iso', 'front'])
      expect(calls[0]?.figureNumber).toBe(1)
      expect(calls[0]?.outputDir).toBe(join(outDir, 'fig1'))
      // 索引条目
      expect(upserted).toHaveLength(1)
      expect(upserted[0]?.analysis.figureType).toBe('structure')
      expect(upserted[0]?.analysis.modelUsed).toBe(STRUCTURE_FIGURE_MODEL_USED)
      expect(upserted[0]?.analysis.confidence).toBe(1)
      expect(upserted[0]?.analysis.usable).toBe(true)
      expect(upserted[0]?.imagePath).toBe('figs/fig1/fig1_iso.svg')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('省略 point3d：单模型可省 model，锚点交给脚本自动选', async () => {
    const dir = tempDir()
    const model = writeModel(dir, 'bracket.step')
    try {
      const { render, calls } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: join(dir, 'figs'), cwd: dir })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'generate_structure_figure', {
        model_path: model,
        views: ['iso'],
        // 不给坐标、也不给归属：单模型的唯一零件就是默认归属，锚点由脚本在顶点里选。
        callouts: [{ numeral: '1', label: '底板' }],
      }, 'a1') as { isError: boolean }
      expect(result.isError).toBe(false)
      expect(calls[0]?.callouts).toHaveLength(1)
      expect(calls[0]?.callouts[0]?.point3d).toBeUndefined()
      expect(calls[0]?.callouts[0]?.label).toBe('底板')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('批量目录：每个模型一图，图号自 base 递增', async () => {
    const dir = tempDir()
    const modelDir = join(dir, 'models')
    mkdirSync(modelDir, { recursive: true })
    writeModel(modelDir, 'a.step')
    writeModel(modelDir, 'b.step')
    writeFileSync(join(modelDir, 'notes.txt'), 'ignored')
    const outDir = join(dir, 'figs')
    try {
      const { render, calls } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: outDir, cwd: dir })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'generate_structure_figure', {
        model_path: modelDir,
        views: ['iso'],
        figure_number: 3,
      }, 's2') as { isError: boolean; value: { paths: string[]; figures: { figureNumber: number }[]; figureDescription: string; assembly?: unknown } }
      expect(result.isError).toBe(false)
      // 摘要只描述一张图，多图时给出会让调用方以为它覆盖全部，故不给。
      expect(result.value.assembly).toBeUndefined()
      expect(result.value.figures.map(f => f.figureNumber)).toEqual([3, 4])
      expect(calls.map(c => c.figureNumber)).toEqual([3, 4])
      expect(result.value.paths).toEqual(['figs/fig3/fig3_iso.svg', 'figs/fig4/fig4_iso.svg'])
      expect(result.value.figureDescription).toBe('图3是本发明实施例提供的结构示意图；图4是本发明实施例提供的结构示意图。')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('persist_index=false 时不写索引', async () => {
    const dir = tempDir()
    const model = writeModel(dir, 'a.step')
    const upserted: FigureIndexEntry[] = []
    try {
      const { render } = okRenderer()
      const tool = createGenerateStructureFigureTool({
        render, enabled: true, outputDir: dir, cwd: dir, upsertIndex: async e => void upserted.push(e),
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'generate_structure_figure', { model_path: model, views: ['iso'], persist_index: false }, 's3') as { value: { indexed: boolean } }
      expect(result.value.indexed).toBe(false)
      expect(upserted).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('无 callouts 时为纯几何线稿，标号表/组件为空', async () => {
    const dir = tempDir()
    const model = writeModel(dir, 'a.step')
    try {
      const { render } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: dir, cwd: dir })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'generate_structure_figure', { model_path: model, views: ['front'] }, 's4') as { value: { numeralMap: unknown[]; components: unknown[]; figureDescription: string } }
      expect(result.value.numeralMap).toEqual([])
      expect(result.value.components).toEqual([])
      expect(result.value.figureDescription).toBe('图1是本发明实施例提供的结构示意图。')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('generate_structure_figure wording & validation', () => {
  it('非阿拉伯数字标号触发图面用语告警', async () => {
    const dir = tempDir()
    const model = writeModel(dir, 'a.step')
    try {
      const { render } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: dir, cwd: dir })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'generate_structure_figure', {
        model_path: model,
        views: ['iso'],
        callouts: [{ numeral: 'A1', point3d: [0, 0, 0], label: '部件' }],
      }, 's5') as { value: { warnings: string[] } }
      expect(result.value.warnings.some(w => w.includes('阿拉伯数字'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('不支持的视图名在 schema 层被拒（enum 门禁先于 execute）', async () => {
    const dir = tempDir()
    const model = writeModel(dir, 'a.step')
    try {
      const { render } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: dir, cwd: dir })
      await expect(tool.execute({ model_path: model, views: ['bogus'] }, exec)).rejects.toMatchObject({ code: 'INVALID_ARGS' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('不支持的模型格式报 invalid_tool_input', async () => {
    const dir = tempDir()
    const bad = join(dir, 'model.obj')
    writeFileSync(bad, 'x')
    try {
      const { render } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: dir, cwd: dir })
      await expect(tool.execute({ model_path: bad }, exec)).rejects.toMatchObject({ code: 'invalid_tool_input' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('模型路径不存在报 file_not_found', async () => {
    const dir = tempDir()
    try {
      const { render } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: dir, cwd: dir })
      await expect(tool.execute({ model_path: join(dir, 'missing.step') }, exec)).rejects.toMatchObject({ code: 'file_not_found' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('callouts 的 point3d 不是三个有限数时报字段级错误', async () => {
    const dir = tempDir()
    const model = writeModel(dir, 'a.step')
    try {
      const { render } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: dir, cwd: dir })
      await expect(tool.execute({
        model_path: model,
        views: ['iso'],
        callouts: [{ numeral: '1', point3d: [0, 0] }],
      }, exec)).rejects.toThrow('point3d 必须是恰好三个有限数')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('缺省视图列表为空时报 invalid_tool_input', async () => {
    const dir = tempDir()
    const model = writeModel(dir, 'a.step')
    try {
      const { render } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: dir, cwd: dir, defaultViews: [] })
      await expect(tool.execute({ model_path: model }, exec)).rejects.toThrow('视图列表不能为空')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('model_path 指向非文件非目录时报 invalid_tool_input', async () => {
    const dir = tempDir()
    try {
      const { render } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: dir, cwd: dir })
      await expect(tool.execute({ model_path: '/dev/null' }, exec)).rejects.toThrow('既不是文件也不是目录')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('渲染器返回的 manifest 读不到时报 tool_execution_failed', async () => {
    const dir = tempDir()
    const model = writeModel(dir, 'a.step')
    try {
      const render = async (spec: StructureRenderSpec): Promise<StructureRenderOutcome> => ({
        ok: true,
        manifestPath: join(spec.outputDir, 'missing-manifest.json'),
      })
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: dir, cwd: dir })
      await expect(tool.execute({ model_path: model, views: ['iso'] }, exec))
        .rejects.toThrow('读取 manifest 失败')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('manifest 指向的视图文件缺失时报 tool_execution_failed', async () => {
    const dir = tempDir()
    const model = writeModel(dir, 'a.step')
    try {
      const render = async (spec: StructureRenderSpec): Promise<StructureRenderOutcome> => {
        mkdirSync(spec.outputDir, { recursive: true })
        const manifestPath = join(spec.outputDir, STRUCTURE_MANIFEST_FILENAME)
        writeFileSync(manifestPath, JSON.stringify({
          figureNumber: spec.figureNumber,
          modelPaths: spec.modelPaths,
          scale: spec.scale,
          showHidden: spec.showHidden,
          generator: 'freecad-structure',
          views: [{ name: 'iso', kind: 'view', order: 0, path: join(spec.outputDir, 'missing.svg'), bbox: [0, 0, 1, 1], anchors: [] }],
        }))
        return { ok: true, manifestPath }
      }
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: dir, cwd: dir })
      await expect(tool.execute({ model_path: model, views: ['iso'] }, exec))
        .rejects.toThrow('读取视图 iso SVG 失败')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('未注入 cwd 时以 process.cwd 为基准解析相对模型路径', async () => {
    const dir = tempDir()
    const model = writeModel(dir, 'a.step')
    try {
      const { render } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: dir })
      const value = await tool.execute({ model_path: model, views: ['iso'] }, exec) as { paths: string[] }
      expect(value.paths).toHaveLength(1)
      expect(isAbsolute(value.paths[0] ?? '')).toBe(false)
      expect(existsSync(resolve(process.cwd(), value.paths[0] ?? ''))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('落版使用缺省页序与图号，并带出字高与图号', async () => {
    const dir = tempDir()
    const model = writeModel(dir, 'a.step')
    try {
      const { render } = okRenderer({
        svg: '<svg width="100mm" height="50mm" viewBox="0 0 100 50" xmlns="http://www.w3.org/2000/svg"><g stroke="#000000" stroke-width="0.35"><path d="M0 0 L10 10"/><text x="20" y="20" font-size="10">1</text></g></svg>',
      })
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: dir, cwd: dir })
      const value = await tool.execute({
        model_path: model,
        views: ['iso'],
        target_office: 'cnipa',
        caption: '图1',
        fit_to_page: false,
        persist_index: false,
      }, exec) as { layout?: { sheetNumber: string; caption?: string } }
      expect(value.layout?.sheetNumber).toBe('第1页')
      expect(value.layout?.caption).toBe('图1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('页序越界时落版参数报 invalid_tool_input', async () => {
    const dir = tempDir()
    const model = writeModel(dir, 'a.step')
    try {
      const { render } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: dir, cwd: dir })
      await expect(tool.execute({
        model_path: model,
        views: ['iso'],
        target_office: 'cnipa',
        sheet_index: 3,
        sheet_total: 2,
      }, exec)).rejects.toThrow('落版参数非法')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('极小图形落版时把放大限制记成警告', async () => {
    const dir = tempDir()
    const model = writeModel(dir, 'a.step')
    try {
      const { render } = okRenderer({ svg: '<svg width="1mm" height="1mm" viewBox="0 0 1 1" xmlns="http://www.w3.org/2000/svg"><g/></svg>' })
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: dir, cwd: dir })
      const value = await tool.execute({ model_path: model, views: ['iso'], target_office: 'cnipa' }, exec) as { warnings: string[] }
      expect(value.warnings.some(warning => warning.startsWith('落版：'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('目录内无受支持模型报 invalid_tool_input', async () => {
    const dir = tempDir()
    const empty = join(dir, 'empty')
    mkdirSync(empty, { recursive: true })
    writeFileSync(join(empty, 'readme.txt'), 'x')
    try {
      const { render } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: dir, cwd: dir })
      await expect(tool.execute({ model_path: empty }, exec)).rejects.toMatchObject({ code: 'invalid_tool_input' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('批量目录与 callouts 同用报 invalid_tool_input，且不落到渲染器', async () => {
    const dir = tempDir()
    const modelDir = join(dir, 'models')
    mkdirSync(modelDir, { recursive: true })
    writeModel(modelDir, 'a.step')
    writeModel(modelDir, 'b.step')
    try {
      const { render, calls } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: dir, cwd: dir })
      await expect(tool.execute({ model_path: modelDir, views: ['iso'], callouts: twoCallouts }, exec))
        .rejects.toMatchObject({ code: 'invalid_tool_input' })
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('批量目录与 details 同用报 invalid_tool_input（放大窗口也是模型专属坐标）', async () => {
    const dir = tempDir()
    const modelDir = join(dir, 'models')
    mkdirSync(modelDir, { recursive: true })
    writeModel(modelDir, 'a.step')
    writeModel(modelDir, 'b.step')
    try {
      const { render, calls } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: dir, cwd: dir })
      await expect(tool.execute({ model_path: modelDir, views: ['iso'], details: [{ base: 'iso', center: [0, 0, 0], radius_mm: 5 }] }, exec))
        .rejects.toMatchObject({ code: 'invalid_tool_input' })
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('scale 非正数报 invalid_tool_input', async () => {
    const dir = tempDir()
    const model = writeModel(dir, 'a.step')
    try {
      const { render } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: dir, cwd: dir })
      await expect(tool.execute({ model_path: model, views: ['iso'], scale: 0 }, exec)).rejects.toMatchObject({ code: 'invalid_tool_input' })
      await expect(tool.execute({ model_path: model, views: ['iso'], scale: -2 }, exec)).rejects.toMatchObject({ code: 'invalid_tool_input' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('figure_number 非正整数报 invalid_tool_input', async () => {
    const dir = tempDir()
    const model = writeModel(dir, 'a.step')
    try {
      const { render } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: dir, cwd: dir })
      await expect(tool.execute({ model_path: model, views: ['iso'], figure_number: 0 }, exec)).rejects.toMatchObject({ code: 'invalid_tool_input' })
      await expect(tool.execute({ model_path: model, views: ['iso'], figure_number: -1 }, exec)).rejects.toMatchObject({ code: 'invalid_tool_input' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('generate_structure_figure render outcome mapping', () => {
  function fixed(outcome: StructureRenderOutcome) {
    return { render: () => Promise.resolve(outcome) }
  }

  it('not_installed→setup_required / aborted→tool_aborted / render_failed→tool_execution_failed', async () => {
    const dir = tempDir()
    const model = writeModel(dir, 'a.step')
    try {
      const notInstalled = createGenerateStructureFigureTool({ ...fixed({ ok: false, code: 'not_installed', error: '未找到 FreeCAD' }), enabled: true, outputDir: dir, cwd: dir })
      const aborted = createGenerateStructureFigureTool({ ...fixed({ ok: false, code: 'aborted', error: '取消' }), enabled: true, outputDir: dir, cwd: dir })
      const failed = createGenerateStructureFigureTool({ ...fixed({ ok: false, code: 'render_failed', error: '退出码 1' }), enabled: true, outputDir: dir, cwd: dir })
      await expect(notInstalled.execute({ model_path: model, views: ['iso'] }, exec)).rejects.toMatchObject({ code: 'setup_required' })
      await expect(aborted.execute({ model_path: model, views: ['iso'] }, exec)).rejects.toMatchObject({ code: 'tool_aborted' })
      await expect(failed.execute({ model_path: model, views: ['iso'] }, exec)).rejects.toMatchObject({ code: 'tool_execution_failed' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('manifest 无视图时报 tool_execution_failed', async () => {
    const dir = tempDir()
    const model = writeModel(dir, 'a.step')
    try {
      const { render } = okRenderer({ emptyViews: true })
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: dir, cwd: dir })
      await expect(tool.execute({ model_path: model, views: ['iso'] }, exec)).rejects.toMatchObject({ code: 'tool_execution_failed' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('manifest 的逐零件几何事实非法时报 tool_execution_failed', async () => {
    const dir = tempDir()
    const model = writeModel(dir, 'a.step')
    const good = { index: 0, bbox3d: [0, 0, 0, 10, 10, 10], volume: 1000, bounds: [0, 0, 10, 10] }
    // 这些值都会让下游把件号或占位算到错误位置，故在读回 manifest 处 fail-loud。
    const cases: readonly (readonly [string, unknown])[] = [
      ['parts 不是数组', 'not-an-array'],
      ['index 不是整数', [{ ...good, index: 1.5 }]],
      ['index 为负', [{ ...good, index: -1 }]],
      ['index 越界', [{ ...good, index: 99 }]],
      ['bbox3d 不是数组', [{ ...good, bbox3d: 6 }]],
      ['bbox3d 长度不是六', [{ ...good, bbox3d: [0, 0, 0] }]],
      ['bbox3d 含非有限数', [{ ...good, bbox3d: [0, 0, 0, 10, 10, Number.POSITIVE_INFINITY] }]],
      ['volume 不是有限数', [{ ...good, volume: Number.NaN }]],
      ['bounds 不是数组', [{ ...good, bounds: 4 }]],
      ['bounds 长度不是四', [{ ...good, bounds: [0, 0, 0] }]],
      ['bounds 含非有限数', [{ ...good, bounds: [0, 0, Number.NaN, 10] }]],
    ]
    try {
      for (const [label, parts] of cases) {
        const { render } = okRenderer({ partsOverride: parts })
        const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: dir, cwd: dir })
        await expect(tool.execute({ model_path: model, views: ['iso'] }, exec), label)
          .rejects.toMatchObject({ code: 'tool_execution_failed' })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('零件在该朝向看不见时 bounds 为 null，摘要原样带出', async () => {
    const dir = tempDir()
    const model = writeModel(dir, 'a.step')
    try {
      const { render } = okRenderer({
        partsOverride: [{ index: 0, bbox3d: [0, 0, 0, 10, 10, 10], volume: 1000, bounds: null }],
      })
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: join(dir, 'figs'), cwd: dir })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'generate_structure_figure', { model_path: model, views: ['iso'] }, 'n1') as {
        isError: boolean
        value: { assembly?: { viewBounds: Record<string, (number[] | null)[]> } }
      }
      expect(result.isError).toBe(false)
      // null 表示该朝向看不见这个零件，与零面积框不是一回事。
      expect(result.value.assembly?.viewBounds.iso).toEqual([null])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('manifest 视图的 warnings 不是字符串数组时报 tool_execution_failed', async () => {
    const dir = tempDir()
    const model = writeModel(dir, 'a.step')
    try {
      const { render } = okRenderer({ viewWarnings: 'not-an-array' })
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: dir, cwd: dir })
      await expect(tool.execute({ model_path: model, views: ['iso'] }, exec))
        .rejects.toMatchObject({ code: 'tool_execution_failed' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('视图级标号降级说明并入工具警告，注明哪张图的哪个视图', async () => {
    const dir = tempDir()
    const model = writeModel(dir, 'a.step')
    try {
      const { render } = okRenderer({ viewWarnings: ['件号 1 找不到不压盖标号的位置'] })
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: dir, cwd: dir })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'generate_structure_figure', { model_path: model, views: ['iso'] }, 'n2') as {
        isError: boolean
        value: { warnings: string[] }
      }
      expect(result.isError).toBe(false)
      // 标号还在图上、但位置是退路：这句话必须到调用方手上，否则「有标号」会被当成「位置合规」。
      expect(result.value.warnings).toContain('图1 iso：件号 1 找不到不压盖标号的位置')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('版面利用率下限开启时提示级发现进警告而不阻断交付', async () => {
    const dir = tempDir()
    const model = writeModel(dir, 'a.step')
    // 内容只占 A4 幅面一小角：低于下限，但图本身没有画错。
    const sparse = '<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 210 297">'
      + '<g fill="none" stroke="#000000"><rect x="20" y="20" width="10" height="10" stroke-width="0.35"/></g></svg>'
    try {
      const { render } = okRenderer({ svg: sparse })
      const tool = createGenerateStructureFigureTool({
        render, enabled: true, outputDir: dir, cwd: dir, minSheetFillRatio: 0.5, failOnRenderFindings: true,
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'generate_structure_figure', { model_path: model, views: ['iso'] }, 'n3') as {
        isError: boolean
        value: { warnings: string[] }
      }
      expect(result.isError).toBe(false)
      expect(result.value.warnings.some(warning => warning.includes('撑不满纸面'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('视图 SVG 含不安全结构时报 tool_execution_failed', async () => {
    const dir = tempDir()
    const model = writeModel(dir, 'a.step')
    try {
      const { render } = okRenderer({ unsafe: true })
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: dir, cwd: dir })
      await expect(tool.execute({ model_path: model, views: ['iso'] }, exec)).rejects.toMatchObject({ code: 'tool_execution_failed' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('索引写入失败降级为告警且不阻断（indexed=false）', async () => {
    const dir = tempDir()
    const model = writeModel(dir, 'a.step')
    try {
      const { render } = okRenderer()
      const tool = createGenerateStructureFigureTool({
        render,
        enabled: true,
        outputDir: dir,
        cwd: dir,
        upsertIndex: async () => { throw new Error('disk full') },
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'generate_structure_figure', { model_path: model, views: ['iso'], callouts: twoCallouts }, 's6') as { isError: boolean; value: { indexed: boolean; warnings: string[] } }
      expect(result.isError).toBe(false)
      expect(result.value.indexed).toBe(false)
      expect(result.value.warnings.some(w => w.includes('附图索引写入失败') && w.includes('disk full'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('generate_structure_figure 局部放大视图（details）', () => {
  /** 一个最小窗口请求：正视图中以模型 (0,0,8)（立圆柱与底板交界）为圆心、半径 8 毫米。 */
  const window8 = { base: 'front', center: [0, 0, 8] as [number, number, number], radius_mm: 8 }

  it('归一窗口后交给渲染器：缺省 2 倍放大、标号取序号，放大视图进 paths 与 manifest', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    const model = writeModel(dir, 'bracket.step')
    try {
      const { render, calls } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: outDir, cwd: dir })
      const ctx = await ctxWith(tool)
      type ManifestView = {
        name: string
        kind: string
        base?: string
        center3d?: number[]
        radiusMm?: number
        scale?: number
        reference?: string
      }
      const result = await execute(ctx, 'generate_structure_figure', {
        model_path: model,
        views: ['front'],
        details: [window8],
      }, 'detail1') as {
        isError: boolean
        value: { paths: string[]; figures: { manifest: { views: ManifestView[] } }[] }
      }
      expect(result.isError).toBe(false)
      expect(calls[0]!.details).toEqual([{ base: 'front', center: [0, 0, 8], radiusMm: 8, scale: 2, reference: '1' }])
      // 基视图与放大视图都在产物路径里；放大视图带窗口元数据（kind/base/圆心/半径/倍数/标号）。
      expect(result.value.paths).toEqual(['figs/fig1/fig1_front.svg', 'figs/fig1/fig1_detail1.svg'])
      const views = result.value.figures[0]!.manifest.views
      expect(views.map(view => [view.name, view.kind])).toEqual([['front', 'view'], ['detail1', 'detail']])
      expect(views[1]).toMatchObject({ base: 'front', center3d: [0, 0, 8], radiusMm: 8, scale: 2, reference: '1' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('显式 scale 与 reference 原样透传', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    const model = writeModel(dir, 'bracket.step')
    try {
      const { render, calls } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: outDir, cwd: dir })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'generate_structure_figure', {
        model_path: model,
        views: ['front'],
        details: [{ ...window8, scale: 5, reference: 'Ⅰ' }],
      }, 'detail2') as { isError: boolean }
      expect(result.isError).toBe(false)
      expect(calls[0]!.details).toEqual([{ base: 'front', center: [0, 0, 8], radiusMm: 8, scale: 5, reference: 'Ⅰ' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('base 不在本次 views 里报 invalid_tool_input（窗口没有落脚处）', async () => {
    const dir = tempDir()
    const model = writeModel(dir, 'bracket.step')
    try {
      const { render, calls } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: dir, cwd: dir })
      const error = await tool.execute({ model_path: model, views: ['iso'], details: [window8] }, exec).catch((thrown: unknown) => thrown)
      expect(error).toMatchObject({ code: 'invalid_tool_input' })
      // 报错点名是哪个字段：模型要能据此自己改对（并把可用视图列出来）。
      expect((error as Error).message).toContain('details[0].base')
      expect((error as Error).message).toContain('iso')
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('半径与倍数非正各报 invalid_tool_input', async () => {
    const dir = tempDir()
    const model = writeModel(dir, 'bracket.step')
    try {
      const { render, calls } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: dir, cwd: dir })
      const views = ['front']
      for (const details of [
        [{ ...window8, radius_mm: 0 }],
        [{ ...window8, radius_mm: -3 }],
        [{ ...window8, scale: 0 }],
        [{ ...window8, scale: -2 }],
      ]) {
        await expect(tool.execute({ model_path: model, views, details }, exec)).rejects.toMatchObject({ code: 'invalid_tool_input' })
      }
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('圆心长度不是 3 报 invalid_tool_input（schema 只把 center 约束为 number[]）', async () => {
    const dir = tempDir()
    const model = writeModel(dir, 'bracket.step')
    try {
      const { render, calls } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: dir, cwd: dir })
      // 非有限数进不到这里的复核分支：JSON 里 Infinity/NaN 会序列化成 null，被 schema
      // 挡在门外；长度那半支面向的是绕过 schema 的调用方（同 point3d），故按 JSON 边界构造。
      const args = JSON.parse(JSON.stringify({
        model_path: model,
        views: ['front'],
        details: [{ ...window8, center: [0, 0] }],
      })) as GenerateStructureFigureInput
      await expect(tool.execute(args, exec))
        .rejects.toMatchObject({ code: 'invalid_tool_input' })
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('generate_structure_figure 线宽与线型', () => {
  /** FreeCAD 1.1.3 实测的投影片段形态：可见线一组 0.7、隐藏线一组 0.35，无 dasharray。 */
  const FREECAD_SHAPED_SVG = [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-30 -30 60 60" width="60mm" height="60mm">',
    '<g transform="scale(1,-1)">',
    '<g fill="none" stroke="#000000" stroke-width="0.7"><path d=" M -20 12 L 20 12 " /></g>',
    '<g fill="none" stroke="#000000" stroke-width="0.35"><path d=" M -20 -12 L 20 -12 " /></g>',
    '</g></svg>',
  ].join('')

  async function renderWith(style: Record<string, unknown>): Promise<string> {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    const model = writeModel(dir, 'bracket.step')
    const tool = createGenerateStructureFigureTool({
      render: okRenderer({ svg: FREECAD_SHAPED_SVG }).render,
      enabled: true,
      outputDir: outDir,
      cwd: dir,
    })
    const ctx = await ctxWith(tool)
    try {
      const result = await execute(ctx, 'generate_structure_figure', { model_path: model, views: ['iso'], ...style }, 's-style') as {
        isError: boolean
        value: { warnings: string[] }
      }
      expect(result.isError).toBe(false)
      return readFileSync(join(outDir, 'fig1', 'fig1_iso.svg'), 'utf8')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it('不传参数时视图文件与渲染产物逐字节一致', async () => {
    expect(await renderWith({})).toBe(FREECAD_SHAPED_SVG)
    expect(await renderWith({ hidden_line_style: 'solid' })).toBe(FREECAD_SHAPED_SVG)
  })

  it('line_width_mm 与 hidden_line_style 落到交付文件', async () => {
    const styled = await renderWith({ line_width_mm: 1, hidden_line_style: 'dashed' })
    const tags = [...styled.matchAll(/<g\b[^>]*>/g)].map(match => match[0])
    expect(tags.some(tag => tag.includes('stroke-width="1"') && !tag.includes('stroke-dasharray'))).toBe(true)
    expect(tags.some(tag => tag.includes('stroke-width="0.35"') && tag.includes('stroke-dasharray="4.2 1.05"'))).toBe(true)
  })

  it('line_width_mm 非 GB/T 4457.4 线宽系列时被 schema 拒绝', async () => {
    const dir = tempDir()
    const model = writeModel(dir, 'a.step')
    try {
      const tool = createGenerateStructureFigureTool({ render: okRenderer().render, enabled: true, outputDir: dir, cwd: dir })
      await expect(tool.execute({ model_path: model, views: ['iso'], line_width_mm: 0.6 }, exec))
        .rejects.toMatchObject({ code: 'INVALID_ARGS' })
      await expect(tool.execute({ model_path: model, views: ['iso'], hidden_line_style: 'dotted' }, exec))
        .rejects.toMatchObject({ code: 'INVALID_ARGS' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('无隐藏线组时告警带视图路径，且不阻断交付', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    const model = writeModel(dir, 'bracket.step')
    const singleGroup = '<svg xmlns="http://www.w3.org/2000/svg" width="60mm" height="60mm"><g stroke="#000000" stroke-width="0.7"><path d="M0 0 L10 10"/></g></svg>'
    try {
      const tool = createGenerateStructureFigureTool({
        render: okRenderer({ svg: singleGroup }).render,
        enabled: true,
        outputDir: outDir,
        cwd: dir,
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'generate_structure_figure', {
        model_path: model,
        views: ['iso'],
        hidden_line_style: 'dashed',
      }, 's-dash') as { isError: boolean; value: { warnings: string[] } }
      expect(result.isError).toBe(false)
      expect(result.value.warnings.join('\n')).toContain('figs/fig1/fig1_iso.svg 未发现比可见线更细的线组')
      expect(readFileSync(join(outDir, 'fig1', 'fig1_iso.svg'), 'utf8')).toBe(singleGroup)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('generate_structure_figure 隐藏线描述', () => {
  it('描述里的线型与实测一致：细实线，不是虚线', async () => {
    // FreeCAD 1.1.3 实测：viewPartAsSvg 开隐藏线后输出两组描边（可见 0.7 毫米、隐藏
    // 0.35 毫米），全篇无 stroke-dasharray。描述写「虚线」会让模型误判交付物线型。
    const tool = createGenerateStructureFigureTool({ render: okRenderer().render, enabled: true })
    const ctx = await ctxWith(tool)
    const registered = ctx.tools.get('generate_structure_figure')
    const properties = (registered?.parameters as { properties: Record<string, { description: string }> }).properties
    expect(properties['show_hidden']?.description).toContain('细实线')
    // 明写反例而非略过：制图惯例里隐藏线是虚线，模型会默认成虚线，必须说清不是。
    expect(properties['show_hidden']?.description).toContain('不是虚线')
    expect(registered?.description).toContain('细实线')
    expect(registered?.description).toContain('不是虚线')
    expect(registered?.description).not.toContain('隐藏线（虚线）')
  })
})

describe('generate_structure_figure 装配体（model_paths）', () => {
  it('多文件投影成一张图：一次渲染调用带齐全部模型，件号随归属下发', async () => {
    const dir = tempDir()
    const plate = writeModel(dir, 'plate.step')
    const pin = writeModel(dir, 'pin.step')
    try {
      const { render, calls } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: join(dir, 'figs'), cwd: dir })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'generate_structure_figure', {
        model_paths: [plate, pin],
        views: ['iso'],
        figure_number: 2,
        callouts: [
          { numeral: '100', point3d: [0, 0, 24], label: '立销', model: 1 },
          { numeral: '102', point3d: [20, -12, 8], label: '底板', model: 0 },
        ],
      }, 'a1') as { isError: boolean; value: { figures: { figureNumber: number; modelPaths: string[]; manifest: { views: { anchors: { numeral: string; model: number | null; modelPath: string | null }[] }[] } }[]; paths: string[] } }
      expect(result.isError).toBe(false)
      // 目录批量是「一模型一图」，装配体是「多模型一图」：后者只渲一次。
      expect(calls).toHaveLength(1)
      expect(calls[0]?.modelPaths).toEqual([plate, pin])
      expect(calls[0]?.figureNumber).toBe(2)
      expect(result.value.figures).toHaveLength(1)
      expect(result.value.figures[0]?.modelPaths).toEqual([plate, pin])
      expect(result.value.paths).toEqual(['figs/fig2/fig2_iso.svg'])
      // 归属随 manifest 返回：件号 → 下标 + 该零件的绝对路径。
      expect(result.value.figures[0]?.manifest.views[0]?.anchors).toEqual([
        expect.objectContaining({ numeral: '100', model: 1, modelPath: pin }),
        expect.objectContaining({ numeral: '102', model: 0, modelPath: plate }),
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('输出装配体几何事实：每零件 3D 尺寸与各视图投影占位', async () => {
    const dir = tempDir()
    const plate = writeModel(dir, 'plate.step')
    const pin = writeModel(dir, 'pin.step')
    try {
      const { render } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: join(dir, 'figs'), cwd: dir })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'generate_structure_figure', {
        model_paths: [plate, pin],
        views: ['iso', 'front'],
      }, 'a1') as {
        isError: boolean
        value: {
          assembly?: {
            modelPaths: string[]
            parts: { index: number; path: string; bbox3d: number[]; volume: number }[]
            viewBounds: Record<string, (number[] | null)[]>
          }
        }
      }
      expect(result.isError).toBe(false)
      // 几何事实按 modelPaths 顺序给出，path 与下标一一对应（调用方据此把件号绑到零件）。
      expect(result.value.assembly?.modelPaths).toEqual([plate, pin])
      expect(result.value.assembly?.parts).toEqual([
        { index: 0, path: plate, bbox3d: [0, 0, 0, 10, 10, 10], volume: 1000 },
        { index: 1, path: pin, bbox3d: [0, 0, 0, 10, 10, 10], volume: 1000 },
      ])
      // 投影占位按视图分开：同一零件在不同朝向下的占位不同，不能共用一个框。
      expect(Object.keys(result.value.assembly?.viewBounds ?? {})).toEqual(['iso', 'front'])
      expect(result.value.assembly?.viewBounds.iso).toEqual([[0, 0, 10, 10], [0, 0, 10, 10]])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('旧版 manifest 无 parts 字段：不给出 assembly，图仍照常产出', async () => {
    const dir = tempDir()
    const plate = writeModel(dir, 'plate.step')
    try {
      const { render } = okRenderer({ omitParts: true })
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: join(dir, 'figs'), cwd: dir })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'generate_structure_figure', {
        model_paths: [plate],
        views: ['iso'],
      }, 'a1') as { isError: boolean; value: { assembly?: unknown; paths: string[] } }
      expect(result.isError).toBe(false)
      expect(result.value.assembly).toBeUndefined()
      expect(result.value.paths).toEqual(['figs/fig1/fig1_iso.svg'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('分解图把 exploded 交给渲染器；单模型与 details 同时给都当场拒绝', async () => {
    const dir = tempDir()
    const plate = writeModel(dir, 'plate.step')
    const pin = writeModel(dir, 'pin.step')
    try {
      const { render, calls } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: join(dir, 'figs'), cwd: dir })
      // 装配体 + exploded：标记原样下发，渲染器据此走逐件投影路径。
      await execute(await ctxWith(tool), 'generate_structure_figure', {
        model_paths: [plate, pin],
        views: ['front'],
        exploded: true,
      }, 'a1')
      expect(calls[0]?.exploded).toBe(true)
      // 单模型没有可分解的装配关系。
      await expect(tool.execute({ model_path: plate, views: ['front'], exploded: true }, exec))
        .rejects.toMatchObject({ code: 'invalid_tool_input' })
      // 放大窗口挂在单一基视图上，而分解图每个零件各有一个视图。
      await expect(tool.execute({
        model_paths: [plate, pin],
        views: ['front'],
        exploded: true,
        details: [{ base: 'front', center: [0, 0, 10], radius_mm: 5 }],
      }, exec)).rejects.toMatchObject({ code: 'invalid_tool_input' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('装配体下件号必须写明归属：缺 model 报错且不落到渲染器', async () => {
    const dir = tempDir()
    const plate = writeModel(dir, 'plate.step')
    const pin = writeModel(dir, 'pin.step')
    try {
      const { render, calls } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: join(dir, 'figs'), cwd: dir })
      const failure = await tool.execute({
        model_paths: [plate, pin],
        views: ['iso'],
        callouts: [{ numeral: '100', point3d: [0, 0, 24] }],
      }, exec).catch((error: unknown) => error)
      expect(failure).toMatchObject({ code: 'invalid_tool_input' })
      expect((failure as Error).message).toContain('callouts[0].model')
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('model 下标越界报 invalid_tool_input 并指明字段与取值范围', async () => {
    const dir = tempDir()
    const plate = writeModel(dir, 'plate.step')
    const pin = writeModel(dir, 'pin.step')
    try {
      const { render, calls } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: join(dir, 'figs'), cwd: dir })
      const failure = await tool.execute({
        model_paths: [plate, pin],
        views: ['iso'],
        callouts: [{ numeral: '100', point3d: [0, 0, 24], model: 2 }],
      }, exec).catch((error: unknown) => error)
      expect(failure).toMatchObject({ code: 'invalid_tool_input' })
      expect((failure as Error).message).toContain('callouts[0].model 必须是 0 到 1 之间的整数')
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('单模型也接受归属声明（下标只能是 0），目录批量仍不支持 callouts', async () => {
    const dir = tempDir()
    const model = writeModel(dir, 'a.step')
    const modelDir = join(dir, 'models')
    mkdirSync(modelDir, { recursive: true })
    writeModel(modelDir, 'a.step')
    writeModel(modelDir, 'b.step')
    try {
      const { render, calls } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: join(dir, 'figs'), cwd: dir })
      const ctx = await ctxWith(tool)
      // 单模型下 model 只能是 0：归属明确时同样核对锚点是否落在该零件上。
      const ok = await execute(ctx, 'generate_structure_figure', {
        model_path: model,
        views: ['iso'],
        callouts: [{ numeral: '1', point3d: [0, 0, 0], model: 0 }],
      }, 'a4') as { isError: boolean }
      expect(ok.isError).toBe(false)
      expect(calls[0]?.callouts[0]?.model).toBe(0)
      await expect(tool.execute({ model_path: modelDir, views: ['iso'], callouts: twoCallouts }, exec))
        .rejects.toMatchObject({ code: 'invalid_tool_input' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('model_path 与 model_paths 二选一：同给与都不给都报错，且不落到渲染器', async () => {
    const dir = tempDir()
    const plate = writeModel(dir, 'plate.step')
    const pin = writeModel(dir, 'pin.step')
    try {
      const { render, calls } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: join(dir, 'figs'), cwd: dir })
      const both = await tool.execute({ model_path: plate, model_paths: [plate, pin], views: ['iso'] }, exec).catch((error: unknown) => error)
      expect((both as Error).message).toContain('二选一')
      const neither = await tool.execute({ views: ['iso'] }, exec).catch((error: unknown) => error)
      expect(neither).toMatchObject({ code: 'invalid_tool_input' })
      expect((neither as Error).message).toContain('model_path')
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('model_paths 的空数组、重复路径、目录与非文件各报错并指明下标', async () => {
    const dir = tempDir()
    const plate = writeModel(dir, 'plate.step')
    const sub = join(dir, 'sub')
    mkdirSync(sub, { recursive: true })
    try {
      const { render, calls } = okRenderer()
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: join(dir, 'figs'), cwd: dir })
      await expect(tool.execute({ model_paths: [], views: ['iso'] }, exec)).rejects.toMatchObject({ code: 'invalid_tool_input' })
      const duplicate = await tool.execute({ model_paths: [plate, plate], views: ['iso'] }, exec).catch((error: unknown) => error)
      expect((duplicate as Error).message).toContain('model_paths[1] 与前面的模型重复')
      const directory = await tool.execute({ model_paths: [plate, sub], views: ['iso'] }, exec).catch((error: unknown) => error)
      expect((directory as Error).message).toContain('model_paths[1] 不是文件')
      const missing = await tool.execute({ model_paths: [plate, join(dir, 'gone.step')], views: ['iso'] }, exec).catch((error: unknown) => error)
      expect(missing).toMatchObject({ code: 'file_not_found' })
      expect((missing as Error).message).toContain('model_paths[1] 不存在')
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('generate_structure_figure 渲染复核门禁', () => {
  /** 跨组线穿过文字：真实缺陷。 */
  const CROSSED = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="120mm" height="40mm" viewBox="0 0 120 40">',
    '  <g fill="none" stroke="#000000">',
    '    <g class="node"><polygon points="10,10 40,10 40,30 10,30"/></g>',
    '    <line x1="60" y1="5" x2="60" y2="35" stroke-width="0.25"/>',
    '    <text x="60" y="22" text-anchor="middle">条件</text>',
    '  </g>',
    '</svg>',
  ].join('\n')

  it('strict 命中阻断级发现时抛错，已写入的视图保留', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    try {
      const { render } = okRenderer({ svg: CROSSED })
      const tool = createGenerateStructureFigureTool({
        render,
        enabled: true,
        outputDir: outDir,
        cwd: dir,
        failOnRenderFindings: true,
      })
      const error = await tool.execute({ model_path: writeModel(dir, 'a.step'), views: ['iso'] }, exec)
        .catch((caught: unknown) => caught)
      expect((error as Error).message).toContain('渲染复核未通过')
      expect((error as Error).message).toContain('图面文字「条件」被线条贯穿')
      expect((error as Error).message).toContain('fig1_iso.svg')
      expect(existsSync(join(outDir, 'fig1', 'fig1_iso.svg'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('默认模式只记警告，不阻断', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    try {
      const { render } = okRenderer({ svg: CROSSED })
      const tool = createGenerateStructureFigureTool({ render, enabled: true, outputDir: outDir, cwd: dir })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'generate_structure_figure', {
        model_path: writeModel(dir, 'a.step'),
        views: ['iso'],
      }, 'gate1')
      expect(result.isError).toBe(false)
      const warnings = (result as never as { value: { warnings: string[] } }).value.warnings
      expect(warnings.some(warning => warning.includes('渲染复核：图面文字「条件」被线条贯穿'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('structureAssembly', () => {
  it('没有图时不给摘要', () => {
    // 空输入只有一个出口：摘要无从描述任何零件。
    expect(structureAssembly([])).toBeUndefined()
  })
})
