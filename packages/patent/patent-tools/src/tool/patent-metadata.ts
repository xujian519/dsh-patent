/**
 * `patent_metadata` tool: fetch Google Patents metadata by patent number via the
 * nuo scrape engine (LRU-cached). Ported from Sati's patentMetadata.ts.
 * @module @deepseek-ai/dsh-patent-tools/tool/patent-metadata
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { scrapePatent as scrapePatentImpl, validatePatentNumber } from '@deepseek-ai/nuo-patent'
import type { ScrapeResult } from '@deepseek-ai/nuo-patent'
import { CNIPR_SEARCH_PAGE_SIZE, cachedScrapePatent, mapPatentData } from '@deepseek-ai/dsh-patent-data'
import type { CniprChannel, CniprSearchHit, CniprSearchResult, StructuredPatentData } from '@deepseek-ai/dsh-patent-data'
import { PatentToolError } from '../error.ts'
import { retryBounded } from './internal/bounded-retry.ts'
import { CNIPR_CHANNEL, GOOGLE_PATENTS_CHANNEL, appendSecondChannel, renderUpstreamFailure } from './internal/upstream-channel.ts'
import { WARNINGS_SCHEMA, warningSection } from './internal/tool-output.ts'

/** Input for the patent_metadata tool. */
export type PatentMetadataInput = {
  /** Patent number, e.g. "US11452699B2" (validated and normalized). */
  patent: string
  /** Request timeout in ms (default 30000). */
  timeout?: number
  /** Extract abstract (default true). */
  returnAbstract?: boolean
  /** Extract legal status (default true). */
  returnLegal?: boolean
}

/** Output of the patent_metadata tool. */
export type PatentMetadataOutput = {
  success: boolean
  patent: string
  /** Channel this lookup read from; a report cites it as the fact's source. */
  channel: string
  url: string
  /** Structured patent data on success (JSON-string fields parsed); null on failure. */
  data: JsonValue | null
  errorCode: string
  errorMessage: string
  /** 通道级告警（CNIPR 被咨询过但未能服务时点名它）。 */
  warnings: string[]
  /** Non-fatal parse warnings (field gaps from page-structure changes). */
  parseWarnings: Array<{ field: string; message: string }>
}

/**
 * 晚绑定的 CNIPR 检索通道。`patent-data` 的插件声明 `inject: ['subprocess']`，在只注入
 * `['tools']` 的消费方里晚一跳激活；在 `apply()` 里读取会冻结当时看到的服务。
 * @returns 具备 `search` 的通道，本部署未启用或未接线时为 undefined。
 */
export type CniprMetadataLookup = () => Pick<CniprChannel, 'search'> | undefined

/** Injected scrape function (tests override; production uses the LRU-cached nuo scrape). */
export type PatentMetadataDeps = {
  scrape?: (
    patent: string,
    opts?: { timeout?: number; returnAbstract?: boolean; returnLegal?: boolean; signal?: AbortSignal },
  ) => Promise<ScrapeResult>
  /** Retry backoff before each repeat attempt (defaults to {@link DEFAULT_SCRAPE_RETRY_DELAYS_MS}). */
  scrapeRetryDelaysMs?: readonly number[]
  /** CNIPR 第二通道（默认不接线：部署未打开该通道时只走 nuo 引擎）。 */
  cnipr?: CniprMetadataLookup
}

/**
 * Upstream Google Patents answers 503 and drops connections under load; both are
 * transient, so a bounded backoff turns them into a slower answer instead of a
 * failed lookup.
 */
const DEFAULT_SCRAPE_RETRY_DELAYS_MS: readonly number[] = [400, 1_200]

/** Scrape error codes worth another attempt: transient network-layer failures. */
const RETRYABLE_SCRAPE_ERROR_CODES: readonly ScrapeResult['errorCode'][] = ['HTTP_ERROR', 'NETWORK_ERROR']

/**
 * Compact a user-supplied patent number into the form the scrape engine
 * indexes: full-width characters fold to ASCII, case is folded up, whitespace
 * and `-`/`/`/`:` separators drop, and the CN application-number check digit
 * (the `.N` suffix, e.g. `CN202122978405.0`) drops with its separator because it
 * is bookkeeping punctuation rather than part of the number.
 * @param value - the raw patent or application number.
 * @returns the compacted number.
 */
export function compactPatentNumber(value: string): string {
  const folded = value
    .replace(/[\uFF01-\uFF5E]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
    .replace(/[\s\u3000]/g, '')
    .toUpperCase()
  const withCheckDigit = /^(CN)?(\d{12})\.\d$/.exec(folded)
  if (withCheckDigit) return `${withCheckDigit[1] ?? ''}${withCheckDigit[2]}`
  return folded.replace(/[-:/]/g, '')
}

/** Whether a settled scrape is worth another attempt: transient network-layer failures. */
function scrapeRetryable(result: ScrapeResult): boolean {
  return RETRYABLE_SCRAPE_ERROR_CODES.includes(result.errorCode)
}

/**
 * 只有中国公开(公告)号才咨询 CNIPR：该通道按号检索，结果行以同一个公开(公告)号发布，
 * 命中因此能按号精确对齐。中国申请号没有种类码，检索结果给的是公开号，按号对齐不了。
 */
const CNIPR_METADATA_NUMBER = /^CN\d{7,13}[A-Z]$/u

/** 第一通道是否已给出可用答案；校验失败不咨询第二通道，原因属于号码本身。 */
function firstChannelAnswered(result: ScrapeResult): boolean {
  return (result.success && result.data !== null) || result.errorCode === 'VALIDATION_ERROR'
}

/**
 * CNIPR 命中映射成结构化数据：该通道只发布标题、申请人、公开日与摘要，其余字段留空。
 * 返回值声明为 JSON 值，`satisfies` 仍按 {@link StructuredPatentData} 的字段集校验完整性。
 * @param hit - 与请求号完全一致的结果行。
 * @param patent - 请求的公开(公告)号。
 * @param returnAbstract - 是否保留摘要。
 * @returns 与引擎路径同字段面、多数为空的结构化数据。
 */
function cniprStructuredData(hit: CniprSearchHit, patent: string, returnAbstract: boolean): JsonValue {
  return {
    patent,
    url: '',
    title: hit.title,
    applicationNumber: '',
    inventors: [],
    assigneesOriginal: [],
    assigneesCurrent: hit.assignee === '' ? [] : [hit.assignee],
    pubDate: hit.publicationDate,
    filingDate: '',
    priorityDate: '',
    grantDate: '',
    expirationDate: '',
    legalStatus: '',
    ifiStatus: '',
    estimatedExpiration: '',
    pdfUrl: '',
    classifications: [],
    backwardCites: [],
    forwardCites: [],
    abstractText: returnAbstract ? hit.abstract : '',
  } satisfies Record<keyof StructuredPatentData, JsonValue>
}

/** 第二通道服务这次查询的结果：命中，或未服务时它留下的告警。 */
type CniprMetadataAttempt =
  | { served: true; output: PatentMetadataOutput }
  | { served: false; warnings: string[] }

/**
 * 用 CNIPR 第二通道按号查询中国公开(公告)号。
 *
 * 只在前一通道没有可用答案时调用。命中必须与请求的号完全相同：通道按号检索，但结果里
 * 可能混入同族的其他公开号。通道级失败不抛给调用方，而是进 warnings——「第二个通道不可用」
 * 必须在调用记录里看得见，否则会被读成「不需要它」。
 * @param lookup - 晚绑定的通道查询；未接线时按未服务返回。
 * @param patent - 已归一的中国公开(公告)号。
 * @param returnAbstract - 是否保留摘要（调用方关闭摘要时该字段留空）。
 * @param signal - 调用方取消信号。
 * @returns 命中及其输出，或未服务时的告警。
 */
async function lookupThroughCnipr(
  lookup: CniprMetadataLookup | undefined,
  patent: string,
  returnAbstract: boolean,
  signal: AbortSignal,
): Promise<CniprMetadataAttempt> {
  const cnipr = lookup?.()
  if (cnipr === undefined) return { served: false, warnings: [] }
  let result: CniprSearchResult
  try {
    result = await cnipr.search(patent, { limit: CNIPR_SEARCH_PAGE_SIZE, signal })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { served: false, warnings: [`${CNIPR_CHANNEL}不可用（${detail}），本次结果只有 ${GOOGLE_PATENTS_CHANNEL} 的`] }
  }
  const hit = result.hits.find(candidate => compactPatentNumber(candidate.patent) === patent)
  if (hit === undefined) return { served: false, warnings: [`${CNIPR_CHANNEL}也未检索到该公开(公告)号`] }
  return {
    served: true,
    output: {
      success: true,
      patent,
      channel: CNIPR_CHANNEL,
      url: '',
      data: cniprStructuredData(hit, patent, returnAbstract),
      errorCode: '',
      errorMessage: '',
      warnings: [],
      parseWarnings: [],
    },
  }
}

/**
 * Map one nuo ScrapeResult into the tool output, throwing on runtime-class failures.
 * @param result - the settled scrape result.
 * @param attempts - total scrape attempts made, reported when an upstream failure outlived the retries.
 * @param warnings - 第二通道留下的告警：失败结果据此点名被咨询过但未能服务的通道。
 * @returns the tool output for a completed or not-found lookup.
 */
function mapScrapeResult(result: ScrapeResult, attempts: number, warnings: readonly string[]): PatentMetadataOutput {
  if (result.success && result.data) {
    return {
      success: true,
      patent: result.patent,
      channel: GOOGLE_PATENTS_CHANNEL,
      url: result.url,
      data: mapPatentData(result.data, result.patent, result.url) as unknown as JsonValue,
      errorCode: '',
      errorMessage: '',
      warnings: [...warnings],
      parseWarnings: result.parseWarnings,
    }
  }
  switch (result.errorCode) {
    case 'VALIDATION_ERROR':
      throw new PatentToolError('invalid_tool_input', result.errorMessage, { tool: 'patent_metadata', patent: result.patent })
    case 'TIMEOUT':
      throw new PatentToolError('tool_timeout', appendSecondChannel(result.errorMessage, warnings), { tool: 'patent_metadata', patent: result.patent })
    case 'NOT_FOUND':
      return {
        success: false,
        patent: result.patent,
        channel: GOOGLE_PATENTS_CHANNEL,
        url: result.url,
        data: null,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        warnings: [...warnings],
        parseWarnings: result.parseWarnings,
      }
    default:
      throw new PatentToolError('tool_execution_failed', appendSecondChannel(renderUpstreamFailure(result.errorMessage, attempts), warnings), {
        tool: 'patent_metadata',
        patent: result.patent,
        errorCode: result.errorCode,
      })
  }
}

const DESCRIPTION = [
  '- Fetches patent metadata from Google Patents by patent number (e.g. US11452699B2)',
  '- Returns structured data: title, inventors, assignees, dates, legal status, estimated expiration, abstract, PDF URL, classifications, citations',
  '- Validates and normalizes the patent number automatically; a CN application number keeps its 12-digit form (CN202122978405.0 → CN202122978405) and full-width characters, whitespace, and - / : separators fold away',
  '- Use for patent due diligence, prior-art detail lookup, legal status checks',
  '',
  'Usage notes:',
  '  - Read-only; makes one network request per patent',
  '  - One call names the channel that served it and every failure names the channel it failed on, so a report cites the channel it actually used',
  '  - 中国公开(公告)号（如 CN218483312U）在 Google Patents 通道失败、抛错或查不到时，部署启用 CNIPR 通道会再按号检索一次；CNIPR 只发布标题、申请人、公开日与摘要，其余字段为空，被咨询过但未能服务的通道写在 warnings 里',
  '  - A country code is required; a bare application number (202122978405) is rejected — prepend CN or use the publication number',
  "  - A 'not found' result (patent does not exist) is returned as data with success:false — not an error",
  '  - A transient upstream failure (HTTP 503, dropped connection) is retried twice; a failure that outlives the retries names the channel, the upstream error, and the attempts made',
  '  - Non-fatal parse warnings (fields the page structure left empty) are listed under 警告 in the rendered result',
].join('\n')

/**
 * Render the canonical metadata value into model-facing Markdown.
 *
 * Warnings render on both outcomes: a failed lookup still carries the warnings
 * the scrape collected before it gave up, and the description promises the model
 * sees them.
 */
function renderMetadata(value: PatentMetadataOutput): string {
  const lines = value.success && value.data !== null
    ? metadataBodyLines(value.data as unknown as StructuredPatentData, value.channel)
    : [`patent_metadata(${value.patent}) · channel: ${value.channel}: ${value.errorMessage}`]
  lines.push(...warningSection(value.warnings, '通道告警'))
  if (value.parseWarnings.length > 0) {
    lines.push('', '## 警告', ...value.parseWarnings.map(w => `- ${w.field}: ${w.message}`))
  }
  return lines.join('\n')
}

/**
 * Render the metadata fields of a successful lookup.
 * @param d - the mapped structured patent data.
 * @param channel - the channel the lookup read from.
 * @returns the field lines, before the warning sections are appended.
 */
function metadataBodyLines(d: StructuredPatentData, channel: string): string[] {
  const url = d.url === '' ? '' : ` · **url**: ${d.url}`
  const lines = [
    `## ${d.title}`,
    `**patent**: ${d.patent}${url} · **channel**: ${channel}`,
    `**inventors**: ${d.inventors.join(', ') || 'N/A'}`,
    `**assignees**: ${d.assigneesCurrent.join(', ') || 'N/A'}`,
    `**dates**: filing ${d.filingDate || 'N/A'} · grant ${d.grantDate || 'N/A'} · pub ${d.pubDate || 'N/A'}`,
    `**legal status**: ${d.legalStatus || 'N/A'}${d.estimatedExpiration ? ` · est. expiration ${d.estimatedExpiration}` : ''}`,
    `**classifications**: ${d.classifications.join(', ') || 'N/A'}`,
    `**citations**: ${d.backwardCites.length} backward · ${d.forwardCites.length} forward`,
  ]
  if (d.pdfUrl) lines.push(`**pdf**: ${d.pdfUrl}`)
  if (d.abstractText) lines.push('', d.abstractText)
  return lines
}

const WARNING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    field: { type: 'string', required: true },
    message: { type: 'string', required: true },
  },
} as const

/**
 * Build the `patent_metadata` tool over an injectable nuo scrape function.
 * @param deps - optional scrape-function injection (defaults to the LRU-cached nuo scrape).
 * @returns a registry-ready tool definition.
 */
export function createPatentMetadataTool(deps: PatentMetadataDeps = {}): ToolDefinition {
  const scrape = deps.scrape ?? cachedScrapePatent(scrapePatentImpl)
  const retryDelaysMs = deps.scrapeRetryDelaysMs ?? DEFAULT_SCRAPE_RETRY_DELAYS_MS
  return defineTool({
    name: 'patent_metadata',
    description: DESCRIPTION,
    parameters: {
      patent: { type: 'string', required: true, description: "Patent number, e.g. 'US11452699B2'. Validated and normalized (uppercase, no spaces, no - / : separators; a CN application check digit is dropped)." },
      timeout: { type: 'number', description: 'Request timeout in ms (default 30000)' },
      returnAbstract: { type: 'boolean', description: 'Include abstract (default true)' },
      returnLegal: { type: 'boolean', description: 'Include legal status (default true)' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          success: { type: 'boolean', required: true },
          patent: { type: 'string', required: true },
          channel: { type: 'string', required: true },
          url: { type: 'string', required: true },
          data: { type: 'json' },
          errorCode: { type: 'string', required: true },
          errorMessage: { type: 'string', required: true },
          warnings: WARNINGS_SCHEMA,
          parseWarnings: { type: 'array', required: true, items: WARNING_SCHEMA },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderMetadata(value as unknown as PatentMetadataOutput) }],
    },
    async execute(args, exec) {
      const compacted = compactPatentNumber(args.patent)
      const validation = validatePatentNumber(compacted)
      if (!validation.valid) {
        /* v8 ignore next -- the vendored validator always supplies a reason for invalid numbers. */
        const reason = validation.reason ?? `Invalid patent number: ${args.patent}`
        throw new PatentToolError('invalid_tool_input', `${reason}；中国专利可补国家码（如 CN202122978405），或改用公开号（如 CN218483312U）`, {
          tool: 'patent_metadata',
          patent: args.patent,
        })
      }
      /* v8 ignore next -- the vendored validator always normalizes valid numbers. */
      const patent = validation.normalized ?? compacted
      // 引擎的上游失败写在结果里，但也可能直接抛错（网络栈或引擎自身）。两种都算
      // 「第一通道没有可用答案」，都值得一次第二通道的机会；它也不成时原错误照旧抛出。
      let settled: { result: ScrapeResult; attempts: number } | undefined
      let thrown: unknown
      try {
        settled = await retryBounded(
          () => scrape(patent, {
            timeout: args.timeout ?? 30000,
            returnAbstract: args.returnAbstract ?? true,
            returnLegal: args.returnLegal ?? true,
            signal: exec.signal,
          }),
          scrapeRetryable,
          retryDelaysMs,
        )
      } catch (error) {
        thrown = error
      }

      const answered = settled !== undefined && firstChannelAnswered(settled.result)
      const attempt = answered || !CNIPR_METADATA_NUMBER.test(patent)
        ? undefined
        : await lookupThroughCnipr(deps.cnipr, patent, args.returnAbstract ?? true, exec.signal)
      if (attempt?.served === true) return attempt.output
      const warnings = attempt?.warnings ?? []

      if (settled === undefined) throw thrown
      return mapScrapeResult(settled.result, settled.attempts, warnings)
    },
  })
}
