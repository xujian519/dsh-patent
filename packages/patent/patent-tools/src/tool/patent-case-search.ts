/**
 * `patent_case_search` tool: full-text patent case-law search over the external
 * knowledge.db (documents/chunks/docs_fts, FTS5 BM25 first). Ported from Sati's
 * patentCaseSearch.ts. The semantic (embedding) recall path is not ported — dsh
 * ships keyword/FTS only (see the P1.3 package scope).
 * @module @deepseek-ai/dsh-patent-tools/tool/patent-case-search
 */

import { existsSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { CaseLawDocType, CaseLawHit, CaseLawSearchOptions } from '@deepseek-ai/dsh-patent-knowledge'
import type { SearchStrategy } from '@deepseek-ai/dsh-patent-core'
import { PatentToolError } from '../error.ts'
import { knowledgeInstallGuidance, truncateSnippet } from './internal/knowledge.ts'
import { resolveResultLimit } from './internal/query-limit.ts'

/** Input for the patent_case_search tool. */
export type PatentCaseSearchInput = {
  /** Search keywords (e.g. 创造性 三步法, 技术启示, 区别特征 预料不到的效果). */
  query: string
  /** Document-kind filter: case=invalidation decision, judgment=patent ruling. */
  doc_type?: CaseLawDocType
  /** Court substring filter (e.g. 最高人民法院; applies to judgment rows). */
  court?: string
  /** Result cap (default 5, max 10). */
  limit?: number
  /** Attach hit snippets (default true, truncated to ~800 chars). */
  include_content?: boolean
}

/** Output of the patent_case_search tool. */
export type PatentCaseSearchOutput = {
  total: number
  results: Array<{
    documentId: string
    docType: string
    title: string
    decisionNumber?: string
    caseNumber?: string
    court?: string
    source?: string
    charCount: number
    snippet?: string
    ftsRank?: number
    via: 'fts' | 'like'
  }>
  dbPath?: string
  /** 标准化检索策略记录。 */
  searchStrategy: SearchStrategy
}

/** Injected case-law search (tests override; production wires ctx.patentKnowledge.caseLawSearch). */
export type PatentCaseSearchDeps = {
  search?: (query: string, options?: CaseLawSearchOptions) => CaseLawHit[]
  /** Resolved knowledge.db path, used for the setup-required check and surfaced as the output's `dbPath` field. */
  dbPath?: string
}

const INSTALL_GUIDANCE = knowledgeInstallGuidance('判例库')

function toResult(hit: CaseLawHit, includeContent: boolean): PatentCaseSearchOutput['results'][number] {
  return {
    documentId: hit.documentId,
    docType: hit.docType,
    title: hit.title,
    ...(hit.decisionNumber !== undefined ? { decisionNumber: hit.decisionNumber } : {}),
    ...(hit.caseNumber !== undefined ? { caseNumber: hit.caseNumber } : {}),
    ...(hit.court !== undefined ? { court: hit.court } : {}),
    ...(hit.source !== undefined ? { source: hit.source } : {}),
    charCount: hit.charCount,
    ...(includeContent ? { snippet: truncateSnippet(hit.snippet) } : {}),
    ...(hit.ftsRank !== undefined && hit.ftsRank !== null ? { ftsRank: hit.ftsRank } : {}),
    via: hit.via,
  }
}

const DESCRIPTION = '检索本地专利判例全文（无效复审决定/专利判决，knowledge.db，FTS5 BM25 优先）。用于无效宣告分析、OA 答复时检索相似在先决定的理由论证与证据认定。支持 doc_type（case=无效决定/judgment=判决）与 court（法院）过滤。默认排除 wiki 审查标准卡片（审查标准请用 patent_wiki_search）。'

/** Render the canonical case-search value into model-facing prose. */
function renderCaseSearch(value: PatentCaseSearchOutput): string {
  const header = [`**patent_case_search** — ${value.results.length} result(s):`]
  const s = value.searchStrategy
  let line = `检索式：${s.query}`
  /* v8 ignore next -- this tool never writes an IPC field into its search strategy */
  if (s.ipc !== undefined && s.ipc.length > 0) line += `（IPC ${s.ipc.join('、')}）`
  header.push(line)
  if (value.results.length === 0) {
    return [...header, '', '0 条判例命中。'].join('\n')
  }
  const rows = value.results.map((r) => {
    const lines = [`## ${r.title}`]
    lines.push(`**documentId**: ${r.documentId} · ${r.docType} · via ${r.via}`)
    if (r.decisionNumber) lines.push(`**decision**: ${r.decisionNumber}`)
    if (r.caseNumber) lines.push(`**case**: ${r.caseNumber}`)
    if (r.court) lines.push(`**court**: ${r.court}`)
    if (r.source) lines.push(`**source**: ${r.source}`)
    if (r.snippet) lines.push(r.snippet)
    return lines.join('\n')
  })
  return [...header, '', rows.join('\n\n---\n\n')].join('\n')
}

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    documentId: { type: 'string', required: true },
    docType: { type: 'string', required: true },
    title: { type: 'string', required: true },
    decisionNumber: { type: 'string' },
    caseNumber: { type: 'string' },
    court: { type: 'string' },
    source: { type: 'string' },
    charCount: { type: 'integer', required: true },
    snippet: { type: 'string' },
    ftsRank: { type: 'number' },
    via: { type: 'string', required: true, enum: ['fts', 'like'] },
  },
} as const

/**
 * Build the `patent_case_search` tool over an injectable case-law search function.
 * @param deps - the case-law search function plus the resolved knowledge.db path.
 * @returns a registry-ready tool definition.
 */
export function createPatentCaseSearchTool(deps: PatentCaseSearchDeps): ToolDefinition {
  return defineTool({
    name: 'patent_case_search',
    description: DESCRIPTION,
    parameters: {
      query: { type: 'string', required: true, description: '检索关键词（如 创造性 三步法、技术启示、区别特征 预料不到的效果）' },
      doc_type: { type: 'string', enum: ['case', 'judgment'], description: '文档类型过滤：case=无效复审决定，judgment=专利判决（缺省全部）' },
      court: { type: 'string', description: '审理法院过滤（子串匹配，如 最高人民法院）' },
      limit: { type: 'number', description: '返回条数上限（默认 5，最大 10）' },
      include_content: { type: 'boolean', description: '是否附命中片段（默认 true，截断约 800 字）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          results: { type: 'array', required: true, items: RESULT_SCHEMA },
          dbPath: { type: 'string' },
          searchStrategy: { type: 'json', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderCaseSearch(value as unknown as PatentCaseSearchOutput) }],
    },
    // oxlint-disable-next-line typescript/require-await -- tool contract requires async execute
    async execute(args) {
      if (deps.search === undefined) {
        throw new PatentToolError('setup_required', INSTALL_GUIDANCE, { tool: 'patent_case_search' })
      }
      if (deps.dbPath !== undefined && !existsSync(deps.dbPath)) {
        throw new PatentToolError('setup_required', INSTALL_GUIDANCE, { tool: 'patent_case_search' })
      }
      const limit = resolveResultLimit(args.limit, 5, 10)
      const includeContent = args.include_content ?? true
      let hits: CaseLawHit[]
      try {
        hits = deps.search(args.query, { limit, ...(args.doc_type !== undefined ? { docType: args.doc_type } : {}), ...(args.court !== undefined ? { court: args.court } : {}), excludeSource: 'wiki' })
      } catch (err) {
        throw new PatentToolError('setup_required', INSTALL_GUIDANCE, {
          tool: 'patent_case_search',
          cause: err instanceof Error ? err.message : String(err),
        })
      }
      const searchStrategy: SearchStrategy = {
        query: args.query,
        ...(args.doc_type !== undefined || args.court !== undefined
          ? {
            filters: {
              ...(args.doc_type !== undefined ? { docType: args.doc_type } : {}),
              ...(args.court !== undefined ? { court: args.court } : {}),
            },
          }
          : {}),
        ...(hits.length > 0 ? { hits: hits.length } : {}),
      }
      return {
        total: hits.length,
        results: hits.map(hit => toResult(hit, includeContent)),
        ...(deps.dbPath !== undefined ? { dbPath: deps.dbPath } : {}),
        searchStrategy: searchStrategy as unknown as JsonValue,
      }
    },
  })
}
