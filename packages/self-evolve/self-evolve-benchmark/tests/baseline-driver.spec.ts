import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/baseline-driver.ts'
import { BenchmarkId } from '../src/brand.ts'

interface CreateOptions {
  sessionId: string
  meta?: { cwd?: string }
  agentOptions?: { provider?: string; model?: string }
  setup?: (agentCtx: Context) => unknown
}

interface BaselineCall {
  benchmarkId: BenchmarkId
  options: {
    runsPerCase?: number
    sessionId?: string
    provider?: string
    modelId?: string
    signal: AbortSignal
  }
}

interface DriverEnvironment {
  ctx: Context
  exit: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
  establishBaseline: ReturnType<typeof vi.fn>
  calls: BaselineCall[]
}

/**
 * Mount the driver over stub core services. The stubs record what the driver
 * asks of them; the baseline call stays pending until the case settles it, so
 * the assertions observe the driver's actual ordering.
 *
 * @param options - whether the benchmark service is present and how the baseline settles.
 * @returns the mounted context and the recording stubs.
 */
function mountDriver(options: {
  withBenchmark?: boolean
  withFs?: boolean
  baseline?: () => Promise<unknown>
} = {}): DriverEnvironment {
  const ctx = new Context()
  const exit = vi.fn()
  const dispose = vi.fn(async () => {})
  const create = vi.fn(async (_options: CreateOptions) => ({
    agent: { whenIdle: async () => {} },
    dispose,
  }))
  const calls: BaselineCall[] = []
  const establishBaseline = vi.fn(async (benchmarkId: BenchmarkId, callOptions: BaselineCall['options']) => {
    calls.push({ benchmarkId, options: callOptions })
    return options.baseline === undefined ? { version: 0, score: 72.5 } : await options.baseline()
  })
  ctx.provide('appExit', exit)
  ctx.provide('agents', { create })
  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-v4' }),
  })
  if (options.withFs === true) {
    ctx.provide('fs', {
      resolve: async () => ({ targetKey: '/workspace' }),
      processPath: () => '/workspace',
    })
  }
  if (options.withBenchmark !== false) ctx.provide('selfEvolveBenchmark', { establishBaseline })
  apply(ctx, { benchmarkId: 'patent-oas', runsPerCase: 1 })
  return { ctx, exit, create, dispose, establishBaseline, calls }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('baseline driver', () => {
  it('creates one parent agent, runs the baseline, and reports the entry', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const environment = mountDriver()

    await vi.waitFor(() => { expect(environment.exit).toHaveBeenCalledWith(0) })

    expect(environment.create).toHaveBeenCalledTimes(1)
    const created = environment.create.mock.calls[0]?.[0] as CreateOptions
    expect(created.sessionId).toMatch(/^session-/)
    expect(created.agentOptions).toEqual({ provider: 'deepseek', model: 'deepseek-v4' })
    expect(created.meta?.cwd).toBe(process.cwd())
    expect(typeof created.setup).toBe('function')
    // The setup scope registers the model-selection listener on the agent's own context.
    expect(() => { created.setup?.(new Context()) }).not.toThrow()

    expect(environment.calls).toHaveLength(1)
    expect(environment.calls[0]?.benchmarkId).toBe('patent-oas')
    expect(environment.calls[0]?.options.runsPerCase).toBe(1)
    expect(environment.calls[0]?.options.sessionId).toBe(created.sessionId)
    expect(environment.calls[0]?.options.provider).toBe('deepseek')
    expect(environment.calls[0]?.options.modelId).toBe('deepseek-v4')
    expect(environment.calls[0]?.options.signal).toBeInstanceOf(AbortSignal)

    expect(environment.dispose).toHaveBeenCalledTimes(1)
    const printed = stdout.mock.calls.map(call => String(call[0])).join('')
    expect(JSON.parse(printed)).toEqual({ version: 0, score: 72.5 })
  })

  it('reports a missing benchmark service without creating an agent', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const environment = mountDriver({ withBenchmark: false })

    await vi.waitFor(() => { expect(environment.exit).toHaveBeenCalledWith(1) })

    expect(environment.create).not.toHaveBeenCalled()
    const reported = stderr.mock.calls.map(call => String(call[0])).join('')
    expect(reported).toContain('selfEvolveBenchmark')
  })

  it('uses the fs process path for the agent cwd when the fs service is present', async () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const environment = mountDriver({ withFs: true })

    await vi.waitFor(() => { expect(environment.exit).toHaveBeenCalledWith(0) })

    const created = environment.create.mock.calls[0]?.[0] as CreateOptions
    expect(created.meta?.cwd).toBe('/workspace')
  })

  it('disposes the agent and exits failing when the baseline rejects', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const environment = mountDriver({ baseline: () => Promise.reject(new Error('case run failed')) })

    await vi.waitFor(() => { expect(environment.exit).toHaveBeenCalledWith(1) })

    expect(environment.dispose).toHaveBeenCalledTimes(1)
    const reported = stderr.mock.calls.map(call => String(call[0])).join('')
    expect(reported).toContain('case run failed')
  })

  it('reports a non-Error rejection by its string form', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const environment = mountDriver({
      baseline: async () => {
        throw 'plain failure'
      },
    })

    await vi.waitFor(() => { expect(environment.exit).toHaveBeenCalledWith(1) })

    const reported = stderr.mock.calls.map(call => String(call[0])).join('')
    expect(reported).toContain('plain failure')
  })
})
