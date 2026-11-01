/**
 * Builtin atom tunables read from stage state (merged stage params).
 *
 * Deployment-varying limits live here instead of handler-local constants: an
 * absent param keeps the handler's documented default, an invalid one degrades
 * the stage at the earliest resolvable point. The keys are plain state keys so
 * cordis.yml stage params can set them without code changes.
 *
 * @module @deepseek-ai/dsh-patent-core/atoms/tunables
 */

import type { PipelineState } from './handler.ts'

/** Outcome of reading one numeric tunable. */
type TunableResult =
  | {
    ok: true
    value: number
    /** Whether the stage supplied the key (handlers keep per-block defaults when false). */
    configured: boolean
  }
  | { ok: false; reason: string }

/**
 * Read a numeric tunable; absent uses the fallback, malformed or out-of-range degrades.
 * @param state - stage state, including merged params.
 * @param key - state key carrying the override.
 * @param fallback - handler default when the key is absent.
 * @param isValid - range/shape predicate for a supplied value.
 * @param expected - human-readable expectation used in the degradation reason.
 * @returns the value or a degradation reason.
 */
function readTunable(
  state: PipelineState,
  key: string,
  fallback: number,
  isValid: (value: number) => boolean,
  expected: string,
): TunableResult {
  const raw = state[key]
  if (raw === undefined) return { ok: true, value: fallback, configured: false }
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !isValid(raw)) {
    return { ok: false, reason: `params.${key} 必须是：${expected}` }
  }
  return { ok: true, value: raw, configured: true }
}

/** Default score below which a feature is reported as low confidence. */
export const DEFAULT_GROUNDEDNESS_THRESHOLD = 0.6

/** Default maximum size of one claim-chart source file, in UTF-8 bytes. */
export const DEFAULT_CHART_SOURCE_MAX_BYTES = 1024 * 1024

/** Hard ceiling for a configured claim-chart source size limit. */
export const MAX_CHART_SOURCE_MAX_BYTES = 16 * 1024 * 1024

/** Defaults a handler supplies for its tunable surface. */
type AtomTunableDefaults = {
  temperature: number
  promptLimit: number
  maxRetries?: number
  groundednessThreshold?: number
}

/** Resolved tunables for one handler call. */
type AtomTunables = {
  temperature: number
  promptLimit: number
  /** Whether the stage supplied `prompt_char_limit`; per-block defaults apply when false. */
  promptLimitConfigured: boolean
  /** Zero for handlers that do not redo model calls. */
  maxRetries: number
  /** Handler default for handlers that do not filter by score. */
  groundednessThreshold: number
}

/** Outcome of resolving a handler's tunable surface. */
type AtomTunablesResult =
  | { ok: true; tunables: AtomTunables }
  | { ok: false; reason: string }

/**
 * Read every tunable a handler accepts in one step.
 * @param state - stage state, including merged params.
 * @param defaults - handler defaults for the fields it consumes.
 * @returns the resolved values or the first invalid value's reason.
 */
export function readAtomTunables(state: PipelineState, defaults: AtomTunableDefaults): AtomTunablesResult {
  const temperature = readTemperature(state, defaults.temperature)
  if (!temperature.ok) return temperature
  const promptLimit = readPromptCharLimit(state, defaults.promptLimit)
  if (!promptLimit.ok) return promptLimit
  let maxRetries = 0
  if (defaults.maxRetries !== undefined) {
    const resolved = readMaxRetries(state, defaults.maxRetries)
    if (!resolved.ok) return resolved
    maxRetries = resolved.value
  }
  let groundednessThreshold = DEFAULT_GROUNDEDNESS_THRESHOLD
  if (defaults.groundednessThreshold !== undefined) {
    const resolved = readGroundednessThreshold(state, defaults.groundednessThreshold)
    if (!resolved.ok) return resolved
    groundednessThreshold = resolved.value
  }
  return {
    ok: true,
    tunables: {
      temperature: temperature.value,
      promptLimit: promptLimit.value,
      promptLimitConfigured: promptLimit.configured,
      maxRetries,
      groundednessThreshold,
    },
  }
}

/**
 * Read the per-call sampling temperature.
 * @param state - stage state, including merged params.
 * @param fallback - handler default temperature.
 * @returns the configured value in [0, 2], or a degradation reason.
 */
export function readTemperature(state: PipelineState, fallback: number): TunableResult {
  return readTunable(state, 'temperature', fallback, value => value >= 0 && value <= 2, '0-2 的数字')
}

/**
 * Read the maximum number of atom-level redo attempts.
 * @param state - stage state, including merged params.
 * @param fallback - handler default retry count.
 * @returns an integer in [0, 10], or a degradation reason.
 */
export function readMaxRetries(state: PipelineState, fallback: number): TunableResult {
  return readTunable(
    state,
    'max_retries',
    fallback,
    value => Number.isInteger(value) && value >= 0 && value <= 10,
    '0-10 的整数',
  )
}

/**
 * Read the character cap for quoted source text embedded in a prompt. Handlers apply
 * it to their source excerpts; short generated lines (target lists, feature lists,
 * revision hints) keep their own handling.
 * @param state - stage state, including merged params.
 * @param fallback - handler default cap.
 * @returns a positive integer, or a degradation reason.
 */
export function readPromptCharLimit(state: PipelineState, fallback: number): TunableResult {
  return readTunable(
    state,
    'prompt_char_limit',
    fallback,
    value => Number.isInteger(value) && value >= 1,
    '正整数',
  )
}

/**
 * Read the groundedness score below which a feature is reported as low confidence.
 * @param state - stage state, including merged params.
 * @param fallback - handler default threshold.
 * @returns the configured value in [0, 1], or a degradation reason.
 */
export function readGroundednessThreshold(state: PipelineState, fallback: number): TunableResult {
  return readTunable(
    state,
    'groundedness_threshold',
    fallback,
    value => value >= 0 && value <= 1,
    '0-1 的数字',
  )
}

/** Outcome of reading the claim-chart source roots. */
type ChartSourceRootsResult =
  | {
    ok: true
    /** `undefined` keeps the handler default (the working directory); `[]` allows no root. */
    roots: string[] | undefined
  }
  | { ok: false; reason: string }

/**
 * Read the allowed roots for claim-chart source files. An absent key keeps the
 * working-directory default; an explicit list replaces it, and an empty list
 * denies every source read instead of widening access.
 * @param state - stage state, including merged params.
 * @returns the configured roots or a degradation reason.
 */
export function readChartSourceRoots(state: PipelineState): ChartSourceRootsResult {
  const raw = state['chart_source_roots']
  if (raw === undefined) return { ok: true, roots: undefined }
  if (!Array.isArray(raw)) {
    return { ok: false, reason: 'params.chart_source_roots 必须是：非空字符串组成的数组' }
  }
  const roots: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      return { ok: false, reason: 'params.chart_source_roots 必须是：非空字符串组成的数组' }
    }
    roots.push(entry)
  }
  return { ok: true, roots }
}

/**
 * Read the size limit for one claim-chart source file.
 * @param state - stage state, including merged params.
 * @returns a positive byte count up to {@link MAX_CHART_SOURCE_MAX_BYTES}, or a degradation reason.
 */
export function readChartSourceMaxBytes(state: PipelineState): TunableResult {
  return readTunable(
    state,
    'chart_source_max_bytes',
    DEFAULT_CHART_SOURCE_MAX_BYTES,
    value => Number.isInteger(value) && value >= 1 && value <= MAX_CHART_SOURCE_MAX_BYTES,
    `1-${MAX_CHART_SOURCE_MAX_BYTES} 的整数`,
  )
}
