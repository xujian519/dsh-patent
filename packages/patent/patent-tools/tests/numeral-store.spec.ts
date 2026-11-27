import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_FIGURE_NUMERALS_RELATIVE_PATH,
  FIGURE_NUMERAL_STORE_VERSION,
  figureNumeralStore,
  loadNumerals,
  mergeNumerals,
} from '../src/figure/numeral-store.ts'

let dir: string
let file: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-numeral-store-'))
  file = join(dir, 'figure-numerals.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('numeral store constants', () => {
  it('默认路径与版本固定', () => {
    expect(DEFAULT_FIGURE_NUMERALS_RELATIVE_PATH).toBe('.sati/figure-numerals.json')
    expect(FIGURE_NUMERAL_STORE_VERSION).toBe(1)
  })
})

describe('loadNumerals', () => {
  it('文件不存在时返回空表', async () => {
    await expect(loadNumerals(file, 'CN2024-0001')).resolves.toEqual([])
  })

  it('作用域不存在时返回空表', async () => {
    await mergeNumerals(file, 'scope-a', [{ componentId: 'shell', label: '壳体', numeral: '10' }])
    await expect(loadNumerals(file, 'scope-b')).resolves.toEqual([])
  })

  it('读回已写入的标号', async () => {
    await mergeNumerals(file, 'scope-a', [
      { componentId: 'shell', label: '壳体', numeral: '10' },
      { componentId: 'cover', label: '盖板', numeral: '20' },
    ])
    await expect(loadNumerals(file, 'scope-a')).resolves.toEqual([
      { componentId: 'shell', label: '壳体', numeral: '10' },
      { componentId: 'cover', label: '盖板', numeral: '20' },
    ])
  })
})

describe('mergeNumerals', () => {
  it('首次写入后按标号数值升序落盘', async () => {
    const { merged, conflicts } = await mergeNumerals(file, 'scope-a', [
      { componentId: 'c', label: '丙', numeral: '20' },
      { componentId: 'a', label: '甲', numeral: '2' },
      { componentId: 'b', label: '乙', numeral: '10' },
    ])

    expect(conflicts).toEqual([])
    expect(merged.map(item => item.numeral)).toEqual(['2', '10', '20'])
    const raw = JSON.parse(await readFile(file, 'utf8')) as { version: number; entries: unknown[] }
    expect(raw.version).toBe(FIGURE_NUMERAL_STORE_VERSION)
    expect(raw.entries).toHaveLength(1)
  })

  it('同号重复写入不产生冲突也不重复', async () => {
    await mergeNumerals(file, 'scope-a', [{ componentId: 'shell', label: '壳体', numeral: '10' }])
    const { merged, conflicts } = await mergeNumerals(file, 'scope-a', [
      { componentId: 'shell', label: '壳体', numeral: '10' },
    ])

    expect(conflicts).toEqual([])
    expect(merged).toEqual([{ componentId: 'shell', label: '壳体', numeral: '10' }])
  })

  it('异号时保留表内旧号并报告冲突', async () => {
    await mergeNumerals(file, 'scope-a', [{ componentId: 'shell', label: '壳体', numeral: '10' }])
    const { merged, conflicts } = await mergeNumerals(file, 'scope-a', [
      { componentId: 'shell', label: '外壳', numeral: '30' },
    ])

    expect(conflicts).toEqual([{ componentId: 'shell', kept: '10', dropped: '30' }])
    expect(merged).toEqual([{ componentId: 'shell', label: '壳体', numeral: '10' }])
  })

  it('新组件追加到既有表', async () => {
    await mergeNumerals(file, 'scope-a', [{ componentId: 'shell', label: '壳体', numeral: '10' }])
    const { merged } = await mergeNumerals(file, 'scope-a', [
      { componentId: 'cover', label: '盖板', numeral: '20' },
    ])

    expect(merged.map(item => item.componentId)).toEqual(['shell', 'cover'])
  })

  it('空组件标识被跳过', async () => {
    const { merged } = await mergeNumerals(file, 'scope-a', [
      { componentId: '  ', label: '空', numeral: '10' },
    ])

    expect(merged).toEqual([])
    await expect(loadNumerals(file, 'scope-a')).resolves.toEqual([])
  })

  it('不同作用域互不影响', async () => {
    await mergeNumerals(file, 'scope-a', [{ componentId: 'shell', label: '壳体', numeral: '10' }])
    await mergeNumerals(file, 'scope-b', [{ componentId: 'shell', label: '壳体', numeral: '50' }])

    await expect(loadNumerals(file, 'scope-a')).resolves.toEqual([
      { componentId: 'shell', label: '壳体', numeral: '10' },
    ])
    await expect(loadNumerals(file, 'scope-b')).resolves.toEqual([
      { componentId: 'shell', label: '壳体', numeral: '50' },
    ])
  })

  it('并发合并同一文件时不丢条目', async () => {
    await Promise.all([
      mergeNumerals(file, 'scope-a', [{ componentId: 'shell', label: '壳体', numeral: '10' }]),
      mergeNumerals(file, 'scope-a', [{ componentId: 'cover', label: '盖板', numeral: '20' }]),
      mergeNumerals(file, 'scope-a', [{ componentId: 'spring', label: '弹簧', numeral: '30' }]),
    ])

    const stored = await loadNumerals(file, 'scope-a')
    expect(stored.map(item => item.componentId).sort()).toEqual(['cover', 'shell', 'spring'])
  })

  it('损坏的标号表按空表处理并仍可写入', async () => {
    await writeFile(file, '{ not json', 'utf8')
    const { merged } = await mergeNumerals(file, 'scope-a', [
      { componentId: 'shell', label: '壳体', numeral: '10' },
    ])

    expect(merged).toHaveLength(1)
    await expect(loadNumerals(file, 'scope-a')).resolves.toHaveLength(1)
  })

  it('结构不符的作用域条目被忽略', async () => {
    await writeFile(file, JSON.stringify({
      version: FIGURE_NUMERAL_STORE_VERSION,
      updatedAt: new Date().toISOString(),
      entries: [{ scope: 'scope-a', numerals: [{ componentId: 1, label: '壳体', numeral: '10' }] }],
    }), 'utf8')

    await expect(loadNumerals(file, 'scope-a')).resolves.toEqual([])
  })

  it('条目不是对象、作用域不是字符串或标号表不是数组时整条被忽略', async () => {
    await writeFile(file, JSON.stringify({
      version: FIGURE_NUMERAL_STORE_VERSION,
      updatedAt: new Date().toISOString(),
      entries: [
        'not-an-entry',
        null,
        { scope: 1, numerals: [] },
        { scope: 'scope-a', numerals: 'not-an-array' },
        { scope: 'scope-b', numerals: [null] },
        { scope: 'scope-c', numerals: ['x'] },
        { scope: 'scope-d', numerals: [{ componentId: 'shell', label: 1, numeral: '10' }] },
        { scope: 'scope-e', numerals: [{ componentId: 'shell', label: '壳体', numeral: 1 }] },
      ],
    }), 'utf8')

    for (const scope of ['scope-a', 'scope-b', 'scope-c', 'scope-d', 'scope-e']) {
      await expect(loadNumerals(file, scope)).resolves.toEqual([])
    }
  })

  it('组件 id 找不到但标签相同时按标签对齐同一部件', async () => {
    await mergeNumerals(file, 'scope-a', [{ componentId: 'shell', label: '壳体', numeral: '10' }])
    const { merged, conflicts } = await mergeNumerals(file, 'scope-a', [
      { componentId: '壳体', label: '壳体', numeral: '99' },
    ])

    expect(conflicts).toEqual([{ componentId: 'shell', kept: '10', dropped: '99' }])
    expect(merged).toEqual([{ componentId: 'shell', label: '壳体', numeral: '10' }])
  })

  it('组件 id 与标签都不同时新增一条', async () => {
    await mergeNumerals(file, 'scope-a', [{ componentId: 'shell', label: '壳体', numeral: '10' }])
    const { merged } = await mergeNumerals(file, 'scope-a', [
      { componentId: 'cover', label: '盖板', numeral: '20' },
    ])

    expect(merged.map(item => item.componentId)).toEqual(['shell', 'cover'])
  })

  it('写入失败时队列仍释放，后续调用不被阻塞', async () => {
    const blocked = join(dir, 'as-directory')
    await mkdir(blocked)

    await expect(mergeNumerals(blocked, 'scope-a', [
      { componentId: 'shell', label: '壳体', numeral: '10' },
    ])).rejects.toThrow()
    await expect(mergeNumerals(file, 'scope-a', [
      { componentId: 'shell', label: '壳体', numeral: '10' },
    ])).resolves.toMatchObject({ merged: [{ componentId: 'shell' }] })
  })

  it('存储原语的 upsert 按作用域覆盖并按作用域排序', async () => {
    await figureNumeralStore.upsert(file, { scope: 'zeta', numerals: [] })
    await figureNumeralStore.upsert(file, { scope: 'alpha', numerals: [] })
    await figureNumeralStore.upsert(file, { scope: 'zeta', numerals: [
      { componentId: 'shell', label: '壳体', numeral: '10' },
    ] })

    const raw = JSON.parse(await readFile(file, 'utf8')) as { entries: { scope: string; numerals: unknown[] }[] }
    expect(raw.entries.map(entry => entry.scope)).toEqual(['alpha', 'zeta'])
    expect(raw.entries[1]?.numerals).toHaveLength(1)
  })
})
