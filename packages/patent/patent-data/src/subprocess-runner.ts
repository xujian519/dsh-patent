/**
 * Subprocess-backed ego-browser spawn runner: maps the ego-session spawn
 * vocabulary onto `ctx.subprocess.spawn`, owning the timeout-to-terminate
 * mapping and the collected-output read.
 * @module @deepseek-ai/dsh-patent-data/subprocess-runner
 */

import { startSpawnDeadline } from '@deepseek-ai/dsh-patent-core'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type { EgoSpawnResult, EgoSpawnRunner, EgoSpawnSpec } from './types.ts'

/** Default SIGTERM-to-SIGKILL grace period (matches the Sati runner's 3s tier). */
const DEFAULT_GRACE_MS = 3_000

/** Default per-stream in-memory output cap. */
const DEFAULT_MAX_OUTPUT_BYTES = 500_000

/**
 * Spawn runner adapting `ctx.subprocess` to the ego-session runner seam.
 * The script passes verbatim through the seam's batch stdin, so it is never
 * shell-expanded; a timeout terminates the process tree through the seam's
 * abort signal.
 */
export class SubprocessEgoSpawnRunner implements EgoSpawnRunner {
  private readonly graceMs: number
  private readonly maxOutputBytes: number

  constructor(
    private readonly subprocess: SubprocessRuntime,
    options: { graceMs?: number; maxOutputBytes?: number } = {},
  ) {
    this.graceMs = options.graceMs ?? DEFAULT_GRACE_MS
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  }

  /**
   * Run one argv+stdin spawn and collect its settled result.
   * @param spec - executable, arguments, stdin, directory, environment, deadline, and cancellation.
   * @returns the settled exit, output, timeout, and duration facts.
   */
  async spawn(spec: EgoSpawnSpec): Promise<EgoSpawnResult> {
    const startedAt = Date.now()
    const deadline = startSpawnDeadline(spec.timeoutMs, spec.signal)
    try {
      const handle = this.subprocess.spawn({
        argv: spec.argv,
        cwd: spec.cwd,
        stdio: {
          stdin: spec.stdinData !== undefined ? { data: spec.stdinData } : 'ignore',
          stdout: { maxBytes: this.maxOutputBytes },
          stderr: { maxBytes: this.maxOutputBytes },
        },
        graceMs: this.graceMs,
        signal: deadline.signal,
        ...spec.env !== undefined ? { env: spec.env } : {},
      })
      const outcome = await handle.done
      const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
      const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
      return {
        exitCode: outcome.exitCode,
        stdout,
        stderr,
        timedOut: deadline.timedOut(),
        durationMs: Date.now() - startedAt,
      }
    } finally {
      deadline.dispose()
    }
  }
}
