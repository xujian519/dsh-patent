/**
 * 把已落版的 SVG 写成可编辑的 ASCII DXF（毫米，Y 轴向上）。
 *
 * 几何来自 {@link scanSvg} 的毫米坐标，曲线按 0.2 毫米弦高折线化。文字保持 TEXT，
 * 不走文字转路径。填充不写 HATCH。本函数不写文件；调用方在成功之后再落盘。
 * @module @deepseek-ai/dsh-patent-tools/figure/svg-to-dxf
 */

import { GLYPH_ASCENT_RATIO, GLYPH_DESCENT_RATIO } from './glyph-box.ts'
import { rasterFigureMessage } from './raster-input.ts'
import { CIRCLE_GON_SEGMENTS, scanSvg, textQuad } from './render-check-scan.ts'
import type { SubPath } from './render-check-scan.ts'

/** 曲线折线化的弦高（毫米）。 */
const CURVE_TOLERANCE_MM = 0.2

/** 圆的半径在这个毫米数内视为不变。 */
const CIRCLE_RADIUS_TOLERANCE_MM = 0.01

/** 不能写成 DXF 的 SVG。 */
export class SvgDxfError extends Error {
  /**
   * @param message - 拒绝原因。
   */
  constructor(message: string) {
    super(message)
    this.name = 'SvgDxfError'
  }
}

const REJECTED_TAG = /<\s*(?:[a-z_][\w.-]*:)?(image|foreignObject|use)\b/i
const PATH_D = /\bd="([^"]*)"/gi
const CURVE_COMMAND = /[cstqa]/i

/**
 * @param svg - 完整 SVG 文本。
 * @returns DXF 文本与警告。
 * @throws SvgDxfError 含位图、foreignObject、use、无法解析的 viewBox 或变换，或没有画布尺寸时。
 */
export function svgToDxf(svg: string): { dxf: string; warnings: string[] } {
  const source = svg.replace(/<!--[\s\S]*?-->/g, '')
  const rejected = REJECTED_TAG.exec(source)
  if (rejected !== null) {
    /* v8 ignore next -- REJECTED_TAG 的标签名捕获组总在 */
    const name = (rejected[1] ?? '').toLowerCase()
    if (name === 'image') throw new SvgDxfError(rasterFigureMessage('SVG', '<image>'))
    if (name === 'foreignobject') throw new SvgDxfError('SVG 含 <foreignObject>，不能写 DXF')
    throw new SvgDxfError('SVG 含 <use>，不能写 DXF')
  }
  const scan = scanSvg(source, { curveToleranceMm: CURVE_TOLERANCE_MM })
  if (scan.unmeasured.some(note => note.includes('viewBox 无法解析'))) {
    throw new SvgDxfError('根元素的 viewBox 无法解析，不能写 DXF')
  }
  if (scan.unmeasured.some(note => note.includes('之外的变换'))) {
    throw new SvgDxfError('SVG 含无法解析的变换，不能写 DXF')
  }
  if (scan.widthMm === undefined || scan.heightMm === undefined) {
    throw new SvgDxfError('SVG 缺少可解析的画布尺寸，不能写 DXF')
  }
  const pageHeight = scan.heightMm
  const warnings: string[] = []
  if (scan.shapes.some(shape => shape.regionFill)) warnings.push('DXF 未写入填充')
  if (hasCurve(source)) warnings.push('曲线已折线化')
  const lines = [
    '0', 'SECTION',
    '2', 'HEADER',
    '9', '$ACADVER',
    '1', 'AC1032',
    '9', '$INSUNITS',
    '70', '4',
    '0', 'ENDSEC',
    '0', 'SECTION',
    '2', 'ENTITIES',
  ]
  for (const shape of scan.shapes) {
    for (const subpath of shape.subpaths) {
      const circle = circleOf(subpath)
      if (circle !== undefined) {
        lines.push(
          '0', 'CIRCLE',
          '8', '0',
          '10', dxfNumber(circle.cx),
          '20', dxfNumber(pageHeight - circle.cy),
          '40', dxfNumber(circle.r),
        )
        continue
      }
      const points = subpath.points
      /* v8 ignore next -- scanSvg 只交出至少两个顶点的子路径 */
      if (points.length < 2) continue
      if (points.length === 2 && !subpath.closed) {
        const [start, end] = points
        /* v8 ignore next -- 两个顶点的子路径是稠密数组，两端点都在 */
        if (start === undefined || end === undefined) continue
        lines.push(
          '0', 'LINE',
          '8', '0',
          '10', dxfNumber(start[0]),
          '20', dxfNumber(pageHeight - start[1]),
          '11', dxfNumber(end[0]),
          '21', dxfNumber(pageHeight - end[1]),
        )
        continue
      }
      lines.push('0', 'LWPOLYLINE', '8', '0', '90', String(points.length), '70', subpath.closed ? '1' : '0')
      for (const point of points) {
        lines.push('10', dxfNumber(point[0]), '20', dxfNumber(pageHeight - point[1]))
      }
    }
  }
  const glyphScale = GLYPH_ASCENT_RATIO + GLYPH_DESCENT_RATIO
  for (const text of scan.texts) {
    const content = text.content.replace(/[\r\n]+/g, ' ').trim()
    /* v8 ignore next -- scanSvg 已丢掉空白文字，这里的内容去换行后仍非空 */
    if (content === '') continue
    const quad = textQuad(text)
    const height = Math.hypot(quad.edgeHeight[0], quad.edgeHeight[1]) / glyphScale
    if (!(height > 0)) continue
    lines.push(
      '0', 'TEXT',
      '8', '0',
      '10', dxfNumber(text.baseline[0]),
      '20', dxfNumber(pageHeight - text.baseline[1]),
      '40', dxfNumber(height),
      '1', content,
    )
  }
  lines.push('0', 'ENDSEC', '0', 'EOF', '')
  return { dxf: lines.join('\n'), warnings }
}

function hasCurve(source: string): boolean {
  for (const match of source.matchAll(PATH_D)) {
    /* v8 ignore next -- PATH_D 的 d 值捕获组总在，至多是空串 */
    const data = match[1] ?? ''
    if (CURVE_COMMAND.test(data)) return true
  }
  return false
}

function circleOf(subpath: SubPath): { cx: number; cy: number; r: number } | undefined {
  if (!subpath.closed || subpath.points.length !== CIRCLE_GON_SEGMENTS) return undefined
  let sumX = 0
  let sumY = 0
  for (const point of subpath.points) {
    sumX += point[0]
    sumY += point[1]
  }
  const cx = sumX / subpath.points.length
  const cy = sumY / subpath.points.length
  const first = subpath.points[0]
  /* v8 ignore next -- 顶点数已经等于 CIRCLE_GON_SEGMENTS，首点必在 */
  if (first === undefined) return undefined
  const radius = Math.hypot(first[0] - cx, first[1] - cy)
  if (!(radius > 0)) return undefined
  for (const point of subpath.points) {
    if (Math.abs(Math.hypot(point[0] - cx, point[1] - cy) - radius) > CIRCLE_RADIUS_TOLERANCE_MM) return undefined
  }
  return { cx, cy, r: radius }
}

function dxfNumber(value: number): string {
  return String(Math.round(value * 1e6) / 1e6)
}
