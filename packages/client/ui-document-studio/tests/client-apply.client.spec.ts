// @vitest-environment jsdom
/**
 * Document studio plugin body: the registered view tab and its injected host
 * callbacks, the composer-draft write, and the preset auto-switch, mounted on
 * a real Cordis Context with the real slot, conversation, and locale services.
 */
import { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { stubConfigForm } from '@deepseek-ai/dsh-client-test-runtime'
import { UiConversation } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject as pluginInject } from '../src/client/index.ts'
import type { StudioViewInjected } from '../src/client/StudioView.tsx'
import { en, zh } from '../src/client/locales.ts'

/** One catalog row the auto-switch reads. */
interface SessionEntry {
  id: string
  projectionValues?: { agentPreset?: string }
  cwd?: string
  retainedBy: Record<string, number>
}

interface SessionsState {
  byId: Record<string, SessionEntry | undefined>
}

/** The per-session composer draft the insert writes. */
interface DraftSink {
  readonly state: { getSnapshot(): { draft: string } }
  setDraft(text: string): void
}

/** The conversation service surface the plugin reaches. */
interface ConversationFace {
  input: { for(actx: unknown): DraftSink }
  setActiveView(sessionId: SessionId, view: string): boolean
}

type OpenWorkspacePathRequest = { path: string; action?: 'reveal' }
type OpenWorkspacePathResult = { ok: true } | { ok: false; error: { message: string } }

interface MountOptions {
  sessions?: SessionsState
  scope?: (id: SessionId) => unknown
  binding?: (id: SessionId) => unknown
  conversation?: ConversationFace | 'undefined'
  sidebar?: { openResource(address: string): void }
  isLoopback?: boolean
  openWorkspacePath?: (request: OpenWorkspacePathRequest) => Promise<OpenWorkspacePathResult>
}

/** The registry erases the inject return type; this restores the declared face. */
type InjectedFace = Pick<StudioViewInjected, keyof StudioViewInjected>

/** One catalog row, retained by the main view unless a count says otherwise. */
function sessionEntry(id: string, options: { preset?: string; mainView?: number; cwd?: string } = {}): SessionEntry {
  return {
    id,
    cwd: options.cwd ?? '/tmp/w',
    projectionValues: options.preset === undefined ? {} : { agentPreset: options.preset },
    retainedBy: options.mainView === undefined ? {} : { mainView: options.mainView },
  }
}

/** A session event window that already logged one successful deliverable registration. */
function registeredWindow() {
  return [
    {
      type: 'event',
      event: {
        seq: 1, time: 1_000, type: 'tool/call',
        data: { turn: 1, step: 1, callId: 'reg', name: 'document_deliver', arguments: '{}' },
      },
    },
    {
      type: 'event',
      event: {
        seq: 2, time: 2_000, type: 'tool/result', surfaceOp: 'append',
        data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'reg' }, content: [], isError: false } },
      },
    },
    {
      type: 'event',
      event: {
        seq: 3, time: 3_000, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } },
      },
    },
  ]
}

/** One finished turn, appended after a registration or a working draft. */
function turnEndEntry(seq: number) {
  return {
    type: 'event',
    event: { seq, time: seq * 1_000, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  }
}

/** A session binding whose event window reports `entries` and records its subscribers. */
function sessionBinding(entries: unknown, listeners: Array<() => void>) {
  return {
    eventSource: {
      getSnapshot: () => ({ entries }),
      subscribe: (listener: () => void): (() => void) => {
        listeners.push(listener)
        return () => { listeners.splice(listeners.indexOf(listener), 1) }
      },
    },
  }
}

/** A conversation stub; `input.for` and `setActiveView` default to the inert answer. */
function conversationFace(overrides: Partial<ConversationFace> = {}): ConversationFace {
  return {
    input: { for: () => ({ state: { getSnapshot: () => ({ draft: '' }) }, setDraft: () => {} }) },
    setActiveView: () => false,
    ...overrides,
  }
}

/** Mount the plugin body on a real Context over stub host services. */
async function mount(options: MountOptions = {}) {
  const ctx = new Context()
  const slots = new SlotRegistry(ctx)
  new UiConversation(ctx, { binding: () => undefined } as never)
  slots.register({
    name: 'root',
    children: { 'conversation.view': { kind: 'list', scope: 'session' } },
  }, (_props: { renderSlot?: unknown }) => null)
  const sessionsList = createSnapshotStore<SessionsState>(
    options.sessions ?? { byId: { s1: sessionEntry('s1') } },
  )
  ctx.provide('sessions', {
    list: sessionsList,
    scope: options.scope ?? (() => undefined),
    binding: options.binding ?? (() => undefined),
  } as never)
  if (options.conversation === 'undefined') ctx.provide('conversation', undefined)
  else ctx.provide('conversation', (options.conversation ?? conversationFace()) as never)
  if (options.sidebar !== undefined) ctx.provide('sidebarRight', options.sidebar as never)
  ctx.provide('connection', { isLoopback: options.isLoopback ?? true } as never)
  const remoteSession = { openWorkspacePath: options.openWorkspacePath ?? (() => Promise.resolve({ ok: true })) }
  const remoteWorkspaceFiles = {}
  ctx.provide('remote', { $on: () => () => {}, session: remoteSession, workspaceFiles: remoteWorkspaceFiles } as never)
  ctx.provide('remote.session', remoteSession as never)
  ctx.provide('remote.workspaceFiles', remoteWorkspaceFiles as never)
  ctx.provide('configForms', { get: () => stubConfigForm().scope } as never)
  const locale = await import('@deepseek-ai/dsh-client-locale/client')
  // The plugin injects `locale`; the locale plugin publishes the service on its
  // own activation turn, so wait for it before mounting or that mount stays pending.
  await ctx.plugin({ inject: [...locale.inject], apply: locale.apply }).await()
  const fiber = ctx.plugin({ apply, inject: pluginInject })
  await fiber.await()
  const entry = slots.entries('conversation.view')[0]!
  const face = entry.inject!(SessionId('s1') as never) as InjectedFace
  return { ctx, fiber, slots, sessionsList, entry, face }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('document studio plugin body', () => {
  it('registers the dictionaries, the produced-file targets, and the studio view tab', async () => {
    const { ctx, fiber, slots, entry } = await mount()
    const label = resolveSlotLabel(entry.options.label)
    expect([zh['view.document'], en['view.document']]).toContain(label)
    expect(entry.options.id).toBe('documentDeliverables')
    expect(entry.options.order).toBe(20)
    expect(entry.locale).toBe('documentStudio')
    expect(ctx.uiConversation.views.entries().map(view => view.target)).toEqual(['documentDeliverables'])
    expect(ctx.uiConversation.events.entries().map(event => event.kind)).toContain('documentDeliverables')
    await fiber.dispose()
    expect(slots.entries('conversation.view')).toHaveLength(0)
  })

  it('opens and reveals one produced path through the session remote', async () => {
    const openWorkspacePath = vi.fn((_request: OpenWorkspacePathRequest): Promise<OpenWorkspacePathResult> =>
      Promise.resolve({ ok: true }))
    const { fiber, face } = await mount({ openWorkspacePath })
    await face.openFile('out/report.html')
    expect(openWorkspacePath).toHaveBeenLastCalledWith({ path: '/tmp/w/out/report.html' })
    await face.showInFolder('out/report.html')
    expect(openWorkspacePath).toHaveBeenLastCalledWith({ path: '/tmp/w/out/report.html', action: 'reveal' })
    await fiber.dispose()
  })

  it('rejects with the Host message when it refuses to open the path', async () => {
    const openWorkspacePath = vi.fn((): Promise<OpenWorkspacePathResult> =>
      Promise.resolve({ ok: false, error: { message: 'no application registered' } }))
    const { fiber, face } = await mount({ openWorkspacePath })
    await expect(face.openFile('out/report.pdf')).rejects.toThrow('no application registered')
    await fiber.dispose()
  })

  it('hands a produced path to the sidebar preview when that surface is mounted', async () => {
    const openResource = vi.fn()
    const { fiber, face } = await mount({ sidebar: { openResource } })
    expect(face.canOpenInSidebar).toBe(true)
    expect(face.openInSidebar('out/report.docx')).toBe(true)
    expect(openResource).toHaveBeenCalledWith(fileAddressFor(SessionId('s1'), '/tmp/w', 'out/report.docx'))
    expect(face.resourceAddress('out/report.docx')).toBe(
      fileAddressFor(SessionId('s1'), '/tmp/w', 'out/report.docx'),
    )
    await fiber.dispose()
  })

  it('adopts the preview cap the page was served with', async () => {
    const injected = globalThis as { __DSH_DOCUMENT_STUDIO_CONFIG__?: unknown }
    injected.__DSH_DOCUMENT_STUDIO_CONFIG__ = { htmlPreviewMaxBytes: 4096 }
    try {
      const { fiber, face } = await mount()
      expect(face.htmlPreviewMaxBytes).toBe(4096)
      await fiber.dispose()
    } finally {
      delete injected.__DSH_DOCUMENT_STUDIO_CONFIG__
    }
  })

  it('defaults the preview cap when the page carries no configuration', async () => {
    const { fiber, face } = await mount()
    expect(face.htmlPreviewMaxBytes).toBe(8 * 1024 * 1024)
    await fiber.dispose()
  })

  it('offers no sidebar handoff without that surface, and resolves paths without a workspace root', async () => {
    const openWorkspacePath = vi.fn((_request: OpenWorkspacePathRequest): Promise<OpenWorkspacePathResult> =>
      Promise.resolve({ ok: true }))
    const { fiber, face } = await mount({ sessions: { byId: {} }, openWorkspacePath })
    expect(face.canOpenInSidebar).toBe(false)
    expect(face.openInSidebar('out/report.docx')).toBe(false)
    // An uncatalogued session has no cwd, so the produced path travels unchanged.
    await face.openFile('out/report.html')
    expect(openWorkspacePath).toHaveBeenCalledWith({ path: 'out/report.html' })
    await fiber.dispose()
  })

  it('appends to the session draft, or replaces an empty one', async () => {
    let draft = ''
    const setDraft = vi.fn((text: string) => { draft = text })
    const conversation = conversationFace({
      input: { for: () => ({ state: { getSnapshot: () => ({ draft }) }, setDraft }) },
    })
    const { fiber, face } = await mount({ scope: (id: SessionId) => ({ id }), conversation })
    expect(face.insertDraft('first line')).toBe(true)
    expect(setDraft).toHaveBeenLastCalledWith('first line')
    draft = 'existing draft'
    expect(face.insertDraft('appended')).toBe(true)
    expect(setDraft).toHaveBeenLastCalledWith('existing draft\nappended')
    await fiber.dispose()
  })

  it('reports a draft insert it cannot perform instead of claiming one', async () => {
    const unscoped = await mount({ scope: () => undefined })
    expect(unscoped.face.insertDraft('text')).toBe(false)
    await unscoped.fiber.dispose()

    const withoutService = await mount({ scope: (id: SessionId) => ({ id }), conversation: 'undefined' })
    expect(withoutService.face.insertDraft('text')).toBe(false)
    await withoutService.fiber.dispose()

    const throwing = await mount({
      scope: (id: SessionId) => ({ id }),
      conversation: conversationFace({ input: { for: () => { throw new Error('requires a retained Session scope') } } }),
    })
    expect(throwing.face.insertDraft('text')).toBe(false)
    await throwing.fiber.dispose()
  })

  it('switches a document-preset session to the studio once per session entry', async () => {
    const listeners: Array<() => void> = []
    const setActiveView = vi.fn(() => true)
    const { fiber, sessionsList } = await mount({
      sessions: { byId: { s1: sessionEntry('s1', { preset: 'document', mainView: 1 }) } },
      binding: () => sessionBinding(registeredWindow(), listeners),
      conversation: conversationFace({ setActiveView }),
    })
    expect(setActiveView).toHaveBeenCalledWith(SessionId('s1'), 'documentDeliverables')
    expect(setActiveView).toHaveBeenCalledTimes(1)
    // A later event for the same entry does not switch again.
    listeners[0]!()
    expect(setActiveView).toHaveBeenCalledTimes(1)
    // A catalog update for the same entry does not switch again either.
    sessionsList.update((draft) => { draft.byId.s1!.retainedBy = { mainView: 1 } })
    expect(setActiveView).toHaveBeenCalledTimes(1)
    await fiber.dispose()
  })

  it('waits for the turn to end before taking the screen', async () => {
    const listeners: Array<() => void> = []
    const setActiveView = vi.fn(() => true)
    let entries = registeredWindow().slice(0, -1)
    const { fiber } = await mount({
      sessions: { byId: { s1: sessionEntry('s1', { preset: 'document', mainView: 1 }) } },
      binding: () => sessionBinding(entries, listeners),
      conversation: conversationFace({ setActiveView }),
    })
    // The registration arrived, but the reply is still streaming.
    expect(setActiveView).not.toHaveBeenCalled()
    entries = [...entries, turnEndEntry(3)]
    listeners[0]!()
    expect(setActiveView).toHaveBeenCalledTimes(1)
    await fiber.dispose()
  })

  it('switches for a finished turn that produced only a working draft', async () => {
    const listeners: Array<() => void> = []
    const setActiveView = vi.fn(() => true)
    const draft = [
      {
        type: 'event',
        event: {
          seq: 1, time: 1_000, type: 'tool/call',
          data: {
            turn: 1, step: 1, callId: 'wc', name: 'write',
            arguments: JSON.stringify({ file_path: 'brief.md', content: '# Brief' }),
          },
        },
      },
      {
        type: 'event',
        event: {
          seq: 2, time: 2_000, type: 'tool/result', surfaceOp: 'append',
          data: { turn: 1, step: 1, message: { source: { kind: 'tool', callId: 'wc' }, content: [], isError: false } },
        },
      },
      turnEndEntry(3),
    ]
    const { fiber } = await mount({
      sessions: { byId: { s1: sessionEntry('s1', { preset: 'document', mainView: 1 }) } },
      binding: () => sessionBinding(draft, listeners),
      conversation: conversationFace({ setActiveView }),
    })
    expect(setActiveView).toHaveBeenCalledTimes(1)
    await fiber.dispose()
  })

  it('leaves a non-document session, an unregistered session, and an unbound session alone', async () => {
    const standardListeners: Array<() => void> = []
    const standardSetActiveView = vi.fn(() => true)
    const standard = await mount({
      sessions: { byId: { s1: sessionEntry('s1', { preset: 'standard', mainView: 1 }) } },
      binding: () => sessionBinding(registeredWindow(), standardListeners),
      conversation: conversationFace({ setActiveView: standardSetActiveView }),
    })
    standardListeners[0]!()
    expect(standardSetActiveView).not.toHaveBeenCalled()
    await standard.fiber.dispose()

    const listeners: Array<() => void> = []
    const setActiveView = vi.fn(() => true)
    const unregistered = await mount({
      sessions: { byId: { s1: sessionEntry('s1', { preset: 'document', mainView: 1 }) } },
      binding: () => sessionBinding([], listeners),
      conversation: conversationFace({ setActiveView }),
    })
    expect(setActiveView).not.toHaveBeenCalled()
    await unregistered.fiber.dispose()

    const unbound = await mount({
      sessions: { byId: { s1: sessionEntry('s1', { preset: 'document', mainView: 1 }) } },
      binding: () => undefined,
      conversation: conversationFace({ setActiveView }),
    })
    expect(setActiveView).not.toHaveBeenCalled()
    await unbound.fiber.dispose()
  })

  it('waits when a finished turn produced no deliverable', async () => {
    const listeners: Array<() => void> = []
    const setActiveView = vi.fn(() => true)
    const { fiber } = await mount({
      sessions: { byId: { s1: sessionEntry('s1', { preset: 'document', mainView: 1 }) } },
      binding: () => sessionBinding([turnEndEntry(1)], listeners),
      conversation: conversationFace({ setActiveView }),
    })
    expect(setActiveView).not.toHaveBeenCalled()
    listeners[0]!()
    expect(setActiveView).not.toHaveBeenCalled()
    await fiber.dispose()
  })

  it('stops evaluating a session whose binding goes away', async () => {
    const listeners: Array<() => void> = []
    const setActiveView = vi.fn(() => true)
    let binding: unknown = sessionBinding([], listeners)
    const { fiber } = await mount({
      sessions: { byId: { s1: sessionEntry('s1', { preset: 'document', mainView: 1 }) } },
      binding: () => binding,
      conversation: conversationFace({ setActiveView }),
    })
    expect(setActiveView).not.toHaveBeenCalled()
    binding = undefined
    listeners[0]!()
    expect(setActiveView).not.toHaveBeenCalled()
    await fiber.dispose()
  })

  it('waits for a retained session before watching, and switches when one arrives', async () => {
    const listeners: Array<() => void> = []
    const setActiveView = vi.fn(() => true)
    const { fiber, sessionsList } = await mount({
      sessions: { byId: { s1: sessionEntry('s1', { preset: 'document' }) } },
      binding: () => sessionBinding(registeredWindow(), listeners),
      conversation: conversationFace({ setActiveView }),
    })
    // A catalogued but unretained session is not the current entry.
    expect(setActiveView).not.toHaveBeenCalled()
    sessionsList.update((draft) => { draft.byId.s1!.retainedBy = { mainView: 1 } })
    expect(setActiveView).toHaveBeenCalledTimes(1)
    await fiber.dispose()
  })

  it('switches again when the user re-enters the session', async () => {
    const listeners: Array<() => void> = []
    const setActiveView = vi.fn(() => true)
    const { fiber, sessionsList } = await mount({
      sessions: {
        byId: {
          s1: sessionEntry('s1', { preset: 'document', mainView: 1 }),
          s2: sessionEntry('s2', { preset: 'standard' }),
        },
      },
      binding: () => sessionBinding(registeredWindow(), listeners),
      conversation: conversationFace({ setActiveView }),
    })
    expect(setActiveView).toHaveBeenCalledTimes(1)
    // Moving to another session drops the watch for the first one.
    sessionsList.update((draft) => {
      draft.byId.s1!.retainedBy = {}
      draft.byId.s2!.retainedBy = { mainView: 1 }
    })
    expect(setActiveView).toHaveBeenCalledTimes(1)
    // Re-entering the document session starts a new visit.
    sessionsList.update((draft) => {
      draft.byId.s2!.retainedBy = {}
      draft.byId.s1!.retainedBy = { mainView: 1 }
    })
    expect(setActiveView).toHaveBeenCalledTimes(2)
    await fiber.dispose()
  })

  it('retries the switch until the setter reports success', async () => {
    vi.useFakeTimers()
    const setActiveView = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
    const { fiber } = await mount({
      sessions: { byId: { s1: sessionEntry('s1', { preset: 'document', mainView: 1 }) } },
      binding: () => sessionBinding(registeredWindow(), []),
      conversation: conversationFace({ setActiveView }),
    })
    expect(setActiveView).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(150)
    expect(setActiveView).toHaveBeenCalledTimes(2)
    // Success closes the retry window: no further attempt follows.
    vi.advanceTimersByTime(1_000)
    expect(setActiveView).toHaveBeenCalledTimes(2)
    await fiber.dispose()
  })

  it('gives up on the setter after the retry cap', async () => {
    vi.useFakeTimers()
    const setActiveView = vi.fn(() => false)
    const { fiber } = await mount({
      sessions: { byId: { s1: sessionEntry('s1', { preset: 'document', mainView: 1 }) } },
      binding: () => sessionBinding(registeredWindow(), []),
      conversation: conversationFace({ setActiveView }),
    })
    expect(setActiveView).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(150 * 40)
    expect(setActiveView).toHaveBeenCalledTimes(21)
    await fiber.dispose()
  })

  it('gives up when the session leaves during the retry window', async () => {
    vi.useFakeTimers()
    const setActiveView = vi.fn(() => false)
    const { fiber, sessionsList } = await mount({
      sessions: { byId: { s1: sessionEntry('s1', { preset: 'document', mainView: 1 }) } },
      binding: () => sessionBinding(registeredWindow(), []),
      conversation: conversationFace({ setActiveView }),
    })
    // The leave tears the window down through the catalog subscription.
    sessionsList.update((draft) => { draft.byId.s1!.retainedBy = {} })
    vi.advanceTimersByTime(1_000)
    expect(setActiveView).toHaveBeenCalledTimes(1)
    await fiber.dispose()
  })

  it('does not retry a window the catalog closed while the setter was running', async () => {
    vi.useFakeTimers()
    const setActiveView = vi.fn(() => false)
    const { fiber, sessionsList } = await mount({
      sessions: { byId: { s1: sessionEntry('s1', { preset: 'document', mainView: 1 }) } },
      binding: () => sessionBinding(registeredWindow(), []),
      conversation: conversationFace({ setActiveView }),
    })
    // The setter's own catalog update leaves the session mid-attempt.
    setActiveView.mockImplementation(() => {
      sessionsList.update((draft) => { draft.byId.s1!.retainedBy = {} })
      return false
    })
    vi.advanceTimersByTime(150)
    expect(setActiveView).toHaveBeenCalledTimes(2)
    // The queued tick finds the window closed instead of retrying the left session.
    vi.advanceTimersByTime(1_000)
    expect(setActiveView).toHaveBeenCalledTimes(2)
    await fiber.dispose()
  })

  it('keeps the view registered when the session has no conversation service to switch', async () => {
    vi.useFakeTimers()
    const { fiber, slots } = await mount({
      sessions: { byId: { s1: sessionEntry('s1', { preset: 'document', mainView: 1 }) } },
      binding: () => sessionBinding(registeredWindow(), []),
      conversation: 'undefined',
    })
    // The retry window runs out against a service that never arrives; the tab
    // itself stays usable because the switch is the only part it cannot do.
    vi.advanceTimersByTime(5_000)
    expect(slots.entries('conversation.view')).toHaveLength(1)
    await fiber.dispose()
    expect(slots.entries('conversation.view')).toHaveLength(0)
  })
})
