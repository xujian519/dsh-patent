/**
 * `parse_office_action` tool: deterministic parsing of an office action
 * (审查意见通知书) — rejection types, cited references with relevance, affected
 * claims, examiner arguments. The parser lives in
 * @deepseek-ai/dsh-patent-core (`notice/office-action.ts`) and calls no model,
 * so the result is reproducible on the same text.
 *
 * The tool reports the notice's own wording only. It does not decide whether a
 * rejection is well founded and does not draft a response; unmarked references
 * carry no relevance class rather than a default one, and conflicting
 * annotations on the same reference become explicit parse conflicts instead of
 * silently picking one.
 * @module @deepseek-ai/dsh-patent-tools/tool/parse-office-action
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { numberList, recordList, recordString, recordText, recordValue } from './internal/json-read.ts'
import { toJsonValue } from './internal/json-value.ts'
import {
  formatOfficeActionSummary,
  parseOfficeAction,
} from '@deepseek-ai/dsh-patent-core'
import { requireNonBlankText } from './internal/tool-input.ts'

/** Input for the parse_office_action tool. */
export type ParseOfficeActionInput = {
  /** The office action text to parse. */
  text: string
}

/** Output of the parse_office_action tool. */
export type ParseOfficeActionOutput = {
  /** Structured result (ParsedOfficeAction, JSON-safe). */
  parsed: JsonValue
  /** Chinese summary of the parsed facts. */
  summary: string
}

const DESCRIPTION = [
  '确定性解析审查意见通知书（不调用模型）：识别驳回类型（专利法 22.2 新颖性、22.3 创造性、26.3 公开不充分、26.4 不清楚或不支持、33 条修改超范围、形式缺陷；',
  '未识别到具体条款时为 other）、引用文献与相关性类别（X/Y/A/E/P，本文书自身号码不计）、',
  '涉及的权利要求（权利要求1至3 与 第1-5项 两类区间展开为逐个编号）、审查员论点。',
  '用于答复前先拿到结构化事实：先按主驳回类型定答复主策略，再逐条处理。',
  '输出只反映通知书原文的措辞，不判断驳回是否成立，也不起草答复。文献未标注相关性类别时不推断类别。',
  '同一文献在正文不同位置的相关性标注不一致时，结果列入解析冲突（冲突源、候选值、采用依据），不静默取单一结论，须人工核对。',
].join('')

/**
 * Render a cited reference line with the claims its sentence mentions.
 * @param reference - the parsed citation.
 * @returns one line, with the co-occurrence caveat made explicit.
 */
function renderCitation(reference: unknown): string {
  const relevancy = recordString(reference, 'relevancy')
  const relevancyText = relevancy === undefined ? '未标注' : `${relevancy} 类`
  const claims = numberList(recordValue(reference, 'claimsAffected'))
  const claimText = claims.length > 0 ? claims.join(', ') : '无'
  return `- ${recordText(reference, 'documentNumber')}（${relevancyText}）→ 同句提到的权项: ${claimText}`
}

/** Render the canonical parse value into model-facing prose. */
function renderParseOfficeAction(value: { parsed: unknown; summary: string }): string {
  const citations = recordList(value.parsed, 'citations')
  const citationLines = citations.length > 0
    ? ['## 引用文献逐条（权项为同句共现，非权威对应）', ...citations.map(renderCitation)]
    : []
  return [
    'parse_office_action: 审查意见通知书解析（确定性纯函数，未调用模型）',
    value.summary,
    ...citationLines,
  ].join('\n')
}

/**
 * Build the `parse_office_action` tool.
 * @returns a registry-ready tool definition.
 */
export function createParseOfficeActionTool(): ToolDefinition {
  return defineTool({
    name: 'parse_office_action',
    description: DESCRIPTION,
    parameters: {
      text: { type: 'string', required: true, description: '审查意见通知书正文（含驳回条款与引用文献的原文）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          parsed: { type: 'json', required: true },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderParseOfficeAction(value) }],
    },
    // oxlint-disable-next-line typescript/require-await -- tool contract requires async execute
    async execute(args) {
      requireNonBlankText(args.text, 'parse_office_action', 'text 为空（须为审查意见通知书正文）')
      const parsed = parseOfficeAction(args.text)
      return { parsed: toJsonValue(parsed), summary: formatOfficeActionSummary(parsed) }
    },
  })
}
