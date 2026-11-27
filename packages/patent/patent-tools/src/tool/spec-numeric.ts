/**
 * Numeric-range checks: endpoint and midpoint example coverage.
 *
 * The range and value patterns read their separators and units from the
 * vocabulary shared with the novelty numeric-range track, so the two paths
 * cannot read the same sentence differently.
 */

import {
  NUMERIC_ANY_UNIT_ALTERNATION,
  NUMERIC_RANGE_SEPARATOR_CLASS,
  canonicalNumericUnit,
  normalizeNumericUnit,
} from '@deepseek-ai/dsh-patent-core'
import type { NumericRange } from './spec-types.ts'

/**
 * Numeric range (e.g. 20-90℃, 20℃至90℃, 20毫米至90毫米).
 *
 * Separators and units come from the vocabulary shared with the novelty
 * numeric-range track, so the two paths cannot read the same text differently.
 * The trailing unit stays required here: endpoint and midpoint coverage compares
 * single values of the same unit, which needs the range unit to be stated. The
 * alternation carries the Chinese spellings too, because this path can only see
 * a unit that follows the number: a range written 20毫米至90毫米 would otherwise
 * match nothing and the endpoint/midpoint checks would silently not run.
 */
const RANGE_PATTERN = new RegExp(
  `(\\d+(?:\\.\\d+)?)\\s*(?:${NUMERIC_ANY_UNIT_ALTERNATION})?\\s*(?:[${NUMERIC_RANGE_SEPARATOR_CLASS}])\\s*(\\d+(?:\\.\\d+)?)\\s*(${NUMERIC_ANY_UNIT_ALTERNATION})`,
  'g',
)

/** Single value with a unit (e.g. 60℃, 5mm, 60毫米). */
const VALUE_PATTERN = new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(${NUMERIC_ANY_UNIT_ALTERNATION})`, 'g')

/**
 * Extract numeric ranges from the text (kept only when min < max).
 * @param text - the text to scan.
 * @returns the numeric ranges found.
 */
export function extractNumericRanges(text: string): NumericRange[] {
  const ranges: NumericRange[] = []
  let m: RegExpExecArray | null
  RANGE_PATTERN.lastIndex = 0
  while ((m = RANGE_PATTERN.exec(text)) !== null) {
    const min = Number(m[1])
    const max = Number(m[2])
    if (Number.isFinite(min) && Number.isFinite(max) && min < max) {
      /* v8 ignore next -- the range pattern always captures the units group. */
      ranges.push({ min, max, unit: normalizeNumericUnit(m[3] ?? '') })
    }
  }
  return ranges
}

function extractNumericValues(text: string): Array<{ value: number; unit: string }> {
  const body = text.replace(RANGE_PATTERN, ' ')
  const values: Array<{ value: number; unit: string }> = []
  let m: RegExpExecArray | null
  VALUE_PATTERN.lastIndex = 0
  while ((m = VALUE_PATTERN.exec(body)) !== null) {
    const value = Number(m[1])
    if (Number.isFinite(value)) {
      /* v8 ignore next -- the value pattern always captures the units group. */
      values.push({ value, unit: normalizeNumericUnit(m[2] ?? '') })
    }
  }
  return values
}

/**
 * Range endpoint + midpoint example detection: returns (missing-endpoint, missing-midpoint).
 * @param text - the text to scan.
 * @returns ranges missing an endpoint example and ranges missing a midpoint example.
 */
export function checkNumericRangeCoverage(text: string): {
  endpointMissing: NumericRange[]
  midpointMissing: NumericRange[]
} {
  const ranges = extractNumericRanges(text)
  const values = extractNumericValues(text)
  const endpointMissing: NumericRange[] = []
  const midpointMissing: NumericRange[] = []
  for (const range of ranges) {
    // 同一单位的中英文写法（20毫米至90毫米 / 50mm）算同一个单位：比对看规范键，
    // 展示仍用原文写法。
    const rangeUnit = canonicalNumericUnit(range.unit)
    const sameUnit = values.filter(v => canonicalNumericUnit(v.unit) === rangeUnit)
    const hasEndpoint = sameUnit.some(v => v.value === range.min || v.value === range.max)
    const hasMidpoint = sameUnit.some(v => v.value > range.min && v.value < range.max)
    if (!hasEndpoint) endpointMissing.push(range)
    if (!hasMidpoint) midpointMissing.push(range)
  }
  return { endpointMissing, midpointMissing }
}

/**
 * Render one range for model-facing messages, spelling the normalized degree
 * unit back as ℃.
 * @param range - the range to render.
 * @returns the rendered range text.
 */
export function formatRange(range: NumericRange): string {
  return `${range.min}-${range.max}${range.unit === '°' ? '℃' : range.unit}`
}
