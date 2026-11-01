/**
 * Shared command runner the browser-backend extractors use to spawn a page
 * CLI, write a script to its stdin, and collect capped stdout/stderr until the
 * child exits or the caller/timeout aborts it. Kept in one place so the
 * browser-use and ego extractors do not duplicate the aborting-spawn machinery.
 * @module @deepseek-ai/dsh-browser-backend/run-script
 */

import { spawn } from 'node:child_process'

/** Per-stream collected-output cap and the abort window for one run. */
interface RunScriptOptions {
  /** Whole-call timeout in ms. */
  readonly timeoutMs: number
  /** Caller cancellation. */
  readonly signal?: AbortSignal
  /** Per-stream collected-output cap in bytes. */
  readonly maxOutputBytes: number
  /** Child environment; defaults to the harness process environment. */
  readonly env?: NodeJS.ProcessEnv
}

/** One settled script run: exit status plus the collected streams. */
interface RunScriptResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

/**
 * Spawn a CLI, write `script` to its stdin, and resolve once it exits (or once
 * the timeout or caller aborts it). Collected streams are capped at
 * `options.maxOutputBytes`, and an early `error` uses its message as stderr.
 * @param commandName - CLI to execute.
 * @param args - CLI arguments.
 * @param script - script body piped to stdin before the channel closes.
 * @param options - timeout, cancellation, output cap, and child environment.
 * @returns the settled run result.
 */
export function runScriptCommand(
  commandName: string,
  args: readonly string[],
  script: string,
  options: RunScriptOptions,
): Promise<RunScriptResult> {
  return new Promise((resolve) => {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, options.timeoutMs)
    timer.unref()
    const onCallerAbort = (): void => { controller.abort() }
    options.signal?.addEventListener('abort', onCallerAbort, { once: true })
    if (options.signal?.aborted === true) controller.abort()
    const child = spawn(commandName, [...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: controller.signal,
      ...(options.env === undefined ? {} : { env: options.env }),
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < options.maxOutputBytes) {
        stdout += chunk.toString('utf8').slice(0, options.maxOutputBytes - stdout.length)
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < options.maxOutputBytes) {
        stderr += chunk.toString('utf8').slice(0, options.maxOutputBytes - stderr.length)
      }
    })
    child.on('error', (error: Error) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onCallerAbort)
      resolve({ exitCode: null, stdout, stderr: stderr || error.message, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onCallerAbort)
      resolve({ exitCode: code, stdout, stderr, timedOut })
    })
    // stdin write after the child exited would throw EPIPE; the close result already carries the failure.
    child.stdin.on('error', () => {})
    child.stdin.write(script + '\n')
    child.stdin.end()
  })
}

/**
 * PATH delimiter per platform (Windows uses ';', elsewhere ':').
 * @param platform - the runtime platform.
 * @returns the delimiter joining PATH segments.
 */
export function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':'
}

/**
 * Last marker value in the collected stdout; an absent marker means undefined.
 * @param stdout - the collected child stdout.
 * @param marker - the marker line prefix whose trailing value is returned.
 * @returns the last value after the marker, or `null` for an empty value, or `undefined` for no marker.
 */
export function lastMarkerValue(stdout: string, marker: string): string | null | undefined {
  let value: string | null | undefined
  for (const line of stdout.split('\n')) {
    if (line.startsWith(marker)) value = line.slice(marker.length)
  }
  return value
}
