/**
 * `legal_knowledge_search` tool: query the deployment's legal knowledge base.
 *
 * Keeps the service free of model-facing surface: this module owns the schema
 * and result rendering, and consumes the four query methods through
 * `LegalKnowledgeQuery`.
 * @module @deepseek-ai/dsh-legal-knowledge/tool/search
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {
  CaseLawHit,
  GuidingCaseHit,
  JudicialInterpretationHit,
  LegalLevel,
  LegalRegulationHit,
} from '../types.ts'

/** Result families the tool can query. */
const LEGAL_KNOWLEDGE_SCOPES = [
  'case_law',
  'regulation',
  'judicial_interpretation',
  'guiding_case',
] as const

/** One query family. */
type LegalKnowledgeScope = (typeof LEGAL_KNOWLEDGE_SCOPES)[number]

/** Any hit the tool may return. */
type LegalKnowledgeHit = CaseLawHit | LegalRegulationHit | JudicialInterpretationHit | GuidingCaseHit

/** The slice of the service the tool consumes. */
type LegalKnowledgeQuery = {
  caseLawSearch: (
    query: string,
    options?: { limit?: number; docType?: 'judgment' | 'guiding'; court?: string; caseType?: string },
  ) => CaseLawHit[]
  legalSearch: (
    query: string,
    options?: { limit?: number; level?: LegalLevel; asOf?: string; includeUnverified?: boolean },
  ) => LegalRegulationHit[]
  judicialInterpretationSearch: (
    query: string,
    options?: {
      limit?: number
      interpretationType?: 'judicial-interpretation' | 'guiding-case'
      asOf?: string
      includeUnverified?: boolean
    },
  ) => JudicialInterpretationHit[]
  guidingCaseSearch: (query: string, limit?: number) => GuidingCaseHit[]
}

/** Tool output. */
export type LegalKnowledgeSearchOutput = {
  /** Queried family. */
  scope: LegalKnowledgeScope
  /** The query text that ran. */
  query: string
  /** Number of hits returned. */
  count: number
  /** Matching records, ranked by the backend. */
  hits: LegalKnowledgeHit[]
  /** One-paragraph result summary, including the empty-result meaning. */
  summary: string
}

/** Thrown when the tool input cannot be used as a query. */
class LegalKnowledgeSearchToolError extends Error {
  /** Stable failure identifier. */
  readonly code: string

  /**
   * @param code - stable failure identifier.
   * @param message - what is wrong with the input.
   */
  constructor(code: string, message: string) {
    super(message)
    this.name = 'LegalKnowledgeSearchToolError'
    this.code = code
  }
}

/** Default result cap. */
const DEFAULT_LEGAL_KNOWLEDGE_LIMIT = 5

/** Maximum result cap. */
const MAX_LEGAL_KNOWLEDGE_LIMIT = 20

const SCOPE_LABELS: Record<LegalKnowledgeScope, string> = {
  case_law: '案例',
  regulation: '法规条文',
  judicial_interpretation: '司法解释',
  guiding_case: '指导性案例',
}

const DESCRIPTION = [
  '- 检索本部署的法律知识库，覆盖法规条文、裁判文书、司法解释与指导性案例四类记录。',
  '- 法规与司法解释结果带 `validity`（in-force/expired/not-yet-effective/unverified），可用 `asOf` 按指定日期判断有效性。',
  '- 检索结果是部署数据：空结果表示本部署的知识库未命中，不证明该规范或案例不存在；引用前仍需回到官方法源核验原文。',
  '- `via` 说明命中通道（fts 全文、like 降级匹配、memory 内存记录）；`relevanceScore` 越小越相关。',
  '',
  'Usage notes:',
  '  - 先用法条检索确定现行有效条文，再用案例检索补充适用方式；不要颠倒。',
  '  - 逐条引用时同时给出条目 id（regulationId/caseId/interpretationId）与条文或案号。',
  '  - 单次最多返回 20 条；需要更多时缩小查询范围，而不是重复同一查询。',
].join('\n')

/**
 * Create the `legal_knowledge_search` tool.
 * @param knowledge - the legal-knowledge service or an equivalent query surface.
 * @returns the tool definition.
 */
export function createLegalKnowledgeSearchTool(knowledge: LegalKnowledgeQuery): ToolDefinition {
  return defineTool({
    name: 'legal_knowledge_search',
    description: DESCRIPTION,
    parameters: {
      query: { type: 'string', description: '检索关键词或短语', required: true },
      scope: {
        type: 'string',
        description: '检索的记录类别（默认 regulation）',
        enum: [...LEGAL_KNOWLEDGE_SCOPES],
      },
      limit: {
        type: 'number',
        description: `返回条数上限（1-${MAX_LEGAL_KNOWLEDGE_LIMIT}，默认 ${DEFAULT_LEGAL_KNOWLEDGE_LIMIT}）`,
      },
      asOf: { type: 'string', description: '有效性判断日期 YYYY-MM-DD（仅法规与司法解释）' },
      level: {
        type: 'string',
        description: '法规层级过滤（仅 regulation）',
        enum: ['法律', '行政法规', '司法解释', '地方性法规', '部门规章', '其他'],
      },
      docType: {
        type: 'string',
        description: '文书类型过滤（仅 case_law）',
        enum: ['judgment', 'guiding'],
      },
      court: { type: 'string', description: '法院名称片段（仅 case_law）' },
      caseType: { type: 'string', description: '案件类型片段（仅 case_law）' },
      interpretationType: {
        type: 'string',
        description: '司法解释类型过滤（仅 judicial_interpretation）',
        enum: ['judicial-interpretation', 'guiding-case'],
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: { type: 'string' },
          query: { type: 'string' },
          count: { type: 'number' },
          hits: {
            type: 'array',
            items: { type: 'object', additionalProperties: true },
          },
          summary: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: (value as LegalKnowledgeSearchOutput).summary,
      }],
    },
    execute: (input): Promise<LegalKnowledgeSearchOutput> => {
      const query = input.query.trim()
      if (query.length === 0) {
        throw new LegalKnowledgeSearchToolError('empty-query', 'query 不能为空')
      }
      const scope = input.scope ?? 'regulation'
      const limit = input.limit === undefined
        ? DEFAULT_LEGAL_KNOWLEDGE_LIMIT
        : Math.min(MAX_LEGAL_KNOWLEDGE_LIMIT, Math.max(1, Math.trunc(input.limit)))
      const asOf = input.asOf !== undefined && input.asOf.trim().length > 0 ? input.asOf.trim() : undefined

      const hits = searchScope(knowledge, scope, query, limit, {
        ...(asOf !== undefined ? { asOf } : {}),
        ...(input.level !== undefined ? { level: input.level } : {}),
        ...(input.docType !== undefined ? { docType: input.docType } : {}),
        ...(input.court !== undefined ? { court: input.court } : {}),
        ...(input.caseType !== undefined ? { caseType: input.caseType } : {}),
        ...(input.interpretationType !== undefined ? { interpretationType: input.interpretationType } : {}),
      })

      return Promise.resolve({
        scope,
        query,
        count: hits.length,
        hits,
        summary: renderSummary(scope, query, hits.length),
      })
    },
  })
}

/** Options shared by the two dated scopes. */
type SearchFilters = {
  asOf?: string
  level?: LegalLevel
  docType?: 'judgment' | 'guiding'
  court?: string
  caseType?: string
  interpretationType?: 'judicial-interpretation' | 'guiding-case'
}

/** Dispatch one query to the selected family. */
function searchScope(
  knowledge: LegalKnowledgeQuery,
  scope: LegalKnowledgeScope,
  query: string,
  limit: number,
  filters: SearchFilters,
): LegalKnowledgeHit[] {
  switch (scope) {
    case 'case_law':
      return knowledge.caseLawSearch(query, {
        limit,
        ...(filters.docType !== undefined ? { docType: filters.docType } : {}),
        ...(filters.court !== undefined ? { court: filters.court } : {}),
        ...(filters.caseType !== undefined ? { caseType: filters.caseType } : {}),
      })
    case 'regulation':
      return knowledge.legalSearch(query, {
        limit,
        ...(filters.level !== undefined ? { level: filters.level } : {}),
        ...(filters.asOf !== undefined ? { asOf: filters.asOf } : {}),
      })
    case 'judicial_interpretation':
      return knowledge.judicialInterpretationSearch(query, {
        limit,
        ...(filters.interpretationType !== undefined ? { interpretationType: filters.interpretationType } : {}),
        ...(filters.asOf !== undefined ? { asOf: filters.asOf } : {}),
      })
    case 'guiding_case':
      return knowledge.guidingCaseSearch(query, limit)
  }
}

/** Render the result summary. */
function renderSummary(scope: LegalKnowledgeScope, query: string, count: number): string {
  const label = SCOPE_LABELS[scope]
  if (count === 0) {
    return `知识库未检索到${label}（查询：${query}）。空结果只说明本部署没有命中，不能据此认定该规范或案例不存在；请换用官方法源继续核验。`
  }
  return `知识库检索到 ${count} 条${label}（查询：${query}）。引用前请核对条目 id、条文或案号，并回到官方法源确认原文与现行有效性。`
}
