/**
 * `check_claim_figure_coverage`：核对权利要求的技术特征是否能在图面指认到附图标记。
 *
 * 输入是调用方给出的两列事实（特征文本、该特征对应的标号）与各图的标号清单，
 * 工具只算覆盖结论，不调用模型。补的是标号级检查够不到的一层：
 * `check_patent_figure_consistency` 回答「同一标号跨图是否同名」，
 * `validate_specification` 回答「标号在图与说明书之间是否对齐」，两者都不回答
 * 「权利要求里的某个技术特征能不能在图面指认到元素」。
 * @module @deepseek-ai/dsh-patent-tools/tool/check-claim-figure-coverage
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { PatentToolError } from '../error.ts'
import { checkClaimFigureCoverage } from '../figure/claim-figure-coverage.ts'
import type { ClaimFigureCoverageReport, FigureMarkEntry } from '../figure/claim-figure-coverage.ts'
import { MARK_COMPONENT_SCHEMA } from './internal/analysis-schemas.ts'

/** 输入：特征到标号的指认清单与各图标号清单。 */
export type CheckClaimFigureCoverageInput = {
  /** 权利要求技术特征与它对应的附图标记。 */
  bindings: readonly {
    /** 权利要求标识（如 `claim_1`）。 */
    claim_id: string
    /** 技术特征原文。 */
    feature: string
    /** 该特征在图面上的标号；至少一个。 */
    ref_numbers: readonly string[]
  }[]
  /** 各图的标号清单（`analyze_patent_figure` 的结果）。 */
  figures: readonly {
    figure_number: number
    components: readonly { ref_number: string; name?: string | undefined }[]
  }[]
}

const DESCRIPTION = '核对权利要求技术特征在图面的覆盖：bindings 逐条给出「权利要求标识 + 技术特征 + 该特征对应的附图标记」，figures 给出各图识别到的标号。工具检查 ① 是否有特征没指定任何标号；② 指定的标号是否真的出现在某张附图中。它不判断标号是否在语义上体现了该特征——那由人工确认；也不做特征拆分，特征由调用方逐条给出。纯确定性校验，不调用模型。全部指认且标号都在图面时返回 covered=true。'

/**
 * Build the `check_claim_figure_coverage` tool.
 * @returns a registry-ready tool definition.
 */
export function createCheckClaimFigureCoverageTool(): ToolDefinition {
  return defineTool({
    name: 'check_claim_figure_coverage',
    description: DESCRIPTION,
    parameters: {
      bindings: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            claim_id: { type: 'string', required: true, description: '权利要求标识（如 claim_1）' },
            feature: { type: 'string', required: true, description: '技术特征原文' },
            ref_numbers: {
              type: 'array',
              required: true,
              items: { type: 'string' },
              description: '该特征在图面上的附图标记（至少一个）',
            },
          },
        },
        description: '特征到标号的指认清单；至少一条',
      },
      figures: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            figure_number: { type: 'integer', required: true, description: '图号（1 起，同一案件内唯一）' },
            components: {
              type: 'array',
              required: true,
              items: MARK_COMPONENT_SCHEMA,
              description: '本图识别出的标号清单',
            },
          },
        },
        description: '各图的标号清单；至少一张，图号不得重复',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          boundFeatureCount: { type: 'integer', required: true },
          unboundFeatureCount: { type: 'integer', required: true },
          findings: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                check: {
                  type: 'string',
                  required: true,
                  enum: ['feature-empty', 'feature-unbound', 'ref-not-on-figure'],
                },
                claimId: { type: 'string', required: true },
                feature: { type: 'string', required: true },
                ref: { type: 'string' },
                message: { type: 'string', required: true },
              },
            },
          },
          summary: { type: 'string', required: true },
          covered: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => {
        const lines = [
          `权项要素图面覆盖：${String(value.boundFeatureCount)} 条已指认 / ${String(value.boundFeatureCount + value.unboundFeatureCount)} 条特征`,
          '',
          value.summary,
        ]
        const emptyLines = value.findings
          .filter(finding => finding.check === 'feature-empty')
          .map(finding => `- ${finding.message}`)
        const unboundLines = value.findings
          .filter(finding => finding.check === 'feature-unbound')
          .map(finding => `- ${finding.message}`)
        const missingLines = value.findings
          .filter(finding => finding.check === 'ref-not-on-figure')
          .map(finding => `- ${finding.message}`)
        const sections = [
          ...(emptyLines.length === 0 ? [] : ['', '## 空特征', ...emptyLines]),
          ...(unboundLines.length === 0 ? [] : ['', '## 未指定标号', ...unboundLines]),
          ...(missingLines.length === 0 ? [] : ['', '## 标号不在图面', ...missingLines]),
          ...(value.covered ? ['', '## 结论', '- 权项要素图面覆盖检查通过'] : []),
        ]
        return [{ type: 'text', text: [...lines, ...sections].join('\n') }]
      },
    },
    execute(args) {
      if (args.bindings.length === 0) {
        throw new PatentToolError('invalid_tool_input', 'bindings 至少需要一条技术特征', { tool: 'check_claim_figure_coverage' })
      }
      if (args.figures.length === 0) {
        throw new PatentToolError('invalid_tool_input', 'figures 至少需要一张附图', { tool: 'check_claim_figure_coverage' })
      }
      const seen = new Set<number>()
      for (const figure of args.figures) {
        if (!Number.isInteger(figure.figure_number) || figure.figure_number < 1) {
          throw new PatentToolError(
            'invalid_tool_input',
            `figure_number 必须是正整数：${String(figure.figure_number)}`,
            { tool: 'check_claim_figure_coverage' },
          )
        }
        if (seen.has(figure.figure_number)) {
          throw new PatentToolError(
            'invalid_tool_input',
            `figure_number 重复：${String(figure.figure_number)}——每张附图只能出现一次`,
            { tool: 'check_claim_figure_coverage' },
          )
        }
        seen.add(figure.figure_number)
      }

      const entries: FigureMarkEntry[] = args.figures.map(figure => ({
        figureNumber: figure.figure_number,
        components: figure.components.map(component => ({
          refNumber: component.ref_number,
          name: component.name ?? '',
        })),
      }))
      const report = checkClaimFigureCoverage(
        args.bindings.map(binding => ({
          claimId: binding.claim_id,
          feature: binding.feature,
          refNumbers: binding.ref_numbers,
        })),
        entries,
      )
      return Promise.resolve(toOutput(report))
    },
  })
}

/** 报告窄化为工具输出；可选字段只在存在时出现，避免空串冒充标号。 */
function toOutput(report: ClaimFigureCoverageReport): {
  boundFeatureCount: number
  unboundFeatureCount: number
  findings: ClaimFigureCoverageReport['findings']
  summary: string
  covered: boolean
} {
  return {
    boundFeatureCount: report.boundFeatureCount,
    unboundFeatureCount: report.unboundFeatureCount,
    findings: report.findings.map(finding => ({ ...finding })),
    summary: report.summary,
    covered: report.covered,
  }
}
