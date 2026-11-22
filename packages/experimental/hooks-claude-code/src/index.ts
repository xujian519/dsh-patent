/**
 * Bridge for unmodified Claude Code command hooks on harness interception
 * extension points. It supports SessionStart, prompt/tool pre/post, Stop, and subagent
 * start/stop. It owns Claude payloads, environment, substitution, and decision
 * mapping; shared execution and parsing live in `dsh-hook-protocol`.
 * `updatedInput` is logged and warned but not honored. Bespoke behavior should
 * use typed native plugins on the same extension points.
 * @module @deepseek-ai/dsh-hooks-claude-code
 */

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
    'hooks-claude-code': { kind: 'hooks-claude-code' } & ContextFormed
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
// Pulls in the declaration-merged subagent events and the identity pairing their
// start/end edges.
import type { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import { parseClaudeCodeConfig, type ClaudeCodeHookConfig } from './config.ts'

export const name = 'hooks-claude-code'
// `shell` runs hooks and `agents` supplies turn numbers; the rest
// are read opportunistically via ctx.get so a deployment can omit them.
export const inject = ['shell', 'agents', 'workingDirectory']

/** Plugin config: where the CC hook config lives + substitution roots. */
export interface Config {
  /**
   * Path to a `hooks.json` or a settings file whose `hooks` key holds the config.
   * Process-level: read once at load, a relative path resolves against the process
   * launch cwd, so one config applies to the whole process.
   * TODO(per-session-hook-config): per-session discovery of a project-local
   * `hooks.json` from each `session/new.cwd`.
   */
  configPath: string
  /**
   * Replaces `${CLAUDE_PLUGIN_ROOT}` in command strings (the plugin's root dir).
   */
  pluginRoot?: string
  /**
   * Replaces `${CLAUDE_PROJECT_DIR}` in command strings AND is exported as the
   * `CLAUDE_PROJECT_DIR` env var for hook processes. When omitted, the env var
   * defaults per-run to the agent's current directory (the
   * same dir the hook runs in) — Claude Code always exports this var, and common
   * unmodified hooks reference `$CLAUDE_PROJECT_DIR` for project-relative paths.
   */
  projectDir?: string
  /** Default per-hook timeout in ms when a hook sets none (CC default: 600000). */
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
  pluginRoot: z.string(),
  projectDir: z.string(),
  defaultTimeoutMs: z.number().default(DEFAULT_HOOK_TIMEOUT_MS),
  stderrSummaryMaxChars: z.number().default(DEFAULT_STDERR_SUMMARY_MAX_CHARS),
  maxStopContinuations: z.number().default(DEFAULT_MAX_STOP_CONTINUATIONS),
})

/** A stable per-handler id so an invoked/result pair correlates in the log. */
let handlerCounter = 0
function nextHandlerId(point: string): string {
  return `claude-code:${point}:${++handlerCounter}`
}

/** The `{kind:'hooks-claude-code'}` producer source stamped on every context this bridge injects. */
const CONTEXT_SOURCE: MessageSource = { kind: 'hooks-claude-code' }

export function apply(ctx: Context, config: Config): void {
  // Validate before config parsing so a bad value cannot be hidden by its early return.
  const stderrSummaryMaxChars = config.stderrSummaryMaxChars ?? DEFAULT_STDERR_SUMMARY_MAX_CHARS
  assertPositiveInteger('hooks-claude-code: stderrSummaryMaxChars', stderrSummaryMaxChars)
  const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
  const maxStopContinuations = config.maxStopContinuations ?? DEFAULT_MAX_STOP_CONTINUATIONS
  assertPositiveInteger('hooks-claude-code: maxStopContinuations', maxStopContinuations)
  // Parse once at load. A read or parse failure logs and registers nothing.
  let parsed: ClaudeCodeHookConfig = {}
  try {
    const raw: unknown = JSON.parse(readFileSync(config.configPath, 'utf8'))
    const result = parseClaudeCodeConfig(raw, {
      ...config.pluginRoot !== undefined ? { pluginRoot: config.pluginRoot } : {},
      ...config.projectDir !== undefined ? { projectDir: config.projectDir } : {},
    })
    parsed = result.config
    for (const s of result.skipped) {
      ctx.logger.warn(`hooks-claude-code: skipping unsupported "${s.type}" hook on ${s.event} (only command hooks run)`)
    }
  } catch (error: unknown) {
    ctx.logger.warn(`hooks-claude-code: could not load hook config "${config.configPath}": ${String(error)} — no hooks registered`)
    return
  }

  // Emit-shaped points run detached, so track their chains; disposal aborts
  // active hooks and drains continuations before resolving.
  const detached = createDetachedRuns()
  // Only the start edge guarantees registry access. Retain each local child
  // through its paired end so stop hooks keep the session workspace after the
  // handle unregisters the agent. Every retained entry relies on that paired
  // end; a producer that can omit it must provide another release edge.
  const subagentChildren = new Map<SubagentRunId, Agent>()
  // Per-agent state: a startup gate so the first step waits for SessionStart
  // and can fold its context into the admitted batch, plus a counter for
  // consecutive Stop-hook forced continuations.
  const sessionStartGates = new Map<Agent, Promise<MergedHookOutcome | undefined>>()
  const stopLoops = new Map<Agent, number>()
  ctx.effect(() => () => detached.drain(), 'hooks-claude-code: drain detached hook runs')
  ctx.on('agent/disposed', ({ agent }) => {
    sessionStartGates.delete(agent)
    stopLoops.delete(agent)
  })

  /**
   * Run every command hook configured for `point` whose matcher selects
   * `matchQuery`, with the per-event `payload` on stdin, and fold the results.
   * Writes a `hook/invoked`/`hook/result` pair per hook when `opts.turn` names
   * an open turn. Detached lifecycle points omit the pair. Returns the merged outcome (a neutral,
   * already-most-restrictive view) for the caller to map onto its extension point
   * decision. `matchQuery` is the event's matcher subject (tool name, session
   * source, …); `''` for events that ignore matchers.
   */
  async function runPoint(
    point: string,
    matchQuery: string,
    payload: Record<string, unknown>,
    opts: { agent?: Agent; turn?: number; directory?: 'committed'; readonly signal: AbortSignal },
  ): Promise<MergedHookOutcome> {
    const groups = selectHookGroups(parsed[point], matchQuery, 'claude-code')
    if (groups.length === 0) return mergeHookOutputs([])
    const outputs: HookOutput[] = []
    const workdir = opts.agent === undefined ? undefined
      : opts.directory === 'committed' ? ctx.workingDirectory.get(opts.agent.session)
        : await ctx.workingDirectory.ensure(opts.agent, opts.signal)
    // CLAUDE_PROJECT_DIR: an explicit config value wins; otherwise default it to the session
    // workspace (the same dir the hook runs in).
    const projectDir = config.projectDir ?? workdir
    const hookEnv = projectDir !== undefined ? { CLAUDE_PROJECT_DIR: projectDir } : undefined
    for (const group of groups) {
      for (const hook of group.hooks) {
        const handlerId = nextHandlerId(point)
        const session = opts.agent?.session
        if (session && opts.turn !== undefined) {
          appendHookInvoked(session, {
            turn: opts.turn, point, dialect: 'claude-code', handlerId,
            matcher: group.matcher,
          })
        }
        const { output, durationMs } = await runHook(ctx.shell, hook, {
          payload: { ...payload, cwd: workdir ?? process.cwd() },
          defaultTimeoutMs,
          ...hookEnv ? { env: hookEnv } : {},
          ...workdir !== undefined ? { cwd: workdir } : {},
          signal: opts.signal,
          trailingNewline: true,
          // Discard a `hookSpecificOutput` block whose `hookEventName` names a
          // different event than the one firing (the schemas key it by event).
          expectedEventName: point,
        }, () => performance.now())
        outputs.push(output)
        // Execution and decision mapping remain in each bridge so dialect
        // differences stay explicit at their owning extension point.
        /* jscpd:ignore-start */
        if (output.updatedInput !== undefined) {
          ctx.logger.warn(`hooks-claude-code: ${point} hook requested updatedInput, which is not yet honored (ignored)`)
        }
        if (output.systemMessage !== undefined) {
          ctx.logger.warn(`hooks-claude-code: ${point} hook emitted a systemMessage, which is not yet surfaced (ignored)`)
        }
        if (session && opts.turn !== undefined) {
          appendHookResult(session, { turn: opts.turn, point, handlerId, output, stderrSummaryMaxChars, durationMs })
        }
      }
    }
    return mergeHookOutputs(outputs)
  }

  /** Build additional model context from hook output, or return undefined when empty. */
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
    const run = runPoint('SessionStart', source, sessionStartPayload(agent, source), { agent, signal: ownerSignal })
      .then((merged) => {
        if (merged.stop) {
          agent.cancel({ kind: 'hook', reason: hookStopReason('SessionStart', merged) })
        }
        return merged
      })
      .catch((error: unknown) => {
        ctx.logger.warn(`hooks-claude-code: SessionStart hook failed: ${String(error)}`)
        return undefined
      })
    sessionStartGates.set(agent, run)
    detached.track(run)
    await run
  })

  // --- UserPromptSubmit → PreStepDecision. The prompt text is the payload; no
  // matcher subject (CC ignores matchers for this event). ---
  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next): Promise<PreStepDecision> => {
    const startMerged = await sessionStartGates.get(agent)
    if (messages.length === 0) return next()
    sessionStartGates.delete(agent)
    const startContext = startMerged && !startMerged.stop ? contextFrom(startMerged) : undefined
    /* jscpd:ignore-end */
    const content = messages.flatMap(message => message.content)
    const merged = await runPoint('UserPromptSubmit', '', promptPayload(agent, content), { agent, turn, signal })
    /* jscpd:ignore-start */
    if (merged.stop) {
      agent.cancel({ kind: 'hook', reason: hookStopReason('UserPromptSubmit', merged) })
      return { kind: 'reject' }
    }
    if (merged.decision === 'deny') {
      return { kind: 'reject' }
    }
    // Delegate so later listeners may still rewrite or reject, then prepend
    // SessionStart context and append our context only to a downstream enter decision.
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

  // --- PreToolUse → PreToolDecision. Matcher subject is the tool name. ---
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const turn = lastTurn(ctx, exec.agent)
    const merged = await runPoint('PreToolUse', exec.name, preToolPayload(exec), { ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal })
    if (merged.stop) {
      const reason = hookStopReason('PreToolUse', merged)
      exec.agent?.cancel({ kind: 'hook', reason })
      return { kind: 'deny', reason }
    }
    /* jscpd:ignore-end */
    if (merged.decision === 'deny') return { kind: 'deny', reason: merged.reason ?? 'blocked by PreToolUse hook', info: { name: HOOK_ERROR_NAME, code: HOOK_DENIED } }
    if (merged.decision === 'ask') return { kind: 'ask', ...merged.reason !== undefined ? { reason: merged.reason } : {} }
    return next()
  })

  // --- PostToolUse → PostToolDecision. Matcher subject is the tool name. ---
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const turn = lastTurn(ctx, exec.agent)
    const merged = await runPoint('PostToolUse', exec.name, postToolPayload(exec, result), { ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal })
    /* jscpd:ignore-start */
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
    // Our hooks did not block. DELEGATE so a later listener can still block/replace,
    // then fold our context onto its decision (a downstream block carries it too).
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
    const merged = await runPoint('Stop', '', stopPayload(agent, count > 0), { agent, turn, signal })
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
      // A blocking Stop hook forces continuation.
      const text = merged.reason ?? 'continue: blocked by Stop hook'
      agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: CONTEXT_SOURCE }))
      return
    }
    stopLoops.set(agent, 0)
    /* jscpd:ignore-end */
  })

  // SubagentStart may inject child context; SubagentStop only observes. Both
  // use the child's directory and the generic agent-type matcher subject.
  ctx.on('subagent/start', (info) => {
    const child = ctx.get('agents')?.get(info.id)
    if (child !== undefined) subagentChildren.set(info.runId, child)
    detached.track(runPoint('SubagentStart', SUBAGENT_TYPE, subagentPayload('SubagentStart', info, child), { ...child ? { agent: child } : {}, signal: detached.signal })
      .then((merged) => {
        const context = contextFrom(merged)
        if (context && child) child.inject(context)
      })
      .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: SubagentStart hook failed: ${String(error)}`) }))
  })
  ctx.on('subagent/end', (info) => {
    const child = subagentChildren.get(info.runId) ?? ctx.get('agents')?.get(info.id)
    subagentChildren.delete(info.runId)
    // The end edge follows child disposal; committed Session state remains readable.
    detached.track(runPoint('SubagentStop', SUBAGENT_TYPE, subagentPayload('SubagentStop', info, child), { ...child ? { agent: child, directory: 'committed' } : {}, signal: detached.signal })
      .catch((error: unknown) => { ctx.logger.warn(`hooks-claude-code: SubagentStop hook failed: ${String(error)}`) }))
  })
}

/**
 * The `agent_type` value the bridge reports for SubagentStart/Stop. The harness
 * subagent seam carries no per-kind label, so the bridge uses Claude Code's own
 * Task-tool default — a hooks.json with a default/`*`/empty `agent_type` matcher
 * fires; a config matching a specific kind (e.g. `code-reviewer`) does not.
 */
const SUBAGENT_TYPE = 'general-purpose'

// --- Per-event stdin payloads (the CC DIALECT shape). Field names match CC's
// hook input schema; this is the part a bridge owns. ---

/** The last open turn number in the agent's log, or 0 without an agent. */
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

function base(agent: Agent | undefined, event: string): Record<string, unknown> {
  return {
    session_id: agent?.session.header.id ?? '',
    // The persistence seam exposes no artifact path; the field stays empty
    // (a durable consumer gap recorded in this package's README).
    transcript_path: '',
    hook_event_name: event,
  }
}

function sessionStartPayload(agent: Agent, source: string): Record<string, unknown> {
  return { ...base(agent, 'SessionStart'), source }
}
function promptPayload(agent: Agent, content: ContentBlock[]): Record<string, unknown> {
  return { ...base(agent, 'UserPromptSubmit'), prompt: extractTextContent(content) }
}
function preToolPayload(exec: ToolExecution): Record<string, unknown> {
  return { ...base(exec.agent, 'PreToolUse'), tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId }
}
function postToolPayload(exec: ToolExecution, result: ToolExecutionResult): Record<string, unknown> {
  return { ...base(exec.agent, 'PostToolUse'), tool_name: exec.name, tool_input: exec.arguments, tool_use_id: exec.callId, tool_response: extractTextContent(result.content) }
}
function stopPayload(agent: Agent, stopHookActive: boolean): Record<string, unknown> {
  return { ...base(agent, 'Stop'), stop_hook_active: stopHookActive }
}
/**
 * Build a SubagentStart/SubagentStop payload from the CC base (the child's
 * `session_id`/`cwd` when the child agent is available) plus the subagent-hook
 * fields. `agent_type` is the CC-default {@link SUBAGENT_TYPE}; `stop_hook_active`
 * is present on SubagentStop only (the loop-guard flag, always false).
 */
function subagentPayload(event: 'SubagentStart' | 'SubagentStop', info: { id: string }, child: Agent | undefined): Record<string, unknown> {
  return {
    ...base(child, event),
    agent_id: info.id,
    agent_type: SUBAGENT_TYPE,
    ...event === 'SubagentStop' ? { stop_hook_active: false } : {},
  }
}
