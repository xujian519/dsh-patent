/**
 * Crossref REST API 连接器（DOI 元数据，免费无 key）。
 *
 * `mailto` 参数将请求纳入 Crossref 的 polite pool（无需 key）。
 * 摘要（如有）为 JATS XML，剥离为纯文本。
 */
import type { Connector, ConnectorHit } from '../../protocol/types.ts'
import { connectorHttp, type ConnectorHttpOptions } from './connector-http.ts'
import { clampLimit, formatAuthors, nonEmpty, raw, snippet } from '../shared/text.ts'

const BASE = 'https://api.crossref.org/works'
const MAILTO = 'mailto=sati@users.noreply.github.com'

/** 创建 Crossref 连接器的选项。 */
type CreateCrossrefConnectorOptions = ConnectorHttpOptions

interface Author {
  given?: string
  family?: string
  name?: string
}

interface Work {
  DOI?: string
  title?: string[]
  subtitle?: string[]
  abstract?: string
  author?: Author[]
  'container-title'?: string[]
  publisher?: string
  type?: string
  URL?: string
  score?: number
  'is-referenced-by-count'?: number
  issued?: { 'date-parts'?: number[][] }
}

interface SearchResponse {
  message?: { items?: Work[]; 'total-results'?: number }
}

interface WorkResponse {
  message?: Work
}

function year(w: Work): number | undefined {
  return w.issued?.['date-parts']?.[0]?.[0]
}

function authors(w: Work): string | undefined {
  return formatAuthors((w.author ?? []).map(a => a.name ?? [a.given, a.family].filter(Boolean).join(' ')))
}

function toHit(w: Work): ConnectorHit {
  const meta = [authors(w), w['container-title']?.[0], year(w)].filter(Boolean).join('. ')
  return {
    id: w.DOI ?? '',
    title: snippet([w.title?.[0], w.subtitle?.[0]].filter(Boolean).join(': '), 300) ?? w.DOI ?? 'Untitled',
    summary: snippet(w.abstract) ?? nonEmpty(meta),
    url: w.URL ?? (w.DOI ? `https://doi.org/${w.DOI}` : undefined),
    score: typeof w.score === 'number' ? w.score : undefined,
    extra: raw(w),
  }
}

/**
 * 创建 Crossref DOI 元数据连接器。
 * @param options - 连接器选项。
 * @returns Crossref 连接器。
 */
export function createCrossrefConnector(options: CreateCrossrefConnectorOptions = {}): Connector {
  const { client, http } = connectorHttp(options)
  return {
    id: 'crossref',
    name: 'Crossref',
    domain: 'literature',
    description: 'Cross-publisher DOI metadata: titles, authors, venues, references, and citations.',
    homepage: 'https://www.crossref.org',
    async search(query, opts) {
      const rows = clampLimit(opts?.limit)
      const data = await client.getJSON<SearchResponse>(
        `${BASE}?query=${encodeURIComponent(query)}&rows=${rows}&select=DOI,title,subtitle,abstract,author,container-title,publisher,type,URL,score,is-referenced-by-count,issued&${MAILTO}`,
        { ...http, signal: opts?.signal },
      )
      return (data.message?.items ?? []).map(toHit)
    },
    async fetch(id, opts) {
      const doi = id.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim()
      const data = await client.getJSON<WorkResponse>(`${BASE}/${encodeURIComponent(doi)}?${MAILTO}`, { ...http, signal: opts?.signal })
      return data.message ?? null
    },
  }
}
