// Late-bound download channel: the ego channel resolves ctx.patentData per call
// (patent-data declares inject:['subprocess'], so it activates after a
// tools-only consumer), and a host without a usable browser continues on the
// browser-free scrape channel.
import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { ScrapeResult } from '@deepseek-ai/nuo-patent'
import PatentData from '@deepseek-ai/dsh-patent-data'
import { PatentToolError } from '../src/error.ts'
import { createDownloadChannelRunner, createScrapeChannelRunner } from '../src/tool/patent-pdf-download-channel.ts'
import type { PatentDataSeam } from '../src/tool/patent-pdf-download-channel.ts'
import { GOOGLE_PATENTS_CHANNEL } from '../src/tool/internal/upstream-channel.ts'
import type { EgoDownloadRequest } from '../src/tool/patent-pdf-download.ts'
import type { EgoSessionSeam } from '../src/tool/patent-pdf-download-ego.ts'

// The default scrape seam is the LRU-cached nuo scrape; stub the engine call so
// the dependency-free path stays off the network.
const nuo = vi.hoisted(() => ({ scrapePatent: vi.fn() }))
vi.mock('@deepseek-ai/nuo-patent', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  scrapePatent: nuo.scrapePatent,
}))

const request: EgoDownloadRequest = {
  patents: ['US1A'],
  outputDir: '/tmp/patent-pdf-channel',
  pageTimeoutSec: 20,
  downloadTimeoutMs: 1_000,
  record: false,
  timeoutMs: 1_000,
}

const CDN_URL = 'https://patentimages.storage.googleapis.com/ab/cd/US1A.pdf'

/** One nuo scrape result; `pdfUrl` null models a page without a CDN link. */
function scrapeResult(pdfUrl: string | null, errorMessage = ''): ScrapeResult {
  return {
    success: pdfUrl !== null,
    patent: 'US1A',
    url: 'https://patents.google.com/patent/US1A/en',
    data: pdfUrl === null ? null : ({ pdf_url: pdfUrl } as unknown as NonNullable<ScrapeResult['data']>),
    errorCode: pdfUrl === null ? 'PARSE_ERROR' : '',
    errorMessage,
    parseWarnings: [],
  }
}

/** Patent-data stand-in exposing only the surface the channel reads. */
function patentDataWith(session: EgoSessionSeam): PatentDataSeam {
  return { createEgoSession: () => session }
}

function egoSession(overrides: Partial<EgoSessionSeam> = {}): EgoSessionSeam {
  return {
    checkAvailability: () => ({ ok: true }),
    runScript: async () => ({
      output: 'EGO_DOWNLOAD:{"items":[{"patent":"US1A","status":"ok","path":"/tmp/US1A.pdf"}]}',
      exitCode: 0,
      timedOut: false,
    }),
    extractTaggedJson: output => JSON.parse(output.slice(output.indexOf('EGO_DOWNLOAD:') + 'EGO_DOWNLOAD:'.length)) as unknown,
    ...overrides,
  }
}

describe('createScrapeChannelRunner', () => {
  it('reports the scraped CDN link as a fallback item', async () => {
    const runner = createScrapeChannelRunner({ scrape: async () => scrapeResult(CDN_URL) })
    const result = await runner(request)
    expect(result.items).toEqual([{ patent: 'US1A', status: 'fallback', pdfUrl: CDN_URL, channel: GOOGLE_PATENTS_CHANNEL }])
  })

  it('reports the scrape failure without a pdfUrl', async () => {
    const runner = createScrapeChannelRunner({ scrape: async () => scrapeResult(null, 'HTTP 503') })
    const result = await runner(request)
    expect(result.items).toEqual([{
      patent: 'US1A', status: 'fallback', error: 'HTTP 503', channel: GOOGLE_PATENTS_CHANNEL,
    }])
  })

  it('names a page without a CDN link', async () => {
    const runner = createScrapeChannelRunner({ scrape: async () => scrapeResult(null) })
    const result = await runner(request)
    expect(result.items[0]?.error).toContain('未在页面中找到 CDN PDF 链接')
  })

  it('names a page whose CDN link is empty', async () => {
    const runner = createScrapeChannelRunner({ scrape: async () => scrapeResult('') })
    const result = await runner(request)
    expect(result.items[0]?.error).toContain('未在页面中找到 CDN PDF 链接')
  })

  it('defaults to the cached nuo scrape', async () => {
    nuo.scrapePatent.mockResolvedValueOnce(scrapeResult(CDN_URL))
    const runner = createScrapeChannelRunner()
    const result = await runner(request)
    expect(result.items[0]?.pdfUrl).toBe(CDN_URL)
    expect(nuo.scrapePatent).toHaveBeenCalledWith('US1A', { returnAbstract: false, returnLegal: false })
  })
})

describe('createDownloadChannelRunner', () => {
  it('uses the ego channel when the service is present', async () => {
    const runner = createDownloadChannelRunner(() => patentDataWith(egoSession()), {
      scrape: async () => scrapeResult(null, 'scrape must not run'),
    })
    const result = await runner(request)
    expect(result.items).toEqual([{
      patent: 'US1A', status: 'ok', path: '/tmp/US1A.pdf', channel: GOOGLE_PATENTS_CHANNEL,
    }])
    expect(result.warnings).toBeUndefined()
  })

  it('sends every number to the Google leg, including China publication numbers', async () => {
    const runner = createDownloadChannelRunner(() => patentDataWith(egoSession()), {
      scrape: async () => scrapeResult(null, 'scrape must not run'),
    })
    const result = await runner({ ...request, patents: ['CN122072823A'] })
    // 中国号同样走 Google 腿：PatSnap 兜底在下载失败之后由工具启动。
    expect(result.items[0]?.channel).toBe(GOOGLE_PATENTS_CHANNEL)
  })

  it('falls back to the scrape channel when the service is absent', async () => {
    const runner = createDownloadChannelRunner(() => undefined, { scrape: async () => scrapeResult(CDN_URL) })
    const result = await runner(request)
    expect(result.items[0]?.pdfUrl).toBe(CDN_URL)
  })

  it('falls back to the scrape channel when the browser is unusable', async () => {
    const session = egoSession({ checkAvailability: () => ({ ok: false, reason: 'ego lite not installed' }) })
    const runner = createDownloadChannelRunner(() => patentDataWith(session), {
      scrape: async () => scrapeResult(CDN_URL),
    })
    const result = await runner(request)
    expect(result.items[0]?.pdfUrl).toBe(CDN_URL)
  })

  it('propagates ego failures that are not setup problems', async () => {
    const session = egoSession({
      runScript: async () => {
        throw new Error('spawn boom')
      },
    })
    const runner = createDownloadChannelRunner(() => patentDataWith(session), { scrape: async () => scrapeResult(CDN_URL) })
    await expect(runner(request)).rejects.toBeInstanceOf(PatentToolError)
  })

  it('forwards the Google leg recorded directory', async () => {
    const session = egoSession({
      runScript: async () => ({
        output: 'EGO_DOWNLOAD:{"items":[{"patent":"US1A","status":"ok","path":"/tmp/US1A.pdf"}],"recorded":"/tmp/evidence"}',
        exitCode: 0,
        timedOut: false,
      }),
    })
    const runner = createDownloadChannelRunner(() => patentDataWith(session))
    const result = await runner({ ...request, record: true })
    expect(result.recorded).toBe('/tmp/evidence')
  })
})

describe('patent-data activation order', () => {
  /** Minimal `tools` provider so the consumer can declare the preset's inject list. */
  class FakeTools extends Service {
    constructor(ctx: Context) {
      super(ctx, 'tools')
    }
  }

  /** Minimal `subprocess` provider: patent-data only needs the service name. */
  class FakeSubprocess extends Service {
    constructor(ctx: Context) {
      super(ctx, 'subprocess')
    }
  }

  it('resolves the service in a consumer that reads it after activation', async () => {
    const ctx = new Context()
    await ctx.plugin(FakeTools)
    ctx.plugin(FakeSubprocess)
    ctx.plugin(PatentData)

    const seen: Array<PatentData | undefined> = []
    ctx.plugin({
      name: 'channel-probe',
      inject: ['tools'],
      apply(scope) {
        seen.push(scope.get('patentData'))
        // The preset's row order activates patent-data one dependency hop later.
        setTimeout(() => seen.push(scope.get('patentData')), 0)
      },
    })
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(seen[0]).toBeUndefined()
    expect(seen[1]).toBeInstanceOf(PatentData)
    await ctx.fiber.dispose()
  })
})
