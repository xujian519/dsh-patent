import { describe, expect, it, vi } from 'vitest'
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createPatentPdfDownloadTool, normalizePatentNumber } from '../src/tool/patent-pdf-download.ts'
import type { FallbackRequest } from '../src/tool/patent-pdf-download.ts'
import { GOOGLE_PATENTS_CHANNEL, PATSNAP_CHANNEL } from '../src/tool/internal/upstream-channel.ts'
import { PatentToolError } from '../src/error.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const signal = new AbortController().signal

/** 这些用例注入的 runner 扮演 Google Patents 腿；生产由通道 runner 标注每篇的通道。 */
const GOOGLE = GOOGLE_PATENTS_CHANNEL

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

/** The URL a fetch stub received, whatever input form the tool used. */
function inputUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input instanceof URL ? input.href : input
}

/**
 * 跑一次「fetch 永挂起、只在 signal 中止时 reject」的兜底场景：调用方在 fetch 真正发起后
 * 推进假时钟 `advanceMs`，工具应在期限内自行收敛（没有期限的实现会一直挂住，直到测试超时）。
 * @param dir - 输出目录。
 * @param args - 工具入参。
 * @param advanceMs - 推进的假时钟毫秒数。
 * @returns 工具的规范结果。
 */
async function runHangingFallback(dir: string, args: Record<string, unknown>, advanceMs: number): Promise<unknown> {
  let fetchStarted: () => void = () => {}
  const started = new Promise<void>((resolve) => { fetchStarted = resolve })
  const hanging: typeof fetch = (_url, init) => new Promise<Response>((_resolve, reject) => {
    fetchStarted()
    init?.signal?.addEventListener('abort', () => { reject(new Error('aborted at the attempt deadline')) }, { once: true })
  })
  const tool = createPatentPdfDownloadTool({
    runEgo: async () => ({ items: [{ channel: GOOGLE, patent: 'US1A', status: 'fallback', pdfUrl: 'https://cdn/US1A.pdf' }] }),
    resolveOutputDir: () => dir,
    fetchImpl: hanging,
    fetchFallbackRetry: { maxRetries: 0 },
  })
  const pending = tool.execute(args, { signal } as never)
  await started
  await vi.advanceTimersByTimeAsync(advanceMs)
  return pending
}

describe('normalizePatentNumber', () => {
  it('trims, uppercases and strips separators', () => {
    expect(normalizePatentNumber(' us 11452699 b2 ')).toBe('US11452699B2')
    expect(normalizePatentNumber('CN-115690481-A')).toBe('CN115690481A')
    expect(normalizePatentNumber('CN115690481/9')).toBe('CN1156904819')
  })
})

describe('patent_pdf_download', () => {
  it('downloads a batch through the ego runner and renders the summary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => ({ items: [{ channel: GOOGLE, patent: 'US1A', status: 'ok', path: join(dir, 'US1A.pdf') }] }),
        resolveOutputDir: () => dir,
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'patent_pdf_download', { patents: ['us 1 a'] }, 'p-1')
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(text(result)).toContain('下载完成：1/1 成功')
      expect(text(result)).toContain('US1A')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('derives the overall budget from the per-patent page and download budgets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const budgets: number[] = []
      const tool = createPatentPdfDownloadTool({
        runEgo: async (request) => {
          budgets.push(request.timeoutMs)
          return {
            items: request.patents.map(p => ({ channel: GOOGLE, patent: p, status: 'ok' as const, path: join(dir, `${p}.pdf`) })),
          }
        },
        resolveOutputDir: () => dir,
      })
      const ctx = await ctxWith(tool)
      await execute(ctx, 'patent_pdf_download', { patents: ['US1A'] }, 'p-b1')
      // 一篇的「开页 20s + PDF 取回 60s」必须落在默认预算内，否则 ego 腿还没回退到
      // 页面解析 + HTTP 下载，整体超时就先掐断调用。
      expect(budgets[0]).toBeGreaterThanOrEqual(20_000 + 60_000)
      expect(budgets[0]).toBe(20_000 + 60_000 + 15_000)
      await execute(
        ctx,
        'patent_pdf_download',
        { patents: ['US2A', 'US3A'], pageTimeoutSec: 30, downloadTimeoutMs: 20_000 },
        'p-b2',
      )
      expect(budgets[1]).toBe(2 * (30_000 + 20_000) + 15_000)
      await execute(ctx, 'patent_pdf_download', { patents: ['US4A'], pageTimeoutSec: 5, downloadTimeoutMs: 5_000 }, 'p-b3')
      expect(budgets[2]).toBe(60_000)
      await execute(
        ctx,
        'patent_pdf_download',
        { patents: Array.from({ length: 10 }, (_, i) => `US${10 + i}A`) },
        'p-b4',
      )
      expect(budgets[3]).toBe(300_000)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('falls back to fetch for a fallback item and writes the PDF', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const body = '%PDF-1.4 ' + 'x'.repeat(600)
      const fetchImpl = (async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/pdf' : null) },
        arrayBuffer: async () => new TextEncoder().encode(body).buffer,
      })) as unknown as typeof fetch
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => ({ items: [{ channel: GOOGLE, patent: 'US1A', status: 'fallback', pdfUrl: 'https://cdn/US1A.pdf', error: 'no intercept' }] }),
        resolveOutputDir: () => dir,
        fetchImpl,
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'patent_pdf_download', { patents: ['US1A'] }, 'p-2')
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(text(result)).toContain('US1A')
      expect(text(result)).toContain('（fetch 兜底）')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('leaves the fallback channel alone when Google delivers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const resolveFallback = vi.fn()
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => ({ items: [{ channel: GOOGLE, patent: 'US1A', status: 'ok', path: join(dir, 'US1A.pdf') }] }),
        resolveFallback,
        resolveOutputDir: () => dir,
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'patent_pdf_download', { patents: ['US1A'] }, 'fb-1')
      expect(result.isError).toBe(false)
      expect(resolveFallback).not.toHaveBeenCalled()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('serves a Google miss through PatSnap and names the family substitute', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const body = '%PDF-1.4 ' + 'x'.repeat(600)
      const fetchImpl: typeof fetch = async () => new Response(new TextEncoder().encode(body), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      })
      const resolveFallback = vi.fn(async (
        _requests: readonly FallbackRequest[],
        _options: { timeoutMs: number; signal?: AbortSignal },
      ) => [
        { patent: 'CN1A', channel: PATSNAP_CHANNEL, pdfUrl: 'https://data-pdf.example/CN1A.pdf', resolvedNumber: 'CN1B' },
      ])
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => ({ items: [{ channel: GOOGLE, patent: 'CN1A', status: 'fallback', error: '页面没有 PDF 链接' }] }),
        resolveFallback,
        resolveOutputDir: () => dir,
        fetchImpl,
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'patent_pdf_download', { patents: ['CN1A'] }, 'fb-2')
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(text(result)).toContain('下载完成：1/1 成功')
      expect(text(result)).toContain(`通道：${PATSNAP_CHANNEL}`)
      expect(text(result)).toContain('同族替代：CN1B')
      expect(text(result)).toContain(`改由 ${PATSNAP_CHANNEL} 提供`)
      const [fallbackRequests, fallbackOptions] = resolveFallback.mock.calls[0] ?? []
      expect(fallbackRequests).toEqual([{ patent: 'CN1A', reason: '页面没有 PDF 链接' }])
      expect(typeof fallbackOptions?.timeoutMs).toBe('number')
      expect(await readFile(join(dir, 'CN1A.pdf'))).toBeTruthy()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('falls back when the Google CDN returns a non-PDF response', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const fetchImpl: typeof fetch = async (input) => {
        if (inputUrl(input).includes('data-pdf.example')) {
          return new Response(new TextEncoder().encode('%PDF-1.4 ' + 'x'.repeat(600)), {
            status: 200,
            headers: { 'content-type': 'application/pdf' },
          })
        }
        return new Response('forbidden', { status: 403, statusText: 'Forbidden' })
      }
      const resolveFallback = vi.fn(async () => [
        { patent: 'US1A', channel: PATSNAP_CHANNEL, pdfUrl: 'https://data-pdf.example/US1A.pdf' },
      ])
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => ({ items: [{ channel: GOOGLE, patent: 'US1A', status: 'fallback', pdfUrl: 'https://cdn/US1A.pdf' }] }),
        resolveFallback,
        resolveOutputDir: () => dir,
        fetchImpl,
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'patent_pdf_download', { patents: ['US1A'] }, 'fb-3')
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(text(result)).toContain(`通道：${PATSNAP_CHANNEL}`)
      expect(resolveFallback).toHaveBeenCalledTimes(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('hands a failed Google leg to the fallback channel instead of failing the batch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const fetchImpl: typeof fetch = async () => new Response(new TextEncoder().encode('%PDF-1.4 ' + 'x'.repeat(600)), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      })
      const resolveFallback = vi.fn(async () => [
        { patent: 'US1A', channel: PATSNAP_CHANNEL, pdfUrl: 'https://data-pdf.example/US1A.pdf' },
      ])
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => { throw new Error('ego crashed') },
        resolveFallback,
        resolveOutputDir: () => dir,
        fetchImpl,
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'patent_pdf_download', { patents: ['US1A'] }, 'fb-4')
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(text(result)).toContain('下载完成：1/1 成功')
      expect(text(result)).toContain('通道失败')
      expect(text(result)).toContain('改由兜底通道处理')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps both failure reasons when the fallback channel itself is unavailable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => ({ items: [{ channel: GOOGLE, patent: 'US1A', status: 'fallback', error: '页面没有 PDF 链接' }] }),
        resolveFallback: async () => { throw new Error('PatSnap 通道失败（quota_exhausted）：余额不足') },
        resolveOutputDir: () => dir,
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'patent_pdf_download', { patents: ['US1A'] }, 'fb-5')
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(text(result)).toContain('页面没有 PDF 链接')
      expect(text(result)).toContain('兜底通道不可用')
      expect(text(result)).toContain('quota_exhausted')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('appends the fallback download failure to the original reason', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const fetchImpl: typeof fetch = async () => new Response('gone', { status: 410, statusText: 'Gone' })
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => ({ items: [{ channel: GOOGLE, patent: 'US1A', status: 'fallback', error: '页面没有 PDF 链接' }] }),
        resolveFallback: async () => [
          { patent: 'US1A', channel: PATSNAP_CHANNEL, pdfUrl: 'https://data-pdf.example/US1A.pdf' },
        ],
        resolveOutputDir: () => dir,
        fetchImpl,
        fetchFallbackRetry: { maxRetries: 0 },
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'patent_pdf_download', { patents: ['US1A'] }, 'fb-6')
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(text(result)).toContain('页面没有 PDF 链接')
      expect(text(result)).toContain('PatSnap（智慧芽）下载失败')
      expect(text(result)).toContain('HTTP 410')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('skips already-downloaded patents via MANIFEST resume', async () => {    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const file = join(dir, 'US1A.pdf')
      await writeFile(file, '%PDF-1.4 resume body')
      const st = await stat(file)
      await appendFile(
        join(dir, '.MANIFEST.jsonl'),
        JSON.stringify({ patent: 'US1A', status: 'ok', path: file, size: st.size, ts: Date.now() }) + '\n',
      )
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => {
          throw new Error('should not be called')
        },
        resolveOutputDir: () => dir,
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'patent_pdf_download', { patents: ['US1A'] }, 'p-3')
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(text(result)).toContain('（已下载，跳过）')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects an empty patents list', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => ({ items: [] }),
        resolveOutputDir: () => dir,
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'patent_pdf_download', { patents: [] }, 'p-4')
      expect(result.isError).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects path traversal characters in patent numbers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => ({ items: [] }),
        resolveOutputDir: () => dir,
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'patent_pdf_download', { patents: ['../evil'] }, 'p-5')
      expect(result.isError).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects out-of-range or non-integer tuning values', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => ({ items: [] }),
        resolveOutputDir: () => dir,
      })
      const ctx = await ctxWith(tool)
      const low = await execute(ctx, 'patent_pdf_download', { patents: ['US1A'], pageTimeoutSec: 1 }, 'p-6')
      expect(low.isError).toBe(true)
      const high = await execute(ctx, 'patent_pdf_download', { patents: ['US1A'], pageTimeoutSec: 61 }, 'p-7')
      expect(high.isError).toBe(true)
      const fractional = await execute(ctx, 'patent_pdf_download', { patents: ['US1A'], timeoutMs: 0.5 }, 'p-8')
      expect(fractional.isError).toBe(true)
      const tooBig = await execute(ctx, 'patent_pdf_download', { patents: ['US1A'], timeoutMs: 300001 }, 'p-9')
      expect(tooBig.isError).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('resolves the default output directory with a relative outputDir and cwd injection', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => ({ items: [{ channel: GOOGLE, patent: 'US1A', status: 'ok', path: join(temp, 'out', 'US1A.pdf') }] }),
        cwd: temp,
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'patent_pdf_download', { patents: ['US1A'], outputDir: 'out' }, 'p-10')
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(text(result)).toContain(join(temp, 'out'))
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })

  it('rejects an outputDir that escapes the working directory', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    const outside = await mkdtemp(join(tmpdir(), 'dsh-patent-outside-'))
    try {
      const tool = createPatentPdfDownloadTool({ runEgo: async () => ({ items: [] }), cwd: temp })
      const ctx = await ctxWith(tool)
      // 该目录既接收 PDF 与截图，又作为 ego-browser 的 cwd，因此与 patent-document 一致
      // 要求真实位置留在工作目录内。
      const absolute = await execute(ctx, 'patent_pdf_download', { patents: ['US1A'], outputDir: outside }, 'p-12')
      expect(absolute.isError).toBe(true)
      const traversal = await execute(ctx, 'patent_pdf_download', { patents: ['US1A'], outputDir: '../escape' }, 'p-13')
      expect(traversal.isError).toBe(true)
    } finally {
      await rm(temp, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('writes the fallback PDF without touching a predictable temp path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const victim = join(dir, 'victim.txt')
      await writeFile(victim, 'untouched')
      // 旧实现把临时文件固定为 <target>.tmp：预置同名符号链接就能把内容写到别处。
      await symlink(victim, join(dir, 'US1A.pdf.tmp'))
      const body = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(600, 0x20)])
      const fetchImpl = async () => new Response(new Uint8Array(body), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      })
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => ({ items: [{ channel: GOOGLE, patent: 'US1A', status: 'fallback', pdfUrl: 'https://cdn/US1A.pdf' }] }),
        resolveOutputDir: () => dir,
        fetchImpl,
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'patent_pdf_download', { patents: ['US1A'] }, 'p-14')
      expect(result.isError).toBe(false)
      expect(await readFile(victim, 'utf8')).toBe('untouched')
      const written = await readFile(join(dir, 'US1A.pdf'))
      expect(written.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('falls back to the date-partitioned default output dir', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => ({ items: [{ channel: GOOGLE, patent: 'US1A', status: 'ok', path: join(temp, '专利原文', 'x', 'US1A.pdf') }] }),
        cwd: temp,
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'patent_pdf_download', { patents: ['US1A'] }, 'p-11')
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(text(result)).toContain(join(temp, '专利原文'))
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })

  it('re-downloads when the manifest size no longer matches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const file = join(dir, 'US1A.pdf')
      await writeFile(file, '%PDF-1.4 resume body')
      await appendFile(
        join(dir, '.MANIFEST.jsonl'),
        JSON.stringify({ patent: 'US1A', status: 'ok', path: file, size: 999, ts: Date.now() }) + '\n',
      )
      let egoCalls = 0
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => {
          egoCalls += 1
          return { items: [] }
        },
        resolveOutputDir: () => dir,
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'patent_pdf_download', { patents: ['US1A'] }, 'p-12')
      expect(egoCalls).toBe(1)
      expect(result.isError).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rethrows when the manifest file is unreadable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      await mkdir(join(dir, '.MANIFEST.jsonl'))
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => ({ items: [] }),
        resolveOutputDir: () => dir,
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'patent_pdf_download', { patents: ['US1A'] }, 'p-13')
      expect(result.isError).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('classifies every fetch fallback failure and the no-pdfUrl case', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const httpFail = (async () => ({ ok: false, status: 403, statusText: 'Forbidden', headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) })) as unknown as typeof fetch
      const html = (async () => ({ ok: true, status: 200, statusText: 'OK', headers: { get: () => 'text/html' }, arrayBuffer: async () => new TextEncoder().encode('x'.repeat(600)).buffer })) as unknown as typeof fetch
      const tiny = (async () => ({ ok: true, status: 200, statusText: 'OK', headers: { get: () => 'application/pdf' }, arrayBuffer: async () => new TextEncoder().encode('%PDF-').buffer })) as unknown as typeof fetch
      const wrongMagic = (async () => ({ ok: true, status: 200, statusText: 'OK', headers: { get: () => 'application/pdf' }, arrayBuffer: async () => new TextEncoder().encode('x'.repeat(600)).buffer })) as unknown as typeof fetch

      for (const [fetchImpl, label] of [
        [httpFail, 'pf-1'],
        [html, 'pf-2'],
        [tiny, 'pf-3'],
        [wrongMagic, 'pf-4'],
      ] as const) {
        const tool = createPatentPdfDownloadTool({
          runEgo: async () => ({ items: [{ channel: GOOGLE, patent: 'US1A', status: 'fallback', pdfUrl: 'https://cdn/US1A.pdf' }] }),
          resolveOutputDir: () => dir,
          fetchImpl,
        })
        const ctx = await ctxWith(tool)
        const result = await execute(ctx, 'patent_pdf_download', { patents: ['US1A'] }, label)
        expect(result.isError).toBe(false)
        if (result.isError) throw new Error('expected success')
        expect(text(result)).toContain('失败')
        expect(text(result)).toContain('可手动重试')
      }

      const noUrl = createPatentPdfDownloadTool({
        runEgo: async () => ({ items: [{ channel: GOOGLE, patent: 'US1A', status: 'fallback' }] }),
        resolveOutputDir: () => dir,
      })
      const ctxN = await ctxWith(noUrl)
      const noUrlResult = await execute(ctxN, 'patent_pdf_download', { patents: ['US1A'] }, 'pf-5')
      expect(noUrlResult.isError).toBe(false)
      if (noUrlResult.isError) throw new Error('expected success')
      expect(text(noUrlResult)).not.toContain('可手动重试')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects a non-function fetch implementation and falls back to globalThis.fetch otherwise', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const nonFunction = createPatentPdfDownloadTool({
        runEgo: async () => ({ items: [{ channel: GOOGLE, patent: 'US1A', status: 'fallback', pdfUrl: 'https://cdn/US1A.pdf' }] }),
        resolveOutputDir: () => dir,
        fetchImpl: 42 as unknown as typeof fetch,
      })
      const ctxA = await ctxWith(nonFunction)
      const resultA = await execute(ctxA, 'patent_pdf_download', { patents: ['US1A'] }, 'pf-6')
      expect(resultA.isError).toBe(false)
      if (resultA.isError) throw new Error('expected success')
      expect(text(resultA)).toContain('no fetch implementation available')

      // No fetchImpl injected: globalThis.fetch is used; a refused localhost
      // connection fails without touching the network.
      const defaultFetch = createPatentPdfDownloadTool({
        runEgo: async () => ({ items: [{ channel: GOOGLE, patent: 'US1A', status: 'fallback', pdfUrl: 'http://127.0.0.1:1/x.pdf' }] }),
        resolveOutputDir: () => dir,
        fetchFallbackRetry: { maxRetries: 0 },
      })
      const ctxB = await ctxWith(defaultFetch)
      const resultB = await execute(ctxB, 'patent_pdf_download', { patents: ['US1A'] }, 'pf-6b')
      expect(resultB.isError).toBe(false)
      if (resultB.isError) throw new Error('expected success')
      expect(text(resultB)).toContain('失败')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('wraps ego-runner failures and surfaces the recording path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const setupRequired = createPatentPdfDownloadTool({
        runEgo: async () => { throw new PatentToolError('setup_required', '未接线', {}) },
        resolveOutputDir: () => dir,
      })
      const ctxA = await ctxWith(setupRequired)
      const resultA = await execute(ctxA, 'patent_pdf_download', { patents: ['US1A'] }, 'pf-7')
      expect(resultA.isError).toBe(true)

      const failed = createPatentPdfDownloadTool({
        runEgo: async () => { throw new Error('ego crashed') },
        resolveOutputDir: () => dir,
      })
      const ctxB = await ctxWith(failed)
      const resultB = await execute(ctxB, 'patent_pdf_download', { patents: ['US1A'] }, 'pf-8')
      expect(resultB.isError).toBe(true)

      const recorded = createPatentPdfDownloadTool({
        runEgo: async () => ({ items: [{ channel: GOOGLE, patent: 'US1A', status: 'ok', path: join(dir, 'US1A.pdf') }], recorded: join(dir, 'recording.webm') }),
        resolveOutputDir: () => dir,
      })
      const ctxC = await ctxWith(recorded)
      const resultC = await execute(ctxC, 'patent_pdf_download', { patents: ['US1A'] }, 'pf-9')
      expect(resultC.isError).toBe(false)
      if (resultC.isError) throw new Error('expected success')
      expect(text(resultC)).toContain('截图留证')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects more than the 50-patent cap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => ({ items: [] }),
        resolveOutputDir: () => dir,
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'patent_pdf_download', { patents: Array.from({ length: 51 }, (_, i) => `US${i}A`) }, 'p-14')
      expect(result.isError).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('ignores invalid manifest entries and re-downloads them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      await appendFile(
        join(dir, '.MANIFEST.jsonl'),
        [
          'not-json{',
          JSON.stringify({ patent: 'US1A', status: 'failed', ts: 1 }),
          JSON.stringify({ patent: 'US2A', status: 'ok', path: join(dir, 'missing.pdf'), size: 123, ts: 1 }),
          JSON.stringify({ patent: 'US3A', status: 'ok', path: join(dir, 'US3A.pdf'), size: 999, ts: 1 }),
        ].join('\n') + '\n',
      )
      const downloads: string[] = []
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => {
          downloads.push('ran')
          return { items: [{ channel: GOOGLE, patent: 'US2A', status: 'ok', path: join(dir, 'US2A.pdf') }] }
        },
        resolveOutputDir: () => dir,
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'patent_pdf_download', { patents: ['US1A', 'US2A', 'US3A'] }, 'p-15')
      expect(downloads).toHaveLength(1)
      expect(result.isError).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('renders a browser-ok item without a path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => ({ items: [{ channel: GOOGLE, patent: 'US1A', status: 'ok', pdfUrl: 'https://cdn/x.pdf' }] }),
        resolveOutputDir: () => dir,
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'patent_pdf_download', { patents: ['US1A'] }, 'p-16')
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(text(result)).toContain('- US1A: ok')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps the error of a pdfUrl-less fallback item', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => ({ items: [{ channel: GOOGLE, patent: 'US1A', status: 'fallback', error: 'no intercept' }] }),
        resolveOutputDir: () => dir,
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'patent_pdf_download', { patents: ['US1A'] }, 'p-17')
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(text(result)).toContain('no intercept')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('handles a null content-type and a string-thrown fetch failure', async () => {
    const dirA = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    const dirB = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const nullType = (async () => ({ ok: true, status: 200, statusText: 'OK', headers: { get: () => null }, arrayBuffer: async () => new TextEncoder().encode('%PDF-1.4 ' + 'x'.repeat(600)).buffer })) as unknown as typeof fetch
      const toolA = createPatentPdfDownloadTool({
        runEgo: async () => ({ items: [{ channel: GOOGLE, patent: 'US1A', status: 'fallback', pdfUrl: 'https://cdn/US1A.pdf' }] }),
        resolveOutputDir: () => dirA,
        fetchImpl: nullType,
      })
      const ctxA = await ctxWith(toolA)
      const resultA = await execute(ctxA, 'patent_pdf_download', { patents: ['US1A'] }, 'p-18')
      expect(resultA.isError).toBe(false)
      if (resultA.isError) throw new Error('expected success')
      expect(text(resultA)).toContain('（fetch 兜底）')

      const throws = (async () => { throw 'fetch-boom' }) as unknown as typeof fetch
      const toolB = createPatentPdfDownloadTool({
        runEgo: async () => ({ items: [{ channel: GOOGLE, patent: 'US1A', status: 'fallback', pdfUrl: 'https://cdn/US1A.pdf', error: 'intercept failed' }] }),
        resolveOutputDir: () => dirB,
        fetchImpl: throws,
        fetchFallbackRetry: { maxRetries: 0 },
      })
      const ctxB = await ctxWith(toolB)
      const resultB = await execute(ctxB, 'patent_pdf_download', { patents: ['US1A'] }, 'p-19')
      expect(resultB.isError).toBe(false)
      if (resultB.isError) throw new Error('expected success')
      expect(text(resultB)).toContain('intercept failed; fetch fallback failed: fetch-boom')
    } finally {
      await rm(dirA, { recursive: true, force: true })
      await rm(dirB, { recursive: true, force: true })
    }
  })

  it('forces a re-download even when the manifest matches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const file = join(dir, 'US1A.pdf')
      await writeFile(file, '%PDF-1.4 resume body')
      const st = await stat(file)
      await appendFile(
        join(dir, '.MANIFEST.jsonl'),
        JSON.stringify({ patent: 'US1A', status: 'ok', path: file, size: st.size, ts: Date.now() }) + '\n',
      )
      let egoCalls = 0
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => {
          egoCalls += 1
          return { items: [] }
        },
        resolveOutputDir: () => dir,
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'patent_pdf_download', { patents: ['US1A'], force: true }, 'p-20')
      expect(egoCalls).toBe(1)
      expect(result.isError).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('wraps a non-Error ego-runner failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => { throw 'ego-boom' },
        resolveOutputDir: () => dir,
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'patent_pdf_download', { patents: ['US1A'] }, 'p-21')
      expect(result.isError).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports tool_aborted when the ego runner fails on a cancelled call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const controller = new AbortController()
      controller.abort()
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => { throw new Error('cancelled') },
        resolveOutputDir: () => dir,
      })
      await expect(tool.execute(
        { patents: ['US1A'] },
        { signal: controller.signal } as never,
      )).rejects.toMatchObject({ code: 'tool_aborted' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('uses the runner resolved by resolveRunner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const resolved = vi.fn(async () => ({ items: [{ channel: GOOGLE, patent: 'US1A', status: 'ok' as const, path: join(dir, 'US1A.pdf') }] }))
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => { throw new Error('default runner must not run') },
        resolveRunner: () => resolved,
        resolveOutputDir: () => dir,
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'patent_pdf_download', { patents: ['US1A'] }, 'p-12')
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(resolved).toHaveBeenCalledWith(expect.objectContaining({ patents: ['US1A'] }))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('propagates a setup_required from resolveRunner', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => ({ items: [] }),
        resolveRunner: () => Promise.reject(new PatentToolError('setup_required', 'no browser backend', { tool: 'patent_pdf_download' })),
        resolveOutputDir: () => dir,
      })
      await expect(tool.execute({ patents: ['US1A'] }, { signal } as never)).rejects.toMatchObject({ code: 'setup_required' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('wraps a non-tool error from resolveRunner as tool_execution_failed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => ({ items: [] }),
        resolveRunner: () => Promise.reject(new Error('resolution boom')),
        resolveOutputDir: () => dir,
      })
      await expect(tool.execute({ patents: ['US1A'] }, { signal } as never)).rejects.toMatchObject({ code: 'tool_execution_failed' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('retries a rate-limited fetch fallback and recovers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      let calls = 0
      const body = '%PDF-1.4 ' + 'x'.repeat(600)
      const fetchImpl = (async () => {
        calls += 1
        if (calls === 1) return new Response('', { status: 429, headers: { 'retry-after': '0' } })
        return new Response(body, { status: 200, headers: { 'content-type': 'application/pdf' } })
      }) as unknown as typeof fetch
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => ({ items: [{ channel: GOOGLE, patent: 'US1A', status: 'fallback', pdfUrl: 'https://cdn/US1A.pdf' }] }),
        resolveOutputDir: () => dir,
        fetchImpl,
        fetchFallbackRetry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5 },
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'patent_pdf_download', { patents: ['US1A'] }, 'p-ratelimit-retry')
      expect(calls).toBe(2)
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(text(result)).toContain('（fetch 兜底）')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('handles a non-Error thrown while reading the fallback body', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const badBody = (async () => ({ ok: true, status: 200, statusText: 'OK', headers: { get: () => 'application/pdf' }, arrayBuffer: async () => { throw 'body-boom' } })) as unknown as typeof fetch
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => ({ items: [{ channel: GOOGLE, patent: 'US1A', status: 'fallback', pdfUrl: 'https://cdn/US1A.pdf' }] }),
        resolveOutputDir: () => dir,
        fetchImpl: badBody,
        fetchFallbackRetry: { maxRetries: 0 },
      })
      const ctx = await ctxWith(tool)
      const result = await execute(ctx, 'patent_pdf_download', { patents: ['US1A'] }, 'p-bodyboom')
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected success')
      expect(text(result)).toContain('fetch fallback failed: body-boom')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports a 429 without a retry-after header and treats an empty retry config as one attempt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const rateLimited: typeof fetch = async () => new Response(null, { status: 429, statusText: 'Too Many Requests' })
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => ({ items: [{ channel: GOOGLE, patent: 'US1A', status: 'fallback', pdfUrl: 'https://cdn/US1A.pdf' }] }),
        resolveOutputDir: () => dir,
        fetchImpl: rateLimited,
        fetchFallbackRetry: {},
      })
      const value = (await tool.execute({ patents: ['US1A'] }, { signal } as never)) as {
        results: Array<{ error?: string; retryAfterMs?: number }>
      }
      expect(value.results[0]?.error).toContain('HTTP 429 (rate limited)')
      expect(value.results[0]?.error).not.toContain('等待约')
      expect(value.results[0]?.retryAfterMs).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('surfaces a rate-limit wait hint when the fetch fallback stays rate-limited', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const rateLimited = (async () => ({ ok: false, status: 429, statusText: 'Too Many Requests', headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '5' : null) }, arrayBuffer: async () => new ArrayBuffer(0) })) as unknown as typeof fetch
      const tool = createPatentPdfDownloadTool({
        runEgo: async () => ({ items: [{ channel: GOOGLE, patent: 'US1A', status: 'fallback', pdfUrl: 'https://cdn/US1A.pdf' }] }),
        resolveOutputDir: () => dir,
        fetchImpl: rateLimited,
        fetchFallbackRetry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 5 },
      })
      const value = (await tool.execute({ patents: ['US1A'] }, { signal } as never)) as {
        results: Array<{ status: string; networkErrorCode?: string; retryAfterMs?: number; error?: string }>
      }
      const [first] = value.results
      expect(first?.status).toBe('failed')
      expect(first?.networkErrorCode).toBe('network_rate_limited')
      expect(first?.retryAfterMs).toBe(5000)
      expect(first?.error).toContain('rate limited')
      expect(first?.error).toContain('等待约 5s 后重试')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('aborts a hanging fetch fallback at the attempt deadline instead of waiting on the caller', async () => {
    vi.useFakeTimers()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      const value = (await runHangingFallback(dir, { patents: ['US1A'], timeoutMs: 3_000 }, 3_000)) as {
        results: Array<{ status: string; networkErrorCode?: string; error?: string }>
      }
      const [first] = value.results
      expect(first?.status).toBe('failed')
      expect(first?.networkErrorCode).toBe('network_timeout')
    } finally {
      vi.useRealTimers()
      await rm(dir, { recursive: true, force: true })
    }
  }, 15_000)

  it('keeps a deadline for an absurdly small overall budget (attempt floor)', async () => {
    vi.useFakeTimers()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-pdf-'))
    try {
      // timeoutMs=1 均分到 1 次尝试后为 0ms，而 networkFetch 只在正整数时才装计时器：
      // 无下限时兜底会重新变成无期限（该用例在无下限的实现下永不收敛）。
      const value = (await runHangingFallback(dir, { patents: ['US1A'], timeoutMs: 1 }, 1_000)) as {
        results: Array<{ status: string; networkErrorCode?: string }>
      }
      expect(value.results[0]?.status).toBe('failed')
      expect(value.results[0]?.networkErrorCode).toBe('network_timeout')
    } finally {
      vi.useRealTimers()
      await rm(dir, { recursive: true, force: true })
    }
  }, 15_000)
})
