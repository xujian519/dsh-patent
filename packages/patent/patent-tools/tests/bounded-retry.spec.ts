import { afterEach, describe, expect, it, vi } from 'vitest'
import { retryBounded } from '../src/tool/internal/bounded-retry.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('retryBounded', () => {
  it('repeats a retryable result once per backoff entry', async () => {
    vi.useFakeTimers()
    let calls = 0
    const run = retryBounded(
      async () => {
        calls += 1
        return calls >= 3
      },
      settled => !settled,
      [10, 20],
    )
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(20)
    const { result, attempts } = await run
    expect(result).toBe(true)
    expect(attempts).toBe(3)
  })

  it('stops as soon as the result is no longer retryable', async () => {
    let calls = 0
    const { result, attempts } = await retryBounded(
      async () => {
        calls += 1
        return true
      },
      () => false,
      [10, 20],
    )
    expect(result).toBe(true)
    expect(calls).toBe(1)
    expect(attempts).toBe(1)
  })

  it('ends the backoff early when the caller aborts', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let calls = 0
    const run = retryBounded(
      async () => {
        calls += 1
        return false
      },
      () => true,
      [1_000],
      controller.signal,
    )
    // Abort while the 1s backoff is pending: the wait must end at once and the
    // repeat attempt must never start.
    await vi.advanceTimersByTimeAsync(10)
    controller.abort()
    const { attempts } = await run
    expect(calls).toBe(1)
    expect(attempts).toBe(1)
  })
})
