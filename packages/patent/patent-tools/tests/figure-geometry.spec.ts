import { describe, expect, it } from 'vitest'
import { onSegment, pointSegmentDistance, raySegmentIntersection, segmentsIntersect, sideOf } from '../src/figure/geometry.ts'

describe('figure geometry', () => {
  it('reports which side of a directed line a point falls on', () => {
    expect(sideOf([0, 0], [2, 0], [1, 1])).toBeGreaterThan(0)
    expect(sideOf([0, 0], [2, 0], [1, -1])).toBeLessThan(0)
    expect(sideOf([0, 0], [2, 0], [3, 0])).toBe(0)
  })

  it('accepts points inside the segment and rejects collinear points beyond it', () => {
    const segment = { x1: 0, y1: 0, x2: 4, y2: 4 }
    expect(onSegment([2, 2], segment)).toBe(true)
    expect(onSegment([0, 0], segment)).toBe(true)
    expect(onSegment([5, 5], segment)).toBe(false)
    expect(onSegment([2, 3], segment)).toBe(false)
  })

  it('detects crossing, touching, and disjoint segments', () => {
    expect(segmentsIntersect({ x1: 0, y1: 0, x2: 4, y2: 4 }, { x1: 0, y1: 4, x2: 4, y2: 0 })).toBe(true)
    expect(segmentsIntersect({ x1: 0, y1: 0, x2: 2, y2: 0 }, { x1: 2, y1: 0, x2: 4, y2: 0 })).toBe(true)
    expect(segmentsIntersect({ x1: 0, y1: 0, x2: 1, y2: 0 }, { x1: 3, y1: 0, x2: 4, y2: 0 })).toBe(false)
    expect(segmentsIntersect({ x1: 0, y1: 0, x2: 1, y2: 0 }, { x1: 0, y1: 1, x2: 1, y2: 1 })).toBe(false)
  })

  it('measures the shortest distance to a segment, clamping to its endpoints', () => {
    expect(pointSegmentDistance([2, 3], { x1: 0, y1: 0, x2: 4, y2: 0 })).toBe(3)
    expect(pointSegmentDistance([6, 0], { x1: 0, y1: 0, x2: 4, y2: 0 })).toBe(2)
    expect(pointSegmentDistance([2, 0], { x1: 0, y1: 0, x2: 4, y2: 0 })).toBe(0)
    // 零长度线段退化为点。
    expect(pointSegmentDistance([1, 1], { x1: 0, y1: 0, x2: 0, y2: 0 })).toBeCloseTo(Math.SQRT2)
  })

  it('finds the nearest forward ray-segment intersection and rejects parallel, behind-origin, or out-of-segment hits', () => {
    expect(raySegmentIntersection([0, 0], [1, 0], { x1: 5, y1: -1, x2: 5, y2: 1 })).toBe(5)
    // 交点落在线段端点上也接受。
    expect(raySegmentIntersection([0, 0], [1, 0], { x1: 5, y1: 0, x2: 5, y2: 1 })).toBe(5)
    // 射线背向线段、线段在射线一侧、共线都没有交点。
    expect(raySegmentIntersection([0, 0], [1, 0], { x1: -5, y1: -1, x2: -5, y2: 1 })).toBeUndefined()
    expect(raySegmentIntersection([0, 0], [1, 0], { x1: 5, y1: 1, x2: 5, y2: 2 })).toBeUndefined()
    expect(raySegmentIntersection([0, 0], [1, 0], { x1: 0, y1: 0, x2: 4, y2: 0 })).toBeUndefined()
  })
})
