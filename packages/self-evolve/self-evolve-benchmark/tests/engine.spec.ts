import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BenchmarkId, CaseId } from '../src/brand.ts'
import { BenchmarkEngineCore } from '../src/engine.ts'
import { appendScoreboard } from '../src/scoreboard.ts'
import { benchmarkConfigPath, ensureBenchmark, writeCase } from '../src/store.ts'
import type {
  ApplyCandidateOptions,
  BenchmarkEngineOptions,
  EvaluateCaseRequest,
  ExecuteCaseRequest,
  ProposeCandidateOptions,
  ScoreboardEntry,
} from '../src/types.ts'

function signal(): AbortSignal {
  return new AbortController().signal
}

function candidate(index = 1) {
  return { name: `candidate ${index}`, description: `change ${index}`, prediction: `scores shift ${index}` }
}

describe('BenchmarkEngineCore', () => {
  let dir: string
  let agentDir: string
  let benchmarkId: BenchmarkId

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-engine-'))
    agentDir = await mkdtemp(join(tmpdir(), 'dsh-engine-agent-'))
    benchmarkId = BenchmarkId('summarizer')
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    await rm(agentDir, { recursive: true, force: true })
  })

  function options(overrides: Partial<BenchmarkEngineOptions> = {}): BenchmarkEngineOptions {
    return {
      baseDir: dir,
      agentStateDir: agentDir,
      executeCase: vi.fn(async (_request: ExecuteCaseRequest) => ({ output: 'deliverable' })),
      evaluateCase: vi.fn(async (_request: EvaluateCaseRequest) => ({ score: 50 })),
      proposeCandidate: vi.fn(async (_options: ProposeCandidateOptions) => candidate()),
      applyCandidate: vi.fn(async (_options: ApplyCandidateOptions) => ({ agentStatePath: agentDir })),
      restoreSnapshot: vi.fn(async (_options: { version: number; signal: AbortSignal }) => {}),
      ...overrides,
    }
  }

  async function prepareBenchmark(
    cases: { caseId: CaseId; statement: string; rubric?: string }[] = [
      { caseId: CaseId('c1'), statement: 'Task one', rubric: 'Rubric one' },
    ],
  ): Promise<void> {
    await ensureBenchmark(dir, benchmarkId, 'Summarizer')
    for (const spec of cases) await writeCase(dir, benchmarkId, spec.caseId, spec)
  }

  describe('runBenchmark', () => {
    it('runs every case against the current agent state and persists one entry', async () => {
      await prepareBenchmark([
        { caseId: CaseId('c1'), statement: 'Task one', rubric: 'R1' },
        { caseId: CaseId('c2'), statement: 'Task two' },
      ])
      const evaluateCase = vi.fn(async (request: EvaluateCaseRequest) => ({
        score: request.caseId === 'c1' ? 70 : 80,
      }))
      const engine = new BenchmarkEngineCore(options({ evaluateCase }))

      const entry = await engine.runBenchmark(benchmarkId, { signal: signal() })

      expect(entry.version).toBe(0)
      expect(entry.score).toBe(75)
      expect(entry.cases).toHaveLength(2)
      expect(evaluateCase).toHaveBeenCalledTimes(2)
      const firstCall = evaluateCase.mock.calls[0]![0]
      expect(firstCall.caseId).toBe('c1')
      expect(firstCall.statement).toBe('Task one')
      expect(firstCall.rubric).toBe('R1')
      expect(firstCall.agentStatePath).toBe(agentDir)
      await expect(engine.readScoreboard(benchmarkId)).resolves.toHaveLength(1)
    })

    it('rejects a non-finite or out-of-range evaluator score instead of clamping it', async () => {
      await prepareBenchmark()
      for (const score of [Number.NaN, Number.POSITIVE_INFINITY, -1, 101]) {
        const engine = new BenchmarkEngineCore(options({ evaluateCase: vi.fn(async () => ({ score })) }))
        await expect(engine.runBenchmark(benchmarkId, { signal: signal() }))
          .rejects.toThrow(/invalid score for case "c1"/)
      }
    })

    it('executes each case before scoring and threads the deliverable into evaluation', async () => {
      await prepareBenchmark([
        { caseId: CaseId('c1'), statement: 'Task one', rubric: 'R1' },
        { caseId: CaseId('c2'), statement: 'Task two' },
      ])
      const order: string[] = []
      const executeCase = vi.fn(async (request: ExecuteCaseRequest) => {
        order.push(`execute:${request.caseId}`)
        return { output: `answer for ${request.caseId}`, sessionId: `exec-${request.caseId}` }
      })
      const evaluateCase = vi.fn(async (request: EvaluateCaseRequest) => {
        order.push(`evaluate:${request.caseId}`)
        return { score: request.attempt?.output === `answer for ${request.caseId}` ? 85 : 0 }
      })
      const engine = new BenchmarkEngineCore(options({ executeCase, evaluateCase }))

      const entry = await engine.runBenchmark(benchmarkId, { signal: signal() })

      expect(order).toEqual(['execute:c1', 'evaluate:c1', 'execute:c2', 'evaluate:c2'])
      const firstEval = evaluateCase.mock.calls[0]![0]
      expect(firstEval.attempt).toEqual({ output: 'answer for c1', sessionId: 'exec-c1' })
      expect(entry.score).toBe(85)
    })

    it('sums executor and evaluator cost and duration when both phases report them', async () => {
      await prepareBenchmark()
      const executeCase = vi.fn(async (_request: ExecuteCaseRequest) => ({ output: 'd', cost: 0.2, durationMs: 40 }))
      const evaluateCase = vi.fn(async (_request: EvaluateCaseRequest) => ({ score: 60, cost: 0.1, durationMs: 100 }))
      const engine = new BenchmarkEngineCore(options({ executeCase, evaluateCase }))

      const entry = await engine.runBenchmark(benchmarkId, { signal: signal() })

      expect(entry.cost).toBe(0.3)
      expect(entry.durationMs).toBe(140)
      const run = entry.cases[0]!.runs[0]!
      expect(run.score).toBe(60)
      expect(run.cost).toBeCloseTo(0.3)
      expect(run.durationMs).toBe(140)
    })

    it('keeps the reported side when only one phase reports cost or duration', async () => {
      await prepareBenchmark()
      const executeCase = vi.fn(async (_request: ExecuteCaseRequest) => ({ output: 'd', cost: 0.2 }))
      const evaluateCase = vi.fn(async (_request: EvaluateCaseRequest) => ({ score: 60, durationMs: 100 }))
      const engine = new BenchmarkEngineCore(options({ executeCase, evaluateCase }))

      const entry = await engine.runBenchmark(benchmarkId, { signal: signal() })

      expect(entry.cost).toBe(0.2)
      expect(entry.durationMs).toBe(100)
      const run = entry.cases[0]!.runs[0]!
      expect(run.score).toBe(60)
      expect(run.cost).toBe(0.2)
      expect(run.durationMs).toBe(100)
    })

    it('aggregates runsPerCase runs and records provider metadata', async () => {
      await prepareBenchmark()
      const evaluateCase = vi.fn(async (_request: EvaluateCaseRequest) => ({
        score: 60,
        cost: 0.1,
        durationMs: 100,
        sessionId: 'run-s',
        note: 'ok',
      }))
      const engine = new BenchmarkEngineCore(options({ evaluateCase }))

      const entry = await engine.runBenchmark(benchmarkId, {
        signal: signal(),
        runsPerCase: 2,
        provider: 'deepseek',
        modelId: 'deepseek-chat',
        thinkingLevel: 'high',
        sessionId: 'sess-1',
        version: 7,
      })

      expect(evaluateCase).toHaveBeenCalledTimes(2)
      expect(entry.version).toBe(7)
      expect(entry.score).toBe(60)
      expect(entry.provider).toBe('deepseek')
      expect(entry.modelId).toBe('deepseek-chat')
      expect(entry.thinkingLevel).toBe('high')
      expect(entry.sessionId).toBe('sess-1')
      expect(entry.cost).toBe(0.1)
      expect(entry.durationMs).toBe(100)
      expect(entry.cases[0]).toMatchObject({
        caseId: CaseId('c1'),
        score: 60,
        cost: 0.1,
        durationMs: 100,
        runs: [
          { score: 60, cost: 0.1, durationMs: 100, sessionId: 'run-s', note: 'ok' },
          { score: 60, cost: 0.1, durationMs: 100, sessionId: 'run-s', note: 'ok' },
        ],
      })
    })

    it('omits cost and duration when no run reports them', async () => {
      await prepareBenchmark()
      const engine = new BenchmarkEngineCore(options())
      const entry = await engine.runBenchmark(benchmarkId, { signal: signal() })
      expect(entry.cost).toBeUndefined()
      expect(entry.durationMs).toBeUndefined()
    })
  })

  describe('establishBaseline', () => {
    it('is a single-run benchmark entry persisted to the scoreboard', async () => {
      await prepareBenchmark()
      const engine = new BenchmarkEngineCore(options())
      const entry = await engine.establishBaseline(benchmarkId, { signal: signal() })
      expect(entry.score).toBe(50)
      await expect(engine.readScoreboard(benchmarkId)).resolves.toHaveLength(1)
    })
  })

  describe('optimizeLoop', () => {
    it('refuses to optimize without a reference entry', async () => {
      await prepareBenchmark()
      const engine = new BenchmarkEngineCore(options())
      await expect(engine.optimizeLoop(benchmarkId, { signal: signal() })).rejects.toThrow(/no reference entry/)
    })

    it('refuses a measurement-only (held-out) benchmark before any snapshot or candidate', async () => {
      await prepareBenchmark()
      await writeFile(benchmarkConfigPath(dir, benchmarkId), 'title: Held out\noptimizable: false\n', 'utf8')
      const executeCase = vi.fn(async (_request: ExecuteCaseRequest) => ({ output: 'deliverable' }))
      const proposeCandidate = vi.fn(async (_options: ProposeCandidateOptions) => candidate())
      const applyCandidate = vi.fn(async (_options: ApplyCandidateOptions) => ({ agentStatePath: agentDir }))
      const restoreSnapshot = vi.fn(async (_options: { version: number; signal: AbortSignal }) => {})
      const engine = new BenchmarkEngineCore(
        options({ executeCase, proposeCandidate, applyCandidate, restoreSnapshot }),
      )

      await expect(engine.optimizeLoop(benchmarkId, {
        reference: { version: 0, score: 60, cases: [] },
        signal: signal(),
      })).rejects.toThrow(/measurement-only \(optimizable: false/)
      // 拒绝发生在快照与候选之前：optimizer 从未看到 statement，history 为空。
      expect(proposeCandidate).not.toHaveBeenCalled()
      expect(applyCandidate).not.toHaveBeenCalled()
      expect(executeCase).not.toHaveBeenCalled()
      expect(restoreSnapshot).not.toHaveBeenCalled()

      // 测量不受 optimizable 影响：held-out benchmark 仍可 establishBaseline 并写出 scoreboard。
      const baseline = await engine.establishBaseline(benchmarkId, { signal: signal() })
      expect(baseline.score).toBe(50)
      await expect(engine.readScoreboard(benchmarkId)).resolves.toHaveLength(1)
    })

    it('optimizer inputs never cross benchmarks: statement and history carry only the optimized benchmark', async () => {
      const devId = BenchmarkId('dev-bench')
      const heldoutId = BenchmarkId('heldout-bench')
      await ensureBenchmark(dir, devId, 'Dev')
      await writeCase(dir, devId, CaseId('dev-case'), { statement: 'Dev task text', rubric: 'Dev rubric' })
      await ensureBenchmark(dir, heldoutId, 'Held out')
      await writeCase(dir, heldoutId, CaseId('heldout-case'), { statement: 'Heldout task text', rubric: 'Heldout rubric' })
      const proposeCandidate = vi.fn(async (_options: ProposeCandidateOptions) => candidate())
      const evaluateCase = vi.fn(async (_request: EvaluateCaseRequest) => ({ score: 90 }))
      const engine = new BenchmarkEngineCore(options({ proposeCandidate, evaluateCase }))

      await engine.optimizeLoop(devId, {
        reference: { version: 0, score: 60, cases: [] },
        maxRounds: 2,
        signal: signal(),
      })

      expect(proposeCandidate).toHaveBeenCalledTimes(2)
      for (const call of proposeCandidate.mock.calls) {
        const proposeOptions = call[0]
        expect(proposeOptions.statement).toContain('dev-case')
        expect(proposeOptions.statement).toContain('Dev task text')
        expect(proposeOptions.statement).not.toContain('heldout-case')
        expect(proposeOptions.statement).not.toContain('Heldout task text')
        for (const attempt of proposeOptions.history) {
          expect(attempt.cases.map(entry => entry.caseId)).toEqual(['dev-case'])
        }
      }
      // 第二轮的 history 只含本 benchmark 第一轮已评估的尝试。
      expect(proposeCandidate.mock.calls[1]![0].history).toHaveLength(1)
    })

    it('accepts an improving candidate and stops early at the target score', async () => {
      await prepareBenchmark()
      const reference: ScoreboardEntry = { version: 0, score: 60, cases: [] }
      const evaluateCase = vi.fn(async (_request: EvaluateCaseRequest) => ({ score: 90 }))
      const proposeCandidate = vi.fn(async (_options: ProposeCandidateOptions) => candidate())
      const applyCandidate = vi.fn(async (_options: ApplyCandidateOptions) => ({ agentStatePath: agentDir }))
      const restoreSnapshot = vi.fn(async (_options: { version: number; signal: AbortSignal }) => {})
      const engine = new BenchmarkEngineCore(
        options({ evaluateCase, proposeCandidate, applyCandidate, restoreSnapshot }),
      )

      const result = await engine.optimizeLoop(benchmarkId, {
        reference,
        targetScore: 80,
        maxRounds: 3,
        signal: signal(),
      })

      expect(result.accepted).toBe(true)
      // Version 1 is the round's opening state; the candidate's own snapshot is 2.
      expect(result.acceptedVersion).toBe(2)
      expect(result.referenceScore).toBe(60)
      expect(result.bestScore).toBe(90)
      expect(result.rounds).toBe(1)
      expect(result.entries).toHaveLength(1)
      // Acceptance restores the candidate's archive so the disk matches the version.
      expect(restoreSnapshot).toHaveBeenCalledTimes(1)
      expect(restoreSnapshot.mock.calls[0]![0].version).toBe(2)
      expect(proposeCandidate).toHaveBeenCalledTimes(1)
      const proposeCall = proposeCandidate.mock.calls[0]![0]
      expect(proposeCall.reference.score).toBe(60)
      expect(proposeCall.statement).toContain('Task one')
      expect(proposeCall.round).toBe(1)
      expect(applyCandidate).toHaveBeenCalledTimes(1)
      const applyCall = applyCandidate.mock.calls[0]![0]
      expect(applyCall.candidate).toEqual(candidate())
      expect(applyCall.agentStateDir).toBe(agentDir)
    })

    it('rolls back a candidate that fails to strictly beat the reference', async () => {
      await prepareBenchmark()
      const reference: ScoreboardEntry = { version: 0, score: 60, cases: [] }
      const evaluateCase = vi.fn(async (_request: EvaluateCaseRequest) => ({ score: 50 }))
      const restoreSnapshot = vi.fn(async (_options: { version: number; signal: AbortSignal }) => {})
      const engine = new BenchmarkEngineCore(options({ evaluateCase, restoreSnapshot }))

      const result = await engine.optimizeLoop(benchmarkId, { reference, maxRounds: 1, signal: signal() })

      expect(result.accepted).toBe(false)
      expect(result.acceptedVersion).toBeUndefined()
      expect(result.bestScore).toBe(60)
      expect(restoreSnapshot).toHaveBeenCalledTimes(1)
      const restoreCall = restoreSnapshot.mock.calls[0]![0]
      expect(restoreCall.version).toBe(1)
    })

    it('rejects a candidate whose gain stays below minImprovement', async () => {
      await prepareBenchmark()
      const reference: ScoreboardEntry = { version: 0, score: 60, cases: [] }
      const evaluateCase = vi.fn(async (_request: EvaluateCaseRequest) => ({ score: 64 }))
      const restoreSnapshot = vi.fn(async (_options: { version: number; signal: AbortSignal }) => {})
      const engine = new BenchmarkEngineCore(options({ evaluateCase, restoreSnapshot }))

      const result = await engine.optimizeLoop(benchmarkId, {
        reference,
        maxRounds: 1,
        minImprovement: 5,
        signal: signal(),
      })

      expect(result.accepted).toBe(false)
      expect(result.bestScore).toBe(60)
      expect(restoreSnapshot).toHaveBeenCalledTimes(1)
    })

    it('accepts a candidate whose gain reaches minImprovement', async () => {
      await prepareBenchmark()
      const reference: ScoreboardEntry = { version: 0, score: 60, cases: [] }
      const evaluateCase = vi.fn(async (_request: EvaluateCaseRequest) => ({ score: 65 }))
      const restoreSnapshot = vi.fn(async (_options: { version: number; signal: AbortSignal }) => {})
      const engine = new BenchmarkEngineCore(options({ evaluateCase, restoreSnapshot }))

      const result = await engine.optimizeLoop(benchmarkId, {
        reference,
        maxRounds: 1,
        minImprovement: 5,
        signal: signal(),
      })

      expect(result.accepted).toBe(true)
      expect(result.acceptedVersion).toBe(2)
      expect(restoreSnapshot).toHaveBeenCalledTimes(1)
      expect(restoreSnapshot.mock.calls[0]![0].version).toBe(2)
    })

    it('rejects a negative or non-finite minImprovement before touching the agent state', async () => {
      await prepareBenchmark()
      const reference: ScoreboardEntry = { version: 0, score: 60, cases: [] }
      const proposeCandidate = vi.fn(async (_options: ProposeCandidateOptions) => candidate())
      const restoreSnapshot = vi.fn(async (_options: { version: number; signal: AbortSignal }) => {})
      const engine = new BenchmarkEngineCore(options({ proposeCandidate, restoreSnapshot }))

      for (const minImprovement of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(engine.optimizeLoop(benchmarkId, { reference, minImprovement, signal: signal() }))
          .rejects.toThrow(/minImprovement must be a finite number >= 0/)
      }

      expect(proposeCandidate).not.toHaveBeenCalled()
      expect(restoreSnapshot).not.toHaveBeenCalled()
    })

    it('restores the round snapshot when evaluation throws', async () => {
      await prepareBenchmark()
      const reference: ScoreboardEntry = { version: 0, score: 60, cases: [] }
      const evaluateCase = vi.fn(async (_request: EvaluateCaseRequest) => {
        throw new Error('evaluator exploded')
      })
      const restoreSnapshot = vi.fn(async (_options: { version: number; signal: AbortSignal }) => {})
      const engine = new BenchmarkEngineCore(options({ evaluateCase, restoreSnapshot }))

      await expect(engine.optimizeLoop(benchmarkId, { reference, maxRounds: 1, signal: signal() }))
        .rejects.toThrow('evaluator exploded')

      expect(restoreSnapshot).toHaveBeenCalledTimes(1)
      expect(restoreSnapshot.mock.calls[0]![0].version).toBe(1)
    })

    it('reports both failures when the rollback itself fails', async () => {
      await prepareBenchmark()
      const reference: ScoreboardEntry = { version: 0, score: 60, cases: [] }
      const evaluateCase = vi.fn(async (_request: EvaluateCaseRequest) => {
        throw new Error('evaluator exploded')
      })
      const restoreSnapshot = vi.fn(async (_options: { version: number; signal: AbortSignal }) => {
        throw new Error('restore exploded')
      })
      const engine = new BenchmarkEngineCore(options({ evaluateCase, restoreSnapshot }))

      const failure: unknown = await engine
        .optimizeLoop(benchmarkId, { reference, maxRounds: 1, signal: signal() })
        .catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(AggregateError)
      expect((failure as AggregateError).message).toMatch(/round 1 failed and the snapshot restore also failed/)
      expect((failure as AggregateError).errors).toHaveLength(2)
    })

    it('accepts an improving candidate on a later round under a fresh version', async () => {
      await prepareBenchmark()
      const reference: ScoreboardEntry = { version: 0, score: 60, cases: [] }
      const evaluateCase = vi
        .fn(async (_request: EvaluateCaseRequest) => ({ score: 50 }))
        .mockResolvedValueOnce({ score: 50 })
        .mockResolvedValueOnce({ score: 90 })
      const restoreSnapshot = vi.fn(async (_options: { version: number; signal: AbortSignal }) => {})
      const engine = new BenchmarkEngineCore(options({ evaluateCase, restoreSnapshot }))

      const result = await engine.optimizeLoop(benchmarkId, { reference, maxRounds: 2, signal: signal() })

      expect(result.rounds).toBe(2)
      expect(result.accepted).toBe(true)
      // Round 1 mints v1 (opening) + v2 (candidate); round 2 mints v3 + v4.
      expect(result.acceptedVersion).toBe(4)
      expect(result.bestScore).toBe(90)
      expect(restoreSnapshot).toHaveBeenCalledTimes(2)
    })

    it('uses the latest scoreboard entry as the reference when none is given', async () => {
      await prepareBenchmark()
      await appendScoreboard(dir, benchmarkId, { version: 0, score: 60, cases: [] })
      const proposeCandidate = vi.fn(async (_options: ProposeCandidateOptions) => candidate())
      const engine = new BenchmarkEngineCore(options({ proposeCandidate }))

      const result = await engine.optimizeLoop(benchmarkId, { signal: signal() })

      const proposeCall = proposeCandidate.mock.calls[0]![0]
      expect(proposeCall.reference.score).toBe(60)
      expect(result.referenceScore).toBe(60)
    })

    it('passes the session id through to proposal, apply, and evaluation', async () => {
      await prepareBenchmark()
      const reference: ScoreboardEntry = { version: 0, score: 60, cases: [] }
      const proposeCandidate = vi.fn(async (_options: ProposeCandidateOptions) => candidate())
      const applyCandidate = vi.fn(async (_options: ApplyCandidateOptions) => ({ agentStatePath: agentDir }))
      const evaluateCase = vi.fn(async (request: EvaluateCaseRequest) => ({
        score: request.sessionId === 'sess-9' ? 90 : 0,
      }))
      const engine = new BenchmarkEngineCore(options({ proposeCandidate, applyCandidate, evaluateCase }))

      const result = await engine.optimizeLoop(benchmarkId, {
        reference,
        maxRounds: 1,
        sessionId: 'sess-9',
        signal: signal(),
      })

      const proposeCall = proposeCandidate.mock.calls[0]![0]
      const applyCall = applyCandidate.mock.calls[0]![0]
      expect(proposeCall.sessionId).toBe('sess-9')
      expect(applyCall.sessionId).toBe('sess-9')
      expect(result.accepted).toBe(true)
    })

    it('skips all rounds when the signal is already aborted', async () => {
      await prepareBenchmark()
      const reference: ScoreboardEntry = { version: 0, score: 60, cases: [] }
      const proposeCandidate = vi.fn(async (_options: ProposeCandidateOptions) => candidate())
      const engine = new BenchmarkEngineCore(options({ proposeCandidate }))
      const controller = new AbortController()
      controller.abort()

      const result = await engine.optimizeLoop(benchmarkId, {
        reference,
        maxRounds: 3,
        signal: controller.signal,
      })

      expect(result.rounds).toBe(0)
      expect(result.accepted).toBe(false)
      expect(proposeCandidate).not.toHaveBeenCalled()
    })

    it('passes the candidate evaluation runtime fields through each round', async () => {
      await prepareBenchmark()
      const reference: ScoreboardEntry = { version: 0, score: 60, cases: [] }
      const evaluateCase = vi.fn(async (_request: EvaluateCaseRequest) => ({ score: 90 }))
      const engine = new BenchmarkEngineCore(options({ evaluateCase }))

      const result = await engine.optimizeLoop(benchmarkId, {
        reference,
        runsPerCase: 2,
        provider: 'deepseek',
        modelId: 'deepseek-chat',
        thinkingLevel: 'high',
        signal: signal(),
      })

      expect(result.accepted).toBe(true)
      expect(evaluateCase).toHaveBeenCalledTimes(2)
      const entry = result.entries[0]!
      expect(entry.provider).toBe('deepseek')
      expect(entry.modelId).toBe('deepseek-chat')
      expect(entry.thinkingLevel).toBe('high')
    })

    it('proposes candidatesPerRound candidates and rolls every rejected one back to the opening snapshot', async () => {
      await prepareBenchmark()
      const reference: ScoreboardEntry = { version: 0, score: 60, cases: [] }
      const evaluateCase = vi.fn(async (_request: EvaluateCaseRequest) => ({ score: 50 }))
      const proposeCandidate = vi.fn(async (options: ProposeCandidateOptions) => candidate(options.candidateIndex))
      const applyCandidate = vi.fn(async (_options: ApplyCandidateOptions) => ({ agentStatePath: agentDir }))
      const restoreSnapshot = vi.fn(async (_options: { version: number; signal: AbortSignal }) => {})
      const engine = new BenchmarkEngineCore(
        options({ evaluateCase, proposeCandidate, applyCandidate, restoreSnapshot }),
      )

      const result = await engine.optimizeLoop(benchmarkId, {
        reference,
        candidatesPerRound: 3,
        signal: signal(),
      })

      expect(result.accepted).toBe(false)
      expect(result.bestScore).toBe(60)
      expect(result.entries).toHaveLength(3)
      expect(proposeCandidate).toHaveBeenCalledTimes(3)
      expect(applyCandidate).toHaveBeenCalledTimes(3)
      // Candidates 2 and 3 return to the opening state, and so does the round.
      expect(restoreSnapshot.mock.calls.map(call => call[0].version)).toEqual([1, 1, 1])
      expect(result.entries.map(entry => entry.rejected)).toEqual([true, true, true])
      expect(result.entries[0]!.summaryTitle).toBe('candidate 1')
      expect(result.entries[0]!.summary).toBe('change 1\n预测:scores shift 1')
      const persisted = await engine.readScoreboard(benchmarkId)
      expect(persisted.map(entry => entry.rejected)).toEqual([true, true, true])
    })

    it('accepts the highest scoring candidate and restores that candidate snapshot', async () => {
      await prepareBenchmark()
      const reference: ScoreboardEntry = { version: 0, score: 60, cases: [] }
      const scores = [70, 90, 80]
      const evaluateCase = vi.fn(async (_request: EvaluateCaseRequest) => ({ score: scores.shift() ?? 0 }))
      const proposeCandidate = vi.fn(async (options: ProposeCandidateOptions) => candidate(options.candidateIndex))
      const restoreSnapshot = vi.fn(async (_options: { version: number; signal: AbortSignal }) => {})
      const engine = new BenchmarkEngineCore(options({ evaluateCase, proposeCandidate, restoreSnapshot }))

      const result = await engine.optimizeLoop(benchmarkId, {
        reference,
        candidatesPerRound: 3,
        signal: signal(),
      })

      expect(result.accepted).toBe(true)
      // The opening state is v1; the three candidates are v2, v3, v4.
      expect(result.acceptedVersion).toBe(3)
      expect(result.bestScore).toBe(90)
      expect(restoreSnapshot.mock.calls.map(call => call[0].version)).toEqual([1, 1, 3])
      expect(result.entries.map(entry => entry.rejected)).toEqual([true, undefined, true])
      const persisted = await engine.readScoreboard(benchmarkId)
      expect(persisted.map(entry => entry.rejected)).toEqual([true, undefined, true])
      expect(persisted[1]!.version).toBe(3)
    })

    it('stops proposing once a candidate reaches the target score', async () => {
      await prepareBenchmark()
      const reference: ScoreboardEntry = { version: 0, score: 60, cases: [] }
      const scores = [70, 90]
      const evaluateCase = vi.fn(async (_request: EvaluateCaseRequest) => ({ score: scores.shift() ?? 0 }))
      const proposeCandidate = vi.fn(async (options: ProposeCandidateOptions) => candidate(options.candidateIndex))
      const engine = new BenchmarkEngineCore(options({ evaluateCase, proposeCandidate }))

      const result = await engine.optimizeLoop(benchmarkId, {
        reference,
        targetScore: 90,
        candidatesPerRound: 3,
        signal: signal(),
      })

      expect(proposeCandidate).toHaveBeenCalledTimes(2)
      expect(result.entries).toHaveLength(2)
      expect(result.acceptedVersion).toBe(3)
      expect(result.bestScore).toBe(90)
      expect(result.rounds).toBe(1)
    })

    it('restores the opening snapshot and persists nothing when a later candidate throws', async () => {
      await prepareBenchmark()
      const reference: ScoreboardEntry = { version: 0, score: 60, cases: [] }
      let evaluations = 0
      const evaluateCase = vi.fn(async (_request: EvaluateCaseRequest) => {
        evaluations += 1
        if (evaluations === 2) throw new Error('second candidate exploded')
        return { score: 50 }
      })
      const proposeCandidate = vi.fn(async (options: ProposeCandidateOptions) => candidate(options.candidateIndex))
      const restoreSnapshot = vi.fn(async (_options: { version: number; signal: AbortSignal }) => {})
      const engine = new BenchmarkEngineCore(options({ evaluateCase, proposeCandidate, restoreSnapshot }))

      await expect(engine.optimizeLoop(benchmarkId, { reference, candidatesPerRound: 2, signal: signal() }))
        .rejects.toThrow('second candidate exploded')

      // Candidate 2's own return to the opening state, then the round's rollback.
      expect(restoreSnapshot.mock.calls.map(call => call[0].version)).toEqual([1, 1])
      await expect(engine.readScoreboard(benchmarkId)).resolves.toEqual([])
    })

    it('persists no entry when the commit restore fails', async () => {
      await prepareBenchmark()
      const reference: ScoreboardEntry = { version: 0, score: 60, cases: [] }
      const restoreSnapshot = vi.fn(async (call: { version: number; signal: AbortSignal }) => {
        if (call.version === 2) throw new Error('commit restore failed')
      })
      const evaluateCase = vi.fn(async (_request: EvaluateCaseRequest) => ({ score: 80 }))
      const engine = new BenchmarkEngineCore(options({ evaluateCase, restoreSnapshot }))

      await expect(engine.optimizeLoop(benchmarkId, { reference, signal: signal() }))
        .rejects.toThrow('commit restore failed')

      // The round opened at v1 and the candidate minted v2; the catch rolls back
      // to v1. Nothing was appended, so no entry names the failed commit.
      expect(restoreSnapshot.mock.calls.map(call => call[0].version)).toEqual([2, 1])
      await expect(engine.readScoreboard(benchmarkId)).resolves.toEqual([])
    })

    it('feeds earlier attempts to later candidates within and across rounds', async () => {
      await prepareBenchmark()
      const reference: ScoreboardEntry = { version: 0, score: 60, cases: [] }
      const evaluateCase = vi.fn(async (_request: EvaluateCaseRequest) => ({ score: 50 }))
      const proposeCandidate = vi.fn(async (options: ProposeCandidateOptions) => candidate(options.candidateIndex))
      const engine = new BenchmarkEngineCore(options({ evaluateCase, proposeCandidate }))

      await engine.optimizeLoop(benchmarkId, {
        reference,
        maxRounds: 2,
        candidatesPerRound: 2,
        signal: signal(),
      })

      const histories = proposeCandidate.mock.calls.map(call => call[0].history)
      expect(histories.map(history => history.length)).toEqual([0, 1, 2, 3])
      expect(histories[3]![0]).toMatchObject({
        round: 1,
        candidateIndex: 1,
        name: 'candidate 1',
        description: 'change 1',
        prediction: 'scores shift 1',
        score: 50,
        referenceScore: 60,
      })
      expect(histories[3]![0]!.cases).toHaveLength(1)
      expect(histories[3]![2]).toMatchObject({ round: 2, candidateIndex: 1 })
      const numbering = proposeCandidate.mock.calls.map(call => [call[0].candidateIndex, call[0].candidateCount])
      expect(numbering).toEqual([[1, 2], [2, 2], [1, 2], [2, 2]])
    })

    it('skips rejected entries when resolving the default reference', async () => {
      await prepareBenchmark()
      await appendScoreboard(dir, benchmarkId, { version: 0, score: 60, cases: [] })
      await appendScoreboard(dir, benchmarkId, { version: 1, score: 30, cases: [], rejected: true })
      const proposeCandidate = vi.fn(async (_options: ProposeCandidateOptions) => candidate())
      const engine = new BenchmarkEngineCore(options({ proposeCandidate }))

      const result = await engine.optimizeLoop(benchmarkId, { signal: signal() })

      expect(result.referenceScore).toBe(60)
      expect(proposeCandidate.mock.calls[0]![0].reference.score).toBe(60)
    })

    it('fails loud when every scoreboard entry was rejected', async () => {
      await prepareBenchmark()
      await appendScoreboard(dir, benchmarkId, { version: 1, score: 30, cases: [], rejected: true })
      const engine = new BenchmarkEngineCore(options())

      await expect(engine.optimizeLoop(benchmarkId, { signal: signal() }))
        .rejects.toThrow(/no kept scoreboard entry/)
    })

    it('rejects a non-integer or sub-one candidatesPerRound before touching the agent state', async () => {
      await prepareBenchmark()
      const reference: ScoreboardEntry = { version: 0, score: 60, cases: [] }
      const proposeCandidate = vi.fn(async (_options: ProposeCandidateOptions) => candidate())
      const restoreSnapshot = vi.fn(async (_options: { version: number; signal: AbortSignal }) => {})
      const engine = new BenchmarkEngineCore(options({ proposeCandidate, restoreSnapshot }))

      for (const candidatesPerRound of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(engine.optimizeLoop(benchmarkId, { reference, candidatesPerRound, signal: signal() }))
          .rejects.toThrow(/candidatesPerRound must be an integer >= 1/)
      }

      expect(proposeCandidate).not.toHaveBeenCalled()
      expect(restoreSnapshot).not.toHaveBeenCalled()
    })
  })
})
