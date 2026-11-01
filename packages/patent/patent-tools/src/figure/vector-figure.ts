/**
 * 矢量附图接缝：直接绘制 SVG 的图型（电路图、曲线图、剖视图、时序图、
 * 外观设计视图）共用的产出规格、错误类型与画布封装。
 *
 * 与 dot-builder（Graphviz 节点连线图）平行的第二条通路：Graphviz 能表达
 * 「节点 + 边」，但画不出电气符号、剖面线、坐标轴与视图排布。这些图型各自
 * 产出 {@link VectorFigureSpec}（毫米画布 + 黑色描边片段 + 图面词语），由
 * {@link vectorFigureSvg} 封装为独立 SVG 文件，再交给 submission-page 落版
 * 到目标法域的幅面上。
 *
 * 片段约定：坐标单位为毫米；`<g>` 外壳给出 `fill="none"`、`stroke="#000000"`、
 * `stroke-width="0.35"`（对应 GB/T 4457.4 线宽系列的粗实线）。片段内**文本
 * 元素必须自带 `fill="#000000" stroke="none"`**，否则会继承外壳的 `fill="none"`
 * 而在图面上不可见。
 * @module @deepseek-ai/dsh-patent-tools/figure/vector-figure
 */

import { formatMm } from './mm-primitives.ts'

/** 矢量图构建错误码。 */
export type VectorFigureErrorCode = 'empty_input' | 'invalid_input' | 'too_large'

/** 矢量图构建错误（各图型模块抛出；工具层映射为 PatentToolError('invalid_tool_input')）。 */
export class VectorFigureError extends Error {
  /** 构建错误码。 */
  readonly code: VectorFigureErrorCode

  constructor(code: VectorFigureErrorCode, message: string) {
    super(message)
    this.name = 'VectorFigureError'
    this.code = code
  }
}

/**
 * 矢量附图规格：图形自身尺寸（毫米）与 SVG 片段。
 *
 * `body` 不含 `<svg>` 根元素、不含图号与页码——图号由落版阶段按目标法域
 * 加到图形正下方，避免图型模块各自实现编号写法。
 */
export type VectorFigureSpec = {
  /** 画布宽（毫米）。 */
  widthMm: number
  /** 画布高（毫米）。 */
  heightMm: number
  /** 图形片段（毫米坐标、黑色描边，无 `<svg>` 根元素）。 */
  body: string
  /** 图面上出现的词语（供 figureWordingWarnings 的用语检查）。 */
  labels: readonly string[]
}

/** 画布片段大小上限（字节），防止单图 SVG 过大。 */
export const DEFAULT_VECTOR_BODY_MAX_BYTES = 2_000_000

/** 线宽默认值（毫米）：GB/T 4457.4 线宽系列的 0.35，用作粗实线轮廓。 */
const DEFAULT_VECTOR_STROKE_MM = 0.35

/**
 * 坐标数值格式化：保留至多 3 位小数并去掉尾随零。
 * @param value - 坐标或尺寸数值。
 * @returns 可嵌入 SVG 属性的十进制文本。
 * @throws VectorFigureError('invalid_input') 数值非有限时。
 */
export function fmt(value: number): string {
  if (!Number.isFinite(value)) {
    throw new VectorFigureError('invalid_input', `坐标必须是有限数：${String(value)}`)
  }
  return formatMm(value)
}

/**
 * 校验规格：尺寸为正有限数、片段非空且不超限、词语逐条为字符串。
 * @param spec - 待校验规格。
 * @throws VectorFigureError('invalid_input' | 'empty_input' | 'too_large') 校验不通过时。
 */
export function assertVectorFigureSpec(spec: VectorFigureSpec): void {
  if (!Number.isFinite(spec.widthMm) || spec.widthMm <= 0 || !Number.isFinite(spec.heightMm) || spec.heightMm <= 0) {
    throw new VectorFigureError('invalid_input', `画布尺寸必须为正有限数：${String(spec.widthMm)}×${String(spec.heightMm)}`)
  }
  if (spec.body.trim() === '') {
    throw new VectorFigureError('empty_input', '图形片段为空')
  }
  // 与 svg-annotate 的输入上限同一口径：按 UTF-8 字节计（中文字符三字节）。
  if (Buffer.byteLength(spec.body, 'utf8') > DEFAULT_VECTOR_BODY_MAX_BYTES) {
    throw new VectorFigureError('too_large', `图形片段过大（>${DEFAULT_VECTOR_BODY_MAX_BYTES} 字节）`)
  }
  for (const label of spec.labels) {
    if (typeof label !== 'string') {
      throw new VectorFigureError('invalid_input', '图面词语必须是字符串')
    }
  }
}

/**
 * SVG 属性值转义。
 * @param value - 属性原文。
 * @returns 可安全嵌入双引号属性的文本。
 */
export function escapeXmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * 把图形规格封装为独立 SVG 文件内容（毫米画布、无边框、无标题栏、无图号）。
 * @param spec - 图形规格。
 * @param title - 可选的图名（写入 `<title>`，不落图面像素）。
 * @returns 完整 SVG 文本（末尾含换行）。
 * @throws VectorFigureError 规格校验不通过时。
 */
export function vectorFigureSvg(spec: VectorFigureSpec, title?: string): string {
  assertVectorFigureSpec(spec)
  const width = fmt(spec.widthMm)
  const height = fmt(spec.heightMm)
  const head = title === undefined ? [] : [`  <title>${escapeXmlAttribute(title)}</title>`]
  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}mm" height="${height}mm" viewBox="0 0 ${width} ${height}">`,
    ...head,
    `  <g fill="none" stroke="#000000" stroke-width="${DEFAULT_VECTOR_STROKE_MM}" stroke-linecap="round" stroke-linejoin="round">`,
    `    ${spec.body.trim()}`,
    '  </g>',
    '</svg>',
    '',
  ].join('\n')
}
