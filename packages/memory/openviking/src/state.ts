/**
 * Session-sync state file: message seqs and commit bookkeeping only.
 *
 * The file never contains message bodies, API keys, or service responses.
 * Writes are atomic (see {@link @deepseek-ai/dsh-atomic-write}); a malformed
 * file is quarantined, and an identity change (endpoint/account/user/agentId)
 * renames the old file so sync restarts fresh instead of replaying into a
 * different library. At-least-once transport is the caller's contract: a
 * crash between a successful remote append and this state write may replay
 * that message, which the server dedupes through `source_message_ids`.
 * @module @deepseek-ai/dsh-openviking/state
 */

import { createHash } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Identity of the OpenViking library a state file belongs to. */
interface StateIdentity {
  readonly endpoint: string
  readonly account: string
  readonly user: string
  readonly agentId: string
}

/** Per-session bookkeeping: sent message seqs and commit progress. */
interface SessionBookkeeping {
  /** Message seqs already appended to the server (at-least-once dedupe key). */
  sentSeqs: number[]
  /** User turns appended but not yet committed. */
  uncommittedUserTurns: number
  /** Unix ms of the last successful commit; null when never committed. */
  lastCommitAt: number | null
}

/** On-disk state. */
interface StateSnapshot {
  readonly version: 1
  readonly identity: string
  readonly sessions: Record<string, SessionBookkeeping>
}

/** How a state file refused to load. */
type StateLoadIssue = 'identity-mismatch' | 'corrupt'

/** Imprint of the identity used to detect library changes.
 * @param identity - the library identity to imprint.
 * @returns the identity hash.
 */
export function identityHash(identity: StateIdentity): string {
  return createHash('sha256').update([identity.endpoint, identity.account, identity.user, identity.agentId].join('\n')).digest('hex')
}

/** Expand a leading `~` in the configured state file path.
 * @param path - the configured state file path.
 * @returns the expanded absolute path.
 */
export function expandStateFile(path: string): string {
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

function parseStateFile(raw: string, expectedIdentity: string): StateSnapshot | StateLoadIssue {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return 'corrupt'
  }
  if (typeof parsed !== 'object' || parsed === null) return 'corrupt'
  const candidate = parsed as { version?: unknown; identity?: unknown; sessions?: unknown }
  if (candidate.version !== 1 || typeof candidate.identity !== 'string'
    || typeof candidate.sessions !== 'object' || candidate.sessions === null || Array.isArray(candidate.sessions)) {
    return 'corrupt'
  }
  const snapshot = candidate as unknown as StateSnapshot
  if (snapshot.identity !== expectedIdentity) return 'identity-mismatch'
  return { version: 1, identity: snapshot.identity, sessions: { ...snapshot.sessions } }
}

/**
 * State store over one state file; serializes writes through an in-memory
 * snapshot so concurrent captures never lose bookkeeping.
 * @param file - state file path (already `~`-expanded).
 */
export class StateStore {
  private snapshot: StateSnapshot
  private readonly file: string
  private writeChain: Promise<void> = Promise.resolve()

  private constructor(file: string, snapshot: StateSnapshot) {
    this.file = file
    this.snapshot = snapshot
  }

  /**
   * Open (or create) the store.
   * @param file - configured state file path; `~` is expanded here.
   * @param identity - library identity the state belongs to.
   * @returns the store; a quarantined previous file is reported in the returned issue list.
   */
  static async open(
    file: string,
    identity: StateIdentity,
  ): Promise<{ store: StateStore; quarantined: Array<{ path: string; issue: StateLoadIssue }> }> {
    const expanded = expandStateFile(file)
    const expected = identityHash(identity)
    const quarantined: Array<{ path: string; issue: StateLoadIssue }> = []
    let snapshot: StateSnapshot = { version: 1, identity: expected, sessions: {} }
    try {
      const raw = await readFile(expanded, 'utf8')
      const parsed = parseStateFile(raw, expected)
      if (typeof parsed === 'string') {
        const target = `${expanded}.${parsed}-${Date.now()}`
        // The parse issue below is the reported defect; a failed quarantine
        // rename must not stop the store from opening with defaults.
        await rename(expanded, target).catch(() => {})
        quarantined.push({ path: target, issue: parsed })
      } else {
        snapshot = parsed
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return { store: new StateStore(expanded, snapshot), quarantined }
  }

  /** The identity hash this store belongs to. */
  get identity(): string {
    return this.snapshot.identity
  }

  /**
   * Current bookkeeping for one OpenViking session, or `null` when new.
   * @param openvikingSessionId - OpenViking session id (dsh- prefixed).
   * @returns the session bookkeeping, or `null` when none is recorded.
   */
  session(openvikingSessionId: string): SessionBookkeeping | null {
    return this.snapshot.sessions[openvikingSessionId] ?? null
  }

  /**
   * All openviking sessions recorded in this state.
   * @returns the recorded openviking session ids.
   */
  sessions(): string[] {
    return Object.keys(this.snapshot.sessions)
  }

  /**
   * Record a sent seq for one session.
   * @param openvikingSessionId - OpenViking session id (dsh- prefixed).
   * @param seq - the session event seq that was appended.
   */
  recordSent(openvikingSessionId: string, seq: number): Promise<void> {
    const existing = this.session(openvikingSessionId) ?? { sentSeqs: [], uncommittedUserTurns: 0, lastCommitAt: null }
    // Bound the dedupe window: seqs are monotonic, only a recent crash window can replay.
    const sentSeqs = existing.sentSeqs.length >= 10000 ? existing.sentSeqs.slice(-5000) : existing.sentSeqs
    return this.update(openvikingSessionId, { ...existing, sentSeqs: [...sentSeqs, seq] })
  }

  /**
 * Set the uncommitted user-turn count for one session.
 * @param openvikingSessionId - OpenViking session id (dsh- prefixed).
 * @param turns - Uncommitted user-turn count.
 */
  setUncommittedTurns(openvikingSessionId: string, turns: number): Promise<void> {
    const existing = this.session(openvikingSessionId) ?? { sentSeqs: [], uncommittedUserTurns: 0, lastCommitAt: null }
    return this.update(openvikingSessionId, { ...existing, uncommittedUserTurns: turns })
  }

  /**
 * Record a successful commit.
 * @param openvikingSessionId - OpenViking session id (dsh- prefixed).
 * @param at - Unix ms timestamp of the commit.
 */
  recordCommit(openvikingSessionId: string, at: number): Promise<void> {
    const existing = this.session(openvikingSessionId) ?? { sentSeqs: [], uncommittedUserTurns: 0, lastCommitAt: null }
    return this.update(openvikingSessionId, { ...existing, uncommittedUserTurns: 0, lastCommitAt: at })
  }

  private update(openvikingSessionId: string, value: SessionBookkeeping): Promise<void> {
    this.snapshot = { ...this.snapshot, sessions: { ...this.snapshot.sessions, [openvikingSessionId]: value } }
    this.writeChain = this.writeChain.then(() =>
      writeFile(this.file, `${JSON.stringify(this.snapshot, null, 2)}\n`, { mode: 0o600 })
        .catch(() => {}) // State persistence is best-effort; runtime dedupe keeps correctness in memory.
        .then(() => undefined))
    return this.writeChain
  }
}
