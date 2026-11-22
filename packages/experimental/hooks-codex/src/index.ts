/**
 * Bridge for unmodified Codex command hooks on harness interception points. It
 * supports five points (SessionStart, prompt/tool pre/post, Stop), regex-only
 * matchers, snake_case payloads without a trailing newline, no hook environment
 * or command substitution, and no pre-tool approval or rewrite path; only
 * blocking decisions are honored. Shared execution and parsing live in
 * `dsh-hook-protocol`.
 * @module @deepseek-ai/dsh-hooks-codex
 */

// Each dialect bridge keeps its complete dependency list visible at the entry
// point; a cross-package facade for imports alone would add indirection.
/* jscpd:ignore-start */
import type {} from '@deepseek-ai/dsh-working-directory'
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { extractTextContent } from '@deepseek-ai/dsh-llm/message'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'hooks-codex': { kind: 'hooks-codex' } & ContextFormed
  }
}

import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { assertPositiveInteger } from '@deepseek-ai/dsh-value'
import {
  appendHookInvoked,
  appendHookResult,
  createDetachedRuns,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_STDERR_SUMMARY_MAX_CHARS,
  HOOK_BLOCKED,
  HOOK_DENIED,
  HOOK_ERROR_NAME,
  mergeHookOutputs,
  runHook,
  selectHookGroups,
  type HookOutput,
  type MergedHookOutcome,
} from '@deepseek-ai/dsh-hook-protocol'
import { parseCodexConfig, type CodexHookConfig } from './config.ts'
/* jscpd:ignore-end */

export const name = 'hooks-codex'
export const inject = ['shell', 'agents', 'workingDirectory']

/** Plugin config: where the Codex hooks.json lives + the model name for payloads. */
export interface Config {
  /**
   * Path to a Codex `hooks.json`. Process-level: read once at load, a relative
   * path resolves against the process launch cwd.
   * TODO(per-session-hook-config): per-session project-local discovery from each
   * `session/new.cwd`.
   */
  configPath: string
  /** The model name stamped on every payload (Codex includes `model` on each event). */
  model?: string
  /** Default per-hook timeout in ms when a hook sets none (Codex default: 600000). */
  defaultTimeoutMs?: number
  /** Character cap for the `hook/result` event's persisted stderr summary. */
  stderrSummaryMaxChars?: number
  /**
   * Maximum consecutive times a blocking `Stop` hook may force another step
   * before the run is cancelled. Prevents an unconditionally blocking hook from
   * running forever. Defaults to 10.
   */
  maxStopContinuations?: number
}

/** Default cap on consecutive Stop-hook forced continuations before the run is cancelled. */
const DEFAULT_MAX_STOP_CONTINUATIONS = 10

export const Config: z<Config> = z.object({
  configPath: z.string().required(),
  model: z.string().default(''),
  defaultTimeoutMs: z.number().default(DEFAULT_HOOK_TIMEOUT_MS),
  stderrSummaryMaxChars: z.number().default(DEFAULT_STDERR_SUMMARY_MAX_CHARS),
  maxStopContinuations: z.number().default(DEFAULT_MAX_STOP_CONTINUATIONS),
})

let handlerCounter = 0
function nextHandlerId(point: string): string {
  return `codex:${point}:${++handlerCounter}`
}

const CONTEXT_SOURCE: MessageSource = { kind: 'hooks-codex' }

export function apply(ctx: Context, config: Config): void {
  // Validate before config parsing so a bad value cannot be hidden by its early return.
  const stderrSummaryMaxChars = config.stderrSummaryMaxChars ?? DEFAULT_STDERR_SUMMARY_MAX_CHARS
  assertPositiveInteger('hooks-codex: stderrSummaryMaxChars', stderrSummaryMaxChars)
  const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
  const maxStopContinuations = config.maxStopContinuations ?? DEFAULT_MAX_STOP_CONTINUATIONS
  assertPositiveInteger('hooks-codex: maxStopContinuations', maxStopContinuations)
  let parsed: CodexHookConfig = {}
  try {
    const raw: unknown = JSON.parse(readFileSync(config.configPath, 'utf8'))
    const result = parseCodexConfig(raw)
    parsed = result.config
    for (const s of result.skipped) {
      ctx.logger.warn(`hooks-codex: skipping ${s.reason} on ${s.event} (only sync command hooks run)`)
    }
  } catch (error: unknown) {
    ctx.logger.warn(`hooks-codex: could not load hook config "${config.configPath}": ${String(error)} — no hooks registered`)
    return
  }

  const model = config.model ?? ''

  // SessionStart is the one emit-shaped (detached) point Codex has: track its
  // run chains so disposal aborts a still-running hook process and drains the
  // continuation (docs/defensive-patterns/general.md: dispose must reach quiescence).
  const detached = createDetachedRuns()
  // Per-agent state: a startup gate so the first step waits for SessionStart
  // and can fold its context into the admitted batch, plus a counter for
  // consecutive Stop-hook forced continuations.
  const sessionStartGates = new Map<Agent, Promise<MergedHookOutcome | undefined>>()
  const stopLoops = new Map<Agent, number>()
  ctx.effect(() => () => detached.drain(), 'hooks-codex: drain detached hook runs')
  ctx.on('agent/disposed', ({ agent }) => {
    sessionStartGates.delete(agent)
    stopLoops.delete(agent)
  })

  /**
   * Run and fold one configured Codex hook point.
   *
   * A supplied turn records the hook invocation/result pair inside that open turn.
   * Detached lifecycle points omit it.
   */
  async function runPoint(
    point: string,
    matchQuery: string,
    payload: Record<string, unknown>,
    opts: {
      agent?: Agent
      turn?: number
      readonly signal: AbortSignal
      plainStdoutAsContext?: boolean
    },
  ): Promise<MergedHookOutcome> {
    const groups = selectHookGroups(parsed[point], matchQuery, 'codex')
    if (groups.length === 0) return mergeHookOutputs([])
    const outputs: HookOutput[] = []
    const workdir = opts.agent === undefined ? undefined : await ctx.workingDirectory.ensure(opts.agent, opts.signal)
    for (const group of groups) {
      for (const hook of group.hooks) {
        const handlerId = nextHandlerId(point)
        const session = opts.agent?.session
        if (session && opts.turn !== undefined) {
          appendHookInvoked(session, {
            turn: opts.turn, point, dialect: 'codex', handlerId,
            matcher: group.matcher,
          })
        }
        const { output, durationMs } = await runHook(ctx.shell, hook, {
          payload: { ...payload, cwd: workdir ?? process.cwd() },
          defaultTimeoutMs,
          ...workdir !== undefined ? { cwd: workdir } : {},
          signal: opts.signal,
          trailingNewline: false, // Codex writes stdin without a trailing newline.
          // Discard a `hookSpecificOutput` block naming a different event.
          expectedEventName: point,
        }, () => performance.now())
        // Clean plain stdout becomes context only when no structured context
        // exists; nonzero output and raw JSON never leak as prose.
        if (opts.plainStdoutAsContext === true && output.exitCode === 0
          && output.additionalContext === undefined
          && output.stdout.length > 0 && !output.stdout.startsWith('{')) {
          output.additionalContext = output.stdout
        }
        outputs.push(output)
        // Execution and decision mapping remain in each bridge so dialect
        // differences stay explicit at their owning extension point.
        /* jscpd:ignore-start */
        if (output.systemMessage !== undefined) {
          ctx.logger.warn(`hooks-codex: ${point} hook emitted a systemMessage, which is not yet surfaced (ignored)`)
        }
        if (session && opts.turn !== undefined) {
          appendHookResult(session, { turn: opts.turn, point, handlerId, output, stderrSummaryMaxChars, durationMs })
        }
      }
    }
    return mergeHookOutputs(outputs)
  }

  function contextFrom(merged: MergedHookOutcome): UserMessage | undefined {
    if (merged.additionalContext.length === 0) return undefined
    const content: ContentBlock[] = merged.additionalContext.map(text => ({ type: 'text', text }))
    return createUserMessage({ content, source: CONTEXT_SOURCE })
  }

  /** Prepend one context without flattening source fields or other downstream metadata. */
  function prependContext(ours: UserMessage, theirs: UserMessage[] | undefined): UserMessage[] {
    return [ours, ...theirs ?? []]
  }

  // SessionStart's outcome is also stored as a startup gate so the first
  // `agent/pre-step` awaits it and folds any context into the admitted batch
  // (injection alone can miss a step whose messages were already claimed). The
  // gate stays stored until a step consumes it, because the hook usually
  // resolves before the first prompt arrives. `agent/created` is a serial
  // listener, so awaiting the run here also keeps creation behind the hook.
  ctx.on('agent/created', async ({ agent, source, signal }) => {
    const ownerSignal = signal === undefined ? detached.signal : AbortSignal.any([signal, detached.signal])
    const run = runPoint('SessionStart', source, { ...base(agent, 'SessionStart', model), source }, { agent, plainStdoutAsContext: true, signal: ownerSignal })
      .then((merged) => {
        if (merged.stop) {
          agent.cancel({ kind: 'hook', reason: hookStopReason('SessionStart', merged) })
        }
        return merged
      })
      .catch((error: unknown) => { ctx.logger.warn(`hooks-codex: SessionStart hook failed: ${String(error)}`); return undefined })
    sessionStartGates.set(agent, run)
    detached.track(run)
    await run
    /* jscpd:ignore-end */
  })

  // UserPromptSubmit → PreStepDecision. Codex supports reject, not rewrite or ask.
  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next): Promise<PreStepDecision> => {
    const startMerged = await sessionStartGates.get(agent)
    if (messages.length === 0) return next()
    sessionStartGates.delete(agent)
    const startContext = startMerged && !startMerged.stop ? contextFrom(startMerged) : undefined
    const payload = {
      ...base(agent, 'UserPromptSubmit', model),
      turn_id: String(turn),
      prompt: extractTextContent(messages.flatMap(message => message.content)),
    }
    const merged = await runPoint('UserPromptSubmit', '', payload, {
      agent, turn, plainStdoutAsContext: true, signal,
    })
    /* jscpd:ignore-start */
    if (merged.stop) {
      agent.cancel({ kind: 'hook', reason: hookStopReason('UserPromptSubmit', merged) })
      return { kind: 'reject' }
    }
    if (merged.decision === 'deny') {
      return { kind: 'reject' }
    }
    // Context alone is not a veto: DELEGATE so a later pre-step listener can
    // still reject/rewrite, then prepend SessionStart context and append our
    // context only to a downstream enter decision.
    const downstream = await next()
    const ours = contextFrom(merged)
    if (downstream.kind !== 'enter') return downstream
    const admitted = startContext ? [startContext, ...downstream.messages] : downstream.messages
    if (!ours) return { ...downstream, messages: admitted }
    return {
      ...downstream,
      messages: [...admitted, ours],
    }
  })

  // PreToolUse → PreToolDecision. Codex blocks only (no allow/ask honored).
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const turn = lastTurn(ctx, exec.agent)
    const merged = await runPoint('PreToolUse', exec.name, preToolPayload(ctx, exec, model), { ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal })
    /* jscpd:ignore-end */
    if (merged.stop) {
      const reason = hookStopReason('PreToolUse', merged)
      exec.agent?.cancel({ kind: 'hook', reason })
      return { kind: 'deny', reason }
    }
    if (merged.decision === 'deny') return { kind: 'deny', reason: merged.reason ?? 'blocked by PreToolUse hook', info: { name: HOOK_ERROR_NAME, code: HOOK_DENIED } }
    return next()
  })

  // PostToolUse → PostToolDecision (block with feedback, or attach context).
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const turn = lastTurn(ctx, exec.agent)
    /* jscpd:ignore-start */
    const merged = await runPoint('PostToolUse', exec.name, postToolPayload(ctx, exec, result, model), { ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal })
    const context = contextFrom(merged)
    if (merged.stop) {
      const reason = hookStopReason('PostToolUse', merged)
      exec.agent?.cancel({ kind: 'hook', reason })
      return { kind: 'block', feedback: [{ type: 'text', text: reason }], ...context ? { additionalContexts: [context] } : {} }
    }
    if (merged.decision === 'deny') {
      return {
        kind: 'block',
        feedback: [{ type: 'text', text: merged.reason ?? 'blocked by PostToolUse hook' }],
        info: { name: HOOK_ERROR_NAME, code: HOOK_BLOCKED },
        ...context ? { additionalContexts: [context] } : {},
      }
    }
    // Context alone is not a veto: DELEGATE, then fold our context onto the
    // downstream decision (a downstream block carries it too).
    const downstream = await next()
    if (!context) return downstream
    if (downstream.kind === 'block') {
      return { ...downstream, additionalContexts: prependContext(context, downstream.additionalContexts) }
    }
    return {
      ...downstream,
      additionalContexts: prependContext(context, downstream.additionalContexts),
    }
  })

  // A blocking Stop hook steers at the stopping boundary, which makes the
  // machine observe pending input and run another step. To prevent an
  // unconditionally blocking hook from looping forever, the run is cancelled
  // after `maxStopContinuations` consecutive forced continuations.
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }): Promise<void> => {
    const count = stopLoops.get(agent) ?? 0
    const merged = await runPoint('Stop', '', { ...turnBase(ctx, agent, 'Stop', model), stop_hook_active: count > 0, last_assistant_message: null }, { agent, turn, signal })
    /* jscpd:ignore-end */
    if (merged.stop) {
      agent.cancel({ kind: 'hook', reason: hookStopReason('Stop', merged) })
      return
    }
    if (merged.decision === 'deny') {
      if (count >= maxStopContinuations) {
        agent.cancel({ kind: 'hook', reason: 'Stop hook forced continuation too many times' })
        return
      }
      stopLoops.set(agent, count + 1)
      // A blocking Stop hook forces continuation; a block with no reason (exit 2,
      // empty stderr) still forces it — fall back to a generic steering line
      // rather than letting the turn stop.
      const text = merged.reason ?? 'continue: blocked by Stop hook'
      agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: CONTEXT_SOURCE }))
      return
    }
    stopLoops.set(agent, 0)
  })
}

// --- Codex DIALECT payloads: snake_case, model on every event, turn_id on
// turn-scoped events. ---

// Shared hook-protocol code has no Agent dependency, so turn lookup stays in the bridge.
/* jscpd:ignore-start */
function lastTurn(ctx: Context, agent: Agent | undefined): number {
  if (!agent) return 0
  return ctx.agents.turnBoundaryOf(agent.session).lastTurn
}

/**
 * The cancel reason for a hook that requested a run-level stop: the hook's own
 * `stopReason` when it supplied one, else a fallback naming the firing event.
 * @param point - The hook point that halted the run.
 * @param merged - The folded outcome whose `stop` the caller is acting on.
 * @returns The reason to pass to the run-level cancel.
 */
function hookStopReason(point: string, merged: MergedHookOutcome): string {
  return merged.stopReason ?? `${point} hook requested stop`
}
/* jscpd:ignore-end */

/** Base fields on every Codex payload (no turn_id). */
function base(agent: Agent | undefined, event: string, model: string): Record<string, unknown> {
  return {
    session_id: agent?.session.header.id ?? '',
    // The persistence seam exposes no artifact path; the field stays null
    // (a durable consumer gap recorded in this package's README).
    transcript_path: null,
    hook_event_name: event,
    model,
    permission_mode: 'default',
  }
}

/** Base + turn_id, for the turn-scoped events (PreToolUse/PostToolUse/UserPromptSubmit/Stop). */
function turnBase(ctx: Context, agent: Agent | undefined, event: string, model: string): Record<string, unknown> {
  return { ...base(agent, event, model), turn_id: String(lastTurn(ctx, agent)) }
}

/** Extract a `command` string from a tool call's parsed arguments, else ''. */
function commandOf(args: unknown): string {
  if (typeof args === 'object' && args !== null && 'command' in args) {
    const command: unknown = args.command
    if (typeof command === 'string') return command
  }
  return ''
}

function preToolPayload(ctx: Context, exec: ToolExecution, model: string): Record<string, unknown> {
  // `tool_name` is the REAL tool name (matching the `exec.name` matcher subject);
  // a hardcoded constant would disagree with what the matcher tests and make a
  // config's tool matcher never fire. `tool_input` keeps Codex's `{ command }`
  // shape (its shell payload), derived from the call's `command` arg when present.
  return { ...turnBase(ctx, exec.agent, 'PreToolUse', model), tool_name: exec.name, tool_input: { command: commandOf(exec.arguments) }, tool_use_id: exec.callId }
}

function postToolPayload(ctx: Context, exec: ToolExecution, result: ToolExecutionResult, model: string): Record<string, unknown> {
  return { ...turnBase(ctx, exec.agent, 'PostToolUse', model), tool_name: exec.name, tool_input: { command: commandOf(exec.arguments) }, tool_use_id: exec.callId, tool_response: extractTextContent(result.content) }
}
