import { expect, it } from 'vitest'
import { StageCancelledError } from '@deepseek-ai/dsh-patent-core'
import { runNodeWithPolicy } from '../../src/graph/node-policy.ts'
import type { GraphNode, StateDelta } from '../../src/graph/types.ts'

const okNode =
  (value: unknown): GraphNode =>
    async () => ({ key: value })

it('runNodeWithPolicy: 无策略直接成功', async () => {
  const outcome = await runNodeWithPolicy(okNode('v'), undefined, { state: {} })
  expect(outcome.ok).toBe(true)
  if (outcome.ok) expect(outcome.delta).toEqual({ key: 'v' })
})

it('runNodeWithPolicy: 重试成功（第 2 次成功）', async () => {
  let calls = 0
  const flaky: GraphNode = async () => {
    calls += 1
    if (calls < 2) throw new Error('boom')
    return { key: 'ok' }
  }
  const outcome = await runNodeWithPolicy(flaky, { maxRetries: 2, retryDelayMs: 1 }, { state: {} })
  expect(outcome.ok).toBe(true)
  expect(calls).toBe(2)
})

it('runNodeWithPolicy: 重试耗尽返回失败', async () => {
  let calls = 0
  const alwaysFail: GraphNode = async () => {
    calls += 1
    throw new Error('always')
  }
  const outcome = await runNodeWithPolicy(alwaysFail, { maxRetries: 3, retryDelayMs: 1 }, { state: {} })
  expect(outcome.ok).toBe(false)
  expect(calls).toBe(4)
})

it('runNodeWithPolicy: 超时跨重试截断（总时长含重试）', async () => {
  let calls = 0
  const slow: GraphNode = async () => {
    calls += 1
    await new Promise(resolve => setTimeout(resolve, 50))
    return { key: 'late' }
  }
  const outcome = await runNodeWithPolicy(slow, { maxRetries: 3, timeoutMs: 30, retryDelayMs: 1 }, { state: {} })
  expect(outcome.ok).toBe(false)
  // 超时后不再重试：仅 1 次调用。
  expect(calls).toBe(1)
  if (!outcome.ok) expect(outcome.error instanceof Error).toBe(true)
})

it('runNodeWithPolicy: 超时注入 AbortSignal（节点可感知）', async () => {
  let sawAbort = false
  const abortAware: GraphNode = async ({ signal }) => {
    await new Promise<void>((resolve) => {
      signal?.addEventListener('abort', () => {
        sawAbort = true
        resolve()
      })
      setTimeout(resolve, 200)
    })
    throw new Error('aborted')
  }
  const outcome = await runNodeWithPolicy(abortAware, { timeoutMs: 20 }, { state: {} })
  expect(outcome.ok).toBe(false)
  expect(sawAbort).toBe(true)
})

it('runNodeWithPolicy: sideEffect 丢弃 delta', async () => {
  const outcome = await runNodeWithPolicy(okNode('v'), { sideEffect: true }, { state: {} })
  expect(outcome.ok).toBe(true)
  if (outcome.ok) expect(outcome.delta).toEqual({})
})

it('runNodeWithPolicy: 节点同步抛错被捕获', async () => {
  const syncThrow: GraphNode = () => {
    throw new Error('sync')
  }
  const outcome = await runNodeWithPolicy(syncThrow, undefined, { state: {} })
  expect(outcome.ok).toBe(false)
})

it('runNodeWithPolicy: 硬上界——不听 signal 的挂起节点也会在 deadline 后被判超时', async () => {
  // 节点完全不响应 signal 且永不 settle：without withDeadline 整个超步会无限等待。
  const hung: GraphNode = () => new Promise<StateDelta>(() => {})
  const startedAt = Date.now()
  const outcome = await runNodeWithPolicy(hung, { timeoutMs: 30 }, { state: {} })
  expect(outcome.ok).toBe(false)
  expect(Date.now() - startedAt).toBeLessThan(2000)
})

it('runNodeWithPolicy: 调用方取消 signal 联动节点 abort 并报取消而非超时', async () => {
  const controller = new AbortController()
  const abortAware: GraphNode = async ({ signal }) => {
    await new Promise<void>((resolve) => {
      signal?.addEventListener('abort', () => { resolve() })
      setTimeout(resolve, 200)
    })
    throw new Error('caller aborted')
  }
  const run = runNodeWithPolicy(abortAware, { timeoutMs: 5000 }, { state: {}, signal: controller.signal })
  setTimeout(() => { controller.abort() }, 20)
  const outcome = await run
  expect(outcome.ok).toBe(false)
  if (!outcome.ok) expect((outcome.error as Error).message).toContain('取消')
})

it('runNodeWithPolicy: 调用方取消时类型化取消穿透且不重试', async () => {
  const controller = new AbortController()
  let calls = 0
  const cancelling: GraphNode = async () => {
    calls += 1
    controller.abort()
    throw new StageCancelledError('cancel-node')
  }
  await expect(
    runNodeWithPolicy(cancelling, { maxRetries: 3, retryDelayMs: 1 }, { state: {}, signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'StageCancelledError', stageId: 'cancel-node' })
  expect(calls).toBe(1)
})

it('runNodeWithPolicy: 无调用方取消的类型化取消按节点失败处理', async () => {
  const outcome = await runNodeWithPolicy(
    async () => { throw new StageCancelledError('inner') },
    undefined,
    { state: {} },
  )
  expect(outcome.ok).toBe(false)
  if (!outcome.ok) expect(outcome.error).toBeInstanceOf(StageCancelledError)
})
