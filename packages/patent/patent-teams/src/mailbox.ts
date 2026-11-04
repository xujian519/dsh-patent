/**
 * One JSONL mailbox per agent (`captain` or a member name) under
 * `<stateRoot>/<teamId>/inbox/`, mirroring the Claude Code PatentTeams mailbox layout.
 *
 * Appends use a single `O_APPEND` write so a long mailbox never rewrites its history per
 * message; mutations that must preserve malformed lines rewrite the file through the
 * shared atomic write.
 * @module dsh-patent-teams/mailbox
 */

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, open, readFile } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { isENOENT, isRecord } from '@deepseek-ai/dsh-value'
import type { TeamMessage } from './types.ts'
import { atomicWriteText, sanitizeKey, stripLeadingBom, teamLockKey, withTeamLock } from './team-lock.ts'
import { isFiniteNumber } from './value.ts'

/** Default live-delivery lease before a claimed mailbox message becomes retryable. */
export const DEFAULT_MAILBOX_DELIVERY_LEASE_MS = 60_000

/**
 * Build a message record, stamping its id and time.
 * @param from - sending agent key.
 * @param to - receiving agent key.
 * @param content - message body.
 * @returns the new message.
 */
export function createMessage(from: string, to: string, content: string): TeamMessage {
  return { id: randomUUID(), from, to, content, ts: Date.now() }
}

/**
 * Append one message to an agent's mailbox (JSONL) with a single `O_APPEND`
 * write, so a long mailbox no longer rewrites its whole history per message.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 * @param agentKey - `captain` or a member name.
 * @param message - the message to append.
 */
export async function appendMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  message: TeamMessage,
): Promise<void> {
  const file = join(stateRoot, teamId, 'inbox', `${sanitizeKey(agentKey)}.jsonl`)
  await mkdir(join(stateRoot, teamId, 'inbox'), { recursive: true })
  await appendFile(file, `${await missingTrailingNewline(file)}${JSON.stringify(message)}\n`, 'utf8')
}

/**
 * `'\n'` when the mailbox exists, is non-empty, and does not end with a line
 * terminator, so the appended record cannot glue onto a truncated tail;
 * `''` otherwise. A missing file starts fresh; other open failures (for
 * example a directory in the mailbox path) propagate like every read.
 * @param file - the mailbox file.
 * @returns the separator to prepend to the appended line.
 */
async function missingTrailingNewline(file: string): Promise<string> {
  let handle: FileHandle
  try {
    handle = await open(file, 'r')
  } catch (error: unknown) {
    if (isENOENT(error)) {
      return ''
    }
    throw error
  }
  try {
    const { size } = await handle.stat()
    if (size === 0) return ''
    const buffer = Buffer.alloc(1)
    const { bytesRead } = await handle.read(buffer, 0, 1, size - 1)
    // v8 ignore next -- a non-empty stat guarantees one readable byte
    if (bytesRead === 0) return ''
    return buffer[0] === 0x0A ? '' : '\n'
  } finally {
    await handle.close()
  }
}

/**
 * Read one agent's whole mailbox, oldest first.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 * @param agentKey - `captain` or a member name.
 * @param onMalformedLine - optional diagnostic hook; malformed records are
 * skipped so one manually damaged line cannot make the whole team unreadable.
 * @returns the messages, empty when the mailbox does not exist yet.
 */
export async function readMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  onMalformedLine?: (lineNumber: number, error: unknown) => void,
): Promise<TeamMessage[]> {
  const file = join(stateRoot, teamId, 'inbox', `${sanitizeKey(agentKey)}.jsonl`)
  try {
    const raw = await readFile(file, 'utf8')
    const messages: TeamMessage[] = []
    for (const [index, rawLine] of raw.split('\n').entries()) {
      const line = stripLeadingBom(rawLine)
      if (line.trim() === '') continue
      let value: unknown
      try {
        value = JSON.parse(line)
      } catch {
        onMalformedLine?.(index + 1, new Error('invalid JSON'))
        continue
      }
      if (!isTeamMessage(value)) {
        onMalformedLine?.(index + 1, new Error('invalid message shape'))
        continue
      }
      messages.push(value)
    }
    return messages
  } catch (error: unknown) {
    if (isENOENT(error)) {
      return []
    }
    throw error
  }
}

/** Unread mailbox messages split by whether a live-delivery lease still holds them. */
export interface MailboxSnapshot {
  /** Unread messages no unexpired delivery claim holds; a delivery attempt may take them now. */
  unread: TeamMessage[]
  /** Unread messages claimed for live delivery whose lease has not yet expired. */
  leased: TeamMessage[]
}

/**
 * Read one mailbox and split its unread messages by live-delivery lease.
 *
 * A leased message is invisible to {@link readUnreadMailbox} until its lease
 * expires, so status needs both halves to distinguish "nothing arrived" from
 * "a message is waiting for delivery".
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 * @param agentKey - `captain` or a member name.
 * @param onMalformedLine - optional diagnostic hook for malformed records.
 * @param deliveryLeaseMs - how long a live-delivery claim stays exclusive
 * before the message is retryable (defaults to
 * {@link DEFAULT_MAILBOX_DELIVERY_LEASE_MS}).
 * @returns unread and leased messages, both oldest first and empty when the mailbox does not exist.
 */
export async function readMailboxSnapshot(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  onMalformedLine?: (lineNumber: number, error: unknown) => void,
  deliveryLeaseMs = DEFAULT_MAILBOX_DELIVERY_LEASE_MS,
): Promise<MailboxSnapshot> {
  const now = Date.now()
  const snapshot: MailboxSnapshot = { unread: [], leased: [] }
  for (const message of await readMailbox(stateRoot, teamId, agentKey, onMalformedLine)) {
    if (message.readAt !== undefined) continue
    if (message.deliveryClaimedAt !== undefined && now - message.deliveryClaimedAt < deliveryLeaseMs) {
      snapshot.leased.push(message)
      continue
    }
    snapshot.unread.push(message)
  }
  return snapshot
}

/**
 * Read only messages that have not been acknowledged by their recipient,
 * excluding still-claimed deliveries whose lease has not yet expired.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 * @param agentKey - `captain` or a member name.
 * @param onMalformedLine - optional diagnostic hook for malformed records.
 * @param deliveryLeaseMs - how long a live-delivery claim stays exclusive
 * before the message is retryable (defaults to
 * {@link DEFAULT_MAILBOX_DELIVERY_LEASE_MS}).
 * @returns the unacknowledged messages, empty when the mailbox does not exist.
 */
export async function readUnreadMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  onMalformedLine?: (lineNumber: number, error: unknown) => void,
  deliveryLeaseMs = DEFAULT_MAILBOX_DELIVERY_LEASE_MS,
): Promise<TeamMessage[]> {
  return (await readMailboxSnapshot(stateRoot, teamId, agentKey, onMalformedLine, deliveryLeaseMs)).unread
}

async function mutateMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  messageIds: readonly string[],
  mutate: (message: TeamMessage) => TeamMessage,
): Promise<void> {
  if (messageIds.length === 0) return
  const file = join(stateRoot, teamId, 'inbox', `${sanitizeKey(agentKey)}.jsonl`)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch (error: unknown) {
    if (isENOENT(error)) return
    throw error
  }
  const selected = new Set(messageIds)
  const lines = raw.split('\n').map((rawLine) => {
    const line = stripLeadingBom(rawLine)
    if (line.trim() === '') return rawLine
    try {
      const value: unknown = JSON.parse(line)
      if (!isTeamMessage(value) || !selected.has(value.id)) return rawLine
      return JSON.stringify(mutate(value))
    } catch {
      return rawLine
    }
  })
  await atomicWriteText(file, lines.join('\n'))
}

/**
 * Run one mailbox lease mutation under the team lock.
 *
 * Claim, acknowledgement, and release all rewrite the same JSONL file, so they
 * share the team-wide lock rather than acquiring a mailbox-specific one.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 * @param agentKey - `captain` or a member name.
 * @param mutate - the lease mutation, called with the mailbox key.
 */
export async function withMailboxLease(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  mutate: (agentKey: string) => Promise<void>,
): Promise<void> {
  await withTeamLock(teamLockKey(stateRoot, teamId), () => mutate(agentKey))
}

/**
 * Lease selected fallback messages to one delivery path so the scheduler can
 * retry them without double-delivery while the lease is active.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 * @param agentKey - `captain` or a member name.
 * @param messageIds - the message ids to lease.
 * @returns the ids actually claimed; an already-read message is skipped because
 * the scheduler's snapshot may predate an acknowledgement from the status path.
 */
export async function claimMailboxDelivery(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  messageIds: readonly string[],
): Promise<readonly string[]> {
  const now = Date.now()
  const claimed: string[] = []
  await mutateMailbox(stateRoot, teamId, agentKey, messageIds, (message) => {
    if (message.readAt !== undefined) return message
    claimed.push(message.id)
    return {
      ...message,
      deliveryClaimedAt: now,
    }
  })
  return claimed
}

/**
 * Release a failed delivery lease so the scheduler can retry it later.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 * @param agentKey - `captain` or a member name.
 * @param messageIds - the message ids whose lease to release.
 */
export async function releaseMailboxDelivery(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  messageIds: readonly string[],
): Promise<void> {
  await mutateMailbox(stateRoot, teamId, agentKey, messageIds, (message) => {
    const { deliveryClaimedAt: _claimed, ...released } = message
    return released
  })
}

/**
 * Mark selected durable mailbox records delivered/read while preserving
 * malformed lines for diagnostics. Callers serialize this with the team lock.
 * @param stateRoot - resolved absolute state root directory.
 * @param teamId - the team id.
 * @param agentKey - `captain` or a member name.
 * @param messageIds - the message ids to mark delivered/read.
 */
export async function acknowledgeMailbox(
  stateRoot: string,
  teamId: string,
  agentKey: string,
  messageIds: readonly string[],
): Promise<void> {
  const now = Date.now()
  await mutateMailbox(stateRoot, teamId, agentKey, messageIds, (message) => {
    const { deliveryClaimedAt: _claimed, ...rest } = message
    return {
      ...rest,
      deliveredAt: message.deliveredAt ?? now,
      readAt: message.readAt ?? now,
    }
  })
}

/** Validate a mailbox record so later rendering cannot crash on `{}`/`null`. */
function isTeamMessage(value: unknown): value is TeamMessage {
  if (!isRecord(value)) return false
  return typeof value['id'] === 'string'
    && typeof value['from'] === 'string'
    && typeof value['to'] === 'string'
    && typeof value['content'] === 'string'
    && isFiniteNumber(value['ts'])
    && (value['deliveryClaimedAt'] === undefined || isFiniteNumber(value['deliveryClaimedAt']))
    && (value['deliveredAt'] === undefined || isFiniteNumber(value['deliveredAt']))
    && (value['readAt'] === undefined || isFiniteNumber(value['readAt']))
}
