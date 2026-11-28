import { describe, expect, it } from 'vitest'
import {
  checkFigureSetConsistency,
  extractClaimNumeralRefs,
  hasNumeralPrefix,
} from '../src/figure/figure-set-consistency.ts'

/** 跨图一致性：机械案的数字标记归并、名称冲突、图号连续性与权利要求对齐。 */

describe('hasNumeralPrefix', () => {
  it('识别专用编号词与图示引用后的单字编号词', () => {
    expect(hasNumeralPrefix('参见公式')).toBe(true)
    expect(hasNumeralPrefix('如图')).toBe(true)
    expect(hasNumeralPrefix('见条')).toBe(true)
  })

  it('普通部件名不判为编号词', () => {
    expect(hasNumeralPrefix('所述壳体')).toBe(false)
    expect(hasNumeralPrefix('所述密封条')).toBe(false)
    expect(hasNumeralPrefix('连接方式')).toBe(false)
    expect(hasNumeralPrefix('')).toBe(false)
  })
})

describe('extractClaimNumeralRefs', () => {
  it('抽取括号形与直连形标记，去重升序', () => {
    expect(extractClaimNumeralRefs('壳体(10)与盖板（20）连接；转轴30，卡扣(10)')).toEqual([10, 20, 30])
  })

  it('排除编号词后的数字、步骤号与四位年份', () => {
    expect(extractClaimNumeralRefs('如公式(1)所示，步骤(2)，实施例3，申请日(2023)')).toEqual([])
    expect(extractClaimNumeralRefs('图2中壳体(10)')).toEqual([10])
  })

  it('空文本与未给出文本都返回空数组', () => {
    expect(extractClaimNumeralRefs(undefined)).toEqual([])
    expect(extractClaimNumeralRefs('')).toEqual([])
  })

  it('达到上限时停止收集', () => {
    expect(extractClaimNumeralRefs('壳体(10)盖板(20)转轴(30)', 2)).toEqual([10, 20])
    expect(extractClaimNumeralRefs('壳体10，盖板20，转轴30，', 2)).toEqual([10, 20])
  })
})

describe('checkFigureSetConsistency', () => {
  it('同一标记跨图同名时合并图号并通过', () => {
    const report = checkFigureSetConsistency([
      { figureNumber: 2, components: [{ refNumber: '10', name: '壳体' }] },
      { figureNumber: 1, components: [{ refNumber: '10', name: '壳体' }] },
    ])
    expect(report.figureCount).toBe(2)
    expect(report.numericComponents).toEqual({ 10: { name: '壳体', figureNumbers: [1, 2] } })
    expect(report.conflicts).toEqual([])
    expect(report.warnings).toEqual([])
    expect(report.consistent).toBe(true)
    expect(report.summary).toContain('跨图一致性检查通过')
  })

  it('同一标记跨图名称不一致时报冲突', () => {
    const report = checkFigureSetConsistency([
      { figureNumber: 1, components: [{ refNumber: '10', name: '壳体' }] },
      { figureNumber: 2, components: [{ refNumber: '10', name: '底座' }] },
    ])
    expect(report.consistent).toBe(false)
    expect(report.conflicts).toHaveLength(1)
    expect(report.conflicts[0]).toMatchObject({
      kind: 'name',
      ref: '10',
      figureNumbers: [1, 2],
      values: [
        { figureNumber: 1, value: '壳体' },
        { figureNumber: 2, value: '底座' },
      ],
    })
    expect(report.warnings[0]).toContain('名称不一致')
    expect(report.summary).toContain('跨图标记冲突 1 处')
  })

  it('首图没有名称时，冲突的原值归属到真正写了该名称的那张图', () => {
    const report = checkFigureSetConsistency([
      { figureNumber: 1, components: [{ refNumber: '10', name: '' }] },
      { figureNumber: 2, components: [{ refNumber: '10', name: '立柱' }] },
      { figureNumber: 3, components: [{ refNumber: '10', name: '立柱体' }] },
    ])
    expect(report.conflicts).toHaveLength(1)
    expect(report.conflicts[0]?.values).toEqual([
      { figureNumber: 2, value: '立柱' },
      { figureNumber: 3, value: '立柱体' },
    ])
    // 报告不能把图 2 的名称说成图 1 的，否则模型会去改错那张图。
    expect(report.conflicts[0]?.message).toContain('图 2、图 3')
    expect(report.conflicts[0]?.message).not.toContain('图 1')
  })

  it('一侧名称为空不算冲突，并用非空名称补齐', () => {
    const report = checkFigureSetConsistency([
      { figureNumber: 1, components: [{ refNumber: '10', name: '' }] },
      { figureNumber: 2, components: [{ refNumber: '10', name: '壳体' }] },
    ])
    expect(report.conflicts).toEqual([])
    expect(report.numericComponents['10']?.name).toBe('壳体')
  })

  it('没有附图时不判图号连续性', () => {
    const report = checkFigureSetConsistency([])
    expect(report.figureCount).toBe(0)
    expect(report.missingFigureNumbers).toEqual([])
    expect(report.consistent).toBe(true)
    expect(report.summary).toContain('附图 0 张')
  })

  it('两侧名称都为空时保留空名称且不报冲突', () => {
    const report = checkFigureSetConsistency([
      { figureNumber: 1, components: [{ refNumber: '10', name: '' }] },
      { figureNumber: 2, components: [{ refNumber: '10', name: '' }] },
    ])
    expect(report.conflicts).toEqual([])
    expect(report.numericComponents['10']?.name).toBe('')
  })

  it('忽略非数字标记与超过三位的数字', () => {
    const report = checkFigureSetConsistency([
      { figureNumber: 1, components: [{ refNumber: 'R1', name: '电阻' }, { refNumber: '1000', name: '年份' }] },
    ])
    expect(report.numericComponents).toEqual({})
    expect(report.consistent).toBe(true)
  })

  it('同一图号出现两次时列出重复图号', () => {
    const report = checkFigureSetConsistency([
      { figureNumber: 1, components: [] },
      { figureNumber: 1, components: [] },
    ])
    expect(report.duplicateFigureNumbers).toEqual([1])
    expect(report.warnings.some(warning => warning.includes('附图编号重复：1'))).toBe(true)
    expect(report.summary).toContain('重复图号 1 个')
    expect(report.consistent).toBe(false)
  })

  it('图号不连续时列出缺失图号', () => {
    const report = checkFigureSetConsistency([
      { figureNumber: 1, components: [] },
      { figureNumber: 3, components: [] },
    ])
    expect(report.missingFigureNumbers).toEqual([2])
    expect(report.warnings[0]).toContain('缺失图号：2')
    expect(report.consistent).toBe(false)
  })

  it('权利要求引用未在任何图中识别时报缺标', () => {
    const report = checkFigureSetConsistency(
      [{ figureNumber: 1, components: [{ refNumber: '10', name: '壳体' }] }],
      '壳体(10)与盖板(20)连接，转轴30，',
    )
    expect(report.missingRefs).toEqual([20, 30])
    expect(report.warnings.some(warning => warning.includes('未在附图中识别：20, 30'))).toBe(true)
    expect(report.summary).toContain('2 个引用未在附图中识别')
  })

  it('附图中没有数字标记时不启用权利要求对齐（电学案的普通数字不误报）', () => {
    const report = checkFigureSetConsistency(
      [{ figureNumber: 1, components: [{ refNumber: 'R1', name: '电阻' }] }],
      '电阻R1的阻值为10(欧姆)',
    )
    expect(report.missingRefs).toEqual([])
    expect(report.consistent).toBe(true)
  })

  it('未给权利要求文本时不做对齐', () => {
    const report = checkFigureSetConsistency([{ figureNumber: 1, components: [{ refNumber: '10', name: '壳体' }] }])
    expect(report.missingRefs).toEqual([])
  })
})
