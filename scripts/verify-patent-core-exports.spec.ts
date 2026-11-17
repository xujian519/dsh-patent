/**
 * Tests for the patent-core export gate: which import forms count, which files
 * are outside the package, and which barrel forms fail.
 */

import { describe, expect, it } from 'vitest'
import {
  PATENT_CORE_SPECIFIER,
  barrelViolations,
  namesImportedFromPatentCore,
  readBarrelExports,
} from './verify-patent-core-exports.ts'

const entry = 'packages/patent/patent-core/src/index.ts'

describe('readBarrelExports', () => {
  it('lists named exports and rejects a star', () => {
    const barrel = readBarrelExports([
      'export { kept, dropped } from "./mod.ts"',
      'export type { KeptType } from "./mod.ts"',
      'export type * from "./other.ts"',
    ].join('\n'), entry)
    expect(barrel.names.map(item => item.name)).toEqual(['kept', 'dropped', 'KeptType'])
    expect(barrel.stars).toEqual([{ line: 3 }])
  })

  it('treats @public on the statement or the specifier as an explicit exception', () => {
    const barrel = readBarrelExports([
      '/** @public */',
      'export { stated } from "./mod.ts"',
      'export {',
      '  /** @public */',
      '  marked,',
      '  plain,',
      '} from "./mod.ts"',
    ].join('\n'), entry)
    expect(barrel.names.find(item => item.name === 'stated')?.documentedPublic).toBe(true)
    expect(barrel.names.find(item => item.name === 'marked')?.documentedPublic).toBe(true)
    expect(barrel.names.find(item => item.name === 'plain')?.documentedPublic).toBe(false)
  })
})

describe('namesImportedFromPatentCore', () => {
  it('reads named imports, type queries, and dynamic bindings', () => {
    const text = [
      `import { kept, type KeptType } from '${PATENT_CORE_SPECIFIER}'`,
      `export { forwarded } from '${PATENT_CORE_SPECIFIER}'`,
      `let rule: import('${PATENT_CORE_SPECIFIER}').RuleSet`,
      `const { parseRetrySignals: parse } = await import('${PATENT_CORE_SPECIFIER}')`,
      `const label = '${PATENT_CORE_SPECIFIER} dropped'`,
    ].join('\n')
    expect(namesImportedFromPatentCore(text, 'consumer.ts')).toEqual([
      'kept',
      'KeptType',
      'forwarded',
      'RuleSet',
      'parseRetrySignals',
    ])
  })

  it('records a namespace import and ignores another package', () => {
    const text = [
      `import * as Core from '${PATENT_CORE_SPECIFIER}'`,
      'import { dropped } from "@deepseek-ai/dsh-law-core"',
    ].join('\n')
    expect(namesImportedFromPatentCore(text, 'consumer.ts')).toEqual(['*'])
  })

  it('ignores the specifier when the file does not mention the package', () => {
    expect(namesImportedFromPatentCore('export const dropped = 1\n', 'other.ts')).toEqual([])
  })
})

describe('barrelViolations', () => {
  it('reports a star and an export nobody outside the package imports', () => {
    const barrel = readBarrelExports([
      'export { kept, dropped } from "./mod.ts"',
      'export type * from "./other.ts"',
    ].join('\n'), entry)
    expect(barrelViolations(barrel, new Set(['kept']))).toEqual([
      `${entry}:2 uses export *, which publishes names this gate does not list. Name each export.`,
      `${entry}:1 exports dropped, which no file outside the package imports. Mark the specifier @public or stop exporting it.`,
    ])
  })

  it('accepts an imported name, a @public name, and a namespace importer', () => {
    const barrel = readBarrelExports([
      '/** @public */',
      'export { marked } from "./mod.ts"',
      'export { kept } from "./mod.ts"',
    ].join('\n'), entry)
    expect(barrelViolations(barrel, new Set(['kept']))).toEqual([])
    expect(barrelViolations(barrel, new Set(['*']))).toEqual([])
  })
})
