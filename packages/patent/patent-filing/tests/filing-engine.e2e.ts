// Real-engine end to end: the packaged Python engine runs through the real local
// subprocess provider and produces a DOCX that the packaged verifier accepts with
// every assertion green. Runs in the no-coverage e2e lane because it needs a Python
// with python-docx. The suite skips itself through `describe.skipIf` when this host
// has none: an early `return` inside the case would report a pass for a run that
// never happened.
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { DEFAULT_ENGINE_TIMEOUT_MS, buildFiling, defaultSpecPath, defaultTemplatePath, findPython, verifyFiling } from '@deepseek-ai/dsh-patent-filing'
import type { BuildEngineOptions, VerifyEngineOptions } from '@deepseek-ai/dsh-patent-filing'

/**
 * The interpreter that can run the engine, or undefined when this host has none.
 *
 * Probed synchronously at collection time so the suite can skip itself whole. The case
 * leaves `pythonPath` unset, so the engine resolves the same interpreter through the
 * production discovery path.
 */
function enginePython(): string | undefined {
  const candidate = findPython()
  if (candidate === undefined) return undefined
  const probe = spawnSync(candidate, ['-c', 'import docx'], { timeout: 10_000 })
  return probe.status === 0 ? candidate : undefined
}

const interpreter = enginePython()

/**
 * Two minimal but byte-distinct PNGs (1×1 and 2×2): identical bytes would be deduplicated
 * into one media part by python-docx, leaving no way to tell which figure was embedded.
 */
const SQUARE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
const MARKED_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg=='

/**
 * The raster the engine actually embedded first in the document, read back from the
 * produced .docx: the first `r:embed` in `word/document.xml` resolved through the
 * document relationships. This is what the 摘要附图 section receives.
 */
function firstEmbeddedImage(python: string, docxPath: string): Buffer {
  const script = [
    'import re, sys, zipfile',
    'z = zipfile.ZipFile(sys.argv[1])',
    'doc = z.read("word/document.xml").decode("utf-8")',
    'rels = z.read("word/_rels/document.xml.rels").decode("utf-8")',
    'rid = re.search(r\'r:embed="([^"]+)"\', doc).group(1)',
    'target = re.search(\'Id="%s"[^>]*Target="([^"]+)"\' % rid, rels).group(1)',
    'sys.stdout.buffer.write(z.read("word/" + target.lstrip("/")))',
  ].join('\n')
  const probe = spawnSync(python, ['-c', script, docxPath], { maxBuffer: 4 * 1024 * 1024 })
  if (probe.status !== 0) {
    throw new Error(`读取 ${docxPath} 内嵌位图失败：${probe.stderr.toString()}`)
  }
  return probe.stdout
}

describe.skipIf(interpreter === undefined)('filing engine end to end', () => {
  let work: string | undefined

  afterAll(async () => {
    if (work !== undefined) await rm(work, { recursive: true, force: true })
    work = undefined
  })

  it('builds a filing document and verifies it against the packaged template', async () => {
    work = await mkdtemp(join(tmpdir(), 'dsh-patent-filing-e2e-'))
    const subprocess = new LocalSubprocessRuntime(new Context())
    const signal = new AbortController().signal
    const common = {
      subprocess,
      specPath: defaultSpecPath(),
      templatePath: defaultTemplatePath(),
      timeoutMs: DEFAULT_ENGINE_TIMEOUT_MS,
    }
    const buildOptions: BuildEngineOptions = {
      ...common,
      outputRoot: work,
      figureScale: 1,
    }
    const content = {
      abstract: ['本发明公开了一种用于校验出件链路的装置，其包括本体与控制器。'],
      claims: [
        '1. 一种用于校验出件链路的装置，其特征在于，包括本体与控制器，所述控制器设置于所述本体。',
        '2. 根据权利要求 1 所述的装置，其特征在于，所述本体为矩形。',
      ],
      specification: [
        { kind: 'h3', text: '技术领域' },
        { kind: 'p', text: '本发明属于机械领域，具体涉及一种用于校验出件链路的装置。' },
        { kind: 'h3', text: '背景技术' },
        { kind: 'p', text: '现有装置缺少出件校验环节。' },
        { kind: 'h3', text: '发明内容' },
        { kind: 'p', text: '本发明提供一种装置，以解决上述技术问题。' },
        { kind: 'h3', text: '附图说明' },
        { kind: 'p', text: '图1为装置的立体图；图2为装置的剖视图。' },
        { kind: 'h3', text: '具体实施方式' },
        { kind: 'p', text: '下面结合附图对本发明作进一步说明。' },
        // 表题段（contentFromDraft 的产物形态）：不进入 [NNNN] 编号序列。
        { kind: 'p', text: '表 1 · 部位标记表' },
        { kind: 'table', rows: [['部位', '标记'], ['本体', '1'], ['控制器', '2']] },
      ] as { kind: 'h3' | 'p' | 'table'; text?: string; rows?: string[][] }[],
      figures: [join(work, 'fig1.png'), join(work, 'fig2.png')],
    }
    // 最小合法位图，避免依赖 Chrome 栅格化。
    const png = Buffer.from(SQUARE_PNG_BASE64, 'base64')
    for (const path of content.figures) await writeFile(path, png)

    const built = await buildFiling({ content, outputName: '链路校验', outputDir: work }, buildOptions, process.cwd(), signal)
    expect(built.sections.map(tally => tally.key)).toEqual([
      'abstract', 'abstract_figure', 'claims', 'specification', 'figures',
    ])
    expect(built.figures).toHaveLength(2)
    expect(built.templateStyle).toMatchObject({ sectionCount: 5, sizePt: 12, lineSpacing: 1.5 })
    // spec 的说明书节声明 numbering: none（《专利法实施细则》第二十条不要求段落编号下的
    // 体例选择），故说明书各段不写 [NNNN]，编号总数为 0。段落本身照写：5 个正文段、
    // 1 个表题段，外加表格。
    expect(built.numberingTotal).toBe(0)
    await expect(readFile(built.docxPath)).resolves.toBeInstanceOf(Buffer)

    const verifyOptions: VerifyEngineOptions = { ...common }
    const verified = await verifyFiling({ docxPath: built.docxPath }, verifyOptions, signal)
    expect(verified.errors).toEqual([])
    expect(verified.passed).toBe(true)
    expect(verified.info.sections).toBe(5)
    // 附图在两节各出现一次：摘要附图 1 张 + 说明书附图 2 张。
    expect(verified.info.figures).toBe(3)
    expect(verified.info.template?.sections).toBe(5)
  }, 120_000)

  it('checks font size, color, and internal marks inside table cells', async () => {
    const python = enginePython()
    if (python === undefined) throw new Error('本机缺少可运行引擎的解释器')
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-filing-e2e-table-'))
    try {
      const subprocess = new LocalSubprocessRuntime(new Context())
      const signal = new AbortController().signal
      const figure = join(dir, 'fig1.png')
      await writeFile(figure, Buffer.from(SQUARE_PNG_BASE64, 'base64'))
      const common = {
        subprocess,
        specPath: defaultSpecPath(),
        templatePath: defaultTemplatePath(),
        timeoutMs: DEFAULT_ENGINE_TIMEOUT_MS,
      }
      const built = await buildFiling({
        content: {
          abstract: ['本发明公开了一种用于校验表格验收的装置。'],
          claims: ['1. 一种用于校验表格验收的装置，其特征在于，包括本体。'],
          specification: [
            { kind: 'h3', text: '技术领域' },
            { kind: 'p', text: '本发明属于机械领域。' },
            { kind: 'h3', text: '背景技术' },
            { kind: 'p', text: '现有装置缺少表格验收。' },
            { kind: 'h3', text: '发明内容' },
            { kind: 'p', text: '本发明提供一种装置。' },
            { kind: 'h3', text: '附图说明' },
            { kind: 'p', text: '图1为装置的立体图。' },
            { kind: 'h3', text: '具体实施方式' },
            { kind: 'p', text: '下面结合附图对本发明作进一步说明。' },
            { kind: 'table', rows: [['部位', '标记'], ['本体', '1']] },
          ] as { kind: 'h3' | 'p' | 'table'; text?: string; rows?: string[][] }[],
          figures: [figure],
        },
        outputName: '表格验收',
        outputDir: dir,
      }, { ...common, outputRoot: dir, figureScale: 1 }, process.cwd(), signal)

      // Mutate only the table cell: a passing document with one defective cell must fail.
      const mutate = [
        'import sys',
        'from docx import Document',
        'from docx.shared import Pt, RGBColor',
        'd = Document(sys.argv[1])',
        'run = d.tables[0].rows[1].cells[0].paragraphs[0].runs[0]',
        'run.text = "内部复核稿"',
        'run.font.size = Pt(10)',
        'run.font.color.rgb = RGBColor(0xFF, 0, 0)',
        'd.save(sys.argv[1])',
      ].join('\n')
      const mutated = spawnSync(python, ['-c', mutate, built.docxPath], { encoding: 'utf8' })
      expect(mutated.status).toBe(0)

      const verified = await verifyFiling({ docxPath: built.docxPath }, common, signal)
      expect(verified.passed).toBe(false)
      expect(verified.errors.join('\n')).toContain('内部复核稿')
      expect(verified.errors.join('\n')).toContain('字号 10')
      expect(verified.errors.join('\n')).toContain('非黑色文字')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it('入文「摘要附图」节的是 draft 指定的那张图，不是第 1 张', async () => {
    const python = enginePython()
    // describe.skipIf 已在收集期保证本机有可用解释器：缺失时显式失败，不静默通过。
    if (python === undefined) throw new Error('本机缺少可运行引擎的解释器')
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-filing-e2e-absfig-'))
    try {
      const firstFigure = join(dir, 'fig1.png')
      const secondFigure = join(dir, 'fig2.png')
      await writeFile(firstFigure, Buffer.from(SQUARE_PNG_BASE64, 'base64'))
      await writeFile(secondFigure, Buffer.from(MARKED_PNG_BASE64, 'base64'))
      const content = {
        abstract: ['本发明公开了一种用于校验摘要附图的装置。'],
        claims: ['1. 一种用于校验摘要附图的装置，其特征在于，包括本体。'],
        specification: [
          { kind: 'h3', text: '技术领域' },
          { kind: 'p', text: '本发明属于机械领域。' },
          { kind: 'h3', text: '背景技术' },
          { kind: 'p', text: '现有装置缺少摘要附图指定。' },
          { kind: 'h3', text: '发明内容' },
          { kind: 'p', text: '本发明提供一种装置。' },
          { kind: 'h3', text: '附图说明' },
          { kind: 'p', text: '图1为装置的立体图；图2为装置的剖视图。' },
          { kind: 'h3', text: '具体实施方式' },
          { kind: 'p', text: '下面结合附图对本发明作进一步说明。' },
        ] as { kind: 'h3' | 'p'; text: string }[],
        figures: [firstFigure, secondFigure],
        abstractFigureIndex: 1,
      }
      const subprocess = new LocalSubprocessRuntime(new Context())
      const built = await buildFiling(
        { content, outputName: '摘要附图指定', outputDir: dir },
        {
          subprocess,
          specPath: defaultSpecPath(),
          templatePath: defaultTemplatePath(),
          timeoutMs: DEFAULT_ENGINE_TIMEOUT_MS,
          outputRoot: dir,
          figureScale: 1,
        },
        process.cwd(),
        new AbortController().signal,
      )
      // 「摘要附图」节 1 张 + 「说明书附图」节 2 张。
      expect(built.sections.map(tally => tally.figures)).toEqual([0, 1, 0, 0, 2])
      expect(firstEmbeddedImage(python, built.docxPath)).toEqual(await readFile(secondFigure))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it('无附图发明省略摘要附图与说明书附图两节，成品仍通过验收', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-filing-e2e-nofig-'))
    try {
      const subprocess = new LocalSubprocessRuntime(new Context())
      const common = {
        subprocess,
        specPath: defaultSpecPath(),
        templatePath: defaultTemplatePath(),
        timeoutMs: DEFAULT_ENGINE_TIMEOUT_MS,
      }
      const built = await buildFiling({
        content: {
          abstract: ['本发明公开一种无需附图的检测方法。'],
          claims: ['1. 一种检测方法，其特征在于，包括采集步骤与判断步骤。'],
          specification: [
            { kind: 'h3', text: '技术领域' },
            { kind: 'p', text: '本发明属于检测技术领域。' },
            { kind: 'h3', text: '背景技术' },
            { kind: 'p', text: '现有检测方法缺少快速判断步骤。' },
            { kind: 'h3', text: '发明内容' },
            { kind: 'p', text: '本发明提供一种检测方法。' },
            { kind: 'h3', text: '具体实施方式' },
            { kind: 'p', text: '实施例1：采集信号后按阈值判断。' },
          ] as { kind: 'h3' | 'p'; text: string }[],
          figures: [],
        },
        outputName: '无附图',
        outputDir: dir,
      }, { ...common, outputRoot: dir, figureScale: 1 }, process.cwd(), new AbortController().signal)
      expect(built.sections.map(tally => tally.key)).toEqual(['abstract', 'claims', 'specification'])
      expect(built.figures).toEqual([])

      const verified = await verifyFiling({ docxPath: built.docxPath }, common, new AbortController().signal)
      expect(verified.errors).toEqual([])
      expect(verified.passed).toBe(true)
      expect(verified.info.sections).toBe(3)
      expect(verified.info.figures).toBe(0)
      expect(verified.info.layout.map(tally => tally.key)).toEqual(['abstract', 'claims', 'specification'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
