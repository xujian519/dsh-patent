/**
 * src/quality/ledger — draft-quality-ledger 用的确定性判定目录与折叠。
 *
 * 撰写链的下游门（spec-check、enablement-report、claim-breadth、legal-gaps、
 * revision-ledger）各自把布尔判定写进共享 state，但没有任何一处把它们合成一个
 * 可比较的质量标量。本模块按固定目录折叠这些既有输出：每行判定为通过、未过或
 * 未评估（上游阶段没跑、或原子降级没写键），只有已判定行参与标量计数，未评估行
 * 原样列出，避免把「没查」混进「查了没过」或「全过」。反套话分数（`slop_score`）
 * 是数值指标，通过线归 patent-tools 的 slop-gate 所有，这里只作信息行展示。
 */

import { isRecord } from '@deepseek-ai/dsh-value'

/** 单行质量判定。 */
export type DraftQualityVerdict = {
  /** state 键，也是行 id。 */
  key: string
  /** 面向报告的行标签。 */
  label: string
  /** 判定依据（法条或来源原子）。 */
  provision: string
  /** 通过 / 未过 / 未评估。 */
  status: 'passed' | 'failed' | 'unassessed'
  /** 未评估的原因（信号缺失或类型不符）。 */
  reason?: string
}

/** 质量标量汇总。 */
export type DraftQualitySummary = {
  /** 目录中的全部判定行，按目录顺序。 */
  verdicts: DraftQualityVerdict[]
  /** 通过行数。 */
  passed: number
  /** 未过行数。 */
  failed: number
  /** 未评估行数。 */
  unassessed: number
  /** 已判定行数（通过 + 未过）。 */
  assessed: number
  /** 0–100 的整数标量：通过 / 已判定；无已判定行时为 0。 */
  score: number
  /** 全部门判定通过且无未评估行时为 true。 */
  passedAll: boolean
}

/** 判定目录条目：`key` 为 state 键，`label`/`provision` 供报告渲染。 */
type DraftQualitySignal = { readonly key: string; readonly label: string; readonly provision: string }

const SPEC_CHECK_SIGNAL: DraftQualitySignal = { key: 'spec_check_passed', label: '说明书/权利要求形式合规', provision: 'A26.3/A26.4（spec-check）' }
const ENABLEMENT_SIGNAL: DraftQualitySignal = { key: 'enablement_passed', label: '充分公开实施例锚点', provision: 'A26.3（enablement-report）' }
const CLAIM_BREADTH_SIGNAL: DraftQualitySignal = { key: 'claim_breadth_passed', label: '上位概括锚点支撑', provision: 'A26.4（claim-breadth）' }
const REVISION_LEDGER_SIGNAL: DraftQualitySignal = { key: 'revision_ledger_cleared', label: '修订逐条销账', provision: 'draft-review 账本（revision-ledger）' }
const LEGAL_GAPS_SIGNAL: DraftQualitySignal = { key: 'legal_gaps_passed', label: '法条缺口无阻断项', provision: 'legal-gaps 汇总' }

/** 判定目录：目录顺序即报告行顺序。 */
export const DRAFT_QUALITY_SIGNALS: readonly DraftQualitySignal[] = [
  SPEC_CHECK_SIGNAL,
  ENABLEMENT_SIGNAL,
  CLAIM_BREADTH_SIGNAL,
  REVISION_LEDGER_SIGNAL,
  LEGAL_GAPS_SIGNAL,
]

/**
 * 折叠布尔判定键。
 * @param state - 共享执行态。
 * @param entry - 目录条目。
 * @returns 判定行；键缺失或非布尔时判未评估并写明原因。
 */
function readBooleanVerdict(state: Record<string, unknown>, entry: DraftQualitySignal): DraftQualityVerdict {
  const value = state[entry.key]
  if (value === undefined) {
    return { ...entry, status: 'unassessed', reason: '信号缺失：上游阶段未运行或已降级' }
  }
  if (typeof value !== 'boolean') {
    return { ...entry, status: 'unassessed', reason: `信号类型不是布尔（${typeof value}）` }
  }
  return { ...entry, status: value ? 'passed' : 'failed' }
}

/**
 * 把修订账本折叠成一行判定。
 * @param state - 共享执行态（读 `revision_ledger_reconciliation`）。
 * @returns 判定行；账本缺失或字段畸形时判未评估。
 */
export function revisionLedgerVerdict(state: Record<string, unknown>): DraftQualityVerdict {
  const raw = state.revision_ledger_reconciliation
  if (!isRecord(raw)) {
    return { ...REVISION_LEDGER_SIGNAL, status: 'unassessed', reason: '账本缺失：revision-ledger 阶段未运行或已降级' }
  }
  if (typeof raw.persisting !== 'number' || typeof raw.roundCount !== 'number') {
    return { ...REVISION_LEDGER_SIGNAL, status: 'unassessed', reason: '账本字段类型不符（persisting/roundCount 非数值）' }
  }
  if (raw.roundCount === 0) {
    return { ...REVISION_LEDGER_SIGNAL, status: 'unassessed', reason: '无审查轮次记录：draft-review 未执行修订闭环' }
  }
  return { ...REVISION_LEDGER_SIGNAL, status: raw.persisting === 0 ? 'passed' : 'failed' }
}

/**
 * 折叠全部质量信号。
 * @param state - 共享执行态（各门原子的输出键）。
 * @returns 标量汇总；目录顺序固定，与信号是否在场无关。
 */
export function reconcileDraftQuality(state: Record<string, unknown>): DraftQualitySummary {
  const verdicts = DRAFT_QUALITY_SIGNALS.map(signal =>
    signal === REVISION_LEDGER_SIGNAL ? revisionLedgerVerdict(state) : readBooleanVerdict(state, signal),
  )
  const passed = verdicts.filter(verdict => verdict.status === 'passed').length
  const failed = verdicts.filter(verdict => verdict.status === 'failed').length
  const unassessed = verdicts.filter(verdict => verdict.status === 'unassessed').length
  const assessed = passed + failed
  return {
    verdicts,
    passed,
    failed,
    unassessed,
    assessed,
    score: assessed === 0 ? 0 : Math.round((passed / assessed) * 100),
    passedAll: assessed > 0 && failed === 0 && unassessed === 0,
  }
}

const STATUS_ICON: Record<DraftQualityVerdict['status'], string> = {
  passed: '✅ 通过',
  failed: '⚠️ 未过',
  unassessed: '◻️ 未评估',
}

/**
 * 渲染质量标量首行。
 * @param summary - 折叠后的汇总。
 * @returns 一行结论，含标量与三类计数。
 */
export function renderDraftQualityHeadline(summary: DraftQualitySummary): string {
  if (summary.assessed === 0) {
    return `稿件质量标量 0/100（已判定 0/${String(summary.verdicts.length)} 项）：无可用质量信号，全部未评估。`
  }
  const verdict = summary.passedAll ? '全部通过' : summary.failed > 0 ? `未过 ${String(summary.failed)} 项` : `未评估 ${String(summary.unassessed)} 项`
  return `稿件质量标量 ${String(summary.score)}/100（已判定 ${String(summary.assessed)}/${String(summary.verdicts.length)} 项）：通过 ${String(summary.passed)} 项，${verdict}。`
}

/**
 * 渲染逐条质量矩阵报告。
 * @param state - 共享执行态（同时读 `slop_score` 作信息行）。
 * @param summary - 折叠后的汇总。
 * @returns 中文报告：首行标量，随后逐条判定与信息行。
 */
export function renderDraftQualityReport(state: Record<string, unknown>, summary: DraftQualitySummary): string {
  const lines: string[] = ['稿件质量账本（确定性汇总，不调用模型）：', renderDraftQualityHeadline(summary)]
  for (const verdict of summary.verdicts) {
    const detail = verdict.status === 'unassessed' ? `——${verdict.reason ?? '未挂接任何质量信号'}` : ''
    lines.push(`- ${verdict.label}（${verdict.provision}）：${STATUS_ICON[verdict.status]}${detail}`)
  }
  const slopScore = state.slop_score
  if (typeof slopScore === 'number') {
    lines.push(`- 反套话评分（slop-gate，信息行不计入标量）：${String(slopScore)}`)
  } else {
    lines.push('- 反套话评分（slop-gate，信息行不计入标量）：◻️ 未评估——`slop_score` 缺失')
  }
  lines.push('说明：标量只统计已判定行；未评估行需人工复核或在报告里明示，不得当作通过。')
  return lines.join('\n')
}
