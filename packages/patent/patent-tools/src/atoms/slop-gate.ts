/**
 * 反套话域原子：slop-gate（确定性评分门 + 失败时的证据型修订提示）。
 *
 * 移植自 Sati 的 src/patent/atoms/handlers/builtin/gate.ts（SlopGateHandler）。
 * 与 patent-core 的内置 handler 不同，本 handler 依赖 dsh-patent-tools 的
 * slop 引擎（analyzeSlop / buildSlopRevisionHint），故按依赖方向落在本包。
 *
 * 未通过时输出含「需修订」的 slop_report（retry 信号载体）与 slop_score，并写入
 * 仅含证据的 slop_revision_hint（保密契约，见 retry-hints.ts）。回退由 manifest
 * 的 retry 声明，不由本 handler 执行：`patent_oa_response_v1` 的 `slop_gate`
 * 命中「需修订」后回退到 `draft`，重写时注入该提示；`patent_disclosure_v1` 的
 * `slop_clean` 评说明书正文且不声明 retry——权项由策略表确定性渲染，重跑不会
 * 改分，未通过只报告。
 *
 * 受理文本由阶段参数决定，不绑定单一链路：
 * - `text_keys`（缺省 `['claims_draft']`）：按顺序读取并拼接；答复链传
 *   `['draft_tightened']`，披露链传 `['specification']`。
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
  description: '反套话评分门：对权利要求草稿、说明书正文或意见陈述书正文做确定性套话检测；未通过时输出「需修订」并写入证据型修订提示（声明 retry 的 manifest 据此回退重写）',
  category: 'gate',
  inputSchema: ['claims_draft', 'draft', 'draft_tightened', 'specification', 'text_keys', 'char_budget'],
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
