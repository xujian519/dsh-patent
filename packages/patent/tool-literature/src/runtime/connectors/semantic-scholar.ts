/**
 * Semantic Scholar 学术图谱连接器（免费无 key，keyless 层限速）。
 *
 * keyless 层共享限速约 1 req/s（per-host 由 http 层强制）；可选
 * `SEMANTIC_SCHOLAR_API_KEY` / 构造选项注入 `x-api-key` 头提升配额。
 * id 可以是 paperId 或外部 id（"DOI:10.…"、"ARXIV:…"、"PMID:…"）。
 */
import type { Connector, ConnectorHit } from '../../protocol/types.ts'
import { connectorHttp, type ConnectorHttpOptions } from './connector-http.ts'
import { clampLimit, formatAuthors, nonEmpty, raw, snippet } from '../shared/text.ts'

const BASE = 'https://api.semanticscholar.org/graph/v1/paper'
const FIELDS = 'title,abstract,url,year,venue,citationCount,externalIds,authors.name,openAccessPdf'
const RATE_LIMIT = { minIntervalMs: 1000 }

/** 创建 Semantic Scholar 连接器的选项（提额 key、限速、预算）。 */
interface CreateSemanticScholarConnectorOptions extends ConnectorHttpOptions {
  /** 可选提额 key；默认回退 SEMANTIC_SCHOLAR_API_KEY 环境变量。 */
  apiKey?: string
}

interface Author {
  name?: string
}

interface Paper {
  paperId?: string
  title?: string
  abstract?: string
  url?: string
  year?: number
  venue?: string
  citationCount?: number
  authors?: Author[]
  externalIds?: Record<string, unknown>
  openAccessPdf?: { url?: string }
}

interface SearchResponse {
  total?: number
  data?: Paper[]
}

function authors(p: Paper): string | undefined {
  return formatAuthors((p.authors ?? []).map(a => a.name))
}

function toHit(p: Paper): ConnectorHit {
  const meta = [authors(p), p.venue, p.year].filter(Boolean).join('. ')
  return {
    id: p.paperId ?? '',
    title: snippet(p.title, 300) ?? p.paperId ?? 'Untitled',
    summary: snippet(p.abstract) ?? nonEmpty(meta),
    url: p.url ?? (p.paperId ? `https://www.semanticscholar.org/paper/${p.paperId}` : undefined),
    score: typeof p.citationCount === 'number' ? p.citationCount : undefined,
    extra: { ...raw(p), ...(p.openAccessPdf?.url === undefined ? {} : { pdf_url: p.openAccessPdf.url }) },
  }
}

/**
 * 创建 Semantic Scholar 学术图谱连接器。
 * @param options - 连接器选项（提额 key、限速、重试）。
 * @returns Semantic Scholar 连接器。
 */
export function createSemanticScholarConnector(options: CreateSemanticScholarConnectorOptions = {}): Connector {
  const { client, http } = connectorHttp(options, RATE_LIMIT)
  const apiHeaders = (): Record<string, string> | undefined => {
    const key = options.apiKey?.trim() || process.env.SEMANTIC_SCHOLAR_API_KEY?.trim()
    return key ? { 'x-api-key': key } : undefined
  }
  return {
    id: 'semantic-scholar',
    name: 'Semantic Scholar',
    domain: 'literature',
    description: 'AI-powered academic graph: abstracts, citations, references, and influence.',
    homepage: 'https://www.semanticscholar.org',
    async search(query, opts) {
      const limit = clampLimit(opts?.limit)
      const data = await client.getJSON<SearchResponse>(
        `${BASE}/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=${FIELDS}`,
        { ...http, signal: opts?.signal, headers: apiHeaders() },
      )
      return (data.data ?? []).map(toHit)
    },
    async fetch(id, opts) {
      // 外部 id 的冒号/斜杠必须原样保留在路径段中（"DOI:10.x/y"、"ARXIV:…"）。
      const data = await client.getJSON<Paper | null>(
        `${BASE}/${id.trim()}?fields=${FIELDS},references.title,citations.title`,
        { ...http, signal: opts?.signal, headers: apiHeaders() },
      )
      return data ?? null
    },
  }
}
