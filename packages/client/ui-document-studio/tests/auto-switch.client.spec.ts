/**
 * Auto-switch eligibility: the studio may only take the screen once the
 * session has logged a successful `document_deliver` registration.
 */
import { describe, expect, it } from 'vitest'
import type { SessionLiveEventEntry, SessionTransientEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm'
import { endsAfterTurn, hasDeliverRegistration, hasDocumentProduced } from '../src/client/auto-switch.ts'

function at(seq: number, type: string, data: unknown, surfaceOp?: 'append' | 'replace'): SessionLiveEventEntry {
  return {
    type: 'event',
    event: {
      seq, time: seq * 1_000, type, data,
      ...surfaceOp === undefined ? {} : { surfaceOp },
    } as SessionEvent,
  }
}

function call(seq: number, callId: string, name: string): SessionLiveEventEntry {
  return at(seq, 'tool/call', { turn: 1, step: 1, callId, name, arguments: '{}' })
}

function result(seq: number, callId: string, isError = false, surfaceOp: 'append' | 'replace' = 'append'): SessionLiveEventEntry {
  return at(seq, 'tool/result', {
    turn: 1, step: 1,
    message: { source: { kind: 'tool', callId }, content: [], isError },
  }, surfaceOp)
}

describe('hasDeliverRegistration', () => {
  it('is false for an empty window and for a call without its result', () => {
    expect(hasDeliverRegistration([])).toBe(false)
    expect(hasDeliverRegistration([call(1, 'reg', 'document_deliver')])).toBe(false)
  })

  it('is true once the registration call has a non-error append result', () => {
    expect(hasDeliverRegistration([
      call(1, 'reg', 'document_deliver'),
      result(2, 'reg'),
    ])).toBe(true)
  })

  it('ignores a failed registration, a non-append settlement, and unrelated tools', () => {
    expect(hasDeliverRegistration([
      call(1, 'reg', 'document_deliver'),
      result(2, 'reg', true),
    ])).toBe(false)
    expect(hasDeliverRegistration([
      call(3, 'reg', 'document_deliver'),
      result(4, 'reg', false, 'replace'),
    ])).toBe(false)
    expect(hasDeliverRegistration([
      call(5, 'write', 'write'),
      result(6, 'write'),
    ])).toBe(false)
  })

  it('ignores transient entries and pairs results with their own call', () => {
    const transient: SessionTransientEventEntry = {
      type: 'transient',
      event: {
        type: 'assistant/live-chunk',
        seq: 1,
        time: 1,
        data: {
          attemptId: LlmAttemptId('transient-probe'),
          turn: 1,
          step: 1,
          chunk: { type: 'text-delta', index: 0, text: 'live' },
        },
      },
    }
    expect(hasDeliverRegistration([
      transient,
      call(1, 'other', 'write'),
      result(2, 'reg'),
    ])).toBe(false)
  })
})

/** One finished turn. */
function turnEnd(seq: number): SessionLiveEventEntry {
  return at(seq, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
}

describe('endsAfterTurn', () => {
  it('is false for an empty window and for a turn still in progress', () => {
    expect(endsAfterTurn([])).toBe(false)
    expect(endsAfterTurn([call(1, 'w', 'write'), result(2, 'w')])).toBe(false)
  })

  it('is true once the newest turn-lifecycle event is turn/end', () => {
    expect(endsAfterTurn([turnEnd(3)])).toBe(true)
    expect(endsAfterTurn([call(1, 'w', 'write'), result(2, 'w'), turnEnd(3)])).toBe(true)
  })

  it('skips events a finished turn appends outside its lifecycle', () => {
    expect(endsAfterTurn([
      turnEnd(3),
      at(4, 'session/title', { title: 'Report' }),
      at(5, 'session-log-deepseek/delivery-accepted', { sessionId: 's', throughSeq: 3 }),
    ])).toBe(true)
  })

  it('is false when a newer turn started after the last end', () => {
    expect(endsAfterTurn([turnEnd(3), at(4, 'turn/start', { turn: 2 })])).toBe(false)
    expect(endsAfterTurn([turnEnd(3), at(4, 'assistant/message', { turn: 2, step: 1 })])).toBe(false)
  })

  it('ignores transient presentation rows', () => {
    const transient: SessionTransientEventEntry = {
      type: 'transient',
      event: {
        type: 'assistant/live-chunk',
        seq: 4,
        time: 4,
        data: {
          attemptId: LlmAttemptId('transient-probe'),
          turn: 1,
          step: 1,
          chunk: { type: 'text-delta', index: 0, text: 'live' },
        },
      },
    }
    expect(endsAfterTurn([turnEnd(3), transient])).toBe(true)
  })
})

describe('hasDocumentProduced', () => {
  it('is false for a call without a deliverable path', () => {
    expect(hasDocumentProduced([
      call(1, 'w1', 'write'),
      result(2, 'w1'),
    ])).toBe(false)
  })

  it('reads the mutation path from the call arguments', () => {
    const window = (path: string, isError = false): SessionLiveEventEntry[] => [
      at(1, 'tool/call', {
        turn: 1, step: 1, callId: 'w', name: 'write',
        arguments: JSON.stringify({ file_path: path, content: 'x' }),
      }),
      result(2, 'w', isError),
    ]
    expect(hasDocumentProduced(window('brief.md'))).toBe(true)
    expect(hasDocumentProduced(window('chapters/01-intro.md'))).toBe(true)
    expect(hasDocumentProduced(window('deck.html'))).toBe(true)
    expect(hasDocumentProduced(window('brief.md', true))).toBe(false)
    expect(hasDocumentProduced(window('notes.ts'))).toBe(false)
  })

  it('skips transient presentation rows before a mutation settles', () => {
    const transient: SessionTransientEventEntry = {
      type: 'transient',
      event: {
        type: 'assistant/live-chunk',
        seq: 0,
        time: 0,
        data: {
          attemptId: LlmAttemptId('transient-probe'),
          turn: 1,
          step: 1,
          chunk: { type: 'text-delta', index: 0, text: 'live' },
        },
      },
    }
    expect(hasDocumentProduced([
      transient,
      at(1, 'tool/call', {
        turn: 1, step: 1, callId: 'w', name: 'write',
        arguments: JSON.stringify({ file_path: 'brief.md', content: 'x' }),
      }),
      result(2, 'w'),
    ])).toBe(true)
  })

  it('ignores non-append settlements and unrelated tools', () => {
    expect(hasDocumentProduced([
      at(1, 'tool/call', {
        turn: 1, step: 1, callId: 'w', name: 'write',
        arguments: JSON.stringify({ file_path: 'brief.md', content: 'x' }),
      }),
      result(2, 'w', false, 'replace'),
    ])).toBe(false)
    expect(hasDocumentProduced([
      call(3, 'list', 'list_files'),
      result(4, 'list'),
    ])).toBe(false)
  })
})
