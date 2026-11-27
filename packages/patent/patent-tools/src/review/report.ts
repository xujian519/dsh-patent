/**
 * 评审报告的排序、编号与判定。
 *
 * 排序必须是全序：同一份输入两次评审得到同一组 `F` 编号。完全相同的并列项
 * 保留输入（引擎）顺序。
 * @module @deepseek-ai/dsh-patent-tools/review/report
 */

import type { EvaluatedText } from '../internal/evaluated-input.ts'
import type {
  ReviewFinding,
  ReviewReport,
  ReviewReportFinding,
  ReviewSeverity,
  ReviewSource,
} from './types.ts'

/** 严重度顺序：必须修改在前，未评估在后。 */
const SEVERITY_RANK: Readonly<Record<ReviewSeverity, number>> = { error: 0, warning: 1, info: 2 }

/** 来源顺序：权项形式在前，完整说明书检查其次，附图形式再次，范围说明最后。 */
const SOURCE_RANK: Readonly<Record<ReviewSource, number>> = {
  claim_lint: 0,
  claim_check: 1,
  spec_check: 2,
  figure_check: 3,
  review: 4,
}

/** 定位顺序：权项、附图、章节、全篇。 */
const LOCATOR_RANK: Readonly<Record<'claim' | 'figure' | 'section' | 'document', number>> = {
  claim: 0,
  figure: 1,
  section: 2,
  document: 3,
}

/**
 * 比较两个字符串，返回 `-1`/`0`/`1`。
 * @param left - 左值。
 * @param right - 右值。
 * @returns 字典序比较结果。
 */
function compareText(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/**
 * 取 finding 的权项号；非权项定位按 0。
 * @param finding - 待比较的 finding。
 * @returns 权项号或 0。
 */
function claimOf(finding: ReviewFinding): number {
  return finding.locator.kind === 'claim' ? finding.locator.claim : 0
}

/**
 * 取 finding 的图号；非附图定位按 0。
 * @param finding - 待比较的 finding。
 * @returns 图号或 0。
 */
function figureOf(finding: ReviewFinding): number {
  return finding.locator.kind === 'figure' ? finding.locator.figure : 0
}

/**
 * 取 finding 的章节名；非章节定位按空串。
 * @param finding - 待比较的 finding。
 * @returns 章节名或空串。
 */
function sectionOf(finding: ReviewFinding): string {
  return finding.locator.kind === 'section' ? finding.locator.section : ''
}

/**
 * 报告总序比较器。
 * @param left - 左 finding。
 * @param right - 右 finding。
 * @returns 负值表示 left 在前。
 */
export function compareReviewFindings(left: ReviewFinding, right: ReviewFinding): number {
  return SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]
    || SOURCE_RANK[left.source] - SOURCE_RANK[right.source]
    || LOCATOR_RANK[left.locator.kind] - LOCATOR_RANK[right.locator.kind]
    || claimOf(left) - claimOf(right)
    || figureOf(left) - figureOf(right)
    || compareText(sectionOf(left), sectionOf(right))
    || compareText(left.rule, right.rule)
    || compareText(left.message, right.message)
    || (left.line ?? -1) - (right.line ?? -1)
}

/**
 * 生成带 `F` 编号与判定的报告。
 * @param findings - 汇总层的 findings，顺序不限。
 * @param reviewed_scope - 本次实际评审的输入；两项都为 false 时 `passed` 为 false。
 * @param evaluated - 本次实际读到的文本与指纹。
 * @returns 按总序排列、编号并计数的报告。
 */
export function buildReviewReport(
  findings: readonly ReviewFinding[],
  reviewed_scope: ReviewReport['reviewed_scope'],
  evaluated: readonly EvaluatedText[],
): ReviewReport {
  const ordered = [...findings].sort(compareReviewFindings)
  const reportFindings: ReviewReportFinding[] = ordered.map((finding, index) => ({
    ...finding,
    id: `F${String(index + 1)}`,
  }))
  const counts = { error: 0, warning: 0, not_assessed: 0 }
  for (const finding of reportFindings) {
    if (finding.severity === 'info' || finding.not_assessed === true) {
      counts.not_assessed += 1
      continue
    }
    if (finding.severity === 'error') counts.error += 1
    else counts.warning += 1
  }
  const reviewed = reviewed_scope.claims || reviewed_scope.specification || reviewed_scope.figures
  return {
    passed: reviewed && counts.error === 0,
    findings: reportFindings,
    counts,
    reviewed_scope,
    evaluated: [...evaluated],
  }
}
