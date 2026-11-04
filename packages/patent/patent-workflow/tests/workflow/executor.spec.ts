import { describe, expect, it } from 'vitest'
import {
  APPROVAL_GRANTED_KEY,
  AtomRegistry,
  InterruptStageError,
  StageHandlerRegistry,
  type StageHandler,
} from '@deepseek-ai/dsh-patent-core'
import { runStageOnce } from '@deepseek-ai/dsh-patent-workflow'
import type { WorkflowStage } from '@deepseek-ai/dsh-patent-core'

function makeRegistry(handler?: StageHandler): { handlers: StageHandlerRegistry; atoms: AtomRegistry } {
  const handlers = new StageHandlerRegistry()
  const atoms = new AtomRegistry()
  if (handler) {
    handlers.register(handler)
    atoms.register({
      name: handler.name,
      description: '提取',
      category: handler.category,
      inputSchema: [],
      outputSchema: ['result'],
    })
  }
  return { handlers, atoms }
}

function stage(overrides: Partial<WorkflowStage> = {}): WorkflowStage {
  return { id: 's1', strategy: 'chain', description: '测试阶段', ...overrides }
}

const emptyOptions = {
  handlers: new StageHandlerRegistry(),
  atoms: new AtomRegistry(),
  maxRetries: 2,
  ctx: {},
}

describe('runStageOnce', () => {
  it('atom handler output merges into state via the main output key', async () => {
    const { handlers, atoms } = makeRegistry({
      name: 'extract',
      category: 'extract',
      execute: async () => ({ result: '提取结果', extra: 1 }),
    })
    const state: Record<string, unknown> = {}
    const outcome = await runStageOnce(stage({ atom: 'extract' }), state, { ...emptyOptions, handlers, atoms })
    expect(outcome.output).toBe('提取结果')
    expect(state).toEqual({ result: '提取结果', extra: 1, s1: '提取结果' })
  })

  it('falls back to the executor when no atom is declared', async () => {
    let calls = 0
    const outcome = await runStageOnce(
      stage(),
      {},
      {
        ...emptyOptions,
        executor: async (s, _ctx) => {
          calls += 1
          expect(s.id).toBe('s1')
          return 'executor 产出'
        },
      },
    )
    expect(outcome.output).toBe('executor 产出')
    expect(calls).toBe(1)
  })

  it('handler throws, retries, then succeeds', async () => {
    let attempts = 0
    const { handlers, atoms } = makeRegistry({
      name: 'extract',
      category: 'extract',
      execute: async () => {
        attempts += 1
        if (attempts < 2) throw new Error('第一次失败')
        return { result: '第二次成功' }
      },
    })
    const outcome = await runStageOnce(stage({ atom: 'extract' }), {}, { ...emptyOptions, handlers, atoms })
    expect(outcome.output).toBe('第二次成功')
    expect(outcome.retries).toBe(1)
  })

  it('retries exhausted marks the degraded prefix', async () => {
    const { handlers, atoms } = makeRegistry({
      name: 'extract',
      category: 'extract',
      execute: async () => { throw new Error('始终失败') },
    })
    const outcome = await runStageOnce(stage({ atom: 'extract' }), {}, { ...emptyOptions, handlers, atoms })
    expect(outcome.output.startsWith('[WORKFLOW_DEGRADED] s1:')).toBe(true)
    expect(outcome.output).toMatch(/始终失败/)
  })

  it('setup_required configuration errors propagate (fail loud, not retried or degraded)', async () => {
    const { handlers, atoms } = makeRegistry({
      name: 'extract',
      category: 'extract',
      execute: async () => {
        throw Object.assign(new Error('未配置 LLM provider/model'), { code: 'setup_required' })
      },
    })
    await expect(
      runStageOnce(stage({ atom: 'extract' }), {}, { ...emptyOptions, handlers, atoms }),
    ).rejects.toThrow(/未配置 LLM/)
  })

  it('an approved gate injects the grant marker and placeholds APPROVED output', async () => {
    const { handlers, atoms } = makeRegistry({
      name: 'approval-gate',
      category: 'gate',
      execute: async (input) => {
        expect(input.state[APPROVAL_GRANTED_KEY]).toBe(true)
        return {}
      },
    })
    const outcome = await runStageOnce(
      stage({ atom: 'approval-gate' }),
      {},
      { ...emptyOptions, handlers, atoms, approvalGrants: ['s1'] },
    )
    expect(outcome.output).toBe('APPROVED')
  })

  it('a handler that grants the gate itself yields APPROVED without leaking the marker', async () => {
    const { handlers, atoms } = makeRegistry({
      name: 'approval-gate',
      category: 'gate',
      execute: async () => ({ [APPROVAL_GRANTED_KEY]: true }),
    })
    const state: Record<string, unknown> = {}
    const outcome = await runStageOnce(
      stage({ atom: 'approval-gate' }),
      state,
      { ...emptyOptions, handlers, atoms },
    )
    expect(outcome.output).toBe('APPROVED')
    expect(state['s1']).toBe('APPROVED')
    expect(state[APPROVAL_GRANTED_KEY]).toBeUndefined()
  })

  it('InterruptStageError propagates as interrupted (not degraded)', async () => {
    const { handlers, atoms } = makeRegistry({
      name: 'approval-gate',
      category: 'gate',
      execute: async () => { throw new InterruptStageError('s1', '等待人工确认', { stageId: 's1' }) },
    })
    const outcome = await runStageOnce(stage({ atom: 'approval-gate' }), {}, { ...emptyOptions, handlers, atoms })
    expect(outcome.interrupted).toBeDefined()
    expect(outcome.interrupted!.stageId).toBe('s1')
    expect(outcome.output).toBe('')
  })

  it('a granted gate never leaks the grant marker: a later ungranted gate still interrupts', async () => {
    const { handlers, atoms } = makeRegistry({
      name: 'approval-gate',
      category: 'gate',
      execute: async (input) => {
        if (input.state[APPROVAL_GRANTED_KEY]) return {}
        throw new InterruptStageError(typeof input.state.stageId === 'string' ? input.state.stageId : 'unknown', '等待人工确认', {})
      },
    })
    const state: Record<string, unknown> = {}
    // First gate is granted and has NO params — the grant marker must stay on a
    // per-handler copy and not pollute the shared state.
    const granted = await runStageOnce(
      stage({ id: 's1', atom: 'approval-gate' }),
      state,
      { ...emptyOptions, handlers, atoms, approvalGrants: ['s1'] },
    )
    expect(granted.output).toBe('APPROVED')
    expect(state[APPROVAL_GRANTED_KEY]).toBeUndefined()
    // Second gate is NOT granted: without the leak it must interrupt.
    const blocked = await runStageOnce(
      stage({ id: 's2', atom: 'approval-gate' }),
      state,
      { ...emptyOptions, handlers, atoms },
    )
    expect(blocked.interrupted).toBeDefined()
    expect(blocked.interrupted!.stageId).toBe('s2')
  })

  it('passes the provider and the caller signal through to the handler', async () => {
    const seen: Array<{ provider: unknown; signal: unknown }> = []
    const { handlers, atoms } = makeRegistry({
      name: 'extract',
      category: 'extract',
      execute: async (input) => {
        seen.push({ provider: input.provider, signal: input.signal })
        return { result: '透传完成' }
      },
    })
    const provider = { callLLM: async (): Promise<string> => '' }
    const signal = new AbortController().signal
    const outcome = await runStageOnce(stage({ atom: 'extract' }), {}, {
      ...emptyOptions,
      handlers,
      atoms,
      provider,
      signal,
    })
    expect(outcome.output).toBe('透传完成')
    expect(seen).toEqual([{ provider, signal }])
  })

  it('a vanished atom between lookup and output-key derivation falls back silently', async () => {
    const { handlers, atoms } = makeRegistry({
      name: 'extract',
      category: 'extract',
      execute: async () => ({ result: 'x' }),
    })
    const stageObj = stage({ atom: 'extract' })
    let reads = 0
    // 前两次读取（line 54 的条件与 lookup 参数）得到 atom；第三次起（line 80 主输出键）
    // 返回 undefined：mainKey 走 else 分支，输出为空且不降级。
    Object.defineProperty(stageObj, 'atom', {
      get() {
        reads += 1
        return reads <= 2 ? 'extract' : undefined
      },
      configurable: true,
    })
    const outcome = await runStageOnce(stageObj, {}, { ...emptyOptions, handlers, atoms })
    expect(outcome.output).toBe('')
  })

  it('a non-string raw output is JSON-serialized as the main output', async () => {
    const { handlers, atoms } = makeRegistry({
      name: 'extract',
      category: 'extract',
      execute: async () => ({ result: { nested: { key: 'v' } } }),
    })
    const outcome = await runStageOnce(stage({ atom: 'extract' }), {}, { ...emptyOptions, handlers, atoms })
    expect(outcome.output).toContain('"nested"')
    expect(outcome.output).toContain('"key"')
  })

  it('an object fallback on the stage key is JSON-serialized', async () => {
    const { handlers, atoms } = makeRegistry({
      name: 'extract',
      category: 'extract',
      execute: async () => ({ other: 1 }),
    })
    const state: Record<string, unknown> = { s1: { legacy: 'structure' } }
    const outcome = await runStageOnce(stage({ atom: 'extract' }), state, { ...emptyOptions, handlers, atoms })
    expect(outcome.output).toContain('"legacy"')
  })

  it('no handler and no executor produce an empty output without a degradation reason', async () => {
    const outcome = await runStageOnce(stage(), {}, emptyOptions)
    expect(outcome.output).toBe('')
    expect(outcome.retries).toBe(3)
    expect(outcome.interrupted).toBeUndefined()
  })

  it('a string error from the executor is preserved in the degraded prefix', async () => {
    const outcome = await runStageOnce(
      stage(),
      {},
      { ...emptyOptions, executor: async () => { throw '纯文本错误' } },
    )
    expect(outcome.output).toBe('[WORKFLOW_DEGRADED] s1: 纯文本错误')
  })

  it('an object error from the executor is JSON-serialized into the degraded prefix', async () => {
    const outcome = await runStageOnce(
      stage(),
      {},
      { ...emptyOptions, executor: async () => { throw { code: 7, detail: '对象错误' } } },
    )
    expect(outcome.output).toContain('[WORKFLOW_DEGRADED] s1:')
    expect(outcome.output).toContain('"code":7')
    expect(outcome.output).toContain('"detail":"对象错误"')
  })
})
