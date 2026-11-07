import { describe, expect, it } from 'vitest'
import type { PatentModelEvent, PatentModelPort } from '@deepseek-ai/dsh-patent-core'
import { loggedPatentModel } from '../src/model-call-log.ts'
import type { PatentAgent, PatentModelCallEvent } from '../src/types.ts'

/** Session stub that collects the patent/model-call payloads appended through it. */
function agentStub(): { agent: PatentAgent; appended: PatentModelCallEvent[] } {
  const appended: PatentModelCallEvent[] = []
  const session = {
    id: 'session-1',
    append: (type: string, data: PatentModelCallEvent) => {
      if (type === 'patent/model-call') appended.push(data)
      return { type, data, seq: 1 }
    },
  }
  return { agent: { session } as unknown as PatentAgent, appended }
}

/** Port stub replaying one fixed event list, optionally declaring a route. */
function portStub(
  events: readonly PatentModelEvent[],
  route?: { provider: string; model: string },
): PatentModelPort {
  return {
    ...(route === undefined ? {} : { route }),
    async *stream() {
      for (const event of events) yield event
    },
  }
}

/** Read one appended record, failing the test when the call appended none. */
function recordAt(appended: readonly PatentModelCallEvent[], index: number): PatentModelCallEvent {
  const record = appended[index]
  if (record === undefined) throw new Error(`expected model-call record ${String(index)}`)
  return record
}

/** Consume one wrapped port completely and return the forwarded events. */
async function drain(port: PatentModelPort): Promise<PatentModelEvent[]> {
  const seen: PatentModelEvent[] = []
  for await (const event of port.stream({ messages: [] })) seen.push(event)
  return seen
}

describe('loggedPatentModel', () => {
  it('forwards every event and appends one call record with the visible text and usage', async () => {
    const { agent, appended } = agentStub()
    const port = loggedPatentModel(
      portStub(
        [
          { type: 'delta', text: '阶段' },
          { type: 'delta', text: '成果' },
          { type: 'done', usage: { inputTokens: 12, outputTokens: 2 } },
        ],
        { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      ),
      agent,
      { callSite: 'patent_workflow_run', manifestId: 'patent_oa_response_v1' },
    )

    expect(await drain(port)).toEqual([
      { type: 'delta', text: '阶段' },
      { type: 'delta', text: '成果' },
      { type: 'done', usage: { inputTokens: 12, outputTokens: 2 } },
    ])
    // Timing is asserted separately so the remaining payload stays exact.
    const { durationMs, ...payload } = recordAt(appended, 0)
    expect(payload).toEqual({
      callSite: 'patent_workflow_run',
      manifestId: 'patent_oa_response_v1',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      output: '阶段成果',
      callSequence: 1,
      usage: { inputTokens: 12, outputTokens: 2 },
      llmStreamCall: true,
    })
    expect(typeof durationMs).toBe('number')
  })

  it('keeps the declared route on the wrapper and omits route fields the port does not declare', async () => {
    const { agent, appended } = agentStub()
    const route = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
    const wrapped = loggedPatentModel(portStub([], route), agent, { callSite: 'claim_chart_build' })
    expect(wrapped.route).toEqual(route)

    await drain(wrapped)
    expect(appended[0]?.provider).toBe('deepseek-official')

    const unrouted = loggedPatentModel(portStub([]), agent, { callSite: 'claim_chart_build' })
    expect(unrouted.route).toBeUndefined()
    await drain(unrouted)
    const { durationMs, ...payload } = recordAt(appended, 1)
    expect(payload).toEqual({ callSite: 'claim_chart_build', output: '', callSequence: 1, llmStreamCall: true })
    expect(typeof durationMs).toBe('number')
  })

  it('measures the stream to its last event, in whole milliseconds', async () => {
    const { agent, appended } = agentStub()
    const delayed: PatentModelPort = {
      async *stream() {
        await new Promise<void>(resolve => setTimeout(resolve, 20))
        yield { type: 'delta' as const, text: 'a' }
        await new Promise<void>(resolve => setTimeout(resolve, 20))
        yield { type: 'done' as const }
      },
    }

    await drain(loggedPatentModel(delayed, agent, { callSite: 'patent_workflow_run' }))

    // Two 20 ms waits: stopping at the first event would report about half this.
    const { durationMs } = recordAt(appended, 0)
    expect(durationMs).toBeGreaterThanOrEqual(35)
    expect(Number.isInteger(durationMs)).toBe(true)
  })

  it('numbers the calls one wrapper serves in start order, even when they finish out of order', async () => {
    const { agent, appended } = agentStub()
    // 两个并发调用（同一 run 的并行阶段）：第二个先结束，事件按完成顺序落盘，
    // 开始序号让读者仍能重建调用顺序。
    const gates: (() => void)[] = []
    let call = 0
    const port: PatentModelPort = {
      async *stream() {
        call += 1
        const index = call
        await new Promise<void>(resolve => gates.push(resolve))
        yield { type: 'delta' as const, text: `call-${String(index)}` }
        yield { type: 'done' as const }
      },
    }
    const wrapped = loggedPatentModel(port, agent, { callSite: 'patent_workflow_run' })
    const first = drain(wrapped)
    const second = drain(wrapped)
    await new Promise(resolve => setImmediate(resolve))
    expect(gates).toHaveLength(2)
    gates[1]?.()
    await new Promise(resolve => setImmediate(resolve))
    expect(appended.map(entry => entry.callSequence)).toEqual([2])
    gates[0]?.()
    await Promise.all([first, second])
    expect(appended.map(entry => [entry.callSequence, entry.output])).toEqual([[2, 'call-2'], [1, 'call-1']])
  })

  it("rebinds the port to the calling agent's session so its calls are attributable", async () => {
    const { agent } = agentStub()
    const bound: string[] = []
    const base: PatentModelPort = {
      ...portStub([{ type: 'delta', text: 'x' }]),
      bindSession: (sessionId) => {
        bound.push(String(sessionId))
        return portStub([{ type: 'delta', text: 'x' }])
      },
    }

    expect(await drain(loggedPatentModel(base, agent, { callSite: 'claim_chart_build' }))).toEqual([
      { type: 'delta', text: 'x' },
    ])
    expect(bound).toEqual(['session-1'])
  })

  it('returns the port unchanged without an agent', async () => {
    const port = portStub([{ type: 'done' }])
    expect(loggedPatentModel(port, undefined, { callSite: 'patent_workflow_run' })).toBe(port)
  })

  it('records nothing for a stream that fails mid-flight, and propagates the failure', async () => {
    const { agent, appended } = agentStub()
    const failing: PatentModelPort = {
      async *stream() {
        yield { type: 'delta', text: '半' }
        throw new Error('provider exploded')
      },
    }
    const port = loggedPatentModel(failing, agent, { callSite: 'patent_workflow_run' })

    await expect(drain(port)).rejects.toThrow('provider exploded')
    expect(appended).toEqual([])
  })

  it('records nothing when the consumer stops before the stream ends', async () => {
    const { agent, appended } = agentStub()
    const port = loggedPatentModel(
      portStub([{ type: 'delta', text: 'a' }, { type: 'delta', text: 'b' }, { type: 'done' }]),
      agent,
      { callSite: 'patent_workflow_run' },
    )

    for await (const event of port.stream({ messages: [] })) {
      expect(event.type).toBe('delta')
      break
    }
    expect(appended).toEqual([])
  })
})
