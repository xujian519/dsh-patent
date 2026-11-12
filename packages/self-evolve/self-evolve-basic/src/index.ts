/**
 * Basic projection- and maintenance-triggered self-evolve provider.
 *
 * Registers the `failure-patterns` projection unit during load and mounts the
 * three-stage loop through `SelfEvolveEngine`. The proposer and validator hooks are
 * provider-specific: L1 proposals register as runtime skills, L2 proposals register as
 * system-prompt sections, both through scope-local registrations that unwind
 * cleanly when the provider's proposal fiber disposes. L3+ and L4 proposals
 * remain unimplemented by this base provider (they forward to a no-op proposal
 * rejection) so downstream providers can subclass safely.
 *
 * @module @deepseek-ai/dsh-self-evolve-basic
 */

import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { readJsonlRowsCached, readLatestJsonRow, appendJsonlCapped } from './jsonl.ts'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import {
  EvolveProposalId,
  extractText,
  failurePatternsProjectionDefinition,
  FAILURE_PATTERNS_PROJECTION_KEY,
  parseShellMarkers,
  SelfEvolveEngine,
  SelfEvolveRunId,
  verifierMetadata,
} from '@deepseek-ai/dsh-self-evolve'
import type {
  EvolveLevel,
  EvolveProposal,
  EvolveRequestReceipt,
  EvolveTrigger,
  FailurePattern,
  SelfEvolveAgentContext,
  SelfEvolveResult,
} from '@deepseek-ai/dsh-self-evolve'
import type { EvolveCommit, ProposalValidationOutcome, ReplayEvidence, ValidationScores } from '@deepseek-ai/dsh-self-evolve/types'
import type { CordisDynamicPluginId } from '@deepseek-ai/dsh-cordis-host-runner/types'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ShellExecutor, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-shell'
import type {} from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-workflow'
import type {} from '@deepseek-ai/dsh-cordis-host-runner'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-compaction'
import { assertNever } from '@deepseek-ai/dsh-util-values'

export type {
  BasicSelfEvolveConfig,
  ResolvedBasicSelfEvolveConfig,
  ResolvedWorkspaceVerifierConfig,
  TriggerPolicy,
  WorkspaceBaseline,
  WorkspaceSignal,
  WorkspaceVerifierConfig,
} from './types.ts'
import type {
  BasicSelfEvolveConfig,
  ResolvedBasicSelfEvolveConfig,
  ResolvedWorkspaceVerifierConfig,
  TriggerPolicy,
  WorkspaceBaseline,
  WorkspaceSignal,
} from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /**
     * Provider-authored requests the self-evolve loop sends on its own behalf:
     * proposal judging, reflection, and rewrite prompts. Readers without this
     * producer retain the recorded content and every source property; the
     * loop's own judgement of its prompts stays producer-local.
     * @persistenceAttribution
     */
    'self-evolve': { kind: 'self-evolve' }
  }
}

const DEFAULT_LEVELS: EvolveLevel[] = ['L1-skill', 'L2-context']
const DEFAULT_TRIGGERS: TriggerPolicy = {
  'idle-maintenance': { enabled: true, minIntervalMs: 30_000 },
  pressure: { enabled: true, minIntervalMs: 60_000 },
  'user-command': { enabled: true, minIntervalMs: 0 },
  'validation-retry': { enabled: true, minIntervalMs: 0 },
}
/** Paths under this prefix are harness-owned state, not the project tree. */
export const WORKSPACE_EXCLUDED_PREFIX = '.dsh/'
/** Upper bound on untracked-file lines counted toward the dirty measure (P1.9b). */
const MAX_UNTRACKED_LINES = 100_000
/** Upper bound on collected git stdout the verifier parses (P1.9b). */
const GIT_OUTPUT_MAX_BYTES = 1_000_000
const DEFAULT_GIT_TIMEOUT_MS = 30_000
const DEFAULT_BUILD_TIMEOUT_MS = 300_000

/**
 * Patterns that cleared the mining threshold (SIG-2). Weak `tool-runtime`
 * signals are verifier-grounded only by a generic error name, so their
 * threshold is lifted by one; stronger tiers use the configured base.
 *
 * @param patterns - projected failure patterns, ranked by occurrence count.
 * @param minOccurrences - configured base threshold.
 * @returns the patterns eligible for proposal targeting.
 */
export function eligiblePatterns(patterns: FailurePattern[], minOccurrences: number): FailurePattern[] {
  return patterns.filter((pattern) => {
    const lift = pattern.verifierTier === 'tool-runtime' ? 1 : 0
    return pattern.occurrences >= minOccurrences + lift
  })
}

/**
 * Sum `git diff HEAD --numstat` rows into a dirty-line count, adding the
 * caller-supplied untracked-line total. Rows under the harness-owned `.dsh/`
 * prefix are excluded; a binary row counts as one dirty unit because git
 * reports `-` for both count fields while the file still changed.
 *
 * @param numstat - stdout of `git diff HEAD --numstat --relative`.
 * @param untrackedLines - total lines of untracked files outside `.dsh/`, already bounded.
 * @returns the dirty-line count.
 */
export function parseDirtyDelta(numstat: string, untrackedLines = 0): number {
  let lines = untrackedLines
  for (const row of numstat.split('\n')) {
    if (row.trim().length === 0) continue
    const [added, deleted, ...rest] = row.split('\t')
    const path = rest.join('\t')
    if (path.startsWith(WORKSPACE_EXCLUDED_PREFIX)) continue
    const addedCount = Number(added)
    const deletedCount = Number(deleted)
    if (Number.isFinite(addedCount) && Number.isFinite(deletedCount)) {
      lines += addedCount + deletedCount
    } else {
      lines += 1
    }
  }
  return lines
}

/** Render one candidate as plain text for replay prompts and the judge. */
function candidateText(proposal: EvolveProposal): string {
  const candidate = proposal.candidate
  switch (candidate.kind) {
    case 'L1-skill':
      return candidate.content
    case 'L2-context':
      return `${candidate.sectionName}: ${candidate.sectionText}`
    case 'L3-workflow':
      return `workflow ${candidate.scriptName}:\n${candidate.scriptBody}`
    case 'L4-harness':
      return `plugin ${candidate.pluginIdPrefix} (host=${candidate.hostCode !== undefined ? 'provided' : 'none'}, client=${candidate.clientCode !== undefined ? 'provided' : 'none'})`
    /* v8 ignore next -- closed-union backstop; the compiler rejects a new candidate kind here. */
    default:
      return assertNever(candidate, 'evolve candidate')
  }
}

/** Compact event-type window around a failure seq, for the replay prompt. */
function caseContextText(session: Session, lastSeq: number): string {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  const events = session.snapshotEvents()
  const index = events.findIndex(event => event.seq === lastSeq)
  if (index < 0) return `失败事件 seq ${lastSeq}`
  const window = events.slice(Math.max(0, index - 2), index + 3)
  return window.map(event => `[${event.seq}] ${event.type}`).join(' → ')
}

/**
 * Fold a fork child's own events (after the end-seed marker) into pattern ids
 * and a tool-call count. Both are read from durable events, so the replay
 * verdict rests on what the child did rather than on its own account of it.
 */
function foldChildSession(session: Session): { retriggeredPatternIds: string[]; toolCalls: number } {
  let state = failurePatternsProjectionDefinition.init()
  let afterSeed = false
  let toolCalls = 0
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  for (const event of session.snapshotEvents()) {
    if (event.type === 'session/end-seed') {
      afterSeed = true
      continue
    }
    if (!afterSeed) continue
    if (event.type === 'tool/call') toolCalls += 1
    state = failurePatternsProjectionDefinition.apply(state, event)
  }
  return { retriggeredPatternIds: Object.keys(state.patterns), toolCalls }
}

/** Plain text of one content block, or null for non-text blocks. */
function blockText(block: { type: string; text?: unknown }): string | null {
  return block.type === 'text' && typeof block.text === 'string' ? block.text : null
}

/** Whether rendered tool text carries a shell failure marker (P3.1 trigger). */
function hasShellFailureMarkers(text: string): boolean {
  return parseShellMarkers(text) !== null
}

/** Extract and parse the first JSON value matching `pattern`; null when unparseable. */
function parseJsonValue(text: string, pattern: RegExp): unknown {
  const match = pattern.exec(text)
  if (match === null) return null
  try {
    return JSON.parse(match[0])
  } catch {
    return null
  }
}

/** Stream one model call and return its assembled plain text. */
async function streamText(stream: AsyncIterable<StreamChunk>): Promise<string> {
  const assembler = new BlockAssembler()
  for await (const chunk of stream) assembler.push(chunk)
  return assembler.blocks().map(blockText).filter((text): text is string => text !== null).join('\n')
}

/** Parse one step-reflection JSON output (P3.1); null when unparseable. */
function parseReflection(text: string): { confidence: number; patternId: string; suggestion: string } | null {
  const raw = parseJsonValue(text, /\{[\s\S]*\}/)
  if (raw === null || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const confidence = typeof item.confidence === 'number' && Number.isFinite(item.confidence)
    ? Math.min(1, Math.max(0, item.confidence))
    : undefined
  const patternId = typeof item.patternId === 'string' && item.patternId.length > 0 ? item.patternId : undefined
  const suggestion = typeof item.suggestion === 'string' ? item.suggestion : ''
  if (confidence === undefined || patternId === undefined) return null
  return { confidence, patternId, suggestion }
}

/** Parse the LLM proposer's JSON proposal array (P3.2); malformed entries drop out. */
function parseLlmProposals(text: string): EvolveProposal[] {
  const raw = parseJsonValue(text, /\[[\s\S]*\]/)
  if (!Array.isArray(raw)) return []
  const proposals: EvolveProposal[] = []
  for (const entry of raw) {
    const item = entry as Record<string, unknown>
    const candidate = item.candidate as Record<string, unknown> | undefined
    const name = typeof item.name === 'string' ? item.name : ''
    const purpose = typeof item.purpose === 'string' ? item.purpose : ''
    const addresses = Array.isArray(item.addressesPatternIds)
      ? item.addressesPatternIds.filter((id): id is string => typeof id === 'string')
      : []
    if (name.length === 0 || purpose.length === 0 || candidate === undefined) continue
    if (candidate.kind === 'L1-skill' && typeof candidate.skillName === 'string' && typeof candidate.content === 'string') {
      proposals.push({
        proposalId: proposalIdSeq(),
        runId: SelfEvolveRunId('pending'),
        level: 'L1-skill',
        name,
        purpose,
        addressesPatternIds: addresses,
        candidate: {
          kind: 'L1-skill',
          skillName: candidate.skillName,
          content: candidate.content,
          ...(typeof candidate.whenToUse === 'string' ? { whenToUse: candidate.whenToUse } : {}),
        },
      })
    } else if (candidate.kind === 'L2-context' && typeof candidate.sectionName === 'string' && typeof candidate.sectionText === 'string') {
      const sectionText = candidate.sectionText
      proposals.push({
        proposalId: proposalIdSeq(),
        runId: SelfEvolveRunId('pending'),
        level: 'L2-context',
        name,
        purpose,
        addressesPatternIds: addresses,
        candidate: {
          kind: 'L2-context',
          sectionName: candidate.sectionName,
          sectionText,
          order: typeof candidate.order === 'number' ? candidate.order : SECTION_ORDER_PATCH,
          estimatedBytes: utf8Bytes(sectionText),
        },
      })
    }
  }
  return proposals
}

/**
 * Parse the judge's JSON score object, clamped to [0, 1]. Returns null when
 * the output carries no parseable object with all four dimensions, so the
 * caller degrades to structural scores.
 */
function parseJudgeScores(text: string): ValidationScores | null {
  const raw = parseJsonValue(text, /\{[\s\S]*\}/)
  if (raw === null || typeof raw !== 'object') return null
  const item = raw as Record<string, unknown>
  const score = (value: unknown): number | undefined => (
    typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : undefined
  )
  const activatesWhenCorrect = score(item.activatesWhenCorrect)
  const clarity = score(item.clarity)
  const noRegressionIntroduced = score(item.noRegressionIntroduced)
  const safety = score(item.safety)
  if (activatesWhenCorrect === undefined || clarity === undefined || noRegressionIntroduced === undefined || safety === undefined) {
    return null
  }
  return { activatesWhenCorrect, clarity, noRegressionIntroduced, safety }
}

/** Per-process id sequence whose opaque core is a UUID, so committed session
 * snapshots redact the id wherever a run, proposal, or request reference
 * appears — including inside summary text. */
function makeIdSeq<T>(prefix: string, brand: (id: string) => T): () => T {
  let counter = 0
  const instance = randomUUID()
  return () => brand(`${prefix}-${instance}-${(counter++).toString(36)}`)
}

const runIdSeq = makeIdSeq('selfev', SelfEvolveRunId)
const proposalIdSeq = makeIdSeq('prop', EvolveProposalId)
const requestIdSeq = makeIdSeq('req', (id: string) => id)

const MAX_SECTION_NAME_DIGEST = 8
const SECTION_ORDER_PATCH = 260
/** Rolling window for the per-session autonomous-loop cap (`maxDailyLoopsPerSession`). */
const DAILY_WINDOW_MS = 24 * 60 * 60 * 1000
/** How many recent per-pattern rejection rows the proposer prefix summarizes. */
const NEGATIVE_RESULTS_CONTEXT_ITEMS = 3
/** Missing-rate value for an unavailable verifier dimension (P1.4 weak path). */
const WEAK_VERIFIER_RATE = 0.3
/** Consecutive same-pattern regressions that trigger a champion rollback (P1.8). */
const REGRESSION_ROLLBACK_THRESHOLD = 2
/** Minimum workflow agents for an L3 smoke to count as passing (P2.1). */
const L3_SMOKE_MIN_AGENTS = 1
/** Step-reflection LLM budget (P3.1): input chars and output tokens. */
const REFLECTION_MAX_INPUT_CHARS = 2048
const REFLECTION_MAX_OUTPUT_TOKENS = 512
/** Rolling window for the cross-session global pattern merge (P4.2). */
const GLOBAL_PATTERN_WINDOW_MS = 24 * 60 * 60 * 1000
/**
 * Scores recorded for an L4 proposal that entered the approval pipeline.
 *
 * The aggregate confidence gate does not evaluate L4: activation settles
 * asynchronously through `dynamicCordisRunner`, and the human approval flow —
 * not a confidence score — authorizes the change. These values record "not
 * evaluated", not "evaluated favourably". The pinned `confidence: 1` on that
 * outcome exists only because the accepted variant requires a number, and is
 * never evidence of proposal quality.
 */
const L4_APPROVAL_SCORES: ValidationScores = {
  activatesWhenCorrect: 1,
  clarity: 1,
  noRegressionIntroduced: 1,
  safety: 1,
}

/**
 * Scores substituted when the LLM judge returned no signal (no
 * `validatorTarget`, or the llm service is absent). Capping every dimension at
 * the weak rate keeps a missing judge from reading as a favourable one, which
 * is what scoring it 1.0 would do.
 */
const WEAK_VALIDATION_SCORES: ValidationScores = {
  activatesWhenCorrect: WEAK_VERIFIER_RATE,
  clarity: WEAK_VERIFIER_RATE,
  noRegressionIntroduced: WEAK_VERIFIER_RATE,
  safety: WEAK_VERIFIER_RATE,
}

/**
 * UTF-8 byte length of a string. Prompt-inflation accounting is configured in
 * bytes (`maxPromptInflationBytesPerWeek`, `L2-context.estimatedBytes`), so it
 * cannot use `String.length`: that counts UTF-16 code units and understates
 * non-ASCII text by up to 3×, silently widening the budget.
 */
function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** One append-only negative-result row (P1.7b, 翁荔挑战 4). */
export interface NegativeResultRow {
  /** Wall-clock timestamp of the rejection. */
  ts: number
  /** The pattern the rejected proposal targeted. */
  patternId: string
  /** The rejected proposal's immutable identity. */
  proposalId: string
  /** Rejection reason from the validation outcome. */
  reason: Extract<ProposalValidationOutcome, { kind: 'rejected' }>['reason']
  /** Verifier-grounded failure detail. */
  diagnostic: string
  /** Partial per-dimension scores recorded before the rejection. */
  deconstructedScores?: Partial<ValidationScores>
  /** Repair hint the next proposal cycle should read first. */
  nextRoundSuggestion: string
}

/** Durable champion archive row (P1.8): the candidate a rollback restores. */
export interface ChampionArchiveRow {
  ts: number
  patternId: string
  proposalId: string
  name: string
  /** The candidate this commit made live. */
  candidate: EvolveProposal['candidate']
  /**
   * Durable seq of the `self-evolve/commit` event that made this row's
   * candidate live. Rows written before that seq existed are not champions.
   */
  commitSeq?: number
  /**
   * The candidate the commit replaced — the true champion a rollback
   * restores. `null` on the first commit for a pattern (nothing to restore).
   * L1 previous state is derived from the archive history because the skill
   * registry has no name-based reader.
   */
  previousCandidate: EvolveProposal['candidate'] | null
}

/** Whether a configured LLM target is complete; a partial target fails load. */
function requireCompleteTarget(
  target: { provider?: string; model?: string } | undefined,
  label: string,
): target is { provider: string; model: string } {
  if (target === undefined || Object.keys(target).length === 0) return false
  if (target.provider === undefined || target.model === undefined) {
    throw new Error(`self-evolve: ${label} must include both provider and model`)
  }
  return true
}

/** Most recent matching rows for one pattern, kept in log order. */
function recentNegatives(rows: NegativeResultRow[], patternId: string, limit: number): NegativeResultRow[] {
  const matches: NegativeResultRow[] = []
  for (const row of rows) if (row.patternId === patternId) matches.push(row)
  return matches.slice(-limit)
}

/** Convert a validated candidate that could not be applied into `apply-failed`. */
function applyRejected(
  accepted: Extract<ProposalValidationOutcome, { kind: 'accepted' }>,
  error: Error,
): Extract<ProposalValidationOutcome, { kind: 'rejected' }> {
  return {
    kind: 'rejected',
    reason: 'apply-failed',
    regressions: [],
    diagnostic: error.message,
    deconstructedScores: accepted.deconstructedScores,
    confidence: accepted.confidence,
    replayEvidence: accepted.replayEvidence,
    nextRoundSuggestion: '候选与已存在的 skill/section 名称冲突或超出上限；换一个名称后重新提案。',
  }
}

/** Resolve and validate public configuration; throw at load time. */
function resolveConfig(config: BasicSelfEvolveConfig): ResolvedBasicSelfEvolveConfig {
  const triggers: TriggerPolicy = { ...DEFAULT_TRIGGERS }
  if (config.triggers !== undefined) {
    for (const key of Object.keys(config.triggers) as (keyof TriggerPolicy)[]) {
      triggers[key] = { ...triggers[key], ...config.triggers[key] }
    }
  }
  const workspaceVerifier: ResolvedWorkspaceVerifierConfig = {
    enabled: config.workspaceVerifier?.enabled ?? true,
    gitTimeoutMs: config.workspaceVerifier?.gitTimeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
    buildTimeoutMs: config.workspaceVerifier?.buildTimeoutMs ?? DEFAULT_BUILD_TIMEOUT_MS,
  }
  if (config.workspaceVerifier?.buildCommand !== undefined) {
    workspaceVerifier.buildCommand = config.workspaceVerifier.buildCommand
  }
  const resolved: ResolvedBasicSelfEvolveConfig = {
    maxDailyLoopsPerSession: config.maxDailyLoopsPerSession ?? 4,
    triggers,
    defaultLevels: config.defaultLevels ?? DEFAULT_LEVELS,
    minPatternOccurrences: config.minPatternOccurrences ?? 2,
    maxProposalsPerLoop: config.maxProposalsPerLoop ?? 2,
    maxDirtyLinesAddedPerCommit: config.maxDirtyLinesAddedPerCommit ?? 2,
    requireDualVerification: config.requireDualVerification ?? true,
    minAcceptConfidence: config.minAcceptConfidence ?? 0.5,
    maxHeldOutCases: config.maxHeldOutCases ?? 5,
    heldOutSessionIds: config.heldOutSessionIds ?? [],
    minHeldOutPassRate: config.minHeldOutPassRate ?? 0.6,
    maxPromptInflationBytesPerWeek: config.maxPromptInflationBytesPerWeek ?? 2048,
    l4ReapprovalHours: config.l4ReapprovalHours ?? 24,
    maxStepReflectionsPerTurn: config.maxStepReflectionsPerTurn ?? 1,
    reflectionMinConfidence: config.reflectionMinConfidence ?? 0.85,
    patternFreezeHours: config.patternFreezeHours ?? 24,
    maxBudgetCharsPerLoop: config.maxBudgetCharsPerLoop ?? 32_768,
    allowUnverifiedAutonomousRuns: config.allowUnverifiedAutonomousRuns ?? false,
    maxValidationRetriesPerPattern: config.maxValidationRetriesPerPattern ?? 1,
    maxPendingEvolveRequests: config.maxPendingEvolveRequests ?? 8,
    notifyOnExplicitRun: config.notifyOnExplicitRun ?? true,
    maxNegativeResultRows: config.maxNegativeResultRows ?? 500,
    maxGlobalPatternRows: config.maxGlobalPatternRows ?? 1000,
    maxTrackedSessions: config.maxTrackedSessions ?? 64,
    maxTrackedPatternsPerSession: config.maxTrackedPatternsPerSession ?? 256,
    maxLiveSkills: config.maxLiveSkills ?? 32,
    workspaceVerifier,
  }
  if (requireCompleteTarget(config.proposerTarget, 'proposerTarget')) resolved.proposerTarget = config.proposerTarget
  if (requireCompleteTarget(config.validatorTarget, 'validatorTarget')) resolved.validatorTarget = config.validatorTarget
  if (
    resolved.proposerTarget !== undefined
    && resolved.validatorTarget !== undefined
    && resolved.proposerTarget.provider === resolved.validatorTarget.provider
    && resolved.proposerTarget.model === resolved.validatorTarget.model
  ) {
    // Validator 漂移防护: the judge must never share the proposer's route.
    throw new Error('self-evolve: validatorTarget must differ from proposerTarget (validator drift protection)')
  }
  return resolved
}

/** Per-session rate-limiting state. */
interface SessionRateState {
  loopStarts: number[]
  lastStartByTrigger: Record<string, number>
  /** patternId → frozen-until epoch for the 24h proposal freeze (P3.3). */
  frozenPatterns: Map<string, number>
  /** Last time this session's state was touched, for bounded retention. */
  touchedAt: number
}

/** One queued evolve request. The queue is process-local (see EvolveRequestReceipt). */
interface QueuedEvolveRequest {
  requestId: string
  trigger: EvolveTrigger
  levels: EvolveLevel[]
  /** Explicit requests outrank autonomous ones and are never evicted. */
  explicit: boolean
}

/** One live runtime skill contribution this provider owns (P0-4). */
interface LiveSkill {
  dispose: () => void
  proposalId: string
  candidate: Extract<EvolveProposal['candidate'], { kind: 'L1-skill' }>
  description: string
  source: string
}

/** Trigger precedence when several requests are queued for one session. */
const TRIGGER_PRIORITY: Record<EvolveTrigger, number> = {
  'user-command': 0,
  'validation-retry': 1,
  pressure: 2,
  'idle-maintenance': 3,
}

/** Raised when a candidate cannot be applied; the loop records `apply-failed`. */
class ApplyRejectedError extends Error {}

/**
 * Dependency-light self-evolve backend. Real implementations subclass
 * `proposeForPatterns()` and `validateProposal()`; trigger gating, projection
 * mining, rate limits, event brackets, and durable-log emission stay fixed.
 */
export class BasicSelfEvolveEngine extends SelfEvolveEngine {
  static inject = ['sessionProjections', 'sessions', 'skills', 'systemPrompt', 'agents']

  static Config: z<BasicSelfEvolveConfig> = z.object({
    maxDailyLoopsPerSession: z.number().step(1).min(0).default(4),
    triggers: z.dict(
      z.object({
        enabled: z.boolean(),
        minIntervalMs: z.number().step(1).min(0),
      }),
      z.union([
        z.const('idle-maintenance'),
        z.const('pressure'),
        z.const('user-command'),
        z.const('validation-retry'),
      ]),
    ).default(DEFAULT_TRIGGERS),
    defaultLevels: z.array(z.union([
      z.const('L1-skill'),
      z.const('L2-context'),
      z.const('L3-workflow'),
      z.const('L4-harness'),
    ])).default(DEFAULT_LEVELS),
    minPatternOccurrences: z.number().step(1).min(1).default(2),
    maxProposalsPerLoop: z.number().step(1).min(1).default(2),
    requireDualVerification: z.boolean().default(true),
    minAcceptConfidence: z.number().step(0.01).min(0).max(1).default(0.5),
    maxHeldOutCases: z.number().step(1).min(0).max(10).default(5),
    heldOutSessionIds: z.array(z.string()),
    minHeldOutPassRate: z.number().step(0.01).min(0).max(1).default(0.6),
    maxPromptInflationBytesPerWeek: z.number().step(1).min(0).default(2048),
    l4ReapprovalHours: z.number().step(0.5).min(0).default(24),
    maxStepReflectionsPerTurn: z.number().step(1).min(0).max(10).default(1),
    reflectionMinConfidence: z.number().step(0.01).min(0).max(1).default(0.85),
    patternFreezeHours: z.number().step(0.5).min(0).default(24),
    maxBudgetCharsPerLoop: z.number().step(1).min(0).default(32_768),
    proposerTarget: z.object({
      provider: z.string(),
      model: z.string(),
    }),
    validatorTarget: z.object({
      provider: z.string(),
      model: z.string(),
    }),
    maxDirtyLinesAddedPerCommit: z.number().step(1).min(0).default(2),
    allowUnverifiedAutonomousRuns: z.boolean().default(false),
    maxValidationRetriesPerPattern: z.number().step(1).min(0).default(1),
    maxPendingEvolveRequests: z.number().step(1).min(1).default(8),
    notifyOnExplicitRun: z.boolean().default(true),
    maxNegativeResultRows: z.number().step(1).min(1).default(500),
    maxGlobalPatternRows: z.number().step(1).min(1).default(1000),
    maxTrackedSessions: z.number().step(1).min(1).default(64),
    maxTrackedPatternsPerSession: z.number().step(1).min(1).default(256),
    maxLiveSkills: z.number().step(1).min(1).default(32),
    workspaceVerifier: z.object({
      enabled: z.boolean().default(true),
      buildCommand: z.string(),
      gitTimeoutMs: z.number().step(1).min(1_000).default(DEFAULT_GIT_TIMEOUT_MS),
      buildTimeoutMs: z.number().step(1).min(1_000).default(DEFAULT_BUILD_TIMEOUT_MS),
    }),
  })

  /** Resolved provider configuration with defaults applied. */
  readonly config: ResolvedBasicSelfEvolveConfig
  /** Queued evolve requests per session; drained at the next idle boundary. */
  private readonly evolveQueues = new Map<string, QueuedEvolveRequest[]>()
  /** Trigger currently executing per session; a second start is a busy no-op. */
  private readonly inFlight = new Map<string, EvolveTrigger>()
  /** Live self-evolve runtime skills this provider owns, keyed by skill name (P0-4). */
  private readonly liveSkills = new Map<string, LiveSkill>()
  /** Candidate the latest commit made live, keyed by pattern id (rollback bookkeeping). */
  private readonly liveByPattern = new Map<string, EvolveProposal['candidate']>()
  /** Validation-retry counters keyed by `sessionId:patternId` (P0-3). */
  private readonly retryCounts = new Map<string, number>()
  private readonly sessionRateStates = new Map<string, SessionRateState>()
  /** Live self-evolve-generated L2 sections, for prompt-inflation pruning (P1.9). */
  private readonly liveSections = new Map<string, { text: string; order: number; registeredAt: number; dispose: () => void }>()
  /** Consecutive same-pattern regressions, for champion rollback (P1.8). */
  private readonly regressionCounts = new Map<string, number>()
  /** L4 plugins this provider drove, keyed by pluginId → current proposalId (P2.2). */
  private readonly l4Pending = new Map<string, string>()
  /** L4 approval ledger, keyed by pluginId → last approved proposal + timestamp (P2.3). */
  private readonly l4Ledger = new Map<string, { proposalId: string; approvedAt: number }>()
  /** Runner request correlation for pending L4 plugins (requestId → owner), for cleanup on refusal. */
  private readonly l4RequestByRun = new Map<string, { pluginId: CordisDynamicPluginId; agentId: SessionId }>()
  /** Per-session step-reflection counts for the current turn (P3.1). */
  private readonly reflectionCounts = new Map<string, { turn: number; count: number }>()
  /** Per-session per-pattern proposal counts for the 24h freeze (P3.3), one bounded map per session. */
  private readonly proposalCounts = new Map<string, Map<string, { count: number; at: number }>>()
  /** Byte budget charged across one loop's LLM calls and searches (P3.4); null outside a loop. */
  private loopBudget: { used: number } | null = null

  constructor(ctx: Context, config: BasicSelfEvolveConfig) {
    super(ctx)
    this.config = resolveConfig(config)
    // Every runtime contribution this provider makes unwinds with the fiber.
    ctx.effect(() => () => {
      this.disposeLiveContributions()
    })
    // Idle boundary: the agent reports `idle` while the maintenance phase runs
    // too, so `agent/status` fires exactly when a turn releases the loop — the
    // `turn/end` event is still inside the running phase.
    ctx.effect(() => ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'idle') return
      if (this.isSubagentSession(agent.session)) return
      void this.drain(agent)
    }))
    // Pressure trigger: an in-turn automatic compaction signals context
    // pressure; a standalone manual compaction (`turn === null`) does not.
    ctx.effect(() => ctx.on('session/event', (session: Session, event) => {
      if (event.type !== 'compaction/start') return
      if (event.data.turn === null) return
      if (!this.config.triggers.pressure.enabled) return
      if (this.isSubagentSession(session)) return
      const agent = ctx.agents.get(session.id)
      if (agent === undefined) return
      if (!this.autonomousRunsAllowed()) {
        this.ctx.logger('self-evolve').debug('pressure trigger skipped: no verifier is configured and allowUnverifiedAutonomousRuns is false')
        return
      }
      this.enqueue(agent, 'pressure', this.config.defaultLevels, false)
    }))
    ctx.effect(() => ctx.on('agent/request-error', async (payload, next) => {
      // Durable record of a terminating model-request failure (G1): the failure
      // projection classifies it as the llm-provider tier keyed on failure.code.
      // The waterfall must delegate first — a retry owner consumes the failure
      // and the retry attempts must not each count as a new occurrence.
      const action = await next()
      if (action !== undefined) return action
      try {
        payload.agent.session.append('agent/request-error', {
          turn: payload.turn,
          step: payload.step,
          provider: payload.provider,
          statusCode: payload.failure.status,
          error: { code: payload.failure.code, name: 'LlmFailure', message: payload.failure.message },
        })
      } catch (error: unknown) {
        // A session closed during teardown cannot take appends; the projection
        // is best-effort and the failure is already durable in the log.
        this.ctx.logger('self-evolve').debug(`agent/request-error append skipped: ${error instanceof Error ? error.message : String(error)}`)
      }
      return undefined
    }))
    ctx.effect(() => ctx.on('cordis/before-approval', (info, next) => next().then((base) => {
      // L4 re-approval guard (P2.3): a plugin this provider drove before is
      // forced through human approval again when the current proposal differs
      // from the last approved one or the approval is older than
      // `l4ReapprovalHours` — even when approveFutureVersions would
      // auto-approve.
      const pending = this.l4Pending.get(info.pluginId)
      const ledger = this.l4Ledger.get(info.pluginId)
      if (pending !== undefined && ledger !== undefined) {
        const stale = pending !== ledger.proposalId
          || Date.now() - ledger.approvedAt > this.config.l4ReapprovalHours * 3_600_000
        if (stale) return true
      }
      return base
    })))
    ctx.effect(() => ctx.on('agent/pre-step', async (payload, next): Promise<PreStepDecision> => {
      // Step reflection (P3.1): when the current turn already failed, one
      // low-budget LLM reflection per turn may reinforce an existing pattern.
      // The step pipeline must proceed regardless of the reflection outcome.
      if (!payload.signal.aborted && this.config.maxStepReflectionsPerTurn > 0) {
        try {
          await this.maybeReflect(payload.agent, payload.turn, payload.step, payload.signal)
        } catch (error: unknown) {
          ctx.logger('self-evolve').debug(`step reflection skipped: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return next()
    }))
    ctx.effect(() => ctx.on('@deepseek-ai/cordis/request-run', (request) => {
      // Correlate the runner's approval request with an L4 plugin this
      // provider drove, so a later refusal can drop the definition (P2.2).
      if (this.l4Pending.has(request.pluginId)) {
        this.l4RequestByRun.set(String(request.requestId), { pluginId: request.pluginId, agentId: request.agentId })
      }
    }))
    ctx.effect(() => ctx.on('@deepseek-ai/cordis/request-run-resolved', (resolved) => {
      const owner = this.l4RequestByRun.get(String(resolved.requestId))
      if (owner === undefined) return
      this.l4RequestByRun.delete(String(resolved.requestId))
      this.l4Pending.delete(owner.pluginId)
      if (resolved.outcome === 'approved' || resolved.outcome === 'completed') return
      // The activation was refused or failed: drop the orphaned definition so
      // the runner registry does not accumulate never-activated plugins.
      void this.dropL4Plugin(owner.agentId, owner.pluginId)
    }))
  }

  /** Register the failure-pattern projection before any mining or draining runs. */
  protected async [Service.init](): Promise<void> {
    await this.ctx.sessionProjections.register(failurePatternsProjectionDefinition)
  }

  /** Undefine an L4 plugin this provider defined when its run was refused or failed (P2.2). */
  private async dropL4Plugin(agentId: SessionId, pluginId: CordisDynamicPluginId): Promise<void> {
    const runner = this.ctx.get('dynamicCordisRunner')
    const parent = this.ctx.agents.get(agentId)
    if (runner === undefined || parent === undefined) return
    try {
      await runner.undefine(parent, pluginId)
    } catch (error: unknown) {
      // The definition may already be gone; cleanup is best-effort.
      this.ctx.logger('self-evolve').debug(`L4 undefine skipped for ${pluginId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async evolveIfNeeded(
    agent: SelfEvolveAgentContext,
    trigger: EvolveTrigger,
    signal: AbortSignal,
    levels: EvolveLevel[] = this.config.defaultLevels,
  ): Promise<SelfEvolveResult | null> {
    if (!this.config.triggers[trigger].enabled) return null
    if (this.inFlight.has(agent.sessionId)) return null
    const state = this.rateState(agent.sessionId)
    const now = Date.now()
    const lastStart = state.lastStartByTrigger[trigger] ?? 0
    if (now - lastStart < this.config.triggers[trigger].minIntervalMs) return null
    // The 24-hour autonomous-loop cap bounds how much of the session budget an
    // unattended loop sequence can consume; explicit user commands bypass it.
    if (this.isAutonomousTrigger(trigger) && this.recentLoopCount(state) >= this.config.maxDailyLoopsPerSession) {
      return null
    }
    // Mining stays inside the maintenance job: the phase must be reserved
    // before the first await, or a concurrent turn claims the agent while the
    // projection/JSONL reads are still in flight.
    return this.runLoop(agent, trigger, () => this.filterEligiblePatterns(agent.sessionId), levels, signal, true)
  }

  async evolveNow(
    agent: SelfEvolveAgentContext,
    signal: AbortSignal,
    levels: EvolveLevel[] = this.config.defaultLevels,
  ): Promise<SelfEvolveResult> {
    const result = await this.runLoop(
      agent,
      'user-command',
      () => this.filterEligiblePatterns(agent.sessionId),
      levels,
      signal,
      false,
    )
    /* A concurrent caller already owns the in-flight slot, so this call starts
     * no loop at all; reporting that is more honest than returning a fake run. */
    if (result === null) throw new Error('self-evolve: evolveNow produced no result')
    return result
  }

  /**
   * Queue one explicit evolution request for the next idle boundary and return
   * its receipt. The tool that calls this is inside a turn, so starting the
   * loop synchronously would always collide with the running agent.
   */
  requestEvolve(
    agent: SelfEvolveAgentContext,
    levels: EvolveLevel[] = this.config.defaultLevels,
  ): EvolveRequestReceipt {
    const receipt = this.enqueueFor(agent.sessionId, 'user-command', levels, true)
    const live = this.ctx.agents.get(agent.sessionId)
    if (live !== undefined) void this.drain(live)
    return receipt
  }

  async readPatterns(sessionId: string): Promise<FailurePattern[]> {
    const session = this.requireSession(sessionId)
    const snapshot = this.ctx.sessionProjections.snapshot(session)
    const state = snapshot.values[FAILURE_PATTERNS_PROJECTION_KEY] as { patterns?: Record<string, FailurePattern> } | undefined
    if (state === undefined || state.patterns === undefined) return []
    const sorted = Object.values(state.patterns).sort((a, b) => b.occurrences - a.occurrences)
    // Cross-session occurrence merge (P4.2): other sessions' occurrences
    // within the 24h window push sparse patterns over the mining threshold.
    const global = await this.readGlobalPatternOccurrences(sessionId)
    const allNegatives = await this.readAllNegativeResults()
    // Enrich each pattern with its durable rejection history (P1.6) so the
    // proposer sees prior failed attempts as few-shot counterexamples.
    const enriched: FailurePattern[] = []
    for (const pattern of sorted) {
      const globalOccurrences = global.get(pattern.patternId) ?? 0
      const occurrences = pattern.occurrences + globalOccurrences
      const failed = recentNegatives(allNegatives, pattern.patternId, NEGATIVE_RESULTS_CONTEXT_ITEMS)
      if (failed.length === 0) {
        enriched.push(globalOccurrences > 0 ? { ...pattern, occurrences } : pattern)
        continue
      }
      enriched.push({
        ...pattern,
        occurrences,
        verifierMeta: verifierMetadata({ ...pattern.verifierMeta, failedProposals: failed }),
      })
    }
    return enriched
  }

  /**
   * Projection-only pattern read: the sorted failure patterns contributed by
   * this session, without the cross-session occurrence merge or the durable
   * negative-result enrichment. Hot per-step callers (step reflection) use
   * this so a failing step never re-reads two JSONL files; the public
   * `readPatterns` keeps the enriched behaviour the proposer needs.
   *
   * @param sessionId - the session whose projection to read.
   * @returns the session-local patterns, most frequent first.
   */
  protected readProjectedPatterns(sessionId: string): FailurePattern[] {
    const session = this.requireSession(sessionId)
    const snapshot = this.ctx.sessionProjections.snapshot(session)
    const state = snapshot.values[FAILURE_PATTERNS_PROJECTION_KEY] as { patterns?: Record<string, FailurePattern> } | undefined
    if (state === undefined || state.patterns === undefined) return []
    return Object.values(state.patterns).sort((a, b) => b.occurrences - a.occurrences)
  }

  /** Hook point for subclass implementations; base produces L2 prompt sections for L1-skill patterns.
   * When `proposerTarget` is configured and the llm service is mounted, the LLM proposer (P3.2)
   * runs instead; the template remains the default. `_agentOptions` is the routed proposer target
   * for subclass LLM calls. */
  protected async proposeForPatterns(
    patterns: FailurePattern[],
    levels: readonly EvolveLevel[],
    _agentOptions: { provider?: string; model?: string },
    signal: AbortSignal,
    sessionId?: string,
  ): Promise<EvolveProposal[]> {
    if (sessionId !== undefined) {
      const llmProposals = await this.proposeWithLlm(patterns, levels, signal, sessionId)
      if (llmProposals.length > 0) return llmProposals
    }
    return this.proposeTemplate(patterns, levels)
  }

  /** The P0/P1 template proposer: one L2 prompt section per L1-skill pattern. */
  private async proposeTemplate(patterns: FailurePattern[], levels: readonly EvolveLevel[]): Promise<EvolveProposal[]> {
    if (!levels.includes('L2-context')) return []
    const allNegatives = await this.readAllNegativeResults()
    const out: EvolveProposal[] = []
    for (const pattern of patterns) {
      if (pattern.level !== 'L1-skill') continue
      const localId = pattern.patternId.includes(':')
        ? pattern.patternId.slice(pattern.patternId.indexOf(':') + 1)
        : pattern.patternId
      const sectionName = `self-evolve-patch-${localId.slice(0, MAX_SECTION_NAME_DIGEST)}`
      const lastSeq = pattern.supportingSeqs[pattern.supportingSeqs.length - 1]
      const contextHint = lastSeq !== undefined
        ? `supportingSeqs 最后一次失败 (seq ${lastSeq}) 的上下文`
        : '该 pattern 的上下文'
      const negatives = recentNegatives(allNegatives, pattern.patternId, NEGATIVE_RESULTS_CONTEXT_ITEMS)
      const failurePrefix = negatives.length > 0
        ? `此前针对该模式的 ${negatives.length} 次提案均被拒绝（${[...new Set(negatives.map(n => n.reason))].join('、')}），不要重复同样方案。`
        : ''
      const sectionText = `当你遇到以下工具错误模式时：${pattern.summary}。${failurePrefix}请先检查 ${contextHint}，不要立即重复同样的调用顺序；外部进程错误先诊断 exitCode 和 stderr 再修复。`
      const proposal: EvolveProposal = {
        proposalId: proposalIdSeq(),
        runId: SelfEvolveRunId('pending'),
        level: 'L2-context',
        name: sectionName,
        purpose: `L1-skill pattern ${pattern.patternId} 的 L2 上下文修补`,
        addressesPatternIds: [pattern.patternId],
        candidate: {
          kind: 'L2-context',
          sectionName,
          sectionText,
          order: SECTION_ORDER_PATCH,
          estimatedBytes: utf8Bytes(sectionText),
        },
      }
      out.push(proposal)
      if (out.length >= this.config.maxProposalsPerLoop) break
    }
    return out
  }

  /**
   * Replay one case with the candidate applied (P1.2), via the `fork`
   * subagent provider when it is mounted. The child is seeded with the
   * parent's completed-turn prefix and instructed to re-attempt the failing
   * action under the candidate; the child's own events (after the end-seed
   * marker) are folded with the failure projection to detect retriggered
   * patterns. Returns `null` when the replay infrastructure is unavailable
   * (no subagents service, no fork provider, or no live parent agent), so
   * the weak path applies.
   *
   * @param agent - owner session and maintenance runner.
   * @param proposal - the candidate being validated.
   * @param caseText - description of the failing case to re-attempt.
   * @param signal - cancels the fork and its turn work.
   * @returns replay exit code and retriggered pattern ids, or `null` when
   *   unavailable. A non-zero exit code means the child did not complete, made
   *   no tool call, or re-triggered a failure pattern.
   */
  protected async replayCase(
    agent: SelfEvolveAgentContext,
    proposal: EvolveProposal,
    caseText: string,
    signal: AbortSignal,
  ): Promise<{ exitCode: number; retriggeredPatternIds: string[] } | null> {
    const subagents = this.ctx.get('subagents')
    const parent = this.ctx.agents.get(agent.sessionId)
    if (subagents === undefined || parent === undefined || subagents.getProvider('fork') === undefined) return null
    const run = await subagents.startActivation({
      provider: 'fork',
      label: 'self-evolve-replay',
      delivery: 'caller',
      prompt: [{
        type: 'text',
        text: `你正在验证一个自进化修补提案，请如实重放以下失败场景并应用修补方案，完成一次验证执行。\n失败场景：${caseText}\n修补方案：${candidateText(proposal)}\n请按修补方案实际执行原本失败的操作（必须真的调用工具执行，只描述结果不算验证），完成后用一句话说明结果。`,
      }],
      parent,
      signal,
    })
    try {
      const result = await run.result
      const replayAgent = this.ctx.agents.get(run.childId)
      const folded = replayAgent === undefined
        ? { retriggeredPatternIds: [], toolCalls: 0 }
        : foldChildSession(replayAgent.session)
      // A child that called no tool never re-attempted the failure, so a
      // "completed" run without a tool call is an empty replay rather than a
      // fix; it fails the gate alongside incomplete runs.
      const exitCode = result.stopReason === 'completed' && folded.toolCalls > 0 ? 0 : 1
      return { exitCode, retriggeredPatternIds: folded.retriggeredPatternIds }
    } finally {
      await run.dispose()
    }
  }

  /**
   * Replay signal for one proposal's held-in case (dual verifier A): re-attempt
   * the pattern's last supporting failure under the candidate (P1.2). Reports
   * the signal unavailable (null) when the replay infrastructure is absent.
   * L3-workflow candidates substitute the workflow smoke run (P2.1).
   */
  protected async collectReplaySignal(
    agent: SelfEvolveAgentContext,
    proposal: EvolveProposal,
    pattern: FailurePattern,
    signal: AbortSignal,
  ): Promise<{ exitCode: number; retriggeredPatternIds: string[] } | null> {
    if (proposal.candidate.kind === 'L3-workflow') {
      return this.runWorkflowSmoke(agent, proposal, signal)
    }
    const session = this.ctx.sessions.get(SessionId(agent.sessionId))
    const lastSeq = pattern.supportingSeqs[pattern.supportingSeqs.length - 1]
    const context = session === undefined || lastSeq === undefined
      ? `模式 ${pattern.patternId}（${pattern.summary}）`
      : `模式 ${pattern.patternId}（${pattern.summary}）最近一次失败事件链：${caseContextText(session, lastSeq)}`
    return this.replayCase(agent, proposal, context, signal)
  }

  /**
   * L3 workflow smoke run (Phase 2, P2.1): execute the candidate script once
   * through the workflow engine; it passes when the run completes with at
   * least one started agent. Returns null when the workflow engine or the
   * live parent agent is absent, so the weak path applies.
   */
  protected async runWorkflowSmoke(
    agent: SelfEvolveAgentContext,
    proposal: EvolveProposal,
    signal: AbortSignal,
  ): Promise<{ exitCode: number; retriggeredPatternIds: string[] } | null> {
    const candidate = proposal.candidate
    if (candidate.kind !== 'L3-workflow') return null
    const workflowEngine = this.ctx.get('workflowEngine')
    const parent = this.ctx.agents.get(agent.sessionId)
    if (workflowEngine === undefined || parent === undefined) return null
    const run = workflowEngine.start({
      script: candidate.scriptBody,
      meta: { name: candidate.scriptName, description: proposal.purpose },
      parent,
      signal,
    })
    try {
      const result = await run.result
      const passed = result.stopReason === 'completed' && result.agentsStarted >= L3_SMOKE_MIN_AGENTS
      return { exitCode: passed ? 0 : 1, retriggeredPatternIds: [] }
    } finally {
      await run.dispose()
    }
  }

  /**
   * Capture the pre-replay workspace state (P1.9b): whether the session's
   * project is a git work tree and its dirty-line count at that moment. The
   * held-in gate measures the replay's NET dirty delta against this baseline,
   * so pre-existing in-progress user changes never fail the gate and the
   * replay cannot hide its own footprint behind them.
   *
   * Returns `null` when the verifier is disabled, the shell service is absent,
   * or the session has no cwd — the workspace signal then degrades to the
   * weak path.
   */
  protected async captureWorkspaceBaseline(
    agent: SelfEvolveAgentContext,
    signal: AbortSignal,
  ): Promise<WorkspaceBaseline | null> {
    const shell = this.ctx.get('shell')
    const session = this.ctx.sessions.get(SessionId(agent.sessionId))
    if (shell === undefined || session === undefined || !this.config.workspaceVerifier.enabled) return null
    const cwd = session.header.cwd ?? process.cwd()
    const gitAvailable = await this.gitAvailable(shell, cwd, signal)
    if (!gitAvailable) return { gitAvailable: false, dirtyLines: 0 }
    const dirtyLines = await this.measureDirty(shell, cwd, signal)
    if (dirtyLines === null) return { gitAvailable: false, dirtyLines: 0 }
    return { gitAvailable: true, dirtyLines }
  }

  /**
   * Workspace signal for one proposal's held-in case (dual verifier B: git
   * dirty delta + build health, P1.9b). The signal measures the replay's net
   * dirty delta against the captured baseline and runs the configured build
   * command in the session's project; `null` (weak path) when the verifier is
   * disabled, the shell service is absent, or either dimension is
   * unavailable. Subclasses may override for project-specific build checks.
   *
   * @param agent - owner session; its cwd is the project to check.
   * @param proposal - the candidate being validated.
   * @param signal - cancels the build run; an aborted loop rethrows.
   * @param baseline - the pre-replay state captured by {@link captureWorkspaceBaseline}.
   * @returns the workspace signal, or `null` when unavailable.
   */
  protected async collectWorkspaceSignal(
    agent: SelfEvolveAgentContext,
    _proposal: EvolveProposal,
    signal: AbortSignal,
    baseline: WorkspaceBaseline | null,
  ): Promise<WorkspaceSignal | null> {
    const shell = this.ctx.get('shell')
    const session = this.ctx.sessions.get(SessionId(agent.sessionId))
    if (shell === undefined || session === undefined || !this.config.workspaceVerifier.enabled) return null
    if (baseline === null) return null
    const cwd = session.header.cwd ?? process.cwd()
    const cfg = this.config.workspaceVerifier

    let buildHealthy: boolean | null = null
    if (cfg.buildCommand !== undefined && cfg.buildCommand.length > 0) {
      const spec = shell.resolve({
        command: cfg.buildCommand,
        workdir: cwd,
        timeoutMs: cfg.buildTimeoutMs,
        signal,
      })
      try {
        const result = await (await shell.execute(spec)).result()
        if (result.aborted) throw new DOMException('aborted', 'AbortError')
        buildHealthy = result.exitCode === 0 && !result.timedOut
      } catch (error: unknown) {
        // Build infrastructure failure (missing binary, spawn error): the
        // dimension cannot be judged, so the whole signal degrades to the
        // weak path instead of guessing.
        this.ctx.logger('self-evolve').debug(`workspace verifier build failed: ${error instanceof Error ? error.message : String(error)}`)
        return null
      }
    }

    if (!baseline.gitAvailable) {
      if (buildHealthy === null) return null
      return { dirtyLines: 0, noDirtyFallback: true, buildHealthy }
    }
    if (buildHealthy === null) return null
    const dirtyLines = await this.measureDirty(shell, cwd, signal)
    if (dirtyLines === null) return null
    return { dirtyLines: Math.max(0, dirtyLines - baseline.dirtyLines), noDirtyFallback: false, buildHealthy }
  }

  /** Whether the session's project is a git work tree; command failure = unavailable. */
  private async gitAvailable(shell: ShellExecutor, cwd: string, signal: AbortSignal): Promise<boolean> {
    const result = await this.runGitCommand(shell, cwd, 'rev-parse --is-inside-work-tree', signal)
    return result?.exitCode === 0
  }

  /** Current dirty-line count, or null when a git command fails (dimension unavailable). */
  private async measureDirty(shell: ShellExecutor, cwd: string, signal: AbortSignal): Promise<number | null> {
    const numstat = await this.runGitCommand(shell, cwd, 'diff HEAD --numstat --relative', signal)
    if (numstat === null || numstat.exitCode !== 0) return null
    const untrackedLines = await this.countUntrackedLines(shell, cwd, signal)
    if (untrackedLines === null) return null
    return parseDirtyDelta(numstat.stdout.text, untrackedLines)
  }

  /** Total lines of untracked files outside `.dsh/`, bounded; null when git fails. */
  private async countUntrackedLines(shell: ShellExecutor, cwd: string, signal: AbortSignal): Promise<number | null> {
    const listed = await this.runGitCommand(shell, cwd, 'ls-files --others --exclude-standard -- .', signal)
    if (listed === null || listed.exitCode !== 0) return null
    const paths = listed.stdout.text
      .split('\n')
      .map(path => path.trim())
      .filter(path => path.length > 0 && !path.startsWith(WORKSPACE_EXCLUDED_PREFIX))
    if (paths.length === 0) return 0
    const shellQuote = (path: string): string => `'${path.replace(/'/g, "'\\''")}'`
    const quoted = paths.map(shellQuote).join(' ')
    const spec = shell.resolve({
      command: `wc -l -- ${quoted}`,
      workdir: cwd,
      timeoutMs: this.config.workspaceVerifier.gitTimeoutMs,
      signal,
      stdoutMaxBytes: GIT_OUTPUT_MAX_BYTES,
    })
    try {
      const result = await (await shell.execute(spec)).result()
      if (result.aborted) throw new DOMException('aborted', 'AbortError')
      if (result.exitCode !== 0) return null
      let total = 0
      for (const line of result.stdout.text.split('\n')) {
        const match = /^\s*(\d+)/.exec(line)
        if (match !== null) total += Number(match[1])
      }
      return Math.min(total, MAX_UNTRACKED_LINES)
    } catch (error: unknown) {
      this.ctx.logger('self-evolve').debug(`workspace verifier wc failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /** Run one read-only git command; null on infrastructure failure (git missing, spawn error). */
  private async runGitCommand(
    shell: ShellExecutor,
    cwd: string,
    args: string,
    signal: AbortSignal,
  ): Promise<ShellRunResult | null> {
    const spec = shell.resolve({
      command: `git ${args}`,
      workdir: cwd,
      timeoutMs: this.config.workspaceVerifier.gitTimeoutMs,
      signal,
      stdoutMaxBytes: GIT_OUTPUT_MAX_BYTES,
    })
    try {
      const result = await (await shell.execute(spec)).result()
      if (result.aborted) throw new DOMException('aborted', 'AbortError')
      return result
    } catch (error: unknown) {
      this.ctx.logger('self-evolve').debug(`workspace verifier git failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  /**
   * Held-out signal for one proposal (P1.3): search for events matching the
   * pattern summary (up to `maxHeldOutCases`) and replay each similar case
   * with the candidate. Sources are `heldOutSessionIds` when configured,
   * otherwise the proposing session — a same-source probe is
   * self-confirmation, which the config docstring and the package README both
   * state. Returns `null` when sessionQuery is unavailable or no similar case
   * is found, leaving the dimension unmeasured rather than passing.
   */
  protected async collectHeldOutSignal(
    agent: SelfEvolveAgentContext,
    proposal: EvolveProposal,
    pattern: FailurePattern,
    signal: AbortSignal,
  ): Promise<{ passed: number; cases: number } | null> {
    const sessionQuery = this.ctx.get('sessionQuery')
    if (sessionQuery === undefined || this.ctx.sessions.get(SessionId(agent.sessionId)) === undefined) return null
    const sources: string[] = this.config.heldOutSessionIds.length > 0
      ? this.config.heldOutSessionIds
      : [agent.sessionId]
    const hits: { seq: number; snippet: string }[] = []
    for (const source of sources) {
      const page = await sessionQuery.searchEvents({
        sessionId: SessionId(source),
        query: pattern.summary,
        limit: this.config.maxHeldOutCases,
      }, { signal })
      this.chargeBudget(utf8Bytes(pattern.summary) + page.items.length * 200)
      for (const hit of page.items) {
        // The supporting seqs are the evidence that minted this pattern, so
        // replaying them would re-test the same events. Seq numbers are
        // session-local, so the filter applies only to that same session.
        if (source === agent.sessionId && pattern.supportingSeqs.includes(hit.seq)) continue
        hits.push({ seq: hit.seq, snippet: hit.snippet })
      }
    }
    const selected = hits.slice(0, this.config.maxHeldOutCases)
    if (selected.length === 0) return null
    let passed = 0
    for (const hit of selected) {
      if (signal.aborted) throw new DOMException('aborted', 'AbortError')
      const replay = await this.replayCase(
        agent,
        proposal,
        `相似历史失败 [seq ${hit.seq}]: ${hit.snippet.slice(0, 200)}`,
        signal,
      )
      if (replay !== null && replay.exitCode === 0 && replay.retriggeredPatternIds.length === 0) passed += 1
    }
    return { passed, cases: selected.length }
  }

  /**
   * LLM judge (P1.4): four fixed-dimension structural scores for the candidate
   * given the replay evidence. Returns `null` when no `validatorTarget` is
   * configured or the llm service is unavailable; the caller then treats the
   * judge dimension as missing (weak rate) instead of scoring it favourably.
   */
  protected async _judge(
    proposal: EvolveProposal,
    evidence: ReplayEvidence[],
    signal: AbortSignal,
  ): Promise<ValidationScores | null> {
    const target = this.config.validatorTarget
    const llm = this.ctx.get('llm')
    if (target === undefined || llm === undefined) return null
    const system = '你是自进化修补提案的结构化评审员。只输出一个 JSON 对象，四个维度各给 0 到 1 之间的数字：'
      + '{"activatesWhenCorrect": 只在目标失败类上激活的准确性, "clarity": 措辞无歧义且自包含, '
      + '"noRegressionIntroduced": 未引入已观察到的回归, "safety": 不包含破坏性或过宽编辑}'
    const payload = JSON.stringify({ proposal: candidateText(proposal), evidence })
    this.chargeBudget(utf8Bytes(payload) + utf8Bytes(system))
    const text = await streamText(llm.stream({
      provider: target.provider,
      model: target.model,
      messages: [createUserMessage({
        content: [{ type: 'text', text: payload }],
        source: { kind: 'self-evolve' },
      })],
      system,
      temperature: 0,
      maxTokens: 200,
      signal,
    }))
    return parseJudgeScores(text)
  }

  /**
   * Validate one proposal through the Phase 1 pipeline: held-in dual
   * verification (when both signals are available), held-out similarity
   * replay, the LLM judge, and the aggregate confidence gate
   * `min(scores) × heldInRate × heldOutRate`.
   *
   * A dimension with no signal is capped at the weak rate (0.3) and recorded
   * in `weakDimensions`. Because any single weak dimension puts `confidence`
   * at or below 0.3 — under every positive threshold — such a proposal is
   * rejected as `verifier-unavailable` before the threshold comparison runs,
   * which distinguishes "the verifiers never judged this" from
   * `low-confidence` ("the verifiers judged it badly"). The check is ordered
   * first on purpose: lowering `minAcceptConfidence` must not convert missing
   * evidence into an acceptance.
   */
  protected async validateProposal(
    agent: SelfEvolveAgentContext,
    proposal: EvolveProposal,
    signal: AbortSignal,
  ): Promise<ProposalValidationOutcome> {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    if (proposal.candidate.kind === 'L4-harness') {
      return this.validateL4Proposal(agent, proposal, signal)
    }
    const patterns = await this.readPatterns(agent.sessionId)
    const addressed = patterns.find(pattern => pattern.patternId === proposal.addressesPatternIds[0])
    const evidence: ReplayEvidence[] = []
    // Dimensions that produced no signal. Any single one caps `confidence` at
    // the weak rate, which `minAcceptConfidence` can never accept — so a
    // rejection driven by this list means "could not be judged", never
    // "judged badly".
    const weakDimensions: string[] = []

    let heldInRate: number | null = null
    if (this.config.requireDualVerification) {
      // Sequential: the workspace signal must measure the state AFTER the
      // replay, so the baseline is captured first and the delta is the
      // replay's own footprint (P1.9b).
      const baseline = await this.captureWorkspaceBaseline(agent, signal)
      const replay = addressed !== undefined
        ? await this.collectReplaySignal(agent, proposal, addressed, signal)
        : null
      const workspace = await this.collectWorkspaceSignal(agent, proposal, signal, baseline)
      if (replay !== null && workspace !== null) {
        const held = this._verifyHeldInCase(replay, workspace)
        evidence.push({
          kind: 'held-in',
          coversPatternIds: proposal.addressesPatternIds,
          passed: held.passed,
          verifierSignal: held.reason ?? 'dual-verification',
          note: held.passed ? 'held-in 双 verifier 均通过。' : `held-in 双 verifier 拒绝（${held.reason}）。`,
        })
        if (!held.passed) {
          return {
            kind: 'rejected',
            reason: 'held-in-failed',
            heldInPassed: 0,
            regressions: [],
            replayEvidence: evidence,
            diagnostic: `held-in dual verification rejected (${held.reason})`,
            nextRoundSuggestion: '修复 held-in 重放或工作区脏状态后再重新提案。',
          }
        }
        heldInRate = 1
      } else {
        heldInRate = WEAK_VERIFIER_RATE
        weakDimensions.push('held-in')
        evidence.push({
          kind: 'held-in',
          coversPatternIds: proposal.addressesPatternIds,
          passed: false,
          verifierSignal: 'verifier-unavailable',
          note: 'held-in 双 verifier 信号不可用（重放或工作区信号缺失），按弱路径 0.3 计。',
        })
      }
    }

    let heldOutPassed = 0
    let heldOutRate = WEAK_VERIFIER_RATE
    let heldOutMeasured = false
    if (addressed !== undefined) {
      const heldOut = await this.collectHeldOutSignal(agent, proposal, addressed, signal)
      if (heldOut !== null && heldOut.cases > 0) {
        heldOutMeasured = true
        heldOutPassed = heldOut.passed
        heldOutRate = heldOut.passed / heldOut.cases
        evidence.push({
          kind: 'held-out',
          coversPatternIds: proposal.addressesPatternIds,
          passed: heldOutRate >= this.config.minHeldOutPassRate,
          verifierSignal: `held-out ${heldOut.passed}/${heldOut.cases}`,
          note: heldOutRate >= this.config.minHeldOutPassRate ? 'held-out 通过率达标。' : 'held-out 通过率不足，保守拒绝。',
        })
      }
    }
    if (!heldOutMeasured) {
      weakDimensions.push('held-out')
      evidence.push({
        kind: 'held-out',
        coversPatternIds: proposal.addressesPatternIds,
        passed: false,
        verifierSignal: 'held-out-unavailable',
        note: 'held-out 相似案例或 sessionQuery 不可用，按弱路径 0.3 计。',
      })
    }

    const judged = await this._judge(proposal, evidence, signal)
    if (judged === null) weakDimensions.push('judge')
    const scores = judged ?? WEAK_VALIDATION_SCORES
    const confidence = Math.min(scores.activatesWhenCorrect, scores.clarity, scores.noRegressionIntroduced, scores.safety)
      * (heldInRate ?? 1)
      * heldOutRate
    const heldInPassed = heldInRate === 1 ? 1 : 0
    if (weakDimensions.length > 0) {
      return {
        kind: 'rejected',
        reason: 'verifier-unavailable',
        heldInPassed,
        heldOutPassed,
        regressions: [],
        deconstructedScores: scores,
        confidence,
        replayEvidence: evidence,
        diagnostic: `验证信号不可用（${weakDimensions.join(' + ')}）：缺失维度按弱路径 ${WEAK_VERIFIER_RATE} 计，`
          + `聚合置信度上限为 ${WEAK_VERIFIER_RATE}，低于阈值 ${this.config.minAcceptConfidence}，保守拒绝。`,
        nextRoundSuggestion: '先让验证器可用（配置 workspaceVerifier.buildCommand 与 validatorTarget，'
          + '或提供可命中的 held-out 语料），再重新提案。',
      }
    }
    if (confidence >= this.config.minAcceptConfidence) {
      return {
        kind: 'accepted',
        heldInPassed,
        heldOutPassed,
        regressions: [],
        deconstructedScores: scores,
        confidence,
        replayEvidence: evidence,
        nextRoundSuggestion: '',
      }
    }
    return {
      kind: 'rejected',
      reason: 'low-confidence',
      heldInPassed,
      heldOutPassed,
      regressions: [],
      deconstructedScores: scores,
      confidence,
      replayEvidence: evidence,
      diagnostic: `confidence ${confidence.toFixed(2)} 低于阈值 ${this.config.minAcceptConfidence}`
        + `（scores=${Math.min(scores.activatesWhenCorrect, scores.clarity, scores.noRegressionIntroduced, scores.safety).toFixed(2)}, heldIn=${heldInRate ?? 1}, heldOut=${heldOutRate.toFixed(2)}）`,
      nextRoundSuggestion: '提供可复验的 held-in 重放或 held-out 证据后再重新提案。',
    }
  }

  /**
   * L4 validation (Phase 2, P2.2): define the plugin from the candidate and
   * run it through `dynamicCordisRunner`. A Client-bearing package always
   * enters the human approval flow; refusals reject the proposal, while an
   * armed run (awaiting-approval / starting / running) is accepted — the
   * activation settles asynchronously through the runner. The approval ledger
   * feeds the re-approval guard (P2.3).
   */
  protected async validateL4Proposal(
    agent: SelfEvolveAgentContext,
    proposal: EvolveProposal,
    signal: AbortSignal,
  ): Promise<ProposalValidationOutcome> {
    const runner = this.ctx.get('dynamicCordisRunner')
    const parent = this.ctx.agents.get(agent.sessionId)
    if (runner === undefined || parent === undefined) {
      return {
        kind: 'rejected',
        reason: 'approval-denied',
        regressions: [],
        diagnostic: 'L4-harness 需要 dynamicCordisRunner 服务（当前组合未挂载）。',
        nextRoundSuggestion: '在挂载 cordis-host-runner 的组合中启用 L4 提案。',
      }
    }
    const candidate = proposal.candidate
    if (candidate.kind !== 'L4-harness') {
      throw new Error('validateL4Proposal: expected an L4-harness candidate')
    }
    const receipt = runner.define({
      sessionId: agent.sessionId,
      plugin: { kind: 'new', idPrefix: candidate.pluginIdPrefix },
      name: proposal.name,
      purpose: proposal.purpose,
      code: {
        ...(candidate.hostCode !== undefined ? { host: candidate.hostCode } : {}),
        ...(candidate.clientCode !== undefined ? { client: candidate.clientCode } : {}),
      },
    })
    this.l4Pending.set(receipt.pluginId, proposal.proposalId)
    const response = await runner.run(parent, receipt.pluginId, receipt.packageId, 'run', signal)
    if (!response.ok) {
      // The run was refused before activation: drop the definition and the
      // pending marker so the registry does not accumulate orphans.
      this.l4Pending.delete(receipt.pluginId)
      await this.dropL4Plugin(SessionId(agent.sessionId), receipt.pluginId)
      return {
        kind: 'rejected',
        reason: 'approval-denied',
        regressions: [],
        diagnostic: `L4 run refused (${response.reason}): ${response.message}`,
        nextRoundSuggestion: '修复 L4 候选定义或审批路径后重新提案。',
      }
    }
    return {
      kind: 'accepted',
      heldInPassed: 0,
      heldOutPassed: 0,
      regressions: [],
      deconstructedScores: L4_APPROVAL_SCORES,
      confidence: 1,
      replayEvidence: [{
        kind: 'held-in',
        coversPatternIds: proposal.addressesPatternIds,
        passed: true,
        verifierSignal: `cordis-run-${response.status}`,
        note: `L4 提案已进入 ${response.status} 流程（激活经 runner 异步落定）。`,
      }],
      nextRoundSuggestion: '',
    }
  }

  /**
   * Held-In dual-verifier check (翁荔挑战 1): a single case only passes when BOTH
   * independent signals confirm the proposal — a) the replayed supporting seq
   * exits cleanly with no re-appearance of the same patternId, and b) the
   * build/dirty-state signal reports no workspace regression. Any mixed T+F
   * result is treated as rejected-no-regression (not counted as a future
   * pattern regression, so naive proposers cannot learn to game it).
   */
  protected _verifyHeldInCase(
    replay: { exitCode: number; retriggeredPatternIds: string[] },
    workspace: WorkspaceSignal,
  ): { passed: boolean; reason?: 'replay-failed' | 'workspace-dirty' | 'build-failed' } {
    const replayPassed = replay.exitCode === 0 && replay.retriggeredPatternIds.length === 0
    const buildPassed = workspace.buildHealthy !== false
    const dirtyPassed = workspace.noDirtyFallback
      || workspace.dirtyLines <= this.config.maxDirtyLinesAddedPerCommit
    if (replayPassed && buildPassed && dirtyPassed) return { passed: true }
    if (!replayPassed) return { passed: false, reason: 'replay-failed' }
    if (!buildPassed) return { passed: false, reason: 'build-failed' }
    return { passed: false, reason: 'workspace-dirty' }
  }

  /** Durable negative-results file under the resolved DSH home. */
  protected negativeResultsFile(): string {
    return dshHomePath('self-evolve', 'negative-results.jsonl')
  }

  /**
   * Append one rejected proposal to the durable negative-results log (P1.7b).
   * Once the log exceeds `maxNegativeResultRows`, the oldest rows are dropped
   * by an atomic under-lock rewrite so the file cannot grow without bound.
   * Failures propagate: a negative result that cannot be persisted is a
   * harness-data failure and closes the loop bracket with an error.
   *
   * @param proposal - the rejected proposal.
   * @param outcome - the rejection outcome; diagnostic and suggestion become the knowledge row.
   */
  protected async persistNegativeResult(
    proposal: EvolveProposal,
    outcome: Extract<ProposalValidationOutcome, { kind: 'rejected' }>,
  ): Promise<void> {
    const row: NegativeResultRow = {
      ts: Date.now(),
      patternId: proposal.addressesPatternIds[0] ?? '',
      proposalId: proposal.proposalId,
      reason: outcome.reason,
      diagnostic: outcome.diagnostic,
      ...(outcome.deconstructedScores !== undefined ? { deconstructedScores: outcome.deconstructedScores } : {}),
      nextRoundSuggestion: outcome.nextRoundSuggestion,
    }
    await appendJsonlCapped(this.negativeResultsFile(), [JSON.stringify(row)], this.config.maxNegativeResultRows)
  }

  /**
   * Read the most recent negative results for one pattern (P1.8 prefix feed).
   * Hot loops should call {@link readAllNegativeResults} once instead.
   *
   * @param patternId - the pattern whose failed proposals to load.
   * @param limit - maximum rows to return, most recent last.
   * @returns the matching rows; empty when the log does not exist yet.
   */
  async readNegativeResults(patternId: string, limit = NEGATIVE_RESULTS_CONTEXT_ITEMS): Promise<NegativeResultRow[]> {
    return recentNegatives(await this.readAllNegativeResults(), patternId, limit)
  }

  /** All durable negative-result rows, one cached file read (P1.7b). */
  protected async readAllNegativeResults(): Promise<NegativeResultRow[]> {
    return readJsonlRowsCached(this.negativeResultsFile(), raw => raw as NegativeResultRow)
  }

  /** Commit one accepted proposal. Base handles L1 skill and L2 prompt sections.
   * Registrations are wrapped in `ctx.effect` scoped to the provider's context; disposal
   * (on validation-failure abort, or the provider fiber unwinding) removes the runtime
   * skill or prompt section cleanly. Accepted L1 skills are additionally persisted to
   * `<project>/.dsh/skills/<name>/SKILL.md` (P1.5) and the pre-commit state is archived
   * as a rollback champion (P1.8).
   */
  protected async applyCommit(
    agent: SelfEvolveAgentContext,
    proposal: EvolveProposal,
    validation: Extract<ProposalValidationOutcome, { kind: 'accepted' }>,
  ): Promise<{ commitSeq: number }> {
    const session = this.requireSession(agent.sessionId)
    const candidate = proposal.candidate
    let undo: (() => void) | null = null
    switch (candidate.kind) {
      case 'L1-skill': {
        await this.assertL1Available(agent, candidate.skillName, proposal.proposalId)
        undo = this.registerL1Skill(candidate, proposal.purpose, 'runtime-evolve', proposal.proposalId)
        await this.persistSkillFile(agent, proposal)
        break
      }
      case 'L2-context': {
        undo = this.registerL2Section(candidate)
        break
      }
      case 'L3-workflow': {
        // The validation smoke already gated the candidate; re-running it at
        // commit time confirms the script still completes before the commit
        // event records the proposal as live.
        const smoke = await this.runWorkflowSmoke(agent, proposal, new AbortController().signal)
        if (smoke === null || smoke.exitCode !== 0) {
          throw new Error(`applyCommit: L3 workflow smoke failed (${smoke === null ? 'workflow engine unavailable' : 'run did not complete with agents'})`)
        }
        break
      }
      case 'L4-harness':
        break
      /* v8 ignore next -- candidate.kind is a closed union of the four switch cases */
      default:
        throw new Error('applyCommit: unsupported candidate kind')
    }
    let commitEvent
    try {
      commitEvent = session.append('self-evolve/commit', { runId: proposal.runId, commit: { proposal, validation } })
    } catch (error: unknown) {
      // The runtime contribution is already live; undo it before rethrowing so
      // the session never carries an un-logged behaviour change.
      undo?.()
      throw error
    }
    if (candidate.kind === 'L4-harness') {
      // The plugin was defined and run during validation; committing records
      // the accepted candidate and updates the approval ledger (P2.3).
      for (const [pluginId, proposalId] of this.l4Pending) {
        if (proposalId === proposal.proposalId) {
          this.l4Ledger.set(pluginId, { proposalId, approvedAt: Date.now() })
        }
      }
    }
    // Archive only after the commit is durable: a failed apply must never leave
    // a champion row for a candidate that never went live.
    await this.archiveChampion(proposal, commitEvent.seq)
    const patternId = proposal.addressesPatternIds[0]
    if (patternId !== undefined) this.liveByPattern.set(patternId, candidate)
    return { commitSeq: commitEvent.seq }
  }

  /**
   * Refuse an L1 candidate whose skill name another provider already owns.
   * A same-name static or filesystem skill is shadowed first-wins by the
   * registry, so registering over it would look committed while changing
   * nothing.
   */
  private async assertL1Available(agent: SelfEvolveAgentContext, skillName: string, proposalId: string): Promise<void> {
    if (!this.liveSkills.has(skillName) && this.liveSkills.size >= this.config.maxLiveSkills) {
      throw new ApplyRejectedError(
        `skill ${skillName} rejected: ${this.liveSkills.size} live self-evolve skills already reach maxLiveSkills (${this.config.maxLiveSkills})`,
      )
    }
    const session = this.requireSession(agent.sessionId)
    const cwd = session.header.cwd ?? process.cwd()
    let snapshot = await this.ctx.skills.snapshot({ cwd })
    if (!snapshot.complete) snapshot = await this.ctx.skills.snapshot({ cwd })
    if (!snapshot.complete) {
      throw new ApplyRejectedError(
        `skill ${skillName} rejected: the skill catalog did not complete a stable observation, so a name collision cannot be ruled out`,
      )
    }
    const collision = snapshot.skills.find(skill => skill.name === skillName)
    if (collision !== undefined && !this.liveSkills.has(skillName)) {
      throw new ApplyRejectedError(`skill ${skillName} rejected: another provider already owns that skill name`)
    }
    // The proposal id is recorded on the live entry; keep the parameter part of
    // the message-free contract even when no collision exists.
    void proposalId
  }

  /**
   * Persist an accepted L1 skill to `<project>/.dsh/skills/<name>/SKILL.md`
   * (P1.5) through the fs capability when it is mounted. The skill-filesystem
   * provider's file observation picks the file up on its next scan; runtime
   * registration is unaffected when fs is absent.
   */
  protected async persistSkillFile(agent: SelfEvolveAgentContext, proposal: EvolveProposal): Promise<void> {
    const fs = this.ctx.get('fs')
    if (fs === undefined) return
    const candidate = proposal.candidate
    if (candidate.kind !== 'L1-skill') return
    const session = this.requireSession(agent.sessionId)
    const cwd = session.header.cwd ?? process.cwd()
    await this.writeSkillFile(cwd, candidate.skillName, proposal.purpose, candidate.whenToUse ?? '', candidate.content)
  }

  private async writeSkillFile(
    cwd: string,
    skillName: string,
    description: string,
    whenToUse: string,
    content: string,
  ): Promise<void> {
    const fs = this.ctx.get('fs')
    if (fs === undefined) return
    const frontmatter = (value: string): string => value.replace(/\n/g, ' ')
    const text = `---\nname: ${skillName}\ndescription: ${frontmatter(description)}\nwhenToUse: ${frontmatter(whenToUse)}\n---\n\n${content}\n`
    const target = await fs.resolve(join('.dsh', 'skills', skillName, 'SKILL.md'), { cwd })
    await fs.writeText(target, text)
  }

  /**
   * Archive the state this commit replaced AFTER the commit is durable (P1.8):
   * one JSON row per proposal under
   * `$DSH_HOME/self-evolve/archive/<patternId>/<proposalId>.json`. The row's
   * `previousCandidate` is the pattern's last committed candidate (the
   * champion a rollback restores), or null on the first commit.
   */
  protected async archiveChampion(proposal: EvolveProposal, commitSeq: number): Promise<void> {
    const patternId = proposal.addressesPatternIds[0]
    if (patternId === undefined) return
    const archiveDir = dshHomePath('self-evolve', 'archive', patternId)
    const previousCandidate = await this.latestArchivedCandidate(patternId)
    const file = join(archiveDir, `${proposal.proposalId}.json`)
    const row: ChampionArchiveRow = {
      ts: Date.now(),
      patternId,
      proposalId: proposal.proposalId,
      name: proposal.name,
      commitSeq,
      candidate: proposal.candidate,
      previousCandidate,
    }
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `${JSON.stringify(row)}\n`)
  }

  /** The last committed candidate for a pattern, or null when it has none. */
  private async latestArchivedCandidate(patternId: string): Promise<EvolveProposal['candidate'] | null> {
    const row = await this.latestCommittedRow(patternId)
    return row?.candidate ?? null
  }

  /** The latest archive row that carries a durable commit seq. */
  private async latestCommittedRow(patternId: string): Promise<ChampionArchiveRow | null> {
    const row = await readLatestJsonRow(
      dshHomePath('self-evolve', 'archive', patternId),
      raw => raw as ChampionArchiveRow,
    )
    return row !== null && row.commitSeq !== undefined ? row : null
  }

  /**
   * Restore the latest archived champion candidate for a pattern after
   * repeated regressions (P1.8): re-register the state the last commit
   * replaced through the owning seam (L1 skill / L2 section) without
   * re-validating. A first commit has no champion, so an L1 rollback writes a
   * frontmatter-less tombstone that skill-filesystem ignores.
   */
  protected async rollbackPattern(patternId: string): Promise<void> {
    const row = await this.latestCommittedRow(patternId)
    if (row === null || row.previousCandidate === null) {
      const stale = this.liveByPattern.get(patternId)
      if (stale?.kind === 'L1-skill') await this.tombstoneSkill(this.rollbackCwd(), stale.skillName)
      this.liveByPattern.delete(patternId)
      return
    }
    const champion = row.previousCandidate
    const cwd = this.rollbackCwd()
    switch (champion.kind) {
      case 'L1-skill': {
        const current = this.liveSkills.get(champion.skillName)
        this.registerL1Skill(
          champion,
          current?.description ?? champion.skillName,
          'runtime-evolve-rollback',
          row.proposalId,
        )
        await this.writeSkillFile(
          cwd,
          champion.skillName,
          current?.description ?? champion.skillName,
          champion.whenToUse ?? '',
          champion.content,
        )
        break
      }
      case 'L2-context':
        this.registerL2Section(champion)
        break
      default:
        return
    }
    this.liveByPattern.set(patternId, champion)
  }

  /** Working directory for restoring a skill file; the first live session's cwd. */
  private rollbackCwd(): string {
    for (const sessionId of this.sessionRateStates.keys()) {
      const session = this.ctx.sessions.get(SessionId(sessionId))
      if (session?.header.cwd !== undefined) return session.header.cwd
    }
    return process.cwd()
  }

  /** Replace an L1 skill file with a frontmatter-less body skill-filesystem ignores. */
  private async tombstoneSkill(cwd: string, skillName: string): Promise<void> {
    const fs = this.ctx.get('fs')
    if (fs === undefined) return
    const previous = this.liveSkills.get(skillName)
    previous?.dispose()
    this.liveSkills.delete(skillName)
    const target = await fs.resolve(join('.dsh', 'skills', skillName, 'SKILL.md'), { cwd })
    await fs.writeText(target, `<!-- self-evolve rollback tombstone: ${skillName} retired at ${new Date().toISOString()} -->\n`)
  }

  /**
   * Register one runtime skill, replacing any self-evolve contribution of the
   * same name. `ctx.skills.register` is first-wins per name, so the previous
   * contribution must be disposed before the new one or the commit is a no-op.
   * Returns an undo that restores the previous contribution.
   */
  private registerL1Skill(
    candidate: Extract<EvolveProposal['candidate'], { kind: 'L1-skill' }>,
    description: string,
    source: string,
    proposalId: string,
  ): () => void {
    const previous = this.liveSkills.get(candidate.skillName)
    previous?.dispose()
    const dispose = this.ctx.skills.register({
      name: candidate.skillName,
      description,
      whenToUse: candidate.whenToUse ?? '',
      source,
      content: candidate.content,
    })
    this.liveSkills.set(candidate.skillName, { dispose, proposalId, candidate, description, source })
    return () => {
      dispose()
      this.liveSkills.delete(candidate.skillName)
      if (previous === undefined) return
      const restore = this.ctx.skills.register({
        name: previous.candidate.skillName,
        description: previous.description,
        whenToUse: previous.candidate.whenToUse ?? '',
        source: previous.source,
        content: previous.candidate.content,
      })
      this.liveSkills.set(candidate.skillName, { ...previous, dispose: restore })
    }
  }

  /**
   * Register one runtime prompt section, replacing any self-evolve section of
   * the same name. Registration happens only after the previous self-evolve
   * section is disposed; a rejected registration (a colliding static section)
   * restores the previous one before rethrowing. Returns an undo.
   */
  private registerL2Section(candidate: Extract<EvolveProposal['candidate'], { kind: 'L2-context' }>): () => void {
    const previous = this.liveSections.get(candidate.sectionName)
    previous?.dispose()
    let dispose: () => void
    try {
      dispose = this.ctx.systemPrompt.section({
        name: candidate.sectionName,
        order: candidate.order,
        text: candidate.sectionText,
      })
    } catch (error: unknown) {
      if (previous !== undefined) {
        const restore = this.ctx.systemPrompt.section({
          name: candidate.sectionName,
          order: previous.order,
          text: previous.text,
        })
        this.liveSections.set(candidate.sectionName, { ...previous, dispose: restore })
      }
      throw new ApplyRejectedError(
        `section ${candidate.sectionName} rejected: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    this.liveSections.set(candidate.sectionName, {
      text: candidate.sectionText,
      order: candidate.order,
      registeredAt: Date.now(),
      dispose,
    })
    return () => {
      dispose()
      this.liveSections.delete(candidate.sectionName)
      if (previous === undefined) return
      const restore = this.ctx.systemPrompt.section({
        name: candidate.sectionName,
        order: previous.order,
        text: previous.text,
      })
      this.liveSections.set(candidate.sectionName, { ...previous, dispose: restore })
    }
  }

  /**
   * Long-horizon prompt-inflation pruning (P1.9, 翁荔挑战 7): when live
   * self-evolve L2 sections exceed `maxPromptInflationBytesPerWeek`, archive
   * the oldest sections to `$DSH_HOME/self-evolve/l2-archive/` and dispose
   * their effects until the total is back under budget. Usage counting (7-day
   * zero-use) is approximated by age: the oldest registered sections are
   * pruned first.
   */
  protected async pruneInflatedSections(): Promise<void> {
    const budget = this.config.maxPromptInflationBytesPerWeek
    let total = 0
    for (const section of this.liveSections.values()) total += utf8Bytes(section.text)
    if (total <= budget) return
    const ordered = [...this.liveSections.entries()].sort((a, b) => a[1].registeredAt - b[1].registeredAt)
    for (const [name, section] of ordered) {
      if (total <= budget) break
      await this.archiveSection(name, section.text, section.registeredAt)
      section.dispose()
      this.liveSections.delete(name)
      total -= utf8Bytes(section.text)
    }
  }

  private async archiveSection(name: string, text: string, registeredAt: number): Promise<void> {
    // The registered-at stamp keeps a section that is pruned, re-proposed and
    // pruned again from appending to one archive file forever.
    const file = join(dshHomePath('self-evolve', 'l2-archive'), `${name}.${registeredAt}.md`)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, `${text}\n`, { flag: 'a' })
  }

  /** Count one rejected proposal for its pattern; true when rollback triggers (P1.8). */
  private trackRegression(patternId: string): boolean {
    const next = (this.regressionCounts.get(patternId) ?? 0) + 1
    this.regressionCounts.set(patternId, next)
    return next >= REGRESSION_ROLLBACK_THRESHOLD
  }

  private resetRegressions(patternId: string): void {
    this.regressionCounts.delete(patternId)
  }

  /** Charge one LLM/search byte cost against the running loop budget (P3.4).
   * Text costs must be measured in UTF-8 bytes, matching the documented byte
   * budget; `String.length` counts UTF-16 code units and under-charges CJK.
   */
  private chargeBudget(cost: number): void {
    if (this.loopBudget === null) return
    this.loopBudget.used += cost
    if (this.loopBudget.used > this.config.maxBudgetCharsPerLoop) {
      throw new DOMException(`budget-exceeded: ${this.loopBudget.used} chars over ${this.config.maxBudgetCharsPerLoop}`, 'AbortError')
    }
  }

  /** Whether the current turn contains a durable failure surface (P3.1 trigger). */
  private turnHasFailure(session: Session, turn: number): boolean {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    for (const event of session.snapshotEvents()) {
      const data = event.data as { turn?: unknown; message?: { content?: unknown }; error?: unknown }
      if (data.turn !== turn) continue
      if (event.type === 'agent/request-error') return true
      if (event.type === 'tool/result') {
        if (data.error !== undefined) return true
        if (hasShellFailureMarkers(extractText(data.message?.content))) return true
      }
    }
    return false
  }

  /**
   * Step reflection (P3.1): at most `maxStepReflectionsPerTurn` times per
   * turn, when the turn already carries a durable failure, run one
   * low-budget LLM reflection (2K input chars, 512 output tokens) that names
   * an existing pattern; confidence at or above `reflectionMinConfidence`
   * reinforces it via a `self-evolve/reflection` session event. Failures are
   * best-effort — the step pipeline never blocks on reflection.
   */
  protected async maybeReflect(agent: Agent, turn: number, step: number, signal: AbortSignal): Promise<void> {
    const session = this.ctx.sessions.get(agent.session.id)
    const llm = this.ctx.get('llm')
    if (session === undefined || llm === undefined) return
    if (agent.options.provider === undefined || agent.options.model === undefined) return
    const state = this.reflectionCounts.get(agent.session.id)
    if (state !== undefined && state.turn === turn && state.count >= this.config.maxStepReflectionsPerTurn) return
    if (!this.turnHasFailure(session, turn)) return
    const patterns = this.readProjectedPatterns(agent.session.id)
    if (patterns.length === 0) return
    const prior = state !== undefined && state.turn === turn ? state.count : 0
    this.reflectionCounts.set(agent.session.id, { turn, count: prior + 1 })
    const prompt = '你正在为一次失败的 agent 步骤做低成本反思。从以下现有失败模式中选一个最匹配的（只输出 JSON：'
      + '{"confidence": 0到1, "patternId": 精确的模式id, "suggestion": 一句修复建议}）：\n'
      + patterns.map(p => `${p.patternId}: ${p.summary}`).join('\n')
    const text = await streamText(llm.stream({
      provider: agent.options.provider,
      model: agent.options.model,
      messages: [createUserMessage({ content: [{ type: 'text', text: prompt.slice(0, REFLECTION_MAX_INPUT_CHARS) }], source: { kind: 'self-evolve' } })],
      temperature: 0,
      maxTokens: REFLECTION_MAX_OUTPUT_TOKENS,
      signal,
    }))
    const reflection = parseReflection(text)
    if (reflection === null || reflection.confidence < this.config.reflectionMinConfidence) return
    if (!patterns.some(p => p.patternId === reflection.patternId)) return
    session.append('self-evolve/reflection', {
      turn,
      step,
      patternId: reflection.patternId,
      confidence: reflection.confidence,
      suggestion: reflection.suggestion.slice(0, 200),
    })
  }

  /**
   * LLM proposer (P3.2): when `proposerTarget` is configured and the llm
   * service is mounted, generate L1/L2 proposals from the eligible patterns
   * with the JoyCode CSR experience section (`resolved <summary>` search
   * hits) and the per-pattern negative-results prefix as few-shot context.
   * Falls back to the template proposer when the route is unavailable.
   */
  protected async proposeWithLlm(
    patterns: FailurePattern[],
    levels: readonly EvolveLevel[],
    signal: AbortSignal,
    sessionId: string,
  ): Promise<EvolveProposal[]> {
    const target = this.config.proposerTarget
    const llm = this.ctx.get('llm')
    if (target === undefined || llm === undefined) return []
    const session = this.ctx.sessions.get(SessionId(sessionId))
    const section = await this.buildProposerContext(patterns, levels, session)
    if (section === null) return []
    const prompt = `你是一个自进化修补提案器。为以下失败模式生成最多 ${this.config.maxProposalsPerLoop} 个 L1-skill 或 L2-context 修补提案。`
      + '只输出 JSON 数组：[{"name","purpose","addressesPatternIds":["patternId"],"candidate":{"kind":"L1-skill","skillName","content","whenToUse"?} 或 {"kind":"L2-context","sectionName","sectionText","order":260}}]。'
      + '\n\n' + section
    this.chargeBudget(utf8Bytes(prompt))
    const text = await streamText(llm.stream({
      provider: target.provider,
      model: target.model,
      messages: [createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'self-evolve' } })],
      temperature: 0.4,
      maxTokens: 1024,
      signal,
    }))
    return parseLlmProposals(text).slice(0, this.config.maxProposalsPerLoop)
  }

  /** Assemble the proposer context: patterns, negative results, and CSR hits (P3.2). */
  private async buildProposerContext(
    patterns: FailurePattern[],
    levels: readonly EvolveLevel[],
    session: Session | undefined,
  ): Promise<string | null> {
    if (levels.length === 0) return null
    const allNegatives = await this.readAllNegativeResults()
    const sections: string[] = []
    for (const pattern of patterns.slice(0, this.config.maxProposalsPerLoop * 2)) {
      const failed = recentNegatives(allNegatives, pattern.patternId, NEGATIVE_RESULTS_CONTEXT_ITEMS)
      let block = `模式 ${pattern.patternId}（${pattern.summary}，occurrences=${pattern.occurrences}）`
      if (failed.length > 0) {
        block += `\n此前 ${failed.length} 次提案被拒：${failed.map(f => `${f.reason}: ${f.nextRoundSuggestion}`).join('; ')}`
      }
      const sessionQuery = this.ctx.get('sessionQuery')
      if (sessionQuery !== undefined && session !== undefined) {
        // JoyCode CSR experience section: how similar failures were actually resolved.
        const page = await sessionQuery.searchEvents({ sessionId: session.id, query: `resolved ${pattern.summary}`, limit: 3 })
        if (page.items.length > 0) {
          block += `\n相似问题解决经验：${page.items.map(hit => `[seq ${hit.seq}] ${hit.snippet.slice(0, 160)}`).join(' | ')}`
        }
        this.chargeBudget(page.items.length * 200)
      }
      sections.push(block)
    }
    return sections.join('\n\n')
  }

  /**
   * Per-session per-pattern freeze (P3.3): count proposals per pattern and
   * freeze a pattern for `patternFreezeHours` once it has been proposed
   * twice; the third targeting attempt skips it. The count decays with the
   * freeze window, so a pattern proposed again after an expired freeze
   * restarts at one. Each session's counters are bounded by
   * `maxTrackedPatternsPerSession`, evicting the least recently proposed
   * pattern, so a long session cannot grow the map without limit.
   */
  private markProposed(sessionId: string, patternId: string): void {
    let counts = this.proposalCounts.get(sessionId)
    if (counts === undefined) {
      counts = new Map()
      this.proposalCounts.set(sessionId, counts)
    }
    const windowMs = this.config.patternFreezeHours * 3_600_000
    const prior = counts.get(patternId)
    const count = prior === undefined || Date.now() - prior.at > windowMs ? 1 : prior.count + 1
    counts.set(patternId, { count, at: Date.now() })
    if (count >= 2) {
      const state = this.rateState(sessionId)
      state.frozenPatterns.set(patternId, Date.now() + windowMs)
      counts.delete(patternId)
    }
    const overflow = counts.size - this.config.maxTrackedPatternsPerSession
    if (overflow > 0) {
      const stale = [...counts.entries()]
        .sort((a, b) => a[1].at - b[1].at)
        .slice(0, overflow)
      for (const [staleId] of stale) counts.delete(staleId)
    }
  }

  /**
   * Append the run's patterns to the cross-session global log (P4.1), keeping
   * only the last `maxGlobalPatternRows` rows so the file stays bounded.
   */
  protected async persistGlobalPatterns(agent: SelfEvolveAgentContext, patterns: FailurePattern[]): Promise<void> {
    if (patterns.length === 0) return
    const file = dshHomePath('self-evolve', 'global-patterns.jsonl')
    const rows = patterns.map(p => JSON.stringify({
      ts: Date.now(),
      sessionId: agent.sessionId,
      patternId: p.patternId,
      occurrences: p.occurrences,
    }))
    await appendJsonlCapped(file, rows, this.config.maxGlobalPatternRows)
  }

  /** Cross-session occurrences for a session's patterns within the 24h window (P4.2). */
  protected async readGlobalPatternOccurrences(sessionId: string): Promise<Map<string, number>> {
    const rows = await readJsonlRowsCached(
      dshHomePath('self-evolve', 'global-patterns.jsonl'),
      raw => raw as { ts: number; sessionId: string; patternId: string; occurrences: number },
    )
    const cutoff = Date.now() - GLOBAL_PATTERN_WINDOW_MS
    const merged = new Map<string, number>()
    for (const row of rows) {
      if (row.ts < cutoff || row.sessionId === sessionId) continue
      merged.set(row.patternId, (merged.get(row.patternId) ?? 0) + row.occurrences)
    }
    return merged
  }

  private rateState(sessionId: string): SessionRateState {
    const existing = this.sessionRateStates.get(sessionId)
    if (existing !== undefined) {
      existing.touchedAt = Date.now()
      return existing
    }
    const created: SessionRateState = {
      loopStarts: [],
      lastStartByTrigger: {},
      frozenPatterns: new Map(),
      touchedAt: Date.now(),
    }
    this.sessionRateStates.set(sessionId, created)
    this.evictSessionState()
    return created
  }

  /** Keep the per-session rate/reflection maps bounded by least-recent use. */
  private evictSessionState(): void {
    const overflow = this.sessionRateStates.size - this.config.maxTrackedSessions
    if (overflow <= 0) return
    const oldest = [...this.sessionRateStates.entries()]
      .sort((a, b) => a[1].touchedAt - b[1].touchedAt)
      .slice(0, overflow)
    for (const [sessionId] of oldest) {
      this.sessionRateStates.delete(sessionId)
      this.reflectionCounts.delete(sessionId)
      this.regressionCounts.delete(sessionId)
      this.proposalCounts.delete(sessionId)
      for (const key of this.retryCounts.keys()) {
        if (key.startsWith(`${sessionId}:`)) this.retryCounts.delete(key)
      }
    }
  }

  private async filterEligiblePatterns(sessionId: string): Promise<FailurePattern[]> {
    const all = await this.readPatterns(sessionId)
    const state = this.rateState(sessionId)
    const now = Date.now()
    return eligiblePatterns(all, this.config.minPatternOccurrences)
      .filter((pattern) => {
        const frozenUntil = state.frozenPatterns.get(pattern.patternId)
        return frozenUntil === undefined || frozenUntil <= now
      })
  }

  private isAutonomousTrigger(trigger: EvolveTrigger): boolean {
    return trigger === 'idle-maintenance' || trigger === 'pressure' || trigger === 'validation-retry'
  }

  private recentLoopCount(state: SessionRateState): number {
    const cutoff = Date.now() - DAILY_WINDOW_MS
    state.loopStarts = state.loopStarts.filter(timestamp => timestamp > cutoff)
    return state.loopStarts.length
  }

  /**
   * Reserve the agent's maintenance phase synchronously, then mine and run.
   * The reservation happens before the first `await` so a turn that starts
   * concurrently cannot claim the agent between mining and the loop.
   */
  private async runLoop(
    agent: SelfEvolveAgentContext,
    trigger: EvolveTrigger,
    mine: () => Promise<FailurePattern[]>,
    levels: readonly EvolveLevel[],
    signal: AbortSignal,
    skipWhenEmpty: boolean,
  ): Promise<SelfEvolveResult | null> {
    if (this.inFlight.has(agent.sessionId)) return null
    this.inFlight.set(agent.sessionId, trigger)
    const runId = runIdSeq()
    try {
      return await agent.runMaintenance(async (maintenanceSignal) => {
        const patterns = await mine()
        if (skipWhenEmpty && patterns.length === 0) return null
        // Rate-limit accounting only counts runs that actually mined patterns;
        // a busy agent or an empty mining result must not consume the daily cap.
        const state = this.rateState(agent.sessionId)
        state.loopStarts.push(Date.now())
        state.lastStartByTrigger[trigger] = Date.now()
        const combined = AbortSignal.any([signal, maintenanceSignal])
        return this.executeLoop(runId, agent, trigger, patterns, levels.slice(), combined)
      })
    } finally {
      this.inFlight.delete(agent.sessionId)
    }
  }

  /** Session-level FIFO queue; higher-priority triggers are served first. */
  private queueFor(sessionId: string): QueuedEvolveRequest[] {
    const existing = this.evolveQueues.get(sessionId)
    if (existing !== undefined) return existing
    const created: QueuedEvolveRequest[] = []
    this.evolveQueues.set(sessionId, created)
    return created
  }

  private enqueueFor(
    sessionId: string,
    trigger: EvolveTrigger,
    levels: readonly EvolveLevel[],
    explicit: boolean,
  ): EvolveRequestReceipt {
    const queue = this.queueFor(sessionId)
    const key = [...levels].sort().join(',')
    if (explicit) {
      const existing = queue.findIndex(request => request.explicit && [...request.levels].sort().join(',') === key)
      const coalesced = queue[existing]
      if (coalesced !== undefined) {
        return { requestId: coalesced.requestId, status: 'coalesced', queuePosition: existing + 1 }
      }
    }
    if (queue.length >= this.config.maxPendingEvolveRequests) {
      const victim = queue.findIndex(request => !request.explicit)
      const dropped = queue[victim]
      if (dropped !== undefined) {
        queue.splice(victim, 1)
        this.ctx.logger('self-evolve').debug(`evolve queue full; dropped autonomous request ${dropped.requestId}`)
      } else if (!explicit) {
        // An all-explicit queue never drops an explicit request; the autonomous
        // request is the one that yields.
        this.ctx.logger('self-evolve').debug(`evolve queue full of explicit requests; dropped ${trigger}`)
        return { requestId: '', status: 'coalesced', queuePosition: queue.length }
      }
    }
    const request: QueuedEvolveRequest = { requestId: requestIdSeq(), trigger, levels: [...levels], explicit }
    queue.push(request)
    return { requestId: request.requestId, status: 'queued', queuePosition: queue.length }
  }

  private enqueue(agent: Agent, trigger: EvolveTrigger, levels: readonly EvolveLevel[], explicit: boolean): void {
    this.enqueueFor(agent.session.id, trigger, levels, explicit)
    void this.drain(agent)
  }

  private nextQueued(sessionId: string): QueuedEvolveRequest | undefined {
    const queue = this.evolveQueues.get(sessionId)
    if (queue === undefined || queue.length === 0) return undefined
    // The strict comparison keeps the earlier entry on a tie, so requests that
    // share a trigger priority stay in arrival order.
    const best = queue.reduce((left, right) =>
      TRIGGER_PRIORITY[right.trigger] < TRIGGER_PRIORITY[left.trigger] ? right : left)
    queue.splice(queue.indexOf(best), 1)
    return best
  }

  /**
   * Serve at most one queued request (or the idle policy when the queue is
   * empty), then re-enter once to pick up work queued while it ran. Every
   * rejected start is contained here: an idle listener must never throw into
   * the dispatch path.
   */
  private async drain(agent: Agent): Promise<void> {
    const sessionId = agent.session.id
    if (this.inFlight.has(sessionId)) return
    if (agent.status !== 'idle') return
    const queued = this.nextQueued(sessionId)
    let ran = false
    try {
      if (queued === undefined) {
        await this.runIdleMaintenance(agent)
      } else {
        ran = true
        const result = await this.runLoop(
          this.agentContext(agent),
          queued.trigger,
          () => this.filterEligiblePatterns(sessionId),
          queued.levels,
          new AbortController().signal,
          queued.trigger !== 'user-command',
        )
        if (queued.explicit && this.config.notifyOnExplicitRun && result !== null) {
          this.notifyExplicitRun(agent, result)
        }
      }
    } catch (error: unknown) {
      this.ctx.logger('self-evolve').warn(
        `${queued?.trigger ?? 'idle-maintenance'} loop failed: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      if (ran) void this.drain(agent)
    }
  }

  /** Idle-maintenance policy pass; the queue is empty at this point. */
  private async runIdleMaintenance(agent: Agent): Promise<void> {
    if (!this.config.triggers['idle-maintenance'].enabled) return
    if (!this.autonomousRunsAllowed()) {
      this.ctx.logger('self-evolve').debug(
        'idle-maintenance skipped: no verifier is configured and allowUnverifiedAutonomousRuns is false',
      )
      return
    }
    await this.evolveIfNeeded(this.agentContext(agent), 'idle-maintenance', new AbortController().signal)
  }

  /** Whether an unattended loop can produce a verified commit in this deployment. */
  private autonomousRunsAllowed(): boolean {
    if (this.config.allowUnverifiedAutonomousRuns) return true
    return this.config.validatorTarget !== undefined
      && this.config.workspaceVerifier.enabled
      && this.config.workspaceVerifier.buildCommand !== undefined
  }

  private agentContext(agent: Agent): SelfEvolveAgentContext {
    return {
      sessionId: agent.session.id,
      options: agent.options,
      runMaintenance: agent.runMaintenance.bind(agent),
    }
  }

  /** Fork and subagent sessions inherit a parent's history; they never evolve it. */
  private isSubagentSession(session: Session): boolean {
    const header = session.header
    return header.origin === 'subagent'
      || header.parentSession !== undefined
      || (header.delegationDepth ?? 0) > 0
  }

  /** Follow-up summary for a completed explicit request (autonomous runs stay silent). */
  private notifyExplicitRun(agent: Agent, result: SelfEvolveResult): void {
    const committed = result.commits.length
    const rejected = result.proposals.length - committed
    const text = `self-evolve 完成：run ${String(result.runId)} 挖掘 ${result.patterns.length} 个失败模式，`
      + `提案 ${result.proposals.length} 个，提交 ${committed} 个，未通过 ${rejected} 个。`
    try {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'self-evolve' } }))
    } catch (error: unknown) {
      this.ctx.logger('self-evolve').debug(`explicit-run follow-up skipped: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Dispose every runtime contribution this provider registered. */
  private disposeLiveContributions(): void {
    for (const skill of this.liveSkills.values()) skill.dispose()
    this.liveSkills.clear()
    for (const section of this.liveSections.values()) section.dispose()
    this.liveSections.clear()
  }

  private async executeLoop(
    runId: SelfEvolveRunId,
    agent: SelfEvolveAgentContext,
    trigger: EvolveTrigger,
    patterns: FailurePattern[],
    levels: EvolveLevel[],
    signal: AbortSignal,
  ): Promise<SelfEvolveResult> {
    const session = this.requireSession(agent.sessionId)
    const targeting = patterns.slice(0, this.config.maxProposalsPerLoop).map(p => p.patternId)
    const committed: EvolveCommit[] = []
    let proposals: EvolveProposal[] = []
    let startSeq = 0
    let started = false
    let ended = false
    this.loopBudget = { used: 0 }
    try {
      const startEvent = session.append('self-evolve/start', { runId, sessionId: agent.sessionId, trigger, startedAt: Date.now(), levels, targeting })
      startSeq = startEvent.seq
      started = true
      this.ctx.emit('self-evolve-loop/start', { runId, trigger })
      session.append('self-evolve/mined', {
        runId,
        patterns: patterns.map(p => ({
          patternId: p.patternId,
          verifierTier: p.verifierTier,
          causalSignature: p.causalSignature,
          level: p.level,
          summary: p.summary,
          occurrences: p.occurrences,
          supportingSeqs: p.supportingSeqs,
          verifierMeta: p.verifierMeta,
        })),
        targeting,
      })
      if (signal.aborted) throw new DOMException('aborted', 'AbortError')
      // Long-horizon prompt-inflation guard (P1.9): prune before mining so the
      // loop never proposes while the prompt budget is already over.
      await this.pruneInflatedSections()
      const agentOptions = { ...agent.options }
      if (this.config.proposerTarget !== undefined) {
        agentOptions.provider = this.config.proposerTarget.provider
        agentOptions.model = this.config.proposerTarget.model
      }
      const proposalsRaw = await this.proposeForPatterns(patterns, levels, agentOptions, signal, agent.sessionId)
      proposals = proposalsRaw
        .map(p => ({ ...p, runId }))
        .slice(0, this.config.maxProposalsPerLoop)
      for (const proposal of proposals) {
        // Per-pattern freeze accounting (P3.3): two proposals freeze a pattern.
        const addressed = proposal.addressesPatternIds[0]
        if (addressed !== undefined) this.markProposed(agent.sessionId, addressed)
        session.append('self-evolve/proposed', { runId, proposal })
        const outcome = await this.validateProposal(agent, proposal, signal)
        if (outcome.kind !== 'accepted') {
          session.append('self-evolve/validated', { runId, proposalId: proposal.proposalId, outcome })
          await this.settleRejected(agent, proposal, outcome)
          continue
        }
        let commitResult: { commitSeq: number }
        try {
          commitResult = await this.applyCommit(agent, proposal, outcome)
        } catch (error: unknown) {
          if (!(error instanceof ApplyRejectedError)) throw error
          const rejection = applyRejected(outcome, error)
          session.append('self-evolve/validated', { runId, proposalId: proposal.proposalId, outcome: rejection })
          await this.settleRejected(agent, proposal, rejection)
          continue
        }
        session.append('self-evolve/validated', { runId, proposalId: proposal.proposalId, outcome })
        this.resetRegressions(proposal.addressesPatternIds[0] ?? '')
        this.clearRetry(agent.sessionId, proposal.addressesPatternIds[0])
        committed.push({ proposal, validation: outcome, commitSeq: commitResult.commitSeq })
      }
      // Cross-session global pattern log (P4.1): recorded before the end event
      // so a fresh session can meet thresholds earlier (P4.2).
      await this.persistGlobalPatterns(agent, patterns)
      const endEvent = session.append('self-evolve/end', {
        runId,
        committedProposalIds: committed.map(c => c.proposal.proposalId),
        endedAt: Date.now(),
      })
      ended = true
      this.ctx.emit('self-evolve-loop/end', { runId })
      return {
        runId,
        trigger,
        patterns,
        proposals,
        commits: committed,
        startSeq,
        endSeq: endEvent.seq,
      }
    } catch (error: unknown) {
      const diagnostic = error instanceof Error ? error.stack ?? error.message : String(error)
      if (started && !ended) {
        // Best-effort bracket close: a failed append must not replace the
        // original error, which is what the caller needs to see.
        try {
          session.append('self-evolve/end', {
            runId,
            committedProposalIds: committed.map(c => c.proposal.proposalId),
            error: diagnostic,
            endedAt: Date.now(),
          })
          ended = true
        } catch (appendError: unknown) {
          this.ctx.logger('self-evolve').debug(
            `self-evolve/end append failed: ${appendError instanceof Error ? appendError.message : String(appendError)}`,
          )
        }
        try {
          this.ctx.emit('self-evolve-loop/end', { runId, error: diagnostic })
        } catch (emitError: unknown) {
          this.ctx.logger('self-evolve').debug(
            `self-evolve-loop/end emit failed: ${emitError instanceof Error ? emitError.message : String(emitError)}`,
          )
        }
      }
      throw error
    } finally {
      this.loopBudget = null
    }
  }

  /** Record one rejected proposal and its rollback/retry follow-ups. */
  private async settleRejected(
    agent: SelfEvolveAgentContext,
    proposal: EvolveProposal,
    outcome: Extract<ProposalValidationOutcome, { kind: 'rejected' }>,
  ): Promise<void> {
    await this.persistNegativeResult(proposal, outcome)
    const patternId = proposal.addressesPatternIds[0]
    if (patternId === undefined) return
    if (this.trackRegression(patternId)) {
      await this.rollbackPattern(patternId)
      this.resetRegressions(patternId)
    }
    this.maybeQueueRetry(agent, patternId, outcome)
  }

  /**
   * Validation-retry producer: a `low-confidence` rejection of a fully
   * configured deployment queues one bounded retry for the pattern. Every
   * other reason (including `verifier-unavailable`, which means "could not be
   * judged") stays terminal.
   */
  private maybeQueueRetry(
    agent: SelfEvolveAgentContext,
    patternId: string,
    outcome: Extract<ProposalValidationOutcome, { kind: 'rejected' }>,
  ): void {
    if (outcome.reason !== 'low-confidence') return
    if (this.config.proposerTarget === undefined) return
    if (!this.config.triggers['validation-retry'].enabled) return
    if (!this.autonomousRunsAllowed()) return
    const state = this.rateState(agent.sessionId)
    const frozenUntil = state.frozenPatterns.get(patternId)
    if (frozenUntil !== undefined && frozenUntil > Date.now()) return
    const key = `${agent.sessionId}:${patternId}`
    const used = this.retryCounts.get(key) ?? 0
    if (used >= this.config.maxValidationRetriesPerPattern) return
    const receipt = this.enqueueFor(agent.sessionId, 'validation-retry', this.config.defaultLevels, false)
    if (receipt.status !== 'queued') return
    if (this.sessionRetryKeys(agent.sessionId) >= this.config.maxTrackedPatternsPerSession) {
      // An untracked retry would be unlimited; drop it instead of growing the map.
      this.ctx.logger('self-evolve').debug(`validation-retry skipped for ${patternId}: retry map at maxTrackedPatternsPerSession`)
      return
    }
    this.retryCounts.set(key, used + 1)
  }

  private sessionRetryKeys(sessionId: string): number {
    let count = 0
    for (const key of this.retryCounts.keys()) if (key.startsWith(`${sessionId}:`)) count += 1
    return count
  }

  private clearRetry(sessionId: string, patternId: string | undefined): void {
    if (patternId === undefined) return
    this.retryCounts.delete(`${sessionId}:${patternId}`)
  }

  private requireSession(sessionId: string): Session {
    const session = this.ctx.sessions.get(SessionId(sessionId))
    if (session === undefined) throw new Error(`self-evolve: unknown sessionId ${sessionId}`)
    return session
  }
}

export default BasicSelfEvolveEngine
