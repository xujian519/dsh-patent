/**
 * Unified ego-browser (ego-lite) execution session: availability checks, a
 * connection probe, session-scoped task-space naming, and verbatim script runs
 * over a spawn-capable runner. The runner defaults to the subprocess-backed
 * adapter the service injects; the script passes through stdin verbatim (the
 * single-quoted heredoc is replaced by the subprocess seam's batch stdin, so
 * the script is never shell-expanded).
 * @module @deepseek-ai/dsh-patent-data/ego-session
 */

import { accessSync, constants as fsConstants, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { EgoAvailability, EgoRunOptions, EgoScriptResult, EgoSessionOptions, EgoSpawnRunner } from './types.ts'

/** Default ego-browser CLI command name. */
export const DEFAULT_EGO_COMMAND_NAME = 'ego-browser'
/** Default per-run timeout in milliseconds. */
export const DEFAULT_EGO_TIMEOUT_MS = 90_000
/** Default hard cap for a per-run timeout in milliseconds. */
export const DEFAULT_EGO_MAX_TIMEOUT_MS = 300_000
/** Default soft cap in bytes for the merged run output. */
export const DEFAULT_EGO_MAX_OUTPUT_BYTES = 500_000
/** Default connection-probe timeout in milliseconds. */
export const DEFAULT_EGO_PROBE_TIMEOUT_MS = 8_000
/** The ego-browser script delimiter name shared with the future ego_browser tool's input validation. */
export const EGO_HEREDOC_MARKER = 'EGO_SCRIPT_EOF'

/** Unified ego-browser execution session. Stateless; availability is checked per call. */
export class EgoBrowserSession {
  private readonly commandName: string
  private readonly defaultTimeoutMs: number
  private readonly maxTimeoutMs: number
  private readonly probeTimeoutMs: number
  private readonly homeDir: string
  private readonly pathEntries: string[]
  private readonly maxOutputBytes: number
  private readonly platform: NodeJS.Platform
  private readonly env: NodeJS.ProcessEnv
  private readonly runner: EgoSpawnRunner | undefined

  constructor(options: EgoSessionOptions = {}) {
    this.commandName = options.commandName ?? DEFAULT_EGO_COMMAND_NAME
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_EGO_TIMEOUT_MS
    this.maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_EGO_MAX_TIMEOUT_MS
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_EGO_PROBE_TIMEOUT_MS
    this.homeDir = options.homeDir ?? homedir()
    this.pathEntries = (options.pathEntries ?? [join(this.homeDir, '.local', 'bin')]).filter(entry => entry.length > 0)
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_EGO_MAX_OUTPUT_BYTES
    this.platform = options.platform ?? process.platform
    this.env = options.env ?? process.env
    this.runner = options.runner
  }

  /**
   * Static availability check: the platform must be macOS or Windows and the
   * CLI executable must exist (checked live, never cached).
   * @param env - optional environment override for the PATH probe.
   * @returns ok, or the unavailable/setup_required reason.
   */
  checkAvailability(env?: NodeJS.ProcessEnv): EgoAvailability {
    if (this.platform !== 'darwin' && this.platform !== 'win32') {
      return {
        ok: false,
        code: 'unavailable',
        reason: 'ego-browser (ego lite) only supports macOS and Windows.',
      }
    }
    if (!this.isCommandExecutable(env ?? this.env)) {
      return {
        ok: false,
        code: 'setup_required',
        reason: 'ego-browser CLI not found. Install ego lite (https://lite.ego.app/), complete first-run onboarding, and confirm ego-browser is on the PATH (usually ~/.local/bin/ego-browser).',
      }
    }
    return { ok: true }
  }

  /**
   * Connection probe: run ego-browser with an inline cliLog and check for the probe marker.
   * @param timeoutMs - probe timeout (defaults to the session's probeTimeoutMs).
   * @returns true when the probe exits 0 without timing out and emits the marker.
   */
  async runConnectionProbe(timeoutMs?: number): Promise<boolean> {
    const probeTimeout = timeoutMs ?? this.probeTimeoutMs
    try {
      const result = await this.requireRunner().spawn({
        argv: [this.commandName, 'nodejs', '-e', "cliLog('EGO_DOCTOR_OK')"],
        cwd: process.cwd(),
        env: this.env,
        timeoutMs: probeTimeout,
      })
      if (result.timedOut || result.exitCode !== 0) return false
      return `${result.stdout}\n${result.stderr}`.includes('EGO_DOCTOR_OK')
    } catch {
      return false
    }
  }

  /**
   * Session-scoped task-space name: sati-<domain>[-<sessionId>]. One sessionId+domain
   * reuses one browser task space, preserving login state and open tabs across calls.
   * @param domain - the task-space domain (e.g. "patent-download").
   * @param sessionId - optional session id that scopes the space.
   * @returns the stable task-space name.
   */
  taskSpaceName(domain: string, sessionId?: string): string {
    const base = `sati-${domain}`
    if (sessionId) return `${base}-${sessionId}`
    return base
  }

  /**
   * Run an ego-browser script (the script body is stdin; the final result uses cliLog).
   * @param script - the verbatim ego-browser script body.
   * @param options - cwd, optional timeout, environment, and cancellation.
   * @returns the merged/truncated output plus stream and exit facts.
   */
  async runScript(script: string, options: EgoRunOptions): Promise<EgoScriptResult> {
    const timeoutMs = Math.min(options.timeoutMs ?? this.defaultTimeoutMs, this.maxTimeoutMs)
    const env = this.buildEnv(options.env ?? this.env)
    try {
      const result = await this.requireRunner().spawn({
        argv: [this.commandName, 'nodejs'],
        stdinData: script,
        cwd: options.cwd,
        env,
        timeoutMs,
        ...options.signal !== undefined ? { signal: options.signal } : {},
      })
      const combined = [result.stdout, result.stderr].filter(t => t.length > 0).join('\n')
      return {
        output: this.truncate(combined),
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      }
    } catch (error) {
      // 调用方取消是控制流信号，不是启动失败：保留 AbortError 身份，调用方才能把它
      // 与真正的启动失败区分开，而不是按失败消息去猜。
      options.signal?.throwIfAborted()
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`ego-browser failed to start: ${message}`, { cause: error })
    }
  }

  /**
   * Extract the JSON payload of the first EGO_<TAG>:<json> line in the output.
   * @param output - the combined ego-browser output.
   * @param tag - the tag name (the payload prefix is EGO_<tag>:).
   * @returns the parsed payload, or null when absent or unparseable.
   */
  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- 调用方以显式类型实参标注返回类型（tests/ego-session.spec.ts），T 无法从参数推断
  extractTaggedJson<T>(output: string, tag: string): T | null {
    const prefix = `EGO_${tag}:`
    for (const line of output.split('\n')) {
      const idx = line.indexOf(prefix)
      if (idx === -1) continue
      const payload = line.slice(idx + prefix.length).trim()
      try {
        return JSON.parse(payload) as T
      } catch {
        return null
      }
    }
    return null
  }

  /**
   * Ensure an output directory exists (before downloads/screen captures).
   * @param dir - the directory path to create (recursively).
   */
  ensureDir(dir: string): void {
    mkdirSync(dir, { recursive: true })
  }

  private requireRunner(): EgoSpawnRunner {
    if (this.runner === undefined) {
      throw new Error('ego-browser runner not configured; construct the session through ctx.patentData.createEgoSession')
    }
    return this.runner
  }

  private buildEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const delimiter = pathDelimiter(this.platform)
    const existingPath = base.PATH ?? ''
    const segments = existingPath.length > 0 ? existingPath.split(delimiter) : []
    for (const entry of this.pathEntries) {
      if (!segments.includes(entry)) segments.push(entry)
    }
    return { ...base, PATH: segments.join(delimiter) }
  }

  private isCommandExecutable(env: NodeJS.ProcessEnv): boolean {
    const delimiter = pathDelimiter(this.platform)
    const localBin = join(this.homeDir, '.local', 'bin')
    const pathSegments = (env.PATH ?? '').split(delimiter).filter(s => s.length > 0)
    // 可用性检查与 spawn 使用同一组目录：pathEntries 会注入子进程 PATH，
    // 若不参与探测，自定义安装目录会出现「探测说没装、运行能找到」。
    const dirs = [...new Set([localBin, ...this.pathEntries, ...pathSegments])]
    for (const dir of dirs) {
      for (const name of commandNames(this.commandName, this.platform)) {
        if (isUsableFile(join(dir, name), this.platform)) return true
      }
    }
    return false
  }

  private truncate(text: string): string {
    const buffer = Buffer.from(text, 'utf8')
    if (buffer.length <= this.maxOutputBytes) return text
    let end = this.maxOutputBytes
    // 从上限处回退到 UTF-8 字符边界，避免切出半个多字节字符。
    while (end > 0 && (buffer.readUInt8(end) & 0xc0) === 0x80) end -= 1
    return `${buffer.subarray(0, end).toString('utf8')}…\n[output truncated]`
  }
}

/** PATH delimiter per platform (Windows ';', elsewhere ':'). */
function pathDelimiter(platform: NodeJS.Platform): string {
  return platform === 'win32' ? ';' : ':'
}

/* jscpd:ignore-start -- platform command resolution stays per-domain: each backend
   carries its own copy of these two helpers. */
/** File names a command may resolve to on the platform. */
function commandNames(command: string, platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`] : [command]
}

/** Whether a path resolves to a usable command on the platform. */
function isUsableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    // Windows scripts carry no executable bit; presence is the usable signal.
    accessSync(path, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}
/* jscpd:ignore-end */

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
