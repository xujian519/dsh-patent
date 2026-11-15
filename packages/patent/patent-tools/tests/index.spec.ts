import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as tool from '../src/index.ts'
import { buildImageGateResolver } from '../src/index.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const signal = new AbortController().signal

function exec(ctx: Context, name: string, args: unknown, label: string) {
  return executeToolFixture(ctx, { signal, callId: ToolCallId(label), name, arguments: args })
}

async function mounted(config: Record<string, unknown>): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(tool, config)
  return ctx
}

/** Minimal knowledge.db satisfying the KgStore schema introspection (kg_nodes/kg_edges). */
function createKgDb(path: string): void {
  const db = new DatabaseSync(path)
  db.exec(
    'CREATE TABLE kg_nodes (id TEXT, node_type TEXT, name TEXT, title TEXT, content TEXT, law_refs TEXT, source TEXT, full_ref TEXT, chapter TEXT, article_number TEXT)',
  )
  db.exec('CREATE TABLE kg_edges (source_id TEXT, target_id TEXT, relation TEXT)')
  db.close()
}

let temp: string | undefined

afterEach(async () => {
  if (temp !== undefined) {
    await rm(temp, { recursive: true, force: true })
    temp = undefined
  }
})

describe('patent-tools plugin wiring', () => {
  it('resolves Config provider/model into the model port and uses it', async () => {
    // No llm service on this context: the resolved route still builds the
    // fail-loud stub port, whose stream throws setup_required on first use.
    const ctx = await mounted({ provider: 'p', model: 'm' })
    const result = await exec(ctx, 'claim_chart_build', { mode: 'invalidity', claim_text: 'c', targets: [] }, 'w-1')
    expect(result.isError).toBe(true)
  })

  it('passes Config maxTokens into the model port', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('llm', {
      stream: async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
    await ctx.plugin(tool, { provider: 'p', model: 'm', maxTokens: 128 })
    const result = await exec(ctx, 'claim_chart_build', { mode: 'invalidity', claim_text: 'c', targets: [] }, 'w-2')
    expect(result.isError).toBe(true)
  })

  it('uses the Config imageModel override for the figure route', async () => {
    const ctx = await mounted({ imageModel: { provider: 'img-p', model: 'img-m' } })
    expect(ctx.tools.schemas().map(s => s.name)).toContain('analyze_patent_figure')
  })

  it('builds the image-capability resolver when the llm declares resolveModelInfo', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('llm', { resolveModelInfo: async () => ({ inputModalities: ['text'] }) })
    await ctx.plugin(tool, {})
    expect(ctx.tools.schemas().map(s => s.name)).toContain('analyze_patent_figure')
  })

  it('resolves declared modalities through the built image-gate resolver', async () => {
    const ctx = new Context()
    ctx.provide('llm', {
      resolveModelInfo: async (provider: string, model: string) => ({
        inputModalities: provider === 'p' && model === 'm' ? (['text', 'image'] as const) : ([] as const),
      }),
    })
    const resolver = buildImageGateResolver(ctx)
    expect(resolver).toBeDefined()
    await expect(resolver!('p', 'm')).resolves.toEqual(['text', 'image'])
    await expect(resolver!('p', 'other')).resolves.toEqual([])
  })

  it('returns undefined from the gate resolver without an llm capability source', () => {
    expect(buildImageGateResolver(new Context())).toBeUndefined()
  })

  it('wires the knowledge tools from ctx.patentKnowledge with a present db', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-patent-tools-kg-'))
    createKgDb(join(temp, 'query.db'))
    await mkdir(join(temp, 'wiki'))
    await writeFile(join(temp, 'wiki', 'a.md'), '卡片A')
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('patentKnowledge', {
      paths: { wikiDir: join(temp, 'wiki'), queryDbPath: join(temp, 'query.db') },
      caseLawSearch: () => [],
    })
    await ctx.plugin(tool, {})

    const caseResult = await exec(ctx, 'patent_case_search', { query: '创造性' }, 'w-3')
    expect(caseResult.isError).toBe(false)
    const wikiResult = await exec(ctx, 'patent_wiki_search', { query: 'a', include_body: true }, 'w-4')
    expect(wikiResult.isError).toBe(false)
  })

  it('keeps the kg tool dbPath-only when the knowledge db is absent', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-patent-tools-kg-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('patentKnowledge', {
      paths: { wikiDir: join(temp, 'wiki'), queryDbPath: join(temp, 'missing.db') },
      caseLawSearch: () => [],
    })
    await ctx.plugin(tool, {})
    const result = await exec(ctx, 'patent_kg_query', { query: 'x' }, 'w-5')
    expect(result.isError).toBe(true)
  })

  it('serves search_patent_figure from the default (absent) figure index', async () => {
    // Config.figureIndexFile is unset → resolveFigureIndexFile falls back to
    // <cwd>/.sati/figures-index.json, which does not exist → empty entries →
    // a zero-hit result (not an error).
    const ctx = await mounted({})
    const result = await exec(ctx, 'search_patent_figure', { query: 'x' }, 'w-6')
    expect(result.isError).toBe(false)
  })

  it('persists analyze_patent_figure results into Config.figureIndexFile', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-patent-tools-fig-'))
    const indexFile = join(temp, 'figures-index.json')
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('llm', {
      stream: async function* () {
        yield { type: 'text-delta', text: JSON.stringify({ figure_type: 'structure', overall_description: '结构', components: [{ ref_number: '1', name: '壳体', kind: 'mechanical', description: '外壳' }], connections: [], figure_description: '图1', warnings: [] }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
    ctx.provide('attachments', {
      saveImage: async () => ({
        attachmentId: AttachmentId('sha256:feed'),
        mediaType: 'image/png' as const,
        bytes: 10,
        width: 1,
        height: 1,
      }),
    })
    await ctx.plugin(tool, { figureIndexFile: indexFile, provider: 'p', model: 'm' })
    const imagePath = join(temp, 'fig1.png')
    await writeFile(imagePath, 'fake-image')
    const analyzeResult = await exec(ctx, 'analyze_patent_figure', { image_path: imagePath, figure_number: 1 }, 'w-6a')
    expect(analyzeResult.isError).toBe(false)
    const searchResult = await exec(ctx, 'search_patent_figure', { query: '壳体' }, 'w-6b')
    expect(searchResult.isError).toBe(false)
    if (searchResult.isError) throw new Error('expected success')
    expect(JSON.stringify(searchResult.content)).toContain('壳体')
  })

  it('selects the two-step analysis engine from Config.figureAnalysisMode', async () => {
    // Config.figureAnalysisMode="two-step" → 组合点注入 TwoStepModelEngine：
    // 第一次调用返回结构抽取 JSON，第二次返回说明文字，最终结果反映第二步。
    temp = await mkdtemp(join(tmpdir(), 'dsh-patent-tools-2step-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    let call = 0
    ctx.provide('llm', {
      stream: async function* () {
        call++
        yield {
          type: 'text-delta',
          text: call === 1
            ? JSON.stringify({
              figure_type: 'structure',
              overall_description: '整体结构',
              confidence: 0.9,
              components: [{ ref_number: '1', name: '壳体', kind: 'mechanical', description: '外壳' }],
              connections: [],
              warnings: [],
            })
            : '图1是本发明实施例提供的装置的结构示意图；图中：1-壳体；',
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
    ctx.provide('attachments', {
      saveImage: async () => ({
        attachmentId: AttachmentId('sha256:feed'),
        mediaType: 'image/png' as const,
        bytes: 10,
        width: 1,
        height: 1,
      }),
    })
    await ctx.plugin(tool, {
      figureAnalysisMode: 'two-step',
      figureIndexFile: join(temp, 'figures-index.json'),
      provider: 'p',
      model: 'm',
    })
    const imagePath = join(temp, 'fig1.png')
    await writeFile(imagePath, 'fake-image')
    const result = await exec(ctx, 'analyze_patent_figure', { image_path: imagePath, figure_number: 1 }, 'w-6c')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(call).toBe(2)
    expect(JSON.stringify(result.content)).toContain('图1是本发明实施例提供的装置的结构示意图')
  })

  it('resolves Config.chemistryIndexFile for the recognize upsert wiring', async () => {
    // Config.chemistryIndexFile takes the resolve() branch over the cwd default;
    // the recognize tool stays registered either way.
    temp = await mkdtemp(join(tmpdir(), 'dsh-patent-tools-chem-'))
    const ctx = await mounted({ chemistryIndexFile: join(temp, 'chem-index.json') })
    expect(ctx.tools.schemas().map(s => s.name)).toContain('recognize_chemical_structure')
  })

  it('keeps patent_pdf_download registered without a patent-data service', async () => {
    // The runner resolves ctx.patentData per call: a host without the service
    // continues on the browser-free scrape channel instead of failing the batch,
    // so registration no longer depends on the service being present at apply.
    const ctx = await mounted({})
    expect(ctx.tools.schemas().map(s => s.name)).toContain('patent_pdf_download')
  })

  it('wires knowledge_note_save to the file writer under Config.noteDir', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-patent-tools-notes-'))
    const ctx = await mounted({ noteDir: temp })
    const first = await exec(ctx, 'knowledge_note_save', { title: 't', content: 'c' }, 'w-8')
    expect(first.isError).toBe(false)
    const second = await exec(ctx, 'knowledge_note_save', { title: 't', content: 'c' }, 'w-9')
    expect(second.isError).toBe(false)
    const files = (await import('node:fs/promises')).readdir
    expect((await files(temp)).filter(f => f.endsWith('.json')).length).toBe(1)
  })

  it('wires patent_pdf_download to the ego session when patentData is provided', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-patent-tools-pdf-'))
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('patentData', {
      // 本部署未启用 CNIPR 段：createCniprChannel() 返回 undefined。
      createCniprChannel: () => undefined,
      createEgoSession: () => ({
        checkAvailability: () => ({ ok: true }),
        runScript: async () => ({
          output: 'EGO_DOWNLOAD:{"items":[{"patent":"US1A","status":"ok","path":"' + join(temp!, 'US1A.pdf') + '"}]}',
          exitCode: 0,
          timedOut: false,
        }),
        extractTaggedJson: (output: string, tag: string) => {
          const prefix = `EGO_${tag}:`
          const idx = output.indexOf(prefix)
          if (idx < 0) return null
          return JSON.parse(output.slice(idx + prefix.length)) as unknown
        },
      }),
    })
    await ctx.plugin(tool, {})
    // 本用例只验证接线：输出目录受限于进程工作目录，传 '.' 解析后就是它本身，
    // mkdir 无副作用；ego 假实现回报 ok，工具不会落盘到仓库里。
    const result = await exec(ctx, 'patent_pdf_download', { patents: ['US1A'], outputDir: '.' }, 'w-10')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(JSON.stringify(result.content)).toContain('下载完成：1/1 成功')
  })

  it('renders generate_patent_figure through the bundled WASM engine without a subprocess service', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-patent-tools-wasm-'))
    const ctx = await mounted({ figureOutputDir: join(temp, 'figs'), figureIndexFile: join(temp, 'figures-index.json') })
    const result = await exec(ctx, 'generate_patent_figure', {
      figure_type: 'flowchart',
      steps: [{ id: 's1', label: '接收输入', next: [] }],
      format: 'svg',
      persist_index: false,
    }, 'w-11')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(JSON.stringify(result.content)).toContain('已生成专利附图')
    const svg = await readFile(join(temp, 'figs', 'fig1.svg'), 'utf8')
    expect(svg).toContain('<svg')
  })

  it('wires loadIndex so a declared family continues numerals across generations', async () => {
    // figure_family 续号走真实接线：gen1 经 upsertIndex 写入 figureIndexStore，
    // gen2 经 loadIndex 读回，同名组件沿用既有标号。
    temp = await mkdtemp(join(tmpdir(), 'dsh-patent-tools-family-'))
    const ctx = await mounted({ figureOutputDir: join(temp, 'figs'), figureIndexFile: join(temp, 'figures-index.json') })
    const gen1 = await exec(ctx, 'generate_patent_figure', {
      blocks: [{ id: 'sensor', label: '温度传感器' }, { id: 'controller', label: '控制器' }],
      figure_family: 'acme',
      persist_index: true,
    }, 'w-13')
    expect(gen1.isError).toBe(false)
    const gen2 = await exec(ctx, 'generate_patent_figure', {
      figure_number: 2,
      blocks: [{ id: 'controller', label: '控制器' }],
      figure_family: 'acme',
      persist_index: true,
    }, 'w-14')
    expect(gen2.isError).toBe(false)
    if (gen2.isError) throw new Error('expected success')
    // gen2 的控制器沿用 gen1 分配的 102（跨图同件同号），报警器之类新组件另起本图系列。
    expect(JSON.stringify(gen2.content)).toContain('102-控制器')
  })

  it('routes figureRenderer="cli" to the dot CLI and fails loud without the subprocess service', async () => {
    const ctx = await mounted({ figureRenderer: 'cli' })
    const result = await exec(ctx, 'generate_patent_figure', {
      figure_type: 'flowchart',
      steps: [{ id: 's1', label: '接收输入', next: [] }],
      persist_index: false,
    }, 'w-12')
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('subprocess 服务不可用')
  })

  it('routes png through the cli fallback and fails loud without a subprocess service', async () => {
    const ctx = await mounted({})
    const result = await exec(ctx, 'generate_patent_figure', {
      figure_type: 'flowchart',
      steps: [{ id: 's1', label: '接收输入', next: [] }],
      format: 'png',
      persist_index: false,
    }, 'w-13')
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('subprocess 服务不可用')
  })
})
