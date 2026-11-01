/**
 * Shared mapping from a connector failure to model-facing, actionable guidance.
 * Both literature tools report source failures this way, so rate limiting reads
 * the same wherever it surfaces.
 * @module @deepseek-ai/dsh-tool-literature/tool/source-error
 */

import type { Connector } from '../protocol/types.ts'

/** The connector fields the guidance needs. */
type SourceIdentity = Pick<Connector, 'id' | 'name'>

/** Messages carrying these status codes (or the words "rate limit") mean throttling. */
const RATE_LIMIT_PATTERN = /\b(429|503|408)\b/
const RATE_LIMIT_WORD = /rate.?limit/i

/**
 * Describe a connector failure as guidance the model can act on.
 * @param source - the connector that failed (routing id and display name).
 * @param error - the thrown value; non-Error values are stringified.
 * @returns guidance text distinguishing throttling from other failures.
 */
export function describeSourceError(source: SourceIdentity, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const rateLimited = RATE_LIMIT_PATTERN.test(message) || RATE_LIMIT_WORD.test(message)
  if (!rateLimited) return `${source.name} returned an error: ${message}`
  const hint = source.id === 'arxiv' ? ' (arXiv allows ~1 request every 3s)' : ''
  return `${source.name} is rate limiting requests. Wait a few seconds, then retry${hint}.`
}
