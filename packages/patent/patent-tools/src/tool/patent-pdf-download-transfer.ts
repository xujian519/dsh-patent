/**
 * PDF 取回与兜底下载：把 Google Patents 给出的地址或 PatSnap 返回的地址落盘，
 * 校验状态码、Content-Type 与 PDF 魔数；首次下载失败的篇目在这里交给兜底通道。
 *
 * 与工具主模块分开，是因为这里只处理「一个地址 → 一个文件」和「一批失败 → 兜底
 * 地址」；通道选择、预算与结果编排留在 `patent-pdf-download.ts`。
 * @module @deepseek-ai/dsh-patent-tools/tool/patent-pdf-download-transfer
 */

import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { inspectPdfBody, isHtmlContentType, type PdfBodyFault } from '@deepseek-ai/dsh-patent-core'
import { networkFetch, NetworkFetchError, parseRetryAfterHeader, type NetworkRetryOptions } from '@deepseek-ai/dsh-tool-literature'
import { GOOGLE_PATENTS_CHANNEL } from './internal/upstream-channel.ts'
import type { FallbackLink, PatentDownloadItem, PatentPdfDownloadDeps } from './patent-pdf-download.ts'

/** fetch 兜底重试策略：吸收瞬时失败与限流（429/503），按 Retry-After 退避，上限 30s。 */
export const DEFAULT_FETCH_FALLBACK_RETRY: NetworkRetryOptions = { maxRetries: 2, baseDelayMs: 250, maxDelayMs: 30_000 }

/**
 * Google Patents CDN（patentimages.storage.googleapis.com）对非浏览器 UA 返回
 * 403，因此 fetch 兜底刻意使用浏览器 UA。
 */
const PATENT_DOWNLOAD_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
/** 限流重试提示（模型可见，用于替代盲 sleep）。 */
function rateLimitHint(retryAfterMs: number): string {
  return `，等待约 ${Math.max(1, Math.round(retryAfterMs / 1000))}s 后重试`
}

/** 三检失败文案（专利工具的措辞：魔数失配时带上实际前缀）。 */
function pdfBodyFaultMessage(fault: PdfBodyFault): string {
  return fault.code === 'magic'
    ? `invalid PDF magic: ${JSON.stringify(fault.prefix)}`
    : `response too small (${fault.bytes} bytes), likely an error page`
}

/** 一次 PDF 取回的结果；失败携带网络层分类与限流建议等待时长。 */
export type DownloadAttempt =
  | { ok: true; path: string; durationMs: number }
  | { ok: false; error: string; networkErrorCode?: string; retryAfterMs?: number; durationMs: number }

/**
 * 从 URL 取回一个 PDF 并落盘，校验状态码、Content-Type 与 PDF 魔数。
 * 每次尝试都有期限（`options.timeoutMs`），挂起的连接会在期限内收敛；
 * 重试耗尽仍限流时，返回 `network_rate_limited` 与建议等待时长。
 * @param url - PDF 地址（Google CDN 或 PatSnap 签名/公开地址）。
 * @param target - 落盘路径。
 * @param options - 取消信号、单次期限、fetch 注入与重试策略。
 * @returns 成功时的路径与耗时，或失败原因与网络层分类。
 */
export async function downloadPdfFromUrl(
  url: string,
  target: string,
  options: { signal?: AbortSignal; timeoutMs: number; fetchImpl?: typeof fetch; fetchRetry?: NetworkRetryOptions },
): Promise<DownloadAttempt> {
  const start = Date.now()
  const fetchFn = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchFn !== 'function') {
    return { ok: false, error: 'no fetch implementation available', durationMs: Date.now() - start }
  }
  try {
    const res = await networkFetch(
      url,
      { headers: { 'User-Agent': PATENT_DOWNLOAD_USER_AGENT, Accept: 'application/pdf' } },
      {
        /* v8 ignore next -- execute always passes exec.signal through. */
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        timeoutMs: options.timeoutMs,
        fetchImpl: fetchFn,
        retry: options.fetchRetry ?? DEFAULT_FETCH_FALLBACK_RETRY,
      },
    )
    if (!res.ok) {
      if (res.status === 429) {
        const retryAfterMs = parseRetryAfterHeader(res.headers.get('retry-after'))
        return {
          ok: false,
          error: `HTTP 429 (rate limited)${retryAfterMs === undefined ? '' : rateLimitHint(retryAfterMs)}`,
          networkErrorCode: 'network_rate_limited',
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
          durationMs: Date.now() - start,
        }
      }
      return { ok: false, error: `HTTP ${res.status} ${res.statusText}`, durationMs: Date.now() - start }
    }
    const contentType = res.headers.get('content-type') ?? ''
    if (isHtmlContentType(contentType)) {
      return { ok: false, error: `unexpected Content-Type: ${contentType}`, durationMs: Date.now() - start }
    }
    const buf = Buffer.from(await res.arrayBuffer())
    const fault = inspectPdfBody(buf)
    if (fault !== undefined) return { ok: false, error: pdfBodyFaultMessage(fault), durationMs: Date.now() - start }
    await writeFileAtomic(target, buf, { mode: 0o644 })
    return { ok: true, path: target, durationMs: Date.now() - start }
  } catch (fetchErr) {
    return {
      ok: false,
      error: fetchErr instanceof Error ? fetchErr.message : String(fetchErr),
      ...(fetchErr instanceof NetworkFetchError ? { networkErrorCode: fetchErr.code } : {}),
      durationMs: Date.now() - start,
    }
  }
}

/** 兜底通道失败时保留首次失败原因，并把兜底原因接在后面。 */
function withFallbackFailure(failure: PatentDownloadItem, reason: string): PatentDownloadItem {
  return { ...failure, error: `${failure.error ?? '未取到 PDF'}；${reason}` }
}

/**
 * 把首次下载失败的篇目交给兜底通道（生产：PatSnap），并下载它给出的地址。
 *
 * 兜底只在 Google 腿已经交付不了该篇时启动：没有 URL、HTTP 失败、返回页不是 PDF、
 * 或整条腿抛错。通道级失败（缺 Key、余额不足、限流）进 `warnings`，这些篇保持原失败；
 * 单篇失败把兜底原因接在原原因后面，报告能看出两个通道都试过。
 * @param failures - 首次下载失败的篇目（保持请求顺序）。
 * @param deps - 工具依赖（`resolveFallback` 缺省时不做任何事）。
 * @param outputDir - PDF 落盘目录。
 * @param options - 取消信号、单篇期限与 fetch 注入。
 * @returns 兜底成功的篇目与模型可见的告警。
 */
export async function runFallback(
  failures: readonly PatentDownloadItem[],
  deps: PatentPdfDownloadDeps,
  outputDir: string,
  options: { signal?: AbortSignal; timeoutMs: number; fetchImpl?: typeof fetch; fetchRetry?: NetworkRetryOptions },
): Promise<{ items: PatentDownloadItem[]; warnings: string[] }> {
  if (deps.resolveFallback === undefined || failures.length === 0) return { items: [], warnings: [] }
  let links: readonly FallbackLink[]
  try {
    links = await deps.resolveFallback(
      failures.map(failure => ({ patent: failure.patent, reason: failure.error ?? '未取到 PDF' })),
      { timeoutMs: options.timeoutMs, ...(options.signal === undefined ? {} : { signal: options.signal }) },
    )
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { items: [], warnings: [`兜底通道不可用（${detail}），${failures.length} 篇保持失败`] }
  }

  const byPatent = new Map(links.map(link => [link.patent, link]))
  const warnings: string[] = []
  const items = await Promise.all(failures.map(async (failure): Promise<PatentDownloadItem> => {
    const link = byPatent.get(failure.patent)
    if (link === undefined) return withFallbackFailure(failure, '兜底通道未返回该号')
    if (link.pdfUrl === undefined) return withFallbackFailure(failure, link.error ?? '兜底通道未给出 PDF')
    const attempt = await downloadPdfFromUrl(link.pdfUrl, join(outputDir, `${failure.patent}.pdf`), options)
    if (!attempt.ok) return withFallbackFailure(failure, `${link.channel}下载失败：${attempt.error}`)
    warnings.push(`${GOOGLE_PATENTS_CHANNEL} 未取到 ${failure.patent}（${failure.error ?? '无 PDF'}），改由 ${link.channel} 提供`)
    return {
      patent: failure.patent,
      status: 'ok',
      path: attempt.path,
      method: 'http',
      channel: link.channel,
      // 兜底通道的地址可能带签名与有效期：落盘即可，不把签名写进会话结果与 MANIFEST。
      ...(link.resolvedNumber === undefined || link.resolvedNumber === failure.patent
        ? {}
        : { resolvedNumber: link.resolvedNumber }),
      durationMs: attempt.durationMs,
    }
  }))
  return { items, warnings }
}
