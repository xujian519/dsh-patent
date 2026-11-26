import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createPatentCaseSearchTool } from '../src/tool/patent-case-search.ts'
import { createPatentCorpusStatusTool } from '../src/tool/patent-corpus-status.ts'
import { createPatentWikiSearchTool, PATENT_WIKI_DIRS } from '../src/tool/patent-wiki-search.ts'
import { createPatentKgQueryTool } from '../src/tool/patent-kg-query.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const signal = new AbortController().signal

async function ctxWith(...tools: ToolDefinition[]): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  for (const t of tools) ctx.tools.register(t)
  return ctx
}

function execute(ctx: Context, name: string, args: unknown, label: string) {
  return executeToolFixture(ctx, { signal, callId: ToolCallId(label), name, arguments: args })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
}

describe('patent_case_search', () => {
  const hit = {
    documentId: 'd1', docType: 'case', title: 'T', decisionNumber: '566693', caseNumber: undefined,
    court: undefined, source: undefined, module: undefined, charCount: 10, chunkIndex: 0,
    snippet: 'snippet', ftsRank: -1.5, via: 'fts' as const,
  }

  it('searches and renders hits', async () => {
    const tool = createPatentCaseSearchTool({ search: () => [hit] })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_case_search', { query: '创造性' }, 'c-1')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('d1')
    expect(text(result)).toContain('snippet')
  })

  it('renders the corpus freshness the reader supplies', async () => {
    const tool = createPatentCaseSearchTool({
      search: () => [hit],
      corpusInfo: () => ({
        dbPath: '/tmp/knowledge.db',
        lastIndexedAt: '2026-07-02T10:59:39.174Z',
        version: 3,
        documents: 81038,
        chunks: 138609,
        fileModifiedAt: '2026-08-19T11:00:00.000Z',
      }),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_case_search', { query: '创造性' }, 'c-corpus')
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('语料：上游索引 2026-07-02T10:59:39.174Z · 版本 3 · 81038 文档 / 138609 分块')
  })

  it('fails loud when the corpus reader throws', async () => {
    const tool = createPatentCaseSearchTool({
      search: () => [hit],
      corpusInfo: () => { throw new Error('database is locked') },
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_case_search', { query: 'x' }, 'c-corpus-fail')
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('database is locked')
  })

  it('fails loud when the db is absent', async () => {
    const tool = createPatentCaseSearchTool({ search: () => [hit], dbPath: '/nonexistent/knowledge.db' })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_case_search', { query: 'x' }, 'c-2')
    expect(result.isError).toBe(true)
  })

  it('truncates a fractional limit before calling the search', async () => {
    const seen: number[] = []
    const tool = createPatentCaseSearchTool({
      search: (_query, options) => { seen.push(options?.limit ?? 0); return [hit] },
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_case_search', { query: 'x', limit: 2.9 }, 'c-3')
    expect(result.isError).toBe(false)
    expect(seen).toEqual([2])
  })

  it('records only the supplied filter in the search strategy', async () => {
    const seen: { docType?: string; court?: string }[] = []
    const tool = createPatentCaseSearchTool({
      search: (_query, options) => {
        seen.push({
          ...(options?.docType === undefined ? {} : { docType: options.docType }),
          ...(options?.court === undefined ? {} : { court: options.court }),
        })
        return [hit]
      },
    })
    const ctx = await ctxWith(tool)
    const byType = await execute(ctx, 'patent_case_search', { query: 'x', doc_type: 'judgment' }, 'c-4')
    expect(seen[0]).toEqual({ docType: 'judgment' })
    expect((byType.value as { searchStrategy: { filters?: Record<string, string> } }).searchStrategy.filters)
      .toEqual({ docType: 'judgment' })

    const byCourt = await execute(ctx, 'patent_case_search', { query: 'x', court: '最高人民法院' }, 'c-5')
    expect(seen[1]).toEqual({ court: '最高人民法院' })
    expect((byCourt.value as { searchStrategy: { filters?: Record<string, string> } }).searchStrategy.filters)
      .toEqual({ court: '最高人民法院' })
  })
})

describe('patent_wiki_search', () => {
  it('maps the four drafting directories', () => {
    expect(PATENT_WIKI_DIRS.claims).toBe('专利实务/权利要求')
    expect(PATENT_WIKI_DIRS.specification).toBe('专利实务/说明书')
  })

  it('searches with a directory prefix', async () => {
    const meta = { id: '专利实务/权利要求/x', title: 'X', relativePath: '专利实务/权利要求/x.md', concept: 'c', domain: undefined }
    const tool = createPatentWikiSearchTool({ searchIn: () => [meta], formatAsContext: () => 'body' })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_wiki_search', { query: 'x', dir: 'claims', include_body: true }, 'w-1')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('X')
  })
})

describe('patent_kg_query', () => {
  const node = { id: 'CASE_1', nodeType: 'Case', name: 'n', title: 'T' }
  const adapter = {
    getNode: (id: string) => (id === 'CASE_1' ? node : undefined),
    searchRelevant: () => [{ node, via: 'keyword' as const }],
    getSimilarNodes: () => [],
    getNeighbors: () => [],
    listByType: () => [node],
  }

  it('queries by keyword', async () => {
    const tool = createPatentKgQueryTool({ adapter })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_kg_query', { query: '创造性' }, 'k-1')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('CASE_1')
  })

  it('queries by id with neighbor expansion', async () => {
    const tool = createPatentKgQueryTool({ adapter })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_kg_query', { id: 'CASE_1' }, 'k-2')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('CASE_1')
  })

  it('throws when neither query/id/node_type is given', async () => {
    const tool = createPatentKgQueryTool({ adapter })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_kg_query', {}, 'k-3')
    expect(result.isError).toBe(true)
  })

  it('truncates a fractional limit before querying the graph', async () => {
    const seen: number[] = []
    const recording = {
      ...adapter,
      searchRelevant: (_query: string, options?: { keywordLimit?: number }) => {
        seen.push(options?.keywordLimit ?? 0)
        return [{ node, via: 'keyword' as const }]
      },
    }
    const tool = createPatentKgQueryTool({ adapter: recording })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_kg_query', { query: 'x', limit: 2.9 }, 'k-4')
    expect(result.isError).toBe(false)
    expect(seen).toEqual([2])
  })
})

describe('patent_corpus_status', () => {
  const corpus = {
    dbPath: '/tmp/knowledge.db',
    lastIndexedAt: '2026-07-02T10:59:39.174Z',
    version: 3,
    versionCreatedAt: '2026-07-02T10:00:00.000Z',
    documents: 81038,
    chunks: 138609,
    fileModifiedAt: '2026-08-19T11:00:00.000Z',
  }

  it('reports the corpus facts without running a search', async () => {
    const tool = createPatentCorpusStatusTool({ corpusInfo: () => corpus })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_corpus_status', {}, 'cs-1')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const out = text(result)
    expect(out).toContain('上游索引 2026-07-02T10:59:39.174Z')
    expect(out).toContain('本机副本 2026-08-19T11:00:00.000Z')
    expect(out).toContain('版本创建：2026-07-02T10:00:00.000Z')
    expect(result.value).toMatchObject({ dbPath: '/tmp/knowledge.db', documents: 81038, chunks: 138609 })
  })

  it('fails loud when the knowledge service is not mounted', async () => {
    const tool = createPatentCorpusStatusTool({})
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_corpus_status', {}, 'cs-2')
    expect(result.isError).toBe(true)
  })

  it('fails loud when the db is absent', async () => {
    const tool = createPatentCorpusStatusTool({
      corpusInfo: () => corpus,
      dbPath: '/nonexistent/knowledge.db',
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_corpus_status', {}, 'cs-3')
    expect(result.isError).toBe(true)
  })
})
