import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createSteeringSignal, emitAgentEvent, type Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'

type Message = ReturnType<typeof createUserMessage>

/** An Inbox that only serves reads; mutation support is not part of this module's contract. */
function readOnlyInbox(nextStep: Message[]): Agent['inbox'] {
  const rejectMutation = (): never => {
    throw new Error('this test Agent does not support Inbox mutations')
  }
  return {
    nextTurn: [], nextStep, clear: rejectMutation, append: rejectMutation,
    prepend: rejectMutation, replace: rejectMutation, remove: rejectMutation, splice: rejectMutation,
  }
}

/** A complete Agent double whose next-step inbox is the returned mutable array. */
function agent(rawId: string): { agent: Agent; nextStep: Message[] } {
  const id = SessionId(rawId)
  const nextStep: Message[] = []
  const value: Agent = {
    id,
    options: {},
    session: Session.create(id),
    model: {
      current: () => undefined,
      select: () => { throw new Error('this test Agent does not support model selection') },
    },
    inbox: readOnlyInbox(nextStep),
    status: 'idle',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  return { agent: value, nextStep }
}

function message(text: string): Message {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

describe('createSteeringSignal', () => {
  it('latches steering for one agent until the message leaves the next-step inbox', () => {
    const ctx = new Context()
    const signal = createSteeringSignal(ctx)
    const subject = agent('steering-a')
    const other = agent('steering-b')
    // A non-steering message of an agent the signal never latched must not throw.
    emitAgentEvent(ctx, other.agent, 'agent/inbox/claimed', { message: message('claimed'), turn: 1 })
    const firstListener = vi.fn()
    const secondListener = vi.fn()
    const unsubscribeFirst = signal.subscribe(subject.agent, firstListener)
    const unsubscribeSecond = signal.subscribe(subject.agent, secondListener)

    const steer = message('steer')
    subject.nextStep.push(steer)
    emitAgentEvent(ctx, subject.agent, 'agent/steered', { message: steer })
    expect(signal.isPending(subject.agent)).toBe(true)
    expect(signal.isPending(other.agent)).toBe(false)
    expect(firstListener).toHaveBeenCalledTimes(1)
    expect(secondListener).toHaveBeenCalledTimes(1)

    const foreign = message('foreign')
    other.nextStep.push(foreign)
    emitAgentEvent(ctx, other.agent, 'agent/steered', { message: foreign })
    expect(firstListener).toHaveBeenCalledTimes(1)
    expect(secondListener).toHaveBeenCalledTimes(1)
    expect(signal.isPending(other.agent)).toBe(true)

    // The first listener's removal leaves the second one subscribed.
    unsubscribeFirst()
    subject.nextStep.splice(0)
    emitAgentEvent(ctx, subject.agent, 'agent/inbox/claimed', { message: steer, turn: 1 })
    expect(signal.isPending(subject.agent)).toBe(false)

    const discarded = message('discarded')
    subject.nextStep.push(discarded)
    emitAgentEvent(ctx, subject.agent, 'agent/steered', { message: discarded })
    expect(firstListener).toHaveBeenCalledTimes(1)
    expect(secondListener).toHaveBeenCalledTimes(2)
    subject.nextStep.splice(0)
    emitAgentEvent(ctx, subject.agent, 'agent/inbox/discarded', { message: discarded })
    expect(signal.isPending(subject.agent)).toBe(false)

    unsubscribeSecond()
    const afterUnsubscribe = message('after unsubscribe')
    subject.nextStep.push(afterUnsubscribe)
    emitAgentEvent(ctx, subject.agent, 'agent/steered', { message: afterUnsubscribe })
    expect(secondListener).toHaveBeenCalledTimes(2)
  })
})
