import { describe, expect, it } from 'vitest'
import {
  StageCancelledError,
  type PatentModelPort,
  type StageProvider,
} from '@deepseek-ai/dsh-patent-core'
import { KeywordsHandler } from '../src/atoms/handlers/builtin/search.ts'

const STATE = { input: '一种过滤装置，包括壳体和滤芯。' }

describe('LLM signal 透传', () => {
  it('provider.callLLM 收到调用方同一个 signal', async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const provider: StageProvider = {
      callLLM: async (_prompt, _opts, signal) => {
        seen = signal
        return JSON.stringify({ keywords: ['过滤装置'] })
      },
    }
    const out = await new KeywordsHandler().execute({ state: STATE, provider, signal: controller.signal })
    expect(seen).toBe(controller.signal)
    expect(out.keywords).toEqual(['过滤装置'])
  })

  it('abort 经 callLLM 接缝传播为类型化取消，不降级', async () => {
    const controller = new AbortController()
    const provider: StageProvider = {
      callLLM: (_prompt, _opts, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
        }),
    }
    const pending = new KeywordsHandler().execute({ state: STATE, provider, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'StageCancelledError', stageId: 'keywords' })
  })

  it('已取消的信号不发起模型调用', async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    const provider: StageProvider = {
      callLLM: async () => {
        calls += 1
        return JSON.stringify({ keywords: ['过滤装置'] })
      },
    }
    await expect(
      new KeywordsHandler().execute({ state: STATE, provider, signal: controller.signal }),
    ).rejects.toBeInstanceOf(StageCancelledError)
    expect(calls).toBe(0)
  })

  it('provider 抛 AbortError 即使信号未中止也按取消处理', async () => {
    const provider: StageProvider = {
      callLLM: async () => { throw new DOMException('aborted', 'AbortError') },
    }
    await expect(new KeywordsHandler().execute({ state: STATE, provider }))
      .rejects.toMatchObject({ name: 'StageCancelledError', stageId: 'keywords' })
  })

  it('provider 已抛出的类型化取消原样穿透', async () => {
    const provider: StageProvider = {
      callLLM: async () => { throw new StageCancelledError('inner') },
    }
    await expect(new KeywordsHandler().execute({ state: STATE, provider }))
      .rejects.toMatchObject({ name: 'StageCancelledError', stageId: 'inner' })
  })

  it('provider.llm 端口收到同一个 signal', async () => {
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const port: PatentModelPort = {
      stream: async function* (_request, signal) {
        seen = signal
        yield { type: 'delta', text: JSON.stringify({ keywords: ['壳体'] }) }
        yield { type: 'done' }
      },
    }
    const out = await new KeywordsHandler().execute({
      state: STATE,
      provider: { llm: port },
      signal: controller.signal,
    })
    expect(seen).toBe(controller.signal)
    expect(out.keywords).toEqual(['壳体'])
  })
})
