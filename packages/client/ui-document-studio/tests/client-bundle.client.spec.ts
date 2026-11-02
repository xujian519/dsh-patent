// @vitest-environment jsdom
/**
 * Real tsdown artifact shape: lib/client.js hands off through
 * window.__ModuleLoader__.load, resolves externals through the injected
 * require, returns the exports (apply + inject), and a mounted apply
 * registers the document view tab, the produced-file targets, and the
 * preset auto-switch against real registries. Skips when dist/ is not built
 * (`pnpm --filter @deepseek-ai/dsh-client-ui-document-studio bundle`).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const PLUGIN_ID = '@deepseek-ai/dsh-client-ui-document-studio'

/** Event window of a session that already registered one deliverable and finished the turn. */
function registeredEntries() {
  return [
    { type: 'event', event: { seq: 1, time: 1_000, type: 'tool/call', data: { turn: 1, step: 1, callId: 'reg', name: 'document_deliver', arguments: '{}' } } },
    { type: 'event', event: { seq: 2, time: 2_000, type: 'tool/result', surfaceOp: 'append', data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'reg' }, content: [], isError: false } } } },
    { type: 'event', event: { seq: 3, time: 3_000, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } } },
  ]
}

/** The session binding the auto-switch reads its event window from. */
function sessionBinding() {
  const entries = registeredEntries()
  return { eventSource: { getSnapshot: () => ({ entries }), subscribe: () => () => {} } }
}

interface Handoff { id: string; factory: (require: (spec: string) => unknown) => Record<string, unknown> }
type Win = { __ModuleLoader__?: { load(h: Handoff): void } }

function readBundle(): string | undefined {
  try {
    return readFileSync(resolve('packages/client/ui-document-studio/lib/client.js'), 'utf8')
  } catch {
    return undefined
  }
}

afterEach(() => {
  delete (window as Win).__ModuleLoader__
  for (const el of document.querySelectorAll('style')) el.remove()
})

describe('tsdown client artifact', () => {
  const code = readBundle()

  async function loadArtifact() {
    let handoff: Handoff | undefined
    ;(window as Win).__ModuleLoader__ = { load: (h) => { handoff = h } }
    // The implied-eval ban targets accidental string execution, not this
    // deliberate built-bundle fixture running in the window scope.
    // oxlint-disable-next-line typescript/no-implied-eval, typescript/no-unsafe-call
    new Function(code!)()
    expect(handoff).toBeDefined()
    const modules = new Map<string, unknown>([
      ['react', await import('react')],
      ['react/jsx-runtime', await import('react/jsx-runtime')],
      ['react-dom', await import('react-dom')],
      ['@deepseek-ai/dsh-client-connection/client', await import('@deepseek-ai/dsh-client-connection/client')],
      ['@deepseek-ai/dsh-client-ui-conversation/client', await import('@deepseek-ai/dsh-client-ui-conversation/client')],
      ['@deepseek-ai/dsh-client-ui-primitives', await import('@deepseek-ai/dsh-client-ui-primitives')],
    ])
    const exports = handoff!.factory((spec) => {
      if (!modules.has(spec)) throw new Error(`unexpected require: ${spec}`)
      return modules.get(spec)
    })
    return { handoff: handoff!, exports: exports as { apply: (ctx: Context) => void; inject: string[] } }
  }

  interface SessionEntry {
    id: string
    projectionValues?: { agentPreset?: string }
    cwd?: string
    retainedBy: Record<string, number>
  }

  interface SessionsState {
    byId: Record<string, SessionEntry | undefined>
  }

  async function harness(exports: { apply: (ctx: Context) => void }, state: SessionsState) {
    const ctx = new Context()
    const slots = new SlotRegistry(ctx)
    new UiConversation(ctx, { binding: () => undefined } as never)
    slots.register({
      name: 'root',
      children: { 'conversation.view': { kind: 'list', scope: 'session' } },
    }, (_p: { renderSlot?: unknown }) => null)
    const sessionsList = createSnapshotStore<SessionsState>(state)
    ctx.provide('sessions', {
      list: sessionsList,
      binding: () => sessionBinding(),
    } as never)
    const viewSetters: Array<[string, string]> = []
    ctx.provide('conversation', {
      setActiveView: (sessionId: string, view: string): boolean => {
        viewSetters.push([sessionId, view])
        return true
      },
    } as never)
    ctx.provide('connection', { isLoopback: true } as never)
    const remoteSession = {}
    const remoteWorkspaceFiles = {}
    ctx.provide('remote', { $on: () => () => {}, session: remoteSession, workspaceFiles: remoteWorkspaceFiles } as never)
    ctx.provide('remote.session', remoteSession as never)
    ctx.provide('remote.workspaceFiles', remoteWorkspaceFiles as never)
    ctx.provide('configForms', { get: () => stubConfigForm().scope } as never)
    const locale = await import('@deepseek-ai/dsh-client-locale/client')
    // The plugin under test injects `locale`; the locale plugin publishes the service on
    // its own activation turn, so wait for it before mounting or that mount stays pending.
    await ctx.plugin({ inject: [...locale.inject], apply: locale.apply }).await()
    const fiber = ctx.plugin(exports)
    return { ctx, fiber, slots, sessionsList, viewSetters }
  }

  it.skipIf(code === undefined)('hands off with the manifest id and the DI-require factory', async () => {
    const { handoff, exports } = await loadArtifact()
    expect(handoff.id).toBe(PLUGIN_ID)
    expect(exports.apply).toBeTypeOf('function')
    expect(exports.inject).toEqual([
      'slots', 'locale', 'uiConversation', 'conversation', 'sessions', 'connection', 'remote', 'remote.session',
      'remote.workspaceFiles',
    ])
  })

  it.skipIf(code === undefined)('mounts the view tab and the produced-file targets, and disposes them', async () => {
    const { exports } = await loadArtifact()
    const { ctx, fiber, slots } = await harness(exports, { byId: {} })
    await fiber.await()
    const events = ctx.uiConversation.events
    const views = ctx.uiConversation.views
    expect(slots.entries('conversation.view').map(entry => entry.options.id)).toEqual(['documentDeliverables'])
    expect(events.entries().map(entry => entry.kind)).toContain('documentDeliverables')
    expect(views.entries().map(entry => entry.target)).toEqual(['documentDeliverables'])
    await fiber.dispose()
    expect(slots.entries('conversation.view')).toHaveLength(0)
    expect(events.entries()).toEqual([])
    expect(views.entries()).toEqual([])
  })

  it.skipIf(code === undefined)('auto-switches a document-preset session to the studio view', async () => {
    const { exports } = await loadArtifact()
    const { fiber, viewSetters, sessionsList } = await harness(exports, {
      byId: {
        s1: { id: 's1', projectionValues: { agentPreset: 'document' }, cwd: '/tmp/w', retainedBy: { mainView: 1 } },
        s2: { id: 's2', retainedBy: {} },
      },
    })
    await fiber.await()
    expect(viewSetters).toEqual([['s1', 'documentDeliverables']])
    // A non-document session switch does not fire again.
    sessionsList.update((draft) => {
      draft.byId.s1!.retainedBy = {}
      draft.byId.s2!.retainedBy = { mainView: 1 }
    })
    await Promise.resolve()
    expect(viewSetters).toEqual([['s1', 'documentDeliverables']])
    // Re-entering the document session switches again (session entry only).
    sessionsList.update((draft) => {
      draft.byId.s2!.retainedBy = {}
      draft.byId.s1!.retainedBy = { mainView: 1 }
    })
    await Promise.resolve()
    expect(viewSetters).toEqual([['s1', 'documentDeliverables'], ['s1', 'documentDeliverables']])
    await fiber.dispose()
  })

  it.skipIf(code === undefined)('retries until the setter reports success, then gives up on the cap', async () => {
    vi.useFakeTimers()
    try {
      const { exports } = await loadArtifact()
      const ctx = new Context()
      const slots = new SlotRegistry(ctx)
      new UiConversation(ctx, { binding: () => undefined } as never)
      slots.register({
        name: 'root',
        children: { 'conversation.view': { kind: 'list', scope: 'session' } },
      }, (_p: { renderSlot?: unknown }) => null)
      const sessionsList = createSnapshotStore<SessionsState>({
        byId: { s1: { id: 's1', projectionValues: { agentPreset: 'document' }, retainedBy: { mainView: 1 } } },
      })
      ctx.provide('sessions', { list: sessionsList, binding: () => sessionBinding() } as never)
      // Setter reports false until it exists: exercise the retry cadence.
      let attempts = 0
      ctx.provide('conversation', {
        setActiveView: (): boolean => { attempts += 1; return false },
      } as never)
      ctx.provide('connection', { isLoopback: true } as never)
      const remoteSession = {}
      const remoteWorkspaceFiles = {}
      ctx.provide('remote', { $on: () => () => {}, session: remoteSession, workspaceFiles: remoteWorkspaceFiles } as never)
      ctx.provide('remote.session', remoteSession as never)
      ctx.provide('remote.workspaceFiles', remoteWorkspaceFiles as never)
      ctx.provide('configForms', { get: () => stubConfigForm().scope } as never)
      const locale = await import('@deepseek-ai/dsh-client-locale/client')
      // The plugin under test injects `locale`; the locale plugin publishes the service on
      // its own activation turn, so wait for it before mounting or that mount stays pending.
      await ctx.plugin({ inject: [...locale.inject], apply: locale.apply }).await()
      const fiber = ctx.plugin(exports)
      await fiber.await()
      const initial = attempts
      vi.advanceTimersByTime(150)
      expect(attempts).toBe(initial + 1)
      vi.advanceTimersByTime(150 * (20 + 2))
      expect(attempts).toBeLessThanOrEqual(initial + 1 + 20)
      await fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it.skipIf(code === undefined)('injects plugin-tagged module CSS during factory execution', async () => {
    await loadArtifact()
    const tags = document.querySelectorAll(`style[data-plugin=${JSON.stringify(PLUGIN_ID)}]`)
    expect(tags.length).toBeGreaterThan(0)
  })
})
