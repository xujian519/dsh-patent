/** Runs the GitHub CLI on the host with a scrubbed, non-interactive environment. */

import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { execa } from 'execa'

/** Complete output of one `gh` invocation that ran to an exit code. */
export interface GhOutput {
  /** Process exit code. */
  readonly exitCode: number
  /** Standard output without its final newline. */
  readonly stdout: string
  /** Standard error without its final newline. */
  readonly stderr: string
}

/** Runs `gh` with literal arguments; rejects when the process cannot run to an exit code. */
export type GhRunner = (args: readonly string[], signal: AbortSignal) => Promise<GhOutput>

/** Resolved executable and limits for `gh`. */
interface GhConfig {
  /** Executable name or absolute host path. */
  readonly ghCommand: string
  /** Deadline in milliseconds for one invocation. */
  readonly timeoutMs: number
  /** Maximum captured bytes per output stream. */
  readonly maxOutputBytes: number
}

/** Thrown when the `gh` executable cannot start, for example because it is not installed. */
export class GhUnavailableError extends Error {
  override name = 'GhUnavailableError'
}

/** Thrown when one invocation outlives `timeoutMs`; the process is killed. */
export class GhTimeoutError extends Error {
  override name = 'GhTimeoutError'
}

/** Thrown when an output stream exceeds `maxOutputBytes`; the process is killed. */
export class GhOutputLimitError extends Error {
  override name = 'GhOutputLimitError'
}

/**
 * Build a runner for `gh` on the host. The child inherits the scrubbed parent
 * environment, so variables whose names contain KEY, PASSWORD, SECRET, or
 * TOKEN never reach it and `gh` authenticates from its own credential store.
 * Prompts, update notices, pagers, and colors are disabled.
 * @param config - executable and limits.
 * @returns the runner.
 */
export function ghRunner(config: GhConfig): GhRunner {
  return async (args, signal) => {
    const command = ['gh', ...args.slice(0, 1)].join(' ')
    // The child runs in its own process group so its descendants (a shell's
    // children, for example) are stopped with it: killing only the direct child
    // leaves them holding the output pipes until they exit on their own.
    const detached = process.platform !== 'win32'
    const deadline = new AbortController()
    const timer = setTimeout(() => {
      deadline.abort(new GhTimeoutError(`${command} timed out after ${config.timeoutMs}ms`))
    }, config.timeoutMs)
    const forwardAbort = (): void => { deadline.abort(signal.reason) }
    signal.addEventListener('abort', forwardAbort, { once: true })
    const subprocess = execa(config.ghCommand, args, {
      env: { ...scrubbedParentEnv(), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_PAGER: '', NO_COLOR: '1', CLICOLOR: '0' },
      extendEnv: false,
      stdin: 'ignore',
      encoding: 'utf8',
      reject: false,
      detached,
      cancelSignal: deadline.signal,
      maxBuffer: config.maxOutputBytes,
    })
    const pid = subprocess.pid
    const cancel = (): void => {
      if (pid === undefined) return
      try {
        if (detached) process.kill(-pid, 'SIGKILL')
        /* v8 ignore start -- Windows has no process groups, and its lane never runs this coverage gate. */
        else subprocess.kill('SIGKILL')
        /* v8 ignore stop */
      } catch {
        // The process already exited; its group is gone.
      }
    }
    deadline.signal.addEventListener('abort', cancel, { once: true })
    try {
      const result = await subprocess
      const timeout: unknown = deadline.signal.reason
      if (timeout instanceof GhTimeoutError) throw timeout
      if (result.isCanceled) throw signal.reason
      if (result.isMaxBuffer) throw new GhOutputLimitError(`${command} output exceeds maxOutputBytes`)
      // A result without an exit code failed before the process ran; execa then always sets shortMessage.
      if (result.exitCode === undefined) throw new GhUnavailableError(`gh could not start: ${String(result.shortMessage)}`)
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', forwardAbort)
      deadline.signal.removeEventListener('abort', cancel)
    }
  }
}
