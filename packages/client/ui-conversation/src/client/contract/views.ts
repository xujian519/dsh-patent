/** Conversation view and session-local presentation state. */
import type { DraftInput } from './draft-editor.ts'

/**
 * One conversation view tab, projected from a 'conversation.view' slot
 * entry's registration options (label falls back to the entry id).
 *
 * The shell orders tabs by `priority`, then `order`, then entry id: two View
 * packages that declare the same rank still yield one row, and that row does
 * not follow plugin activation order.
 */
export interface ViewTab { id: string; label: string }

/** One-shot focus request addressed to a Conversation View. */
export interface ConversationViewRequest {
  /** Target `conversation.view` entry id. */
  readonly view: string
  /** Target-owned opaque focus identity. */
  readonly focus: string
}

/** Per-session state owned by the target-neutral Conversation shell. */
export interface ConversationStoreState {
  /** Composer draft (persisted; survives session switches and reloads). */
  draft: DraftInput
  /** Preferred `conversation.view` entry id; null resolves to Chat when registered. */
  view: string | null
  /** Focus request consumed and acknowledged by the addressed View. */
  viewRequest: ConversationViewRequest | null
}
