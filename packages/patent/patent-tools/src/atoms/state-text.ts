/**
 * 撰写域原子共用的状态文本读取。
 */

import type { PipelineState } from '@deepseek-ai/dsh-patent-core'

/** 按候选键读取状态文本的结果：命中、全部缺失或类型错误。 */
type StateTextRead =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'missing'; reason: string }
  | { kind: 'error'; reason: string }

/**
 * 按优先级读取第一个非空字符串键。
 *
 * 缺失的键继续回退；键存在但类型不是字符串时立即报错，避免把非法输入当成缺输入。
 * @param state - 阶段执行态。
 * @param keys - 候选键，按优先级排列。
 * @param label - 缺失报告中的文本角色（如“权利要求”）。
 * @returns 命中文本与键名、缺失原因或类型错误原因。
 */
export function readFirstStateText(
  state: PipelineState,
  keys: readonly string[],
  label: string,
): StateTextRead {
  for (const key of keys) {
    const value = state[key]
    if (value === undefined) continue
    if (typeof value !== 'string') return { kind: 'error', reason: `state.${key} 不是字符串` }
    if (value.trim().length === 0) continue
    return { kind: 'text', key, text: value }
  }
  return { kind: 'missing', reason: `未提供${label}（${keys.join(' / ')}）` }
}
