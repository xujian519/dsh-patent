import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  compareBaseline,
  isResourceImport,
  packageViolations,
  parseBaseline,
  prunedBaseline,
  resolveClientImport,
} from './verify-client-domain-graph.ts'

const fixtures: string[] = []

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-domain-graph-'))
  fixtures.push(dir)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  return dir
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('client domain import resolution', () => {
  it('preserves imports that leave src/client from a top-level file', () => {
    expect(resolveClientImport('styles.ts', '../styles/base.css?inline'))
      .toBe('../styles/base.css?inline')
  })

  it('normalizes imports between domains inside src/client', () => {
    expect(resolveClientImport('input/hub.ts', '../queue/store.ts'))
      .toBe('queue/store.ts')
  })
})

describe('client domain resources', () => {
  it('treats image and font paths as resources, not domain edges', () => {
    expect(isResourceImport('./assets/onboarding-welcome.webp')).toBe(true)
    expect(isResourceImport('../assets/icon.svg?url')).toBe(true)
    expect(isResourceImport('./fonts/mono.woff2')).toBe(true)
  })

  it('keeps stylesheets and source modules inside the layer check', () => {
    expect(isResourceImport('../rows/Rows.module.css')).toBe(false)
    expect(isResourceImport('../zoom/types.ts')).toBe(false)
  })
})

describe('client domain package scan', () => {
  it('reports sibling and contract imports but allows assembly and resources', () => {
    const dir = fixture({
      'chat/A.ts': "import type { B } from '../zoom/b.ts'\nimport logo from '../assets/logo.svg'\n",
      'contract/slots.ts': "export { x } from '../chat/A.ts'\n",
      'apply.ts': "export { x } from './chat/A.ts'\n",
      'locales.ts': "export { x } from './locales/onboarding.ts'\n",
      'top.ts': "export { x } from './chat/A.ts'\n",
    })
    const violations = packageViolations('packages/client/demo', dir)

    expect(violations.map(violation => `${violation.file} -> ${violation.imported}`)).toEqual([
      'packages/client/demo/src/client/chat/A.ts -> ../zoom/b.ts',
      'packages/client/demo/src/client/contract/slots.ts -> ../chat/A.ts',
      'packages/client/demo/src/client/top.ts -> ./chat/A.ts',
    ])
  })
})

describe('client domain baseline', () => {
  const accepted = {
    entries: [{
      file: 'packages/client/demo/src/client/chat/A.ts',
      imported: '../zoom/b.ts',
      count: 1,
      reason: 'shared leaf',
    }],
  }

  it('accepts recorded violations', () => {
    const comparison = compareBaseline([{
      file: 'packages/client/demo/src/client/chat/A.ts',
      imported: '../zoom/b.ts',
      reason: 'domain "chat" imports sibling domain "zoom"',
    }], accepted)

    expect(comparison).toEqual({ unexpected: [], stale: [] })
  })

  it('reports additions above the recorded count and stale entries', () => {
    const comparison = compareBaseline([
      { file: 'packages/client/demo/src/client/chat/A.ts', imported: '../zoom/b.ts', reason: 'sibling' },
      { file: 'packages/client/demo/src/client/chat/A.ts', imported: '../zoom/b.ts', reason: 'sibling' },
    ], accepted)

    expect(comparison.unexpected).toHaveLength(1)
    expect(comparison.stale).toEqual([])

    const dropped = compareBaseline([], accepted)
    expect(dropped.stale.map(entry => entry.imported)).toEqual(['../zoom/b.ts'])
  })

  it('rejects malformed and duplicate entries', () => {
    expect(() => parseBaseline({ entries: [{ file: 'elsewhere.ts', imported: './x.ts', count: 1, reason: 'x' }] }))
      .toThrow('invalid baseline entry')
    expect(() => parseBaseline({ entries: [
      accepted.entries[0], accepted.entries[0],
    ] })).toThrow('duplicate baseline entry')
    expect(() => parseBaseline({ entries: [{ ...accepted.entries[0], reason: ' ' }] }))
      .toThrow('invalid baseline entry')
  })

  it('prunes stale entries and keeps reasons for the remaining ones', () => {
    const pruned = prunedBaseline([{
      file: 'packages/client/demo/src/client/chat/A.ts',
      imported: '../zoom/b.ts',
      reason: 'sibling',
    }], accepted)

    expect(pruned.entries).toEqual(accepted.entries)
  })
})
