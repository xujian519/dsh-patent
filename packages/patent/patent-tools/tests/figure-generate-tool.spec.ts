import { describe, expect, it } from 'vitest'
import { mkdtempSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { GraphvizRenderOutcome, GraphvizRenderSpec } from '../src/figure/graphviz-renderer.ts'
import { createGeneratePatentFigureTool } from '../src/tool/generate-patent-figure.ts'
import { createAddPatentFigureReferencesTool } from '../src/tool/add-patent-figure-references.ts'
import { createSearchPatentFigureTool } from '../src/tool/search-patent-figure.ts'
import { figureIndexStore } from '../src/figure/index-store.ts'
import type { FigureIndexEntry } from '../src/figure/index-store.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const signal = new AbortController().signal

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

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
}

/** 成功结果的 value（isError=false 时存在；调用处以 as 断言结构）。 */
function valueOf(result: unknown): unknown {
  return (result as { value: unknown }).value
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-figgen-'))
}

/** fake renderer: writes an SVG at outputDir/"<filename>.svg" and returns its absolute path。 */
function okRenderer(_dir: string): { render: (spec: GraphvizRenderSpec) => Promise<GraphvizRenderOutcome>; calls: GraphvizRenderSpec[] } {
  const calls: GraphvizRenderSpec[] = []
  return {
    calls,
    render: (spec) => {
      calls.push(spec)
      const out = join(spec.outputDir, `${spec.filename}.${spec.format}`)
      writeFileSync(out, '<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>')
      return Promise.resolve({ ok: true, path: out })
    },
  }
}

const flowSteps = [
  { id: 'start', label: '开始', shape: 'ellipse' as const, next: ['s1'] },
  { id: 's1', label: '处理', next: ['end'] },
  { id: 'end', label: '结束', shape: 'ellipse' as const, next: [] },
]

/** 直接驱动 tool.execute 的最小执行上下文；错误码断言走抛出的 PatentToolError。 */
const exec = { signal } as never

describe('generate_patent_figure tool', () => {
  it('生成流程图：标号表/附图说明/索引 upsert 闭环', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    const upserted: FigureIndexEntry[] = []
    const { render, calls } = okRenderer(outDir)
    const tool = createGeneratePatentFigureTool({
      render,
      outputDir: outDir,
      cwd: dir,
      upsertIndex: async entry => void upserted.push(entry),
    })
    const ctx = await ctxWith(tool)
    try {
      const result = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'flowchart',
        steps: flowSteps,
        figure_number: 1,
        invention_name: '一种自动加热装置',
        persist_index: true,
      }, 'g1')
      expect(result.isError).toBe(false)
      const value = result as {
        content: { type: string; text?: string }[]
        value: { path: string; numeralMap: { numeral: string }[]; figureDescription: string; components: unknown[]; indexed: boolean }
      }
      expect(value.value.path).toBe('figs/fig1.svg')
      expect(value.value.numeralMap.map(m => m.numeral)).toEqual(['100', '102', '104'])
      expect(value.value.figureDescription).toContain('图1是本发明实施例提供的一种自动加热装置的流程图；图中：100-开始，102-处理，104-结束')
      expect(value.value.indexed).toBe(true)
      // render spec 传递
      expect(calls[0]?.dot).toContain('"start" [label="100. 开始", shape=ellipse];')
      expect(calls[0]?.dot).not.toContain('fillcolor')
      expect(calls[0]?.format).toBe('svg')
      expect(text(result)).toContain('参考标号')
      // 索引条目
      expect(upserted.length).toBe(1)
      expect(upserted[0]?.analysis.figureNumber).toBe(1)
      expect(upserted[0]?.analysis.modelUsed).toBe('graphviz-generator')
      expect(upserted[0]?.analysis.confidence).toBe(1)
      expect(upserted[0]?.analysis.components.length).toBe(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('框图 + 连接 + 显式标号续接 + semantic 彩色', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    const { render, calls } = okRenderer(outDir)
    const tool = createGeneratePatentFigureTool({ render, outputDir: outDir, cwd: dir, resolveFont: () => 'Arial' })
    const ctx = await ctxWith(tool)
    try {
      const result = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'block_diagram',
        blocks: [
          { id: 'in', label: '输入', type: 'input' },
          { id: 'cpu', label: '处理', type: 'process' },
        ],
        connections: [{ from: 'in', to: 'cpu', label: '信号' }],
        figure_number: 2,
        numerals: { cpu: '100' },
        style: 'semantic',
        filename: 'sys',
        format: 'png',
        engine: 'neato',
        persist_index: false,
      }, 'g2')
      expect(result.isError).toBe(false)
      const dot = calls[0]?.dot ?? ''
      expect(dot).toContain('fillcolor=lightblue')
      expect(dot).toContain('"cpu" [label="处理 (100)", shape=box, fillcolor=lightyellow]')
      expect(calls[0]?.format).toBe('png')
      expect(calls[0]?.engine).toBe('neato')
      expect(calls[0]?.dot).toContain('fontname="Arial"')
      const value = (result as never as { value: { numeralMap: { numeral: string }[]; indexed: boolean; path: string } }).value
      expect(value.numeralMap).toEqual([
        { componentId: 'in', label: '输入', numeral: '200', figure: 2 },
        { componentId: 'cpu', label: '处理', numeral: '100', figure: 2 },
      ])
      expect(value.indexed).toBe(false)
      expect(value.path).toBe('figs/sys.png')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('输入校验：缺步骤/模板/超限 DOT 转为 invalid_tool_input', async () => {
    const dir = tempDir()
    const tool = createGeneratePatentFigureTool({ render: okRenderer(dir).render, outputDir: dir, cwd: dir })
    try {
      // 注册表执行会把抛错折成 isError 文本结果（不保留 code），所以错误码
      // 断言直接驱动 tool.execute，与 analyze/figure-tools 规格保持同一约定。
      await expect(tool.execute({ figure_type: 'flowchart' }, exec)).rejects.toMatchObject({
        name: 'PatentToolError', code: 'invalid_tool_input',
      })
      await expect(tool.execute({ figure_type: 'template' }, exec)).rejects.toMatchObject({
        code: 'invalid_tool_input',
      })
      await expect(tool.execute({ figure_type: 'raw_dot', dot: 'x'.repeat(200_001) }, exec)).rejects.toMatchObject({
        code: 'invalid_tool_input',
      })
      // raw_dot 必须自包含：文件引用属性会在 CLI 渲染路径上读取宿主文件（WASM 沙箱读不到）。
      await expect(tool.execute({ figure_type: 'raw_dot', dot: 'digraph { a [ image="/etc/passwd" ] }' }, exec)).rejects.toMatchObject({
        code: 'invalid_tool_input',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('numerals 接受数字标号，非标量值报字段级 invalid_tool_input', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    const tool = createGeneratePatentFigureTool({ render: okRenderer(outDir).render, outputDir: outDir, cwd: dir })
    try {
      await expect(tool.execute({
        figure_type: 'block_diagram',
        blocks: [{ id: 'cpu', label: '处理' }],
        numerals: { cpu: 100 },
        persist_index: false,
      }, exec)).resolves.toMatchObject({ numeralMap: [expect.objectContaining({ numeral: '100' })] })

      const rejected = {
        figure_type: 'block_diagram',
        blocks: [{ id: 'cpu', label: '处理' }],
        numerals: { cpu: ['100'] },
        persist_index: false,
      }
      await expect(tool.execute(rejected, exec)).rejects.toMatchObject({
        name: 'PatentToolError',
        code: 'invalid_tool_input',
      })
      // 错误消息点名具体字段，调用方据此定位是哪个 numerals 项不合法
      await expect(tool.execute(rejected, exec)).rejects.toThrow('顶层 numerals["cpu"]')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('渲染失败映射：not_installed→setup_required / 其它→tool_execution_failed / abort→tool_aborted', async () => {
    const dir = tempDir()
    const notInstalled = createGeneratePatentFigureTool({
      render: () => Promise.resolve({ ok: false, code: 'not_installed', error: '未找到 Graphviz，请 brew install graphviz' }),
      outputDir: dir,
      cwd: dir,
    })
    const failed = createGeneratePatentFigureTool({
      render: () => Promise.resolve({ ok: false, code: 'render_failed', error: '语法错误' }),
      outputDir: dir,
      cwd: dir,
    })
    const aborted = createGeneratePatentFigureTool({
      render: () => Promise.resolve({ ok: false, code: 'aborted', error: '取消' }),
      outputDir: dir,
      cwd: dir,
    })
    try {
      const blockInput = { figure_type: 'block_diagram', blocks: [{ id: 'a', label: 'A' }], connections: [] } as const
      await expect(notInstalled.execute(blockInput, exec)).rejects.toMatchObject({ code: 'setup_required' })
      await expect(failed.execute(blockInput, exec)).rejects.toMatchObject({ code: 'tool_execution_failed' })
      await expect(aborted.execute(blockInput, exec)).rejects.toMatchObject({ code: 'tool_aborted' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('upsertIndex 抛错时静默降级（indexed 标记不变）', async () => {
    const dir = tempDir()
    const tool = createGeneratePatentFigureTool({
      render: okRenderer(dir).render,
      outputDir: dir,
      cwd: dir,
      upsertIndex: () => Promise.reject(new Error('disk full')),
    })
    const ctx = await ctxWith(tool)
    try {
      const result = await execute(ctx, 'generate_patent_figure', { figure_type: 'block_diagram', blocks: [{ id: 'a', label: 'A' }], connections: [] }, 'e4')
      expect(result.isError).toBe(false)
      const value = (result as never as { value: { indexed: boolean } }).value
      expect(value.indexed).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('numeral_start/numeral_step 覆盖自动系列参数', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    const { render } = okRenderer(outDir)
    const tool = createGeneratePatentFigureTool({ render, outputDir: outDir, cwd: dir })
    const ctx = await ctxWith(tool)
    try {
      const result = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'block_diagram',
        blocks: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
        connections: [],
        numeral_start: 500,
        numeral_step: 4,
      }, 'ns1')
      expect(result.isError).toBe(false)
      const value = (valueOf(result) as { numeralMap: { numeral: string }[] })
      expect(value.numeralMap.map(m => m.numeral)).toEqual(['500', '504'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('flowchart 图型下 numeral_step 生效', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    const { render, calls } = okRenderer(outDir)
    const tool = createGeneratePatentFigureTool({ render, outputDir: outDir, cwd: dir })
    const ctx = await ctxWith(tool)
    try {
      const result = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'flowchart',
        steps: flowSteps,
        numeral_step: 10,
      }, 'fs1')
      expect(result.isError).toBe(false)
      expect(calls[0]?.dot).toContain('"start" [label="100. 开始", shape=ellipse];')
      expect(calls[0]?.dot).toContain('"s1" [label="110. 处理", shape=box];')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('无 cwd 注入时以 process.cwd 为基准', async () => {
    const dir = tempDir()
    const { render } = okRenderer(dir)
    const tool = createGeneratePatentFigureTool({ render, outputDir: dir })
    const ctx = await ctxWith(tool)
    try {
      const result = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'block_diagram',
        blocks: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
        connections: [{ from: 'a', to: 'b' }],
      }, 'ncwd1')
      expect(result.isError).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('显式标号冲突 / 缺 blocks / 未知图型均转 invalid_tool_input', async () => {
    const dir = tempDir()
    const tool = createGeneratePatentFigureTool({ render: okRenderer(dir).render, outputDir: dir, cwd: dir })
    const ctx = await ctxWith(tool)
    try {
      const conflict = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'block_diagram',
        blocks: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
        connections: [],
        numerals: { a: '100', b: '100' },
      }, 'e5')
      expect(conflict.isError).toBe(true)
      expect(text(conflict)).toContain('标号分配失败')
      const noBlocks = await execute(ctx, 'generate_patent_figure', { figure_type: 'block_diagram' }, 'e6')
      expect(noBlocks.isError).toBe(true)
      expect(text(noBlocks)).toContain('block_diagram 需要 blocks')
      const emptyTree = await execute(ctx, 'generate_patent_figure', { figure_type: 'component_hierarchy' }, 'e6b')
      expect(emptyTree.isError).toBe(true)
      expect(text(emptyTree)).toContain('component_hierarchy 需要 tree')
      const emptyDot = await execute(ctx, 'generate_patent_figure', { figure_type: 'raw_dot' }, 'e6c')
      expect(emptyDot.isError).toBe(true)
      expect(text(emptyDot)).toContain('raw_dot 需要 dot 内容')
      const unknown = await execute(ctx, 'generate_patent_figure', { figure_type: 'nonexistent' }, 'e7')
      expect(unknown.isError).toBe(true)
      // schema enum 在 execute 前拦截未知图型
      expect(text(unknown)).toContain('must be one of')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('层级图型下 numeral_step 生效', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    const { render, calls } = okRenderer(outDir)
    const tool = createGeneratePatentFigureTool({ render, outputDir: outDir, cwd: dir })
    const ctx = await ctxWith(tool)
    try {
      const result = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'component_hierarchy',
        tree: [{ id: 'a', label: 'A', children: [{ id: 'b', label: 'B' }] }],
        numeral_step: 10,
        leader_lines: false,
      }, 'hs1')
      expect(result.isError).toBe(false)
      expect(calls[0]?.dot).toContain('"a" [label="A (100)"];')
      expect(calls[0]?.dot).toContain('"b" [label="B (110)"];')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('结构化输入的元素上限：200 元素通过，超出转 invalid_tool_input 并指向 panels', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    const tool = createGeneratePatentFigureTool({ render: okRenderer(outDir).render, outputDir: outDir, cwd: dir })
    const ctx = await ctxWith(tool)
    const steps = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, label: `步骤 ${i + 1}`, next: [] as string[] }))
    // 上限以「节点 + 边」计：流程图每加一条 next 边就多一个元素。
    const chained = (n: number) => steps(n).map((step, index) => ({ ...step, next: index + 1 < n ? [`s${index + 1}`] : [] }))
    try {
      const atLimit = await execute(ctx, 'generate_patent_figure', { figure_type: 'flowchart', steps: chained(100) }, 'cap1')
      expect(atLimit.isError).toBe(false)
      await expect(tool.execute({ figure_type: 'flowchart', steps: chained(101) }, exec)).rejects.toThrow(/图元素过多/)
      // 层级树递归计入深层节点
      const nested = [{
        id: 'root',
        label: '根',
        children: Array.from({ length: 120 }, (_, i) => ({ id: `c${i}`, label: `子 ${i}`, children: [{ id: `g${i}`, label: `孙 ${i}` }] })),
      }]
      await expect(tool.execute({ figure_type: 'component_hierarchy', tree: nested }, exec)).rejects.toThrow(/图元素过多/)
      // 状态图按状态 + 转移计数
      await expect(tool.execute({
        figure_type: 'state_diagram',
        states: steps(120).map(step => ({ id: step.id, label: step.label })),
        transitions: Array.from({ length: 120 }, (_, i) => ({ from: `s${i}`, to: `s${(i + 1) % 120}` })),
      }, exec)).rejects.toThrow(/图元素过多/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('raw_dot 直通渲染并标注为 unknown 图型', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    const { render, calls } = okRenderer(outDir)
    const tool = createGeneratePatentFigureTool({ render, outputDir: outDir, cwd: dir })
    const ctx = await ctxWith(tool)
    try {
      const result = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'raw_dot',
        dot: 'digraph X { a -> b; }',
        filename: 'custom',
      }, 'raw1')
      expect(result.isError).toBe(false)
      const value = (valueOf(result) as { path: string; figureType: string; numeralMap: unknown[] })
      expect(value.path).toBe('figs/custom.svg')
      expect(value.figureType).toBe('unknown')
      expect(value.numeralMap).toEqual([])
      expect(calls[0]?.dot).toContain('digraph X')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('raw_dot 自包含检查只拦属性赋值：标签文本里的属性名照常渲染', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    const { render, calls } = okRenderer(outDir)
    const tool = createGeneratePatentFigureTool({ render, outputDir: outDir, cwd: dir })
    const ctx = await ctxWith(tool)
    try {
      const result = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'raw_dot',
        dot: 'digraph X { a [ label="image=输入图像" ]; a -> b; }',
        filename: 'custom',
      }, 'raw2')
      expect(result.isError).toBe(false)
      expect(calls[0]?.dot).toContain('label="image=输入图像"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('生成 → 索引 → search 检索全链路闭环', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    const indexPath = join(dir, 'figures-index.json')
    const { render } = okRenderer(outDir)
    const generate = createGeneratePatentFigureTool({
      render,
      outputDir: outDir,
      cwd: dir,
      upsertIndex: entry => figureIndexStore.upsert(indexPath, entry),
    })
    const search = createSearchPatentFigureTool({ loadIndex: () => figureIndexStore.load(indexPath) })
    const ctx = await ctxWith(generate, search)
    try {
      const gen = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'flowchart',
        steps: flowSteps,
        invention_name: '一种温控装置',
      }, 'chain1')
      expect(gen.isError).toBe(false)
      const hit = await execute(ctx, 'search_patent_figure', { query: '处理' }, 'chain2')
      expect(hit.isError).toBe(false)
      const value = (hit as never as {
        value: {
          query: string
          total: number
          indexedCount: number
          results: { figureNumber: number; figureDescription: string; components: unknown[] }[]
        }
      }).value
      expect(value.total).toBeGreaterThanOrEqual(1)
      expect(value.indexedCount).toBe(1)
      expect(value.results[0]?.figureNumber).toBe(1)
      expect(value.results[0]?.figureDescription).toContain('温控装置')
      expect(value.results[0]?.components.length).toBe(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('模板与层级图：模板名校验、层级先序标号', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    const { render, calls } = okRenderer(outDir)
    const tool = createGeneratePatentFigureTool({ render, outputDir: outDir, cwd: dir })
    const ctx = await ctxWith(tool)
    try {
      const tpl = await execute(ctx, 'generate_patent_figure', { figure_type: 'template', template: 'method_steps' }, 't1')
      expect(tpl.isError).toBe(false)
      expect(calls[0]?.dot).toContain('101. 接收输入数据')

      const hier = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'component_hierarchy',
        tree: [{ id: 'sys', label: '系统', children: [{ id: 'a', label: '组件A' }, { id: 'b', label: '组件B' }] }],
      }, 't2')
      const value = (valueOf(hier) as { numeralMap: { componentId: string; numeral: string }[]; figureType: string })
      expect(value.numeralMap).toEqual([
        { componentId: 'sys', label: '系统', numeral: '100', figure: 1 },
        { componentId: 'a', label: '组件A', numeral: '102', figure: 1 },
        { componentId: 'b', label: '组件B', numeral: '104', figure: 1 },
      ])
      expect(value.figureType).toBe('structure')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('add_patent_figure_references tool', () => {
  it('为既有 SVG 追加标号并输出 _annotated 文件', async () => {
    const dir = tempDir()
    const svg = join(dir, 'fig.svg')
    writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"><text>Input Sensor</text></svg>')
    const tool = createAddPatentFigureReferencesTool({ cwd: dir })
    const ctx = await ctxWith(tool)
    try {
      const result = await execute(ctx, 'add_patent_figure_references', {
        svg_path: 'fig.svg',
        references: [{ label: 'Input Sensor', numeral: '20' }, { label: 'Ghost', numeral: '30' }],
      }, 'a1')
      expect(result.isError).toBe(false)
      const value = (result as never as { value: { path: string; numReferences: number; warnings: string[] } }).value
      expect(value.path).toBe('fig_annotated.svg')
      expect(value.numReferences).toBe(2)
      expect(value.warnings).toEqual(['Ghost'])
      const out = join(dir, 'fig_annotated.svg')
      expect(readFileSync(out, 'utf8')).toContain('Input Sensor (20)')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('全部命中时无警告；未传 cwd 时用 process.cwd 基准', async () => {
    const dir = tempDir()
    const svg = join(dir, 'hit.svg')
    writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"><text>Sensor</text></svg>')
    const tool = createAddPatentFigureReferencesTool()
    const ctx = await ctxWith(tool)
    try {
      const result = await execute(ctx, 'add_patent_figure_references', {
        svg_path: svg, // 绝对路径在无 cwd 实例下仍可解析
        references: [{ label: 'Sensor', numeral: '10' }],
      }, 'a4')
      expect(result.isError).toBe(false)
      const value = (valueOf(result) as { warnings: string[] })
      expect(value.warnings).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('非 .svg 文件名同样生成 _annotated.svg 输出', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'fig.txt'), '<svg xmlns="http://www.w3.org/2000/svg"><text>Sensor</text></svg>')
    const tool = createAddPatentFigureReferencesTool({ cwd: dir })
    const ctx = await ctxWith(tool)
    try {
      const result = await execute(ctx, 'add_patent_figure_references', {
        svg_path: 'fig.txt',
        references: [{ label: 'Sensor', numeral: '10' }],
      }, 'a5')
      expect(result.isError).toBe(false)
      expect((valueOf(result) as { path: string }).path).toBe('fig.txt_annotated.svg')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('文件缺失与不安全 SVG 分别报 file_not_found / invalid_input', async () => {
    const dir = tempDir()
    const tool = createAddPatentFigureReferencesTool({ cwd: dir })
    try {
      await expect(tool.execute({ svg_path: 'nope.svg', references: [{ label: 'x', numeral: '1' }] }, exec))
        .rejects.toMatchObject({ name: 'PatentToolError', code: 'file_not_found' })
      writeFileSync(join(dir, 'bad.svg'), '<!ENTITY x "y"><svg></svg>')
      await expect(tool.execute({ svg_path: 'bad.svg', references: [{ label: 'x', numeral: '1' }] }, exec))
        .rejects.toMatchObject({ code: 'invalid_tool_input' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leader_lines:true 时改用引线模式（数字外置 + 引线），默认仍内嵌', async () => {
    const dir = tempDir()
    const svg = join(dir, 'graph.svg')
    writeFileSync(svg, [
      '<svg xmlns="http://www.w3.org/2000/svg">',
      '<g id="node1" class="node"><title>a</title><polygon points="10,10 10,50 110,50 110,10"/><text text-anchor="middle" x="60" y="34">Input Sensor</text></g>',
      '</svg>',
    ].join('\n'))
    const tool = createAddPatentFigureReferencesTool({ cwd: dir })
    const ctx = await ctxWith(tool)
    try {
      const leader = await execute(ctx, 'add_patent_figure_references', {
        svg_path: 'graph.svg',
        references: [{ label: 'Input Sensor', numeral: '20' }],
        leader_lines: true,
      }, 'a2')
      expect(leader.isError).toBe(false)
      const leaderOut = readFileSync(join(dir, 'graph_annotated.svg'), 'utf8')
      expect(leaderOut).toContain('<line ')
      expect(leaderOut).toContain('>20</text>')
      expect(leaderOut).toContain('>Input Sensor<')
      expect(leaderOut).not.toContain('(20)')
      expect((valueOf(leader) as { warnings: string[] }).warnings).toEqual([])

      const inline = await execute(ctx, 'add_patent_figure_references', {
        svg_path: 'graph.svg',
        references: [{ label: 'Input Sensor', numeral: '20' }],
      }, 'a3')
      expect(inline.isError).toBe(false)
      expect(readFileSync(join(dir, 'graph_annotated.svg'), 'utf8')).toContain('Input Sensor (20)')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('output_filename 越出图目录时拒绝，且不产生文件', async () => {
    const root = tempDir()
    const work = join(root, 'a', 'b')
    mkdirSync(work, { recursive: true })
    writeFileSync(join(work, 'fig.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><text>Sensor</text></svg>')
    const tool = createAddPatentFigureReferencesTool({ cwd: work })
    try {
      for (const output_filename of ['../../evil', 'a/b', '\\abs', '..', '', '  ']) {
        await expect(tool.execute({
          svg_path: 'fig.svg',
          references: [{ label: 'Sensor', numeral: '10' }],
          output_filename,
        }, exec)).rejects.toMatchObject({ name: 'PatentToolError', code: 'invalid_tool_input' })
      }
      // 两级上界落在本轮新建的 root 内：断言不会被其它运行留下的同名文件污染。
      expect(existsSync(join(root, 'evil.svg'))).toBe(false)
      expect(existsSync(join(work, 'evil.svg'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('中文输出名按原样使用（不做净化改名）', async () => {
    const dir = tempDir()
    writeFileSync(join(dir, 'fig.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><text>Sensor</text></svg>')
    const tool = createAddPatentFigureReferencesTool({ cwd: dir })
    try {
      await tool.execute({
        svg_path: 'fig.svg',
        references: [{ label: 'Sensor', numeral: '10' }],
        output_filename: '图1',
      }, exec)
      expect(existsSync(join(dir, '图1.svg'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('generate_patent_figure submission layout', () => {
  it('未配置页面参数时 DOT 不含布局属性（零回归）', async () => {
    const dir = tempDir()
    try {
      const { render, calls } = okRenderer(dir)
      const tool = createGeneratePatentFigureTool({ render, outputDir: dir, cwd: dir })
      await tool.execute({ figure_type: 'flowchart', steps: flowSteps, persist_index: false }, exec)
      const dot = calls[0]?.dot ?? ''
      expect(dot).not.toContain('page=')
      expect(dot).not.toContain('dpi=')
      expect(dot).not.toContain('orientation=')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('依赖默认值（Config 通路）写入 page/size/margin/dpi', async () => {
    const dir = tempDir()
    try {
      const { render, calls } = okRenderer(dir)
      const tool = createGeneratePatentFigureTool({
        render,
        outputDir: dir,
        cwd: dir,
        pageSize: 'a4',
        dpi: 300,
        marginCm: 2.5,
      })
      await tool.execute({ figure_type: 'flowchart', steps: flowSteps, persist_index: false }, exec)
      const dot = calls[0]?.dot ?? ''
      expect(dot).toContain('page="8.27,11.69";')
      expect(dot).toContain('size="6.3,9.72";')
      expect(dot).toContain('margin="0.98,0.98";')
      expect(dot).toContain('dpi=300;')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('per-call 覆盖逐项优先于依赖默认值', async () => {
    const dir = tempDir()
    try {
      const { render, calls } = okRenderer(dir)
      const tool = createGeneratePatentFigureTool({
        render,
        outputDir: dir,
        cwd: dir,
        pageSize: 'a4',
        dpi: 300,
        marginCm: 2.5,
        orientation: 'portrait',
      })
      await tool.execute({
        figure_type: 'flowchart',
        steps: flowSteps,
        persist_index: false,
        page_size: 'letter',
        dpi: 600,
        margin: 1.27,
        orient: 'landscape',
      }, exec)
      const dot = calls[0]?.dot ?? ''
      expect(dot).toContain('page="11,8.5";')
      expect(dot).toContain('orientation=landscape;')
      expect(dot).toContain('dpi=600;')
      expect(dot).toContain('margin="0.5,0.5";')
      expect(dot).not.toContain('dpi=300;')
      expect(dot).not.toContain('"8.27')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('per-call 部分覆盖：仅 orient 时页面尺寸沿用默认', async () => {
    const dir = tempDir()
    try {
      const { render, calls } = okRenderer(dir)
      const tool = createGeneratePatentFigureTool({ render, outputDir: dir, cwd: dir, pageSize: 'a4' })
      await tool.execute({ figure_type: 'block_diagram', blocks: [{ id: 'a', label: 'A' }], connections: [], orient: 'landscape', persist_index: false }, exec)
      const dot = calls[0]?.dot ?? ''
      expect(dot).toContain('page="11.69,8.27";')
      expect(dot).toContain('orientation=landscape;')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('非法 dpi 在工具层映射 invalid_tool_input', async () => {
    const dir = tempDir()
    try {
      const { render } = okRenderer(dir)
      const tool = createGeneratePatentFigureTool({ render, outputDir: dir, cwd: dir })
      await expect(tool.execute({ figure_type: 'flowchart', steps: flowSteps, dpi: -5, persist_index: false }, exec))
        .rejects.toMatchObject({ code: 'invalid_tool_input' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('generate_patent_figure leader lines', () => {
  const blockInput = {
    figure_type: 'block_diagram',
    blocks: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    connections: [{ from: 'a', to: 'b' }],
    persist_index: false,
  } as const

  /** fake renderer：SVG 输出带 Graphviz 节点组结构（title/polygon/ellipse/text），供引线解析。 */
  function graphSvgRenderer(): { render: (spec: GraphvizRenderSpec) => Promise<GraphvizRenderOutcome>; calls: GraphvizRenderSpec[] } {
    const calls: GraphvizRenderSpec[] = []
    return {
      calls,
      render: (spec) => {
        calls.push(spec)
        const out = join(spec.outputDir, `${spec.filename}.${spec.format}`)
        if (spec.format === 'svg') {
          writeFileSync(out, [
            '<svg xmlns="http://www.w3.org/2000/svg">',
            '<g id="node1" class="node"><title>a</title><polygon points="10,10 10,50 110,50 110,10"/><text text-anchor="middle" x="60" y="34">A</text></g>',
            '<g id="node2" class="node"><title>b</title><ellipse cx="60" cy="85" rx="45" ry="18"/><text text-anchor="middle" x="60" y="89">B</text></g>',
            '</svg>',
          ].join('\n'))
        } else {
          writeFileSync(out, 'png-bytes')
        }
        return Promise.resolve({ ok: true, path: out })
      },
    }
  }

  it('框图 SVG 默认改用引线标号：DOT 无内嵌标号，SVG 含 <line> 与图外数字', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    try {
      const { render, calls } = graphSvgRenderer()
      const tool = createGeneratePatentFigureTool({ render, outputDir: outDir, cwd: dir })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'generate_patent_figure', blockInput, 'll1')
      expect(result.isError).toBe(false)
      const dot = calls[0]?.dot ?? ''
      expect(dot).toContain('"a" [label="A", shape=box];')
      expect(dot).not.toContain('(100)')
      const svg = readFileSync(join(outDir, 'fig1.svg'), 'utf8')
      expect(svg).toContain('<line ')
      expect(svg).toContain('>100</text>')
      expect(svg).toContain('>A<')
      expect(svg).not.toContain('(100)')
      expect((valueOf(result) as { warnings: string[] }).warnings).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('流程图默认保持内嵌 NNN. 前缀且无引线', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    try {
      const { render, calls } = graphSvgRenderer()
      const tool = createGeneratePatentFigureTool({ render, outputDir: outDir, cwd: dir })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'flowchart',
        steps: flowSteps,
        persist_index: false,
      }, 'll2')
      expect(result.isError).toBe(false)
      expect(calls[0]?.dot).toContain('"start" [label="100. 开始", shape=ellipse];')
      expect(readFileSync(join(outDir, 'fig1.svg'), 'utf8')).not.toContain('<line ')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leader_lines:false 显式关闭框图引线，恢复内嵌标号', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    try {
      const { render, calls } = graphSvgRenderer()
      const tool = createGeneratePatentFigureTool({ render, outputDir: outDir, cwd: dir })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'generate_patent_figure', { ...blockInput, leader_lines: false }, 'll3')
      expect(result.isError).toBe(false)
      expect(calls[0]?.dot).toContain('"a" [label="A (100)", shape=box];')
      expect(readFileSync(join(outDir, 'fig1.svg'), 'utf8')).not.toContain('<line ')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('流程图显式 leader_lines:true 时去除前缀并画引线', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    try {
      const { render, calls } = graphSvgRenderer()
      const tool = createGeneratePatentFigureTool({ render, outputDir: outDir, cwd: dir })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'flowchart',
        steps: [
          { id: 'start', label: 'A', shape: 'ellipse' as const, next: ['s1'] },
          { id: 's1', label: 'B', next: [] },
        ],
        leader_lines: true,
        persist_index: false,
      }, 'll4')
      expect(result.isError).toBe(false)
      expect(calls[0]?.dot).toContain('"start" [label="A", shape=ellipse];')
      expect(calls[0]?.dot).not.toContain('100. ')
      expect(readFileSync(join(outDir, 'fig1.svg'), 'utf8')).toContain('<line ')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('非 SVG 格式请求引线时返回警告且照常产出工件', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    try {
      const { render } = graphSvgRenderer()
      const tool = createGeneratePatentFigureTool({ render, outputDir: outDir, cwd: dir })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'generate_patent_figure', { ...blockInput, format: 'png', leader_lines: true }, 'll5')
      expect(result.isError).toBe(false)
      const value = (valueOf(result) as { path: string; warnings: string[] })
      expect(value.warnings).toEqual(['引线标号仅支持 SVG 矢量输出；本次 png 保持内嵌标号'])
      expect(value.path).toBe('figs/fig1.png')
      expect(readFileSync(join(outDir, 'fig1.png'), 'utf8')).toBe('png-bytes')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('图面用语检查：注释词语、非中文词语与非数字标号各出一条警告，合规输入无警告', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    try {
      const { render } = graphSvgRenderer()
      const tool = createGeneratePatentFigureTool({ render, outputDir: outDir, cwd: dir })
      const ctx = await ctxWith(tool)
      const flagged = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'block_diagram',
        blocks: [{ id: 'a', label: '注：温度传感器' }, { id: 'b', label: 'Controller' }],
        connections: [],
        numerals: { b: 'S101' },
        leader_lines: false,
        persist_index: false,
      }, 'w1')
      expect(flagged.isError).toBe(false)
      expect((valueOf(flagged) as { warnings: string[] }).warnings).toEqual([
        expect.stringContaining('"注：温度传感器" 疑似非必需注释'),
        expect.stringContaining('"Controller" 应当使用中文'),
        expect.stringContaining('"S101" 应当使用阿拉伯数字'),
      ])

      const rawDot = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'raw_dot',
        dot: 'digraph G { a [label="如图1所示"]; }',
        leader_lines: false,
        persist_index: false,
      }, 'w2')
      expect((valueOf(rawDot) as { warnings: string[] }).warnings).toEqual([
        expect.stringContaining('"如图1所示" 疑似非必需注释（正文引用）'),
      ])

      const clean = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'block_diagram',
        blocks: [{ id: 'a', label: '温度传感器' }],
        connections: [],
        leader_lines: false,
        persist_index: false,
      }, 'w3')
      expect((valueOf(clean) as { warnings: string[] }).warnings).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('标注工具对非阿拉伯数字标号给出警告', async () => {
    const dir = tempDir()
    try {
      const svgPath = join(dir, 'graph.svg')
      writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"><text>Input Sensor</text></svg>')
      const tool = createAddPatentFigureReferencesTool({ cwd: dir })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'add_patent_figure_references', {
        svg_path: 'graph.svg',
        references: [{ label: 'Input Sensor', numeral: 'S101' }],
      }, 'w4')
      expect(result.isError).toBe(false)
      expect((valueOf(result) as { warnings: string[] }).warnings).toEqual([
        expect.stringContaining('"S101" 应当使用阿拉伯数字'),
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('标注校验被拒时降级为警告（不吞掉渲染产物）', async () => {
    const dir = tempDir()
    try {
      const render = (spec: GraphvizRenderSpec) => {
        const out = join(spec.outputDir, `${spec.filename}.${spec.format}`)
        writeFileSync(out, '<!ENTITY x "y"><svg></svg>')
        return Promise.resolve({ ok: true, path: out } as const)
      }
      const tool = createGeneratePatentFigureTool({ render, outputDir: dir, cwd: dir })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'block_diagram',
        blocks: [{ id: 'a', label: 'A' }],
        connections: [],
        leader_lines: true,
        persist_index: false,
      }, 'll6')
      expect(result.isError).toBe(false)
      expect((valueOf(result) as { warnings: string[] }).warnings).toEqual([
        '引线标注被跳过：SVG 包含 ENTITY/CDATA 等不安全结构，拒绝处理',
        '渲染复核被跳过：SVG 包含 ENTITY/CDATA 等不安全结构，拒绝处理',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('渲染产物缺失（无法读回标注）时保持 loud 失败', async () => {
    const dir = tempDir()
    try {
      const render = (spec: GraphvizRenderSpec) =>
        Promise.resolve({ ok: true, path: join(spec.outputDir, `${spec.filename}.${spec.format}`) } as const)
      const tool = createGeneratePatentFigureTool({ render, outputDir: dir, cwd: dir })
      await expect(tool.execute({ ...blockInput, leader_lines: true }, exec)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('generate_patent_figure figure type inference', () => {
  it('从唯一结构输入推断图型（steps/blocks/tree/dot/template）', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    const tool = createGeneratePatentFigureTool({ render: okRenderer(outDir).render, outputDir: outDir, cwd: dir })
    const ctx = await ctxWith(tool)
    try {
      const cases = [
        [{ steps: flowSteps }, 'flowchart'],
        [{ blocks: [{ id: 'a', label: 'A' }] }, 'block_diagram'],
        [{ tree: [{ id: 'root', label: '根' }] }, 'structure'],
        [{ dot: 'digraph { a -> b }' }, 'unknown'],
        [{ template: 'simple_flowchart' }, 'schematic'],
      ] as const
      for (const [index, [args, expected]] of cases.entries()) {
        const result = await execute(ctx, 'generate_patent_figure', args, `infer-${index}`)
        expect(result.isError).toBe(false)
        expect((valueOf(result) as { figureType: string }).figureType).toBe(expected)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('多结构输入或无输入且缺省 figure_type 时报 invalid_tool_input', async () => {
    const dir = tempDir()
    const tool = createGeneratePatentFigureTool({ render: okRenderer(dir).render, outputDir: dir, cwd: dir })
    try {
      await expect(tool.execute({ steps: flowSteps, blocks: [{ id: 'a', label: 'A' }] }, exec)).rejects.toThrow('请显式传入 figure_type')
      await expect(tool.execute({}, exec)).rejects.toThrow('请显式传入 figure_type')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('generate_patent_figure panels', () => {
  const twoPanels = {
    panels: [
      { suffix: 'A', blocks: [{ id: 'sensor', label: '温度传感器' }, { id: 'controller', label: '控制器' }] },
      { suffix: 'B', blocks: [{ id: 'alarm', label: '报警器' }] },
    ],
    invention_name: '一种监控系统',
  }

  it('两面板共享连续标号系列并写 fig1A/fig1B', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    const { render, calls } = okRenderer(outDir)
    const tool = createGeneratePatentFigureTool({ render, outputDir: outDir, cwd: dir })
    const ctx = await ctxWith(tool)
    try {
      const result = await execute(ctx, 'generate_patent_figure', twoPanels, 'panels-1')
      expect(result.isError).toBe(false)
      const value = valueOf(result) as {
        path: string
        panels: { suffix: string; path: string }[]
        numeralMap: { numeral: string; label: string }[]
        figureDescription: string
      }
      expect(value.panels.map(p => p.path)).toEqual(['figs/fig1A.svg', 'figs/fig1B.svg'])
      expect(value.path).toBe('figs/fig1A.svg')
      const numeralByLabel = Object.fromEntries(value.numeralMap.map(m => [m.label, m.numeral]))
      expect(numeralByLabel['温度传感器']).toBe('100')
      expect(numeralByLabel['控制器']).toBe('102')
      expect(numeralByLabel['报警器']).toBe('104')
      expect(new Set(value.numeralMap.map(m => m.numeral)).size).toBe(value.numeralMap.length)
      expect(value.figureDescription).toContain('图1A是')
      expect(value.figureDescription).toContain('图1B是')
      expect(value.figureDescription).toContain('图中：100-温度传感器，102-控制器，104-报警器。')
      expect(existsSync(join(outDir, 'fig1A.svg'))).toBe(true)
      expect(existsSync(join(outDir, 'fig1B.svg'))).toBe(true)
      expect(calls.map(c => c.filename)).toEqual(['fig1A', 'fig1B'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('panels 与顶层结构输入/空列表/非法后缀/filename/歧义面板图型均拒绝', async () => {
    const dir = tempDir()
    const tool = createGeneratePatentFigureTool({ render: okRenderer(dir).render, outputDir: dir, cwd: dir })
    try {
      await expect(tool.execute({ ...twoPanels, steps: flowSteps }, exec)).rejects.toThrow('顶层结构输入')
      await expect(tool.execute({
        ...twoPanels,
        circuit: { components: [], connections: [] },
      }, exec)).rejects.toThrow('顶层结构输入')
      await expect(tool.execute({ panels: [] }, exec)).rejects.toThrow('不能为空列表')
      await expect(tool.execute({ panels: [{ suffix: '../x', blocks: [{ id: 'a', label: 'A' }] }] }, exec)).rejects.toThrow('面板后缀')
      await expect(tool.execute({
        panels: [
          { suffix: 'A', blocks: [{ id: 'a', label: 'A' }] },
          { suffix: 'A', blocks: [{ id: 'b', label: 'B' }] },
        ],
      }, exec)).rejects.toThrow('面板后缀重复')
      await expect(tool.execute({ ...twoPanels, filename: 'custom' }, exec)).rejects.toThrow('filename')
      await expect(tool.execute({
        panels: [{ suffix: 'A', steps: flowSteps, blocks: [{ id: 'a', label: 'A' }] }],
      }, exec)).rejects.toThrow('面板 A')
      // 两个面板给不同组件同一个显式标号：与单图路径同一条分配与报错路径。
      await expect(tool.execute({
        panels: [
          { suffix: 'A', blocks: [{ id: 'a', label: 'A' }], numerals: { a: '100' } },
          { suffix: 'B', blocks: [{ id: 'b', label: 'B' }], numerals: { b: '100' } },
        ],
      }, exec)).rejects.toThrow('标号分配失败')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('generate_patent_figure figure family continuation', () => {
  const blocksOf = (...ids: { id: string; label: string }[]) => ({
    figure_type: 'block_diagram' as const,
    leader_lines: false,
    blocks: ids,
  })

  function familyTool(dir: string, outDir: string, entries: FigureIndexEntry[]) {
    const { render } = okRenderer(outDir)
    return createGeneratePatentFigureTool({
      render,
      outputDir: outDir,
      cwd: dir,
      upsertIndex: async entry => void entries.push(entry),
      loadIndex: () => Promise.resolve([...entries]),
    })
  }

  function numeralOf(value: unknown, label: string): string {
    const map = (value as { numeralMap: { numeral: string; label: string }[] }).numeralMap
    const match = map.find(m => m.label === label)
    expect(match, `组件 ${label} 应在标号表中`).toBeDefined()
    return match?.numeral ?? ''
  }

  it('声明家族后同名组件沿用标号、新组件续接空闲号', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    const entries: FigureIndexEntry[] = []
    const tool = familyTool(dir, outDir, entries)
    const ctx = await ctxWith(tool)
    try {
      const gen1 = await execute(ctx, 'generate_patent_figure', {
        ...blocksOf({ id: 'sensor', label: '温度传感器' }, { id: 'controller', label: '控制器' }),
        figure_family: 'acme',
      }, 'fam-1')
      expect(gen1.isError).toBe(false)
      const v1 = valueOf(gen1) as { numeralMap: unknown[] }
      expect(numeralOf(v1, '温度传感器')).toBe('100')
      expect(numeralOf(v1, '控制器')).toBe('102')
      expect(entries[0]?.analysis.figureFamily).toBe('acme')

      const gen2 = await execute(ctx, 'generate_patent_figure', {
        ...blocksOf({ id: 'controller', label: '控制器' }, { id: 'alarm', label: '报警器' }),
        figure_number: 2,
        figure_family: 'acme',
      }, 'fam-2')
      expect(gen2.isError).toBe(false)
      const v2 = valueOf(gen2) as { numeralMap: unknown[] }
      // 同名组件沿用既有标号；新组件取本图系列起点（200），不与家族保留号（100）冲突。
      expect(numeralOf(v2, '控制器')).toBe('102')
      expect(numeralOf(v2, '报警器')).toBe('200')
      expect(entries[1]?.analysis.figureFamily).toBe('acme')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('未声明家族时全新编号，旧索引不生效', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    const entries: FigureIndexEntry[] = []
    const tool = familyTool(dir, outDir, entries)
    const ctx = await ctxWith(tool)
    try {
      const gen1 = await execute(ctx, 'generate_patent_figure', {
        ...blocksOf({ id: 'sensor', label: '温度传感器' }),
        figure_family: 'acme',
      }, 'fam-3')
      expect(gen1.isError).toBe(false)
      const gen2 = await execute(ctx, 'generate_patent_figure', {
        ...blocksOf({ id: 'sensor', label: '温度传感器' }),
      }, 'fam-4')
      expect(gen2.isError).toBe(false)
      // 第二次调用未声明家族：即使索引里已有同名组件，也按本图系列全新编号。
      expect(numeralOf(valueOf(gen2), '温度传感器')).toBe('100')
      expect(entries[1]?.analysis.figureFamily).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('旧索引条目（无 figureFamily）不参与续号也不报错', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    const legacy: FigureIndexEntry = {
      imagePath: 'figs/fig1.svg',
      analyzedAt: '2024-01-01T00:00:00.000Z',
      analysis: {
        imagePath: 'figs/fig1.svg',
        figureNumber: 1,
        figureType: 'block_diagram',
        overallDescription: '整体结构',
        components: [{ refNumber: '100', name: '温度传感器', kind: 'sensor', description: '测温' }],
        connections: [],
        figureDescription: '图1是本发明实施例提供的装置的方框图；图中：100-温度传感器。',
        confidence: 1,
        warnings: [],
        usable: true,
        modelUsed: 'm',
      },
    }
    const tool = createGeneratePatentFigureTool({
      render: okRenderer(outDir).render,
      outputDir: outDir,
      cwd: dir,
      loadIndex: () => Promise.resolve([legacy]),
    })
    const ctx = await ctxWith(tool)
    try {
      const result = await execute(ctx, 'generate_patent_figure', {
        ...blocksOf({ id: 'sensor', label: '温度传感器' }),
        figure_family: 'acme',
      }, 'fam-5')
      expect(result.isError).toBe(false)
      // 旧条目属于「无家族」：即使组件同名也不沿用，按本图系列全新编号。
      expect(numeralOf(valueOf(result), '温度传感器')).toBe('100')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('声明 figure_family 而宿主未注入 loadIndex 时报 invalid_tool_input', async () => {
    const dir = tempDir()
    const tool = createGeneratePatentFigureTool({ render: okRenderer(dir).render, outputDir: dir, cwd: dir })
    try {
      await expect(tool.execute({
        ...blocksOf({ id: 'sensor', label: '温度传感器' }),
        figure_family: 'acme',
      }, exec)).rejects.toThrow('loadIndex')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('generate_patent_figure 文字转路径', () => {
  /** 带画布尺寸的渲染产物：落版要能解析 width/height 才会改写文件。 */
  const sized = (spec: GraphvizRenderSpec): Promise<GraphvizRenderOutcome> => {
    const out = join(spec.outputDir, `${spec.filename}.${spec.format}`)
    writeFileSync(out, '<svg width="400pt" height="500pt" viewBox="0 0 400 500" xmlns="http://www.w3.org/2000/svg">'
      + '<g stroke="#000000" stroke-width="0.35"><line x1="1" y1="1" x2="9" y2="9"/><text x="1" y="2" font-size="10">开始</text></g></svg>')
    return Promise.resolve({ ok: true, path: out })
  }

  it('注入转换端口后在落版之后就地改写文件', async () => {
    const dir = tempDir()
    const seen: { path: string; content: string }[] = []
    const tool = createGeneratePatentFigureTool({
      render: sized,
      outlineText: async (spec) => {
        seen.push({ path: spec.path, content: readFileSync(spec.path, 'utf8') })
        writeFileSync(spec.path, '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>', 'utf8')
        return { ok: true }
      },
      outputDir: dir,
      cwd: dir,
    })
    try {
      const result = await tool.execute({ figure_type: 'flowchart', steps: flowSteps, target_office: 'cnipa' }, exec)
      const value = result as { path: string; absolutePath: string; warnings: string[] }
      // 转换看到的是已落版的页面（A4 幅面），说明这一步排在落版之后。
      expect(seen).toHaveLength(1)
      expect(seen[0]?.path).toBe(value.absolutePath)
      expect(seen[0]?.content).toContain('width="210mm" height="297mm"')
      expect(readFileSync(value.absolutePath, 'utf8')).toContain('<path d="M0 0h1v1z"/>')
      expect(value.warnings.join('\n')).not.toContain('文字转路径')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('非 SVG 输出时给出「仅对 SVG 生效」警告且不调用转换', async () => {
    const dir = tempDir()
    let calls = 0
    const tool = createGeneratePatentFigureTool({
      render: sized,
      outlineText: async () => {
        calls += 1
        return { ok: true }
      },
      outputDir: dir,
      cwd: dir,
    })
    try {
      const result = await tool.execute({ figure_type: 'flowchart', steps: flowSteps, format: 'png' }, exec)
      expect(calls).toBe(0)
      expect((result as { warnings: string[] }).warnings.join('\n'))
        .toContain('文字转路径（Config.figureTextToPath）仅对 SVG 输出生效')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('转换失败按渲染失败的同一张表映射：not_installed → setup_required', async () => {
    const dir = tempDir()
    const tool = createGeneratePatentFigureTool({
      render: sized,
      outlineText: () => Promise.resolve({ ok: false, code: 'not_installed', error: '未找到 Inkscape 可执行文件。' }),
      outputDir: dir,
      cwd: dir,
    })
    try {
      await expect(tool.execute({ figure_type: 'flowchart', steps: flowSteps }, exec)).rejects.toMatchObject({
        code: 'setup_required',
        message: '未找到 Inkscape 可执行文件。',
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('模板落版时把页面参数与引线开关一并交给模板构建器', async () => {
    const dir = tempDir()
    const calls: GraphvizRenderSpec[] = []
    const render = (spec: GraphvizRenderSpec): Promise<GraphvizRenderOutcome> => {
      calls.push(spec)
      const out = join(spec.outputDir, `${spec.filename}.${spec.format}`)
      writeFileSync(out, '<svg width="400pt" height="500pt" viewBox="0 0 400 500" xmlns="http://www.w3.org/2000/svg"><text font-size="10">A</text></svg>')
      return Promise.resolve({ ok: true, path: out })
    }
    const tool = createGeneratePatentFigureTool({ render, outputDir: dir, cwd: dir })
    try {
      const result = await tool.execute({
        figure_type: 'template',
        template: 'method_steps',
        target_office: 'cnipa',
        page_size: 'a4',
        leader_lines: true,
        persist_index: false,
      }, exec)
      expect((result as { layout?: { office: string } }).layout?.office).toBe('cnipa')
      expect(calls).toHaveLength(1)
      expect(calls[0]?.format).toBe('svg')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('generate_patent_figure：部署图面字号（小四／四号）', () => {
  it('配置图面字号时 DOT 的 node/edge fontsize 按毫米换算出 pt', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    const { render, calls } = okRenderer(outDir)
    const tool = createGeneratePatentFigureTool({ render, outputDir: outDir, cwd: dir, figureFontMm: 4.25 })
    const ctx = await ctxWith(tool)
    try {
      const result = await execute(ctx, 'generate_patent_figure', { figure_type: 'flowchart', steps: flowSteps }, 'fontpt')
      expect(result.isError).toBe(false)
      // 4.25 毫米 = 12.05pt（小四 = 12pt）；node 与 edge 同用部署值。
      expect(calls[0]?.dot).toContain('fontsize=12.05')
      expect(calls[0]?.dot).not.toContain('fontsize=10')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('未配置时保持历史默认（node 10／edge 9）', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    const { render, calls } = okRenderer(outDir)
    const tool = createGeneratePatentFigureTool({ render, outputDir: outDir, cwd: dir })
    const ctx = await ctxWith(tool)
    try {
      await execute(ctx, 'generate_patent_figure', { figure_type: 'flowchart', steps: flowSteps }, 'fontdef')
      expect(calls[0]?.dot).toContain('fontsize=10')
      expect(calls[0]?.dot).toContain('fontsize=9')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('剖视图的图面字号取部署默认，模型显式给的字号优先', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    const { render } = okRenderer(outDir)
    const tool = createGeneratePatentFigureTool({ render, outputDir: outDir, cwd: dir, figureFontMm: 4.25 })
    const ctx = await ctxWith(tool)
    const sections = {
      parts: [{ outline: [[0, 0], [40, 0], [40, 20], [0, 20]], hatch: { angle_deg: 45, spacing_mm: 3 } }],
      labels: [{ text: '1', at: [44, 10], from: [40, 10] }],
    }
    try {
      await execute(ctx, 'generate_patent_figure', { figure_type: 'cross_section', sections }, 'fontsec')
      expect(readFileSync(join(outDir, 'fig1.svg'), 'utf8')).toContain('font-size="4.25"')
      await execute(ctx, 'generate_patent_figure', {
        figure_type: 'cross_section',
        sections: { ...sections, label_font_size_mm: 5 },
      }, 'fontsec2')
      expect(readFileSync(join(outDir, 'fig1.svg'), 'utf8')).toContain('font-size="5"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('generate_patent_figure：面板与非 SVG 全链', () => {
  const SIZED_SVG = '<svg width="400pt" height="500pt" viewBox="0 0 400 500" xmlns="http://www.w3.org/2000/svg">'
    + '<g stroke="#000000" stroke-width="0.35"><line x1="1" y1="1" x2="9" y2="9"/><text x="1" y="2" font-size="10">开始</text></g></svg>'

  /** 写带画布尺寸的 SVG（落版可解析），并记录渲染规格。 */
  function sizedRenderer(): { render: (spec: GraphvizRenderSpec) => Promise<GraphvizRenderOutcome>; calls: GraphvizRenderSpec[] } {
    const calls: GraphvizRenderSpec[] = []
    return {
      calls,
      render: (spec) => {
        calls.push(spec)
        const out = join(spec.outputDir, `${spec.filename}.${spec.format}`)
        writeFileSync(out, SIZED_SVG)
        return Promise.resolve({ ok: true, path: out })
      },
    }
  }

  /** 假导出端口：成功时写出目标文件。 */
  function exportPort(result: { ok: true } | { ok: false; code: 'not_installed' | 'render_failed'; error: string }) {
    const calls: { path: string; outcomePath: string; format: string; dpi?: number }[] = []
    return {
      calls,
      exportFigure: async (spec: { path: string; outcomePath: string; format: string; dpi?: number }) => {
        calls.push(spec)
        if (result.ok) writeFileSync(spec.outcomePath, 'EXPORTED', 'utf8')
        return result
      },
    }
  }

  const panels = [
    { suffix: 'A', figure_type: 'flowchart', steps: flowSteps },
    { suffix: 'B', figure_type: 'block_diagram', blocks: [{ id: 'x', label: '块' }], connections: [] },
  ]

  it('面板非 SVG + 落版：走全链导出，并写索引', async () => {
    const dir = tempDir()
    const { render } = sizedRenderer()
    const { exportFigure, calls } = exportPort({ ok: true })
    const upserted: FigureIndexEntry[] = []
    const tool = createGeneratePatentFigureTool({
      render,
      outputDir: dir,
      cwd: dir,
      exportFigure,
      dpi: 300,
      upsertIndex: async entry => void upserted.push(entry),
    })
    try {
      const value = await tool.execute({
        panels,
        figure_number: 1,
        target_office: 'cnipa',
        figure_count: 2,
        format: 'png',
        dpi: 150,
      }, exec) as { indexed: boolean; path: string; warnings: string[]; panels: { path: string }[] }
      expect(value.path).toBe('fig1A.png')
      expect(value.panels.map(panel => panel.path)).toEqual(['fig1A.png', 'fig1B.png'])
      expect(value.indexed).toBe(true)
      expect(upserted).toHaveLength(2)
      expect(calls.map(call => call.dpi)).toEqual([150, 150])
      expect(calls[0]?.format).toBe('png')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('面板全链导出失败：退回渲染器直出并记录索引失败', async () => {
    const dir = tempDir()
    const { render } = sizedRenderer()
    const { exportFigure } = exportPort({ ok: false, code: 'render_failed', error: '导出失败' })
    const tool = createGeneratePatentFigureTool({
      render,
      outputDir: dir,
      cwd: dir,
      exportFigure,
      dpi: 200,
      upsertIndex: async () => { throw new Error('index down') },
    })
    try {
      const value = await tool.execute({
        panels,
        target_office: 'cnipa',
        format: 'png',
      }, exec) as { indexed: boolean; path: string; warnings: string[] }
      expect(value.path).toBe('fig1A.png')
      expect(value.indexed).toBe(false)
      expect(value.warnings.join('\n')).toContain('附图索引写入失败')
      // 回退产物来自渲染器直接出图。
      expect(readFileSync(join(dir, 'fig1A.png'), 'utf8')).toBe(SIZED_SVG)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('面板引线在非 SVG 输出时给出警告', async () => {
    const dir = tempDir()
    const { render } = sizedRenderer()
    const tool = createGeneratePatentFigureTool({ render, outputDir: dir, cwd: dir })
    try {
      const value = await tool.execute({
        panels: [{ suffix: 'A', figure_type: 'block_diagram', blocks: [{ id: 'x', label: '块' }] }],
        format: 'png',
      }, exec) as { warnings: string[] }
      expect(value.warnings.join('\n')).toContain('引线标号仅支持 SVG 矢量输出')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('无组件的模板面板不写「图中」标号表', async () => {
    const dir = tempDir()
    const { render } = sizedRenderer()
    const tool = createGeneratePatentFigureTool({ render, outputDir: dir, cwd: dir })
    try {
      const value = await tool.execute({
        panels: [{ suffix: 'A', figure_type: 'template', template: 'method_steps' }],
        format: 'svg',
      }, exec) as { figureDescription: string; numeralMap: unknown[] }
      expect(value.numeralMap).toEqual([])
      expect(value.figureDescription).not.toContain('图中：')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('直绘图型非 SVG 导出成功但无落版时 layout 缺省', async () => {
    const dir = tempDir()
    const { render } = sizedRenderer()
    const { exportFigure } = exportPort({ ok: true })
    const tool = createGeneratePatentFigureTool({ render, outputDir: dir, cwd: dir, exportFigure })
    try {
      const value = await tool.execute({
        figure_type: 'circuit',
        circuit: {
          components: [
            { id: 'v1', kind: 'voltage_source', label: '电源', col: 0, row: 0 },
            { id: 'r1', kind: 'resistor', label: '电阻', col: 1, row: 0 },
          ],
          connections: [{ from: 'v1', to: 'r1' }],
        },
        format: 'png',
      }, exec) as { layout?: unknown; path: string }
      expect(value.path).toBe('fig1.png')
      expect(value.layout).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('直绘图型导出以非 not_installed 码失败时报 tool_execution_failed', async () => {
    const dir = tempDir()
    const { render } = sizedRenderer()
    const { exportFigure } = exportPort({ ok: false, code: 'render_failed', error: '导出失败' })
    const tool = createGeneratePatentFigureTool({ render, outputDir: dir, cwd: dir, exportFigure })
    try {
      await expect(tool.execute({
        figure_type: 'circuit',
        circuit: {
          components: [{ id: 'r1', kind: 'resistor', label: '电阻', col: 0, row: 0 }],
          connections: [],
        },
        format: 'png',
      }, exec)).rejects.toMatchObject({ code: 'tool_execution_failed' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('流程图显式引线在全链回退时按直绘图型处理', async () => {
    const dir = tempDir()
    const { render, calls } = sizedRenderer()
    const { exportFigure } = exportPort({ ok: false, code: 'render_failed', error: '导出失败' })
    const tool = createGeneratePatentFigureTool({ render, outputDir: dir, cwd: dir, exportFigure })
    try {
      const value = await tool.execute({
        figure_type: 'flowchart',
        steps: flowSteps,
        leader_lines: true,
        target_office: 'cnipa',
        figure_count: 2,
        format: 'png',
      }, exec) as { path: string; warnings: string[] }
      expect(value.path).toBe('fig1.png')
      // 中间 SVG 的 DOT 已按引线模式关闭内嵌标号；回退直出仍沿用同一份 DOT。
      expect(calls[0]?.dot).not.toContain('"start" [label="100. 开始"')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('渲染复核门禁（strict）', () => {
  /** 跨组线穿过文字：真实缺陷（同组豁免不覆盖）。 */
  const CROSSED_SVG = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="120mm" height="40mm" viewBox="0 0 120 40">',
    '  <g fill="none" stroke="#000000">',
    '    <g class="node"><polygon points="10,10 40,10 40,30 10,30"/></g>',
    '    <line x1="60" y1="5" x2="60" y2="35" stroke-width="0.25"/>',
    '    <text x="60" y="22" text-anchor="middle">条件</text>',
    '  </g>',
    '</svg>',
  ].join('\n')

  /** 写死 SVG 内容的渲染器替身（raw_dot 不需要结构输入，适合直接喂缺陷图）。 */
  function fixedRenderer(svg: string) {
    return (spec: GraphvizRenderSpec): Promise<GraphvizRenderOutcome> => {
      const out = join(spec.outputDir, `${spec.filename}.${spec.format}`)
      writeFileSync(out, spec.format === 'svg' ? svg : 'png-bytes')
      return Promise.resolve({ ok: true, path: out })
    }
  }

  function resultText(result: unknown): string {
    return (result as { content: { type: string; text?: string }[] }).content
      .filter(block => block.type === 'text')
      .map(block => block.text ?? '')
      .join('')
  }

  it('strict 命中阻断级发现时抛错，文件保留但不作为交付件', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    try {
      const tool = createGeneratePatentFigureTool({
        render: fixedRenderer(CROSSED_SVG),
        outputDir: outDir,
        cwd: dir,
        failOnRenderFindings: true,
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'raw_dot',
        dot: 'digraph G { a; }',
        persist_index: false,
      }, 'strict1')
      expect(result.isError).toBe(true)
      const text = resultText(result)
      expect(text).toContain('渲染复核未通过')
      expect(text).toContain('图面文字「条件」被线条贯穿')
      expect(text).toContain(join(outDir, 'fig1.svg'))
      expect(existsSync(join(outDir, 'fig1.svg'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('版面利用率下限开启时只报提示级发现，strict 仍放行', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    // 干净图但内容只占画布一角：撑不满纸面不是画错。
    const sparse = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="120mm" height="40mm" viewBox="0 0 120 40">',
      '  <g fill="none" stroke="#000000"><rect x="10" y="10" width="5" height="5" stroke-width="0.35"/></g>',
      '</svg>',
    ].join('\n')
    try {
      const tool = createGeneratePatentFigureTool({
        render: fixedRenderer(sparse),
        outputDir: outDir,
        cwd: dir,
        minSheetFillRatio: 0.9,
        failOnRenderFindings: true,
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'raw_dot',
        dot: 'digraph G { a; }',
        persist_index: false,
      }, 'sheet1')
      expect(result.isError).toBe(false)
      const warnings = (valueOf(result) as { warnings: string[] }).warnings
      expect(warnings.some(warning => warning.includes('撑不满纸面'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('默认模式只把发现折成警告，不阻断', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    try {
      const tool = createGeneratePatentFigureTool({
        render: fixedRenderer(CROSSED_SVG),
        outputDir: outDir,
        cwd: dir,
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'raw_dot',
        dot: 'digraph G { a; }',
        persist_index: false,
      }, 'strict2')
      expect(result.isError).toBe(false)
      const warnings = (valueOf(result) as { warnings: string[] }).warnings
      expect(warnings.some(warning => warning.includes('渲染复核：图面文字「条件」被线条贯穿'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('非 SVG 直绘通路没有可量测的图面，strict 不生效并给出警告', async () => {
    const dir = tempDir()
    const outDir = join(dir, 'figs')
    try {
      const tool = createGeneratePatentFigureTool({
        render: fixedRenderer(CROSSED_SVG),
        outputDir: outDir,
        cwd: dir,
        failOnRenderFindings: true,
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'flowchart',
        steps: [{ id: 's1', label: '开始', next: [] }],
        format: 'png',
        persist_index: false,
      }, 'strict3')
      expect(result.isError).toBe(false)
      const warnings = (valueOf(result) as { warnings: string[] }).warnings
      expect(warnings.some(warning => warning.includes('渲染复核未执行'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
