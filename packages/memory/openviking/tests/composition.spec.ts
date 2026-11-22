/**
 * Real-composition gate for the shipped plugin: the test-only cordis.yml
 * boots through the real Loader with the real system-prompt/tools services,
 * while only the external OpenViking service is faked (a recording HTTP
 * server). It proves the wiring unit tests cannot see: `memcommit` reaches
 * the service, and the `viking://` guard delegates to downstream
 * `tools/pre-execute` listeners instead of short-circuiting the waterfall.
 */

import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool, type PreToolDecision } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as openviking from '../src/index.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

let context: Context | undefined
let root: string | undefined
let server: Server | undefined
let seen: string[] = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  server?.close()
  server = undefined
  seen = []
  if (root !== undefined) {
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

async function startRecorder(): Promise<string> {
  server = createServer((req, res) => {
    seen.push(`${String(req.method)} ${req.url}`)
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ status: 'ok', result: { ok: true } }))
  })
  await new Promise<void>((resolve) => { server?.listen(0, '127.0.0.1', resolve) })
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

describe('@deepseek-ai/dsh-openviking real Loader composition', () => {
  it('commits through memcommit and delegates the pre-execute waterfall', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-openviking-loader-'))
    const endpoint = await startRecorder()
    const stateFile = join(root, 'state.json')
    await writeFile(join(root, 'cordis.yml'), [
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@test/agents'",
      "- name: '@deepseek-ai/dsh-openviking'",
      '  config:',
      `    endpoint: '${endpoint}'`,
      `    stateFile: '${stateFile}'`,
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    // Plugin namespaces are the real shipped modules; only the sibling MCP
    // client is stubbed so the test stays hermetic (no network handshake).
    const mcpClientStub = {
      name: 'mcp-client',
      inject: ['tools', 'systemPrompt'],
      Config: undefined,
      apply: () => {},
    } as never
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@test/agents', { name: 'test-agents', apply: (ctx: Context) => ctx.provide('agents', {}) }],
      ['@deepseek-ai/dsh-openviking', openviking],
      ['@deepseek-ai/dsh-mcp-client', mcpClientStub],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(join(root, 'cordis.yml')).href },
    })
    await context.loader.await()

    // A downstream pre-execute listener registered after openviking: it must
    // still run on calls the guard allows (delegation), and must NOT run when
    // the guard denies (deny is terminal).
    const downstream = vi.fn((_exec: unknown, next: () => Promise<PreToolDecision>) => next())
    context.on('tools/pre-execute', downstream)

    // A real local-path tool so the guard denial dispatches through the
    // scheduler instead of resolving as an unknown tool.
    context.tools.register(defineTool({
      name: 'read',
      description: 'read a local file',
      parameters: { file_path: { type: 'string' } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      execute: () => Promise.resolve('local content'),
    }))

    // The mounted projection registry folds committed events through the Session
    // interface, so the stand-in carries the header, inherited count, and history read.
    const session = { id: 'comp-s1', header: {}, inheritedEventCount: 0, snapshotEvents: () => [] }
    const agent = { id: 'comp-agent-1', session } as never
    const signal = new AbortController().signal

    // The session-sync effect initializes asynchronously after the store
    // opens; retry with re-emitted events until the wiring is live, then
    // assert the service saw messages AND a commit for this session.
    interface Round { got: boolean }
    let round: Round = { got: false }
    for (let attempt = 0; attempt < 30 && !round.got; attempt += 1) {
      context.emit('agent/created', { agent, source: 'startup' })
      context.emit('session/event', session as never, {
        type: 'user/message', seq: attempt + 1, time: Date.now(),
        data: { content: [{ type: 'text', text: `composition probe ${attempt}` }], source: { kind: 'user' } },
      } as never)
      await executeToolFixture(context, {
        signal,
        callId: ToolCallId(`comp-memcommit-${attempt}`),
        name: 'memcommit',
        arguments: {},
        agent,
      })
      round = await new Promise<Round>((resolve) => {
        // Allow the in-flight flush to reach the server.
        setTimeout(() => {
          resolve({
            got: seen.some(line => line.includes('/api/v1/sessions/') && line.includes('/commit')),
          })
        }, 50)
      })
    }
    expect(round.got).toBe(true)
    expect(seen.some(line => line.includes('/api/v1/sessions/dsh-comp-s1/messages'))).toBe(true)

    // The guard allows the foreign-call path (memcommit carries no viking URI)
    // and the downstream listener saw it — the waterfall was delegated, not cut.
    expect(downstream).toHaveBeenCalled()

    // A viking:// URI on a local path tool is denied through the real
    // scheduler, and the terminal deny never reaches downstream listeners.
    const seenBefore = downstream.mock.calls.length
    const denied = await executeToolFixture(context, {
      signal,
      callId: ToolCallId('comp-deny'),
      name: 'read',
      arguments: { file_path: 'viking://user/memories/x.md' },
      agent,
    })
    expect(denied.isError).toBe(true)
    expect((denied.content[0] as { text: string }).text).toContain('viking:// URIs live in the OpenViking context database')
    expect(downstream.mock.calls.length).toBe(seenBefore)
  })
})
