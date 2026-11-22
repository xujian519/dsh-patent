// @vitest-environment jsdom
// @vitest-environment-options {"url": "http://127.0.0.1:3080/"}
/**
 * Synapse browser half: the switch/overlay DOM, the iframe bridge RPC surface,
 * the coalesced session sync, current-session selection by main-view retention,
 * live-reply fan-out, the theme follow, and disposal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyHost } from '../src/index.ts'

// jsdom iframes ship a null-origin contentWindow whose postMessage rejects the
// 'null' target; point the iframe at the parent window so the bridge sends are
// observable and never throw in the fake environment.
Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
  configurable: true,
  get: () => window,
})

/** One catalog row the fake sessions store projects. */
interface SessionRowState {
  id: string
  displayTitle: string
  cwd?: string
  parentId?: string
  blank: boolean
  retainedBy: Record<string, number>
}

/** Catalog row with the shape the bridge reads, overridable per case. */
function sessionRow(overrides: Partial<SessionRowState> & { id: string }): SessionRowState {
  return { displayTitle: overrides.id, blank: false, retainedBy: {}, ...overrides }
}

/** One workspace row the fake registry projects. */
interface WorkspaceRowState {
  workspaceId: string
  title: string
  path: string
  sessionIds: string[]
}

/** Workspace service list: rows replaced wholesale the way a registry refresh does. */
class FakeWorkspaceList {
  items: WorkspaceRowState[] = []
  private readonly listeners = new Set<() => void>()

  getSnapshot(): { items: WorkspaceRowState[]; archivedSessionIds: string[] } {
    return { items: this.items, archivedSessionIds: [] }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  listenerCount(): number { return this.listeners.size }

  replace(items: WorkspaceRowState[]): void {
    this.items = items
    for (const listener of [...this.listeners]) listener()
  }
}

/** Session list store: `ids`/`byId` stay derived from one row array. */
class FakeSessionList {
  rows: SessionRowState[] = []
  private readonly listeners = new Set<() => void>()

  getSnapshot(): { ids: string[]; byId: Record<string, SessionRowState> } {
    return {
      ids: this.rows.map(row => row.id),
      byId: Object.fromEntries(this.rows.map(row => [row.id, row])),
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  listenerCount(): number { return this.listeners.size }

  replace(rows: SessionRowState[]): void {
    this.rows = rows
    for (const listener of [...this.listeners]) listener()
  }
}

/** Live session face: prompt results, running state, and one subscriber set. */
interface PromptResult {
  ok: boolean
  error?: { code?: string; message: string }
}

type PromptMock = ReturnType<typeof vi.fn<(content: unknown, mode: string) => Promise<PromptResult>>>

interface FakeFace {
  running: boolean
  prompt: PromptMock
  listeners: Set<() => void>
  getSnapshot(): { running: boolean }
  subscribe(listener: () => void): () => void
  emit(): void
}

function makeFace(): FakeFace {
  const listeners = new Set<() => void>()
  const face: FakeFace = {
    running: false,
    prompt: vi.fn<(content: unknown, mode: string) => Promise<PromptResult>>(async () => ({ ok: true })),
    listeners,
    getSnapshot: () => ({ running: face.running }),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    emit: () => { for (const listener of [...listeners]) listener() },
  }
  return face
}

type CreateMock = ReturnType<typeof vi.fn<(opts?: { workspaceId?: string; cwd?: string }) => Promise<string>>>
type ForkOptions = { sessionId: string; atSeq?: number; increaseTitle?: boolean }
type ForkMock = ReturnType<typeof vi.fn<(opts: ForkOptions) => Promise<string>>>
type OpenSessionMock = ReturnType<typeof vi.fn<(id: string) => void>>

interface Runtime {
  sessions: {
    list: FakeSessionList
    create: CreateMock
    fork: ForkMock
    scope(id: string): { id: string } | undefined
    sessionOf(scope: unknown): FakeFace | undefined
  }
  workspaces: { list: FakeWorkspaceList }
  uiWorkspace: { openSession: OpenSessionMock }
  faces: Map<string, FakeFace>
  scopes: Map<string, { id: string }>
  effects: Array<() => void>
  dispose(): void
}

function makeRuntime(): Runtime {
  const list = new FakeSessionList()
  const faces = new Map<string, FakeFace>()
  const scopes = new Map<string, { id: string }>()
  const effects: Array<() => void> = []
  return {
    sessions: {
      list,
      create: vi.fn<(opts?: { workspaceId?: string; cwd?: string }) => Promise<string>>(async () => 's-new'),
      fork: vi.fn<(opts: { sessionId: string; atSeq?: number; increaseTitle?: boolean }) => Promise<string>>(
        async () => 'child-1',
      ),
      scope: id => scopes.get(id),
      sessionOf: scope => faces.get((scope as { id: string }).id),
    },
    workspaces: { list: new FakeWorkspaceList() },
    uiWorkspace: { openSession: vi.fn<(id: string) => void>() },
    faces,
    scopes,
    effects,
    dispose: () => { for (const effect of effects.reverse()) effect(); effects.length = 0 },
  }
}

let booted: Runtime[] = []
let fetchMock: ReturnType<typeof vi.fn<(url: string, init: RequestInit) => Promise<unknown>>>
let sentMessages: Record<string, unknown>[] = []
let pendingFrames: FrameRequestCallback[] = []

/** Boot the plugin over a fresh runtime; `runtime` is reusable for pre-seeded state. */
function boot(runtime: Runtime = makeRuntime()): Runtime {
  booted.push(runtime)
  apply({
    sessions: runtime.sessions,
    workspaces: runtime.workspaces,
    uiWorkspace: runtime.uiWorkspace,
    effect: (body: () => unknown) => {
      const result = body()
      if (typeof result === 'function') runtime.effects.push(result as () => void)
    },
  } as never)
  return runtime
}

function host(): HTMLElement {
  const node = document.querySelector('.dsh-synapse-host')
  if (node === null) throw new Error('synapse host is not mounted')
  return node as HTMLElement
}

function overlay(): HTMLElement {
  return host().querySelector('.dsh-synapse-overlay') as HTMLElement
}

function frame(): HTMLIFrameElement {
  return host().querySelector('iframe') as HTMLIFrameElement
}

function switchButton(view: 'dialog' | 'map'): HTMLButtonElement {
  return host().querySelector(`[data-view="${view}"]`) as HTMLButtonElement
}

function switchBox(): HTMLElement {
  return host().querySelector('.dsh-synapse-switch') as HTMLElement
}

/** Box the conversation tab row reports to the switch placement. */
interface TabRowBox { top: number; right: number; width: number; height: number }

function tabRowRect(box: TabRowBox): DOMRect {
  return {
    x: box.right - box.width,
    y: box.top,
    top: box.top,
    right: box.right,
    bottom: box.top + box.height,
    left: box.right - box.width,
    width: box.width,
    height: box.height,
    toJSON: () => box,
  }
}

/** Mount the conversation tab row (`data-conversation-tabs`) the switch anchors to. */
function mountTabRow(box: TabRowBox): HTMLElement {
  const row = document.createElement('div')
  row.setAttribute('data-conversation-tabs', '')
  row.getBoundingClientRect = () => tabRowRect(box)
  document.body.append(row)
  return row
}

/** Mount the Session surface (`data-conversation-session`) the blank-Session fallback uses. */
function mountSessionContent(box: TabRowBox): HTMLElement {
  const content = document.createElement('div')
  content.setAttribute('data-conversation-session', 's-1')
  content.getBoundingClientRect = () => tabRowRect(box)
  document.body.append(content)
  return content
}

/** Give the switch a laid-out box, which jsdom reports as zero for every element. */
function stubSwitchBox(width: number, height: number): void {
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(width)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(height)
}

/** ResizeObserver stand-in: records the targets it watches and can fire a resize. */
class FakeResizeObserver {
  static readonly instances: FakeResizeObserver[] = []
  readonly observed = new Set<Element>()
  disconnected = false
  private readonly notify: (entries: ResizeObserverEntry[]) => void

  constructor(notify: (entries: ResizeObserverEntry[]) => void) {
    this.notify = notify
    FakeResizeObserver.instances.push(this)
  }

  observe(target: Element): void { this.observed.add(target) }
  unobserve(target: Element): void { this.observed.delete(target) }
  disconnect(): void { this.disconnected = true; this.observed.clear() }
  fire(entries: ResizeObserverEntry[] = []): void { this.notify(entries) }
}

/** One delivered border box. A positive size must not make placement read layout. */
function sizeEntry(target: Element, inlineSize: number, blockSize: number): ResizeObserverEntry {
  const size = { inlineSize, blockSize }
  return {
    target,
    borderBoxSize: [size],
    contentBoxSize: [size],
    devicePixelContentBoxSize: [size],
    contentRect: new DOMRectReadOnly(0, 0, inlineSize, blockSize),
  }
}

const ANCHOR_NAME = '--dsh-synapse-switch'

function expectAnchored(kind: 'row' | 'content', anchor: Element): void {
  if (!(anchor instanceof HTMLElement)) throw new Error('anchor is not an element')
  const box = switchBox()
  expect(box.classList.contains(kind === 'row' ? 'is-anchored-row' : 'is-anchored-content')).toBe(true)
  expect(box.classList.contains('is-holding')).toBe(false)
  expect(anchor.style.getPropertyValue('anchor-name')).toBe(ANCHOR_NAME)
  expect(box.style.left).toBe('')
  expect(box.style.top).toBe('')
  expect(box.style.right).toBe('')
}

function expectCorner(): void {
  const box = switchBox()
  expect(box.classList.contains('is-anchored-row')).toBe(false)
  expect(box.classList.contains('is-anchored-content')).toBe(false)
  expect(box.classList.contains('is-holding')).toBe(false)
  expect(box.style.left).toBe('')
  expect(box.style.top).toBe('')
  expect(box.style.right).toBe('')
}

/** Run the callbacks the plugin queued through requestAnimationFrame. */
function flushFrames(): void {
  const callbacks = pendingFrames
  pendingFrames = []
  for (const callback of callbacks) callback(0)
}

/** One message the canvas iframe sends to the plugin. */
function fromCanvas(type: string, payload: Record<string, unknown> = {}, origin = window.location.origin): void {
  window.dispatchEvent(new MessageEvent('message', {
    origin,
    data: { source: 'dsh-synapse', type, ...payload },
  }))
}

function sent(type: string): Record<string, unknown>[] {
  return sentMessages.filter(data => data.type === type)
}

function lastSent(type: string): Record<string, unknown> | undefined {
  return sent(type).at(-1)
}

interface SyncBody {
  sessions: Array<{ id: string; title: string; cwd: string | null; parentId?: string; blank: boolean }>
  removedSessionIds: string[]
}

function syncBodies(): SyncBody[] {
  return fetchMock.mock.calls.map(call => JSON.parse(call[1].body as string) as SyncBody)
}

const macrotask = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })
const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 10) })

beforeEach(() => {
  fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<unknown>>(async () => ({ ok: true }))
  vi.stubGlobal('fetch', fetchMock)
  sentMessages = []
  vi.stubGlobal('postMessage', (message: unknown) => { sentMessages.push(message as Record<string, unknown>) })
  pendingFrames = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    pendingFrames.push(callback)
    return pendingFrames.length
  })
})

afterEach(() => {
  for (const runtime of booted.reverse()) runtime.dispose()
  booted = []
  document.querySelectorAll('.dsh-synapse-host').forEach((node) => { node.remove() })
  document.querySelectorAll('style').forEach((node) => { node.remove() })
  document.body.removeAttribute('data-ds-dark-theme')
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('synapse browser half wiring', () => {
  it('declares the session, workspace, and UI-workspace services it binds', () => {
    expect(inject).toEqual(['sessions', 'workspaces', 'uiWorkspace'])
  })

  it('mounts the 对话/会话地图 switch, a hidden map overlay, and the /synapse/ iframe', () => {
    boot()
    const buttons = host().querySelectorAll('.dsh-synapse-switch button')
    expect(buttons).toHaveLength(2)
    expect(switchButton('dialog').textContent).toBe('对话')
    expect(switchButton('dialog').getAttribute('aria-pressed')).toBe('true')
    expect(switchButton('map').textContent).toBe('会话地图')
    expect(switchButton('map').getAttribute('aria-pressed')).toBe('false')
    expect(overlay().hidden).toBe(true)
    expect(frame().getAttribute('src')).toBe('/synapse/')
    expect(document.head.querySelector('style')?.textContent).toContain('.dsh-synapse-switch')
  })

  it('removes its host and stylesheet when the environment drops the injected markup', () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, 'innerHTML')
    // A sanitizing environment keeps the host element but discards its HTML.
    Object.defineProperty(HTMLDivElement.prototype, 'innerHTML', {
      configurable: true,
      get: () => '',
      set: () => {},
    })
    try {
      expect(() => { boot() }).toThrow('synapse: failed to build the map switch DOM')
    } finally {
      if (descriptor === undefined) delete (HTMLDivElement.prototype as { innerHTML?: unknown }).innerHTML
      else Object.defineProperty(HTMLDivElement.prototype, 'innerHTML', descriptor)
    }
    expect(document.querySelector('.dsh-synapse-host')).toBeNull()
    expect(document.querySelector('.dsh-synapse-switch')).toBeNull()
    expect(document.head.querySelector('style')).toBeNull()
  })

  it('keeps the node half inert, so the Loader row carries no host behavior', () => {
    expect(applyHost).not.toThrow()
  })
})

describe('synapse canvas bridge', () => {
  it('reports the first session the main view retains, with its title and cwd', () => {
    const runtime = boot()
    runtime.sessions.list.replace([
      sessionRow({ id: 's-1', displayTitle: '未保留' }),
      sessionRow({ id: 's-2', displayTitle: '修复登录', cwd: '/work/login', retainedBy: { mainView: 1 } }),
      sessionRow({ id: 's-3', displayTitle: '后开的主视图', retainedBy: { mainView: 2 } }),
    ])
    fromCanvas('synapse:request-current')
    expect(lastSent('synapse:current-session')).toEqual({
      source: 'dsh-synapse',
      type: 'synapse:current-session',
      session: { id: 's-2', title: '修复登录', cwd: '/work/login' },
    })
  })

  it('reports no current session while nothing is retained by the main view', () => {
    const runtime = boot()
    runtime.sessions.list.replace([
      sessionRow({ id: 's-1' }),
      sessionRow({ id: 's-2', displayTitle: '侧边列出的会话', retainedBy: {} }),
    ])
    fromCanvas('synapse:request-current')
    expect(lastSent('synapse:current-session')?.session).toBeNull()
  })

  it('follows a later retention change and reports a session without a directory as null', () => {
    const runtime = boot()
    runtime.sessions.list.replace([
      sessionRow({ id: 's-1', displayTitle: '修复登录', cwd: '/work/login', retainedBy: { mainView: 1 } }),
    ])
    fromCanvas('synapse:request-current')
    expect(lastSent('synapse:current-session')?.session).toEqual({ id: 's-1', title: '修复登录', cwd: '/work/login' })

    runtime.sessions.list.replace([
      sessionRow({ id: 's-1', displayTitle: '修复登录', cwd: '/work/login' }),
      sessionRow({ id: 's-2', displayTitle: '无目录', retainedBy: { mainView: 1 } }),
    ])
    fromCanvas('synapse:request-current')
    expect(lastSent('synapse:current-session')?.session).toEqual({ id: 's-2', title: '无目录', cwd: null })
  })

  it('lists every workspace plus the ungrouped tail when the canvas asks for its first paint', () => {
    const runtime = boot()
    runtime.sessions.list.replace([
      sessionRow({ id: 's-1' }),
      sessionRow({ id: 's-2' }),
      sessionRow({ id: 's-3' }),
    ])
    runtime.workspaces.list.replace([
      { workspaceId: 'w-1', title: '登录修复', path: '/work/login', sessionIds: ['s-1', 's-2'] },
      { workspaceId: 'w-2', title: '空工作区', path: '/work/empty', sessionIds: [] },
    ])
    fromCanvas('synapse:request-current')
    expect(lastSent('synapse:workspaces')?.workspaces).toEqual([
      { id: 'w-1', title: '登录修复', path: '/work/login', sessionIds: ['s-1', 's-2'] },
      { id: 'w-2', title: '空工作区', path: '/work/empty', sessionIds: [] },
      { id: 'dsh-ungrouped', title: '未分组', path: null, sessionIds: ['s-3'] },
    ])
  })

  it('sends the session list — parent link, blank bit, and null directory included — after the debounce', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const runtime = boot()
    runtime.sessions.list.replace([
      sessionRow({ id: 's-1', displayTitle: '主线', cwd: '/work/a', blank: true }),
      sessionRow({ id: 's-2', displayTitle: '分支', parentId: 's-1' }),
    ])
    expect(fetchMock).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(fetchMock).toHaveBeenCalledWith('/synapse/api/sessions/sync', expect.objectContaining({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }))
    expect(syncBodies()).toEqual([{
      sessions: [
        { id: 's-1', title: '主线', cwd: '/work/a', blank: true },
        { id: 's-2', title: '分支', cwd: null, parentId: 's-1', blank: false },
      ],
      removedSessionIds: [],
    }])
  })

  it('coalesces a burst of list churn into one sync and reports the sessions it dropped', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const runtime = boot()
    runtime.sessions.list.replace([sessionRow({ id: 's-1' })])
    vi.advanceTimersByTime(300)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    runtime.sessions.list.replace([sessionRow({ id: 's-1' }), sessionRow({ id: 's-2' })])
    runtime.sessions.list.replace([sessionRow({ id: 's-1' }), sessionRow({ id: 's-2' }), sessionRow({ id: 's-3' })])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(300)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(syncBodies()[1]!.sessions.map(session => session.id)).toEqual(['s-1', 's-2', 's-3'])

    runtime.sessions.list.replace([sessionRow({ id: 's-1' })])
    vi.advanceTimersByTime(300)
    expect(syncBodies()[2]!.removedSessionIds).toEqual(['s-2', 's-3'])
  })

  it('keeps syncing after a failed POST instead of losing the bridge', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fetchMock.mockRejectedValueOnce(new Error('net::ERR_INSUFFICIENT_RESOURCES'))
    const runtime = boot()
    runtime.sessions.list.replace([sessionRow({ id: 's-1' })])
    vi.advanceTimersByTime(300)
    await Promise.resolve()
    await Promise.resolve()

    runtime.sessions.list.replace([sessionRow({ id: 's-1' }), sessionRow({ id: 's-2' })])
    vi.advanceTimersByTime(300)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(syncBodies()[1]!.sessions.map(session => session.id)).toEqual(['s-1', 's-2'])
  })
})

describe('synapse live replies', () => {
  it('streams replies only while the map is open and releases the sessions it dropped', () => {
    const runtime = boot()
    const first = makeFace()
    runtime.faces.set('s-1', first)
    runtime.scopes.set('s-1', { id: 's-1' })
    runtime.sessions.list.replace([sessionRow({ id: 's-1' })])
    expect(sent('synapse:live-reply')).toHaveLength(0)

    switchButton('map').click()
    flushFrames()
    first.running = true
    first.emit()
    expect(lastSent('synapse:live-reply')).toEqual({
      source: 'dsh-synapse',
      type: 'synapse:live-reply',
      sessionId: 's-1',
      running: true,
      text: '',
    })

    switchButton('dialog').click()
    first.running = false
    first.emit()
    expect(sent('synapse:live-reply')).toHaveLength(1)

    switchButton('map').click()
    const late = makeFace()
    runtime.faces.set('s-2', late)
    runtime.scopes.set('s-2', { id: 's-2' })
    runtime.sessions.list.replace([sessionRow({ id: 's-1' }), sessionRow({ id: 's-2' })])
    expect(lastSent('synapse:live-reply')).toEqual({
      source: 'dsh-synapse',
      type: 'synapse:live-reply',
      sessionId: 's-2',
      running: false,
      text: '',
    })

    runtime.sessions.list.replace([sessionRow({ id: 's-2' })])
    expect(first.listeners.size).toBe(0)
    first.emit()
    expect(sent('synapse:live-reply')).toHaveLength(2)
  })

  it('skips sessions that have no live scope or no session face', () => {
    const runtime = boot()
    runtime.scopes.set('s-1', { id: 's-1' })
    runtime.sessions.list.replace([sessionRow({ id: 's-1' }), sessionRow({ id: 's-2' })])
    switchButton('map').click()
    flushFrames()
    expect(sent('synapse:live-reply')).toHaveLength(0)
  })
})

describe('synapse switch placement', () => {
  afterEach(() => {
    document.querySelectorAll('[data-conversation-tabs]').forEach((node) => { node.remove() })
    document.querySelectorAll('[data-conversation-tab-row]').forEach((node) => { node.remove() })
    document.querySelectorAll('[data-conversation-session]').forEach((node) => { node.remove() })
  })

  it('parks the switch at the right end of the conversation tab row', () => {
    stubSwitchBox(150, 36)
    const row = mountTabRow({ top: 50, right: 1180, width: 1180, height: 26 })
    boot()
    expectAnchored('row', row)
    expect(document.head.querySelector('style')?.textContent).toContain('right:anchor(right);bottom:anchor(bottom)')
  })

  it('anchors to the full tab row rather than the tablist inside it', () => {
    stubSwitchBox(150, 36)
    const row = document.createElement('div')
    row.setAttribute('data-conversation-tab-row', '')
    row.getBoundingClientRect = () => tabRowRect({ top: 50, right: 1180, width: 1180, height: 26 })
    const tabs = document.createElement('div')
    tabs.setAttribute('data-conversation-tabs', '')
    tabs.getBoundingClientRect = () => tabRowRect({ top: 50, right: 600, width: 600, height: 26 })
    row.append(tabs)
    document.body.append(row)

    boot()

    expectAnchored('row', row)
    expect(tabs.style.getPropertyValue('anchor-name')).toBe('')
  })

  it('parks below the header on a blank Session without a tab row', () => {
    stubSwitchBox(150, 36)
    const content = mountSessionContent({ top: 40, right: 792, width: 512, height: 960 })

    boot()

    expectAnchored('content', content)
    expect(document.head.querySelector('style')?.textContent).toContain('top:calc(anchor(top) + 40px)')
  })

  it('re-observes a replaced Session surface and releases one that unmounts', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      stubSwitchBox(150, 36)
      FakeResizeObserver.instances.length = 0
      vi.stubGlobal('ResizeObserver', FakeResizeObserver)
      const first = mountSessionContent({ top: 40, right: 792, width: 512, height: 960 })
      boot()
      const observer = FakeResizeObserver.instances[0]!
      expect(observer.observed.has(first)).toBe(true)

      // The Session view replaces its surface node; the next placement stops
      // watching the detached node and follows the replacement.
      const second = mountSessionContent({ top: 40, right: 900, width: 600, height: 960 })
      first.remove()
      window.dispatchEvent(new Event('resize'))
      flushFrames()
      expect(observer.observed.has(first)).toBe(false)
      expect(observer.observed.has(second)).toBe(true)
      expectAnchored('content', second)
      expect(first.style.getPropertyValue('anchor-name')).toBe('')

      // Without any Session surface the transient retry expires, the switch
      // returns to the stylesheet corner, and the detached node is released.
      second.remove()
      window.dispatchEvent(new Event('resize'))
      flushFrames()
      for (let attempt = 0; attempt < 20; attempt += 1) {
        flushFrames()
        vi.advanceTimersByTime(50)
      }
      flushFrames()
      expect(observer.observed.has(second)).toBe(false)
      expectCorner()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps its placement while the row is replaced between frames', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      stubSwitchBox(150, 36)
      const row = mountTabRow({ top: 50, right: 1180, width: 1180, height: 26 })
      boot()
      expectAnchored('row', row)

      switchBox().getBoundingClientRect = () => tabRowRect({ top: 40, right: 1180, width: 150, height: 36 })
      row.remove()
      window.dispatchEvent(new Event('resize'))
      flushFrames()
      expect(switchBox().classList.contains('is-holding')).toBe(true)
      expect(switchBox().style.left).toBe('1030px')
      expect(switchBox().style.top).toBe('40px')

      const next = mountTabRow({ top: 50, right: 900, width: 900, height: 26 })
      vi.advanceTimersByTime(50)
      flushFrames()
      expectAnchored('row', next)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the stylesheet corner while the surface publishes no tab row', () => {
    stubSwitchBox(150, 36)
    boot()
    expectCorner()
    expect(document.head.querySelector('style')?.textContent)
      .toContain('.dsh-synapse-switch{position:fixed;z-index:80;top:40px;right:28px')
  })

  it('returns to the stylesheet corner when the row collapses on either axis', () => {
    stubSwitchBox(150, 36)
    const row = mountTabRow({ top: 50, right: 1180, width: 1180, height: 26 })
    boot()
    expectAnchored('row', row)

    row.getBoundingClientRect = () => tabRowRect({ top: 0, right: 0, width: 0, height: 26 })
    window.dispatchEvent(new Event('resize'))
    flushFrames()
    expectCorner()
    expect(row.style.getPropertyValue('anchor-name')).toBe('')

    row.getBoundingClientRect = () => tabRowRect({ top: 50, right: 1180, width: 1180, height: 26 })
    window.dispatchEvent(new Event('resize'))
    flushFrames()
    expectAnchored('row', row)

    row.getBoundingClientRect = () => tabRowRect({ top: 0, right: 0, width: 1180, height: 0 })
    window.dispatchEvent(new Event('resize'))
    flushFrames()
    expectCorner()
  })

  it('coalesces a resize burst into a single placement frame', () => {
    stubSwitchBox(150, 36)
    const row = mountTabRow({ top: 50, right: 1180, width: 1180, height: 26 })
    boot()
    let reads = 0
    row.getBoundingClientRect = () => {
      reads += 1
      return tabRowRect({ top: 50, right: 1000, width: 1000, height: 26 })
    }
    window.dispatchEvent(new Event('resize'))
    window.dispatchEvent(new Event('resize'))
    expect(reads).toBe(0)

    flushFrames()
    expect(reads).toBe(1)
    expectAnchored('row', row)
  })

  it('follows a session change without waiting for a resize', () => {
    stubSwitchBox(150, 36)
    const row = mountTabRow({ top: 50, right: 1180, width: 1180, height: 26 })
    const runtime = boot()
    let reads = 0
    row.getBoundingClientRect = () => {
      reads += 1
      return tabRowRect({ top: 50, right: 1000, width: 1000, height: 26 })
    }
    runtime.sessions.list.replace([sessionRow({ id: 's-1' })])
    expect(reads).toBe(0)
    flushFrames()
    expect(reads).toBe(1)
    expectAnchored('row', row)
  })

  it('places the switch when the environment has no ResizeObserver', () => {
    // `scripts/test-dom-environment.ts` installs a default ResizeObserver in
    // jsdom, so the absent case is stated here rather than inherited.
    stubSwitchBox(150, 36)
    const row = mountTabRow({ top: 50, right: 1180, width: 1180, height: 26 })
    vi.stubGlobal('ResizeObserver', undefined)
    boot()
    expectAnchored('row', row)

    row.getBoundingClientRect = () => tabRowRect({ top: 0, right: 0, width: 0, height: 26 })
    window.dispatchEvent(new Event('resize'))
    flushFrames()
    expectCorner()
  })

  it('watches the tab row so a column respan moves the switch without a window resize', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    stubSwitchBox(150, 36)
    FakeResizeObserver.instances.length = 0
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    const first = mountTabRow({ top: 50, right: 1180, width: 1180, height: 26 })
    const runtime = boot()
    const observer = FakeResizeObserver.instances[0]!
    expect(observer.observed.has(first)).toBe(true)

    // The Session view replaces the row node; the next placement re-observes it.
    const second = mountTabRow({ top: 50, right: 900, width: 900, height: 26 })
    first.remove()
    runtime.sessions.list.replace([sessionRow({ id: 's-1' })])
    flushFrames()
    expect(observer.observed.has(first)).toBe(false)
    expect(observer.observed.has(second)).toBe(true)
    expectAnchored('row', second)

    // A positive respan is delivered by the observer and must not read layout.
    const reads = vi.spyOn(second, 'getBoundingClientRect')
    observer.fire([sizeEntry(second, 900, 26)])
    flushFrames()
    expect(reads).not.toHaveBeenCalled()
    expectAnchored('row', second)

    // Losing the row (no Session view) retries the transient replacement,
    // then falls back and stops watching it.
    second.remove()
    observer.fire()
    for (let attempt = 0; attempt < 20; attempt += 1) {
      flushFrames()
      vi.advanceTimersByTime(50)
    }
    flushFrames()
    expect(observer.observed.size).toBe(0)
    expectCorner()

    runtime.dispose()
    vi.useRealTimers()
    expect(observer.disconnected).toBe(true)
  })

  it('drops the resize listener and the pending placement frame on disposal', () => {
    stubSwitchBox(150, 36)
    const row = mountTabRow({ top: 50, right: 1180, width: 1180, height: 26 })
    const runtime = boot()
    const box = switchBox()
    row.getBoundingClientRect = () => tabRowRect({ top: 50, right: 900, width: 900, height: 26 })
    window.dispatchEvent(new Event('resize'))
    const cancel = vi.spyOn(window, 'cancelAnimationFrame')

    runtime.dispose()
    expect(cancel).toHaveBeenCalledWith(1)
    // The stubbed scheduler never learns of the cancellation, so drop the
    // callback it still holds before proving the listener is gone too.
    pendingFrames = []
    expect(box.classList.contains('is-anchored-row')).toBe(true)
    expect(row.style.getPropertyValue('anchor-name')).toBe('')

    window.dispatchEvent(new Event('resize'))
    flushFrames()
    expect(box.classList.contains('is-anchored-row')).toBe(true)
    expect(document.querySelector('.dsh-synapse-host')).toBeNull()
  })

  it('disposes a switch that never scheduled a placement frame', () => {
    stubSwitchBox(150, 36)
    const runtime = boot()
    runtime.dispose()
    expect(document.querySelector('.dsh-synapse-host')).toBeNull()
  })
})

describe('synapse map overlay lifecycle', () => {
  it('lays the iframe out while opening, announces the open on the next frame, and falls back after 300ms', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    boot()
    switchButton('map').click()
    expect(overlay().hidden).toBe(false)
    expect(overlay().classList.contains('is-opening')).toBe(true)
    expect(switchButton('map').classList.contains('active')).toBe(true)
    expect(switchButton('map').getAttribute('aria-pressed')).toBe('true')
    expect(switchButton('dialog').classList.contains('active')).toBe(false)

    flushFrames()
    expect(sent('synapse:map-opened')).toHaveLength(1)
    vi.advanceTimersByTime(300)
    expect(overlay().classList.contains('is-opening')).toBe(false)
    expect(overlay().hidden).toBe(false)
  })

  it('re-announces the open when the iframe loads mid-open, then only re-syncs', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    boot()
    switchButton('map').click()
    frame().dispatchEvent(new Event('load'))
    expect(sent('synapse:map-opened')).toHaveLength(1)
    frame().dispatchEvent(new Event('load'))
    expect(sent('synapse:map-opened')).toHaveLength(2)

    vi.advanceTimersByTime(300)
    const syncsBefore = sent('synapse:current-session').length
    frame().dispatchEvent(new Event('load'))
    expect(sent('synapse:map-opened')).toHaveLength(2)
    expect(sent('synapse:current-session')).toHaveLength(syncsBefore + 1)
  })

  it('treats synapse:map-ready from the canvas as the open handshake', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    boot()
    switchButton('map').click()
    expect(overlay().classList.contains('is-opening')).toBe(true)
    fromCanvas('synapse:map-ready')
    expect(overlay().classList.contains('is-opening')).toBe(false)
    expect(overlay().hidden).toBe(false)
  })

  it('cancels the opening fallback when the canvas closes first', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    boot()
    switchButton('map').click()
    fromCanvas('synapse:close')
    expect(overlay().hidden).toBe(true)
    expect(overlay().classList.contains('is-opening')).toBe(false)
    expect(switchButton('dialog').getAttribute('aria-pressed')).toBe('true')

    frame().dispatchEvent(new Event('load'))
    expect(sent('synapse:map-opened')).toHaveLength(0)
    vi.advanceTimersByTime(1000)
    expect(overlay().hidden).toBe(true)
  })

  it('releases the opening fallback when the plugin disposes mid-open', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const runtime = boot()
    switchButton('map').click()
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    runtime.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('closes on Escape only while the map is showing', () => {
    boot()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(overlay().hidden).toBe(true)

    switchButton('map').click()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g' }))
    expect(overlay().hidden).toBe(false)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(overlay().hidden).toBe(true)
  })

  it('ignores messages that are neither same-origin nor from its canvas', () => {
    const runtime = boot()
    fromCanvas('synapse:open-session', { sessionId: 's-9' }, 'http://canvas.example')
    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { source: 'dsh-other', type: 'synapse:open-session', sessionId: 's-9' },
    }))
    expect(runtime.uiWorkspace.openSession).not.toHaveBeenCalled()
    expect(sentMessages).toEqual([])
  })
})

describe('synapse canvas requests', () => {
  it('opens the session the canvas selected and closes the map behind it', () => {
    const runtime = boot()
    switchButton('map').click()
    fromCanvas('synapse:open-session', { sessionId: 's-9' })
    expect(runtime.uiWorkspace.openSession).toHaveBeenCalledWith('s-9')
    expect(overlay().hidden).toBe(true)
    expect(sent('synapse:bridge-error')).toHaveLength(0)
  })

  it('reports a bridge error and keeps the map open when the session cannot be shown', () => {
    const runtime = boot()
    runtime.uiWorkspace.openSession.mockImplementation(() => { throw new Error('generation gone') })
    switchButton('map').click()
    fromCanvas('synapse:open-session', { sessionId: 's-9' })
    expect(overlay().hidden).toBe(false)
    expect(lastSent('synapse:bridge-error')).toEqual({
      source: 'dsh-synapse',
      type: 'synapse:bridge-error',
      message: '关联的 DSH 会话已不可用',
    })
  })

  it('ignores an open-session frame without a session id', () => {
    const runtime = boot()
    fromCanvas('synapse:open-session', { sessionId: 7 })
    fromCanvas('synapse:open-session')
    expect(runtime.uiWorkspace.openSession).not.toHaveBeenCalled()
    expect(sentMessages).toEqual([])
  })

  it('activates a session without closing the map', () => {
    const runtime = boot()
    switchButton('map').click()
    fromCanvas('synapse:activate-session', { sessionId: 's-9' })
    expect(runtime.uiWorkspace.openSession).toHaveBeenCalledWith('s-9')
    expect(overlay().hidden).toBe(false)
    expect(sent('synapse:bridge-error')).toHaveLength(0)
  })

  it('reports a bridge error when activating fails, and ignores a frame without a session id', () => {
    const runtime = boot()
    runtime.uiWorkspace.openSession.mockImplementation(() => { throw new Error('generation gone') })
    fromCanvas('synapse:activate-session', { sessionId: 's-9' })
    expect(lastSent('synapse:bridge-error')).toEqual({
      source: 'dsh-synapse',
      type: 'synapse:bridge-error',
      message: '关联的 DSH 会话已不可用',
    })
    sentMessages = []
    fromCanvas('synapse:activate-session', { sessionId: null })
    expect(runtime.uiWorkspace.openSession).toHaveBeenCalledTimes(1)
    expect(sentMessages).toEqual([])
  })

  it('forks from the requested seq and acks the child the catalog now reports', async () => {
    const runtime = boot()
    runtime.sessions.list.replace([sessionRow({ id: 'child-1', displayTitle: '分支 · 修复登录' })])
    fromCanvas('synapse:fork-session', { sessionId: 's-1', atSeq: 12, requestId: 'r-fork' })
    expect(runtime.sessions.fork).toHaveBeenCalledWith({ sessionId: 's-1', atSeq: 12, increaseTitle: true })
    await settle()
    expect(lastSent('synapse:forked-session')).toEqual({
      source: 'dsh-synapse',
      type: 'synapse:forked-session',
      requestId: 'r-fork',
      session: { id: 'child-1', title: '分支 · 修复登录' },
    })
  })

  it('forks from the head when the seq is not an integer and names an unlisted child by default', async () => {
    const runtime = boot()
    fromCanvas('synapse:fork-session', { sessionId: 's-1', atSeq: '12', requestId: 'r-fork' })
    expect(runtime.sessions.fork).toHaveBeenCalledWith({ sessionId: 's-1', increaseTitle: true })
    await settle()
    expect(lastSent('synapse:forked-session')?.session).toEqual({ id: 'child-1', title: 'DSH 分支' })
  })

  it('reports a fork failure against its request and ignores a frame without a session id', async () => {
    const runtime = boot()
    runtime.sessions.fork.mockRejectedValueOnce(new Error('turn still running'))
    fromCanvas('synapse:fork-session', { sessionId: 's-1', requestId: 'r-fork' })
    await settle()
    expect(lastSent('synapse:bridge-error')).toEqual({
      source: 'dsh-synapse',
      type: 'synapse:bridge-error',
      requestId: 'r-fork',
      message: 'DSH 分支创建失败，请确认源会话已经完成当前轮次',
    })
    sentMessages = []
    fromCanvas('synapse:fork-session', {})
    expect(runtime.sessions.fork).toHaveBeenCalledTimes(1)
    expect(sentMessages).toEqual([])
  })

  it('sends the trimmed prompt into the session scope and acks it', async () => {
    const runtime = boot()
    const face = makeFace()
    runtime.faces.set('s-1', face)
    runtime.scopes.set('s-1', { id: 's-1' })
    fromCanvas('synapse:send-message', { sessionId: 's-1', text: '  继续修复  ', requestId: 'r-send' })
    await settle()
    expect(face.prompt).toHaveBeenCalledWith([{ type: 'text', text: '继续修复' }], 'queue')
    expect(lastSent('synapse:message-sent')).toEqual({
      source: 'dsh-synapse',
      type: 'synapse:message-sent',
      requestId: 'r-send',
      sessionId: 's-1',
    })
  })

  it('rejects a blank or non-text message without reaching the session', async () => {
    const runtime = boot()
    const face = makeFace()
    runtime.faces.set('s-1', face)
    runtime.scopes.set('s-1', { id: 's-1' })
    fromCanvas('synapse:send-message', { sessionId: 's-1', text: '   ', requestId: 'r-send' })
    fromCanvas('synapse:send-message', { sessionId: 's-1', text: 42, requestId: 'r-send-2' })
    await settle()
    expect(face.prompt).not.toHaveBeenCalled()
    expect(sent('synapse:bridge-error')).toEqual([
      { source: 'dsh-synapse', type: 'synapse:bridge-error', requestId: 'r-send', message: '消息不能为空' },
      { source: 'dsh-synapse', type: 'synapse:bridge-error', requestId: 'r-send-2', message: '消息不能为空' },
    ])
  })

  it('reports the session error when the prompt is refused', async () => {
    const runtime = boot()
    const face = makeFace()
    face.prompt.mockResolvedValueOnce({ ok: false, error: { code: 'session_busy', message: '会话正在运行' } })
    runtime.faces.set('s-1', face)
    runtime.scopes.set('s-1', { id: 's-1' })
    fromCanvas('synapse:send-message', { sessionId: 's-1', text: '继续', requestId: 'r-send' })
    await settle()
    expect(lastSent('synapse:bridge-error')).toEqual({
      source: 'dsh-synapse',
      type: 'synapse:bridge-error',
      requestId: 'r-send',
      message: '会话正在运行',
    })
  })

  it('falls back to a generic message when the prompt rejects with a non-Error', async () => {
    const runtime = boot()
    const face = makeFace()
    face.prompt.mockRejectedValueOnce('offline')
    runtime.faces.set('s-1', face)
    runtime.scopes.set('s-1', { id: 's-1' })
    fromCanvas('synapse:send-message', { sessionId: 's-1', text: '继续', requestId: 'r-send' })
    await settle()
    expect(lastSent('synapse:bridge-error')).toEqual({
      source: 'dsh-synapse',
      type: 'synapse:bridge-error',
      requestId: 'r-send',
      message: 'DSH 消息发送失败',
    })
  })

  it('reports an unavailable session and ignores a frame without a session id', async () => {
    boot()
    fromCanvas('synapse:send-message', { sessionId: 's-gone', text: '继续', requestId: 'r-send' })
    await settle()
    expect(lastSent('synapse:bridge-error')).toEqual({
      source: 'dsh-synapse',
      type: 'synapse:bridge-error',
      requestId: 'r-send',
      message: '关联的 DSH 会话已不可用',
    })
    sentMessages = []
    fromCanvas('synapse:send-message', { text: '继续' })
    await settle()
    expect(sentMessages).toEqual([])
  })

  it('creates the session in the named workspace and echoes the projected title and cwd', async () => {
    const runtime = boot()
    runtime.sessions.create.mockImplementationOnce(async () => {
      runtime.sessions.list.replace([sessionRow({ id: 's-new', displayTitle: '新会话 · 登录', cwd: '/work/login' })])
      return 's-new'
    })
    fromCanvas('synapse:create-session', { workspaceId: 'w-1', cwd: '/ignored', requestId: 'r-new' })
    await settle()
    expect(runtime.sessions.create).toHaveBeenCalledWith({ workspaceId: 'w-1' })
    expect(lastSent('synapse:created-session')).toEqual({
      source: 'dsh-synapse',
      type: 'synapse:created-session',
      requestId: 'r-new',
      session: { id: 's-new', title: '新会话 · 登录', cwd: '/work/login' },
    })
  })

  it('creates in the requested directory when the canvas points at the ungrouped bucket', async () => {
    const runtime = boot()
    fromCanvas('synapse:create-session', { workspaceId: 'dsh-ungrouped', cwd: '/work/login', requestId: 'r-new' })
    await settle()
    expect(runtime.sessions.create).toHaveBeenCalledWith({ cwd: '/work/login' })
    expect(lastSent('synapse:created-session')?.session).toEqual({
      id: 's-new',
      title: '新会话',
      cwd: '/work/login',
    })
  })

  it('creates with no target when the canvas names neither a workspace nor a directory', async () => {
    const runtime = boot()
    fromCanvas('synapse:create-session', { workspaceId: '', requestId: 'r-new' })
    await settle()
    expect(runtime.sessions.create).toHaveBeenCalledWith()
    expect(lastSent('synapse:created-session')?.session).toEqual({ id: 's-new', title: '新会话', cwd: null })
  })

  it('reports a create failure against its request', async () => {
    const runtime = boot()
    runtime.sessions.create.mockRejectedValueOnce(new Error('no workspace'))
    fromCanvas('synapse:create-session', { cwd: '/work/login', requestId: 'r-new' })
    await settle()
    expect(lastSent('synapse:bridge-error')).toEqual({
      source: 'dsh-synapse',
      type: 'synapse:bridge-error',
      requestId: 'r-new',
      message: 'DSH 会话创建失败，请先在 DSH 选择工作目录',
    })
  })

  it('absorbs canvas acks and error reports without replying', () => {
    boot()
    fromCanvas('synapse:created-session', { requestId: 'r-1', session: { id: 's-1', title: '新会话' } })
    fromCanvas('synapse:forked-session', { requestId: 'r-2' })
    fromCanvas('synapse:message-sent', { requestId: 'r-3' })
    fromCanvas('synapse:message-sent')
    fromCanvas('synapse:bridge-error', { requestId: 'r-4', message: '失败' })
    fromCanvas('synapse:bridge-error', { message: '失败' })
    expect(sentMessages).toEqual([])
  })
})

describe('synapse theme follow', () => {
  it('mirrors the DSH dark-mode attribute into the canvas', async () => {
    boot()
    document.body.setAttribute('data-ds-dark-theme', '')
    await macrotask()
    expect(lastSent('synapse:theme')).toEqual({ source: 'dsh-synapse', type: 'synapse:theme', dark: true })

    document.body.removeAttribute('data-ds-dark-theme')
    await macrotask()
    expect(lastSent('synapse:theme')?.dark).toBe(false)
  })

  it('boots without a MutationObserver in the environment', async () => {
    vi.stubGlobal('MutationObserver', undefined)
    boot()
    document.body.setAttribute('data-ds-dark-theme', '')
    await macrotask()
    expect(sent('synapse:theme')).toHaveLength(0)
    expect(overlay().hidden).toBe(true)
    switchButton('map').click()
    expect(overlay().hidden).toBe(false)
  })
})

describe('synapse teardown', () => {
  it('drops the DOM, the subscriptions, and the pending sync on disposal', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const runtime = boot()
    const face = makeFace()
    runtime.faces.set('s-1', face)
    runtime.scopes.set('s-1', { id: 's-1' })
    runtime.sessions.list.replace([sessionRow({ id: 's-1' })])
    switchButton('map').click()
    flushFrames()
    vi.advanceTimersByTime(300)
    runtime.sessions.list.replace([sessionRow({ id: 's-1' }), sessionRow({ id: 's-2' })])

    runtime.dispose()
    expect(document.querySelector('.dsh-synapse-host')).toBeNull()
    expect(document.head.querySelector('style')).toBeNull()
    expect(face.listeners.size).toBe(0)
    expect(runtime.sessions.list.listenerCount()).toBe(0)
    expect(runtime.workspaces.list.listenerCount()).toBe(0)

    const fetches = fetchMock.mock.calls.length
    runtime.sessions.list.replace([sessionRow({ id: 's-3' })])
    face.emit()
    vi.advanceTimersByTime(1000)
    expect(fetchMock).toHaveBeenCalledTimes(fetches)
  })

  it('detaches the window listeners and the theme observer on disposal', async () => {
    const runtime = boot()
    const face = makeFace()
    runtime.faces.set('s-1', face)
    runtime.scopes.set('s-1', { id: 's-1' })
    runtime.sessions.list.replace([sessionRow({ id: 's-1' })])
    switchButton('map').click()
    const messages = sentMessages.length

    runtime.dispose()
    fromCanvas('synapse:open-session', { sessionId: 's-9' })
    document.body.setAttribute('data-ds-dark-theme', '')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await macrotask()
    expect(runtime.uiWorkspace.openSession).not.toHaveBeenCalled()
    expect(sentMessages).toHaveLength(messages)
  })
})
