/**
 * `claim_lint` tool: deterministic formal self-check of a claim set — numbering,
 * reference direction, multiple-dependent form, antecedent basis, subject names,
 * two-part form, wording, punctuation, and non-claim content.
 *
 * The rules live in @deepseek-ai/dsh-patent-core (`claim-lint/`) and call no
 * model, so the same text always yields the same report. Structural rules are
 * deterministic; wording rules are vocabulary heuristics — a hit means the
 * drafting needs a human read, not that the claim is defective.
 * @module @deepseek-ai/dsh-patent-tools/tool/claim-lint
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { lintClaimText, type ClaimLintFinding, type ClaimLintReport } from '@deepseek-ai/dsh-patent-core'
import { requireNonBlankText } from './internal/tool-input.ts'

/** One finding as the tool reports it; document-level findings omit `claim`. */
export type ClaimLintFindingOutput = {
  /** Stable rule id (numbering, antecedent-basis, functional-limitation, …). */
  rule: string
  /** Claim number; absent for whole-document findings. */
  claim?: number
  /** error blocks the draft; warning needs a human read. */
  severity: 'error' | 'warning'
  /** What is wrong and how to fix it. */
  message: string
  /** The offending text. */
  evidence: string
  /** Statute and examination-guideline clause the rule enforces. */
  basis: string
}

/** Output of the claim_lint tool. */
export type ClaimLintOutput = {
  /** True when no error-level finding was reported. */
  passed: boolean
  /** Number of claims parsed. */
  claim_count: number
  /** Number of error-level findings. */
  error_count: number
  /** Number of warning-level findings. */
  warning_count: number
  /** Findings in detection order. */
  findings: ClaimLintFindingOutput[]
}

const DESCRIPTION = [
  '确定性检查权利要求书的撰写形式（不调用模型），逐条给出《专利法》/《专利法实施细则》/《专利审查指南》依据：',
  '编号连续、引用方向（从权只能引用在先权项）、多项从属（择一引用、不得作为另一项多项从属的引用基础）、',
  '引用基础（「所述X」须在本项或所引权项中在先引入）、从权主题名称与所引用权项一致、从权须有附加技术特征的限定部分、',
  '独权的前序部分+特征部分、功能性/效果性限定、工艺方法特征、方法权要列举步骤而未声明顺序是否构成限定、不产生技术效果的内容、商业性宣传用语、',
  '引用说明书或附图的用语、每项仅一个结尾句号、正文之外不得有标题/表格/说明行。',
  '结构化规则是确定性的；用语类规则是词表启发式，命中不等于违规，须人工复核。',
  '通过的判据是零 error，出现 warning 时仍需逐条确认。',
].join('')

/**
 * Map one core finding to the tool's JSON-safe field set.
 * @param finding - the finding reported by the core linter.
 * @returns the finding with a document-level claim omitted.
 */
function toFindingOutput(finding: ClaimLintFinding): ClaimLintFindingOutput {
  return {
    rule: finding.rule,
    ...(finding.claim === null ? {} : { claim: finding.claim }),
    severity: finding.severity,
    message: finding.message,
    evidence: finding.evidence,
    basis: finding.basis,
  }
}

/**
 * Convert the core report into the declared output value.
 * @param report - the core lint report.
 * @returns the tool output.
 */
function toOutput(report: ClaimLintReport): ClaimLintOutput {
  return {
    passed: report.passed,
    claim_count: report.claims.length,
    error_count: report.errorCount,
    warning_count: report.warningCount,
    findings: report.findings.map(toFindingOutput),
  }
}

/**
 * Render one finding line, tagging its claim scope.
 * @param finding - the finding to render.
 * @returns one line for the model.
 */
function renderFinding(finding: ClaimLintFindingOutput): string {
  const scope = finding.claim === undefined ? '权利要求书全文' : `权利要求 ${finding.claim}`
  return `- [${finding.severity}] ${scope}｜${finding.rule}：${finding.message}（命中：${finding.evidence}）`
}

/** Render the canonical lint value into model-facing prose. */
function renderClaimLint(value: ClaimLintOutput): string {
  const header = `claim_lint: 权利要求书形式自检（确定性纯函数，未调用模型）：${value.claim_count} 项，${value.error_count} 项 error、${value.warning_count} 项 warning，${value.passed ? '通过' : '未通过'}。`
  if (value.findings.length === 0) return `${header}\n未发现问题。`
  const errors = value.findings.filter(finding => finding.severity === 'error')
  const warnings = value.findings.filter(finding => finding.severity === 'warning')
  return [
    header,
    ...(errors.length > 0 ? ['## 必须修改（error）', ...errors.map(renderFinding)] : []),
    ...(warnings.length > 0 ? ['## 需要复核（warning）', ...warnings.map(renderFinding)] : []),
  ].join('\n')
}

/**
 * Build the `claim_lint` tool.
 * @returns a registry-ready tool definition.
 */
export function createClaimLintTool(): ToolDefinition {
  return defineTool({
    name: 'claim_lint',
    description: DESCRIPTION,
    parameters: {
      text: { type: 'string', required: true, description: '权利要求书全文（markdown 或纯文本，含各项编号）。' },
      max_claims: { type: 'number', description: '撰写约束的权项数上限（可选）；超出时报 warning。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          passed: { type: 'boolean', required: true },
          claim_count: { type: 'number', required: true },
          error_count: { type: 'number', required: true },
          warning_count: { type: 'number', required: true },
          findings: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                rule: { type: 'string', required: true },
                claim: { type: 'number' },
                severity: { type: 'string', required: true, enum: ['error', 'warning'] },
                message: { type: 'string', required: true },
                evidence: { type: 'string', required: true },
                basis: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderClaimLint(value) }],
    },
    execute: (args) => {
      requireNonBlankText(args.text, 'claim_lint', 'text 为空（须为权利要求书全文）')
      const report = lintClaimText(args.text, args.max_claims === undefined ? {} : { maxClaims: args.max_claims })
      return Promise.resolve(toOutput(report))
    },
  })
}
