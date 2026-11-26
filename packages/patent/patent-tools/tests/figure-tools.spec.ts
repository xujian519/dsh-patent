import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { PatentModelPort } from '@deepseek-ai/dsh-patent-core'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createAnalyzePatentFigureTool, renderFigureAnalysis } from '../src/tool/analyze-patent-figure.ts'
import type { FigureAnalysisResult } from '../src/tool/analyze-patent-figure.ts'
import {
  createSearchPatentFigureTool,
  renderSearchFigure,
  retrieveFiguresKeyword,
  tokenizeFigureText,
} from '../src/tool/search-patent-figure.ts'
import type { SearchPatentFigureOutput } from '../src/tool/search-patent-figure.ts'
import type { FigureIndexEntry } from '../src/figure/index-store.ts'
import { PatentToolError } from '../src/error.ts'
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

function jsonModel(json: string): PatentModelPort {
  return {
    stream: async function* () {
      yield { type: 'delta' as const, text: json }
      yield { type: 'done' as const }
    },
  }
}

function failingModel(error: Error): PatentModelPort {
  return {
    stream: async function* () {
      throw error
    },
  }
}

const FIGURE_ROUTE = { provider: 'p', model: 'vision' }

const IMAGE_REF: ImageAttachmentRef = {
  attachmentId: AttachmentId('sha256:feed'),
  mediaType: 'image/png',
  bytes: 10,
  width: 1,
  height: 1,
}

/** Vision-path deps over the fixture route: no resolver is wired, so the tool runs un-gated. */
function visionDeps(model: PatentModelPort) {
  return {
    imageModel: model,
    saveImage: async (): Promise<ImageAttachmentRef> => IMAGE_REF,
    gateModel: FIGURE_ROUTE,
  }
}

const fullJson = JSON.stringify({
  figure_type: 'structure',
  overall_description: '整体结构示意图',
  confidence: 0.85,
  components: [
    { ref_number: '1', name: '壳体', kind: 'mechanical', description: '外壳' },
    { ref_number: '2', name: '电机', kind: 'electrical', description: '驱动' },
  ],
  connections: [{ source: '1', target: '2', kind: 'electrical', description: '连接线' }],
  figure_description: '图1是本发明实施例提供的装置的结构示意图；图中：1-壳体；2-电机；',
  warnings: ['标号 3 无法确认', ''],
})

const edgeJson = JSON.stringify({
  figure_type: 'bogus',
  overall_description: 42,
  confidence: 1.5,
  components: [
    123,
    null,
    { ref_number: 7, name: '无标号' },
    { ref_number: '', name: '空标号' },
    { ref_number: '1', name: '', kind: 'bogus', description: 42 },
    { ref_number: '1', name: '重复标号', kind: 'mechanical' },
    { ref_number: '3', name: '三号件', kind: 'flowchart', description: '三号' },
    { ref_number: '8', name: '八号件', kind: 'mechanical', description: '八号' },
  ],
  connections: [
    123,
    null,
    { source: 123, target: '1' },
    { source: '', target: '1' },
    { source: '1', target: 9 },
    { source: '1', target: '9' },
    { source: '1', target: '3', kind: 'bogus', description: 42 },
    { source: '1', target: '3', kind: 'data_flow', description: '数据' },
  ],
  figure_description: '   ',
  warnings: [42, '未标注'],
})

describe('analyze_patent_figure execute', () => {
  it('normalizes a full model answer and renders components/connections/warnings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-fig-'))
    try {
      await writeFile(join(dir, 'fig1.png'), 'fake-image')
      const tool = createAnalyzePatentFigureTool({ ...visionDeps(jsonModel(fullJson)), cwd: dir, modelUsed: 'test-model' })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'analyze_patent_figure', {
        image_path: 'fig1.png', figure_number: 1, claim_context: '权利要求上下文', invention_name: '一种装置',
      }, 'f-1')
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(text(result)).toContain('## 组件')
      expect(text(result)).toContain('- 1 壳体（mechanical）：外壳')
      expect(text(result)).toContain('## 连接关系')
      expect(text(result)).toContain('1 → 2（electrical）：连接线')
      expect(text(result)).toContain('标号 3 无法确认')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('degrades unparseable output into an unknown-type empty analysis', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-fig-'))
    try {
      await writeFile(join(dir, 'fig1.png'), 'fake-image')
      const tool = createAnalyzePatentFigureTool({ ...visionDeps(jsonModel('not json at all')), cwd: dir })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'analyze_patent_figure', { image_path: 'fig1.png' }, 'f-2')
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(text(result)).toContain('需人工确认')
      expect(text(result)).toContain('（无整体描述）')
      expect(text(result)).toContain('模型输出无法解析为 JSON')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('normalizes hostile field types, clamps confidence, and flags non-contiguous marks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-fig-'))
    try {
      await writeFile(join(dir, 'fig1.png'), 'fake-image')
      const tool = createAnalyzePatentFigureTool({ ...visionDeps(jsonModel(edgeJson)), cwd: dir })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'analyze_patent_figure', {
        image_path: 'fig1.png', figure_number: 2, invention_name: '   ',
      }, 'f-3')
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      // confidence clamped to 1; bogus type → 示意图; hostile fields normalized.
      expect(text(result)).toContain('置信度 1.00')
      // 步进 2（1、3）一致，8 破坏了步进 → 提示步进不一致
      expect(text(result)).toContain('附图标记步进不一致：3 后为 8（图内前序步进 2）')
      expect(text(result)).toContain('- 1 未命名部件（unknown）：')
      expect(text(result)).toContain('1 → 3（data_flow）：数据')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('clamps a negative confidence to zero and builds the description from components', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-fig-'))
    try {
      await writeFile(join(dir, 'fig1.png'), 'fake-image')
      const model = jsonModel(JSON.stringify({
        figure_type: 'flowchart', overall_description: '流程', confidence: -0.5,
        components: [{ ref_number: '5', name: '步骤五', kind: 'software', description: '处理' }],
        connections: [],
      }))
      const tool = createAnalyzePatentFigureTool({ ...visionDeps(model), cwd: dir })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'analyze_patent_figure', { image_path: 'fig1.png', invention_name: '方法' }, 'f-4')
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(text(result)).toContain('置信度 0.00')
      expect(text(result)).toContain('5-步骤五')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports tool_execution_failed when the model stream throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-fig-'))
    try {
      await writeFile(join(dir, 'fig1.png'), 'fake-image')
      const tool = createAnalyzePatentFigureTool({ ...visionDeps(failingModel(new Error('boom'))), cwd: dir })
      await expect(tool.execute({ image_path: 'fig1.png' }, { signal } as never)).rejects.toMatchObject({
        name: 'PatentToolError',
        code: 'tool_execution_failed',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports tool_execution_failed when the model stream throws a non-Error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-fig-'))
    try {
      await writeFile(join(dir, 'fig1.png'), 'fake-image')
      const tool = createAnalyzePatentFigureTool({
        ...visionDeps({
          stream: async function* () {
            throw 'boom-string'
          },
        }),
        cwd: dir,
      })
      await expect(tool.execute({ image_path: 'fig1.png' }, { signal } as never)).rejects.toMatchObject({
        name: 'PatentToolError',
        code: 'tool_execution_failed',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports tool_aborted when the call is cancelled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-fig-'))
    try {
      await writeFile(join(dir, 'fig1.png'), 'fake-image')
      const controller = new AbortController()
      controller.abort()
      const tool = createAnalyzePatentFigureTool({ ...visionDeps(failingModel(new Error('aborted'))), cwd: dir })
      await expect(tool.execute({ image_path: 'fig1.png' }, { signal: controller.signal } as never)).rejects.toMatchObject({
        code: 'tool_aborted',
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('persists the normalized analysis into the injected index', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-fig-'))
    try {
      await writeFile(join(dir, 'fig1.png'), 'fake-image')
      const written: FigureIndexEntry[] = []
      const tool = createAnalyzePatentFigureTool({
        ...visionDeps(jsonModel(fullJson)),
        cwd: dir,
        modelUsed: 'test-model',
        upsertIndex: (entry) => { written.push(entry); return Promise.resolve() },
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'analyze_patent_figure', { image_path: 'fig1.png', figure_number: 1 }, 'f-5')
      expect(result.isError).toBe(false)
      expect(written).toHaveLength(1)
      expect(written[0]?.imagePath).toBe('fig1.png')
      expect(written[0]?.analysis.figureNumber).toBe(1)
      expect(written[0]?.analysis.usable).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('swallows an upsert failure so the analysis result still returns', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-fig-'))
    try {
      await writeFile(join(dir, 'fig1.png'), 'fake-image')
      const tool = createAnalyzePatentFigureTool({
        ...visionDeps(jsonModel(fullJson)),
        cwd: dir,
        upsertIndex: () => Promise.reject(new Error('disk full')),
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'analyze_patent_figure', { image_path: 'fig1.png', figure_number: 1 }, 'f-6')
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(text(result)).toContain('## 组件')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

function makeEntry(over: Partial<FigureAnalysisResult> & { imagePath: string }): FigureIndexEntry {
  return {
    imagePath: over.imagePath,
    analyzedAt: '2024-01-01T00:00:00.000Z',
    analysis: {
      figureNumber: 1,
      figureType: 'structure',
      overallDescription: '整体结构',
      components: [{ refNumber: '1', name: '壳体', kind: 'mechanical', description: '外壳' }],
      connections: [],
      figureDescription: '图1是本发明实施例提供的装置的结构示意图；图中：1-壳体；',
      confidence: 0.9,
      warnings: [],
      usable: true,
      modelUsed: 'm',
      ...over,
    },
  }
}

describe('tokenizeFigureText', () => {
  it('splits ASCII tokens and CJK chars with bigrams', () => {
    expect(tokenizeFigureText('PumpB_2中文')).toEqual(['pumpb_2', '中', '中文', '文'])
    expect(tokenizeFigureText('单')).toEqual(['单'])
    expect(tokenizeFigureText('!!!')).toEqual([])
  })
})

describe('render helpers', () => {
  it('renders the empty-figure fallbacks for a bare analysis result', () => {
    const text = renderFigureAnalysis({
      imagePath: 'x.png',
      figureNumber: 1,
      figureType: 'structure',
      overallDescription: '',
      components: [],
      connections: [],
      figureDescription: '',
      confidence: 0,
      warnings: [],
      usable: false,
      modelUsed: 'm',
    })
    expect(text).toContain('需人工确认')
    expect(text).toContain('（无整体描述）')
    expect(text).toContain('（无附图说明）')
    expect(text).toContain('本结果是读图提案，没有毫米坐标，不能落版')
  })

  it('renders a zero-hit search result without a hint', () => {
    const value: SearchPatentFigureOutput = { query: 'x', total: 0, indexedCount: 0, method: 'keyword', results: [] }
    expect(renderSearchFigure(value)).toContain('0 张附图命中')
  })

  it('renders per-result analysis warnings', () => {
    const value: SearchPatentFigureOutput = {
      query: '壳体',
      total: 1,
      indexedCount: 1,
      method: 'keyword',
      results: [{
        figureNumber: 1,
        figureType: 'structure',
        imagePath: 'a.png',
        score: 1,
        usable: true,
        overallDescription: '整体结构',
        figureDescription: '图1是装置的结构示意图。',
        components: [],
        warnings: ['附图标记步进不一致：1、3、5'],
      }],
    }
    const text = renderSearchFigure(value)
    expect(text).toContain('**警告**')
    expect(text).toContain('附图标记步进不一致：1、3、5')
  })
})

describe('retrieveFiguresKeyword', () => {
  const entries = [
    makeEntry({ imagePath: 'a.png', figureNumber: 2, overallDescription: '带壳体与电机', connections: [{ source: '1', target: '2', kind: 'electrical', description: '连接线' }] }),
    makeEntry({ imagePath: 'b.png', figureNumber: 1, usable: false, overallDescription: '电路板' }),
    makeEntry({ imagePath: 'c.png', figureNumber: 1, overallDescription: '壳体结构' }),
  ]

  it('lists by figure number on an empty query, tie-breaking by image path', () => {
    const hits = retrieveFiguresKeyword(entries, '  ', 5)
    expect(hits.map(h => h.entry.imagePath)).toEqual(['b.png', 'c.png', 'a.png'])
    expect(hits[0]?.score).toBe(0.5)
    expect(hits[1]?.score).toBe(1)
  })

  it('ranks keyword hits by cosine and drops zero-score documents', () => {
    const hits = retrieveFiguresKeyword(entries, '壳体 电机', 5)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]?.entry.imagePath).toBe('a.png')

    const none = retrieveFiguresKeyword(entries, 'nomatchzz', 5)
    expect(none).toEqual([])
  })

  it('ties equal-score hits by figure number then image path', () => {
    const tie = [
      makeEntry({ imagePath: 'x1.png', figureNumber: 2, overallDescription: '完全相同的内容' }),
      makeEntry({ imagePath: 'x2.png', figureNumber: 1, overallDescription: '完全相同的内容' }),
      makeEntry({ imagePath: 'x3.png', figureNumber: 1, overallDescription: '完全相同的内容' }),
    ]
    const hits = retrieveFiguresKeyword(tie, '完全相同', 5)
    expect(hits).toHaveLength(3)
    // equal scores break on ascending figureNumber, then image path.
    expect(hits.map(h => h.entry.imagePath)).toEqual(['x2.png', 'x3.png', 'x1.png'])
  })

  it('returns nothing for an empty index', () => {
    expect(retrieveFiguresKeyword([], 'x', 5)).toEqual([])
  })
})

describe('search_patent_figure execute', () => {
  it('searches the loaded index and renders hits', async () => {
    const entries = [makeEntry({ imagePath: 'a.png', figureNumber: 1, overallDescription: '带壳体与电机' })]
    const tool = createSearchPatentFigureTool({ loadIndex: async () => ({ entries }) })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'search_patent_figure', { query: '壳体' }, 'sf-1')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('1 result(s)')
    expect(text(result)).toContain('组件：1 壳体')
  })

  it('renders an unusable and component-less hit with the human-review flag', async () => {
    const entries = [
      makeEntry({ imagePath: 'b.png', figureNumber: 1, usable: false, components: [], overallDescription: '电路板' }),
    ]
    const tool = createSearchPatentFigureTool({ loadIndex: async () => ({ entries }) })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'search_patent_figure', { query: '电路板' }, 'sf-1b')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('需人工确认')
  })

  it('hints on an empty index and renders a zero-hit result', async () => {
    const tool = createSearchPatentFigureTool({ loadIndex: async () => ({ entries: [] }) })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'search_patent_figure', { query: '壳体' }, 'sf-2')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('0 张附图命中')
    expect(text(result)).toContain('附图索引为空')
  })

  it('surfaces a load warning as the hint', async () => {
    const tool = createSearchPatentFigureTool({
      loadIndex: async () => ({ entries: [makeEntry({ imagePath: 'a.png' })], warning: '索引文件版本过旧，已忽略 2 条' }),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'search_patent_figure', { query: 'nomatchzz' }, 'sf-3')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('索引文件版本过旧')
  })

  it('hints when a keyword query matches nothing', async () => {
    const tool = createSearchPatentFigureTool({ loadIndex: async () => ({ entries: [makeEntry({ imagePath: 'a.png' })] }) })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'search_patent_figure', { query: '无此词' }, 'sf-4')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('未检索到匹配附图')
  })

  it('wraps a non-setup load failure as tool_execution_failed', async () => {
    const tool = createSearchPatentFigureTool({
      loadIndex: async () => { throw new Error('corrupt index') },
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'search_patent_figure', { query: 'x' }, 'sf-5')
    expect(result.isError).toBe(true)
  })

  it('wraps a non-Error load failure as tool_execution_failed', async () => {
    const tool = createSearchPatentFigureTool({
      loadIndex: async () => { throw 'corrupt-index-string' },
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'search_patent_figure', { query: 'x' }, 'sf-5b')
    expect(result.isError).toBe(true)
  })

  it('rethrows the setup_required stub from the loader', async () => {
    const tool = createSearchPatentFigureTool({
      loadIndex: async () => { throw new PatentToolError('setup_required', '未接线', {}) },
    })
    await expect(tool.execute({ query: 'x' }, { signal } as never)).rejects.toMatchObject({
      code: 'setup_required',
    })
  })

  it('caps the argument-free listing at limit and states that cap in the parameter descriptions', async () => {
    const entries = Array.from({ length: 12 }, (_, index) =>
      makeEntry({ imagePath: `figure-${String(index)}.png`, figureNumber: index + 1 }))
    const tool = createSearchPatentFigureTool({ loadIndex: async () => ({ entries }) })
    const ctx = await ctxWith(tool)
    const properties = (ctx.tools.get('search_patent_figure')?.parameters as {
      properties: Record<string, { description: string }>
    }).properties
    expect(properties['limit']?.description).toBe('返回条数上限（默认 5，最大 10）')
    expect(properties['query']?.description).toContain('条数受 limit 约束')

    const defaulted = await execute(ctx, 'search_patent_figure', { query: '' }, 'sf-cap-1')
    if (defaulted.isError) throw new Error('expected success')
    expect((defaulted.value as SearchPatentFigureOutput).results).toHaveLength(5)

    const aboveMax = await execute(ctx, 'search_patent_figure', { query: '', limit: 50 }, 'sf-cap-2')
    if (aboveMax.isError) throw new Error('expected success')
    expect((aboveMax.value as SearchPatentFigureOutput).results).toHaveLength(10)
  })
})
