/**
 * Contract tests for the MiniMax provider's rate-limit handling: a `429` whose
 * `Retry-After` fits the ceiling is retried after that wait, and every other
 * shape of `429` fails at once. The clock is injected so no test sleeps.
 */

import { describe, expect, it } from 'vitest'
import { delay } from '../src/cloud-common.ts'
import {
  MiniMaxMediaProvider,
  resolveMiniMax,
  type MiniMaxConfig,
  type MiniMaxFetchLike,
} from '../src/index.ts'

/** Settings with a test key and an explicit retry policy. */
function settingsOf(overrides: MiniMaxConfig = {}) {
  return resolveMiniMax({ enabled: true, apiKey: 'sk-test', pollMs: 1, ...overrides }, 1024 * 1024)
}

/** A `429` carrying the given `Retry-After` header. */
function limited(retryAfter?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (retryAfter !== undefined) headers['retry-after'] = retryAfter
  return new Response(JSON.stringify({ error: { message: 'rate limited' } }), { status: 429, headers })
}

/** A `200` submission response naming one task. */
function accepted(taskId: string): Response {
  return new Response(JSON.stringify({ task_id: taskId }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** A `200` status response reporting one task state. */
function statusOf(state: string): Response {
  return new Response(JSON.stringify({ task: { status: state } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** Submit one video task. */
function submit(provider: MiniMaxMediaProvider) {
  return provider.submit({ kind: 'video', prompt: 'a lantern drifts over a river' }, new AbortController().signal)
}

/** A fetch stub serving the queued responses in order. */
function sequence(responses: Response[]): MiniMaxFetchLike {
  return async () => {
    const response = responses.shift()
    if (response === undefined) throw new Error('unexpected extra request')
    return response
  }
}

/** Collect the waits a provider asks for. */
function sleeps(): { waits: number[]; sleep: (ms: number) => Promise<void> } {
  const waits: number[] = []
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms)
    },
  }
}

describe('minimax rate-limit contract', () => {
  it('retries once after the wait a Retry-After header asks for', async () => {
    const responses = [limited('1'), accepted('remote-1')]
    const clock = sleeps()
    const provider = new MiniMaxMediaProvider(settingsOf(), sequence(responses), undefined, clock.sleep)

    const task = await submit(provider)

    expect(task.status).toBe('submitted')
    expect(clock.waits).toEqual([1000])
    expect(responses).toEqual([])
  })

  it('gives up after the configured number of retries', async () => {
    let calls = 0
    const fetchImpl: MiniMaxFetchLike = async () => {
      calls += 1
      return limited('0')
    }
    const clock = sleeps()
    const provider = new MiniMaxMediaProvider(settingsOf({ maxRetries: 2 }), fetchImpl, undefined, clock.sleep)

    await expect(submit(provider)).rejects.toMatchObject({ code: 'MEDIA_TASK_FAILED' })

    expect(calls).toBe(3)
    expect(clock.waits).toEqual([0, 0])
  })

  it('fails at once when Retry-After exceeds the wait ceiling', async () => {
    let calls = 0
    const fetchImpl: MiniMaxFetchLike = async () => {
      calls += 1
      return limited('60')
    }
    const clock = sleeps()
    const provider = new MiniMaxMediaProvider(settingsOf({ maxRetryAfterMs: 5_000 }), fetchImpl, undefined, clock.sleep)

    await expect(submit(provider)).rejects.toMatchObject({ code: 'MEDIA_TASK_FAILED' })

    expect(calls).toBe(1)
    expect(clock.waits).toEqual([])
  })

  it('resolves delay after the requested wait', async () => {
    await delay(0)
  })

  it('fails at once when Retry-After is not a delay', async () => {
    let calls = 0
    const fetchImpl: MiniMaxFetchLike = async () => {
      calls += 1
      return limited('not-a-date')
    }
    const clock = sleeps()
    const provider = new MiniMaxMediaProvider(settingsOf(), fetchImpl, undefined, clock.sleep)

    await expect(submit(provider)).rejects.toMatchObject({ code: 'MEDIA_TASK_FAILED' })

    expect(calls).toBe(1)
    expect(clock.waits).toEqual([])
  })

  it('retries when releasing the rate-limited body throws', async () => {
    const stream = new ReadableStream({
      cancel() {
        throw new Error('already closed')
      },
    })
    const rejected = new Response(stream, {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '1' },
    })
    const responses = [rejected, accepted('remote-cancel')]
    const clock = sleeps()
    const provider = new MiniMaxMediaProvider(settingsOf(), sequence(responses), undefined, clock.sleep)

    const task = await submit(provider)

    expect(task.status).toBe('submitted')
    expect(clock.waits).toEqual([1000])
  })

  it('fails at once when the response names no wait', async () => {
    let calls = 0
    const fetchImpl: MiniMaxFetchLike = async () => {
      calls += 1
      return limited()
    }
    const clock = sleeps()
    const provider = new MiniMaxMediaProvider(settingsOf(), fetchImpl, undefined, clock.sleep)

    await expect(submit(provider)).rejects.toMatchObject({ code: 'MEDIA_TASK_FAILED' })

    expect(calls).toBe(1)
    expect(clock.waits).toEqual([])
  })

  it('reads an HTTP-date Retry-After', async () => {
    const responses = [limited(new Date(Date.now() + 3_000).toUTCString()), accepted('remote-2')]
    const clock = sleeps()
    const provider = new MiniMaxMediaProvider(settingsOf(), sequence(responses), undefined, clock.sleep)

    await submit(provider)

    expect(clock.waits).toHaveLength(1)
    const waited = clock.waits[0] ?? 0
    expect(waited).toBeGreaterThan(2_000)
    expect(waited).toBeLessThanOrEqual(3_000)
  })

  it('retries the status endpoint under the same policy', async () => {
    const responses = [accepted('remote-3'), limited('0'), statusOf('queued')]
    const clock = sleeps()
    const provider = new MiniMaxMediaProvider(settingsOf({ pollMs: 1 }), sequence(responses), undefined, clock.sleep)
    const task = await submit(provider)
    await new Promise(resolve => setTimeout(resolve, 2))

    const polled = await provider.poll(task, new AbortController().signal)

    expect(polled.status).toBe('queued')
    expect(clock.waits).toEqual([0])
  })
})
