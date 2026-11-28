/**
 * ego-browser download adapter for `patent_pdf_download`: builds the
 * ego-browser script that opens each Google Patents page, extracts the CDN PDF
 * link, and captures the PDF response body through CDP, then runs it over an
 * injected `EgoBrowserSession` and maps the tagged JSON result back to the
 * tool's `EgoDownloadResult` vocabulary.
 *
 * The capture reads the network stack instead of relying on the browser's
 * download handling: `Network.enable` arms the page, `page.events()` yields the
 * `Network.responseReceived` for the CDN URL, and `Network.getResponseBody`
 * returns its bytes. The page-level download behavior this replaced no longer
 * lands on Chromium 152, and the bytes are not readable from the page itself
 * (the CDN is cross-origin, so a page-side fetch is refused).
 *
 * The script is one task space per deployment (`sati-patent-download`), resolved
 * by name so a later call lands in the same space and keeps the login state and
 * tab; per-patent try/catch; one `EGO_DOWNLOAD:<json>` payload via stdout.
 * Anything the browser cannot capture is reported as a `fallback` item carrying
 * the extracted CDN URL, which the tool then fetches itself.
 * @module @deepseek-ai/dsh-patent-tools/tool/patent-pdf-download-ego
 */

import { errorMessage } from '@deepseek-ai/dsh-value'
import { PatentToolError } from '../error.ts'
import { GOOGLE_PATENTS_CHANNEL } from './internal/upstream-channel.ts'
import type { EgoDownloadItem, EgoDownloadRequest, EgoDownloadResult, RunEgo } from './patent-pdf-download.ts'

/** Task-space name for the patent PDF download space (sati-<domain>, matching EgoBrowserSession.taskSpaceName). */
const TASK_SPACE_DOMAIN = 'sati-patent-download'

/** PDF bytes start with this; a captured body without it is not the document we asked for. */
const PDF_MAGIC = '%PDF-'

/**
 * Page-side expression returning the patent's CDN PDF link. The first CDN anchor
 * is not always the document (a CN utility model page leads with its drawing
 * PNG), so a `.pdf` link wins and the first CDN anchor is the fallback.
 */
const PDF_LINK_EXPRESSION =
  '(() => { const anchors = Array.from(document.querySelectorAll(\'a[href*="patentimages.storage.googleapis.com"]\')); const pdf = anchors.find(a => /\\.pdf($|[?#])/i.test(a.href)); const chosen = pdf || anchors[0]; return chosen ? chosen.href : null })()'

/** One settled ego-browser script run, as the adapter consumes it. */
type EgoScriptRun = {
  output: string
  exitCode: number | null
  timedOut: boolean
}

/**
 * The ego-browser session surface the download adapter needs. EgoBrowserSession
 * satisfies it structurally; tests inject a fake with the same three methods.
 */
export type EgoSessionSeam = {
  /** Availability check; a non-ok verdict throws setup_required before any run. */
  checkAvailability: () => { ok: boolean; reason?: string }
  /** Run one script via stdin and return the collected output. */
  runScript: (script: string, options: { cwd: string; timeoutMs?: number; signal?: AbortSignal }) => Promise<EgoScriptRun>
  /** Parse the first EGO_<tag>:<json> line from the output. */
  extractTaggedJson: (output: string, tag: string) => unknown
}

/**
 * Build the ego-browser script for one batch download.
 * @param request - the validated download request.
 * @returns the script body to pass to `ego-browser nodejs` via stdin.
 */
export function buildDownloadScript(request: EgoDownloadRequest): string {
  const patents = JSON.stringify(request.patents)
  const outputDir = JSON.stringify(request.outputDir)
  const pageTimeoutMs = request.pageTimeoutSec * 1000
  const downloadTimeoutMs = request.downloadTimeoutMs
  const evidenceLines = request.record
    ? [
      '    const shot = await page.cdp(\'Page.captureScreenshot\', { format: \'png\' })',
      '    const shotPayload = shot && shot.result ? shot.result : shot',
      '    if (shotPayload && shotPayload.data) { const evidenceDir = outputDir + \'/evidence\'; fs.mkdirSync(evidenceDir, { recursive: true }); const evidencePath = evidenceDir + \'/evidence-\' + patent + \'.png\'; fs.writeFileSync(evidencePath, Buffer.from(shotPayload.data, \'base64\')); evidence.push(evidencePath) }',
    ]
    : []
  const recordedLine = request.record
    ? 'if (evidence.length > 0) payload.recorded = outputDir + \'/evidence\''
    : undefined
  return [
    `const task = await taskSpace('${TASK_SPACE_DOMAIN}')`,
    // 名称解析到同一个任务空间：下一次调用沿用它的登录态与标签页（脚本不回收到处）。
    'const page = task.page(\'p1\')',
    'const fs = await import(\'node:fs\')',
    'const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))',
    'const items = []',
    ...(request.record ? ['const evidence = []'] : []),
    `const patents = ${patents}`,
    `const outputDir = ${outputDir}`,
    'for (const patent of patents) {',
    '  let pdfUrl = null',
    '  try {',
    '    await page.cdp(\'Network.enable\', {})',
    `    await page.goto('https://patents.google.com/patent/' + patent + '/en', { timeout: ${pageTimeoutMs} })`,
    `    pdfUrl = await page.evaluate(${JSON.stringify(PDF_LINK_EXPRESSION)})`,
    '    if (!pdfUrl) throw new Error(\'no CDN pdf link on page\')',
    '    await page.events()',
    `    await page.goto(pdfUrl, { timeout: ${downloadTimeoutMs} })`,
    '    const seen = new Set()',
    '    let bytes = null',
    `    const deadline = Date.now() + ${downloadTimeoutMs}`,
    '    while (bytes === null && Date.now() < deadline) {',
    '      const events = await page.events()',
    '      for (const event of events) {',
    '        const response = event && event.method === \'Network.responseReceived\' && event.params ? event.params.response : null',
    '        if (!response || response.url !== pdfUrl || response.status !== 200 || !/pdf/i.test(response.mimeType || \'\')) continue',
    '        seen.add(event.params.requestId)',
    '      }',
    '      for (const requestId of seen) {',
    '        try {',
    '          const detail = await page.cdp(\'Network.getResponseBody\', { requestId })',
    '          const body = detail && detail.result ? detail.result : detail',
    '          if (!body || typeof body.body !== \'string\') continue',
    '          const candidate = Buffer.from(body.body, body.base64Encoded ? \'base64\' : \'utf8\')',
    `          if (candidate.subarray(0, 5).toString('latin1') === '${PDF_MAGIC}') { bytes = candidate; break }`,
    '        } catch (error) { /* 候选已过期或被逐出：继续试下一个 */ }',
    '      }',
    '      if (bytes === null) await sleep(250)',
    '    }',
    '    if (!bytes) throw new Error(\'no PDF body captured\')',
    '    const target = outputDir + \'/\' + patent + \'.pdf\'',
    '    fs.writeFileSync(target, bytes)',
    '    items.push({ patent, status: \'ok\', path: target })',
    ...evidenceLines,
    '  } catch (error) {',
    '    items.push({ patent, status: \'fallback\', pdfUrl, error: String(error && error.message || error) })',
    '  }',
    '}',
    'const payload = { items }',
    ...(recordedLine === undefined ? [] : [recordedLine]),
    'console.log(\'EGO_DOWNLOAD:\' + JSON.stringify(payload))',
  ].join('\n')
}

/**
 * Build the `runEgo` batch runner over one ego-browser session.
 * @param session - the ego-browser session (production: ctx.patentData.createEgoSession()).
 * @returns a `RunEgo` that runs the download script and parses the tagged result.
 */
export function createEgoDownloadRunner(session: EgoSessionSeam): RunEgo {
  return async (request: EgoDownloadRequest): Promise<EgoDownloadResult> => {
    const availability = session.checkAvailability()
    if (!availability.ok) {
      throw new PatentToolError(
        'setup_required',
        availability.reason ?? 'ego-browser 不可用；请先安装 ego lite 并完成首次引导。',
        { tool: 'patent_pdf_download' },
      )
    }
    let result: EgoScriptRun
    try {
      result = await session.runScript(buildDownloadScript(request), {
        cwd: request.outputDir,
        timeoutMs: request.timeoutMs,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
    } catch (error) {
      throw new PatentToolError(
        'tool_execution_failed',
        `ego-browser 启动失败：${errorMessage(error)}`,
        { tool: 'patent_pdf_download' },
      )
    }
    if (result.timedOut) {
      throw new PatentToolError('tool_execution_failed', 'patent_pdf_download 超出 ego-browser 整体超时。', {
        tool: 'patent_pdf_download',
      })
    }
    const payload = session.extractTaggedJson(result.output, 'DOWNLOAD') as EgoDownloadResult | null
    if (payload === null || !Array.isArray(payload.items)) {
      const tail = result.output.slice(-400)
      throw new PatentToolError(
        'tool_execution_failed',
        `ego-browser 未返回可解析的下载结果（exit ${result.exitCode}）：${tail}`,
        { tool: 'patent_pdf_download' },
      )
    }
    const items: EgoDownloadItem[] = payload.items.map(item => ({
      patent: item.patent,
      status: item.status === 'ok' ? 'ok' : 'fallback',
      channel: GOOGLE_PATENTS_CHANNEL,
      ...(item.path === undefined ? {} : { path: item.path }),
      ...(item.pdfUrl === undefined ? {} : { pdfUrl: item.pdfUrl }),
      ...(item.error === undefined ? {} : { error: item.error }),
    }))
    return { items, ...(payload.recorded === undefined ? {} : { recorded: payload.recorded }) }
  }
}
