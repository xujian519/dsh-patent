/**
 * Vocabulary for the benchmark-driven self-evolve provider.
 *
 * The provider adds a quantitative target to the harness self-evolve capability:
 * a benchmark is a bounded set of cases, each with a public `statement` (the
 * only input a target or optimizing agent ever sees) and a private `rubric`
 * (the scoring standard, physically separated and excluded from optimizer
 * context). Scoring is output-level: each case run first executes the task to
 * produce a deliverable (`executeCase`), then the evaluator scores that
 * deliverable against the rubric. Scores persist to a versioned
 * `scoreboard.yaml`; whole-state snapshots enable strict improve-or-rollback
 * across candidate rounds.
 *
 * @module @deepseek-ai/dsh-self-evolve-benchmark/types
 */

import type { BenchmarkId, CaseId } from './brand.ts'

export type { BenchmarkId, CaseId } from './brand.ts'

/** One benchmark case: `statement` is public, `rubric` is private. */
export interface CaseSpec {
  /** Stable case identifier; also the directory name under the benchmark. */
  caseId: CaseId
  /** Task text handed to the evaluated or optimizing agent — the only public input. */
  statement: string
  /** Private scoring standard consumed only by the evaluator, never the optimizer. */
  rubric?: string
}

/** A loaded benchmark: a title plus its case set, ready for evaluation. */
export interface BoundBenchmark {
  /** Benchmark identifier, matching the on-disk directory. */
  id: BenchmarkId
  /** Human-readable title persisted in `benchmark_config.yaml`. */
  title: string
  /** Cases in stable order. */
  cases: CaseSpec[]
}

/** One scored run of a single case. */
export interface CaseRunRecord {
  /** Evaluator score, 0–100. */
  score: number
  /** Provider-reported cost in the run; absent when not reported. */
  cost?: number
  /** Wall-clock duration of the run; absent when not reported. */
  durationMs?: number
  /** Durable session/trace id linking the run back to an evaluator transcript. */
  sessionId?: string
  /** Evaluator note; model-visible, never carries private rubric content. */
  note?: string
}

/** Aggregated result for one case across its runs. */
export interface CaseAggregate {
  /** Case identifier. */
  caseId: CaseId
  /** Mean run score, rounded to two decimals. */
  score: number
  /** Mean run cost, rounded to six decimals; absent when no run reported cost. */
  cost?: number
  /** Mean run duration, integer milliseconds; absent when no run reported one. */
  durationMs?: number
  /** The raw runs this aggregate is derived from. */
  runs: CaseRunRecord[]
}

/** One persisted scoreboard entry; scores never regress across accepted entries. */
export interface ScoreboardEntry {
  /** Agent-state snapshot version this entry was evaluated under. */
  version: number
  /**
   * Whether the round that produced this entry rolled its candidate back;
   * absent when the entry was kept. A rejected entry's state is not on disk, so
   * the default optimize reference resolves to the latest entry without this
   * mark.
   */
  rejected?: boolean
  /** Evaluation runtime provider route; absent when not reported. */
  provider?: string
  /** Evaluation model id; absent when not reported. */
  modelId?: string
  /** Evaluation thinking level; absent when not reported. */
  thinkingLevel?: string
  /** Mean score across all cases and runs, 0–100, two decimals. */
  score: number
  /** Mean cost across all runs, six decimals; absent when no run reported cost. */
  cost?: number
  /** Mean duration across all runs, integer ms; absent when no run reported one. */
  durationMs?: number
  /** Durable session/trace id linking the entry to an evaluation run. */
  sessionId?: string
  /** Per-case aggregates, in benchmark case order. */
  cases: CaseAggregate[]
  /** One-line conclusion for this entry, set to the candidate name by an optimize round; model-facing. */
  summaryTitle?: string
  /** Longer summary of the candidate change plus its falsifiable prediction; model-facing. */
  summary?: string
}

/** Execution request handed to the injected {@link ExecuteCase}. */
export interface ExecuteCaseRequest {
  /** The case being executed. */
  caseId: CaseId
  /** Public task text — the only benchmark content the executing agent sees. */
  statement: string
  /** Agent-state directory whose guidance the executor consults before producing. */
  agentStatePath: string
  /** Parent session id for the live-agent fallback of the default executor. */
  sessionId?: string
  /** Cancellation signal from the calling context. */
  signal: AbortSignal
}

/** One execution outcome for a case run: the deliverable plus optional run metadata. */
export interface ExecuteCaseResult {
  /** Deliverable text the executor produced under the agent state's guidance. */
  output: string
  /** Provider-reported cost for the run; absent when not reported. */
  cost?: number
  /** Wall-clock duration of the run; absent when not reported. */
  durationMs?: number
  /** Durable session/trace id; absent when the executor has none. */
  sessionId?: string
}

/** The execution seam the engine core depends on; injectable for tests. */
export type ExecuteCase = (request: ExecuteCaseRequest) => Promise<ExecuteCaseResult>

/** Evaluation request handed to the injected {@link EvaluateCase}. */
export interface EvaluateCaseRequest {
  /** The case being scored. */
  caseId: CaseId
  /** Public task text — the only benchmark content the target agent sees. */
  statement: string
  /** Private scoring standard for the evaluator; must never reach optimizer context. */
  rubric?: string
  /** Agent-state directory the candidate currently lives in; retained for traceability. */
  agentStatePath: string
  /** The deliverable scored this run; output-level scoring always evaluates a deliverable. */
  attempt: ExecuteCaseResult
  /** Parent session id for the live-agent fallback of the default evaluator. */
  sessionId?: string
  /** Cancellation signal from the calling context. */
  signal: AbortSignal
}

/** One evaluation outcome for a case run. */
export interface EvaluateCaseResult {
  /** Evaluator score, 0–100. */
  score: number
  /** Provider-reported cost for the run; absent when not reported. */
  cost?: number
  /** Wall-clock duration of the run; absent when not reported. */
  durationMs?: number
  /** Durable session/trace id; absent when the evaluator has none. */
  sessionId?: string
  /** Evaluator note; must never carry private rubric content. */
  note?: string
}

/** The evaluation seam the engine core depends on; injectable for tests. */
export type EvaluateCase = (request: EvaluateCaseRequest) => Promise<EvaluateCaseResult>

/** A candidate proposed against the current reference score. */
export interface CandidateProposal {
  /** Short human-readable candidate name. */
  name: string
  /** What the candidate changes about the agent state. */
  description: string
  /** Falsifiable prediction of which case behaviors will change. */
  prediction: string
}

/**
 * One candidate already evaluated in the current optimize loop, projected for
 * the optimizer: the proposal, what it scored, and the per-case detail behind
 * that score. The projection deliberately carries no cost, provider, or
 * session metadata — those say nothing about why the candidate scored as it did.
 */
export interface CandidateAttempt {
  /** 1-based round the candidate was proposed in. */
  round: number
  /** 1-based position of the candidate within its round. */
  candidateIndex: number
  /** The candidate's name. */
  name: string
  /** What the candidate changed about the agent state. */
  description: string
  /** The candidate's falsifiable prediction. */
  prediction: string
  /** Aggregate score the candidate reached. */
  score: number
  /** Reference score the candidate was measured against, so a reader can verify the comparison. */
  referenceScore: number
  /** Per-case aggregates behind `score`, in benchmark case order. */
  cases: CaseAggregate[]
}

/** Optimizer seam: propose one candidate against a reference entry. */
export type ProposeCandidate = (options: ProposeCandidateOptions) => Promise<CandidateProposal>

/** Options handed to {@link ProposeCandidate}. */
export interface ProposeCandidateOptions {
  /** Benchmark being optimized. */
  benchmarkId: BenchmarkId
  /** The reference entry this round must strictly beat. */
  reference: ScoreboardEntry
  /**
   * Public statement text of all cases joined in case order, each preceded by
   * its `[caseId]` label so optimizer feedback can name the case a score belongs
   * to; never contains rubric content.
   */
  statement: string
  /** 1-based round index within the current optimize loop. */
  round: number
  /** 1-based position of this candidate within the round. */
  candidateIndex: number
  /** How many candidates this round proposes in total. */
  candidateCount: number
  /**
   * Candidates this loop already evaluated, oldest first, kept or rejected.
   * The reference's per-case scores and evaluator notes are on `reference`;
   * this list adds what earlier attempts changed and how
   * they scored, so the optimizer does not repeat a direction already measured.
   * Empty for the first candidate of the first round.
   */
  history: readonly CandidateAttempt[]
  /** Parent session id for the live-agent fallback of the default optimizer. */
  sessionId?: string
  /** Cancellation signal. */
  signal: AbortSignal
}

/** Apply seam: materialize a candidate into the agent state directory. */
export type ApplyCandidate = (options: ApplyCandidateOptions) => Promise<{ agentStatePath: string }>

/** Options handed to {@link ApplyCandidate}. */
export interface ApplyCandidateOptions {
  /** Benchmark being optimized. */
  benchmarkId: BenchmarkId
  /** The candidate to apply. */
  candidate: CandidateProposal
  /** Agent-state directory the candidate's files are written into. */
  agentStateDir: string
  /** Parent session id for the live-agent fallback of the default applier. */
  sessionId?: string
  /** Cancellation signal. */
  signal: AbortSignal
}

/** Rollback seam: restore the agent state directory to a snapshot version. */
export type RestoreSnapshot = (options: { version: number; signal: AbortSignal }) => Promise<void>

/** Engine core wiring; all seams are injected so tests run deterministically. */
export interface BenchmarkEngineOptions {
  /** Root directory for benchmark data and snapshots. */
  baseDir: string
  /** Agent-state directory snapshotted before each round and rolled back on rejection. */
  agentStateDir: string
  /** Produces the deliverable for one case run; the evaluator scores it output-level. */
  executeCase: ExecuteCase
  /** Scores one case run's deliverable. */
  evaluateCase: EvaluateCase
  /** Proposes one candidate against the reference. */
  proposeCandidate: ProposeCandidate
  /** Materializes a candidate into the agent state directory. */
  applyCandidate: ApplyCandidate
  /** Restores the agent state directory to a snapshot version. */
  restoreSnapshot: RestoreSnapshot
}

/** Options for {@link BenchmarkEngineCore.runBenchmark} and `establishBaseline`. */
export interface RunBenchmarkOptions {
  /** Agent-state snapshot version this entry is evaluated under; defaults to 0. */
  version?: number
  /** Runs per case; defaults to 1. */
  runsPerCase?: number
  /** Evaluation runtime provider route recorded on the entry. */
  provider?: string
  /** Evaluation model id recorded on the entry. */
  modelId?: string
  /** Evaluation thinking level recorded on the entry. */
  thinkingLevel?: string
  /** Parent session id passed through to each evaluator. */
  sessionId?: string
  /** Cancellation signal. */
  signal: AbortSignal
}

/** Options for {@link BenchmarkEngineCore.optimizeLoop}. */
export interface OptimizeLoopOptions {
  /** Reference entry to beat; defaults to the latest scoreboard entry. */
  reference?: ScoreboardEntry
  /** Optional score goal; reaching it accepts the round early. */
  targetScore?: number
  /** Maximum candidate rounds; defaults to 1. */
  maxRounds?: number
  /**
   * Runs per case for candidate evaluations; defaults to 1.
   *
   * One run measures evaluator noise as much as the candidate: identical
   * repeated evaluations of one case varied by several points. Use at least 3
   * runs and compare means when deciding whether a candidate helped, and
   * evaluate the reference under the same `runsPerCase`.
   */
  runsPerCase?: number
  /**
   * Minimum aggregate gain over the reference required to accept a round;
   * defaults to 0, which admits any strict gain. Set it above the measured
   * single-run noise so a round is not accepted on a difference the evaluator
   * could reproduce from an unchanged state.
   */
  minImprovement?: number
  /**
   * Candidates proposed per round; defaults to 1. Each candidate is evaluated
   * from the round's opening state and the highest scoring qualified one is
   * accepted, so a larger count spends proportionally more requests. Picking
   * the maximum of several noisy scores inflates the accepted score when
   * `runsPerCase` is 1 — raise `runsPerCase` before raising this.
   */
  candidatesPerRound?: number
  /** Evaluation runtime provider route recorded on candidate entries. */
  provider?: string
  /** Evaluation model id recorded on candidate entries. */
  modelId?: string
  /** Evaluation thinking level recorded on candidate entries. */
  thinkingLevel?: string
  /** Parent session id passed through to each evaluator. */
  sessionId?: string
  /** Cancellation signal. */
  signal: AbortSignal
}

/** Outcome of one optimize loop over a benchmark. */
export interface OptimizeResult {
  /** Benchmark identifier. */
  benchmarkId: BenchmarkId
  /** The reference score the loop started from. */
  referenceScore: number
  /** The best score the loop settled on (the reference after all rounds). */
  bestScore: number
  /** Number of candidate rounds actually executed. */
  rounds: number
  /** Whether at least one candidate strictly beat the reference. */
  accepted: boolean
  /** Snapshot version of the last accepted candidate; absent when nothing was accepted. */
  acceptedVersion?: number
  /**
   * Every candidate entry this loop produced, in evaluation order, with the
   * `rejected` mark already applied. A round that threw contributes nothing
   * here: its entries are neither persisted nor returned.
   */
  entries: ScoreboardEntry[]
}

/** Public configuration for the benchmark-driven provider. */
export interface BenchmarkEvolveConfig {
  /** Benchmark/snapshot data root; defaults to `~/.dsh/self-evolve-benchmark`. */
  baseDir?: string
  /**
   * Agent-state directory to snapshot and roll back. Required: a rejected
   * round wipes and restores this directory, so it must be an absolute path
   * that is not the data root, the cwd, home, or the filesystem root, and a
   * non-empty directory must carry the `.self-evolve-benchmark` marker. The
   * provider validates all of this at construction and refuses an unsafe
   * directory rather than falling back to `process.cwd()`.
   */
  agentStateDir: string
  /** Runs per case when a method does not specify one; defaults to 1. */
  runsPerCase?: number
  /** Default maximum candidate rounds per optimize loop; defaults to 1. */
  maxRoundsPerLoop?: number
  /** Default score goal for optimize loops; absent disables early acceptance. */
  targetScore?: number
  /**
   * Default minimum aggregate gain for accepting an optimize round; defaults
   * to 0, which admits any strict gain. Construction rejects a negative or
   * non-finite value rather than accepting it as a regression-tolerant
   * threshold.
   */
  minImprovement?: number
  /**
   * Default candidates proposed per optimize round; defaults to 1. Construction
   * rejects a value that is not an integer >= 1 rather than proposing nothing
   * or a fraction of a candidate.
   */
  candidatesPerRound?: number
}
