import { describe, expect, it } from 'vitest'
import {
  collectPluginDefaultViolations,
  readDefaultDeclarations,
  type SourceInput,
} from './verify-plugin-defaults.ts'

function source(path: string, body: string[]): SourceInput {
  return { path, source: `${body.join('\n')}\n` }
}

describe('plugin default declarations', () => {
  it('reads schema defaults and config fallbacks with line numbers', () => {
    const declarations = readDefaultDeclarations(source('packages/patent/probe/src/config.ts', [
      'export const Config = z.object({',
      '  pageSize: z.number().default(30),',
      '  label: z.string().default("patent"),',
      '})',
      'const size = options.pageSize ?? 30',
    ]))

    expect(declarations.defaults).toEqual([
      { path: 'packages/patent/probe/src/config.ts', line: 2, field: 'pageSize', value: '30' },
      { path: 'packages/patent/probe/src/config.ts', line: 3, field: 'label', value: '"patent"' },
    ])
    expect(declarations.fallbacks).toEqual([
      { path: 'packages/patent/probe/src/config.ts', line: 5, field: 'pageSize', value: '30' },
    ])
  })
})

describe('duplicated plugin defaults', () => {
  it('reports a fallback that restates a schema default in the same package', () => {
    const files = [
      source('packages/patent/probe/src/config.ts', [
        'export const Config = z.object({ pageSize: z.number().default(30) })',
      ]),
      source('packages/patent/probe/src/index.ts', [
        'const size = options.pageSize ?? 30',
      ]),
    ]

    expect(collectPluginDefaultViolations(files)).toEqual([
      'packages/patent/probe/src/index.ts:1: pageSize falls back to 30,'
      + ' already declared at packages/patent/probe/src/config.ts:1',
    ])
  })

  it('accepts a fallback whose literal differs from the schema default', () => {
    const files = [
      source('packages/patent/probe/src/config.ts', [
        'export const Config = z.object({ pageSize: z.number().default(30) })',
      ]),
      source('packages/patent/probe/src/index.ts', ['const size = options.pageSize ?? 50']),
    ]

    expect(collectPluginDefaultViolations(files)).toEqual([])
  })

  it('accepts a shared constant on both sides', () => {
    const files = [
      source('packages/patent/probe/src/config.ts', [
        'export const Config = z.object({ pageSize: z.number().default(DEFAULT_PAGE_SIZE) })',
      ]),
      source('packages/patent/probe/src/index.ts', [
        'const size = options.pageSize ?? DEFAULT_PAGE_SIZE',
      ]),
    ]

    expect(collectPluginDefaultViolations(files)).toEqual([])
  })

  it('does not match the same field name across packages', () => {
    const files = [
      source('packages/patent/probe/src/config.ts', [
        'export const Config = z.object({ pageSize: z.number().default(30) })',
      ]),
      source('packages/patent/other/src/index.ts', ['const size = options.pageSize ?? 30']),
    ]

    expect(collectPluginDefaultViolations(files)).toEqual([])
  })
})
