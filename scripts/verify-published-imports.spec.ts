import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { auditPublishedImports } from './verify-published-imports.ts'

const roots: string[] = []

/** Create one package directory with a manifest and an optional built entry. */
function packageAt(
  root: string,
  group: string,
  name: string,
  manifest: Record<string, unknown>,
  entry?: string,
): void {
  const dir = join(root, 'packages', group, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, main: 'lib/index.js', ...manifest }))
  if (entry !== undefined) {
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib/index.js'), entry)
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('auditPublishedImports', () => {
  it('accepts an entry whose bare imports are all declared', () => {
    const root = mkdtempSync(join(tmpdir(), 'published-imports-'))
    roots.push(root)
    packageAt(root, 'core', 'alpha', { dependencies: { dep: 'workspace:*' } },
      'import { x } from "dep";\nimport { readFileSync } from "node:fs";\n')

    const audit = auditPublishedImports(root)

    expect(audit.checked).toBe(1)
    expect(audit.violations).toEqual([])
  })

  it('reports an entry importing a package only its devDependencies declare', () => {
    const root = mkdtempSync(join(tmpdir(), 'published-imports-'))
    roots.push(root)
    packageAt(root, 'core', 'beta', { devDependencies: { dep: 'workspace:*' } },
      'import { x } from "dep";\n')

    const audit = auditPublishedImports(root)

    expect(audit.violations).toHaveLength(1)
    expect(audit.violations[0]).toMatchObject({ packageName: 'beta', dependency: 'dep' })
  })

  it('skips Client packages, whose browser inputs stay in devDependencies', () => {
    const root = mkdtempSync(join(tmpdir(), 'published-imports-'))
    roots.push(root)
    packageAt(root, 'client', 'widget', { devDependencies: { react: '^18.0.0' } },
      'import { x } from "react";\n')

    const audit = auditPublishedImports(root)

    expect(audit.checked).toBe(0)
    expect(audit.violations).toEqual([])
  })

  it('reports a publishable package whose built entry is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'published-imports-'))
    roots.push(root)
    packageAt(root, 'core', 'gamma', {})

    const audit = auditPublishedImports(root)

    expect(audit.violations).toEqual([
      expect.objectContaining({ packageName: 'gamma', dependency: '(missing built entry)' }),
    ])
  })
})
