import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage, { BackendRegistry, storageBackendServiceKey, UNIT_NAME_RE } from '../src/index.ts'
import type { StorageBackend } from '../src/index.ts'

const fakeBackend = (): StorageBackend => ({ close: async () => {} })

describe('BackendRegistry', () => {
  it('registers, resolves, and disposes names', () => {
    const registry = new BackendRegistry()
    const backend = fakeBackend()
    const dispose = registry.register('json', backend)
    expect(registry.get('json')).toBe(backend)
    expect(registry.names()).toEqual(['json'])
    dispose()
    expect(registry.names()).toEqual([])
    expect(() => registry.get('json')).toThrowMatchingObject({ code: 'backend-not-found' })
  })

  it('rejects duplicate names', () => {
    const registry = new BackendRegistry()
    registry.register('json', fakeBackend())
    expect(() => registry.register('json', fakeBackend())).toThrowMatchingObject({ code: 'duplicate-backend' })
  })
})

describe('Storage service', () => {
  it('derives stable lifecycle service keys for named backends', () => {
    expect(storageBackendServiceKey('json')).toBe('storage.backend.json')
    expect(storageBackendServiceKey('tenant-a')).toBe('storage.backend.tenant-a')
  })

  it('mounts on the context and exposes registry plus form mounting', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    expect(ctx.storage).toBeInstanceOf(Storage)

    const facility = { marker: true }
    const dispose = ctx.storage.mount('domain' as never, facility as never)
    expect(ctx.storage.form('domain' as never)).toBe(facility)
    expect(ctx.storage.domain).toBe(facility)
    expect(() => ctx.storage.mount('domain' as never, facility as never)).toThrowMatchingObject({
      code: 'duplicate-mount',
    })
    dispose()
    expect(() => ctx.storage.form('domain' as never)).toThrowMatchingObject({ code: 'form-not-mounted' })
    expect(() => ctx.storage.domain).toThrowMatchingObject({ code: 'form-not-mounted' })
  })

  it('ignores a stale disposer after dispose and re-mount / re-register', async () => {
    const ctx = new Context()
    await ctx.plugin(Storage)
    const first = { first: true }
    const second = { second: true }
    const staleMount = ctx.storage.mount('domain' as never, first as never)
    staleMount()
    ctx.storage.mount('domain' as never, second as never)
    staleMount()
    expect(ctx.storage.form('domain' as never)).toBe(second)

    const backendA = fakeBackend()
    const backendB = fakeBackend()
    const staleRegister = ctx.storage.backend.register('json', backendA)
    staleRegister()
    ctx.storage.backend.register('json', backendB)
    staleRegister()
    expect(ctx.storage.backend.get('json')).toBe(backendB)
  })
})

describe('UNIT_NAME_RE', () => {
  // The regex: /^[a-z][a-z0-9_]*$/
  // Valid: starts with lowercase letter, followed by zero or more lowercase letters, digits, or underscores.
  // Critical: used by storage-json, storage-sqlite, and storage-domain to validate unit/table names
  // before they become filesystem paths or SQL identifiers. A bug here creates SQL injection or
  // path traversal risk across every backend.

  it('accepts well-formed unit and table names across every backend', () => {
    const valid = [
      'users',
      'user_sessions',
      't1',
      'a',                          // single lowercase letter
      'abc_def_123',
      'schema',
      'global_settings',
      // Boundary: names that look dangerously close to reserved words but are valid identifiers
      'group_settings',             // 'group' would be SQL keyword, but 'group_settings' is fine
    ]
    for (const name of valid) {
      expect(UNIT_NAME_RE.test(name)).toBe(true)
    }
  })

  it('rejects names that violate the regex — every rejection matters for SQL/file safety', () => {
    const invalid = [
      // Uppercase start or anywhere
      'Users',
      'USER_DATA',
      'User_table',
      // Leading digit
      '1users',
      '0data',
      // Leading underscore
      '_users',
      '_private',
      // Empty string
      '',
      // Special characters that would escape SQL identifiers or filesystem paths
      'users; DROP TABLE',          // SQL injection classic
      'users/../../etc',            // path traversal
      'users..hidden',
      'users name',                  // space
      'users.name',                  // dot
      'users-name',                  // hyphen
      'users.name;--',
      'users\0',                     // null byte
      // Reserved SQL keywords that are valid standalone words but would need quoting
      // (these actually pass the regex — the regex deliberately allows them since
      // the backend wraps names in quotes. We verify the regex explicitly rejects
      // nothing more dangerous than what it promises.)
    ]
    for (const name of invalid) {
      expect(UNIT_NAME_RE.test(name)).toBe(false)
    }
  })

  it('rejects non-string inputs that would produce unsafe coercions', () => {
    // The regex tests whatever gets passed to it. Backend callers must pass
    // strings; here we verify the regex is not accidentally lenient toward
    // values that would become unsafe identifiers when coerced.
    expect(UNIT_NAME_RE.test(String(123))).toBe(false)         // '123' fails: starts with digit
    expect(UNIT_NAME_RE.test(String(0))).toBe(false)           // '0' fails
    expect(UNIT_NAME_RE.test(String(456.789))).toBe(false)     // '456.789' fails: dot + starts digit
    // Note: 'undefined', 'null', 'true', 'false' all happen to be valid
    // lowercase identifier shapes — the regex cannot detect semantic nonsense,
    // only identifier shape. That's the documented contract.
  })

  it('enforces the exact contract exported from backend.ts', () => {
    // Sanity: the regex exported from index.ts matches the documented pattern.
    expect(UNIT_NAME_RE.source).toBe('^[a-z][a-z0-9_]*$')
    expect(UNIT_NAME_RE.flags).toBe('')
  })
})

expect.extend({
  toThrowMatchingObject(received: () => unknown, expected: object) {
    try {
      received()
    } catch (error) {
      const pass = Object.entries(expected).every(
        entry => (error as Record<string, unknown>)[entry[0]] === entry[1],
      )
      return { pass, message: () => `expected thrown error to match ${JSON.stringify(expected)}, got ${String(error)}` }
    }
    return { pass: false, message: () => 'expected function to throw' }
  },
})

declare module 'vitest' {
  interface Assertion<T> {
    toThrowMatchingObject(expected: object): T
  }
}
