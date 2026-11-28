/**
 * `patent_pdf_download` tool: batch-download patent PDFs from Google Patents
 * through an injected ego-browser runner, with a fetch fallback (bounded retry/
 * timeout, Retry-After-aware backoff) for the extracted CDN URL. Ported from
 * Sati's patentPdfDownload.ts.
 *
 * The ego-browser script construction (buildDownloadScript) and the Sati
 * session (EgoBrowserSession.runScript) are NOT ported here — the integrator
 * wires \`runEgo\` to \`ctx.patentData.createEgoSession()\`. This tool ports
 * validation, output-dir resolution, the MANIFEST resume (dedupe), the fetch
 * fallback, and the summary rendering. Per-patent telemetry (appendDownloadLog)
 * is dropped (Sati-specific ~/.sati/logs path).
 * @module @deepseek-ai/dsh-patent-tools/tool/patent-pdf-download
 */

import { appendFile, mkdir, readFile, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { resolveConfinedPath, resolveDatedOutputDir } from '@deepseek-ai/dsh-patent-core'
import type { NetworkRetryOptions } from '@deepseek-ai/dsh-tool-literature'
import { PatentToolError } from '../error.ts'
import { WARNINGS_SCHEMA, warningSection } from './internal/tool-output.ts'
import { GOOGLE_PATENTS_CHANNEL } from './internal/upstream-channel.ts'
import { DEFAULT_FETCH_FALLBACK_RETRY, downloadPdfFromUrl, runFallback } from './patent-pdf-download-transfer.ts'

const MAX_PATENTS = 50
/**
 * 默认整体超时推算参数：一篇的最坏预算 = 开页超时 + PDF 取回预算（两者都有可传入的
 * 默认值），整批再加一次设置开销。取值必须覆盖这两个预算之和：小于它时 ego 腿还没回退到
 * 页面解析 + HTTP 下载，整体超时就先掐断调用，预置 persona 承诺的降级路径走不到。
 * 上限取入参自身的上限 300s。
 */
const PER_BATCH_OVERHEAD_MS = 15_000
const MIN_DEFAULT_TIMEOUT_MS = 60_000
const MAX_DEFAULT_TIMEOUT_MS = 300_000
/** 断点续传 MANIFEST 文件名（`<outputDir>/.MANIFEST.jsonl`，append 追加式）。 */
const MANIFEST_FILE = '.MANIFEST.jsonl'
/**
 * fetch 兜底每次尝试的期限下限。整体预算按尝试次数均分后可能小于 1s（调用方显式传很小的
 * `timeoutMs`），而 `networkFetch` 只在正整数时才装计时器——无下限会让兜底重新变成无期限。
 */
const MIN_FETCH_FALLBACK_TIMEOUT_MS = 1_000

/** Input for the patent_pdf_download tool. */
export type PatentPdfDownloadInput = {
  /** 专利公开号/授权公告号列表（CN/US/EP/WO…），1-50 篇。 */
  patents: string[]
  /** 输出目录（相对当前工作目录，或留在工作目录内的绝对路径；越界会被拒绝）；默认 <cwd>/专利原文/YYYY-MM-DD。 */
  outputDir?: string
  /** 每页打开超时（秒），默认 20。 */
  pageTimeoutSec?: number
  /** 每篇取回 PDF 响应体的超时（毫秒），默认 60_000。 */
  downloadTimeoutMs?: number
  /** 整体执行超时（毫秒）；默认按 `篇数 × (pageTimeoutSec × 1000 + downloadTimeoutMs) + 15_000` 推算，夹在 60_000–300_000 之间。 */
  timeoutMs?: number
  /** 是否截图留证（页面证据截图），默认 false。 */
  record?: boolean
  /** 忽略 MANIFEST 断点续传，强制重跑全部专利（默认 false）。 */
  force?: boolean
}

/** One patent PDF download result. */
export type PatentDownloadItem = {
  patent: string
  status: 'ok' | 'failed'
  /** status=ok 时的落盘路径。 */
  path?: string
  /** 提取到的 CDN PDF 链接（诊断 / 手动重试用）。 */
  pdfUrl?: string
  /** 失败原因。 */
  error?: string
  /** 落盘方式：browser=浏览器内取回响应体，http=fetch 兜底，skip=MANIFEST 续传命中。 */
  method?: 'browser' | 'http' | 'skip'
  /** fetch 兜底路径的下载耗时（毫秒）。 */
  durationMs?: number
  /** 网络层错误码（network_rate_limited / network_timeout 等），供按码路由与诊断。 */
  networkErrorCode?: string
  /** 限流建议等待时长（毫秒，由 Retry-After 推测），供模型决定何时重试。 */
  retryAfterMs?: number
  /** 产出该篇的通道名；报告据此写明原文取白哪个通道，不必从 pdfUrl 反推。 */
  channel: string
  /** 该篇文件的取数时间（ISO-8601）：本次落盘的时间，或续传命中时 MANIFEST 记录的下载时间。 */
  retrievedAt?: string
  /** 同族替代时实际取到的公开号（PatSnap 的 `pn_related`）；与 `patent` 相同时省略。 */
  resolvedNumber?: string
}

/** Output of the patent_pdf_download tool. */
export type PatentPdfDownloadOutput = {
  results: PatentDownloadItem[]
  summary: { total: number; ok: number; failed: number }
  outputDir: string
  /** record=true 且截图成功时的证据目录路径。 */
  recorded?: string
  /** 通道级告警（某通道被咨询过但未能服务，或某篇无直链而改走另一通道）。 */
  warnings: string[]
}

/** 单篇下载结果（脚本侧只产生 ok / fallback）；`channel` 是实际服务的通道。 */
export type EgoDownloadItem = {
  patent: string
  status: 'ok' | 'fallback'
  path?: string
  pdfUrl?: string
  error?: string
  /** 产出该篇的通道名（见 internal/upstream-channel.ts 的通道常量）。 */
  channel: string
}

/** 批量下载结果。 */
export type EgoDownloadResult = {
  items: EgoDownloadItem[]
  /** 截图证据目录路径（record=true 且成功时）。 */
  recorded?: string
  /**
   * 模型可见的告警：某个通道被咨询过但没能服务（例如 CNIPR 登录态失效），
   * 说明该篇由哪个通道接手，避免把通道不可用读成「不需要第二个通道」。
   */
  warnings?: string[]
}

/** 传给注入的 ego-browser runner 的批量下载参数。 */
export type EgoDownloadRequest = {
  patents: string[]
  outputDir: string
  pageTimeoutSec: number
  downloadTimeoutMs: number
  record: boolean
  timeoutMs: number
  signal?: AbortSignal
}

/** 注入的 ego-browser 批量下载 runner。 */
export type RunEgo = (request: EgoDownloadRequest) => Promise<EgoDownloadResult>

/** 一次兜底请求：哪篇、Google 腿给出的失败原因。 */
export type FallbackRequest = {
  /** 专利公开号。 */
  patent: string
  /** Google 腿未能交付该篇的原因。 */
  reason: string
}

/** 兜底通道给出的结果：下载地址，或该篇失败的原因。 */
export type FallbackLink = {
  /** 专利公开号。 */
  patent: string
  /** 可直接下载的 PDF 地址；失败时省略。 */
  pdfUrl?: string
  /** 实际服务的通道名（模型可见）。 */
  channel: string
  /** 同族替代时实际取到的公开号。 */
  resolvedNumber?: string
  /** 该篇在兜底通道上的失败原因。 */
  error?: string
}

/** 注入的兜底通道：一次拿到整批失败项的下载地址。 */
export type ResolveFallback = (
  requests: readonly FallbackRequest[],
  options: { timeoutMs: number; signal?: AbortSignal },
) => Promise<readonly FallbackLink[]>

/** MANIFEST 条目（与 Sati 契约一致）。 */
type PatentManifestEntry = {
  patent: string
  status: 'ok' | 'failed'
  path?: string
  size?: number
  sha1?: string
  ts: number
  /**
   * 产出该篇的通道（见 internal/upstream-channel.ts 的通道常量）。续传时据此点名通道；
   * 本字段之前写下的条目没有它，那时既记不住也回不了头——缺省表示「该条未记录通道」。
   */
  channel?: string
}

/** A MANIFEST resume hit as a download result; `retrievedAt` is the recorded download time. */
function resumedDownloadItem(patent: string, entry: PatentManifestEntry, path: string): PatentDownloadItem {
  return {
    patent,
    status: 'ok',
    path,
    method: 'skip',
    channel: entry.channel ?? '',
    retrievedAt: new Date(entry.ts).toISOString(),
  }
}

/** A freshly downloaded item carries this call's time; a failed item carries none. */
function withRetrievalTime(item: PatentDownloadItem): PatentDownloadItem {
  return item.status === 'ok' ? { ...item, retrievedAt: new Date().toISOString() } : item
}

/** Injected patent-PDF-download dependencies. */
export type PatentPdfDownloadDeps = {
  /** ego-browser batch runner (production wires ctx.patentData.createEgoSession()). */
  runEgo: RunEgo
  /** Working directory used to resolve a relative outputDir (default process.cwd()). */
  cwd?: string
  /** Resolve the output directory (defaults to <cwd>/专利原文/YYYY-MM-DD). */
  resolveOutputDir?: (outputDir: string | undefined, cwd: string) => string
  /** fetch implementation for the CDN fallback (defaults to globalThis.fetch). */
  fetchImpl?: typeof fetch
  /** Override the CDN fallback retry policy (defaults to DEFAULT_FETCH_FALLBACK_RETRY). */
  fetchFallbackRetry?: NetworkRetryOptions
  /** Resolve the batch runner from a browser-backend cold decision (defaults to runEgo). */
  resolveRunner?: () => Promise<RunEgo> | RunEgo
  /**
   * 兜底通道：Google 腿交付不了的篇目交给它（生产接线到 PatSnap）。
   * 未注入时行为与之前一致：这些篇以失败结束。
   */
  resolveFallback?: ResolveFallback
}

/**
 * Normalize a patent number: trim, upper-case, and strip whitespace/separators.
 * @param value - the raw patent number.
 * @returns the normalized number.
 */
export function normalizePatentNumber(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[\s\-:/]/g, '')
}

/**
 * 默认输出目录解析：显式 outputDir 要求真实位置留在 cwd 内，否则 <cwd>/专利原文/YYYY-MM-DD。
 *
 * 该目录既接收下载的 PDF 与截图，又作为 ego-browser 子进程的 cwd，因此与
 * `patent-document`、`patent-filing` 一致走 {@link resolveConfinedPath}：`../` 串联、
 * 根外绝对路径与根内指向根外的 symlink 都会在这里被拒。
 */
function defaultResolveOutputDir(outputDir: string | undefined, cwd: string): string {
  if (outputDir === undefined) return resolveDatedOutputDir(undefined, cwd, '专利原文')
  return resolveConfinedPath(
    outputDir,
    cwd,
    '输出目录',
    message => new PatentToolError('invalid_tool_input', message, { tool: 'patent_pdf_download' }),
  )
}

/** 校验 + 归一化 + 去重专利号（含目录穿越拒绝）。 */
function validatePatents(patents: string[]): string[] {
  const normalized = patents.map(normalizePatentNumber).filter(n => n.length > 0)
  const unique = [...new Set(normalized)]
  if (unique.length === 0) {
    throw new PatentToolError('invalid_tool_input', 'patents must contain at least one non-empty number', {
      tool: 'patent_pdf_download',
    })
  }
  if (unique.length > MAX_PATENTS) {
    throw new PatentToolError('invalid_tool_input', `patents exceeds the maximum of ${MAX_PATENTS}`, {
      tool: 'patent_pdf_download',
    })
  }
  const traversal = unique.filter(n => n.includes('\\') || n.includes('..'))
  if (traversal.length > 0) {
    throw new PatentToolError(
      'invalid_tool_input',
      `patents contain path traversal characters: ${traversal.join(', ')}`,
      { tool: 'patent_pdf_download' },
    )
  }
  return unique
}

/**
 * Reject a defined integer value outside [min, max], throwing an
 * invalid_tool_input error for the patent_pdf_download tool.
 * @param value - the candidate value (undefined passes through).
 * @param min - inclusive lower bound.
 * @param max - inclusive upper bound.
 * @param message - the error message when the value is out of range.
 */
function requireIntRange(value: number | undefined, min: number, max: number, message: string): void {
  if (value !== undefined && (!Number.isInteger(value) || value < min || value > max)) {
    throw new PatentToolError('invalid_tool_input', message, { tool: 'patent_pdf_download' })
  }
}

/** 磁盘文件大小与 MANIFEST 记录一致才算命中续传。 */
async function fileSizeMatches(path: string, expectedSize: number): Promise<boolean> {
  try {
    const st = await stat(path)
    return st.size === expectedSize
  } catch {
    return false
  }
}

/**
 * 加载 MANIFEST。按 patent 键去重（append 式积累的重复行最后一条 wins）；
 * 损坏行容忍跳过，文件不存在返回空。
 */
async function loadManifest(outputDir: string): Promise<Map<string, PatentManifestEntry>> {
  const manifestPath = join(outputDir, MANIFEST_FILE)
  let raw: string
  try {
    raw = await readFile(manifestPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
    throw error
  }
  const byPatent = new Map<string, PatentManifestEntry>()
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let entry: PatentManifestEntry | null
    try {
      entry = JSON.parse(trimmed) as PatentManifestEntry | null
    } catch (error) {
      // 单行损坏：跳过该行，其余行仍生效
      void error
      continue
    }
    if (entry && typeof entry.patent === 'string' && entry.status === 'ok') {
      byPatent.set(entry.patent, entry)
    }
  }
  return byPatent
}

/** 追加一条 MANIFEST 记录。 */
async function saveManifestEntry(outputDir: string, entry: PatentManifestEntry): Promise<void> {
  const manifestPath = join(outputDir, MANIFEST_FILE)
  await appendFile(manifestPath, JSON.stringify(entry) + '\n', 'utf8')
}

/** 计算文件 SHA-1（写 MANIFEST 用）。 */
async function sha1OfFile(path: string): Promise<string> {
  const data = await readFile(path)
  return createHash('sha1').update(data).digest('hex')
}

/**
 * 为已落盘的下载结果追加一条 MANIFEST 续传记录。
 * 文件不可读（stat/读盘失败）时抛错，由调用方放弃该条记录。
 * @param outputDir - 输出目录。
 * @param item - 本次下载成功的结果（path 必填）。
 * @returns 写入完成。
 */
async function recordDownloadedFile(outputDir: string, item: PatentDownloadItem & { path: string }): Promise<void> {
  const st = await stat(item.path)
  await saveManifestEntry(outputDir, {
    patent: item.patent,
    status: 'ok',
    path: item.path,
    size: st.size,
    sha1: await sha1OfFile(item.path),
    ts: Date.now(),
    channel: item.channel,
  })
}

/**
 * 浏览器拦截条目兜底：脚本返回 fallback（已提取 CDN URL）时，用 fetch 直接
 * 下载落盘。成功升格为 ok（method=http）；失败标记 failed（保留 pdfUrl 供重试）。
 *
 * 与 Sati 的差异：Sati 经 networkFetch 流式写盘；本端口用注入的 fetchImpl
 * 整读入内存（20MB 级 PDF）落盘。每次尝试都有期限（`options.timeoutMs`，由调用方
 * 从整体预算均分得出），因此挂起的 CDN 连接会在期限内以 network_timeout 收敛，
 * 而不是只等调用方取消；重试耗尽仍限流时，在失败项给出 networkErrorCode 与
 * retryAfterMs，并把建议等待时长写入 error，让模型据此重试而非盲 sleep。
 */
async function fetchPdfFallback(
  item: EgoDownloadItem,
  outputDir: string,
  options: { signal?: AbortSignal; timeoutMs: number; fetchImpl?: typeof fetch; fetchRetry?: NetworkRetryOptions },
): Promise<PatentDownloadItem> {
  if (item.status === 'ok') {
    return {
      patent: item.patent,
      status: 'ok',
      ...(item.path === undefined ? {} : { path: item.path }),
      ...(item.pdfUrl === undefined ? {} : { pdfUrl: item.pdfUrl }),
      method: 'browser',
      channel: item.channel,
    }
  }
  if (!item.pdfUrl) {
    return {
      patent: item.patent,
      status: 'failed',
      channel: item.channel,
      ...(item.error === undefined ? {} : { error: item.error }),
    }
  }
  const pdfUrl: string = item.pdfUrl
  const attempt = await downloadPdfFromUrl(pdfUrl, join(outputDir, `${item.patent}.pdf`), options)
  if (attempt.ok) {
    return {
      patent: item.patent,
      status: 'ok',
      path: attempt.path,
      pdfUrl,
      method: 'http',
      channel: item.channel,
      durationMs: attempt.durationMs,
    }
  }
  const base = item.error ? `${item.error}; ` : ''
  return {
    patent: item.patent,
    status: 'failed',
    pdfUrl,
    channel: item.channel,
    ...(attempt.networkErrorCode === undefined ? {} : { networkErrorCode: attempt.networkErrorCode }),
    ...(attempt.retryAfterMs === undefined ? {} : { retryAfterMs: attempt.retryAfterMs }),
    error: `${base}fetch fallback failed: ${attempt.error}`,
    durationMs: attempt.durationMs,
  }
}

function summarize(results: PatentDownloadItem[], total: number): { total: number; ok: number; failed: number } {
  const ok = results.filter(r => r.status === 'ok').length
  return { total, ok, failed: total - ok }
}

/** 落盘方式的中文标注（formatSummary 行内后缀）。 */
const METHOD_LABELS: Record<string, string> = {
  http: '（fetch 兜底）',
  skip: '（已下载，跳过）',
}

/**
 * Render the canonical download value into model-facing prose. 每行点名通道：报告写「原文
 * 取自哪个通道」时据此引用，不必从 pdfUrl 反推是谁给的直链。
 */
function renderPdfDownload(value: PatentPdfDownloadOutput): string {
  const lines: string[] = [
    `下载完成：${value.summary.ok}/${value.summary.total} 成功，${value.summary.failed} 失败`,
    `输出目录：${value.outputDir}`,
  ]
  if (value.recorded) lines.push(`截图留证：${value.recorded}`)
  for (const r of value.results) {
    // 通道未知只发生在旧 MANIFEST 的续传条目上：那时省略该子句，不编一个通道名。
    const channelNote = r.channel === '' ? '' : ` · 通道：${r.channel}`
    if (r.status === 'failed') {
      const retry = r.pdfUrl ? `；可手动重试：${r.pdfUrl}` : ''
      lines.push(`- ${r.patent}: 失败（${r.error ?? 'unknown'}${retry}）${channelNote}`)
    } else {
      /* v8 ignore next -- fallback results always carry a method for ok items. */
      const method = METHOD_LABELS[r.method ?? ''] ?? ''
      const resolved = r.resolvedNumber === undefined ? '' : ` · 同族替代：${r.resolvedNumber}`
      lines.push(`- ${r.patent}: ${r.path ?? 'ok'}${method}${channelNote}${resolved}`)
    }
  }
  const warningLines = warningSection(value.warnings, '通道告警')
  return [...lines, ...warningLines].join('\n')
}

const ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    patent: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['ok', 'failed'] },
    path: { type: 'string' },
    pdfUrl: { type: 'string' },
    error: { type: 'string' },
    method: { type: 'string', enum: ['browser', 'http', 'skip'] },
    durationMs: { type: 'number' },
    networkErrorCode: { type: 'string' },
    retryAfterMs: { type: 'number' },
    channel: { type: 'string', required: true },
    retrievedAt: { type: 'string' },
    resolvedNumber: { type: 'string' },
  },
} as const

const DESCRIPTION = [
  '批量下载专利 PDF。输入 patents 为公开号列表（CN123456789A、US11452699B2、EP1234567A1、WO2023123456A1…），保存为 `<outputDir>/<patent>.pdf`。下载通道按顺序降级并逐篇点名：先走 Google Patents——优先经 ego-browser（ego lite）在浏览器内取回 PDF 响应体，取不到时提取 CDN PDF 链接后用 HTTP 直接下载落盘；该篇仍拿不到有效 PDF 时，在部署启用 PatSnap 的情况下交给 PatSnap 兜底（按公开号换 PDF 直链，同族替代时在结果里写明实际取到的号）。每篇结果为 status=ok（带 path、method 与 channel）或 status=failed（带 error 与 channel，且保留 pdfUrl 供手动重试）；失败不中断其余专利。',
  '',
  'Usage notes:',
  '  - 每篇的 channel 是实际产出该篇的通道；某通道被咨询过但未能服务时，结果另在 warnings 里点名，报告据此区分「换通道」与「同通道重试」',
  '  - 同族替代时 resolvedNumber 是文件里实际印的公开号；报告引用原文号，不要把它当成请求号',
  '  - 重复执行命中 MANIFEST 断点续传（size 匹配即跳过，method=skip），force=true 强制重下；续传条目的 channel 与 retrievedAt 取自 MANIFEST 记录（本字段之前写下的条目没有记录，输出里该篇不带通道/取数时间）',
  '  - retrievedAt 是该篇文件的取数时间（本次落盘时间，或续传命中时 MANIFEST 记录的下载时间），报告据此写明原文是何时取得的',
  '  - record=true 可额外截图留证（输出 `<outputDir>/evidence/`）',
  '  - HTTP 兜底对瞬时失败/限流（429/503）自动重试并按 Retry-After 退避；重试后仍 429 时 error 会注明限流与建议等待时长（并可结合 retryAfterMs），此时应等待后再重试而非立即重试',
].join('\n')
/**
 * Run the Google Patents leg. A channel-level failure is not a batch failure when a
 * fallback is wired: the leg's items become per-patent failures carrying the reason,
 * and the tool's fallback pass takes over. Without a fallback the failure stays loud.
 * @param patents - pending numbers.
 * @param deps - tool dependencies (runner plus optional fallback).
 * @param options - output directory, per-page and per-download budgets, batch budget, recording, and cancellation.
 * @returns the Google leg's items and warnings.
 */
async function runGoogleLeg(
  patents: readonly string[],
  deps: PatentPdfDownloadDeps,
  options: {
    outputDir: string
    pageTimeoutSec: number
    downloadTimeoutMs: number
    record: boolean
    timeoutMs: number
    signal: AbortSignal
  },
): Promise<EgoDownloadResult> {
  try {
    const runner = deps.resolveRunner !== undefined ? await deps.resolveRunner() : deps.runEgo
    return await runner({
      patents: [...patents],
      outputDir: options.outputDir,
      pageTimeoutSec: options.pageTimeoutSec,
      downloadTimeoutMs: options.downloadTimeoutMs,
      record: options.record,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    })
  } catch (error) {
    if (options.signal.aborted) {
      throw new PatentToolError('tool_aborted', 'patent_pdf_download aborted', { tool: 'patent_pdf_download' })
    }
    // 配置类失败（未接线的 fail-loud 桩）保留 setup_required 码，供按码路由的调用方判别。
    if (error instanceof PatentToolError && error.code === 'setup_required') throw error
    const detail = error instanceof Error ? error.message : String(error)
    if (deps.resolveFallback === undefined) {
      throw new PatentToolError('tool_execution_failed', `patent_pdf_download failed: ${detail}`, {
        tool: 'patent_pdf_download',
      })
    }
    // Google 整腿失败不是整批失败：这批号交给兜底通道，失败原因保留在每篇上。
    return {
      items: patents.map((patent): EgoDownloadItem => ({
        patent,
        status: 'fallback',
        channel: GOOGLE_PATENTS_CHANNEL,
        error: `通道失败：${detail}`,
      })),
      warnings: [`${GOOGLE_PATENTS_CHANNEL} 通道失败（${detail}），${patents.length} 篇改由兜底通道处理`],
    }
  }
}

/**
 * Build the `patent_pdf_download` tool over an injected ego-browser runner.
 * @param deps - the runner plus optional cwd / output-dir resolver / fetch impl.
 * @returns a registry-ready tool definition.
 */
export function createPatentPdfDownloadTool(deps: PatentPdfDownloadDeps): ToolDefinition {
  const resolveDir = deps.resolveOutputDir ?? defaultResolveOutputDir
  return defineTool({
    name: 'patent_pdf_download',
    description: DESCRIPTION,
    parameters: {
      patents: { type: 'array', required: true, items: { type: 'string' }, description: '专利公开号列表（1-50 篇）' },
      outputDir: { type: 'string', description: '输出目录（相对当前工作目录；越出工作目录的路径会被拒绝）；默认 <cwd>/专利原文/YYYY-MM-DD' },
      pageTimeoutSec: { type: 'number', description: '每页打开超时（秒），默认 20' },
      downloadTimeoutMs: { type: 'number', description: '每篇取回 PDF 响应体的超时（毫秒），默认 60000' },
      timeoutMs: { type: 'number', description: '单腿执行预算（毫秒）：Google 腿与 PatSnap 兜底腿各自按它设期限，不是整批墙钟上限，最坏情形两腿各用满预算。默认 clamp(篇数 × (pageTimeoutSec × 1000 + downloadTimeoutMs) + 15000, 60000, 300000)，上限 300000' },
      record: { type: 'boolean', description: '是否截图留证（默认 false）' },
      force: { type: 'boolean', description: '忽略 MANIFEST 断点续传，强制重下全部（默认 false）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: { type: 'array', required: true, items: ITEM_SCHEMA },
          summary: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              total: { type: 'integer', required: true },
              ok: { type: 'integer', required: true },
              failed: { type: 'integer', required: true },
            },
          },
          outputDir: { type: 'string', required: true },
          recorded: { type: 'string' },
          warnings: WARNINGS_SCHEMA,
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderPdfDownload(value) }],
    },
    async execute(args, exec) {
      const patents = validatePatents(args.patents)

      const pageTimeoutSec = args.pageTimeoutSec
      requireIntRange(pageTimeoutSec, 5, 60, 'pageTimeoutSec must be an integer between 5 and 60')
      const downloadTimeoutMs = args.downloadTimeoutMs
      requireIntRange(downloadTimeoutMs, 5_000, 300_000, 'downloadTimeoutMs must be between 5000 and 300000')
      const timeoutMs = args.timeoutMs
      requireIntRange(timeoutMs, 1, 300_000, 'timeoutMs must be between 1 and 300000')

      const cwd = deps.cwd ?? process.cwd()
      const outputDir = resolveDir(args.outputDir, cwd)
      await mkdir(outputDir, { recursive: true })

      const pageTimeoutSecValue = pageTimeoutSec ?? 20
      const downloadTimeoutMsValue = downloadTimeoutMs ?? 60_000
      const perPatentMs = pageTimeoutSecValue * 1000 + downloadTimeoutMsValue
      const timeoutMsValue =
        timeoutMs ??
        Math.min(
          MAX_DEFAULT_TIMEOUT_MS,
          Math.max(MIN_DEFAULT_TIMEOUT_MS, patents.length * perPatentMs + PER_BATCH_OVERHEAD_MS),
        )
      const record = args.record === true
      const force = args.force === true

      // 断点续传：status=ok 且磁盘 size 匹配的专利跳过；--force 时全部视为未下载。
      const manifest = await loadManifest(outputDir)
      const skipped: PatentDownloadItem[] = []
      let pending: string[]
      if (force) {
        pending = patents
      } else {
        pending = []
        for (const patent of patents) {
          const entry = manifest.get(patent)
          if (entry?.path && entry.size !== undefined && (await fileSizeMatches(entry.path, entry.size))) {
            skipped.push(resumedDownloadItem(patent, entry, entry.path))
          } else {
            pending.push(patent)
          }
        }
      }
      if (pending.length === 0) {
        const summary = { total: patents.length, ok: patents.length, failed: 0 }
        return { results: skipped, summary, outputDir, warnings: [] }
      }

      const egoResult = await runGoogleLeg(pending, deps, {
        outputDir,
        pageTimeoutSec: pageTimeoutSecValue,
        downloadTimeoutMs: downloadTimeoutMsValue,
        record,
        timeoutMs: timeoutMsValue,
        signal: exec.signal,
      })

      // 兜底：浏览器拦截不可用或失败时，用 fetch 下载 CDN PDF。把整体预算均分到
      // 各次尝试（含首次），使每次尝试都有期限；总时长最坏为 尝试次数 × 该值 + 退避。
      const fallbackRetry = deps.fetchFallbackRetry ?? DEFAULT_FETCH_FALLBACK_RETRY
      const fallbackAttempts = 1 + (fallbackRetry.maxRetries ?? 0)
      const fallbackTimeoutMs = Math.max(MIN_FETCH_FALLBACK_TIMEOUT_MS, Math.floor(timeoutMsValue / fallbackAttempts))
      const firstPass = await Promise.all(
        egoResult.items.map(item =>
          fetchPdfFallback(item, outputDir, {
            signal: exec.signal,
            timeoutMs: fallbackTimeoutMs,
            ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
            ...(deps.fetchFallbackRetry === undefined ? {} : { fetchRetry: deps.fetchFallbackRetry }),
          }),
        ),
      )
      const fallback = await runFallback(
        firstPass.filter(item => item.status === 'failed'),
        deps,
        outputDir,
        {
          signal: exec.signal,
          timeoutMs: timeoutMsValue,
          ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
          ...(deps.fetchFallbackRetry === undefined ? {} : { fetchRetry: deps.fetchFallbackRetry }),
        },
      )
      const fallbackByPatent = new Map(fallback.items.map(item => [item.patent, item]))
      const results = firstPass.map(item => fallbackByPatent.get(item.patent) ?? item)

      // 下载成功的条目追加进 MANIFEST；落盘文件不可读时放弃续传记录，不阻断结果。
      for (const r of results) {
        if (r.status === 'ok' && r.path) {
          try {
            await recordDownloadedFile(outputDir, { ...r, path: r.path })
          } catch (error) {
            // 续传记录失败不影响本次下载结果
            void error
          }
        }
      }

      const allResults = [...skipped, ...results.map(withRetrievalTime)]
      const summary = summarize(allResults, patents.length)
      return {
        results: allResults,
        summary,
        outputDir,
        warnings: [...(egoResult.warnings ?? []), ...fallback.warnings],
        ...(egoResult.recorded === undefined ? {} : { recorded: egoResult.recorded }),
      }
    },
  })
}
