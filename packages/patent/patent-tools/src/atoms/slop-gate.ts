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
 * - `embodiment_char_budget`：带特征编号的实施例块各自的可见字符预算。只改变
 *   这些块的篇幅结论，不把绝对化套话从全文评分里豁免。
 */

import {
  type Atom,
  type PipelineState,
  type StageExecuteInput,
  type StageHandler,
  degraded,
  getStateString,
  resolveKeyList,
} from '@deepseek-ai/dsh-patent-core'
import { analyzeSlop, SLOP_PASS_LINE, visibleChars } from '../internal/slop-engine.ts'
import { buildSlopRevisionHint } from '../internal/retry-hints.ts'
import { readCharBudget, readEmbodimentCharBudget } from '../internal/stage-params.ts'

/** 反套话评分门通过线（单一来源为 slop 引擎的 SLOP_PASS_LINE；改判定须改 engine）。 */
export const SLOP_GATE_PASS_THRESHOLD = SLOP_PASS_LINE

/** 缺省受理文本键（撰写链路的权利要求草稿）。 */
const DEFAULT_SLOP_TEXT_KEYS: readonly string[] = ['claims_draft']

/** 一个带特征编号、需要单独计篇幅的实施例块。 */
type FeatureCitedBlock = { index: number; text: string }

/**
 * 读出带特征编号的实施例块。没有该键时按空表处理。
 * @param state - 阶段执行态。
 * @returns 块列表；结构不符合实施例块时返回 undefined。
 */
function readFeatureCitedBlocks(state: PipelineState): FeatureCitedBlock[] | undefined {
  const raw = state['embodiment_blocks']
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return undefined
  const blocks: FeatureCitedBlock[] = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined
    const record = item as Record<string, unknown>
    const text = record['text']
    const featureIds = record['feature_ids']
    const index = record['index']
    if (typeof text !== 'string') return undefined
    if (!Array.isArray(featureIds) || featureIds.some(id => typeof id !== 'string')) return undefined
    if (featureIds.length === 0) continue
    if (typeof index !== 'number' || !Number.isInteger(index) || index <= 0) return undefined
    blocks.push({ index, text })
  }
  return blocks
}

/**
 * 逐块比较可见字符与预算。
 * @param blocks - 带特征编号的实施例块。
 * @param budget - 每块可见字符预算。
 * @returns 写入报告的一行，以及是否有块超出预算。
 */
function embodimentBudgetLine(blocks: readonly FeatureCitedBlock[], budget: number): { text: string; exceeded: boolean } {
  if (blocks.length === 0) return { text: '实施例块篇幅：无带特征编号的实施例块', exceeded: false }
  const exceeded = blocks.some(block => visibleChars(block.text) > budget)
  const parts = blocks.map(block => `实施例${block.index} ${visibleChars(block.text)}/${budget}`)
  return { text: `实施例块篇幅：${parts.join('，')}${exceeded ? '，超出预算' : '，未超出预算'}`, exceeded }
}

/** slop-gate 原子：对草稿文本做确定性套话检测，未通过时输出「需修订」并附证据提示。 */
export const slopGateAtom: Atom = {
  name: 'slop-gate',
  description: '反套话评分门：对权利要求草稿、说明书正文或意见陈述书正文做确定性套话检测；未通过时输出「需修订」并写入证据型修订提示（声明 retry 的 manifest 据此回退重写）',
  category: 'gate',
  inputSchema: ['claims_draft', 'draft', 'draft_tightened', 'specification', 'text_keys', 'char_budget', 'embodiment_char_budget', 'embodiment_blocks'],
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
    const keys = resolveKeyList(state, 'text_keys', DEFAULT_SLOP_TEXT_KEYS)
    if (keys === undefined) {
      return degraded('slop-gate', 'params.text_keys 必须是非空字符串数组')
    }
    const budget = readCharBudget(state)
    if (budget.kind === 'invalid') {
      return degraded('slop-gate', 'params.char_budget 必须是正整数')
    }
    const embodimentBudget = readEmbodimentCharBudget(state)
    if (embodimentBudget.kind === 'invalid') {
      return degraded('slop-gate', 'params.embodiment_char_budget 必须是正整数')
    }
    const featureBlocks = embodimentBudget.value === undefined ? [] : readFeatureCitedBlocks(state)
    if (featureBlocks === undefined) {
      return degraded('slop-gate', 'embodiment_blocks 必须是实施例块数组')
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
    const blockBudget = embodimentBudget.value === undefined
      ? undefined
      : embodimentBudgetLine(featureBlocks, embodimentBudget.value)
    const passed = score.passed && blockBudget?.exceeded !== true
    const headline = `反套话评分门: ${passed ? '✅ 通过' : '⚠️ 需修订'}（总分 ${score.total}，通过线 ${SLOP_GATE_PASS_THRESHOLD}）`
    const segment: PipelineState = {
      slop_report: blockBudget === undefined ? headline : `${headline}\n${blockBudget.text}`,
      slop_score: score.total,
    }
    if (!score.passed) {
      const hint = buildSlopRevisionHint(analysis)
      if (hint !== undefined) segment.slop_revision_hint = hint
    }
    return segment
  }
}
