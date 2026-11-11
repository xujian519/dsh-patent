import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  commitTempSibling,
  countTableRows,
  formatGigabytes,
  prepareTempSibling,
} from '@deepseek-ai/dsh-knowledge-core'

const created: string[] = []

/** A fresh real directory under the platform temp root, removed after the test. */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  created.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('countTableRows', () => {
  it('counts the rows of an existing table', () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE regs (id INTEGER)')
    db.exec('INSERT INTO regs (id) VALUES (1), (2)')
    expect(countTableRows(db, 'regs')).toBe(2)
    db.close()
  })

  it('reports -1 for a missing table', () => {
    const db = new DatabaseSync(':memory:')
    expect(countTableRows(db, 'missing')).toBe(-1)
    db.close()
  })
})

describe('formatGigabytes', () => {
  it('renders two decimals of gigabytes', () => {
    expect(formatGigabytes(1073741824)).toBe('1.00 GB')
    expect(formatGigabytes(0)).toBe('0.00 GB')
  })
})

describe('prepareTempSibling', () => {
  it('creates the output directory and returns a sibling temp path', () => {
    const root = tempDir('dsh-install-fs-')
    const output = join(root, 'nested', 'output.db')
    const temp = prepareTempSibling(output)
    expect(temp).toBe(`${join(root, 'nested', 'output.db')}.tmp-${String(process.pid)}`)
    expect(existsSync(join(root, 'nested'))).toBe(true)
    expect(existsSync(temp)).toBe(false)
  })

  it('clears a stale temp file left by an interrupted run', () => {
    const root = tempDir('dsh-install-fs-')
    const output = join(root, 'output.db')
    const temp = `${output}.tmp-${String(process.pid)}`
    writeFileSync(temp, 'stale')
    expect(prepareTempSibling(output)).toBe(temp)
    expect(existsSync(temp)).toBe(false)
  })
})

describe('commitTempSibling', () => {
  it('renames the temp file onto a fresh output path', () => {
    const root = tempDir('dsh-install-fs-')
    const output = join(root, 'output.db')
    const temp = prepareTempSibling(output)
    writeFileSync(temp, 'payload')
    const log: string[] = []
    commitTempSibling(temp, output, line => log.push(line))
    expect(readFileSync(output, 'utf8')).toBe('payload')
    expect(existsSync(temp)).toBe(false)
    expect(log).toEqual([])
  })

  it('replaces an existing output and records the overwrite', () => {
    const root = tempDir('dsh-install-fs-')
    const output = join(root, 'output.db')
    writeFileSync(output, 'old')
    const temp = prepareTempSibling(output)
    writeFileSync(temp, 'new')
    const log: string[] = []
    commitTempSibling(temp, output, line => log.push(line))
    expect(readFileSync(output, 'utf8')).toBe('new')
    expect(log).toHaveLength(1)
    expect(log[0]).toContain('输出已存在，覆盖')
  })
})
