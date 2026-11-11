/**
 * `paper_search` tool: search academic papers through the literature Connector registry.
 *
 * Pairs with `paper_list_sources` (discover `db` ids first). Source errors (rate limiting,
 * unavailability) surface as a structured failure with actionable guidance, distinct from a
 * genuine zero-hit result.
 * @module @deepseek-ai/dsh-tool-literature/tool/paper-search
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ConnectorHit } from '../protocol/types.ts'
import type { ConnectorRegistry } from '../runtime/connector-registry.ts'
import { LiteratureToolError } from '../error.ts'
import { clampLimit } from '../runtime/shared/text.ts'
import { describeSourceError } from './source-error.ts'

/** Input for the paper_search tool. */
export type PaperSearchInput = {
  /** Database id (from paper_list_sources, e.g. "arxiv", "openalex"). */
  db: string
  /** Search query in the database's native syntax. */
  query: string
  /** Max hits (1-50, default 10). */
  limit?: number
}

/** Output of the paper_search tool. */
export type PaperSearchOutput = {
  db: string
  query: string
  hits: ConnectorHit[]
}

const DESCRIPTION = [
  '- Searches scholarly literature databases (arXiv, OpenAlex, Semantic Scholar, Crossref) — free, no API key required',
  '- Pass a `db` id (from `paper_list_sources`) and a `query`',
  '- Returns normalized hits: id, title, summary, and URL',
  '- Use for academic papers, preprints, DOI metadata, and research literature',
  '',
  'Usage notes:',
  '  - Call `paper_list_sources` first to discover available `db` ids',
  '  - Fielded queries are supported by arXiv (e.g. `ti:transformer AND cat:cs.LG`); other sources take free-text queries',
  '  - This tool is read-only and does not modify files',
].join('\n')

/** Render the canonical search value into model-facing prose. */
function renderSearch(value: PaperSearchOutput): string {
  const { db, query, hits } = value
  if (hits.length === 0) {
    return `No results for "${query}" in ${db}.`
  }
  const rows = hits.map((h) => {
    const lines = [`## ${h.title}`, `**id**: ${h.id}${h.score !== undefined ? ` · score: ${h.score}` : ''}`]
    if (h.url) lines.push(`**url**: ${h.url}`)
    // Sources disagree on the extra key: arXiv adds `pdf`, the others `pdf_url`.
    const pdf =
      typeof h.extra?.pdf === 'string'
        ? h.extra.pdf
        : typeof h.extra?.pdf_url === 'string'
          ? h.extra.pdf_url
          : undefined
    if (pdf) lines.push(`**pdf**: ${pdf}`)
    if (h.summary) lines.push(h.summary)
    return lines.join('\n')
  })
  return [`**${db}** — ${hits.length} result(s):`, '', rows.join('\n\n---\n\n')].join('\n')
}

/**
 * Build the `paper_search` tool over a given connector registry.
 * @param registry - the literature connector registry to search.
 * @returns a registry-ready tool definition.
 */
export function createPaperSearchTool(registry: ConnectorRegistry): ToolDefinition {
  return defineTool({
    name: 'paper_search',
    description: DESCRIPTION,
    parameters: {
      db: {
        type: 'string',
        required: true,
        description: "Database id to search (from paper_list_sources, e.g. 'arxiv', 'openalex', 'semantic-scholar', 'crossref')",
      },
      query: {
        type: 'string',
        required: true,
        description: "Search query in the database's native syntax. Be specific; arXiv supports fielded syntax like `ti:transformer`.",
      },
      limit: {
        type: 'number',
        description: 'Max results (1-50, default 10)',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          db: { type: 'string', required: true },
          query: { type: 'string', required: true },
          hits: { type: 'array', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSearch(value as unknown as PaperSearchOutput) }],
    },
    execute: async (args, exec) => {
      const connector = registry.get(args.db)
      if (!connector) {
        const available = registry.catalog().map(e => e.id).join(', ')
        throw new LiteratureToolError(
          'invalid_tool_input',
          `No database "${args.db}". Available: ${available || '(none registered)'}. Use paper_list_sources.`,
          { tool: 'paper_search' },
        )
      }

      const query = args.query.trim()
      if (query === '') {
        throw new LiteratureToolError('invalid_tool_input', 'query must be non-empty.', { tool: 'paper_search' })
      }

      const limit = clampLimit(args.limit)
      let hits: ConnectorHit[]
      try {
        hits = await connector.search(query, { limit, signal: exec.signal })
      } catch (err) {
        // Source errors differ from zero hits: surface a structured failure with actionable
        // guidance instead of an empty result the model misreads as "no such paper". Caller
        // cancellation propagates unchanged.
        if (exec.signal.aborted) throw err
        throw new LiteratureToolError('tool_execution_failed', describeSourceError(connector, err), {
          tool: 'paper_search',
          db: connector.id,
        })
      }

      // The output schema declares `hits` as an unconstrained array (matching Sati); the
      // registry validates JSON-safety at the boundary and the connectors produce JSON-safe
      // `ConnectorHit`s, so this cast records that guarantee.
      const hitsJson: JsonValue[] = hits as unknown as JsonValue[]
      return { db: args.db, query, hits: hitsJson }
    },
  })
}
