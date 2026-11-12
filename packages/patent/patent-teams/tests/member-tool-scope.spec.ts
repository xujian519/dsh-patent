// Two-layer scope regression: a preset registers the shared member tools, and
// both the captain and each member are children of that preset generation.
// The member allow list must be resolved against the captain's context, because
// `restrictableNames()` on the plugin registration context excludes exactly the
// preset-owned layer the child inherits. Resolving it there produces an allow
// list with every preset tool missing, which `tools.restrict()` then enforces.
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import { MEMBER_DENIED_TOOLS, memberToolAllowList, spawnMember } from '../src/members.ts'
import type { TeamMember, TeamState } from '../src/types.ts'

/** Mount the real registry so `restrict()` validates against real layers. */
async function mount(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(ToolRuntime)
  return ctx
}

/**
 * Mint one scope under `ctx`. The minting plugin injects the services a scope
 * holder reaches, mirroring the agent loop's inject list in production.
 * @param ctx - the context that backs the scope fiber.
 * @param id - scope identity, doubled as a minimal agent key.
 * @param parent - enclosing scope key, when this scope is a child.
 * @returns the scoped context and its key.
 */
async function mintScope(ctx: Context, id: string, parent?: object): Promise<{ ctx: Context; key: object }> {
  const key = { id: SessionId(id) } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => {
    scope = createScope(inner, key, parent === undefined ? undefined : { parent })
  }, { inject: ['tools', 'systemPrompt'] }))
  return { ctx: scope.ctx, key }
}

/** A registered stand-in; the tests never execute it. */
function standIn(name: string) {
  return defineTool({
    name,
    description: `test stand-in for ${name}`,
    parameters: {},
    output: { schema: { type: 'json' }, render: () => [] },
    async execute() { return null },
  })
}

const team: TeamState = {
  name: 'Alpha',
  id: 'team1',
  captainSessionId: 'captain-1',
  createdAt: 1,
  members: [],
  tasks: [],
  taskSeq: 0,
}

const memberDraft: TeamMember = {
  id: '',
  name: 'alice',
  role: 'researcher',
  provider: 'spawn',
  model: 'deepseek-v4',
  joinedAt: 1,
  status: 'idle',
}

/** Boot a registry, a preset layer, and the captain and member scopes under it. */
async function bootLayers(cnlaw = true): Promise<{
  root: Context
  preset: { ctx: Context; key: object }
  captain: { ctx: Context; key: object }
  member: { ctx: Context; key: object }
  activations: { toolFilter: { allow?: string[]; deny: string[] } }[]
}> {
  const root = await mount()
  if (cnlaw) root.tools.register(standIn('mcp__cnlaw__search'))
  root.tools.register(standIn('send_message'))

  const preset = await mintScope(root, 'preset-generation')
  for (const name of [
    'read',
    'bash',
    ...MEMBER_DENIED_TOOLS,
    'patent_teams_claim_task',
    'patent_teams_update_task',
    'patent_teams_send_message',
    'patent_teams_status',
    'patent_search',
  ]) {
    preset.ctx.tools.register(standIn(name))
  }

  const activations: { toolFilter: { allow?: string[]; deny: string[] } }[] = []
  root.provide('subagents', {
    getProvider: () => ({
      name: 'spawn',
      capabilities: { persona: true, toolFilter: true },
      prepareContinuable: () => undefined,
    }),
    list: () => ['spawn'],
    startActivation: async (spec: { toolFilter: { allow?: string[]; deny: string[] } }) => {
      activations.push(spec)
      return { childId: SessionId('child-1'), messageId: 'msg-1' }
    },
  } as never)

  const captain = await mintScope(root, 'captain', preset.key)
  const member = await mintScope(root, 'member', preset.key)
  return { root, preset, captain, member, activations }
}

describe('member tool allow list across preset, captain, and member scopes', () => {
  it('keeps the preset-owned tools and the coordination channel on a member', async () => {
    const { preset, captain, member, activations } = await bootLayers()
    const captainAgent = { id: SessionId('captain-1'), ctx: captain.ctx } as Agent

    // The plugin registration context is the preset scope, exactly as in
    // `addMember`, which passes `host.ctx`. The captain is its child.
    await spawnMember(
      preset.ctx,
      { provider: 'spawn' },
      { provider: 'p', model: 'm' },
      captainAgent,
      team,
      { ...memberDraft },
      'state',
      new AbortController().signal,
    )

    const allow = activations[0]?.toolFilter.allow
    expect(allow).toBeDefined()
    for (const name of [
      'read',
      'bash',
      'patent_teams_claim_task',
      'patent_teams_update_task',
      'patent_teams_send_message',
      'patent_teams_status',
      'mcp__cnlaw__search',
      'patent_search',
    ]) {
      expect(allow).toContain(name)
    }
    expect(allow).not.toContain('patent_teams_create')
    // `researcher` declares `patent_eval`, but this composition does not register it.
    expect(allow).not.toContain('patent_eval')

    member.ctx.tools.restrict({ allow: allow!, deny: [...MEMBER_DENIED_TOOLS] })
    const names = new Set(member.ctx.tools.schemas(member.key).map(schema => schema.name))
    expect(names).toContain('read')
    expect(names).toContain('patent_teams_claim_task')
    expect(names).not.toContain('patent_teams_create')
    expect(names).not.toContain('send_message')
  })

  it('fails loud when the allow list names a tool the member scope does not inherit', async () => {
    const { root, captain } = await bootLayers()
    const allow = memberToolAllowList(captain.ctx, 'researcher')
    const orphan = await mintScope(root, 'orphan')

    expect(() => orphan.ctx.tools.restrict({ allow: allow!, deny: [...MEMBER_DENIED_TOOLS] }))
      .toThrow(/unknown global tool/)
  })

  it('keeps the deny-only surface when the composition carries no cnlaw tools', async () => {
    const { captain } = await bootLayers(false)
    expect(memberToolAllowList(captain.ctx, 'researcher')).toBeUndefined()
  })

  it('drops the preset layer when the plugin registration context is queried instead', async () => {
    const { preset } = await bootLayers()
    const allow = memberToolAllowList(preset.ctx, 'researcher')

    expect(allow).toContain('mcp__cnlaw__search')
    // The failure this guards against: the preset's `read` is invisible from the
    // registration context, so a list built there would strip it from the child.
    expect(allow).not.toContain('read')
  })
})
