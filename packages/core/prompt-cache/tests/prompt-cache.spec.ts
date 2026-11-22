import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import PromptCache, { DEFAULT_PROMPT_CACHE_TTL_MS } from '@deepseek-ai/dsh-prompt-cache'
import type { CachedPromptSection, PromptCacheKey } from '@deepseek-ai/dsh-system-prompt/prompt-cache'

const agentScope = {}

afterEach(() => {
  vi.useRealTimers()
})

const key = (over: Partial<PromptCacheKey> = {}): PromptCacheKey => ({
  scope: undefined,
  signature: 'sig',
  configFingerprint: 'cfg',
  ...over,
})

describe('PromptCache service', () => {
  it('mounts at ctx.promptCache and serves set/get by exact key', async () => {
    const ctx = new Context()
    await ctx.plugin(PromptCache, { ttlMs: DEFAULT_PROMPT_CACHE_TTL_MS })

    const sections: CachedPromptSection[] = [{ name: 'harness:identity', text: 'You are an AI agent.' }]
    const k = key()
    expect(await ctx.promptCache.get(k)).toBeUndefined()
    await ctx.promptCache.set(k, sections)
    expect(await ctx.promptCache.get(k)).toEqual(sections)
  })

  it('distinguishes keys by scope, signature, and config fingerprint', async () => {
    const ctx = new Context()
    await ctx.plugin(PromptCache, { ttlMs: 10000 })

    const k = key()
    await ctx.promptCache.set(k, [{ name: 'a', text: 'A' }])
    expect(await ctx.promptCache.get(key({ signature: 'other' }))).toBeUndefined()
    expect(await ctx.promptCache.get(key({ configFingerprint: 'other' }))).toBeUndefined()
    expect(await ctx.promptCache.get(key({ scope: agentScope }))).toBeUndefined()
  })

  it('overwrites an existing entry for the same key', async () => {
    const ctx = new Context()
    await ctx.plugin(PromptCache, { ttlMs: 10000 })

    const k = key()
    await ctx.promptCache.set(k, [{ name: 'a', text: 'A' }])
    await ctx.promptCache.set(k, [{ name: 'a', text: 'B' }])
    expect(await ctx.promptCache.get(k)).toEqual([{ name: 'a', text: 'B' }])
  })

  it('expires entries after the TTL', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    await ctx.plugin(PromptCache, { ttlMs: 1000 })

    const k = key()
    await ctx.promptCache.set(k, [{ name: 'a', text: 'A' }])
    expect(await ctx.promptCache.get(k)).toBeDefined()

    vi.advanceTimersByTime(1001)
    expect(await ctx.promptCache.get(k)).toBeUndefined()
  })

  it('invalidate drops the scope bucket', async () => {
    const ctx = new Context()
    await ctx.plugin(PromptCache, { ttlMs: 10000 })

    const k = key({ scope: agentScope })
    await ctx.promptCache.set(k, [{ name: 'a', text: 'A' }])
    await ctx.promptCache.invalidate(agentScope)
    expect(await ctx.promptCache.get(k)).toBeUndefined()
  })

  it('clears every scope on a system-prompt change', async () => {
    const ctx = new Context()
    await ctx.plugin(PromptCache, { ttlMs: 10000 })
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: 'You are p.' })

    const k = key()
    await ctx.promptCache.set(k, [{ name: 'a', text: 'A' }])
    ctx.systemPrompt.section({ name: 'new-section', order: 5, text: 'fresh' })
    expect(await ctx.promptCache.get(k)).toBeUndefined()
  })
})

describe('PromptCache with SystemPrompt assembly', () => {
  it('serves the stable prefix across assembles without re-evaluating providers', async () => {
    const ctx = new Context()
    await ctx.plugin(PromptCache, { ttlMs: 10000 })
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: 'You are p.' })

    let calls = 0
    ctx.systemPrompt.section({
      name: 'stable-fn',
      order: 10,
      stable: true,
      text: () => `resolved ${++calls}`,
    })

    const first = await ctx.systemPrompt.assemble()
    const second = await ctx.systemPrompt.assemble()

    expect(calls).toBe(1)
    expect(renderPrompt(first)).toBe(renderPrompt(second))
    expect(renderPrompt(second)).toContain('resolved 1')
  })

  it('re-evaluates after an explicit invalidation', async () => {
    const ctx = new Context()
    await ctx.plugin(PromptCache, { ttlMs: 10000 })
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: 'You are p.' })

    let calls = 0
    ctx.systemPrompt.section({
      name: 'stable-fn',
      order: 10,
      stable: true,
      text: () => `resolved ${++calls}`,
    })

    await ctx.systemPrompt.assemble()
    await ctx.systemPrompt.assemble()
    expect(calls).toBe(1)

    await ctx.promptCache.invalidate(undefined)
    await ctx.systemPrompt.assemble()

    expect(calls).toBe(2)
  })
})
