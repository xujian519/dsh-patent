/**
 * Delivered-session detection for the studio auto-switch.
 *
 * The studio may only take the screen when it has something to show, and only
 * once the turn that produced it has finished: switching mid-turn hides the
 * reply the user is still reading. The apply world (where
 * `conversation.setActiveView` lives) has no read path to the conversation view
 * target, so the two signals come from the session's own event window — a
 * successful `document_deliver` registration, or a successful file mutation
 * that produced a deliverable-shaped draft.
 */
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { DOCUMENT_DELIVER_TOOL, mutationPath } from './document-deliverables.ts'
import { isDeliverablePath } from './paths.ts'

/** The agent-preset id whose sessions the studio follows. */
export const DOCUMENT_PRESET_ID = 'document'

/**
 * Whether one session event window records a successful deliverable registration.
 * @param entries - the contiguous event window of the current session.
 * @returns true once a `document_deliver` call has a non-error append-surface result.
 */
export function hasDeliverRegistration(entries: readonly SessionEventLikeEntry[]): boolean {
  const registrations = new Set<string>()
  for (const entry of entries) {
    if (entry.type !== 'event') continue
    const event = entry.event
    if (event.type === 'tool/call') {
      if (event.data.name === DOCUMENT_DELIVER_TOOL) registrations.add(String(event.data.callId))
      continue
    }
    if (event.type !== 'tool/result' || !isAppendSurfaceEvent(event)) continue
    if (event.data.message.isError === true) continue
    if (registrations.has(String(event.data.message.source.callId))) return true
  }
  return false
}

/**
 * Whether one session event window records a successful deliverable-shaped
 * mutation — a working draft written before any registration exists.
 * @param entries - the contiguous event window of the current session.
 * @returns true once a supported mutation call with a deliverable extension settles without error.
 */
export function hasDocumentProduced(entries: readonly SessionEventLikeEntry[]): boolean {
  const mutations = new Map<string, string | null>()
  for (const entry of entries) {
    if (entry.type !== 'event') continue
    const event = entry.event
    if (event.type === 'tool/call') {
      mutations.set(String(event.data.callId), mutationPath(event.data.name, event.data.arguments))
      continue
    }
    if (event.type !== 'tool/result' || !isAppendSurfaceEvent(event)) continue
    if (event.data.message.isError === true) continue
    const path = mutations.get(String(event.data.message.source.callId))
    if (path !== null && path !== undefined && isDeliverablePath(path)) return true
  }
  return false
}

/** Event types that belong to one turn's lifecycle. */
const TURN_EVENT_PREFIXES = ['turn/', 'step/', 'assistant/', 'tool/'] as const

/**
 * Whether the newest turn-lifecycle event in the window is its `turn/end`.
 *
 * Non-lifecycle events (`session/title`, a log delivery acknowledgement) are
 * appended outside turns and carry no reply content, so they are skipped: the
 * question is whether the last *turn* finished, not whether the journal's last
 * row is its end.
 * @param entries - the contiguous event window of the current session.
 * @returns true when no turn is in progress.
 */
export function endsAfterTurn(entries: readonly SessionEventLikeEntry[]): boolean {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry === undefined || entry.type !== 'event') continue
    const type = entry.event.type
    if (type === 'turn/end') return true
    if (TURN_EVENT_PREFIXES.some(prefix => type.startsWith(prefix))) return false
  }
  return false
}
