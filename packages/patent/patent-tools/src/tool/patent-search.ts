/**
 * `patent_search` tool: keyword/boolean search over Google Patents via the nuo
 * engine (LRU-cached). Ported from Sati's patentSearch.ts.
 * @module @deepseek-ai/dsh-patent-tools/tool/patent-search
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { searchPatents as searchPatentsImpl } from '@deepseek-ai/nuo-patent'
import type { PatentSearchHit, PatentSearchResult } from '@deepseek-ai/nuo-patent'
import { CNIPR_SEARCH_MAX_HITS, cachedSearchPatents } from '@deepseek-ai/dsh-patent-data'
import type { CniprChannel, CniprSearchHit, CniprSearchResult } from '@deepseek-ai/dsh-patent-data'
import { PatentToolError } from '../error.ts'
import { retryBounded } from './internal/bounded-retry.ts'
import { CNIPR_CHANNEL, GOOGLE_PATENTS_CHANNEL, appendSecondChannel, renderUpstreamFailure } from './internal/upstream-channel.ts'
import { WARNINGS_SCHEMA, warningSection } from './internal/tool-output.ts'

/** Input for the patent_search tool. */
export type PatentSearchInput = {
  /** Google Patents native search syntax (keywords/boolean/assignee:/date range). */
  query: string
  /** Max hits (1-50, default 10). */
  limit?: number
}

/** One normalized search hit. */
export type PatentSearchHitItem = {
  patent: string
  title: string
  assignee: string
  publicationDate: string
  priorityDate: string
  abstract: string
  url: string
}

/** Output of the patent_search tool. */
export type PatentSearchOutput = {
  query: string
  /** Channel this search read from; a report cites it as the fact's source. */
  channel: string
  total: number
  hits: PatentSearchHitItem[]
  /** Non-fatal warnings (parse degradation / partial fields / family dedupe). */
  warnings: string[]
}

/**
 * 晚绑定的 CNIPR 检索通道。`patent-data` 的插件声明 `inject: ['subprocess']`，在只注入
 * `['tools']` 的消费方里晚一跳激活；在 `apply()` 里读取会冻结当时看到的服务。
 * @returns 具备 `search` 的通道，本部署未启用或未接线时为 undefined。
 */
export type CniprSearchLookup = () => Pick<CniprChannel, 'search'> | undefined

/** Injected search function (tests override; production uses the LRU-cached nuo search). */
export type PatentSearchDeps = {
  search?: (query: string, opts?: { limit?: number; signal?: AbortSignal }) => Promise<PatentSearchResult>
  /** Retry backoff before each repeat attempt (defaults to {@link DEFAULT_SEARCH_RETRY_DELAYS_MS}). */
  searchRetryDelaysMs?: readonly number[]
  /** CNIPR 第二通道（默认不接线：部署未打开该通道时只走 nuo 引擎）。 */
  cnipr?: CniprSearchLookup
}

/**
 * The engine answers timeouts and dropped connections under load; both are
 * transient, so a bounded backoff turns them into a slower answer instead of a
 * failed search. The delays mirror `patent_metadata`'s scrape retry.
 */
const DEFAULT_SEARCH_RETRY_DELAYS_MS: readonly number[] = [400, 1_200]

/** Failure-class warning prefixes: the engine reports failures in `warnings`, not an error code. */
const SEARCH_FAILURE_WARNING = /^(查询条件为空|检索超时|检索失败)/

/** The subset of failure warnings worth another attempt: transient upstream failures. */
const RETRYABLE_SEARCH_FAILURE_WARNING = /^(检索超时|检索失败)/

/** The failure-class warning carried by a result, if any. */
function failureWarning(result: PatentSearchResult): string | undefined {
  return result.warnings.find(w => SEARCH_FAILURE_WARNING.test(w))
}

function toItem(h: PatentSearchHit): PatentSearchHitItem {
  return {
    patent: h.patent,
    title: h.title,
    assignee: h.assignee,
    publicationDate: h.publication_date,
    priorityDate: h.priority_date,
    abstract: h.abstract,
    url: h.url,
  }
}

/**
 * Extract the base number of a patent (strip kind code): `CN115690481A`→`CN115690481`.
 * @param patent - the patent number to extract from.
 * @returns the base number, or undefined when the format does not match.
 */
export function baseNumber(patent: string): string | undefined {
  const match = /^([A-Z]{2}\d+)[A-Z]\d?$/.exec(patent)
  return match?.[1]
}

/**
 * Deduplicate by base number: Google Patents often returns A/B/C variants of the
 * same application; keep the latest publication date per base, in source order.
 * @param hits - the source hits.
 * @param baseWarnings - existing warnings to append to.
 * @returns deduped hits plus the merged warnings.
 */
export function dedupeByFamily(
  hits: readonly PatentSearchHit[],
  baseWarnings: readonly string[],
): { hits: PatentSearchHit[]; warnings: string[] } {
  const bestByBase = new Map<string, PatentSearchHit>()
  const kept = new Set<string>()
  const dropped = new Map<string, number>()

  for (const hit of hits) {
    const base = baseNumber(hit.patent)
    if (base === undefined) continue
    const current = bestByBase.get(base)
    if (current === undefined) {
      bestByBase.set(base, hit)
      kept.add(hit.patent)
      continue
    }
    if (hit.publication_date > current.publication_date) {
      bestByBase.set(base, hit)
      kept.delete(current.patent)
      kept.add(hit.patent)
    }
    dropped.set(base, (dropped.get(base) ?? 0) + 1)
  }

  const deduped = hits.filter(h => kept.has(h.patent) || baseNumber(h.patent) === undefined)
  const warnings = [...baseWarnings]
  for (const [base, count] of dropped) {
    const best = bestByBase.get(base)
    const date = best?.publication_date ? ` ${best.publication_date}` : ''
    warnings.push(`family 去重：${base}* 的 ${count + 1} 篇公开/授权变体合并为 1 篇（保留 ${best?.patent}${date}）`)
  }
  return { hits: deduped, warnings }
}

/** 第二通道的用途、它能返回什么、以及它不接哪些查询（模型可见，故与实现同处一份）。 */
const CNIPR_USAGE_NOTE = '  - 当 Google Patents 通道失败、抛错或零命中时，部署启用 CNIPR 通道会再检索一次，结果里的 channel 写明这次实际由谁服务；CNIPR 只做关键词检索，命中含公开(公告)号、标题、申请人、公开日与摘要，没有 URL 与优先权，且带 assignee:/after:/CL: 这类字段语法的查询不咨询它'

/** Google Patents 的字段语法（`assignee:`/`after:`/`CL:`…）；CNIPR 的检索框只认关键词。 */
const GOOGLE_FIELD_SYNTAX = /(?:^|[\s(])(assignee|inventor|after|before|country|status|type|CL|AB|TI|TA|AN|PN|IPC|CPC)\s*:/iu

/** 第二通道服务这次检索的结果：命中（含它的告警），或未服务时它留下的告警。 */
type CniprSearchAttempt =
  | { served: true; total: number; hits: PatentSearchHitItem[]; warnings: string[] }
  | { served: false; warnings: string[] }

/** CNIPR 命中映射成工具的命中；该通道不发布 URL 与优先权，两者留空而不编造。 */
function toCniprItem(hit: CniprSearchHit): PatentSearchHitItem {
  return {
    patent: hit.patent,
    title: hit.title,
    assignee: hit.assignee,
    publicationDate: hit.publicationDate,
    priorityDate: '',
    abstract: hit.abstract,
    url: '',
  }
}

/**
 * 用 CNIPR 第二通道服务这次检索。
 *
 * 只在前一通道没有可用答案时调用（失败告警、抛错或零命中）。带 Google 字段语法的查询不
 * 咨询该通道：它只做关键词检索，原样发过去会按字面匹配、给出无法解释的命中。通道级失败
 * 不抛给调用方，而是进 warnings——「第二个通道不可用」必须在调用记录里看得见，否则会被
 * 读成「不需要它」。
 * @param lookup - 晚绑定的通道查询；未接线时按未服务返回。
 * @param query - 检索词。
 * @param limit - 调用方期望的条数。
 * @param signal - 调用方取消信号。
 * @returns 命中与告警，或未服务时的告警。
 */
async function searchThroughCnipr(
  lookup: CniprSearchLookup | undefined,
  query: string,
  limit: number,
  signal: AbortSignal | undefined,
): Promise<CniprSearchAttempt> {
  const cnipr = lookup?.()
  if (cnipr === undefined) return { served: false, warnings: [] }
  const operator = GOOGLE_FIELD_SYNTAX.exec(query)?.[1]
  if (operator !== undefined) {
    return { served: false, warnings: [`查询含 Google Patents 字段语法（${operator}:），${CNIPR_CHANNEL}只做关键词检索，未咨询它`] }
  }
  const truncation = limit > CNIPR_SEARCH_MAX_HITS
    ? [`${CNIPR_CHANNEL}单次检索上限 ${CNIPR_SEARCH_MAX_HITS} 条，请求的 ${limit} 条按上限截断`]
    : []
  let result: CniprSearchResult
  try {
    /* v8 ignore next -- exec.signal is always present on the tool execution context */
    result = await cnipr.search(query, { limit, ...(signal === undefined ? {} : { signal }) })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { served: false, warnings: [`${CNIPR_CHANNEL}不可用（${detail}），结果只有 ${GOOGLE_PATENTS_CHANNEL} 的`, ...truncation] }
  }
  if (result.hits.length === 0) return { served: false, warnings: [`${CNIPR_CHANNEL}也未命中`, ...truncation] }
  return { served: true, total: result.total, hits: result.hits.map(toCniprItem), warnings: truncation }
}

const DESCRIPTION = [
  '- Searches Google Patents by keyword or boolean query (e.g. \'(phase change OR PCM) AND thermal\', \'assignee:(Samsung) after:20200101\')',
  '- Returns structured hits: patent number, title, assignee, publication date, abstract, URL',
  '- Use for prior-art search, novelty pre-screening, competitor/assignee analysis',
  '',
  'Usage notes:',
  '  - Read-only; query syntax follows Google Patents search grammar',
  '  - Follow up with patent_metadata to fetch full details of a specific hit',
  '  - The result names the channel that served it and every failure names the channel it failed on, so a report cites the channel it actually used instead of inferring one from a hit URL',
  CNIPR_USAGE_NOTE,
  '  - A network failure is reported as an error naming that channel; a genuine zero-result search returns empty hits',
  '  - A transient upstream failure (timeout, dropped connection) is retried twice; a failure that outlives the retries names the channel, the upstream error, and the attempts made',
  '  - Non-fatal warnings (family dedupe, fields the page structure left empty) are listed under 警告 in the rendered result',
].join('\n')

/**
 * Render the canonical search value into model-facing Markdown.
 *
 * Warnings are rendered, not merely carried: the description promises the model
 * sees them, and a zero-hit render would otherwise state `0 result(s)` without
 * the reason the upstream reported.
 */
function renderSearch(value: PatentSearchOutput): string {
  const hits = value.hits.map(h =>
    [
      `## ${h.title || h.patent}`,
      `**patent**: ${h.patent}${h.publicationDate ? ` · published ${h.publicationDate}` : ''}`,
      `**assignee**: ${h.assignee || 'N/A'}`,
      ...(h.url ? [`**url**: ${h.url}`] : []),
      ...(h.abstract ? [h.abstract] : []),
    ].join('\n'),
  )
  const header = `**patent_search** — ${value.hits.length} result(s) for "${value.query}" · channel: ${value.channel}`
  const warningLines = warningSection(value.warnings)
  return [header, '', hits.join('\n\n---\n\n'), ...warningLines].join('\n')
}

const HIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    patent: { type: 'string', required: true },
    title: { type: 'string', required: true },
    assignee: { type: 'string', required: true },
    publicationDate: { type: 'string', required: true },
    priorityDate: { type: 'string', required: true },
    abstract: { type: 'string', required: true },
    url: { type: 'string', required: true },
  },
} as const

/**
 * Build the `patent_search` tool over an injectable nuo search function.
 * @param deps - optional search-function injection (defaults to the LRU-cached nuo search).
 * @returns a registry-ready tool definition.
 */
export function createPatentSearchTool(deps: PatentSearchDeps = {}): ToolDefinition {
  const search = deps.search ?? cachedSearchPatents(searchPatentsImpl)
  const retryDelaysMs = deps.searchRetryDelaysMs ?? DEFAULT_SEARCH_RETRY_DELAYS_MS
  return defineTool({
    name: 'patent_search',
    description: DESCRIPTION,
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Search query in Google Patents syntax: keywords, phrases, boolean (AND/OR/NOT), fielded (assignee:/inventor:), date ranges (after:/before:).',
      },
      limit: { type: 'number', description: 'Max hits (1-50, default 10)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          channel: { type: 'string', required: true },
          total: { type: 'integer', required: true },
          hits: { type: 'array', required: true, items: HIT_SCHEMA },
          warnings: WARNINGS_SCHEMA,
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSearch(value) }],
    },
    async execute(args, exec) {
      const query = args.query.trim()
      if (query.length === 0) {
        throw new PatentToolError('invalid_tool_input', 'Search query is empty.', { tool: 'patent_search' })
      }
      const limit = Math.min(Math.max(Math.floor(args.limit ?? 10), 1), 50)
      // 引擎把上游失败写在 warnings 里，但也可能直接抛错（网络栈或引擎自身）。两种都算
      // 「第一通道没有可用答案」，都值得一次第二通道的机会；它也不成时原错误照旧抛出。
      let settled: { result: PatentSearchResult; attempts: number } | undefined
      let thrown: unknown
      try {
        settled = await retryBounded(
          () => search(query, { limit, signal: exec.signal }),
          (result) => {
            const warning = failureWarning(result)
            return warning !== undefined && RETRYABLE_SEARCH_FAILURE_WARNING.test(warning)
          },
          retryDelaysMs,
          exec.signal,
        )
      } catch (error) {
        thrown = error
      }

      const failure = settled === undefined ? undefined : failureWarning(settled.result)
      const hasUsableAnswer = settled !== undefined && failure === undefined && settled.result.hits.length > 0
      const attempt = hasUsableAnswer
        ? undefined
        : await searchThroughCnipr(deps.cnipr, query, limit, exec.signal)
      if (attempt?.served === true) {
        return { query, channel: CNIPR_CHANNEL, total: attempt.total, hits: attempt.hits, warnings: attempt.warnings }
      }
      const secondChannel = attempt?.warnings ?? []

      if (settled === undefined) throw thrown
      if (failure) {
        if (failure.startsWith('检索超时')) {
          throw new PatentToolError('tool_timeout', appendSecondChannel(renderUpstreamFailure(failure, settled.attempts), secondChannel), { tool: 'patent_search', query })
        }
        if (failure === '查询条件为空') {
          throw new PatentToolError('invalid_tool_input', failure, { tool: 'patent_search' })
        }
        throw new PatentToolError('tool_execution_failed', appendSecondChannel(renderUpstreamFailure(failure, settled.attempts), secondChannel), { tool: 'patent_search', query })
      }

      const { hits: dedupedHits, warnings } = dedupeByFamily(settled.result.hits, settled.result.warnings)
      const hits = dedupedHits.map(toItem)
      return { query, channel: GOOGLE_PATENTS_CHANNEL, total: settled.result.total, hits, warnings: [...warnings, ...secondChannel] }
    },
  })
}
