import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import type { CachedPromptSection, PromptCache, PromptCacheKey } from '@deepseek-ai/dsh-system-prompt/prompt-cache'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'

/** In-memory PromptCache stub: records calls and serves exact-key entries. */
class StubCache implements PromptCache {
  entries = new Map<string, CachedPromptSection[]>()
  getCalls = 0
  setCalls = 0
  invalidateCalls: Array<ScopeKey | undefined> = []

  async get(key: PromptCacheKey): Promise<CachedPromptSection[] | undefined> {
    this.getCalls += 1
    return this.entries.get(this.keyOf(key))
  }

  async set(key: PromptCacheKey, sections: readonly CachedPromptSection[]): Promise<void> {
    this.setCalls += 1
    this.entries.set(this.keyOf(key), [...sections])
  }

  async invalidate(scope: ScopeKey | undefined): Promise<void> {
    this.invalidateCalls.push(scope)
    const prefix = scope === undefined ? 'scope=global' : 'scope=scoped'
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) this.entries.delete(key)
    }
  }

  private keyOf(key: PromptCacheKey): string {
    const scope = key.scope === undefined ? 'scope=global' : 'scope=scoped'
    return `${scope}|sig=${key.signature}|cfg=${key.configFingerprint}`
  }
}

describe('SystemPrompt stable-prefix cache', () => {
  it('evaluates a stable static prefix once across two assembles', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: 'You are p.' })
    const cache = new StubCache()
    ctx.provide('promptCache', cache)

    const a1 = await ctx.systemPrompt.assemble()
    const a2 = await ctx.systemPrompt.assemble()

    expect(renderPrompt(a1)).toBe(renderPrompt(a2))
    // identity + persona are stable strings: first assemble evaluates and
    // writes, the second reads the cache.
    expect(cache.setCalls).toBe(1)
    expect(cache.getCalls).toBe(2)
  })

  it('skips a function provider declared stable after the first assembly', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: 'You are p.' })
    const cache = new StubCache()
    ctx.provide('promptCache', cache)

    let calls = 0
    ctx.systemPrompt.section({
      name: 'stable-fn',
      order: 10,
      stable: true,
      text: () => `resolved ${++calls}`,
    })

    await ctx.systemPrompt.assemble()
    const second = await ctx.systemPrompt.assemble()

    expect(calls).toBe(1)
    expect(renderPrompt(second)).toContain('resolved 1')
  })

  it('re-evaluates a function provider that does not declare stable', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: 'You are p.' })
    const cache = new StubCache()
    ctx.provide('promptCache', cache)

    let calls = 0
    ctx.systemPrompt.section({
      name: 'live-fn',
      order: 10,
      text: () => `live ${++calls}`,
    })

    const first = await ctx.systemPrompt.assemble()
    const second = await ctx.systemPrompt.assemble()

    expect(calls).toBe(2)
    expect(renderPrompt(first)).toContain('live 1')
    expect(renderPrompt(second)).toContain('live 2')
  })

  it('serves the cached prefix across variable value changes', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: 'You are p.' })
    const cache = new StubCache()
    ctx.provide('promptCache', cache)

    let ticks = 0
    ctx.systemPrompt.variable('ts', () => String(++ticks))
    ctx.systemPrompt.section({ name: 'stamped', order: 10, text: 'now {{ts}}' })

    const first = await ctx.systemPrompt.assemble()
    const second = await ctx.systemPrompt.assemble()

    expect(renderPrompt(first)).toContain('now 1')
    expect(renderPrompt(second)).toContain('now 2')
    // The cached text is uninterpolated, so the changed value must not
    // invalidate the prefix; the second assembly hit the cache and
    // interpolation applied the new value at render time.
    expect(cache.setCalls).toBe(1)
    expect(cache.getCalls).toBe(2)
  })

  it('invalidating the scope forces re-evaluation', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: 'You are p.' })
    const cache = new StubCache()
    ctx.provide('promptCache', cache)

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

    await cache.invalidate(undefined)
    await ctx.systemPrompt.assemble()

    expect(calls).toBe(2)
  })

  it('restores a cached complete section as the sole prompt section', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: 'You are p.' })
    const cache = new StubCache()
    ctx.provide('promptCache', cache)

    ctx.systemPrompt.section({
      name: 'complete-stable',
      order: 10,
      stable: true,
      complete: true,
      text: 'The complete prompt.',
    })

    const first = await ctx.systemPrompt.assemble()
    const second = await ctx.systemPrompt.assemble()

    expect(renderPrompt(first)).toBe('The complete prompt.')
    expect(renderPrompt(second)).toBe('The complete prompt.')
    // The second assembly spliced the cached sections, then restored the
    // cached complete section.
    expect(cache.getCalls).toBe(2)
  })

  it('keeps registered variable values out of the signature', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: 'You are p.' })
    const cache = new StubCache()
    ctx.provide('promptCache', cache)

    let ticks = 0
    ctx.systemPrompt.variable('optional', () => undefined)
    ctx.systemPrompt.variable('volatile', () => String(++ticks))

    const first = await ctx.systemPrompt.assemble()
    const second = await ctx.systemPrompt.assemble()

    expect(renderPrompt(first)).toBe(renderPrompt(second))
    // No section references either variable; their changing values never
    // enter the signature, so the second assembly hit the cache.
    expect(cache.setCalls).toBe(1)
    expect(cache.getCalls).toBe(2)
  })

  it('degrades to the normal assembly path when the cache read throws', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: 'You are p.' })
    const failing = new StubCache()
    failing.get = async () => { throw new Error('cache down') }
    ctx.provide('promptCache', failing)

    let calls = 0
    ctx.systemPrompt.section({
      name: 'stable-fn',
      order: 10,
      stable: true,
      text: () => `resolved ${++calls}`,
    })

    const first = await ctx.systemPrompt.assemble()
    const second = await ctx.systemPrompt.assemble()

    expect(renderPrompt(first)).toContain('resolved 1')
    expect(renderPrompt(second)).toContain('resolved 2')
    // Every read failed, so the provider evaluated per assembly.
    expect(calls).toBe(2)
  })

  it('degrades to the normal assembly path when the cache write throws', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: 'You are p.' })
    const failing = new StubCache()
    failing.set = async () => { throw new Error('cache full') }
    ctx.provide('promptCache', failing)

    let calls = 0
    ctx.systemPrompt.section({
      name: 'stable-fn',
      order: 10,
      stable: true,
      text: () => `resolved ${++calls}`,
    })

    const first = await ctx.systemPrompt.assemble()
    const second = await ctx.systemPrompt.assemble()

    expect(renderPrompt(first)).toContain('resolved 1')
    expect(renderPrompt(second)).toContain('resolved 2')
    // The write never landed, so each assembly evaluated and wrote again.
    expect(calls).toBe(2)
  })

  it('caches only the contiguous stable prefix, excluding later unstable sections', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: 'You are p.' })
    const cache = new StubCache()
    ctx.provide('promptCache', cache)

    let calls = 0
    ctx.systemPrompt.section({ name: 'live-fn', order: 10, text: () => `live ${++calls}` })

    await ctx.systemPrompt.assemble()
    await ctx.systemPrompt.assemble()

    // The stable prefix stops at the first unstable section; live-fn is
    // evaluated per assembly and never enters the cache.
    const lastSet = [...cache.entries.values()].at(-1)!
    expect(lastSet.map(s => s.name)).toEqual(['harness:identity', 'deployment:persona-prefix'])
    expect(calls).toBe(2)
  })

  it('behaves unchanged when no cache strategy is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: 'You are p.' })

    let calls = 0
    ctx.systemPrompt.section({ name: 'live-fn', order: 10, text: () => `live ${++calls}` })

    const first = await ctx.systemPrompt.assemble()
    const second = await ctx.systemPrompt.assemble()

    expect(calls).toBe(2)
    expect(renderPrompt(first)).toContain('live 1')
    expect(renderPrompt(second)).toContain('live 2')
  })
})
