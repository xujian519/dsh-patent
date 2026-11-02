/**
 * `draft_claims` tool: deterministic claim drafting over the pure engine in
 * `@deepseek-ai/dsh-patent-core/claim-draft`.
 *
 * This module owns only the model-facing schema and Markdown projection; the
 * feature table → claim-text rules live in the core engine so the workflow's
 * `draft-claims` atom and this tool cannot drift.
 * @module @deepseek-ai/dsh-patent-tools/tool/draft-claims
 */

import {
  ClaimDraftError,
  PARENT_SCHEMA,
  draftClaims,
  renderParents,
  type DraftClaimsOutput,
} from '@deepseek-ai/dsh-patent-core'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { PatentToolError } from '../error.ts'
import { WARNINGS_SCHEMA, warningSection } from './internal/tool-output.ts'

export { DOMAIN_KEYWORDS, draftClaims, validateClaims } from '@deepseek-ai/dsh-patent-core'
export type {
  ClaimViolation,
  DependentClaimNode,
  DraftClaimsInput,
  DraftClaimsOutput,
  DraftedClaim,
  PatentType,
  TechDomain,
} from '@deepseek-ai/dsh-patent-core'

const DESCRIPTION = '根据技术交底书或技术方案撰写权利要求书草案（机械/电学/化学/软件四领域）。当用户要求撰写权利要求、写权利要求书时使用，避免自行手写权利要求文本。输出独立权利要求 + 从属权利要求 + 形式校验报告。'

/**
 * Render the canonical draft into model-facing Markdown.
 * @param value - the claim draft to render.
 * @returns the rendered Markdown.
 */
export function renderDraftClaims(value: DraftClaimsOutput): string {
  const lines = [
    `# 权利要求书草案（${value.invention_name}）`,
    `技术领域: ${value.tech_domain}`,
    '',
    ...value.claims.map(c => `${c.number}. [${c.type}]${c.refersTo !== undefined ? `（引用 ${renderParents(c.refersTo, ' 或 ')}）` : ''} ${c.text}`),
  ]
  if (value.violations.length > 0) {
    lines.push('', '## 形式校验违规', ...value.violations.map(v => `- [${v.severity}] ${v.rule}${v.claimNumber !== undefined ? `（权${v.claimNumber}）` : ''}: ${v.message}${v.suggestion ? ` → ${v.suggestion}` : ''}`))
  }
  lines.push(...warningSection(value.warnings))
  return lines.join('\n')
}

const CLAIM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    number: { type: 'integer', required: true },
    type: { type: 'string', required: true, enum: ['independent', 'dependent'] },
    text: { type: 'string', required: true },
    refersTo: PARENT_SCHEMA,
    featureId: { type: 'string' },
  },
} as const

const DEPENDENT_NODE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    number: { type: 'integer', required: true, description: '从属权利要求编号（2 起）' },
    parent: { ...PARENT_SCHEMA, required: true, description: '引用的在先权利要求编号；数组表示择一引用（渲染为「权利要求 1 或 2」）' },
    text: { type: 'string', required: true, description: '本条从属权利要求增加的附加技术特征' },
    feature_id: { type: 'string', description: '特征表中的特征编号，用于把成文回映射到策略表' },
  },
} as const

const VIOLATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    rule: { type: 'string', required: true },
    severity: { type: 'string', required: true, enum: ['error', 'warning'] },
    claimNumber: { type: 'integer' },
    message: { type: 'string', required: true },
    suggestion: { type: 'string' },
  },
} as const

/**
 * Build the `draft_claims` tool (pure, no dependencies).
 * @returns a registry-ready tool definition.
 */
export function createDraftClaimsTool(): ToolDefinition {
  return defineTool({
    name: 'draft_claims',
    description: DESCRIPTION,
    parameters: {
      invention_name: { type: 'string', required: true, description: '发明名称' },
      tech_domain: { type: 'string', enum: ['mechanical', 'electrical', 'chemical', 'software', 'general'], description: '技术领域（为空时自动识别）' },
      technical_features: { type: 'array', required: true, items: { type: 'string' }, description: '必要技术特征列表（用于独立权利要求）' },
      optional_features: { type: 'array', items: { type: 'string' }, description: '附加/可选技术特征列表：渲染为逐条引用前一条的线性从权链。与 dependent_tree 互斥' },
      dependent_tree: {
        type: 'array',
        items: DEPENDENT_NODE_SCHEMA,
        description: '显式从权树：每个从权给出编号、父项（数字或数字数组）与附加特征，支持多路引用。与 optional_features 互斥',
      },
      prior_art: { type: 'string', description: '最接近现有技术描述（可选，用于前序部分）' },
      max_claims: { type: 'integer', description: '本次撰写指令给定的权利要求项数上限（可选）。超过上限判 error——指令给定的上限是验收条件，不得以申请附加费起征线为由放宽' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          invention_name: { type: 'string', required: true },
          tech_domain: { type: 'string', required: true, enum: ['mechanical', 'electrical', 'chemical', 'software', 'general'] },
          claims: { type: 'array', required: true, items: CLAIM_SCHEMA },
          violations: { type: 'array', required: true, items: VIOLATION_SCHEMA },
          warnings: WARNINGS_SCHEMA,
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderDraftClaims(value) }],
    },
    // oxlint-disable-next-line typescript/require-await -- tool contract requires async execute
    async execute(args) {
      try {
        return draftClaims(args)
      } catch (error) {
        // The core engine rejects mutually exclusive inputs; the tool keeps its
        // `invalid_tool_input` vocabulary for callers and the tool catalog.
        if (error instanceof ClaimDraftError) {
          throw new PatentToolError('invalid_tool_input', error.message, { tool: 'draft_claims' })
        }
        throw error
      }
    },
  })
}
