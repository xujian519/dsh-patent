/**
 * `law_search` tool: full-text search over the deployment's external IP knowledge
 * base (knowledge.db documents/chunks/docs_fts) for the two normative corpora it
 * indexes — statute text (`law_article`) and the 《专利审查指南》 chapters
 * (`guideline_rule`).
 *
 * This is the retrieval channel for *rules*: the packed law index behind
 * `law_verify` decides citation form and whether an entry is transcribed, but it
 * does not carry the guideline text, so a guideline section it reports as 未核验
 * is settled here — with the corpus path (`file_path`) recorded as the citation's
 * source. Case law has its own tool (`patent_case_search`).
 * @module @deepseek-ai/dsh-patent-tools/tool/law-search
 */

import { existsSync } from 'node:fs'
import { errorMessage } from '@deepseek-ai/dsh-value'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { resolveAsOf, type LawSearchResult, type LawValidity } from '@deepseek-ai/dsh-patent-knowledge'
import type { SearchStrategy } from '@deepseek-ai/dsh-patent-core'
import { PatentToolError } from '../error.ts'
import { knowledgeInstallGuidance, truncateSnippet } from './internal/knowledge.ts'
import { resolveResultLimit } from './internal/query-limit.ts'

/** Which normative corpus of the knowledge base to search. */
export type LawSearchScope = 'law' | 'guideline'

/** Input for the law_search tool. */
export type LawSearchInput = {
  /** Search text (e.g. 说明书 附图标记, 有益效果, 计算机程序 技术方案). */
  query: string
  /** Corpus: law=statute text, guideline=《专利审查指南》 full text. Defaults to law. */
  scope?: LawSearchScope
  /** Legal level filter (法律 / 行政法规 / 司法解释 / 部门规章…); applies to statute rows. */
  level?: string
  /** Result cap (default 5, max 10). */
  limit?: number
  /** Attach the matched fragment (default true, truncated to ~800 chars). */
  include_content?: boolean
  /** Point-in-time validity date (YYYY-MM-DD); defaults to today. */
  asOf?: string
}

/** Output of the law_search tool. */
export type LawSearchOutput = {
  scope: LawSearchScope
  /** 时间效力判定时点（YYYY-MM-DD）。 */
  asOf: string
  total: number
  results: Array<{
    id: string
    /** Document title (statute name, or the guideline chapter title). */
    name: string
    level: string
    /** Corpus-relative path (`documents.file_path`): the citation's source. */
    sourcePath?: string
    /** Validity at the search's as-of date (today for this tool). */
    validity: LawValidity
    charCount: number
    score: number
    snippet?: string
  }>
  dbPath?: string
  /** 标准化检索策略记录（形状同 `SearchStrategy`；字段类型放宽到 JSON 值以对齐工具输出 schema）。 */
  searchStrategy: JsonValue
}

/** Options accepted by an injected normative-corpus search. */
type LawSearchPortOptions = {
  limit?: number
  level?: string
  asOf?: string
  includeUnverified?: boolean
}

/** Injected normative-corpus search (tests override; production wires ctx.patentKnowledge). */
export type LawSearchDeps = {
  /** Statute-text search (production: ctx.patentKnowledge.legalSearch). */
  searchLaw?: (query: string, options?: LawSearchPortOptions) => LawSearchResult[]
  /** Guideline-text search (production: ctx.patentKnowledge.guidelineSearch). */
  searchGuideline?: (query: string, options?: LawSearchPortOptions) => LawSearchResult[]
  /** Resolved knowledge.db path, used for the setup-required check and surfaced as the output's `dbPath` field. */
  dbPath?: string
}

const INSTALL_GUIDANCE = knowledgeInstallGuidance('本地规范库', '（Config.knowledgeDir）')

const DESCRIPTION = [
  '检索部署的外接 IP 知识库（knowledge.db 全文索引）里的规范原文：scope=law 取法律法规条文，scope=guideline 取《专利审查指南》全文。',
  '这是**规则**的检索通道：`law_verify` 只按随包索引判定引用形式与是否转录（指南的节级条目已随包转录，其下各节都没有转录的条目才判「未核验」），指南条文要在这里取原文并把 sourcePath（语料内路径）记为引文来源；判例全文另有 patent_case_search。',
  '命中为空不得下任何结论；引用格式：`<名称>` + `<条号/节号>` + `<sourcePath>`。',
  '每条命中带 `时间效力`：已废止与尚未生效的条文不会返回；标为「未核验」表示库里缺少施行/失效时间，引用前须另行核对版本。',
].join(' ')

const VALIDITY_LABELS: Record<LawValidity, string> = {
  'in-force': '在效',
  expired: '已废止',
  'not-yet-effective': '尚未生效',
  unverified: '未核验（缺少施行/失效时间）',
}

/**
 * Render the canonical law-search value into model-facing prose.
 * @param value - the search result to render.
 * @param query - the query the call carried (the strategy record is JSON-typed in the output schema).
 * @returns the rendered Markdown.
 */
function renderLawSearch(value: LawSearchOutput, query: string): string {
  const label = value.scope === 'guideline' ? '审查指南全文' : '法规条文'
  const header = [
    `**law_search**（${label}）— ${String(value.results.length)} 条命中：`,
    `检索式：${query}`,
    `时间效力判定时点：${value.asOf}`,
  ]
  if (value.results.length === 0) {
    return [...header, '', `0 条${label}命中；换个检索词或改 scope 再查，命中为空不得据此下结论。`].join('\n')
  }
  const rows = value.results.map((r) => {
    const lines = [`## ${r.name}`]
    lines.push(`**id**: ${r.id} · ${r.level}`)
    if (r.sourcePath !== undefined) lines.push(`**sourcePath**: ${r.sourcePath}`)
    lines.push(`**时间效力**: ${VALIDITY_LABELS[r.validity]}`)
    lines.push(`**字数**: ${String(r.charCount)}`)
    if (r.snippet !== undefined) lines.push(r.snippet)
    return lines.join('\n')
  })
  return [...header, '', rows.join('\n\n---\n\n')].join('\n')
}

const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    level: { type: 'string', required: true },
    sourcePath: { type: 'string' },
    validity: {
      type: 'string',
      required: true,
      enum: ['in-force', 'expired', 'not-yet-effective', 'unverified'],
    },
    charCount: { type: 'integer', required: true },
    score: { type: 'number', required: true },
    snippet: { type: 'string' },
  },
} as const

/**
 * Build the `law_search` tool over injectable normative-corpus search functions.
 * @param deps - the statute and guideline search functions plus the resolved knowledge.db path.
 * @returns a registry-ready tool definition.
 */
export function createLawSearchTool(deps: LawSearchDeps): ToolDefinition {
  return defineTool({
    name: 'law_search',
    description: DESCRIPTION,
    parameters: {
      query: { type: 'string', required: true, description: '检索关键词（如 说明书 附图标记、有益效果、计算机程序 技术方案）' },
      scope: { type: 'string', enum: ['law', 'guideline'], description: '语料范围：law=法律法规条文（缺省），guideline=《专利审查指南》全文' },
      level: { type: 'string', description: '法律层级过滤（法律/行政法规/司法解释/部门规章…），对法规条文生效' },
      limit: { type: 'number', description: '返回条数上限（默认 5，最大 10）' },
      include_content: { type: 'boolean', description: '是否附命中片段（默认 true，截断约 800 字）' },
      asOf: { type: 'string', description: '时间效力判定时点（YYYY-MM-DD），缺省为今天；用于按历史版本检索' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: { type: 'string', required: true, enum: ['law', 'guideline'] },
          asOf: { type: 'string', required: true },
          total: { type: 'integer', required: true },
          results: { type: 'array', required: true, items: RESULT_SCHEMA },
          dbPath: { type: 'string' },
          searchStrategy: { type: 'json', required: true },
        },
      },
      render: (args, value) => [{ type: 'text', text: renderLawSearch(value, args.query) }],
    },
    // oxlint-disable-next-line typescript/require-await -- tool contract requires async execute
    async execute(args) {
      const scope: LawSearchScope = args.scope ?? 'law'
      const search = scope === 'guideline' ? deps.searchGuideline : deps.searchLaw
      if (search === undefined) {
        throw new PatentToolError('setup_required', INSTALL_GUIDANCE, { tool: 'law_search', scope })
      }
      if (deps.dbPath !== undefined && !existsSync(deps.dbPath)) {
        throw new PatentToolError('setup_required', INSTALL_GUIDANCE, { tool: 'law_search', scope })
      }
      const limit = resolveResultLimit(args.limit)
      const includeContent = args.include_content ?? true
      let asOf: string
      try {
        asOf = resolveAsOf(args.asOf)
      } catch (err) {
        throw new PatentToolError('invalid_tool_input', errorMessage(err), {
          tool: 'law_search',
          scope,
        })
      }
      let hits: LawSearchResult[]
      try {
        hits = search(args.query, {
          limit,
          asOf,
          ...(args.level === undefined ? {} : { level: args.level }),
        })
      } catch (err) {
        throw new PatentToolError('setup_required', INSTALL_GUIDANCE, {
          tool: 'law_search',
          scope,
          cause: errorMessage(err),
        })
      }
      const results = hits.map(hit => ({
        id: hit.id,
        name: hit.name,
        level: hit.level,
        ...(hit.filename === undefined ? {} : { sourcePath: hit.filename }),
        validity: hit.validity,
        charCount: hit.content?.length ?? 0,
        score: hit.score,
        ...(includeContent && hit.content !== undefined ? { snippet: truncateSnippet(hit.content) } : {}),
      }))
      const searchStrategy: SearchStrategy = {
        query: args.query,
        ...(args.level === undefined ? {} : { level: args.level }),
      }
      return {
        scope,
        asOf,
        total: results.length,
        results,
        searchStrategy: { ...searchStrategy },
        ...(deps.dbPath === undefined ? {} : { dbPath: deps.dbPath }),
      }
    },
  })
}
