/**
 * `check_patent_figure_consistency`：对同一案件的多张附图做跨图一致性校验。
 *
 * 输入是 `analyze_patent_figure` 已识别的标记清单，因此本工具不调用模型、结果可
 * 复现：同一数字标记在不同图中必须指同一部件、图号必须从 1 起连续、权利要求或
 * 说明书引用的标记必须在某张图中出现。电学符号与网表不在校验范围（电学分析
 * 引擎尚未移植）。
 * @module @deepseek-ai/dsh-patent-tools/tool/check-patent-figure-consistency
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { checkFigureSetConsistency } from '../figure/figure-set-consistency.ts'
import type { FigureSetEntry, FigureSetReport } from '../figure/figure-set-consistency.ts'
import { REPORT_TAIL_FIELDS } from './internal/analysis-schemas.ts'
import { figureMarkListParameter, requireFigureList, toFigureMarkEntries } from './internal/figure-mark-list.ts'
import { reportSection, textReport } from './internal/tool-output.ts'

/** 输入：各图的标记清单与可选的引用正文。 */
export type CheckPatentFigureConsistencyInput = {
  /** 各图的标记清单（图号 + 该图识别出的标记与名称）。 */
  figures: readonly {
    figure_number: number
    components: readonly { ref_number: string; name?: string | undefined }[]
  }[]
  /** 权利要求书或说明书正文；给出时核对其中引用的标记是否都在图中出现。 */
  claim_context?: string | undefined
}

const DESCRIPTION = '校验同一案件多张附图的跨图一致性：把 analyze_patent_figure 对每张图的识别结果放进 figures（图号 + 标记号/名称），检查 ① 同一数字标记在不同图中名称是否一致（如 10 在图1 是「壳体」、在图2 变成「底座」即报冲突）；② 图号是否从 1 起连续（缺号逐项列出）；③ 给出 claim_context（权利要求书或说明书正文）时，其中引用的数字标记（括号形「(10)」、直连形「壳体10」）是否都在某张图中识别到。纯确定性校验，不调用模型；电学符号与网表不在范围。一致时返回 consistent=true 与空警告，否则逐条给出可修正的警告。'

/** 输出条目共用的图号字段。 */
const FIGURE_NUMBER_FIELD = { type: 'integer', required: true } as const

/** 数字标记输出条目共用的编号与名称字段。 */
const MARK_FIELDS = {
  refNumber: { type: 'string', required: true },
  name: { type: 'string', required: true },
} as const

/**
 * Build the `check_patent_figure_consistency` tool.
 * @returns a registry-ready tool definition.
 */
export function createCheckPatentFigureConsistencyTool(): ToolDefinition {
  return defineTool({
    name: 'check_patent_figure_consistency',
    description: DESCRIPTION,
    parameters: {
      figures: figureMarkListParameter(
        '本图识别出的组件列表（analyze_patent_figure 的结果）',
        '各图的标记清单；至少一张，图号不得重复',
      ),
      claim_context: {
        type: 'string',
        description: '权利要求书或说明书正文（可选）：给出时核对其中引用的数字标记是否都在附图中识别到',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          figureCount: { type: 'integer', required: true },
          numericComponents: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                ...MARK_FIELDS,
                figureNumbers: { type: 'array', required: true, items: { type: 'integer' } },
              },
            },
          },
          conflicts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', required: true, enum: ['name'] },
                ref: { type: 'string', required: true },
                figureNumbers: { type: 'array', required: true, items: { type: 'integer' } },
                values: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      figureNumber: FIGURE_NUMBER_FIELD,
                      value: { type: 'string', required: true },
                    },
                  },
                },
                message: { type: 'string', required: true },
              },
            },
          },
          missingFigureNumbers: { type: 'array', required: true, items: { type: 'integer' } },
          missingRefs: { type: 'array', required: true, items: { type: 'integer' } },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
          ...REPORT_TAIL_FIELDS,
        },
      },
      render: (_args, value) => {
        const lines = [`跨图一致性检查：${String(value.figureCount)} 张附图`, '', value.summary]
        const conflictLines = value.conflicts.map(conflict => `- ${conflict.message}`)
        const missingNumberLines = value.missingFigureNumbers.map(number => `- 缺图号 ${String(number)}`)
        const missingRefLines = value.missingRefs.map(ref => `- 标记 ${String(ref)} 在权利要求/说明书中出现，但任何附图都未识别`)
        const sections = [
          ...reportSection('跨图冲突', conflictLines),
          ...reportSection('缺失图号', missingNumberLines),
          ...reportSection('未识别标记', missingRefLines),
          ...reportSection('结论', value.consistent ? ['- 跨图一致性检查通过'] : []),
        ]
        return textReport(lines, sections)
      },
    },
    execute(args) {
      requireFigureList(args.figures, 'check_patent_figure_consistency')
      const entries: FigureSetEntry[] = toFigureMarkEntries(args.figures)
      const report = checkFigureSetConsistency(entries, args.claim_context)
      return Promise.resolve(toOutput(report))
    },
  })
}

/** 报告窄化为工具输出：标记索引按数字升序排列，便于模型逐条核对。 */
function toOutput(report: FigureSetReport): {
  figureCount: number
  numericComponents: { refNumber: string; name: string; figureNumbers: number[] }[]
  conflicts: FigureSetReport['conflicts']
  missingFigureNumbers: number[]
  missingRefs: number[]
  warnings: string[]
  summary: string
  consistent: boolean
} {
  const numericComponents = Object.entries(report.numericComponents)
    .map(([refNumber, value]) => ({ refNumber, name: value.name, figureNumbers: [...value.figureNumbers] }))
    .sort((left, right) => Number(left.refNumber) - Number(right.refNumber))
  return {
    figureCount: report.figureCount,
    numericComponents,
    conflicts: report.conflicts.map(conflict => ({ ...conflict })),
    missingFigureNumbers: [...report.missingFigureNumbers],
    missingRefs: [...report.missingRefs],
    warnings: [...report.warnings],
    summary: report.summary,
    consistent: report.consistent,
  }
}
