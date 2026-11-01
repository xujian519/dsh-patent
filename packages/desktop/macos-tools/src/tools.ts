/**
 * The seven macOS native tool definitions. Host effects with reach beyond the
 * session — opening a path with its default application, reading the
 * clipboard, launching or quitting an application — resolve one-time approval
 * through the approval seam before anything runs and fail closed without it;
 * the remaining effects (reveal, browser URLs, clipboard writes,
 * notifications, speech, activation) run directly. Mirrors the fail-closed
 * sequence the sandbox escalation family shares.
 * @module @deepseek-ai/dsh-macos-tools/tools
 */

import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { CliRunner } from './runner.ts'

/** Resolved plugin limits; the factory treats them as final. */
export interface MacosLimits {
  /** Timeout for every system-CLI invocation, in milliseconds. */
  readonly commandTimeoutMs: number
  /** Character cap for one clipboard read. */
  readonly clipboardReadMaxChars: number
  /** Character cap for one clipboard write. */
  readonly clipboardWriteMaxChars: number
  /** Character cap for one spoken text. */
  readonly speakMaxChars: number
  /** Character cap for a notification title plus message. */
  readonly notifyMaxChars: number
}

/** The approval requester (`ctx.approval`), or `undefined` when none is composed. */
type MacosApprover = Pick<ApprovalService, 'request'>

/** Factory inputs: the effectful seams, so tests substitute fakes. */
interface MacosToolDeps {
  /** Runs one macOS system CLI. */
  readonly run: CliRunner
  /** Approval channel for host-effect actions, when composed. */
  readonly approver: MacosApprover | undefined
  /** Existence precheck for path arguments; rejects when the path is inaccessible. */
  readonly stat: (path: string) => Promise<void>
  /** Resolved limits. */
  readonly limits: MacosLimits
}

/** The absolute system executables every tool spawns; never resolved through PATH. */
const OPEN = '/usr/bin/open'
const OSASCRIPT = '/usr/bin/osascript'
const PBPASTE = '/usr/bin/pbpaste'
const PBCOPY = '/usr/bin/pbcopy'
const SAY = '/usr/bin/say'

/**
 * The production path-existence precheck over `node:fs/promises`.
 * @returns a check that resolves for an accessible path and otherwise names it.
 */
export function createStatPathCheck(): (path: string) => Promise<void> {
  return async (path) => {
    try {
      await stat(path)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      throw new Error(`cannot access path: ${path} (${code})`)
    }
  }
}

/**
 * Resolve one approval request before any host effect runs: a missing
 * service, an agent-less call, or any non-grant outcome throws, so the tool
 * registry turns the throw into that call's isError result and nothing has
 * executed.
 * @param deps - the factory seams supplying the approval channel.
 * @param exec - the calling execution, routing the question and carrying its signal.
 * @param action - the effect description shown on rejection paths.
 * @param reason - the one-line justification recorded with the audit pair.
 */
async function requireApproval(deps: MacosToolDeps, exec: ToolRunContext, action: string, reason: string): Promise<void> {
  if (deps.approver === undefined) {
    throw new Error(`${action} requires approval, but no approval service is composed`)
  }
  if (exec.agent === undefined) {
    throw new Error(`${action} requires approval, but the call has no agent to route it through`)
  }
  const outcome = await deps.approver.request({
    agent: exec.agent,
    toolName: exec.name,
    callId: exec.callId,
    reason,
    signal: exec.signal,
  })
  switch (outcome) {
    case 'allowed-once': return
    case 'rejected': throw new Error(`the user rejected ${action}`)
    case 'cancelled': throw new Error(`approval for ${action} was cancelled`)
    case 'unavailable': throw new Error(`${action} requires approval, but no approval channel is available`)
    default: return assertNever(outcome, 'ApprovalOutcome')
  }
}

/** Expand `~` against the real home directory; reject relative paths. */
function normalizeTargetPath(raw: string): string {
  if (raw === '~') return homedir()
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2))
  if (!isAbsolute(raw)) {
    throw new Error(`path must be absolute or start with ~ (got "${raw}")`)
  }
  return raw
}

/** Accept only http and https targets; a bare host defaults to https. */
function normalizeUrl(raw: string): string {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('url must not be empty')
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
  if (!/^https?:\/\//i.test(withScheme)) {
    throw new Error('only http and https URLs can be opened')
  }
  return withScheme
}

/** Strip every character that could escape an AppleScript string literal. */
function appleScriptText(value: string): string {
  return value.replace(/[\x00-\x1f\\"]/g, '')
}

/**
 * The closed `{ ok, chars }` output schema shared by the clipboard-write and
 * speak tools; `as const` keeps `defineTool`'s value inference literal.
 */
const OK_CHARS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    chars: { type: 'integer', required: true },
  },
} as const

/** Reject empty or over-limit text with the limit named. */
function requireText(value: string, max: number, label: string): string {
  if (value.length === 0) throw new Error(`${label} must not be empty`)
  if (value.length > max) throw new Error(`${label} exceeds the ${max}-character limit`)
  return value
}

/**
 * Define the seven macOS native tools.
 * @param deps - the effectful seams (CLI runner, approval channel, existence
 *   precheck) and the resolved limits.
 * @returns registry-ready definitions; `ctx.tools.register` takes each one.
 */
export function createMacosTools(deps: MacosToolDeps): ToolDefinition[] {
  const { run, stat, limits } = deps
  const spawn = (command: string, args: readonly string[], exec: ToolRunContext, input?: string) =>
    run(command, args, { timeoutMs: limits.commandTimeoutMs, signal: exec.signal, ...input !== undefined ? { input } : {} })

  return [
    defineTool({
      name: 'macos_open_path',
      description: 'Open a file or folder with its default macOS application, or reveal it in Finder. '
        + 'Opening hands the path to its default application and asks the user for approval; revealing only selects it in Finder.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute or ~-rooted file or folder path.' },
        reveal: { type: 'boolean', description: 'true to select the path in Finder instead of opening it (default false).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            path: { type: 'string', required: true },
            revealed: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.revealed ? `Revealed in Finder: ${value.path}` : `Opened: ${value.path}`,
        }],
      },
      async execute(args, exec) {
        const path = normalizeTargetPath(args.path)
        await stat(path)
        const revealed = args.reveal === true
        if (!revealed) {
          await requireApproval(deps, exec, `opening "${path}" with its default application`, `open ${path} with its default application`)
        }
        await spawn(OPEN, revealed ? ['-R', path] : [path], exec)
        return { ok: true, path, revealed }
      },
    }),

    defineTool({
      name: 'macos_open_url',
      description: 'Open a URL in the user\'s default browser. Bare hosts default to https; only http and https URLs are allowed.',
      parameters: {
        url: { type: 'string', required: true, description: 'URL to open, e.g. https://example.com or example.com.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            url: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `Opened in default browser: ${value.url}` }],
      },
      async execute(args, exec) {
        const url = normalizeUrl(args.url)
        await spawn(OPEN, [url], exec)
        return { ok: true, url }
      },
    }),

    defineTool({
      name: 'macos_clipboard_get',
      description: 'Read the current macOS clipboard text. The clipboard may hold secrets, so every read asks the user for one-time approval first.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            text: { type: 'string', required: true },
            truncated: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.text.length === 0
            ? 'Clipboard is empty'
            : `${value.truncated ? 'Clipboard (truncated):\n' : 'Clipboard:\n'}${value.text}`,
        }],
      },
      async execute(_args, exec) {
        await requireApproval(deps, exec, 'reading the clipboard', 'read the current clipboard text')
        let text = ''
        try {
          text = (await spawn(PBPASTE, [], exec)).stdout
        } catch {
          // pbpaste exits non-zero when the clipboard holds no text (e.g. an
          // image); approval already resolved above, so the exit reads as an
          // empty clipboard.
        }
        const truncated = text.length > limits.clipboardReadMaxChars
        return {
          ok: true,
          text: truncated ? text.slice(0, limits.clipboardReadMaxChars) : text,
          truncated,
        }
      },
    }),

    defineTool({
      name: 'macos_clipboard_set',
      description: 'Replace the macOS clipboard text with the given text, overwriting its previous content.',
      parameters: {
        text: { type: 'string', required: true, description: 'Text to place on the clipboard.' },
      },
      output: {
        schema: OK_CHARS_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: `Copied ${value.chars} characters to the clipboard` }],
      },
      async execute(args, exec) {
        const text = requireText(args.text, limits.clipboardWriteMaxChars, 'text')
        await spawn(PBCOPY, [], exec, text)
        return { ok: true, chars: text.length }
      },
    }),

    defineTool({
      name: 'macos_notify',
      description: 'Post a macOS system notification with a title, an optional message, and an optional sound.',
      parameters: {
        title: { type: 'string', required: true, description: 'Notification title.' },
        message: { type: 'string', description: 'Notification body (optional).' },
        sound: { type: 'boolean', description: 'Play a notification sound (default false).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            title: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `Sent notification: ${value.title}` }],
      },
      async execute(args, exec) {
        const title = requireText(args.title, limits.notifyMaxChars, 'title')
        const message = (args.message ?? '').trim()
        if (message.length > limits.notifyMaxChars) {
          throw new Error(`message exceeds the ${limits.notifyMaxChars}-character limit`)
        }
        let script = `display notification "${appleScriptText(message)}" with title "${appleScriptText(title)}"`
        if (args.sound === true) script += ' sound name "Glass"'
        await spawn(OSASCRIPT, ['-e', script], exec)
        return { ok: true, title }
      },
    }),

    defineTool({
      name: 'macos_speak',
      description: 'Speak text aloud with macOS text-to-speech (the say command).',
      parameters: {
        text: { type: 'string', required: true, description: 'Text to speak.' },
        voice: { type: 'string', description: 'Voice name (e.g. Tingting, Samantha); defaults to the system voice.' },
        rate: { type: 'integer', description: 'Words per minute, between 80 and 500 (default 175).' },
      },
      output: {
        schema: OK_CHARS_SCHEMA,
        render: (_args, value) => [{ type: 'text', text: `Spoke ${value.chars} characters` }],
      },
      async execute(args, exec) {
        const text = requireText(args.text, limits.speakMaxChars, 'text')
        const argv: string[] = []
        if (args.rate !== undefined) {
          if (args.rate < 80 || args.rate > 500) {
            throw new Error('rate must be between 80 and 500')
          }
          argv.push('-r', String(args.rate))
        }
        if (args.voice !== undefined) {
          argv.push('-v', requireText(args.voice, 100, 'voice'))
        }
        // '--' ends option parsing, keeping a leading-dash text (e.g. a
        // markdown list item) positional instead of silently swallowed.
        argv.push('--', text)
        await spawn(SAY, argv, exec)
        return { ok: true, chars: text.length }
      },
    }),

    defineTool({
      name: 'macos_app',
      description: 'Launch, activate, or quit a macOS application by name, bundle id, or absolute/~-rooted .app path. '
        + 'Launching and quitting ask the user for approval; activating only brings a running app to the front.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['launch', 'activate', 'quit'],
          description: 'launch starts the application; activate brings a running application to the front; quit asks a running application to quit.',
        },
        name: { type: 'string', required: true, description: 'Application name (Safari), bundle id (com.apple.Safari), or .app path.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            action: { type: 'string', required: true },
            name: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.action === 'launch'
            ? `Launched: ${value.name}`
            : value.action === 'activate' ? `Activated: ${value.name}` : `Sent quit to: ${value.name}`,
        }],
      },
      async execute(args, exec) {
        const name = requireText(args.name, 512, 'name')
        if (args.action === 'launch') {
          await requireApproval(deps, exec, `launching "${name}"`, `launch the application ${name}`)
          if (name.startsWith('/') || name.startsWith('~/')) {
            const path = normalizeTargetPath(name)
            await stat(path)
            await spawn(OPEN, [path], exec)
          } else {
            await spawn(OPEN, ['-a', name], exec)
          }
        } else {
          if (args.action === 'quit') {
            await requireApproval(deps, exec, `quitting "${name}"`, `quit the application ${name}`)
          }
          await spawn(OSASCRIPT, ['-e', `tell application "${appleScriptText(name)}" to ${args.action}`], exec)
        }
        return { ok: true, action: args.action, name }
      },
    }),
  ]
}
