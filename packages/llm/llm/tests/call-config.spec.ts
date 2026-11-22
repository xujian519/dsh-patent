/**
 * call-config unit tests: field-wise LlmCallConfig equality (the real-change
 * detector behind logged changed headers) and the agent-loop request identity
 * markers the loop applies to every built request.
 */

import { describe, expect, it } from 'vitest'
import { callConfigEquals, isAgentLoopRequest, markAgentLoopRequest } from '../src/call-config.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ReasoningEffortId } from '../src/types.ts'
import type { GenerateOptions } from '../src/types.ts'

describe('callConfigEquals', () => {
  it('compares every field, including the stop list element-wise', () => {
    const base = { provider: 'p', model: 'm' }
    expect(callConfigEquals(base, base)).toBe(true)
    expect(callConfigEquals(base, { provider: 'x', model: 'm' })).toBe(false)
    expect(callConfigEquals(base, { provider: 'p', model: 'x' })).toBe(false)
    expect(callConfigEquals({ ...base, reasoningEffort: brandString<ReasoningEffortId>('high') }, base)).toBe(false)
    expect(callConfigEquals(
      { ...base, reasoningEffort: brandString<ReasoningEffortId>('high') },
      { ...base, reasoningEffort: brandString<ReasoningEffortId>('high') },
    )).toBe(true)
    expect(callConfigEquals({ ...base, temperature: 0.5 }, base)).toBe(false)
    expect(callConfigEquals({ ...base, maxTokens: 1 }, { ...base, maxTokens: 2 })).toBe(false)
    expect(callConfigEquals({ ...base, stop: ['a'] }, base)).toBe(false)
    expect(callConfigEquals({ ...base, stop: ['a'] }, { ...base, stop: ['a', 'b'] })).toBe(false)
    expect(callConfigEquals({ ...base, stop: ['a'] }, { ...base, stop: ['b'] })).toBe(false)
    expect(callConfigEquals({ ...base, stop: ['a', 'b'] }, { ...base, stop: ['a', 'b'] })).toBe(true)
  })
})

describe('agent-loop request identity', () => {
  it('marks only the exact request object and preserves its identity', () => {
    const request: GenerateOptions = {
      provider: 'mock',
      model: 'model',
      messages: [],
    }
    const copy = { ...request }

    expect(isAgentLoopRequest(request)).toBe(false)
    expect(markAgentLoopRequest(request)).toBe(request)
    expect(isAgentLoopRequest(request)).toBe(true)
    expect(isAgentLoopRequest(copy)).toBe(false)
  })
})
