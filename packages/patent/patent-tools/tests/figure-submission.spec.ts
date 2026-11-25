import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { figureCaption, officeProfile, sheetNumberText, TARGET_OFFICES } from '../src/figure/office-profile.ts'
import type { OfficeProfile } from '../src/figure/office-profile.ts'
import { buildSubmissionPage, parseDrawingSvg } from '../src/figure/submission-page.ts'
import { measureInkBounds } from '../src/figure/render-check.ts'
import { parseLengthMm } from '../src/figure/svg-viewport.ts'
import type { SubmissionPageMetrics } from '../src/figure/submission-page.ts'
import { drawingComplianceWarnings } from '../src/figure/compliance.ts'
import { SvgAnnotateError } from '../src/figure/svg-annotate.ts'
import { createGeneratePatentFigureTool } from '../src/tool/generate-patent-figure.ts'
import { applySubmissionPage, buildLayout, resolveSubmission } from '../src/tool/figure-submission.ts'
import { PatentToolError } from '../src/error.ts'
import type { GraphvizRenderOutcome, GraphvizRenderSpec } from '../src/figure/graphviz-renderer.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const signal = new AbortController().signal

async function ctxWith(...tools: ToolDefinition[]): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  for (const t of tools) ctx.tools.register(t)
  return ctx
}

function execute(ctx: Context, name: string, args: unknown, label: string) {
  return executeToolFixture(ctx, { signal, callId: ToolCallId(label), name, arguments: args })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
}

/** Graphviz 形态的 SVG（含 pt 尺寸与带偏移的 viewBox），供落版解析。 */
const GRAPHVIZ_SVG = [
  '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
  '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">',
  '<svg width="400pt" height="500pt" viewBox="0 0 400 500" xmlns="http://www.w3.org/2000/svg">',
  '  <g><text font-size="10">A</text></g>',
  '</svg>',
].join('\n')

/** fake renderer：写出指定 SVG 文本并返回其路径。 */
function svgRenderer(svg: string): { render: (spec: GraphvizRenderSpec) => Promise<GraphvizRenderOutcome> } {
  return {
    render: (spec) => {
      const out = join(spec.outputDir, `${spec.filename}.${spec.format}`)
      writeFileSync(out, svg)
      return Promise.resolve({ ok: true, path: out })
    },
  }
}

const flowSteps = [
  { id: 'start', label: '开始', shape: 'ellipse' as const, next: ['s1'] },
  { id: 's1', label: '处理', next: [] },
]

describe('office-profile：目标法域附图规格', () => {
  it('中国档案：A4、25/25/15/15 毫米、图N、必要时彩色、附图片页码', () => {
    const profile = officeProfile('cnipa')
    expect(profile.paper).toEqual({ widthMm: 210, heightMm: 297 })
    expect(profile.margins).toEqual({ topMm: 25, leftMm: 25, rightMm: 15, bottomMm: 15 })
    expect(profile.captionStyle).toBe('figure-number')
    expect(profile.color).toBe('color-if-necessary')
    expect(profile.sheetNumbering).toBe('figure-pages')
    expect(profile.minCharHeightMm).toBeUndefined()
    expect(profile.reductionRatio).toBeCloseTo(2 / 3)
  })

  it('PCT 与美国档案：0.32 厘米最短字高、不得着色、1/3 页码', () => {
    for (const office of ['pct', 'uspto'] as const) {
      const profile = officeProfile(office)
      expect(profile.minCharHeightMm).toBe(3.2)
      expect(profile.color).toBe('monochrome')
      expect(profile.sheetNumbering).toBe('sheet-of')
      expect(profile.margins.bottomMm).toBe(10)
    }
    expect(officeProfile('pct').captionStyle).toBe('fig')
    expect(officeProfile('uspto').captionStyle).toBe('fig-upper')
    expect(TARGET_OFFICES).toEqual(['cnipa', 'pct', 'uspto'])
  })

  it('图号：两幅以上才编号；写法按法域', () => {
    expect(figureCaption(officeProfile('cnipa'), 1, 1)).toBeUndefined()
    expect(figureCaption(officeProfile('cnipa'), 2, 3)).toBe('图2')
    expect(figureCaption(officeProfile('pct'), 1, 1)).toBeUndefined()
    expect(figureCaption(officeProfile('pct'), 3, 3)).toBe('Fig. 3')
    expect(figureCaption(officeProfile('uspto'), 2, 2)).toBe('FIG. 2')
  })

  it('图号参数非法时报 RangeError', () => {
    expect(() => figureCaption(officeProfile('cnipa'), 0, 2)).toThrow(RangeError)
    expect(() => figureCaption(officeProfile('cnipa'), 1.5, 2)).toThrow(RangeError)
    expect(() => figureCaption(officeProfile('cnipa'), 3, 2)).toThrow(RangeError)
  })

  it('页码：中国写「第N页 共M页」（单页写「第N页」），PCT/美国写「页序/总页数」', () => {
    expect(sheetNumberText(officeProfile('cnipa'), 2, 5)).toBe('第2页 共5页')
    expect(sheetNumberText(officeProfile('cnipa'), 1, 1)).toBe('第1页')
    expect(sheetNumberText(officeProfile('pct'), 2, 5)).toBe('2/5')
    expect(sheetNumberText(officeProfile('uspto'), 1, 1)).toBe('1/1')
    expect(() => sheetNumberText(officeProfile('cnipa'), 0, 5)).toThrow(RangeError)
    expect(() => sheetNumberText(officeProfile('cnipa'), 6, 5)).toThrow(RangeError)
  })
})

describe('submission-page：SVG 长度解析与图形几何', () => {
  it('长度单位换算', () => {
    expect(parseLengthMm('210mm')).toBe(210)
    expect(parseLengthMm('21cm')).toBe(210)
    expect(parseLengthMm('8.27in')).toBeCloseTo(210.058)
    expect(parseLengthMm('72pt')).toBeCloseTo(25.4)
    expect(parseLengthMm('96px')).toBeCloseTo(25.4)
    expect(parseLengthMm('96')).toBeCloseTo(25.4)
    expect(parseLengthMm(' 12.5 mm ')).toBe(12.5)
    expect(parseLengthMm('50%')).toBeUndefined()
    expect(parseLengthMm('auto')).toBeUndefined()
  })

  it('解析 pt 尺寸与 viewBox，换算用户单位', () => {
    const { geometry, warnings } = parseDrawingSvg(GRAPHVIZ_SVG)
    expect(geometry.widthMm).toBeCloseTo(141.11, 1)
    expect(geometry.heightMm).toBeCloseTo(176.39, 1)
    expect(geometry.userUnitToMmX).toBeCloseTo(geometry.widthMm / 400)
    expect(geometry.userUnitToMmY).toBeCloseTo(geometry.heightMm / 500)
    expect(geometry.inner).toContain('<text font-size="10">A</text>')
    expect(warnings).toEqual([])
  })

  it('缺 width/height 时按 viewBox 的 96 dpi 换算并给提示', () => {
    const svg = '<svg viewBox="0 0 96 192" xmlns="http://www.w3.org/2000/svg"><g/></svg>'
    const { geometry, warnings } = parseDrawingSvg(svg)
    expect(geometry.widthMm).toBeCloseTo(25.4)
    expect(geometry.heightMm).toBeCloseTo(50.8)
    expect(warnings[0]).toContain('96 dpi')
  })

  it('只声明一边尺寸时把视口对齐的假设说明并入提示', () => {
    const svg = '<svg width="96mm" viewBox="0 0 96 192" xmlns="http://www.w3.org/2000/svg"><g/></svg>'
    const { geometry, warnings } = parseDrawingSvg(svg)
    expect(geometry.heightMm).toBeCloseTo(192 * 25.4 / 96, 10)
    expect(warnings.join('\n')).toContain('96 dpi')
  })

  it('拒绝非 SVG、缺尺寸与不安全结构', () => {
    expect(() => parseDrawingSvg('<html></html>')).toThrow(SvgAnnotateError)
    expect(() => parseDrawingSvg('<svg xmlns="http://www.w3.org/2000/svg"><g/></svg>')).toThrow(SvgAnnotateError)
    expect(() => parseDrawingSvg('<svg width="1mm" height="1mm"><!ENTITY x "y"></svg>')).toThrow(SvgAnnotateError)
  })
})

describe('submission-page：落版', () => {
  it('中国：A4 幅面、图号在图形正下方、页码在版心底部', () => {
    const page = buildSubmissionPage({
      drawingSvg: GRAPHVIZ_SVG,
      profile: officeProfile('cnipa'),
      caption: '图1',
      sheetNumber: '1',
      bodyFontSize: 10,
    })
    expect(page.svg).toContain('width="210mm" height="297mm"')
    expect(page.svg).toContain('viewBox="0 0 210 297"')
    expect(page.svg).toContain('text-anchor="middle"')
    expect(page.svg).toContain('>图1</text>')
    expect(page.svg).toContain('>1</text>')
    // 图号 y 在图形下沿之下
    const captionY = Number(/>图1<\/text>/.exec(page.svg) === null ? 0 : /<text x="[^"]*" y="([^"]*)"[^>]*>图1</.exec(page.svg)?.[1])
    expect(captionY).toBeGreaterThan(page.metrics.placedHeightMm + 25)
    expect(page.metrics.placedWidthMm).toBeCloseTo(page.metrics.drawingWidthMm * page.metrics.pageScale)
    expect(page.metrics.charHeightMm).toBeCloseTo(
      10 * (page.metrics.drawingHeightMm / 500) * 0.7 * page.metrics.pageScale,
    )
    expect(page.metrics.reducedCharHeightMm).toBeCloseTo((page.metrics.charHeightMm ?? 0) * (2 / 3))
    expect(page.warnings).toEqual([])
  })

  it('无图号/页码时不写入落版文本元素', () => {
    const page = buildSubmissionPage({ drawingSvg: GRAPHVIZ_SVG, profile: officeProfile('cnipa') })
    // 落版新增的图号/页码文本一律 text-anchor="middle"；源图形内没有这种文本。
    expect(page.svg).not.toContain('text-anchor="middle"')
    expect(page.metrics.charHeightMm).toBeUndefined()
    expect(page.metrics.reducedCharHeightMm).toBeUndefined()
  })

  it('极小的图形放大被截断并给出提示', () => {
    const tiny = '<svg width="1mm" height="1mm" xmlns="http://www.w3.org/2000/svg"><g/></svg>'
    const page = buildSubmissionPage({ drawingSvg: tiny, profile: officeProfile('uspto'), caption: 'FIG. 1', sheetNumber: '1/1' })
    expect(page.metrics.pageScale).toBe(4)
    expect(page.warnings[0]).toContain('放大被限制')
    expect(page.svg).toContain('>FIG. 1</text>')
  })

  it('参数与幅面非法时报 RangeError', () => {
    const tiny = '<svg width="10mm" height="10mm" xmlns="http://www.w3.org/2000/svg"><g/></svg>'
    const base = { drawingSvg: tiny, profile: officeProfile('cnipa') }
    expect(() => buildSubmissionPage({ ...base, captionFontMm: 0 })).toThrow(RangeError)
    expect(() => buildSubmissionPage({ ...base, captionGapMm: -1 })).toThrow(RangeError)
    expect(() => buildSubmissionPage({ ...base, sheetFontMm: Number.NaN })).toThrow(RangeError)
    expect(() => buildSubmissionPage({ ...base, bodyFontSize: 0 })).toThrow(RangeError)
    const crowded: OfficeProfile = { ...officeProfile('cnipa'), margins: { topMm: 200, leftMm: 20, rightMm: 20, bottomMm: 200 } }
    expect(() => buildSubmissionPage({ ...base, profile: crowded })).toThrow(RangeError)
  })

  it('片段里的空行缩进后仍为空行', () => {
    const svg = '<svg width="100mm" height="100mm" xmlns="http://www.w3.org/2000/svg">\n<g/>\n\n<rect x="0" y="0" width="10" height="10"/>\n</svg>'
    const page = buildSubmissionPage({ drawingSvg: svg, profile: officeProfile('cnipa') })
    // 片段中间的空行在缩进后仍是空行（只有首尾空白被 trim 掉）。
    expect(page.svg).toContain('\n\n')
  })

  it('图号/页码字号与间距按参数落到落版文本', () => {
    const tiny = '<svg width="100mm" height="100mm" xmlns="http://www.w3.org/2000/svg"><g/></svg>'
    const base = { drawingSvg: tiny, profile: officeProfile('cnipa'), caption: '图1', sheetNumber: '1' }
    const read = (svg: string, text: string): { font: number; y: number } => {
      const match = new RegExp(`<text x="([^"]*)" y="([^"]*)"[^>]*font-size="([^"]*)"[^>]*>${text}</`).exec(svg)
      return { font: Number(match?.[3]), y: Number(match?.[2]) }
    }
    expect(read(buildSubmissionPage(base).svg, '图1')).toEqual({ font: 4, y: 241.2 })
    // 图号 y = 图形下沿 + 间距 + 字高×0.8；字号与间距也参与上方的图号块高度，
    // 故放大后图形上移、y 的增量小于「间距+字高」的增量。
    expect(read(buildSubmissionPage({ ...base, captionFontMm: 5, captionGapMm: 6 }).svg, '图1')).toEqual({ font: 5, y: 243 })
    expect(read(buildSubmissionPage({ ...base, sheetFontMm: 6 }).svg, '1').font).toBe(6)
  })
})

describe('submission-page：落版旋转', () => {
  /** 精确填满声明尺寸的矩形，供墨迹量测（无图号/页码时墨迹即图形框）。 */
  const boxed = (widthMm: number, heightMm: number): string =>
    `<svg width="${String(widthMm)}mm" height="${String(heightMm)}mm" viewBox="0 0 ${String(widthMm)} ${String(heightMm)}" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="${String(widthMm)}" height="${String(heightMm)}" fill="none" stroke="#000000"/></svg>`

  it('90°：纵横比互换、旋转后仍装进可绘图区、绕绘图区中心', () => {
    const profile = officeProfile('cnipa')
    const plain = buildSubmissionPage({ drawingSvg: boxed(200, 100), profile })
    const turned = buildSubmissionPage({ drawingSvg: boxed(200, 100), profile, rotateDeg: 90 })
    expect(turned.metrics.placedWidthMm / turned.metrics.placedHeightMm)
      .toBeCloseTo(plain.metrics.placedHeightMm / plain.metrics.placedWidthMm)
    // 可绘图区 170×257；旋转后仍不越界（这正是按旋转后占位重算缩放比的原因）。
    expect(turned.metrics.placedWidthMm).toBeLessThanOrEqual(170)
    expect(turned.metrics.placedHeightMm).toBeLessThanOrEqual(257)
    // 绕可绘图区中心：x 25+170/2=110，y 25+257/2=153.5。
    expect(turned.svg).toContain('translate(110,153.5) rotate(90) translate(-110,-153.5)')
    expect(plain.svg).not.toContain('rotate(')
    // 墨迹中心落在可绘图区中心（两种朝向都不偏），且不越出可绘图区。
    const slack = 1e-6
    for (const [label, page, area] of [['不旋转', plain, 170 * 85], ['旋转', turned, 128.5 * 257]] as const) {
      const ink = measureInkBounds(page.svg)
      expect(ink, label).toBeDefined()
      expect(ink?.minX ?? 0, label).toBeGreaterThanOrEqual(25 - slack)
      expect(ink?.maxX ?? 0, label).toBeLessThanOrEqual(195 + slack)
      expect(ink?.minY ?? 0, label).toBeGreaterThanOrEqual(25 - slack)
      expect(ink?.maxY ?? 0, label).toBeLessThanOrEqual(282 + slack)
      expect(((ink?.maxX ?? 0) + (ink?.minX ?? 0)) / 2, label).toBeCloseTo(110)
      expect(((ink?.maxY ?? 0) + (ink?.minY ?? 0)) / 2, label).toBeCloseTo(153.5)
      // 占位面积与旋转无关地守恒（缩放比不同，故只比面积）
      expect(((ink?.maxX ?? 0) - (ink?.minX ?? 0)) * ((ink?.maxY ?? 0) - (ink?.minY ?? 0)), label).toBeCloseTo(area, 0)
    }
  })

  it('正方形图形旋转 90°：图号与页码的 y 逐值不变', () => {
    const profile = officeProfile('cnipa')
    const base = { drawingSvg: boxed(100, 100), profile, caption: '图1', sheetNumber: '1' }
    const plain = buildSubmissionPage(base)
    const turned = buildSubmissionPage({ ...base, rotateDeg: 90 })
    const y = (svg: string, text: string): string | undefined =>
      new RegExp(`<text x="[^"]*" y="([^"]*)"[^>]*>${text}</`).exec(svg)?.[1]
    expect(y(turned.svg, '图1')).toBe(y(plain.svg, '图1'))
    expect(y(turned.svg, '1')).toBe(y(plain.svg, '1'))
    expect(turned.metrics.placedWidthMm).toBeCloseTo(plain.metrics.placedWidthMm)
    expect(turned.metrics.placedHeightMm).toBeCloseTo(plain.metrics.placedHeightMm)
  })

  it('非正方形图形旋转后图号仍紧贴旋转后图形的下沿', () => {
    const profile = officeProfile('cnipa')
    const base = { drawingSvg: boxed(200, 100), profile, caption: '图1', sheetNumber: '1' }
    const page = buildSubmissionPage({ ...base, rotateDeg: 90 })
    const captionY = Number(/<text x="[^"]*" y="([^"]*)"[^>]*>图1</.exec(page.svg)?.[1])
    // 图号块占 3+4 毫米，故可绘图区高 250；图形下沿 = 25 + (250 - placedHeight)/2 + placedHeight。
    expect(captionY).toBeCloseTo(25 + (250 + page.metrics.placedHeightMm) / 2 + 3 + 4 * 0.8)
  })

  it('0 与不传逐字节一致', () => {
    const base = { drawingSvg: GRAPHVIZ_SVG, profile: officeProfile('cnipa'), caption: '图1', sheetNumber: '1' }
    expect(buildSubmissionPage({ ...base, rotateDeg: 0 }).svg).toBe(buildSubmissionPage(base).svg)
  })
})

describe('figure-submission：落版应用与布局核算', () => {
  it('把落版页面的警告接进调用方的警告数组', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-submission-'))
    try {
      const target = join(dir, 'fig1.svg')
      const tiny = '<svg width="1mm" height="1mm" xmlns="http://www.w3.org/2000/svg"><g/></svg>'
      writeFileSync(target, tiny, 'utf8')
      const plan = resolveSubmission({ target_office: 'uspto' }, '')
      if (plan === undefined) throw new Error('expected a submission plan')
      const warnings: string[] = []
      const applied = await applySubmissionPage(target, plan, 'svg', warnings)
      expect(applied?.metrics.pageScale).toBe(4)
      expect(warnings[0]).toContain('落版：图形相对幅面过小')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('落版布局带字高、缩减字高与图号', () => {
    const plan = resolveSubmission({
      target_office: 'cnipa',
      figure_number: 2,
      figure_count: 2,
    }, '')
    if (plan === undefined) throw new Error('expected a submission plan')
    const warnings: string[] = []
    const layout = buildLayout(plan, {
      metrics: {
        pageScale: 1,
        placedWidthMm: 100,
        placedHeightMm: 50,
        drawingWidthMm: 100,
        drawingHeightMm: 50,
        charHeightMm: 3.2,
        reducedCharHeightMm: 2.1,
      },
      caption: '图2',
      sheetNumber: '1',
    }, 'grayscale', 2, warnings)
    expect(layout.charHeightMm).toBe(3.2)
    expect(layout.reducedCharHeightMm).toBe(2.1)
    expect(layout.caption).toBe('图2')
    expect(warnings).toEqual([])
  })

  it('落版布局在缺字号量测时省略字高字段', () => {
    const plan = resolveSubmission({ target_office: 'cnipa' }, '')
    if (plan === undefined) throw new Error('expected a submission plan')
    const layout = buildLayout(plan, {
      metrics: {
        pageScale: 1,
        placedWidthMm: 100,
        placedHeightMm: 50,
        drawingWidthMm: 100,
        drawingHeightMm: 50,
      },
      sheetNumber: '1',
    }, 'grayscale', 1, [])
    expect(layout.charHeightMm).toBeUndefined()
    expect(layout.reducedCharHeightMm).toBeUndefined()
    expect(layout.caption).toBeUndefined()
  })
})

describe('figure-submission：图号写法与页码', () => {
  it('自定义图号必须匹配目标法域写法', () => {
    expect(resolveSubmission({ target_office: 'cnipa', figure_number: 2, figure_count: 2, caption: '图2' }, '')?.caption).toBe('图2')
    expect(() => resolveSubmission({ target_office: 'cnipa', figure_number: 2, figure_count: 2, caption: 'Fig. 2' }, ''))
      .toThrow('不符合该法域写法')
    expect(() => resolveSubmission({ target_office: 'cnipa', figure_number: 1, figure_count: 1, caption: '图1' }, ''))
      .toThrow('不足两幅时不编号')
  })

  it('未写页码时落版给出 warning', () => {
    const page = buildSubmissionPage({
      drawingSvg: '<svg width="10mm" height="10mm" xmlns="http://www.w3.org/2000/svg"><g/></svg>',
      profile: officeProfile('cnipa'),
      caption: '图1',
      sheetNumber: undefined,
    })
    expect(page.warnings.join('\n')).toContain('未写页码')
    expect(page.svg).not.toContain('data-dsh-role="sheet-number"')
  })

  it('显式空页码不画页码也不警告', () => {
    const page = buildSubmissionPage({
      drawingSvg: '<svg width="10mm" height="10mm" xmlns="http://www.w3.org/2000/svg"><g/></svg>',
      profile: officeProfile('cnipa'),
      caption: '图1',
      sheetNumber: '',
    })
    expect(page.warnings.join('\n')).not.toContain('未写页码')
    expect(page.svg).not.toContain('data-dsh-role="sheet-number"')
    expect(page.svg).toContain('data-dsh-role="caption"')
  })

  it('sheet_number false 计划值为空字符串，且不校验页序', () => {
    expect(resolveSubmission({ target_office: 'cnipa' }, '')?.sheetNumber).toBe('第1页')
    expect(resolveSubmission({ target_office: 'cnipa', sheet_number: true }, '')?.sheetNumber).toBe('第1页')
    expect(resolveSubmission({ target_office: 'pct', sheet_index: 1, sheet_total: 1 }, '')?.sheetNumber).toBe('1/1')
    expect(resolveSubmission({ target_office: 'cnipa', sheet_number: false }, '')?.sheetNumber).toBe('')
    expect(resolveSubmission({ target_office: 'cnipa', sheet_number: false, sheet_index: 0, sheet_total: 1 }, '')?.sheetNumber).toBe('')
    expect(resolveSubmission({ sheet_number: false }, '')).toBeUndefined()
  })
})

describe('figure-submission：落版参数解析', () => {
  it('rotate_deg 收窄到闭集；非闭集值报 invalid_tool_input', () => {
    expect(resolveSubmission({}, '')).toBeUndefined()
    expect(resolveSubmission({ target_office: 'cnipa' }, '')?.rotateDeg).toBe(0)
    expect(resolveSubmission({ target_office: 'cnipa', rotate_deg: 270 }, '')?.rotateDeg).toBe(270)
    // schema 的 enum 已挡下模型的非法值；这一层对绕过 schema 的调用方收口。
    expect(() => resolveSubmission({ target_office: 'cnipa', rotate_deg: 45 }, '')).toThrow(PatentToolError)
  })

  it('正文字号由调用方代入（部署图面字号），缺省沿用历史默认 10pt', () => {
    // DOT 图代入 pt（小四 = 12.05pt），直绘图型代入毫米；两者都进落版核算。
    expect(resolveSubmission({ target_office: 'cnipa' }, '', 12.05)?.bodyFontSize).toBe(12.05)
    expect(resolveSubmission({ target_office: 'cnipa' }, '', 4.25)?.bodyFontSize).toBe(4.25)
    expect(resolveSubmission({ target_office: 'cnipa' }, '')?.bodyFontSize).toBe(10)
    expect(() => resolveSubmission({ target_office: 'cnipa', rotate_deg: 45 }, '')).toThrow('rotate_deg 只支持 0/90/180/270（度）')
  })

  it('字号/间距填默认并校验为正', () => {
    const plain = resolveSubmission({ target_office: 'cnipa' }, '')
    expect(plain).toMatchObject({ captionFontMm: 4, captionGapMm: 3, sheetFontMm: 3, fitToPage: true })
    expect(resolveSubmission({ target_office: 'cnipa', caption_font_mm: 5, caption_gap_mm: 2, sheet_font_mm: 4, fit_to_page: false }, ''))
      .toMatchObject({ captionFontMm: 5, captionGapMm: 2, sheetFontMm: 4, fitToPage: false })
    expect(() => resolveSubmission({ target_office: 'cnipa', caption_font_mm: 0 }, '')).toThrow('caption_font_mm')
    expect(() => resolveSubmission({ target_office: 'cnipa', caption_gap_mm: Number.NaN }, '')).toThrow('caption_gap_mm')
    expect(() => resolveSubmission({ target_office: 'cnipa', sheet_font_mm: -1 }, '')).toThrow('sheet_font_mm')
  })
})

describe('compliance：合规核算', () => {
  const metrics = (over: Partial<SubmissionPageMetrics> = {}): SubmissionPageMetrics => ({
    pageScale: 1,
    drawingWidthMm: 150,
    drawingHeightMm: 200,
    placedWidthMm: 150,
    placedHeightMm: 200,
    ...over,
  })

  it('PCT/美国：彩色附图与未标图号各一条警告', () => {
    const pct = drawingComplianceWarnings({
      profile: officeProfile('pct'),
      style: 'semantic',
      figureCount: 3,
      hasCaption: false,
      metrics: metrics(),
    })
    expect(pct.join('\n')).toContain('11.13(a)')
    expect(pct.join('\n')).toContain('11.13(k)')
    const uspto = drawingComplianceWarnings({
      profile: officeProfile('uspto'),
      style: 'semantic',
      figureCount: 1,
      hasCaption: true,
      metrics: metrics(),
    })
    expect(uspto.join('\n')).toContain('1.84(a)(2)')
    expect(uspto).toHaveLength(1)
    // 美国未标图号时引 37 CFR 1.84(u)（不是 PCT/中国的依据）。
    const uncaptioned = drawingComplianceWarnings({
      profile: officeProfile('uspto'),
      style: 'grayscale',
      figureCount: 2,
      hasCaption: false,
      metrics: metrics(),
    })
    expect(uncaptioned.join('\n')).toContain('37 CFR 1.84(u)')
  })

  it('摘要附图按 40×60 毫米核算缩放后字高，且不宣称清晰', () => {
    const warnings = drawingComplianceWarnings({
      profile: officeProfile('cnipa'),
      style: 'grayscale',
      figureCount: 2,
      hasCaption: true,
      abstractFigure: true,
      metrics: metrics({ placedWidthMm: 80, placedHeightMm: 120, charHeightMm: 4 }),
    })
    expect(warnings.join('\n')).toContain('40×60 毫米')
    expect(warnings.join('\n')).toContain('字高约 2 毫米')
    expect(warnings.join('\n')).toContain('不判定“清晰”')
    // 非摘要附图不产生该警告。
    expect(drawingComplianceWarnings({
      profile: officeProfile('cnipa'),
      style: 'grayscale',
      figureCount: 2,
      hasCaption: true,
      metrics: metrics({ placedWidthMm: 80, placedHeightMm: 120, charHeightMm: 4 }),
    })).toEqual([])
  })

  it('中国：彩色提示必要性与「正下方」编号依据', () => {
    const warnings = drawingComplianceWarnings({
      profile: officeProfile('cnipa'),
      style: 'semantic',
      figureCount: 2,
      hasCaption: false,
      metrics: metrics(),
    })
    expect(warnings.join('\n')).toContain('必要时')
    expect(warnings.join('\n')).toContain('第一部分第一章 4.3')
  })

  it('字高核算：低于该法域下限时报出法源与实测值', () => {
    const low = drawingComplianceWarnings({
      profile: officeProfile('pct'),
      style: 'grayscale',
      figureCount: 1,
      hasCaption: false,
      metrics: metrics({ charHeightMm: 2.5, reducedCharHeightMm: 1.6 }),
    })
    expect(low).toHaveLength(1)
    expect(low[0]).toContain('11.13(h)')
    const uspto = drawingComplianceWarnings({
      profile: officeProfile('uspto'),
      style: 'grayscale',
      figureCount: 1,
      hasCaption: true,
      metrics: metrics({ charHeightMm: 3.1 }),
    })
    expect(uspto.join('\n')).toContain('1.84(p)(3)')
    // 未提供字号时无字高结论
    expect(drawingComplianceWarnings({
      profile: officeProfile('pct'),
      style: 'grayscale',
      figureCount: 1,
      hasCaption: true,
      metrics: metrics(),
    })).toEqual([])
  })

  it('字高达标且黑白时无警告（中国不设字高下限）', () => {
    expect(drawingComplianceWarnings({
      profile: officeProfile('pct'),
      style: 'grayscale',
      figureCount: 1,
      hasCaption: false,
      metrics: metrics({ charHeightMm: 3.6, reducedCharHeightMm: 2.4 }),
    })).toEqual([])
    expect(drawingComplianceWarnings({
      profile: officeProfile('cnipa'),
      style: 'grayscale',
      figureCount: 5,
      hasCaption: true,
      metrics: metrics({ charHeightMm: 0.5, reducedCharHeightMm: 0.3 }),
    })).toEqual([])
  })
})

describe('generate_patent_figure：非 SVG 走 SVG 全链', () => {
  /** 假导出端口：记录规格，并写出目标文件；返回设定的结果。 */
  function fakeExport(result: { ok: true } | { ok: false; code: 'not_installed' | 'render_failed' | 'aborted'; error: string } = { ok: true }) {
    const calls: { path: string; outcomePath: string; format: string; dpi?: number; laidOutSvg: string }[] = []
    const exportFigure = (spec: { path: string; outcomePath: string; format: string; dpi?: number }): Promise<typeof result> => {
      calls.push({ ...spec, laidOutSvg: readFileSync(spec.path, 'utf8') })
      if (result.ok) writeFileSync(spec.outcomePath, `${spec.format.toUpperCase()} bytes`, 'utf8')
      return Promise.resolve(result)
    }
    return { exportFigure, calls }
  }

  function harness(exportFigure: ReturnType<typeof fakeExport>['exportFigure'] | undefined) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-chain-'))
    const outDir = join(dir, 'figs')
    const tool = createGeneratePatentFigureTool({
      ...svgRenderer(GRAPHVIZ_SVG),
      outputDir: outDir,
      cwd: dir,
      ...(exportFigure === undefined ? {} : { exportFigure }),
    })
    return { dir, outDir, tool }
  }

  it('pdf + target_office：中间 SVG 已落版，最终交付 pdf 并带 layout', async () => {
    const { exportFigure, calls } = fakeExport()
    const { dir, tool } = harness(exportFigure)
    const ctx = await ctxWith(tool)
    try {
      const result = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'flowchart',
        steps: flowSteps,
        target_office: 'cnipa',
        figure_count: 2,
        format: 'pdf',
        dpi: 300,
      }, 'c1') as { isError: boolean; value: { path: string; format: string; layout?: { office: string; caption?: string }; warnings: string[] } }
      expect(result.isError).toBe(false)
      expect(result.value.format).toBe('pdf')
      expect(result.value.path).toBe('figs/fig1.pdf')
      expect(result.value.layout).toMatchObject({ office: 'cnipa', caption: '图1' })
      // 交给 Inkscape 的是已落版的 A4 附图页（不是 Graphviz 原始画布）。
      expect(calls).toHaveLength(1)
      expect(calls[0]?.path).toBe(join(dir, 'figs', 'fig1.svg'))
      expect(calls[0]?.outcomePath).toBe(join(dir, 'figs', 'fig1.pdf'))
      expect(calls[0]?.format).toBe('pdf')
      expect(calls[0]?.dpi).toBe(300)
      expect(calls[0]?.laidOutSvg).toContain('width="210mm" height="297mm"')
      expect(calls[0]?.laidOutSvg).toContain('>图1</text>')
      expect(readFileSync(join(dir, 'figs', 'fig1.pdf'), 'utf8')).toBe('PDF bytes')
      // 落版/复核的提示照常进入 warnings（复核本身对该图无发现）。
      expect(result.value.warnings.join('\n')).not.toContain('未生效')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('导出失败：直绘图型退回渲染器直接出图并说明哪几步未生效', async () => {
    const { exportFigure } = fakeExport({ ok: false, code: 'render_failed', error: 'Inkscape 导出 png 失败（退出码 1）' })
    const { dir, outDir, tool } = harness(exportFigure)
    const ctx = await ctxWith(tool)
    try {
      const result = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'flowchart',
        steps: flowSteps,
        target_office: 'cnipa',
        figure_count: 2,
        format: 'png',
      }, 'c2') as { isError: boolean; value: { path: string; layout?: unknown; warnings: string[] } }
      expect(result.isError).toBe(false)
      expect(result.value.path).toBe('figs/fig1.png')
      expect(result.value.layout).toBeUndefined()
      expect(result.value.warnings.join('\n')).toContain('落版、渲染复核与文字转路径未生效')
      // 回退产物来自渲染器直接出图，不是导出端口写的。
      expect(readFileSync(join(outDir, 'fig1.png'), 'utf8')).toBe(GRAPHVIZ_SVG)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('直绘图型导出 png：走全链（此前只支持 svg）', async () => {
    const { exportFigure, calls } = fakeExport()
    const { dir, tool } = harness(exportFigure)
    const ctx = await ctxWith(tool)
    try {
      const result = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'cross_section',
        sections: {
          parts: [{ label: '基座', outline: [[0, 0], [40, 0], [40, 20], [0, 20]], hatch: 'none' }],
        },
        format: 'png',
        target_office: 'cnipa',
        figure_count: 2,
      }, 'c3') as { isError: boolean; value: { path: string; layout?: unknown } }
      expect(result.isError).toBe(false)
      expect(result.value.path).toBe('figs/fig1.png')
      expect(result.value.layout).toBeDefined()
      expect(calls[0]?.format).toBe('png')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('直绘图型导出失败：无 SVG 直绘以外的通路，报 setup_required', async () => {
    const { exportFigure } = fakeExport({ ok: false, code: 'not_installed', error: '未找到 Inkscape。' })
    const { dir, tool } = harness(exportFigure)
    const ctx = await ctxWith(tool)
    try {
      const result = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'circuit',
        circuit: {
          components: [
            { id: 'v1', kind: 'voltage_source', label: '电源', col: 0, row: 0 },
            { id: 'r1', kind: 'resistor', label: '电阻', col: 1, row: 0 },
          ],
          connections: [{ from: 'v1', to: 'r1' }],
        },
        format: 'png',
      }, 'c4')
      expect(result.isError).toBe(true)
      expect(text(result)).toContain('未找到 Inkscape')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('未注入导出端口：保持渲染器直接出图并提示需要 Inkscape', async () => {
    const { dir, tool } = harness(undefined)
    const ctx = await ctxWith(tool)
    try {
      const result = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'flowchart',
        steps: flowSteps,
        target_office: 'cnipa',
        figure_count: 2,
        format: 'png',
      }, 'c5') as { isError: boolean; value: { layout?: unknown; warnings: string[] } }
      expect(result.isError).toBe(false)
      expect(result.value.layout).toBeUndefined()
      expect(result.value.warnings.join('\n')).toContain('Inkscape')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('generate_patent_figure：落版接线', () => {
  it('中国 + 多幅附图：图号入图、页码入图、返回落版尺寸', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-submit-'))
    const outDir = join(dir, 'figs')
    const tool = createGeneratePatentFigureTool({ ...svgRenderer(GRAPHVIZ_SVG), outputDir: outDir, cwd: dir })
    const ctx = await ctxWith(tool)
    try {
      const result = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'flowchart',
        steps: flowSteps,
        invention_name: '一种自动加热装置',
        target_office: 'cnipa',
        figure_count: 3,
      }, 's1')
      expect(result.isError).toBe(false)
      const value = result as {
        value: {
          layout: { office: string; caption?: string; sheetNumber: string; pageScale: number; charHeightMm?: number }
          warnings: string[]
        }
      }
      expect(value.value.layout.office).toBe('cnipa')
      expect(value.value.layout.caption).toBe('图1')
      expect(value.value.layout.sheetNumber).toBe('第1页')
      expect(value.value.warnings.join('\n')).not.toContain('未写页码')
      expect(text(result)).toContain('- 页码 第1页')
      expect(value.value.layout.charHeightMm).toBeGreaterThan(0)
      const written = readFileSync(join(outDir, 'fig1.svg'), 'utf8')
      expect(written).toContain('width="210mm" height="297mm"')
      expect(written).toContain('>图1</text>')
      expect(text(result)).toContain('## 落版（cnipa）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('单幅附图不标图号；fit_to_page=false 只核算不改写画布', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-submit-'))
    const outDir = join(dir, 'figs')
    const tool = createGeneratePatentFigureTool({ ...svgRenderer(GRAPHVIZ_SVG), outputDir: outDir, cwd: dir })
    const ctx = await ctxWith(tool)
    try {
      const single = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'flowchart',
        steps: flowSteps,
        target_office: 'pct',
        sheet_index: 1,
        sheet_total: 2,
      }, 's2')
      const singleValue = single as { value: { layout: { caption?: string; sheetNumber: string } } }
      expect(singleValue.value.layout.caption).toBeUndefined()
      expect(singleValue.value.layout.sheetNumber).toBe('1/2')
      const dry = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'flowchart',
        steps: flowSteps,
        target_office: 'cnipa',
        figure_count: 2,
        fit_to_page: false,
        filename: 'dry',
      }, 's3')
      const dryValue = dry as { value: { layout: { pageScale: number } } }
      expect(dryValue.value.layout.pageScale).toBeGreaterThan(0)
      expect(readFileSync(join(outDir, 'dry.svg'), 'utf8')).not.toContain('210mm')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('PCT 拒绝彩色；非法图号参数与 PNG 落版分别报错与提示', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-submit-'))
    const outDir = join(dir, 'figs')
    const tool = createGeneratePatentFigureTool({ ...svgRenderer(GRAPHVIZ_SVG), outputDir: outDir, cwd: dir })
    const ctx = await ctxWith(tool)
    try {
      const colored = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'flowchart',
        steps: flowSteps,
        target_office: 'pct',
        style: 'semantic',
      }, 's4')
      expect(colored.isError).toBe(true)
      expect(text(colored)).toContain('11.13(a)')
      const badCount = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'flowchart',
        steps: flowSteps,
        target_office: 'cnipa',
        figure_count: 0,
      }, 's5')
      expect(badCount.isError).toBe(true)
      expect(text(badCount)).toContain('落版参数非法')
      const png = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'flowchart',
        steps: flowSteps,
        target_office: 'cnipa',
        format: 'png',
      }, 's6')
      const pngValue = png as { value: { layout?: unknown; warnings: string[] } }
      expect(pngValue.value.layout).toBeUndefined()
      expect(pngValue.value.warnings.join('\n')).toContain('落版仅支持 SVG')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('落版字号参数直达工具：生效、非法值报 invalid_tool_input', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-submit-'))
    const outDir = join(dir, 'figs')
    const tool = createGeneratePatentFigureTool({ ...svgRenderer(GRAPHVIZ_SVG), outputDir: outDir, cwd: dir })
    const ctx = await ctxWith(tool)
    try {
      const sized = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'flowchart',
        steps: flowSteps,
        target_office: 'cnipa',
        figure_count: 2,
        caption_font_mm: 5,
        sheet_font_mm: 4,
        filename: 'sized',
      }, 's8')
      expect(sized.isError).toBe(false)
      const written = readFileSync(join(outDir, 'sized.svg'), 'utf8')
      expect(written).toMatch(/font-size="5"[^>]*>图1<\/text>/)
      expect(written).toMatch(/font-size="4"[^>]*>第1页<\/text>/)
      const omitted = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'flowchart',
        steps: flowSteps,
        target_office: 'cnipa',
        figure_count: 2,
        sheet_number: false,
        filename: 'no-sheet',
      }, 's8b')
      expect(omitted.isError).toBe(false)
      const omittedValue = omitted as { value: { layout: { sheetNumber: string }; warnings: string[] } }
      expect(omittedValue.value.layout.sheetNumber).toBe('')
      expect(omittedValue.value.warnings.join('\n')).not.toContain('未写页码')
      expect(text(omitted)).toContain('## 落版（cnipa）')
      expect(text(omitted)).not.toContain('- 页码')
      const omittedSvg = readFileSync(join(outDir, 'no-sheet.svg'), 'utf8')
      expect(omittedSvg).not.toContain('data-dsh-role="sheet-number"')
      expect(omittedSvg).not.toContain('第1页')
      expect(omittedSvg).toContain('>图1</text>')
      const withoutOffice = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'flowchart',
        steps: flowSteps,
        sheet_number: false,
        filename: 'no-office',
      }, 's8c')
      expect(withoutOffice.isError).toBe(false)
      expect((withoutOffice as { value: { layout?: unknown } }).value.layout).toBeUndefined()
      for (const [callId, field, value] of [['s9', 'caption_font_mm', 0], ['s10', 'caption_gap_mm', -1], ['s11', 'sheet_font_mm', 0]] as const) {
        const bad = await execute(ctx, 'generate_patent_figure', {
          figure_type: 'flowchart',
          steps: flowSteps,
          target_office: 'cnipa',
          [field]: value,
        }, callId)
        expect(bad.isError).toBe(true)
        expect(text(bad)).toContain(field)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('落版旋转角直达工具：非闭集值报 invalid_tool_input', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-submit-'))
    const outDir = join(dir, 'figs')
    const tool = createGeneratePatentFigureTool({ ...svgRenderer(GRAPHVIZ_SVG), outputDir: outDir, cwd: dir })
    const ctx = await ctxWith(tool)
    try {
      const turned = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'flowchart',
        steps: flowSteps,
        target_office: 'cnipa',
        figure_count: 2,
        rotate_deg: 180,
        filename: 'turned',
      }, 's12')
      expect(turned.isError).toBe(false)
      expect(readFileSync(join(outDir, 'turned.svg'), 'utf8')).toContain('rotate(180)')
      const bad = await execute(ctx, 'generate_patent_figure', {
        figure_type: 'flowchart',
        steps: flowSteps,
        target_office: 'cnipa',
        rotate_deg: 45,
      }, 's13')
      expect(bad.isError).toBe(true)
      expect(text(bad)).toContain('"rotate_deg" must be one of [0,90,180,270]')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('panels：每个面板各自落版并追加面板后缀', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-submit-'))
    const outDir = join(dir, 'figs')
    const tool = createGeneratePatentFigureTool({ ...svgRenderer(GRAPHVIZ_SVG), outputDir: outDir, cwd: dir })
    const ctx = await ctxWith(tool)
    try {
      const result = await execute(ctx, 'generate_patent_figure', {
        figure_number: 2,
        figure_count: 2,
        target_office: 'cnipa',
        panels: [
          { suffix: 'A', figure_type: 'flowchart', steps: flowSteps },
          { suffix: 'B', figure_type: 'block_diagram', blocks: [{ id: 'a', label: '输入' }], connections: [] },
        ],
      }, 's7')
      expect(result.isError).toBe(false)
      const value = result as { value: { panels: { suffix: string; layout?: { caption?: string } }[] } }
      expect(value.value.panels.map(p => p.layout?.caption)).toEqual(['图2A', '图2B'])
      expect(readFileSync(join(outDir, 'fig2A.svg'), 'utf8')).toContain('>图2A</text>')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
