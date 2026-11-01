/**
 * 毫米图元内核：图面坐标点、包围盒与 SVG 数值格式化的唯一实现。
 *
 * 各渲染器（剖视、电路、曲线、时序、落版、引线）此前各留一份「四舍五入后转字符串」
 * 与包围盒累加；两处口径一旦分叉，同一张图的坐标就会因绘制路径不同而写法不同。
 * 本模块只做算术与格式化，不读盘、不抛领域错误，可被任意渲染器依赖而不成环。
 * @module @deepseek-ai/dsh-patent-tools/figure/mm-primitives
 */

/** 图面坐标（毫米）。 */
export type MmPoint = readonly [number, number]

/** 毫米包围盒。 */
type MmBounds = {
  /** 最小 x。 */
  minX: number
  /** 最小 y。 */
  minY: number
  /** 最大 x。 */
  maxX: number
  /** 最大 y。 */
  maxY: number
}

/** SVG 坐标默认精度：千分之一毫米。 */
export const MM_DECIMALS = 3

/**
 * 格式化坐标数值：按给定精度四舍五入后转十进制文本，去掉尾随零。
 * @param value - 坐标或尺寸数值（毫米）。
 * @param decimals - 小数位数，默认 {@link MM_DECIMALS}。
 * @returns 可嵌入 SVG 属性的十进制文本。
 */
export function formatMm(value: number, decimals: number = MM_DECIMALS): string {
  const factor = 10 ** decimals
  return String(Math.round(value * factor) / factor)
}

/**
 * 点集的轴对齐包围盒。
 *
 * 调用方须保证点集非空：空集返回反向无穷（min > max），不会抛错——这里只做算术，
 * 由调用方在给出点集时保证它有意义。
 * @param points - 图面点集（毫米）。
 * @returns 包围盒。
 */
export function boundsOfPoints(points: readonly MmPoint[]): MmBounds {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of points) {
    const [x, y] = point
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}
