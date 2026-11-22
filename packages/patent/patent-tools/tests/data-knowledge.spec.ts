import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ScrapeResult } from '@deepseek-ai/nuo-patent'
import { createPatentSearchTool, dedupeByFamily } from '../src/tool/patent-search.ts'
import { createPatentMetadataTool } from '../src/tool/patent-metadata.ts'
import { createPatentLegalStatusTool } from '../src/tool/patent-legal-status.ts'
import { createPatentCaseSearchTool } from '../src/tool/patent-case-search.ts'
import { createPatentWikiSearchTool } from '../src/tool/patent-wiki-search.ts'
import { createPatentKgQueryTool } from '../src/tool/patent-kg-query.ts'
import type { KgAdapter } from '../src/tool/patent-kg-query.ts'
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

let temp: string | undefined

afterEach(async () => {
  if (temp !== undefined) {
    await rm(temp, { recursive: true, force: true })
    temp = undefined
  }
})

describe('patent_search failure and render paths', () => {
  it('maps timeout / empty-query / failure warnings to typed errors', async () => {
    for (const [warning, label] of [
      ['检索超时（30s）', 'ps-t'],
      ['查询条件为空', 'ps-e'],
      ['检索失败: network unreachable', 'ps-f'],
    ] as const) {
      const tool = createPatentSearchTool({
        searchRetryDelaysMs: [],
        search: async () => ({ query: 'q', total: 0, hits: [], warnings: [warning] }),
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'patent_search', { query: 'q' }, label)
      expect(result.isError).toBe(true)
    }
  })

  it('retries a transient upstream failure and returns the recovered hits', async () => {
    const hit = {
      patent: 'CN1A', title: 'T', assignee: 'A', publication_date: '2024-01-01',
      priority_date: '', abstract: '', url: 'u',
    }
    let calls = 0
    const tool = createPatentSearchTool({
      searchRetryDelaysMs: [0, 0],
      search: async () => {
        calls += 1
        return calls === 1
          ? { query: 'q', total: 0, hits: [], warnings: ['检索失败: fetch failed'] }
          : { query: 'q', total: 1, hits: [hit], warnings: [] }
      },
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_search', { query: 'q' }, 'ps-retry-ok')
    expect(result.isError).toBe(false)
    expect(calls).toBe(2)
    expect(text(result)).toContain('**patent**: CN1A')
  })

  it('reports the attempts made when the failure outlives the retries', async () => {
    let calls = 0
    const tool = createPatentSearchTool({
      searchRetryDelaysMs: [0, 0],
      search: async () => {
        calls += 1
        return { query: 'q', total: 0, hits: [], warnings: ['检索失败: fetch failed'] }
      },
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_search', { query: 'q' }, 'ps-retry-dead')
    expect(result.isError).toBe(true)
    expect(calls).toBe(3)
    expect(text(result)).toContain('已退避重试 2 次仍未成功')
  })

  it('does not retry a non-transient failure (empty query)', async () => {
    let calls = 0
    const tool = createPatentSearchTool({
      searchRetryDelaysMs: [0, 0],
      search: async () => {
        calls += 1
        return { query: 'q', total: 0, hits: [], warnings: ['查询条件为空'] }
      },
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_search', { query: 'q' }, 'ps-retry-empty')
    expect(result.isError).toBe(true)
    expect(calls).toBe(1)
  })

  it('stops retrying once the call is aborted', async () => {
    const controller = new AbortController()
    let calls = 0
    const tool = createPatentSearchTool({
      searchRetryDelaysMs: [0, 0],
      search: async () => {
        calls += 1
        controller.abort()
        return { query: 'q', total: 0, hits: [], warnings: ['检索失败: fetch failed'] }
      },
    })
    const ctx = await ctxWith(tool)
    const result = await executeToolFixture(ctx, {
      signal: controller.signal,
      callId: ToolCallId('ps-retry-abort'),
      name: 'patent_search',
      arguments: { query: 'q' },
    })
    expect(result.isError).toBe(true)
    expect(calls).toBe(1)
  })

  it('renders a sparse hit with fallbacks', async () => {
    const fake = {
      query: 'q',
      total: 1,
      hits: [{ patent: 'CN1A', title: '', assignee: '', publication_date: '', priority_date: '', abstract: '', url: 'u' }],
      warnings: [],
    }
    const tool = createPatentSearchTool({ search: async () => fake })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_search', { query: 'q' }, 'ps-s')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const out = text(result)
    expect(out).toContain('**patent**: CN1A')
    expect(out).toContain('**assignee**: N/A')
  })

  it('names the channel in a hit render and in an upstream failure', async () => {
    const hit = {
      patent: 'CN1A', title: 'T', assignee: 'A', publication_date: '2024-01-01',
      priority_date: '', abstract: '', url: 'u',
    }
    const okTool = createPatentSearchTool({ search: async () => ({ query: 'q', total: 1, hits: [hit], warnings: [] }) })
    const okCtx = await ctxWith(okTool)
    const ok = await execute(okCtx, 'patent_search', { query: 'q' }, 'ps-ch-ok')
    expect(ok.isError).toBe(false)
    expect(text(ok)).toContain('channel: Google Patents（nuo 引擎）')

    const failTool = createPatentSearchTool({
      searchRetryDelaysMs: [],
      search: async () => ({ query: 'q', total: 0, hits: [], warnings: ['检索失败: fetch failed'] }),
    })
    const failCtx = await ctxWith(failTool)
    const failed = await execute(failCtx, 'patent_search', { query: 'q' }, 'ps-ch-fail')
    expect(failed.isError).toBe(true)
    const message = text(failed)
    expect(message).toContain('通道 Google Patents（nuo 引擎）：检索失败: fetch failed')
    expect(message).not.toContain('CNIPR')
  })

  it('builds a cached search tool without an injected search', () => {
    expect(createPatentSearchTool().name).toBe('patent_search')
    expect(createPatentMetadataTool().name).toBe('patent_metadata')
    expect(createPatentLegalStatusTool().name).toBe('patent_legal_status')
  })
})

describe('dedupeByFamily edge cases', () => {
  it('keeps unmatched patents and drops older variants without dates', () => {
    const hits = [
      { patent: 'zzz', title: 'no-base', assignee: '', publication_date: '', priority_date: '', abstract: '', url: 'u' },
      { patent: 'CN1A', title: 'a', assignee: '', publication_date: '2023-01-01', priority_date: '', abstract: '', url: 'u' },
      { patent: 'CN1B', title: 'b', assignee: '', publication_date: '2022-01-01', priority_date: '', abstract: '', url: 'u' },
      { patent: 'CN1C', title: 'c', assignee: '', publication_date: '', priority_date: '', abstract: '', url: 'u' },
      { patent: 'CN2A', title: 'd', assignee: '', publication_date: '', priority_date: '', abstract: '', url: 'u' },
      { patent: 'CN2B', title: 'e', assignee: '', publication_date: '', priority_date: '', abstract: '', url: 'u' },
    ]
    const { hits: deduped, warnings } = dedupeByFamily(hits, [])
    expect(deduped.map(h => h.patent)).toEqual(['zzz', 'CN1A', 'CN2A'])
    expect(warnings.some(w => w.includes('CN1'))).toBe(true)
    expect(warnings.some(w => w.includes('CN2'))).toBe(true)
  })
})

describe('patent_metadata failure and render paths', () => {
  function scrapeResult(over: Record<string, unknown>): ScrapeResult {
    return {
      success: false,
      patent: 'US1A',
      url: 'u',
      data: null,
      errorCode: 'VALIDATION_ERROR',
      errorMessage: 'bad number',
      parseWarnings: [],
      ...over,
    }
  }

  it('maps VALIDATION_ERROR / TIMEOUT / unknown error codes to typed errors', async () => {
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ errorCode: 'VALIDATION_ERROR' }, 'pm-v', 'invalid_tool_input'],
      [{ errorCode: 'TIMEOUT' }, 'pm-t', 'tool_timeout'],
      [{ errorCode: 'OTHER' }, 'pm-o', 'tool_execution_failed'],
    ]
    for (const [over, label] of cases) {
      const tool = createPatentMetadataTool({ scrape: async () => scrapeResult(over) })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'patent_metadata', { patent: 'US1A' }, label)
      expect(result.isError).toBe(true)
    }
  })

  it('names the channel and the attempts made in a failed lookup', async () => {
    let attempts = 0
    const tool = createPatentMetadataTool({
      scrapeRetryDelaysMs: [0, 0],
      scrape: async () => {
        attempts += 1
        return scrapeResult({ errorCode: 'HTTP_ERROR', errorMessage: 'HTTP 503' })
      },
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_metadata', { patent: 'US1A' }, 'pm-ch-fail')
    expect(result.isError).toBe(true)
    expect(attempts).toBe(3)
    const message = text(result)
    expect(message).toContain('通道 Google Patents（nuo 引擎）：HTTP 503；已退避重试 2 次仍未成功')
    expect(message).toContain('上游限流')
    expect(message).not.toContain('CNIPR')
  })

  it('asks for a spaced retry on a rate-limited upstream and a plain retry otherwise', async () => {
    const rateLimited = createPatentMetadataTool({
      scrapeRetryDelaysMs: [0, 0],
      scrape: async () => scrapeResult({ errorCode: 'HTTP_ERROR', errorMessage: 'HTTP 503' }),
    })
    const rateLimitedResult = await execute(await ctxWith(rateLimited), 'patent_metadata', { patent: 'US1A' }, 'pm-rate-limit')
    expect(rateLimitedResult.isError).toBe(true)
    expect(text(rateLimitedResult)).toContain('上游限流或过载（可持续数分钟），请间隔数分钟再试')

    const transient = createPatentMetadataTool({
      scrapeRetryDelaysMs: [0, 0],
      scrape: async () => scrapeResult({ errorCode: 'NETWORK_ERROR', errorMessage: 'fetch failed' }),
    })
    const transientResult = await execute(await ctxWith(transient), 'patent_metadata', { patent: 'US1A' }, 'pm-transient')
    expect(transientResult.isError).toBe(true)
    expect(text(transientResult)).toContain('上游瞬时失败，可稍后重试')
    expect(text(transientResult)).not.toContain('上游限流')
  })

  it('renders the channel of a not-found lookup', async () => {
    const tool = createPatentMetadataTool({ scrape: async () => scrapeResult({ errorCode: 'NOT_FOUND', errorMessage: '查无此专利' }) })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_metadata', { patent: 'US1A' }, 'pm-ch-nf')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('patent_metadata(US1A) · channel: Google Patents（nuo 引擎）: 查无此专利')
  })

  it('rejects an invalid patent number', async () => {
    const tool = createPatentMetadataTool({ scrape: async () => scrapeResult({}) })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_metadata', { patent: 'no' }, 'pm-i')
    expect(result.isError).toBe(true)
  })

  it('renders pdf url and abstract alongside N/A fallbacks', async () => {
    const tool = createPatentMetadataTool({
      scrape: async patent => ({
        success: true,
        patent,
        url: 'u',
        data: {
          title: 'T',
          application_number: '',
          inventor_name: '[]',
          assignee_name_orig: '[]',
          assignee_name_current: '[]',
          pub_date: '',
          filing_date: '',
          priority_date: '',
          grant_date: '',
          expiration_date: '',
          legal_status: '',
          ifi_status: '',
          estimated_expiration: '2030-01-01',
          pdf_url: 'https://p/pdf',
          classifications: '[]',
          forward_cite_no_family: '[]',
          forward_cite_yes_family: '[]',
          backward_cite_no_family: '[]',
          backward_cite_yes_family: '[]',
          abstract_text: '摘要',
        },
        errorCode: '',
        errorMessage: '',
        parseWarnings: [],
      }),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_metadata', { patent: 'CN1A' }, 'pm-r')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const out = text(result)
    expect(out).toContain('**inventors**: N/A')
    expect(out).toContain('**channel**: Google Patents（nuo 引擎）')
    expect(out).toContain('**pdf**: https://p/pdf')
    expect(out).toContain('est. expiration 2030-01-01')
    expect(out).toContain('摘要')
  })

  it('renders without a pdf url or abstract', async () => {
    const tool = createPatentMetadataTool({
      scrape: async patent => ({
        success: true,
        patent,
        url: 'u',
        data: {
          title: 'T', application_number: '', inventor_name: '[]', assignee_name_orig: '[]', assignee_name_current: '[]',
          pub_date: '', filing_date: '', priority_date: '', grant_date: '', expiration_date: '', legal_status: '',
          ifi_status: '', estimated_expiration: '', pdf_url: '', classifications: '[]',
          forward_cite_no_family: '[]', forward_cite_yes_family: '[]', backward_cite_no_family: '[]', backward_cite_yes_family: '[]',
          abstract_text: '',
        },
        errorCode: '',
        errorMessage: '',
        parseWarnings: [],
      }),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_metadata', { patent: 'CN1A' }, 'pm-r2')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const out = text(result)
    expect(out).not.toContain('**pdf**:')
    expect(out).not.toContain('摘要')
  })
})

describe('patent_legal_status render and batch paths', () => {
  const okItem = {
    patent_number: 'US1A', title: 'T', status: 'Active', ifi_status: 'x', estimated_expiration: '2030',
    filing_date: '2010', grant_date: '2012', applicant: 'A', inventor: 'I', events_summary: [], url: 'u',
  }

  it('renders error flags, unknown status, and missing results', async () => {
    const checker = {
      checkBatch: async () => ({
        US1A: { ...okItem, title: '', status: 'UNKNOWN', estimated_expiration: '' },
        US2A: { ...okItem, patent_number: 'US2A', title: '', estimated_expiration: '', error: '查无此专利' },
        US4A: { ...okItem, patent_number: 'US4A', title: '', status: '', estimated_expiration: '' },
      }),
    }
    const tool = createPatentLegalStatusTool({ checker })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_legal_status', { patents: ['US1A', 'US2A', 'US3A', 'US4A'] }, 'pls-1')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const out = text(result)
    expect(out).toContain('⚠️ US1A')
    expect(out).toContain('❌ US2A')
    expect(out).toContain('查无此专利')
    expect(out).toContain('未知状态')
    expect(out).toContain('US4A: 未知状态 (UNKNOWN)')
  })

  it('truncates the batch over the 20-item cap', async () => {
    const patents = Array.from({ length: 21 }, (_, i) => `US${i + 1}A`)
    const checker = { checkBatch: async () => ({}) }
    const tool = createPatentLegalStatusTool({ checker })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_legal_status', { patents }, 'pls-2')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('1 个专利号超出 20 条上限被截断')
  })
})

describe('patent_case_search deeper paths', () => {
  const hit = {
    documentId: 'd1', docType: 'case', title: 'T', decisionNumber: '566693', caseNumber: 'CN-1', court: '北京知产法院',
    source: 'src', module: 'm', charCount: 10, chunkIndex: 0, snippet: '短'.repeat(900), ftsRank: -1.5, via: 'fts' as const,
  }

  it('searches with filters, truncates long snippets, and renders every field', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-patent-tools-case-'))
    await writeFile(join(temp, 'knowledge.db'), '')
    const tool = createPatentCaseSearchTool({ search: () => [hit], dbPath: join(temp, 'knowledge.db') })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_case_search', {
      query: '创造性', doc_type: 'case', court: '北京', include_content: true,
    }, 'pcs-1')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const out = text(result)
    expect(out).toContain('**decision**: 566693')
    expect(out).toContain('**case**: CN-1')
    expect(out).toContain('**court**: 北京知产法院')
    expect(out).toContain('（截断')
  })

  it('skips optional fields and null ftsRank in a sparse hit', async () => {
    const sparse = { ...hit, decisionNumber: undefined, caseNumber: undefined, court: undefined, source: undefined, snippet: 's', ftsRank: null, charCount: 1 }
    const tool = createPatentCaseSearchTool({ search: () => [sparse] })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_case_search', { query: 'x', include_content: false }, 'pcs-2')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const out = text(result)
    expect(out).not.toContain('**decision**:')
    expect(out).not.toContain('**case**:')
    expect(out).not.toContain('snippet')
  })

  it('renders a zero-hit result and fails loud without search deps', async () => {
    const empty = createPatentCaseSearchTool({ search: () => [] })
    const ctxE = await ctxWith(empty)
    const zero = await execute(ctxE, 'patent_case_search', { query: 'x' }, 'pcs-4')
    expect(zero.isError).toBe(false)
    if (zero.isError) throw new Error('expected success')
    expect(text(zero)).toContain('0 条判例命中')

    const noSearch = createPatentCaseSearchTool({ dbPath: '/nonexistent' })
    const ctxN = await ctxWith(noSearch)
    const missing = await execute(ctxN, 'patent_case_search', { query: 'x' }, 'pcs-5')
    expect(missing.isError).toBe(true)
  })

  it('maps a throwing search to a setup_required failure with cause', async () => {
    const tool = createPatentCaseSearchTool({ search: () => { throw new Error('db locked') } })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_case_search', { query: 'x' }, 'pcs-3')
    expect(result.isError).toBe(true)
  })

  it('maps a non-Error search failure to a setup_required failure', async () => {
    const tool = createPatentCaseSearchTool({ search: () => { throw 'db-unlocked-string' } })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_case_search', { query: 'x' }, 'pcs-6')
    expect(result.isError).toBe(true)
  })
})

describe('patent_wiki_search deeper paths', () => {
  it('searches all directories without a dir filter and renders sparse metadata', async () => {
    const meta = { id: '专利实务/x', title: 'X', relativePath: '专利实务/x.md', domain: '电学' }
    const tool = createPatentWikiSearchTool({
      searchIn: () => [meta],
      formatAsContext: () => '',
      wikiDir: '/wiki',
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_wiki_search', { query: 'x' }, 'pws-1')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const out = text(result)
    expect(out).toContain('**领域**: 电学')
    expect(out).not.toContain('**概念**')
    expect(out).not.toContain('**path**: /wiki')
  })

  it('renders a zero-hit result', async () => {
    const tool = createPatentWikiSearchTool({ searchIn: () => [], formatAsContext: () => '' })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_wiki_search', { query: 'x' }, 'pws-2')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('0 张卡片命中')
  })

  it('fails loud without search deps', async () => {
    const tool = createPatentWikiSearchTool({})
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_wiki_search', { query: 'x' }, 'pws-3')
    expect(result.isError).toBe(true)
  })

  it('attaches a body when include_body is set and formatAsContext returns one', async () => {
    const tool = createPatentWikiSearchTool({
      searchIn: () => [{ id: '专利实务/x', title: 'X', relativePath: '专利实务/x.md' }],
      formatAsContext: () => '卡片正文',
      wikiDir: '/wiki',
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_wiki_search', { query: 'x', dir: 'claims', include_body: true }, 'pws-4')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const out = text(result)
    expect(out).toContain('卡片正文')
    expect(out).toContain('**path**: 专利实务/x.md')
  })

  it('omits the body when formatAsContext returns an empty string', async () => {
    const tool = createPatentWikiSearchTool({
      searchIn: () => [{ id: '专利实务/x', title: 'X', relativePath: '专利实务/x.md' }],
      formatAsContext: () => '',
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_wiki_search', { query: 'x', include_body: true }, 'pws-5')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).not.toContain('卡片正文')
  })

  it('caps the argument-free listing at limit and states that cap in the parameter descriptions', async () => {
    const seen: number[] = []
    const tool = createPatentWikiSearchTool({
      searchIn: (_prefix, _query, limit) => { seen.push(limit); return [] },
      formatAsContext: () => '',
      wikiDir: '/wiki',
    })
    const ctx = await ctxWith(tool)
    const properties = (ctx.tools.get('patent_wiki_search')?.parameters as {
      properties: Record<string, { description: string }>
    }).properties
    expect(properties['limit']?.description).toBe('返回条数上限（默认 5，最大 10）')
    expect(properties['query']?.description).toContain('条数受 limit 约束')

    await execute(ctx, 'patent_wiki_search', { query: '' }, 'pws-cap-1')
    await execute(ctx, 'patent_wiki_search', { query: '', limit: 50 }, 'pws-cap-2')
    expect(seen).toEqual([5, 10])
  })
})

describe('patent_kg_query deeper paths', () => {
  const node = {
    id: 'CASE_1', nodeType: 'Case', name: 'n', title: 'T',
    content: '长'.repeat(700),
  }
  const node2 = { id: 'CASE_2', nodeType: 'Case', name: 'n2' }
  const node3 = { id: 'CASE_3', nodeType: 'Case', title: 'T3' }
  const node4 = { id: 'CASE_4', nodeType: 'Case' }
  const adapter: KgAdapter = {
    getNode: id => (id === 'CASE_1' ? node : id === 'CASE_2' ? node2 : undefined),
    searchRelevant: () => [
      { node, via: 'keyword' as const },
      { node: node2, via: 'similar' as const, relation: 'similar' },
      { node: node4, via: 'keyword' as const },
    ],
    getSimilarNodes: () => [{ node, relation: 'similar' }, { node: node3, relation: 'similar' }],
    getNeighbors: () => [
      { targetId: 'CASE_1', relation: 'CITES' },
      { targetId: 'CASE_2', relation: 'CITES' },
      { targetId: 'MISSING', relation: 'CITES' },
    ],
    listByType: type => (type === 'SupremeCourtJudgment' ? [node, node2, node] : [node2]),
  }

  it('queries by keyword without expansion and truncates long content', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-patent-tools-kg-'))
    await writeFile(join(temp, 'query.db'), '')
    const tool = createPatentKgQueryTool({ adapter, dbPath: join(temp, 'query.db') })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_kg_query', {
      query: '创造性', expand: false, include_content: true, limit: 5,
    }, 'pkg-1')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const out = text(result)
    expect(out).toContain('CASE_1')
    expect(out).toContain('（截断')
    expect(out).not.toContain('via similar')
  })

  it('expands hits and renders a bare-id node', async () => {
    const tool = createPatentKgQueryTool({ adapter })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_kg_query', { query: '创造性', expand: true }, 'pkg-1b')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const out = text(result)
    expect(out).toContain('via similar')
    expect(out).toContain('CASE_4')
  })

  it('expands neighbors by id, skipping duplicate and missing targets', async () => {
    const tool = createPatentKgQueryTool({ adapter })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_kg_query', { id: 'CASE_1', include_content: true }, 'pkg-2')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const out = text(result)
    expect(out).toContain('CASE_1')
    expect(out).toContain('邻居:')
    expect(out).toContain('CASE_2')
    expect(out).not.toContain('MISSING')
  })

  it('browses node types with alias expansion and dedupe', async () => {
    const tool = createPatentKgQueryTool({ adapter })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_kg_query', { node_type: 'Judgment', limit: 5 }, 'pkg-3')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('CASE_1')
  })

  it('breaks the type browse early at the limit', async () => {
    const capped = createPatentKgQueryTool({ adapter })
    const ctx = await ctxWith(capped)
    const result = await execute(ctx, 'patent_kg_query', { node_type: 'Judgment', limit: 1 }, 'pkg-3b')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('CASE_1')
  })

  it('returns zero hits for an unknown id', async () => {
    const tool = createPatentKgQueryTool({ adapter })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_kg_query', { id: 'NOPE' }, 'pkg-4')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('0 个节点命中')
  })

  it('clamps the limit into [1, 10]', async () => {
    const tool = createPatentKgQueryTool({ adapter })
    const ctx = await ctxWith(tool)
    const high = await execute(ctx, 'patent_kg_query', { query: 'x', limit: 99 }, 'pkg-5')
    expect(high.isError).toBe(false)
    const low = await execute(ctx, 'patent_kg_query', { query: 'x', limit: 0 }, 'pkg-6')
    expect(low.isError).toBe(false)
  })

  it('fails loud without an adapter or with a missing db', async () => {
    const noAdapter = createPatentKgQueryTool({})
    const ctxA = await ctxWith(noAdapter)
    const resultA = await execute(ctxA, 'patent_kg_query', { query: 'x' }, 'pkg-7')
    expect(resultA.isError).toBe(true)

    temp = await mkdtemp(join(tmpdir(), 'dsh-patent-tools-kg-'))
    const missingDb = createPatentKgQueryTool({ adapter, dbPath: join(temp, 'nope.db') })
    const ctxB = await ctxWith(missingDb)
    const resultB = await execute(ctxB, 'patent_kg_query', { query: 'x' }, 'pkg-8')
    expect(resultB.isError).toBe(true)
  })
})
