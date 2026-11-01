/**
 * 阶段参数的共用读取。
 *
 * `char_budget` 由 `slop-gate` 与 `tighten` 各自声明，两处必须同判：前者按它归一 concision
 * 评分，后者按它决定要不要调模型删减、以及删到多少算达标。任一处放松校验，另一处就会收到
 * 一个自己不会承认的预算，于是同一份草稿在评分与删减两个阶段得到两种「超没超预算」的答案。
 * 放在这里只为一件事：口径只有一份实现。
 *
 * @module
 */

import type { PipelineState } from '@deepseek-ai/dsh-patent-core'

/** 篇幅预算的读取结果：已声明、未声明或取值非法。 */
type BudgetRead = { kind: 'ok'; value?: number } | { kind: 'invalid' }

/**
 * 读取阶段参数 `char_budget`。
 * @param state - 阶段执行态（阶段参数已合入）。
 * @returns 预算（未声明时 `value` 为 undefined）或非法标记。
 */
export function readCharBudget(state: PipelineState): BudgetRead {
  const raw = state.char_budget
  if (raw === undefined) return { kind: 'ok' }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) return { kind: 'invalid' }
  return { kind: 'ok', value: raw }
}
