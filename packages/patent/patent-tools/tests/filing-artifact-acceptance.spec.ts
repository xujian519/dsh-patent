/**
 * ADR-002 验收 1–5 的集成测试。
 *
 * 装配器只把说明书收成段落。验收 5 还要钉表题，因此在已通过校验的草案上
 * 补两张具体实施方式表格，再把这一份 SpecDraft 同时交给 HTML 与 DOCX。
 * DOCX 的项号、图号与表题在交给 Python 成文引擎之前写入 content.json；
 * 本文件在 build.py 边界读取这份内容，不启动成文引擎。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  DisclosureAssemblyError,
  assembleDisclosureSpecDraft,
  isJsonRecord,
  validateSpecDraft,
  type SpecDraft,
} from '@deepseek-ai/dsh-patent-core'
import { DocumentRenderError, renderPatentDocument } from '@deepseek-ai/dsh-patent-document'
import {
  DEFAULT_ENGINE_TIMEOUT_MS,
  PatentFilingError,
  buildFiling,
  contentFromDraft,
  defaultSpecPath,
  defaultTemplatePath,
  type BuildEngineOptions,
} from '@deepseek-ai/dsh-patent-filing'
import SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessOutputReader,
  SubprocessSpawnSpec,
  SubprocessTerminalEnvironment,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type { GraphvizRenderOutcome, GraphvizRenderSpec } from '../src/figure/graphviz-renderer.ts'
import { PatentToolError } from '../src/error.ts'
import { createGeneratePatentFigureTool } from '../src/tool/generate-patent-figure.ts'

const signal = new AbortController().signal
const exec = { signal } as never

const created: string[] = []
const contexts: Context[] = []

const BUILD_REPORT = JSON.stringify({
  status: 'ok',
  out: '/out/a.docx',
  sections: [{ key: 'abstract', paragraphs: 1, figures: 0 }],
  numbering_total: 0,
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

const VERIFY_REPORT = JSON.stringify({
  passed: true,
  errors: [],
  info: {
    sections: 5,
    headers: ['说明书摘要'],
    paragraphs: 10,
    claims: 2,
    numbering: 'none',
    tables: 2,
    figures: 2,
    layout: { abstract: { paragraphs: 1, figures: 1 } },
    template: { sections: 5, sizes_pt: [12], line_spacings: [1.5] },
  },
})

/** 一次成文时记下 build.py 收到的 content.json，并按引擎替身写好成品与 PDF。 */
class ChannelSubprocess extends SubprocessRuntime {
  contentJson: string | undefined

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const argv = spec.argv
    const pdfArg = argv.find(arg => arg.startsWith('--print-to-pdf='))
    if (pdfArg !== undefined) {
      writeFileSync(pdfArg.slice('--print-to-pdf='.length), '%PDF-1.4')
      return stdoutHandle('')
    }
    const script = argv[1] ?? ''
    if (script.endsWith('build.py')) {
      const contentPath = argv[argv.indexOf('--content') + 1]
      const outPath = argv[argv.indexOf('--out') + 1]
      if (contentPath === undefined || outPath === undefined) {
        throw new Error('build.py 缺少 --content 或 --out')
      }
      this.contentJson = readFileSync(contentPath, 'utf8')
      writeFileSync(outPath, 'docx')
      return stdoutHandle(BUILD_REPORT)
    }
    if (script.endsWith('verify.py')) return stdoutHandle(VERIFY_REPORT)
    throw new Error(`意外的子进程：${argv.join(' ')}`)
  }

  override resolveExecutable(): Promise<string> {
    return Promise.resolve('/usr/bin/python3')
  }

  override terminalEnvironment(): Promise<SubprocessTerminalEnvironment> {
    return Promise.resolve({ platform: 'posix' })
  }

  override spawnTerminal(_spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return Promise.reject(new Error('本用例不分配终端'))
  }
}

function stdoutHandle(stdout: string): SubprocessHandle {
  const reader = (text: string): SubprocessOutputReader => ({
    readFrom: (from: number) => ({ text: text.slice(from), nextOffset: text.length, lossy: false }),
  })
  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    collected: { stdout: reader(stdout), stderr: reader('') },
    done: Promise.resolve({ exitCode: 0, signal: null }),
    terminate() {},
    waitForExit: () => Promise.resolve(true),
  }
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

function channelProcess(): ChannelSubprocess {
  const ctx = new Context()
  contexts.push(ctx)
  return new ChannelSubprocess(ctx)
}

afterEach(async () => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

function writeFigures(dir: string): [string, string] {
  const first = join(dir, 'fig1.png')
  const second = join(dir, 'fig2.png')
  writeFileSync(first, 'png')
  writeFileSync(second, 'png')
  return [first, second]
}

/** 披露链成功终态。文本键与 T2 夹具一致，并带两幅附图与摘要附图号，供验收 5 对图号。 */
function disclosureState(figureFiles: readonly string[]): Record<string, unknown> {
  return {
    caseId: 'CN2026-0001',
    title: '不该采用的名称',
    draft_title: '一种检测装置',
    applicant: '示例申请人',
    inventor: '示例发明人',
    agent: '示例代理机构',
    date: '2026-11-24',
    claims_draft: [
      '1. 一种检测装置，其特征在于，包括壳体和传感器。',
      '2. 根据权利要求1所述的检测装置，其特征在于，所述传感器为光学传感器。',
    ].join('\n\n'),
    abstract: '本发明公开了一种检测装置。关键词：检测装置',
    figure_files: [...figureFiles],
    abstractFigure: '2',
    specification: [
      '**说明书草案（一种检测装置）**',
      '',
      '摘要: 摘要行不作为装配来源。',
      '',
      '## 技术领域',
      '',
      '本发明涉及机械技术领域，尤其涉及一种检测装置。',
      '',
      '## 背景技术',
      '',
      '现有检测装置的检测精度不足。',
      '',
      '## 发明内容',
      '',
      '本发明要解决的技术问题是：检测精度不足',
      '',
      '## 附图说明',
      '',
      '图1为整体结构示意图',
      '图2为剖视示意图',
      '',
      '## 具体实施方式',
      '',
      '实施例1：本实施例提供一种检测装置，包括壳体和传感器。',
      '',
      '**警告**',
      '- 这条警告不得进入具体实施方式',
    ].join('\n'),
    report: '披露分析报告不得进入草案',
  }
}

function assembledDraft(figureFiles: readonly string[]): SpecDraft {
  return assembleDisclosureSpecDraft(disclosureState(figureFiles))
}

/** 在装配结果上补两张表。表只进具体实施方式，装配器本身不产出表格。 */
function draftWithTables(figureFiles: readonly string[]): SpecDraft {
  const assembled = assembledDraft(figureFiles)
  return validateSpecDraft({
    ...assembled,
    sections: {
      ...assembled.sections,
      embodiment: [
        ...assembled.sections.embodiment,
        { kind: 'table', name: '参数对照', header: ['项目', '取值'], rows: [['精度', '0.1 mm']] },
        { kind: 'paragraph', text: '参数见上表。' },
        { kind: 'table', name: '部件清单', header: ['标记', '名称'], rows: [['1', '壳体']] },
      ],
    },
  })
}

function expectGap(state: Record<string, unknown>, fragment: string): void {
  let caught: unknown
  try {
    assembleDisclosureSpecDraft(state)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(DisclosureAssemblyError)
  if (!(caught instanceof DisclosureAssemblyError)) return
  expect(caught.gaps.some(gap => gap.includes(fragment))).toBe(true)
}

function filingOptions(subprocess: ChannelSubprocess, workRoot?: string): BuildEngineOptions {
  return {
    subprocess,
    pythonPath: '/usr/bin/python3',
    specPath: defaultSpecPath(),
    templatePath: defaultTemplatePath(),
    figureScale: 3,
    timeoutMs: DEFAULT_ENGINE_TIMEOUT_MS,
    ...(workRoot === undefined ? {} : { workRoot }),
  }
}

function renderOptions(subprocess: ChannelSubprocess, cwd: string, workRoot?: string) {
  const chromePath = join(cwd, 'chrome')
  writeFileSync(chromePath, '')
  return {
    subprocess,
    chromePath,
    ...(workRoot === undefined ? {} : { workRoot }),
  }
}

const flowSteps = [
  { id: 'start', label: '开始', shape: 'ellipse' as const, next: ['end'] },
  { id: 'end', label: '结束', shape: 'ellipse' as const, next: [] },
]

function okRenderer(): (spec: GraphvizRenderSpec) => Promise<GraphvizRenderOutcome> {
  return (spec) => {
    const out = join(spec.outputDir, `${spec.filename}.${spec.format}`)
    writeFileSync(out, '<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    return Promise.resolve({ ok: true, path: out })
  }
}

interface ChannelMarks {
  claimNumbers: string[]
  claimBodies: string[]
  figureLines: string[]
  tableTitles: string[]
  abstractFigure: string | undefined
}

function marksFromHtml(html: string): ChannelMarks {
  return {
    claimNumbers: [...html.matchAll(/<span class="claim-num">(\d+)\.<\/span>/g)].map(match => match[1] ?? ''),
    claimBodies: [...html.matchAll(/<span class="claim-num">\d+\.<\/span>([^<]*)/g)].map(match => match[1] ?? ''),
    figureLines: [...html.matchAll(/<li>(图\d+为[^<]*)<\/li>/g)].map(match => match[1] ?? ''),
    tableTitles: [...html.matchAll(/<caption>(表 \d+ · [^<]*)<\/caption>/g)].map(match => match[1] ?? ''),
    abstractFigure: /摘要附图：<\/strong>图 <span class="mono">(\d+)<\/span>/.exec(html)?.[1],
  }
}

function readStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} 不是数组`)
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(`${label} 含非字符串`)
    items.push(item)
  }
  return items
}

function marksFromDocx(json: string): ChannelMarks {
  const parsed: unknown = JSON.parse(json)
  if (!isJsonRecord(parsed)) throw new Error('docx 通道内容不是对象')
  const claims = readStringList(parsed.claims, 'claims')
  if (!Array.isArray(parsed.specification)) throw new Error('specification 不是数组')
  const texts: string[] = []
  for (const node of parsed.specification) {
    if (!isJsonRecord(node) || node.kind !== 'p' || typeof node.text !== 'string') continue
    texts.push(node.text)
  }
  const claimNumbers: string[] = []
  const claimBodies: string[] = []
  for (const claim of claims) {
    const splitAt = claim.indexOf('. ')
    if (splitAt <= 0) throw new Error(`权项缺少项号前缀：${claim}`)
    claimNumbers.push(claim.slice(0, splitAt))
    claimBodies.push(claim.slice(splitAt + 2))
  }
  const index = parsed.abstractFigureIndex
  if (index !== undefined && typeof index !== 'number') throw new Error('abstractFigureIndex 不是数字')
  return {
    claimNumbers,
    claimBodies,
    figureLines: texts.filter(text => /^图\d+为/.test(text)),
    tableTitles: texts.filter(text => /^表 \d+ · /.test(text)),
    abstractFigure: typeof index === 'number' ? String(index + 1) : undefined,
  }
}

function absentOldDefaults(cwd: string): void {
  expect(existsSync(join(cwd, '.dsh'))).toBe(false)
  expect(existsSync(join(cwd, 'data', 'cases'))).toBe(false)
  expect(existsSync(join(cwd, 'patent', 'figures'))).toBe(false)
}

function readFigurePath(value: unknown): string {
  if (!isJsonRecord(value) || typeof value.absolutePath !== 'string') {
    throw new Error('附图结果没有 absolutePath')
  }
  return value.absolutePath
}

/** 写入必须失败，并点名案卷目录无法解析。 */
async function expectUnresolved(run: () => Promise<unknown>, errorClass: new (...args: never[]) => Error): Promise<void> {
  let caught: unknown
  try {
    await run()
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(errorClass)
  if (!(caught instanceof Error)) return
  expect(caught.message).toMatch(/无法解析案卷目录/)
}

describe('ADR-002 申请文件产物验收', () => {
  it('披露成功终态装配后通过校验，HTML、PDF、DOCX 与附图写入案卷目录，且两通道项号、图号、表题一致', async () => {
    const cwd = tempDir('dsh-adr-cwd-')
    const workRoot = tempDir('dsh-adr-work-')
    const figures = writeFigures(cwd)
    const assembled = assembledDraft(figures)
    expect(validateSpecDraft(assembled)).toEqual(assembled)
    expect(assembled.claims).toEqual([
      '一种检测装置，其特征在于，包括壳体和传感器。',
      '根据权利要求1所述的检测装置，其特征在于，所述传感器为光学传感器。',
    ])
    expect(assembled.sections.drawingDescriptions).toEqual([
      { kind: 'list', items: ['整体结构示意图', '剖视示意图'] },
    ])
    expect(assembled.abstractFigure).toBe('2')
    expect(assembled.meta.title).toBe('一种检测装置')
    const assembledText = JSON.stringify(assembled)
    expect(assembledText).not.toContain('这条警告不得进入具体实施方式')
    expect(assembledText).not.toContain('不该采用的名称')
    expect(assembledText).not.toContain('披露分析报告不得进入草案')
    expect(assembledText).not.toContain('摘要行不作为装配来源')

    const draft = draftWithTables(figures)
    expect(validateSpecDraft(draft)).toEqual(draft)
    const subprocess = channelProcess()
    const matterDir = join(workRoot, 'CN2026-0001', '04-撰写')
    const rendered = await renderPatentDocument(
      {
        template: 'claims-spec',
        outputName: '权利要求书与说明书',
        caseId: 'CN2026-0001',
        format: 'both',
        draft,
      },
      cwd,
      renderOptions(subprocess, cwd, workRoot),
    )
    expect(rendered.htmlPath).toBe(join(matterDir, '权利要求书与说明书.html'))
    expect(rendered.pdfPath).toBe(join(matterDir, '权利要求书与说明书.pdf'))
    expect(existsSync(rendered.htmlPath)).toBe(true)
    expect(rendered.pdfPath !== undefined && existsSync(rendered.pdfPath)).toBe(true)
    expect(rendered.pdfError).toBeUndefined()

    const filed = await buildFiling(
      { content: contentFromDraft(draft), outputName: '申请文件', caseId: 'CN2026-0001' },
      filingOptions(subprocess, workRoot),
      cwd,
      signal,
    )
    expect(filed.docxPath).toBe(join(matterDir, '申请文件.docx'))
    expect(existsSync(filed.docxPath)).toBe(true)
    if (subprocess.contentJson === undefined) throw new Error('docx 通道没有把内容交给成文引擎')

    const figure = createGeneratePatentFigureTool({ render: okRenderer(), cwd, workRoot })
    const figurePath = readFigurePath(await figure.execute({
      figure_type: 'flowchart',
      steps: flowSteps,
      case_id: 'CN2026-0001',
      filename: 'fig-flow',
      persist_index: false,
    }, exec))
    expect(figurePath).toBe(join(matterDir, 'fig-flow.svg'))
    expect(existsSync(figurePath)).toBe(true)
    absentOldDefaults(cwd)

    const htmlText = readFileSync(rendered.htmlPath, 'utf8')
    const html = marksFromHtml(htmlText)
    const docx = marksFromDocx(subprocess.contentJson)
    expect(html.claimNumbers).toEqual(['1', '2'])
    expect(docx.claimNumbers).toEqual(html.claimNumbers)
    expect(docx.claimBodies).toEqual(draft.claims)
    expect(html.claimBodies).toEqual(draft.claims)
    expect(html.figureLines).toEqual(['图1为整体结构示意图；', '图2为剖视示意图。'])
    expect(docx.figureLines).toEqual(html.figureLines)
    expect(html.tableTitles).toEqual(['表 1 · 参数对照', '表 2 · 部件清单'])
    expect(docx.tableTitles).toEqual(html.tableTitles)
    expect(html.abstractFigure).toBe('2')
    expect(docx.abstractFigure).toBe(html.abstractFigure)
    expect(htmlText).not.toContain('这条警告不得进入具体实施方式')
    expect(htmlText).not.toContain('不该采用的名称')
  })

  it('改掉必要字段或丢掉关键文本键时失败并点名缺口', () => {
    const cwd = tempDir('dsh-adr-gap-')
    const figures = writeFigures(cwd)
    const dropped = disclosureState(figures)
    delete dropped.claims_draft
    expectGap(dropped, 'claims_draft 缺失')
    expectGap({ ...disclosureState(figures), applicant: '  \n' }, 'applicant 为空')
    const missingFigures = disclosureState(figures)
    delete missingFigures.figure_files
    expectGap(missingFigures, 'figure_files 缺失')
  })

  it('工作目录已含案卷日志且未传输出目录时，HTML、DOCX 与附图写在该目录内', async () => {
    const cwd = tempDir('dsh-adr-matter-')
    writeFileSync(join(cwd, '_matter-log.md'), '# log\n')
    const draft = draftWithTables(writeFigures(cwd))
    const subprocess = channelProcess()
    const matterDir = join(cwd, '04-撰写')
    const rendered = await renderPatentDocument(
      {
        template: 'claims-spec',
        outputName: '权利要求书与说明书',
        format: 'html',
        draft,
      },
      cwd,
      renderOptions(subprocess, cwd),
    )
    const filed = await buildFiling(
      { content: contentFromDraft(draft), outputName: '申请文件' },
      filingOptions(subprocess),
      cwd,
      signal,
    )
    const figurePath = readFigurePath(await createGeneratePatentFigureTool({
      render: okRenderer(),
      cwd,
    }).execute({
      figure_type: 'flowchart',
      steps: flowSteps,
      filename: 'fig-flow',
      persist_index: false,
    }, exec))
    expect(rendered.htmlPath).toBe(join(matterDir, '权利要求书与说明书.html'))
    expect(filed.docxPath).toBe(join(matterDir, '申请文件.docx'))
    expect(figurePath).toBe(join(matterDir, 'fig-flow.svg'))
    expect(existsSync(rendered.htmlPath)).toBe(true)
    expect(existsSync(filed.docxPath)).toBe(true)
    expect(existsSync(figurePath)).toBe(true)
    expect(existsSync(join(cwd, '.dsh'))).toBe(false)
    expect(existsSync(join(cwd, 'data', 'cases'))).toBe(false)
  })

  it('显式传入旧路径时仍写到该旧位置', async () => {
    const cwd = tempDir('dsh-adr-old-')
    const workRoot = tempDir('dsh-adr-old-work-')
    const draft = draftWithTables(writeFigures(cwd))
    const subprocess = channelProcess()
    const rendered = await renderPatentDocument(
      {
        template: 'claims-spec',
        outputName: '权利要求书与说明书',
        caseId: 'CN2026-0001',
        outputDir: join('.dsh', 'documents'),
        format: 'html',
        draft,
      },
      cwd,
      renderOptions(subprocess, cwd, workRoot),
    )
    const filed = await buildFiling(
      {
        content: contentFromDraft(draft),
        outputName: '申请文件',
        caseId: 'CN2026-0001',
        outputDir: join('data', 'cases', 'CN2026-0001', 'outputs'),
      },
      filingOptions(subprocess, workRoot),
      cwd,
      signal,
    )
    const explicitFigures = join(cwd, 'patent', 'figures')
    const figurePath = readFigurePath(await createGeneratePatentFigureTool({
      render: okRenderer(),
      cwd,
      workRoot,
      outputDir: explicitFigures,
    }).execute({
      figure_type: 'flowchart',
      steps: flowSteps,
      case_id: 'CN2026-0001',
      filename: 'fig-flow',
      persist_index: false,
    }, exec))
    expect(rendered.htmlPath).toBe(join(cwd, '.dsh', 'documents', '权利要求书与说明书.html'))
    expect(filed.docxPath).toBe(join(cwd, 'data', 'cases', 'CN2026-0001', 'outputs', '申请文件.docx'))
    expect(figurePath).toBe(join(explicitFigures, 'fig-flow.svg'))
    expect(existsSync(rendered.htmlPath)).toBe(true)
    expect(existsSync(filed.docxPath)).toBe(true)
    expect(existsSync(figurePath)).toBe(true)
    expect(existsSync(join(workRoot, 'CN2026-0001'))).toBe(false)
  })

  it('无法解析案卷目录且无覆盖时失败，不回落旧默认', async () => {
    for (const caseId of ['CN2026-0001', undefined] as const) {
      const cwd = tempDir('dsh-adr-refuse-')
      const draft = draftWithTables(writeFigures(cwd))
      const subprocess = channelProcess()
      const caseFields = caseId === undefined ? {} : { caseId }
      await expectUnresolved(() => renderPatentDocument(
        {
          template: 'claims-spec',
          outputName: '权利要求书与说明书',
          ...caseFields,
          format: 'html',
          draft,
        },
        cwd,
        renderOptions(subprocess, cwd),
      ), DocumentRenderError)
      await expectUnresolved(() => buildFiling(
        {
          content: contentFromDraft(draft),
          outputName: '申请文件',
          ...caseFields,
        },
        filingOptions(subprocess),
        cwd,
        signal,
      ), PatentFilingError)
      await expectUnresolved(() => createGeneratePatentFigureTool({ render: okRenderer(), cwd }).execute({
        figure_type: 'flowchart',
        steps: flowSteps,
        ...(caseId === undefined ? {} : { case_id: caseId }),
        filename: 'fig-flow',
        persist_index: false,
      }, exec), PatentToolError)
      absentOldDefaults(cwd)
    }
  })
})
