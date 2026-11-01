/**
 * OpenAlex 连接器（开放学术图谱，免费无 key）。
 *
 * 摘要以 `abstract_inverted_index`（词 → 位置）到达，重建为纯文本。
 * `mailto` 参数将请求纳入 polite pool（更快、配额更高），无 key 也能用；
 * 可选 `OPENALEX_MAILTO` 环境变量覆盖默认值。
 */
import type { Connector, ConnectorHit } from '../../protocol/types.ts'
import { connectorHttp, type ConnectorHttpOptions } from './connector-http.ts'
import { clampLimit, formatAuthors, fromInverted, nonEmpty, raw, snippet } from '../shared/text.ts'

const BASE = 'https://api.openalex.org/works'
const DEFAULT_MAILTO = 'sati@users.noreply.github.com'

/** 创建 OpenAlex 连接器的选项（polite pool 邮箱等）。 */
interface CreateOpenAlexConnectorOptions extends ConnectorHttpOptions {
  /** polite pool 标识邮箱；默认回退 OPENALEX_MAILTO 环境变量。 */
  mailto?: string
}

interface Authorship {
  author?: { display_name?: string }
}

interface Location {
  source?: { display_name?: string }
  landing_page_url?: string
  pdf_url?: string
}

interface Work {
  id?: string
  doi?: string
  title?: string
  display_name?: string
  publication_year?: number
  cited_by_count?: number
  abstract_inverted_index?: Record<string, number[]> | null
  authorships?: Authorship[]
  primary_location?: Location
  best_oa_location?: Location
  open_access?: { oa_url?: string }
  relevance_score?: number
}

interface SearchResponse {
  results?: Work[]
  meta?: { count?: number }
}

function shortId(id?: string): string {
  return (id ?? '').replace(/^https?:\/\/openalex\.org\//i, '')
}

function authors(w: Work): string | undefined {
  return formatAuthors((w.authorships ?? []).map(a => a.author?.display_name))
}

/** Best open-access PDF link: the best-oa location's pdf, else the oa_url. */
function pdfUrlOf(w: Work): string | undefined {
  return w.best_oa_location?.pdf_url || w.open_access?.oa_url || undefined
}

function toHit(w: Work): ConnectorHit {
  const meta = [authors(w), w.primary_location?.source?.display_name, w.publication_year].filter(Boolean).join('. ')
  return {
    id: shortId(w.id) || (w.doi ?? ''),
    title: snippet(w.display_name ?? w.title, 300) ?? (shortId(w.id) || 'Untitled'),
    summary: snippet(fromInverted(w.abstract_inverted_index)) ?? nonEmpty(meta),
    url: w.id ?? w.primary_location?.landing_page_url ?? w.doi ?? undefined,
    score: typeof w.relevance_score === 'number' ? w.relevance_score : w.cited_by_count,
    extra: { ...raw(w), ...(pdfUrlOf(w) === undefined ? {} : { pdf_url: pdfUrlOf(w) }) },
  }
}

/**
 * 创建 OpenAlex 开放学术图谱连接器。
 * @param options - 连接器选项（polite pool 邮箱、fetch 注入）。
 * @returns OpenAlex 连接器。
 */
export function createOpenAlexConnector(options: CreateOpenAlexConnectorOptions = {}): Connector {
  const { client, http } = connectorHttp(options)
  const polite = (): string => {
    const email = options.mailto?.trim() || process.env.OPENALEX_MAILTO?.trim() || DEFAULT_MAILTO
    return `mailto=${encodeURIComponent(email)}`
  }
  return {
    id: 'openalex',
    name: 'OpenAlex',
    domain: 'literature',
    description: 'Open scholarly graph of works, authors, venues, and concepts (successor to MAG).',
    homepage: 'https://openalex.org',
    async search(query, opts) {
      const per = clampLimit(opts?.limit)
      const data = await client.getJSON<SearchResponse>(
        `${BASE}?search=${encodeURIComponent(query)}&per-page=${per}&${polite()}`,
        { ...http, signal: opts?.signal },
      )
      return (data.results ?? []).map(toHit)
    },
    async fetch(id, opts) {
      // OpenAlex 接受裸 work id（W…）或 DOI 原样路径段（"works/doi:10.x/y"）；
      // DOI 的斜杠/冒号不能编码。
      const path = /^10\.\d/.test(id) ? `doi:${id}` : encodeURIComponent(shortId(id) || id)
      const data = await client.getJSON<Work | null>(`${BASE}/${path}?${polite()}`, { ...http, signal: opts?.signal })
      return data ?? null
    },
  }
}
