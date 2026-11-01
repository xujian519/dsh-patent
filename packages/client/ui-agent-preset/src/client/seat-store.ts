/**
 * Hero-chip controller: which preset the NEXT session gets.
 *
 * The new-session screen has no session, so a pick is staged rather than
 * applied. It reaches a session when one becomes current and is still blank —
 * whether the workspace connect created it or reused an existing blank one. A
 * flow that knows its preset before it starts (the settings section's creator
 * entry) passes it to session creation instead, and its stage only drives the
 * chip's display.
 *
 * The stage is forgotten once applied. The next new session starts from the
 * Host-effective default again.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote merge into this program, and the refusal
// codes the seat reports as markers.
import type { RemoteErrorCode } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import { presetOptions, readRoster } from './settings-store.ts'
import type { AgentPresetOption } from './settings-store.ts'

/** Hero-chip snapshot. */
export interface AgentPresetSeatState {
  /** Presets the deployment supplies; empty means the chip renders nothing. */
  options: readonly AgentPresetOption[]
  /** The staged choice, empty until the roster loads. */
  current: string
  /** An error message; explicit selection failures also carry the preset for a Toast. */
  error: string | { readonly preset: AgentPresetOption; readonly reason: string } | null
  busy: boolean
  /**
   * One-shot cue that the chip should introduce itself (the creator-draft
   * entry staged the pick from another screen, so the user never touched the
   * chip); the renderer clears it via `introduced()` once played.
   */
  introduce: boolean
}

/**
 * Semantic marker for a pick the chip refuses because the session already
 * started. The store holds it as the seat's `error`; surfaces translate it to
 * the locale line instead of the raw marker.
 */
export const SEAT_PRESET_LOCKED = 'session-already-started'

/**
 * Semantic marker for a pick the Host refused because another flow owns the
 * Session's Agent. Surfaces translate it like {@link SEAT_PRESET_LOCKED}.
 */
export const SEAT_SESSION_BUSY = 'session-agent-busy'

/**
 * The Host refusals whose answer carries no `reason` field, or carries one in
 * Host vocabulary rather than user vocabulary: the seat reports them as these
 * markers and the surfaces translate them, so the Host's English message never
 * lands inside localized copy.
 */
const SEAT_REFUSALS: Partial<Record<RemoteErrorCode, string>> = {
  'agent-preset/locked': SEAT_PRESET_LOCKED,
  'session/agent-busy': SEAT_SESSION_BUSY,
}

/**
 * The refusal line for a seat error, or null when the text is not a marker this
 * vocabulary owns.
 * @param error - a seat error string or a refusal's reason.
 * @param t - the `settings.agentPreset` binder.
 * @returns the localized line, or null to show `error` verbatim.
 */
export function seatRefusalText(
  error: string,
  t: (key: 'seatLocked' | 'seatAgentBusy') => string,
): string | null {
  if (error === SEAT_PRESET_LOCKED) return t('seatLocked')
  if (error === SEAT_SESSION_BUSY) return t('seatAgentBusy')
  return null
}

const INITIAL: AgentPresetSeatState = {
  options: [], current: '', error: null, busy: false, introduce: false,
}

/** Mutable one-shot preset choice shared across Provider-bound seat controllers. */
export interface AgentPresetStage {
  /** Preset awaiting application; absence means no staged choice. */
  id: string | undefined
  /** Whether the receiving chip should announce the applied choice once. */
  introduce: boolean
}

/**
 * Result of one attempt to hand a staged preset to the current Session: the Host applied it,
 * it waits for a Session to appear, nothing changed (busy, already composed, or no stage),
 * or the attempt was refused by the Host or by the started-Session lock.
 */
type AgentPresetApplyOutcome =
  | { readonly kind: 'applied' | 'staged' | 'unchanged' }
  | { readonly kind: 'refused'; readonly reason: string }

const UNCHANGED: AgentPresetApplyOutcome = { kind: 'unchanged' }

/** Stages the next session's preset and applies it when one appears. */
export class AgentPresetSeatController {
  /** Chip snapshot the renderer subscribes to. */
  readonly store: SnapshotStore<AgentPresetSeatState> = createSnapshotStore(INITIAL)

  /**
   * The Host-effective default, so a consumed stage can fall back to it without
   * re-reading the roster.
   */
  private fallback = ''

  /** Only the newest roster read may publish after overlapping refreshes. */
  private loadGeneration = 0
  /** Completion of the active Host selection; Settings choices wait before staging. */
  private pendingSelection: Promise<undefined> | undefined

  constructor(
    private readonly ctx: ClientContext,
    /** The session the hero is about to hand over to, when there is one. */
    private readonly currentSession: () => Pick<
      SessionSummary,
      'id' | 'blank' | 'projectionValues'
    > | undefined,
    private readonly staged: AgentPresetStage = { id: undefined, introduce: false },
  ) {}

  private set(patch: Partial<AgentPresetSeatState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...patch })
  }

  private clearStage(): void {
    this.staged.id = undefined
    this.staged.introduce = false
  }

  /**
   * Read the roster and open the chip on the Host-effective default.
  * @returns once the snapshot reflects the host.
  */
  async load(): Promise<void> {
    const generation = ++this.loadGeneration
    const roster = await readRoster(this.ctx)
    if (generation !== this.loadGeneration) return
    // A roster refresh can finish after a selection; leave its announcement for the chip.
    const error = this.store.getSnapshot().error
    if (!roster.ok) {
      if (typeof error !== 'object' || error === null) this.set({ error: roster.error })
      return
    }
    const { presets } = roster.value
    this.fallback = presets.find(preset => preset.isDefault)?.id ?? presets[0]?.id ?? ''
    const session = this.currentSession()
    this.set({
      options: presetOptions(presets),
      // Staged pick first, then the composition the current session
      // already carries, then the Host-effective default. The middle term is
      // what keeps a late-landing load from regressing the display after
      // an applied stage was consumed — the chip mounts (and loads) only
      // once the flow's session is current, so the reply can arrive after
      // apply() already composed it.
      current: this.staged.id ?? (session === undefined ? this.fallback : presetOf(session) ?? ''),
      error: typeof error === 'object' ? error : null,
      introduce: this.staged.introduce,
    })
    await this.apply()
  }

  /**
   * Stage one preset for the next session, applying it immediately when a
   * blank session is already current.
   *
   * The refusal is stored for the chip's announcement and returned to callers
   * such as Settings that also report the result of their own write.
   * @param id - the preset to stage.
   * @returns how the pick settled; a refusal carries its text.
   */
  async select(id: string): Promise<AgentPresetApplyOutcome> {
    if (this.store.getSnapshot().busy) return UNCHANGED
    this.stage(id)
    return await this.apply()
  }

  /**
   * Stage a pick WITHOUT the immediate apply, for a flow that starts the
   * receiving session after the pick (the settings section's creator entry).
   * `select()`'s immediate apply would meet the still-current running session
   * and drop the stage as unservable; staging alone leaves it for the
   * list-change applier, which fires when the started session becomes
   * current.
   * @param id - the preset to stage.
   * @param introduce - true when the stage came from another screen and the
   * chip should announce itself on the session it lands on.
   */
  stage(id: string, introduce = false): void {
    this.staged.id = id
    this.staged.introduce = introduce
    this.set({ current: id, error: null, introduce })
  }

  /** Acknowledge a displayed refusal without dismissing a newer attempt.
   * @param refusal - the selection error whose Toast finished.
   */
  dismissRefusal(refusal: AgentPresetSeatState['error']): void {
    if (refusal !== null && typeof refusal === 'object' && this.store.getSnapshot().error === refusal) {
      this.set({ error: refusal.reason })
    }
  }

  /**
   * Capture the exact blank Session a Settings action may bring along.
   * @returns its id, or undefined outside a blank Session.
   */
  blankSessionId(): SessionSummary['id'] | undefined {
    const session = this.currentSession()
    return session?.blank === true ? session.id : undefined
  }

  /**
   * Apply a Settings choice only if its captured Session is still current and
   * blank after any pending selection settles. The selection uses the existing stage/apply path.
   * @param expectedSessionId - blank Session captured before the Settings write.
   * @param id - the effective default that the write persisted.
   * @returns the Host refusal text, or undefined when applied or no longer relevant.
   */
  async syncBlankSession(
    expectedSessionId: SessionSummary['id'],
    id: string,
  ): Promise<string | undefined> {
    while (this.pendingSelection !== undefined) await this.pendingSelection
    const session = this.currentSession()
    if (session === undefined || !session.blank || session.id !== expectedSessionId) return undefined
    this.stage(id)
    const outcome = await this.apply()
    return outcome.kind === 'refused' ? outcome.reason : undefined
  }

  /** Acknowledge the introduction cue once the chip has played it. */
  introduced(): void {
    if (!this.store.getSnapshot().introduce) return
    this.staged.introduce = false
    this.set({ introduce: false })
  }

  /**
   * Hand the staged choice to the current session, if there is one to take it.
   *
   * Called both by `select()` and by whoever observes the current session
   * changing, because the session may appear either before or after the pick.
   * List updates do not repeat a selection while its response is pending.
   * @returns how this attempt settled; only a Host commit of the staged preset is applied.
   */
  async apply(): Promise<AgentPresetApplyOutcome> {
    if (this.store.getSnapshot().busy) return UNCHANGED
    const staged = this.staged.id
    const session = this.currentSession()
    if (staged === undefined) {
      const current = session === undefined ? this.fallback : presetOf(session) ?? ''
      const shown = this.store.getSnapshot()
      if (current !== shown.current) this.set({ current })
      return UNCHANGED
    }
    if (session === undefined) return { kind: 'staged' }
    // The session already runs the staged composition: the label already
    // shows it, so the stage drops silently.
    if (presetOf(session) === staged) {
      this.clearStage()
      return UNCHANGED
    }
    // A started session's history was produced under its own composition, so
    // the host refuses the swap (agent-preset-locked). The chip knows this
    // before asking and does not spend a round-trip — but the pick must not
    // read as a silent no-op. Surface the refusal as the seat's error and snap
    // the label back to the preset the session actually runs.
    if (!session.blank) {
      this.clearStage()
      this.set({ current: presetOf(session) ?? this.fallback, error: SEAT_PRESET_LOCKED })
      return { kind: 'refused', reason: SEAT_PRESET_LOCKED }
    }
    const completion = Promise.withResolvers<undefined>()
    this.pendingSelection = completion.promise
    this.clearStage()
    // The stage is already consumed, so a refusal settles the label back onto
    // the composition the Session actually runs (or the deployment default):
    // an empty choice hides the chip and leaves no way to pick again.
    const revertTo = presetOf(session) ?? this.fallback
    const refuse = (reason: string): AgentPresetApplyOutcome => {
      this.set({
        error: { reason, preset: this.store.getSnapshot().options.find(option => option.id === staged) ?? { id: staged } },
        current: this.staged.id ?? revertTo,
      })
      return { kind: 'refused', reason }
    }
    try {
      this.set({ busy: true, error: null })
      const result = await this.ctx.remote.agentPresets.select(session.id, staged)
      if (!result.ok) {
        const { error } = result
        // The Host owns the started-or-not decision and answers on its own turn
        // boundary, which can already be ahead of this browser's cached list
        // row. A refusal the seat already models as a marker reports that marker
        // rather than the Host's English text, so the Toast stays localized.
        const marker = SEAT_REFUSALS[error.code]
        if (marker !== undefined) return refuse(marker)
        // Prefer the bare cause; the Toast already names the rejected preset.
        const refusal = 'reason' in error.details && typeof error.details.reason === 'string'
          ? error.details.reason
          : error.message
        return refuse(refusal)
      }
      this.set({ current: this.staged.id ?? result.value })
      return result.value === staged ? { kind: 'applied' } : UNCHANGED
    } catch (error) {
      return refuse(error instanceof Error ? error.message : String(error))
    } finally {
      this.pendingSelection = undefined
      this.set({ busy: false })
      completion.resolve(undefined)
    }
  }
}

function presetOf(
  session: Pick<SessionSummary, 'projectionValues'> | undefined,
): string | undefined {
  const value = session?.projectionValues?.agentPreset
  return typeof value === 'string' ? value : undefined
}
