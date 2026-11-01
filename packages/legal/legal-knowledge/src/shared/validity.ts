/**
 * Legal regulation validity determination.
 *
 * The validity rules live in `@deepseek-ai/dsh-patent-core` because the patent
 * knowledge database applies the same three-column rule. This module keeps the
 * legal-domain column names and the visible-result filter the engines use.
 * @module @deepseek-ai/dsh-legal-knowledge/shared/validity
 */

import { isLawVisible, resolveAsOf, resolveLawValidity } from '@deepseek-ai/dsh-patent-core'
import type { LegalRegulationValidity } from '../types.ts'

export { isLawVisible as isVisible, resolveAsOf, todayIsoDate } from '@deepseek-ai/dsh-patent-core'

/** Validity determination input columns. */
export type ValidityInput = {
  /** Effective date (YYYY-MM-DD). */
  effectiveDate?: string | null | undefined
  /** Expiry date (YYYY-MM-DD). */
  expiryDate?: string | null | undefined
  /** Expired flag: 0=in force, 1=expired; undefined means unverified. */
  expired?: number | null | undefined
}

/**
 * Determine the validity status of a regulation at a given point in time.
 *
 * Rules (strongest to weakest):
 * 1. expired=1 or expiryDate < asOf → expired
 * 2. effectiveDate > asOf → not yet effective
 * 3. any valid date column present and not matched above → in force
 * 4. all columns missing → unverified
 * @param input - validity columns.
 * @param asOf - point-in-time date (YYYY-MM-DD).
 * @returns the validity status.
 */
export function resolveValidity(input: ValidityInput, asOf: string): LegalRegulationValidity {
  return resolveLawValidity(
    { validFrom: input.effectiveDate, validTo: input.expiryDate, expired: input.expired },
    asOf,
  )
}

/** 检索选项中的时间效力字段。 */
type ValidityFilterOptions = {
  /** Point-in-time validity (YYYY-MM-DD); defaults to today. */
  asOf?: string | undefined
  /** Whether to return records whose validity is unverified; defaults true. */
  includeUnverified?: boolean | undefined
  /** Result cap; defaults to 10. */
  limit?: number | undefined
}

/** 带时间效力列的检索命中。 */
export type ValidityDated = {
  effectiveDate: string
  expiryDate?: string | undefined
  expired?: number | undefined
}

/**
 * Resolve each hit's validity at the requested date and drop the invisible ones.
 * Hits keep their input order, capped at the option limit.
 * @param hits - the raw hits, in relevance order.
 * @param options - as-of date, unverified visibility, and result cap.
 * @param defaultLimit - cap used when the options omit one.
 * @returns the visible hits with their resolved validity.
 */
export function filterByValidity<T extends ValidityDated>(
  hits: readonly T[],
  options: ValidityFilterOptions,
  defaultLimit = 10,
): Array<T & { validity: LegalRegulationValidity }> {
  const asOf = resolveAsOf(options.asOf)
  const includeUnverified = options.includeUnverified ?? true
  const limit = options.limit ?? defaultLimit
  const results: Array<T & { validity: LegalRegulationValidity }> = []
  for (const hit of hits) {
    if (results.length >= limit) break
    const validity = resolveValidity(hit, asOf)
    if (!isLawVisible(validity, includeUnverified)) continue
    results.push({ ...hit, validity })
  }
  return results
}
