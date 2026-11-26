/**
 * 专利申请文件评审的统一 findings 契约。
 *
 * 契约只描述一条缺陷是什么、落在哪里、依据是什么，不决定报告顺序或编号；
 * 排序、`F` 编号与判定归各自的消费者（`review_patent_application`、`domain_check`）。
 * @module @deepseek-ai/dsh-patent-tools/review/types
 */

import type { EvaluatedText } from '../internal/evaluated-input.ts'

/**
 * 产生该 finding 的检查器入口。
 *
 * - `claim_lint`：权利要求形式自检。
 * - `claim_check`：只跑 `checkClaimViolations`（没有说明书可做覆盖比对）。
 * - `spec_check`：完整的 `validateSpecification`（可能含 `claims` 族的覆盖/单一性记录）。
 * - `review`：评审层自己的范围说明（例如某一半输入未提供）。
 */
export type ReviewSource = 'claim_lint' | 'claim_check' | 'spec_check' | 'review'

/**
 * 一条 finding 的严重度。
 *
 * `error` 表示确定性规则发现必须修改；`warning` 需要人工复核；
 * `info` 只用于未评估项，不计入 error/warning。
 */
export type ReviewSeverity = 'error' | 'warning' | 'info'

/** finding 的定位：具体权项、说明书章节，或全篇。 */
export type ReviewLocator =
  | { kind: 'claim'; claim: number }
  | { kind: 'section'; section: string }
  | { kind: 'document' }

/**
 * 定位在工具 JSON 上的扁平形状。
 *
 * `defineTool` 从 schema 推断出的 `render` 入参是扁平对象；报告契约保留判别联合，
 * 两者在结构上互相可赋值（联合成员都满足扁平形状）。
 */
export type ReviewLocatorView = {
  /** 定位种类。 */
  kind: 'claim' | 'section' | 'document'
  /** 权项号；`kind` 为 `claim` 时提供。 */
  claim?: number
  /** 说明书章节名；`kind` 为 `section` 时提供。 */
  section?: string
}

/**
 * 一条统一的评审发现。
 *
 * 报告内唯一标识由消费者赋的 `id` 承担；finding 本身不带跨运行稳定的键。
 */
export type ReviewFinding = {
  /** 产生该 finding 的检查器入口。 */
  source: ReviewSource
  /** 规则标识。 */
  rule: string
  /** 严重度。 */
  severity: ReviewSeverity
  /** 规则因缺少输入未能判定；true 时不计入 error/warning。 */
  not_assessed?: boolean
  /** 面向模型与代理师的问题说明。 */
  message: string
  /** 可执行的修改方向；来源没有给出时省略。 */
  suggestion?: string
  /** 缺陷位置。 */
  locator: ReviewLocator
  /** 原文片段：`claim_lint` 的 evidence，或 `validate_specification` 的 matchedSentence。 */
  evidence?: string
  /** 规范依据：`claim_lint` 的 basis。 */
  basis?: string
  /** 1-based 行号；只有部分 `validate_specification` 规则提供。 */
  line?: number
}

/** 报告中的一条 finding：带报告内唯一的 `F` 编号。 */
export type ReviewReportFinding = ReviewFinding & {
  /** 报告内唯一编号，按报告的总序从 `F1` 起。 */
  id: string
}

/** 报告 finding 在工具 JSON 上的扁平形状。 */
export type ReviewReportFindingView = Omit<ReviewReportFinding, 'locator'> & {
  /** 扁平定位。 */
  locator: ReviewLocatorView
}

/** 一次申请文件评审的完整结果。 */
export type ReviewReport = {
  /** 没有 error 且至少评审了一个输入。 */
  passed: boolean
  /** 按报告总序排列的 findings。 */
  findings: ReviewReportFinding[]
  /** error/warning/未评估项计数；未评估项不计入前两者。 */
  counts: { error: number; warning: number; not_assessed: number }
  /** 本次实际评审的输入。 */
  reviewed_scope: { claims: boolean; specification: boolean }
  /** 本次实际读到的文本与指纹，供另一次评审对照是否读的是同一份文本。 */
  evaluated: EvaluatedText[]
}

/** 报告在工具 JSON 上的扁平形状，供 `render` 入参使用。 */
export type ReviewReportView = Omit<ReviewReport, 'findings'> & {
  /** 扁平定位后的 findings。 */
  findings: ReviewReportFindingView[]
}
