import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import BenchmarkEvolveEngine, { BenchmarkEvolveEngine as NamedBenchmarkEvolveEngine } from '../src/index.ts'
import { BenchmarkId, CaseId } from '../src/brand.ts'
import { appendScoreboard } from '../src/scoreboard.ts'
import { AGENT_STATE_MARKER } from '../src/snapshot.ts'
import { ensureBenchmark, writeCase } from '../src/store.ts'

function textBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

function nonTextBlock(): ContentBlock {
  return { type: 'tool-call', id: '1' as never, name: 'n', arguments: '{}' }
}

interface StubRun {
  childId: SessionId
  result: Promise<{ output: ContentBlock[]; stopReason: string }>
  dispose: ReturnType<typeof vi.fn>
}

function stubRun(output: ContentBlock[], stopReason = 'completed'): StubRun {
  return {
    childId: SessionId('stub-run'),
    result: Promise.resolve({ output, stopReason }),
    dispose: vi.fn(async () => {}),
  }
}

type ForkStart = (spec: { prompt: ContentBlock[]; parent: unknown; signal: AbortSignal }) => Promise<StubRun>

function provideRuntime(ctx: Context, start: ForkStart, agentsGet: () => unknown = () => ({})): void {
  ctx.provide('subagents', {
    getProvider: (name: string) => (name === 'fork' ? {} : undefined),
    startActivation: start,
  })
  ctx.provide('agents', { get: agentsGet })
}

describe('BenchmarkEvolveEngine service wiring', () => {
  let dir: string
  let agentDir: string
  let benchmarkId: BenchmarkId

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-index-'))
    agentDir = await mkdtemp(join(tmpdir(), 'dsh-index-agent-'))
    benchmarkId = BenchmarkId('summarizer')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(agentDir, { recursive: true, force: true })
  })

  function makeEngine(ctx: Context): BenchmarkEvolveEngine {
    return new BenchmarkEvolveEngine(ctx, { baseDir: dir, agentStateDir: agentDir })
  }

  async function prepareBenchmark(): Promise<void> {
    await ensureBenchmark(dir, benchmarkId, 'Summarizer')
    await writeCase(dir, benchmarkId, CaseId('c1'), { statement: 'Task one', rubric: 'Rubric one' })
  }

  it('default-exports the named engine class and registers as ctx.selfEvolveBenchmark', () => {
    const ctx = new Context()
    const engine = makeEngine(ctx)
    expect(BenchmarkEvolveEngine).toBe(NamedBenchmarkEvolveEngine)
    // `ctx.<name>` exposes the registered instance through a traceable proxy,
    // so identity differs but the class and its core are the same.
    expect(ctx.selfEvolveBenchmark).toBeInstanceOf(BenchmarkEvolveEngine)
    expect(ctx.selfEvolveBenchmark.core).toBe(engine.core)
  })

  it('refuses to construct without an explicit agentStateDir', () => {
    const ctx = new Context()
    // The cwd fallback would make a rejected round wipe the caller's work tree.
    expect(() => new BenchmarkEvolveEngine(ctx, {} as never)).toThrow(/agentStateDir is required/)
  })

  it('refuses a relative, forbidden, or unmarked agentStateDir', async () => {
    const signal = (): AbortSignal => new AbortController().signal
    const relative = new BenchmarkEvolveEngine(new Context(), { baseDir: dir, agentStateDir: 'relative/state' })
    await expect(relative.runBenchmark(benchmarkId, { signal: signal() }))
      .rejects.toThrow(/must be an absolute path/)

    const cwd = new BenchmarkEvolveEngine(new Context(), { baseDir: dir, agentStateDir: process.cwd() })
    await expect(cwd.runBenchmark(benchmarkId, { signal: signal() }))
      .rejects.toThrow(/must not be the current working directory/)

    const root = new BenchmarkEvolveEngine(new Context(), { baseDir: dir, agentStateDir: '/' })
    await expect(root.runBenchmark(benchmarkId, { signal: signal() }))
      .rejects.toThrow(/must not be the filesystem root/)

    const missing = await mkdtemp(join(tmpdir(), 'dsh-index-missing-'))
    await rm(missing, { recursive: true, force: true })
    const gone = new BenchmarkEvolveEngine(new Context(), { baseDir: dir, agentStateDir: missing })
    await expect(gone.runBenchmark(benchmarkId, { signal: signal() }))
      .rejects.toThrow(/does not exist/)

    // A non-empty directory without the marker is someone's workspace.
    await writeFile(join(agentDir, 'notes.md'), 'do not wipe me')
    const unmarked = new BenchmarkEvolveEngine(new Context(), { baseDir: dir, agentStateDir: agentDir })
    await expect(unmarked.runBenchmark(benchmarkId, { signal: signal() }))
      .rejects.toThrow(/lacks the \.self-evolve-benchmark marker/)
  })

  it('refuses an agentStateDir that is not a directory or cannot be inspected', async () => {
    const signal = (): AbortSignal => new AbortController().signal
    const stateFile = join(dir, 'state-file')
    await writeFile(stateFile, 'not a directory\n')
    const file = new BenchmarkEvolveEngine(new Context(), { baseDir: dir, agentStateDir: stateFile })
    await expect(file.runBenchmark(benchmarkId, { signal: signal() }))
      .rejects.toThrow(/agentStateDir is not a directory/)

    // A path below a regular file fails with ENOTDIR: not a missing directory.
    const nested = new BenchmarkEvolveEngine(new Context(), {
      baseDir: dir,
      agentStateDir: join(stateFile, 'nested'),
    })
    await expect(nested.runBenchmark(benchmarkId, { signal: signal() }))
      .rejects.toThrow(/ENOTDIR/)
  })

  it('accepts a marked non-empty agent state directory', async () => {
    const ctx = new Context()
    provideRuntime(ctx, async () => stubRun([textBlock('{"score": 70}')]))
    await writeFile(join(agentDir, AGENT_STATE_MARKER), '')
    await writeFile(join(agentDir, 'guidance.md'), 'guidance')
    const engine = makeEngine(ctx)
    await prepareBenchmark()
    await expect(engine.runBenchmark(benchmarkId, { signal: new AbortController().signal, sessionId: 'sess-1' })).resolves.toBeDefined()
  })

  it('delegates readScoreboard to the core', async () => {
    const ctx = new Context()
    const engine = makeEngine(ctx)
    await expect(engine.readScoreboard(benchmarkId)).resolves.toEqual([])
  })

  describe('default evaluator seam', () => {
    it('evaluates a case through a fork subagent, parsing the JSON score', async () => {
      const ctx = new Context()
      const parent = {}
      const run = stubRun([textBlock('{"score": 80, "note": "good"}')])
      provideRuntime(ctx, async () => run, () => parent)
      const engine = makeEngine(ctx)
      await prepareBenchmark()

      const entry = await engine.runBenchmark(benchmarkId, {
        signal: new AbortController().signal,
        sessionId: 'sess-1',
      })

      expect(entry.score).toBe(80)
      expect(run.dispose).toHaveBeenCalled()
    })

    it('resolves the live parent agent from the session id', async () => {
      const ctx = new Context()
      const parent = {}
      const agentsGet = vi.fn(() => parent)
      const start = vi.fn(
        async (_spec: { prompt: ContentBlock[]; parent: unknown; signal: AbortSignal }) =>
          stubRun([textBlock('{"score": 80}')]),
      )
      provideRuntime(ctx, start, agentsGet)
      const engine = makeEngine(ctx)
      await prepareBenchmark()

      await engine.runBenchmark(benchmarkId, {
        signal: new AbortController().signal,
        sessionId: 'sess-1',
      })

      expect(agentsGet).toHaveBeenCalledWith(SessionId('sess-1'))
      const spec = start.mock.calls[0]![0]
      expect(spec.parent).toBe(parent)
    })

    it('collects every optional outcome field when the evaluator reports them', async () => {
      const ctx = new Context()
      provideRuntime(ctx, async () =>
        stubRun([nonTextBlock(), textBlock('{"score": 85, "cost": 0.5, "durationMs": 123, "sessionId": "s", "note": "n"}')]),
      )
      const engine = makeEngine(ctx)
      await prepareBenchmark()

      const entry = await engine.runBenchmark(benchmarkId, {
        signal: new AbortController().signal,
        sessionId: 'sess-1',
      })

      expect(entry.score).toBe(85)
      expect(entry.cost).toBe(0.5)
      expect(entry.durationMs).toBe(123)
      expect(entry.cases[0]!.runs[0]).toMatchObject({ score: 85, cost: 0.5, durationMs: 123, sessionId: 's', note: 'n' })
    })

    it('skips outcome fields whose JSON types do not match', async () => {
      const ctx = new Context()
      provideRuntime(ctx, async () => stubRun([textBlock('{"score": 80, "cost": "x", "sessionId": 5}')]))
      const engine = makeEngine(ctx)
      await prepareBenchmark()

      const entry = await engine.runBenchmark(benchmarkId, {
        signal: new AbortController().signal,
        sessionId: 'sess-1',
      })

      expect(entry.score).toBe(80)
      expect(entry.cost).toBeUndefined()
      expect(entry.durationMs).toBeUndefined()
      expect(entry.cases[0]!.runs[0]).toEqual({ score: 80, sessionId: 'stub-run' })
    })

    it('fails loud when the evaluator subagent ends early', async () => {
      const ctx = new Context()
      provideRuntime(ctx, async (spec) => {
        const first = spec.prompt[0]
        const text = first !== undefined && first.type === 'text' ? first.text : ''
        if (text.includes('任务执行者')) return stubRun([textBlock('deliverable')])
        return stubRun([textBlock('{"score": 80}')], 'error')
      })
      const engine = makeEngine(ctx)
      await prepareBenchmark()

      await expect(
        engine.runBenchmark(benchmarkId, { signal: new AbortController().signal, sessionId: 'sess-1' }),
      ).rejects.toThrow(/evaluation subagent ended error/)
    })

    it('fails loud on non-JSON, non-object, and score-less evaluator output', async () => {
      for (const payload of ['not json', '42', '{}']) {
        const ctx = new Context()
        provideRuntime(ctx, async () => stubRun([textBlock(payload)]))
        const engine = makeEngine(ctx)
        await prepareBenchmark()
        const expected = payload === '{}' ? /omitted the numeric "score" field/ : /returned (non-JSON output|a non-object)/
        await expect(
          engine.runBenchmark(benchmarkId, { signal: new AbortController().signal, sessionId: 'sess-1' }),
        ).rejects.toThrow(expected)
      }
    })

    it('fails loud when the subagents service is missing', async () => {
      const ctx = new Context()
      ctx.provide('agents', { get: () => ({}) })
      const engine = makeEngine(ctx)
      await prepareBenchmark()

      await expect(
        engine.runBenchmark(benchmarkId, { signal: new AbortController().signal, sessionId: 'sess-1' }),
      ).rejects.toThrow(/execution needs the fork subagent provider and a live parent agent/)
    })

    it('fails loud when no live parent agent resolves', async () => {
      const ctx = new Context()
      ctx.provide('subagents', { getProvider: () => ({}), startActivation: vi.fn() })
      ctx.provide('agents', { get: () => undefined })
      const engine = makeEngine(ctx)
      await prepareBenchmark()

      await expect(
        engine.runBenchmark(benchmarkId, { signal: new AbortController().signal, sessionId: 'sess-1' }),
      ).rejects.toThrow(/execution needs the fork subagent provider and a live parent agent/)
    })

    it('fails loud when the fork provider is not registered', async () => {
      const ctx = new Context()
      ctx.provide('subagents', { getProvider: () => undefined, startActivation: vi.fn() })
      ctx.provide('agents', { get: () => ({}) })
      const engine = makeEngine(ctx)
      await prepareBenchmark()

      await expect(
        engine.runBenchmark(benchmarkId, { signal: new AbortController().signal, sessionId: 'sess-1' }),
      ).rejects.toThrow(/execution needs the fork subagent provider and a live parent agent/)
    })

    it('fails loud when no session id is given and no parent can resolve', async () => {
      const ctx = new Context()
      ctx.provide('subagents', { getProvider: () => ({}), startActivation: vi.fn() })
      ctx.provide('agents', { get: vi.fn() })
      const engine = makeEngine(ctx)
      await prepareBenchmark()

      await expect(
        engine.runBenchmark(benchmarkId, { signal: new AbortController().signal }),
      ).rejects.toThrow(/execution needs the fork subagent provider and a live parent agent/)
    })

    it('evaluates a case without a rubric', async () => {
      const ctx = new Context()
      provideRuntime(ctx, async () => stubRun([textBlock('{"score": 70}')]))
      const engine = makeEngine(ctx)
      await ensureBenchmark(dir, benchmarkId, 'No rubric')
      await writeCase(dir, benchmarkId, CaseId('c1'), { statement: 'Task one' })

      const entry = await engine.runBenchmark(benchmarkId, {
        signal: new AbortController().signal,
        sessionId: 'sess-1',
      })

      expect(entry.score).toBe(70)
    })
  })

  describe('default executor seam', () => {
    it('executes a case through a fork subagent before the evaluator scores it', async () => {
      const ctx = new Context()
      const parent = {}
      const runs: StubRun[] = []
      const start: ForkStart = async (spec) => {
        const first = spec.prompt[0]
        const text = first !== undefined && first.type === 'text' ? first.text : ''
        const run = text.includes('任务执行者')
          ? stubRun([textBlock('正式答复文本')])
          : stubRun([textBlock('{"score": 88, "note": "ok"}')])
        runs.push(run)
        return run
      }
      provideRuntime(ctx, start, () => parent)
      const engine = makeEngine(ctx)
      await prepareBenchmark()

      const entry = await engine.runBenchmark(benchmarkId, {
        signal: new AbortController().signal,
        sessionId: 'sess-1',
      })

      expect(entry.score).toBe(88)
      expect(runs).toHaveLength(2)
      expect(runs[0]!.dispose).toHaveBeenCalled()
      expect(runs[1]!.dispose).toHaveBeenCalled()
    })

    it('falls back to the executor run id as the run session id when the evaluator reports none', async () => {
      const ctx = new Context()
      const parent = {}
      const start: ForkStart = async (spec) => {
        const first = spec.prompt[0]
        const text = first !== undefined && first.type === 'text' ? first.text : ''
        if (text.includes('任务执行者')) {
          return { ...stubRun([textBlock('deliverable')]), childId: SessionId('exec-session-1') }
        }
        return stubRun([textBlock('{"score": 80}')])
      }
      provideRuntime(ctx, start, () => parent)
      const engine = makeEngine(ctx)
      await prepareBenchmark()

      const entry = await engine.runBenchmark(benchmarkId, {
        signal: new AbortController().signal,
        sessionId: 'sess-1',
      })

      expect(entry.cases[0]!.runs[0]).toMatchObject({ score: 80, sessionId: 'exec-session-1' })
    })

    it('fails loud when the executor subagent ends early', async () => {
      const ctx = new Context()
      const parent = {}
      provideRuntime(
        ctx,
        async (spec) => {
          const first = spec.prompt[0]
          const text = first !== undefined && first.type === 'text' ? first.text : ''
          if (text.includes('任务执行者')) return stubRun([textBlock('partial')], 'max-tokens')
          return stubRun([textBlock('{"score": 80}')])
        },
        () => parent,
      )
      const engine = makeEngine(ctx)
      await prepareBenchmark()

      await expect(
        engine.runBenchmark(benchmarkId, { signal: new AbortController().signal, sessionId: 'sess-1' }),
      ).rejects.toThrow(/execution subagent ended max-tokens/)
    })
  })

  describe('default optimizer and applier seams', () => {
    function routedStart(routes: Record<string, { output: string; stopReason?: string }>): ForkStart {
      return async (spec) => {
        const first = spec.prompt[0]
        const text = first !== undefined && first.type === 'text' ? first.text : ''
        const route = text.includes('任务执行者')
          ? 'execute'
          : text.includes('优化者')
            ? 'propose'
            : text.includes('实现者')
              ? 'apply'
              : 'evaluate'
        const config = routes[route] ?? { output: '{"score": 90}' }
        return stubRun([textBlock(config.output)], config.stopReason)
      }
    }

    it('optimizes end to end: propose, apply, then evaluate under the accepted candidate', async () => {
      const ctx = new Context()
      provideRuntime(
        ctx,
        routedStart({
          propose: { output: '{"name":"n","description":"d","prediction":"p"}' },
          apply: { output: '{"applied":true}' },
          evaluate: { output: '{"score": 90}' },
        }),
      )
      const engine = makeEngine(ctx)
      await prepareBenchmark()
      await appendScoreboard(dir, benchmarkId, { version: 0, score: 60, cases: [] })

      const result = await engine.optimizeLoop(benchmarkId, {
        signal: new AbortController().signal,
        sessionId: 'sess-1',
      })

      expect(result.accepted).toBe(true)
      expect(result.bestScore).toBe(90)
      expect(result.acceptedVersion).toBe(1)
    })

    it('fails loud when the proposal omits a field', async () => {
      const ctx = new Context()
      provideRuntime(ctx, routedStart({ propose: { output: '{"name":"n"}' } }))
      const engine = makeEngine(ctx)
      await prepareBenchmark()
      await appendScoreboard(dir, benchmarkId, { version: 0, score: 60, cases: [] })

      await expect(
        engine.optimizeLoop(benchmarkId, { signal: new AbortController().signal, sessionId: 'sess-1' }),
      ).rejects.toThrow(/omitted name\/description\/prediction/)
    })

    it('fails loud when the optimizer subagent ends early', async () => {
      const ctx = new Context()
      provideRuntime(ctx, routedStart({ propose: { output: '{"name":"n","description":"d","prediction":"p"}', stopReason: 'error' } }))
      const engine = makeEngine(ctx)
      await prepareBenchmark()
      await appendScoreboard(dir, benchmarkId, { version: 0, score: 60, cases: [] })

      await expect(
        engine.optimizeLoop(benchmarkId, { signal: new AbortController().signal, sessionId: 'sess-1' }),
      ).rejects.toThrow(/optimization subagent ended error/)
    })

    it('fails loud when the applier subagent ends early', async () => {
      const ctx = new Context()
      provideRuntime(
        ctx,
        routedStart({
          propose: { output: '{"name":"n","description":"d","prediction":"p"}' },
          apply: { output: '{"applied":true}', stopReason: 'error' },
        }),
      )
      const engine = makeEngine(ctx)
      await prepareBenchmark()
      await appendScoreboard(dir, benchmarkId, { version: 0, score: 60, cases: [] })

      await expect(
        engine.optimizeLoop(benchmarkId, { signal: new AbortController().signal, sessionId: 'sess-1' }),
      ).rejects.toThrow(/apply subagent ended error/)
    })

    it('rolls back a rejected candidate through the snapshot restore seam', async () => {
      const ctx = new Context()
      provideRuntime(
        ctx,
        routedStart({
          propose: { output: '{"name":"n","description":"d","prediction":"p"}' },
          apply: { output: '{"applied":true}' },
          evaluate: { output: '{"score": 50}' },
        }),
      )
      const engine = makeEngine(ctx)
      await prepareBenchmark()
      await appendScoreboard(dir, benchmarkId, { version: 0, score: 60, cases: [] })

      const result = await engine.optimizeLoop(benchmarkId, {
        signal: new AbortController().signal,
        sessionId: 'sess-1',
      })

      expect(result.accepted).toBe(false)
      expect(result.acceptedVersion).toBeUndefined()
      expect(result.bestScore).toBe(60)
    })
  })

  describe('delegated public methods', () => {
    it('runs a baseline through the default evaluator seam', async () => {
      const ctx = new Context()
      provideRuntime(ctx, async () => stubRun([textBlock('{"score": 70}')]))
      const engine = makeEngine(ctx)
      await prepareBenchmark()

      const entry = await engine.establishBaseline(benchmarkId, {
        signal: new AbortController().signal,
        sessionId: 'sess-1',
      })

      expect(entry.score).toBe(70)
      await expect(engine.readScoreboard(benchmarkId)).resolves.toHaveLength(1)
    })

    it('applies the configured runsPerCase to a run that omits it', async () => {
      const ctx = new Context()
      let evaluateCalls = 0
      provideRuntime(ctx, async (spec) => {
        const first = spec.prompt[0]
        const text = first !== undefined && first.type === 'text' ? first.text : ''
        if (text.includes('任务执行者')) return stubRun([textBlock('deliverable')])
        evaluateCalls += 1
        return stubRun([textBlock('{"score": 70}')])
      })
      const engine = new BenchmarkEvolveEngine(ctx, {
        baseDir: dir,
        agentStateDir: agentDir,
        runsPerCase: 2,
      })
      await prepareBenchmark()

      const entry = await engine.establishBaseline(benchmarkId, {
        signal: new AbortController().signal,
        sessionId: 'sess-1',
      })

      expect(evaluateCalls).toBe(2)
      expect(entry.cases[0]!.runs).toHaveLength(2)
    })

    it('applies configured loop defaults to an optimizeLoop that omits them', async () => {
      const ctx = new Context()
      const start: ForkStart = async (spec) => {
        const first = spec.prompt[0]
        const text = first !== undefined && first.type === 'text' ? first.text : ''
        if (text.includes('任务执行者')) return stubRun([textBlock('deliverable')])
        if (text.includes('优化者')) return stubRun([textBlock('{"name":"n","description":"d","prediction":"p"}')])
        if (text.includes('实现者')) return stubRun([textBlock('{"applied":true}')])
        return stubRun([textBlock('{"score": 90}')])
      }
      provideRuntime(ctx, start)
      const engine = new BenchmarkEvolveEngine(ctx, {
        baseDir: dir,
        agentStateDir: agentDir,
        runsPerCase: 2,
        maxRoundsPerLoop: 2,
        targetScore: 90,
      })
      await prepareBenchmark()
      await appendScoreboard(dir, benchmarkId, { version: 0, score: 60, cases: [] })

      const result = await engine.optimizeLoop(benchmarkId, {
        signal: new AbortController().signal,
        sessionId: 'sess-1',
      })

      expect(result.rounds).toBe(1)
      expect(result.accepted).toBe(true)
      expect(result.bestScore).toBe(90)
      expect(result.entries[0]!.cases[0]!.runs).toHaveLength(2)
    })

    it('lets explicit run options override the configured defaults', async () => {
      const ctx = new Context()
      let evaluateCalls = 0
      provideRuntime(ctx, async (spec) => {
        const first = spec.prompt[0]
        const text = first !== undefined && first.type === 'text' ? first.text : ''
        if (text.includes('任务执行者')) return stubRun([textBlock('deliverable')])
        evaluateCalls += 1
        return stubRun([textBlock('{"score": 70}')])
      })
      const engine = new BenchmarkEvolveEngine(ctx, {
        baseDir: dir,
        agentStateDir: agentDir,
        runsPerCase: 1,
      })
      await prepareBenchmark()

      const entry = await engine.runBenchmark(benchmarkId, {
        signal: new AbortController().signal,
        sessionId: 'sess-1',
        runsPerCase: 2,
      })

      expect(evaluateCalls).toBe(2)
      expect(entry.cases[0]!.runs).toHaveLength(2)
    })

    it('honors explicit optimizeLoop knobs over the configured defaults', async () => {
      const ctx = new Context()
      provideRuntime(ctx, async (spec) => {
        const first = spec.prompt[0]
        const text = first !== undefined && first.type === 'text' ? first.text : ''
        if (text.includes('任务执行者')) return stubRun([textBlock('deliverable')])
        if (text.includes('优化者')) return stubRun([textBlock('{"name":"n","description":"d","prediction":"p"}')])
        if (text.includes('实现者')) return stubRun([textBlock('{"applied":true}')])
        return stubRun([textBlock('{"score": 90}')])
      })
      const engine = new BenchmarkEvolveEngine(ctx, {
        baseDir: dir,
        agentStateDir: agentDir,
        runsPerCase: 1,
        maxRoundsPerLoop: 1,
      })
      await prepareBenchmark()
      await appendScoreboard(dir, benchmarkId, { version: 0, score: 60, cases: [] })

      const result = await engine.optimizeLoop(benchmarkId, {
        signal: new AbortController().signal,
        sessionId: 'sess-1',
        maxRounds: 1,
        runsPerCase: 1,
      })

      expect(result.accepted).toBe(true)
    })
  })
})
