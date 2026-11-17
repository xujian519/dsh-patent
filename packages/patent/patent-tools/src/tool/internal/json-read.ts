/**
 * Field readers for a tool value that is canonical JSON or a domain object the
 * tool just built. Each reader narrows with `typeof` and `Array.isArray`.
 * @module @deepseek-ai/dsh-patent-tools/tool/internal/json-read
 */

/**
 * Whether a value is a non-array object whose own fields can be read.
 * @param value - candidate JSON value or domain object.
 * @returns true when field reads are safe.
 */
export function isDataRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Own enumerable fields of a record, or an empty list when the value is not one.
 * @param value - candidate record.
 * @returns the entries.
 */
export function recordEntries(value: unknown): Array<[string, unknown]> {
  return isDataRecord(value) ? Object.entries(value) : []
}

/**
 * Own field, or undefined when the value is not a record or the field is absent.
 * @param value - candidate record.
 * @param key - field name.
 * @returns the raw field.
 */
export function recordValue(value: unknown, key: string): unknown {
  if (!isDataRecord(value) || !Object.hasOwn(value, key)) return undefined
  return value[key]
}

/**
 * String field, or undefined when the field is absent or not a string.
 * @param value - candidate record.
 * @param key - field name.
 * @returns the string field.
 */
export function recordString(value: unknown, key: string): string | undefined {
  const raw = recordValue(value, key)
  return typeof raw === 'string' ? raw : undefined
}

/**
 * String field, or an empty string when it is absent or not a string.
 * @param value - candidate record.
 * @param key - field name.
 * @returns the string field, or `''`.
 */
export function recordText(value: unknown, key: string): string {
  return recordString(value, key) ?? ''
}

/**
 * A string that may be omitted, or an empty string when it is.
 * @param value - the string, or undefined.
 * @returns the string, or `''`.
 */
export function textOrEmpty(value: string | undefined): string {
  return value ?? ''
}

/**
 * String or finite number field, rendered as text. Anything else is empty.
 * @param value - candidate record.
 * @param key - field name.
 * @returns the display text.
 */
export function recordDisplay(value: unknown, key: string): string {
  const raw = recordValue(value, key)
  if (typeof raw === 'string') return raw
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  return ''
}

/**
 * Finite number field, or the fallback when it is absent or not a finite number.
 * @param value - candidate record.
 * @param key - field name.
 * @param fallback - value used when the field is not a finite number.
 * @returns the number field, or `fallback`.
 */
export function recordNumberOr(value: unknown, key: string, fallback: number): number {
  const raw = recordValue(value, key)
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback
}

/**
 * Whether a field is exactly `true`.
 * @param value - candidate record.
 * @param key - field name.
 * @returns true only for a boolean true.
 */
export function recordFlag(value: unknown, key: string): boolean {
  return recordValue(value, key) === true
}

/**
 * Nested record field.
 * @param value - candidate record.
 * @param key - field name.
 * @returns the nested record, or undefined.
 */
export function recordChild(value: unknown, key: string): Record<string, unknown> | undefined {
  const child = recordValue(value, key)
  return isDataRecord(child) ? child : undefined
}

/**
 * Array field, or an empty array when the field is absent or not an array.
 * @param value - candidate record.
 * @param key - field name.
 * @returns the array elements.
 */
export function recordList(value: unknown, key: string): unknown[] {
  return dataList(recordValue(value, key))
}

/**
 * Array value, or an empty array when the value is not an array.
 * @param value - candidate array.
 * @returns the elements.
 */
export function dataList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * Array value, or an empty array when the value is not an array.
 * @param value - candidate array, including an omitted list.
 * @returns the elements.
 */
export function listOrEmpty(value: readonly unknown[] | undefined): readonly unknown[] {
  return value ?? []
}

/**
 * String elements of an array, skipping anything that is not a string.
 * @param value - candidate array.
 * @returns the string elements, in order.
 */
export function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/**
 * Finite number elements of an array, skipping anything else.
 * @param value - candidate array.
 * @returns the finite numbers, in order.
 */
export function numberList(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is number => typeof item === 'number' && Number.isFinite(item))
}

/**
 * Text preview of one JSON field. A string is kept. `undefined` is empty.
 * Other JSON values use `JSON.stringify`.
 * @param value - the field value.
 * @returns the preview text.
 */
export function jsonPreview(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  return JSON.stringify(value)
}

/**
 * Label stored under a string key, or the key itself when the map has no entry.
 * A non-string value reads as an empty string.
 * @param labels - key to display text.
 * @param value - candidate key.
 * @returns the label, the key, or `''`.
 */
export function namedLabel(labels: object, value: unknown): string {
  if (typeof value !== 'string') return ''
  if (!isDataRecord(labels) || !Object.hasOwn(labels, value)) return value
  const label = labels[value]
  return typeof label === 'string' ? label : value
}
