/**
 * One-shot team change waiters behind `patent_teams_wait`.
 *
 * A waiter resolves on the next change announced after it registers: a task
 * transition, a mailbox delivery, a roster change, or a member status edge.
 * The captain reacts to work as it happens instead of sleeping until its next
 * poll. A wait observes announcements only — durable team state stays the
 * authoritative source the caller re-reads after it wakes.
 * @module @deepseek-ai/dsh-patent-teams/team-activity
 */

/** Shortest accepted `timeout_ms`. */
export const TEAM_WAIT_MIN_MS = 10_000

/** Longest accepted `timeout_ms`. */
export const TEAM_WAIT_MAX_MS = 3_600_000

/** `timeout_ms` used when the caller omits it. */
export const TEAM_WAIT_DEFAULT_MS = 30_000

// Fork-owned: upstream's agent-team package no longer carries this waiter
// primitive, and the experimental package rules bar a release package from
// depending on an experimental one. Sinking the primitive into util/ stays
// deferred.
/* jscpd:ignore-start */
/** One registered waiter, released at most once. */
interface Waiter {
  readonly resolve: () => void
}

/**
 * Live `patent_teams_wait` waiters, keyed by team id.
 *
 * One instance lives on the service. Nothing here is durable: a harness
 * restart drops the waiters, and a caller that outlives it wakes on its own
 * timeout and re-reads team state.
 */
export class TeamActivity {
  private readonly waiters = new Map<string, Set<Waiter>>()
  private closed = false

  /**
   * Wait for the next change of one team.
   * @param teamId - durable team id whose next announced change wakes the caller.
   * @param timeoutMs - bounded wait duration; the caller validates the range.
   * @param signal - caller cancellation for this wait only.
   * @returns whether the wait ended by timeout rather than by a change.
   */
  async wait(teamId: string, timeoutMs: number, signal: AbortSignal): Promise<{ timedOut: boolean }> {
    signal.throwIfAborted()
    if (this.closed) return { timedOut: false }
    const changed = await new Promise<boolean>((resolve, reject) => {
      let waiters = this.waiters.get(teamId)
      if (waiters === undefined) {
        waiters = new Set()
        this.waiters.set(teamId, waiters)
      }
      let settled = false
      const finish = (settle: () => void): void => {
        /* v8 ignore next -- a timeout, an abort, and a notification can race after one winner removes the others. */
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        waiters.delete(waiter)
        if (waiters.size === 0) this.waiters.delete(teamId)
        settle()
      }
      const onAbort = (): void => {
        finish(() => {
          const reason: unknown = signal.reason
          reject(reason instanceof Error ? reason : new Error(`patent_teams_wait aborted: ${String(reason)}`))
        })
      }
      const waiter: Waiter = {
        resolve: () => {
          finish(() => { resolve(true) })
        },
      }
      waiters.add(waiter)
      const timer = setTimeout(() => { finish(() => { resolve(false) }) }, timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      // AbortSignal does not replay an abort that wins between the pre-check and listener registration.
      /* v8 ignore next -- requires an abort inside the synchronous gap between the pre-check and listener registration. */
      if (signal.aborted) onAbort()
    })
    return { timedOut: !changed }
  }

  /**
   * Wake every current waiter of one team after its change is committed.
   * @param teamId - durable team id whose waiters observe this change.
   */
  notify(teamId: string): void {
    const waiters = this.waiters.get(teamId)
    if (waiters === undefined) return
    this.waiters.delete(teamId)
    for (const waiter of waiters) waiter.resolve()
  }

  /** Close admission and wake every current waiter during runtime disposal. */
  close(): void {
    this.closed = true
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) waiter.resolve()
    }
    this.waiters.clear()
  }
}
/* jscpd:ignore-end */
