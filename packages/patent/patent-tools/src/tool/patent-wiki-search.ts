/**
 * `patent_wiki_search` tool: keyword lookup over the patent wiki knowledge cards
 * (four drafting-related directories). Ported from Sati's patentWikiSearch.ts.
 * @module @deepseek-ai/dsh-patent-tools/tool/patent-wiki-search
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { WikiCardMeta } from '@deepseek-ai/dsh-patent-knowledge'
import { PatentToolError } from '../error.ts'
import { resolveResultLimit } from './internal/query-limit.ts'

/** Drafting-related wiki directories (relative path prefixes under the wiki root). */
export const PATENT_WIKI_DIRS = {
  specification: '专利实务/说明书',
  claims: '专利实务/权利要求',
  drafting: '专利实务/撰写',
  figures: '专利实务/附图',
} as const

/** Drafting-related wiki directory key. */
export type PatentWikiDir = keyof typeof PATENT_WIKI_DIRS

/** Input for the patent_wiki_search tool. */
export type PatentWikiSearchInput = {
  /** Search keyword (title/concept/domain substring; empty = list by directory). */
  query: string
  /** Directory filter (default = all directories). */
  dir?: PatentWikiDir
  /** Result cap (default 5, max 10). */
  limit?: number
  /** Attach card body fragments (default false). */
  include_body?: boolean
}

/** Output of the patent_wiki_search tool. */
export type PatentWikiSearchOutput = {
  total: number
  results: Array<{
    id: string
    title: string
    relativePath: string
    concept?: string
    domain?: string
    body?: string
  }>
  wikiDir?: string
}

/** Injected wiki search (tests override; production wires a WikiCardLoader over ctx.patentKnowledge.paths.wikiDir). */
export type PatentWikiSearchDeps = {
  searchIn?: (prefix: string, keyword: string, limit: number) => WikiCardMeta[]
  formatAsContext?: (id: string, maxChars: number) => string
  /** Resolved wiki directory, surfaced as the output's `wikiDir` field. */
  wikiDir?: string
}

function toResult(meta: WikiCardMeta, formatAsContext: (id: string, maxChars: number) => string, includeBody: boolean): PatentWikiSearchOutput['results'][number] {
  const result: PatentWikiSearchOutput['results'][number] = {
    id: meta.id,
    title: meta.title,
    relativePath: meta.relativePath,
    ...(meta.concept !== undefined ? { concept: meta.concept } : {}),
    ...(meta.domain !== undefined ? { domain: meta.domain } : {}),
  }
  if (includeBody) {
    const body = formatAsContext(meta.id, 600)
    if (body) result.body = body
  }
  return result
}

const DESCRIPTION = '检索专利 wiki 知识卡片（说明书/权利要求/撰写/附图四目录），用于撰写说明书、权利要求书时查询充分公开、实施例、数值范围、以说明书为依据等撰写标准。支持 dir 目录过滤（specification/claims/drafting/figures）与 include_body 正文片段。'

/**
 * Result cap applied when a call omits its own `limit`.
 */
const DEFAULT_RESULT_LIMIT = 5

/**
 * Upper bound on `limit`: one call returns at most this many cards in
 * argument-free listing mode, whatever the caller asks for.
 */
const MAX_RESULT_LIMIT = 10

/** Render the canonical wiki-search value into model-facing prose. */
function renderWikiSearch(value: PatentWikiSearchOutput): string {
  if (value.results.length === 0) {
    return 'patent_wiki_search: 0 张卡片命中。'
  }
  const rows = value.results.map((r) => {
    const head = `## ${r.title}`
    const meta = [`**id**: ${r.id}`, `**path**: ${r.relativePath}`]
    if (r.concept) meta.push(`**概念**: ${r.concept}`)
    if (r.domain) meta.push(`**领域**: ${r.domain}`)
    const lines = [head, meta.join(' · ')]
    if (r.body) lines.push(r.body)
    return lines.join('\n')
  })
  return [`**patent_wiki_search** — ${value.results.length} card(s):`, '', rows.join('\n\n---\n\n')].join('\n')
}

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    relativePath: { type: 'string', required: true },
    concept: { type: 'string' },
    domain: { type: 'string' },
    body: { type: 'string' },
  },
} as const

/**
 * Build the `patent_wiki_search` tool over an injectable wiki-card search.
 * @param deps - the wiki-card search/format functions plus the resolved wiki dir.
 * @returns a registry-ready tool definition.
 */
export function createPatentWikiSearchTool(deps: PatentWikiSearchDeps): ToolDefinition {
  return defineTool({
    name: 'patent_wiki_search',
    description: DESCRIPTION,
    parameters: {
      query: { type: 'string', required: true, description: '检索关键词（卡片标题/概念/领域子串匹配；空串 = 按目录列出卡片，条数受 limit 约束）' },
      dir: { type: 'string', enum: ['specification', 'claims', 'drafting', 'figures'], description: '目录过滤：specification=说明书、claims=权利要求、drafting=撰写、figures=附图（缺省全部）' },
      limit: { type: 'number', description: `返回条数上限（默认 ${String(DEFAULT_RESULT_LIMIT)}，最大 ${String(MAX_RESULT_LIMIT)}）` },
      include_body: { type: 'boolean', description: '是否附带卡片正文片段（默认 false）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          results: { type: 'array', required: true, items: RESULT_SCHEMA },
          wikiDir: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderWikiSearch(value) }],
    },
    // oxlint-disable-next-line typescript/require-await -- tool contract requires async execute
    async execute(args) {
      if (deps.searchIn === undefined || deps.formatAsContext === undefined) {
        throw new PatentToolError('setup_required', 'wiki 卡片目录不可用：请先运行 patent-knowledge:install 准备本地知识数据。', { tool: 'patent_wiki_search' })
      }
      const prefix = args.dir ? PATENT_WIKI_DIRS[args.dir] : ''
      const limit = resolveResultLimit(args.limit, DEFAULT_RESULT_LIMIT, MAX_RESULT_LIMIT)
      const includeBody = args.include_body === true
      const formatAsContext = deps.formatAsContext
      const metas = deps.searchIn(prefix, args.query, limit)
      return {
        total: metas.length,
        results: metas.map(meta => toResult(meta, formatAsContext, includeBody)),
        ...(deps.wikiDir !== undefined ? { wikiDir: deps.wikiDir } : {}),
      }
    },
  })
}
