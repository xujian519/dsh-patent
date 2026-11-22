/**
 * Benchmark-driven target evolution core (C1 + C6).
 *
 * The core runs full-matrix evaluations, establishes a reference score, and
 * optimizes a benchmark under a strict improve-or-rollback policy backed by
 * whole-state snapshot versioning. Scoring is output-level: each case run first
 * executes the task through the `executeCase` seam to produce a deliverable,
 * then the `evaluateCase` seam scores that deliverable against the rubric.
 * Execution, evaluation, proposal, apply, and rollback are injected seams, so
 * every decision branch is unit-testable without a model or subagent runtime;
 * the service wiring in `index.ts` provides real seams over `ctx.subagents`.
 *
 * @module @deepseek-ai/dsh-self-evolve-benchmark/engine
 */

import { assertNoPrivateLeak, publicBenchmarkView } from './contamination.ts'
import type { BenchmarkId } from './brand.ts'
import { aggregateRuns, appendScoreboard, mean, readScoreboard, roundCost, roundScore } from './scoreboard.ts'
import { createNextSnapshot } from './snapshot.ts'
import { loadBenchmark } from './store.ts'
import type {
  BenchmarkEngineOptions,
  CandidateAttempt,
  CandidateProposal,
  CaseAggregate,
  CaseRunRecord,
  EvaluateCaseRequest,
  ExecuteCaseRequest,
  OptimizeLoopOptions,
  OptimizeResult,
  RunBenchmarkOptions,
  ScoreboardEntry,
} from './types.ts'

/** Sum present numbers; undefined when every value is absent. */
function sumWhenPresent(...values: Array<number | undefined>): number | undefined {
  if (values.every(value => value === undefined)) return undefined
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
}

/**
 * Assert an evaluator's score is a usable 0–100 number.
 *
 * A seam that reports `NaN`, `Infinity`, a negative number, or a value above
 * 100 would otherwise be averaged into the scoreboard as-is: `NaN` makes every
 * later mean `NaN`, and an out-of-range value silently breaks the 0–100 range
 * every consumer assumes. Clamping is the wrong remedy — it hides a broken
 * evaluator behind a plausible score.
 *
 * @param score The evaluator's reported score.
 * @param caseId The case being scored, for the diagnostic.
 * @throws when the score is not a finite number in 0–100.
 */
function assertScored(score: number, caseId: string): void {
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new Error(`self-evolve-benchmark: evaluator returned an invalid score for case "${caseId}": ${String(score)} (expected a finite number in 0–100)`)
  }
}

/**
 * Assert an acceptance threshold is a usable minimum gain.
 *
 * A negative threshold would accept a round that lowered the score, and a
 * `NaN` one would silently reject every round; both break improve-or-rollback
 * without any visible failure.
 *
 * @param minImprovement The configured or per-call minimum gain.
 * @throws when the value is not a finite number >= 0.
 */
export function assertMinImprovement(minImprovement: number): void {
  if (!Number.isFinite(minImprovement) || minImprovement < 0) {
    throw new Error(
      `self-evolve-benchmark: minImprovement must be a finite number >= 0, got ${String(minImprovement)}`,
    )
  }
}

/**
 * Assert a per-round candidate count is a usable integer.
 *
 * Zero would evaluate no candidate and roll every round back, and a fractional
 * or non-integer value either throws partway through the loop or never
 * terminates. Rejecting it before the first snapshot keeps the agent state
 * untouched.
 *
 * @param candidatesPerRound The configured or per-call candidate count.
 * @throws when the value is not an integer >= 1.
 */
export function assertCandidatesPerRound(candidatesPerRound: number): void {
  if (!Number.isInteger(candidatesPerRound) || candidatesPerRound < 1) {
    throw new Error(
      `self-evolve-benchmark: candidatesPerRound must be an integer >= 1, got ${String(candidatesPerRound)}`,
    )
  }
}

/**
 * The entry an optimize round must beat when the caller passes none: the
 * latest scoreboard entry that was not rolled back.
 *
 * A rejected entry describes a state that is not on disk — the round restored
 * its opening snapshot — so using it as the reference would measure the next
 * candidate against a score the disk never holds.
 *
 * @param entries Persisted entries, oldest first.
 * @returns The latest kept entry, or `undefined` when every entry was rejected.
 */
function latestKeptEntry(entries: readonly ScoreboardEntry[]): ScoreboardEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]
    if (entry !== undefined && entry.rejected !== true) return entry
  }
  return undefined
}

/** Pure orchestration core over injected evaluation and optimization seams. */
export class BenchmarkEngineCore {
  constructor(private readonly options: BenchmarkEngineOptions) {}

  /**
   * Read all persisted scoreboard entries for a benchmark.
   *
   * @param benchmarkId Benchmark id.
   * @returns Persisted entries, oldest first.
   */
  readScoreboard(benchmarkId: BenchmarkId): Promise<ScoreboardEntry[]> {
    return readScoreboard(this.options.baseDir, benchmarkId)
  }

  /**
   * Run the full benchmark — every case, `runsPerCase` runs each — against the
   * current agent state and persist the aggregated entry to the scoreboard.
   *
   * @param benchmarkId Benchmark id.
   * @param options Evaluation options.
   * @returns The aggregated scoreboard entry.
   */
  async runBenchmark(benchmarkId: BenchmarkId, options: RunBenchmarkOptions): Promise<ScoreboardEntry> {
    const cases = await this.evaluateCases(benchmarkId, {
      agentStatePath: this.options.agentStateDir,
      signal: options.signal,
      ...(options.runsPerCase !== undefined ? { runsPerCase: options.runsPerCase } : {}),
      ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
    })
    const entry = this.entryFromCases(cases, options)
    await appendScoreboard(this.options.baseDir, benchmarkId, entry)
    return entry
  }

  /**
   * Establish a single-run baseline score for a benchmark — the reference an
   * optimize loop must strictly beat. Equivalent to `runBenchmark`.
   *
   * @param benchmarkId Benchmark id.
   * @param options Evaluation options.
   * @returns The baseline scoreboard entry.
   */
  establishBaseline(benchmarkId: BenchmarkId, options: RunBenchmarkOptions): Promise<ScoreboardEntry> {
    return this.runBenchmark(benchmarkId, options)
  }

  /**
   * Optimize a benchmark under strict improve-or-rollback.
   *
   * Each round mints a snapshot of the opening agent state, then proposes
   * `candidatesPerRound` candidates (default 1) against the reference using
   * only the public statement surface. Every candidate starts again from that
   * opening state, and each applied candidate is snapshotted under its own
   * version before it is evaluated, so `ScoreboardEntry.version` names the
   * state that produced the score. The highest scoring candidate whose gain
   * reaches `minImprovement` (default 0, any strict gain) is accepted and
   * restored; the rest are rolled back to the opening snapshot and persisted
   * with `rejected: true`. A configured `targetScore` stops proposing further
   * candidates once a score reaches it, but never displaces a higher scoring
   * candidate already evaluated in the round, and stops the loop when the
   * accepted round reached it.
   *
   * @param benchmarkId Benchmark id.
   * @param options Optimization options.
   * @returns The loop outcome, including every evaluated entry.
   */
  async optimizeLoop(benchmarkId: BenchmarkId, options: OptimizeLoopOptions): Promise<OptimizeResult> {
    const maxRounds = options.maxRounds ?? 1
    const minImprovement = options.minImprovement ?? 0
    const candidatesPerRound = options.candidatesPerRound ?? 1
    assertMinImprovement(minImprovement)
    assertCandidatesPerRound(candidatesPerRound)
    let reference = options.reference
    let rejectedOnly = false
    if (reference === undefined) {
      const persisted = await readScoreboard(this.options.baseDir, benchmarkId)
      reference = latestKeptEntry(persisted)
      rejectedOnly = persisted.length > 0
    }
    if (reference === undefined) {
      throw new Error(
        rejectedOnly
          ? `optimizeLoop: benchmark "${benchmarkId}" has no kept scoreboard entry — every entry was rejected by its round, so pass the reference explicitly`
          : `optimizeLoop: benchmark "${benchmarkId}" has no reference entry — run establishBaseline first`,
      )
    }
    const benchmark = await loadBenchmark(this.options.baseDir, benchmarkId)
    const publicView = publicBenchmarkView(benchmark)
    assertNoPrivateLeak(publicView, `optimizer-context:${benchmarkId}`)
    const statement = publicView.cases.map(spec => `[${spec.caseId}]\n${spec.statement}`).join('\n\n---\n\n')

    let current = reference
    let accepted = false
    let acceptedVersion: number | undefined
    let rounds = 0
    const entries: ScoreboardEntry[] = []
    // Every attempt this loop evaluated, so a later round does not repeat a
    // direction an earlier round already measured.
    const history: CandidateAttempt[] = []

    for (let round = 1; round <= maxRounds; round++) {
      if (options.signal.aborted) break
      rounds = round
      const base = await createNextSnapshot(this.options.baseDir, this.options.agentStateDir)
      const roundEntries: ScoreboardEntry[] = []
      let winner: { entry: ScoreboardEntry; version: number } | undefined
      try {
        for (let candidateIndex = 1; candidateIndex <= candidatesPerRound; candidateIndex++) {
          // The opening snapshot already holds this state; later candidates
          // must discard whatever the previous candidate and its evaluation left.
          if (candidateIndex > 1) {
            await this.options.restoreSnapshot({ version: base.version, signal: options.signal })
          }
          const candidate: CandidateProposal = await this.options.proposeCandidate({
            benchmarkId,
            reference: current,
            statement,
            round,
            candidateIndex,
            candidateCount: candidatesPerRound,
            history: [...history],
            signal: options.signal,
            ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
          })
          const applied = await this.options.applyCandidate({
            benchmarkId,
            candidate,
            agentStateDir: this.options.agentStateDir,
            signal: options.signal,
            ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
          })
          const minted = await createNextSnapshot(this.options.baseDir, this.options.agentStateDir)
          const entry = await this.evaluateCandidate(benchmarkId, {
            agentStatePath: applied.agentStatePath,
            version: minted.version,
            signal: options.signal,
            ...(options.runsPerCase !== undefined ? { runsPerCase: options.runsPerCase } : {}),
            ...(options.provider !== undefined ? { provider: options.provider } : {}),
            ...(options.modelId !== undefined ? { modelId: options.modelId } : {}),
            ...(options.thinkingLevel !== undefined ? { thinkingLevel: options.thinkingLevel } : {}),
            ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
          })
          entry.summaryTitle = candidate.name
          entry.summary = `${candidate.description}\n预测:${candidate.prediction}`
          const attempt: CandidateAttempt = {
            round,
            candidateIndex,
            name: candidate.name,
            description: candidate.description,
            prediction: candidate.prediction,
            score: entry.score,
            referenceScore: current.score,
            cases: entry.cases,
          }
          assertNoPrivateLeak(attempt, `optimizer-history:${benchmarkId}`)
          history.push(attempt)
          roundEntries.push(entry)
          const gain = entry.score - current.score
          if (gain > 0 && gain >= minImprovement && (winner === undefined || entry.score > winner.entry.score)) {
            winner = { entry, version: minted.version }
          }
          if (options.targetScore !== undefined && entry.score >= options.targetScore) break
        }

        // Commit the round's state before recording it, so no persisted entry
        // ever names a state the directory does not hold.
        if (winner === undefined) {
          await this.options.restoreSnapshot({ version: base.version, signal: options.signal })
        } else {
          // Even when the winner was the last candidate evaluated, the restore
          // discards anything its evaluation left behind: the directory must
          // match the archive the entry's version names.
          await this.options.restoreSnapshot({ version: winner.version, signal: options.signal })
          current = winner.entry
          accepted = true
          acceptedVersion = winner.version
        }
      } catch (error) {
        await this.rollbackFailedRound(base.version, error, round)
      }

      // Record only after the round's state is committed, so no persisted entry
      // names a state the directory does not hold. Appending in evaluation order
      // keeps readers monotonic even when a later append fails: the entries they
      // can see are a true prefix of the round. The round is not atomic — a
      // failing append leaves the committed state ahead of the ledger, which a
      // re-run of `runBenchmark` reconciles.
      for (const entry of roundEntries) {
        if (entry !== winner?.entry) entry.rejected = true
        await appendScoreboard(this.options.baseDir, benchmarkId, entry)
      }
      entries.push(...roundEntries)
      if (winner !== undefined && options.targetScore !== undefined && winner.entry.score >= options.targetScore) {
        break
      }
    }

    const result: OptimizeResult = {
      benchmarkId,
      referenceScore: reference.score,
      bestScore: current.score,
      rounds,
      accepted,
      entries,
    }
    if (acceptedVersion !== undefined) result.acceptedVersion = acceptedVersion
    return result
  }

  /**
   * Roll a failed round back to its opening snapshot, then rethrow its error.
   *
   * A round that dies mid-way leaves a half-applied candidate behind, so the
   * agent state never keeps a change that was not measured. The caller's signal
   * may already be aborted, so the restore runs on its own.
   *
   * @param baseVersion The round's opening snapshot version.
   * @param error The error that ended the round.
   * @param round The 1-based round index, for the diagnostic.
   * @throws always: the original error, or an `AggregateError` holding it when the restore also fails.
   */
  private async rollbackFailedRound(baseVersion: number, error: unknown, round: number): Promise<never> {
    try {
      await this.options.restoreSnapshot({ version: baseVersion, signal: new AbortController().signal })
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `self-evolve-benchmark: round ${round} failed and the snapshot restore also failed`,
      )
    }
    throw error
  }

  /** Execute then score every case of a benchmark `runsPerCase` times under one agent state. */
  private async evaluateCases(
    benchmarkId: BenchmarkId,
    opts: {
      agentStatePath: string
      runsPerCase?: number
      sessionId?: string
      signal: AbortSignal
    },
  ): Promise<CaseAggregate[]> {
    const benchmark = await loadBenchmark(this.options.baseDir, benchmarkId)
    const runsPerCase = opts.runsPerCase ?? 1
    const cases: CaseAggregate[] = []
    for (const spec of benchmark.cases) {
      const runs: CaseRunRecord[] = []
      for (let run = 0; run < runsPerCase; run++) {
        const executeRequest: ExecuteCaseRequest = {
          caseId: spec.caseId,
          statement: spec.statement,
          agentStatePath: opts.agentStatePath,
          signal: opts.signal,
        }
        if (opts.sessionId !== undefined) executeRequest.sessionId = opts.sessionId
        const attempt = await this.options.executeCase(executeRequest)

        const request: EvaluateCaseRequest = {
          caseId: spec.caseId,
          statement: spec.statement,
          agentStatePath: opts.agentStatePath,
          signal: opts.signal,
          attempt,
        }
        if (spec.rubric !== undefined) request.rubric = spec.rubric
        if (opts.sessionId !== undefined) request.sessionId = opts.sessionId
        const result = await this.options.evaluateCase(request)
        assertScored(result.score, spec.caseId)

        const record: CaseRunRecord = { score: result.score }
        const cost = sumWhenPresent(attempt.cost, result.cost)
        const duration = sumWhenPresent(attempt.durationMs, result.durationMs)
        if (cost !== undefined) record.cost = cost
        if (duration !== undefined) record.durationMs = duration
        if (result.sessionId !== undefined) record.sessionId = result.sessionId
        else if (attempt.sessionId !== undefined) record.sessionId = attempt.sessionId
        if (result.note !== undefined) record.note = result.note
        runs.push(record)
      }
      cases.push({ caseId: spec.caseId, ...aggregateRuns(runs), runs })
    }
    return cases
  }

  /** Aggregate and persist one candidate evaluation under a snapshot version. */
  private async evaluateCandidate(
    benchmarkId: BenchmarkId,
    opts: {
      agentStatePath: string
      version: number
      runsPerCase?: number
      provider?: string
      modelId?: string
      thinkingLevel?: string
      sessionId?: string
      signal: AbortSignal
    },
  ): Promise<ScoreboardEntry> {
    const cases = await this.evaluateCases(benchmarkId, opts)
    return this.entryFromCases(cases, opts)
  }

  /** Build a scoreboard entry from per-case aggregates using the scoreboard rounding rules. */
  private entryFromCases(cases: CaseAggregate[], fields: RunBenchmarkOptions): ScoreboardEntry {
    const allScores = cases.flatMap(spec => spec.runs.map(run => run.score))
    const allCosts = cases.flatMap(spec => spec.runs.flatMap(run => (run.cost === undefined ? [] : [run.cost])))
    const allDurations = cases.flatMap(spec =>
      spec.runs.flatMap(run => (run.durationMs === undefined ? [] : [run.durationMs])),
    )
    const entry: ScoreboardEntry = { version: fields.version ?? 0, score: roundScore(mean(allScores)), cases }
    if (fields.provider !== undefined) entry.provider = fields.provider
    if (fields.modelId !== undefined) entry.modelId = fields.modelId
    if (fields.thinkingLevel !== undefined) entry.thinkingLevel = fields.thinkingLevel
    if (fields.sessionId !== undefined) entry.sessionId = fields.sessionId
    if (allCosts.length > 0) entry.cost = roundCost(mean(allCosts))
    if (allDurations.length > 0) entry.durationMs = Math.round(mean(allDurations))
    return entry
  }
}
