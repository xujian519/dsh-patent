/**
 * Result-cap normalization shared by the patent knowledge tools and engines.
 *
 * SQLite binds a cap as `LIMIT ?`: a fractional or non-finite operand is a
 * datatype error, and a negative operand means "no limit", so a caller-supplied
 * cap must be truncated and clamped before it reaches a query. The tool layer
 * and the knowledge engines call one implementation so a cap means the same
 * thing on both sides.
 * @module @deepseek-ai/dsh-patent-core/knowledge/result-limit
 */

/**
 * Normalize a requested result cap.
 * @param value - the requested cap, or undefined when the caller omitted it.
 * @param fallback - cap used when the parameter is omitted or not finite.
 * @param max - largest cap the caller accepts.
 * @returns an integer in `[1, max]`.
 */
export function resolveResultLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(Math.max(Math.trunc(value), 1), max)
}
