import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentCancelCause, InboxTarget } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as macosTools from '../src/index.ts'
import { createExecFileRunner, type CliRunOptions, type CliRunner } from '../src/runner.ts'
import { createMacosTools, createStatPathCheck, type MacosLimits } from '../src/tools.ts'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const signal = new AbortController().signal
const contexts: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** One captured fake-runner invocation. */
interface RecordedCall {
  command: string
  args: string[]
  options: CliRunOptions
}

const DEFAULT_LIMITS: MacosLimits = {
  commandTimeoutMs: 15_000,
  clipboardReadMaxChars: 20_000,
  clipboardWriteMaxChars: 1_000_000,
  speakMaxChars: 4_000,
  notifyMaxChars: 4_000,
}

/** A CliRunner recording every call and resolving fixed stdout. */
function fakeRunner(output = ''): { run: CliRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const run: CliRunner = (command, args, options) => {
    calls.push({ command, args: [...args], options })
    return Promise.resolve({ stdout: output })
  }
  return { run, calls }
}

/** A CliRunner recording every call and rejecting once for pbpaste-style failures. */
function rejectingRunner(): { run: CliRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const run: CliRunner = (command, args, options) => {
    calls.push({ command, args: [...args], options })
    return Promise.reject(new Error('command failed'))
  }
  return { run, calls }
}

function stubAgent(ctx: Context, id: string): Agent {
  const session = ctx.sessions.create(SessionId(id))
  return {
    id: session.id,
    options: {},
    session,
    inbox: unsupportedInbox(),
    model: { current: () => undefined, select: () => {} },
    status: 'idle',
    ctx: new Context(),
    send(_message: UserMessage, _target: InboxTarget, _wakeup: boolean) {},
    runMaintenance: task => task(signal),
    cancel(_cause: AgentCancelCause) {},
    whenIdle: () => Promise.resolve(),
    followup(_message: UserMessage) {},
    steer(_message: UserMessage) {},
    inject(_message: UserMessage) {},
  }
}

/** Composition knobs for one factory-level harness. */
interface HarnessOptions {
  runnerOutput?: string
  rejectRuns?: boolean
  approvalOutcome?: string
  withoutApprover?: boolean
  statRejects?: boolean
  limits?: Partial<MacosLimits>
}

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly calls: RecordedCall[]
  readonly approvals: ApprovalRequest[]
  readonly statPaths: string[]
  execute(name: string, args: unknown, options?: { agentless?: boolean }): Promise<ToolExecutionResult>
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const agent = stubAgent(ctx, `macos-tools-${Math.random()}`)
  ctx.agents.register(agent)

  const { run, calls } = options.rejectRuns === true ? rejectingRunner() : fakeRunner(options.runnerOutput)
  const approvals: ApprovalRequest[] = []
  const approver = options.withoutApprover === true ? undefined : {
    async request(request: ApprovalRequest): Promise<ApprovalOutcome> {
      approvals.push(request)
      return (options.approvalOutcome ?? 'allowed-once') as ApprovalOutcome
    },
  }
  const statPaths: string[] = []
  const tools = createMacosTools({
    run,
    approver,
    stat: async (path) => {
      statPaths.push(path)
      if (options.statRejects === true) throw new Error(`inaccessible: ${path}`)
    },
    limits: { ...DEFAULT_LIMITS, ...options.limits },
  })
  for (const tool of tools) ctx.tools.register(tool)

  const execute = (name: string, args: unknown, execOptions: { agentless?: boolean } = {}) =>
    execOptions.agentless === true
      ? executeToolFixture(ctx, { signal, callId: ToolCallId(`call-${Math.random()}`), name, arguments: args })
      : ctx.agents.withInitiator(agent, () => executeToolFixture(ctx, {
        signal,
        callId: ToolCallId(`call-${Math.random()}`),
        name,
        arguments: args,
        agent,
      }))
  return { ctx, agent, calls, approvals, statPaths, execute }
}

/** Assert success and return the canonical value. */
function value(result: ToolExecutionResult): Record<string, unknown> {
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error('expected a successful canonical value')
  return result.value as Record<string, unknown>
}

/** Assert failure and return the error message. */
function error(result: ToolExecutionResult): string {
  expect(result.isError).toBe(true)
  if (!result.isError) throw new Error('expected an error result')
  return result.error.message
}

/** The rendered Native text of a successful call. */
function text(result: ToolExecutionResult): string {
  if (result.isError) throw new Error('expected a successful result')
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('expected deterministic text content')
  return block.text
}

describe('macos_open_path', () => {
  it('reveals in Finder without approval', async () => {
    const test = await harness()
    const result = await test.execute('macos_open_path', { path: '/tmp/notes.md', reveal: true })
    expect(value(result)).toEqual({ ok: true, path: '/tmp/notes.md', revealed: true })
    expect(text(result)).toBe('Revealed in Finder: /tmp/notes.md')
    expect(test.calls.map(({ command, args, options }) => ({ command, args, timeoutMs: options.timeoutMs })))
      .toEqual([{ command: '/usr/bin/open', args: ['-R', '/tmp/notes.md'], timeoutMs: 15_000 }])
    expect(test.approvals).toEqual([])
    expect(test.statPaths).toEqual(['/tmp/notes.md'])
  })

  it('opens with the default application after approval', async () => {
    const test = await harness()
    const result = await test.execute('macos_open_path', { path: '/tmp/report.pdf' })
    expect(value(result)).toEqual({ ok: true, path: '/tmp/report.pdf', revealed: false })
    expect(text(result)).toBe('Opened: /tmp/report.pdf')
    expect(test.calls[0]?.args).toEqual(['/tmp/report.pdf'])
    expect(test.approvals).toHaveLength(1)
    expect(test.approvals[0]?.toolName).toBe('macos_open_path')
    expect(test.approvals[0]?.reason).toContain('/tmp/report.pdf')
    expect(test.approvals[0]?.agent).toBe(test.agent)
  })

  it('rejects relative paths', async () => {
    const test = await harness()
    const result = await test.execute('macos_open_path', { path: 'notes.md', reveal: true })
    expect(error(result)).toMatch(/path must be absolute or start with ~/)
    expect(test.calls).toEqual([])
  })

  it('expands ~ against the real home directory', async () => {
    const test = await harness()
    const bare = await test.execute('macos_open_path', { path: '~', reveal: true })
    expect(value(bare)).toEqual({ ok: true, path: homedir(), revealed: true })
    const nested = await test.execute('macos_open_path', { path: '~/Desktop', reveal: true })
    expect(value(nested)).toEqual({ ok: true, path: join(homedir(), 'Desktop'), revealed: true })
    expect(test.statPaths).toEqual([homedir(), join(homedir(), 'Desktop')])
  })

  it('fails closed when the stat precheck rejects', async () => {
    const test = await harness({ statRejects: true })
    const result = await test.execute('macos_open_path', { path: '/tmp/secret.pdf', reveal: true })
    expect(error(result)).toBe('inaccessible: /tmp/secret.pdf')
    expect(test.calls).toEqual([])
  })
})

describe('macos_open_url', () => {
  it('opens a https URL as given', async () => {
    const test = await harness()
    const result = await test.execute('macos_open_url', { url: 'https://example.com/a' })
    expect(value(result)).toEqual({ ok: true, url: 'https://example.com/a' })
    expect(test.calls[0]?.args).toEqual(['https://example.com/a'])
  })

  it('defaults a bare host to https', async () => {
    const test = await harness()
    await test.execute('macos_open_url', { url: 'example.com' })
    expect(test.calls[0]?.args).toEqual(['https://example.com'])
  })

  it('rejects non-http schemes', async () => {
    const test = await harness()
    const result = await test.execute('macos_open_url', { url: 'ftp://example.com' })
    expect(error(result)).toBe('only http and https URLs can be opened')
    expect(test.calls).toEqual([])
  })

  it('rejects an empty URL', async () => {
    const test = await harness()
    const result = await test.execute('macos_open_url', { url: '   ' })
    expect(error(result)).toBe('url must not be empty')
  })
})

describe('macos_clipboard_get', () => {
  it('reads the clipboard after approval', async () => {
    const test = await harness({ runnerOutput: 'copied text' })
    const result = await test.execute('macos_clipboard_get', {})
    expect(value(result)).toEqual({ ok: true, text: 'copied text', truncated: false })
    expect(text(result)).toBe('Clipboard:\ncopied text')
    expect(test.calls[0]?.command).toBe('/usr/bin/pbpaste')
    expect(test.approvals).toHaveLength(1)
  })

  it('truncates to the read limit', async () => {
    const test = await harness({ runnerOutput: '0123456789ABC', limits: { clipboardReadMaxChars: 10 } })
    const result = await test.execute('macos_clipboard_get', {})
    expect(value(result)).toEqual({ ok: true, text: '0123456789', truncated: true })
    expect(text(result)).toContain('truncated')
  })

  it('treats a pbpaste failure as an empty clipboard', async () => {
    const test = await harness({ rejectRuns: true })
    const result = await test.execute('macos_clipboard_get', {})
    expect(value(result)).toEqual({ ok: true, text: '', truncated: false })
    expect(text(result)).toBe('Clipboard is empty')
  })

  it('fails closed for every non-grant approval outcome', async () => {
    for (const [outcome, expected] of [
      ['rejected', 'the user rejected reading the clipboard'],
      ['cancelled', 'approval for reading the clipboard was cancelled'],
      ['unavailable', 'reading the clipboard requires approval, but no approval channel is available'],
    ] as const) {
      const test = await harness({ approvalOutcome: outcome })
      const result = await test.execute('macos_clipboard_get', {})
      expect(error(result)).toBe(expected)
      expect(test.calls).toEqual([])
    }
  })

  it('fails closed without an approval service', async () => {
    const test = await harness({ withoutApprover: true })
    const result = await test.execute('macos_clipboard_get', {})
    expect(error(result)).toBe('reading the clipboard requires approval, but no approval service is composed')
  })

  it('fails closed for an agent-less call', async () => {
    const test = await harness()
    const result = await test.execute('macos_clipboard_get', {}, { agentless: true })
    expect(error(result)).toBe('reading the clipboard requires approval, but the call has no agent to route it through')
  })

  it('rejects a rogue approval outcome through the closed union', async () => {
    const test = await harness({ approvalOutcome: 'bogus' })
    const result = await test.execute('macos_clipboard_get', {})
    expect(error(result)).toContain('unreachable variant in ApprovalOutcome')
  })
})

describe('macos_clipboard_set', () => {
  it('writes text through stdin', async () => {
    const test = await harness()
    const result = await test.execute('macos_clipboard_set', { text: 'hello' })
    expect(value(result)).toEqual({ ok: true, chars: 5 })
    expect(text(result)).toBe('Copied 5 characters to the clipboard')
    expect(test.calls[0]?.command).toBe('/usr/bin/pbcopy')
    expect(test.calls[0]?.options.input).toBe('hello')
  })

  it('rejects empty text', async () => {
    const test = await harness()
    const result = await test.execute('macos_clipboard_set', { text: '' })
    expect(error(result)).toBe('text must not be empty')
  })

  it('enforces the write limit', async () => {
    const test = await harness({ limits: { clipboardWriteMaxChars: 5 } })
    const result = await test.execute('macos_clipboard_set', { text: '012345' })
    expect(error(result)).toBe('text exceeds the 5-character limit')
  })
})

describe('macos_notify', () => {
  it('posts a titled notification with message and sound', async () => {
    const test = await harness()
    const result = await test.execute('macos_notify', { title: 'Task done', message: 'All tests passed', sound: true })
    expect(value(result)).toEqual({ ok: true, title: 'Task done' })
    expect(test.calls[0]?.command).toBe('/usr/bin/osascript')
    expect(test.calls[0]?.args[0]).toBe('-e')
    expect(test.calls[0]?.args[1]).toBe('display notification "All tests passed" with title "Task done" sound name "Glass"')
  })

  it('posts a bare title when message and sound are omitted', async () => {
    const test = await harness()
    await test.execute('macos_notify', { title: 'Done' })
    expect(test.calls[0]?.args[1]).toBe('display notification "" with title "Done"')
  })

  it('strips AppleScript escapes from the embedded literals', async () => {
    const test = await harness()
    await test.execute('macos_notify', { title: 'a"b\\c', message: 'd\ne' })
    expect(test.calls[0]?.args[1]).toBe('display notification "de" with title "abc"')
  })

  it('rejects an empty title and an over-limit message', async () => {
    const test = await harness()
    expect(error(await test.execute('macos_notify', { title: '' }))).toBe('title must not be empty')
    expect(error(await test.execute('macos_notify', { title: 't', message: 'x'.repeat(4_001) })))
      .toBe('message exceeds the 4000-character limit')
  })
})

describe('macos_speak', () => {
  it('speaks plain text', async () => {
    const test = await harness()
    const result = await test.execute('macos_speak', { text: 'hello world' })
    expect(value(result)).toEqual({ ok: true, chars: 11 })
    expect(text(result)).toBe('Spoke 11 characters')
    expect(test.calls[0]).toEqual(expect.objectContaining({ command: '/usr/bin/say' }))
    expect(test.calls[0]?.args).toEqual(['--', 'hello world'])
  })

  it('passes rate and voice as separate argv elements', async () => {
    const test = await harness()
    await test.execute('macos_speak', { text: 'hi', voice: 'Tingting', rate: 200 })
    expect(test.calls[0]?.args).toEqual(['-r', '200', '-v', 'Tingting', '--', 'hi'])
  })

  it('keeps leading-dash text positional through the -- separator', async () => {
    const test = await harness()
    const result = await test.execute('macos_speak', { text: '- item to speak' })
    expect(value(result)).toEqual({ ok: true, chars: 15 })
    expect(test.calls[0]?.args).toEqual(['--', '- item to speak'])
  })

  it('rejects out-of-range and non-integer rates', async () => {
    const test = await harness()
    expect(error(await test.execute('macos_speak', { text: 'hi', rate: 50 }))).toBe('rate must be between 80 and 500')
    expect(error(await test.execute('macos_speak', { text: 'hi', rate: 999 }))).toBe('rate must be between 80 and 500')
    expect(error(await test.execute('macos_speak', { text: 'hi', rate: 200.5 }))).toContain('rate')
    expect(error(await test.execute('macos_speak', { text: 'hi', voice: '' }))).toBe('voice must not be empty')
  })
})

describe('macos_app', () => {
  it('launches by name after approval', async () => {
    const test = await harness()
    const result = await test.execute('macos_app', { action: 'launch', name: 'Safari' })
    expect(value(result)).toEqual({ ok: true, action: 'launch', name: 'Safari' })
    expect(text(result)).toBe('Launched: Safari')
    expect(test.calls[0]?.args).toEqual(['-a', 'Safari'])
    expect(test.approvals[0]?.reason).toContain('launch the application Safari')
  })

  it('launches by path after a stat precheck', async () => {
    const test = await harness()
    const result = await test.execute('macos_app', { action: 'launch', name: '/Applications/Safari.app' })
    expect(value(result)).toEqual({ ok: true, action: 'launch', name: '/Applications/Safari.app' })
    expect(test.statPaths).toEqual(['/Applications/Safari.app'])
    expect(test.calls[0]?.args).toEqual(['/Applications/Safari.app'])
  })

  it('activates without approval', async () => {
    const test = await harness()
    const result = await test.execute('macos_app', { action: 'activate', name: 'Safari' })
    expect(value(result)).toEqual({ ok: true, action: 'activate', name: 'Safari' })
    expect(text(result)).toBe('Activated: Safari')
    expect(test.approvals).toEqual([])
    expect(test.calls[0]?.args).toEqual(['-e', 'tell application "Safari" to activate'])
  })

  it('quits after approval and strips the embedded application name', async () => {
    const test = await harness()
    const result = await test.execute('macos_app', { action: 'quit', name: 'No"te\\pad' })
    expect(value(result)).toEqual({ ok: true, action: 'quit', name: 'No"te\\pad' })
    expect(text(result)).toBe('Sent quit to: No"te\\pad')
    expect(test.calls[0]?.args[1]).toBe('tell application "Notepad" to quit')
    expect(test.approvals[0]?.reason).toContain('quit the application')
  })

  it('fails closed when quitting is rejected', async () => {
    const test = await harness({ approvalOutcome: 'rejected' })
    const result = await test.execute('macos_app', { action: 'quit', name: 'Safari' })
    expect(error(result)).toBe('the user rejected quitting "Safari"')
    expect(test.calls).toEqual([])
  })

  it('rejects an empty or over-long name', async () => {
    const test = await harness()
    expect(error(await test.execute('macos_app', { action: 'activate', name: '' }))).toBe('name must not be empty')
    expect(error(await test.execute('macos_app', { action: 'activate', name: 'x'.repeat(513) })))
      .toBe('name exceeds the 512-character limit')
  })

  it('rejects an action outside the enum before execute', async () => {
    const test = await harness()
    const result = await test.execute('macos_app', { action: 'terminate', name: 'Safari' })
    expect(result.isError).toBe(true)
    expect(test.calls).toEqual([])
  })
})

describe('createStatPathCheck', () => {
  it('resolves for an accessible path and names the failing one', async () => {
    const check = createStatPathCheck()
    const dir = await mkdtemp(join(tmpdir(), 'dsh-macos-stat-'))
    tempDirs.push(dir)
    await expect(check(dir)).resolves.toBeUndefined()
    const missing = join(dir, 'absent.txt')
    await expect(check(missing)).rejects.toThrow(`cannot access path: ${missing} (ENOENT)`)
  })
})

describe('createExecFileRunner', () => {
  it('resolves stdout, rejects failures, pipes stdin, and honors a pre-aborted signal', async () => {
    const run = createExecFileRunner()
    await expect(run('/bin/echo', ['hello'], { timeoutMs: 5_000, signal })).resolves.toEqual({ stdout: 'hello\n' })
    await expect(run('/usr/bin/false', [], { timeoutMs: 5_000, signal })).rejects.toThrow(/false/)
    await expect(run('/bin/cat', [], { timeoutMs: 5_000, signal, input: 'piped' })).resolves.toEqual({ stdout: 'piped' })
    const aborted = AbortSignal.abort('stop')
    await expect(run('/bin/echo', ['x'], { timeoutMs: 5_000, signal: aborted })).rejects.toThrow()
  })

  it('contains an EPIPE when the child exits before draining a large stdin payload', async () => {
    // 1 MB overflows the pipe buffer, so writes continue after /usr/bin/true
    // exits and at least one lands on the closed read end: the contained
    // stream error runs while the callback still resolves success.
    const run = createExecFileRunner()
    await expect(run('/usr/bin/true', [], { timeoutMs: 5_000, signal, input: 'x'.repeat(1024 * 1024) }))
      .resolves.toEqual({ stdout: '' })
  })
})

describe('plugin assembly', () => {
  it('registers all seven tools under the default config', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(macosTools)
    const names = ['macos_open_path', 'macos_open_url', 'macos_clipboard_get', 'macos_clipboard_set', 'macos_notify', 'macos_speak', 'macos_app']
    for (const name of names) expect(ctx.tools.get(name)?.name, name).toBe(name)
  })

  it('fails loud on non-positive or non-integer limits', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    expect(() => { macosTools.apply(ctx, { commandTimeoutMs: 0 }) }).toThrow('commandTimeoutMs must be a positive integer')
    expect(() => { macosTools.apply(ctx, { clipboardReadMaxChars: -1 }) }).toThrow('clipboardReadMaxChars must be a positive integer')
    expect(() => { macosTools.apply(ctx, { notifyMaxChars: 1.5 }) }).toThrow('notifyMaxChars must be a positive integer')
  })

  it('removes the seven tools when the contributing fiber disposes', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(macosTools)
    expect(ctx.tools.schemas().map(item => item.name)).toHaveLength(7)
    await fiber.dispose()
    expect(ctx.tools.schemas()).toEqual([])
    expect(ctx.tools.get('macos_open_url')).toBeUndefined()
  })
})
