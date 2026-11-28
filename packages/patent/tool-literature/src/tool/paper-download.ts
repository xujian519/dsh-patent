/**
 * `paper_download` tool: download one academic paper's PDF from the literature
 * connectors. The direct link wins (arXiv extra.pdf / OpenAlex
 * best_oa_location.pdf_url, open_access.oa_url / Semantic Scholar
 * openAccessPdf), verified by PDF magic and minimum size; when the direct link
 * is missing or the fetch fails (403/404/HTML shell page), the ego extractor
 * opens the record page, extracts the PDF link, and the same fetch path
 * downloads it. Mirrors the patent_pdf_download channel design.
 * @module @deepseek-ai/dsh-tool-literature/tool/paper-download
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { inspectPdfBody, isHtmlContentType, resolveDatedOutputDir, type PdfBodyFault } from '@deepseek-ai/dsh-patent-core'
import { EgoExtractor, type PageExtractor } from '@deepseek-ai/dsh-browser-backend'
import type { Connector } from '../protocol/types.ts'
import type { ConnectorRegistry } from '../runtime/connector-registry.ts'
import { abortReason } from '../runtime/http.ts'
import { LiteratureToolError } from '../error.ts'
import { describeSourceError } from './source-error.ts'

/** Browser UA for sources that reject non-browser clients. */
const PAPER_DOWNLOAD_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
/** Whole-call timeout default (ms). */
const DEFAULT_TIMEOUT_MS = 60_000
/** JS expression yielding the first PDF link on a paper record page. */
const PDF_LINK_EXPR = '(() => { const a = document.querySelector(\'a[href$=".pdf"], a[href*="/pdf/"], a[href*=".pdf?"]\'); return a ? a.href : null })()'

/** Input for the paper_download tool. */
export type PaperDownloadInput = {
  /** Database id from paper_list_sources (e.g. "arxiv", "openalex"). */
  db: string
  /** Paper id from a paper_search hit. */
  id: string
  /** Direct PDF link override (skips the connector's pdf_url resolution). */
  pdfUrl?: string
  /** Output directory (absolute or relative to cwd); default <cwd>/论文原文/YYYY-MM-DD. */
  outputDir?: string
  /** Whole-call timeout in ms (default 60000, max 300000). */
  timeoutMs?: number
}

/** One paper download result. */
export type PaperDownloadResult = {
  status: 'ok' | 'failed'
  /** status=ok 时的落盘路径。 */
  path?: string
  /** 实际下载的 PDF 链接（诊断 / 手动重试用）。 */
  pdfUrl?: string
  /** 失败原因。 */
  error?: string
  /** 落盘方式：direct=直链 fetch，browser=browser-use 提取链接后 fetch。 */
  method?: 'direct' | 'browser'
}

/** Output of the paper_download tool. */
export type PaperDownloadOutput = {
  db: string
  id: string
  result: PaperDownloadResult
  outputDir: string
}

/** Injected paper-download dependencies. */
export type PaperDownloadDeps = {
  /** The literature connector registry (resolves the db's fetch + record url). */
  registry: ConnectorRegistry
  /** fetch implementation for the PDF download (defaults to globalThis.fetch). */
  fetchImpl?: typeof fetch
  /** Page extractor for the browser fallback channel (defaults to a fresh ego extractor). */
  extractor?: PageExtractor
  /** Working directory used to resolve a relative outputDir (default process.cwd()). */
  cwd?: string
  /** Resolve the output directory (defaults to <cwd>/论文原文/YYYY-MM-DD). */
  resolveOutputDir?: (outputDir: string | undefined, cwd: string) => string
}

/** 三检失败文案（与 patent_pdf_download 同措辞；魔数失配不回报实际前缀）。 */
function pdfBodyFaultMessage(fault: PdfBodyFault): string {
  return fault.code === 'magic'
    ? 'invalid PDF magic'
    : `response too small (${fault.bytes} bytes), likely an error page`
}

/** Default output directory resolution: explicit outputDir relative to cwd, else <cwd>/论文原文/YYYY-MM-DD. */
function defaultResolveOutputDir(outputDir: string | undefined, cwd: string): string {
  return resolveDatedOutputDir(outputDir, cwd, '论文原文')
}

/** A fetched PDF body with the download duration. */
export type FetchedPdf = { ok: true; body: Buffer; durationMs: number }

/** Download a URL and verify it is a real PDF (magic + minimum size + not an HTML shell). */
async function fetchPdfBody(
  url: string,
  options: { signal: AbortSignal; callerSignal: AbortSignal; timeoutMs: number; fetchImpl?: typeof fetch },
): Promise<FetchedPdf | { ok: false; error: string; durationMs: number }> {
  const start = Date.now()
  try {
    const fetchFn = options.fetchImpl ?? globalThis.fetch
    const res = await fetchFn(url, {
      headers: { 'User-Agent': PAPER_DOWNLOAD_USER_AGENT, Accept: 'application/pdf' },
      signal: options.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`)
    const contentType = res.headers.get('content-type') ?? ''
    if (isHtmlContentType(contentType)) throw new Error(`unexpected Content-Type: ${contentType}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const fault = inspectPdfBody(buf)
    if (fault !== undefined) throw new Error(pdfBodyFaultMessage(fault))
    return { ok: true, body: buf, durationMs: Date.now() - start }
  } catch (error) {
    // A caller cancellation is not a download fault; the whole-call deadline is.
    if (isAborted(options.callerSignal)) throw error
    if (isAborted(options.signal)) return { ok: false, error: timeoutMessage(options.timeoutMs), durationMs: Date.now() - start }
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - start,
    }
  }
}

/**
 * Resolve the PDF link for a download: an explicit override wins, else the
 * connector record's PDF field. A connector `fetch` returns its raw source
 * record (arXiv `pdf`, OpenAlex `best_oa_location.pdf_url` /
 * `open_access.oa_url`, Semantic Scholar `openAccessPdf.url`, Crossref none) or
 * a normalized hit carrying those under `.extra`; accept both so the source
 * record is read without its wrapper.
 */
function pdfUrlFrom(
  record: unknown,
  direct: string | undefined,
): { pdfUrl: string } | { error: string } {
  if (direct !== undefined && direct.trim() !== '') return { pdfUrl: direct.trim() }
  // record may be null when the connector exposes no fetch; every access is optional-chained.
  const r = record as {
    extra?: { pdf_url?: unknown; pdf?: unknown }
    pdf_url?: unknown
    pdf?: unknown
    openAccessPdf?: { url?: unknown }
    best_oa_location?: { pdf_url?: unknown }
    primary_location?: { pdf_url?: unknown }
    open_access?: { oa_url?: unknown }
  } | null | undefined
  const candidates = [
    r?.extra?.pdf_url,
    r?.extra?.pdf,
    r?.pdf_url,
    r?.pdf,
    r?.best_oa_location?.pdf_url,
    r?.open_access?.oa_url,
    r?.primary_location?.pdf_url,
    r?.openAccessPdf?.url,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return { pdfUrl: candidate }
  }
  return { error: 'no PDF link available for this record (no pdf_url in the record and no direct pdfUrl given)' }
}

/**
 * The record page the browser fallback opens: the record's own `url`/`URL`, then
 * a nested OpenAlex landing page, then its id when that id is itself a URL.
 */
function recordPageUrl(record: unknown): string | undefined {
  const r = record as {
    url?: unknown
    URL?: unknown
    landing_page_url?: unknown
    primary_location?: { landing_page_url?: unknown }
    best_oa_location?: { landing_page_url?: unknown }
    id?: unknown
  } | null | undefined
  const candidates = [
    r?.url,
    r?.URL,
    r?.landing_page_url,
    r?.primary_location?.landing_page_url,
    r?.best_oa_location?.landing_page_url,
    r?.id,
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && /^https?:\/\//.test(candidate)) return candidate
  }
  return undefined
}

/** Render the canonical download value into model-facing prose. */
function renderDownload(value: PaperDownloadOutput): string {
  const { result } = value
  if (result.status === 'ok') {
    const method = result.method === 'browser' ? '（ego 兜底）' : ''
    return [`下载完成：${result.path}${method}`, `输出目录：${value.outputDir}`].join('\n')
  }
  const retry = result.pdfUrl ? `；可手动重试：${result.pdfUrl}` : ''
  /* v8 ignore next -- execute always sets result.error on failure; the fallback covers hand-built values. */
  return `下载失败（${result.error ?? 'unknown'}${retry}）\n输出目录：${value.outputDir}`
}

const DESCRIPTION = [
  '- Downloads one academic paper PDF identified by `db` + `id` (from `paper_search`)',
  "- Prefers the source's direct PDF link (`extra.pdf_url` / `pdf_url` / `pdf`, OpenAlex location links, Semantic Scholar `openAccessPdf`), verified by PDF magic and minimum size",
  '- When the direct link is missing or fails (403/404/HTML shell), falls back to ego opening the record page and extracting the PDF link',
  '- Saves as `<outputDir>/<id>.pdf` (default `<cwd>/论文原文/YYYY-MM-DD/<id>.pdf`)',
  '',
  'Usage notes:',
  '  - Call `paper_search` first to obtain a `db` id and paper `id`',
  '  - `pdfUrl` overrides the connector-resolved link (diagnostics / manual retry)',
].join('\n')

/** Input for the download pipeline. */
type DownloadInput = {
  record: unknown
  override: string | undefined
  signal: AbortSignal
  callerSignal: AbortSignal
  timeoutMs: number
  fetchImpl: typeof fetch | undefined
  extractor: PageExtractor
}

/** A verified PDF body plus the link it came from. */
type DownloadOutcome =
  | { ok: true; body: Buffer; pdfUrl: string; method: 'direct' | 'browser' }
  | { ok: false; error: string; pdfUrl?: string }

/** Build a failed outcome without carrying an absent retry link. */
function failed(error: string, pdfUrl: string | undefined): DownloadOutcome {
  return pdfUrl === undefined ? { ok: false, error } : { ok: false, error, pdfUrl }
}

/** Message for a call that exhausted its whole-call budget. */
function timeoutMessage(timeoutMs: number): string {
  return `paper_download timed out after ${timeoutMs}ms`
}

/** Read a signal's state through a call: control-flow narrowing must not assume it stays current across awaits. */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/** Throw the caller's abort reason, normalized to an `Error`, when the signal is aborted. */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal.reason)
}

/**
 * Fetch the connector record for a paper id. Caller cancellation propagates
 * unchanged, the whole-call deadline becomes a `timedOut` result, and any other
 * failure becomes actionable source guidance.
 */
async function fetchRecord(
  connector: Connector,
  id: string,
  signal: AbortSignal,
  callerSignal: AbortSignal,
): Promise<{ record: unknown } | { timedOut: true }> {
  throwIfAborted(callerSignal)
  if (connector.fetch === undefined) return { record: null }
  try {
    return { record: await connector.fetch(id, { signal }) }
  } catch (error) {
    if (isAborted(callerSignal)) throw error
    if (isAborted(signal)) return { timedOut: true }
    throw new LiteratureToolError('tool_execution_failed', describeSourceError(connector, error), {
      tool: 'paper_download',
      db: connector.id,
    })
  }
}

/**
 * Resolve, fetch, and verify the PDF: the direct link first, then the record
 * page through the extractor when the direct link is missing or fails.
 */
async function downloadPdf(input: DownloadInput): Promise<DownloadOutcome> {
  const direct = pdfUrlFrom(input.record, input.override)
  let directError: string
  let directPdfUrl: string | undefined
  if ('pdfUrl' in direct) {
    directPdfUrl = direct.pdfUrl
    const body = await fetchPdfBody(direct.pdfUrl, input)
    if (body.ok) return { ok: true, body: body.body, pdfUrl: direct.pdfUrl, method: 'direct' }
    directError = body.error
  } else {
    directError = direct.error
  }

  // A caller cancellation that landed while the direct link was failing is not
  // a download fault; it propagates before any fallback work starts. The
  // whole-call deadline ends the call where it stands.
  throwIfAborted(input.callerSignal)
  if (isAborted(input.signal)) return failed(timeoutMessage(input.timeoutMs), directPdfUrl)
  const pageUrl = recordPageUrl(input.record)
  if (pageUrl === undefined) {
    const fallback = input.override?.trim()
      ? 'record-page fallback skipped for the pdfUrl override'
      : 'no record page for browser extraction'
    return failed(`${directError}; ${fallback}`, directPdfUrl)
  }
  const extracted = await input.extractor.extract(pageUrl, PDF_LINK_EXPR, {
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  })
  throwIfAborted(input.callerSignal)
  if (isAborted(input.signal)) return failed(timeoutMessage(input.timeoutMs), directPdfUrl)
  if (!extracted.ok || extracted.value === null) {
    const reason = extracted.ok ? 'no PDF link on the record page' : extracted.error
    return failed(`${directError}; browser extraction failed: ${reason}`, directPdfUrl)
  }
  const viaBrowser = await fetchPdfBody(extracted.value, input)
  if (!viaBrowser.ok) return failed(viaBrowser.error, extracted.value)
  return { ok: true, body: viaBrowser.body, pdfUrl: extracted.value, method: 'browser' }
}

/**
 * Build the `paper_download` tool over the literature registry and an optional
 * browser-use extractor.
 * @param deps - the registry plus optional fetch/extractor/output-dir injection.
 * @returns a registry-ready tool definition.
 */
export function createPaperDownloadTool(deps: PaperDownloadDeps): ToolDefinition {
  const resolveDir = deps.resolveOutputDir ?? defaultResolveOutputDir
  const extractor = deps.extractor ?? new EgoExtractor()
  return defineTool({
    name: 'paper_download',
    description: DESCRIPTION,
    parameters: {
      db: { type: 'string', required: true, description: 'Database id (from paper_list_sources)' },
      id: { type: 'string', required: true, description: 'Paper id from a paper_search hit' },
      pdfUrl: { type: 'string', description: 'Direct PDF link override (skips connector resolution)' },
      outputDir: { type: 'string', description: 'Output directory; default <cwd>/论文原文/YYYY-MM-DD' },
      timeoutMs: { type: 'number', description: 'Whole-call timeout (ms); default 60000, max 300000' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          db: { type: 'string', required: true },
          id: { type: 'string', required: true },
          result: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              status: { type: 'string', required: true, enum: ['ok', 'failed'] },
              path: { type: 'string' },
              pdfUrl: { type: 'string' },
              error: { type: 'string' },
              method: { type: 'string', enum: ['direct', 'browser'] },
            },
          },
          outputDir: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderDownload(value) }],
    },
    async execute(args, exec) {
      const db = args.db.trim()
      const id = args.id.trim()
      if (db === '' || id === '') {
        throw new LiteratureToolError('invalid_tool_input', 'db and id must be non-empty.', { tool: 'paper_download' })
      }
      const timeoutMs = args.timeoutMs
      if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000)) {
        throw new LiteratureToolError('invalid_tool_input', 'timeoutMs must be an integer between 1 and 300000', {
          tool: 'paper_download',
        })
      }
      const effectiveTimeout = timeoutMs ?? DEFAULT_TIMEOUT_MS
      // One deadline bounds record lookup, direct fetch, browser extraction,
      // and the fallback fetch; per-request timers cannot outlive the call.
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(effectiveTimeout)])
      const connector = deps.registry.get(db)
      if (connector === undefined) {
        const available = deps.registry.catalog().map(e => e.id).join(', ')
        throw new LiteratureToolError(
          'invalid_tool_input',
          `No database "${db}". Available: ${available || '(none registered)'}. Use paper_list_sources.`,
          { tool: 'paper_download' },
        )
      }
      const outputDir = resolveDir(args.outputDir, deps.cwd ?? process.cwd())
      await mkdir(outputDir, { recursive: true })

      // An explicit override is the whole resolution: skip the connector call.
      const override = args.pdfUrl?.trim()
      let record: unknown = null
      if (override === undefined || override === '') {
        const fetched = await fetchRecord(connector, id, signal, exec.signal)
        if ('timedOut' in fetched) {
          return {
            db,
            id,
            result: { status: 'failed' as const, error: timeoutMessage(effectiveTimeout) },
            outputDir,
          }
        }
        record = fetched.record
      }
      const outcome = await downloadPdf({
        record,
        override,
        signal,
        callerSignal: exec.signal,
        timeoutMs: effectiveTimeout,
        fetchImpl: deps.fetchImpl,
        extractor,
      })
      if (!outcome.ok) {
        return {
          db,
          id,
          result: {
            status: 'failed' as const,
            ...(outcome.pdfUrl === undefined ? {} : { pdfUrl: outcome.pdfUrl }),
            error: outcome.error,
          },
          outputDir,
        }
      }
      const target = await writePdf(outputDir, id, outcome.body)
      return {
        db,
        id,
        result: { status: 'ok' as const, path: target, pdfUrl: outcome.pdfUrl, method: outcome.method },
        outputDir,
      }
    },
  })
}

/** Strip path separators from a paper id used as a file name. */
function safeFileName(id: string): string {
  return id.replace(/[\\/]/g, '_')
}

/**
 * Write a PDF body to `<dir>/<id>.pdf` and return the target path. Atomic like
 * the sibling patent_pdf_download channel: an interrupted write must not leave a
 * truncated file that a later call reads as an already-downloaded source.
 */
async function writePdf(dir: string, id: string, body: Buffer): Promise<string> {
  const target = join(dir, `${safeFileName(id)}.pdf`)
  await writeFileAtomic(target, body, { mode: 0o644 })
  return target
}
