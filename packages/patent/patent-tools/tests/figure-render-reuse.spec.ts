import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RENDER_REUSE_VERSION,
  hashModelFile,
  nonEmptyFile,
  readJsonRecord,
  readReuseText,
  readStringArray,
  removeReuseFile,
  renderKeyPath,
  renderReuseKey,
  reusableProduct,
  writeRenderKey,
  writeReuseText,
} from '../src/figure/render-reuse.ts'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-reuse-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('renderReuseKey', () => {
  it('字段顺序不影响键，版本、数组顺序和模型摘要会影响', () => {
    const left = renderReuseKey({
      tool: 'structure',
      request: { b: 1, a: { d: true, c: null }, extra: undefined },
      modelHashes: ['aa'],
    })
    const right = renderReuseKey({
      tool: 'structure',
      request: { a: { c: null, d: true }, b: 1 },
      modelHashes: ['aa'],
    })
    expect(left).toBe(right)
    expect(left).toHaveLength(64)
    expect(renderReuseKey({
      tool: 'structure',
      request: { a: 1 },
      modelHashes: ['aa'],
      version: RENDER_REUSE_VERSION + 1,
    })).not.toBe(renderReuseKey({ tool: 'structure', request: { a: 1 }, modelHashes: ['aa'] }))
    expect(renderReuseKey({
      tool: 'section-source',
      request: { items: [1, 2] },
      modelHashes: ['aa', 'bb'],
    })).not.toBe(renderReuseKey({
      tool: 'section-source',
      request: { items: [2, 1] },
      modelHashes: ['bb', 'aa'],
    }))
  })
})

describe('render reuse files', () => {
  it('按模型字节摘要，相同字节得到同一摘要', async () => {
    const dir = tempDir()
    const left = join(dir, 'a.step')
    const right = join(dir, 'b.step')
    writeFileSync(left, 'ISO-10303-21;\n')
    writeFileSync(right, 'ISO-10303-21;\n')
    expect(await hashModelFile(left)).toBe(await hashModelFile(right))
    writeFileSync(right, 'ISO-10303-21;\nchanged\n')
    expect(await hashModelFile(left)).not.toBe(await hashModelFile(right))
  })

  it('键文件与产物 mtime、空文件、缺失文件决定能否复用', async () => {
    const dir = tempDir()
    const product = join(dir, 'fig.svg')
    writeFileSync(product, '<svg/>')
    expect(renderKeyPath(product)).toBe(`${product}.render-key`)
    expect(await reusableProduct(product, 'abc')).toBe(false)
    await writeRenderKey(product, 'abc')
    const when = new Date('2020-01-01T00:00:00Z')
    await utimes(product, when, when)
    await utimes(renderKeyPath(product), when, when)
    expect(await reusableProduct(product, 'abc')).toBe(true)
    expect(await reusableProduct(product, 'nope')).toBe(false)
    writeFileSync(renderKeyPath(product), 'abc\n')
    await utimes(renderKeyPath(product), when, when)
    expect(await reusableProduct(product, 'abc')).toBe(true)
    writeFileSync(product, '')
    await utimes(product, when, when)
    expect(await reusableProduct(product, 'abc')).toBe(false)
    writeFileSync(product, '<svg/>')
    await utimes(product, new Date('2021-01-01T00:00:00Z'), new Date('2021-01-01T00:00:00Z'))
    expect(await reusableProduct(product, 'abc')).toBe(false)
    rmSync(product)
    expect(await reusableProduct(product, 'abc')).toBe(false)
  })

  it('读、写、删除收据；目录和不存在的父路径按错误抛出', async () => {
    const dir = tempDir()
    const receipt = join(dir, 'nested', 'section-reuse.json')
    expect(await readReuseText(receipt)).toBeUndefined()
    await writeReuseText(receipt, '{"ok":true}')
    expect(await readReuseText(receipt)).toBe('{"ok":true}')
    expect(await nonEmptyFile(receipt)).toBe(true)
    await removeReuseFile(receipt)
    expect(await readReuseText(receipt)).toBeUndefined()
    await removeReuseFile(receipt)
    expect(await nonEmptyFile(join(dir, 'missing.svg'))).toBe(false)

    const folder = join(dir, 'folder')
    mkdirSync(folder)
    writeFileSync(join(folder, 'child'), 'x')
    await expect(removeReuseFile(folder)).rejects.toThrow()
    await expect(readReuseText(folder)).rejects.toThrow()
    const blocked = join(dir, 'notdir')
    writeFileSync(blocked, 'x')
    await expect(nonEmptyFile(join(blocked, 'child'))).rejects.toThrow()
    const product = join(dir, 'view.svg')
    writeFileSync(product, '<svg/>')
    mkdirSync(`${product}.render-key`)
    await expect(reusableProduct(product, 'abc')).rejects.toThrow()
  })

  it('JSON 对象与字符串数组的损坏值按未命中', () => {
    expect(readJsonRecord('{"b":1,"a":2}')).toEqual({ b: 1, a: 2 })
    expect(readJsonRecord('{')).toBeUndefined()
    expect(readJsonRecord('[]')).toBeUndefined()
    expect(readJsonRecord('null')).toBeUndefined()
    expect(readStringArray(['壳体'])).toEqual(['壳体'])
    expect(readStringArray([])).toEqual([])
    expect(readStringArray(['壳体', 1])).toBeUndefined()
    expect(readStringArray('壳体')).toBeUndefined()
  })
})
