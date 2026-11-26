/**
 * `review_patent_application` 工具：把权利要求形式检查与说明书合规检查汇总成一份
 * 带定位、原文与法条依据的评审报告。
 *
 * 工具只做输入归一化、调用汇总层、排序编号与渲染；规则本身由 `claim_lint` 与
 * `validate_specification` 决定，本工具不新增规则。
 * @module @deepseek-ai/dsh-patent-tools/tool/review-patent-application
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { PatentType, TechDomain } from '@deepseek-ai/dsh-patent-core'
import { PatentToolError } from '../error.ts'
import { EVALUATED_TEXT_SCHEMA, renderEvaluatedTexts } from '../internal/evaluated-input.ts'
import { aggregateReviewFindings } from '../review/aggregate.ts'
import { buildReviewReport } from '../review/report.ts'
import type {
  ReviewReport,
  ReviewReportFindingView,
  ReviewReportView,
} from '../review/types.ts'

/** `review_patent_application` 的入参。 */
export type ReviewPatentApplicationInput = {
  /** 权利要求书全文。与 `specification` 至少提供一项。 */
  claims?: string
  /** 说明书全文。与 `claims` 至少提供一项。 */
  specification?: string
  /** 摘要。 */
  abstract?: string
  /** 发明名称。 */
  title?: string
  /** 专利类型；缺省时按发明检查并给出 warning。 */
  patent_type?: PatentType
  /** 是否有附图；缺省时由说明书文本推断。 */
  has_drawings?: boolean
  /** 技术领域；`chemical`/`software` 启用领域规则。 */
  tech_domain?: TechDomain
  /** 声明的附图数量。 */
  drawing_count?: number
  /** 请求书中的摘要附图号。 */
  abstract_figure_number?: number
  /** 权利要求项数上限；超出时报 `claim-count`。 */
  max_claims?: number
}

/** `review_patent_application` 的规范输出。 */
export type ReviewPatentApplicationOutput = ReviewReport

/** 工具名；报告范围说明与错误上下文共用。 */
const TOOL_NAME = 'review_patent_application'

/**
 * 渲染一条 finding 的模型可读行。
 * @param finding - 带编号的 finding。
 * @returns 问题行，以及可选的命中原文与修改建议行。
 */
function renderFinding(finding: ReviewReportFindingView): string[] {
  const where = finding.locator.kind === 'claim'
    ? `权利要求 ${String(finding.locator.claim ?? 0)}`
    : finding.locator.kind === 'section' ? `说明书·${finding.locator.section ?? ''}` : '全篇'
  const basis = finding.basis === undefined ? '' : `（依据：${finding.basis}）`
  const lines = [`- [${finding.id}] ${where}｜${finding.rule}：${finding.message}${basis}`]
  if (finding.evidence !== undefined) lines.push(`  命中：${finding.evidence}`)
  if (finding.suggestion !== undefined) lines.push(`  → 建议：${finding.suggestion}`)
  return lines
}

/**
 * 把评审报告渲染为模型可读的 Markdown。
 * @param value - 评审报告。
 * @returns 结论行、分组 findings 与输入指纹。
 */
export function renderReviewReport(value: ReviewReportView): string {
  const scope = [
    value.reviewed_scope.claims ? '权利要求' : '',
    value.reviewed_scope.specification ? '说明书' : '',
  ].filter(part => part !== '').join('+')
  const header = `申请文件评审：${value.passed ? '通过（未发现 error）' : '未通过'}`
    + `（error ${String(value.counts.error)}、warning ${String(value.counts.warning)}；`
    + `未评估 ${String(value.counts.not_assessed)} 项；已评审 ${scope}）`
  const sections: Array<[string, ReviewReportFindingView[]]> = [
    ['## 必须修改（error）', value.findings.filter(finding => finding.severity === 'error')],
    ['## 需要复核（warning）', value.findings.filter(finding => finding.severity === 'warning')],
    ['## 未评估（信息）', value.findings.filter(finding => finding.severity === 'info')],
  ]
  const lines = [header]
  for (const [title, findings] of sections) {
    lines.push(title)
    if (findings.length === 0) {
      lines.push('- 无')
      continue
    }
    for (const finding of findings) lines.push(...renderFinding(finding))
  }
  const evaluated = renderEvaluatedTexts(value.evaluated)
  if (evaluated !== '') lines.push('', evaluated)
  return lines.join('\n')
}

/**
 * 构建 `review_patent_application` 工具。
 * @returns 可注册的工具定义。
 */
export function createReviewPatentApplicationTool(): ToolDefinition {
  return defineTool({
    name: TOOL_NAME,
    description: [
      '按专利法/实施细则/审查指南的形式口径，对一份专利申请文件跑确定性评审（不调用模型）。',
      '- 权利要求：claim_lint 的编号、引用方向、多项从属、引用基础、主题名称、两部分式、功能性/工艺限定、结尾标点等；',
      '- 说明书与摘要：validate_specification 的五部分结构、标题集合、附图引用形式、名称/摘要长度、禁止性内容、模糊表述、实施例、数值范围与领域规则等；',
      '- 两者都给时同时跑权项—说明书特征覆盖（A26.4）。',
      '至少提供 claims 或 specification 之一；只给一半时，报告用未评估项声明另一半未评审，不会把它读成通过。',
      '每条 finding 带报告内唯一的 F 编号、定位、命中原文与法条依据；passed 只表示已运行的确定性规则未发现 error，不表示符合专利法；未评估项单列。',
      '结果末尾给出实际读到的文本字数与指纹，便于另一次评审对照是否读的是同一份文本。',
    ].join(''),
    parameters: {
      claims: { type: 'string', description: '权利要求书全文（可选，但与 specification 至少提供一项）。' },
      specification: { type: 'string', description: '说明书全文（可选，但与 claims 至少提供一项）。' },
      abstract: { type: 'string', description: '摘要（可选）；提供时检查篇幅、关键词、附图号与宣传语。' },
      title: { type: 'string', description: '发明名称（可选）；提供时检查长度与禁用词。' },
      patent_type: {
        type: 'string',
        enum: ['invention', 'utility_model'],
        description: '专利类型；缺省时按发明检查并给出 warning。',
      },
      has_drawings: { type: 'boolean', description: '是否有附图；缺省时由说明书文本推断。' },
      tech_domain: {
        type: 'string',
        enum: ['mechanical', 'electrical', 'chemical', 'software', 'general'],
        description: '技术领域；chemical/software 启用对应领域规则。',
      },
      drawing_count: { type: 'number', description: '声明的附图数量（可选），与附图说明条目数比对。' },
      abstract_figure_number: { type: 'number', description: '请求书中的摘要附图号（可选）。' },
      max_claims: { type: 'number', description: '权利要求项数上限（可选）；超出时报 claim-count。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          passed: { type: 'boolean', required: true },
          counts: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              error: { type: 'number', required: true },
              warning: { type: 'number', required: true },
              not_assessed: { type: 'number', required: true },
            },
          },
          reviewed_scope: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              claims: { type: 'boolean', required: true },
              specification: { type: 'boolean', required: true },
            },
          },
          findings: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                source: {
                  type: 'string',
                  required: true,
                  enum: ['claim_lint', 'claim_check', 'spec_check', 'review'],
                },
                rule: { type: 'string', required: true },
                severity: { type: 'string', required: true, enum: ['error', 'warning', 'info'] },
                not_assessed: { type: 'boolean' },
                message: { type: 'string', required: true },
                suggestion: { type: 'string' },
                locator: {
                  type: 'object',
                  additionalProperties: false,
                  required: true,
                  properties: {
                    kind: { type: 'string', required: true, enum: ['claim', 'section', 'document'] },
                    claim: { type: 'number' },
                    section: { type: 'string' },
                  },
                },
                evidence: { type: 'string' },
                basis: { type: 'string' },
                line: { type: 'number' },
              },
            },
          },
          evaluated: { type: 'array', required: true, items: EVALUATED_TEXT_SCHEMA },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderReviewReport(value) }],
    },
    execute: (args) => {
      const claims = args.claims
      const specification = args.specification
      const hasClaims = claims !== undefined && claims.trim().length > 0
      const hasSpecification = specification !== undefined && specification.trim().length > 0
      if (!hasClaims && !hasSpecification) {
        throw new PatentToolError(
          'invalid_tool_input',
          '至少提供 claims 或 specification；两者都为空时无法评审',
          { tool: TOOL_NAME },
        )
      }
      const aggregated = aggregateReviewFindings({
        ...(claims === undefined ? {} : { claims }),
        ...(specification === undefined ? {} : { specification }),
        ...(args.abstract === undefined ? {} : { abstract: args.abstract }),
        ...(args.title === undefined ? {} : { title: args.title }),
        ...(args.patent_type === undefined ? {} : { patentType: args.patent_type }),
        ...(args.has_drawings === undefined ? {} : { hasDrawings: args.has_drawings }),
        ...(args.tech_domain === undefined ? {} : { techDomain: args.tech_domain }),
        ...(args.drawing_count === undefined ? {} : { drawingCount: args.drawing_count }),
        ...(args.abstract_figure_number === undefined
          ? {}
          : { abstractFigureNumber: args.abstract_figure_number }),
        ...(args.max_claims === undefined ? {} : { maxClaims: args.max_claims }),
      })
      return Promise.resolve(
        buildReviewReport(aggregated.findings, aggregated.reviewed_scope, aggregated.evaluated),
      )
    },
  })
}
