// SubprocessEgoSpawnRunner: spec translation onto the subprocess seam
// (argv/cwd/stdio/env/grace/signal), collected-output reads with missing-stream
// fallbacks, timeout-to-abort escalation, and caller-signal cancellation.
import { describe, expect, it } from 'vitest'
import { SubprocessEgoSpawnRunner } from '@deepseek-ai/dsh-patent-data'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputReader,
  SubprocessRuntime,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

function reader(text: string): SubprocessOutputReader {
  return { readFrom: () => ({ text, nextOffset: text.length, lossy: false }) }
}

function makeHandle(options: {
  outcome?: SubprocessOutcome
  stdout?: SubprocessOutputReader
  stderr?: SubprocessOutputReader
  done?: Promise<SubprocessOutcome>
} = {}): SubprocessHandle {
  return {
    stdin: undefined,
    stdout: undefined,
    stderr: undefined,
    control: undefined,
    // SubprocessCollectedOutputs declares optional keys; omit absent readers
    // instead of assigning undefined (exactOptionalPropertyTypes).
    collected: {
      ...(options.stdout !== undefined ? { stdout: options.stdout } : {}),
      ...(options.stderr !== undefined ? { stderr: options.stderr } : {}),
    },
    done: options.done ?? Promise.resolve(options.outcome ?? { exitCode: 0, signal: null }),
    terminate() {},
    waitForExit: () => Promise.resolve(true),
  }
}

function fakeRuntime(onSpawn: (spec: SubprocessSpawnSpec) => SubprocessHandle): {
  runtime: SubprocessRuntime
  calls: SubprocessSpawnSpec[]
} {
  const calls: SubprocessSpawnSpec[] = []
  return {
    runtime: {
      spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
        calls.push(spec)
        return onSpawn(spec)
      },
    } as unknown as SubprocessRuntime,
    calls,
  }
}

describe('SubprocessEgoSpawnRunner.spawn', () => {
  it('collects both streams and passes the full spec through', async () => {
    const { runtime, calls } = fakeRuntime(() =>
      makeHandle({ stdout: reader('out'), stderr: reader('err'), outcome: { exitCode: 2, signal: null } }),
    )
    const runner = new SubprocessEgoSpawnRunner(runtime, { graceMs: 1_000, maxOutputBytes: 10_000 })

    const result = await runner.spawn({
      argv: ['ego-browser', 'nodejs'],
      stdinData: "cliLog('x')",
      cwd: '/tmp',
      env: { PATH: '/usr/bin' },
      timeoutMs: 5_000,
    })

    expect(result.exitCode).toBe(2)
    expect(result.stdout).toBe('out')
    expect(result.stderr).toBe('err')
    expect(result.timedOut).toBe(false)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(calls.length).toBe(1)
    const spec = calls[0]!
    expect(spec.argv).toEqual(['ego-browser', 'nodejs'])
    expect(spec.cwd).toBe('/tmp')
    expect(spec.stdio.stdin).toEqual({ data: "cliLog('x')" })
    expect(spec.stdio.stdout).toEqual({ maxBytes: 10_000 })
    expect(spec.stdio.stderr).toEqual({ maxBytes: 10_000 })
    expect(spec.graceMs).toBe(1_000)
    expect(spec.env).toEqual({ PATH: '/usr/bin' })
    expect(spec.signal).toBeInstanceOf(AbortSignal)
  })

  it('defaults stdin to ignore and env/collected streams to empty when absent', async () => {
    const { runtime, calls } = fakeRuntime(() => makeHandle())
    const runner = new SubprocessEgoSpawnRunner(runtime)

    const result = await runner.spawn({ argv: ['ego-browser', 'nodejs'], cwd: '/tmp', timeoutMs: 5_000 })

    expect(calls[0]?.stdio.stdin).toBe('ignore')
    expect(calls[0]?.env).toBeUndefined()
    expect(calls[0]?.graceMs).toBe(3_000)
    expect(calls[0]?.stdio.stdout).toEqual({ maxBytes: 500_000 })
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
    expect(result.timedOut).toBe(false)
  })

  it('reports a timeout and aborts the spawned process after the deadline', async () => {
    const { runtime } = fakeRuntime(spec => ({
      ...makeHandle(),
      done: new Promise<SubprocessOutcome>((resolve) => {
        spec.signal?.addEventListener('abort', () => { resolve({ exitCode: null, signal: 'SIGTERM' }) }, { once: true })
      }),
    }))
    const runner = new SubprocessEgoSpawnRunner(runtime)

    const result = await runner.spawn({ argv: ['ego-browser', 'nodejs'], cwd: '/tmp', timeoutMs: 20 })

    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
  })

  it('propagates a process that fails to start instead of reporting a settled run', async () => {
    const failure = new Error('spawn EACCES')
    const { runtime } = fakeRuntime(() => makeHandle({ done: Promise.reject(failure) }))
    const runner = new SubprocessEgoSpawnRunner(runtime)

    await expect(runner.spawn({ argv: ['ego-browser', 'nodejs'], cwd: '/tmp', timeoutMs: 1_000 }))
      .rejects.toBe(failure)
  })

  it('aborts the internal controller when the caller signal is already fired', async () => {
    const caller = new AbortController()
    caller.abort()
    let spawnedSignal: AbortSignal | undefined
    const { runtime } = fakeRuntime((spec) => {
      spawnedSignal = spec.signal
      return makeHandle()
    })
    const runner = new SubprocessEgoSpawnRunner(runtime)

    await runner.spawn({ argv: ['ego-browser', 'nodejs'], cwd: '/tmp', timeoutMs: 60_000, signal: caller.signal })

    expect(spawnedSignal?.aborted).toBe(true)
  })

  it('propagates a caller abort to the spawned process', async () => {
    const caller = new AbortController()
    const { runtime } = fakeRuntime(spec => ({
      ...makeHandle(),
      done: new Promise<SubprocessOutcome>((resolve) => {
        spec.signal?.addEventListener('abort', () => { resolve({ exitCode: null, signal: 'SIGTERM' }) }, { once: true })
      }),
    }))
    const runner = new SubprocessEgoSpawnRunner(runtime)

    const pending = runner.spawn({ argv: ['ego-browser', 'nodejs'], cwd: '/tmp', timeoutMs: 60_000, signal: caller.signal })
    caller.abort()

    const result = await pending
    expect(result.exitCode).toBeNull()
    expect(result.timedOut).toBe(false)
  })
})
