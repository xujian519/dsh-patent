import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createPatentSearchTool, baseNumber, dedupeByFamily } from '../src/tool/patent-search.ts'
import { createPatentMetadataTool, compactPatentNumber } from '../src/tool/patent-metadata.ts'
import { createPatentLegalStatusTool } from '../src/tool/patent-legal-status.ts'
import { CNIPR_CHANNEL, GOOGLE_PATENTS_CHANNEL } from '../src/tool/internal/upstream-channel.ts'
import type { LegalStatusOptions, PatentData } from '@deepseek-ai/nuo-patent'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const signal = new AbortController().signal

/** Minimal scraped page payload: every field present, every JSON field empty. */
function minimalPatentData(): PatentData {
  return {
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
    estimated_expiration: '',
    pdf_url: '',
    classifications: '[]',
    forward_cite_no_family: '[]',
    forward_cite_yes_family: '[]',
    backward_cite_no_family: '[]',
    backward_cite_yes_family: '[]',
    abstract_text: 'A',
  }
}

async function ctxWith(...tools: ToolDefinition[]): Promise<Context> {
  const ctx = new Context()
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

describe('patent_search', () => {
  it('baseNumber strips the kind code', () => {
    expect(baseNumber('CN115690481A')).toBe('CN115690481')
    expect(baseNumber('US11452699B2')).toBe('US11452699')
    expect(baseNumber('CN115690481')).toBeUndefined()
  })

  it('dedupeByFamily keeps the latest publication per base', () => {
    const hits = [
      { patent: 'CN115690481A', title: 'a', assignee: '', publication_date: '2023-01-01', priority_date: '', abstract: '', url: 'u' },
      { patent: 'CN115690481B', title: 'b', assignee: '', publication_date: '2024-01-01', priority_date: '', abstract: '', url: 'u' },
      { patent: 'US1A', title: 'c', assignee: '', publication_date: '2023-01-01', priority_date: '', abstract: '', url: 'u' },
    ]
    const { hits: deduped, warnings } = dedupeByFamily(hits, [])
    expect(deduped.map(h => h.patent)).toEqual(['CN115690481B', 'US1A'])
    expect(warnings.length).toBe(1)
  })

  it('searches and renders hits', async () => {
    const fake = { query: 'q', total: 1, hits: [{ patent: 'CN115690481A', title: 't', assignee: 'a', publication_date: '2023', priority_date: '2022', abstract: 'abs', url: 'u' }], warnings: [] }
    const tool = createPatentSearchTool({ search: async () => fake })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_search', { query: 'q' }, 's-1')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('patent_search')
    expect(text(result)).toContain('CN115690481A')
  })

  it('clamps limit into [1, 50]', async () => {
    const seen: number[] = []
    const tool = createPatentSearchTool({
      search: async (_query, options) => {
        seen.push(options?.limit ?? -1)
        return { query: 'q', total: 0, hits: [], warnings: [] }
      },
    })
    const ctx = await ctxWith(tool)
    await execute(ctx, 'patent_search', { query: 'q', limit: 0 }, 's-clamp-low')
    await execute(ctx, 'patent_search', { query: 'q', limit: 999 }, 's-clamp-high')
    expect(seen).toEqual([1, 50])
  })

  it('renders the non-fatal warnings alongside the hits', async () => {
    const fake = {
      query: 'q',
      total: 3,
      hits: [
        { patent: 'CN115690481A', title: 'a', assignee: '', publication_date: '2023-01-01', priority_date: '', abstract: '', url: 'u' },
        { patent: 'CN115690481B', title: 'b', assignee: '', publication_date: '2024-01-01', priority_date: '', abstract: '', url: 'u' },
      ],
      warnings: [],
    }
    const tool = createPatentSearchTool({ search: async () => fake })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_search', { query: 'q' }, 's-warn')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const out = text(result)
    expect(out).toContain('## 警告')
    expect(out).toContain('- family 去重：CN115690481* 的 2 篇公开/授权变体合并为 1 篇（保留 CN115690481B 2024-01-01）')
  })

  it('renders the warnings of a zero-hit search', async () => {
    const tool = createPatentSearchTool({
      search: async () => ({ query: 'q', total: 0, hits: [], warnings: ['部分字段未解析：publication_date'] }),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_search', { query: 'q' }, 's-warn-empty')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('- 部分字段未解析：publication_date')
  })

  it('renders no warning section when there is nothing to warn about', async () => {
    const fake = { query: 'q', total: 1, hits: [{ patent: 'CN115690481A', title: 't', assignee: 'a', publication_date: '2023', priority_date: '2022', abstract: 'abs', url: 'u' }], warnings: [] }
    const tool = createPatentSearchTool({ search: async () => fake })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_search', { query: 'q' }, 's-no-warn')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).not.toContain('## 警告')
  })

  it('throws on an empty query', async () => {
    const tool = createPatentSearchTool({ search: async () => ({ query: '', total: 0, hits: [], warnings: [] }) })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_search', { query: '   ' }, 's-2')
    expect(result.isError).toBe(true)
  })
})

describe('patent_search through the CNIPR channel', () => {
  const googleEmpty = { query: '石墨烯电池', total: 0, hits: [], warnings: [] }
  const cnpirHit = {
    patent: 'CN211350734U',
    title: '一种稳定性高的石墨烯电池',
    assignee: '上海碳源汇谷新材料科技有限公司',
    publicationDate: '2020-08-25',
    abstract: '本实用新型属于石墨烯电池技术领域。',
  }

  it('serves a zero-hit engine search through CNIPR and names the channel', async () => {
    const tool = createPatentSearchTool({
      search: async () => googleEmpty,
      cnipr: () => ({ search: async () => ({ total: 655, hits: [cnpirHit] }) }),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_search', { query: '石墨烯电池' }, 's-cnipr-empty')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const out = text(result)
    expect(out).toContain('CN211350734U')
    expect(out).toContain(`channel: ${CNIPR_CHANNEL}`)
    // CNIPR 不发布 URL：缺席的字段整行不渲染，不留一个空 URL 行。
    expect(out).not.toContain('**url**:')
  })

  it('serves a failed engine search through CNIPR instead of failing the call', async () => {
    const tool = createPatentSearchTool({
      search: async () => ({ query: 'q', total: 0, hits: [], warnings: ['检索失败: fetch failed'] }),
      searchRetryDelaysMs: [],
      cnipr: () => ({ search: async () => ({ total: 1, hits: [cnpirHit] }) }),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_search', { query: 'q' }, 's-cnipr-failure')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain(`channel: ${CNIPR_CHANNEL}`)
  })

  it('serves a thrown engine error through CNIPR', async () => {
    const tool = createPatentSearchTool({
      search: async () => { throw new Error('socket hang up') },
      cnipr: () => ({ search: async () => ({ total: 1, hits: [cnpirHit] }) }),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_search', { query: 'q' }, 's-cnipr-thrown')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain(`channel: ${CNIPR_CHANNEL}`)
  })

  it('does not consult CNIPR when the engine already answered', async () => {
    const cniprSearch = vi.fn(async () => ({ total: 0, hits: [] }))
    const tool = createPatentSearchTool({
      search: async () => ({ query: 'q', total: 1, hits: [{ patent: 'US1A', title: 't', assignee: 'a', publication_date: '2023-01-01', priority_date: '', abstract: '', url: 'u' }], warnings: [] }),
      cnipr: () => ({ search: cniprSearch }),
    })
    const ctx = await ctxWith(tool)
    await execute(ctx, 'patent_search', { query: 'q' }, 's-no-second-channel')
    expect(cniprSearch).not.toHaveBeenCalled()
  })

  it('skips CNIPR for Google field syntax and records why', async () => {
    const cniprSearch = vi.fn(async () => ({ total: 1, hits: [cnpirHit] }))
    const tool = createPatentSearchTool({
      search: async () => googleEmpty,
      cnipr: () => ({ search: cniprSearch }),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_search', { query: 'assignee:(Samsung) after:20200101' }, 's-syntax')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(cniprSearch).not.toHaveBeenCalled()
    expect(text(result)).toContain('字段语法（assignee:）')
  })

  it('reports an unusable CNIPR channel without dropping the engine outcome', async () => {
    const tool = createPatentSearchTool({
      search: async () => googleEmpty,
      cnipr: () => ({ search: async () => { throw new Error('CNIPR 通道失败（login_required）：未检测到 CNIPR 登录态') } }),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_search', { query: '石墨烯电池' }, 's-cnipr-down')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const out = text(result)
    expect(out).toContain('## 警告')
    expect(out).toContain(`${CNIPR_CHANNEL}不可用`)
    expect(out).toContain('未检测到 CNIPR 登录态')
  })

  it('keeps the upstream failure when the second channel also misses, and names it', async () => {
    const tool = createPatentSearchTool({
      search: async () => ({ query: 'q', total: 0, hits: [], warnings: ['检索失败: HTTP 503'] }),
      searchRetryDelaysMs: [],
      cnipr: () => ({ search: async () => ({ total: 0, hits: [] }) }),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_search', { query: 'q' }, 's-cnipr-miss')
    expect(result.isError).toBe(true)
    const out = text(result)
    expect(out).toContain('HTTP 503')
    expect(out).toContain(`${CNIPR_CHANNEL}也未命中`)
  })

  it('warns that CNIPR truncates above its per-call ceiling', async () => {
    const tool = createPatentSearchTool({
      search: async () => googleEmpty,
      cnipr: () => ({ search: async () => ({ total: 655, hits: [cnpirHit] }) }),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_search', { query: '石墨烯电池', limit: 50 }, 's-truncate')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('上限 30 条')
  })

  it('runs without a CNIPR lookup at all', async () => {
    const tool = createPatentSearchTool({ search: async () => googleEmpty })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_search', { query: 'q' }, 's-plain')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain(`channel: ${GOOGLE_PATENTS_CHANNEL}`)
  })

  it('passes the caller signal to the CNIPR channel', async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const tool = createPatentSearchTool({
      search: async () => googleEmpty,
      cnipr: () => ({
        search: async (_query, options) => {
          seen = options?.signal
          return { total: 1, hits: [cnpirHit] }
        },
      }),
    })
    await tool.execute({ query: 'q' }, { signal: controller.signal } as never)
    expect(seen).toBe(controller.signal)
  })

  it('names a non-Error CNIPR failure with its string form', async () => {
    const tool = createPatentSearchTool({
      search: async () => googleEmpty,
      cnipr: () => ({
        search: async () => {
          throw 'channel offline'
        },
      }),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_search', { query: 'q' }, 's-cnipr-string')
    expect(text(result)).toContain('channel offline')
  })

  it('rethrows the original engine failure when no second channel is wired', async () => {
    const tool = createPatentSearchTool({
      search: async () => {
        throw new Error('socket hang up')
      },
    })
    await expect(tool.execute({ query: 'q' }, { signal } as never)).rejects.toThrow('socket hang up')
  })
})

describe('patent_metadata', () => {
  it('maps a successful scrape', async () => {
    const tool = createPatentMetadataTool({
      scrape: async patent => ({
        success: true, patent, url: 'https://patents.google.com/patent/CN1',
        data: { title: 'T', application_number: '', inventor_name: '[]', assignee_name_orig: '[]', assignee_name_current: '[]', pub_date: '', filing_date: '', priority_date: '', grant_date: '', expiration_date: '', legal_status: '', ifi_status: '', estimated_expiration: '', pdf_url: '', classifications: '[]', forward_cite_no_family: '[]', forward_cite_yes_family: '[]', backward_cite_no_family: '[]', backward_cite_yes_family: '[]', abstract_text: 'A' },
        errorCode: '' as const, errorMessage: '', parseWarnings: [],
      }),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_metadata', { patent: 'CN1A' }, 'm-1')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('T')
  })

  it('returns success:false for a NOT_FOUND scrape', async () => {
    const tool = createPatentMetadataTool({
      scrape: async patent => ({ success: false, patent, url: 'u', data: null, errorCode: 'NOT_FOUND', errorMessage: 'not found', parseWarnings: [] }),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_metadata', { patent: 'CN1A' }, 'm-2')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('not found')
  })

  it('compacts separators, full-width characters, and a CN application check digit', async () => {
    const seen: string[] = []
    const tool = createPatentMetadataTool({
      scrape: async (patent) => {
        seen.push(patent)
        return { success: false, patent, url: 'u', data: null, errorCode: 'NOT_FOUND', errorMessage: 'not found', parseWarnings: [] }
      },
    })
    const ctx = await ctxWith(tool)
    for (const [index, input] of ['CN202122978405.0', 'ｃｎ２０２１２２９７８４０５.０', 'CN-218483312-U'].entries()) {
      await execute(ctx, 'patent_metadata', { patent: input }, `m-c-${index}`)
    }
    expect(seen).toEqual(['CN202122978405', 'CN202122978405', 'CN218483312U'])
    // 没有国家码前缀时只去掉校验位，不补 CN。
    expect(compactPatentNumber('202122978405.0')).toBe('202122978405')
  })

  it('rejects a number without a country code with actionable guidance', async () => {
    const tool = createPatentMetadataTool({ scrape: async () => { throw new Error('must not scrape') } })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_metadata', { patent: '202122978405' }, 'm-no-cc')
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('中国专利可补国家码')
  })

  it('retries a transient upstream failure and keeps the successful answer', async () => {
    let calls = 0
    const tool = createPatentMetadataTool({
      scrapeRetryDelaysMs: [0, 0],
      scrape: async (patent) => {
        calls += 1
        if (calls === 1) {
          return { success: false, patent, url: 'u', data: null, errorCode: 'HTTP_ERROR', errorMessage: 'HTTP 503', parseWarnings: [] }
        }
        return {
          success: true, patent, url: 'https://patents.google.com/patent/CN1',
          data: { title: 'T', application_number: '', inventor_name: '[]', assignee_name_orig: '[]', assignee_name_current: '[]', pub_date: '', filing_date: '', priority_date: '', grant_date: '', expiration_date: '', legal_status: '', ifi_status: '', estimated_expiration: '', pdf_url: '', classifications: '[]', forward_cite_no_family: '[]', forward_cite_yes_family: '[]', backward_cite_no_family: '[]', backward_cite_yes_family: '[]', abstract_text: 'A' },
          errorCode: '' as const, errorMessage: '', parseWarnings: [],
        }
      },
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_metadata', { patent: 'CN1A' }, 'm-retry')
    expect(result.isError).toBe(false)
    expect(calls).toBe(2)
  })

  it('reports the exhausted retries on a persistent upstream failure', async () => {
    let calls = 0
    const tool = createPatentMetadataTool({
      scrapeRetryDelaysMs: [0],
      scrape: async (patent) => {
        calls += 1
        return { success: false, patent, url: 'u', data: null, errorCode: 'HTTP_ERROR', errorMessage: 'HTTP 503', parseWarnings: [] }
      },
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_metadata', { patent: 'CN1A' }, 'm-retry-out')
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('通道 Google Patents（nuo 引擎）：HTTP 503；已退避重试 1 次仍未成功')
    expect(calls).toBe(2)
  })

  it('does not retry a parse failure', async () => {
    let calls = 0
    const tool = createPatentMetadataTool({
      scrapeRetryDelaysMs: [0],
      scrape: async (patent) => {
        calls += 1
        return { success: false, patent, url: 'u', data: null, errorCode: 'PARSE_ERROR', errorMessage: 'bad page', parseWarnings: [] }
      },
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_metadata', { patent: 'CN1A' }, 'm-parse')
    expect(result.isError).toBe(true)
    expect(calls).toBe(1)
  })

  it('renders the non-fatal parse warnings of a successful scrape', async () => {
    const tool = createPatentMetadataTool({
      scrape: async patent => ({
        success: true,
        patent,
        url: 'https://patents.google.com/patent/CN1',
        data: minimalPatentData(),
        errorCode: '' as const,
        errorMessage: '',
        parseWarnings: [
          { field: 'assigneesCurrent', message: '页面结构变化：申请人字段未解析' },
          { field: 'legalStatus', message: '页面结构变化：法律状态字段未解析' },
        ],
      }),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_metadata', { patent: 'CN1A' }, 'm-warn')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const out = text(result)
    expect(out).toContain('## 警告')
    expect(out).toContain('- assigneesCurrent: 页面结构变化：申请人字段未解析')
    expect(out).toContain('- legalStatus: 页面结构变化：法律状态字段未解析')
  })

  it('renders the parse warnings that accompany a failed lookup', async () => {
    const tool = createPatentMetadataTool({
      scrape: async patent => ({
        success: false,
        patent,
        url: 'u',
        data: null,
        errorCode: 'NOT_FOUND',
        errorMessage: 'not found',
        parseWarnings: [{ field: 'title', message: '页面结构变化：标题未解析' }],
      }),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_metadata', { patent: 'CN1A' }, 'm-warn-fail')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const out = text(result)
    expect(out).toContain('not found')
    expect(out).toContain('## 警告')
    expect(out).toContain('- title: 页面结构变化：标题未解析')
  })

  it('renders no warning section when the parse is clean', async () => {
    const tool = createPatentMetadataTool({
      scrape: async patent => ({
        success: true,
        patent,
        url: 'https://patents.google.com/patent/CN1',
        data: minimalPatentData(),
        errorCode: '' as const,
        errorMessage: '',
        parseWarnings: [],
      }),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_metadata', { patent: 'CN1A' }, 'm-clean')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).not.toContain('## 警告')
  })
})

describe('patent_metadata through the CNIPR channel', () => {
  const patent = 'CN218483312U'
  const cnpirHit = {
    patent,
    title: '一种测试装置',
    assignee: '某某公司',
    publicationDate: '2023-05-09',
    abstract: '摘要文本',
  }
  const notFound = (number: string) => ({
    success: false as const,
    patent: number,
    url: 'u',
    data: null,
    errorCode: 'NOT_FOUND' as const,
    errorMessage: 'not found',
    parseWarnings: [],
  })
  const servedByCnipr = () => ({ search: async () => ({ total: 1, hits: [cnpirHit] }) })

  it('serves a NOT_FOUND scrape through CNIPR and names the channel', async () => {
    const tool = createPatentMetadataTool({
      scrape: async number => notFound(number),
      cnipr: servedByCnipr,
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_metadata', { patent }, 'm-cnipr-not-found')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const out = text(result)
    expect(out).toContain(cnpirHit.title)
    expect(out).toContain(cnpirHit.assignee)
    expect(out).toContain(cnpirHit.publicationDate)
    expect(out).toContain(cnpirHit.abstract)
    expect(out).toContain(`**channel**: ${CNIPR_CHANNEL}`)
    // CNIPR 不发布 URL：缺席的字段整行不渲染，不留一个空 URL 行。
    expect(out).not.toContain('**url**:')
    expect(out).not.toContain('## 通道告警')
  })

  it('serves a failed engine scrape through CNIPR instead of failing the call', async () => {
    const tool = createPatentMetadataTool({
      scrapeRetryDelaysMs: [],
      scrape: async number => ({
        success: false as const,
        patent: number,
        url: 'u',
        data: null,
        errorCode: 'HTTP_ERROR' as const,
        errorMessage: 'HTTP 503',
        parseWarnings: [],
      }),
      cnipr: servedByCnipr,
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_metadata', { patent }, 'm-cnipr-failure')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain(`**channel**: ${CNIPR_CHANNEL}`)
  })

  it('serves a thrown engine error through CNIPR', async () => {
    const tool = createPatentMetadataTool({
      scrape: async () => {
        throw new Error('socket hang up')
      },
      cnipr: servedByCnipr,
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_metadata', { patent }, 'm-cnipr-thrown')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain(`**channel**: ${CNIPR_CHANNEL}`)
  })

  it('rethrows the original engine error when no second channel is wired', async () => {
    const tool = createPatentMetadataTool({
      scrapeRetryDelaysMs: [],
      scrape: async () => {
        throw new Error('socket hang up')
      },
    })
    await expect(tool.execute({ patent }, { signal } as never)).rejects.toThrow('socket hang up')
  })

  it('does not consult CNIPR when the engine already answered', async () => {
    const cniprSearch = vi.fn(async () => ({ total: 1, hits: [cnpirHit] }))
    const tool = createPatentMetadataTool({
      scrape: async number => ({
        success: true as const,
        patent: number,
        url: 'https://patents.google.com/patent/CN1',
        data: minimalPatentData(),
        errorCode: '' as const,
        errorMessage: '',
        parseWarnings: [],
      }),
      cnipr: () => ({ search: cniprSearch }),
    })
    const ctx = await ctxWith(tool)
    await execute(ctx, 'patent_metadata', { patent }, 'm-cnipr-no-need')
    expect(cniprSearch).not.toHaveBeenCalled()
  })

  it('does not consult CNIPR for a non-China number or a China application number', async () => {
    const cniprSearch = vi.fn(async () => ({ total: 1, hits: [cnpirHit] }))
    const tool = createPatentMetadataTool({
      scrapeRetryDelaysMs: [],
      scrape: async number => notFound(number),
      cnipr: () => ({ search: cniprSearch }),
    })
    const ctx = await ctxWith(tool)
    await execute(ctx, 'patent_metadata', { patent: 'US11452699B2' }, 'm-cnipr-us')
    await execute(ctx, 'patent_metadata', { patent: 'CN202122978405' }, 'm-cnipr-app')
    expect(cniprSearch).not.toHaveBeenCalled()
  })

  it('does not consult CNIPR when the scrape reports an invalid number', async () => {
    const cniprSearch = vi.fn(async () => ({ total: 1, hits: [cnpirHit] }))
    const tool = createPatentMetadataTool({
      scrape: async number => ({
        success: false as const,
        patent: number,
        url: 'u',
        data: null,
        errorCode: 'VALIDATION_ERROR' as const,
        errorMessage: 'bad number',
        parseWarnings: [],
      }),
      cnipr: () => ({ search: cniprSearch }),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_metadata', { patent }, 'm-cnipr-invalid')
    expect(result.isError).toBe(true)
    expect(cniprSearch).not.toHaveBeenCalled()
    expect(text(result)).toContain('bad number')
  })

  it('keeps the engine reason when CNIPR misses the number', async () => {
    const tool = createPatentMetadataTool({
      scrapeRetryDelaysMs: [0],
      scrape: async number => ({
        success: false as const,
        patent: number,
        url: 'u',
        data: null,
        errorCode: 'HTTP_ERROR' as const,
        errorMessage: 'HTTP 503',
        parseWarnings: [],
      }),
      cnipr: () => ({ search: async () => ({ total: 1, hits: [{ ...cnpirHit, patent: 'CN218483313U' }] }) }),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_metadata', { patent }, 'm-cnipr-miss')
    expect(result.isError).toBe(true)
    const out = text(result)
    expect(out).toContain('HTTP 503')
    expect(out).toContain(`${CNIPR_CHANNEL}也未检索到该公开(公告)号`)
  })

  it('keeps a NOT_FOUND result and warns when CNIPR is unavailable', async () => {
    const tool = createPatentMetadataTool({
      scrape: async number => notFound(number),
      cnipr: () => ({
        search: async () => {
          throw new Error('CNIPR 通道失败（login_required）：未检测到 CNIPR 登录态')
        },
      }),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_metadata', { patent }, 'm-cnipr-down')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const out = text(result)
    expect(out).toContain('not found')
    expect(out).toContain('## 通道告警')
    expect(out).toContain(`${CNIPR_CHANNEL}不可用`)
    expect(out).toContain('未检测到 CNIPR 登录态')
    expect(out).toContain('本次结果只有')
  })

  it('names a non-Error CNIPR failure with its string form', async () => {
    const tool = createPatentMetadataTool({
      scrape: async number => notFound(number),
      cnipr: () => ({
        search: async () => {
          throw 'channel offline'
        },
      }),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_metadata', { patent }, 'm-cnipr-string')
    expect(text(result)).toContain('channel offline')
  })

  it('skips the second channel when the lookup returns nothing', async () => {
    const tool = createPatentMetadataTool({
      scrape: async number => notFound(number),
      cnipr: () => undefined,
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_metadata', { patent }, 'm-cnipr-off')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain(`channel: ${GOOGLE_PATENTS_CHANNEL}`)
  })

  it('matches a hit whose number needs folding', async () => {
    const tool = createPatentMetadataTool({
      scrape: async number => notFound(number),
      cnipr: () => ({ search: async () => ({ total: 1, hits: [{ ...cnpirHit, patent: ' cn218483312u ' }] }) }),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_metadata', { patent }, 'm-cnipr-fold')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain(`**patent**: ${patent}`)
  })

  it('passes the caller signal to the CNIPR channel', async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const tool = createPatentMetadataTool({
      scrape: async number => notFound(number),
      cnipr: () => ({
        search: async (_query, options) => {
          seen = options?.signal
          return { total: 1, hits: [cnpirHit] }
        },
      }),
    })
    await tool.execute({ patent }, { signal: controller.signal } as never)
    expect(seen).toBe(controller.signal)
  })

  it('leaves the abstract and an unnamed assignee out when the caller opts out', async () => {
    const tool = createPatentMetadataTool({
      scrape: async number => notFound(number),
      cnipr: () => ({
        search: async () => ({ total: 1, hits: [{ ...cnpirHit, assignee: '' }] }),
      }),
    })
    const value = await tool.execute({ patent, returnAbstract: false }, { signal } as never) as { data: { abstractText: string } }
    expect(value.data.abstractText).toBe('')
    const rendered = text({ content: tool.output.render({ patent, returnAbstract: false }, value) })
    expect(rendered).toContain('**assignees**: N/A')
    expect(rendered).not.toContain(cnpirHit.abstract)
  })
})

describe('patent_legal_status', () => {
  const activeRecord = {
    patent_number: 'US1A', title: 'T', status: 'Active', ifi_status: 'x', estimated_expiration: '2030',
    filing_date: '2010', grant_date: '2012', applicant: 'A', inventor: 'I', events_summary: [], url: 'u',
  }

  it('maps a batch result', async () => {
    const tool = createPatentLegalStatusTool({
      checker: { checkBatch: async () => ({ 'US1A': activeRecord }) },
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_legal_status', { patents: ['US1A'] }, 'l-1')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    expect(text(result)).toContain('US1A')
    expect(text(result)).toContain('Active')
    expect(text(result)).toContain(`通道：${GOOGLE_PATENTS_CHANNEL}`)
  })

  it('clamps maxConcurrency into [1, 20]', async () => {
    const seen: Array<number | undefined> = []
    const tool = createPatentLegalStatusTool({
      checker: {
        checkBatch: async (_patents, options?: LegalStatusOptions) => {
          seen.push(options?.maxConcurrency)
          return { 'US1A': activeRecord }
        },
      },
    })
    const ctx = await ctxWith(tool)
    await execute(ctx, 'patent_legal_status', { patents: ['US1A'], maxConcurrency: 0 }, 'l-clamp-low')
    await execute(ctx, 'patent_legal_status', { patents: ['US1A'], maxConcurrency: 999 }, 'l-clamp-high')
    expect(seen).toEqual([1, 20])
  })

  it('retries numbers the engine could not answer through CNIPR', async () => {
    const tool = createPatentLegalStatusTool({
      checker: { checkBatch: async () => ({ 'CN2023113560975': { ...activeRecord, patent_number: 'CN2023113560975', status: 'UNKNOWN', error: 'HTTP 503' } }) },
      cnipr: () => ({
        legalStatus: async () => [{
          number: 'CN2023113560975',
          appNumber: '202311356097.5',
          total: 2,
          records: [
            { app_number: '202311356097.5', announce_date: '2023.12.12', status: '公开', status_info: '公开' },
            { app_number: '202311356097.5', announce_date: '2023.12.29', status: '实质审查的生效', status_info: '实质审查的生效' },
          ],
        }],
      }),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_legal_status', { patents: ['CN2023113560975'] }, 'l-cnipr')
    const rendered = text(result)
    expect(result.isError).toBe(false)
    // 状态取公告日最新的一条（2023.12.29 的实质审查生效，而不是 2023.12.12 的公开），
    // 通道点名 CNIPR，nuo 通道的失败原因不再承担这一篇的结论。
    expect(rendered).toContain('实质审查的生效')
    expect(rendered).not.toContain('(公开)')
    expect(rendered).toContain(`通道：${CNIPR_CHANNEL}`)
    expect(rendered).not.toContain('HTTP 503')
  })

  it('keeps the engine result when the CNIPR channel has no records for the number', async () => {
    const tool = createPatentLegalStatusTool({
      checker: { checkBatch: async () => ({ 'CN2023113560975': { ...activeRecord, patent_number: 'CN2023113560975', status: 'UNKNOWN', error: 'HTTP 503' } }) },
      cnipr: () => ({ legalStatus: async () => [{ number: 'CN2023113560975', appNumber: '', total: null, records: [], error: '未检索到申请号' }] }),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_legal_status', { patents: ['CN2023113560975'] }, 'l-cnipr-miss')
    const rendered = text(result)
    expect(rendered).toContain('HTTP 503')
    expect(rendered).toContain(`通道：${GOOGLE_PATENTS_CHANNEL}`)
  })

  it('reports an unusable CNIPR channel without dropping the engine results', async () => {
    const tool = createPatentLegalStatusTool({
      checker: { checkBatch: async () => ({ 'CN2023113560975': { ...activeRecord, patent_number: 'CN2023113560975', status: 'UNKNOWN' } }) },
      cnipr: () => ({ legalStatus: async () => { throw new Error('CNIPR 通道失败（login_required）：未检测到 CNIPR 登录态') } }),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_legal_status', { patents: ['CN2023113560975'] }, 'l-cnipr-down')
    const rendered = text(result)
    expect(result.isError).toBe(false)
    expect(rendered).toContain('## 通道告警')
    expect(rendered).toContain(`${CNIPR_CHANNEL}不可用`)
    expect(rendered).toContain('未检测到 CNIPR 登录态')
    expect(rendered).toContain(`只有 ${GOOGLE_PATENTS_CHANNEL} 的结果`)
  })

  it('does not consult CNIPR for numbers the engine already answered', async () => {
    const legalStatus = vi.fn(async () => [])
    const tool = createPatentLegalStatusTool({
      checker: { checkBatch: async () => ({ 'US1A': activeRecord }) },
      cnipr: () => ({ legalStatus }),
    })
    const ctx = await ctxWith(tool)
    await execute(ctx, 'patent_legal_status', { patents: ['US1A'] }, 'l-no-retry')
    expect(legalStatus).not.toHaveBeenCalled()
  })

  it('runs without a CNIPR lookup at all', async () => {
    const tool = createPatentLegalStatusTool({
      checker: { checkBatch: async () => ({ 'US1A': activeRecord }) },
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_legal_status', { patents: ['US1A', 'US2A'] }, 'l-plain')
    expect(result.isError).toBe(false)
    // 缺失结果的号按 UNKNOWN 报出，不因缺第二个通道而报错。
    expect(text(result)).toContain('US2A')
  })

  it('falls back to the record status, keeps the newest record, and ignores unknown numbers', async () => {
    const tool = createPatentLegalStatusTool({
      checker: { checkBatch: async () => ({ 'CN2023113560975': { ...activeRecord, patent_number: 'CN2023113560975', status: 'UNKNOWN' } }) },
      cnipr: () => ({
        legalStatus: async () => [
          {
            number: 'CN2023113560975',
            appNumber: '202311356097.5',
            total: 2,
            records: [
              { app_number: '202311356097.5', announce_date: '2024.01.05', status: '驳回', status_info: '' },
              { app_number: '202311356097.5', announce_date: '2023.12.29', status: '公开', status_info: '公开' },
            ],
          },
          {
            number: 'CN9999999999999',
            appNumber: '999999999.9',
            total: 1,
            records: [{ app_number: '999999999.9', announce_date: '2024.01.01', status: '公开', status_info: '公开' }],
          },
        ],
      }),
    })
    const value = await tool.execute({ patents: ['CN2023113560975'] }, { signal } as never)
    const rendered = text({ content: tool.output.render({ patents: ['CN2023113560975'] }, value as never) })
    expect(rendered).toContain('驳回')
    expect(rendered).not.toContain('(公开)')
    expect(rendered).toContain(`通道：${CNIPR_CHANNEL}`)
  })

  it('reports a non-Error CNIPR failure with its string form', async () => {
    const tool = createPatentLegalStatusTool({
      checker: { checkBatch: async () => ({ 'CN2023113560975': { ...activeRecord, patent_number: 'CN2023113560975', status: 'UNKNOWN' } }) },
      cnipr: () => ({
        legalStatus: async () => {
          throw 'channel offline'
        },
      }),
    })
    const ctx = await ctxWith(tool)
    const result = await execute(ctx, 'patent_legal_status', { patents: ['CN2023113560975'] }, 'l-cnipr-string')
    expect(text(result)).toContain('channel offline')
  })
})
