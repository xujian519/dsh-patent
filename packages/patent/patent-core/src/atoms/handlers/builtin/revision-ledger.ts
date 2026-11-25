/**
 * 修订域原子：revision-ledger（修订逐条对账，纯函数）。
 *
 * 读 draft-review 每轮追加的账本记录（`_revision_ledger_rounds`，跨回退保留），
 * 把各轮可执行争议点按稳定 finding id 折叠，逐条判定已销账、仍存在还是修订过程
 * 中新出现。首轮审查没有对账对象，报告为首轮基线。本原子只读账本，不重新调用
 * 审查模型，也不发出回退信号——回退由 draft-review 自己的类别级信号决定。
 */

import { type Atom } from '../../atom.ts'
import { type PipelineState, type StageExecuteInput, type StageHandler } from '../../handler.ts'
import {
  REVISION_LEDGER_ROUNDS_KEY,
  readLedgerRounds,
  reconcileDraftReviewLedger,
  type DraftReviewLedgerEntry,
  type DraftReviewLedgerSummary,
} from '../../../draft-review/index.ts'

/** revision-ledger 原子：修订轮次的逐条销账对账。 */
export const revisionLedgerAtom: Atom = {
  name: 'revision-ledger',
  description: '修订逐条对账：按稳定 finding id 折叠 draft-review 各轮争议点，输出已销账/仍存在/新增的条目与计数（纯函数，不调用模型）',
  category: 'gate',
  inputSchema: [REVISION_LEDGER_ROUNDS_KEY],
  outputSchema: ['revision_ledger_summary', 'revision_ledger_report', 'revision_ledger_reconciliation'],
}

/**
 * 组装对账结论文本。
 *
 * 本原子不发回退信号，文本不参与 `whenOutputMatches` 判定，因此不受
 * 「信号词须在首个句界前」约束；首行仍是总计数，方便日志一眼读。
 * 清账与否按末轮仍存在的条数判，不按曾标记条数判：全部销账就是已清账。
 * @param summary - 折叠后的对账汇总。
 * @returns 面向模型与日志的对账结论。
 */
function summarize(summary: DraftReviewLedgerSummary): string {
  const flagged = summary.entries.length
  if (flagged === 0) {
    return `修订对账通过（${summary.roundCount} 轮审查）：draft-review 未留下可执行争议点，无待销账条目。`
  }
  if (summary.persisting === 0) {
    return `修订对账通过（${summary.roundCount} 轮审查）：曾标记 ${flagged} 项已全部销账。`
  }
  const parts: string[] = [`共 ${flagged} 项曾标记`, `已销账 ${summary.resolved} 项`, `仍存在 ${summary.persisting} 项`]
  if (summary.introduced > 0) parts.push(`其中修订过程新增 ${summary.introduced} 项`)
  return `修订对账未清账（${summary.roundCount} 轮审查）：${parts.join('，')}。`
}

/** 渲染单条 finding 的对账行。 */
function renderEntry(entry: DraftReviewLedgerEntry): string {
  const status = entry.persisting
    ? `仍存在（第 ${entry.firstRound} 轮标记，末轮仍未解决）`
    : `已销账（第 ${entry.firstRound} 轮标记，第 ${entry.lastSeenRound} 轮后未再出现）`
  return `- ${entry.findingId}（${entry.provision}，${entry.locator}）：${status}`
}

/**
 * 渲染逐条对账报告。
 * @param summary - 折叠后的对账汇总。
 * @returns 中文报告；首轮无记录时给出说明。
 */
function renderLedgerReport(summary: DraftReviewLedgerSummary): string {
  const lines: string[] = []
  if (summary.roundCount === 0) {
    return '修订对账：无 draft-review 轮次记录，未执行修订闭环。'
  }
  lines.push(`修订对账（${summary.roundCount} 轮审查）：`)
  lines.push(summarize(summary))
  if (summary.entries.length === 0) {
    lines.push('- 首轮审查即通过，无争议点需要销账。')
    return lines.join('\n')
  }
  for (const entry of summary.entries) {
    lines.push(renderEntry(entry))
  }
  lines.push('说明：定位（权项/特征）相同视为同一条问题；锚点措辞变化不影响销账判定。')
  return lines.join('\n')
}

/** revision-ledger 执行器：折叠账本并输出对账报告与结构化明细。 */
export class RevisionLedgerHandler implements StageHandler {
  readonly name = 'revision-ledger'
  readonly category = 'gate' as const

  /**
   * 对账 draft-review 的各轮争议点。
   * @param input - 阶段执行输入（state 携带 `_revision_ledger_rounds`）。
   * @returns `revision_ledger_summary`、`revision_ledger_report` 与结构化明细，或降级片段。
   */
  // oxlint-disable-next-line typescript/require-await -- StageHandler contract requires async execute
  async execute(input: StageExecuteInput): Promise<PipelineState> {
    const rounds = readLedgerRounds(input.state[REVISION_LEDGER_ROUNDS_KEY])
    const summary = reconcileDraftReviewLedger(rounds)
    return {
      revision_ledger_summary: summarize(summary),
      revision_ledger_report: renderLedgerReport(summary),
      revision_ledger_reconciliation: summary,
    }
  }
}
