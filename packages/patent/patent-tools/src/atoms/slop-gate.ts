/**
 * 反套话域原子：slop-gate（评分门 + 失败带证据自动回退）。
 *
 * 移植自 Sati 的 src/patent/atoms/handlers/builtin/gate.ts（SlopGateHandler）。
 * 与 patent-core 的内置 handler 不同，本 handler 依赖 dsh-patent-tools 的
 * slop 引擎（analyzeSlop / buildSlopRevisionHint），故按依赖方向落在本包。
 *
 * 闭环：manifest 中 draft-claims 之后接 slop-gate 阶段，其 retry 声明
 * `whenOutputMatches: '需修订'`、`rewindTo: 'draft_claims'`；未通过时本
 * handler 输出含「需修订」的 slop_report（retry 信号载体）并写入仅含证据
 * 的 slop_revision_hint（保密契约，见 retry-hints.ts），runWorkflow 捕获信号
 * 回退重跑 draft-claims，其 prompt 注入上一轮 hint。
 *
 * 受理文本由阶段参数决定，不绑定单一链路：
 * - `text_keys`（缺省 `['claims_draft']`）：按顺序读取并拼接，撰写链路行为不变；
 *   意见陈述书链路传 `['draft']`（收口阶段的产出落在 `state[stage.id]`）。
 * - `char_budget`：该文书的篇幅预算（可见字符）。声明后 concision 按预算归一，
 *   未声明则沿用段数口径（见 slop 引擎 scoreConcision）。
 */

import {
  type Atom,
  type PipelineState,
  type StageExecuteInput,
  type StageHandler,
  degraded,
  getStateString,
} from '@deepseek-ai/dsh-patent-core'
import { analyzeSlop, SLOP_PASS_LINE } from '../internal/slop-engine.ts'
import { buildSlopRevisionHint } from '../internal/retry-hints.ts'
import { readCharBudget } from '../internal/stage-params.ts'

/** 反套话评分门通过线（单一来源为 slop 引擎的 SLOP_PASS_LINE；改判定须改 engine）。 */
export const SLOP_GATE_PASS_THRESHOLD = SLOP_PASS_LINE

/** 缺省受理文本键（撰写链路的权利要求草稿）。 */
const DEFAULT_SLOP_TEXT_KEYS: readonly string[] = ['claims_draft']

/**
 * 解析阶段参数 `text_keys`。
 *
 * 与 patent-core 内置 handler 的 `resolveKeyList` 同一语义（缺失取缺省、非法返回
 * undefined），但在本包内无法复用该模块的内部实现，故按同一约定在此实现。
 * @param state - 阶段执行态（阶段参数已合入）。
 * @returns 受理文本键；参数已声明但非法时返回 undefined。
 */
function resolveTextKeys(state: PipelineState): string[] | undefined {
  const raw = state.text_keys
  if (raw === undefined) return [...DEFAULT_SLOP_TEXT_KEYS]
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const keys: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim().length === 0) return undefined
    keys.push(item.trim())
  }
  return keys
}

/** slop-gate 原子：对草稿文本做确定性套话检测，未通过时输出「需修订」并附证据提示。 */
export const slopGateAtom: Atom = {
  name: 'slop-gate',
  description: '反套话评分门：对权利要求草稿或意见陈述书正文做确定性套话检测；未通过时输出「需修订」并写入证据型修订提示（自动回退重写）',
  category: 'gate',
  inputSchema: ['claims_draft', 'draft', 'text_keys', 'char_budget'],
  outputSchema: ['slop_report', 'slop_score'],
}

/** slop-gate 执行器：确定性评分 + 未通过时产出回退信号与证据提示。 */
export class SlopGateHandler implements StageHandler {
  readonly name = 'slop-gate'
  readonly category = 'gate' as const

  /**
   * 执行 slop-gate 阶段，返回下一管线状态。
   * @param input - 阶段执行输入（state 中已合入阶段参数）。
   * @returns 下一管线状态（含 slop_report / slop_score，未通过时追加 slop_revision_hint）。
   */
  // oxlint-disable-next-line typescript/require-await -- StageHandler contract requires async execute
  async execute(input: StageExecuteInput): Promise<PipelineState> {
    const { state } = input
    const keys = resolveTextKeys(state)
    if (keys === undefined) {
      return degraded('slop-gate', 'params.text_keys 必须是非空字符串数组')
    }
    const budget = readCharBudget(state)
    if (budget.kind === 'invalid') {
      return degraded('slop-gate', 'params.char_budget 必须是正整数')
    }
    const draft = keys
      .map(key => getStateString(state, key))
      .filter(text => text.trim().length > 0)
      .join('\n\n')
      .trim()
    if (draft.length === 0) {
      return degraded('slop-gate', `输入为空（${keys.join('、')}）`)
    }
    const analysis = analyzeSlop(draft, budget.value === undefined ? {} : { charBudget: budget.value })
    const { score } = analysis
    const passed = score.passed
    const segment: PipelineState = {
      slop_report: `反套话评分门: ${passed ? '✅ 通过' : '⚠️ 需修订'}（总分 ${score.total}，通过线 ${SLOP_GATE_PASS_THRESHOLD}）`,
      slop_score: score.total,
    }
    if (!passed) {
      const hint = buildSlopRevisionHint(analysis)
      if (hint !== undefined) segment.slop_revision_hint = hint
    }
    return segment
  }
}
