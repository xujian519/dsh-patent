/**
 * 附图几何原语：叉积、落段、线段相交与点线距。
 *
 * 引线放置（`leader-line`）与渲染复核（`render-check-findings`）共用同一套判定，
 * 避免修一处交线判定而不带动另一处。包围盒统一用
 * {@link boundsOfPoints}（`mm-primitives.ts`）。
 * @module @deepseek-ai/dsh-patent-tools/figure/geometry
 */

/** 二维点（毫米或 SVG 用户单位）。 */
export type GeoPoint = readonly [number, number]

/** 端点对表示的有向线段。 */
export type GeoSegment = {
  readonly x1: number
  readonly y1: number
  readonly x2: number
  readonly y2: number
}

/**
 * 点在有向直线 `from→to` 的哪一侧（叉积符号）。
 * @param from - 直线起点。
 * @param to - 直线终点。
 * @param point - 待判定点。
 * @returns 有向面积的两倍：>0 左侧、<0 右侧、=0 共线。
 */
export function sideOf(from: GeoPoint, to: GeoPoint, point: GeoPoint): number {
  return (to[0] - from[0]) * (point[1] - from[1]) - (to[1] - from[1]) * (point[0] - from[0])
}

/**
 * 点是否落在线段上（共线且落在两端之间，含端点）。
 * @param point - 待判定点。
 * @param segment - 线段。
 * @returns 落在段上时为 true。
 */
export function onSegment(point: GeoPoint, segment: GeoSegment): boolean {
  return sideOf([segment.x1, segment.y1], [segment.x2, segment.y2], point) === 0
    && point[0] >= Math.min(segment.x1, segment.x2) && point[0] <= Math.max(segment.x1, segment.x2)
    && point[1] >= Math.min(segment.y1, segment.y2) && point[1] <= Math.max(segment.y1, segment.y2)
}

/**
 * 两线段是否相交（含端点接触与共线重叠）。
 * @param a - 第一条线段。
 * @param b - 第二条线段。
 * @returns 相交时为 true。
 */
export function segmentsIntersect(a: GeoSegment, b: GeoSegment): boolean {
  const a1: GeoPoint = [a.x1, a.y1]
  const a2: GeoPoint = [a.x2, a.y2]
  const b1: GeoPoint = [b.x1, b.y1]
  const b2: GeoPoint = [b.x2, b.y2]
  const d1 = sideOf(a1, a2, b1)
  const d2 = sideOf(a1, a2, b2)
  const d3 = sideOf(b1, b2, a1)
  const d4 = sideOf(b1, b2, a2)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true
  return onSegment(b1, a) || onSegment(b2, a) || onSegment(a1, b) || onSegment(a2, b)
}

/**
 * 点到线段的最短距离。
 * @param point - 待测点。
 * @param segment - 线段。
 * @returns 最短距离（与坐标同单位）；点落在线段上时为 0。
 */
export function pointSegmentDistance(point: GeoPoint, segment: GeoSegment): number {
  const dx = segment.x2 - segment.x1
  const dy = segment.y2 - segment.y1
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared === 0
    ? 0
    : Math.max(0, Math.min(1, ((point[0] - segment.x1) * dx + (point[1] - segment.y1) * dy) / lengthSquared))
  return Math.hypot(point[0] - (segment.x1 + dx * t), point[1] - (segment.y1 + dy * t))
}

/**
 * 射线与线段的交点参数。
 *
 * 射线为 `origin + t · direction`（t > 0），线段为 `a + u · (b - a)`（0 ≤ u ≤ 1）。
 * 用于从节点中心沿候选方向求真实轮廓边上的锚点：斜边形状的包围盒角点落在
 * 轮廓之外，直接用作引线起点会让引线悬空。
 * @param origin - 射线起点。
 * @param direction - 射线方向（无须单位化）。
 * @param segment - 目标线段。
 * @returns 沿 direction 的参数 t（> 0）；平行、共线或交点在线段外时 undefined。
 */
export function raySegmentIntersection(
  origin: GeoPoint,
  direction: GeoPoint,
  segment: GeoSegment,
): number | undefined {
  const edgeX = segment.x2 - segment.x1
  const edgeY = segment.y2 - segment.y1
  const denominator = direction[0] * edgeY - direction[1] * edgeX
  if (denominator === 0) return undefined
  const offsetX = segment.x1 - origin[0]
  const offsetY = segment.y1 - origin[1]
  const t = (offsetX * edgeY - offsetY * edgeX) / denominator
  const u = (offsetX * direction[1] - offsetY * direction[0]) / denominator
  if (t <= 0 || u < 0 || u > 1) return undefined
  return t
}
