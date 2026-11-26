/**
 * src/draft-review/findings — 逐条销账用的稳定 finding id 与跨轮对账。
 *
 * draft-review 每跑一轮，把当轮可执行争议点按稳定 id 记进 `_revision_ledger_rounds`。
 * 该键刻意不列入任何 atom 的 `outputSchema`：回退清理会删除已声明输出键，而这份轮次
 * 记录必须跨回退保留，下一轮才认得出上一轮标记过哪些问题，逐条判定已销账、仍存在还是
 * 新出现。finding id 只由口径与定位（权项号/特征号）派生，不含 anchor——锚点是模型
 * 每轮重新摘录的文本，措辞变动会让同一个问题在轮次间被误判成新问题。
 */

import { draftReviewGapId, type DraftReviewCategory, type DraftReviewDispute } from './types.ts'

/** 账本轮次记录的状态键；不在任何 outputSchema 中，故跨回退保留。 */
export const REVISION_LEDGER_ROUNDS_KEY = '_revision_ledger_rounds'

/**
 * 一条争议点的稳定 finding id。
 * @param dispute - 已构造的争议点。
 * @returns 形如 `draft-review:enablement:claim1` 的 id；定位优先权项号，其次特征号，都缺时按全篇。
 */
export function draftReviewFindingId(dispute: DraftReviewDispute): string {
  const locator = dispute.claimNumber !== undefined
    ? `claim${String(dispute.claimNumber)}`
    : dispute.featureId !== undefined
      ? `feat-${dispute.featureId}`
      : 'doc'
  return `${draftReviewGapId(dispute.category)}:${locator}`
}

/**
 * 一条 finding 的人可读定位（权项/特征/全篇）；与 finding id 同源派生。
 * @param dispute - 已构造的争议点。
 * @returns 定位文本。
 */
export function draftReviewFindingLocator(dispute: DraftReviewDispute): string {
  if (dispute.claimNumber !== undefined) return `权利要求 ${String(dispute.claimNumber)}`
  if (dispute.featureId !== undefined) return `特征 ${dispute.featureId}`
  return '全篇'
}

/** 一轮换位审查的账本记录：轮次序号与该轮可执行争议点。 */
export type DraftReviewLedgerRound = {
  /** 轮次序号（1 基），按 draft-review 实际执行顺序递增。 */
  round: number
  /** 该轮的可执行争议点（recommendation 非 none）。 */
  findings: DraftReviewDispute[]
}

/**
 * 安全读取已累积的轮次记录。
 * @param value - state 中 `_revision_ledger_rounds` 的原始值。
 * @returns 轮次数组；非数组时为空数组。
 */
export function readLedgerRounds(value: unknown): DraftReviewLedgerRound[] {
  return Array.isArray(value) ? (value as DraftReviewLedgerRound[]) : []
}

/**
 * 可执行争议点：过滤掉 recommendation 为 none 的条目。
 * @param disputes - 一轮审查的全部争议点。
 * @returns 需要上游改稿的争议点，顺序与输入一致。
 */
export function draftReviewActionableFindings(disputes: readonly DraftReviewDispute[]): DraftReviewDispute[] {
  return disputes.filter(dispute => dispute.recommendation !== 'none')
}

/** 单条 finding 的跨轮判定。 */
export type DraftReviewLedgerEntry = {
  /** 稳定 finding id。 */
  findingId: string
  /** 审查口径。 */
  category: DraftReviewCategory
  /** 法条或指南节号。 */
  provision: string
  /** 人可读定位。 */
  locator: string
  /** 首次标记的轮次。 */
  firstRound: number
  /** 最后一次标记的轮次。 */
  lastSeenRound: number
  /** 末轮是否仍标记着（true=未销账，false=已销账）。 */
  persisting: boolean
}

/** 跨轮对账汇总。 */
export type DraftReviewLedgerSummary = {
  /** 账本记录的轮次数。 */
  roundCount: number
  /** 末轮轮次序号（无记录时为 0）。 */
  lastRound: number
  /** 曾标记过的全部 finding 的判定，按首次出现顺序。 */
  entries: DraftReviewLedgerEntry[]
  /** 首轮标记、末轮已消失的条数。 */
  resolved: number
  /** 末轮仍在的条数。 */
  persisting: number
  /** 仅末轮新出现的条数（修订过程中冒出的新问题）。 */
  introduced: number
}

/**
 * 按稳定 finding id 折叠各轮记录，判定销账 / 未销账 / 新增。
 * @param rounds - draft-review 累积的轮次记录。
 * @returns 对账汇总；rounds 为空时 roundCount 与条目均为零。
 */
export function reconcileDraftReviewLedger(
  rounds: readonly DraftReviewLedgerRound[],
): DraftReviewLedgerSummary {
  const latest = rounds.at(-1)
  const lastRound = latest === undefined ? 0 : latest.round
  const byId = new Map<string, DraftReviewLedgerEntry>()
  for (const round of rounds) {
    for (const finding of round.findings) {
      const findingId = draftReviewFindingId(finding)
      const entry = byId.get(findingId)
      if (entry === undefined) {
        byId.set(findingId, {
          findingId,
          category: finding.category,
          provision: finding.provision,
          locator: draftReviewFindingLocator(finding),
          firstRound: round.round,
          lastSeenRound: round.round,
          persisting: round.round === lastRound,
        })
      } else {
        entry.lastSeenRound = round.round
        entry.persisting = round.round === lastRound
      }
    }
  }
  const entries = [...byId.values()]
  const persisting = entries.filter(entry => entry.persisting).length
  const introduced = entries.filter(entry => entry.persisting && entry.firstRound === lastRound).length
  return {
    roundCount: rounds.length,
    lastRound,
    entries,
    resolved: entries.length - persisting,
    persisting,
    introduced,
  }
}
