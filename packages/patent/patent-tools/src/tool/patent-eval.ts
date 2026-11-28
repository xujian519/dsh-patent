/**
 * `patent_eval` tool: deterministic patent-work-product quality evaluation
 * (report / retrieval / workflow / citations / comprehensive). The evaluator and
 * its anti-slop dimension live in `@deepseek-ai/dsh-patent-core` (`quality/`) so
 * the patent-teams worker-output gate can score content without depending on the
 * model-tool package; this module owns the model-facing tool definition.
 * @module @deepseek-ai/dsh-patent-tools/tool/patent-eval
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { evaluatePatentContent } from '@deepseek-ai/dsh-patent-core'
import type { PatentEvalMode } from '@deepseek-ai/dsh-patent-core'
import { recordEntries, recordFlag, recordNumberOr, recordString } from './internal/json-read.ts'
import { toJsonValue } from './internal/json-value.ts'

export { ABSOLUTE_PHRASES, evaluatePatentContent } from '@deepseek-ai/dsh-patent-core'
export type { PatentEvalDimension, PatentEvalMode, PatentEvalOutput } from '@deepseek-ai/dsh-patent-core'

/** Input for the patent_eval tool. */
export type PatentEvalInput = {
  /** Evaluation mode: report / retrieval / workflow / citations / comprehensive. */
  mode: PatentEvalMode
  /** Content to evaluate (report body / keyword list / workflow steps / citation list). */
  content?: string
  /** Statute citations that must be present (e.g. ["第二十二条第二款", "第二十二条第三款"]). */
  required_citations?: string[]
}

const DESCRIPTION = '评估专利相关产出的质量（报告/检索/流程/引用/综合）。返回结构化评分和通过/失败判定。支持 5 种评估模式（report/retrieval/workflow/citations/comprehensive），在提交人工复核前使用可提前发现质量问题。'

/** Render the canonical evaluation value into model-facing prose. */
function renderEval(value: { summary: string; details: unknown }): string {
  const parts = [value.summary]
  for (const [key, dim] of recordEntries(value.details)) {
    const extra = recordString(dim, 'details')
    parts.push(`  ${recordFlag(dim, 'passed') ? '✅' : '❌'} ${key}: ${recordNumberOr(dim, 'score', 0).toFixed(2)}${extra ? `（${extra}）` : ''}`)
  }
  return parts.join('\n')
}

/**
 * Build the `patent_eval` tool (pure, no dependencies).
 * @returns a registry-ready tool definition.
 */
export function createPatentEvalTool(): ToolDefinition {
  return defineTool({
    name: 'patent_eval',
    description: DESCRIPTION,
    parameters: {
      mode: { type: 'string', required: true, enum: ['report', 'retrieval', 'workflow', 'citations', 'comprehensive'], description: '评估模式: report(分析报告质量) / retrieval(检索式形态) / workflow(流程完整性) / citations(引用合规性) / comprehensive(全面评估)' },
      content: { type: 'string', description: '待评估的内容文本（报告正文/检索关键词列表/工作流步骤/引文列表等）' },
      required_citations: { type: 'array', items: { type: 'string' }, description: '要求必须包含的法条引用列表（如 ["第二十二条第二款", "第二十二条第三款"]）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', required: true },
          score: { type: 'number', required: true },
          passed: { type: 'boolean', required: true },
          details: { type: 'json', required: true },
          summary: { type: 'string', required: true },
          searchStrategy: { type: 'json' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderEval(value) }],
    },
    // oxlint-disable-next-line typescript/require-await -- tool contract requires async execute
    async execute(args) {
      const out = evaluatePatentContent(args.mode, args.content ?? '', args.required_citations ?? [])
      return {
        mode: out.mode,
        score: out.score,
        passed: out.passed,
        details: out.details,
        summary: out.summary,
        ...(out.searchStrategy !== undefined ? { searchStrategy: toJsonValue(out.searchStrategy) } : {}),
      }
    },
  })
}
