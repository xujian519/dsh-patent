import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { GraphvizRenderOutcome, GraphvizRenderSpec } from '../src/figure/graphviz-renderer.ts'
import type { FigureNumeralItem } from '../src/figure/numeral-store.ts'
import { resolveFamilySeeds } from '../src/tool/figure-input.ts'
import { createGeneratePatentFigureTool } from '../src/tool/generate-patent-figure.ts'
import { createAddPatentFigureReferencesTool } from '../src/tool/add-patent-figure-references.ts'
import { validateSpecification } from '../src/tool/validate-specification.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const signal = new AbortController().signal

async function ctxWith(...tools: ToolDefinition[]): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  for (const tool of tools) ctx.tools.register(tool)
  return ctx
}

function execute(ctx: Context, name: string, args: unknown, label: string) {
  return executeToolFixture(ctx, { signal, callId: ToolCallId(label), name, arguments: args })
}

/** 内存版作用域标号表：与 numeral-store 的读写端口同形，测试无需落盘。 */
function memoryNumerals() {
  const table = new Map<string, FigureNumeralItem[]>()
  return {
    table,
    loadNumerals: (scope: string): Promise<FigureNumeralItem[]> =>
      Promise.resolve((table.get(scope) ?? []).map(item => ({ ...item }))),
    upsertNumerals: (scope: string, items: readonly FigureNumeralItem[]): Promise<never[]> => {
      const merged = new Map<string, FigureNumeralItem>()
      for (const existing of table.get(scope) ?? []) merged.set(existing.componentId, { ...existing })
      for (const item of items) merged.set(item.componentId, { ...item })
      table.set(scope, [...merged.values()])
      return Promise.resolve([])
    },
  }
}

function okRenderer(dir: string): (spec: GraphvizRenderSpec) => Promise<GraphvizRenderOutcome> {
  return (spec) => {
    const out = join(spec.outputDir || dir, `${spec.filename}.${spec.format}`)
    writeFileSync(out, '<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>')
    return Promise.resolve({ ok: true, path: out })
  }
}

const blocks = [
  { id: 'shell', label: '壳体' },
  { id: 'cover', label: '盖板' },
]

describe('resolveFamilySeeds 标号表优先', () => {
  it('表内有该作用域时按组件 id 沿用并保留其余号', async () => {
    const seeds = await resolveFamilySeeds('CN2024-0001', [
      { id: 'shell', label: '外壳' },
      { id: 'spring', label: '弹簧' },
    ], {
      render: () => Promise.reject(new Error('unused')),
      loadNumerals: scope => Promise.resolve(scope === 'CN2024-0001'
        ? [
          { componentId: 'shell', label: '壳体', numeral: '10' },
          { componentId: 'cover', label: '盖板', numeral: '20' },
        ]
        : []),
      loadIndex: () => Promise.resolve([]),
    })

    expect(seeds.explicit).toEqual({ shell: '10' })
    expect(seeds.reserved).toEqual(['20'])
  })

  it('表为空时不报错，返回空种子', async () => {
    const seeds = await resolveFamilySeeds('fresh-scope', blocks, {
      render: () => Promise.reject(new Error('unused')),
      loadNumerals: () => Promise.resolve([]),
    })

    expect(seeds).toEqual({ explicit: {}, reserved: [] })
  })

  it('表有数据时不再回落到附图索引', async () => {
    const seeds = await resolveFamilySeeds('CN2024-0001', blocks, {
      render: () => Promise.reject(new Error('unused')),
      loadNumerals: () => Promise.resolve([{ componentId: 'shell', label: '壳体', numeral: '10' }]),
      loadIndex: () => Promise.reject(new Error('索引不应被读取')),
    })

    expect(seeds.explicit).toEqual({ shell: '10' })
  })

  it('表为空时回落到附图索引', async () => {
    const seeds = await resolveFamilySeeds('CN2024-0001', blocks, {
      render: () => Promise.reject(new Error('unused')),
      loadNumerals: () => Promise.resolve([]),
      loadIndex: () => Promise.resolve([
        {
          imagePath: 'fig1.svg',
          analyzedAt: '2026-11-27T00:00:00.000Z',
          analysis: {
            imagePath: 'fig1.svg',
            figureNumber: 1,
            figureType: 'block_diagram',
            overallDescription: '',
            components: [{ refNumber: '100', name: '壳体', kind: 'unknown', description: '' }],
            connections: [],
            figureDescription: '',
            confidence: 1,
            warnings: [],
            usable: true,
            modelUsed: 'x',
            drawingStatus: 'drawn',
            figureFamily: 'CN2024-0001',
          },
        },
      ]),
    })

    expect(seeds.explicit).toEqual({ shell: '100' })
  })

  it('读取标号表失败时报 tool_execution_failed', async () => {
    await expect(resolveFamilySeeds('CN2024-0001', blocks, {
      render: () => Promise.reject(new Error('unused')),
      loadNumerals: () => Promise.reject(new Error('磁盘错误')),
    })).rejects.toMatchObject({ code: 'tool_execution_failed' })
  })

  it('两个读取端口都未注入时报 invalid_tool_input', async () => {
    await expect(resolveFamilySeeds('CN2024-0001', blocks, {
      render: () => Promise.reject(new Error('unused')),
    })).rejects.toMatchObject({ code: 'invalid_tool_input' })
  })
})

describe('generate_patent_figure 写入标号表', () => {
  it('声明 figure_family 时把本图标号登记进表', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-num-wiring-'))
    try {
      const store = memoryNumerals()
      const ctx = await ctxWith(createGeneratePatentFigureTool({
        render: okRenderer(dir),
        outputDir: dir,
        cwd: dir,
        loadNumerals: store.loadNumerals,
        upsertNumerals: store.upsertNumerals,
      }))
      await execute(ctx, 'generate_patent_figure', {
        figure_type: 'block_diagram',
        blocks,
        figure_family: 'CN2024-0001',
        filename: 'fig1',
      }, 'gen-fig1')

      expect(store.table.get('CN2024-0001')).toEqual([
        { componentId: 'shell', label: '壳体', numeral: '100' },
        { componentId: 'cover', label: '盖板', numeral: '102' },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('第二次生成沿用表内既有标号', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-num-wiring-'))
    try {
      const store = memoryNumerals()
      const ctx = await ctxWith(createGeneratePatentFigureTool({
        render: okRenderer(dir),
        outputDir: dir,
        cwd: dir,
        loadNumerals: store.loadNumerals,
        upsertNumerals: store.upsertNumerals,
      }))
      await execute(ctx, 'generate_patent_figure', {
        figure_type: 'block_diagram',
        blocks,
        figure_family: 'CN2024-0001',
        filename: 'fig1',
      }, 'gen-fig1')
      const second = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'block_diagram',
        blocks,
        figure_family: 'CN2024-0001',
        figure_number: 2,
        filename: 'fig2',
      }, 'gen-fig2')

      const value = (second as { value: { numeralMap: { componentId: string; numeral: string }[] } }).value
      expect(value.numeralMap.map(item => [item.componentId, item.numeral])).toEqual([
        ['shell', '100'],
        ['cover', '102'],
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('未声明 figure_family 时不写表', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-num-wiring-'))
    try {
      const store = memoryNumerals()
      const ctx = await ctxWith(createGeneratePatentFigureTool({
        render: okRenderer(dir),
        outputDir: dir,
        cwd: dir,
        loadNumerals: store.loadNumerals,
        upsertNumerals: store.upsertNumerals,
      }))
      await execute(ctx, 'generate_patent_figure', {
        figure_type: 'block_diagram',
        blocks,
        filename: 'fig1',
      }, 'gen-no-family')

      expect(store.table.size).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('add_patent_figure_references 标号表补全', () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>壳体</text><text>盖板</text></svg>'

  it('给出 figure_family 时用表补全未列出的部件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-num-annotate-'))
    try {
      writeFileSync(join(dir, 'src.svg'), svg)
      const store = memoryNumerals()
      await store.upsertNumerals('CN2024-0001', [
        { componentId: 'shell', label: '壳体', numeral: '10' },
        { componentId: 'cover', label: '盖板', numeral: '20' },
      ])
      const ctx = await ctxWith(createAddPatentFigureReferencesTool({
        cwd: dir,
        loadNumerals: store.loadNumerals,
        upsertNumerals: store.upsertNumerals,
      }))
      const result = await execute(ctx, 'add_patent_figure_references', {
        svg_path: 'src.svg',
        references: [{ label: '壳体', numeral: '10' }],
        figure_family: 'CN2024-0001',
      }, 'annotate-table')

      expect((result as { value: { numReferences: number } }).value.numReferences).toBe(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('未给出 figure_family 时不读表', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-num-annotate-'))
    try {
      writeFileSync(join(dir, 'src.svg'), svg)
      const ctx = await ctxWith(createAddPatentFigureReferencesTool({
        cwd: dir,
        loadNumerals: () => Promise.reject(new Error('不应读取标号表')),
        upsertNumerals: () => Promise.reject(new Error('不应写入标号表')),
      }))
      const result = await execute(ctx, 'add_patent_figure_references', {
        svg_path: 'src.svg',
        references: [{ label: '壳体', numeral: '10' }],
      }, 'annotate-no-family')

      expect((result as { value: { numReferences: number } }).value.numReferences).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('validate_specification 标号表核对', () => {
  const analysis = [{
    figureNumber: 1,
    usable: true,
    components: [{ refNumber: '10' }, { refNumber: '99' }],
  }]

  it('图面标号未登记时报告 warning', () => {
    const output = validateSpecification({
      text: '# 说明书\n\n## 附图说明\n\n图1是结构示意图。\n',
      figure_analysis: analysis,
      numeral_table: [{ numeral: '10' }],
    })

    const finding = output.violations.find(item => item.rule === 'figure_numeral_table')
    expect(finding).toMatchObject({ family: 'figures', severity: 'warning' })
    expect(finding?.message).toContain('99')
  })

  it('全部登记时不产发现', () => {
    const output = validateSpecification({
      text: '# 说明书\n\n## 附图说明\n\n图1是结构示意图。\n',
      figure_analysis: analysis,
      numeral_table: [{ numeral: '10' }, { numeral: '99' }],
    })

    expect(output.violations.filter(item => item.rule === 'figure_numeral_table')).toEqual([])
  })

  it('未传 numeral_table 时不产发现', () => {
    const output = validateSpecification({
      text: '# 说明书\n\n## 附图说明\n\n图1是结构示意图。\n',
      figure_analysis: analysis,
    })

    expect(output.violations.filter(item => item.rule === 'figure_numeral_table')).toEqual([])
  })

  it('空表不产发现', () => {
    const output = validateSpecification({
      text: '# 说明书\n\n## 附图说明\n\n图1是结构示意图。\n',
      figure_analysis: analysis,
      numeral_table: [],
    })

    expect(output.violations.filter(item => item.rule === 'figure_numeral_table')).toEqual([])
  })
})
