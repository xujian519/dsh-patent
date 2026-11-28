import { afterEach, describe, expect, it, vi } from 'vitest'
import { startSpawnDeadline } from '@deepseek-ai/dsh-patent-core'

afterEach(() => {
  vi.useRealTimers()
})

describe('startSpawnDeadline', () => {
  it('aborts at the timeout and reports timedOut', () => {
    vi.useFakeTimers()
    const deadline = startSpawnDeadline(1_000)
    try {
      expect(deadline.signal.aborted).toBe(false)
      expect(deadline.timedOut()).toBe(false)
      vi.advanceTimersByTime(999)
      expect(deadline.signal.aborted).toBe(false)
      vi.advanceTimersByTime(1)
      expect(deadline.signal.aborted).toBe(true)
      expect(deadline.timedOut()).toBe(true)
    } finally {
      deadline.dispose()
    }
  })

  it('follows a caller abort without claiming an internal timeout', () => {
    vi.useFakeTimers()
    const caller = new AbortController()
    const deadline = startSpawnDeadline(60_000, caller.signal)
    try {
      caller.abort()
      expect(deadline.signal.aborted).toBe(true)
      expect(deadline.timedOut()).toBe(false)
      // 子进程收尾可能慢于剩余超时：计时器若没被取消，这里会翻成内部超时，
      // 把用户主动取消误报成超时。
      vi.advanceTimersByTime(60_000)
      expect(deadline.timedOut()).toBe(false)
    } finally {
      deadline.dispose()
    }
  })

  it('aborts immediately when the caller signal is already aborted', () => {
    vi.useFakeTimers()
    const caller = new AbortController()
    caller.abort()
    const deadline = startSpawnDeadline(60_000, caller.signal)
    try {
      expect(deadline.signal.aborted).toBe(true)
      expect(deadline.timedOut()).toBe(false)
      // 已中止信号不会再派发事件：计时器必须一并取消，否则收尾期间会误报内部超时。
      vi.advanceTimersByTime(60_000)
      expect(deadline.timedOut()).toBe(false)
    } finally {
      deadline.dispose()
    }
  })

  it('stops the timer and the caller listener on dispose', () => {
    vi.useFakeTimers()
    const caller = new AbortController()
    const deadline = startSpawnDeadline(1_000, caller.signal)
    deadline.dispose()
    vi.advanceTimersByTime(5_000)
    expect(deadline.signal.aborted).toBe(false)
    expect(deadline.timedOut()).toBe(false)
    // 调用方在 dispose 之后取消也不再传播：监听已摘除。
    caller.abort()
    expect(deadline.signal.aborted).toBe(false)
  })
})
