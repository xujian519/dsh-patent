/**
 * Shared value primitives for classifying, validating, and rendering
 * `unknown` inputs at parser and config boundaries: object guards, key-set
 * validation, fail-loud positive number assertions, filesystem errno and
 * abort-error tests, and thrown-value normalization. Pure predicates and pure
 * operations only — no I/O; `deepFreeze` is re-exported from
 * `@deepseek-ai/dsh-util-values`, the harness-wide owner of the shared
 * deep-freeze implementation.
 * @module @deepseek-ai/dsh-value
 */

/**
 * Test whether a value is a non-null, non-array object. Class instances,
 * `Map`, `Date`, and `RegExp` all pass: the guard owns the object shape, not
 * the prototype. Arrays and `null` are rejected because callers index them
 * differently than records.
 *
 * @param value The untrusted value to classify.
 * @returns Whether the value behaves as a record of unknown values.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read an untrusted value as a record: the same test `isRecord` performs,
 * returning the record itself rather than a boolean, so a decoder can hand the
 * narrowed value straight to its own readers.
 *
 * @param value The untrusted value to read.
 * @returns The value as a record of unknown values, or `null` when it is an array, `null`, or a scalar.
 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

/**
 * Assert a positive integer (>= 1) and narrow an `unknown` value to `number`.
 *
 * @param label Diagnostic label naming the validated input; the thrown message
 *   reads `${label} must be a positive integer`.
 * @param value The untrusted value to validate.
 * @returns the same value narrowed to `number` (assertion only; never returns otherwise).
 * @throws TypeError when `value` is not an integer >= 1.
 */
export function assertPositiveInteger(label: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer`)
  }
}

/**
 * Assert a positive finite number (not necessarily an integer) and narrow an
 * `unknown` value to `number`.
 *
 * @param label Diagnostic label naming the validated input; the thrown message
 *   reads `${label} must be a positive finite number`.
 * @param value The untrusted value to validate.
 * @returns the same value narrowed to `number` (assertion only; never returns otherwise).
 * @throws TypeError when `value` is not a finite number > 0.
 */
export function assertPositiveFinite(label: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive finite number`)
  }
}

/**
 * The plugin-config shape after schemastery applied the schema defaults: every
 * field is present except the keys the caller declares as defaultless.
 */
export type ResolvedConfig<C extends object, K extends keyof C & string = never> = Required<Omit<C, K>> & Pick<C, K>

/**
 * Assert the plugin-config boundary where the schema has already run: fields
 * backed by a schema default are present, and only the declared defaultless
 * keys may be `undefined`. The type system cannot encode that fact (the schema
 * output type is unconditional, and the hand-written `Config` interface is all
 * optional), which is why every consumer previously restated a local resolved
 * alias and cast. This is the single assertion point: a bypassed schema or a
 * dropped default fails loud here at load instead of surfacing as `undefined`
 * at a read site. Key presence is not reconstructed — an object omitting the
 * key entirely passes, so callers constructing configs by hand must still go
 * through their schema.
 *
 * @param label Diagnostic label naming the config owner; it prefixes the thrown message.
 * @param config The config value as delivered by the schema boundary.
 * @param defaultlessKeys The fields the schema leaves optional (no default).
 * @returns The same object, typed at its resolved shape.
 * @throws Error when a non-defaultless field is `undefined`.
 */
export function assertResolvedConfig<C extends object, K extends keyof C & string = never>(
  label: string,
  config: C,
  defaultlessKeys: readonly K[] = [],
): ResolvedConfig<C, K> {
  const defaultless = new Set<string>(defaultlessKeys)
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined && !defaultless.has(key)) {
      throw new Error(`${label}: config field "${key}" is undefined after schema resolution; a schema default did not run`)
    }
  }
  return config as ResolvedConfig<C, K>
}

/**
 * Test whether a value is a plain data object: a non-array object whose
 * prototype is `Object.prototype` or `null`. Primitives, `null`, arrays, and
 * class instances are rejected.
 *
 * @param value The untrusted value to classify.
 * @returns Whether the value is a plain object.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Test whether a record carries exactly the expected own keys: every key in
 * `required` is present, and no own key outside `required` plus `optional` is.
 * Inherited keys do not count, so a decoded durable value passes only on the
 * keys it literally declares. The caller narrows with {@link isRecord} first.
 *
 * @param value The record to inspect.
 * @param required The keys that must all be own properties.
 * @param optional Additional own keys that may be present but are not required.
 * @returns Whether the record's own key set is `required` plus `optional`.
 */
export function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => allowed.has(key))
}

/**
 * Test whether a caught error reports Node's ENOENT code: the target path does
 * not exist. Only real `Error` instances qualify, so every other failure —
 * including a non-error lookalike carrying `code` — surfaces to the caller.
 *
 * @param error The caught value from a filesystem call.
 * @returns Whether the error means absence.
 */
export function isENOENT(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/**
 * Test whether a caught error reports Node's EEXIST code: an exclusive create
 * found an existing target. Only real `Error` instances qualify, so every
 * other failure surfaces to the caller.
 *
 * @param error The caught value from a filesystem call.
 * @returns Whether the error means the target already exists.
 */
export function isEEXIST(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}

/**
 * Test whether a caught error reports an abort: a real `Error` whose `name` is
 * `AbortError`. That is what an aborted `AbortSignal` carries as its reason and
 * what `fetch` rejects with, in every supported runtime — a `DOMException`
 * named `AbortError` is an `Error` instance there. Only real `Error` instances
 * qualify, so a lookalike carrying `name: 'AbortError'` surfaces to the caller
 * instead of being reported as an abort.
 *
 * @param error The caught value from an abortable operation.
 * @returns Whether the error means the operation was aborted.
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export { deepFreeze } from '@deepseek-ai/dsh-util-values'

/**
 * Render an arbitrary thrown value as a short human-readable message without
 * letting coercion escape: `Error` instances render `.message` coerced to a
 * string — the property is writable and may hold any value at run time, while
 * this function promises a string — non-Error objects carrying a string
 * `message` property (e.g. `throw { message: 'denied' }`) render it, everything
 * else is stringified. The renderer is total — a hostile thrown value that
 * traps `instanceof`, property access, or string coercion yields the fixed
 * `[unrenderable thrown value]` placeholder, so diagnostics keep a consistent
 * format across the harness.
 *
 * @param value The caught value to render.
 * @returns The rendered message.
 */
export function errorMessage(value: unknown): string {
  try {
    if (value instanceof Error) {
      // `message` is writable and may hold a non-string at run time.
      const message: unknown = value.message
      return String(message)
    }
    if (typeof value === 'object' && value !== null && 'message' in value) {
      const message: unknown = value.message
      if (typeof message === 'string') return message
    }
    return String(value)
  } catch {
    return '[unrenderable thrown value]'
  }
}

/**
 * Normalize an arbitrary thrown value to a total `Error` without trusting
 * coercion: real `Error` instances pass through untouched, everything else
 * becomes an `Error` carrying the {@link errorMessage} rendering. The
 * `instanceof` probe is itself guarded — a hostile thrown value that traps it
 * falls through to the total renderer instead of throwing from the catch
 * handler and masking the original failure.
 *
 * @param value The caught value to normalize.
 * @returns The value as an `Error`.
 */
export function toError(value: unknown): Error {
  try {
    if (value instanceof Error) return value
  } catch (error) {
    // A hostile proxy may throw during instanceof; fall through to the total renderer.
    void error
  }
  return new Error(errorMessage(value))
}

/**
 * Escape special regex metacharacters in a literal string so it can be
 * safely interpolated into a regex source. Matches the TC39 proposal for
 * `RegExp.escape`.
 * @param value - The literal text.
 * @returns A string safe to drop into a regex source.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
