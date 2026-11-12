/**
 * document_deliver validation, resolution, registration, and presentation:
 * semantic parsing, workspace existence checks, the deterministic checks, the
 * canonical result, the durable presentation metadata, and the pending-call
 * card.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { findStyleByName, loadStyles, stylesDirectory } from '@deepseek-ai/dsh-doc-style'
import { renderDocx } from '@deepseek-ai/dsh-docx-kit'
import type { ZipReadLimits } from '@deepseek-ai/dsh-docx-kit'
import { writeZip } from '@deepseek-ai/dsh-docx-kit/src/zip.ts'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import * as plugin from '../src/index.ts'
import {
  briefReferenceWarnings,
  createDocumentDeliverTool, DEFAULT_MAX_CHECK_BYTES, missingDeliverableFiles, P0_CHECKLIST,
  p0ChecklistWarnings, parseDocumentDeliverArgs, resolveAckIdentities, resolveCheckFormat, resolveUnreadableReports,
  type DocumentDeliverDeps, type DocumentDeliverInput, type DocumentDeliverResult, type DocumentDeliverSpec,
  type DeliverableCheckReport,
} from '../src/tool.ts'
import { DEFAULT_LENGTH_TOLERANCE, DEFAULT_MAX_FINDINGS_PER_CHECK } from '../src/checks.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const signal = new AbortController().signal
const exec = { signal } as unknown as ToolRunContext
/** Every P0 id the shipped checklist declares: the declaration of a call that has nothing to report. */
const P0_IDS = P0_CHECKLIST.map(entry => entry.id)

/**
 * DOCX read budgets for tools built straight from `deps()`; wide enough that no
 * fixture reaches them. The budget tests below mount the plugin instead, so
 * their budgets come from `Config` exactly as a deployment's would.
 */
const DOCX_LIMITS: ZipReadLimits = { maxArchiveEntries: 10_000, maxUncompressedBytes: 64 * 1024 * 1024 }

/** The loaded shipped styles, with the named one as the default of the test deployment. */
function deps(defaultStyle = 'assistant-neutral'): DocumentDeliverDeps {
  const styles = loadStyles([stylesDirectory()])
  const style = findStyleByName(styles, defaultStyle)
  if (style === undefined) throw new Error(`test setup: no style named ${defaultStyle}`)
  return {
    styles,
    defaultStyle: style,
    maxCheckBytes: DEFAULT_MAX_CHECK_BYTES,
    lengthTolerance: DEFAULT_LENGTH_TOLERANCE,
    maxFindingsPerCheck: DEFAULT_MAX_FINDINGS_PER_CHECK,
    docxReadLimits: DOCX_LIMITS,
  }
}

/** A tool over a bare context, for the checks that never reach the filesystem. */
function bareTool(defaultStyle = 'assistant-neutral'): ReturnType<typeof createDocumentDeliverTool> {
  return createDocumentDeliverTool(new Context(), deps(defaultStyle))
}

let temp: string | undefined

afterEach(async () => {
  if (temp !== undefined) {
    await rm(temp, { recursive: true, force: true })
    temp = undefined
  }
})

/**
 * Mount the plugin over a filesystem whose relative-path base is `cwd`.
 *
 * These tests spell one file relatively and absolutely to prove both resolve to
 * one identity. `ToolRunContext.agent` is what the tool reads a session cwd
 * from, and a test needs no agent to exercise resolution: the backend's own
 * configured base answers relative paths, so the shared {@link exec} stands in
 * for a full execution and nothing here asserts a type it does not have.
 * @param cwd - directory relative paths resolve against.
 * @param config - plugin configuration.
 * @returns the mounted context.
 */
async function mountedAt(cwd: string, config: plugin.Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem, { cwd })
  await ctx.plugin(plugin, config)
  return ctx
}

async function mounted(config: plugin.Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(plugin, config)
  return ctx
}

async function run(ctx: Context, args: unknown): Promise<{ isError: boolean; content: string }> {
  const result = await executeToolFixture(ctx, {
    signal,
    callId: ToolCallId('d-1'),
    name: 'document_deliver',
    arguments: args,
  })
  const block = result.content[0]
  if (block === undefined || block.type !== 'text') throw new Error('expected a text content block')
  return { isError: result.isError, content: block.text }}

/** Register one declaration through the tool itself and render its result. */
async function register(
  ctx: Context, args: Readonly<Record<string, unknown>>,
): Promise<{ value: DocumentDeliverResult; content: string }> {
  const tool = createDocumentDeliverTool(ctx, deps())
  const value = await tool.execute(args, exec) as DocumentDeliverResult
  const block = tool.output.render({}, value as never)[0]
  return { value, content: block?.type === 'text' ? block.text : '' }
}

describe('parseDocumentDeliverArgs', () => {
  it('normalizes a valid registration and defaults p1/briefRef', () => {
    expect(parseDocumentDeliverArgs({
      files: [{ path: 'out/index.html', format: 'html' }, { path: 'report.md', format: 'markdown' }],
      gate: { p0: ['命名规范', '自包含'], p1: ['可访问性'] },
    })).toEqual({
      files: [{ path: 'out/index.html', format: 'html' }, { path: 'report.md', format: 'markdown' }],
      gate: { p0: ['命名规范', '自包含'], p1: ['可访问性'] },
    })
  })

  it('fills briefRef from brief_ref and empty p1 from omission', () => {
    expect(parseDocumentDeliverArgs({
      files: [{ path: 'deck.html', format: 'html' }],
      gate: { p0: ['命名规范'] },
      brief_ref: 'brief.md',
    })).toEqual({
      files: [{ path: 'deck.html', format: 'html' }],
      gate: { p0: ['命名规范'], p1: [] },
      briefRef: 'brief.md',
    })
  })

  it('rejects an empty files list', () => {
    expect(() => parseDocumentDeliverArgs({ files: [], gate: { p0: ['x'] } }))
      .toThrow(/files must list at least one/)
  })

  it('rejects blank and duplicate deliverable paths', () => {
    expect(() => parseDocumentDeliverArgs({
      files: [{ path: '  ', format: 'html' }], gate: { p0: ['x'] },
    })).toThrow(/non-empty string/)
    expect(() => parseDocumentDeliverArgs({
      files: [{ path: 'a.html', format: 'html' }, { path: 'a.html', format: 'pdf' }], gate: { p0: ['x'] },
    })).toThrow(/duplicate deliverable path/)
  })

  it('rejects empty, blank, and partly blank P0 lists', () => {
    const gate = (p0: string[]): DocumentDeliverInput => ({
      files: [{ path: 'a.html', format: 'html' }],
      gate: { p0 },
    })
    expect(() => parseDocumentDeliverArgs(gate([]))).toThrow(/p0 must list/)
    expect(() => parseDocumentDeliverArgs(gate([' ']))).toThrow(/p0 must list/)
    expect(() => parseDocumentDeliverArgs(gate(['ok', ' ']))).toThrow(/p0 must list/)
  })

  it('rejects blank p1 items and a blank brief_ref', () => {
    expect(() => parseDocumentDeliverArgs({
      files: [{ path: 'a.html', format: 'html' }], gate: { p0: ['ok'], p1: [' ', 'x'] },
    })).toThrow(/p1 items/)
    expect(() => parseDocumentDeliverArgs({
      files: [{ path: 'a.html', format: 'html' }], gate: { p0: ['ok'] }, brief_ref: ' ',
    })).toThrow(/brief_ref/)
  })

  it('carries the declared style and character budget, and rejects invalid ones', () => {
    expect(parseDocumentDeliverArgs({
      files: [{ path: 'a.html', format: 'html' }], gate: { p0: ['ok'] }, style: 'patent-standard', char_budget: 800,
    })).toEqual({
      files: [{ path: 'a.html', format: 'html' }],
      gate: { p0: ['ok'], p1: [] },
      styleName: 'patent-standard',
      charBudget: 800,
    })
    expect(() => parseDocumentDeliverArgs({
      files: [{ path: 'a.html', format: 'html' }], gate: { p0: ['ok'] }, style: ' ',
    })).toThrow(/style must be a non-empty/)
    expect(() => parseDocumentDeliverArgs({
      files: [{ path: 'a.html', format: 'html' }], gate: { p0: ['ok'] }, char_budget: 0,
    })).toThrow(/char_budget/)
    expect(() => parseDocumentDeliverArgs({
      files: [{ path: 'a.html', format: 'html' }], gate: { p0: ['ok'] }, char_budget: 12.5,
    })).toThrow(/char_budget/)
  })
})

describe('missingDeliverableFiles', () => {
  it('reports only the paths that do not resolve to a file', async () => {
    const ctx = await mounted()
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const present = join(temp, 'report.html')
    await writeFile(present, '<h1>x</h1>')
    const missing = await missingDeliverableFiles(ctx, exec, [present, join(temp, 'ghost.pdf')])
    expect(missing).toEqual([join(temp, 'ghost.pdf')])
  })

  it('returns empty when every file exists', async () => {
    const ctx = await mounted()
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const present = join(temp, 'report.html')
    await writeFile(present, '<h1>x</h1>')
    expect(await missingDeliverableFiles(ctx, exec, [present])).toEqual([])
  })
})

describe('document_deliver tool', () => {
  it('registers existing files and confirms gate state', async () => {
    const ctx = await mounted()
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const html = join(temp, 'report.html')
    const md = join(temp, 'report.md')
    await writeFile(html, '<h1>x</h1>')
    await writeFile(md, '# x')
    const result = await run(ctx, {
      files: [{ path: html, format: 'html' }, { path: md, format: 'markdown' }],
      gate: { p0: ['命名规范', '自包含'], p1: ['可访问性'] },
      brief_ref: 'brief.md',
    })
    expect(result.isError).toBe(false)
    expect(result.content).toContain('已登记 2 个交付文件')
    expect(result.content).toContain('P0 2 项通过，P1 1 项')
    expect(result.content).toContain('brief 参考：brief.md')
  })

  it('confirms without p1/brief_ref lines when they are absent', async () => {
    const ctx = await mounted()
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const html = join(temp, 'deck.html')
    await writeFile(html, '<h1>x</h1>')
    const result = await run(ctx, {
      files: [{ path: html, format: 'html' }],
      gate: { p0: ['命名规范'] },
    })
    expect(result.isError).toBe(false)
    expect(result.content).toContain('P0 1 项通过')
    expect(result.content).not.toContain('P1')
    expect(result.content).not.toContain('brief 参考')
  })

  it('fails loud when a registered file is missing', async () => {
    const ctx = await mounted()
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const result = await run(ctx, {
      files: [{ path: join(temp, 'ghost.docx'), format: 'docx' }],
      gate: { p0: ['命名规范'] },
    })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('不存在')
  })

  it('fails semantic validation before touching the filesystem', async () => {
    const ctx = await mounted()
    const result = await run(ctx, { files: [{ path: 'a.html', format: 'html' }], gate: { p0: [] } })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('p0 must list')
  })

  it('rejects an unsupported format through the schema', async () => {
    const ctx = await mounted()
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const present = join(temp, 'a.html')
    await writeFile(present, '<h1>x</h1>')
    const result = await run(ctx, {
      files: [{ path: present, format: 'slides' }],
      gate: { p0: ['命名规范'] },
    })
    expect(result.isError).toBe(true)
  })

  it('aborts before validation when the caller signal is already cancelled', async () => {
    const ctx = await mounted()
    const aborted = new AbortController()
    aborted.abort()
    const tool = createDocumentDeliverTool(ctx, deps())
    await expect(tool.execute(
      { files: [{ path: 'a.html', format: 'html' }], gate: { p0: ['x'] } },
      { signal: aborted.signal } as unknown as ToolRunContext,
    )).rejects.toThrow(/aborted/)
  })

  it('presents the pending call as a generic card with the file locations', () => {
    const view = bareTool().presentCall?.({
      files: [{ path: 'out/report.html', format: 'html' }],
      gate: { p0: ['命名规范'], p1: ['可访问性'] },
      brief_ref: 'brief.md',
    })
    expect(view).toEqual({
      card: 'generic',
      title: '登记文档交付物（1 个文件）',
      rawInput: { files: ['out/report.html (html)'], p0: 1, p1: 1, brief_ref: 'brief.md' },
      locations: [{ path: 'out/report.html' }],
    })
  })

  it('presents the card without a brief_ref key when none was provided', () => {
    const view = bareTool().presentCall?.({
      files: [{ path: 'out/deck.html', format: 'html' }],
      gate: { p0: ['命名规范'] },
    })
    expect(view).toEqual({
      card: 'generic',
      title: '登记文档交付物（1 个文件）',
      rawInput: { files: ['out/deck.html (html)'], p0: 1, p1: 0 },
      locations: [{ path: 'out/deck.html' }],
    })
  })

  it('resolves registered paths against the session cwd', async () => {
    const ctx = await mounted()
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    await writeFile(join(temp, 'deck.html'), '<h1>x</h1>\n<p>正文。</p>\n')
    const tool = createDocumentDeliverTool(ctx, deps())
    const result = await tool.execute(
      { files: [{ path: 'deck.html', format: 'html' }], gate: { p0: P0_IDS } },
      { signal, agent: { session: { header: { cwd: temp } } } } as unknown as ToolRunContext,
    ) as DocumentDeliverResult
    expect(result).toEqual({
      registered: [{ path: 'deck.html', format: 'html' }],
      gate: {
        p0: P0_IDS,
        p1: [],
        style: 'assistant-neutral',
        checks: [{
          path: 'deck.html',
          identity: await realpath(join(temp, 'deck.html')),
          format: 'html',
          status: 'checked',
          findings: [],
        }],
      },
    })
  })

  it('falls back to the default card when the pending args are semantically invalid', () => {
    expect(bareTool().presentCall?.({ files: [], gate: { p0: ['x'] } })).toBeUndefined()
  })
})

describe('document_deliver plugin configuration', () => {
  it('layers a configured style directory and selects the configured default style', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem)
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const styles = join(temp, 'styles')
    await mkdir(styles)
    await writeFile(join(styles, 'house.yaml'), [
      'name: house', 'domain: house', 'version: "1.0"', 'sections:', '  anti_patterns:',
      '    - word: 严禁词', '      replace: 替代词', '      severity: block', '',
    ].join('\n'))
    await ctx.plugin(plugin, { styleDirs: [styles], defaultStyle: 'house' })

    const path = join(temp, 'report.md')
    await writeFile(path, '# 报告\n\n正文。\n\n这里是严禁词。\n')
    const result = await run(ctx, { files: [{ path, format: 'markdown' }], gate: { p0: ['命名规范'] } })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('出现样式禁用词 "严禁词"，建议改用 "替代词"')
  })

  it('resolves a configured style directory, so a load failure names one absolute path', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem)
    // doc-template resolves configured style directories; this plugin must load
    // the same directory, so a relative override and its failure name it the
    // same way in both.
    await expect(ctx.plugin(plugin, { styleDirs: ['no-such-relative-styles'] }))
      .rejects.toThrow(resolve('no-such-relative-styles'))
  })

  it('fails the deployment when the configured default style is not loaded', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem)
    await expect(ctx.plugin(plugin, { defaultStyle: 'no-such-style' }))
      .rejects.toThrow(/默认样式 "no-such-style" 未加载/)
  })

  it('falls back to the packaged style root and the shipped default style when applied without configuration', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem)
    plugin.apply(ctx, {})
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const path = join(temp, 'report.md')
    await writeFile(path, '# 报告\n\n正文。\n')
    const result = await run(ctx, { files: [{ path, format: 'markdown' }], gate: { p0: ['命名规范'] } })
    expect(result.isError).toBe(false)
    expect(result.content).toContain('确定性核验（样式 assistant-neutral）')
  })
})

describe('document_deliver deterministic checks', () => {
  it('refuses a deliverable that still carries a residual placeholder', async () => {
    const ctx = await mounted()
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    await writeFile(join(temp, 'report.md'), '# 报告\n\n客户：{{client_name}}\n')
    const result = await run(ctx, {
      files: [{ path: join(temp, 'report.md'), format: 'markdown' }],
      gate: { p0: ['命名规范'] },
    })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('确定性核验未通过')
    expect(result.content).toContain('[placeholder] 第 3 行仍有残余占位符 "{{client_name}}"')
  })

  it('registers a checked document and reports its warnings', async () => {
    const ctx = await mounted()
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const path = join(temp, 'report.md')
    await writeFile(path, '# 报告\n\n正文。\n\n## 空节\n\n## 结论\n\n完成。\n')
    const result = await register(ctx, {
      files: [{ path, format: 'markdown' }],
      gate: { p0: ['命名规范'] },
      char_budget: 500,
    })
    expect(result.value.gate.checks[0]?.status).toBe('checked')
    expect(result.content).toContain(`确定性核验（样式 assistant-neutral）：${path} 2 项提示`)
    expect(result.content).toContain('提示（2）：')
    expect(result.content).toContain(`- ${path} [empty_section] 第 5 行的标题 "空节" 下没有任何内容`)
    expect(result.content).toContain(`- ${path} [length_budget] 全文`)
  })

  it('refuses a word the selected style forbids outright', async () => {
    const ctx = await mounted()
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    await writeFile(join(temp, 'report.md'), '# 报告\n\n正文。\n\n绝对可行。\n')
    const result = await run(ctx, {
      files: [{ path: join(temp, 'report.md'), format: 'markdown' }],
      gate: { p0: ['命名规范'] },
      style: 'patent-standard',
    })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('[anti_pattern] 第 5 行出现样式禁用词 "绝对"，建议改用 "通常"')
  })

  it('fails loud on a style name no loaded style carries', async () => {
    const ctx = await mounted()
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    await writeFile(join(temp, 'report.md'), '# 报告\n')
    const result = await run(ctx, {
      files: [{ path: join(temp, 'report.md'), format: 'markdown' }],
      gate: { p0: ['命名规范'] },
      style: 'no-such-style',
    })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('未加载样式 "no-such-style"')
    expect(result.content).toContain('assistant-neutral')
  })

  it('reports the format-level limit of a file it cannot read as text', async () => {
    const ctx = await mounted()
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const path = join(temp, 'deck.pdf')
    await writeFile(path, '%PDF-1.4')
    const result = await register(ctx, { files: [{ path, format: 'pdf' }], gate: { p0: ['命名规范'] } })
    expect(result.value.gate.checks).toEqual([
      { path, identity: await realpath(path), format: 'pdf', status: 'unchecked', reason: 'pdf 格式没有文本读取器', findings: [] },
    ])
    expect(result.content).toContain(`${path} 未核验（pdf 格式没有文本读取器）`)
  })

  it('projects a DOCX package through docx-kit and checks its text', async () => {
    const ctx = await mounted()
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const path = join(temp, 'report.docx')
    await writeFile(path, renderDocx('# 报告\n\n正文内容。\n'))
    const clean = await register(ctx, { files: [{ path, format: 'docx' }], gate: { p0: ['命名规范'] } })
    expect(clean.value.gate.checks[0]).toEqual({
      path, identity: await realpath(path), format: 'docx', status: 'checked', findings: [],
    })

    await writeFile(path, renderDocx('# 报告\n\n客户：{{client_name}}\n'))
    const refused = await run(ctx, { files: [{ path, format: 'docx' }], gate: { p0: ['命名规范'] } })
    expect(refused.isError).toBe(true)
    expect(refused.content).toContain('残余占位符 "{{client_name}}"')
  })

  it('reports a package it cannot project and a file it cannot read', async () => {
    const ctx = await mounted()
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const path = join(temp, 'broken.docx')
    await writeFile(path, 'not a zip package')
    // A package the reader cannot open is a property of the document, so the
    // call has to say why it still ships; the declared reason comes back beside
    // the check outcome.
    const broken = await register(ctx, {
      files: [{ path, format: 'docx' }],
      gate: { p0: P0_IDS },
      unreadable_ack: [{ path, reason_text: '历史归档件，本部署的 DOCX 读取器打不开' }],
    })
    expect(broken.value.gate.checks[0]?.status).toBe('unreadable')
    expect(broken.value.gate.checks[0]?.ack).toBe('历史归档件，本部署的 DOCX 读取器打不开')
    expect(broken.content).toContain(`确定性核验（样式 assistant-neutral）：${path} 无法核验`)
    expect(broken.content).toContain('（已声明：历史归档件，本部署的 DOCX 读取器打不开）')

    // A directory resolves and stats, then fails the read: same rule, same ack.
    const unreadable = await register(ctx, {
      files: [{ path: temp, format: 'markdown' }],
      gate: { p0: P0_IDS },
      unreadable_ack: [{ path: temp, reason_text: '声明错了路径，交付物是另一份文件' }],
    })
    expect(unreadable.value.gate.checks[0]?.status).toBe('unreadable')
    expect(unreadable.value.gate.checks[0]?.reason).toBeDefined()
  })

  it('refuses an unreadable DOCX that declares no reason, naming the structure and the fix', async () => {
    const ctx = await mounted()
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const path = join(temp, 'broken.docx')
    await writeFile(path, 'not a zip package')
    const result = await run(ctx, { files: [{ path, format: 'docx' }], gate: { p0: P0_IDS } })
    expect(result.isError).toBe(true)
    // V-B4-1: the refusal names the structure and tells the caller what to do.
    expect(result.content).toContain('无法核验，且没有 unreadable_ack 说明原因')
    expect(result.content).toContain('not-a-zip')
    expect(result.content).toContain('重新渲染或检查写盘方式')
    expect(result.content).toContain('给每个文件补一条 unreadable_ack')
  })

  it('refuses a text deliverable beyond the configured read cap instead of scanning it', async () => {
    const ctx = await mounted({ maxCheckBytes: 64 })
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const path = join(temp, 'huge.md')
    await writeFile(path, `# 报告\n\n${'内'.repeat(64)}\n`)
    const result = await run(ctx, { files: [{ path, format: 'markdown' }], gate: { p0: P0_IDS } })
    // V-B4-2: the deployment's own byte cap is not a defect, so no ack is
    // required; the reason says which budget stopped the read.
    expect(result.isError).toBe(false)
    expect(result.content).toContain(`${path} 无法核验（`)
    expect(result.content).toContain('超过读取上限（too-large）：')
    expect(result.content).toContain('exceeds the 64-byte limit')
  })

  it('states the configured length tolerance in the tool description', async () => {
    const shipped = await mounted()
    const configured = await mounted({ lengthTolerance: 0.5 })
    expect(shipped.tools.get('document_deliver')?.description).toContain('char_budget，本部署按 ±20% 容差核验')
    expect(configured.tools.get('document_deliver')?.description).toContain('char_budget，本部署按 ±50% 容差核验')
  })

  it('applies the configured tolerance to a declared character budget', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const path = join(temp, 'report.md')
    await writeFile(path, '# 报告\n\n正文。\n')
    const args = { files: [{ path, format: 'markdown' }], gate: { p0: ['命名规范'] }, char_budget: 10 }
    // Six non-whitespace characters against a ten-character budget.
    const strict = await run(await mounted(), args)
    expect(strict.content).toContain(`- ${path} [length_budget] 全文 6 字，低于声明的 10 字预算（允许 8–12 字）`)
    const lenient = await run(await mounted({ lengthTolerance: 0.6 }), args)
    expect(lenient.content).not.toContain('[length_budget]')
  })

  it('applies the configured per-check finding cap', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const path = join(temp, 'report.md')
    await writeFile(path, Array.from({ length: 7 }, (_, index) => `{{slot_${String(index)}}}`).join('\n\n'))
    const args = { files: [{ path, format: 'markdown' }], gate: { p0: ['命名规范'] } }
    const shipped = await run(await mounted(), args)
    expect(shipped.content).toContain('另有 2 处同类问题未逐条列出')
    const capped = await run(await mounted({ maxFindingsPerCheck: 2 }), args)
    expect(capped.content).toContain('另有 5 处同类问题未逐条列出')
  })

  it('refuses a DOCX that expands past the configured budget', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem)
    await ctx.plugin(plugin, { maxUncompressedBytes: 4096 })
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const path = join(temp, 'repetitive.docx')
    await writeFile(path, renderDocx(`# 报告\n\n${'正文。'.repeat(4096)}\n`))
    const result = await run(ctx, { files: [{ path, format: 'docx' }], gate: { p0: ['命名规范'] } })
    expect(result.isError).toBe(false)
    expect(result.content).toContain('无法核验')
    expect(result.content).toContain('too-large')
  })

  it('checks a large DOCX under the shipped budgets', async () => {
    const ctx = await mounted()
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const path = join(temp, 'large.docx')
    await writeFile(path, renderDocx(`# 报告\n\n${Array.from({ length: 2_000 }, () => '正文内容。').join('\n\n')}\n`))
    const result = await run(ctx, { files: [{ path, format: 'docx' }], gate: { p0: ['命名规范'] } })
    expect(result.isError).toBe(false)
    expect(result.content).toContain(`${path} 通过`)
  })

  it('rejects a DOCX read budget outside its accepted bounds at load', async () => {
    for (const config of [{ maxArchiveEntries: 0 }, { maxArchiveEntries: 0x1_0000 }, { maxUncompressedBytes: 0 }]) {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(LocalFileSystem)
      await expect(ctx.plugin(plugin, config)).rejects.toThrow()
    }
  })

  it('reports the body findings of a DOCX whose other parts did not project', async () => {
    const ctx = await mounted()
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const path = join(temp, 'partial.docx')
    const encoded = new TextEncoder()
    await writeFile(path, writeZip([
      { name: 'word/document.xml', data: encoded.encode('<?xml version="1.0"?><w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>正文。</w:t></w:r></w:p></w:body></w:document>') },
      { name: 'word/header1.xml', data: encoded.encode('<w:p>未闭合') },
    ]))
    const result = await register(ctx, {
      files: [{ path, format: 'docx' }],
      gate: { p0: P0_IDS },
      // The body projected; a broken header part is still a defect in the
      // document, so the call declares why it ships anyway.
      unreadable_ack: [{ path, reason_text: '页眉部件由第三方工具写入，正文完整' }],
    })
    expect(result.value.gate.checks[0]?.status).toBe('unreadable')
    expect(result.value.gate.checks[0]?.reason).toContain('DOCX 结构报告 malformed-xml')
    expect(result.value.gate.checks[0]?.findings).toEqual([])
    expect(result.value.gate.checks[0]?.ack).toBe('页眉部件由第三方工具写入，正文完整')
    expect(result.content).toContain(`${path} 无法核验（DOCX 结构报告 malformed-xml`)
  })

  it('records the same reports as durable presentation metadata', () => {
    const tool = bareTool()
    const value: DocumentDeliverResult = {
      registered: [{ path: 'a.md', format: 'markdown' }, { path: 'deck.pdf', format: 'pdf' }],
      gate: {
        p0: ['命名规范'],
        p1: [],
        style: 'assistant-neutral',
        checks: [
          {
            path: 'a.md',
            format: 'markdown',
            status: 'checked',
            findings: [
              { check: 'empty_section', level: 'warn', detail: '第 5 行的标题 "空节" 下没有任何内容', line: 5 },
              { check: 'length_budget', level: 'warn', detail: '全文 103 字，超出声明的 80 字预算（允许 64–96 字）' },
            ],
          },
          { path: 'deck.pdf', format: 'pdf', status: 'unchecked', reason: 'pdf 格式没有文本读取器', findings: [] },
          { path: 'archive.docx', format: 'docx', status: 'unreadable', reason: 'DOCX 结构报告 not-a-zip', ack: '历史归档件', findings: [] },
        ],
      },
    }
    expect(tool.output.presentationMeta?.({}, value as never)).toEqual({ checks: value.gate.checks })
  })
})

describe('brief_ref existence', () => {
  it('warns once and still registers when the brief names no file', async () => {
    const ctx = await mounted()
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const path = join(temp, 'report.md')
    const brief = join(temp, 'brief.md')
    await writeFile(path, '# 报告\n\n正文。\n')
    const result = await run(ctx, {
      files: [{ path, format: 'markdown' }],
      gate: { p0: P0_IDS },
      brief_ref: brief,
    })
    // V-A3-1: the registration is unchanged and exactly one line reports the brief.
    expect(result.isError).toBe(false)
    expect(result.content).toContain('已登记 1 个交付文件')
    const reported = result.content.split('\n').filter(line => line.includes('brief 参考文件不存在'))
    expect(reported).toEqual([`- brief 参考文件不存在，登记继续但要修正或省略：${brief}`])
  })

  it('says nothing when the brief exists or when the call declared none', async () => {
    const ctx = await mounted()
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const path = join(temp, 'report.md')
    const brief = join(temp, 'brief.md')
    await writeFile(path, '# 报告\n\n正文。\n')
    await writeFile(brief, '# brief\n\n目标。\n')
    const present = await run(ctx, {
      files: [{ path, format: 'markdown' }],
      gate: { p0: P0_IDS },
      brief_ref: brief,
    })
    // V-A3-2: an existing brief, and an omitted one, produce no brief warning.
    expect(present.content).toContain(`brief 参考：${brief}`)
    expect(present.content).not.toContain('brief 参考文件不存在')
    const absent = await run(ctx, { files: [{ path, format: 'markdown' }], gate: { p0: P0_IDS } })
    expect(absent.content).not.toContain('brief 参考')
  })

  it('warns instead of failing when the brief path cannot be resolved', async () => {
    // A context with no `fs` service cannot resolve the path at all; the brief
    // is context rather than a deliverable, so the failure is reported the same
    // way a missing file is instead of escaping the tool.
    const warnings = await briefReferenceWarnings(new Context(), exec, 'brief.md')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('brief 参考文件无法读取')
  })
})

describe('format declaration against the extension', () => {
  it('reads a .html declared pdf as HTML, so its placeholder still blocks (V-B3-1)', async () => {
    const ctx = await mounted()
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const path = join(temp, 'report.html')
    await writeFile(path, '<h1>报告</h1><p>客户：{{client_name}}</p>\n')
    const result = await run(ctx, { files: [{ path, format: 'pdf' }], gate: { p0: P0_IDS } })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('[placeholder]')
    expect(result.content).toContain('{{client_name}}')
  })

  it('reports the contradiction beside a passing check, and the report carries the extension format', async () => {
    const ctx = await mounted()
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const path = join(temp, 'report.html')
    await writeFile(path, '<h1>报告</h1><p>正文。</p>\n')
    const result = await register(ctx, { files: [{ path, format: 'pdf' }], gate: { p0: P0_IDS } })
    // V-B3-3: the mismatch travels in `reason`, the field the studio renders.
    expect(result.value.gate.checks[0]?.status).toBe('checked')
    expect(result.value.gate.checks[0]?.format).toBe('html')
    expect(result.value.gate.checks[0]?.reason).toBe('声明格式 pdf 与扩展名 .html 不一致，已按 html 核验')
    expect(result.value.registered[0]?.format).toBe('pdf')
    expect(result.content).toContain('声明格式 pdf 与扩展名 .html 不一致，已按 html 核验')
  })

  it('reads a .md declared docx as Markdown, not as a DOCX package (V-B3-2)', async () => {
    const ctx = await mounted()
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const path = join(temp, 'report.md')
    await writeFile(path, '# 报告\n\n客户：{{client_name}}\n')
    const result = await run(ctx, { files: [{ path, format: 'docx' }], gate: { p0: P0_IDS } })
    expect(result.isError).toBe(true)
    // A DOCX reading would have reported a structure problem instead.
    expect(result.content).not.toContain('DOCX 结构报告')
    expect(result.content).toContain('[placeholder]')
    expect(result.content).toContain('{{client_name}}')
  })

  it('keeps the declared format for `other` and for an unknown extension', async () => {
    const ctx = await mounted()
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const text = join(temp, 'notes.txt')
    const other = join(temp, 'report.md')
    await writeFile(text, '# 报告\n\n正文。\n')
    await writeFile(other, '# 报告\n\n正文。\n')
    const declared = await register(ctx, { files: [{ path: text, format: 'markdown' }], gate: { p0: P0_IDS } })
    expect(declared.value.gate.checks[0]?.status).toBe('checked')
    expect(declared.value.gate.checks[0]?.reason).toBeUndefined()
    const opaque = await register(ctx, { files: [{ path: other, format: 'other' }], gate: { p0: P0_IDS } })
    expect(opaque.value.gate.checks[0]?.status).toBe('unchecked')
    expect(opaque.value.gate.checks[0]?.reason).toBe('other 格式没有文本读取器')
  })

  it('measures a declared HTML budget over the prose, not the inline stylesheet', async () => {
    const ctx = await mounted()
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const path = join(temp, 'report.html')
    // 500 characters of stylesheet around 6 characters of prose: the markup-only
    // reading would report a budget miss, the body reading stays inside it.
    await writeFile(path, `<style>${'x'.repeat(500)}</style><p>${'正'.repeat(6)}</p>`)
    const result = await run(ctx, {
      files: [{ path, format: 'html' }],
      gate: { p0: P0_IDS },
      char_budget: 8,
    })
    expect(result.isError).toBe(false)
    expect(result.content).not.toContain('[length_budget]')
    // The same declaration on a Markdown file still reports, because a Markdown
    // body is already prose.
    const markdown = join(temp, 'report.md')
    await writeFile(markdown, `# 标题\n\n${'正'.repeat(6)}\n`)
    const declared = await run(ctx, { files: [{ path: markdown, format: 'markdown' }], gate: { p0: P0_IDS }, char_budget: 2 })
    expect(declared.content).toContain('[length_budget]')
  })

  it('resolves the format a path is checked as, without a context', () => {
    expect(resolveCheckFormat('out/report.html', 'pdf')).toEqual({
      format: 'html',
      mismatch: '声明格式 pdf 与扩展名 .html 不一致，已按 html 核验',
    })
    expect(resolveCheckFormat('out/report.md', 'markdown')).toEqual({ format: 'markdown' })
    expect(resolveCheckFormat('out/report.MD', 'markdown')).toEqual({ format: 'markdown' })
    expect(resolveCheckFormat('out/report.dat', 'other')).toEqual({ format: 'other' })
    expect(resolveCheckFormat('out/report', 'pdf')).toEqual({ format: 'pdf' })
  })
})

describe('P0 checklist ids', () => {
  it('accepts every id and reports nothing when all of them are named', async () => {
    const ctx = await mounted()
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const path = join(temp, 'report.md')
    await writeFile(path, '# 报告\n\n正文。\n')
    const result = await run(ctx, { files: [{ path, format: 'markdown' }], gate: { p0: P0_IDS } })
    // V-B5-1: the id form passes, and a complete list adds no registration warning.
    expect(result.isError).toBe(false)
    expect(result.content).toContain(`P0 ${String(P0_IDS.length)} 项通过`)
    expect(result.content).not.toContain('登记提示')
  })

  it('names the ids a partial declaration left out (V-B5-2)', async () => {
    const ctx = await mounted()
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const path = join(temp, 'report.md')
    await writeFile(path, '# 报告\n\n正文。\n')
    const result = await run(ctx, {
      files: [{ path, format: 'markdown' }],
      gate: { p0: ['P0-1'] },
    })
    // V-B5-1: one known id still registers; V-B5-2: the result names what is missing.
    expect(result.isError).toBe(false)
    expect(result.content).toContain('登记提示（1）：')
    expect(result.content).toContain('缺少 P0 项：P0-2 自包含、P0-3 无占位残留、P0-4 断链、P0-5 来源、P0-6 语言')
    expect(result.content).not.toContain('未知的 P0 项')
  })

  it('reports a free-text item as unknown instead of refusing it (V-B5-1)', async () => {
    const ctx = await mounted()
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const path = join(temp, 'report.md')
    await writeFile(path, '# 报告\n\n正文。\n')
    const result = await run(ctx, {
      files: [{ path, format: 'markdown' }],
      gate: { p0: ['命名'] },
    })
    // A transcript recorded before the ids existed still registers, and the
    // unknown item names the id to use. It satisfies no checklist entry, so the
    // result also names every check the delivery has yet to state.
    expect(result.isError).toBe(false)
    expect(result.content).toContain('登记提示（2）：')
    expect(result.content).toContain('未知的 P0 项 "命名"')
    expect(result.content).toContain('P0-1 命名')
    expect(result.content).toContain('缺少 P0 项：P0-1 命名、P0-2 自包含、P0-3 无占位残留、P0-4 断链、P0-5 来源、P0-6 语言')
  })

  it('still refuses an empty P0 list', async () => {
    const ctx = await mounted()
    const result = await run(ctx, { files: [{ path: 'a.html', format: 'html' }], gate: { p0: [] } })
    expect(result.isError).toBe(true)
    expect(result.content).toContain('p0 must list')
  })

  it('keeps the constant and the delivery skill in sync', async () => {
    // The skill prints the checklist the model reads; the constant is what the
    // tool compares against. A rename on one side alone would silently turn
    // every registration into "unknown id", so this fails on the drift.
    const skill = await readFile(
      new URL('../../../bundle/web-app/skills/document/document-quality-gate/SKILL.md', import.meta.url),
      'utf8',
    )
    for (const entry of P0_CHECKLIST) expect(skill).toContain(`**${entry.id} ${entry.label}**`)
    const declared = new Set([...skill.matchAll(/\bP0-\d+\b/gu)].map(match => match[0]))
    expect([...declared].sort()).toEqual(P0_CHECKLIST.map(entry => entry.id).sort())
  })

  it('reports unknown and missing ids as pure functions', () => {
    const checklist = 'P0-1 命名、P0-2 自包含、P0-3 无占位残留、P0-4 断链、P0-5 来源、P0-6 语言'
    expect(p0ChecklistWarnings(P0_IDS)).toEqual([])
    expect(p0ChecklistWarnings(['P0-6'])).toEqual([
      '缺少 P0 项：P0-1 命名、P0-2 自包含、P0-3 无占位残留、P0-4 断链、P0-5 来源',
    ])
    // An unknown id satisfies no checklist item, so a call naming only one gets
    // both lines: the wording that missed, and every check still unstated.
    expect(p0ChecklistWarnings(['写法一'])).toEqual([
      `未知的 P0 项 "写法一"：本技能 P0 清单用稳定 id（${checklist}）`,
      `缺少 P0 项：${checklist}`,
    ])
    expect(p0ChecklistWarnings(['写法一', 'P0-1'])).toEqual([
      `未知的 P0 项 "写法一"：本技能 P0 清单用稳定 id（${checklist}）`,
      '缺少 P0 项：P0-2 自包含、P0-3 无占位残留、P0-4 断链、P0-5 来源、P0-6 语言',
    ])
    // `parseDocumentDeliverArgs` refuses an empty p0 list, so only a direct call
    // reaches this input, and it names the whole checklist as missing.
    expect(p0ChecklistWarnings([])).toEqual([`缺少 P0 项：${checklist}`])
  })
})

describe('unreadable acknowledgement', () => {
  it('warns about a reason for a path that needs none', () => {
    const checks: DeliverableCheckReport[] = [
      { path: 'report.md', format: 'markdown', status: 'checked', findings: [] },
    ]
    const resolved = resolveUnreadableReports({
      files: [{ path: 'report.md', format: 'markdown' }],
      gate: { p0: P0_IDS, p1: [] },
      unreadableAck: [
        { path: 'report.md', reasonText: '多余的原因' },
        { path: 'ghost.docx', reasonText: '未登记的路径' },
      ],
    }, checks)
    expect(resolved.reports).toEqual(checks)
    expect(resolved.warnings).toEqual([
      'unreadable_ack 的 report.md 不是无法核验状态，不需要说明原因',
      'unreadable_ack 指向未登记的路径：ghost.docx',
    ])
  })

  it('names every undeclared unreadable reason with its repair advice', () => {
    const checks: DeliverableCheckReport[] = [
      { path: 'broken.docx', format: 'docx', status: 'unreadable', reason: 'not-a-zip', findings: [] },
      { path: 'empty.docx', format: 'docx', status: 'unreadable', reason: 'no-text', findings: [] },
      { path: 'bad.docx', format: 'docx', status: 'unreadable', reason: 'malformed-xml', findings: [] },
      { path: 'odd.md', format: 'markdown', status: 'unreadable', reason: 'permission denied', findings: [] },
      { path: 'silent.md', format: 'markdown', status: 'unreadable', findings: [] },
    ]
    const spec: DocumentDeliverSpec = {
      files: checks.map(report => ({ path: report.path, format: report.format })),
      gate: { p0: P0_IDS, p1: [] },
    }
    let message = ''
    try {
      resolveUnreadableReports(spec, checks)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('- broken.docx：not-a-zip → 这不是有效的 docx 包：重新渲染或检查写盘方式')
    expect(message).toContain('- empty.docx：no-text → 包内没有可读正文：检查是否只写了页眉、图片或空正文')
    expect(message).toContain('- bad.docx：malformed-xml → 包内 XML 无法解析：重新渲染该文件')
    expect(message).toContain('- odd.md：permission denied → 修复文件后重新登记')
    expect(message).toContain('- silent.md：读取失败 → 修复文件后重新登记')
  })

  it('rejects a declared reason with a blank text', () => {
    expect(() => parseDocumentDeliverArgs({
      files: [{ path: 'a.md', format: 'markdown' }],
      gate: { p0: P0_IDS },
      unreadable_ack: [{ path: 'a.md', reason_text: '   ' }],
    })).toThrow(/unreadable_ack entry needs a non-empty path and reason_text/)
    expect(() => parseDocumentDeliverArgs({
      files: [{ path: 'a.md', format: 'markdown' }],
      gate: { p0: P0_IDS },
      unreadable_ack: [
        { path: 'a.md', reason_text: '一' },
        { path: 'a.md', reason_text: '二' },
      ],
    })).toThrow(/duplicate unreadable_ack path/)
  })
})

describe('deliverable identity', () => {
  it('gives two spellings of one file the same identity while keeping each declared path', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const ctx = await mountedAt(temp)
    const absolute = join(temp, 'report.md')
    await writeFile(absolute, '# 报告\n\n正文。\n')
    const tool = createDocumentDeliverTool(ctx, deps())
    const relative = await tool.execute(
      { files: [{ path: 'report.md', format: 'markdown' }], gate: { p0: P0_IDS } }, exec,
    ) as DocumentDeliverResult
    const spelled = await tool.execute(
      { files: [{ path: absolute, format: 'markdown' }], gate: { p0: P0_IDS } }, exec,
    ) as DocumentDeliverResult
    const canonical = await realpath(absolute)
    expect(relative.gate.checks[0]?.identity).toBe(canonical)
    expect(spelled.gate.checks[0]?.identity).toBe(canonical)
    // The declared spelling stays verbatim, so display never shows the host path.
    expect(relative.gate.checks[0]?.path).toBe('report.md')
    expect(spelled.gate.checks[0]?.path).toBe(absolute)
  })

  it('reports identity for a file it did not read, so an unchecked format is still one deliverable', async () => {
    const ctx = await mounted()
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const path = join(temp, 'deck.pptx')
    await writeFile(path, 'not really a deck')
    const result = await register(ctx, { files: [{ path, format: 'pptx' }], gate: { p0: P0_IDS } })
    expect(result.value.gate.checks[0]?.status).toBe('unchecked')
    expect(result.value.gate.checks[0]?.identity).toBe(await realpath(path))
  })

  it('records identity beside the declared path in the presentation metadata', () => {
    const tool = bareTool()
    const value: DocumentDeliverResult = {
      registered: [{ path: 'a.md', format: 'markdown' }, { path: 'b.md', format: 'markdown' }],
      gate: {
        p0: ['命名规范'],
        p1: [],
        style: 'assistant-neutral',
        checks: [
          { path: 'a.md', identity: '/work/a.md', format: 'markdown', status: 'checked', findings: [] },
          { path: 'b.md', format: 'markdown', status: 'checked', findings: [] },
        ],
      },
    }
    expect(tool.output.presentationMeta?.({}, value as never)).toEqual({
      checks: [
        { path: 'a.md', identity: '/work/a.md', format: 'markdown', status: 'checked', findings: [] },
        { path: 'b.md', format: 'markdown', status: 'checked', findings: [] },
      ],
    })
  })

  it('keeps a result recorded before identity existed parseable', () => {
    const tool = bareTool()
    // A replayed pre-identity result: the field is simply absent, and the
    // declared path stays the only key a consumer has.
    const value: DocumentDeliverResult = {
      registered: [{ path: 'a.md', format: 'markdown' }],
      gate: {
        p0: ['命名规范'],
        p1: [],
        style: 'assistant-neutral',
        checks: [{ path: 'a.md', format: 'markdown', status: 'checked', findings: [] }],
      },
    }
    const meta = tool.output.presentationMeta?.({}, value as never) as { checks: Array<Record<string, unknown>> }
    expect(meta.checks[0]).not.toHaveProperty('identity')
    expect(meta.checks[0]?.path).toBe('a.md')
  })

  it('projects every registered file and its recorded facts into the log metadata', () => {
    const tool = bareTool()
    // The delivery panel rebuilds from this projection alone, so a file, a
    // status, or a declared reason the projection drops is lost on replay.
    const value: DocumentDeliverResult = {
      registered: [
        { path: 'a.md', format: 'markdown' },
        { path: 'b.pdf', format: 'pdf' },
        { path: 'c.docx', format: 'docx' },
      ],
      gate: {
        p0: ['命名规范'],
        p1: [],
        style: 'assistant-neutral',
        checks: [
          {
            path: 'a.md',
            identity: '/work/a.md',
            format: 'markdown',
            status: 'checked',
            findings: [{ check: 'anti_pattern', level: 'warn', detail: '禁用词', line: 3 }],
          },
          { path: 'b.pdf', format: 'pdf', status: 'unchecked', reason: 'pdf 格式没有文本读取器', findings: [] },
          {
            path: 'c.docx',
            format: 'docx',
            status: 'unreadable',
            reason: 'DOCX 结构报告 word/document.xml 未投影，投影文本可能不完整',
            ack: '甲方要求交付原始 DOCX',
            findings: [],
          },
        ],
      },
    }
    const meta = tool.output.presentationMeta?.({}, value as never) as { checks: Array<Record<string, unknown>> }
    expect(meta.checks.map(check => check.path)).toEqual(['a.md', 'b.pdf', 'c.docx'])
    expect(meta.checks[0]).toMatchObject({
      identity: '/work/a.md',
      status: 'checked',
      findings: [{ check: 'anti_pattern', level: 'warn', detail: '禁用词', line: 3 }],
    })
    expect(meta.checks[1]).toMatchObject({ status: 'unchecked', reason: 'pdf 格式没有文本读取器' })
    expect(meta.checks[2]).toMatchObject({ status: 'unreadable', ack: '甲方要求交付原始 DOCX' })
  })

  it('accepts an output value carrying identity through the declared schema', async () => {
    const ctx = await mounted()
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const path = join(temp, 'report.md')
    await writeFile(path, '# 报告\n\n正文。\n')
    // Executing through `ctx.tools` validates the result against OUTPUT_SCHEMA,
    // so a field the schema omitted would fail here rather than at replay.
    const result = await run(ctx, { files: [{ path, format: 'markdown' }], gate: { p0: P0_IDS } })
    expect(result.isError).toBe(false)
  })
})

describe('unreadable acknowledgement across spellings', () => {
  it('attaches an ack written in another spelling of the same file', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const ctx = await mountedAt(temp)
    const absolute = join(temp, 'broken.docx')
    await writeFile(absolute, 'not a zip package')
    const tool = createDocumentDeliverTool(ctx, deps())
    const result = await tool.execute({
      // Declared relatively, explained absolutely: one file, two spellings.
      files: [{ path: 'broken.docx', format: 'docx' }],
      gate: { p0: P0_IDS },
      unreadable_ack: [{ path: absolute, reason_text: '历史归档件，读取器打不开' }],
    }, exec) as DocumentDeliverResult
    expect(result.gate.checks[0]?.status).toBe('unreadable')
    expect(result.gate.checks[0]?.ack).toBe('历史归档件，读取器打不开')
    expect(result.warnings).toBeUndefined()
  })

  it('does not report the same file spelled two ways as an unregistered path', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const ctx = await mountedAt(temp)
    const absolute = join(temp, 'report.md')
    await writeFile(absolute, '# 报告\n\n正文。\n')
    const tool = createDocumentDeliverTool(ctx, deps())
    const result = await tool.execute({
      files: [{ path: 'report.md', format: 'markdown' }],
      gate: { p0: P0_IDS },
      unreadable_ack: [{ path: absolute, reason_text: '多余的原因' }],
    }, exec) as DocumentDeliverResult
    // The ack names a registered file, so it is not an unregistered path; the
    // file was readable, so the "needs no reason" line still reports it.
    expect(result.gate.checks[0]?.status).toBe('checked')
    expect(result.warnings).toEqual([`unreadable_ack 的 ${absolute} 不是无法核验状态，不需要说明原因`])
  })

  it('still reports an ack that resolves to no registered file', () => {
    const checks: DeliverableCheckReport[] = [
      { path: 'report.md', identity: '/work/report.md', format: 'markdown', status: 'checked', findings: [] },
    ]
    const resolved = resolveUnreadableReports({
      files: [{ path: 'report.md', format: 'markdown' }],
      gate: { p0: P0_IDS, p1: [] },
      unreadableAck: [{ path: '/work/ghost.docx', reasonText: '未登记的路径' }],
    }, checks, new Map([['/work/ghost.docx', '/work/ghost.docx']]))
    expect(resolved.warnings).toEqual(['unreadable_ack 指向未登记的路径：/work/ghost.docx'])
  })

  it('matches on spelling alone when the caller resolved no identity', () => {
    const checks: DeliverableCheckReport[] = [
      { path: 'broken.docx', identity: '/work/broken.docx', format: 'docx', status: 'unreadable', reason: 'not-a-zip', findings: [] },
    ]
    // No ackIdentity map: a spelling match still attaches, and a differently
    // spelled ack for the same file cannot be recognized without one.
    const matched = resolveUnreadableReports({
      files: [{ path: 'broken.docx', format: 'docx' }],
      gate: { p0: P0_IDS, p1: [] },
      unreadableAck: [{ path: 'broken.docx', reasonText: '历史归档件' }],
    }, checks)
    expect(matched.reports[0]?.ack).toBe('历史归档件')
    expect(() => resolveUnreadableReports({
      files: [{ path: 'broken.docx', format: 'docx' }],
      gate: { p0: P0_IDS, p1: [] },
      unreadableAck: [{ path: '/work/broken.docx', reasonText: '历史归档件' }],
    }, checks)).toThrow(/无法核验，且没有 unreadable_ack 说明原因/)
  })

  it('resolves ack identities and leaves an unresolvable ack to spelling matching', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-deliver-'))
    const ctx = await mountedAt(temp)
    const absolute = join(temp, 'report.md')
    await writeFile(absolute, '# 报告\n\n正文。\n')
    const underFile = join(absolute, 'child.md')
    const spec: DocumentDeliverSpec = {
      files: [{ path: 'report.md', format: 'markdown' }],
      gate: { p0: P0_IDS, p1: [] },
      unreadableAck: [
        { path: absolute, reasonText: '一' },
        // A path through a regular file can never resolve: the ack keeps its
        // spelling, and the caller still learns it names no registered file.
        { path: underFile, reasonText: '二' },
      ],
    }
    const identities = await resolveAckIdentities(ctx, exec, spec)
    expect(identities.get(absolute)).toBe(await realpath(absolute))
    expect(identities.has(underFile)).toBe(false)
  })

  it('propagates cancellation instead of reading it as an unresolvable ack path', async () => {
    const ctx = await mounted()
    const aborted = new AbortController()
    aborted.abort()
    const spec: DocumentDeliverSpec = {
      files: [{ path: 'report.md', format: 'markdown' }],
      gate: { p0: P0_IDS, p1: [] },
      unreadableAck: [{ path: 'report.md', reasonText: '一' }],
    }
    await expect(resolveAckIdentities(ctx, { ...exec, signal: aborted.signal }, spec))
      .rejects.toThrow(/abort/i)
  })
})
