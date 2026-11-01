/**
 * Browser stand-in for `node:module` (Vite alias). Exports stay public for the
 * alias surface even when no source file imports them by name.
 */

/** Fail if browser boot reaches Node's module loader. */
export const createRequire = (): never => {
  throw new Error('node:module is not available in the browser')
}

/** Type-only peer for the vendored loader; kept for the alias module face. */
export type LoadHookContext = never
