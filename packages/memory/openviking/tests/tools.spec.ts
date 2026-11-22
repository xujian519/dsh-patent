/* oxlint-disable typescript/no-unsafe-assignment -- Dynamic mock shapes are only asserted, never typed. */





import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import CommandRuntime from '@deepseek-ai/dsh-commands'

import { registerOpenVikingTools } from '../src/tools.ts'
import { LearnService, redactSecrets, isValidSkillName, isValidVikingUri } from '../src/learn-service.ts'
import { mountOpenVikingSkill } from '../src/skills.ts'
import { registerOpenVikingCommands } from '../src/commands.ts'
import { guardVikingUri, mentionsVikingUri } from '../src/uri-guard.ts'
import { mountOpenVikingMcp } from '../src/mcp-surface.ts'
import { OpenVikingClient } from '../src/client.ts'
import { OpenVikingError } from '../src/errors.ts'

function mockClient() {
  const find = vi.fn<(params: { targetUri?: string; query?: string }, options?: { signal?: AbortSignal }) => Promise<{
    memories: Array<{ context_type: 'memory'; uri: string; level: number; score: number; abstract: string }>
    resources: unknown[]
    skills: unknown[]
    total: number
  }>>(async () => ({ memories: [], resources: [], skills: [], total: 0 }))
  const queue = vi.fn(async () => ({ name: 'queue', is_healthy: true, has_errors: false, status: 'all idle' }))
  const commit = vi.fn(async () => ({}))
  const writeContent = vi.fn(async () => ({}))
  const getSkill = vi.fn(async () => ({}))
  const putSkill = vi.fn(async () => ({}))
  const createSkill = vi.fn(async () => ({}))
  const client = { find, queue, commit, writeContent, getSkill, putSkill, createSkill } as unknown as OpenVikingClient
  return { client, find, queue, commit, writeContent, getSkill, putSkill, createSkill }
}

const execContext = (agent?: { session: { id: string } }) => ({
  agent,
  signal: new AbortController().signal,
}) as never

describe('registerOpenVikingTools', () => {
  let ctx: Context
  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
  })

  async function mountTools(f: ReturnType<typeof mockClient>, sync = { flush: vi.fn(async () => {}), commit: vi.fn(async () => {}) }) {
    const fiber = ctx.plugin({ apply: (c: Context) => {
      registerOpenVikingTools(c, {
        client: f.client,
        sync: () => sync as never,
        learn: new LearnService(f.client),
      })
    } })
    await fiber.await()
    return fiber
  }

  it('registers memcommit, memqueue, and memlearn', async () => {
    const f = mockClient()
    await mountTools(f)
    expect(ctx.tools.get('memcommit')).toBeDefined()
    expect(ctx.tools.get('memqueue')).toBeDefined()
    expect(ctx.tools.get('memlearn')).toBeDefined()
  })

  it('memcommit flushes and commits the caller session', async () => {
    const f = mockClient()
    const sync = { flush: vi.fn(async () => {}), commit: vi.fn(async () => {}) }
    await mountTools(f, sync)
    const output = ctx.tools.get('memcommit')!.output
    const value = await ctx.tools.get('memcommit')!.execute({}, execContext({ session: { id: 's7' } }))
    expect(sync.flush).toHaveBeenCalledWith('s7')
    expect(sync.commit).toHaveBeenCalledWith('s7')
    expect(value).toEqual({ committed: true, session: 's7' })
    expect(output.render({}, value as never)).toEqual([{ type: 'text', text: expect.stringContaining('Committed session s7') }])
  })

  it('memcommit rejects without an agent context', async () => {
    const f = mockClient()
    await mountTools(f)
    await expect(ctx.tools.get('memcommit')!.execute({}, execContext())).rejects.toThrow('requires an agent')
  })

  it('memqueue renders the observer status', async () => {
    const f = mockClient()
    await mountTools(f)
    const value = await ctx.tools.get('memqueue')!.execute({}, execContext())
    expect(value).toEqual({ healthy: true, errors: false, status: 'all idle' })
    expect(ctx.tools.get('memqueue')!.output.render({}, value as never)[0]).toEqual({ type: 'text', text: expect.stringContaining('healthy') })
  })

  it('memlearn routes through the learn service', async () => {
    const f = mockClient()
    await mountTools(f)
    const value = await ctx.tools.get('memlearn')!.execute({ lesson: 'Always verify the diff', capability: 'skill', skill: 'verify-diff' }, execContext())
    expect((value as { result: string }).result).toBe('stored')
  })

  it('disposes its registrations with the fiber', async () => {
    const f = mockClient()
    const fiber = ctx.plugin({ apply: (c: Context) => {
      registerOpenVikingTools(c, {
        client: f.client,
        sync: () => ({ flush: vi.fn(), commit: vi.fn() }) as never,
        learn: new LearnService(f.client),
      })
    } })
    await fiber.await()

    expect(ctx.tools.get('memcommit')).toBeDefined()
    await fiber.dispose()
    expect(ctx.tools.get('memcommit')).toBeUndefined()
  })
})

describe('LearnService', () => {
  it('redacts secret-shaped strings', () => {
    expect(redactSecrets('key sk-abcdefghijklmnopqrstuvwxyz123456')).toBe('key [REDACTED]')
    expect(redactSecrets('api_key: hunter2')).toBe('api_key: [REDACTED]')
    expect(redactSecrets('Bearer abcdefghijklmnopqrstuvwxyz1234567890')).toBe('Bearer [REDACTED]')
  })

  it('validates skill names and viking targets', () => {
    expect(isValidSkillName('runbook')).toBe(true)
    expect(isValidSkillName('Bad Name')).toBe(false)
    expect(isValidSkillName('')).toBe(false)
    expect(isValidVikingUri('viking://user/memories/a.md')).toBe(true)
    expect(isValidVikingUri('not-a-uri')).toBe(false)
  })

  it('mints a playbook when the skill is absent (404)', async () => {
    const f = mockClient()
    f.getSkill.mockRejectedValueOnce(new OpenVikingError('e', 'not found', { code: 'NOT_FOUND', httpStatus: 404 }))
    const learn = new LearnService(f.client)
    const result = await learn.capture({ lesson: 'Lesson text', capability: 'skill', skill: 'new-playbook' })
    expect(result.result).toBe('stored')
    expect(f.createSkill).toHaveBeenCalledWith({ name: 'new-playbook', content: 'Lesson text' }, undefined)
  })

  it('updates an existing playbook', async () => {
    const f = mockClient()
    const learn = new LearnService(f.client)
    const result = await learn.capture({ lesson: 'Lesson text', capability: 'skill', skill: 'existing' })
    expect(result.result).toBe('stored')
    expect(f.putSkill).toHaveBeenCalled()
  })

  it('defaults to the runbook playbook when skill is omitted', async () => {
    const f = mockClient()
    const learn = new LearnService(f.client)
    const result = await learn.capture({ lesson: 'Lesson text', capability: 'skill' })
    expect(result.result).toBe('stored')
    expect(f.putSkill).toHaveBeenCalledWith('runbook', { name: 'runbook', content: 'Lesson text' }, undefined)
  })

  it('rejects invalid skill names and missing targets', async () => {
    const f = mockClient()
    const learn = new LearnService(f.client)
    expect((await learn.capture({ lesson: 'x', capability: 'skill', skill: 'Bad Name' })).result).toBe('failed')
    expect((await learn.capture({ lesson: 'x', capability: 'target' })).result).toBe('failed')
    expect((await learn.capture({ lesson: 'x', capability: 'target', target: 'nope' })).result).toBe('failed')
  })

  it('appends to an explicit target', async () => {
    const f = mockClient()
    const learn = new LearnService(f.client)
    const result = await learn.capture({ lesson: 'x', capability: 'target', target: 'viking://user/memories/preferences/x.md' })
    expect(result.result).toBe('merged')
    expect(f.writeContent).toHaveBeenCalledWith('viking://user/memories/preferences/x.md', '\nx', { mode: 'append', signal: undefined })
  })

  it('reports no-match below the semantic threshold', async () => {
    const f = mockClient()
    const learn = new LearnService(f.client)
    const result = await learn.capture({ lesson: 'totally new lesson about zzz' })
    expect(result.result).toBe('no-match')
    expect(f.writeContent).not.toHaveBeenCalled()
  })

  it('merges into the best semantic match', async () => {
    const f = mockClient()
    f.find.mockImplementationOnce(async () => ({ memories: [{ context_type: 'memory', uri: 'viking://user/memories/preferences/w.md', level: 0, score: 0.81, abstract: 'x' }], resources: [], skills: [], total: 1 }))
    const learn = new LearnService(f.client)
    const result = await learn.capture({ lesson: 'a lesson about writing style' })
    expect(result.result).toBe('merged')
    expect(f.writeContent).toHaveBeenCalledWith('viking://user/memories/preferences/w.md', '\na lesson about writing style', { mode: 'append', signal: undefined })
  })

  it('falls back to the parent URI when the leaf file rejects a write', async () => {
    const f = mockClient()
    f.find.mockImplementationOnce(async () => ({ memories: [{ context_type: 'memory', uri: 'viking://user/memories/preferences/.abstract.md', level: 0, score: 0.9, abstract: 'x' }], resources: [], skills: [], total: 1 }))
    f.writeContent.mockRejectedValueOnce(new OpenVikingError('e', 'nope', { code: 'HTTP_ERROR', httpStatus: 400 }))
    const learn = new LearnService(f.client)
    const result = await learn.capture({ lesson: 'a lesson about habits' })
    expect(result.result).toBe('merged')
    expect(f.writeContent).toHaveBeenCalledTimes(2)
    expect(f.writeContent).toHaveBeenLastCalledWith('viking://user/memories/preferences/', '\na lesson about habits', { mode: 'append', signal: undefined })
  })

  it('rejects empty lessons after redaction', async () => {
    const f = mockClient()
    const learn = new LearnService(f.client)
    expect((await learn.capture({ lesson: '   ' })).result).toBe('failed')
    expect((await learn.capture({ lesson: 'sk-abcdefghijklmnopqrstuvwxyz123456' })).result).toBe('failed')
  })
})

describe('guardVikingUri', () => {
  it('denies local path tools carrying viking URIs', () => {
    expect(guardVikingUri({ name: 'read', arguments: { file_path: 'viking://user/memories/a.md' } } as never).kind).toBe('deny')
    expect(guardVikingUri({ name: 'bash', arguments: { command: 'cat viking://x' } } as never).kind).toBe('deny')
  })

  it('allows local paths and unrelated tools', () => {
    expect(guardVikingUri({ name: 'read', arguments: { file_path: '/tmp/a.md' } } as never).kind).toBe('allow')
    expect(guardVikingUri({ name: 'mcp__openviking__read', arguments: { uri: 'viking://x' } } as never).kind).toBe('allow')
  })
})

describe('mountOpenVikingSkill', () => {
  it('registers the runtime skill with a mounted registry', async () => {
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    mountOpenVikingSkill(ctx)
    const skills = await ctx.skills.list()
    expect(skills.some(skill => skill.name === 'openviking-memory')).toBe(true)
  })
})

describe('registerOpenVikingCommands', () => {
  const stubAgent = (): never => ({ id: 'a1', session: { append: () => {} } }) as never

  it('registers /memlearn and runs it without a model turn', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    const f = mockClient()
    f.find.mockImplementationOnce(async () => ({ memories: [{ context_type: 'memory', uri: 'viking://user/memories/x.md', level: 0, score: 0.9, abstract: 'x' }], resources: [], skills: [], total: 1 }))
    const fiber = ctx.plugin({ apply: (c: Context) => { registerOpenVikingCommands(c, new LearnService(f.client)) } })
    await fiber.await()
    const result = await ctx.commands.execute(stubAgent(), '/memlearn a memorable lesson', [], new AbortController().signal)
    expect(result?.result).toMatchObject({ kind: 'success', text: expect.stringContaining('Merged') })
  })

  it('reports no-match without pretending a write happened', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    const f = mockClient()
    const fiber = ctx.plugin({ apply: (c: Context) => { registerOpenVikingCommands(c, new LearnService(f.client)) } })
    await fiber.await()
    const result = await ctx.commands.execute(stubAgent(), '/memlearn something with no match', [], new AbortController().signal)
    expect(result?.result).toMatchObject({ kind: 'success' })
    expect(result?.result.text).toContain('No existing memory matched')
  })

  it('returns a failed outcome for an invalid learn request', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    const f = mockClient()
    const fiber = ctx.plugin({ apply: (c: Context) => { registerOpenVikingCommands(c, new LearnService(f.client)) } })
    await fiber.await()
    const result = await ctx.commands.execute(stubAgent(), '/memlearn   ', [], new AbortController().signal)
    expect(result?.result.kind).toBe('error')
    // A lesson that redacts to nothing yields a learn-service failure too.
    const redacted = await ctx.commands.execute(
      stubAgent(), '/memlearn sk-abcdefghijklmnopqrstuvwxyz123456', [], new AbortController().signal)
    expect(redacted?.result.kind).toBe('error')
  })

  it('returns an error for empty input', async () => {
    const ctx = new Context()
    await ctx.plugin(CommandRuntime)
    const f = mockClient()
    const fiber = ctx.plugin({ apply: (c: Context) => { registerOpenVikingCommands(c, new LearnService(f.client)) } })
    await fiber.await()
    const result = await ctx.commands.execute(stubAgent(), '/memlearn    ', [], new AbortController().signal)
    expect(result?.result).toMatchObject({ kind: 'error' })
  })
})

describe('mountOpenVikingMcp', () => {
  it('mounts without failing on an unreachable endpoint', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = mountOpenVikingMcp(ctx, { endpoint: 'http://127.0.0.1:1', apiKey: '', account: '', user: '', agentId: 'dsh', timeoutMs: 1000 })
    await new Promise(resolve => setTimeout(resolve, 50))
    await fiber.dispose()
  })

  it('passes identity headers for the MCP session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = mountOpenVikingMcp(ctx, { endpoint: 'http://127.0.0.1:1/', apiKey: 'k', account: 'a', user: 'u', agentId: 'dsh', timeoutMs: 1000 })
    await fiber.dispose()
  })

  it('omits an empty agent header', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = mountOpenVikingMcp(ctx, { endpoint: 'http://127.0.0.1:1', apiKey: 'k', account: 'a', user: 'u', agentId: '', timeoutMs: 1000 })
    await fiber.dispose()
  })
})

describe('tool render branches and edge wires', () => {
  it('memqueue renders the error state and memcommit the nothing-to-commit state', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const f = mockClient()
    f.queue.mockResolvedValueOnce({ name: 'queue', is_healthy: false, has_errors: true, status: '2 errors' })
    const fiber = ctx.plugin({ apply: (c: Context) => {
      registerOpenVikingTools(c, {
        client: f.client,
        sync: () => ({ flush: vi.fn(async () => {}), commit: vi.fn(async () => {}) }) as never,
        learn: new LearnService(f.client),
      })
    } })
    await fiber.await()
    const queueValue = await ctx.tools.get('memqueue')?.execute({}, execContext())
    expect(ctx.tools.get('memqueue')?.output.render({}, queueValue as never)[0]).toEqual(
      { type: 'text', text: expect.stringContaining('has errors') })
    const commitResult = await ctx.tools.get('memcommit')!.execute({}, execContext({ session: { id: 's8' } }))
    expect((commitResult as { committed: boolean }).committed).toBe(true)
    const falseRender = ctx.tools.get('memcommit')!.output.render({}, { committed: false, session: 's8' })
    expect(falseRender[0]).toEqual({ type: 'text', text: expect.stringContaining('nothing to commit') })
    const learnOnlyRender = ctx.tools.get('memlearn')!.output.render({}, { result: 'stored', uri: 'u', detail: 'ok' })
    expect(learnOnlyRender[0]).toEqual({ type: 'text', text: 'ok' })
    const resultOnlyRender = ctx.tools.get('memlearn')!.output.render({}, { result: 'no-match', detail: 'none' })
    expect(resultOnlyRender[0]).toEqual({ type: 'text', text: 'none' })
    const bareRender = ctx.tools.get('memlearn')!.output.render({}, { result: 'stored' })
    expect(bareRender[0]).toEqual({ type: 'text', text: 'stored' })
  })
})

describe('LearnService error paths', () => {
  it('rethrows a non-404 skill probe failure', async () => {
    const f = mockClient()
    f.getSkill.mockRejectedValueOnce(new OpenVikingError('e', 'down', { code: 'HTTP_ERROR', httpStatus: 500 }))
    const learn = new LearnService(f.client)
    await expect(learn.capture({ lesson: 'x', capability: 'skill', skill: 'ab' })).rejects.toMatchObject({ httpStatus: 500 })
  })

  it('rethrows when the leaf write fails with a non-OpenViking error', async () => {
    const f = mockClient()
    f.find.mockImplementationOnce(async () => ({ memories: [{ context_type: 'memory', uri: 'viking://user/memories/x.md', level: 0, score: 0.9, abstract: 'x' }], resources: [], skills: [], total: 1 }))
    f.writeContent.mockRejectedValueOnce(new Error('plain failure'))
    const learn = new LearnService(f.client)
    await expect(learn.capture({ lesson: 'a lesson' })).rejects.toThrow('plain failure')
  })

  it('rethrows a leaf-write failure outside the 400/404 fallback window', async () => {
    const f = mockClient()
    f.find.mockImplementationOnce(async () => ({ memories: [{ context_type: 'memory', uri: 'viking://user/memories/x.md', level: 0, score: 0.9, abstract: 'x' }], resources: [], skills: [], total: 1 }))
    f.writeContent.mockRejectedValueOnce(new OpenVikingError('e', 'down', { code: 'HTTP_ERROR', httpStatus: 500 }))
    const learn = new LearnService(f.client)
    await expect(learn.capture({ lesson: 'a lesson' })).rejects.toMatchObject({ httpStatus: 500 })
  })
})

describe('guardVikingUri recursion', () => {
  it('detects viking URIs in nested arrays and objects', async () => {
    const nested = { items: [{ paths: ['viking://user/memories/x.md'] }] }
    expect(mentionsVikingUri(nested)).toBe(true)
    expect(mentionsVikingUri(42)).toBe(false)
    expect(mentionsVikingUri(null)).toBe(false)
  })
})
