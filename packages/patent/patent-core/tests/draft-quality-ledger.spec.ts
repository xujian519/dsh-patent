import { describe, expect, it } from 'vitest'
import {
  DRAFT_QUALITY_SIGNALS,
  reconcileDraftQuality,
  renderDraftQualityHeadline,
  renderDraftQualityReport,
  revisionLedgerVerdict,
} from '../src/quality/ledger.ts'
import { DraftQualityLedgerHandler, draftQualityLedgerAtom } from '../src/atoms/handlers/builtin/draft-quality-ledger.ts'

/** 五门全部通过的 state。 */
function allPassed(): Record<string, unknown> {
  return {
    spec_check_passed: true,
    enablement_passed: true,
    claim_breadth_passed: true,
    revision_ledger_reconciliation: { roundCount: 2, persisting: 0 },
    legal_gaps_passed: true,
  }
}

describe('draft-quality-ledger 判定折叠', () => {
  it('目录固定五行，标量键与之一致', () => {
    expect(DRAFT_QUALITY_SIGNALS.map(signal => signal.key)).toEqual([
      'spec_check_passed',
      'enablement_passed',
      'claim_breadth_passed',
      'revision_ledger_cleared',
      'legal_gaps_passed',
    ])
  })

  it('空 state 全部未评估，标量为 0 且不算全过', () => {
    const summary = reconcileDraftQuality({})
    expect(summary).toMatchObject({ passed: 0, failed: 0, unassessed: 5, assessed: 0, score: 0, passedAll: false })
  })

  it('五门全过：标量 100，passedAll 为真', () => {
    const summary = reconcileDraftQuality(allPassed())
    expect(summary).toMatchObject({ passed: 5, failed: 0, unassessed: 0, score: 100, passedAll: true })
  })

  it('布尔信号缺失与类型不符分别给出原因', () => {
    const missing = reconcileDraftQuality(allPassed()).verdicts[0]
    expect(missing?.status).toBe('passed')
    const summary = reconcileDraftQuality({ ...allPassed(), spec_check_passed: 'yes' })
    const row = summary.verdicts.find(verdict => verdict.key === 'spec_check_passed')
    expect(row).toMatchObject({ status: 'unassessed', reason: '信号类型不是布尔（string）' })
  })

  it('未过行与已判定行参与标量：通过/已判定取整', () => {
    const summary = reconcileDraftQuality({ ...allPassed(), claim_breadth_passed: false, legal_gaps_passed: undefined })
    expect(summary).toMatchObject({ passed: 3, failed: 1, unassessed: 1, assessed: 4, passedAll: false })
    expect(summary.score).toBe(75)
  })

  it('修订账本行：缺键、非对象、字段畸形、零轮各有判词', () => {
    expect(revisionLedgerVerdict({})).toMatchObject({ status: 'unassessed', reason: '账本缺失：revision-ledger 阶段未运行或已降级' })
    expect(revisionLedgerVerdict({ revision_ledger_reconciliation: 'corrupted' })).toMatchObject({
      status: 'unassessed', reason: '账本缺失：revision-ledger 阶段未运行或已降级',
    })
    // null 的 typeof 也是 'object'：必须显式排除，否则读取字段会抛 TypeError。
    expect(revisionLedgerVerdict({ revision_ledger_reconciliation: null })).toMatchObject({
      status: 'unassessed', reason: '账本缺失：revision-ledger 阶段未运行或已降级',
    })
    expect(revisionLedgerVerdict({ revision_ledger_reconciliation: { persisting: 'x' } })).toMatchObject({
      status: 'unassessed', reason: '账本字段类型不符（persisting/roundCount 非数值）',
    })
    expect(revisionLedgerVerdict({ revision_ledger_reconciliation: { roundCount: 0, persisting: 0 } })).toMatchObject({
      status: 'unassessed', reason: '无审查轮次记录：draft-review 未执行修订闭环',
    })
    expect(revisionLedgerVerdict({ revision_ledger_reconciliation: { roundCount: 2, persisting: 1 } }).status).toBe('failed')
  })
})

describe('draft-quality-ledger 报告渲染', () => {
  it('无信号时首行说明全部未评估', () => {
    const summary = reconcileDraftQuality({})
    expect(renderDraftQualityHeadline(summary)).toBe('稿件质量标量 0/100（已判定 0/5 项）：无可用质量信号，全部未评估。')
  })

  it('首行按通过/未过/未评估给出结论', () => {
    expect(renderDraftQualityHeadline(reconcileDraftQuality(allPassed())))
      .toBe('稿件质量标量 100/100（已判定 5/5 项）：通过 5 项，全部通过。')
    expect(renderDraftQualityHeadline(reconcileDraftQuality({ ...allPassed(), enablement_passed: false })))
      .toContain('未过 1 项')
    expect(renderDraftQualityHeadline(reconcileDraftQuality({ ...allPassed(), legal_gaps_passed: undefined })))
      .toContain('未评估 1 项')
  })

  it('报告逐条列出行标签，未评估行带原因', () => {
    const state = { ...allPassed(), claim_breadth_passed: undefined }
    const report = renderDraftQualityReport(state, reconcileDraftQuality(state))
    expect(report).toContain('- 说明书/权利要求形式合规（A26.3/A26.4（spec-check））：✅ 通过')
    expect(report).toContain('- 上位概括锚点支撑（A26.4（claim-breadth））：◻️ 未评估——信号缺失：上游阶段未运行或已降级')
    expect(report).toContain('未评估行需人工复核或在报告里明示，不得当作通过')
  })

  it('外部传入的未评估行无原因时给兼容判词', () => {
    const report = renderDraftQualityReport({}, {
      verdicts: [{ key: 'spec_check_passed', label: '形式合规', provision: 'A26.3', status: 'unassessed' }],
      passed: 0,
      failed: 0,
      unassessed: 1,
      assessed: 0,
      score: 0,
      passedAll: false,
    })
    expect(report).toContain('- 形式合规（A26.3）：◻️ 未评估——未挂接任何质量信号')
  })

  it('反套话分作信息行：在场显示数值，缺席说明缺失', () => {
    const withScore = renderDraftQualityReport({ ...allPassed(), slop_score: 42 }, reconcileDraftQuality(allPassed()))
    expect(withScore).toContain('信息行不计入标量）：42')
    const without = renderDraftQualityReport(allPassed(), reconcileDraftQuality(allPassed()))
    expect(without).toContain('信息行不计入标量）：◻️ 未评估——`slop_score` 缺失')
  })
})

describe('draft-quality-ledger 原子契约与执行', () => {
  it('契约：gate 类、不调用模型、输入输出键固定', () => {
    expect(draftQualityLedgerAtom.category).toBe('gate')
    expect(draftQualityLedgerAtom.usesModel).toBeUndefined()
    expect(draftQualityLedgerAtom.inputSchema).toEqual([
      'spec_check_passed',
      'enablement_passed',
      'claim_breadth_passed',
      'revision_ledger_reconciliation',
      'legal_gaps_passed',
      'slop_score',
    ])
    expect(draftQualityLedgerAtom.outputSchema).toEqual([
      'draft_quality_summary',
      'draft_quality_report',
      'draft_quality_matrix',
    ])
  })

  it('缺信号不降级：照常输出矩阵与标量', async () => {
    const out = await new DraftQualityLedgerHandler().execute({ state: {} })
    expect(out._error).toBeUndefined()
    expect(out.draft_quality_summary).toContain('无可用质量信号')
    expect(out.draft_quality_matrix).toMatchObject({ unassessed: 5, score: 0 })
  })

  it('全过 state 输出 100 分矩阵', async () => {
    const out = await new DraftQualityLedgerHandler().execute({ state: allPassed() })
    expect(out.draft_quality_summary).toContain('100/100')
    expect(out.draft_quality_report).toContain('稿件质量账本（确定性汇总，不调用模型）')
    expect(out.draft_quality_matrix).toMatchObject({ passedAll: true })
  })
})
