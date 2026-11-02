import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { inspectDshPackageLicenses } from './verify-dsh-package-licenses.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function writeManifest(root: string, file: string, manifest: Record<string, unknown>): void {
  const path = join(root, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
}

function createWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-package-licenses-'))
  roots.push(root)
  writeManifest(root, 'package.json', {
    name: '@deepseek-ai/dsh-root',
    license: 'MIT',
    workspaces: ['apps/*', 'packages/*/*', 'vendor/*'],
  })
  return root
}

describe('DSH package license gate', () => {
  it('checks root, unhyphenated CLI, and dsh-prefixed package names while ignoring other families', () => {
    const root = createWorkspace()
    writeManifest(root, 'apps/cli/package.json', { name: '@deepseek-ai/dsh', license: 'MIT' })
    writeManifest(root, 'packages/core/agent/package.json', {
      name: '@deepseek-ai/dsh-agent',
      license: 'BSD-3-Clause',
    })
    writeManifest(root, 'vendor/cordis/package.json', {
      name: '@deepseek-ai/cordis',
      license: 'BSD-3-Clause',
    })

    expect(inspectDshPackageLicenses(root)).toEqual({
      packageCount: 3,
      failures: [
        'packages/core/agent/package.json: @deepseek-ai/dsh-agent must declare a license allowing MIT; found "BSD-3-Clause".',
      ],
    })
  })

  it('rejects a missing license declaration', () => {
    const root = createWorkspace()
    writeManifest(root, 'packages/core/agent/package.json', { name: '@deepseek-ai/dsh-agent' })

    expect(inspectDshPackageLicenses(root).failures).toEqual([
      'packages/core/agent/package.json: @deepseek-ai/dsh-agent must declare a license allowing MIT; found undefined.',
    ])
  })

  it('accepts MIT-selectable expressions and rejects declarations that oblige another license', () => {
    const root = createWorkspace()
    writeManifest(root, 'packages/core/agent/package.json', {
      name: '@deepseek-ai/dsh-agent',
      license: 'MIT OR Apache-2.0',
    })
    writeManifest(root, 'packages/core/tool/package.json', {
      name: '@deepseek-ai/dsh-tool',
      license: 'MIT/Apache-2.0',
    })
    writeManifest(root, 'packages/core/service/package.json', {
      name: '@deepseek-ai/dsh-service',
      license: 'MIT AND Apache-2.0',
    })
    writeManifest(root, 'packages/core/plugin/package.json', {
      name: '@deepseek-ai/dsh-plugin',
      license: '(MIT OR Apache-2.0) AND BSD-3-Clause',
    })

    expect(inspectDshPackageLicenses(root).failures).toEqual([
      'packages/core/plugin/package.json: @deepseek-ai/dsh-plugin must declare a license allowing MIT; found "(MIT OR Apache-2.0) AND BSD-3-Clause".',
      'packages/core/service/package.json: @deepseek-ai/dsh-service must declare a license allowing MIT; found "MIT AND Apache-2.0".',
    ])
  })
})
