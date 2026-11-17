import { expect, it } from 'vitest'
import {
  DEGRADED_ERROR_KEY,
  DEGRADED_RETRYABLE_KEY,
  type GraphState,
} from '@deepseek-ai/dsh-patent-core'
import {
  DEGRADATION_SUFFIX,
  absorbHandlerDegradation,
  degradationSummary,
  getDegradationMark,
  isDegraded,
  markDegraded,
} from '../../src/graph/degradation.ts'
import type { StateDelta } from '../../src/graph/types.ts'

it('markDegraded: 写 fallback 值与并列降级标记', () => {
  const delta: StateDelta = {}
  markDegraded(delta, 'prior_art', [], 'search_failed', '检索失败', 'warning')
  expect(delta.prior_art).toEqual([])
  expect(delta[`prior_art${DEGRADATION_SUFFIX}`]).toEqual({
    reason: 'search_failed',
    message: '检索失败',
    severity: 'warning',
  })
})

it('isDegraded / getDegradationMark: 读取标记', () => {
  const state: GraphState = {}
  const delta: StateDelta = {}
  markDegraded(delta, 'features', [], 'llm_unavailable', 'LLM 不可用')
  Object.assign(state, delta)
  expect(isDegraded(state, 'features')).toBe(true)
  expect(isDegraded(state, 'other')).toBe(false)
  expect(getDegradationMark(state, 'features')).toEqual({
    reason: 'llm_unavailable',
    message: 'LLM 不可用',
    severity: 'warning',
  })
  expect(getDegradationMark(state, 'other')).toBeUndefined()
})

it('degradationSummary: 汇总全部标记（按 key 字典序）', () => {
  const state: GraphState = {}
  const a: StateDelta = {}
  const b: StateDelta = {}
  markDegraded(a, 'prior_art', [], 'search_failed', '检索失败', 'critical')
  markDegraded(b, 'features', [], 'llm_unavailable', 'LLM 不可用')
  Object.assign(state, a, b)
  state['normal_key'] = '正常数据'
  const summary = degradationSummary(state)
  expect(summary.length).toBe(2)
  // 字典序：features__degradation < prior_art__degradation
  expect(summary[0]?.reason).toBe('llm_unavailable')
  expect(summary[1]?.reason).toBe('search_failed')
})

it('degradationSummary: 结构异常的标记 key 被忽略', () => {
  const state: GraphState = { [`bad${DEGRADATION_SUFFIX}`]: 'not-an-object' }
  expect(degradationSummary(state)).toEqual([])
})

it('absorbHandlerDegradation: 无 _error 的片段原样返回', () => {
  const delta: StateDelta = { result: '成功' }
  expect(absorbHandlerDegradation(delta, 'node')).toBe(delta)
})

it('absorbHandlerDegradation: 剥离内部诊断键并写节点级标记', () => {
  const delta: StateDelta = {
    result: '部分结果',
    [DEGRADED_ERROR_KEY]: '[atom] 缺少输入',
    [DEGRADED_RETRYABLE_KEY]: false,
  }
  const absorbed = absorbHandlerDegradation(delta, 'node')
  expect(absorbed.result).toBe('部分结果')
  expect(absorbed).not.toHaveProperty(DEGRADED_ERROR_KEY)
  expect(absorbed).not.toHaveProperty(DEGRADED_RETRYABLE_KEY)
  expect(absorbed[`node${DEGRADATION_SUFFIX}`]).toEqual({
    reason: 'node_failed',
    message: '[atom] 缺少输入',
    severity: 'critical',
  })
})

it('absorbHandlerDegradation: 非字符串 _error 以 JSON 文本记录', () => {
  const absorbed = absorbHandlerDegradation({ [DEGRADED_ERROR_KEY]: { code: 'E1' } }, 'node')
  expect(absorbed[`node${DEGRADATION_SUFFIX}`]).toMatchObject({ message: '{"code":"E1"}' })
})

it('absorbHandlerDegradation: 可重试失败在消息中标注', () => {
  const absorbed = absorbHandlerDegradation(
    { [DEGRADED_ERROR_KEY]: '[atom] 临时失败', [DEGRADED_RETRYABLE_KEY]: true },
    'node',
  )
  expect(absorbed[`node${DEGRADATION_SUFFIX}`]).toMatchObject({
    message: '[atom] 临时失败（可重试）',
  })
})
