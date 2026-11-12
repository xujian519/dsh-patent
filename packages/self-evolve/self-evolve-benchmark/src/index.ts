/**
 * Benchmark-driven self-evolve provider (`ctx.selfEvolveBenchmark`).
 *
 * A complementary capability seam to `ctx.selfEvolve`: the runtime provider
 * mines failure patterns from the session stream, while this provider chases a
 * quantitative benchmark target. It registers as its own service so both can
 * coexist; a single provider instance routes all benchmark work through the
 * injected evaluation/optimization seams, whose real defaults run over the
 * `fork` subagent provider.
 *
 * Scoring is output-level: each case run first forks an executor that produces
 * a deliverable under the agent state's guidance, then forks an evaluator that
 * scores that deliverable against the rubric. The default seams keep the
 * statement/rubric split: evaluator prompts receive the private rubric (an
 * evaluator is allowed to see it), while executor, optimizer, and applier
 * prompts receive only the public statement surface — never the rubric or any
 * expected answer.
 *
 * @module @deepseek-ai/dsh-self-evolve-benchmark
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentResult, SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { homedir } from 'node:os'
import { isAbsolute, parse as parsePath, resolve as resolvePath } from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import type { BenchmarkId } from './brand.ts'
import { BenchmarkEngineCore } from './engine.ts'
import { AGENT_STATE_MARKER, restoreSnapshot } from './snapshot.ts'
import type {
  ApplyCandidate,
  BenchmarkEvolveConfig,
  CandidateProposal,
  EvaluateCase,
  EvaluateCaseRequest,
  EvaluateCaseResult,
  ExecuteCase,
  ExecuteCaseRequest,
  ExecuteCaseResult,
  OptimizeLoopOptions,
  OptimizeResult,
  ProposeCandidate,
  ProposeCandidateOptions,
  RunBenchmarkOptions,
  ScoreboardEntry,
} from './types.ts'

/** Resolve the live parent agent for a fork seam from the session id. */
function resolveParent(ctx: Context, sessionId?: string): Agent | undefined {
  if (sessionId === undefined) return undefined
  return ctx.get('agents')?.get(SessionId(sessionId))
}

/**
 * The subagent runtime a default seam needs: the `fork` provider and a live
 * parent agent. Every default seam routes through this one check, so a missing
 * runtime fails loud with the same message whether evaluation, proposal, or
 * apply is first to need it.
 */
function requireForkRuntime(
  ctx: Context,
  sessionId: string | undefined,
  kind: 'execution' | 'evaluation' | 'optimization',
): { subagents: SubagentRuntime; parent: Agent } {
  const subagents = ctx.get('subagents')
  const parent = resolveParent(ctx, sessionId)
  if (subagents === undefined || parent === undefined || subagents.getProvider('fork') === undefined) {
    throw new Error(`self-evolve-benchmark: ${kind} needs the fork subagent provider and a live parent agent`)
  }
  return { subagents, parent }
}

/** One text content block for a subagent prompt. */
function textMessage(text: string): ContentBlock {
  return { type: 'text', text }
}

/** The evaluator's prompt: the private rubric is legitimate here, and only here. */
function evaluatorPrompt(request: EvaluateCaseRequest): string {
  const lines = [
    '你是基准评估者。请只依据评分标准,对下列交付物打分,而不是对配置或过程打分。',
    '任务(statement):',
    request.statement,
  ]
  if (request.rubric !== undefined) {
    lines.push('评分标准(rubric):', request.rubric)
  }
  lines.push('交付物(deliverable):', request.attempt.output)
  lines.push('只输出一个 JSON 对象,形如 {"score": 0 到 100 的数, "note": 一句话评语}。score 必须严格对照评分标准。')
  return lines.join('\n')
}

/** The executor's prompt: read the agent state's guidance and produce the deliverable. */
function executePrompt(request: ExecuteCaseRequest): string {
  return [
    '你是任务执行者。请依据目标 agent 状态目录中的作业规范,完成下列任务。',
    '任务(statement):',
    request.statement,
    '作业规范目录:', request.agentStatePath,
    '要求:先阅读目录中的指导文档(如 guidance.md),按其 checklist 完成交付物;这是执行任务而非计划,直接完成并只输出交付物正文,不要输出 JSON 包装、计划说明或解释性前缀。',
  ].join('\n')
}

/** The optimizer's prompt: public statements and the reference score only, never the rubric. */
function proposePrompt(options: ProposeCandidateOptions): string {
  return [
    '你是优化者。目标:针对下列基准提出一个候选改进,使分数严格提高。',
    `当前参考分数:${options.reference.score}`,
    '基准任务(statement,唯一允许依据的输入):',
    options.statement,
    '重要:优化上下文中绝不含评分标准;若你发现自己拿到了评分标准或标准答案,立即停止并报告污染。',
    '只输出一个 JSON 对象:{"name": 候选名, "description": 改动说明, "prediction": 可证伪的预测(哪些行为会变)}',
  ].join('\n')
}

/** The applier's prompt: materialize a candidate into the agent state directory. */
function applyPrompt(options: { candidate: CandidateProposal; agentStateDir: string }): string {
  return [
    '你是实现者。请将下列候选改进应用到目标 agent 状态目录,完成必要的编辑。',
    `候选:${options.candidate.name}`,
    `说明:${options.candidate.description}`,
    `目标 agent 状态目录:${options.agentStateDir}`,
    '完成后只输出一个 JSON 对象:{"applied": true}',
  ].join('\n')
}

/** Extract the child's final assistant text from its output blocks. */
function finalOutputText(result: SubagentResult): string {
  return result.output
    .map(block => (block.type === 'text' ? block.text : ''))
    .join('\n')
    .trim()
}

/**
 * Validate the agent-state directory at construction time.
 *
 * `agentStateDir` is snapshotted and, on a rejected round, wiped and restored.
 * A caller that omits it must not fall back to `process.cwd()`: the rollback
 * would then delete the caller's working tree. The directory must therefore be
 * stated explicitly, be absolute, be distinct from the data root, cwd, home,
 * and filesystem root, and — when non-empty — carry the benchmark marker that
 * proves it is a benchmark state directory rather than someone's project.
 *
 * @param agentStateDir The configured agent-state directory.
 * @param baseDir The configured benchmark data root.
 * @throws when the directory is missing, unsafe, or not a benchmark state dir.
 */
async function assertAgentStateDir(agentStateDir: string, baseDir: string): Promise<void> {
  if (!isAbsolute(agentStateDir)) {
    throw new Error(`self-evolve-benchmark: agentStateDir must be an absolute path, got ${JSON.stringify(agentStateDir)}`)
  }
  const dir = resolvePath(agentStateDir)
  const forbidden: Array<[string, string]> = [
    ['the benchmark data root', resolvePath(baseDir)],
    ['the current working directory', resolvePath(process.cwd())],
    ['the home directory', resolvePath(homedir())],
    ['the filesystem root', parsePath(dir).root],
  ]
  for (const [label, path] of forbidden) {
    if (dir === path) {
      throw new Error(`self-evolve-benchmark: agentStateDir must not be ${label} (${path}) — a rejected round wipes and restores it`)
    }
  }
  let info
  try {
    info = await stat(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`self-evolve-benchmark: agentStateDir does not exist: ${dir}`)
    }
    throw error
  }
  if (!info.isDirectory()) throw new Error(`self-evolve-benchmark: agentStateDir is not a directory: ${dir}`)
  const entries = await readdir(dir)
  if (entries.length > 0 && !entries.includes(AGENT_STATE_MARKER)) {
    throw new Error(`self-evolve-benchmark: agentStateDir ${dir} is non-empty and lacks the ${AGENT_STATE_MARKER} marker — refusing to treat a caller workspace as benchmark state`)
  }
}

/** Parse a subagent's terminal output as a JSON object, failing loud on malformed output. */
function parseJsonObject(result: SubagentResult, label: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(finalOutputText(result))
  } catch {
    throw new Error(`self-evolve-benchmark: ${label} subagent returned non-JSON output`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`self-evolve-benchmark: ${label} subagent returned a non-object`)
  }
  return parsed as Record<string, unknown>
}

/** Default executor seam: fork one executor per case run, produce the deliverable under the agent state's guidance. */
function createSubagentExecuteCase(ctx: Context): ExecuteCase {
  return async (request) => {
    const { subagents, parent } = requireForkRuntime(ctx, request.sessionId, 'execution')
    const run = await subagents.startActivation({
      provider: 'fork',
      label: 'self-evolve-benchmark',
      delivery: 'caller',
      prompt: [textMessage(executePrompt(request))],
      parent,
      signal: request.signal,
    })
    try {
      const result = await run.result
      if (result.stopReason !== 'completed') {
        throw new Error(`self-evolve-benchmark: execution subagent ended ${result.stopReason}`)
      }
      const outcome: ExecuteCaseResult = { output: finalOutputText(result) }
      outcome.sessionId = run.childId
      return outcome
    } finally {
      await run.dispose()
    }
  }
}

/** Default evaluator seam: fork one evaluator per case run, judge against the rubric locally. */
function createSubagentEvaluateCase(ctx: Context): EvaluateCase {
  return async (request) => {
    const { subagents, parent } = requireForkRuntime(ctx, request.sessionId, 'evaluation')
    const run = await subagents.startActivation({
      provider: 'fork',
      label: 'self-evolve-benchmark',
      delivery: 'caller',
      prompt: [textMessage(evaluatorPrompt(request))],
      parent,
      signal: request.signal,
    })
    try {
      const result = await run.result
      if (result.stopReason !== 'completed') {
        throw new Error(`self-evolve-benchmark: evaluation subagent ended ${result.stopReason}`)
      }
      const parsed = parseJsonObject(result, 'evaluation')
      if (typeof parsed.score !== 'number') {
        throw new Error('self-evolve-benchmark: evaluation subagent omitted the numeric "score" field')
      }
      const outcome: EvaluateCaseResult = { score: parsed.score }
      if (typeof parsed.cost === 'number') outcome.cost = parsed.cost
      if (typeof parsed.durationMs === 'number') outcome.durationMs = parsed.durationMs
      if (typeof parsed.sessionId === 'string') outcome.sessionId = parsed.sessionId
      if (typeof parsed.note === 'string') outcome.note = parsed.note
      return outcome
    } finally {
      await run.dispose()
    }
  }
}

/** Default optimizer seam: fork one child that proposes a candidate against the public surface. */
function createProposeCandidate(ctx: Context): ProposeCandidate {
  return async (options) => {
    const { subagents, parent } = requireForkRuntime(ctx, options.sessionId, 'optimization')
    const run = await subagents.startActivation({
      provider: 'fork',
      label: 'self-evolve-benchmark',
      delivery: 'caller',
      prompt: [textMessage(proposePrompt(options))],
      parent,
      signal: options.signal,
    })
    try {
      const result = await run.result
      if (result.stopReason !== 'completed') {
        throw new Error(`self-evolve-benchmark: optimization subagent ended ${result.stopReason}`)
      }
      const parsed = parseJsonObject(result, 'proposal')
      if (typeof parsed.name !== 'string' || typeof parsed.description !== 'string' || typeof parsed.prediction !== 'string') {
        throw new Error('self-evolve-benchmark: proposal subagent omitted name/description/prediction')
      }
      return { name: parsed.name, description: parsed.description, prediction: parsed.prediction }
    } finally {
      await run.dispose()
    }
  }
}

/** Default applier seam: fork one child that edits the agent state directory in place. */
function createApplyCandidate(ctx: Context): ApplyCandidate {
  return async (options) => {
    const { subagents, parent } = requireForkRuntime(ctx, options.sessionId, 'optimization')
    const run = await subagents.startActivation({
      provider: 'fork',
      label: 'self-evolve-benchmark',
      delivery: 'caller',
      prompt: [textMessage(applyPrompt(options))],
      parent,
      signal: options.signal,
    })
    try {
      const result = await run.result
      if (result.stopReason !== 'completed') {
        throw new Error(`self-evolve-benchmark: apply subagent ended ${result.stopReason}`)
      }
      return { agentStatePath: options.agentStateDir }
    } finally {
      await run.dispose()
    }
  }
}

/**
 * Benchmark-driven self-evolve provider. Registers as `ctx.selfEvolveBenchmark`
 * on instantiation and routes all work through a `BenchmarkEngineCore` whose
 * seams default to the `fork` subagent provider.
 */
export class BenchmarkEvolveEngine extends Service {
  /** The orchestration core whose seams this provider wires to the subagent runtime. */
  readonly core: BenchmarkEngineCore
  /** Default runs per case when a public method omits one. */
  private readonly runsPerCase: number
  /** Default maximum candidate rounds per optimize loop when a public method omits one. */
  private readonly maxRoundsPerLoop: number
  /** Default score goal for optimize loops; absent disables early acceptance. */
  private readonly targetScore: number | undefined
  /** Constructor-started validation of `agentStateDir`; every public method awaits it first. */
  private readonly ready: Promise<void>

  constructor(ctx: Context, config: BenchmarkEvolveConfig) {
    super(ctx, 'selfEvolveBenchmark')
    const baseDir = config.baseDir ?? dshHomePath('self-evolve-benchmark')
    if (typeof config.agentStateDir !== 'string' || config.agentStateDir.length === 0) {
      throw new Error('self-evolve-benchmark: agentStateDir is required — the provider snapshots it every round and wipes it on a rejected round')
    }
    const agentStateDir = config.agentStateDir
    // The directory is validated before any round can snapshot or wipe it; the
    // check is async, so the constructor starts it and every public method
    // awaits it before touching the directory.
    const ready = assertAgentStateDir(agentStateDir, baseDir)
    // Awaiters still observe the rejection; the no-op handler only keeps an
    // unused provider from surfacing it as an unhandled rejection.
    ready.catch(() => {})
    this.core = new BenchmarkEngineCore({
      baseDir,
      agentStateDir,
      executeCase: createSubagentExecuteCase(ctx),
      evaluateCase: createSubagentEvaluateCase(ctx),
      proposeCandidate: createProposeCandidate(ctx),
      applyCandidate: createApplyCandidate(ctx),
      restoreSnapshot: options => restoreSnapshot(baseDir, options.version, agentStateDir),
    })
    this.ready = ready
    this.runsPerCase = config.runsPerCase ?? 1
    this.maxRoundsPerLoop = config.maxRoundsPerLoop ?? 1
    this.targetScore = config.targetScore
  }

  /** Fill per-run defaults from config when the caller omitted them. */
  private runDefaults(options: RunBenchmarkOptions): RunBenchmarkOptions {
    if (options.runsPerCase !== undefined) return options
    return { ...options, runsPerCase: this.runsPerCase }
  }

  /** Fill per-loop defaults from config when the caller omitted them. */
  private loopDefaults(options: OptimizeLoopOptions): OptimizeLoopOptions {
    const filled = { ...options }
    if (options.maxRounds === undefined) filled.maxRounds = this.maxRoundsPerLoop
    if (options.targetScore === undefined && this.targetScore !== undefined) filled.targetScore = this.targetScore
    if (options.runsPerCase === undefined) filled.runsPerCase = this.runsPerCase
    return filled
  }

  /**
   * Run the full benchmark against the current agent state and persist the entry.
   *
   * @param benchmarkId Benchmark id.
   * @param options Evaluation options.
   * @returns The aggregated scoreboard entry.
   */
  runBenchmark(benchmarkId: BenchmarkId, options: RunBenchmarkOptions): Promise<ScoreboardEntry> {
    return this.ready.then(() => this.core.runBenchmark(benchmarkId, this.runDefaults(options)))
  }

  /**
   * Establish a single-run baseline score for a benchmark.
   *
   * @param benchmarkId Benchmark id.
   * @param options Evaluation options.
   * @returns The baseline scoreboard entry.
   */
  establishBaseline(benchmarkId: BenchmarkId, options: RunBenchmarkOptions): Promise<ScoreboardEntry> {
    return this.ready.then(() => this.core.establishBaseline(benchmarkId, this.runDefaults(options)))
  }

  /**
   * Optimize a benchmark under strict improve-or-rollback.
   *
   * @param benchmarkId Benchmark id.
   * @param options Optimization options.
   * @returns The loop outcome.
   */
  optimizeLoop(benchmarkId: BenchmarkId, options: OptimizeLoopOptions): Promise<OptimizeResult> {
    return this.ready.then(() => this.core.optimizeLoop(benchmarkId, this.loopDefaults(options)))
  }

  /**
   * Read all persisted scoreboard entries for a benchmark.
   *
   * @param benchmarkId Benchmark id.
   * @returns Persisted entries, oldest first.
   */
  readScoreboard(benchmarkId: BenchmarkId): Promise<ScoreboardEntry[]> {
    return this.core.readScoreboard(benchmarkId)
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Benchmark-driven self-evolve provider, complementary to `ctx.selfEvolve`. */
    selfEvolveBenchmark: BenchmarkEvolveEngine
  }
}

export default BenchmarkEvolveEngine
