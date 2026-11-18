/** Default option resolution for the legal knowledge installer, isolated to a temporary home. */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { parseInstallArguments } from '../src/bin.ts'

const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'legal-knowledge-defaults-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

it('resolves the default source database path under home', async () => {
  const home = tempDir()
  const knowledgeDir = join(home, '.dsh', 'legal-knowledge')
  mkdirSync(knowledgeDir, { recursive: true })
  const sourcePath = join(knowledgeDir, 'legal.db')
  const db = new DatabaseSync(sourcePath)
  try {
    db.exec('CREATE TABLE case_law (id INTEGER PRIMARY KEY)')
  } finally {
    db.close()
  }

  vi.stubEnv('HOME', home)
  vi.resetModules()
  vi.spyOn(console, 'log').mockImplementation(() => {})

  const { installLegalKnowledgeDb } = await import('../src/install.ts')
  const result = await installLegalKnowledgeDb({
    output: join(tempDir(), 'output.db'),
    noFts: true,
  })

  expect(result.input).toBe(sourcePath)
})

it('resolves the home knowledge directory, default output, and console log', async () => {
  const home = tempDir()
  const sourcePath = join(tempDir(), 'source.db')
  const db = new DatabaseSync(sourcePath)
  try {
    db.exec('CREATE TABLE case_law (id INTEGER PRIMARY KEY); INSERT INTO case_law VALUES (1)')
  } finally {
    db.close()
  }

  vi.stubEnv('HOME', home)
  vi.resetModules()
  const logs: string[] = []
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)) })

  const { installLegalKnowledgeDb } = await import('../src/install.ts')
  const knowledgeDir = join(home, '.dsh', 'legal-knowledge')
  mkdirSync(knowledgeDir, { recursive: true })

  const result = await installLegalKnowledgeDb({ sourceDbPath: sourcePath })

  expect(result.output).toBe(join(knowledgeDir, 'legal.db'))
  expect(logs[0]).toBe(`输入: ${sourcePath}`)
  expect(logs[1]).toBe(`输出: ${join(knowledgeDir, 'legal.db')}`)
})

it('parses the installer command line, including a missing --from', () => {
  expect(parseInstallArguments(['--from', '/tmp/legal.db'])).toEqual({
    from: '/tmp/legal.db', output: undefined, noFts: false, help: false,
  })
  expect(parseInstallArguments(['--from', 'source.db', '--output', 'out.db', '--no-fts'])).toEqual({
    from: 'source.db', output: 'out.db', noFts: true, help: false,
  })
  expect(parseInstallArguments(['-h'])).toEqual({
    from: undefined, output: undefined, noFts: false, help: true,
  })
  // The default source path is the file the installer writes, so the bin
  // requires --from instead of letting the same-file guard reject a bare run.
  expect(parseInstallArguments([]).from).toBeUndefined()
})
