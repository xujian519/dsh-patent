/**
 * 专利附图曲线图/坐标图生成（纯函数，无 IO）。
 *
 * 专利附图允许以曲线图/坐标图表达技术内容（温度—时间曲线、应力—应变曲线
 * 等），但《专利审查指南》第一部分第二章 7.3(10) 要求实用新型必须有形状、
 * 构造视图，不得仅有性能曲线图。图面遵守附图制图要求：UTF-8 黑白线条，只用
 * `#000000`；序列之间只用标记形状区分而不使用颜色；不标注比例（PCT Rule
 * 11.13(d) 与 37 CFR 1.84(k) 禁止在附图中写「比例」「actual size」「1:2」等
 * 比例说明），因此本模块不画尺寸线、不产出任何比例文本。
 *
 * 片段约定同 vector-figure：坐标单位为毫米；`<g>` 外壳给出 `fill="none"`、
 * `stroke="#000000"`、`stroke-width="0.35"`。片段内的**文本元素必须自带
 * `fill="#000000" stroke="none"`**，否则继承外壳的 `fill="none"` 而在图面上
 * 不可见。纵轴在左、横轴在下，轴端为开口箭头；刻度短线朝外，刻度数值写在轴
 * 外侧，轴标目（含单位，如「温度(℃)」）写在轴中部；多序列时在横轴下方折行
 * 列出图例。
 * @module @deepseek-ai/dsh-patent-tools/figure/plot-diagram
 */

import { assertNever } from '@deepseek-ai/dsh-util-values'
import { escapeXmlText } from './svg-annotate.ts'
import { VectorFigureError, fmt } from './vector-figure.ts'
import type { VectorFigureSpec } from './vector-figure.ts'

/** 一条数据序列。 */
type PlotSeries = {
  /** 序列名（写入图例，简短）。 */
  name?: string
  /** 数据点 [x, y]（有限数，至少 1 个）。 */
  points: readonly (readonly [number, number])[]
  /** 标记形状：'none'（只连线）| 'circle' | 'square' | 'triangle'，默认 'circle'。 */
  marker?: 'none' | 'circle' | 'square' | 'triangle'
}

/** 曲线图输入。 */
export type PlotDiagramInput = {
  /** 数据序列（至少 1 条，每条至少 1 个数据点）。 */
  series: readonly PlotSeries[]
  /** 横轴标目（如「温度」）。 */
  xLabel: string
  /** 纵轴标目（如「时间」）。 */
  yLabel: string
  /** 横轴单位（可选，如 '℃'；写入标目后的括号内）。 */
  xUnit?: string
  /** 纵轴单位（可选，如 's'；写入标目后的括号内）。 */
  yUnit?: string
  /** 横轴范围；缺省按数据 min/max 外扩 5% 自动推导。 */
  xRange?: readonly [number, number]
  /** 纵轴范围；缺省按数据 min/max 外扩 5% 自动推导。 */
  yRange?: readonly [number, number]
  /** 每轴刻度数量（含端点），默认 5，取值 2..11。 */
  tickCount?: number
  /** 是否绘制网格线（细实线），默认 false。 */
  showGrid?: boolean
  /** 画布宽（毫米），默认 120。 */
  widthMm?: number
  /** 画布高（毫米），默认 80。 */
  heightMm?: number
}

/** 标记形状。 */
type PlotMarker = NonNullable<PlotSeries['marker']>

/** 文本锚点。 */
type TextAnchor = 'start' | 'middle' | 'end'

/** 图例条目：图上写出的序列名与其标记形状。 */
type LegendEntry = { name: string; marker: PlotMarker }

/** 默认画布尺寸（毫米）与每轴刻度数量（含端点）。 */
const DEFAULT_WIDTH_MM = 120
const DEFAULT_HEIGHT_MM = 80
const DEFAULT_TICK_COUNT = 5

/** 刻度数量取值上下限。 */
const MIN_TICK_COUNT = 2
const MAX_TICK_COUNT = 11

/** 未给出 marker 时的默认标记。 */
const DEFAULT_MARKER: PlotMarker = 'circle'

/** 自动范围相对数据跨度的外扩比例。 */
const AUTO_RANGE_PAD_RATIO = 0.05

/** 数据跨度为 0 且值为 0 时使用的一半跨度（数据量纲）。 */
const DEGENERATE_HALF_SPAN = 1

/** 字号（毫米）。 */
const FONT_MM = 3.2

/** 绘图区边距（毫米）：左侧留纵轴刻度值与标目，下方留给刻度值与横轴标目。 */
const MARGIN_LEFT_MM = 22
const MARGIN_RIGHT_MM = 8
const MARGIN_TOP_MM = 6
const AXIS_BAND_MM = 13

/** 图例行高、条目间距与标记示例占位（毫米）。 */
const LEGEND_ROW_MM = 5
const LEGEND_GAP_MM = 8
const LEGEND_SWATCH_MM = 4

/** 刻度短线长度与刻度数值到轴线的间隙（毫米）。 */
const TICK_MM = 1.5
const TICK_LABEL_GAP_MM = 1

/** 线宽（毫米）：轴线、刻度线、网格线、折线与标记描边。 */
const AXIS_STROKE_MM = 0.35
const TICK_STROKE_MM = 0.25
const GRID_STROKE_MM = 0.15
const SERIES_STROKE_MM = 0.25

/** 标记半径与轴端开口箭头的长度、半宽（毫米）。 */
const MARKER_RADIUS_MM = 0.9
const ARROW_LENGTH_MM = 2.2
const ARROW_HALF_WIDTH_MM = 0.7

/** 三角形标记相对标记半径的顶点外扩、底边下移与底边半宽。 */
const TRIANGLE_APEX_RATIO = 1.15
const TRIANGLE_BASE_RATIO = 0.75
const TRIANGLE_HALF_WIDTH_RATIO = 1.1

/** 文本基线相对几何中心的垂直微调（字号比例）。 */
const BASELINE_MID_RATIO = 0.35

/** 文本宽度估算的字宽比例（毫米/字号）：CJK 满宽、其余半宽。 */
const CJK_WIDTH_RATIO = 1
const ASCII_WIDTH_RATIO = 0.55

/** CJK 字符（含全角标点）判定，用于估算文本宽度。 */
const CJK_CHAR_PATTERN = /[\u3000-\u9fff\uff00-\uffef]/

/**
 * 取全部数据点在某一维上的最小/最大值。
 * @param series - 数据序列（已校验非空，且每条序列至少 1 个有限数点）。
 * @param axis - 0 取横坐标、1 取纵坐标。
 * @returns 该维的 [min, max]。
 */
function dataExtent(series: readonly PlotSeries[], axis: 0 | 1): readonly [number, number] {
  let min = Infinity
  let max = -Infinity
  for (const item of series) {
    for (const point of item.points) {
      min = Math.min(min, point[axis])
      max = Math.max(max, point[axis])
    }
  }
  return [min, max]
}

/**
 * 按数据 min/max 外扩 5% 推导轴范围；跨度为 0（单点或全部同值）时改为对称外扩。
 * @param extent - 数据在该维的 [min, max]。
 * @returns 递增的轴范围。
 */
function autoRange(extent: readonly [number, number]): readonly [number, number] {
  const [min, max] = extent
  const span = max - min
  if (span > 0) {
    const pad = span * AUTO_RANGE_PAD_RATIO
    return [min - pad, max + pad]
  }
  const pad = min === 0 ? DEGENERATE_HALF_SPAN : Math.abs(min) * AUTO_RANGE_PAD_RATIO
  return [min - pad, max + pad]
}

/**
 * 校验调用方给出的轴范围。
 * @param range - 调用方给出的 [min, max]。
 * @param name - 报错用语（'xRange' 或 'yRange'）。
 * @returns 原范围。
 * @throws VectorFigureError('invalid_input') 端点为非有限数或区间非递增时。
 */
function assertRange(range: readonly [number, number], name: string): readonly [number, number] {
  if (!Number.isFinite(range[0]) || !Number.isFinite(range[1]) || range[0] >= range[1]) {
    throw new VectorFigureError('invalid_input', `${name} 必须是递增的有限数区间：[${String(range[0])}, ${String(range[1])}]`)
  }
  return range
}

/**
 * 计算含端点的等距刻度值；末项直接取端点，避免累加漂移。
 * @param range - 轴范围。
 * @param count - 刻度数量（>= 2）。
 * @returns 刻度值列表（长度等于 count）。
 */
function tickValues(range: readonly [number, number], count: number): number[] {
  const step = (range[1] - range[0]) / (count - 1)
  const values: number[] = []
  for (let index = 0; index < count; index += 1) {
    values.push(index === count - 1 ? range[1] : range[0] + step * index)
  }
  return values
}

/**
 * 估算文本宽度（毫米）：CJK 按满宽、其余按半宽。
 * @param text - 文本原文。
 * @returns 估算宽度（毫米）。
 */
function textWidthMm(text: string): number {
  let width = 0
  for (const char of text) width += FONT_MM * (CJK_CHAR_PATTERN.test(char) ? CJK_WIDTH_RATIO : ASCII_WIDTH_RATIO)
  return width
}

/**
 * 拼接轴标目与单位，单位非空时写成「温度(℃)」。
 * @param label - 轴标目。
 * @param unit - 轴单位。
 * @returns 图面写出的标目文本。
 */
function axisTitle(label: string, unit: string | undefined): string {
  const trimmed = unit?.trim() ?? ''
  return trimmed === '' ? label : `${label}(${trimmed})`
}

/** 绘制一条黑色线段。 */
function svgLine(x1: number, y1: number, x2: number, y2: number, strokeWidthMm: number): string {
  return `<line x1="${fmt(x1)}" y1="${fmt(y1)}" x2="${fmt(x2)}" y2="${fmt(y2)}" stroke="#000000" stroke-width="${fmt(strokeWidthMm)}"/>`
}

/**
 * 绘制一个文本元素；`rotated` 时绕自身锚点逆时针旋转 90°（纵轴标目自下而上）。
 * @param x - 锚点横坐标（毫米）。
 * @param y - 基线纵坐标（毫米）。
 * @param content - 文本原文（按 XML 文本转义）。
 * @param anchor - 文本锚点。
 * @param rotated - 是否旋转 90°。
 * @returns `<text>` 片段（自带 fill/stroke，避免继承外壳的 `fill="none"`）。
 */
function svgText(x: number, y: number, content: string, anchor: TextAnchor, rotated: boolean): string {
  const transform = rotated ? ` transform="rotate(-90 ${fmt(x)} ${fmt(y)})"` : ''
  return `<text x="${fmt(x)}" y="${fmt(y)}" font-size="${fmt(FONT_MM)}" text-anchor="${anchor}"${transform} fill="#000000" stroke="none">${escapeXmlText(content)}</text>`
}

/**
 * 绘制一个黑色空心标记。
 * @param marker - 标记形状。
 * @param cx - 中心横坐标（毫米）。
 * @param cy - 中心纵坐标（毫米）。
 * @returns SVG 片段；'none' 返回空串。
 */
function markerFragment(marker: PlotMarker, cx: number, cy: number): string {
  const stroke = `fill="none" stroke="#000000" stroke-width="${fmt(SERIES_STROKE_MM)}"`
  switch (marker) {
    case 'none':
      return ''
    case 'circle':
      return `<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(MARKER_RADIUS_MM)}" ${stroke}/>`
    case 'square': {
      const half = MARKER_RADIUS_MM
      return `<rect x="${fmt(cx - half)}" y="${fmt(cy - half)}" width="${fmt(half * 2)}" height="${fmt(half * 2)}" ${stroke}/>`
    }
    case 'triangle': {
      const apex = fmt(cy - MARKER_RADIUS_MM * TRIANGLE_APEX_RATIO)
      const baseY = fmt(cy + MARKER_RADIUS_MM * TRIANGLE_BASE_RATIO)
      const baseX = MARKER_RADIUS_MM * TRIANGLE_HALF_WIDTH_RATIO
      return `<polygon points="${fmt(cx)},${apex} ${fmt(cx - baseX)},${baseY} ${fmt(cx + baseX)},${baseY}" ${stroke}/>`
    }
    /* v8 ignore next -- closed-union backstop; the compiler rejects a new marker shape. */
    default:
      return assertNever(marker, 'plot marker')
  }
}

/**
 * 把图例条目按可用宽度折行（行内自左向右排布，超出宽度换行）。
 * @param entries - 图例条目。
 * @param availableMm - 每行可用宽度（毫米）。
 * @returns 每行的条目列表；无条目时为空列表。
 */
function legendRows(entries: readonly LegendEntry[], availableMm: number): LegendEntry[][] {
  const rows: LegendEntry[][] = []
  let row: LegendEntry[] = []
  let cursor = 0
  for (const entry of entries) {
    const entryWidth = LEGEND_SWATCH_MM + textWidthMm(entry.name)
    if (row.length > 0 && cursor + LEGEND_GAP_MM + entryWidth > availableMm) {
      rows.push(row)
      row = []
      cursor = 0
    }
    cursor += (row.length === 0 ? 0 : LEGEND_GAP_MM) + entryWidth
    row.push(entry)
  }
  if (row.length > 0) rows.push(row)
  return rows
}

/**
 * 构建专利附图曲线图：纵轴在左、横轴在下的坐标轴，折线加标记的数据序列，可选
 * 网格线与图例。全部图元为黑色线条；数据序列只用标记形状区分，不使用颜色；不
 * 写比例说明、不画尺寸线。
 * @param input - 曲线图输入：数据序列、轴标目与单位、可选的坐标范围、刻度数量、
 * 网格、画布尺寸。
 * @returns 图形规格：画布尺寸（毫米）、SVG 片段与图面词语（轴标目含单位、刻度
 * 数值、序列名，去重后按出现顺序）。
 * @throws VectorFigureError('empty_input') 未给出任何数据序列时。
 * @throws VectorFigureError('invalid_input') 序列无数据点、坐标非有限数、轴范围
 * 非递增或含非有限数、刻度数量越界、画布尺寸非正时。
 */
export function buildPlotDiagram(input: PlotDiagramInput): VectorFigureSpec {
  if (input.series.length === 0) {
    throw new VectorFigureError('empty_input', '曲线图至少需要一条数据序列')
  }
  const tickCount = input.tickCount ?? DEFAULT_TICK_COUNT
  if (!Number.isInteger(tickCount) || tickCount < MIN_TICK_COUNT || tickCount > MAX_TICK_COUNT) {
    throw new VectorFigureError('invalid_input', `每轴刻度数量必须是 ${MIN_TICK_COUNT}..${MAX_TICK_COUNT} 的整数：${String(tickCount)}`)
  }
  const widthMm = input.widthMm ?? DEFAULT_WIDTH_MM
  const heightMm = input.heightMm ?? DEFAULT_HEIGHT_MM
  if (!Number.isFinite(widthMm) || widthMm <= 0 || !Number.isFinite(heightMm) || heightMm <= 0) {
    throw new VectorFigureError('invalid_input', `画布尺寸必须为正有限数：${String(widthMm)}×${String(heightMm)}`)
  }
  for (const series of input.series) {
    if (series.points.length === 0) {
      throw new VectorFigureError('invalid_input', `数据序列「${series.name?.trim() ?? ''}」没有数据点`)
    }
    for (const point of series.points) {
      if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) {
        throw new VectorFigureError('invalid_input', `数据点必须是有限数：[${String(point[0])}, ${String(point[1])}]`)
      }
    }
  }
  const xRange = input.xRange === undefined ? autoRange(dataExtent(input.series, 0)) : assertRange(input.xRange, 'xRange')
  const yRange = input.yRange === undefined ? autoRange(dataExtent(input.series, 1)) : assertRange(input.yRange, 'yRange')
  const xTicks = tickValues(xRange, tickCount)
  const yTicks = tickValues(yRange, tickCount)

  const named = input.series
    .map(series => ({ name: series.name?.trim() ?? '', marker: series.marker ?? DEFAULT_MARKER }))
    .filter(entry => entry.name !== '')
  // 图例只用于区分多序列；单序列时序列名仍进图面词语（供用语检查）。
  const legendEntries = input.series.length > 1 ? named : []

  const plotLeft = MARGIN_LEFT_MM
  const plotRight = widthMm - MARGIN_RIGHT_MM
  const rows = legendRows(legendEntries, plotRight - plotLeft)
  const plotBottom = heightMm - AXIS_BAND_MM - rows.length * LEGEND_ROW_MM
  const plotTop = MARGIN_TOP_MM
  const plotWidth = plotRight - plotLeft
  const plotHeight = plotBottom - plotTop
  const mapX = (value: number): number => plotLeft + ((value - xRange[0]) / (xRange[1] - xRange[0])) * plotWidth
  const mapY = (value: number): number => plotBottom - ((value - yRange[0]) / (yRange[1] - yRange[0])) * plotHeight

  const parts: string[] = []
  if (input.showGrid === true) {
    for (const value of xTicks) parts.push(svgLine(mapX(value), plotTop, mapX(value), plotBottom, GRID_STROKE_MM))
    for (const value of yTicks) parts.push(svgLine(plotLeft, mapY(value), plotRight, mapY(value), GRID_STROKE_MM))
  }
  // 轴线：纵轴在左、横轴在下，轴端画开口箭头。
  parts.push(svgLine(plotLeft, plotTop, plotLeft, plotBottom, AXIS_STROKE_MM))
  parts.push(svgLine(plotLeft, plotBottom, plotRight, plotBottom, AXIS_STROKE_MM))
  parts.push(svgLine(plotLeft, plotTop, plotLeft - ARROW_HALF_WIDTH_MM, plotTop + ARROW_LENGTH_MM, AXIS_STROKE_MM))
  parts.push(svgLine(plotLeft, plotTop, plotLeft + ARROW_HALF_WIDTH_MM, plotTop + ARROW_LENGTH_MM, AXIS_STROKE_MM))
  parts.push(svgLine(plotRight, plotBottom, plotRight - ARROW_LENGTH_MM, plotBottom - ARROW_HALF_WIDTH_MM, AXIS_STROKE_MM))
  parts.push(svgLine(plotRight, plotBottom, plotRight - ARROW_LENGTH_MM, plotBottom + ARROW_HALF_WIDTH_MM, AXIS_STROKE_MM))

  // 刻度短线朝外，刻度数值写在轴外侧。
  const tickLabelBaseline = plotBottom + TICK_MM + TICK_LABEL_GAP_MM + FONT_MM
  for (const value of xTicks) {
    const x = mapX(value)
    parts.push(svgLine(x, plotBottom, x, plotBottom + TICK_MM, TICK_STROKE_MM))
    parts.push(svgText(x, tickLabelBaseline, fmt(value), 'middle', false))
  }
  for (const value of yTicks) {
    const y = mapY(value)
    parts.push(svgLine(plotLeft, y, plotLeft - TICK_MM, y, TICK_STROKE_MM))
    parts.push(svgText(plotLeft - TICK_MM - TICK_LABEL_GAP_MM, y + FONT_MM * BASELINE_MID_RATIO, fmt(value), 'end', false))
  }

  // 轴标目写在轴中部：横轴在刻度数值下方，纵轴旋转 90° 自下而上。
  parts.push(svgText((plotLeft + plotRight) / 2, tickLabelBaseline + FONT_MM + 2, axisTitle(input.xLabel, input.xUnit), 'middle', false))
  const yTitleX = plotLeft - TICK_MM - TICK_LABEL_GAP_MM - FONT_MM - 2
  parts.push(svgText(yTitleX, plotTop + plotHeight / 2, axisTitle(input.yLabel, input.yUnit), 'middle', true))

  for (const series of input.series) {
    const marker = series.marker ?? DEFAULT_MARKER
    const points = series.points.map(point => `${fmt(mapX(point[0]))},${fmt(mapY(point[1]))}`).join(' ')
    parts.push(`<polyline points="${points}" fill="none" stroke="#000000" stroke-width="${fmt(SERIES_STROKE_MM)}"/>`)
    for (const point of series.points) parts.push(markerFragment(marker, mapX(point[0]), mapY(point[1])))
  }

  // 图例列在横轴标目下方：只连线的序列用短线段作标记示例。
  const legendTop = plotBottom + AXIS_BAND_MM
  for (const [index, row] of rows.entries()) {
    const baseline = legendTop + index * LEGEND_ROW_MM + FONT_MM
    let cursor = plotLeft
    for (const entry of row) {
      const centerY = baseline - FONT_MM * BASELINE_MID_RATIO
      parts.push(entry.marker === 'none'
        ? svgLine(cursor, centerY, cursor + LEGEND_SWATCH_MM, centerY, SERIES_STROKE_MM)
        : markerFragment(entry.marker, cursor + LEGEND_SWATCH_MM / 2, centerY))
      parts.push(svgText(cursor + LEGEND_SWATCH_MM, baseline, entry.name, 'start', false))
      cursor += LEGEND_SWATCH_MM + textWidthMm(entry.name) + LEGEND_GAP_MM
    }
  }

  const labels = [
    axisTitle(input.xLabel, input.xUnit),
    axisTitle(input.yLabel, input.yUnit),
    ...xTicks.map(value => fmt(value)),
    ...yTicks.map(value => fmt(value)),
    ...named.map(entry => entry.name),
  ]
  return {
    widthMm,
    heightMm,
    body: parts.filter(part => part !== '').join('\n'),
    labels: [...new Set(labels)],
  }
}
