import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  DEFAULT_ENGINE_TIMEOUT_MS,
  DEFAULT_OUTPUT_DIR,
  PatentFilingError,
  assertSafeOutputName,
  buildFiling,
  defaultSpecPath,
  defaultTemplatePath,
  getEngineDir,
  resolveOutputDir,
  verifyFiling,
} from '@deepseek-ai/dsh-patent-filing'
import type { BuildEngineOptions, FilingContent, VerifyEngineOptions } from '@deepseek-ai/dsh-patent-filing'
import { argvOf, fakeSubprocess, stdoutHandle } from './helpers.ts'

/** A valid build report as `build.py` prints it. */
function buildReport(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'ok',
    out: '/out/a.docx',
    sections: [{ key: 'abstract', paragraphs: 1, figures: 0 }],
    numbering_total: 7,
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
    ...overrides,
  })
}

/** A valid verify report as `verify.py` prints it. */
function verifyReport(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    passed: true,
    errors: [],
    info: {
      sections: 5,
      headers: ['说明书摘要'],
      paragraphs: 10,
      claims: 2,
      numbering: '1..7',
      tables: 0,
      figures: 1,
      layout: { abstract: { paragraphs: 1, figures: 0 } },
      template: { sections: 5, sizes_pt: [12], line_spacings: [1.5] },
    },
    ...overrides,
  })
}

/** A content model valid enough for the tool boundary. */
const CONTENT: FilingContent = {
  abstract: ['摘要正文。'],
  claims: ['1. 一种装置，其特征在于，包括本体。'],
  specification: [{ kind: 'p', text: '本发明属于机械领域。' }],
  figures: ['/tmp/fig1.png'],
}

/** Build options whose paths resolve to the packaged assets. */
function buildOptions(subprocess: BuildEngineOptions['subprocess']): BuildEngineOptions {
  return {
    subprocess,
    pythonPath: '/usr/bin/python3',
    specPath: defaultSpecPath(),
    templatePath: defaultTemplatePath(),
    defaultOutputDir: DEFAULT_OUTPUT_DIR,
    figureScale: 3,
    timeoutMs: DEFAULT_ENGINE_TIMEOUT_MS,
  }
}

/** A subprocess double that answers each engine script with the given stdout. */
function answering(byScript: Record<string, string | (() => string)>): {
  spawner: BuildEngineOptions['subprocess']
  calls: SubprocessSpawnSpec[]
} {
  return fakeSubprocess((spec) => {
    // argv = [python, 脚本, ...]；脚本是第二项。
    const script = argvOf(spec)[1] ?? ''
    for (const [name, answer] of Object.entries(byScript)) {
      if (script.endsWith(name)) {
        return stdoutHandle(typeof answer === 'function' ? answer() : answer)
      }
    }
    throw new Error(`unexpected engine script: ${script}`)
  })
}

describe('assertSafeOutputName', () => {
  it('accepts a Chinese stem with a circled numeral prefix', () => {
    expect(assertSafeOutputName('②件_权利要求书与说明书_内部稿')).toBe('②件_权利要求书与说明书_内部稿')
  })

  it('rejects separators, dot-dot, control characters, blanks, and over-long names', () => {
    for (const bad of ['a/b', 'a\\b', '..', 'a..b', 'a\nb', '', '   ', 'a'.repeat(121)]) {
      expect(() => assertSafeOutputName(bad)).toThrow(PatentFilingError)
    }
  })
})

describe('resolveOutputDir', () => {
  it('prefers an explicit directory, absolute or relative to cwd', () => {
    expect(resolveOutputDir({ outputDir: '/abs/out' }, '/abs', DEFAULT_OUTPUT_DIR)).toBe('/abs/out')
    expect(resolveOutputDir({ outputDir: 'rel/out' }, '/cwd', DEFAULT_OUTPUT_DIR)).toBe(resolve('/cwd', 'rel/out'))
  })

  it('uses the case outputs convention when a caseId is given', () => {
    expect(resolveOutputDir({ caseId: 'A-1' }, '/cwd', DEFAULT_OUTPUT_DIR)).toBe(resolve('/cwd', 'data/cases/A-1/outputs'))
  })

  it('rejects an unsafe caseId instead of escaping the case directory', () => {
    expect(() => resolveOutputDir({ caseId: '../escape' }, '/cwd', DEFAULT_OUTPUT_DIR)).toThrow(/Invalid 案卷号/)
  })

  it('falls back to the deployment default directory', () => {
    expect(resolveOutputDir({}, '/cwd', 'out/docs')).toBe(resolve('/cwd', 'out/docs'))
  })
})

describe('buildFiling', () => {
  it('runs build.py with the packaged assets and returns the canonical result', async () => {
    const { spawner, calls } = answering({ 'build.py': buildReport() })
    const outDir = mkdtempSync(join(tmpdir(), 'dsh-filing-out-'))
    const figure = join(outDir, 'fig1.png')
    writeFileSync(figure, 'png')
    const input = { content: { ...CONTENT, figures: [figure] }, outputName: '案卷_申请文件', outputDir: outDir }
    try {
      const result = await buildFiling(input, buildOptions(spawner), outDir, new AbortController().signal)
      expect(result.docxPath).toBe(join(outDir, '案卷_申请文件.docx'))
      expect(result.numberingTotal).toBe(7)
      expect(result.upstreamNumberingSeen).toBe(0)
      expect(result.sections).toEqual([{ key: 'abstract', paragraphs: 1, figures: 0 }])
      expect(result.templateStyle.sizePt).toBe(12)
      expect(result.figures).toEqual([figure])
      expect(result.templateFingerprint).toMatch(/^[0-9a-f]{64}$/)
      expect(existsSync(outDir)).toBe(true)

      const argv = argvOf(calls[0] as SubprocessSpawnSpec)
      expect(argv[0]).toBe('/usr/bin/python3')
      expect(argv[1]).toBe(join(getEngineDir(), 'build.py'))
      expect(argv).toContain('--template')
      expect(argv[argv.indexOf('--template') + 1]).toBe(defaultTemplatePath())
      expect(argv[argv.indexOf('--spec') + 1]).toBe(defaultSpecPath())
      // 内容模型落在临时工作目录，不进交付目录。
      const contentPath = argv[argv.indexOf('--content') + 1] ?? ''
      expect(contentPath).toMatch(/content\.json$/)
      expect(existsSync(contentPath)).toBe(false)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  it('rasterizes .svg figures first and keeps the caller figure order', async () => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-filing-svg-'))
    const first = join(work, 'fig1.svg')
    const second = join(work, 'fig2.svg')
    const png = join(work, 'fig3.png')
    for (const path of [first, second, png]) writeFileSync(path, '<svg width="10" height="10"/>')
    const { spawner, calls } = answering({
      'render_figures.py': () => JSON.stringify({ status: 'ok', figures: ['/work/figures/fig1.png', '/work/figures/fig2.png'] }),
      'build.py': buildReport(),
    })
    const outDir = mkdtempSync(join(tmpdir(), 'dsh-filing-out-'))
    const input = { content: { ...CONTENT, figures: [second, png, first] }, outputName: 'ordered', outputDir: outDir }
    try {
      const result = await buildFiling(input, buildOptions(spawner), outDir, new AbortController().signal)
      // 输入顺序 [fig2.svg, fig3.png, fig1.svg] → 栅格化产物按 .svg 出现顺序插回原位。
      expect(result.figures).toEqual(['/work/figures/fig1.png', png, '/work/figures/fig2.png'])
      const rasterArgv = argvOf(calls[0] as SubprocessSpawnSpec)
      expect(rasterArgv.filter(arg => arg === '--svg-file')).toHaveLength(2)
      expect(rasterArgv[rasterArgv.indexOf('--scale') + 1]).toBe('3')
    } finally {
      rmSync(work, { recursive: true, force: true })
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  it('reports a missing figure source before reaching the engine', async () => {
    const { spawner, calls } = answering({ 'build.py': buildReport() })
    const input = { content: { ...CONTENT, figures: ['/nope/missing.png'] }, outputName: 'x', outputDir: '/tmp' }
    await expect(buildFiling(input, buildOptions(spawner), '/tmp', new AbortController().signal))
      .rejects.toThrow(/附图源件不存在：\/nope\/missing\.png/)
    expect(calls).toHaveLength(0)
  })

  it('rejects a figure extension it cannot ingest', async () => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-filing-ext-'))
    const pdf = join(work, 'fig.pdf')
    writeFileSync(pdf, '%PDF-1.4')
    const { spawner } = answering({ 'build.py': buildReport() })
    try {
      await expect(buildFiling({ content: { ...CONTENT, figures: [pdf] }, outputName: 'x', outputDir: work },
        buildOptions(spawner), work, new AbortController().signal))
        .rejects.toThrow(/只接受 \.svg 源件或 \.png\/\.jpg\/\.jpeg 位图/)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('rejects a rasterization report that yields fewer bitmaps than .svg inputs', async () => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-filing-short-'))
    const svg = join(work, 'a.svg')
    writeFileSync(svg, '<svg width="10" height="10"/>')
    const { spawner } = answering({
      'render_figures.py': JSON.stringify({ status: 'ok', figures: [] }),
      'build.py': buildReport(),
    })
    try {
      await expect(buildFiling({ content: { ...CONTENT, figures: [svg] }, outputName: 'x', outputDir: work },
        buildOptions(spawner), work, new AbortController().signal))
        .rejects.toThrow(/figures 少于输入的 \.svg 张数/)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('rejects a rasterization report without a figures array', async () => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-filing-nofigs-'))
    const svg = join(work, 'a.svg')
    writeFileSync(svg, '<svg width="10" height="10"/>')
    const { spawner } = answering({
      'render_figures.py': JSON.stringify({ status: 'ok' }),
      'build.py': buildReport(),
    })
    try {
      await expect(buildFiling({ content: { ...CONTENT, figures: [svg] }, outputName: 'x', outputDir: work },
        buildOptions(spawner), work, new AbortController().signal))
        .rejects.toThrow(/render_figures 报告缺少 figures/)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('rejects content before touching the engine', async () => {
    const { spawner, calls } = answering({ 'build.py': buildReport() })
    await expect(buildFiling({ content: { ...CONTENT, claims: [] }, outputName: 'x', outputDir: '/tmp' },
      buildOptions(spawner), '/tmp', new AbortController().signal)).rejects.toThrow(PatentFilingError)
    expect(calls).toHaveLength(0)
  })

  it('rejects an unsafe output name before touching the engine', async () => {
    const { spawner, calls } = answering({ 'build.py': buildReport() })
    await expect(buildFiling({ content: CONTENT, outputName: '../escape', outputDir: '/tmp' },
      buildOptions(spawner), '/tmp', new AbortController().signal)).rejects.toThrow(/不可用/)
    expect(calls).toHaveLength(0)
  })
})

describe('verifyFiling', () => {
  it('reports a passing document with the engine summary', async () => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-filing-verify-'))
    const docx = join(work, 'a.docx')
    writeFileSync(docx, 'x')
    const { spawner, calls } = answering({ 'verify.py': verifyReport() })
    const options: VerifyEngineOptions = {
      subprocess: spawner,
      pythonPath: '/usr/bin/python3',
      specPath: defaultSpecPath(),
      templatePath: defaultTemplatePath(),
      timeoutMs: DEFAULT_ENGINE_TIMEOUT_MS,
    }
    try {
      const result = await verifyFiling({ docxPath: docx }, options, new AbortController().signal)
      expect(result.passed).toBe(true)
      expect(result.errors).toEqual([])
      expect(result.docxPath).toBe(docx)
      expect(result.info.layout).toEqual([{ key: 'abstract', paragraphs: 1, figures: 0 }])
      expect(result.info.template).toEqual({ sections: 5, sizes_pt: [12], line_spacings: [1.5] })
      expect(argvOf(calls[0] as SubprocessSpawnSpec)).toContain('--template')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('keeps failed assertions as a domain result and omits a missing template summary', async () => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-filing-verify-'))
    const docx = join(work, 'a.docx')
    writeFileSync(docx, 'x')
    const report = JSON.parse(verifyReport()) as { info: Record<string, unknown> }
    delete report.info.template
    const { spawner } = answering({ 'verify.py': JSON.stringify({ passed: false, errors: ['分节数 4 ≠ 期望 5'], info: report.info }) })
    const options: VerifyEngineOptions = {
      subprocess: spawner,
      pythonPath: '/usr/bin/python3',
      specPath: defaultSpecPath(),
      templatePath: defaultTemplatePath(),
      timeoutMs: DEFAULT_ENGINE_TIMEOUT_MS,
    }
    try {
      const result = await verifyFiling({ docxPath: docx }, options, new AbortController().signal)
      expect(result.passed).toBe(false)
      expect(result.errors).toEqual(['分节数 4 ≠ 期望 5'])
      expect(result.info.template).toBeUndefined()
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

  it('refuses a document path that does not exist', async () => {
    const { spawner, calls } = answering({ 'verify.py': verifyReport() })
    const options: VerifyEngineOptions = {
      subprocess: spawner,
      pythonPath: '/usr/bin/python3',
      specPath: defaultSpecPath(),
      templatePath: defaultTemplatePath(),
      timeoutMs: DEFAULT_ENGINE_TIMEOUT_MS,
    }
    await expect(verifyFiling({ docxPath: '/nope/a.docx' }, options, new AbortController().signal))
      .rejects.toThrow(/待验收文件不存在/)
    expect(calls).toHaveLength(0)
  })
})

describe('engine output parsing', () => {
  /** Options that reach the engine with a canned stdout. */
  function optionsFor(stdout: string, exitCode: number | null = 0): VerifyEngineOptions {
    return {
      subprocess: fakeSubprocess(() => stdoutHandle(stdout, { exitCode, signal: exitCode === null ? 'SIGKILL' : null })).spawner,
      pythonPath: '/usr/bin/python3',
      specPath: defaultSpecPath(),
      templatePath: defaultTemplatePath(),
      timeoutMs: DEFAULT_ENGINE_TIMEOUT_MS,
    }
  }

  /** A docx path that exists, so parsing is what fails. */
  function docxStub(): { dir: string; path: string } {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-filing-parse-'))
    const path = join(dir, 'a.docx')
    writeFileSync(path, 'x')
    return { dir, path }
  }

  it('names the exit facts when stdout is not JSON', async () => {
    const stub = docxStub()
    try {
      await expect(verifyFiling({ docxPath: stub.path }, optionsFor('boom', 3),
        new AbortController().signal)).rejects.toThrow(/退出码 3）：boom/)
    } finally {
      rmSync(stub.dir, { recursive: true, force: true })
    }
  })

  it('names the terminating signal when the engine is killed', async () => {
    const stub = docxStub()
    try {
      await expect(verifyFiling({ docxPath: stub.path }, optionsFor('boom', null),
        new AbortController().signal)).rejects.toThrow(/被信号 SIGKILL 终止/)
    } finally {
      rmSync(stub.dir, { recursive: true, force: true })
    }
  })

  it('rejects a report that is not a JSON object', async () => {
    const stub = docxStub()
    try {
      await expect(verifyFiling({ docxPath: stub.path }, optionsFor('[]'),
        new AbortController().signal)).rejects.toThrow(/verify 报告 不是 JSON 对象/)
    } finally {
      rmSync(stub.dir, { recursive: true, force: true })
    }
  })

  it('rejects an errors field that is not a string array', async () => {
    const stub = docxStub()
    try {
      await expect(verifyFiling({ docxPath: stub.path }, optionsFor(verifyReport({ errors: 'nope' })),
        new AbortController().signal)).rejects.toThrow(/errors 不是字符串数组/)
      await expect(verifyFiling({ docxPath: stub.path }, optionsFor(verifyReport({ errors: [1] })),
        new AbortController().signal)).rejects.toThrow(/errors 不是字符串数组/)
    } finally {
      rmSync(stub.dir, { recursive: true, force: true })
    }
  })

  it('rejects a verify report missing any declared info field', async () => {
    const stub = docxStub()
    const fields = ['sections', 'headers', 'paragraphs', 'claims', 'numbering', 'tables', 'figures', 'layout']
    try {
      for (const field of fields) {
        const info = (JSON.parse(verifyReport()) as { info: Record<string, unknown> }).info
        // 用删除后的副本重建报告，避免动态 delete。
        const pruned = Object.fromEntries(Object.entries(info).filter(([key]) => key !== field))
        await expect(verifyFiling({ docxPath: stub.path }, optionsFor(JSON.stringify({ passed: true, errors: [], info: pruned })),
          new AbortController().signal)).rejects.toThrow(PatentFilingError)
      }
    } finally {
      rmSync(stub.dir, { recursive: true, force: true })
    }
  })

  it('rejects malformed info collections and entries', async () => {
    const stub = docxStub()
    const cases: Record<string, unknown>[] = []
    const base = (): Record<string, unknown> => (JSON.parse(verifyReport()) as { info: Record<string, unknown> }).info
    cases.push({ ...base(), headers: 'nope' })
    cases.push({ ...base(), headers: [1] })
    cases.push({ ...base(), layout: [] })
    cases.push({ ...base(), layout: { a: 'nope' } })
    // 各节归属缺一项计数：把 abstract 的 figures 换成非法值，等价于字段缺失。
    const brokenLayout = base()
    const layout = brokenLayout.layout as Record<string, Record<string, unknown>>
    layout.abstract = { paragraphs: 1 }
    cases.push(brokenLayout)
    cases.push({ ...base(), template: { sections: 5, sizes_pt: 'nope', line_spacings: [1.5] } })
    cases.push({ ...base(), template: { sections: 5, sizes_pt: [1], line_spacings: ['nope'] } })
    try {
      for (const info of cases) {
        await expect(verifyFiling({ docxPath: stub.path }, optionsFor(JSON.stringify({ passed: true, errors: [], info })),
          new AbortController().signal)).rejects.toThrow(PatentFilingError)
      }
    } finally {
      rmSync(stub.dir, { recursive: true, force: true })
    }
  })

  it('rejects malformed build reports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-filing-buildparse-'))
    // 附图必须真实存在，否则每个用例都会在引擎调用之前因缺图失败，断言就成了空转。
    const figure = join(dir, 'fig1.png')
    writeFileSync(figure, 'png')
    const input = { content: { ...CONTENT, figures: [figure] }, outputName: 'x', outputDir: dir }
    const template = defaultTemplatePath()
    const bad: string[] = [
      JSON.stringify([]),
      JSON.stringify({ sections: 'nope' }),
      JSON.stringify({ sections: [{}], numbering_total: 1, upstream_numbering_seen: 0, template_style: {} }),
      JSON.stringify({ sections: [null], numbering_total: 1, upstream_numbering_seen: 0, template_style: {} }),
      JSON.stringify({ sections: [], upstream_numbering_seen: 0, template_style: {} }),
      buildReport({ template_style: null }),
      buildReport({ template_style: { ...((JSON.parse(buildReport()) as { template_style: object }).template_style), sizes_pt: 'nope' } }),
      buildReport({ template_style: { ...((JSON.parse(buildReport()) as { template_style: object }).template_style), sizes_pt: [1, 'x'] } }),
      buildReport({
        template_style: { ...(JSON.parse(buildReport()) as { template_style: object }).template_style, eastAsia: undefined },
      }),
    ]
    try {
      for (const stdout of bad) {
        const options = { ...buildOptions(fakeSubprocess(() => stdoutHandle(stdout)).spawner), templatePath: template }
        await expect(buildFiling(input, options, dir, new AbortController().signal)).rejects.toThrow(PatentFilingError)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('engine invocation edge branches', () => {
  /** Options that reach the engine with a canned exit fact. */
  function optionsWith(spawner: VerifyEngineOptions['subprocess']): VerifyEngineOptions {
    return {
      subprocess: spawner,
      pythonPath: '/usr/bin/python3',
      specPath: defaultSpecPath(),
      templatePath: defaultTemplatePath(),
      timeoutMs: DEFAULT_ENGINE_TIMEOUT_MS,
    }
  }

  /** A docx path that exists. */
  function docxStub(): { dir: string; path: string } {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-filing-edge-'))
    const path = join(dir, 'a.docx')
    writeFileSync(path, 'x')
    return { dir, path }
  }

  it('does not spawn an engine when the caller already cancelled', async () => {
    const stub = docxStub()
    const controller = new AbortController()
    controller.abort()
    const { spawner, calls } = fakeSubprocess(() => stdoutHandle(verifyReport()))
    try {
      await expect(verifyFiling({ docxPath: stub.path }, optionsWith(spawner), controller.signal))
        .rejects.toThrow(/未启动：调用方在起进程前已取消/)
      expect(calls).toHaveLength(0)
    } finally {
      rmSync(stub.dir, { recursive: true, force: true })
    }
  })

  it('resolves the interpreter at call time when the options carry none', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-filing-nopy-'))
    const interpreter = join(dir, 'python3')
    writeFileSync(interpreter, '#!/bin/sh\n')
    const saved = process.env.DSH_PYTHON_PATH
    process.env.DSH_PYTHON_PATH = interpreter
    const stub = docxStub()
    try {
      const { spawner, calls } = fakeSubprocess(() => stdoutHandle(verifyReport()))
      const options: VerifyEngineOptions = {
        subprocess: spawner,
        specPath: defaultSpecPath(),
        templatePath: defaultTemplatePath(),
        timeoutMs: DEFAULT_ENGINE_TIMEOUT_MS,
      }
      await verifyFiling({ docxPath: stub.path }, options, new AbortController().signal)
      expect(argvOf(calls[0] as SubprocessSpawnSpec)[0]).toBe(interpreter)
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, 'DSH_PYTHON_PATH')
      else process.env.DSH_PYTHON_PATH = saved
      rmSync(dir, { recursive: true, force: true })
      rmSync(stub.dir, { recursive: true, force: true })
    }
  })

  it('treats a handle with no collected streams as empty output', async () => {
    const stub = docxStub()
    const handle = stdoutHandle('', { exitCode: 0, signal: null, streams: { stdout: false, stderr: false } })
    try {
      await expect(verifyFiling({ docxPath: stub.path }, optionsWith(fakeSubprocess(() => handle).spawner),
        new AbortController().signal)).rejects.toThrow(/无输出/)
    } finally {
      rmSync(stub.dir, { recursive: true, force: true })
    }
  })

  it('names an unknown terminating signal', async () => {
    const stub = docxStub()
    const handle = stdoutHandle('boom', { exitCode: null, signal: null })
    try {
      await expect(verifyFiling({ docxPath: stub.path }, optionsWith(fakeSubprocess(() => handle).spawner),
        new AbortController().signal)).rejects.toThrow(/被信号 未知 终止/)
    } finally {
      rmSync(stub.dir, { recursive: true, force: true })
    }
  })

  it('points at the interpreter when the engine cannot import its dependency', async () => {
    const stub = docxStub()
    const handle = stdoutHandle('', {
      exitCode: 1,
      signal: null,
      stderr: "Traceback (most recent call last):\nModuleNotFoundError: No module named 'docx'",
    })
    try {
      await expect(verifyFiling({ docxPath: stub.path }, optionsWith(fakeSubprocess(() => handle).spawner),
        new AbortController().signal)).rejects.toThrow(/\/usr\/bin\/python3 无法加载引擎依赖，请指向一个自带 python-docx 的解释器/)
    } finally {
      rmSync(stub.dir, { recursive: true, force: true })
    }
  })

  it('rejects a verify report with no info object', async () => {
    const stub = docxStub()
    try {
      await expect(verifyFiling({ docxPath: stub.path },
        optionsWith(fakeSubprocess(() => stdoutHandle(JSON.stringify({ passed: false, errors: [] }))).spawner),
        new AbortController().signal)).rejects.toThrow(/info 不是 JSON 对象/)
    } finally {
      rmSync(stub.dir, { recursive: true, force: true })
    }
  })

  it('rejects a build report with no sections or no template_style', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-filing-nosec-'))
    const figure = join(dir, 'fig1.png')
    writeFileSync(figure, 'png')
    const input = { content: { ...CONTENT, figures: [figure] }, outputName: 'x', outputDir: dir }
    try {
      for (const stdout of [
        JSON.stringify({ numbering_total: 1, upstream_numbering_seen: 0, template_style: {} }),
        JSON.stringify({ sections: [], numbering_total: 1, upstream_numbering_seen: 0 }),
      ]) {
        const options = { ...buildOptions(fakeSubprocess(() => stdoutHandle(stdout)).spawner) }
        await expect(buildFiling(input, options, dir, new AbortController().signal)).rejects.toThrow(PatentFilingError)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('passes an explicit chrome path to the rasterizer', async () => {
    const work = mkdtempSync(join(tmpdir(), 'dsh-filing-chrome-'))
    const svg = join(work, 'a.svg')
    writeFileSync(svg, '<svg width="10" height="10"/>')
    const { spawner, calls } = answering({
      'render_figures.py': JSON.stringify({ status: 'ok', figures: [join(work, 'figures', 'fig1.png')] }),
      'build.py': buildReport(),
    })
    const outDir = mkdtempSync(join(tmpdir(), 'dsh-filing-out-'))
    try {
      await buildFiling({ content: { ...CONTENT, figures: [svg] }, outputName: 'x', outputDir: outDir },
        { ...buildOptions(spawner), chromePath: '/opt/chrome' }, outDir, new AbortController().signal)
      const rasterArgv = argvOf(calls[0] as SubprocessSpawnSpec)
      expect(rasterArgv[rasterArgv.indexOf('--chrome') + 1]).toBe('/opt/chrome')
    } finally {
      rmSync(work, { recursive: true, force: true })
      rmSync(outDir, { recursive: true, force: true })
    }
  })
})

describe('engine bounds', () => {
  /** A handle that settles only after a macrotask, so timers and aborts fire first. */
  function slowHandle(stdout: string): ReturnType<typeof stdoutHandle> {
    return stdoutHandle(stdout, { exitCode: 0, signal: null, delayMs: 30 })
  }

  function docxStub(): { dir: string; path: string } {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-filing-bounds-'))
    const path = join(dir, 'a.docx')
    writeFileSync(path, 'x')
    return { dir, path }
  }

  it('aborts the spawned engine when the timeout elapses', async () => {
    const stub = docxStub()
    const { spawner, calls } = fakeSubprocess(() => slowHandle(verifyReport()))
    const caller = new AbortController()
    try {
      const options: VerifyEngineOptions = {
        subprocess: spawner,
        pythonPath: '/usr/bin/python3',
        specPath: defaultSpecPath(),
        templatePath: defaultTemplatePath(),
        timeoutMs: 1,
      }
      const result = await verifyFiling({ docxPath: stub.path }, options, caller.signal)
      expect(result.passed).toBe(true)
      expect(calls[0]?.signal?.aborted).toBe(true)
      // 子进程拿的是内部信号：超时与调用方取消各能中止它，互不覆盖。
      expect(calls[0]?.signal).not.toBe(caller.signal)
    } finally {
      rmSync(stub.dir, { recursive: true, force: true })
    }
  })

  it('leaves the engine signal unaborted while the call is still running', async () => {
    const stub = docxStub()
    const { spawner, calls } = fakeSubprocess(() => slowHandle(verifyReport()))
    const caller = new AbortController()
    try {
      const options: VerifyEngineOptions = {
        subprocess: spawner,
        pythonPath: '/usr/bin/python3',
        specPath: defaultSpecPath(),
        templatePath: defaultTemplatePath(),
        timeoutMs: DEFAULT_ENGINE_TIMEOUT_MS,
      }
      const result = await verifyFiling({ docxPath: stub.path }, options, caller.signal)
      expect(result.passed).toBe(true)
      expect(calls[0]?.signal?.aborted).toBe(false)
      expect(calls[0]?.signal).not.toBe(caller.signal)
    } finally {
      rmSync(stub.dir, { recursive: true, force: true })
    }
  })

  it('aborts the spawned engine when the caller cancels', async () => {
    const stub = docxStub()
    const { spawner, calls } = fakeSubprocess(() => slowHandle(verifyReport()))
    const controller = new AbortController()
    try {
      const options: VerifyEngineOptions = {
        subprocess: spawner,
        pythonPath: '/usr/bin/python3',
        specPath: defaultSpecPath(),
        templatePath: defaultTemplatePath(),
        timeoutMs: DEFAULT_ENGINE_TIMEOUT_MS,
      }
      const pending = verifyFiling({ docxPath: stub.path }, options, controller.signal)
      controller.abort()
      await pending
      expect(calls[0]?.signal?.aborted).toBe(true)
    } finally {
      rmSync(stub.dir, { recursive: true, force: true })
    }
  })

  it('names non-JSON stdout when stderr is empty', async () => {
    const stub = docxStub()
    try {
      const options: VerifyEngineOptions = {
        subprocess: fakeSubprocess(() => stdoutHandle('boom', { exitCode: 3, signal: null })).spawner,
        pythonPath: '/usr/bin/python3',
        specPath: defaultSpecPath(),
        templatePath: defaultTemplatePath(),
        timeoutMs: DEFAULT_ENGINE_TIMEOUT_MS,
      }
      await expect(verifyFiling({ docxPath: stub.path }, options, new AbortController().signal))
        .rejects.toThrow(/退出码 3）：boom/)
    } finally {
      rmSync(stub.dir, { recursive: true, force: true })
    }
  })

  it('rejects a template summary missing its measured collections', async () => {
    const stub = docxStub()
    const base = (): Record<string, unknown> => (JSON.parse(verifyReport()) as { info: Record<string, unknown> }).info
    try {
      for (const template of [{ sections: 5, line_spacings: [1.5] }, { sections: 5, sizes_pt: [12] }]) {
        await expect(verifyFiling({ docxPath: stub.path },
          {
            subprocess: fakeSubprocess(() => stdoutHandle(
              JSON.stringify({ passed: true, errors: [], info: { ...base(), template } }),
            )).spawner,
            pythonPath: '/usr/bin/python3',
            specPath: defaultSpecPath(),
            templatePath: defaultTemplatePath(),
            timeoutMs: DEFAULT_ENGINE_TIMEOUT_MS,
          },
          new AbortController().signal)).rejects.toThrow(/不是数组/)
      }
    } finally {
      rmSync(stub.dir, { recursive: true, force: true })
    }
  })
})
