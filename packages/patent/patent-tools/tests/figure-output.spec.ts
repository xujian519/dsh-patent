import { describe, expect, it } from 'vitest'
import { renderGenerateFigureResult, upsertFigureIndex } from '../src/tool/figure-output.ts'
import type { GeneratePatentFigureOutput } from '../src/tool/figure-input.ts'
import type { FigureAnalysisResult } from '../src/tool/analyze-patent-figure.ts'

const analysis: FigureAnalysisResult = {
  imagePath: 'fig1.svg',
  figureNumber: 1,
  figureType: 'flowchart',
  overallDescription: '',
  components: [],
  connections: [],
  figureDescription: '',
  confidence: 1,
  warnings: [],
  usable: true,
  modelUsed: 'graphviz-generator',
}

describe('upsertFigureIndex', () => {
  it('returns true when the index write succeeds', async () => {
    const written: unknown[] = []
    const warnings: string[] = []
    const ok = await upsertFigureIndex({
      upsertIndex: async (entry) => { written.push(entry) },
      imagePath: 'fig1.svg',
      analysis,
      warnings,
      label: '',
    })
    expect(ok).toBe(true)
    expect(warnings).toEqual([])
    expect(written).toHaveLength(1)
  })

  it('records an Error failure as a warning and returns false', async () => {
    const warnings: string[] = []
    const ok = await upsertFigureIndex({
      upsertIndex: async () => { throw new Error('disk full') },
      imagePath: 'fig1.svg',
      analysis,
      warnings,
      label: '面板 A ',
    })
    expect(ok).toBe(false)
    expect(warnings).toEqual(['面板 A 附图索引写入失败（不阻断）：disk full'])
  })

  it('records a non-Error failure with its string form', async () => {
    const warnings: string[] = []
    const ok = await upsertFigureIndex({
      upsertIndex: async () => { throw 'disk gone' },
      imagePath: 'fig1.svg',
      analysis,
      warnings,
      label: '',
    })
    expect(ok).toBe(false)
    expect(warnings[0]).toContain('disk gone')
  })
})

describe('renderGenerateFigureResult', () => {
  const base: GeneratePatentFigureOutput = {
    path: 'figs/fig1.svg',
    absolutePath: '/tmp/figs/fig1.svg',
    format: 'svg',
    engine: 'dot',
    figureNumber: 1,
    figureType: 'flowchart',
    figureDescription: '图1是流程图。',
    numeralMap: [{ componentId: 'a', label: '开始', numeral: '100', figure: 1 }],
    components: [],
    connections: [],
    warnings: [],
    indexed: false,
  }

  it('renders the numeral table without a layout block', () => {
    const text = renderGenerateFigureResult(base)[0]!.text
    expect(text).toContain('已生成专利附图（图1，svg）：figs/fig1.svg')
    expect(text).toContain('绝对路径')
    expect(text).toContain('- 100 开始')
    expect(text).not.toContain('## 落版')
  })

  it('omits the character height line when the layout has no font metrics', () => {
    const text = renderGenerateFigureResult({
      ...base,
      layout: {
        office: 'cnipa',
        pageScale: 1,
        placedWidthMm: 100,
        placedHeightMm: 50,
        sheetNumber: '1',
      },
    })[0]!.text
    expect(text).not.toContain('字高')
    expect(text).toContain('- 页码 1')
  })

  it('renders layout metrics including character height, caption and sheet number', () => {
    const text = renderGenerateFigureResult({
      ...base,
      layout: {
        office: 'cnipa',
        pageScale: 1,
        placedWidthMm: 100,
        placedHeightMm: 50,
        charHeightMm: 3.2,
        reducedCharHeightMm: 2.1,
        caption: '图1',
        sheetNumber: '1',
      },
    })[0]!.text
    expect(text).toContain('## 落版（cnipa）')
    expect(text).toContain('- 字高 3.2 毫米（缩小至三分之二后 2.1 毫米）')
    expect(text).toContain('- 图号 图1')
    expect(text).toContain('- 页码 1')
  })

  it('skips the sheet-number line when the layout sheet number is empty', () => {
    const text = renderGenerateFigureResult({
      ...base,
      layout: {
        office: 'cnipa',
        pageScale: 1,
        placedWidthMm: 100,
        placedHeightMm: 50,
        sheetNumber: '',
      },
    })[0]!.text
    expect(text).toContain('## 落版（cnipa）')
    expect(text).not.toContain('- 页码')
  })

  it('joins panel paths in the header', () => {
    const text = renderGenerateFigureResult({
      ...base,
      panels: [
        { suffix: 'A', path: 'figs/fig1A.svg', absolutePath: '/tmp/figs/fig1A.svg', figureType: 'flowchart' },
        { suffix: 'B', path: 'figs/fig1B.svg', absolutePath: '/tmp/figs/fig1B.svg', figureType: 'flowchart' },
      ],
    })[0]!.text
    expect(text).toContain('figs/fig1A.svg、figs/fig1B.svg')
    expect(text).toContain('/tmp/figs/fig1A.svg、/tmp/figs/fig1B.svg')
  })
})
