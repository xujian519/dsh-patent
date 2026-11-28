import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runFallback } from '../src/tool/patent-pdf-download-transfer.ts'
import { GOOGLE_PATENTS_CHANNEL, PATSNAP_CHANNEL } from '../src/tool/internal/upstream-channel.ts'
import type { FallbackRequest, PatentDownloadItem, PatentPdfDownloadDeps } from '../src/tool/patent-pdf-download.ts'
import type { FallbackLink } from '../src/tool/patent-pdf-download.ts'

/** A failed first-pass item. */
function failed(patent: string, error?: string): PatentDownloadItem {
  return {
    patent,
    status: 'failed',
    channel: GOOGLE_PATENTS_CHANNEL,
    ...(error === undefined ? {} : { error }),
  }
}

/** Minimal dependencies: only `resolveFallback` participates. */
function deps(
  resolveFallback?: (requests: readonly FallbackRequest[], options: { timeoutMs: number }) => Promise<readonly FallbackLink[]>,
): PatentPdfDownloadDeps {
  return {
    runEgo: async () => ({ items: [] }),
    ...(resolveFallback === undefined ? {} : { resolveFallback }),
  }
}

const PDF = new TextEncoder().encode('%PDF-1.4 ' + 'x'.repeat(600))

/** A fetch implementation that serves a valid PDF for `ok` and 404 otherwise. */
function fetchFor(ok: boolean): typeof fetch {
  return async () => ok
    ? new Response(PDF, { status: 200, headers: { 'content-type': 'application/pdf' } })
    : new Response('gone', { status: 404, statusText: 'Not Found' })
}

describe('runFallback', () => {
  it('does nothing without a fallback or without failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-fallback-'))
    try {
      await expect(runFallback([failed('US1A')], deps(), dir, { timeoutMs: 1 })).resolves.toEqual({ items: [], warnings: [] })
      await expect(runFallback([], deps(async () => []), dir, { timeoutMs: 1 })).resolves.toEqual({ items: [], warnings: [] })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports every request the resolver did not answer, with and without a reason', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-fallback-'))
    try {
      const result = await runFallback([failed('US1A'), failed('US2A', 'HTTP 403')], deps(async () => []), dir, { timeoutMs: 1 })
      expect(result.items[0]?.error).toBe('未取到 PDF；兜底通道未返回该号')
      expect(result.items[1]?.error).toBe('HTTP 403；兜底通道未返回该号')
      expect(result.warnings).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('names the record-level failure with and without the channel reason', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-fallback-'))
    try {
      const result = await runFallback([failed('US1A'), failed('US2A')], deps(async () => [
        { patent: 'US1A', channel: PATSNAP_CHANNEL, error: '记录没有 PDF' },
        { patent: 'US2A', channel: PATSNAP_CHANNEL },
      ]), dir, { timeoutMs: 1 })
      expect(result.items[0]?.error).toBe('未取到 PDF；记录没有 PDF')
      expect(result.items[1]?.error).toBe('未取到 PDF；兜底通道未给出 PDF')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('stringifies a non-Error resolver failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-fallback-'))
    try {
      const result = await runFallback([failed('US1A')], deps(async () => { throw 'offline' }), dir, { timeoutMs: 1 })
      expect(result.warnings[0]).toContain('offline')
      expect(result.items).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('downloads served links and keeps a distinct resolved number', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-fallback-'))
    try {
      const result = await runFallback([failed('US1A'), failed('US2A')], deps(async () => [
        { patent: 'US1A', channel: PATSNAP_CHANNEL, pdfUrl: 'https://data-pdf.example/US1A.pdf', resolvedNumber: 'US1B' },
        { patent: 'US2A', channel: PATSNAP_CHANNEL, pdfUrl: 'https://data-pdf.example/US2A.pdf' },
      ]), dir, { timeoutMs: 5_000, fetchImpl: fetchFor(true) })
      expect(result.items[0]?.status).toBe('ok')
      expect(result.items[0]?.resolvedNumber).toBe('US1B')
      expect(result.items[1]?.resolvedNumber).toBeUndefined()
      expect(result.warnings[0]).toContain('改由 PatSnap（智慧芽） 提供')
      expect(result.warnings[0]).toContain('无 PDF')
      expect(await readFile(join(dir, 'US1A.pdf'))).toBeTruthy()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps the original reason when the fallback download fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-patent-fallback-'))
    try {
      const result = await runFallback([failed('US1A', 'HTTP 403')], deps(async () => [
        { patent: 'US1A', channel: PATSNAP_CHANNEL, pdfUrl: 'https://data-pdf.example/US1A.pdf' },
      ]), dir, { timeoutMs: 5_000, fetchImpl: fetchFor(false), fetchRetry: { maxRetries: 0 } })
      expect(result.items[0]?.status).toBe('failed')
      expect(result.items[0]?.error).toContain('HTTP 403')
      expect(result.items[0]?.error).toContain('PatSnap（智慧芽）下载失败')
      expect(result.warnings).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
