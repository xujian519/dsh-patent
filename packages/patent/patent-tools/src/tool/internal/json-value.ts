/**
 * Copy tool results into canonical JSON without an assertion through `unknown`.
 * @module @deepseek-ai/dsh-patent-tools/tool/internal/json-value
 */

import { snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { PatentToolError } from '../../error.ts'

/**
 * Drop object properties whose value is `undefined`. JSON omits those
 * properties; a lossless snapshot rejects the whole value instead.
 * @param value - candidate data.
 * @param seen - objects already visited, so a cycle is left for the snapshot to reject.
 * @returns data with undefined object properties removed.
 */
function omitUndefined(value: unknown, seen: Set<object>): unknown {
  if (typeof value !== 'object' || value === null) return value
  if (seen.has(value)) return value
  seen.add(value)
  if (Array.isArray(value)) return value.map(item => omitUndefined(item, seen))
  const copy: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) copy[key] = omitUndefined(child, seen)
  }
  return copy
}

/**
 * Copy one tool field into canonical JSON.
 *
 * `snapshotJsonValue` accepts any candidate and returns its argument type, so
 * the copy is asserted to {@link JsonValue} here: the helper returns that type
 * only after a lossless snapshot exists.
 * @param value - plain data the tool is about to return.
 * @returns a detached JSON value.
 * @throws PatentToolError when the value cannot round-trip through JSON.
 */
export function toJsonValue(value: object): JsonValue {
  const prepared = omitUndefined(value, new Set())
  const snapshot = snapshotJsonValue(prepared) as JsonValue | undefined
  if (snapshot === undefined) {
    throw new PatentToolError('tool_execution_failed', '工具结果含有不能无损写入 JSON 的值', {})
  }
  return snapshot
}

/**
 * Copy one tool field into a canonical JSON array.
 * @param value - array the tool is about to return.
 * @returns a detached JSON array.
 * @throws PatentToolError when the value is not a JSON array.
 */
export function toJsonArray(value: object): JsonValue[] {
  const snapshot = toJsonValue(value)
  if (!Array.isArray(snapshot)) {
    throw new PatentToolError('tool_execution_failed', '工具结果不是可无损写入 JSON 的数组', {})
  }
  return snapshot
}
