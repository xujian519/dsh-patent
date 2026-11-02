/**
 * Shared JSON readers for the claim-strategy and draft-claims atoms.
 *
 * Both stages parse a dependent-claim parent (one number or several alternative
 * citations) and a technical domain from model or state JSON. Keeping the
 * readers here means the two stages accept exactly the same vocabulary.
 *
 * @module @deepseek-ai/dsh-patent-core/atoms/handlers/builtin/claim-json
 */

import type { TechDomain } from '../../../claim-draft/index.ts'

/**
 * Read a claim number from model JSON.
 *
 * The response schema marks the number as an integer, but providers return a
 * quoted `"2"` often enough that rejecting it loses an otherwise usable
 * strategy table. A decimal string is the only tolerated deviation; anything
 * else is unusable.
 *
 * @param value - candidate value.
 * @returns the integer claim number, or undefined when the value is unusable.
 */
export function readClaimNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!/^\d+$/u.test(trimmed)) return undefined
  return Number(trimmed)
}

/**
 * Read a dependent claim's parent citation.
 * @param value - one claim number or an array of alternative citations.
 * @returns the normalized parent, or undefined when the value is unusable.
 */
export function readParent(value: unknown): number | number[] | undefined {
  const single = readClaimNumber(value)
  if (single !== undefined) return single
  if (!Array.isArray(value) || value.length === 0) return undefined
  const parents: number[] = []
  for (const item of value) {
    const parent = readClaimNumber(item)
    if (parent === undefined) return undefined
    parents.push(parent)
  }
  return parents
}

/**
 * Type guard for the supported technical domains.
 * @param value - candidate value.
 * @returns whether the value is a {@link TechDomain}.
 */
export function isTechDomain(value: unknown): value is TechDomain {
  return value === 'mechanical' || value === 'electrical' || value === 'chemical'
    || value === 'software' || value === 'general'
}
