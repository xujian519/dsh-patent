/**
 * Compile-time lock between a zod schema and the interface callers use.
 * @module @deepseek-ai/dsh-video-mode/schema-lock
 */

import type { z } from 'zod'

type Equal<Left, Right> = [Left] extends [Right] ? [Right] extends [Left] ? true : false : false

/** Drop `readonly` so a schema's mutable output can be compared with an interface. */
type Writable<T> = T extends readonly (infer Element)[]
  ? Writable<Element>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Writable<T[Key]> }
    : T

/** Checker that returns its schema when the parsed fields match `Interface`. */
type LockedSchema<Interface> = <Schema extends z.ZodType>(
  schema: Schema & (Equal<z.output<Schema>, Writable<Interface>> extends true ? unknown : never),
) => Schema

/**
 * Return `schema` when its parsed fields match `Interface`.
 *
 * A field added, removed, or retyped on only one side fails typecheck.
 * Numeric bounds such as `max(3600)` stay on the schema and are not part of the interface.
 * @returns a function that returns the same schema.
 */
export function lockToInterface<Interface>(): LockedSchema<Interface> {
  return <Schema extends z.ZodType>(
    schema: Schema & (Equal<z.output<Schema>, Writable<Interface>> extends true ? unknown : never),
  ): Schema => schema
}
