// Plugin entry: Config schema validation and apply() wiring (service mount,
// usage section, tool registration). Service internals are stubbed away.
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, Config, inject, name } from '../src/index.ts'
import { PatentTeamsService } from '../src/service.ts'
import { PATENT_TEAMS_TOOL_NAMES } from '../src/tools.ts'

describe('plugin identity', () => {
  it('declares the plugin name, injection list, and service class', () => {
    expect(name).toBe('patent-teams')
    expect(inject).toEqual(['tools', 'systemPrompt', 'subagents'])
    expect(PatentTeamsService).toBeTypeOf('function')
  })
})

describe('Config schema', () => {
  it('applies the documented defaults', () => {
    expect(Config({})).toEqual({
      stateDir: '.patent-teams',
      memberProvider: 'spawn',
      memberMaxDepth: 1,
      maxMembers: 8,
      promptSectionOrder: 117,
      qualityGate: false,
      passThreshold: 0.7,
      mailboxDeliveryLeaseMs: 60_000,
      approveCreation: false,
      approveClosure: false,
    })
  })

  it('normalizes explicit values and rejects out-of-range ones', () => {
    expect(Config({
      stateDir: 'state',
      memberProvider: 'fork',
      memberModel: 'model-x',
      memberMaxDepth: 0,
      maxMembers: 2,
      promptSectionOrder: 5,
      qualityGate: true,
      passThreshold: 0.9,
      approveCreation: true,
      approveClosure: true,
    })).toEqual({
      stateDir: 'state',
      memberProvider: 'fork',
      memberModel: 'model-x',
      memberMaxDepth: 0,
      maxMembers: 2,
      promptSectionOrder: 5,
      qualityGate: true,
      passThreshold: 0.9,
      mailboxDeliveryLeaseMs: 60_000,
      approveCreation: true,
      approveClosure: true,
    })
    expect(() => Config({ maxMembers: 0 })).toThrow()
    expect(() => Config({ memberMaxDepth: -1 })).toThrow()
    expect(() => Config({ mailboxDeliveryLeaseMs: 0 })).toThrow()
  })
})

describe('apply', () => {
  function harness(config: Partial<Config> = {}) {
    const ctx = new Context()
    const registered: Array<{ name: string }> = []
    const sections: Array<{ name: string; order: number; text: string }> = []
    ctx.provide('tools', {
      register: (definition: { name: string }) => {
        registered.push(definition)
        return () => {}
      },
    } as never)
    ctx.provide('systemPrompt', {
      section: (section: { name: string; order: number; text: string }) => {
        sections.push(section)
        return () => {}
      },
    } as never)
    ctx.provide('llm', { resolveCallConfig: async (c: unknown) => c } as never)
    ctx.provide('agents', { get: () => undefined } as never)
    ctx.provide('subagents', {
      listChildren: async () => [],
      listDescendants: async () => [],
      sendMessage: async () => 'msg',
    } as never)
    apply(ctx, Config(config))
    return { ctx, registered, sections }
  }

  it('mounts the service and registers the usage section and all tools', async () => {
    const { ctx, registered, sections } = harness({ promptSectionOrder: 42 })
    // The service fiber activates asynchronously (it joins the test-invariant
    // host readiness), so wait for the mount.
    await vi.waitFor(() => {
      expect(ctx.patentTeams).toBeInstanceOf(PatentTeamsService)
    })
    expect(sections).toHaveLength(1)
    expect(sections[0]!.name).toBe('patent-teams:usage')
    expect(sections[0]!.order).toBe(42)
    for (const toolName of PATENT_TEAMS_TOOL_NAMES) {
      expect(registered.some(tool => tool.name === toolName)).toBe(true)
      expect(sections[0]!.text).toContain(toolName)
    }
    expect(sections[0]!.text).toContain('you are the captain of a multi-agent team')
    expect(sections[0]!.text).toContain('patent_teams_reassign_task first')
    expect(sections[0]!.text).toContain('never sleep, poll, or loop on status')
  })

  it('uses the default prompt-section order when not configured', () => {
    const { sections } = harness()
    expect(sections[0]!.order).toBe(117)
  })

  it('honors the configured member cap and model default', async () => {
    const { ctx } = harness({ maxMembers: 1, memberModel: 'model-x' })
    await vi.waitFor(() => {
      expect(ctx.patentTeams).toBeDefined()
    })
    const serviceConfig = (ctx.patentTeams as unknown as {
      config: { maxMembers: number; memberModel?: string; stateDir: string; memberProvider: string; memberMaxDepth: number }
    }).config
    expect(serviceConfig.maxMembers).toBe(1)
    expect(serviceConfig.memberModel).toBe('model-x')
    expect(serviceConfig.stateDir).toBe('.patent-teams')
    expect(serviceConfig.memberProvider).toBe('spawn')
    expect(serviceConfig.memberMaxDepth).toBe(1)
  })
})
