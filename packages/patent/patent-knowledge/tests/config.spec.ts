import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_KNOWLEDGE_DIR, DEFAULT_SOURCE_DB_PATH, resolveKnowledgePaths } from '@deepseek-ai/dsh-patent-knowledge'

const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!()
})

describe('resolveKnowledgePaths', () => {
  it('prefers knowledge.db over knowledge-lite.db over the source db', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pk-paths-'))
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
    new DatabaseSync(join(dir, 'knowledge.db')).close()
    new DatabaseSync(join(dir, 'knowledge-lite.db')).close()
    const sourceDbPath = join(dir, 'source.db')
    new DatabaseSync(sourceDbPath).close()
    const paths = resolveKnowledgePaths({ knowledgeDir: dir, sourceDbPath })
    expect(paths.queryDbPath).toBe(join(dir, 'knowledge.db'))
    expect(paths.wikiDir).toBe(join(dir, 'wiki'))
  })

  it('falls back to the source db when neither candidate exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pk-paths-fallback-'))
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
    const sourceDbPath = join(dir, 'source.db')
    new DatabaseSync(sourceDbPath).close()
    const paths = resolveKnowledgePaths({ knowledgeDir: dir, sourceDbPath })
    expect(paths.queryDbPath).toBe(sourceDbPath)
  })

  it('takes the shipped data directory and source db when no config is given', () => {
    const paths = resolveKnowledgePaths()
    expect(paths.dataDir).toBe(DEFAULT_KNOWLEDGE_DIR)
    expect(paths.sourceDbPath).toBe(DEFAULT_SOURCE_DB_PATH)
    expect(paths.wikiDir).toBe(join(DEFAULT_KNOWLEDGE_DIR, 'wiki'))
  })

  it('falls back to knowledge.db when nothing at all exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pk-paths-none-'))
    cleanups.push(() => { rmSync(dir, { recursive: true, force: true }) })
    const paths = resolveKnowledgePaths({ knowledgeDir: dir, sourceDbPath: join(dir, 'missing.db') })
    expect(paths.queryDbPath).toBe(join(dir, 'knowledge.db'))
    expect(paths.dataDir).toBe(dir)
    expect(paths.sourceDbPath).toBe(join(dir, 'missing.db'))
  })
})
