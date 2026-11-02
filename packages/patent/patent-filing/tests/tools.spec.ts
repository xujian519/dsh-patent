import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createBuildPatentFilingTool,
  createVerifyPatentFilingTool,
  defaultSpecPath,
  defaultTemplatePath,
  renderBuildResult,
  renderVerifyResult,
} from '@deepseek-ai/dsh-patent-filing'
import type { FilingBuildResult, FilingVerifyResult } from '@deepseek-ai/dsh-patent-filing'
import { argvOf, fakeSubprocess, stdoutHandle } from './helpers.ts'

/** A build report as `build.py` prints it. */
const BUILD_REPORT = JSON.stringify({
  status: 'ok',
  out: '/out/a.docx',
  sections: [
    { key: 'abstract', paragraphs: 1, figures: 0 },
    { key: 'figures', paragraphs: 0, figures: 5 },
  ],
  numbering_total: 100,
  upstream_numbering_seen: 100,
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

/** A failing verify report as `verify.py` prints it. */
const VERIFY_FAIL_REPORT = JSON.stringify({
  passed: false,
  errors: ['分节数 4 ≠ 期望 5', '内部痕迹未清除：\'待签\''],
  info: {
    sections: 4,
    headers: ['说明书摘要'],
    paragraphs: 12,
    claims: 8,
    numbering: '1..3',
    tables: 1,
    figures: 6,
    layout: { abstract: { paragraphs: 1, figures: 0 } },
    template: { sections: 5, sizes_pt: [12], line_spacings: [1.5] },
  },
})

/** 最小可通过校验的受控草案（claims 不带项号）。 */
function draftFixture(figure: string): Record<string, unknown> {
  return {
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
  }
}

describe('build_patent_filing tool', () => {
  it('declares the defineTool shape', () => {
    const tool = createBuildPatentFilingTool({
      subprocess: fakeSubprocess(() => stdoutHandle(BUILD_REPORT)).spawner,
      pythonPath: '/usr/bin/python3',
      specPath: defaultSpecPath(),
      templatePath: defaultTemplatePath(),
      defaultOutputDir: '.dsh/documents',
      figureScale: 3,
      timeoutMs: 1_000,
    })
    expect(tool.name).toBe('build_patent_filing')
    expect(tool.description).toContain('申请文件')
    const parameters = tool.parameters as { properties?: Record<string, unknown> }
    expect(parameters.properties).toBeDefined()
    expect(parameters.properties).toHaveProperty('draft')
    expect(parameters.properties).toHaveProperty('outputName')
    expect(parameters.properties).toHaveProperty('caseId')
    expect(parameters.properties).toHaveProperty('outputDir')
    expect(typeof tool.output.render).toBe('function')
    expect(typeof tool.execute).toBe('function')
  })

  it('builds through the engine and returns the canonical value', async () => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-filing-tool-'))
    const figure = join(work, 'fig1.png')
    writeFileSync(figure, 'png')
    const { spawner, calls } = fakeSubprocess(() => stdoutHandle(BUILD_REPORT))
    try {
      const tool = createBuildPatentFilingTool({
        subprocess: spawner,
        pythonPath: '/usr/bin/python3',
        specPath: defaultSpecPath(),
        templatePath: defaultTemplatePath(),
        defaultOutputDir: work,
        figureScale: 3,
        timeoutMs: 1_000,
        chromePath: '/usr/bin/chrome',
      })
      const value = await tool.execute({
        draft: draftFixture(figure),
        outputName: '案卷_申请文件',
      }, { signal: new AbortController().signal } as never) as FilingBuildResult

      expect(value.numberingTotal).toBe(100)
      expect(value.upstreamNumberingSeen).toBe(100)
      expect(value.docxPath).toBe(join(work, '案卷_申请文件.docx'))
      expect(value.templateFingerprint).toMatch(/^[0-9a-f]{64}$/)
      expect(argvOf(calls[0]!)).toContain('--out')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('passes an explicit output directory through, overriding the case convention', async () => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-filing-tool-'))
    const figure = join(work, 'fig1.png')
    writeFileSync(figure, 'png')
    const explicit = join(work, 'deliver')
    const savedCwd = process.cwd()
    process.chdir(work)
    try {
      const tool = createBuildPatentFilingTool({
        subprocess: fakeSubprocess(() => stdoutHandle(BUILD_REPORT)).spawner,
        pythonPath: '/usr/bin/python3',
        specPath: defaultSpecPath(),
        templatePath: defaultTemplatePath(),
        defaultOutputDir: work,
        figureScale: 3,
        timeoutMs: 1_000,
      })
      const value = await tool.execute({
        draft: draftFixture(figure),
        outputName: 'out',
        caseId: 'A-1',
        outputDir: explicit,
      }, { signal: new AbortController().signal } as never) as FilingBuildResult
      expect(value.docxPath).toBe(join(explicit, 'out.docx'))
    } finally {
      process.chdir(savedCwd)
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('takes the deployment default output directory when neither caseId nor outputDir is given', async () => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-filing-tool-'))
    const figure = join(work, 'fig1.png')
    writeFileSync(figure, 'png')
    try {
      const tool = createBuildPatentFilingTool({
        subprocess: fakeSubprocess(() => stdoutHandle(BUILD_REPORT)).spawner,
        pythonPath: '/usr/bin/python3',
        specPath: defaultSpecPath(),
        templatePath: defaultTemplatePath(),
        defaultOutputDir: work,
        figureScale: 3,
        timeoutMs: 1_000,
      })
      // 无 caseId、无 outputDir：覆盖缺省目录分支。
      const value = await tool.execute({
        draft: draftFixture(figure),
        outputName: 'default-dir',
      }, { signal: new AbortController().signal } as never) as FilingBuildResult
      expect(value.docxPath).toBe(join(work, 'default-dir.docx'))
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('rejects the legacy content parameter at the executor argument gate', async () => {
    const tool = createBuildPatentFilingTool({
      subprocess: fakeSubprocess(() => stdoutHandle(BUILD_REPORT)).spawner,
      pythonPath: '/usr/bin/python3',
      specPath: defaultSpecPath(),
      templatePath: defaultTemplatePath(),
      defaultOutputDir: '.dsh/documents',
      figureScale: 3,
      timeoutMs: 1_000,
    })
    // content 已不在参数 schema 里：执行器按缺 required draft 拒绝，不静默忽略旧键。
    await expect(tool.execute({
      content: { abstract: ['a'], claims: ['1. a'], specification: [{ kind: 'p', text: 'x' }], figures: ['f.png'] },
      outputName: 'legacy',
    }, { signal: new AbortController().signal } as never)).rejects.toThrow(/missing required property "draft"/)
  })

  it('rejects an invalid draft with the slot-listing validation message', async () => {
    const tool = createBuildPatentFilingTool({
      subprocess: fakeSubprocess(() => stdoutHandle(BUILD_REPORT)).spawner,
      pythonPath: '/usr/bin/python3',
      specPath: defaultSpecPath(),
      templatePath: defaultTemplatePath(),
      defaultOutputDir: '.dsh/documents',
      figureScale: 3,
      timeoutMs: 1_000,
    })
    await expect(tool.execute({
      draft: { claims: ['1. 自带项号的一种装置'] },
      outputName: 'bad-draft',
    }, { signal: new AbortController().signal } as never)).rejects.toThrow(/claims\[0\] 自带项号/)
  })

  it('renders the canonical result as pure model-facing prose', () => {
    const value: FilingBuildResult = {
      docxPath: '/out/a.docx',
      figures: ['/out/f1.png', '/out/f2.png'],
      sections: [{ key: 'abstract', paragraphs: 1, figures: 0 }, { key: 'figures', paragraphs: 0, figures: 2 }],
      numberingTotal: 100,
      upstreamNumberingSeen: 0,
      templateStyle: {
        sectionCount: 5,
        eastAsia: '宋体',
        ascii: 'Times New Roman',
        cs: 'Times New Roman',
        sizePt: 12,
        lineSpacing: 1.5,
        firstLineIndent: 0,
        sizesPt: [12],
        lineSpacings: [1.5],
      },
      templateFingerprint: 'a'.repeat(64),
    }
    const text = renderBuildResult(value)
    expect(text).toContain('成品：/out/a.docx')
    expect(text).toContain('宋体 / Times New Roman 12pt 行距 1.5 首行缩进 0pt')
    expect(text).toContain('abstract 1 段/0 图 · figures 0 段/2 图')
    expect(text).toContain('段落编号：100 条（源件已带编号 0 条）')
    expect(text).toContain('附图：2 张')
    expect(text).toContain(`模板指纹：sha256 ${'a'.repeat(16)}…`)
  })
})

describe('verify_patent_filing tool', () => {
  it('declares the defineTool shape', () => {
    const tool = createVerifyPatentFilingTool({
      subprocess: fakeSubprocess(() => stdoutHandle(VERIFY_FAIL_REPORT)).spawner,
      pythonPath: '/usr/bin/python3',
      specPath: defaultSpecPath(),
      templatePath: defaultTemplatePath(),
      timeoutMs: 1_000,
    })
    expect(tool.name).toBe('verify_patent_filing')
    expect(tool.description).toContain('静默缺陷')
    const parameters = tool.parameters as { properties?: Record<string, unknown> }
    expect(parameters.properties).toHaveProperty('docx')
    expect(typeof tool.execute).toBe('function')
  })

  it('executes the assertion run and returns failures as the canonical value', async () => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-filing-verifytool-'))
    const docx = join(work, 'a.docx')
    writeFileSync(docx, 'x')
    try {
      const tool = createVerifyPatentFilingTool({
        subprocess: fakeSubprocess(() => stdoutHandle(VERIFY_FAIL_REPORT)).spawner,
        pythonPath: '/usr/bin/python3',
        specPath: defaultSpecPath(),
        templatePath: defaultTemplatePath(),
        timeoutMs: 1_000,
      })
      const value = await tool.execute({ docx }, { signal: new AbortController().signal } as never) as FilingVerifyResult
      expect(value.passed).toBe(false)
      expect(value.errors).toHaveLength(2)
      expect(value.info.sections).toBe(4)
      expect(existsSync(docx)).toBe(true)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('returns failed assertions through the tool for a document that fails them', async () => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-filing-verifyrender-'))
    const docx = join(work, 'a.docx')
    writeFileSync(docx, 'x')
    try {
      const tool = createVerifyPatentFilingTool({
        subprocess: fakeSubprocess(() => stdoutHandle(VERIFY_FAIL_REPORT)).spawner,
        pythonPath: '/usr/bin/python3',
        specPath: defaultSpecPath(),
        templatePath: defaultTemplatePath(),
        timeoutMs: 1_000,
      })
      const value = await tool.execute({ docx }, { signal: new AbortController().signal } as never) as FilingVerifyResult
      expect(value.passed).toBe(false)
      expect(value.errors).toContain('分节数 4 ≠ 期望 5')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('renders a passing result and a failing result', () => {
    const base: FilingVerifyResult = {
      passed: true,
      errors: [],
      docxPath: '/out/a.docx',
      templateFingerprint: 'b'.repeat(64),
      info: {
        sections: 5,
        headers: ['说明书摘要', '摘要附图'],
        paragraphs: 123,
        claims: 8,
        numbering: '1..100',
        tables: 1,
        figures: 6,
        layout: [{ key: 'abstract', paragraphs: 1, figures: 0 }],
      },
    }
    const passing = renderVerifyResult(base)
    expect(passing).toContain('✅ 断言全部通过：/out/a.docx')
    expect(passing).toContain('分节 5（说明书摘要 / 摘要附图）')
    expect(passing).toContain('段落 123 · 权项 8 · 编号 1..100 · 表格 1 · 附图 6')
    expect(passing).toContain('各节归属：abstract 1 段/0 图')
    expect(passing).toContain(`模板指纹：sha256 ${'b'.repeat(16)}…`)

    const failing = renderVerifyResult({ ...base, passed: false, errors: ['分节数 4 ≠ 期望 5'] })
    expect(failing).toContain('❌ 1 项未通过：/out/a.docx')
    expect(failing).toContain('  - 分节数 4 ≠ 期望 5')
  })
})
