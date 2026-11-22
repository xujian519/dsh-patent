/**
 * Synapse session-map browser half, loaded as a `dsh.client` row in the Web
 * profile. Adds the 对话/会话地图 switch and hosts the map at `/synapse/` in a
 * full-surface iframe, bridging it to the DSH session and workspace services:
 * create/fork/send, current-session sync, live replies, and theme follows.
 * The host half (dsh-host-synapse) owns the map page and projection.
 * @module @deepseek-ai/dsh-client-synapse
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the sessions-service Context merge (ctx.sessions).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// WorkspaceId import also pulls the workspaces-service Context merge (ctx.workspaces).
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only: pulls the ui-workspace Context merge (ctx.uiWorkspace).
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: declares the retention sources a Session summary reports.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Required client services: the session and workspace services. */
export const inject = ['sessions', 'workspaces', 'uiWorkspace']

/** One canvas session row sent to `/synapse/api/sessions/sync`. */
interface SessionRow {
  id: SessionId
  title: string
  cwd: string | null
  parentId?: SessionId
  blank: boolean
}

/** One canvas workspace row sent to the map's sidebar. */
interface WorkspaceRow {
  id: string
  title: string
  path: string | null
  sessionIds: SessionId[]
}

interface PendingRpc {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: number
}

/** Coalesce session/workspace-list churn into one sync POST. */
const SYNC_DEBOUNCE_MS = 300

/**
 * Register the map switch and its overlay. Pure DOM: the map lives in an
 * iframe, so nothing here renders through the slot system — the canvas app
 * owns its own document.
 * @param ctx - client root context carrying sessions/workspaces.
 */
export function apply(ctx: ClientContext): void {
  const currentSession = (): { id: SessionId; title: string; cwd: string | null } | null => {
    const snapshot = ctx.sessions.list.getSnapshot()
    const id = Object.values(snapshot.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
    if (id === undefined) return null
    const session = snapshot.byId[id]
    /* v8 ignore next -- byId is a Record<SessionId, SessionSummary>: the row Object.values found is addressable under its own id */
    return session === undefined ? null : { id, title: session.displayTitle, cwd: session.cwd ?? null }
  }
  const sessionRows = (): SessionRow[] =>
    ctx.sessions.list.getSnapshot().ids.flatMap((id) => {
      const session = ctx.sessions.list.getSnapshot().byId[id]
      /* v8 ignore next -- a snapshot's ids are keys of its byId row map, so every listed id resolves */
      return session === undefined ? [] : [{
        id,
        title: session.displayTitle,
        cwd: session.cwd ?? null,
        ...(session.parentId === undefined ? {} : { parentId: session.parentId }),
        blank: session.blank,
      }]
    })
  const workspaceRows = (): WorkspaceRow[] => {
    const sessions = ctx.sessions.list.getSnapshot()
    const workspaces = ctx.workspaces.list.getSnapshot()
    const accounted = new Set(workspaces.items.flatMap(workspace => workspace.sessionIds))
    return [
      ...workspaces.items.map(workspace => ({
        id: workspace.workspaceId,
        title: workspace.title,
        path: workspace.path,
        sessionIds: [...workspace.sessionIds],
      })),
      { id: 'dsh-ungrouped', title: '未分组', path: null, sessionIds: sessions.ids.filter(id => !accounted.has(id)) },
    ]
  }
  const promptSession = async (sessionId: SessionId, text: string): Promise<void> => {
    const scope = ctx.sessions.scope(sessionId)
    const session = scope === undefined ? undefined : ctx.sessions.sessionOf(scope)
    if (session === undefined) throw new Error('关联的 DSH 会话已不可用')
    const result = await session.prompt([{ type: 'text', text }], 'queue')
    if (!result.ok) throw new Error(result.error.message)
  }
  const style = document.createElement('style')
  // The switch parks at the right end of the conversation header's tab row,
  // never across the window's top centre where it covered the Session header's
  // title and preset/agent status. The `top`/`right` pair is the fallback for
  // a surface that publishes no anchor (no Session, a global panel). Anchored
  // rules follow that box with CSS anchor positioning, so a column resize does
  // not read layout.
  style.textContent = '.dsh-synapse-switch{position:fixed;z-index:80;top:40px;right:28px;display:flex;gap:2px;border:1px solid #d1d5db;border-radius:999px;background:rgba(255,255,255,.96);padding:3px;backdrop-filter:blur(10px)}.dsh-synapse-switch button{height:28px;border:0;border-radius:999px;background:transparent;padding:0 11px;color:#6b7280;font:600 12px Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap}.dsh-synapse-switch button:hover{background:#f3f4f6;color:#111827}.dsh-synapse-switch button.active{background:#111827;color:#fff}.dsh-synapse-switch button:focus-visible{outline:2px solid #111827;outline-offset:2px}body[data-ds-dark-theme] .dsh-synapse-switch{border-color:rgba(255,255,255,.14);background:rgba(21,21,23,.92)}body[data-ds-dark-theme] .dsh-synapse-switch button{color:#9ca3af}body[data-ds-dark-theme] .dsh-synapse-switch button:hover{background:rgba(255,255,255,.08);color:#e6e8eb}body[data-ds-dark-theme] .dsh-synapse-switch button.active{background:rgba(255,255,255,.14);color:#e6e8eb}body[data-ds-dark-theme] .dsh-synapse-switch button:focus-visible{outline-color:#5b8def}.dsh-synapse-switch.is-anchored-row{position-anchor:--dsh-synapse-switch;top:auto;right:anchor(right);bottom:anchor(bottom);left:auto}.dsh-synapse-switch.is-anchored-content{position-anchor:--dsh-synapse-switch;top:calc(anchor(top) + 40px);right:anchor(right);bottom:auto;left:auto}.dsh-synapse-overlay{position:fixed;z-index:100;inset:0;background:#f5f7fa}.dsh-synapse-overlay.is-opening{visibility:hidden}.dsh-synapse-overlay[hidden]{display:none}.dsh-synapse-overlay iframe{display:block;width:100%;height:100%;border:0}'
  document.head.append(style)
  const host = document.createElement('div')
  host.className = 'dsh-synapse-host'
  host.innerHTML = '<div class="dsh-synapse-switch" role="group" aria-label="视图切换"><button type="button" data-view="dialog" class="active" aria-pressed="true">对话</button><button type="button" data-view="map" aria-pressed="false">会话地图</button></div><section class="dsh-synapse-overlay" hidden><iframe title="会话地图" src="/synapse/"></iframe></section>'
  document.body.append(host)
  const dialogButton = host.querySelector('[data-view="dialog"]')
  const mapButton = host.querySelector('[data-view="map"]')
  const switchEl = host.querySelector('.dsh-synapse-switch')
  const overlay = host.querySelector('.dsh-synapse-overlay')
  const frame = host.querySelector('iframe')
  const frameReady = frame instanceof HTMLIFrameElement
  const buttonsReady = dialogButton instanceof HTMLElement && mapButton instanceof HTMLElement
  const switchReady = switchEl instanceof HTMLElement
  const overlayReady = overlay instanceof HTMLElement
  if (!frameReady || !buttonsReady || !switchReady || !overlayReady) {
    style.remove()
    host.remove()
    throw new Error('synapse: failed to build the map switch DOM')
  }
  const send = (type: string, payload: Record<string, unknown> = {}): void => {
    frame.contentWindow?.postMessage({ source: 'dsh-synapse', type, ...payload }, window.location.origin)
  }
  const pendingRpc = new Map<string, PendingRpc>()
  const settle = (requestId: string, value: unknown, error?: string): void => {
    const pending = pendingRpc.get(requestId)
    /* v8 ignore start -- no producer registers a pending RPC in this half, so a settle can only miss its waiter */
    if (pending === undefined) return
    pendingRpc.delete(requestId)
    window.clearTimeout(pending.timer)
    if (error === undefined) pending.resolve(value)
    else pending.reject(new Error(error))
    /* v8 ignore stop */
  }
  const setView = (view: 'dialog' | 'map'): void => {
    const showingMap = view === 'map'
    dialogButton.classList.toggle('active', !showingMap)
    dialogButton.setAttribute('aria-pressed', String(!showingMap))
    mapButton.classList.toggle('active', showingMap)
    mapButton.setAttribute('aria-pressed', String(showingMap))
  }
  // ui-conversation marks the full tab row as data-conversation-tab-row and the
  // tablist inside it as data-conversation-tabs. The row's box spans the
  // conversation column. CSS anchor positioning pins the switch to that box's
  // right and bottom edges, clear of the tabs, the More launcher, the header
  // title, and an open right sidebar. A blank Session has no row; its content
  // anchor sits 40px below the content top, still clear of the sidebar header.
  // A missing or collapsed anchor uses the stylesheet corner. The row is
  // re-created with the Session view, so placement re-observes whichever node
  // carries the anchor name. Size deliveries for a live anchor do not read
  // layout: the anchor follows a sidebar drag without a script-nested reflow.
  const ANCHOR_NAME = '--dsh-synapse-switch'
  let observedRow: Element | null = null
  let observedContent: Element | null = null
  let namedAnchor: HTMLElement | null = null
  let placed = false
  let anchorRetry = 0
  let retryTimer = 0
  const clearNamedAnchor = (): void => {
    namedAnchor?.style.removeProperty('anchor-name')
    namedAnchor = null
  }
  const nameAnchor = (element: Element): void => {
    if (!(element instanceof HTMLElement) || namedAnchor === element) return
    clearNamedAnchor()
    element.style.setProperty('anchor-name', ANCHOR_NAME)
    namedAnchor = element
  }
  const clearInlinePlace = (): void => {
    switchEl.style.removeProperty('left')
    switchEl.style.removeProperty('top')
    switchEl.style.removeProperty('right')
  }
  const useCorner = (): void => {
    clearNamedAnchor()
    switchEl.classList.remove('is-anchored-row', 'is-anchored-content', 'is-holding')
    clearInlinePlace()
    placed = false
    anchorRetry = 0
    window.clearTimeout(retryTimer)
  }
  /** Keep the last viewport box while a Session view swaps the anchor node out. */
  const holdPlacement = (): void => {
    if (switchEl.classList.contains('is-holding')) return
    const rect = switchEl.getBoundingClientRect()
    switchEl.classList.remove('is-anchored-row', 'is-anchored-content')
    switchEl.classList.add('is-holding')
    clearNamedAnchor()
    if (rect.width === 0 || rect.height === 0) return
    switchEl.style.right = 'auto'
    switchEl.style.left = `${Math.round(rect.left)}px`
    switchEl.style.top = `${Math.round(rect.top)}px`
  }
  const anchorSwitch = (element: Element, kind: 'row' | 'content'): void => {
    nameAnchor(element)
    switchEl.classList.toggle('is-anchored-row', kind === 'row')
    switchEl.classList.toggle('is-anchored-content', kind === 'content')
    switchEl.classList.remove('is-holding')
    clearInlinePlace()
    anchorRetry = 0
    window.clearTimeout(retryTimer)
    placed = true
  }
  const collapsed = (element: Element): boolean => {
    const rect = element.getBoundingClientRect()
    return rect.width === 0 || rect.height === 0
  }
  const placeSwitch = (): void => {
    const contentElement = document.querySelector('[data-conversation-session]')
    if (contentElement !== observedContent) {
      if (observedContent !== null) placementObserver?.unobserve(observedContent)
      if (contentElement !== null) placementObserver?.observe(contentElement)
      observedContent = contentElement
    }
    const row = document.querySelector('[data-conversation-tab-row]')
      ?? document.querySelector('[data-conversation-tabs]')
    if (row !== observedRow) {
      if (observedRow !== null) placementObserver?.unobserve(observedRow)
      if (row !== null) placementObserver?.observe(row)
      observedRow = row
    }
    if (row !== null && !collapsed(row)) {
      anchorSwitch(row, 'row')
      return
    }
    // A blank Session renders no tab row. Its content still spans the column.
    if (contentElement !== null && !collapsed(contentElement)) {
      anchorSwitch(contentElement, 'content')
      return
    }
    // A Session view can unmount the row between two frames. Keep the last
    // placement briefly and look again before giving up on the inline box.
    if (row === null && placed && anchorRetry < 20) {
      anchorRetry += 1
      holdPlacement()
      window.clearTimeout(retryTimer)
      retryTimer = window.setTimeout(schedulePlaceSwitch, 50)
      return
    }
    useCorner()
  }
  let placementFrame = 0
  const schedulePlaceSwitch = (): void => {
    if (placementFrame !== 0) return
    placementFrame = window.requestAnimationFrame(() => {
      placementFrame = 0
      placeSwitch()
    })
  }
  // Positive border boxes are already laid out. Reading them, or measuring the
  // anchor again, would nest a layout inside this callback on every drag step.
  const onAnchorResize: ResizeObserverCallback = (entries) => {
    if ((observedRow !== null && !observedRow.isConnected) || (observedContent !== null && !observedContent.isConnected)) {
      schedulePlaceSwitch()
      return
    }
    for (const entry of entries) {
      const box = entry.borderBoxSize[0]
      if (box !== undefined && (box.inlineSize === 0 || box.blockSize === 0)) {
        schedulePlaceSwitch()
        return
      }
    }
  }
  const placementObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(onAnchorResize)
  placeSwitch()
  let mapOpenFallback = 0
  let mapOpening = false
  const close = (): void => {
    window.clearTimeout(mapOpenFallback)
    mapOpening = false
    overlay.classList.remove('is-opening')
    overlay.hidden = true
    setView('dialog')
  }
  let syncTimer = 0
  let knownSessionIds = new Set<SessionId>()
  const liveUnsubscribers = new Map<SessionId, () => void>()
  const syncLiveSessions = (): void => {
    const snapshot = ctx.sessions.list.getSnapshot()
    for (const id of snapshot.ids) {
      if (liveUnsubscribers.has(id)) continue
      const scope = ctx.sessions.scope(id)
      const session = scope === undefined ? undefined : ctx.sessions.sessionOf(scope)
      if (session === undefined) continue
      const publish = (): void => {
        if (overlay.hidden) return
        // SessionSnapshot carries no streaming text; the bridge publishes the
        // running flag only (live reply text would need the conversation
        // assembly).
        send('synapse:live-reply', { sessionId: id, running: session.getSnapshot().running, text: '' })
      }
      liveUnsubscribers.set(id, session.subscribe(publish))
      publish()
    }
    for (const [id, unsubscribe] of liveUnsubscribers) {
      if (!snapshot.ids.includes(id)) {
        unsubscribe()
        liveUnsubscribers.delete(id)
      }
    }
  }
  const syncSessions = (): void => {
    // The list subscription fires on every session change; a team task that
    // spawns many subagent sessions would otherwise POST /sessions/sync in a
    // tight burst, exhausting the renderer request budget and surfacing as
    // net::ERR_INSUFFICIENT_RESOURCES (a white screen). Trailing-debounce the
    // burst; removedSessionIds is computed from the final snapshot.
    if (syncTimer !== 0) window.clearTimeout(syncTimer)
    syncTimer = window.setTimeout(() => {
      syncTimer = 0
      const sessions = sessionRows()
      const sessionIds = new Set(sessions.map(session => session.id))
      const removedSessionIds = [...knownSessionIds].filter(id => !sessionIds.has(id))
      knownSessionIds = sessionIds
      // Fire-and-forget: each pass posts the full list, so a dropped failure is
      // superseded by the next debounced pass.
      void fetch('/synapse/api/sessions/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessions, removedSessionIds }),
      }).catch(() => {})
    }, SYNC_DEBOUNCE_MS)
  }
  const syncTheme = (): void => {
    send('synapse:theme', { dark: document.body.hasAttribute('data-ds-dark-theme') })
  }
  const syncCurrentSession = (): void => {
    syncSessions()
    syncLiveSessions()
    syncTheme()
    // Session and panel switches respan the tab row's box.
    schedulePlaceSwitch()
    if (!overlay.hidden) {
      send('synapse:workspaces', { workspaces: workspaceRows() })
      send('synapse:current-session', { session: currentSession() })
    }
  }
  const showMapOverlay = (): void => {
    window.clearTimeout(mapOpenFallback)
    mapOpening = false
    overlay.hidden = false
    overlay.classList.remove('is-opening')
    syncCurrentSession()
  }
  const open = (): void => {
    window.clearTimeout(mapOpenFallback)
    mapOpening = true
    setView('map')
    // Keep the iframe laid out while hidden so its canvas can receive a
    // real scroll offset. display:none would clamp scrollTop back to zero.
    overlay.hidden = false
    overlay.classList.add('is-opening')
    window.requestAnimationFrame(() => {
      send('synapse:map-opened')
      syncCurrentSession()
    })
    mapOpenFallback = window.setTimeout(showMapOverlay, 300)
  }
  const onFrameLoad = (): void => {
    syncCurrentSession()
    if (mapOpening) send('synapse:map-opened')
  }
  const onMessage = (event: MessageEvent): void => {
    const data = event.data as {
      source?: unknown
      type: string
      requestId?: string
      sessionId?: string
      session?: unknown
      text?: unknown
      atSeq?: unknown
      workspaceId?: unknown
      cwd?: unknown
      message?: unknown
    }
    if (event.origin !== window.location.origin || data.source !== 'dsh-synapse') return
    if (data.type === 'synapse:close') { close(); return }
    if (data.type === 'synapse:map-ready') { showMapOverlay(); return }
    if (data.type === 'synapse:request-current') {
      send('synapse:workspaces', { workspaces: workspaceRows() })
      send('synapse:current-session', { session: currentSession() })
      return
    }
    if (data.type === 'synapse:open-session') {
      if (typeof data.sessionId !== 'string') return
      try { ctx.uiWorkspace.openSession(data.sessionId as SessionId); close() } catch { send('synapse:bridge-error', { message: '关联的 DSH 会话已不可用' }) }
      return
    }
    if (data.type === 'synapse:activate-session') {
      // Bidirectional current-session sync: switch DSH's current session
      // without closing the map; the sessions-list subscription re-sends
      // synapse:current-session so the map follows the new highlight.
      if (typeof data.sessionId !== 'string') return
      try { ctx.uiWorkspace.openSession(data.sessionId as SessionId) } catch { send('synapse:bridge-error', { message: '关联的 DSH 会话已不可用' }) }
      return
    }
    if (data.type === 'synapse:fork-session') {
      if (typeof data.sessionId !== 'string') return
      const sessionId = data.sessionId as SessionId
      const atSeq = Number.isInteger(data.atSeq) ? (data.atSeq as number) : undefined
      ctx.sessions.fork({ sessionId, ...(atSeq === undefined ? {} : { atSeq }), increaseTitle: true }).then((childId) => {
        send('synapse:forked-session', {
          requestId: data.requestId,
          session: { id: childId, title: ctx.sessions.list.getSnapshot().byId[childId]?.displayTitle ?? 'DSH 分支' },
        })
      }).catch(() => {
        send('synapse:bridge-error', { requestId: data.requestId, message: 'DSH 分支创建失败，请确认源会话已经完成当前轮次' })
      })
      return
    }
    if (data.type === 'synapse:send-message') {
      if (typeof data.sessionId !== 'string') return
      const text = typeof data.text === 'string' ? data.text.trim() : ''
      if (text === '') { send('synapse:bridge-error', { requestId: data.requestId, message: '消息不能为空' }); return }
      void promptSession(data.sessionId as SessionId, text).then(() => {
        send('synapse:message-sent', { requestId: data.requestId, sessionId: data.sessionId })
      }).catch((error: unknown) => {
        send('synapse:bridge-error', { requestId: data.requestId, message: error instanceof Error ? error.message : 'DSH 消息发送失败' })
      })
      return
    }
    if (data.type === 'synapse:create-session') {
      const workspaceId = typeof data.workspaceId === 'string' && data.workspaceId !== '' && data.workspaceId !== 'dsh-ungrouped' ? data.workspaceId : undefined
      const cwd = typeof data.cwd === 'string' && data.cwd !== '' ? data.cwd : undefined
      // New-session creation is sessions-owned: create() resolves only once
      // the child is in the list store, so the resolved id is addressable
      // (and current) without waiting on a list tick.
      void (async () => {
        const id = workspaceId !== undefined
          ? await ctx.sessions.create({ workspaceId: workspaceId as WorkspaceId })
          : cwd !== undefined
            ? await ctx.sessions.create({ cwd })
            : await ctx.sessions.create()
        send('synapse:created-session', {
          requestId: data.requestId,
          session: { id, title: ctx.sessions.list.getSnapshot().byId[id]?.displayTitle ?? '新会话', cwd: ctx.sessions.list.getSnapshot().byId[id]?.cwd ?? cwd ?? null },
        })
      })().catch(() => {
        send('synapse:bridge-error', { requestId: data.requestId, message: 'DSH 会话创建失败，请先在 DSH 选择工作目录' })
      })
      return
    }
    if (data.type === 'synapse:forked-session' || data.type === 'synapse:created-session' || data.type === 'synapse:message-sent') {
      if (data.requestId !== undefined) settle(data.requestId, data.session ?? data)
    }
    if (data.type === 'synapse:bridge-error') {
      if (data.requestId !== undefined) settle(data.requestId, undefined, data.message as string | undefined)
    }
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !overlay.hidden) close()
  }
  // Follow DSH's live theme switch: body[data-ds-dark-theme] is the web
  // client's dark-mode signal, mirrored into the map iframe via synapse:theme.
  const themeObserver = typeof MutationObserver === 'undefined'
    ? null
    : new MutationObserver(() => { syncTheme() })
  if (themeObserver !== null) {
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
  }
  const unsubscribeSessions = ctx.sessions.list.subscribe(syncCurrentSession)
  const unsubscribeWorkspaces = ctx.workspaces.list.subscribe(syncCurrentSession)
  dialogButton.addEventListener('click', close)
  mapButton.addEventListener('click', open)
  frame.addEventListener('load', onFrameLoad)
  window.addEventListener('message', onMessage)
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('resize', schedulePlaceSwitch)
  ctx.effect(() => () => {
    dialogButton.removeEventListener('click', close)
    mapButton.removeEventListener('click', open)
    frame.removeEventListener('load', onFrameLoad)
    window.removeEventListener('message', onMessage)
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('resize', schedulePlaceSwitch)
    themeObserver?.disconnect()
    unsubscribeSessions()
    unsubscribeWorkspaces()
    window.clearTimeout(syncTimer)
    window.clearTimeout(retryTimer)
    window.clearTimeout(mapOpenFallback)
    if (placementFrame !== 0) window.cancelAnimationFrame(placementFrame)
    placementObserver?.disconnect()
    clearNamedAnchor()
    for (const unsubscribe of liveUnsubscribers.values()) unsubscribe()
    host.remove()
    style.remove()
  }, 'synapse: web workspace switch')
}
