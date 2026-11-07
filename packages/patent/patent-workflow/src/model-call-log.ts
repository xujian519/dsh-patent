/**
 * Model-call logging for the patent pipeline: one `patent/model-call` session
 * event per call the pipeline issues through the harness LLM seam.
 *
 * The agent loop logs its own calls as `request/*` + `assistant/*`; a model call
 * a patent tool makes inside its body has no such event, which leaves the
 * request invisible to the session log and the keyless replay unable to rebuild
 * the call order. Every LLM-consuming patent tool therefore wraps its port with
 * {@link loggedPatentModel} before passing it to atoms, the graph, or a stage
 * executor.
 * @module @deepseek-ai/dsh-patent-workflow/model-call-log
 */

import type { PatentModelPort, PatentModelUsage } from '@deepseek-ai/dsh-patent-core'
import type { PatentAgent, PatentModelCallContext } from './types.ts'

/**
 * Wrap one port so every call it serves appends a `patent/model-call` event to
 * the calling agent's session. Without an agent (direct library use, unit
 * tests) the port is returned unchanged, so a caller never has to branch on
 * session availability.
 *
 * The event is appended after the wrapped stream ends: a consumer that stops
 * early or a provider that fails mid-stream leaves no record, matching what a
 * replay can serve (the recorded output is the complete visible text).
 * @param port - the port to wrap.
 * @param agent - the calling agent whose session records the calls, when present.
 * @param context - static labels recorded on every call this port serves.
 * @returns the logging port, or `port` itself without an agent.
 */
export function loggedPatentModel(
  port: PatentModelPort,
  agent: PatentAgent | undefined,
  context: PatentModelCallContext,
): PatentModelPort {
  if (agent === undefined) return port
  const { session } = agent
  // The port owns the request envelope, so the session identity goes through the
  // port's own rebinding: a wrapper that only forwarded requests could not stamp
  // a session id on calls the atoms build themselves.
  const target = port.bindSession?.(session.id) ?? port
  const route = target.route
  // Ordinal among the calls this wrapper serves, read at stream start: concurrent
  // callers (parallel stages of one run) may finish in another order than they
  // started, and the event is appended after its stream ends.
  let calls = 0
  return {
    ...(route === undefined ? {} : { route }),
    async *stream(request, signal) {
      calls += 1
      const callSequence = calls
      const startedAt = performance.now()
      let output = ''
      let usage: PatentModelUsage | undefined
      for await (const event of target.stream(request, signal)) {
        if (event.type === 'delta') output += event.text
        else usage = event.usage
        yield event
      }
      session.append('patent/model-call', {
        callSite: context.callSite,
        ...(context.manifestId === undefined ? {} : { manifestId: context.manifestId }),
        ...(route === undefined ? {} : { provider: route.provider, model: route.model }),
        output,
        callSequence,
        ...(usage === undefined ? {} : { usage }),
        durationMs: Math.round(performance.now() - startedAt),
        llmStreamCall: true,
      })
    },
  }
}
