/**
 * Real-composition test: boots a test cordis.yml through the real Loader
 * mounting @deepseek-ai/dsh-subprocess-local, the tools registry,
 * @deepseek-ai/dsh-patent-data, and @deepseek-ai/dsh-patent-tools, and
 * asserts the wired consumer layer: ctx.patentData resolves inside the
 * composition, knowledge_note_save persists through the file writer, and
 * patent_pdf_download no longer reports the unwired-stub message (its ego
 * runner is the real adapter over the mounted service).
 */
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import PatentData from '@deepseek-ai/dsh-patent-data'
import * as PatentTools from '@deepseek-ai/dsh-patent-tools'
import { findDot } from '@deepseek-ai/dsh-patent-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

let root: string | undefined
let context: Context | undefined

/**
 * The model face a background run needs: a deployment default route plus a
 * stream that ends without producing content. Stages degrade on the empty
 * answer, which is enough to carry the run to its approval gate.
 */
const modelFixture = {
  name: 'fixture-model',
  apply(ctx: Context) {
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'fixture', model: 'fixture-model' }),
    })
    ctx.provide('llm', {
      stream: async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
  },
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot the composition. `extraPlugins` appends further composition rows after
 * the patent-tools row; `extraModules` supplies the modules those rows import.
 */
async function boot(
  noteDir: string,
  extraConfig: readonly string[] = [],
  extraPlugins: readonly string[] = [],
  extraModules: ReadonlyArray<readonly [string, unknown]> = [],
): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-patent-tools-loader-'))
  const configPath = join(root, 'cordis.yml')
  const yml = [
    "- name: '@deepseek-ai/dsh-subprocess-local'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-patent-data'",
    "- name: '@deepseek-ai/dsh-patent-tools'",
    '  config:',
    '    noteDir: ' + JSON.stringify(noteDir),
    ...extraConfig,
    ...extraPlugins,
    '',
  ].join('\n')
  await writeFile(configPath, yml)

  const ctx = new Context()
  context = ctx
  const workspaceKey: string = 'sandboxPolicy'
  ctx.provide(workspaceKey, { workspaceRoot: root })
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-patent-data', PatentData],
    ['@deepseek-ai/dsh-patent-tools', PatentTools],
    ...extraModules,
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('patent-tools real Loader composition', () => {
  it('resolves ctx.patentData and registers the wired tools', async () => {
    const notes = join(await mkdtemp(join(tmpdir(), 'dsh-patent-tools-notes-')), '99-知识库')
    try {
      const ctx = await boot(notes)
      expect(ctx.patentData).toBeInstanceOf(PatentData)
      const names = ctx.tools.schemas().map(schema => schema.name)
      expect(names).toContain('patent_pdf_download')
      expect(names).toContain('knowledge_note_save')
    } finally {
      await rm(notes, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('persists a knowledge note through the file writer', async () => {
    const notes = join(await mkdtemp(join(tmpdir(), 'dsh-patent-tools-notes-')), '99-知识库')
    try {
      const ctx = await boot(notes)
      const result = await executeToolFixture(ctx, {
        signal: new AbortController().signal,
        callId: ToolCallId('loader-note-1'),
        name: 'knowledge_note_save',
        arguments: { title: '组合测试笔记', content: '写入内容', project: 'loader' },
      })
      expect(result.isError).toBe(false)
      const files = await readdir(notes)
      expect(files.filter(file => file.endsWith('.json')).length).toBe(1)
    } finally {
      await rm(notes, { recursive: true, force: true }).catch(() => {})
    }
  })

  it.skipIf(findDot() === undefined)('applies the dot render timeout configured in cordis.yml', async () => {
    const notes = join(await mkdtemp(join(tmpdir(), 'dsh-patent-tools-notes-')), '99-知识库')
    const figures = join(notes, 'figures')
    try {
      const ctx = await boot(notes, [
        '    figureRenderer: cli',
        '    graphvizRenderTimeoutMs: 1',
        '    figureOutputDir: ' + JSON.stringify(figures),
        '    figureIndexFile: ' + JSON.stringify(join(notes, 'figures-index.json')),
      ])
      const result = await executeToolFixture(ctx, {
        signal: new AbortController().signal,
        callId: ToolCallId('loader-figure-1'),
        name: 'generate_patent_figure',
        arguments: { figure_type: 'raw_dot', dot: 'digraph { a -> b }', filename: 'timeout-probe' },
      })
      // A 1 ms budget aborts the dot CLI, so the configured value is what the
      // renderer used; the default 60 s could not fail this fast.
      expect(JSON.stringify(result)).toContain('渲染超时')
    } finally {
      await rm(notes, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('figureTextToPath 接到生成工具：Inkscape 路径无效时 fail loud（不静默留文字）', async () => {
    const notes = join(await mkdtemp(join(tmpdir(), 'dsh-patent-tools-notes-')), '99-知识库')
    const figures = join(notes, 'figures')
    try {
      const ctx = await boot(notes, [
        '    figureTextToPath: true',
        // 指向不存在的路径：与机器上是否装了 Inkscape 无关，结果确定。
        '    inkscapeExecutable: "/nonexistent/inkscape-probe"',
        '    figureOutputDir: ' + JSON.stringify(figures),
        '    figureIndexFile: ' + JSON.stringify(join(notes, 'figures-index.json')),
      ])
      const result = await executeToolFixture(ctx, {
        signal: new AbortController().signal,
        callId: ToolCallId('loader-outline-1'),
        name: 'generate_patent_figure',
        arguments: {
          figure_type: 'circuit',
          circuit: { components: [{ id: 'r1', kind: 'resistor', label: 'R1', col: 0, row: 0 }], connections: [] },
          filename: 'outline-probe',
          persist_index: false,
        },
      })
      // 配置开了就绝不能交出仍是 <text> 的图：缺 Inkscape 时 fail loud 并给出安装引导
      // （错误码 setup_required 的映射由 figure-generate-tool.spec 断言）。
      expect(result.isError).toBe(true)
      const text = JSON.stringify(result)
      expect(text).toContain('未找到 Inkscape 可执行文件')
      expect(text).toContain('Config.inkscapeExecutable')
    } finally {
      await rm(notes, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('registers a background patent_workflow_run and settles a collectable result', async () => {
    const notes = join(await mkdtemp(join(tmpdir(), 'dsh-patent-tools-notes-')), '99-知识库')
    try {
      const ctx = await boot(notes, [], [
        "- name: '@deepseek-ai/dsh-jobs-local'",
        "- name: '@deepseek-ai/dsh-tool-jobs'",
        '- name: fixture-model',
      ], [
        ['@deepseek-ai/dsh-jobs-local', LocalJobRegistry],
        ['@deepseek-ai/dsh-tool-jobs', ToolJobs],
        ['fixture-model', modelFixture],
      ])
      // The model tools the run's consumer needs are part of the same composition.
      expect(ctx.tools.schemas().map(schema => schema.name)).toContain('job_list')

      const result = await executeToolFixture(ctx, {
        signal: new AbortController().signal,
        callId: ToolCallId('loader-background-1'),
        name: 'patent_workflow_run',
        arguments: { manifestId: 'patent_disclosure_v1', input: '技术交底书', run_in_background: true },
      })
      expect(result.isError).toBe(false)
      // The model-visible acknowledgement is pinned here: no recorded session
      // exercises this flag, so nothing else would catch a rewrite of it.
      expect(JSON.stringify(result.content)).toContain('已在后台启动 job')

      // The registration reached the mounted registry, which is the wiring a
      // hand-built plugin context cannot prove.
      const registered = ctx.jobs.list().filter(job => job.kind === 'patent-workflow')
      expect(registered).toHaveLength(1)
      const settled = await ctx.jobs.wait(registered[0]!.id, 15_000)
      expect(settled.status).toBe('completed')
      // The settled value is the text a foreground call returns, handed out once.
      expect(ctx.jobs.read(registered[0]!.id).result).toContain('patent_workflow_run(patent_disclosure_v1)')
    } finally {
      await rm(notes, { recursive: true, force: true }).catch(() => {})
    }
  })

  it('registers patent_pdf_download live (not an unwired stub)', async () => {
    const notes = join(await mkdtemp(join(tmpdir(), 'dsh-patent-tools-notes-')), '99-知识库')
    try {
      const ctx = await boot(notes)
      // The tool is registered by the real apply(); executing with an invalid
      // patent list fails at the tool's own validation regardless of whether the
      // host has ego-browser installed, proving the adapter wiring is live.
      const result = await executeToolFixture(ctx, {
        signal: new AbortController().signal,
        callId: ToolCallId('loader-pdf-1'),
        name: 'patent_pdf_download',
        arguments: { patents: [], outputDir: notes },
      })
      expect(result.isError).toBe(true)
      const text = JSON.stringify(result.content)
      expect(text).not.toContain('当前未挂载')
    } finally {
      await rm(notes, { recursive: true, force: true }).catch(() => {})
    }
  })
})
