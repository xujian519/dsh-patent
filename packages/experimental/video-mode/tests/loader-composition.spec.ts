/**
 * Real Loader composition: a `cordis.yml` mounts the video-mode package with
 * the synthetic provider, and the model-facing tools appear in the registry and
 * execute against the composed filesystem. This covers the product-visible
 * plugin through the Loader path rather than a hand-built test Context.
 */

import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader, { type ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { unsupportedInbox, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import VideoMode from '../src/index.ts'

/**
 * Loader internals stand-in: resolves only the modules this composition names.
 * `loadCache` belongs to Node's live loader and is never read here.
 */
class StubLoader implements ModuleLoaderV2 {
  readonly version = 'v2'
  declare loadCache: ModuleLoaderV2['loadCache']

  constructor(private readonly modules: ReadonlyMap<string, unknown>) {}

  async import(specifier: string): Promise<unknown> {
    if (!this.modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
    return this.modules.get(specifier)
  }

  register(): void {}

  getOrCreateModuleJob(): Promise<never> {
    return Promise.reject(new Error('getOrCreateModuleJob is not part of this composition'))
  }

  resolveSync(): never {
    throw new Error('resolveSync is not part of this composition')
  }

  load(): Promise<never> {
    return Promise.reject(new Error('load is not part of this composition'))
  }
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** A registered Agent with the minimum shape the tools read. */
async function agent(ctx: Context): Promise<Agent> {
  const scope = ctx.plugin(() => {})
  const id = SessionId('video-loader-agent')
  const session = Session.create(id)
  const value: Agent = {
    id,
    options: {},
    session,
    model: unsupportedModel(),
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx: scope.ctx,
    followup: () => {},
    steer: () => {},
    inject: () => {},
    send: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(value)
  return value
}

/**
 * Boot one Loader composition carrying the video-mode row.
 * @param directory - isolated working directory for the fixture.
 * @returns the booted context.
 */
async function boot(directory: string): Promise<Context> {
  const configPath = join(directory, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-executor-native'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-fs-local'",
    '  config:',
    `    cwd: ${JSON.stringify(directory)}`,
    "- name: '@deepseek-ai/dsh-subprocess-local'",
    "- name: '@deepseek-ai/dsh-working-directory'",
    '  config:',
    `    defaultDirectory: ${JSON.stringify(directory)}`,
    "- name: '@deepseek-ai/dsh-video-mode'",
    '  config:',
    '    fakeProvider: true',
    '    approvalThresholdCny: 0.1',
    '    waitMs: 5000',
    '    pollMs: 10',
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = `${pathToFileURL(directory).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-executor-native', NativeToolExecutor],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-fs-local', LocalFileSystem],
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['@deepseek-ai/dsh-working-directory', WorkingDirectory],
    ['@deepseek-ai/dsh-video-mode', VideoMode],
  ])
  ctx.loader.internal = new StubLoader(modules)
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  return ctx
}

describe('video mode through the real Loader', () => {
  it('registers the four tools and executes the project and media flow', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-video-loader-')))
    const ctx = await boot(root)
    const names = ctx.tools.schemas().map(schema => schema.name).sort()
    for (const name of ['media', 'video_assemble', 'video_deliver', 'video_project']) {
      expect(names, `registered tool ${name}`).toContain(name)
    }

    const owner = await agent(ctx)
    const signal = new AbortController().signal
    const init = await executeToolFixture(ctx, {
      signal,
      callId: ToolCallId('loader-init'),
      name: 'video_project',
      arguments: { action: 'init', title: 'Loader Film', budget_cny: 50 },
      agent: owner,
    })
    expect(init.isError).toBe(false)
    const projectPath = init.isError ? '' : (init.value as { path: string }).path
    expect(projectPath.startsWith(root)).toBe(true)

    const generate = await executeToolFixture(ctx, {
      signal,
      callId: ToolCallId('loader-generate'),
      name: 'media',
      arguments: {
        action: 'generate',
        kind: 'image',
        prompt: 'a door',
        output_path: 'assets/loader.png',
        project_path: projectPath,
        confirm_cost: true,
      },
      agent: owner,
    })
    expect(generate.isError).toBe(false)
    const file = join(root, 'assets/loader.png')
    expect((await stat(file)).size).toBeGreaterThan(0)
    const bytes = await readFile(file)
    expect(bytes[0]).toBe(0x89)
  })
})
