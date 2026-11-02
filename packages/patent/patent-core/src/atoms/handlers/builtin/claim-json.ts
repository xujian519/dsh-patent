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
 * Read a dependent claim's parent citation.
 * @param value - one claim number or an array of alternative citations.
 * @returns the normalized parent, or undefined when the value is unusable.
 */
export function readParent(value: unknown): number | number[] | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value
  if (!Array.isArray(value) || value.length === 0) return undefined
  const parents: number[] = []
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item)) return undefined
    parents.push(item)
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
