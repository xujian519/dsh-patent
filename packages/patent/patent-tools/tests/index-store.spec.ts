import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { figureIndexStore, FIGURE_INDEX_VERSION } from '../src/figure/index-store.ts'
import { chemistryIndexStore, CHEMISTRY_INDEX_VERSION } from '../src/chemistry/index-store.ts'
import { createRecognizeChemicalStructureTool, resolveChemicalSourceKey } from '../src/tool/recognize-chemical-structure.ts'
import type { ChemicalStructureResult } from '../src/tool/recognize-chemical-structure.ts'
import type { FigureIndexEntry } from '../src/figure/index-store.ts'
import type { ChemistryIndexEntry } from '../src/chemistry/index-store.ts'

function figureEntry(over: { imagePath: string } & Partial<{ figureNumber: number; figureFamily: string }>): FigureIndexEntry {
  return {
    imagePath: over.imagePath,
    analyzedAt: '2024-01-01T00:00:00.000Z',
    analysis: {
      imagePath: over.imagePath,
      figureNumber: over.figureNumber ?? 1,
      figureType: 'structure',
      overallDescription: '整体结构',
      components: [{ refNumber: '1', name: '壳体', kind: 'mechanical', description: '外壳' }],
      connections: [],
      figureDescription: '图1是本发明实施例提供的装置的结构示意图；图中：1-壳体；',
      confidence: 0.9,
      warnings: [],
      usable: true,
      modelUsed: 'm',
      drawingStatus: 'drawn',
      ...(over.figureFamily === undefined ? {} : { figureFamily: over.figureFamily }),
    },
  }
}

describe('figureIndexStore.load', () => {
  it('returns empty entries when the index file is absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-fig-store-'))
    try {
      const { entries, warning } = await figureIndexStore.load(join(dir, 'missing.json'))
      expect(entries).toEqual([])
      expect(warning).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns empty + warning on a version mismatch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-fig-store-'))
    try {
      const file = join(dir, 'index.json')
      await writeFile(file, JSON.stringify({ version: FIGURE_INDEX_VERSION + 1, updatedAt: '', entries: [] }))
      const { entries, warning } = await figureIndexStore.load(file)
      expect(entries).toEqual([])
      expect(warning).toContain('版本不兼容')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns empty + warning on a structurally anomalous index', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-fig-store-'))
    try {
      const file = join(dir, 'index.json')
      await writeFile(file, JSON.stringify({ version: FIGURE_INDEX_VERSION, updatedAt: '', entries: 'oops' }))
      const { entries, warning } = await figureIndexStore.load(file)
      expect(entries).toEqual([])
      expect(warning).toContain('结构异常')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('drops invalid entries and warns', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-fig-store-'))
    try {
      const file = join(dir, 'index.json')
      await writeFile(
        file,
        JSON.stringify({
          version: FIGURE_INDEX_VERSION,
          updatedAt: '',
          entries: [figureEntry({ imagePath: 'a.png' }), { imagePath: 'b.png' }, 42],
        }),
      )
      const { entries, warning } = await figureIndexStore.load(file)
      expect(entries.map(e => e.imagePath)).toEqual(['a.png'])
      expect(warning).toContain('2 条无效条目')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('loads a fully valid index without a warning', async () => {
    // 新路径不走缓存，解析路径上 dropped=0 分支必须返回无 warning 的结果。
    const dir = await mkdtemp(join(tmpdir(), 'dsh-fig-valid-'))
    try {
      const file = join(dir, 'index.json')
      await writeFile(
        file,
        JSON.stringify({ version: FIGURE_INDEX_VERSION, updatedAt: '', entries: [figureEntry({ imagePath: 'a.png' })] }),
      )
      const { entries, warning } = await figureIndexStore.load(file)
      expect(entries.map(e => e.imagePath)).toEqual(['a.png'])
      expect(warning).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('returns empty + warning on corrupt JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-fig-store-'))
    try {
      const file = join(dir, 'index.json')
      await writeFile(file, '{not-json')
      const { entries, warning } = await figureIndexStore.load(file)
      expect(entries).toEqual([])
      expect(warning).toContain('损坏')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('tolerates legacy entries without figureFamily and keeps well-formed family markers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-fig-family-'))
    try {
      const file = join(dir, 'index.json')
      await writeFile(
        file,
        JSON.stringify({
          version: FIGURE_INDEX_VERSION,
          updatedAt: '',
          entries: [figureEntry({ imagePath: 'legacy.png' }), figureEntry({ imagePath: 'family.png', figureFamily: 'acme' })],
        }),
      )
      const { entries, warning } = await figureIndexStore.load(file)
      expect(warning).toBeUndefined()
      expect(entries.map(e => e.analysis.figureFamily)).toEqual([undefined, 'acme'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('loads an entry that omits drawingStatus', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-fig-status-'))
    try {
      const file = join(dir, 'index.json')
      const legacy = figureEntry({ imagePath: 'legacy.png' })
      delete (legacy.analysis as { drawingStatus?: string }).drawingStatus
      await writeFile(
        file,
        JSON.stringify({ version: FIGURE_INDEX_VERSION, updatedAt: '', entries: [legacy] }),
      )
      const { entries, warning } = await figureIndexStore.load(file)
      expect(warning).toBeUndefined()
      expect(entries[0]?.analysis.drawingStatus).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps proposal and drops a drawingStatus outside proposal or drawn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-fig-status-'))
    try {
      const file = join(dir, 'index.json')
      const proposal = figureEntry({ imagePath: 'p.png' })
      proposal.analysis.drawingStatus = 'proposal'
      const bad = figureEntry({ imagePath: 'bad.png' })
      Reflect.set(bad.analysis, 'drawingStatus', 'filed')
      await writeFile(
        file,
        JSON.stringify({ version: FIGURE_INDEX_VERSION, updatedAt: '', entries: [proposal, bad] }),
      )
      const { entries, warning } = await figureIndexStore.load(file)
      expect(entries.map(entry => entry.imagePath)).toEqual(['p.png'])
      expect(entries[0]?.analysis.drawingStatus).toBe('proposal')
      expect(warning).toContain('1 条无效条目')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('drops entries whose figureFamily is not a string', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-fig-family-'))
    try {
      const file = join(dir, 'index.json')
      const bad = figureEntry({ imagePath: 'bad.png' })
      ;(bad.analysis as { figureFamily: unknown }).figureFamily = 42
      await writeFile(
        file,
        JSON.stringify({ version: FIGURE_INDEX_VERSION, updatedAt: '', entries: [bad] }),
      )
      const { entries, warning } = await figureIndexStore.load(file)
      expect(entries).toEqual([])
      expect(warning).toContain('1 条无效条目')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rethrows a non-ENOENT read failure', async () => {
    // readFile on a directory path rejects with a non-ENOENT code (EISDIR on
    // macOS/Linux); a real I/O failure must surface, not be read as an empty index.
    const dir = await mkdtemp(join(tmpdir(), 'dsh-fig-store-'))
    try {
      await expect(figureIndexStore.load(dir)).rejects.toBeInstanceOf(Error)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('figureIndexStore.upsert', () => {
  it('writes a new entry and persists a readable index', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-fig-store-'))
    try {
      const file = join(dir, 'index.json')
      await figureIndexStore.upsert(file, figureEntry({ imagePath: 'a.png' }))
      const { entries } = await figureIndexStore.load(file)
      expect(entries.map(e => e.imagePath)).toEqual(['a.png'])
      const raw = JSON.parse(await readFile(file, 'utf8')) as { version: number; entries: unknown[] }
      expect(raw.version).toBe(FIGURE_INDEX_VERSION)
      expect(raw.entries).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('overwrites an existing entry with the same key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-fig-store-'))
    try {
      const file = join(dir, 'index.json')
      await figureIndexStore.upsert(file, figureEntry({ imagePath: 'a.png' }))
      await figureIndexStore.upsert(file, { ...figureEntry({ imagePath: 'a.png' }), analyzedAt: '2025-01-01T00:00:00.000Z' })
      const { entries } = await figureIndexStore.load(file)
      expect(entries).toHaveLength(1)
      expect(entries[0]?.analyzedAt).toBe('2025-01-01T00:00:00.000Z')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('serializes concurrent upserts without losing entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-fig-store-'))
    try {
      const file = join(dir, 'index.json')
      await Promise.all([
        figureIndexStore.upsert(file, figureEntry({ imagePath: 'a.png', figureNumber: 1 })),
        figureIndexStore.upsert(file, figureEntry({ imagePath: 'b.png', figureNumber: 2 })),
        figureIndexStore.upsert(file, figureEntry({ imagePath: 'c.png', figureNumber: 3 })),
      ])
      const { entries } = await figureIndexStore.load(file)
      expect(entries.map(e => e.imagePath)).toEqual(['a.png', 'b.png', 'c.png'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('breaks figure-number ties by image path on upsert', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-fig-store-'))
    try {
      const file = join(dir, 'index.json')
      await figureIndexStore.upsert(file, figureEntry({ imagePath: 'b.png', figureNumber: 1 }))
      await figureIndexStore.upsert(file, figureEntry({ imagePath: 'a.png', figureNumber: 1 }))
      const { entries } = await figureIndexStore.load(file)
      expect(entries.map(e => e.imagePath)).toEqual(['a.png', 'b.png'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('backs up a corrupt index before rewriting it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-fig-store-'))
    try {
      const file = join(dir, 'index.json')
      await writeFile(file, '{corrupt')
      await figureIndexStore.upsert(file, figureEntry({ imagePath: 'a.png' }))
      const backups = (await readdir(dir)).filter(f => f.startsWith('index.json.corrupt-'))
      expect(backups).toHaveLength(1)
      const { entries } = await figureIndexStore.load(file)
      expect(entries.map(e => e.imagePath)).toEqual(['a.png'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('caches parsed loads: repeat load serves the cache, not the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-fig-cache-'))
    try {
      const file = join(dir, 'index.json')
      await figureIndexStore.upsert(file, figureEntry({ imagePath: 'a.png' }))
      await rm(file) // 命中缓存后不应重新读盘，删掉文件也仍返回缓存内容。
      const { entries } = await figureIndexStore.load(file)
      expect(entries.map(e => e.imagePath)).toEqual(['a.png'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('upsert refreshes the cache so a later load sees the new entry without re-reading', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-fig-cache-'))
    try {
      const file = join(dir, 'index.json')
      await figureIndexStore.load(file) // 空索引入缓存
      await figureIndexStore.upsert(file, figureEntry({ imagePath: 'a.png' }))
      await rm(file) // upsert 须同步更新缓存，否则 load 会回退到空。
      const { entries } = await figureIndexStore.load(file)
      expect(entries.map(e => e.imagePath)).toEqual(['a.png'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('releases the upsert queue tail so a later upsert on the same path starts fresh', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-fig-queue-'))
    try {
      const file = join(dir, 'index.json')
      await Promise.all([
        figureIndexStore.upsert(file, figureEntry({ imagePath: 'a.png', figureNumber: 1 })),
        figureIndexStore.upsert(file, figureEntry({ imagePath: 'b.png', figureNumber: 2 })),
      ])
      // 并发链完成后队列尾已释放：后续同路径 upsert 不再串在旧链上，仍正确追加。
      await figureIndexStore.upsert(file, figureEntry({ imagePath: 'c.png', figureNumber: 3 }))
      const { entries } = await figureIndexStore.load(file)
      expect(entries.map(e => e.imagePath)).toEqual(['a.png', 'b.png', 'c.png'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('releases the queue tail when an upsert fails, so a later upsert starts fresh', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-fig-fail-'))
    try {
      // upsert 指向目录：load 读目录抛 EISDIR（非 ENOENT），run 失败，调用方感知。
      await expect(figureIndexStore.upsert(dir, figureEntry({ imagePath: 'a.png' }))).rejects.toBeInstanceOf(Error)
      // 失败路径下队尾也已释放：同目录下的新文件 upsert 不再串在旧链上，仍正确写入。
      const file = join(dir, 'index.json')
      await figureIndexStore.upsert(file, figureEntry({ imagePath: 'a.png' }))
      const { entries } = await figureIndexStore.load(file)
      expect(entries.map(e => e.imagePath)).toEqual(['a.png'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('chemistryIndexStore', () => {
  function chemistryEntry(sourceKey: string): ChemistryIndexEntry {
    return {
      sourceKey,
      analyzedAt: '2024-01-01T00:00:00.000Z',
      analysis: {
        kind: 'structure',
        candidates: [],
        chosenIndex: -1,
        names: [],
        confidence: 0,
        warnings: [],
        needHumanReview: true,
        usable: false,
        modelUsed: 'm',
      },
    }
  }

  it('loads an empty absent index and upserts entries keyed by sourceKey', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-chem-store-'))
    try {
      const file = join(dir, 'index.json')
      const { entries, warning } = await chemistryIndexStore.load(file)
      expect(entries).toEqual([])
      expect(warning).toBeUndefined()
      await chemistryIndexStore.upsert(file, chemistryEntry('text:abc'))
      await chemistryIndexStore.upsert(file, chemistryEntry('text:def'))
      await chemistryIndexStore.upsert(file, chemistryEntry('text:abc'))
      const reloaded = await chemistryIndexStore.load(file)
      expect(reloaded.entries.map(e => e.sourceKey)).toEqual(['text:abc', 'text:def'])
      const raw = JSON.parse(await readFile(file, 'utf8')) as { version: number }
      expect(raw.version).toBe(CHEMISTRY_INDEX_VERSION)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('drops invalid chemistry entries on load', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-chem-store-'))
    try {
      const file = join(dir, 'index.json')
      await writeFile(
        file,
        JSON.stringify({
          version: CHEMISTRY_INDEX_VERSION,
          updatedAt: '',
          entries: [chemistryEntry('text:abc'), { sourceKey: 'text:bad' }, null],
        }),
      )
      const { entries, warning } = await chemistryIndexStore.load(file)
      expect(entries).toHaveLength(1)
      expect(warning).toContain('2 条无效条目')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('creates the parent directory on save', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-chem-store-'))
    try {
      const file = join(dir, 'nested', 'deep', 'index.json')
      await chemistryIndexStore.upsert(file, chemistryEntry('text:abc'))
      const { entries } = await chemistryIndexStore.load(file)
      expect(entries).toHaveLength(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('recognize_chemical_structure index interaction', () => {
  it('does not persist the chemistry index while the engine is unusable', async () => {
    const upserted: ChemistryIndexEntry[] = []
    const tool = createRecognizeChemicalStructureTool({
      upsertIndex: (entry) => { upserted.push(entry); return Promise.resolve() },
    })
    const result = await tool.execute({ text: '苯' }, { signal: new AbortController().signal } as never)
    expect((result as ChemicalStructureResult).usable).toBe(false)
    expect(upserted).toEqual([])
  })
})

describe('resolveChemicalSourceKey', () => {
  it('uses the image path for image mode', () => {
    expect(resolveChemicalSourceKey({ image_path: 'img/s.png' })).toBe('img/s.png')
    expect(resolveChemicalSourceKey({ image_path: 'img/s.png', text: 'C6H6' })).toBe('img/s.png')
  })

  it('derives a stable text:<hash> key for text mode', () => {
    const first = resolveChemicalSourceKey({ text: '苯' })
    const second = resolveChemicalSourceKey({ text: '苯' })
    expect(first).toMatch(/^text:[0-9a-f]{16}$/)
    expect(first).toBe(second)
    expect(resolveChemicalSourceKey({})).toMatch(/^text:[0-9a-f]{16}$/)
  })
})
