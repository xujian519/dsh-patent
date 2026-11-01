/**
 * Shared state readers for builtin atom handlers: key configuration, text
 * values, and record guards. Semantics stay here so handlers that read the
 * same pipeline state cannot drift.
 *
 * @module @deepseek-ai/dsh-patent-core/atoms/handlers/builtin/state-keys
 */

import type { PipelineState } from '../../handler.ts'
import { isRecord } from '@deepseek-ai/dsh-value'

export { isRecord }

/**
 * Whether a value is a non-empty string.
 * @param value - candidate value.
 * @returns true when the value has non-whitespace content.
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Resolve a configured state-key name, keeping the value untrimmed.
 * @param state - stage state, including merged params.
 * @param paramKey - param carrying the key name.
 * @param fallback - key used when the param is absent.
 * @returns the configured key, or undefined when the param is invalid.
 */
export function resolveConfiguredKey(
  state: PipelineState,
  paramKey: string,
  fallback: string,
): string | undefined {
  const raw = state[paramKey]
  if (raw === undefined) return fallback
  return isNonEmptyString(raw) ? raw : undefined
}

/**
 * Resolve a configured state-key name and trim it.
 * @param state - stage state, including merged params.
 * @param paramKey - param carrying the key name.
 * @param fallback - key used when the param is absent.
 * @returns the trimmed key, or undefined when the param is invalid.
 */
export function resolveTrimmedKey(
  state: PipelineState,
  paramKey: string,
  fallback: string,
): string | undefined {
  return resolveConfiguredKey(state, paramKey, fallback)?.trim()
}

/**
 * Resolve a configured list of state-key names.
 * @param state - stage state, including merged params.
 * @param paramKey - param carrying the key list.
 * @param fallback - keys used when the param is absent.
 * @returns the configured keys, or undefined when the param is invalid.
 */
export function resolveKeyList(
  state: PipelineState,
  paramKey: string,
  fallback: readonly string[],
): string[] | undefined {
  const raw = state[paramKey]
  if (raw === undefined) return [...fallback]
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const keys: string[] = []
  for (const item of raw) {
    if (!isNonEmptyString(item)) return undefined
    keys.push(item)
  }
  return keys
}

/**
 * Read one state key as text: a string or a string array joined by newlines.
 * @param state - stage state.
 * @param key - key to read.
 * @returns trimmed text, or undefined when the key is absent, mistyped, or empty.
 */
export function readStateText(state: PipelineState, key: string): string | undefined {
  const raw = state[key]
  if (typeof raw === 'string') {
    const text = raw.trim()
    return text.length > 0 ? text : undefined
  }
  if (!Array.isArray(raw)) return undefined
  const parts = raw.filter(isNonEmptyString).map(part => part.trim())
  return parts.length > 0 ? parts.join('\n') : undefined
}
