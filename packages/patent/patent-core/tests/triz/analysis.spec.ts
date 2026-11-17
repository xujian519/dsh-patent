import { expect, it } from 'vitest'
import { buildTrizAnalysis } from '@deepseek-ai/dsh-patent-core'
import type { TrizExtractionInput } from '../../src/triz/types.ts'
import { loadMatrix } from '@deepseek-ai/dsh-methodology'

const SOURCE = '本方案增大预紧力以提升结构稳定性，但预紧力增大后装配耗时明显增加，产线节拍下降。'

/** 找一个非对角且矩阵有推荐原理的格。 */
function findRecommendedCell(): { improving: number; worsening: number } {
  const matrix = loadMatrix()
  for (let worsening = 1; worsening <= 39; worsening += 1) {
    for (let improving = 1; improving <= 39; improving += 1) {
      if (improving === worsening) continue
      if ((matrix[worsening - 1]?.[improving - 1] ?? []).length > 0) return { improving, worsening }
    }
  }
  throw new Error('矩阵中没有非对角且非空的格')
}

/** 找一个非对角且矩阵为空缺的格。 */
function findGapCell(): { improving: number; worsening: number } {
  const matrix = loadMatrix()
  for (let worsening = 1; worsening <= 39; worsening += 1) {
    for (let improving = 1; improving <= 39; improving += 1) {
      if (improving === worsening) continue
      if ((matrix[worsening - 1]?.[improving - 1] ?? []).length === 0) return { improving, worsening }
    }
  }
  throw new Error('矩阵中没有非对角空格')
}

it('落格: 编号合法且证据可定位 → 采用并补全参数名与原理名', () => {
  const cell = findRecommendedCell()
  const analysis = buildTrizAnalysis({
    contradictions: [{
      improving: cell.improving,
      worsening: cell.worsening,
      statement: '提升稳定性同时牺牲节拍',
      evidence: '增大预紧力以提升结构稳定性',
      solution_directions: ['把预紧力改为可调分组'],
    }],
  }, SOURCE)

  expect(analysis.droppedForEvidence).toBe(0)
  expect(analysis.unmapped).toEqual([])
  const contradiction = analysis.contradictions[0]!
  expect(contradiction.id).toBe('C1')
  expect(contradiction.matrixStatus).toBe('recommended')
  expect(contradiction.improving.number).toBe(cell.improving)
  expect(contradiction.improving.name.length).toBeGreaterThan(0)
  expect(contradiction.principles.length).toBeGreaterThan(0)
  expect(contradiction.principles.every(principle => principle.name.length > 0)).toBe(true)
  expect(contradiction.solutionDirections).toEqual(['把预紧力改为可调分组'])
})

it('证据核验: 片段不在原文 → 丢弃并计数，且不占用编号', () => {
  const cell = findRecommendedCell()
  const analysis = buildTrizAnalysis({
    contradictions: [
      {
        improving: cell.improving,
        worsening: cell.worsening,
        statement: '编造的矛盾',
        evidence: '这句话不在交底书里',
      },
      {
        improving: cell.improving,
        worsening: cell.worsening,
        statement: '有依据的矛盾',
        evidence: '预紧力增大后装配耗时明显增加',
      },
    ],
  }, SOURCE)

  expect(analysis.droppedForEvidence).toBe(1)
  expect(analysis.contradictions).toHaveLength(1)
  expect(analysis.contradictions[0]!.id).toBe('C1')
  expect(analysis.unmapped[0]!.reason).toContain('无法在交底书原文中定位')
})

it('证据核验: 空证据片段 → 丢弃（空串不算证据）', () => {
  const cell = findRecommendedCell()
  const analysis = buildTrizAnalysis({
    contradictions: [{ improving: cell.improving, worsening: cell.worsening, statement: '无证据', evidence: '   ' }],
  }, SOURCE)

  expect(analysis.contradictions).toEqual([])
  expect(analysis.droppedForEvidence).toBe(1)
})

it('编号校验: 越界与非整数 → 不落格，进 unmapped', () => {
  const analysis = buildTrizAnalysis({
    contradictions: [
      { improving: 40, worsening: 1, statement: '越界', evidence: '增大预紧力' },
      { improving: 0, worsening: 1, statement: '下界越界', evidence: '增大预紧力' },
      { improving: 2.5, worsening: 1, statement: '非整数', evidence: '增大预紧力' },
      { improving: '3', worsening: 1, statement: '字符串编号', evidence: '增大预紧力' },
    ],
  }, SOURCE)

  expect(analysis.contradictions).toEqual([])
  expect(analysis.unmapped).toHaveLength(4)
  expect(analysis.unmapped.every(item => item.reason.includes('整数编号'))).toBe(true)
})

it('矩阵落格: 对角格 → 物理矛盾，不给原理', () => {
  const analysis = buildTrizAnalysis({
    contradictions: [{ improving: 17, worsening: 17, statement: '温度自身矛盾', evidence: '增大预紧力' }],
  }, SOURCE)

  const contradiction = analysis.contradictions[0]!
  expect(contradiction.matrixStatus).toBe('physical')
  expect(contradiction.principles).toEqual([])
})

it('矩阵落格: 转录空格 → gap，不给原理', () => {
  const cell = findGapCell()
  const analysis = buildTrizAnalysis({
    contradictions: [{
      improving: cell.improving,
      worsening: cell.worsening,
      statement: '矩阵空缺',
      evidence: '增大预紧力',
    }],
  }, SOURCE)

  expect(analysis.contradictions[0]!.matrixStatus).toBe('gap')
  expect(analysis.contradictions[0]!.principles).toEqual([])
})

it('参数缺口: 同一参数多条 → 合并维度并保持全集顺序', () => {
  const analysis = buildTrizAnalysis({
    parameter_gaps: [
      { parameter: 9, missing: ['target-value', 'unit'], detail: '响应时间未给目标值' },
      { parameter: 9, missing: ['test-method'], detail: '' },
    ],
  }, SOURCE)

  expect(analysis.parameterGaps).toHaveLength(1)
  expect(analysis.parameterGaps[0]!.parameter.number).toBe(9)
  expect(analysis.parameterGaps[0]!.missing).toEqual(['target-value', 'unit', 'test-method'])
  expect(analysis.parameterGaps[0]!.detail).toBe('响应时间未给目标值')
})

it('参数缺口: 编号非法或维度非法 → 进 unmapped，不产出缺口', () => {
  const analysis = buildTrizAnalysis({
    parameter_gaps: [
      { parameter: 99, missing: ['unit'] },
      { parameter: 9, missing: ['不存在的维度'] },
      { parameter: 9, missing: [] },
    ],
  }, SOURCE)

  expect(analysis.parameterGaps).toEqual([])
  expect(analysis.unmapped).toHaveLength(3)
})

it('未映射项: 模型自报的 unmapped 原样并入，缺 reason 时给默认值', () => {
  const analysis = buildTrizAnalysis({
    unmapped: [{ statement: '提高客户满意度' }, { statement: '', reason: '空表述' }, 'not-an-object'],
  }, SOURCE)

  expect(analysis.unmapped).toHaveLength(1)
  expect(analysis.unmapped[0]!.statement).toBe('提高客户满意度')
  expect(analysis.unmapped[0]!.reason).toBe('未映射到 1-39 工程参数')
})

it('条目形状: 非对象矛盾与参数缺口逐项计入未映射', () => {
  const analysis = buildTrizAnalysis({
    contradictions: [null, {}, 'text'],
    parameter_gaps: [
      null,
      { parameter: 0, missing: ['unit'] },
      { parameter: 3, missing: [] },
      { missing: ['unit'] },
      {},
    ],
  }, SOURCE)

  expect(analysis.contradictions).toEqual([])
  expect(analysis.parameterGaps).toEqual([])
  expect(analysis.unmapped.map(item => item.reason)).toEqual([
    '条目不是对象',
    expect.stringContaining('改善／恶化参数不是'),
    '条目不是对象',
    '参数编号或缺失维度非法，未采纳',
    '参数编号或缺失维度非法，未采纳',
    '参数编号或缺失维度非法，未采纳',
    '参数编号或缺失维度非法，未采纳',
  ])
})

it('参数缺口: 同一参数多次出现时合并维度并保留首条非空说明', () => {
  const analysis = buildTrizAnalysis({
    parameter_gaps: [
      { parameter: 5, missing: ['unit'], detail: '' },
      { parameter: 5, missing: ['unit', 'current-value'], detail: '需补充当前值' },
    ],
  }, SOURCE)

  expect(analysis.parameterGaps).toHaveLength(1)
  expect(analysis.parameterGaps[0]).toMatchObject({
    missing: ['current-value', 'unit'],
    detail: '需补充当前值',
  })
  expect(analysis.parameterGaps[0]?.parameter.number).toBe(5)
  expect(analysis.parameterGaps[0]?.parameter.name).toBeTypeOf('string')
})

it('形状容错: 顶层字段非数组 → 空产物，不抛错', () => {
  const extraction: TrizExtractionInput = {
    contradictions: 'not-an-array',
    parameter_gaps: null,
    unmapped: 42,
  }
  const analysis = buildTrizAnalysis(extraction, SOURCE)

  expect(analysis.contradictions).toEqual([])
  expect(analysis.parameterGaps).toEqual([])
  expect(analysis.unmapped).toEqual([])
  expect(analysis.droppedForEvidence).toBe(0)
})
