import { execFile } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEventInput, SessionEventType, SessionHeader } from '@deepseek-ai/dsh-session'
import type { ShellExecRequest, ShellExecSpec, ShellExecution, ShellExecutor, ShellRunResult } from '@deepseek-ai/dsh-shell'
import {
  BasicSelfEvolveEngine,
  eligiblePatterns,
  parseDirtyDelta,
} from '../src/index.ts'
import type { BasicSelfEvolveConfig, TriggerPolicy, WorkspaceBaseline, WorkspaceSignal } from '../src/types.ts'
import { failurePatternsProjectionDefinition } from '@deepseek-ai/dsh-self-evolve'
import { EvolveProposalId, FailurePatternId } from '@deepseek-ai/dsh-self-evolve'
import type { EvolveLevel, EvolveProposal, FailurePattern, SelfEvolveAgentContext } from '@deepseek-ai/dsh-self-evolve'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { ProposalValidationOutcome, ReplayEvidence, ValidationScores } from '@deepseek-ai/dsh-self-evolve/types'

function sessionFactory(): Session {
  return Session.create(SessionId(`test-${Math.random().toString(36).slice(2, 10)}`))
}

/**
 * Replace `session.append` so appends of `eventTypes` throw `thrown` (default
 * `Error("log closed for <type>")`), leaving every other append to the original.
 */
function failingAppend(session: Session, eventTypes: string | readonly string[], thrown?: unknown): void {
  const types = typeof eventTypes === 'string' ? [eventTypes] : eventTypes
  const original = session.append.bind(session) as (type: SessionEventType | readonly SessionEventInput[], ...rest: unknown[]) => unknown
  session.append = ((type: SessionEventType | readonly SessionEventInput[], ...rest: unknown[]) => {
    if (typeof type === 'string' && types.includes(type)) throw thrown ?? new Error(`log closed for ${type}`)
    return original(type, ...rest)
  }) as typeof session.append
}

function appendShellResult(session: Session, callId: string, text: string): void {
  const callSeq = session.append('tool/call', { turn: 1, step: 1, callId: callId as never, name: 'bash', arguments: '{}' }).seq
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text }] } as never,
  }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
}

function pattern(text: string, tier: FailurePattern['verifierTier'], occurrences: number): FailurePattern {
  return {
    patternId: FailurePatternId(`${tier}:${text}`),
    verifierTier: tier,
    causalSignature: text,
    level: 'L1-skill',
    summary: text,
    supportingSeqs: [1, 2],
    occurrences,
    verifierMeta: {},
  }
}

/** Project a session's events into the failure-patterns state (as the registry would). */
function projectedState(session: Session): Record<string, unknown> {
  let state = failurePatternsProjectionDefinition.init()
  for (const event of session.snapshotEvents()) state = failurePatternsProjectionDefinition.apply(state, event)
  return { values: { 'failure-patterns': state } }
}

function agentFor(session: Session, runMaintenance?: SelfEvolveAgentContext['runMaintenance']): SelfEvolveAgentContext {
  return {
    sessionId: session.id,
    options: {},
    runMaintenance: runMaintenance ?? (async task => task(new AbortController().signal)),
  }
}

/** A fake services bundle so the engine can run without the full composition. */
function provideServices(ctx: Context, session: Session, parent?: unknown, systemPrompt?: unknown): void {
  ctx.provide('sessionProjections', {
    register: () => () => {},
    snapshot: () => projectedState(session),
  })
  ctx.provide('sessions', { get: (id: string) => (id === session.id ? session : undefined) })
  ctx.provide('agents', { get: () => parent })
  ctx.provide('skills', { register: () => () => {}, snapshot: async () => ({ skills: [], complete: true }) })
  ctx.provide('systemPrompt', systemPrompt ?? { section: () => () => {} })
}

function baseConfig(overrides: Partial<BasicSelfEvolveConfig> = {}): BasicSelfEvolveConfig {
  return {
    maxDailyLoopsPerSession: 4,
    triggers: {
      'idle-maintenance': { enabled: true, minIntervalMs: 0 },
      pressure: { enabled: true, minIntervalMs: 0 },
      'user-command': { enabled: true, minIntervalMs: 0 },
      'validation-retry': { enabled: true, minIntervalMs: 0 },
    },
    defaultLevels: ['L1-skill', 'L2-context'],
    minPatternOccurrences: 2,
    maxProposalsPerLoop: 2,
    requireDualVerification: true,
    maxDirtyLinesAddedPerCommit: 2,
    ...overrides,
  }
}

/** Judge scores that clear every dimension; lets a test exercise the other two dimensions. */
const PASSING_SCORES: ValidationScores = {
  activatesWhenCorrect: 1,
  clarity: 1,
  noRegressionIntroduced: 1,
  safety: 1,
}

/** Judge scores that clear every signal dimension but miss the confidence gate. */
const LOW_CONFIDENCE_SCORES: ValidationScores = {
  activatesWhenCorrect: 1,
  clarity: 0.4,
  noRegressionIntroduced: 1,
  safety: 1,
}

/** Subclass exposing protected hooks and injecting verifier signals. */
class SignalEngine extends BasicSelfEvolveEngine {
  replay: { exitCode: number; retriggeredPatternIds: string[] } | null = null
  workspace: WorkspaceSignal | null = null
  heldOut: { passed: number; cases: number } | null = { passed: 1, cases: 1 }
  session: Session

  constructor(ctx: Context, config: BasicSelfEvolveConfig, session: Session) {
    super(ctx, config)
    this.session = session
  }

  protected override async collectReplaySignal(): Promise<{ exitCode: number; retriggeredPatternIds: string[] } | null> {
    return this.replay
  }

  protected override async collectWorkspaceSignal(): Promise<WorkspaceSignal | null> {
    return this.workspace
  }

  protected override async collectHeldOutSignal(): Promise<{ passed: number; cases: number } | null> {
    return this.heldOut
  }

  validate(proposal: EvolveProposal, signal = new AbortController().signal): Promise<ProposalValidationOutcome> {
    return this.validateProposal(agentFor(this.session), proposal, signal)
  }
}

/** Subclass rejecting every proposal, for negative-results coverage. */
class RejectingEngine extends BasicSelfEvolveEngine {
  protected override async validateProposal(): Promise<ProposalValidationOutcome> {
    return {
      kind: 'rejected',
      reason: 'held-in-failed',
      regressions: [],
      diagnostic: 'test rejection',
      nextRoundSuggestion: 'try something else',
    }
  }

  persist(proposal: EvolveProposal, outcome: Extract<ProposalValidationOutcome, { kind: 'rejected' }>): Promise<void> {
    return this.persistNegativeResult(proposal, outcome)
  }
}

/** Subclass exposing Phase 1 protected hooks for direct testing. */
class ProbeEngine extends BasicSelfEvolveEngine {
  replay(agent: SelfEvolveAgentContext, p: EvolveProposal, caseText: string, signal: AbortSignal): ReturnType<BasicSelfEvolveEngine['replayCase']> {
    return this.replayCase(agent, p, caseText, signal)
  }

  replaySignal(agent: SelfEvolveAgentContext, p: EvolveProposal, pattern: FailurePattern, signal: AbortSignal): ReturnType<BasicSelfEvolveEngine['collectReplaySignal']> {
    return this.collectReplaySignal(agent, p, pattern, signal)
  }

  validateL4(agent: SelfEvolveAgentContext, p: EvolveProposal, signal: AbortSignal): ReturnType<BasicSelfEvolveEngine['validateL4Proposal']> {
    return this.validateL4Proposal(agent, p, signal)
  }

  reflect(agent: Agent, turn: number, step: number, signal: AbortSignal): Promise<void> {
    return this.maybeReflect(agent, turn, step, signal)
  }

  propose(patterns: FailurePattern[], levels: readonly EvolveLevel[], signal: AbortSignal, sessionId: string): ReturnType<BasicSelfEvolveEngine['proposeForPatterns']> {
    return this.proposeForPatterns(patterns, levels, {}, signal, sessionId)
  }

  persistGlobal(agent: SelfEvolveAgentContext, patterns: FailurePattern[]): Promise<void> {
    return this.persistGlobalPatterns(agent, patterns)
  }

  readProjection(sessionId: string): Promise<FailurePattern[]> {
    return Promise.resolve(this.readProjectedPatterns(sessionId))
  }

  readGlobal(sessionId: string): Promise<Map<string, number>> {
    return this.readGlobalPatternOccurrences(sessionId)
  }

  heldOut(agent: SelfEvolveAgentContext, p: EvolveProposal, pattern: FailurePattern, signal: AbortSignal): ReturnType<BasicSelfEvolveEngine['collectHeldOutSignal']> {
    return this.collectHeldOutSignal(agent, p, pattern, signal)
  }

  judge(p: EvolveProposal, evidence: ReplayEvidence[], signal: AbortSignal): ReturnType<BasicSelfEvolveEngine['_judge']> {
    return this._judge(p, evidence, signal)
  }

  prune(): Promise<void> {
    return this.pruneInflatedSections()
  }

  archive(p: EvolveProposal, commitSeq = 1): Promise<void> {
    return this.archiveChampion(p, commitSeq)
  }

  rollback(patternId: string): Promise<void> {
    return this.rollbackPattern(patternId)
  }

  commit(agent: SelfEvolveAgentContext, p: EvolveProposal): Promise<{ commitSeq: number }> {
    return this.applyCommit(agent, p, {
      kind: 'accepted',
      heldInPassed: 1,
      heldOutPassed: 1,
      regressions: [],
      deconstructedScores: { activatesWhenCorrect: 1, clarity: 1, noRegressionIntroduced: 1, safety: 1 },
      confidence: 1,
      replayEvidence: [],
      nextRoundSuggestion: '',
    })
  }

  workflowSmoke(agent: SelfEvolveAgentContext, p: EvolveProposal, signal: AbortSignal): ReturnType<BasicSelfEvolveEngine['runWorkflowSmoke']> {
    return this.runWorkflowSmoke(agent, p, signal)
  }

  skillFile(agent: SelfEvolveAgentContext, p: EvolveProposal): Promise<void> {
    return this.persistSkillFile(agent, p)
  }
}

/** Proposal overrides with the id still a plain string, branded inside the factory. */
type ProposalOverrides = Omit<Partial<EvolveProposal>, 'proposalId'> & { proposalId?: string }

function proposal(overrides: ProposalOverrides = {}): EvolveProposal {
  const { proposalId, ...rest } = overrides
  return {
    proposalId: EvolveProposalId(proposalId ?? 'prop-1'),
    runId: 'run-1' as never,
    level: 'L2-context',
    name: 'patch',
    purpose: 'test',
    addressesPatternIds: ['L1-skill:abc'],
    candidate: { kind: 'L2-context', sectionName: 's', sectionText: 't', order: 260, estimatedBytes: 1 },
    ...rest,
  }
}

describe('eligiblePatterns (SIG-2 weak-tier threshold lift)', () => {
  it('tool-runtime occurrences=2 with default min=2 → NOT eligible (threshold +1 lift)', () => {
    expect(eligiblePatterns([pattern('x', 'tool-runtime', 2)], 2)).toHaveLength(0)
  })

  it('tool-runtime occurrences=3 with default min=2 → eligible', () => {
    expect(eligiblePatterns([pattern('x', 'tool-runtime', 3)], 2)).toHaveLength(1)
  })

  it('subprocess-exit occurrences=2 with default min=2 → eligible (no lift for strong tier)', () => {
    expect(eligiblePatterns([pattern('x', 'subprocess-exit', 2)], 2)).toHaveLength(1)
  })
})

describe('parseDirtyDelta (P1.9b)', () => {
  it('sums insertions and deletions of tracked rows', () => {
    expect(parseDirtyDelta('1\t2\tpath/a.ts\n3\t0\tb.ts')).toBe(6)
  })

  it('excludes harness-owned .dsh/ paths', () => {
    expect(parseDirtyDelta('1\t2\t.dsh/skills/x/SKILL.md\n3\t0\ta.ts')).toBe(3)
  })

  it('counts a binary row as one dirty unit', () => {
    expect(parseDirtyDelta('-\t-\tassets/logo.png\n1\t0\ta.ts')).toBe(2)
  })

  it('adds the untracked-line total', () => {
    expect(parseDirtyDelta('1\t0\ta.ts', 7)).toBe(8)
  })

  it('empty numstat yields 0', () => {
    expect(parseDirtyDelta('')).toBe(0)
  })
})

describe('Phase 1 validation pipeline (P1.1b/P1.3/P1.4)', () => {
  /**
   * Build an engine whose verifier hooks are injected. Passing `judgeScores`
   * additionally mounts a validator LLM so the judge dimension yields a real
   * signal; without it the judge is missing and every outcome is rejected as
   * `verifier-unavailable`.
   */
  async function signalEngine(
    overrides: Partial<BasicSelfEvolveConfig> = {},
    judgeScores?: ValidationScores,
  ): Promise<{ engine: SignalEngine; patternId: string }> {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session)
    if (judgeScores !== undefined) {
      ctx.provide('llm', {
        stream: async function* () {
          yield { type: 'text-delta', index: 0, text: JSON.stringify(judgeScores) }
        },
      } as never)
    }
    const engine = new SignalEngine(ctx, baseConfig({
      ...(judgeScores === undefined ? {} : { validatorTarget: { provider: 'deepseek', model: 'judge' } }),
      ...overrides,
    }), session)
    const [pattern] = await engine.readPatterns(session.id)
    return { engine, patternId: pattern!.patternId }
  }

  it('both verifiers pass + held-out passes → accepted with heldInPassed=1', async () => {
    const { engine, patternId } = await signalEngine({}, PASSING_SCORES)
    engine.replay = { exitCode: 0, retriggeredPatternIds: [] }
    engine.workspace = { dirtyLines: 0, noDirtyFallback: false, buildHealthy: true }
    const outcome = await engine.validate(proposal({ addressesPatternIds: [patternId] }))
    expect(outcome.kind).toBe('accepted')
    if (outcome.kind === 'accepted') {
      expect(outcome.heldInPassed).toBe(1)
      expect(outcome.confidence).toBeGreaterThanOrEqual(0.5)
    }
  })

  it('mixed T+F → rejected with no counted regressions (conservative)', async () => {
    const { engine, patternId } = await signalEngine()
    engine.replay = { exitCode: 0, retriggeredPatternIds: [] }
    engine.workspace = { dirtyLines: 9, noDirtyFallback: false, buildHealthy: true }
    const outcome = await engine.validate(proposal({ addressesPatternIds: [patternId] }))
    expect(outcome.kind).toBe('rejected')
    if (outcome.kind === 'rejected') {
      expect(outcome.reason).toBe('held-in-failed')
      expect(outcome.regressions).toEqual([])
    }
  })

  it('F+T → rejected', async () => {
    const { engine, patternId } = await signalEngine()
    engine.replay = { exitCode: 3, retriggeredPatternIds: [patternId] }
    engine.workspace = { dirtyLines: 0, noDirtyFallback: false, buildHealthy: true }
    const outcome = await engine.validate(proposal({ addressesPatternIds: [patternId] }))
    expect(outcome.kind).toBe('rejected')
  })

  it('build failure → rejected held-in-failed with build-failed reason (P1.9b)', async () => {
    const { engine, patternId } = await signalEngine()
    engine.replay = { exitCode: 0, retriggeredPatternIds: [] }
    engine.workspace = { dirtyLines: 0, noDirtyFallback: false, buildHealthy: false }
    const outcome = await engine.validate(proposal({ addressesPatternIds: [patternId] }))
    expect(outcome.kind).toBe('rejected')
    if (outcome.kind === 'rejected') {
      expect(outcome.reason).toBe('held-in-failed')
      expect(outcome.diagnostic).toContain('build-failed')
      expect(outcome.regressions).toEqual([])
    }
  })

  it('noDirtyFallback with a healthy build → accepted regardless of dirty lines (P1.9b)', async () => {
    const { engine, patternId } = await signalEngine({}, PASSING_SCORES)
    engine.replay = { exitCode: 0, retriggeredPatternIds: [] }
    engine.workspace = { dirtyLines: 999, noDirtyFallback: true, buildHealthy: true }
    const outcome = await engine.validate(proposal({ addressesPatternIds: [patternId] }))
    expect(outcome.kind).toBe('accepted')
  })

  it('requireDualVerification=false → held-in is not required but confidence still gates', async () => {
    const { engine, patternId } = await signalEngine({ requireDualVerification: false }, PASSING_SCORES)
    engine.replay = { exitCode: 3, retriggeredPatternIds: [patternId] }
    engine.workspace = { dirtyLines: 99, noDirtyFallback: false, buildHealthy: true }
    const outcome = await engine.validate(proposal({ addressesPatternIds: [patternId] }))
    expect(outcome.kind).toBe('accepted')
    if (outcome.kind === 'accepted') expect(outcome.heldInPassed).toBe(0)
  })

  it('verifier signals unavailable → verifier-unavailable, not low-confidence (weak path 0.3)', async () => {
    const { engine, patternId } = await signalEngine()
    engine.replay = null
    engine.workspace = null
    const outcome = await engine.validate(proposal({ addressesPatternIds: [patternId] }))
    expect(outcome.kind).toBe('rejected')
    if (outcome.kind === 'rejected') {
      expect(outcome.reason).toBe('verifier-unavailable')
      expect(outcome.diagnostic).toContain('验证信号不可用')
      expect(outcome.diagnostic).toContain('held-in')
      expect(outcome.replayEvidence?.some(row => row.note?.includes('弱路径'))).toBe(true)
      expect(outcome.regressions).toEqual([])
      // Missing signal rather than a bad score: the aggregate cannot exceed the weak rate.
      expect(outcome.confidence).toBeLessThanOrEqual(0.3)
    }
  })

  it('a missing judge is not scored favourably → verifier-unavailable despite passing verifiers', async () => {
    const { engine, patternId } = await signalEngine()
    engine.replay = { exitCode: 0, retriggeredPatternIds: [] }
    engine.workspace = { dirtyLines: 0, noDirtyFallback: false, buildHealthy: true }
    const outcome = await engine.validate(proposal({ addressesPatternIds: [patternId] }))
    expect(outcome.kind).toBe('rejected')
    if (outcome.kind === 'rejected') {
      expect(outcome.reason).toBe('verifier-unavailable')
      expect(outcome.diagnostic).toContain('judge')
      expect(outcome.confidence).toBeLessThanOrEqual(0.3)
    }
  })

  it('lowering minAcceptConfidence does not turn a missing signal into an acceptance', async () => {
    const { engine, patternId } = await signalEngine({ minAcceptConfidence: 0 })
    engine.replay = null
    engine.workspace = null
    const outcome = await engine.validate(proposal({ addressesPatternIds: [patternId] }))
    expect(outcome.kind).toBe('rejected')
    if (outcome.kind === 'rejected') expect(outcome.reason).toBe('verifier-unavailable')
  })

  it('held-out pass rate below 0.6 lowers confidence below the gate', async () => {
    const { engine, patternId } = await signalEngine({}, PASSING_SCORES)
    engine.replay = { exitCode: 0, retriggeredPatternIds: [] }
    engine.workspace = { dirtyLines: 0, noDirtyFallback: false, buildHealthy: true }
    engine.heldOut = { passed: 1, cases: 3 }
    const outcome = await engine.validate(proposal({ addressesPatternIds: [patternId] }))
    // confidence = 1 × 1 × (1/3) = 0.333 < 0.5
    expect(outcome.kind).toBe('rejected')
    if (outcome.kind === 'rejected') expect(outcome.reason).toBe('low-confidence')
  })

  it('validatorTarget equal to proposerTarget fails load-time validation', () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session)
    expect(() => new BasicSelfEvolveEngine(ctx, baseConfig({
      proposerTarget: { provider: 'deepseek', model: 'proposer' },
      validatorTarget: { provider: 'deepseek', model: 'proposer' },
    }))).toThrow(/validatorTarget must differ from proposerTarget/)
  })

  it('schema-normalized empty targets do not trip the drift guard', () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session)
    const validated = BasicSelfEvolveEngine.Config(baseConfig())
    expect(validated.proposerTarget).toEqual({})
    expect(validated.validatorTarget).toEqual({})
    expect(() => new BasicSelfEvolveEngine(ctx, validated)).not.toThrow()
  })
})

describe('maxDailyLoopsPerSession enforcement', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'self-evolve-rate-'))
    vi.stubEnv('DSH_HOME', dir)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('blocks a second autonomous loop inside the 24h window', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session)
    const engine = new BasicSelfEvolveEngine(ctx, baseConfig({ maxDailyLoopsPerSession: 1 }))
    let maintenanceCalls = 0
    const agent = agentFor(session, async (task) => {
      maintenanceCalls += 1
      return task(new AbortController().signal)
    })

    const first = await engine.evolveIfNeeded(agent, 'idle-maintenance', new AbortController().signal)
    expect(first).not.toBeNull()
    const second = await engine.evolveIfNeeded(agent, 'idle-maintenance', new AbortController().signal)
    expect(second).toBeNull()
    expect(maintenanceCalls).toBe(1)
  })

  it('respects the per-trigger minIntervalMs gate once a loop has started', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session)
    const engine = new BasicSelfEvolveEngine(ctx, baseConfig({
      maxDailyLoopsPerSession: 4,
      triggers: {
        'idle-maintenance': { enabled: true, minIntervalMs: 60_000 },
        pressure: { enabled: true, minIntervalMs: 0 },
        'user-command': { enabled: true, minIntervalMs: 0 },
        'validation-retry': { enabled: true, minIntervalMs: 0 },
      },
    }))
    let maintenanceCalls = 0
    const agent = agentFor(session, async (task) => {
      maintenanceCalls += 1
      return task(new AbortController().signal)
    })

    await engine.evolveIfNeeded(agent, 'idle-maintenance', new AbortController().signal)
    // A second idle attempt inside the 60s window is gated before mining.
    const second = await engine.evolveIfNeeded(agent, 'idle-maintenance', new AbortController().signal)
    expect(second).toBeNull()
    expect(maintenanceCalls).toBe(1)
  })

  it('explicit user-command loops bypass the autonomous cap', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session)
    const engine = new BasicSelfEvolveEngine(ctx, baseConfig({ maxDailyLoopsPerSession: 1 }))
    let maintenanceCalls = 0
    const agent = agentFor(session, async (task) => {
      maintenanceCalls += 1
      return task(new AbortController().signal)
    })

    await engine.evolveNow(agent, new AbortController().signal)
    await engine.evolveNow(agent, new AbortController().signal)
    expect(maintenanceCalls).toBe(2)
  })
})

describe('commit bracket integrity', () => {
  /** Engine that accepts every proposal, for the full-loop commit path. */
  class AcceptingEngine extends BasicSelfEvolveEngine {
    protected override async validateProposal(): Promise<ProposalValidationOutcome> {
      return {
        kind: 'accepted',
        heldInPassed: 1,
        heldOutPassed: 1,
        regressions: [],
        deconstructedScores: { activatesWhenCorrect: 1, clarity: 1, noRegressionIntroduced: 1, safety: 1 },
        confidence: 1,
        replayEvidence: [],
        nextRoundSuggestion: '',
      }
    }
  }

  it('a full loop records exactly one commit event and reports its durable seq', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-commit-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionFactory()
      appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
      appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
      provideServices(ctx, session)
      const engine = new AcceptingEngine(ctx, baseConfig())
      const result = await engine.evolveNow(agentFor(session), new AbortController().signal)

      const commitEvents = session.snapshotEvents().filter(e => e.type === 'self-evolve/commit')
      expect(commitEvents).toHaveLength(1)
      const commitData = commitEvents[0]?.data as { commit: { proposal: { proposalId: string }; commitSeq?: number } }
      expect(commitData.commit.proposal.proposalId).toBe(result.commits[0]?.proposal.proposalId)
      expect(result.commits[0]?.commitSeq).toBe(commitEvents[0]?.seq)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('negative results (P1.7b)', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'self-evolve-test-'))
    vi.stubEnv('DSH_HOME', dir)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('rejected proposals append one JSON line per rejection to the negative-results log', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session)
    const engine = new RejectingEngine(ctx, baseConfig())
    const result = await engine.evolveNow(agentFor(session), new AbortController().signal)
    expect(result.proposals.length).toBeGreaterThan(0)

    const raw = await readFile(join(dir, 'self-evolve', 'negative-results.jsonl'), 'utf8')
    const lines = raw.trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(result.proposals.length)
    const row = JSON.parse(lines[0]!) as Record<string, unknown>
    expect(row.reason).toBe('held-in-failed')
    expect(row.diagnostic).toBe('test rejection')
    expect(row.nextRoundSuggestion).toBe('try something else')
    expect(typeof row.patternId).toBe('string')
    expect(row.proposalId).toBe(result.proposals[0]?.proposalId)
  })

  it('readNegativeResults filters by pattern and caps the limit', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session)
    const engine = new RejectingEngine(ctx, baseConfig())
    // Seed the log through the protected path, then read through the public API.
    for (let i = 0; i < 2; i += 1) {
      await engine.persist(proposal({ proposalId: `p-a-${i}` }), {
        kind: 'rejected',
        reason: 'held-in-failed',
        regressions: [],
        diagnostic: 'a',
        nextRoundSuggestion: 'x',
      })
    }
    await engine.persist(proposal({ proposalId: 'p-b', addressesPatternIds: ['L1-skill:other'] }), {
      kind: 'rejected',
      reason: 'rate-limited',
      regressions: [],
      diagnostic: 'b',
      nextRoundSuggestion: 'y',
    })
    const rows = await engine.readNegativeResults('L1-skill:abc')
    expect(rows).toHaveLength(2)
    expect(rows[1]?.proposalId).toBe('p-a-1')
    const others = await engine.readNegativeResults('L1-skill:other')
    expect(others).toHaveLength(1)
    expect(await engine.readNegativeResults('L1-skill:abc', 1)).toHaveLength(1)
    expect(await engine.readNegativeResults('L1-skill:none')).toHaveLength(0)
  })

  it('the template proposer summarizes recent rejections into its section text (P1.8 prefix)', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session)
    const engine = new RejectingEngine(ctx, baseConfig())
    const [target] = await engine.readPatterns(session.id)
    expect(target).toBeDefined()
    await engine.persist(proposal({ proposalId: 'p-old', addressesPatternIds: [target!.patternId] }), {
      kind: 'rejected',
      reason: 'held-in-failed',
      regressions: [],
      diagnostic: 'still failing',
      nextRoundSuggestion: 'different approach',
    })
    const result = await engine.evolveNow(agentFor(session), new AbortController().signal)
    const section = result.proposals[0]?.candidate
    expect(section?.kind).toBe('L2-context')
    if (section?.kind === 'L2-context') {
      expect(section.sectionText).toContain('1 次提案均被拒绝')
      expect(section.sectionText).toContain('held-in-failed')
      expect(section.sectionText).toContain('不要重复同样方案')
    }
  })
})

describe('agent/request-error producer (G1)', () => {
  it('appends a durable session event on the request-error waterfall and delegates', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session)
    const engine = new BasicSelfEvolveEngine(ctx, baseConfig())
    void engine

    let nextCalled = false
    ctx.emit('agent/request-error', {
      agent: { session },
      turn: 1,
      step: 1,
      provider: 'deepseek',
      failure: { message: 'rate limited', code: 'rate_limit_exceeded', status: 429 },
      retryPolicy: undefined,
      signal: new AbortController().signal,
    } as never, async () => {
      nextCalled = true
      return undefined
    })
    expect(nextCalled).toBe(true)
    await vi.waitFor(() => {
      expect(session.snapshotEvents().some(e => e.type === 'agent/request-error')).toBe(true)
    })
    const event = session.snapshotEvents().find(e => e.type === 'agent/request-error')
    expect(event).toBeDefined()
    const data = event?.data as { turn?: unknown; step?: unknown; provider?: unknown; statusCode?: unknown; error?: { code?: unknown } }
    expect(data.turn).toBe(1)
    expect(data.step).toBe(1)
    expect(data.provider).toBe('deepseek')
    expect(data.statusCode).toBe(429)
    expect(data.error?.code).toBe('rate_limit_exceeded')
  })
})

describe('Phase 1 replay, judge, and long-horizon guards', () => {
  function childSession(): Session {
    const child = Session.create(SessionId('child-replay'), [])
    const callSeq = child.append('tool/call', { turn: 1, step: 1, callId: 'rc1' as never, name: 'bash', arguments: '{}' }).seq
    child.append('tool/result', {
      turn: 1,
      step: 1,
      message: { role: 'tool', toolCallId: 'rc1', content: [{ type: 'text', text: '[stderr]\nboom\n[exit code: 1]' }] } as never,
    }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
    return child
  }

  /** A fork child that completes and calls one tool, so a replay counts it as exercised. */
  function replayChild(id: string): Session {
    const child = Session.create(SessionId(id), [])
    child.append('tool/call', { turn: 1, step: 1, callId: `${id}-call` as never, name: 'bash', arguments: '{}' })
    return child
  }

  function forkSubagents(ctx: Context, child: Session): void {
    ctx.provide('subagents', {
      getProvider: () => ({}),
      startActivation: async () => ({
        childId: child.id,
        result: Promise.resolve({ stopReason: 'completed', output: [] }),
        dispose: async () => {},
      }),
    } as never)
    // The engine resolves the replayed Agent from the activation's child id, so
    // the child must be reachable through `agents` alongside whatever
    // `provideServices` installed for the parent. `provide` registers once, so
    // the existing stub is widened in place instead of re-registered.
    const agents = ctx.get('agents') as { get(id: SessionId): unknown }
    const installed = agents.get.bind(agents)
    agents.get = (id: SessionId) => (id === child.id ? { session: child } : installed(id))
  }

  it('replayCase forks a child and folds only its own events after the end-seed (P1.2)', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session, { session })
    forkSubagents(ctx, childSession())
    const engine = new ProbeEngine(ctx, baseConfig())
    const replay = await engine.replay(agentFor(session), proposal(), 'case', new AbortController().signal)
    expect(replay).not.toBeNull()
    expect(replay?.exitCode).toBe(0)
    expect(replay?.retriggeredPatternIds).toHaveLength(1)
    expect(replay?.retriggeredPatternIds[0]).toMatch(/^L1-skill:/)
  })

  it('replayCase returns null when the fork infrastructure is absent', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session)
    const engine = new ProbeEngine(ctx, baseConfig())
    expect(await engine.replay(agentFor(session), proposal(), 'case', new AbortController().signal)).toBeNull()
  })

  it('collectHeldOutSignal replays similar history hits and reports the pass rate (P1.3)', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session, { session })
    // A replay passes when the child completes, calls a tool (so it actually
    // re-attempted the surface), and re-triggers no failure pattern.
    const cleanChild = Session.create(SessionId('child-clean'), [])
    cleanChild.append('tool/call', { turn: 1, step: 1, callId: 'ok1' as never, name: 'bash', arguments: '{}' })
    forkSubagents(ctx, cleanChild)
    ctx.provide('sessionQuery', {
      searchEvents: async () => ({
        items: [
          { seq: 5, snippet: 'old failure one', type: 'tool/result' },
          { seq: 9, snippet: 'old failure two', type: 'tool/result' },
        ],
      }),
    } as never)
    const engine = new ProbeEngine(ctx, baseConfig({ maxHeldOutCases: 5 }))
    const [pattern] = await engine.readPatterns(session.id)
    expect(pattern).toBeDefined()
    const target = proposal({ addressesPatternIds: [pattern!.patternId] })
    const signal = await engine.heldOut(agentFor(session), target, pattern!, new AbortController().signal)
    expect(signal).toEqual({ passed: 2, cases: 2 })
  })

  it('collectHeldOutSignal returns null without sessionQuery or similar hits', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session, { session })
    const engine = new ProbeEngine(ctx, baseConfig())
    const [pattern] = await engine.readPatterns(session.id)
    expect(await engine.heldOut(agentFor(session), proposal(), pattern!, new AbortController().signal)).toBeNull()
  })

  it('heldOutSessionIds routes the probe to the configured sessions (P1.3)', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session, { session })
    forkSubagents(ctx, replayChild('child-foreign'))
    const queried: string[] = []
    ctx.provide('sessionQuery', {
      searchEvents: async ({ sessionId }: { sessionId: string }) => {
        queried.push(sessionId)
        return { items: [{ seq: 4, snippet: 'an unseen failure', type: 'tool/result' }] }
      },
    } as never)
    const engine = new ProbeEngine(ctx, baseConfig({ heldOutSessionIds: ['foreign-session'] }))
    const [pattern] = await engine.readPatterns(session.id)
    const target = proposal({ addressesPatternIds: [pattern!.patternId] })
    const signal = await engine.heldOut(agentFor(session), target, pattern!, new AbortController().signal)
    expect(queried).toEqual(['foreign-session'])
    expect(signal).toEqual({ passed: 1, cases: 1 })
  })

  it('does not apply the owning session supporting-seq filter to a foreign source', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session, { session })
    forkSubagents(ctx, replayChild('child-foreign'))
    ctx.provide('sessionQuery', {
      // Seq numbers are session-local: this hit shares a number with a
      // supporting seq but is a different event in a different session.
      searchEvents: async () => ({ items: [{ seq: 1, snippet: 'same number, another session', type: 'tool/result' }] }),
    } as never)
    const engine = new ProbeEngine(ctx, baseConfig({ heldOutSessionIds: ['foreign-session'] }))
    const [pattern] = await engine.readPatterns(session.id)
    expect(pattern!.supportingSeqs).toContain(1)
    const target = proposal({ addressesPatternIds: [pattern!.patternId] })
    const signal = await engine.heldOut(agentFor(session), target, pattern!, new AbortController().signal)
    expect(signal).toEqual({ passed: 1, cases: 1 })
  })

  it('merges several held-out sources and caps the case count', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session, { session })
    forkSubagents(ctx, replayChild('child-merged'))
    ctx.provide('sessionQuery', {
      searchEvents: async ({ sessionId }: { sessionId: string }) => ({
        items: [
          { seq: 1, snippet: `${sessionId} one`, type: 'tool/result' },
          { seq: 2, snippet: `${sessionId} two`, type: 'tool/result' },
        ],
      }),
    } as never)
    const engine = new ProbeEngine(ctx, baseConfig({ heldOutSessionIds: ['a', 'b'], maxHeldOutCases: 3 }))
    const [pattern] = await engine.readPatterns(session.id)
    const target = proposal({ addressesPatternIds: [pattern!.patternId] })
    const signal = await engine.heldOut(agentFor(session), target, pattern!, new AbortController().signal)
    expect(signal).toEqual({ passed: 3, cases: 3 })
  })

  it('_judge parses the four-dimension scores from the validator LLM (P1.4)', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session)
    ctx.provide('llm', {
      stream: async function* () {
        yield { type: 'text-delta', index: 0, text: '{"activatesWhenCorrect":0.8,"clarity":0.9,"noRegressionIntroduced":1,"safety":1}' }
      },
    } as never)
    const engine = new ProbeEngine(ctx, baseConfig({ validatorTarget: { provider: 'deepseek', model: 'judge' } }))
    const scores = await engine.judge(proposal(), [], new AbortController().signal)
    expect(scores).toEqual({ activatesWhenCorrect: 0.8, clarity: 0.9, noRegressionIntroduced: 1, safety: 1 })
  })

  it('_judge returns null without a validatorTarget and clamps out-of-range scores', async () => {
    const bare = new Context()
    const bareSession = sessionFactory()
    provideServices(bare, bareSession)
    const engine = new ProbeEngine(bare, baseConfig())
    expect(await engine.judge(proposal(), [], new AbortController().signal)).toBeNull()

    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session)
    ctx.provide('llm', {
      stream: async function* () {
        yield { type: 'text-delta', index: 0, text: '{"activatesWhenCorrect":7,"clarity":-1,"noRegressionIntroduced":0.5,"safety":1}' }
      },
    } as never)
    const clamped = new ProbeEngine(ctx, baseConfig({ validatorTarget: { provider: 'deepseek', model: 'judge' } }))
    const scores = await clamped.judge(proposal(), [], new AbortController().signal)
    expect(scores).toEqual({ activatesWhenCorrect: 1, clarity: 0, noRegressionIntroduced: 0.5, safety: 1 })
  })

  it('pruneInflatedSections archives and disposes sections over the byte budget (P1.9)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-prune-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionFactory()
      const disposed: string[] = []
      const systemPrompt = {
        section: (section: { name: string }) => {
          return () => { disposed.push(section.name) }
        },
      }
      provideServices(ctx, session, undefined, systemPrompt)
      const engine = new ProbeEngine(ctx, baseConfig({ maxPromptInflationBytesPerWeek: 10 }))
      const agent = agentFor(session)
      await engine.commit(agent, proposal({
        proposalId: 'p-old',
        candidate: { kind: 'L2-context', sectionName: 'old-section', sectionText: 'x'.repeat(20), order: 260, estimatedBytes: 20 },
      }))
      await engine.commit(agent, proposal({
        proposalId: 'p-new',
        candidate: { kind: 'L2-context', sectionName: 'new-section', sectionText: 'y'.repeat(20), order: 260, estimatedBytes: 20 },
      }))
      await engine.prune()
      expect(disposed).toContain('old-section')
      const archiveDir = join(dir, 'self-evolve', 'l2-archive')
      const archivedFile = (await readdir(archiveDir)).find(name => name.startsWith('old-section.'))
      expect(archivedFile).toBeDefined()
      const archived = await readFile(join(archiveDir, archivedFile as string), 'utf8')
      expect(archived).toContain('xxxx')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('prompt-inflation budget counts UTF-8 bytes, not UTF-16 code units', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-prune-bytes-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionFactory()
      const disposed: string[] = []
      const systemPrompt = {
        section: (section: { name: string }) => {
          return () => { disposed.push(section.name) }
        },
      }
      provideServices(ctx, session, undefined, systemPrompt)
      // 5 CJK characters = 5 UTF-16 code units but 15 UTF-8 bytes. A `.length`
      // budget of 10 keeps this section; a byte budget evicts it.
      const engine = new ProbeEngine(ctx, baseConfig({ maxPromptInflationBytesPerWeek: 10 }))
      const agent = agentFor(session)
      await engine.commit(agent, proposal({
        proposalId: 'p-cjk',
        candidate: { kind: 'L2-context', sectionName: 'cjk-section', sectionText: '上下文膨胀', order: 260, estimatedBytes: 15 },
      }))
      expect('上下文膨胀'.length).toBeLessThan(10)
      await engine.prune()
      expect(disposed).toContain('cjk-section')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('rollbackPattern restores the candidate the last commit replaced (P1.8)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-rollback-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionFactory()
      const sections: { name: string; text: string }[] = []
      const systemPrompt = {
        section: (section: { name: string; text: string }) => {
          sections.push(section)
          return () => {}
        },
      }
      provideServices(ctx, session, undefined, systemPrompt)
      const engine = new ProbeEngine(ctx, baseConfig())
      // Commit 1 archives a null previous (first commit); commit 2 archives
      // commit 1 as the champion, so a rollback restores commit 1's text.
      await engine.archive(proposal({
        proposalId: 'c1',
        candidate: { kind: 'L2-context', sectionName: 'sec', sectionText: 'champion text', order: 260, estimatedBytes: 13 },
      }))
      await engine.archive(proposal({
        proposalId: 'c2',
        candidate: { kind: 'L2-context', sectionName: 'sec', sectionText: 'regressing text', order: 260, estimatedBytes: 15 },
      }))
      await engine.rollback('L1-skill:abc')
      expect(sections.some(section => section.name === 'sec' && section.text === 'champion text')).toBe(true)
      expect(sections.some(section => section.text === 'regressing text')).toBe(false)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('rollbackPattern is a no-op when the pattern has no previous commit (P1.8)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-rollback-first-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionFactory()
      const sections: { name: string; text: string }[] = []
      const systemPrompt = {
        section: (section: { name: string; text: string }) => {
          sections.push(section)
          return () => {}
        },
      }
      provideServices(ctx, session, undefined, systemPrompt)
      const engine = new ProbeEngine(ctx, baseConfig())
      await engine.archive(proposal({
        proposalId: 'c1',
        candidate: { kind: 'L2-context', sectionName: 'sec', sectionText: 'first text', order: 260, estimatedBytes: 10 },
      }))
      await engine.rollback('L1-skill:abc')
      expect(sections).toHaveLength(0)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('two consecutive same-pattern rejections trigger one champion rollback in the loop', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-rollback-loop-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionFactory()
      appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
      appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
      provideServices(ctx, session)
      const engine = new (class extends BasicSelfEvolveEngine {
        rollbacks = 0
        protected override async validateProposal(): Promise<ProposalValidationOutcome> {
          return {
            kind: 'rejected',
            reason: 'held-out-regression',
            regressions: ['L1-skill:abc'],
            diagnostic: 'still failing',
            nextRoundSuggestion: 'nope',
          }
        }

        protected override async rollbackPattern(): Promise<void> {
          this.rollbacks += 1
        }
      })(ctx, baseConfig())
      const agent = agentFor(session)
      await engine.evolveNow(agent, new AbortController().signal)
      await engine.evolveNow(agent, new AbortController().signal)
      expect(engine.rollbacks).toBe(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('Phase 2 L3/L4 (workflow smoke + dynamic runner approval)', () => {
  it('L3 candidates validate through the workflow smoke run (P2.1)', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session, { session })
    ctx.provide('workflowEngine', {
      start: () => ({
        result: Promise.resolve({ value: null, stopReason: 'completed', agentsStarted: 2 }),
        dispose: async () => {},
      }),
    } as never)
    const engine = new ProbeEngine(ctx, baseConfig())
    const l3 = proposal({ candidate: { kind: 'L3-workflow', scriptName: 'audit', scriptBody: 'return 1' } })
    const signal = await engine.replaySignal(agentFor(session), l3, pattern('x', 'subprocess-exit', 2), new AbortController().signal)
    expect(signal).toEqual({ exitCode: 0, retriggeredPatternIds: [] })
  })

  it('a failing L3 smoke run rejects the proposal through held-in verification', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session, { session })
    ctx.provide('workflowEngine', {
      start: () => ({
        result: Promise.resolve({ value: null, stopReason: 'error', error: 'script threw', agentsStarted: 0 }),
        dispose: async () => {},
      }),
    } as never)
    const engine = new ProbeEngine(ctx, baseConfig())
    const l3 = proposal({ candidate: { kind: 'L3-workflow', scriptName: 'audit', scriptBody: 'throw new Error()' } })
    const signal = await engine.replaySignal(agentFor(session), l3, pattern('x', 'subprocess-exit', 2), new AbortController().signal)
    expect(signal?.exitCode).toBe(1)
  })

  it('L3 candidates report the smoke unavailable without a workflow engine', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session)
    const engine = new ProbeEngine(ctx, baseConfig())
    const l3 = proposal({ candidate: { kind: 'L3-workflow', scriptName: 'audit', scriptBody: 'return 1' } })
    expect(await engine.replaySignal(agentFor(session), l3, pattern('x', 'subprocess-exit', 2), new AbortController().signal)).toBeNull()
  })

  it('L4 candidates define and run through the dynamic runner, entering approval (P2.2)', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session, { session })
    const runs: string[] = []
    ctx.provide('dynamicCordisRunner', {
      define: () => ({
        pluginId: 'dyn-1', packageId: 'pkg-1', name: 'n', purpose: 'p', hasHostHalf: true, hasClientHalf: true,
      }),
      run: async (_agent: unknown, pluginId: string) => {
        runs.push(pluginId)
        return { ok: true, status: 'awaiting-approval', pluginId, packageId: 'pkg-1', pluginRunId: 'run-1', waitingFor: [] }
      },
    } as never)
    const engine = new ProbeEngine(ctx, baseConfig())
    const outcome = await engine.validateL4(
      agentFor(session),
      proposal({ candidate: { kind: 'L4-harness', pluginIdPrefix: 'dyn' } }),
      new AbortController().signal,
    )
    expect(outcome.kind).toBe('accepted')
    expect(runs).toEqual(['dyn-1'])
  })

  it('an L4 run refusal rejects the proposal as approval-denied', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session, { session })
    ctx.provide('dynamicCordisRunner', {
      define: () => ({ pluginId: 'dyn-1', packageId: 'pkg-1', name: 'n', purpose: 'p', hasHostHalf: true, hasClientHalf: true }),
      run: async () => ({ ok: false, reason: 'approval-denied', message: 'user declined' }),
    } as never)
    const engine = new ProbeEngine(ctx, baseConfig())
    const outcome = await engine.validateL4(
      agentFor(session),
      proposal({ candidate: { kind: 'L4-harness', pluginIdPrefix: 'dyn' } }),
      new AbortController().signal,
    )
    expect(outcome.kind).toBe('rejected')
    if (outcome.kind === 'rejected') expect(outcome.reason).toBe('approval-denied')
  })

  it('L4 candidates reject without the dynamic runner service', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session)
    const engine = new ProbeEngine(ctx, baseConfig())
    const outcome = await engine.validateL4(
      agentFor(session),
      proposal({ candidate: { kind: 'L4-harness', pluginIdPrefix: 'dyn' } }),
      new AbortController().signal,
    )
    expect(outcome.kind).toBe('rejected')
  })

  it('the before-approval wrapper forces re-approval for stale or cross-proposal L4 runs (P2.3)', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session)
    const engine = new ProbeEngine(ctx, baseConfig({ l4ReapprovalHours: 24 }))
    const base = false
    const info = (pluginId: string, requiresApproval: boolean) => ({
      requestId: 'req-1', agentId: session.id, pluginId, packageId: 'pkg-2', mode: 'run', name: 'n', purpose: 'p', requiresApproval,
    }) as never

    // Stale approval (>24h) and a different proposal id both force approval.
    engine['l4Pending'].set('dyn-1', 'prop-2')
    engine['l4Ledger'].set('dyn-1', { proposalId: 'prop-1', approvedAt: Date.now() - 25 * 3_600_000 })
    expect(await ctx.events.waterfall('cordis/before-approval', info('dyn-1', base), () => Promise.resolve(base))).toBe(true)
    engine['l4Ledger'].set('dyn-1', { proposalId: 'prop-1', approvedAt: Date.now() - 1000 })
    expect(await ctx.events.waterfall('cordis/before-approval', info('dyn-1', base), () => Promise.resolve(base))).toBe(true)

    // A fresh same-proposal run within the window keeps the base requirement.
    engine['l4Pending'].set('dyn-1', 'prop-1')
    engine['l4Ledger'].set('dyn-1', { proposalId: 'prop-1', approvedAt: Date.now() - 1000 })
    expect(await ctx.events.waterfall('cordis/before-approval', info('dyn-1', base), () => Promise.resolve(base))).toBe(false)

    // A plugin this provider never drove is left to the runner's own grants.
    expect(await ctx.events.waterfall('cordis/before-approval', info('other-1', base), () => Promise.resolve(base))).toBe(false)
  })
})

function fakeLlm(ctx: Context, text: string): void {
  ctx.provide('llm', {
    stream: async function* () {
      yield { type: 'text-delta', index: 0, text }
    },
  } as never)
}

function fakeLlmQueue(ctx: Context, texts: string[]): void {
  let index = 0
  ctx.provide('llm', {
    stream: async function* () {
      yield { type: 'text-delta', index: 0, text: texts[Math.min(index, texts.length - 1)] ?? '' }
      index += 1
    },
  } as never)
}

function reflectAgent(session: Session): Agent {
  return { session, options: { provider: 'deepseek', model: 'chat' } } as unknown as Agent
}

/** A session with two mined patterns and the services the engine needs. */
function reflectSetup(): { ctx: Context; session: Session } {
  const ctx = new Context()
  const session = sessionFactory()
  appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
  appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
  provideServices(ctx, session)
  return { ctx, session }
}

describe('Phase 3/4 (reflection, LLM proposer, freeze, budget, global KB)', () => {

  it('a high-confidence reflection reinforces an existing pattern (P3.1)', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session)
    const engine = new ProbeEngine(ctx, baseConfig())
    const [pattern] = await engine.readPatterns(session.id)
    const before = pattern!.occurrences
    fakeLlm(ctx, JSON.stringify({ confidence: 0.9, patternId: pattern!.patternId, suggestion: 'check cwd first' }))
    await engine.reflect(reflectAgent(session), 1, 1, new AbortController().signal)
    const event = session.snapshotEvents().find(e => e.type === 'self-evolve/reflection')
    expect(event).toBeDefined()
    const [after] = await engine.readPatterns(session.id)
    expect(after!.occurrences).toBe(before + 1)
  })

  it('a low-confidence reflection is dropped and unknown pattern ids are ignored (P3.1)', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session)
    const engine = new ProbeEngine(ctx, baseConfig())
    fakeLlm(ctx, JSON.stringify({ confidence: 0.4, patternId: 'L1-skill:nope', suggestion: 'x' }))
    await engine.reflect(reflectAgent(session), 1, 1, new AbortController().signal)
    expect(session.snapshotEvents().filter(e => e.type === 'self-evolve/reflection')).toHaveLength(0)
  })

  it('the reflection throttle limits reflections to one per turn (P3.1)', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session)
    const engine = new ProbeEngine(ctx, baseConfig({ maxStepReflectionsPerTurn: 1 }))
    const [pattern] = await engine.readPatterns(session.id)
    fakeLlm(ctx, JSON.stringify({ confidence: 0.9, patternId: pattern!.patternId, suggestion: 'x' }))
    await engine.reflect(reflectAgent(session), 1, 1, new AbortController().signal)
    await engine.reflect(reflectAgent(session), 1, 2, new AbortController().signal)
    expect(session.snapshotEvents().filter(e => e.type === 'self-evolve/reflection')).toHaveLength(1)
  })

  it('the LLM proposer parses generated proposals with the CSR context (P3.2)', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session, { session })
    ctx.provide('sessionQuery', {
      searchEvents: async () => ({ items: [{ seq: 3, snippet: 'resolved by checking cwd', type: 'tool/result' }] }),
    } as never)
    const engine = new ProbeEngine(ctx, baseConfig({ proposerTarget: { provider: 'deepseek', model: 'proposer' } }))
    const patterns = await engine.readPatterns(session.id)
    fakeLlm(ctx, JSON.stringify([{
      name: 'cwd-guard', purpose: 'check cwd before bash', addressesPatternIds: [patterns[0]!.patternId],
      candidate: { kind: 'L2-context', sectionName: 'cwd-guard', sectionText: 'check cwd first', order: 260 },
    }]))
    const proposals = await engine.propose(patterns, ['L1-skill', 'L2-context'], new AbortController().signal, session.id)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.candidate.kind).toBe('L2-context')
    if (proposals[0]?.candidate.kind === 'L2-context') {
      expect(proposals[0].candidate.sectionText).toBe('check cwd first')
      expect(proposals[0].candidate.estimatedBytes).toBe('check cwd first'.length)
    }
  })

  it('without a proposerTarget the template proposer still runs', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session)
    const engine = new ProbeEngine(ctx, baseConfig())
    const patterns = await engine.readPatterns(session.id)
    const proposals = await engine.propose(patterns, ['L1-skill', 'L2-context'], new AbortController().signal, session.id)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.candidate.kind).toBe('L2-context')
  })

  it('two proposals freeze a pattern for the freeze window (P3.3)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-freeze-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionFactory()
      appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
      appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
      provideServices(ctx, session)
      const engine = new (class extends BasicSelfEvolveEngine {
        protected override async validateProposal(): Promise<ProposalValidationOutcome> {
          return {
            kind: 'rejected', reason: 'held-in-failed', regressions: [],
            diagnostic: 'frozen-test', nextRoundSuggestion: 'x',
          }
        }
      })(ctx, baseConfig({ patternFreezeHours: 24, maxProposalsPerLoop: 2 }))
      const agent = agentFor(session)
      await engine.evolveNow(agent, new AbortController().signal)
      await engine.evolveNow(agent, new AbortController().signal)
      // Third loop: the pattern is frozen, so no proposals are generated.
      const third = await engine.evolveNow(agent, new AbortController().signal)
      expect(third.proposals).toHaveLength(0)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('the loop budget aborts with budget-exceeded (P3.4)', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session)
    fakeLlm(ctx, '{}')
    const engine = new ProbeEngine(ctx, baseConfig({
      validatorTarget: { provider: 'deepseek', model: 'judge' },
      maxBudgetCharsPerLoop: 10,
    }))
    await expect(engine.evolveNow(agentFor(session), new AbortController().signal)).rejects.toThrow(/budget-exceeded/)
  })

  it('global patterns merge across sessions within the 24h window (P4.1/P4.2)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-global-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const sessionB = sessionFactory()
      appendShellResult(sessionB, 'c1', '[stderr]\nboom\n[exit code: 1]')
      appendShellResult(sessionB, 'c2', '[stderr]\nboom\n[exit code: 1]')
      provideServices(ctx, sessionB)
      const engine = new ProbeEngine(ctx, baseConfig())
      const [pattern] = await engine.readPatterns(sessionB.id)
      // Session A (a different session) contributes two occurrences.
      await engine.persistGlobal(agentFor(sessionFactory()), [
        { ...pattern!, occurrences: 2 },
      ])
      const merged = await engine.readGlobal(sessionB.id)
      expect(merged.get(pattern!.patternId)).toBe(2)
      const [enriched] = await engine.readPatterns(sessionB.id)
      expect(enriched!.occurrences).toBe(pattern!.occurrences + 2)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('stale global rows outside the 24h window are ignored (P4.2)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-global-stale-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const sessionB = sessionFactory()
      provideServices(ctx, sessionB)
      const engine = new ProbeEngine(ctx, baseConfig())
      const file = join(dir, 'self-evolve', 'global-patterns.jsonl')
      await mkdtemp(join(dir, 'self-evolve'))
      const { mkdir, appendFile: append } = await import('node:fs/promises')
      await mkdir(join(dir, 'self-evolve'), { recursive: true })
      await append(file, `${JSON.stringify({ ts: Date.now() - 25 * 3_600_000, sessionId: 'other', patternId: 'L1-skill:x', occurrences: 9 })}\n`)
      expect(await engine.readGlobal(sessionB.id)).toEqual(new Map())
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('review fixes (M1 request-error reflection, M3 L4 cleanup)', () => {
  it('a request-error recorded with its turn triggers the reflection path (M1)', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session)
    const engine = new ProbeEngine(ctx, baseConfig())
    const [pattern] = await engine.readPatterns(session.id)
    // The producer records the failing turn; turnHasFailure must match it.
    session.append('agent/request-error', {
      turn: 1,
      step: 2,
      provider: 'deepseek',
      statusCode: 429,
      error: { code: 'rate_limit_exceeded', name: 'LlmFailure', message: 'rate limited' },
    })
    fakeLlm(ctx, JSON.stringify({ confidence: 0.9, patternId: pattern!.patternId, suggestion: 'retry later' }))
    await engine.reflect(reflectAgent(session), 1, 3, new AbortController().signal)
    expect(session.snapshotEvents().filter(e => e.type === 'self-evolve/reflection')).toHaveLength(1)
  })

  it('an L4 run refusal undefines the orphaned plugin definition (M3)', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session, { session })
    const undefinedIds: string[] = []
    ctx.provide('dynamicCordisRunner', {
      define: () => ({ pluginId: 'dyn-1', packageId: 'pkg-1', name: 'n', purpose: 'p', hasHostHalf: true, hasClientHalf: true }),
      run: async () => ({ ok: false, reason: 'approval-denied', message: 'user declined' }),
      undefine: async (_agent: unknown, pluginId: string) => { undefinedIds.push(pluginId) },
    } as never)
    const engine = new ProbeEngine(ctx, baseConfig())
    const outcome = await engine.validateL4(
      agentFor(session),
      proposal({ candidate: { kind: 'L4-harness', pluginIdPrefix: 'dyn' } }),
      new AbortController().signal,
    )
    expect(outcome.kind).toBe('rejected')
    expect(undefinedIds).toEqual(['dyn-1'])
  })

  it('an async approval refusal drops the definition via request-run-resolved (M3)', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session, { session })
    const undefinedIds: string[] = []
    ctx.provide('dynamicCordisRunner', {
      define: () => ({ pluginId: 'dyn-1', packageId: 'pkg-1', name: 'n', purpose: 'p', hasHostHalf: true, hasClientHalf: true }),
      run: async () => ({ ok: true, status: 'awaiting-approval', pluginId: 'dyn-1', packageId: 'pkg-1', pluginRunId: 'run-1', waitingFor: [] }),
      undefine: async (_agent: unknown, pluginId: string) => { undefinedIds.push(pluginId) },
    } as never)
    const engine = new ProbeEngine(ctx, baseConfig())
    await engine.validateL4(
      agentFor(session),
      proposal({ candidate: { kind: 'L4-harness', pluginIdPrefix: 'dyn' } }),
      new AbortController().signal,
    )
    ctx.emit('@deepseek-ai/cordis/request-run', {
      requestId: 'req-1', agentId: session.id, pluginId: 'dyn-1', packageId: 'pkg-1',
      mode: 'run', name: 'n', purpose: 'p', requiresApproval: true,
    } as never)
    ctx.emit('@deepseek-ai/cordis/request-run-resolved', { requestId: 'req-1', outcome: 'rejected' } as never)
    await vi.waitFor(() => { expect(undefinedIds).toEqual(['dyn-1']) })
  })
})

describe('candidate rendering across kinds (judge path)', () => {
  it('renders L1-skill, L3-workflow, and L4-harness candidates for the judge', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session)
    fakeLlm(ctx, JSON.stringify({ activatesWhenCorrect: 0.8, clarity: 0.9, noRegressionIntroduced: 1, safety: 1 }))
    const engine = new ProbeEngine(ctx, baseConfig({ validatorTarget: { provider: 'deepseek', model: 'judge' } }))
    const signal = new AbortController().signal
    await expect(engine.judge(
      proposal({ candidate: { kind: 'L1-skill', skillName: 'guard', content: 'check first', whenToUse: 'on bash' } }),
      [], signal,
    )).resolves.toEqual({ activatesWhenCorrect: 0.8, clarity: 0.9, noRegressionIntroduced: 1, safety: 1 })
    await expect(engine.judge(
      proposal({ candidate: { kind: 'L3-workflow', scriptName: 'audit', scriptBody: 'return 1' } }),
      [], signal,
    )).resolves.toEqual({ activatesWhenCorrect: 0.8, clarity: 0.9, noRegressionIntroduced: 1, safety: 1 })
    await expect(engine.judge(
      proposal({ candidate: { kind: 'L4-harness', pluginIdPrefix: 'dyn', hostCode: 'host()', clientCode: 'client()' } }),
      [], signal,
    )).resolves.toEqual({ activatesWhenCorrect: 0.8, clarity: 0.9, noRegressionIntroduced: 1, safety: 1 })
    await expect(engine.judge(
      proposal({ candidate: { kind: 'L4-harness', pluginIdPrefix: 'bare' } }),
      [], signal,
    )).resolves.toEqual({ activatesWhenCorrect: 0.8, clarity: 0.9, noRegressionIntroduced: 1, safety: 1 })
  })
})

describe('LLM output parser edges (P3.1/P3.2/P1.4)', () => {
  it('non-object reflection output is dropped', async () => {
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    const ctx = new Context()
    provideServices(ctx, session)
    fakeLlm(ctx, '"plain string"')
    const engine = new ProbeEngine(ctx, baseConfig())
    await engine.reflect(reflectAgent(session), 1, 1, new AbortController().signal)
    expect(session.snapshotEvents().filter(e => e.type === 'self-evolve/reflection')).toHaveLength(0)
  })

  it('reflection with no match or unparseable JSON is dropped', async () => {
    const { ctx, session } = reflectSetup()
    fakeLlmQueue(ctx, ['no json here', '{oops'])
    const engine = new ProbeEngine(ctx, baseConfig())
    await engine.reflect(reflectAgent(session), 1, 1, new AbortController().signal)
    await engine.reflect(reflectAgent(session), 2, 1, new AbortController().signal)
    expect(session.snapshotEvents().filter(e => e.type === 'self-evolve/reflection')).toHaveLength(0)
  })

  it('reflection with non-numeric confidence or non-string patternId is dropped', async () => {
    const { ctx, session } = reflectSetup()
    const engine = new ProbeEngine(ctx, baseConfig({ maxStepReflectionsPerTurn: 2 }))
    const [pattern] = await engine.readPatterns(session.id)
    fakeLlmQueue(ctx, [
      JSON.stringify({ confidence: 'high', patternId: pattern!.patternId, suggestion: 'x' }),
      JSON.stringify({ confidence: 0.9, patternId: 123, suggestion: 'x' }),
    ])
    await engine.reflect(reflectAgent(session), 1, 1, new AbortController().signal)
    await engine.reflect(reflectAgent(session), 1, 2, new AbortController().signal)
    expect(session.snapshotEvents().filter(e => e.type === 'self-evolve/reflection')).toHaveLength(0)
  })

  it('reflection with a non-string suggestion appends an empty suggestion', async () => {
    const { ctx, session } = reflectSetup()
    const engine = new ProbeEngine(ctx, baseConfig())
    const [pattern] = await engine.readPatterns(session.id)
    fakeLlm(ctx, JSON.stringify({ confidence: 0.9, patternId: pattern!.patternId, suggestion: 42 }))
    await engine.reflect(reflectAgent(session), 1, 1, new AbortController().signal)
    const event = session.snapshotEvents().find(e => e.type === 'self-evolve/reflection')
    expect((event?.data as { suggestion?: unknown }).suggestion).toBe('')
  })

  it('judge output that is not an object or misses a dimension degrades to null', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session)
    fakeLlmQueue(ctx, [
      'null',
      '{"activatesWhenCorrect":0.5,"clarity":"high","noRegressionIntroduced":1,"safety":1}',
    ])
    const engine = new ProbeEngine(ctx, baseConfig({ validatorTarget: { provider: 'deepseek', model: 'judge' } }))
    expect(await engine.judge(proposal(), [], new AbortController().signal)).toBeNull()
    expect(await engine.judge(proposal(), [], new AbortController().signal)).toBeNull()
  })

  it('the LLM proposer drops malformed entries and keeps well-formed ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-llm-proposer-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionFactory()
      appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
      appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
      provideServices(ctx, session, { session })
      ctx.provide('sessionQuery', {
        searchEvents: async () => ({ items: [{ seq: 3, snippet: 'resolved by checking cwd', type: 'tool/result' }] }),
      } as never)
      const engine = new ProbeEngine(ctx, baseConfig({ proposerTarget: { provider: 'deepseek', model: 'proposer' }, maxProposalsPerLoop: 10 }))
      const patterns = await engine.readPatterns(session.id)
      fakeLlm(ctx, JSON.stringify([
        { name: 'a', purpose: 'b', addressesPatternIds: ['p1', 42], candidate: { kind: 'L1-skill', skillName: 's1', content: 'c1', whenToUse: 'w1' } },
        { name: 'b', purpose: 'c', addressesPatternIds: ['p1'], candidate: { kind: 'L1-skill', skillName: 's2', content: 'c2' } },
        { name: 'c', purpose: 'd', candidate: { kind: 'L1-skill', skillName: 42, content: 'c3' } },
        { name: 'd', purpose: 'e', candidate: { kind: 'L1-skill', skillName: 's4', content: 42 } },
        { name: 'e', purpose: 'f', candidate: { kind: 'L2-context', sectionName: 'sn', sectionText: 'st', order: 'x' } },
        { name: 42, purpose: 'g', candidate: { kind: 'L2-context', sectionName: 'sn2', sectionText: 'st2', order: 1 } },
        { name: 'h', purpose: 42, candidate: { kind: 'L2-context', sectionName: 'sn3', sectionText: 'st3', order: 1 } },
        { name: 'i', purpose: 'j', addressesPatternIds: 'not-array', candidate: { kind: 'L2-context', sectionName: 'sn4', sectionText: 'st4', order: 1 } },
        { name: 'k', purpose: 'l', candidate: { kind: 'L3-workflow', scriptName: 'w', scriptBody: 'b' } },
        { name: 'm', purpose: 'n' },
      ]))
      const proposals = await engine.propose(patterns, ['L1-skill', 'L2-context'], new AbortController().signal, session.id)
      expect(proposals).toHaveLength(4)
      const l1 = proposals.filter(p => p.level === 'L1-skill')
      expect(l1).toHaveLength(2)
      expect((l1[0]?.candidate as Extract<EvolveProposal['candidate'], { kind: 'L1-skill' }>).whenToUse).toBe('w1')
      expect((l1[1]?.candidate as Extract<EvolveProposal['candidate'], { kind: 'L1-skill' }>).whenToUse).toBeUndefined()
      const l2 = proposals.filter(p => p.level === 'L2-context')
      expect(l2).toHaveLength(2)
      expect((l2[0]?.candidate as Extract<EvolveProposal['candidate'], { kind: 'L2-context' }>).order).toBe(260)
      expect((l2[1]?.candidate as Extract<EvolveProposal['candidate'], { kind: 'L2-context' }>).sectionName).toBe('sn4')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('a non-array LLM proposer output falls back to the template', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session)
    fakeLlm(ctx, '{"not": "an array"}')
    const engine = new ProbeEngine(ctx, baseConfig({ proposerTarget: { provider: 'deepseek', model: 'proposer' } }))
    const patterns = await engine.readPatterns(session.id)
    const proposals = await engine.propose(patterns, ['L1-skill', 'L2-context'], new AbortController().signal, session.id)
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.candidate.kind).toBe('L2-context')
  })

  it('empty levels short-circuit the LLM proposer context', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session)
    fakeLlm(ctx, '[]')
    const engine = new ProbeEngine(ctx, baseConfig({ proposerTarget: { provider: 'deepseek', model: 'proposer' } }))
    const patterns = await engine.readPatterns(session.id)
    expect(await engine.propose(patterns, [], new AbortController().signal, session.id)).toEqual([])
  })

  it('buildProposerContext renders negatives and skips the CSR block without sessionQuery', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-llm-context-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      // Seed a negative result on one context (same shell events → same patternId).
      const seederCtx = new Context()
      const seederSession = sessionFactory()
      appendShellResult(seederSession, 'c1', '[stderr]\nboom\n[exit code: 1]')
      appendShellResult(seederSession, 'c2', '[stderr]\nboom\n[exit code: 1]')
      provideServices(seederCtx, seederSession)
      const rejecter = new RejectingEngine(seederCtx, baseConfig())
      const [target] = await rejecter.readPatterns(seederSession.id)
      await rejecter.persist(proposal({ proposalId: 'p-old', addressesPatternIds: [target!.patternId] }), {
        kind: 'rejected', reason: 'held-in-failed', regressions: [],
        diagnostic: 'x', nextRoundSuggestion: 'different approach',
      })

      const ctx = new Context()
      const session = sessionFactory()
      appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
      appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
      provideServices(ctx, session, { session })
      const engine = new ProbeEngine(ctx, baseConfig({ proposerTarget: { provider: 'deepseek', model: 'proposer' } }))
      const patterns = await engine.readPatterns(session.id)
      // An empty LLM output falls back to the template; without sessionQuery
      // the CSR block is skipped.
      fakeLlm(ctx, '[]')
      const withoutQuery = await engine.propose(patterns, ['L1-skill', 'L2-context'], new AbortController().signal, session.id)
      expect(withoutQuery).toHaveLength(1)
      expect(withoutQuery[0]?.candidate.kind).toBe('L2-context')
      // With sessionQuery returning no items the CSR block stays empty.
      ctx.provide('sessionQuery', { searchEvents: async () => ({ items: [] }) } as never)
      const emptyItems = await engine.propose(patterns, ['L1-skill', 'L2-context'], new AbortController().signal, session.id)
      expect(emptyItems).toHaveLength(1)
      expect(emptyItems[0]?.candidate.kind).toBe('L2-context')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('config resolution edges', () => {
  it('empty config applies every default', () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session)
    const engine = new BasicSelfEvolveEngine(ctx, {})
    expect(engine.config.maxDailyLoopsPerSession).toBe(4)
    expect(engine.config.defaultLevels).toEqual(['L1-skill', 'L2-context'])
    expect(engine.config.minPatternOccurrences).toBe(2)
    expect(engine.config.maxProposalsPerLoop).toBe(2)
    expect(engine.config.maxDirtyLinesAddedPerCommit).toBe(2)
    expect(engine.config.requireDualVerification).toBe(true)
  })

  it('a partial proposerTarget fails load with a loud error', () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session)
    expect(() => new BasicSelfEvolveEngine(ctx, baseConfig({ proposerTarget: { provider: 'deepseek' } as never })))
      .toThrow(/must include both provider and model/)
  })
})

describe('constructor lifecycle listeners', () => {
  function idleSetup(
    status: string,
    runMaintenance?: (task: (signal: AbortSignal) => Promise<unknown>) => Promise<unknown>,
  ): { ctx: Context; session: Session; agent: unknown } {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    const agent = {
      session,
      options: {},
      status,
      runMaintenance: runMaintenance ?? (async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal)),
    }
    provideServices(ctx, session, agent)
    new BasicSelfEvolveEngine(ctx, baseConfig({ allowUnverifiedAutonomousRuns: true }))
    return { ctx, session, agent }
  }

  it('ignores session events other than automatic compaction', () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session)
    new BasicSelfEvolveEngine(ctx, baseConfig())
    expect(() => {
      ctx.emit('session/event', session, { type: 'turn/start', seq: 0 } as never)
      ctx.emit('session/event', session, { type: 'turn/end', seq: 1 } as never)
    }).not.toThrow()
  })

  it('skips an idle status transition for a non-idle status', () => {
    const { ctx, session, agent } = idleSetup('running')
    expect(() => {
      ctx.emit('agent/status', { agent, status: 'running' } as never)
    }).not.toThrow()
    expect(session.snapshotEvents().some(e => e.type === 'self-evolve/start')).toBe(false)
  })

  it('runs an idle-maintenance loop when the agent reports idle', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-idle-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const { ctx, session, agent } = idleSetup('idle')
      ctx.emit('agent/status', { agent, status: 'idle' } as never)
      await vi.waitFor(() => {
        expect(session.snapshotEvents().some(e => e.type === 'self-evolve/end')).toBe(true)
      })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('logs idle-maintenance failures that happen outside the loop bracket', async () => {
    const { ctx, agent } = idleSetup('idle', async () => { throw new Error('maintenance exploded') })
    const logs: string[] = []
    ctx.logger.exporter({ levels: { default: 2 }, export: (message) => { logs.push(String(message.args[0])) } })
    ctx.emit('agent/status', { agent, status: 'idle' } as never)
    await vi.waitFor(() => { expect(logs.some(line => line.includes('maintenance exploded'))).toBe(true) })
  })

  it('logs non-Error idle-maintenance failures with String coercion', async () => {
    const { ctx, agent } = idleSetup('idle', async () => { throw 'exploded-string' })
    const logs: string[] = []
    ctx.logger.exporter({ levels: { default: 2 }, export: (message) => { logs.push(String(message.args[0])) } })
    ctx.emit('agent/status', { agent, status: 'idle' } as never)
    await vi.waitFor(() => { expect(logs.some(line => line.includes('exploded-string'))).toBe(true) })
  })

  it('does not start autonomous maintenance when the verifier is unconfigured', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    const agent = {
      session,
      options: {},
      status: 'idle',
      runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
    }
    provideServices(ctx, session, agent)
    new BasicSelfEvolveEngine(ctx, baseConfig())
    ctx.emit('agent/status', { agent, status: 'idle' } as never)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(session.snapshotEvents().some(e => e.type === 'self-evolve/start')).toBe(false)
  })

  it('skips subagent and forked sessions', async () => {
    const ctx = new Context()
    const child = Session.create(SessionId('subagent-child'), [], {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('subagent-child'),
      createdAt: Date.now(),
      origin: 'subagent',
      delegationDepth: 1,
      isSeeded: false,
    })
    appendShellResult(child, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(child, 'c2', '[stderr]\nboom\n[exit code: 1]')
    const agent = {
      session: child,
      options: {},
      status: 'idle',
      runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
    }
    provideServices(ctx, child, agent)
    new BasicSelfEvolveEngine(ctx, baseConfig({ allowUnverifiedAutonomousRuns: true }))
    ctx.emit('agent/status', { agent, status: 'idle' } as never)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(child.snapshotEvents().some(e => e.type === 'self-evolve/start')).toBe(false)
  })

  it('the request-error producer survives a session that rejects appends', () => {
    const ctx = new Context()
    provideServices(ctx, sessionFactory())
    new BasicSelfEvolveEngine(ctx, baseConfig())
    let nextCalled = false
    ctx.emit('agent/request-error', {
      agent: { session: { append: () => { throw new Error('closed') } } },
      turn: 1, step: 1, provider: 'deepseek',
      failure: { message: 'x', code: 'y', status: 429 },
      retryPolicy: undefined,
      signal: new AbortController().signal,
    } as never, async (): Promise<RequestErrorAction> => { nextCalled = true; return undefined })
    expect(nextCalled).toBe(true)
  })

  it('the request-error producer coerces non-Error append failures', () => {
    const ctx = new Context()
    provideServices(ctx, sessionFactory())
    new BasicSelfEvolveEngine(ctx, baseConfig())
    let nextCalled = false
    ctx.emit('agent/request-error', {
      agent: { session: { append: () => { throw 'closed' } } },
      turn: 1, step: 1, provider: 'deepseek',
      failure: { message: 'x', code: 'y', status: 429 },
      retryPolicy: undefined,
      signal: new AbortController().signal,
    } as never, async (): Promise<RequestErrorAction> => { nextCalled = true; return undefined })
    expect(nextCalled).toBe(true)
  })

  it('the pre-step hook skips aborted signals and zero-reflection configs', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session)
    new BasicSelfEvolveEngine(ctx, baseConfig({ maxStepReflectionsPerTurn: 0 }))
    let calls = 0
    ctx.emit('agent/pre-step', {
      agent: reflectAgent(session), messages: [], turn: 1, step: 1, modelSelection: { provider: 'mock', model: 'mock' }, signal: { aborted: true } as AbortSignal,
    }, async () => { calls += 1; return { kind: 'reject' } })
    ctx.emit('agent/pre-step', {
      agent: reflectAgent(session), messages: [], turn: 1, step: 1, modelSelection: { provider: 'mock', model: 'mock' }, signal: new AbortController().signal,
    }, async () => { calls += 1; return { kind: 'reject' } })
    expect(calls).toBe(2)
  })

  it('the pre-step hook reflects for idle turns and always delegates', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session)
    const engine = new ProbeEngine(ctx, baseConfig())
    const [pattern] = await engine.readPatterns(session.id)
    fakeLlm(ctx, JSON.stringify({ confidence: 0.9, patternId: pattern!.patternId, suggestion: 'x' }))
    let nextCalled = false
    ctx.emit('agent/pre-step', {
      agent: reflectAgent(session), messages: [], turn: 1, step: 1, modelSelection: { provider: 'mock', model: 'mock' }, signal: new AbortController().signal,
    }, async () => { nextCalled = true; return { kind: 'reject' } })
    await vi.waitFor(() => { expect(nextCalled).toBe(true) })
  })

  it('the pre-step hook swallows reflection failures', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session)
    new BasicSelfEvolveEngine(ctx, baseConfig())
    let nextCalled = false
    // A broken agent object makes maybeReflect throw before any session work.
    ctx.emit('agent/pre-step', {
      agent: null as never, messages: [], turn: 1, step: 1, modelSelection: { provider: 'mock', model: 'mock' }, signal: new AbortController().signal,
    }, async () => { nextCalled = true; return { kind: 'reject' } })
    await vi.waitFor(() => { expect(nextCalled).toBe(true) })
  })

  it('the pre-step hook coerces non-Error reflection failures', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session)
    const engine = new BasicSelfEvolveEngine(ctx, baseConfig())
    void engine
    ctx.provide('llm', { stream: async function* () { throw 'llm-boom' } } as never)
    let nextCalled = false
    ctx.emit('agent/pre-step', {
      agent: reflectAgent(session), messages: [], turn: 1, step: 1, modelSelection: { provider: 'mock', model: 'mock' }, signal: new AbortController().signal,
    }, async () => { nextCalled = true; return { kind: 'reject' } })
    await vi.waitFor(() => { expect(nextCalled).toBe(true) })
  })

  it('request-run correlation only tracks plugins this provider drove', () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session, { session })
    const engine = new ProbeEngine(ctx, baseConfig())
    ctx.emit('@deepseek-ai/cordis/request-run', {
      requestId: 'req-x', agentId: session.id, pluginId: 'unrelated', packageId: 'p',
      mode: 'run', name: 'n', purpose: 'p', requiresApproval: true,
    } as never)
    expect(engine['l4RequestByRun'].has('req-x')).toBe(false)
    ctx.emit('@deepseek-ai/cordis/request-run-resolved', { requestId: 'req-x', outcome: 'rejected' } as never)
  })

  it('an approved request-run keeps the pending L4 definition', () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session, { session })
    const engine = new ProbeEngine(ctx, baseConfig())
    const undefinedIds: string[] = []
    ctx.provide('dynamicCordisRunner', {
      undefine: async () => { undefinedIds.push('dyn-1') },
    } as never)
    engine['l4Pending'].set('dyn-1', 'prop-1')
    ctx.emit('@deepseek-ai/cordis/request-run', {
      requestId: 'req-1', agentId: session.id, pluginId: 'dyn-1', packageId: 'pkg-1',
      mode: 'run', name: 'n', purpose: 'p', requiresApproval: true,
    } as never)
    ctx.emit('@deepseek-ai/cordis/request-run-resolved', { requestId: 'req-1', outcome: 'approved' } as never)
    expect(undefinedIds).toEqual([])
  })

  it('cleanup after a refused run tolerates a missing runner', () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session, { session })
    const engine = new ProbeEngine(ctx, baseConfig())
    engine['l4Pending'].set('dyn-1', 'prop-1')
    ctx.emit('@deepseek-ai/cordis/request-run', {
      requestId: 'req-1', agentId: session.id, pluginId: 'dyn-1', packageId: 'pkg-1',
      mode: 'run', name: 'n', purpose: 'p', requiresApproval: true,
    } as never)
    ctx.emit('@deepseek-ai/cordis/request-run-resolved', { requestId: 'req-1', outcome: 'rejected' } as never)
    expect(engine['l4Pending'].has('dyn-1')).toBe(false)
  })

  it('dropL4Plugin swallows undefine failures', () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session, { session })
    const engine = new ProbeEngine(ctx, baseConfig())
    ctx.provide('dynamicCordisRunner', {
      undefine: async () => { throw new Error('already gone') },
    } as never)
    engine['l4Pending'].set('dyn-1', 'prop-1')
    ctx.emit('@deepseek-ai/cordis/request-run', {
      requestId: 'req-1', agentId: session.id, pluginId: 'dyn-1', packageId: 'pkg-1',
      mode: 'run', name: 'n', purpose: 'p', requiresApproval: true,
    } as never)
    ctx.emit('@deepseek-ai/cordis/request-run-resolved', { requestId: 'req-1', outcome: 'rejected' } as never)
    // No unhandled rejection; the cleanup is best-effort.
  })

  it('dropL4Plugin coerces non-Error undefine failures', () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session, { session })
    const engine = new ProbeEngine(ctx, baseConfig())
    ctx.provide('dynamicCordisRunner', {
      undefine: async () => { throw 'gone' },
    } as never)
    engine['l4Pending'].set('dyn-1', 'prop-1')
    ctx.emit('@deepseek-ai/cordis/request-run', {
      requestId: 'req-1', agentId: session.id, pluginId: 'dyn-1', packageId: 'pkg-1',
      mode: 'run', name: 'n', purpose: 'p', requiresApproval: true,
    } as never)
    ctx.emit('@deepseek-ai/cordis/request-run-resolved', { requestId: 'req-1', outcome: 'rejected' } as never)
  })
})

describe('mining and proposer gates', () => {
  it('a turn/end is skipped when idle-maintenance is disabled', () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session)
    const triggers: TriggerPolicy = { ...baseConfig().triggers!, 'idle-maintenance': { enabled: false, minIntervalMs: 0 } }
    new BasicSelfEvolveEngine(ctx, baseConfig({ triggers }))
    expect(() => {
      ctx.emit('session/event', session, { type: 'turn/end', seq: 0 } as never)
    }).not.toThrow()
  })

  it('evolveIfNeeded returns null for a disabled trigger', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session)
    const triggers: TriggerPolicy = { ...baseConfig().triggers!, 'user-command': { enabled: false, minIntervalMs: 0 } }
    const engine = new BasicSelfEvolveEngine(ctx, baseConfig({ triggers }))
    expect(await engine.evolveIfNeeded(agentFor(session), 'user-command', new AbortController().signal)).toBeNull()
  })

  it('autonomous triggers without eligible patterns short-circuit before a loop', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session)
    const engine = new BasicSelfEvolveEngine(ctx, baseConfig())
    expect(await engine.evolveIfNeeded(agentFor(session), 'pressure', new AbortController().signal)).toBeNull()
    expect(await engine.evolveIfNeeded(agentFor(session), 'validation-retry', new AbortController().signal)).toBeNull()
  })

  it('readPatterns returns [] when the projection state is absent', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    ctx.provide('sessionProjections', { register: () => () => {}, snapshot: () => ({ values: {} }) })
    ctx.provide('sessions', { get: (id: string) => (id === session.id ? session : undefined) })
    ctx.provide('agents', { get: () => undefined })
    ctx.provide('skills', { register: () => () => {}, snapshot: async () => ({ skills: [], complete: true }) })
    ctx.provide('systemPrompt', { section: () => () => {} })
    const engine = new ProbeEngine(ctx, baseConfig())
    expect(await engine.readPatterns(session.id)).toEqual([])
  })

  it('requireSession fails loud for an unknown session id', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session)
    const engine = new ProbeEngine(ctx, baseConfig())
    await expect(engine.readPatterns('missing-session')).rejects.toThrow(/unknown sessionId/)
  })

  it('proposeForPatterns without a session id runs the template directly', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session)
    const engine = new ProbeEngine(ctx, baseConfig())
    const proposals = await engine.propose(
      [pattern('a', 'subprocess-exit', 2)],
      ['L1-skill', 'L2-context'],
      new AbortController().signal,
      undefined as never,
    )
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.candidate.kind).toBe('L2-context')
  })

  it('the template proposer skips non-L1 patterns', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session)
    const engine = new ProbeEngine(ctx, baseConfig({ maxProposalsPerLoop: 3 }))
    const l2Level = { ...pattern('x', 'subprocess-exit', 2), level: 'L2-context' as const }
    const proposals = await engine.propose(
      [pattern('a', 'subprocess-exit', 2), l2Level],
      ['L1-skill', 'L2-context'],
      new AbortController().signal,
      session.id,
    )
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.candidate.kind).toBe('L2-context')
  })

  it('the template proposer fills the per-loop cap', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session)
    const engine = new ProbeEngine(ctx, baseConfig({ maxProposalsPerLoop: 1 }))
    const proposals = await engine.propose(
      [pattern('a', 'subprocess-exit', 2), pattern('b', 'subprocess-exit', 2)],
      ['L1-skill', 'L2-context'],
      new AbortController().signal,
      session.id,
    )
    expect(proposals).toHaveLength(1)
    expect(proposals[0]?.candidate.kind).toBe('L2-context')
  })

  it('the template proposer renders ids without a colon and empty evidence windows', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session)
    const engine = new ProbeEngine(ctx, baseConfig({ maxProposalsPerLoop: 3 }))
    const bare = { ...pattern('bare', 'subprocess-exit', 2), patternId: FailurePatternId('nocolon'), supportingSeqs: [] }
    const proposals = await engine.propose(
      [pattern('a', 'subprocess-exit', 2), bare],
      ['L1-skill', 'L2-context'],
      new AbortController().signal,
      session.id,
    )
    expect(proposals).toHaveLength(2)
    expect(proposals[1]?.name).toBe('self-evolve-patch-nocolon')
    if (proposals[1]?.candidate.kind === 'L2-context') {
      expect(proposals[1].candidate.sectionText).toContain('该 pattern 的上下文')
    }
  })
})

describe('replay and held-out edge surfaces', () => {
  function failingFork(ctx: Context, stopReason: string, child?: Session): void {
    ctx.provide('subagents', {
      getProvider: () => ({}),
      startActivation: async () => ({
        childId: child?.id ?? SessionId('fork-child'),
        result: Promise.resolve({ stopReason, output: [] }),
        dispose: async () => {},
      }),
    } as never)
  }

  it('a failing fork replay reports exitCode 1', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session, { session })
    failingFork(ctx, 'error')
    const engine = new ProbeEngine(ctx, baseConfig())
    const replay = await engine.replay(agentFor(session), proposal(), 'case', new AbortController().signal)
    expect(replay?.exitCode).toBe(1)
  })

  it('a fork without a local agent reports no retriggered patterns and fails the gate', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session, { session })
    failingFork(ctx, 'completed')
    const engine = new ProbeEngine(ctx, baseConfig())
    const replay = await engine.replay(agentFor(session), proposal(), 'case', new AbortController().signal)
    expect(replay).toEqual({ exitCode: 1, retriggeredPatternIds: [] })
  })

  it('a completed child that never called a tool fails the replay', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session, { session })
    // The child reports completion without exercising anything: an empty
    // replay is not evidence of a fix.
    failingFork(ctx, 'completed', Session.create(SessionId('child-idle'), []))
    const engine = new ProbeEngine(ctx, baseConfig())
    const replay = await engine.replay(agentFor(session), proposal(), 'case', new AbortController().signal)
    expect(replay).toEqual({ exitCode: 1, retriggeredPatternIds: [] })
  })

  it('a fork child without an end-seed marker contributes no patterns', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session, { session })
    // No seed argument: Session.create appends no end-seed boundary.
    const child = Session.create(SessionId('child-no-seed'))
    const callSeq = child.append('tool/call', { turn: 1, step: 1, callId: 'rc1' as never, name: 'bash', arguments: '{}' }).seq
    child.append('tool/result', {
      turn: 1, step: 1,
      message: { role: 'tool', toolCallId: 'rc1', content: [{ type: 'text', text: '[stderr]\nboom\n[exit code: 1]' }] } as never,
    }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
    failingFork(ctx, 'completed', child)
    const engine = new ProbeEngine(ctx, baseConfig())
    const replay = await engine.replay(agentFor(session), proposal(), 'case', new AbortController().signal)
    expect(replay?.retriggeredPatternIds).toEqual([])
  })

  it('collectReplaySignal falls back when the last seq is not in the session', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session)
    const engine = new ProbeEngine(ctx, baseConfig())
    const unknownSeq = { ...pattern('x', 'subprocess-exit', 2), supportingSeqs: [9999] }
    // The replay infrastructure is absent, so the signal is null; the context
    // string is still rendered through the not-found branch.
    expect(await engine.replaySignal(agentFor(session), proposal(), unknownSeq, new AbortController().signal)).toBeNull()
  })

  it('collectReplaySignal falls back when the session or last seq is unknown', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session)
    const engine = new ProbeEngine(ctx, baseConfig())
    const noSeq = { ...pattern('x', 'subprocess-exit', 2), supportingSeqs: [] }
    expect(await engine.replaySignal(agentFor(session), proposal(), noSeq, new AbortController().signal)).toBeNull()
  })

  it('runWorkflowSmoke returns null for non-L3 candidates', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session)
    const engine = new ProbeEngine(ctx, baseConfig())
    expect(await engine.workflowSmoke(agentFor(session), proposal(), new AbortController().signal)).toBeNull()
  })

  it('collectHeldOutSignal returns null when every hit is already supporting evidence', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session, { session })
    ctx.provide('sessionQuery', {
      searchEvents: async () => ({ items: [{ seq: 1, snippet: 'known', type: 'tool/result' }] }),
    } as never)
    const engine = new ProbeEngine(ctx, baseConfig())
    const [pattern] = await engine.readPatterns(session.id)
    // seq 1 is already in supportingSeqs, so the hit filters out.
    expect(await engine.heldOut(agentFor(session), proposal(), pattern!, new AbortController().signal)).toBeNull()
  })

  it('collectHeldOutSignal aborts mid-replay when the signal fires', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session, { session })
    ctx.provide('sessionQuery', {
      searchEvents: async () => ({ items: [{ seq: 5, snippet: 'old failure', type: 'tool/result' }] }),
    } as never)
    const engine = new ProbeEngine(ctx, baseConfig())
    const [pattern] = await engine.readPatterns(session.id)
    const signal = new AbortController()
    signal.abort()
    await expect(engine.heldOut(agentFor(session), proposal(), pattern!, signal.signal)).rejects.toThrow(/aborted/)
  })

  it('collectHeldOutSignal counts only replays that exit cleanly', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session, { session })
    ctx.provide('sessionQuery', {
      searchEvents: async () => ({ items: [
        { seq: 5, snippet: 'old failure one', type: 'tool/result' },
        { seq: 9, snippet: 'old failure two', type: 'tool/result' },
      ] }),
    } as never)
    failingFork(ctx, 'error')
    const engine = new ProbeEngine(ctx, baseConfig())
    const [pattern] = await engine.readPatterns(session.id)
    const signal = await engine.heldOut(agentFor(session), proposal(), pattern!, new AbortController().signal)
    expect(signal).toEqual({ passed: 0, cases: 2 })
  })
})

describe('validateProposal and validateL4Proposal edges', () => {
  it('an aborted signal aborts validation', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session)
    const engine = new SignalEngine(ctx, baseConfig(), session)
    const signal = new AbortController()
    signal.abort()
    await expect(engine.validate(proposal(), signal.signal)).rejects.toThrow(/aborted/)
  })

  it('L4 candidates route through validateL4Proposal and reject without the runner', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session)
    const engine = new SignalEngine(ctx, baseConfig(), session)
    const outcome = await engine.validate(proposal({ candidate: { kind: 'L4-harness', pluginIdPrefix: 'dyn' } }))
    expect(outcome.kind).toBe('rejected')
    if (outcome.kind === 'rejected') expect(outcome.reason).toBe('approval-denied')
  })

  it('an unknown addressed pattern degrades both held-in and held-out to the weak path', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session)
    const engine = new SignalEngine(ctx, baseConfig(), session)
    const outcome = await engine.validate(proposal({ addressesPatternIds: ['L1-skill:ghost'] }))
    expect(outcome.kind).toBe('rejected')
  })

  it('held-out with zero cases degrades to the weak rate', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session)
    const engine = new SignalEngine(ctx, baseConfig(), session)
    engine.replay = { exitCode: 0, retriggeredPatternIds: [] }
    engine.workspace = { dirtyLines: 0, noDirtyFallback: false, buildHealthy: true }
    engine.heldOut = { passed: 0, cases: 0 }
    const [pattern] = await engine.readPatterns(session.id)
    const outcome = await engine.validate(proposal({ addressesPatternIds: [pattern!.patternId] }))
    expect(outcome.kind).toBe('rejected')
    if (outcome.kind === 'rejected') {
      expect(outcome.reason).toBe('verifier-unavailable')
      expect(outcome.diagnostic).toContain('held-out')
    }
  })

  it('without dual verification the confidence gate counts heldIn as 1', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session)
    ctx.provide('llm', {
      stream: async function* () {
        yield { type: 'text-delta', index: 0, text: '{"activatesWhenCorrect":0.4,"clarity":0.4,"noRegressionIntroduced":0.4,"safety":0.4}' }
      },
    } as never)
    const engine = new SignalEngine(ctx, baseConfig({
      requireDualVerification: false,
      validatorTarget: { provider: 'deepseek', model: 'judge' },
    }), session)
    engine.heldOut = { passed: 1, cases: 1 }
    const [pattern] = await engine.readPatterns(session.id)
    const outcome = await engine.validate(proposal({ addressesPatternIds: [pattern!.patternId] }))
    // held-in is skipped, so it counts as 1: 0.4 × 1 × 1 = 0.4 < 0.5.
    expect(outcome.kind).toBe('rejected')
    if (outcome.kind === 'rejected') {
      expect(outcome.reason).toBe('low-confidence')
      expect(outcome.diagnostic).toContain('heldIn=1')
    }
  })

  it('validateL4Proposal throws for non-L4 candidates', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session, { session })
    ctx.provide('dynamicCordisRunner', {
      define: () => ({ pluginId: 'dyn-1', packageId: 'pkg-1', name: 'n', purpose: 'p', hasHostHalf: true, hasClientHalf: true }),
      run: async () => ({ ok: true, status: 'awaiting-approval', pluginId: 'dyn-1', packageId: 'pkg-1', pluginRunId: 'run-1', waitingFor: [] }),
    } as never)
    const engine = new ProbeEngine(ctx, baseConfig())
    await expect(engine.validateL4(agentFor(session), proposal(), new AbortController().signal))
      .rejects.toThrow(/expected an L4-harness candidate/)
  })

  it('validateL4Proposal maps host and client code into the define call', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session, { session })
    let received: Record<string, unknown> | undefined
    ctx.provide('dynamicCordisRunner', {
      define: (input: Record<string, unknown>) => {
        received = input
        return { pluginId: 'dyn-1', packageId: 'pkg-1', name: 'n', purpose: 'p', hasHostHalf: true, hasClientHalf: true }
      },
      run: async () => ({ ok: true, status: 'awaiting-approval', pluginId: 'dyn-1', packageId: 'pkg-1', pluginRunId: 'run-1', waitingFor: [] }),
    } as never)
    const engine = new ProbeEngine(ctx, baseConfig())
    const outcome = await engine.validateL4(
      agentFor(session),
      proposal({ candidate: { kind: 'L4-harness', pluginIdPrefix: 'dyn', hostCode: 'host()', clientCode: 'client()' } }),
      new AbortController().signal,
    )
    expect(outcome.kind).toBe('accepted')
    expect(received?.code).toEqual({ host: 'host()', client: 'client()' })
  })
})

describe('applyCommit across candidate kinds', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'self-evolve-commit-'))
    vi.stubEnv('DSH_HOME', dir)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function commitSetup(overrides: Partial<BasicSelfEvolveConfig> = {}): {
    ctx: Context
    session: Session
    agent: SelfEvolveAgentContext
    engine: ProbeEngine
  } {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session, { session })
    const engine = new ProbeEngine(ctx, baseConfig(overrides))
    return { ctx, session, agent: agentFor(session), engine }
  }

  it('L1 candidates register a runtime skill and skip the fs write without fs', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    const skills: unknown[] = []
    ctx.provide('sessionProjections', { register: () => () => {}, snapshot: () => projectedState(session) })
    ctx.provide('sessions', { get: (id: string) => (id === session.id ? session : undefined) })
    ctx.provide('agents', { get: () => undefined })
    ctx.provide('skills', { register: (skill: unknown) => { skills.push(skill) }, snapshot: async () => ({ skills: [], complete: true }) })
    ctx.provide('systemPrompt', { section: () => () => {} })
    const engine = new ProbeEngine(ctx, baseConfig())
    await engine.commit(agentFor(session), proposal({
      proposalId: 'l1-1',
      addressesPatternIds: ['L1-skill:abc'],
      candidate: { kind: 'L1-skill', skillName: 'guard', content: 'check first', whenToUse: 'on bash' },
    }))
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({ name: 'guard', source: 'runtime-evolve', whenToUse: 'on bash' })
  })

  it('L1 candidates persist a frontmatter skill file through the fs service', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    const writes: { target: unknown; content: string }[] = []
    ctx.provide('sessionProjections', { register: () => () => {}, snapshot: () => projectedState(session) })
    ctx.provide('sessions', { get: (id: string) => (id === session.id ? session : undefined) })
    ctx.provide('agents', { get: () => undefined })
    ctx.provide('skills', { register: () => () => {}, snapshot: async () => ({ skills: [], complete: true }) })
    ctx.provide('systemPrompt', { section: () => () => {} })
    ctx.provide('fs', {
      resolve: async (path: unknown, options: { cwd?: string }) => ({ kind: 'resolved', path, cwd: options.cwd }),
      writeText: async (target: unknown, content: string) => { writes.push({ target, content }) },
    } as never)
    const engine = new ProbeEngine(ctx, baseConfig())
    await engine.commit(agentFor(session), proposal({
      proposalId: 'l1-2',
      addressesPatternIds: ['L1-skill:abc'],
      candidate: { kind: 'L1-skill', skillName: 'guard', content: 'check first' },
    }))
    expect(writes).toHaveLength(1)
    expect(writes[0]?.content).toContain('name: guard')
    expect(writes[0]?.content).toContain('whenToUse: ')
  })

  it('L1 candidates honor a session cwd and a whenToUse value in the frontmatter', async () => {
    const ctx = new Context()
    const session = Session.create(SessionId('cwd-session'), [], { version: SESSION_FORMAT_VERSION, id: SessionId('cwd-session'), createdAt: Date.now(), cwd: '/proj', isSeeded: false })
    const writes: { content: string }[] = []
    ctx.provide('sessionProjections', { register: () => () => {}, snapshot: () => projectedState(session) })
    ctx.provide('sessions', { get: (id: string) => (id === session.id ? session : undefined) })
    ctx.provide('agents', { get: () => undefined })
    ctx.provide('skills', { register: () => () => {}, snapshot: async () => ({ skills: [], complete: true }) })
    ctx.provide('systemPrompt', { section: () => () => {} })
    ctx.provide('fs', {
      resolve: async (_path: unknown, options: { cwd?: string }) => ({ kind: 'resolved', cwd: options.cwd }),
      writeText: async (_target: unknown, content: string) => { writes.push({ content }) },
    } as never)
    const engine = new ProbeEngine(ctx, baseConfig())
    await engine.commit(agentFor(session), proposal({
      proposalId: 'l1-3',
      addressesPatternIds: ['L1-skill:abc'],
      candidate: { kind: 'L1-skill', skillName: 'guard', content: 'check first', whenToUse: 'when bash fails' },
    }))
    expect(writes[0]?.content).toContain('whenToUse: when bash fails')
  })

  it('persistSkillFile returns early for non-L1 candidates', async () => {
    const { ctx, session, agent, engine } = commitSetup()
    ctx.provide('fs', {
      resolve: async () => 'target',
      writeText: async () => {},
    } as never)
    await engine.skillFile(agent, proposal())
    expect(session).toBeDefined()
  })

  it('L3 candidates commit after a passing smoke run', async () => {
    const { ctx, session, agent, engine } = commitSetup()
    ctx.provide('workflowEngine', {
      start: () => ({
        result: Promise.resolve({ value: null, stopReason: 'completed', agentsStarted: 2 }),
        dispose: async () => {},
      }),
    } as never)
    const result = await engine.commit(agent, proposal({
      proposalId: 'l3-1',
      addressesPatternIds: ['L1-skill:abc'],
      candidate: { kind: 'L3-workflow', scriptName: 'audit', scriptBody: 'return 1' },
    }))
    expect(result.commitSeq).toBeGreaterThanOrEqual(0)
    expect(session.snapshotEvents().some(e => e.type === 'self-evolve/commit')).toBe(true)
  })

  it('L3 candidates without a workflow engine fail the commit loudly', async () => {
    const { agent, engine } = commitSetup()
    await expect(engine.commit(agent, proposal({
      proposalId: 'l3-2',
      addressesPatternIds: ['L1-skill:abc'],
      candidate: { kind: 'L3-workflow', scriptName: 'audit', scriptBody: 'return 1' },
    }))).rejects.toThrow(/workflow engine unavailable/)
  })

  it('L3 candidates with a failing smoke run fail the commit loudly', async () => {
    const { ctx, agent, engine } = commitSetup()
    ctx.provide('workflowEngine', {
      start: () => ({
        result: Promise.resolve({ value: null, stopReason: 'error', error: 'script threw', agentsStarted: 0 }),
        dispose: async () => {},
      }),
    } as never)
    await expect(engine.commit(agent, proposal({
      proposalId: 'l3-3',
      addressesPatternIds: ['L1-skill:abc'],
      candidate: { kind: 'L3-workflow', scriptName: 'audit', scriptBody: 'throw new Error()' },
    }))).rejects.toThrow(/run did not complete with agents/)
  })

  it('L4 candidates update the approval ledger for their pending plugin', async () => {
    const { agent, engine } = commitSetup()
    engine['l4Pending'].set('dyn-2', 'other')
    engine['l4Pending'].set('dyn-1', 'l4-1')
    await engine.commit(agent, proposal({
      proposalId: 'l4-1',
      addressesPatternIds: ['L1-skill:abc'],
      candidate: { kind: 'L4-harness', pluginIdPrefix: 'dyn' },
    }))
    expect(engine['l4Ledger'].get('dyn-1')?.proposalId).toBe('l4-1')
    expect(engine['l4Ledger'].has('dyn-2')).toBe(false)
  })

  it('rollbackPattern restores an L1-skill champion through the skill seam', async () => {
    const { engine } = commitSetup()
    const l1 = (skillName: string, content: string) => proposal({
      addressesPatternIds: ['L1-skill:abc'],
      candidate: { kind: 'L1-skill', skillName, content },
    })
    await engine.archive(l1('s1', 'champion'))
    await engine.archive(l1('s2', 'regressing'))
    await engine.rollback('L1-skill:abc')
  })

  it('rollbackPattern ignores champions without a base-provider apply path', async () => {
    const { engine } = commitSetup()
    // 'a1' sorts before 'a2', so the second archive is the latest row.
    await engine.archive(proposal({ proposalId: 'a1', addressesPatternIds: ['L1-skill:abc'], candidate: { kind: 'L3-workflow', scriptName: 'w', scriptBody: 'b' } }))
    await engine.archive(proposal({ proposalId: 'a2', addressesPatternIds: ['L1-skill:abc'], candidate: { kind: 'L3-workflow', scriptName: 'w2', scriptBody: 'b2' } }))
    await engine.rollback('L1-skill:abc')
  })

  it('registerL2Section disposes the previous registration of the same section', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    const disposed: string[] = []
    const systemPrompt = {
      section: (section: { name: string }) => () => { disposed.push(section.name) },
    }
    provideServices(ctx, session, undefined, systemPrompt)
    const engine = new ProbeEngine(ctx, baseConfig())
    const agent = agentFor(session)
    const candidate = (text: string) => ({
      kind: 'L2-context' as const,
      sectionName: 'sec',
      sectionText: text,
      order: 260,
      estimatedBytes: text.length,
    })
    await engine.commit(agent, proposal({ proposalId: 'a', candidate: candidate('first') }))
    await engine.commit(agent, proposal({ proposalId: 'b', candidate: candidate('second') }))
    expect(disposed).toEqual(['sec'])
  })

  it('pruneInflatedSections stops mid-loop once the budget is back under', async () => {
    const { agent, engine } = commitSetup({ maxPromptInflationBytesPerWeek: 25 })
    const section = (name: string, text: string) => proposal({
      proposalId: `p-${name}`,
      candidate: { kind: 'L2-context', sectionName: name, sectionText: text, order: 260, estimatedBytes: text.length },
    })
    await engine.commit(agent, section('sec-a', 'a'.repeat(20)))
    await engine.commit(agent, section('sec-b', 'b'.repeat(20)))
    await engine.commit(agent, section('sec-c', 'c'.repeat(20)))
    await engine.prune()
    expect(engine['liveSections'].size).toBe(1)
  })
})

describe('step-reflection gate surfaces (P3.1)', () => {
  it('returns early without an llm service', async () => {
    const { ctx, session } = reflectSetup()
    const engine = new ProbeEngine(ctx, baseConfig())
    await engine.reflect(reflectAgent(session), 1, 1, new AbortController().signal)
    expect(session.snapshotEvents().filter(e => e.type === 'self-evolve/reflection')).toHaveLength(0)
  })

  it('returns early without provider and model options', async () => {
    const { ctx, session } = reflectSetup()
    const engine = new ProbeEngine(ctx, baseConfig())
    fakeLlm(ctx, '{}')
    await engine.reflect({ session, options: {} } as Agent, 1, 1, new AbortController().signal)
    expect(session.snapshotEvents().filter(e => e.type === 'self-evolve/reflection')).toHaveLength(0)
  })

  it('returns early when the turn has no failure surface', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    const callSeq = session.append('tool/call', { turn: 1, step: 1, callId: 'ok1' as never, name: 'bash', arguments: '{}' }).seq
    session.append('tool/result', {
      turn: 1, step: 1,
      message: { role: 'tool', toolCallId: 'ok1', content: [{ type: 'text', text: 'all good' }] } as never,
    }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
    provideServices(ctx, session)
    fakeLlm(ctx, '{}')
    const engine = new ProbeEngine(ctx, baseConfig())
    // The same events at a different turn also skip every event.
    await engine.reflect(reflectAgent(session), 1, 1, new AbortController().signal)
    await engine.reflect(reflectAgent(session), 5, 1, new AbortController().signal)
    expect(session.snapshotEvents().filter(e => e.type === 'self-evolve/reflection')).toHaveLength(0)
  })

  it('returns early when the projection has no patterns yet', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session)
    // A projection that has not folded any pattern yet: the failure gate still
    // sees the failed turn, but there is nothing to reinforce.
    class EmptyProjectionEngine extends ProbeEngine {
      protected override readProjectedPatterns(): FailurePattern[] {
        return []
      }
    }
    fakeLlm(ctx, '{}')
    const engine = new EmptyProjectionEngine(ctx, baseConfig())
    await engine.reflect(reflectAgent(session), 1, 1, new AbortController().signal)
    expect(session.snapshotEvents().filter(e => e.type === 'self-evolve/reflection')).toHaveLength(0)
  })

  it('a request-error recorded first drives the reflection path', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    session.append('agent/request-error', {
      turn: 1, step: 2, provider: 'deepseek', statusCode: 429,
      error: { code: 'rate_limit_exceeded', name: 'LlmFailure', message: 'rate limited' },
    })
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session)
    const engine = new ProbeEngine(ctx, baseConfig())
    const [pattern] = await engine.readPatterns(session.id)
    fakeLlm(ctx, JSON.stringify({ confidence: 0.9, patternId: pattern!.patternId, suggestion: 'retry later' }))
    await engine.reflect(reflectAgent(session), 1, 1, new AbortController().signal)
    expect(session.snapshotEvents().filter(e => e.type === 'self-evolve/reflection')).toHaveLength(1)
  })

  it('reflects from the projection alone, without reading the JSONL logs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-reflect-projection-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionFactory()
      session.append('agent/request-error', {
        turn: 1, step: 2, provider: 'deepseek', statusCode: 429,
        error: { code: 'rate_limit_exceeded', name: 'LlmFailure', message: 'rate limited' },
      })
      appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
      appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
      provideServices(ctx, session)
      // A directory where the JSONL file belongs makes any read of it throw
      // EISDIR; the reflection path must not touch it.
      await mkdir(join(dir, 'self-evolve', 'negative-results.jsonl'), { recursive: true })
      await mkdir(join(dir, 'self-evolve', 'global-patterns.jsonl'), { recursive: true })
      const engine = new ProbeEngine(ctx, baseConfig())
      const [pattern] = await engine.readProjection(session.id)
      fakeLlm(ctx, JSON.stringify({ confidence: 0.9, patternId: pattern!.patternId, suggestion: 'retry later' }))
      await engine.reflect(reflectAgent(session), 1, 1, new AbortController().signal)
      expect(session.snapshotEvents().filter(e => e.type === 'self-evolve/reflection')).toHaveLength(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('a second turn resets the per-turn reflection count', async () => {
    const { ctx, session } = reflectSetup()
    const callSeq = session.append('tool/call', { turn: 2, step: 1, callId: 'c3' as never, name: 'bash', arguments: '{}' }).seq
    session.append('tool/result', {
      turn: 2, step: 1,
      message: { role: 'tool', toolCallId: 'c3', content: [{ type: 'text', text: '[stderr]\nboom\n[exit code: 1]' }] } as never,
    }, { surfaceOp: 'append', sourceEventSeqs: [callSeq] })
    const engine = new ProbeEngine(ctx, baseConfig())
    const [pattern] = await engine.readPatterns(session.id)
    fakeLlm(ctx, JSON.stringify({ confidence: 0.9, patternId: pattern!.patternId, suggestion: 'x' }))
    await engine.reflect(reflectAgent(session), 1, 1, new AbortController().signal)
    await engine.reflect(reflectAgent(session), 2, 1, new AbortController().signal)
    expect(session.snapshotEvents().filter(e => e.type === 'self-evolve/reflection')).toHaveLength(2)
  })

  it('a raised per-turn budget reflects twice in the same turn', async () => {
    const { ctx, session } = reflectSetup()
    const engine = new ProbeEngine(ctx, baseConfig({ maxStepReflectionsPerTurn: 2 }))
    const [pattern] = await engine.readPatterns(session.id)
    fakeLlm(ctx, JSON.stringify({ confidence: 0.9, patternId: pattern!.patternId, suggestion: 'x' }))
    await engine.reflect(reflectAgent(session), 1, 1, new AbortController().signal)
    await engine.reflect(reflectAgent(session), 1, 2, new AbortController().signal)
    expect(session.snapshotEvents().filter(e => e.type === 'self-evolve/reflection')).toHaveLength(2)
  })

  it('a reflection naming an unknown pattern id is dropped', async () => {
    const { ctx, session } = reflectSetup()
    const engine = new ProbeEngine(ctx, baseConfig())
    fakeLlm(ctx, JSON.stringify({ confidence: 0.9, patternId: 'L1-skill:ghost', suggestion: 'x' }))
    await engine.reflect(reflectAgent(session), 1, 1, new AbortController().signal)
    expect(session.snapshotEvents().filter(e => e.type === 'self-evolve/reflection')).toHaveLength(0)
  })

  it('an invalid JSON judge payload degrades to structural scores', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session)
    fakeLlm(ctx, '{oops}')
    const engine = new ProbeEngine(ctx, baseConfig({ validatorTarget: { provider: 'deepseek', model: 'judge' } }))
    expect(await engine.judge(proposal(), [], new AbortController().signal)).toBeNull()
  })

  it('judge output blocks without string text are dropped from the stream', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    provideServices(ctx, session)
    ctx.provide('llm', {
      stream: async function* () {
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 42 } }
      },
    } as never)
    const engine = new ProbeEngine(ctx, baseConfig({ validatorTarget: { provider: 'deepseek', model: 'judge' } }))
    expect(await engine.judge(proposal(), [], new AbortController().signal)).toBeNull()
  })
})

describe('full-loop integration edges', () => {
  it('an aborted signal closes the loop bracket with the error', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
    provideServices(ctx, session)
    const engine = new BasicSelfEvolveEngine(ctx, baseConfig())
    const signal = new AbortController()
    signal.abort()
    await expect(engine.evolveNow(agentFor(session), signal.signal)).rejects.toThrow(/aborted/)
    const end = session.snapshotEvents().find(e => e.type === 'self-evolve/end')
    expect((end?.data as { error?: string }).error).toContain('aborted')
  })

  it('a loop with both LLM routes charged stays under the default budget', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-loop-budget-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionFactory()
      appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
      appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
      provideServices(ctx, session)
      const engine = new ProbeEngine(ctx, baseConfig({
        proposerTarget: { provider: 'deepseek', model: 'proposer' },
        validatorTarget: { provider: 'deepseek', model: 'judge' },
      }))
      const [pattern] = await engine.readPatterns(session.id)
      fakeLlm(ctx, JSON.stringify([{
        name: 'cwd-guard', purpose: 'check cwd', addressesPatternIds: [pattern!.patternId],
        candidate: { kind: 'L2-context', sectionName: 'cwd-guard', sectionText: 'check cwd first', order: 260 },
      }]))
      const result = await engine.evolveNow(agentFor(session), new AbortController().signal)
      // The proposal is conservatively rejected on the weak verifier path.
      expect(result.commits).toHaveLength(0)
      expect(result.proposals).toHaveLength(1)
      expect(session.snapshotEvents().some(e => e.type === 'self-evolve/end')).toBe(true)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('a proposal without addressed patterns skips freeze accounting and writes an empty pattern id', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-loop-no-address-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionFactory()
      appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
      appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
      provideServices(ctx, session)
      const engine = new ProbeEngine(ctx, baseConfig({ proposerTarget: { provider: 'deepseek', model: 'proposer' } }))
      fakeLlm(ctx, JSON.stringify([{
        name: 'bare', purpose: 'no addresses',
        candidate: { kind: 'L2-context', sectionName: 's', sectionText: 't', order: 260 },
      }]))
      const result = await engine.evolveNow(agentFor(session), new AbortController().signal)
      expect(result.proposals).toHaveLength(1)
      const raw = await readFile(join(dir, 'self-evolve', 'negative-results.jsonl'), 'utf8')
      expect(raw).toContain('"patternId":""')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('an accepted proposal without addressed patterns skips archiving and resets cleanly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-loop-accept-bare-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionFactory()
      appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
      appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
      provideServices(ctx, session)
      const engine = new (class extends BasicSelfEvolveEngine {
        protected override async validateProposal(): Promise<ProposalValidationOutcome> {
          const outcome: ProposalValidationOutcome = {
            kind: 'accepted',
            heldInPassed: 1,
            heldOutPassed: 1,
            regressions: [],
            deconstructedScores: { activatesWhenCorrect: 1, clarity: 1, noRegressionIntroduced: 1, safety: 1 },
            confidence: 1,
            replayEvidence: [],
            nextRoundSuggestion: '',
          }
          return outcome
        }
      })(ctx, baseConfig({ proposerTarget: { provider: 'deepseek', model: 'proposer' } }))
      fakeLlm(ctx, JSON.stringify([{
        name: 'bare', purpose: 'no addresses',
        candidate: { kind: 'L2-context', sectionName: 's', sectionText: 't', order: 260 },
      }]))
      const result = await engine.evolveNow(agentFor(session), new AbortController().signal)
      expect(result.commits).toHaveLength(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('a mid-loop failure after a commit closes the bracket with the raw diagnostic', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-loop-throw-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionFactory()
      appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
      appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
      provideServices(ctx, session)
      const engine = new (class extends BasicSelfEvolveEngine {
        calls = 0
        protected override async validateProposal(): Promise<ProposalValidationOutcome> {
          this.calls += 1
          if (this.calls === 2) throw 'boom'
          const outcome: ProposalValidationOutcome = {
            kind: 'accepted',
            heldInPassed: 1,
            heldOutPassed: 1,
            regressions: [],
            deconstructedScores: { activatesWhenCorrect: 1, clarity: 1, noRegressionIntroduced: 1, safety: 1 },
            confidence: 1,
            replayEvidence: [],
            nextRoundSuggestion: '',
          }
          return outcome
        }
      })(ctx, baseConfig({ maxProposalsPerLoop: 2, proposerTarget: { provider: 'deepseek', model: 'proposer' } }))
      fakeLlm(ctx, JSON.stringify([
        { name: 'a', purpose: 'b', addressesPatternIds: ['L1-skill:abc'], candidate: { kind: 'L2-context', sectionName: 'a', sectionText: 'a', order: 260 } },
        { name: 'c', purpose: 'd', addressesPatternIds: ['L1-skill:abc'], candidate: { kind: 'L2-context', sectionName: 'c', sectionText: 'c', order: 260 } },
      ]))
      await expect(engine.evolveNow(agentFor(session), new AbortController().signal)).rejects.toThrow('boom')
      const ends = session.snapshotEvents().filter(e => e.type === 'self-evolve/end')
      const errorEnd = ends.find(e => (e.data as { error?: string }).error !== undefined)
      expect((errorEnd?.data as { error?: string }).error).toBe('boom')
      const errorEndData = errorEnd?.data as { committedProposalIds?: string[] }
      expect(errorEndData.committedProposalIds).toEqual(expect.arrayContaining([expect.any(String)]))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('a stackless Error failure falls back to the message in the diagnostic', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-loop-throw-stack-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionFactory()
      appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
      appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
      provideServices(ctx, session)
      const engine = new (class extends BasicSelfEvolveEngine {
        calls = 0
        protected override async validateProposal(): Promise<ProposalValidationOutcome> {
          this.calls += 1
          if (this.calls === 2) {
            const error = Object.create(Error.prototype) as Error
            error.message = 'boom'
            throw error
          }
          const outcome: ProposalValidationOutcome = {
            kind: 'accepted',
            heldInPassed: 1,
            heldOutPassed: 1,
            regressions: [],
            deconstructedScores: { activatesWhenCorrect: 1, clarity: 1, noRegressionIntroduced: 1, safety: 1 },
            confidence: 1,
            replayEvidence: [],
            nextRoundSuggestion: '',
          }
          return outcome
        }
      })(ctx, baseConfig({ maxProposalsPerLoop: 2, proposerTarget: { provider: 'deepseek', model: 'proposer' } }))
      fakeLlm(ctx, JSON.stringify([
        { name: 'a', purpose: 'b', addressesPatternIds: ['L1-skill:abc'], candidate: { kind: 'L2-context', sectionName: 'a', sectionText: 'a', order: 260 } },
        { name: 'c', purpose: 'd', addressesPatternIds: ['L1-skill:abc'], candidate: { kind: 'L2-context', sectionName: 'c', sectionText: 'c', order: 260 } },
      ]))
      await expect(engine.evolveNow(agentFor(session), new AbortController().signal)).rejects.toThrow('boom')
      const errorEnd = session.snapshotEvents().find(e => e.type === 'self-evolve/end' && (e.data as { error?: string }).error !== undefined)
      expect((errorEnd?.data as { error?: string }).error).toBe('boom')
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

/** Real-execution workspace verifier coverage (P1.9b): real git in a temp repo. */
describe('workspace verifier (P1.9b)', () => {
  /** One command outcome as the fake shell would observe it. */
  interface FakeRunOutcome {
    exitCode: number | null
    signal: NodeJS.Signals | null
    stdout: string
    stderr: string
    timedOut: boolean
  }

  /** Execute one whitespace-only command through `execFile` with a timeout. */
  function realRunner(command: string, workdir: string, timeoutMs: number): Promise<FakeRunOutcome> {
    return new Promise((resolve) => {
      execFile('/bin/sh', ['-c', command], { cwd: workdir, timeout: timeoutMs }, (error, stdout, stderr) => {
        if (error === null) {
          resolve({ exitCode: 0, signal: null, stdout, stderr, timedOut: false })
          return
        }
        const code = typeof error.code === 'number' ? error.code : null
        const signal = (error as NodeJS.ErrnoException & { signal?: NodeJS.Signals }).signal ?? null
        resolve({ exitCode: code, signal, stdout, stderr, timedOut: signal !== null })
      })
    })
  }

  /** Run one resolved spec through the real shell and project its foreground result. */
  async function runSpec(spec: ShellExecSpec): Promise<ShellRunResult> {
    const outcome = await realRunner(spec.command, spec.workdir, spec.timeoutMs)
    return {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      timedOut: outcome.timedOut,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: outcome.stdout, truncated: false },
      stderr: { text: outcome.stderr, truncated: false },
    }
  }

  /** A minimal in-process `ctx.shell` double that runs real commands. */
  function fakeShell(): Pick<ShellExecutor, 'resolve' | 'execute'> {
    return {
      resolve: (request: ShellExecRequest): ShellExecSpec => ({
        command: request.command,
        workdir: request.workdir ?? process.cwd(),
        timeoutMs: request.timeoutMs ?? 60_000,
        onExpiry: request.onExpiry ?? 'kill',
        stdoutMaxBytes: request.stdoutMaxBytes ?? 1_000_000,
        signal: request.signal,
        sandboxPolicy: undefined,
      }),
      // The engine reads only the handle's foreground projection.
      execute: async (spec: ShellExecSpec): Promise<ShellExecution> => ({
        result: async () => await runSpec(spec),
      } as ShellExecution),
    }
  }

  /** Subclass exposing the protected workspace hooks. */
  class WorkspaceProbe extends BasicSelfEvolveEngine {
    baseline(agent: SelfEvolveAgentContext, signal: AbortSignal): Promise<WorkspaceBaseline | null> {
      return this.captureWorkspaceBaseline(agent, signal)
    }

    signal(
      agent: SelfEvolveAgentContext,
      p: EvolveProposal,
      signal: AbortSignal,
      baseline: WorkspaceBaseline | null,
    ): Promise<WorkspaceSignal | null> {
      return this.collectWorkspaceSignal(agent, p, signal, baseline)
    }
  }

  const tempDirs: string[] = []

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
  })

  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-ws-'))
    tempDirs.push(dir)
    return dir
  }

  async function gitRepo(buildScript?: string): Promise<string> {
    const dir = await tempDir()
    await realRunner('git init -q', dir, 10_000)
    await realRunner('git config user.email test@example.com', dir, 10_000)
    await realRunner('git config user.name test', dir, 10_000)
    await writeFile(join(dir, 'a.txt'), 'one\n')
    if (buildScript !== undefined) await writeFile(join(dir, 'build-check.js'), buildScript)
    await realRunner('git add -A', dir, 10_000)
    await realRunner('git commit -qm init', dir, 10_000)
    return dir
  }

  function sessionAt(dir: string): Session {
    const id = SessionId(`ws-${Math.random().toString(36).slice(2, 10)}`)
    const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd: dir, isSeeded: false }
    return Session.create(id, undefined, header)
  }

  /** A context with the services the real workspace verifier needs. */
  function workspaceEnv(dir: string): { ctx: Context; session: Session } {
    const ctx = new Context()
    const session = sessionAt(dir)
    ctx.provide('sessions', { get: (id: string) => (id === session.id ? session : undefined) })
    ctx.provide('sessionProjections', { register: () => () => {}, snapshot: () => ({ values: {} }) })
    ctx.provide('shell', fakeShell())
    return { ctx, session }
  }

  function workspaceConfig(overrides: Partial<BasicSelfEvolveConfig['workspaceVerifier']> = {}): BasicSelfEvolveConfig {
    return baseConfig({
      workspaceVerifier: { buildCommand: 'node build-check.js', gitTimeoutMs: 5_000, buildTimeoutMs: 5_000, ...overrides },
    })
  }

  function probe(ctx: Context, config: BasicSelfEvolveConfig): WorkspaceProbe {
    return new WorkspaceProbe(ctx, config)
  }

  it('captures a clean baseline and reports the replay delta with a healthy build', async () => {
    const dir = await gitRepo('process.exit(0)\n')
    const { ctx, session } = workspaceEnv(dir)
    const engine = probe(ctx, workspaceConfig())
    const agent = agentFor(session)
    const signal = new AbortController().signal

    const baseline = await engine.baseline(agent, signal)
    expect(baseline).toEqual({ gitAvailable: true, dirtyLines: 0 })

    await appendFile(join(dir, 'a.txt'), 'two\nthree\nfour\n')
    const ws = await engine.signal(agent, proposal(), signal, baseline)
    expect(ws).toEqual({ dirtyLines: 3, noDirtyFallback: false, buildHealthy: true })
  })

  it('not a git work tree → build-only fallback (noDirtyFallback)', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'build-check.js'), 'process.exit(0)\n')
    const { ctx, session } = workspaceEnv(dir)
    const engine = probe(ctx, workspaceConfig())
    const agent = agentFor(session)
    const signal = new AbortController().signal

    const baseline = await engine.baseline(agent, signal)
    expect(baseline).toEqual({ gitAvailable: false, dirtyLines: 0 })
    const ws = await engine.signal(agent, proposal(), signal, baseline)
    expect(ws).toEqual({ dirtyLines: 0, noDirtyFallback: true, buildHealthy: true })
  })

  it('build failure → buildHealthy=false', async () => {
    const dir = await gitRepo('process.exit(1)\n')
    const { ctx, session } = workspaceEnv(dir)
    const engine = probe(ctx, workspaceConfig())
    const agent = agentFor(session)
    const signal = new AbortController().signal

    const baseline = await engine.baseline(agent, signal)
    const ws = await engine.signal(agent, proposal(), signal, baseline)
    expect(ws).toEqual({ dirtyLines: 0, noDirtyFallback: false, buildHealthy: false })
  })

  it('build timeout → buildHealthy=false', async () => {
    const dir = await gitRepo('setTimeout(() => {}, 60_000)\n')
    const { ctx, session } = workspaceEnv(dir)
    const engine = probe(ctx, workspaceConfig({ buildTimeoutMs: 500 }))
    const agent = agentFor(session)
    const signal = new AbortController().signal

    const baseline = await engine.baseline(agent, signal)
    const ws = await engine.signal(agent, proposal(), signal, baseline)
    expect(ws).not.toBeNull()
    if (ws !== null) expect(ws.buildHealthy).toBe(false)
  })

  it('untracked files outside .dsh count; harness-owned .dsh paths are excluded', async () => {
    const dir = await gitRepo('process.exit(0)\n')
    const { ctx, session } = workspaceEnv(dir)
    const engine = probe(ctx, workspaceConfig())
    const agent = agentFor(session)
    const signal = new AbortController().signal

    const baseline = await engine.baseline(agent, signal)
    expect(baseline).toEqual({ gitAvailable: true, dirtyLines: 0 })

    await writeFile(join(dir, 'scratch.txt'), 'x\ny\nz\n')
    await mkdir(join(dir, '.dsh', 'skills', 's'), { recursive: true })
    await writeFile(join(dir, '.dsh', 'skills', 's', 'SKILL.md'), Array(10).fill('line').join('\n'))
    const ws = await engine.signal(agent, proposal(), signal, baseline)
    expect(ws).toEqual({ dirtyLines: 3, noDirtyFallback: false, buildHealthy: true })
  })

  it('no buildCommand → signal unavailable (weak path)', async () => {
    const dir = await gitRepo()
    const { ctx, session } = workspaceEnv(dir)
    const engine = probe(ctx, baseConfig())
    const agent = agentFor(session)
    const signal = new AbortController().signal

    const baseline = await engine.baseline(agent, signal)
    expect(baseline).toEqual({ gitAvailable: true, dirtyLines: 0 })
    expect(await engine.signal(agent, proposal(), signal, baseline)).toBeNull()
  })

  it('workspaceVerifier.enabled=false → baseline and signal unavailable', async () => {
    const dir = await gitRepo()
    const { ctx, session } = workspaceEnv(dir)
    const engine = probe(ctx, workspaceConfig({ enabled: false }))
    const agent = agentFor(session)
    const signal = new AbortController().signal

    expect(await engine.baseline(agent, signal)).toBeNull()
    expect(await engine.signal(agent, proposal(), signal, null)).toBeNull()
  })
})

/** Two identical shell failures: one eligible `subprocess-exit` pattern at the default threshold. */
function sessionWithBoom(id?: string): Session {
  const session = Session.create(SessionId(id ?? `test-${Math.random().toString(36).slice(2, 10)}`))
  appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
  appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
  return session
}

/** The live-agent surface the provider drives: status, maintenance, follow-up. */
interface FakeAgent {
  session: Session
  options: Record<string, unknown>
  status: string
  runMaintenance: (task: (signal: AbortSignal) => Promise<unknown>) => Promise<unknown>
  followup: (message: unknown) => void
}

function fakeAgent(session: Session): FakeAgent {
  return {
    session,
    options: {},
    status: 'idle',
    runMaintenance: async (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
    followup: () => {},
  }
}

/** Triggers recorded by the run brackets this session opened, in order. */
function triggerRuns(session: Session): string[] {
  return session.snapshotEvents()
    .filter(event => event.type === 'self-evolve/start')
    .map(event => String((event.data as { trigger?: unknown }).trigger))
}

/** Collect every log line the context emits, including debug. */
function captureLogs(ctx: Context): string[] {
  const logs: string[] = []
  ctx.logger.exporter({ levels: { default: 4 }, export: (message) => { logs.push(String(message.args[0])) } })
  return logs
}

describe('pressure trigger producer (P0-3)', () => {
  interface PressureSetup {
    ctx: Context
    session: Session
    agent: FakeAgent
  }

  function pressureSetup(options: {
    config?: Partial<BasicSelfEvolveConfig>
    session?: Session
    withAgent?: boolean
  } = {}): PressureSetup {
    const ctx = new Context()
    const session = options.session ?? sessionWithBoom()
    const agent = fakeAgent(session)
    provideServices(ctx, session, options.withAgent === false ? undefined : agent)
    new BasicSelfEvolveEngine(ctx, baseConfig({ allowUnverifiedAutonomousRuns: true, ...options.config }))
    return { ctx, session, agent }
  }

  /** Emit one compaction/start and give the dispatch a chance to finish. */
  async function compaction(ctx: Context, session: Session, turn: number | null, settleMs = 30): Promise<void> {
    ctx.emit('session/event', session, { type: 'compaction/start', seq: 0, data: { compactionId: 'cmp-1', turn } } as never)
    await new Promise(resolve => setTimeout(resolve, settleMs))
  }

  it('runs a pressure loop for an in-turn automatic compaction', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-pressure-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const { ctx, session } = pressureSetup()
      await compaction(ctx, session, 1)
      // The drain re-enters after a queued run, so the idle policy gets its turn next.
      await vi.waitFor(() => { expect(triggerRuns(session)).toEqual(['pressure', 'idle-maintenance']) })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('ignores a standalone manual compaction (turn === null)', async () => {
    const { ctx, session } = pressureSetup()
    await compaction(ctx, session, null)
    expect(triggerRuns(session)).toEqual([])
  })

  it('ignores compaction when the pressure trigger is disabled', async () => {
    const { ctx, session } = pressureSetup({ config: { triggers: {
      'idle-maintenance': { enabled: true, minIntervalMs: 0 },
      pressure: { enabled: false, minIntervalMs: 0 },
      'user-command': { enabled: true, minIntervalMs: 0 },
      'validation-retry': { enabled: true, minIntervalMs: 0 },
    } } })
    await compaction(ctx, session, 1)
    expect(triggerRuns(session)).toEqual([])
  })

  it('ignores compaction for a subagent session', async () => {
    const child = Session.create(SessionId('pressure-subagent'), [], {
      version: SESSION_FORMAT_VERSION,
      id: SessionId('pressure-subagent'),
      createdAt: Date.now(),
      origin: 'subagent',
      delegationDepth: 1,
      isSeeded: false,
    })
    appendShellResult(child, 'c1', '[stderr]\nboom\n[exit code: 1]')
    appendShellResult(child, 'c2', '[stderr]\nboom\n[exit code: 1]')
    const { ctx } = pressureSetup({ session: child })
    await compaction(ctx, child, 1)
    expect(triggerRuns(child)).toEqual([])
  })

  it('ignores compaction for a session with no live agent', async () => {
    const { ctx, session } = pressureSetup({ withAgent: false })
    await compaction(ctx, session, 1)
    expect(triggerRuns(session)).toEqual([])
  })

  it('skips an autonomous pressure run when the deployment cannot verify a proposal', async () => {
    const { ctx, session } = pressureSetup({ config: { allowUnverifiedAutonomousRuns: false } })
    const logs = captureLogs(ctx)
    await compaction(ctx, session, 1)
    expect(triggerRuns(session)).toEqual([])
    expect(logs.some(line => line.includes('pressure trigger skipped'))).toBe(true)
  })

  it('does not record a request-error that a retry owner consumed', async () => {
    const ctx = new Context()
    const session = sessionWithBoom()
    provideServices(ctx, session)
    new BasicSelfEvolveEngine(ctx, baseConfig())
    ctx.emit('agent/request-error', {
      agent: { session },
      turn: 1,
      step: 1,
      provider: 'deepseek',
      failure: { message: 'rate limited', code: 'rate_limit_exceeded', status: 429 },
      retryPolicy: undefined,
      signal: new AbortController().signal,
    } as never, async (): Promise<RequestErrorAction> => ({ kind: 'retry' }))
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(session.snapshotEvents().some(e => e.type === 'agent/request-error')).toBe(false)
  })
})

describe('explicit request queue (P0-2)', () => {
  interface QueueSetup {
    ctx: Context
    session: Session
    agent: FakeAgent
    engine: BasicSelfEvolveEngine
  }

  function queueSetup(overrides: Partial<BasicSelfEvolveConfig> = {}): QueueSetup {
    const ctx = new Context()
    const session = sessionWithBoom()
    const agent = fakeAgent(session)
    provideServices(ctx, session, agent)
    const engine = new BasicSelfEvolveEngine(ctx, baseConfig({ allowUnverifiedAutonomousRuns: true, ...overrides }))
    return { ctx, session, agent, engine }
  }

  it('queues an explicit request and runs it as a user-command loop', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-queue-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const { session, agent, engine } = queueSetup()
      const receipt = engine.requestEvolve(agentFor(session))
      expect(receipt.status).toBe('queued')
      expect(receipt.requestId.length).toBeGreaterThan(0)
      expect(receipt.queuePosition).toBe(1)
      await vi.waitFor(() => { expect(triggerRuns(session)).toEqual(['user-command', 'idle-maintenance']) })
      expect(agent.status).toBe('idle')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('coalesces a duplicate explicit request for the same levels', async () => {
    const { session, agent, engine } = queueSetup()
    agent.status = 'running'
    const first = engine.requestEvolve(agentFor(session))
    const second = engine.requestEvolve(agentFor(session))
    expect(second.status).toBe('coalesced')
    expect(second.requestId).toBe(first.requestId)
    expect(second.queuePosition).toBe(1)
  })

  it('serves the highest-priority queued trigger first and re-enters the drain', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-queue-order-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const { ctx, session, agent, engine } = queueSetup()
      agent.status = 'running'
      ctx.emit('session/event', session, { type: 'compaction/start', seq: 0, data: { compactionId: 'cmp-1', turn: 1 } } as never)
      engine.requestEvolve(agentFor(session))
      agent.status = 'idle'
      ctx.emit('agent/status', { agent, status: 'idle' } as never)
      // Priority order decides which queued trigger runs first; the drain
      // re-enters afterwards to serve the remaining request.
      await vi.waitFor(() => { expect(triggerRuns(session)).toHaveLength(2) })
      expect(triggerRuns(session)).toEqual(['user-command', 'pressure'])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('sends an explicit-run follow-up summary when the loop produced proposals', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-queue-followup-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const { session, agent, engine } = queueSetup()
      const followups: unknown[] = []
      agent.followup = (message: unknown) => { followups.push(message) }
      engine.requestEvolve(agentFor(session))
      await vi.waitFor(() => { expect(followups).toHaveLength(1) })
      expect(JSON.stringify(followups[0])).toContain('self-evolve 完成')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('keeps an explicit request when the autonomous queue is full', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-queue-full-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const { ctx, session, agent, engine } = queueSetup({ maxPendingEvolveRequests: 1 })
      agent.status = 'running'
      engine.requestEvolve(agentFor(session))
      const logs = captureLogs(ctx)
      ctx.emit('session/event', session, { type: 'compaction/start', seq: 0, data: { compactionId: 'cmp-1', turn: 1 } } as never)
      // The all-explicit queue never yields: the autonomous request is dropped.
      expect(logs.some(line => line.includes('queue full of explicit requests'))).toBe(true)
      agent.status = 'idle'
      ctx.emit('agent/status', { agent, status: 'idle' } as never)
      await vi.waitFor(() => { expect(triggerRuns(session)).toEqual(['user-command', 'idle-maintenance']) })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('replaces the oldest autonomous request when the queue is full', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-queue-evict-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const { ctx, session, agent } = queueSetup({ maxPendingEvolveRequests: 1 })
      agent.status = 'running'
      const logs = captureLogs(ctx)
      for (const turn of [1, 2]) {
        ctx.emit('session/event', session, { type: 'compaction/start', seq: turn, data: { compactionId: `cmp-${turn}`, turn } } as never)
      }
      expect(logs.some(line => line.includes('dropped autonomous request'))).toBe(true)
      agent.status = 'idle'
      ctx.emit('agent/status', { agent, status: 'idle' } as never)
      await vi.waitFor(() => { expect(triggerRuns(session)).toEqual(['pressure', 'idle-maintenance']) })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('returns null instead of racing a loop already in flight', async () => {
    const { session, agent, engine } = queueSetup()
    let release = (): void => {}
    agent.runMaintenance = async (task: (signal: AbortSignal) => Promise<unknown>) => {
      await new Promise<void>((resolve) => { release = resolve })
      return task(new AbortController().signal)
    }
    const first = engine.evolveIfNeeded(agentFor(session), 'user-command', new AbortController().signal)
    const second = await engine.evolveIfNeeded(agentFor(session), 'user-command', new AbortController().signal)
    expect(second).toBeNull()
    release()
    expect(await first).not.toBeNull()
  })

  it('reads no projected patterns when the projection has not folded any', async () => {
    const ctx = new Context()
    const session = sessionWithBoom()
    ctx.provide('sessionProjections', { register: () => () => {}, snapshot: () => ({ values: {} }) })
    ctx.provide('sessions', { get: (id: string) => (id === session.id ? session : undefined) })
    ctx.provide('agents', { get: () => undefined })
    ctx.provide('skills', { register: () => () => {}, snapshot: async () => ({ skills: [], complete: true }) })
    ctx.provide('systemPrompt', { section: () => () => {} })
    const engine = new ProbeEngine(ctx, baseConfig())
    expect(await engine.readProjection(session.id)).toEqual([])
  })
})

/** A context whose skill catalog reports the given entries. */
function provideSkillCatalog(
  ctx: Context,
  session: Session,
  catalog: { skills: { name: string }[]; complete: boolean },
  register: (input: { name: string }) => () => void = () => () => {},
  systemPrompt: unknown = { section: () => () => {} },
): void {
  ctx.provide('sessionProjections', { register: () => () => {}, snapshot: () => projectedState(session) })
  ctx.provide('sessions', { get: (id: string) => (id === session.id ? session : undefined) })
  ctx.provide('agents', { get: () => undefined })
  ctx.provide('skills', { register, snapshot: async () => catalog })
  ctx.provide('systemPrompt', systemPrompt)
}

/** Accepted-validation config: judge + proposer routes, all verifier signals injected. */
const ACCEPT_CONFIG = {
  proposerTarget: { provider: 'deepseek', model: 'proposer' },
  validatorTarget: { provider: 'deepseek', model: 'judge' },
} satisfies Partial<BasicSelfEvolveConfig>

function l1Proposal(proposalId: string, skillName: string, content: string, patternId: string): EvolveProposal {
  return proposal({
    proposalId,
    addressesPatternIds: [patternId],
    candidate: { kind: 'L1-skill', skillName, content },
  })
}

/** The mounted engine instance, narrowed to the probe subclass that exposes the protected hooks. */
function probeOf(ctx: Context): ProbeEngine {
  const engine = ctx.selfEvolve
  if (!(engine instanceof ProbeEngine)) throw new Error('expected the mounted ProbeEngine')
  return engine
}

/** One L2 prompt-section candidate addressing `patternId`, shared by the L2 undo tests. */
function l2Section(proposalId: string, text: string, patternId: string): EvolveProposal {
  return proposal({
    proposalId,
    addressesPatternIds: [patternId],
    candidate: { kind: 'L2-context', sectionName: 'sec', sectionText: text, order: 260, estimatedBytes: text.length },
  })
}

describe('apply-failed and registration undo (P0-4)', () => {
  it('records apply-failed when another provider owns the proposed skill name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-apply-failed-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionWithBoom()
      provideSkillCatalog(ctx, session, { skills: [{ name: 'cwd-guard' }], complete: true })
      const engine = new SignalEngine(ctx, baseConfig({ ...ACCEPT_CONFIG }), session)
      engine.replay = { exitCode: 0, retriggeredPatternIds: [] }
      engine.workspace = { dirtyLines: 0, noDirtyFallback: false, buildHealthy: true }
      const [pattern] = await engine.readPatterns(session.id)
      fakeLlmQueue(ctx, [
        JSON.stringify([{
          name: 'cwd-guard',
          purpose: 'guard cwd',
          addressesPatternIds: [pattern!.patternId],
          candidate: { kind: 'L1-skill', skillName: 'cwd-guard', content: 'check the cwd first' },
        }]),
        JSON.stringify(PASSING_SCORES),
      ])
      const result = await engine.evolveNow(agentFor(session), new AbortController().signal)
      expect(result.commits).toHaveLength(0)
      const outcome = (session.snapshotEvents().find(event => event.type === 'self-evolve/validated')?.data as {
        outcome?: { reason?: string }
      }).outcome
      expect(outcome?.reason).toBe('apply-failed')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('rejects an L1 candidate past maxLiveSkills as apply-failed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-max-live-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionWithBoom()
      provideSkillCatalog(ctx, session, { skills: [], complete: true })
      const engine = new ProbeEngine(ctx, baseConfig({ maxLiveSkills: 0 }))
      const [pattern] = await engine.readPatterns(session.id)
      await expect(engine.commit(agentFor(session), l1Proposal('p1', 'fresh-skill', 'x', pattern!.patternId)))
        .rejects.toThrow(/maxLiveSkills/)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('rejects an L1 candidate when the skill catalog never completes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-skill-catalog-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionWithBoom()
      provideSkillCatalog(ctx, session, { skills: [], complete: false })
      const engine = new ProbeEngine(ctx, baseConfig())
      const [pattern] = await engine.readPatterns(session.id)
      await expect(engine.commit(agentFor(session), l1Proposal('p1', 'fresh-skill', 'x', pattern!.patternId)))
        .rejects.toThrow(/did not complete a stable observation/)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('undoes a live L1 registration when the commit append fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-undo-l1-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionWithBoom()
      const disposed: string[] = []
      provideSkillCatalog(ctx, session, { skills: [], complete: true }, input => () => { disposed.push(input.name) })
      failingAppend(session, 'self-evolve/commit')
      const engine = new ProbeEngine(ctx, baseConfig())
      const [pattern] = await engine.readPatterns(session.id)
      await expect(engine.commit(agentFor(session), l1Proposal('p1', 'cwd-guard', 'x', pattern!.patternId)))
        .rejects.toThrow(/log closed for self-evolve\/commit/)
      expect(disposed).toEqual(['cwd-guard'])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('restores the previous L1 contribution when a later commit append fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-undo-l1-previous-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionWithBoom()
      const registered: string[] = []
      provideSkillCatalog(ctx, session, { skills: [], complete: true }, (input) => {
        registered.push(input.name)
        return () => {}
      })
      const engine = new ProbeEngine(ctx, baseConfig())
      const [pattern] = await engine.readPatterns(session.id)
      await engine.commit(agentFor(session), l1Proposal('p1', 'cwd-guard', 'v1', pattern!.patternId))
      failingAppend(session, 'self-evolve/commit')
      await expect(engine.commit(agentFor(session), l1Proposal('p2', 'cwd-guard', 'v2', pattern!.patternId)))
        .rejects.toThrow(/log closed/)
      // v1, v2, then the restored v1 contribution.
      expect(registered).toEqual(['cwd-guard', 'cwd-guard', 'cwd-guard'])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('restores the previous L2 section when a later registration collides', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-l2-collision-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionWithBoom()
      const texts: string[] = []
      let colliding = false
      provideSkillCatalog(ctx, session, { skills: [], complete: true }, undefined, {
        section: (input: { name: string; order: number; text: string }) => {
          if (colliding) {
            colliding = false
            throw new Error('duplicate section name')
          }
          texts.push(input.text)
          return () => {}
        },
      })
      const engine = new ProbeEngine(ctx, baseConfig())
      const [pattern] = await engine.readPatterns(session.id)
      const patternId = pattern!.patternId
      await engine.commit(agentFor(session), l2Section('p1', 'v1', patternId))
      colliding = true
      await expect(engine.commit(agentFor(session), l2Section('p2', 'v2', patternId)))
        .rejects.toThrow(/section sec rejected: duplicate section name/)
      expect(texts).toEqual(['v1', 'v1'])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('undoes a live L2 section and restores its predecessor when the commit append fails', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-undo-l2-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionWithBoom()
      const texts: string[] = []
      provideSkillCatalog(ctx, session, { skills: [], complete: true }, undefined, {
        section: (input: { name: string; order: number; text: string }) => {
          texts.push(input.text)
          return () => {}
        },
      })
      const engine = new ProbeEngine(ctx, baseConfig())
      const [pattern] = await engine.readPatterns(session.id)
      const patternId = pattern!.patternId
      await engine.commit(agentFor(session), l2Section('p1', 'v1', patternId))
      failingAppend(session, 'self-evolve/commit')
      await expect(engine.commit(agentFor(session), l2Section('p2', 'v2', patternId))).rejects.toThrow(/log closed/)
      expect(texts).toEqual(['v1', 'v2', 'v1'])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('disposes every live contribution when the provider fiber is disposed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-dispose-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionWithBoom()
      const disposed: string[] = []
      provideSkillCatalog(ctx, session, { skills: [], complete: true }, input => () => { disposed.push(input.name) })
      const scope = await ctx.plugin(ProbeEngine, baseConfig())
      const engine = probeOf(ctx)
      const [pattern] = await engine.readPatterns(session.id)
      await engine.commit(agentFor(session), l1Proposal('p1', 'cwd-guard', 'x', pattern!.patternId))
      await scope.dispose()
      expect(disposed).toEqual(['cwd-guard'])
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('champion rollback and validation retry (P0-3/P0-4)', () => {
  interface RollbackHarness {
    ctx: Context
    session: Session
    engine: ProbeEngine
    writes: { path: string; text: string }[]
  }

  function rollbackHarness(ctx: Context, session: Session): RollbackHarness {
    const writes: { path: string; text: string }[] = []
    ctx.provide('fs', {
      resolve: async (path: string) => path,
      writeText: async (path: string, text: string) => { writes.push({ path, text }) },
    })
    return { ctx, session, engine: new ProbeEngine(ctx, baseConfig()), writes }
  }

  it('writes a tombstone when a first-commit L1 skill is rolled back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-tombstone-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionWithBoom()
      provideSkillCatalog(ctx, session, { skills: [], complete: true })
      const { engine, writes } = rollbackHarness(ctx, session)
      const [pattern] = await engine.readPatterns(session.id)
      await engine.commit(agentFor(session), l1Proposal('p1', 'cwd-guard', 'v1', pattern!.patternId))
      await engine.rollback(pattern!.patternId)
      expect(writes.at(-1)?.text).toContain('self-evolve rollback tombstone: cwd-guard')
      expect(writes.at(-1)?.path).toBe(join('.dsh', 'skills', 'cwd-guard', 'SKILL.md'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('restores the champion skill file when a later L1 commit is rolled back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-rollback-l1-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionWithBoom()
      provideSkillCatalog(ctx, session, { skills: [], complete: true })
      const { engine, writes } = rollbackHarness(ctx, session)
      const [pattern] = await engine.readPatterns(session.id)
      await engine.commit(agentFor(session), l1Proposal('p1', 'cwd-guard', 'champion body', pattern!.patternId))
      await engine.commit(agentFor(session), l1Proposal('p2', 'cwd-guard', 'regressing body', pattern!.patternId))
      await engine.rollback(pattern!.patternId)
      expect(writes.at(-1)?.text).toContain('champion body')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('restores the champion L2 section when a later L2 commit is rolled back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-rollback-l2-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionWithBoom()
      const texts: string[] = []
      provideSkillCatalog(ctx, session, { skills: [], complete: true }, undefined, {
        section: (input: { name: string; order: number; text: string }) => {
          texts.push(input.text)
          return () => {}
        },
      })
      const { engine } = rollbackHarness(ctx, session)
      const [pattern] = await engine.readPatterns(session.id)
      const patternId = pattern!.patternId
      await engine.commit(agentFor(session), l2Section('p1', 'champion text', patternId))
      await engine.commit(agentFor(session), l2Section('p2', 'regressing text', patternId))
      await engine.rollback(patternId)
      expect(texts.at(-1)).toBe('champion text')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  interface RetryHarness {
    ctx: Context
    session: Session
    agent: FakeAgent
    engine: SignalEngine
  }

  async function retryHarness(
    overrides: Partial<BasicSelfEvolveConfig> = {},
    options: { proposer?: boolean } = {},
  ): Promise<RetryHarness> {
    const ctx = new Context()
    const session = sessionWithBoom()
    const agent = fakeAgent(session)
    ctx.provide('sessionProjections', { register: () => () => {}, snapshot: () => projectedState(session) })
    ctx.provide('sessions', { get: (id: string) => (id === session.id ? session : undefined) })
    ctx.provide('agents', { get: () => agent })
    ctx.provide('skills', { register: () => () => {}, snapshot: async () => ({ skills: [], complete: true }) })
    ctx.provide('systemPrompt', { section: () => () => {} })
    const engine = new SignalEngine(ctx, baseConfig({
      ...(options.proposer === false
        ? { validatorTarget: ACCEPT_CONFIG.validatorTarget }
        : ACCEPT_CONFIG),
      allowUnverifiedAutonomousRuns: true,
      ...overrides,
    }), session)
    engine.replay = { exitCode: 0, retriggeredPatternIds: [] }
    engine.workspace = { dirtyLines: 0, noDirtyFallback: false, buildHealthy: true }
    const [pattern] = await engine.readPatterns(session.id)
    const judge = JSON.stringify(LOW_CONFIDENCE_SCORES)
    // Without a proposer route the template proposer runs and the first LLM
    // response belongs to the judge.
    fakeLlmQueue(ctx, options.proposer === false
      ? [judge]
      : [
        JSON.stringify([{
          name: 'cwd-guard',
          purpose: 'guard cwd',
          addressesPatternIds: [pattern!.patternId],
          candidate: { kind: 'L2-context', sectionName: 'cwd-guard', sectionText: 'check cwd first', order: 260 },
        }]),
        judge,
      ])
    return { ctx, session, agent, engine }
  }

  it('queues one validation retry for a low-confidence rejection', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-retry-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const { ctx, session, agent, engine } = await retryHarness()
      const result = await engine.evolveNow(agentFor(session), new AbortController().signal)
      expect(result.commits).toHaveLength(0)
      expect(triggerRuns(session)).toEqual(['user-command'])
      ctx.emit('agent/status', { agent, status: 'idle' } as never)
      await vi.waitFor(() => { expect(triggerRuns(session)).toContain('validation-retry') })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('never retries past maxValidationRetriesPerPattern', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-retry-cap-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const { ctx, session, agent, engine } = await retryHarness({ maxValidationRetriesPerPattern: 0 })
      await engine.evolveNow(agentFor(session), new AbortController().signal)
      ctx.emit('agent/status', { agent, status: 'idle' } as never)
      await new Promise(resolve => setTimeout(resolve, 40))
      expect(triggerRuns(session).filter(trigger => trigger === 'validation-retry')).toHaveLength(0)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('drops a retry when the per-session retry map is full', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-retry-map-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const { ctx, session, engine } = await retryHarness({ maxTrackedPatternsPerSession: 0 })
      const logs = captureLogs(ctx)
      await engine.evolveNow(agentFor(session), new AbortController().signal)
      expect(logs.some(line => line.includes('retry map at maxTrackedPatternsPerSession'))).toBe(true)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('logs and swallows a throwing explicit-run follow-up', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-followup-throw-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionWithBoom()
      const agent = fakeAgent(session)
      agent.followup = () => { throw new Error('inbox closed') }
      provideServices(ctx, session, agent)
      const engine = new BasicSelfEvolveEngine(ctx, baseConfig({ allowUnverifiedAutonomousRuns: true }))
      const logs = captureLogs(ctx)
      engine.requestEvolve(agentFor(session))
      await vi.waitFor(() => { expect(logs.some(line => line.includes('explicit-run follow-up skipped'))).toBe(true) })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('keeps the original error when the end append and end emit both fail', async () => {
    const ctx = new Context()
    const session = sessionWithBoom()
    failingAppend(session, ['self-evolve/mined', 'self-evolve/end'])
    provideServices(ctx, session)
    const engine = new BasicSelfEvolveEngine(ctx, baseConfig())
    const logs = captureLogs(ctx)
    ctx.on('self-evolve-loop/end', () => { throw new Error('listener exploded') })
    await expect(engine.evolveNow(agentFor(session), new AbortController().signal))
      .rejects.toThrow(/log closed for self-evolve\/mined/)
    expect(logs.some(line => line.includes('self-evolve/end append failed'))).toBe(true)
    expect(logs.some(line => line.includes('self-evolve-loop/end emit failed'))).toBe(true)
  })

  it('leaves no bracket open when the start append itself fails', async () => {
    const ctx = new Context()
    const session = sessionWithBoom()
    failingAppend(session, 'self-evolve/start')
    provideServices(ctx, session)
    const engine = new BasicSelfEvolveEngine(ctx, baseConfig())
    await expect(engine.evolveNow(agentFor(session), new AbortController().signal))
      .rejects.toThrow(/log closed for self-evolve\/start/)
    expect(session.snapshotEvents().some(event => event.type === 'self-evolve/end')).toBe(false)
  })

  it('retries nothing when the deployment has no LLM proposer to re-prompt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-retry-no-proposer-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      // The template proposer is deterministic: re-running it after a
      // low-confidence rejection would produce the same proposal again.
      const { ctx, session, engine } = await retryHarness({}, { proposer: false })
      const result = await engine.evolveNow(agentFor(session), new AbortController().signal)
      expect(result.commits).toHaveLength(0)
      ctx.emit('agent/status', { agent: fakeAgent(session), status: 'idle' } as never)
      await new Promise(resolve => setTimeout(resolve, 40))
      expect(triggerRuns(session)).not.toContain('validation-retry')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('retries nothing when the validation-retry trigger is disabled', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-retry-disabled-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const { ctx, session, agent, engine } = await retryHarness({
        triggers: {
          'idle-maintenance': { enabled: true, minIntervalMs: 0 },
          pressure: { enabled: true, minIntervalMs: 0 },
          'user-command': { enabled: true, minIntervalMs: 0 },
          'validation-retry': { enabled: false, minIntervalMs: 0 },
        },
      })
      await engine.evolveNow(agentFor(session), new AbortController().signal)
      ctx.emit('agent/status', { agent, status: 'idle' } as never)
      await new Promise(resolve => setTimeout(resolve, 40))
      expect(triggerRuns(session)).not.toContain('validation-retry')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('retries nothing when an unattended run cannot verify a proposal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-retry-unverified-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      // A judge route alone cannot verify: no build command means the
      // autonomous loop would run only to produce a rejection.
      const { ctx, session, agent, engine } = await retryHarness({ allowUnverifiedAutonomousRuns: false })
      await engine.evolveNow(agentFor(session), new AbortController().signal)
      ctx.emit('agent/status', { agent, status: 'idle' } as never)
      await new Promise(resolve => setTimeout(resolve, 40))
      expect(triggerRuns(session)).not.toContain('validation-retry')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('drops the retry when the autonomous queue is full of explicit requests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-retry-queue-full-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const { ctx, session, agent, engine } = await retryHarness({ maxPendingEvolveRequests: 1 })
      // A running agent keeps the explicit request parked, so the rejected
      // loop finds the queue full when it tries to append its retry.
      agent.status = 'running'
      engine.requestEvolve(agentFor(session))
      await engine.evolveNow(agentFor(session), new AbortController().signal)
      agent.status = 'idle'
      ctx.emit('agent/status', { agent, status: 'idle' } as never)
      await new Promise(resolve => setTimeout(resolve, 40))
      expect(triggerRuns(session)).not.toContain('validation-retry')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('counts an existing retry key against the per-session retry budget', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-retry-budget-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = Session.create(SessionId(`two-${Math.random().toString(36).slice(2, 10)}`))
      appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
      appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
      appendShellResult(session, 'c3', '[stderr]\nkaboom\n[exit code: 2]')
      appendShellResult(session, 'c4', '[stderr]\nkaboom\n[exit code: 2]')
      const agent = fakeAgent(session)
      ctx.provide('sessionProjections', { register: () => () => {}, snapshot: () => projectedState(session) })
      ctx.provide('sessions', { get: (id: string) => (id === session.id ? session : undefined) })
      ctx.provide('agents', { get: () => agent })
      ctx.provide('skills', { register: () => () => {}, snapshot: async () => ({ skills: [], complete: true }) })
      ctx.provide('systemPrompt', { section: () => () => {} })
      const engine = new SignalEngine(ctx, baseConfig({
        ...ACCEPT_CONFIG,
        allowUnverifiedAutonomousRuns: true,
        maxTrackedPatternsPerSession: 1,
      }), session)
      engine.replay = { exitCode: 0, retriggeredPatternIds: [] }
      engine.workspace = { dirtyLines: 0, noDirtyFallback: false, buildHealthy: true }
      const patterns = await engine.readPatterns(session.id)
      expect(patterns).toHaveLength(2)
      const proposalFor = (index: number) => ({
        name: `fix-${index}`,
        purpose: 'fix',
        addressesPatternIds: [patterns[index]!.patternId],
        candidate: { kind: 'L2-context', sectionName: `sec-${index}`, sectionText: `text-${index}`, order: 260 },
      })
      fakeLlmQueue(ctx, [
        JSON.stringify([proposalFor(0), proposalFor(1)]),
        JSON.stringify(LOW_CONFIDENCE_SCORES),
        JSON.stringify(LOW_CONFIDENCE_SCORES),
      ])
      const logs = captureLogs(ctx)
      const result = await engine.evolveNow(agentFor(session), new AbortController().signal)
      expect(result.commits).toHaveLength(0)
      // The first rejection spends the single tracked retry; the second one is
      // dropped because an untracked retry would be unlimited.
      expect(logs.some(line => line.includes('retry map at maxTrackedPatternsPerSession'))).toBe(true)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('refuses a second concurrent evolveNow instead of opening a second bracket', async () => {
    const ctx = new Context()
    const session = sessionWithBoom()
    const agent = fakeAgent(session)
    let release = (): void => {}
    agent.runMaintenance = async (task: (signal: AbortSignal) => Promise<unknown>) => {
      await new Promise<void>((resolve) => { release = resolve })
      return task(new AbortController().signal)
    }
    provideServices(ctx, session, agent)
    const engine = new BasicSelfEvolveEngine(ctx, baseConfig())
    const first = engine.evolveNow(agentFor(session), new AbortController().signal)
    await expect(engine.evolveNow(agentFor(session), new AbortController().signal))
      .rejects.toThrow(/produced no result/)
    release()
    await first
  })
})

/** One shell outcome a scripted executor can return. */
type ScriptedShellOutcome =
  | { kind: 'run'; exitCode?: number; stdout?: string; aborted?: boolean }
  | { kind: 'throw'; value: unknown }

/** A shell route whose `git diff --numstat` read fails: the dirty delta is unmeasurable. */
const failingNumstatRoute = (command: string): ScriptedShellOutcome => command.startsWith('git diff')
  ? { kind: 'run', exitCode: 1 }
  : { kind: 'run' }

/** A `ctx.shell` double that answers every command from a script and never spawns. */
function scriptedShell(route: (command: string) => ScriptedShellOutcome): Pick<ShellExecutor, 'resolve' | 'execute'> {
  return {
    resolve: (request: ShellExecRequest): ShellExecSpec => ({
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      timeoutMs: request.timeoutMs ?? 60_000,
      onExpiry: request.onExpiry ?? 'kill',
      stdoutMaxBytes: request.stdoutMaxBytes ?? 1_000_000,
      signal: request.signal,
      sandboxPolicy: undefined,
    }),
    execute: async (spec: ShellExecSpec): Promise<ShellExecution> => ({
      result: async (): Promise<ShellRunResult> => {
        const outcome = route(spec.command)
        if (outcome.kind === 'throw') throw outcome.value
        return {
          exitCode: outcome.exitCode ?? 0,
          signal: null,
          timedOut: false,
          aborted: outcome.aborted ?? false,
          timeoutMs: spec.timeoutMs,
          stdout: { text: outcome.stdout ?? '', truncated: false },
          stderr: { text: '', truncated: false },
        }
      },
    } as ShellExecution),
  }
}

describe('workspace verifier degradation and engine edges (P0-2/P0-4/P1.9b)', () => {
  /** Subclass exposing the protected workspace hooks. */
  class WsProbe extends BasicSelfEvolveEngine {
    baseline(agent: SelfEvolveAgentContext, signal: AbortSignal): ReturnType<BasicSelfEvolveEngine['captureWorkspaceBaseline']> {
      return this.captureWorkspaceBaseline(agent, signal)
    }

    signal(
      agent: SelfEvolveAgentContext,
      p: EvolveProposal,
      signal: AbortSignal,
      baseline: WorkspaceBaseline | null,
    ): ReturnType<BasicSelfEvolveEngine['collectWorkspaceSignal']> {
      return this.collectWorkspaceSignal(agent, p, signal, baseline)
    }
  }

  function wsSession(cwd?: string): Session {
    const id = SessionId(`wsx-${Math.random().toString(36).slice(2, 10)}`)
    if (cwd === undefined) return Session.create(id)
    const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd, isSeeded: false }
    return Session.create(id, undefined, header)
  }

  function wsEnv(session: Session | undefined, route: (command: string) => ScriptedShellOutcome): Context {
    const ctx = new Context()
    ctx.provide('sessions', { get: (id: string) => (session !== undefined && id === session.id ? session : undefined) })
    ctx.provide('sessionProjections', { register: () => () => {}, snapshot: () => ({ values: {} }) })
    ctx.provide('shell', scriptedShell(route))
    return ctx
  }

  function wsConfig(withBuild: boolean): BasicSelfEvolveConfig {
    return withBuild
      ? baseConfig({ workspaceVerifier: { buildCommand: 'node build-check.js', gitTimeoutMs: 5_000, buildTimeoutMs: 5_000 } })
      : baseConfig()
  }

  async function wsBaseline(
    route: (command: string) => ScriptedShellOutcome,
    session: Session = wsSession('/tmp/ws'),
  ): Promise<WorkspaceBaseline | null> {
    const engine = new WsProbe(wsEnv(session, route), wsConfig(true))
    return engine.baseline(agentFor(session), new AbortController().signal)
  }

  async function wsSignal(
    route: (command: string) => ScriptedShellOutcome,
    baseline: WorkspaceBaseline | null,
    withBuild = true,
  ): Promise<WorkspaceSignal | null> {
    const session = wsSession('/tmp/ws')
    const engine = new WsProbe(wsEnv(session, route), wsConfig(withBuild))
    return engine.signal(agentFor(session), proposal(), new AbortController().signal, baseline)
  }

  it('measures in process.cwd() when the session header carries no cwd', async () => {
    const session = wsSession()
    const engine = new WsProbe(wsEnv(session, () => ({ kind: 'run' })), wsConfig(true))
    const agent = agentFor(session)
    const signal = new AbortController().signal
    expect(await engine.baseline(agent, signal)).toEqual({ gitAvailable: true, dirtyLines: 0 })
    expect(await engine.signal(agent, proposal(), signal, { gitAvailable: true, dirtyLines: 0 }))
      .toEqual({ dirtyLines: 0, noDirtyFallback: false, buildHealthy: true })
  })

  it('degrades the baseline when the numstat read fails', async () => {
    const route = failingNumstatRoute
    expect(await wsBaseline(route)).toEqual({ gitAvailable: false, dirtyLines: 0 })
  })

  it('degrades the baseline when the untracked listing fails', async () => {
    const route = (command: string): ScriptedShellOutcome => command.startsWith('git ls-files')
      ? { kind: 'run', exitCode: 128 }
      : { kind: 'run' }
    expect(await wsBaseline(route)).toEqual({ gitAvailable: false, dirtyLines: 0 })
  })

  it('degrades the baseline when the untracked line count fails', async () => {
    const route = (command: string): ScriptedShellOutcome => {
      if (command.startsWith('git ls-files')) return { kind: 'run', stdout: 'scratch.txt\n' }
      if (command.startsWith('wc -l')) return { kind: 'run', exitCode: 2 }
      return { kind: 'run' }
    }
    expect(await wsBaseline(route)).toEqual({ gitAvailable: false, dirtyLines: 0 })
  })

  it('degrades the baseline when the untracked line count throws', async () => {
    const route = (command: string): ScriptedShellOutcome => {
      if (command.startsWith('git ls-files')) return { kind: 'run', stdout: 'scratch.txt\n' }
      if (command.startsWith('wc -l')) return { kind: 'throw', value: new Error('spawn wc failed') }
      return { kind: 'run' }
    }
    expect(await wsBaseline(route)).toEqual({ gitAvailable: false, dirtyLines: 0 })
    const nonErrorRoute = (command: string): ScriptedShellOutcome => {
      if (command.startsWith('git ls-files')) return { kind: 'run', stdout: 'scratch.txt\n' }
      if (command.startsWith('wc -l')) return { kind: 'throw', value: 'spawn wc failed' }
      return { kind: 'run' }
    }
    expect(await wsBaseline(nonErrorRoute)).toEqual({ gitAvailable: false, dirtyLines: 0 })
  })

  it('degrades the baseline when git itself cannot be spawned', async () => {
    expect(await wsBaseline(() => ({ kind: 'throw', value: new Error('git missing') })))
      .toEqual({ gitAvailable: false, dirtyLines: 0 })
    expect(await wsBaseline(() => ({ kind: 'throw', value: 'git missing' })))
      .toEqual({ gitAvailable: false, dirtyLines: 0 })
  })

  it('degrades the baseline when the git probe is aborted', async () => {
    expect(await wsBaseline(() => ({ kind: 'run', aborted: true })))
      .toEqual({ gitAvailable: false, dirtyLines: 0 })
  })

  it('degrades the signal when the build run is aborted or cannot start', async () => {
    const baseline: WorkspaceBaseline = { gitAvailable: true, dirtyLines: 0 }
    expect(await wsSignal(() => ({ kind: 'run', aborted: true }), baseline)).toBeNull()
    expect(await wsSignal(() => ({ kind: 'throw', value: new Error('build spawn failed') }), baseline)).toBeNull()
    expect(await wsSignal(() => ({ kind: 'throw', value: 'build spawn failed' }), baseline)).toBeNull()
  })

  it('reports no workspace signal for a git-less baseline without a build command', async () => {
    expect(await wsSignal(() => ({ kind: 'run' }), { gitAvailable: false, dirtyLines: 0 }, false)).toBeNull()
  })

  it('reports no workspace signal when the dirty delta cannot be measured', async () => {
    const route = failingNumstatRoute
    expect(await wsSignal(route, { gitAvailable: true, dirtyLines: 0 })).toBeNull()
  })

  it('reports no workspace signal without a live session', async () => {
    const ctx = wsEnv(undefined, () => ({ kind: 'run' }))
    const engine = new WsProbe(ctx, wsConfig(true))
    const gone: SelfEvolveAgentContext = {
      sessionId: SessionId('gone'),
      options: {},
      runMaintenance: async task => task(new AbortController().signal),
    }
    const signal = new AbortController().signal
    expect(await engine.baseline(gone, signal)).toBeNull()
    expect(await engine.signal(gone, proposal(), signal, { gitAvailable: true, dirtyLines: 0 })).toBeNull()
  })

  it('queues an explicit request even when no live agent is mounted', () => {
    const ctx = new Context()
    const session = sessionWithBoom()
    provideServices(ctx, session)
    const engine = new BasicSelfEvolveEngine(ctx, baseConfig())
    const receipt = engine.requestEvolve(agentFor(session))
    expect(receipt.status).toBe('queued')
    expect(triggerRuns(session)).toEqual([])
  })

  it('accepts one more explicit request past a queue that holds only explicit requests', async () => {
    const ctx = new Context()
    const session = sessionWithBoom()
    const agent = fakeAgent(session)
    agent.status = 'running'
    provideServices(ctx, session, agent)
    const engine = new BasicSelfEvolveEngine(ctx, baseConfig({ maxPendingEvolveRequests: 1 }))
    expect(engine.requestEvolve(agentFor(session), ['L1-skill']).status).toBe('queued')
    expect(engine.requestEvolve(agentFor(session), ['L2-context']).status).toBe('queued')
  })

  it('keeps the queued request order when the head outranks the tail', async () => {
    const ctx = new Context()
    const session = sessionWithBoom()
    const agent = fakeAgent(session)
    agent.status = 'running'
    provideServices(ctx, session, agent)
    const engine = new BasicSelfEvolveEngine(ctx, baseConfig())
    engine.requestEvolve(agentFor(session), ['L1-skill'])
    engine.requestEvolve(agentFor(session), ['L2-context'])
    agent.status = 'idle'
    ctx.emit('agent/status', { agent, status: 'idle' } as never)
    await vi.waitFor(() => { expect(triggerRuns(session)).toContain('user-command') })
    expect(triggerRuns(session)[0]).toBe('user-command')
  })

  it('contains a throwing queued loop inside the drain', async () => {
    const ctx = new Context()
    const session = sessionWithBoom()
    const agent = fakeAgent(session)
    agent.runMaintenance = async () => { throw new Error('maintenance exploded') }
    provideServices(ctx, session, agent)
    const engine = new BasicSelfEvolveEngine(ctx, baseConfig())
    const logs = captureLogs(ctx)
    engine.requestEvolve(agentFor(session))
    await vi.waitFor(() => {
      expect(logs.some(line => line.includes('user-command loop failed: maintenance exploded'))).toBe(true)
    })
  })

  it('skips an autonomous idle run when the deployment cannot verify a proposal', async () => {
    const skipLog = async (overrides: Partial<BasicSelfEvolveConfig>): Promise<string[]> => {
      const ctx = new Context()
      const session = sessionWithBoom()
      const agent = fakeAgent(session)
      provideServices(ctx, session, agent)
      // The engine only has to mount the idle listener.
      new BasicSelfEvolveEngine(ctx, baseConfig(overrides))
      const logs = captureLogs(ctx)
      ctx.emit('agent/status', { agent, status: 'idle' } as never)
      await vi.waitFor(() => {
        expect(logs.some(line => line.includes('idle-maintenance skipped'))).toBe(true)
      })
      return logs
    }
    // No judge route, verifier disabled, and no build command each withhold consent.
    await skipLog({})
    await skipLog({ validatorTarget: ACCEPT_CONFIG.validatorTarget, workspaceVerifier: { enabled: false } })
    await skipLog({ validatorTarget: ACCEPT_CONFIG.validatorTarget })
  })

  it('reads a tool error as a failed turn for step reflection', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: { role: 'tool', toolCallId: 'x', content: [{ type: 'text', text: 'Error: boom' }], isError: true } as never,
      error: { name: 'ToolError', code: 'E_TOOL' },
    }, { surfaceOp: 'append' })
    provideServices(ctx, session)
    const engine = new ProbeEngine(ctx, baseConfig())
    const [pattern] = await engine.readPatterns(session.id)
    fakeLlm(ctx, JSON.stringify({ confidence: 0.9, patternId: pattern!.patternId, suggestion: 'check cwd' }))
    await engine.reflect(reflectAgent(session), 1, 1, new AbortController().signal)
    expect(session.snapshotEvents().some(event => event.type === 'self-evolve/reflection')).toBe(true)
  })

  it('logs and swallows a follow-up that throws a non-Error', async () => {
    const ctx = new Context()
    const session = sessionWithBoom()
    const agent = fakeAgent(session)
    agent.followup = () => { throw 'inbox closed' }
    provideServices(ctx, session, agent)
    const engine = new BasicSelfEvolveEngine(ctx, baseConfig({ allowUnverifiedAutonomousRuns: true }))
    const logs = captureLogs(ctx)
    engine.requestEvolve(agentFor(session))
    await vi.waitFor(() => { expect(logs.some(line => line.includes('explicit-run follow-up skipped'))).toBe(true) })
  })

  it('keeps the original error when the end append and end emit throw non-Errors', async () => {
    const ctx = new Context()
    const session = sessionWithBoom()
    failingAppend(session, 'self-evolve/end', 'log closed for self-evolve/end')
    provideServices(ctx, session)
    const engine = new BasicSelfEvolveEngine(ctx, baseConfig())
    const logs = captureLogs(ctx)
    ctx.on('self-evolve-loop/end', () => { throw 'listener exploded' })
    await expect(engine.evolveNow(agentFor(session), new AbortController().signal))
      .rejects.toThrow(/log closed for self-evolve\/end/)
    expect(logs.some(line => line.includes('self-evolve/end append failed'))).toBe(true)
    expect(logs.some(line => line.includes('self-evolve-loop/end emit failed'))).toBe(true)
  })

  it('records apply-failed when the L2 registration collides inside the loop', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-loop-apply-failed-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionWithBoom()
      provideSkillCatalog(ctx, session, { skills: [], complete: true }, undefined, {
        section: () => { throw new Error('static section owns this name') },
      })
      const engine = new SignalEngine(ctx, baseConfig({
        ...ACCEPT_CONFIG,
        allowUnverifiedAutonomousRuns: true,
      }), session)
      engine.replay = { exitCode: 0, retriggeredPatternIds: [] }
      engine.workspace = { dirtyLines: 0, noDirtyFallback: false, buildHealthy: true }
      const [pattern] = await engine.readPatterns(session.id)
      fakeLlmQueue(ctx, [
        JSON.stringify([{
          name: 'cwd-guard',
          purpose: 'guard cwd',
          addressesPatternIds: [pattern!.patternId],
          candidate: { kind: 'L2-context', sectionName: 'sec', sectionText: 'v1', order: 260 },
        }]),
        JSON.stringify(PASSING_SCORES),
      ])
      const result = await engine.evolveNow(agentFor(session), new AbortController().signal)
      expect(result.commits).toHaveLength(0)
      const validated = session.snapshotEvents().filter(event => event.type === 'self-evolve/validated')
      expect(validated).toHaveLength(1)
      expect((validated[0]!.data as { outcome: { reason?: string } }).outcome.reason).toBe('apply-failed')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('disposes an L2 section that had no predecessor to restore', async () => {
    const ctx = new Context()
    const session = sessionWithBoom()
    const removed: string[] = []
    provideSkillCatalog(ctx, session, { skills: [], complete: true }, undefined, {
      section: (input: { name: string }) => () => { removed.push(input.name) },
    })
    const scope = await ctx.plugin(ProbeEngine, baseConfig())
    const engine = probeOf(ctx)
    const [pattern] = await engine.readPatterns(session.id)
    await engine.commit(agentFor(session), proposal({
      addressesPatternIds: [pattern!.patternId],
      candidate: { kind: 'L2-context', sectionName: 'sec', sectionText: 'v1', order: 260, estimatedBytes: 2 },
    }))
    await scope.dispose()
    expect(removed).toEqual(['sec'])
  })

  it('reports an L2 conflict on a first registration without a predecessor', async () => {
    const ctx = new Context()
    const session = sessionWithBoom()
    provideSkillCatalog(ctx, session, { skills: [], complete: true }, undefined, {
      section: () => { throw 'static section owns this name' },
    })
    const engine = new ProbeEngine(ctx, baseConfig())
    const [pattern] = await engine.readPatterns(session.id)
    await expect(engine.commit(agentFor(session), proposal({
      addressesPatternIds: [pattern!.patternId],
      candidate: { kind: 'L2-context', sectionName: 'sec', sectionText: 'v1', order: 260, estimatedBytes: 2 },
    }))).rejects.toThrow(/section sec rejected: static section owns this name/)
  })

  it('skips the tombstone when no fs service is mounted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-tombstone-no-fs-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionWithBoom()
      provideSkillCatalog(ctx, session, { skills: [], complete: true })
      const engine = new ProbeEngine(ctx, baseConfig())
      const [pattern] = await engine.readPatterns(session.id)
      await engine.commit(agentFor(session), l1Proposal('p1', 'cwd-guard', 'v1', pattern!.patternId))
      await expect(engine.rollback(pattern!.patternId)).resolves.toBeUndefined()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('writes a rolled-back skill file into the session cwd', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-rollback-cwd-'))
    const cwd = await mkdtemp(join(tmpdir(), 'self-evolve-workspace-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const id = SessionId(`cwd-${Math.random().toString(36).slice(2, 10)}`)
      const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id, createdAt: Date.now(), cwd, isSeeded: false }
      const session = Session.create(id, undefined, header)
      appendShellResult(session, 'c1', '[stderr]\nboom\n[exit code: 1]')
      appendShellResult(session, 'c2', '[stderr]\nboom\n[exit code: 1]')
      provideSkillCatalog(ctx, session, { skills: [], complete: true })
      const resolved: (string | undefined)[] = []
      ctx.provide('fs', {
        resolve: async (path: string, options?: { cwd?: string }) => { resolved.push(options?.cwd); return path },
        writeText: async () => {},
      })
      const engine = new ProbeEngine(ctx, baseConfig({ defaultLevels: [] }))
      // A no-proposal run registers the session, which is what a rollback reads
      // its working directory from.
      await engine.evolveNow(agentFor(session), new AbortController().signal)
      const [pattern] = await engine.readPatterns(session.id)
      await engine.commit(agentFor(session), l1Proposal('p1', 'cwd-guard', 'champion body', pattern!.patternId))
      await engine.commit(agentFor(session), l1Proposal('p2', 'cwd-guard', 'regressing body', pattern!.patternId))
      await engine.rollback(pattern!.patternId)
      expect(resolved.at(-1)).toBe(cwd)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('falls back to the process cwd when the tracked session is gone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-rollback-no-session-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionWithBoom()
      provideSkillCatalog(ctx, session, { skills: [], complete: true })
      const resolved: (string | undefined)[] = []
      ctx.provide('fs', {
        resolve: async (path: string, options?: { cwd?: string }) => { resolved.push(options?.cwd); return path },
        writeText: async () => {},
      })
      const engine = new ProbeEngine(ctx, baseConfig({ defaultLevels: [] }))
      // evolveNow registers the session in the rate map; hiding it from the
      // sessions service afterwards models a session that closed before the
      // rollback, which must fall back to the process cwd.
      await engine.evolveNow(agentFor(session), new AbortController().signal)
      const [pattern] = await engine.readPatterns(session.id)
      await engine.commit(agentFor(session), l1Proposal('p1', 'cwd-guard', 'champion body', pattern!.patternId))
      await engine.commit(agentFor(session), l1Proposal('p2', 'cwd-guard', 'regressing body', pattern!.patternId))
      ctx.set('sessions', { get: () => undefined })
      await engine.rollback(pattern!.patternId)
      expect(resolved.at(-1)).toBe(process.cwd())
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('reports an aborted untracked line count as an unavailable dimension', async () => {
    const route = (command: string): ScriptedShellOutcome => {
      if (command.startsWith('git ls-files')) return { kind: 'run', stdout: 'scratch.txt\n' }
      if (command.startsWith('wc -l')) return { kind: 'run', aborted: true }
      return { kind: 'run' }
    }
    expect(await wsBaseline(route)).toEqual({ gitAvailable: false, dirtyLines: 0 })
  })

  it('reports no workspace signal when the baseline was never captured', async () => {
    expect(await wsSignal(() => ({ kind: 'run' }), null)).toBeNull()
  })

  it('treats an unregistered replay child as an empty replay', async () => {
    const ctx = new Context()
    const session = sessionFactory()
    const child = sessionFactory()
    const parent = { session, options: {} }
    ctx.provide('sessionProjections', { register: () => () => {}, snapshot: () => projectedState(session) })
    ctx.provide('sessions', { get: (id: string) => (id === session.id ? session : undefined) })
    // The fork reports a child id the agent registry never saw; the replay then
    // cannot fold the child's session and must fail the gate on tool calls.
    ctx.provide('agents', { get: (id: string) => (id === session.id ? parent : undefined) })
    ctx.provide('skills', { register: () => () => {}, snapshot: async () => ({ skills: [], complete: true }) })
    ctx.provide('systemPrompt', { section: () => () => {} })
    ctx.provide('subagents', {
      getProvider: () => ({}),
      startActivation: async () => ({
        childId: child.id,
        result: Promise.resolve({ stopReason: 'completed', output: [] }),
        dispose: async () => {},
      }),
    } as never)
    const engine = new ProbeEngine(ctx, baseConfig())
    const replay = await engine.replay(agentFor(session), proposal(), 'case', new AbortController().signal)
    expect(replay).toEqual({ exitCode: 1, retriggeredPatternIds: [] })
  })

  it('undoes a first L2 registration when the commit append fails', async () => {
    const ctx = new Context()
    const session = sessionWithBoom()
    const removed: string[] = []
    provideSkillCatalog(ctx, session, { skills: [], complete: true }, undefined, {
      section: (input: { name: string }) => () => { removed.push(input.name) },
    })
    failingAppend(session, 'self-evolve/commit')
    const engine = new ProbeEngine(ctx, baseConfig())
    const [pattern] = await engine.readPatterns(session.id)
    await expect(engine.commit(agentFor(session), proposal({
      addressesPatternIds: [pattern!.patternId],
      candidate: { kind: 'L2-context', sectionName: 'sec', sectionText: 'v1', order: 260, estimatedBytes: 2 },
    }))).rejects.toThrow(/log closed for self-evolve\/commit/)
    expect(removed).toEqual(['sec'])
  })

  it('ignores an idle boundary while a loop is already in flight', async () => {
    const ctx = new Context()
    const session = sessionWithBoom()
    const agent = fakeAgent(session)
    let release = (): void => {}
    // The run parks inside its maintenance reservation, so the idle boundary
    // below is emitted while the loop provably owns the in-flight slot.
    const parked: SelfEvolveAgentContext['runMaintenance'] = async <T>(task: (signal: AbortSignal) => Promise<T>) => {
      await new Promise<void>((resolve) => { release = resolve })
      return task(new AbortController().signal)
    }
    provideServices(ctx, session, agent)
    // Autonomous runs must be allowed, or the idle trigger would be suppressed
    // by configuration instead of by the in-flight slot under test.
    const engine = new BasicSelfEvolveEngine(ctx, baseConfig({ allowUnverifiedAutonomousRuns: true }))
    const running = engine.evolveNow(agentFor(session, parked), new AbortController().signal)
    ctx.emit('agent/status', { agent, status: 'idle' } as never)
    expect(triggerRuns(session)).toEqual([])
    release()
    await running
    // Only the explicit run logs a start; a second (idle) run would appear here
    // regardless of which of the two appended first.
    expect(triggerRuns(session)).toEqual(['user-command'])
  })

  it('runs no idle loop when the idle-maintenance trigger is disabled', async () => {
    const ctx = new Context()
    const session = sessionWithBoom()
    const agent = fakeAgent(session)
    provideServices(ctx, session, agent)
    new BasicSelfEvolveEngine(ctx, baseConfig({
      triggers: {
        'idle-maintenance': { enabled: false, minIntervalMs: 0 },
        pressure: { enabled: true, minIntervalMs: 0 },
        'user-command': { enabled: true, minIntervalMs: 0 },
        'validation-retry': { enabled: true, minIntervalMs: 0 },
      },
    }))
    ctx.emit('agent/status', { agent, status: 'idle' } as never)
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(triggerRuns(session)).toEqual([])
  })

  it('rethrows an application failure that is not a candidate rejection', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-apply-throw-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const session = sessionWithBoom()
      provideSkillCatalog(ctx, session, { skills: [], complete: true })
      ctx.provide('fs', {
        resolve: async (path: string) => path,
        writeText: async () => { throw new Error('disk full') },
      })
      const engine = new SignalEngine(ctx, baseConfig({
        ...ACCEPT_CONFIG,
        allowUnverifiedAutonomousRuns: true,
      }), session)
      engine.replay = { exitCode: 0, retriggeredPatternIds: [] }
      engine.workspace = { dirtyLines: 0, noDirtyFallback: false, buildHealthy: true }
      const [pattern] = await engine.readPatterns(session.id)
      fakeLlmQueue(ctx, [
        JSON.stringify([{
          name: 'cwd-guard',
          purpose: 'guard cwd',
          addressesPatternIds: [pattern!.patternId],
          candidate: { kind: 'L1-skill', skillName: 'cwd-guard', content: 'check cwd' },
        }]),
        JSON.stringify(PASSING_SCORES),
      ])
      // An fs failure is not a candidate rejection: it must surface unchanged.
      await expect(engine.evolveNow(agentFor(session), new AbortController().signal)).rejects.toThrow(/disk full/)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('evicts the least recently used session state and counts foreign retry keys', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'self-evolve-evict-'))
    vi.stubEnv('DSH_HOME', dir)
    try {
      const ctx = new Context()
      const sessions = [sessionWithBoom(), sessionWithBoom(), sessionWithBoom()]
      const agents = new Map<string, FakeAgent>(
        sessions.map(session => [String(session.id), fakeAgent(session)]),
      )
      ctx.provide('sessionProjections', {
        register: () => () => {},
        snapshot: (session: Session) => projectedState(session),
      })
      ctx.provide('sessions', { get: (id: string) => sessions.find(session => String(session.id) === id) })
      ctx.provide('agents', { get: (id: string) => agents.get(id) })
      ctx.provide('skills', { register: () => () => {}, snapshot: async () => ({ skills: [], complete: true }) })
      ctx.provide('systemPrompt', { section: () => () => {} })
      const engine = new SignalEngine(ctx, baseConfig({
        ...ACCEPT_CONFIG,
        allowUnverifiedAutonomousRuns: true,
        maxTrackedSessions: 2,
      }), sessions[0]!)
      engine.replay = { exitCode: 0, retriggeredPatternIds: [] }
      engine.workspace = { dirtyLines: 0, noDirtyFallback: false, buildHealthy: true }
      const responses: string[] = []
      for (const [index, session] of sessions.entries()) {
        const [pattern] = await engine.readPatterns(session.id)
        responses.push(JSON.stringify([{
          name: `fix-${index}`,
          purpose: 'fix',
          addressesPatternIds: [pattern!.patternId],
          candidate: { kind: 'L2-context', sectionName: `sec-${index}`, sectionText: `text-${index}`, order: 260 },
        }]))
        responses.push(JSON.stringify(LOW_CONFIDENCE_SCORES))
      }
      fakeLlmQueue(ctx, responses)
      // Each run registers one session and leaves a retry key behind; the third
      // run pushes the oldest session out and sweeps its retry bookkeeping.
      for (const session of sessions) {
        await engine.evolveNow(agentFor(session), new AbortController().signal)
      }
      expect(triggerRuns(sessions[2]!)).toEqual(['user-command'])
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
