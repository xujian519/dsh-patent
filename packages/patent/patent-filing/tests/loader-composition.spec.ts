// Proves the plugin is a real, Loader-composed config: booting a cordis.yml
// registers both filing tools, and a dispatch through the tool runtime reaches
// the packaged engine assets and comes back as model-facing prose.
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as PatentFiling from '@deepseek-ai/dsh-patent-filing'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { argvOf, fakeSubprocess, stdoutHandle } from './helpers.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

/**
 * Import mapped source modules without claiming support for Node's HMR internals:
 * only `import` is used, and every other member fails loudly if the Loader reaches it.
 * @param importModule - resolves one specifier to its already-imported module.
 * @returns a typed Node 24 loader holding that module map.
 */
function sourceModuleLoader(importModule: (specifier: string) => Promise<unknown>): ModuleLoaderV2 {
  return {
    version: 'v2',
    import: importModule,
    loadCache: new Map(),
    register(): never { throw new Error('unexpected module hook registration') },
    getOrCreateModuleJob(): never { throw new Error('unexpected module job creation') },
    resolveSync(): never { throw new Error('unexpected synchronous module resolution') },
    load(): never { throw new Error('unexpected module load') },
  }
}

/** What the packaged build.py prints for a successful build. */
const BUILD_REPORT = JSON.stringify({
  status: 'ok',
  out: '/out/a.docx',
  sections: [{ key: 'abstract', paragraphs: 1, figures: 0 }],
  numbering_total: 3,
  upstream_numbering_seen: 0,
  template_style: {
    section_count: 5,
    eastAsia: '宋体',
    ascii: 'Times New Roman',
    cs: 'Times New Roman',
    size_pt: 12,
    line_spacing: 1.5,
    first_line_indent: 0,
    sizes_pt: [12],
    line_spacings: [1.5],
  },
})

/** What the packaged verify.py prints for a document that passes every assertion. */
const VERIFY_REPORT = JSON.stringify({
  passed: true,
  errors: [],
  info: {
    sections: 5,
    headers: ['说明书摘要', '摘要附图', '权利要求书', '说明书', '说明书附图'],
    paragraphs: 3,
    claims: 1,
    numbering: '1..3',
    tables: 0,
    figures: 2,
    layout: { abstract: { paragraphs: 1, figures: 0 } },
    template: { sections: 5, sizes_pt: [12], line_spacings: [1.5] },
  },
})

let root: string | undefined
let context: Context | undefined
let outDir: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  for (const dir of [root, outDir]) {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
  root = undefined
  outDir = undefined
})

/** Boot a cordis.yml carrying the plugin and a stub interpreter, and return the context. */
async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-patent-filing-loader-'))
  outDir = await mkdtemp(join(tmpdir(), 'dsh-patent-filing-out-'))
  const interpreter = join(root, 'python3')
  const figure = join(outDir, 'fig1.png')
  await writeFile(interpreter, '#!/bin/sh\nexit 0\n')
  await writeFile(figure, 'png')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-patent-filing'",
    '  config:',
    `    pythonPath: ${interpreter}`,
    `    outputRoot: ${outDir}`,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.provide('subprocess', fakeSubprocess((spec: SubprocessSpawnSpec) => {
    const argv = argvOf(spec)
    const script = argv[1] ?? ''
    if (script.endsWith('verify.py')) return stdoutHandle(VERIFY_REPORT)
    // 成文成功后立刻验收：验收读的是 build.py 按 --out 写出的文件。
    const out = argv[argv.indexOf('--out') + 1]
    if (out !== undefined) writeFileSync(out, 'docx')
    return stdoutHandle(BUILD_REPORT)
  }).spawner)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-patent-filing', PatentFiling],
  ])
  ctx.loader.internal = sourceModuleLoader(async (specifier: string) => {
    if (!modules.has(specifier)) throw new Error('unexpected Loader import: ' + specifier)
    return modules.get(specifier)
  })
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('patent-filing real Loader composition through cordis.yml', () => {
  it('boots and registers both filing tools', async () => {
    const ctx = await boot()
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('build_patent_filing')
    expect(names).toContain('verify_patent_filing')
  }, 30_000)

  it('builds through the tool runtime and answers with model-facing prose', async () => {
    const ctx = await boot()
    const figure = join(outDir ?? '', 'fig1.png')
    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId('patent-filing-build'),
      name: 'build_patent_filing',
      arguments: {
        draft: {
          meta: { caseNumber: 'CN2026-0001', title: '一种装置', applicant: '示例申请人', inventor: '示例发明人', agent: '示例代理', date: '2026-10-09' },
          claims: ['一种装置，其特征在于，包括本体。'],
          abstract: ['摘要正文。'],
          figureFiles: [figure],
          sections: {
            technicalField: [{ kind: 'paragraph', text: '本发明属于机械领域。' }],
            background: [{ kind: 'paragraph', text: '现有技术存在不足。' }],
            summary: [{ kind: 'paragraph', text: '本发明提供一种装置。' }],
            drawingDescriptions: [{ kind: 'list', items: ['整体结构示意图'] }],
            embodiment: [{ kind: 'paragraph', text: '下面结合附图说明。' }],
          },
        },
        outputName: '案卷_申请文件',
      },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const value = result.value as { docxPath: string; numberingTotal: number }
    expect(value.docxPath).toBe(join(outDir ?? '', '案卷_申请文件.docx'))
    expect(value.numberingTotal).toBe(3)
    const text = result.content.map(block => (block.type === 'text' ? block.text : '')).join('\n')
    expect(text).toContain(`成品：${join(outDir ?? '', '案卷_申请文件.docx')}`)
    expect(text).toContain('段落编号：3 条')
    // 成文后自动验收：结论随成品一起回到模型面前，不依赖模型再调一次 verify。
    expect(text).toContain('验收：✅ 断言全部通过（分节 5 · 权项 1 · 附图 2）')
  }, 30_000)
})

describe('patent-filing verification through the tool runtime', () => {
  it('answers with the assertion report as model-facing prose', async () => {
    const ctx = await boot()
    const result = await executeToolFixture(ctx, {
      signal: new AbortController().signal,
      callId: ToolCallId('patent-filing-verify'),
      name: 'verify_patent_filing',
      // 引擎是替身，验收只检查文件存在；用本场景已写入的桩文件。
      arguments: { docx: join(outDir ?? '', 'fig1.png') },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const value = result.value as { passed: boolean; errors: string[]; info: { sections: number } }
    expect(value.passed).toBe(true)
    expect(value.info.sections).toBe(5)
    const text = result.content.map(block => (block.type === 'text' ? block.text : '')).join('\n')
    expect(text).toContain('✅ 断言全部通过')
    expect(text).toContain('分节 5（说明书摘要 / 摘要附图 / 权利要求书 / 说明书 / 说明书附图）')
  }, 30_000)
})
