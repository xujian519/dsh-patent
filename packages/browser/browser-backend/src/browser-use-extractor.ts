/**
 * BrowserUseExtractor — run the browser-harness `browser-use` CLI to open a
 * page and extract one value with a `js(...)` expression, printed as a
 * `BU_EXTRACT:<value>` marker on stdout. The download tools use this as the
 * browser fallback channel: open the page, extract the PDF link, then fetch
 * and verify the file. Marker extraction mirrors the ego/nuo fetch pattern
 * (NUO_START/NUO_END in nuo-patent's fetchHtmlWithEgoBrowser).
 * @module @deepseek-ai/dsh-browser-backend/browser-use-extractor
 */

import { lastMarkerValue, runScriptCommand } from './run-script.ts'

/** Marker line prefix emitted by the extraction script. */
const BU_EXTRACT_MARKER = 'BU_EXTRACT:'

/** One settled browser-use script run (injectable for tests). */
export type ScriptRun = (script: string, options: {
  timeoutMs: number
  signal?: AbortSignal
  maxOutputBytes: number
}) => Promise<{
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}>

/** Extract options. */
export type ExtractOptions = {
  /** Whole-call timeout in ms (default 60_000). */
  timeoutMs?: number
  /** Caller cancellation. */
  signal?: AbortSignal
  /** Per-stream collected-output cap in bytes (default 1_000_000). */
  maxOutputBytes?: number
}

/** Extract result. */
export type ExtractResult =
  | { ok: true; value: string | null }
  | { ok: false; error: string; timedOut?: boolean }

/** Browser page-value extraction channel (browser-use, ego, and so on). */
export interface PageExtractor {
  /**
   * Open a URL and extract one js-expression value.
   * @param url - the page to open.
   * @param jsExpr - the JavaScript expression whose string value is extracted.
   * @param options - timeout/cancel/output cap.
   * @returns the extracted value, or the failure.
   */
  extract(url: string, jsExpr: string, options?: ExtractOptions): Promise<ExtractResult>
}

/** Extractor options (test injection). */
export type BrowserUseExtractorOptions = {
  /** CLI command name (default "browser-use"). */
  commandName?: string
  /** Script runner; defaults to spawn with stdin write and capped output collection. */
  run?: ScriptRun
}

/**
 * Build the browser-use heredoc script that opens a URL, waits for load, and
 * prints the js-expression value after the BU_EXTRACT marker.
 * @param url - the page to open.
 * @param jsExpr - the JavaScript expression whose string value is extracted.
 * @returns the script body to pipe to `browser-use` stdin.
 */
export function buildBrowserUseExtractScript(url: string, jsExpr: string): string {
  return [
    'ensure_real_tab()',
    `new_tab(${JSON.stringify(url)})`,
    'wait_for_load()',
    `v = js(${JSON.stringify(jsExpr)})`,
    `print('${BU_EXTRACT_MARKER}' + (str(v) if v is not None else ''))`,
  ].join('\n')
}

/** Default script runner: spawn the CLI, write the script to stdin, collect capped output. */
function defaultRun(commandName: string): ScriptRun {
  return (script, options) => runScriptCommand(commandName, [], script, options)
}

/**
 * Extract one value from a page through the browser-harness browser.
 * A missing marker or a non-zero exit reports the failure; a marker with an
 * empty value means the page had no match (ok with value null).
 */
export class BrowserUseExtractor implements PageExtractor {
  private readonly run: ScriptRun

  /**
   * @param options - CLI command name and script-runner injection.
   */
  constructor(options: BrowserUseExtractorOptions = {}) {
    this.run = options.run ?? defaultRun(options.commandName ?? 'browser-use')
  }

  /**
   * Open a URL and extract the js-expression value.
   * @param url - the page to open.
   * @param jsExpr - the JavaScript expression whose string value is extracted.
   * @param options - timeout/cancel/output cap.
   * @returns the extracted value, or the failure.
   */
  async extract(url: string, jsExpr: string, options: ExtractOptions = {}): Promise<ExtractResult> {
    const result = await this.run(buildBrowserUseExtractScript(url, jsExpr), {
      timeoutMs: options.timeoutMs ?? 60_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      maxOutputBytes: options.maxOutputBytes ?? 1_000_000,
    })
    const value = lastMarkerValue(result.stdout, BU_EXTRACT_MARKER)
    if (value !== undefined) return { ok: true, value: value === '' ? null : value }
    if (result.timedOut) return { ok: false, error: 'browser-use timed out', timedOut: true }
    const detail = result.stderr.trim()
    return { ok: false, error: `browser-use exited ${result.exitCode ?? 'null'}${detail ? `: ${detail}` : ''}` }
  }
}
