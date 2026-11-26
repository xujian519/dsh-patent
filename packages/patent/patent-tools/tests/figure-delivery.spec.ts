import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { GeneratePatentFigureDeps, GeneratePatentFigureOutput } from '../src/tool/figure-input.ts'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// `insertSvgDocumentTitle` is mocked at the module boundary so line 41
// (re-throw of a non-VectorFigureError) is reachable without a custom SVG.
vi.mock('../src/figure/vector-figure.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/figure/vector-figure.ts')>()
  return { ...orig, insertSvgDocumentTitle: vi.fn() }
})

const { insertSvgDocumentTitle: mockInsert } = vi.mocked(
  await import('../src/figure/vector-figure.ts'),
)

// Import after mock so `figure-delivery.ts` picks up the mocked `insertSvgDocumentTitle`.
const { attachSiblingDxf, finishDirectRender, finishSvgChain, stampDotDocumentTitle } = await import('../src/tool/figure-delivery.ts')
const { VectorFigureError } = await import('../src/figure/vector-figure.ts')

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-delivery-')) })

/** 这些收尾测试不渲染 DOT。补上必填的 `render`，调用即失败。 */
function testDeps(extra: Omit<GeneratePatentFigureDeps, 'render'> = {}): GeneratePatentFigureDeps {
  return {
    render: () => Promise.reject(new Error('render 不应被调用')),
    ...extra,
  }
}
afterEach(() => { vi.clearAllMocks() })

describe('stampDotDocumentTitle', () => {
  it('title undefined 时不读文件', async () => {
    const path = join(dir, 'skip.svg')
    writeFileSync(path, '<svg></svg>')
    await stampDotDocumentTitle(path, 'svg', undefined)
    expect(readFileSync(path, 'utf8')).toBe('<svg></svg>')
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('format 非 svg 时不读文件', async () => {
    const path = join(dir, 'skip.png')
    writeFileSync(path, 'binary')
    await stampDotDocumentTitle(path, 'png', '标题')
    expect(readFileSync(path, 'utf8')).toBe('binary')
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('正常路径：写入 insertSvgDocumentTitle 的结果', async () => {
    const path = join(dir, 'ok.svg')
    writeFileSync(path, '<svg></svg>')
    mockInsert.mockReturnValueOnce('<svg><title>T</title></svg>')
    await stampDotDocumentTitle(path, 'svg', 'T')
    expect(readFileSync(path, 'utf8')).toBe('<svg><title>T</title></svg>')
  })

  it('insertSvgDocumentTitle 抛 VectorFigureError 时转为 PatentToolError', async () => {
    const path = join(dir, 'bad.svg')
    writeFileSync(path, '<g/>')
    mockInsert.mockImplementation(() => {
      throw new VectorFigureError('invalid_input', '缺少根 svg 开标签')
    })
    // PatentToolError is imported as a value (dynamic import), so assert on constructor name.
    let err: Error | undefined
    try { await stampDotDocumentTitle(path, 'svg', 'T') } catch (e) { err = e as Error }
    expect(err?.constructor.name).toBe('PatentToolError')
    expect(err?.message).toContain('缺少根 svg 开标签')
  })

  it('insertSvgDocumentTitle 抛非 VectorFigureError 时原样重抛', async () => {
    const path = join(dir, 'other.svg')
    writeFileSync(path, '<svg></svg>')
    const cause = new TypeError('unexpected')
    mockInsert.mockImplementationOnce(() => { throw cause })
    await expect(stampDotDocumentTitle(path, 'svg', 'T')).rejects.toThrow(cause)
  })
})

const drawn = '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 100 50"><text x="1" y="40" font-size="3.5">壳体</text><line x1="0" y1="10" x2="10" y2="10" stroke="#000" fill="none"/></svg>'

describe('DXF sibling', () => {
  it('writes DXF before text-to-path and keeps TEXT after the SVG text is outlined', async () => {
    const path = join(dir, 'fig1.svg')
    writeFileSync(path, drawn)
    const output: GeneratePatentFigureOutput = {
      path: 'fig1.svg',
      absolutePath: path,
      format: 'svg',
      engine: 'dot',
      figureNumber: 1,
      figureType: 'flowchart',
      figureDescription: '',
      numeralMap: [],
      components: [],
      connections: [],
      warnings: [],
      indexed: false,
    }
    await finishDirectRender({
      deps: testDeps({
        outlineText: async (spec) => {
          writeFileSync(spec.path, readFileSync(spec.path, 'utf8').replace(/<text[\s\S]*?<\/text>/g, ''))
          return { ok: true }
        },
      }),
      outcomePath: path,
      input: {},
      suffix: '',
      format: 'svg',
      check: false,
      style: 'grayscale',
      signal: new AbortController().signal,
      output,
      figureType: 'flowchart',
      exportDxf: true,
    })
    expect(readFileSync(path, 'utf8')).not.toContain('<text')
    const dxfPath = output.dxfPaths?.[0]
    expect(dxfPath).toBe(join(dir, 'fig1.dxf'))
    expect(readFileSync(dxfPath ?? '', 'utf8')).toContain('壳体')
  })

  it('writes the DXF from the SVG chain before text is outlined', async () => {
    const path = join(dir, 'chain.svg')
    const outcomePath = join(dir, 'chain.png')
    writeFileSync(path, drawn)
    const output: GeneratePatentFigureOutput = {
      path: 'chain.png',
      absolutePath: outcomePath,
      format: 'png',
      engine: 'dot',
      figureNumber: 1,
      figureType: 'flowchart',
      figureDescription: '',
      numeralMap: [],
      components: [],
      connections: [],
      warnings: [],
      indexed: false,
    }
    const outcome = await finishSvgChain({
      deps: testDeps({
        exportFigure: async () => ({ ok: true, path: outcomePath }),
        outlineText: async (spec) => {
          writeFileSync(spec.path, readFileSync(spec.path, 'utf8').replace(/<text[\s\S]*?<\/text>/g, ''))
          return { ok: true }
        },
      }),
      svgPath: path,
      outcomePath,
      input: {},
      suffix: '',
      format: 'png',
      dpi: undefined,
      style: 'grayscale',
      signal: new AbortController().signal,
      output,
      figureType: 'flowchart',
      hasDirectRender: true,
      exportDxf: true,
    })
    expect(outcome).toBe('done')
    expect(readFileSync(path, 'utf8')).not.toContain('<text')
    expect(readFileSync(output.dxfPaths?.[0] ?? '', 'utf8')).toContain('壳体')
  })

  it('warns and writes nothing when the delivered file is not SVG', async () => {
    const output: GeneratePatentFigureOutput = {
      path: 'fig1.png',
      absolutePath: join(dir, 'fig1.png'),
      format: 'png',
      engine: 'dot',
      figureNumber: 1,
      figureType: 'flowchart',
      figureDescription: '',
      numeralMap: [],
      components: [],
      connections: [],
      warnings: [],
      indexed: false,
    }
    await finishDirectRender({
      deps: testDeps(),
      outcomePath: output.absolutePath,
      input: {},
      suffix: '',
      format: 'png',
      check: false,
      style: 'grayscale',
      signal: new AbortController().signal,
      output,
      figureType: 'flowchart',
      exportDxf: true,
    })
    expect(output.warnings).toContain('没有 SVG，未写 DXF')
    expect(output.dxfPaths).toBeUndefined()
  })

  it('does not repeat the missing-SVG warning when a DXF path is already recorded', async () => {
    const output: GeneratePatentFigureOutput = {
      path: 'fig2.png',
      absolutePath: join(dir, 'fig2.png'),
      format: 'png',
      engine: 'dot',
      figureNumber: 2,
      figureType: 'flowchart',
      figureDescription: '',
      numeralMap: [],
      components: [],
      connections: [],
      warnings: [],
      indexed: false,
      dxfPaths: ['already.dxf'],
    }
    await finishDirectRender({
      deps: testDeps(),
      outcomePath: output.absolutePath,
      input: {},
      suffix: '',
      format: 'png',
      check: false,
      style: 'grayscale',
      signal: new AbortController().signal,
      output,
      figureType: 'flowchart',
      exportDxf: true,
    })
    expect(output.warnings).not.toContain('没有 SVG，未写 DXF')
    expect(output.dxfPaths).toEqual(['already.dxf'])
  })

  it('removes the chain DXF when export fails so the direct render warns', async () => {
    const path = join(dir, 'fallback.svg')
    const outcomePath = join(dir, 'fallback.png')
    writeFileSync(path, drawn.replace(
      '<line',
      '<rect x="0" y="0" width="4" height="4" fill="#000" stroke="#000"/><line',
    ))
    const output: GeneratePatentFigureOutput = {
      path: 'fallback.png',
      absolutePath: outcomePath,
      format: 'png',
      engine: 'dot',
      figureNumber: 1,
      figureType: 'flowchart',
      figureDescription: '',
      numeralMap: [],
      components: [],
      connections: [],
      warnings: ['先前'],
      indexed: false,
    }
    const outcome = await finishSvgChain({
      deps: testDeps({
        exportFigure: async () => ({ ok: false, code: 'render_failed', error: 'inkscape down' }),
      }),
      svgPath: path,
      outcomePath,
      input: {},
      suffix: '',
      format: 'png',
      dpi: undefined,
      style: 'grayscale',
      signal: new AbortController().signal,
      output,
      figureType: 'flowchart',
      hasDirectRender: true,
      exportDxf: true,
    })
    expect(outcome).toBe('fallback')
    expect(existsSync(join(dir, 'fallback.dxf'))).toBe(false)
    expect(output.dxfPaths).toBeUndefined()
    expect(output.warnings).toEqual([
      '先前',
      '未能导出 png：inkscape down；落版、渲染复核与文字转路径未生效（它们只作用于 SVG），改由渲染器直接出图',
    ])
    await finishDirectRender({
      deps: testDeps(),
      outcomePath,
      input: {},
      suffix: '',
      format: 'png',
      check: false,
      style: 'grayscale',
      signal: new AbortController().signal,
      output,
      figureType: 'flowchart',
      exportDxf: true,
    })
    expect(output.warnings).toContain('没有 SVG，未写 DXF')
  })

  it('keeps a DXF recorded before this chain when export fails', async () => {
    const path = join(dir, 'fallback-kept.svg')
    const outcomePath = join(dir, 'fallback-kept.png')
    writeFileSync(path, drawn)
    const output: GeneratePatentFigureOutput = {
      path: 'fallback-kept.png',
      absolutePath: outcomePath,
      format: 'png',
      engine: 'dot',
      figureNumber: 2,
      figureType: 'flowchart',
      figureDescription: '',
      numeralMap: [],
      components: [],
      connections: [],
      warnings: ['先前'],
      indexed: false,
      dxfPaths: ['kept.dxf'],
    }
    const outcome = await finishSvgChain({
      deps: testDeps({
        exportFigure: async () => ({ ok: false, code: 'render_failed', error: 'inkscape down' }),
      }),
      svgPath: path,
      outcomePath,
      input: {},
      suffix: '',
      format: 'png',
      dpi: undefined,
      style: 'grayscale',
      signal: new AbortController().signal,
      output,
      figureType: 'flowchart',
      hasDirectRender: true,
      exportDxf: true,
    })
    expect(outcome).toBe('fallback')
    expect(existsSync(join(dir, 'fallback-kept.dxf'))).toBe(false)
    expect(output.dxfPaths).toEqual(['kept.dxf'])
    expect(output.warnings[0]).toBe('先前')
    expect(output.warnings).not.toContain('没有 SVG，未写 DXF')
    await finishDirectRender({
      deps: testDeps(),
      outcomePath,
      input: {},
      suffix: '',
      format: 'png',
      check: false,
      style: 'grayscale',
      signal: new AbortController().signal,
      output,
      figureType: 'flowchart',
      exportDxf: true,
    })
    expect(output.warnings).not.toContain('没有 SVG，未写 DXF')
    expect(output.dxfPaths).toEqual(['kept.dxf'])
  })

  it('does not write a DXF file when the SVG contains an image', async () => {
    const path = join(dir, 'photo.svg')
    writeFileSync(path, '<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm"><image href="a.png" width="10" height="10"/></svg>')
    const output = { warnings: [] as string[] }
    await expect(attachSiblingDxf(path, output, 'generate_patent_figure')).rejects.toThrow(/analyze_patent_figure/)
    expect(existsSync(join(dir, 'photo.dxf'))).toBe(false)
  })
})
