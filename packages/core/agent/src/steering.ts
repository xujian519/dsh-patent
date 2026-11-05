/**
 * Shared steering broadcast and pending-state view for blocking tool waits.
 *
 * The steering delivery operation raises `agent/steered`; a waiter ends its
 * wait while {@link SteeringSignal.isPending} reports steering for its agent,
 * so input delivered before the wait began still releases it. Queued turns and
 * injected context raise nothing, whatever their message source says.
 *
 * @module @deepseek-ai/dsh-agent/steering
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { Agent } from './types.ts'

/** Live broadcast plus latched state of steering input, shared by blocking waits. */
export interface SteeringSignal {
  /**
   * Whether a pending next-step message was delivered as steering and still
   * awaits the next step boundary.
   * @param agent - agent whose pending steering is read.
   * @returns true while steering remains in the next-step inbox.
   */
  isPending(agent: Agent): boolean

  /**
   * Subscribe to steering delivered for one agent.
   * @param agent - the agent whose steering wakes the listener.
   * @param listener - called synchronously after a steering insertion.
   * @returns a disposer that removes this listener.
   */
  subscribe(agent: Agent, listener: () => void): () => void
}

/**
 * Build the steering signal shared by a plugin's blocking waits.
 * @param ctx - context whose disposal removes the underlying event listeners.
 * @returns the steering signal.
 */
export function createSteeringSignal(ctx: Context): SteeringSignal {
  const pending = new WeakMap<Agent, Set<MessageId>>()
  const listeners = new WeakMap<Agent, Set<() => void>>()
  ctx.on('agent/steered', ({ agent, message }) => {
    let ids = pending.get(agent)
    if (ids === undefined) {
      ids = new Set()
      pending.set(agent, ids)
    }
    ids.add(message.id)
    const waiting = listeners.get(agent)
    if (waiting === undefined) return
    for (const listener of [...waiting]) listener()
  })
  // A claimed message reached its step and a discarded one was withdrawn; in
  // either case it can no longer release a wait.
  const settle = ({ agent, message }: { agent: Agent; message: UserMessage }): void => {
    pending.get(agent)?.delete(message.id)
  }
  ctx.on('agent/inbox/claimed', settle)
  ctx.on('agent/inbox/discarded', settle)
  return {
    isPending(agent) {
      const ids = pending.get(agent)
      return ids !== undefined && agent.inbox.nextStep.some(message => ids.has(message.id))
    },
    subscribe(agent, listener) {
      let waiting = listeners.get(agent)
      if (waiting === undefined) {
        waiting = new Set()
        listeners.set(agent, waiting)
      }
      waiting.add(listener)
      return () => {
        waiting.delete(listener)
        if (waiting.size === 0) listeners.delete(agent)
      }
    },
  }
}
