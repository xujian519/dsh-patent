/**
 * Document studio plugin, browser half: registers the `document`
 * conversation view (the deliverable studio), the produced-file definition
 * and session-wide view target it reads, and the auto-switch that jumps a
 * session to the studio once it has a registered deliverable. All policy
 * lives here — composing this plugin out of cordis.yml removes the tab, the
 * auto-switch, and the preview together.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
/* jscpd:ignore-start -- sibling client studios share the Context imports */
import { fileAddressFor, resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: pulls the slots Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the Conversation registries' Context merges (ctx.uiConversation).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the sessions-service Context merge (ctx.sessions).
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: pulls the Client Remote Context merge (ctx.remote, openWorkspacePath included).
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the generated `workspaceFiles` namespace into the Remote face.
import type {} from '@deepseek-ai/dsh-api-workspace-files/remote'
// Type-only: pulls the optional `sidebarRight` service (the file preview handoff).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
// Type-only: pulls the agentPreset Session-projection key (summary.projectionValues).
/* jscpd:ignore-end */
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import {
  DOCUMENT_DELIVERABLES_TARGET, documentDeliverablesDefinition, documentDeliverablesViewDefinition,
} from './document-deliverables.ts'
import { DOCUMENT_PRESET_ID, endsAfterTurn, hasDeliverRegistration, hasDocumentProduced } from './auto-switch.ts'
import { createFileReads } from './file-reads.ts'
import { createWorkspaceProbe } from './workspace-probe.ts'
import { StudioView } from './StudioView.tsx'
import { en, NS, zh, type DocumentStudioKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Document studio view copy. */
    'documentStudio': DocumentStudioKey
  }
}

export { DOCUMENT_PRESET_ID }

/** Required services for the view registration, the targets, and the auto-switch. */
export const inject = ['slots', 'locale', 'uiConversation', 'conversation', 'sessions', 'connection', 'remote', 'remote.session', 'remote.workspaceFiles']

/** Auto-switch retry window and cadence (the view setter mounts with the session seat). */
const SWITCH_RETRY_MS = 150
const SWITCH_MAX_RETRIES = 20

/**
 * Append text to one session's composer draft without sending it.
 *
 * The draft is the only write path this plugin uses: the revision and section
 * references land where the user would have typed them, and submitting stays a
 * human decision. An unavailable service or scope degrades to `false` (the
 * view then reports nothing rather than claiming an insert).
 * @param ctx - client root context carrying the sessions and conversation services.
 * @param sessionId - session whose composer draft receives the text.
 * @param text - text appended after the existing draft.
 * @returns whether the draft was updated.
 */
function insertDraft(ctx: ClientContext, sessionId: SessionId, text: string): boolean {
  try {
    const actx = ctx.sessions.scope(sessionId)
    if (actx === undefined) return false
    const conversation = ctx.get('conversation')
    if (conversation === undefined) return false
    const input = conversation.input.for(actx)
    const existing = input.state.getSnapshot().draft
    input.setDraft(existing.trim() === '' ? text : `${existing}\n${text}`)
    return true
  } catch {
    return false
  }
}

/**
 * Open one workspace path on the Host desktop.
 * @param ctx - client root context carrying the session Remote.
 * @param resolve - maps a produced-file path to the path the Host receives.
 * @param path - produced-file path as the deliverables reported it.
 * @param action - `reveal` selects the file in the OS file manager instead of opening it.
 * @returns completion; a Host refusal rejects so the view can report it.
 */
/* jscpd:ignore-start -- the Host file action and dictionary registration are the shared studio skeleton */
async function openPath(
  ctx: ClientContext,
  resolve: (path: string) => string,
  path: string,
  action?: 'reveal',
): Promise<void> {
  const result = await ctx.remote.session.openWorkspacePath({
    path: resolve(path),
    ...action === undefined ? {} : { action },
  })
  if (!result.ok) throw new Error(result.error.message)
}

/**
 * Client plugin body: register dictionaries, the produced-file targets, the
 * studio view, and the preset auto-switch.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-document-studio: dictionaries')
  /* jscpd:ignore-end */

  ctx.uiConversation.events.register(documentDeliverablesDefinition)
  ctx.uiConversation.views.register(documentDeliverablesViewDefinition)

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    // The shell activates a selected view by its slot id, so the id must equal
    // the ConversationViewDefinition target the studio reads its snapshot from.
    id: DOCUMENT_DELIVERABLES_TARGET,
    order: 20,
    locale: NS,
    label: () => ctx.locale.bind(NS)('view.document'),
    inject: (sessionId: SessionId) => {
      const connection = ctx.get('connection') as ConnectionHandle
      const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
      const resolve = (path: string): string => resolveWorkspacePath(cwd, path)
      const reads = createFileReads(ctx.remote.workspaceFiles, sessionId, resolve)
      const probe = createWorkspaceProbe(ctx.remote.workspaceFiles, sessionId, resolve)
      // The sidebar preview is an optional composition: without it the studio
      // simply offers no handoff rather than holding the whole view pending.
      const sidebar = ctx.get('sidebarRight')
      return {
        isLoopback: connection.isLoopback,
        canOpenInSidebar: sidebar !== undefined,
        openFile: (path: string) => openPath(ctx, resolve, path),
        // Reveal selects the file in the OS file manager; the Host owns the
        // platform-specific handoff (`SessionOpenWorkspacePathRequest.action`).
        showInFolder: (path: string) => openPath(ctx, resolve, path, 'reveal'),
        openInSidebar: (path: string) => {
          if (sidebar === undefined) return false
          sidebar.openResource(fileAddressFor(sessionId, cwd, path))
          return true
        },
        readFileText: reads.readFileText,
        readFileTextComplete: reads.readFileTextComplete,
        statVersions: probe.statVersions,
        probeUnregistered: probe.unregisteredDeliverables,
        insertDraft: (text: string) => insertDraft(ctx, sessionId, text),
      }
    },
  }, StudioView))

  // Jump to the studio when the current session is a document-agent session
  // that has a registered deliverable. The studio must have something to show:
  // switching on the preset alone lands a fresh session on an empty panel
  // instead of the chat it was just asked to run. The registration is read off
  // the session's own event window (the apply world has no view snapshot), and
  // the subscription covers the registration that arrives mid-turn. The
  // store-backed setter mounts with the session's conversation seat, so a
  // switch that precedes it retries for a bounded window; each session entry
  // switches at most once, so a deliberate tab pick survives the visit.
  ctx.effect(() => {
    let entered: SessionId | undefined
    let switched: SessionId | undefined
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let retries = 0
    let retryFor: SessionId | undefined
    let watch: { readonly sessionId: SessionId; readonly dispose: () => void } | undefined

    const stopRetry = (): void => {
      if (retryTimer !== undefined) {
        clearTimeout(retryTimer)
        retryTimer = undefined
      }
      retryFor = undefined
      retries = 0
    }
    const stopWatch = (): void => {
      watch?.dispose()
      watch = undefined
    }
    const attempt = (sessionId: SessionId): boolean => {
      const conversation = ctx.get('conversation')
      if (conversation === undefined) return false
      return conversation.setActiveView(sessionId, DOCUMENT_DELIVERABLES_TARGET)
    }
    const tick = (): void => {
      if (retryFor === undefined) return
      // Leaving a session tears this window down through the catalog
      // subscription, so the guard only answers a timer that outlived it.
      /* v8 ignore next 3 -- leaving a session runs stopRetry through the catalog subscription */
      if (ctx.sessions.list.getSnapshot().byId[retryFor]?.retainedBy.mainView === undefined) {
        stopRetry()
        return
      }
      if (++retries > SWITCH_MAX_RETRIES) {
        stopRetry()
        return
      }
      if (attempt(retryFor)) {
        stopRetry()
        return
      }
      retryTimer = setTimeout(tick, SWITCH_RETRY_MS)
    }
    const switchTo = (sessionId: SessionId): void => {
      switched = sessionId
      stopRetry()
      retryFor = sessionId
      retries = 0
      if (attempt(sessionId)) {
        stopRetry()
        return
      }
      retryTimer = setTimeout(tick, SWITCH_RETRY_MS)
    }
    /** Switch once per session entry, only after a finished turn produced something. */
    const evaluate = (sessionId: SessionId): void => {
      if (sessionId !== entered || sessionId === switched) return
      const preset = ctx.sessions.list.getSnapshot().byId[sessionId]?.projectionValues?.agentPreset
      if (preset !== DOCUMENT_PRESET_ID) return
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) return
      const entries = binding.eventSource.getSnapshot().entries
      // The reply is still streaming until the turn ends, so the studio waits
      // for it instead of taking the screen mid-answer.
      if (!endsAfterTurn(entries)) return
      if (!hasDeliverRegistration(entries) && !hasDocumentProduced(entries)) return
      switchTo(sessionId)
    }
    /** Watch the current session's event window; the list alone cannot report a registration. */
    const follow = (sessionId: SessionId): void => {
      if (watch?.sessionId === sessionId) return
      stopWatch()
      const binding = ctx.sessions.binding(sessionId)
      if (binding === undefined) return
      watch = {
        sessionId,
        dispose: binding.eventSource.subscribe(() => { evaluate(sessionId) }),
      }
      // The window already holds earlier registrations, so evaluate once on
      // attach; anything later arrives through the subscription.
      evaluate(sessionId)
    }
    const onList = (): void => {
      const state = ctx.sessions.list.getSnapshot()
      const current = Object.values(state.byId).find(session => (session.retainedBy.mainView ?? 0) > 0)?.id
      if (current === undefined) {
        stopWatch()
        stopRetry()
        entered = undefined
        switched = undefined
        return
      }
      if (current !== entered) {
        // A new entry starts a new visit: the once-guard and any retry for the
        // previous session do not carry over.
        entered = current
        switched = undefined
        stopRetry()
      }
      follow(current)
    }
    const stop = ctx.sessions.list.subscribe(onList)
    onList()
    return () => {
      stop()
      stopWatch()
      stopRetry()
    }
  }, 'ui-document-studio: preset auto-switch')
}
