/**
 * 质量域原子：draft-quality-ledger（稿件质量账本，纯函数）。
 *
 * 按固定目录折叠 spec-check、enablement-report、claim-breadth、revision-ledger、
 * legal-gaps 已写入 state 的判定，合成逐条矩阵与 0–100 标量；`slop_score` 只作
 * 信息行（通过线归 slop-gate 所有）。缺信号判未评估并写明原因，不并入通过。
 * 本原子不调用模型，也不发出回退信号——各门的回退归各自的阶段所有者。
 */

import { type Atom } from '../../atom.ts'
import { type PipelineState, type StageExecuteInput, type StageHandler } from '../../handler.ts'
import { reconcileDraftQuality, renderDraftQualityHeadline, renderDraftQualityReport } from '../../../quality/index.ts'

/** draft-quality-ledger 原子：下游门判定的确定性合成。 */
export const draftQualityLedgerAtom: Atom = {
  name: 'draft-quality-ledger',
  description: '稿件质量账本：折叠形式合规、充分公开、概括支撑、修订销账、法条缺口五门判定为逐条矩阵与 0–100 标量，反套话分作信息行（纯函数，不调用模型）',
  category: 'gate',
  inputSchema: [
    'spec_check_passed',
    'enablement_passed',
    'claim_breadth_passed',
    'revision_ledger_reconciliation',
    'legal_gaps_passed',
    'slop_score',
  ],
  outputSchema: ['draft_quality_summary', 'draft_quality_report', 'draft_quality_matrix'],
}

/** draft-quality-ledger 执行器：折叠质量信号并输出矩阵、标量与报告。 */
export class DraftQualityLedgerHandler implements StageHandler {
  readonly name = 'draft-quality-ledger'
  readonly category = 'gate' as const

  /**
   * 合成稿件质量账本。
   * @param input - 阶段执行输入（state 携带各门判定键；缺键判未评估，不降级）。
   * @returns `draft_quality_summary`（首行结论）、`draft_quality_report` 与结构化矩阵。
   */
  // oxlint-disable-next-line typescript/require-await -- StageHandler contract requires async execute
  async execute(input: StageExecuteInput): Promise<PipelineState> {
    const summary = reconcileDraftQuality(input.state)
    return {
      draft_quality_summary: renderDraftQualityHeadline(summary),
      draft_quality_report: renderDraftQualityReport(input.state, summary),
      draft_quality_matrix: summary,
    }
  }
}
