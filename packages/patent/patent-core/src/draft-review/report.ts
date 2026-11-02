/**
 * src/draft-review/report — 由同一组争议点同时产出报告、判定与回退信号。
 *
 * 报告与 `draft_review_passed` 只经 {@link buildDraftReviewResult} 构造：
 * 「报告存在、判定缺失」的组合没有构造路径，`legal-gaps` 不会把空判定读成通过。
 */

import type { RetrySignal } from '../workflow/types.ts'
import type { CheckedDispute } from './parse.ts'
import {
  DRAFT_REVIEW_CATEGORY_LABELS,
  draftReviewGapId,
  type DraftReviewDispute,
  type DraftReviewRecommendation,
  type DraftReviewResult,
} from './types.ts'

/** 建议动作的中文名称。 */
const RECOMMENDATION_LABELS: Readonly<Record<DraftReviewRecommendation, string>> = {
  'tighten-claim': '收紧权利要求',
  'add-embodiment': '补充实施例',
  'clarify-term': '澄清术语',
  'split-unity': '拆分单一性',
  none: '无需修改',
}

/** 把一条争议点的定位写成人可读文本。 */
function renderLocation(dispute: DraftReviewDispute, source: CheckedDispute['anchorSource']): string {
  const parts: string[] = []
  if (dispute.claimNumber !== undefined) parts.push(`权利要求 ${String(dispute.claimNumber)}`)
  if (dispute.featureId !== undefined) parts.push(`特征 ${dispute.featureId}`)
  if (parts.length === 0) parts.push('全篇')
  if (dispute.anchor !== undefined) {
    parts.push(source === 'claims' ? '锚点命中权利要求' : '锚点命中说明书')
  }
  return parts.join('；')
}

/**
 * 渲染争议点报告。
 * @param checked - 已复核锚点的争议点。
 * @param notes - 模型给出的补充说明；缺省为空串。
 * @returns 中文报告。
 */
export function renderDraftReviewReport(checked: readonly CheckedDispute[], notes: string): string {
  const actionable = checked.filter(item => item.dispute.recommendation !== 'none')
  const passed = actionable.length === 0
  const lines = [
    `撰写链换位审查：${passed ? '通过' : '未通过'}（争议点 ${String(checked.length)} 项，可执行 ${String(actionable.length)} 项）`,
  ]
  for (const item of checked) {
    const { dispute } = item
    lines.push(
      `- [${DRAFT_REVIEW_CATEGORY_LABELS[dispute.category]}] ${dispute.provision} — ${renderLocation(dispute, item.anchorSource)}：${RECOMMENDATION_LABELS[dispute.recommendation]}`,
    )
  }
  lines.push('说明：本报告来自模型换位审查，只列争议点与建议，不替代审查意见或人工复核。')
  if (notes !== '') lines.push(`审查说明：${notes}`)
  return lines.join('\n')
}

/**
 * 构造审查结果：报告、判定与结构化争议点一次产出。
 * @param checked - 已复核锚点的争议点。
 * @param notes - 模型给出的补充说明；缺省为空串。
 * @returns 完整业务输出。
 */
export function buildDraftReviewResult(
  checked: readonly CheckedDispute[],
  notes: string,
): DraftReviewResult {
  const disputes = checked.map(item => item.dispute)
  return {
    draft_review_report: renderDraftReviewReport(checked, notes),
    draft_review_passed: disputes.every(dispute => dispute.recommendation === 'none'),
    draft_review_disputes: disputes,
  }
}

/**
 * 把可执行争议点折叠成按类别去重的回退信号。
 *
 * 同一类别只发一个信号：回退会重做整段上游，按条重复只会在留痕里堆出重复记录。
 * @param disputes - 已构造的争议点。
 * @returns 回退信号；无实执行建议时为空数组。
 */
export function draftReviewRevisionSignals(
  disputes: readonly DraftReviewDispute[],
): RetrySignal[] {
  const signals: RetrySignal[] = []
  const seen = new Set<string>()
  for (const dispute of disputes) {
    if (dispute.recommendation === 'none') continue
    const gapId = draftReviewGapId(dispute.category)
    if (seen.has(gapId)) continue
    seen.add(gapId)
    const location = [
      dispute.claimNumber === undefined ? '' : `权利要求 ${String(dispute.claimNumber)}`,
      dispute.featureId === undefined ? '' : `特征 ${dispute.featureId}`,
    ].filter(part => part !== '').join('；')
    signals.push({
      gapId,
      rationale: `${dispute.provision} — ${DRAFT_REVIEW_CATEGORY_LABELS[dispute.category]}：${RECOMMENDATION_LABELS[dispute.recommendation]}`,
      evidence: location === '' ? 'draft_review_disputes' : location,
    })
  }
  return signals
}
