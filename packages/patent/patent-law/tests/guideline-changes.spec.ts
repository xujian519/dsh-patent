/**
 * 2026 年修订版改动点资产必须与指南索引、权威基线相互印证。
 *
 * 改动点资产是「指南哪些节被 2026 年版改过」的唯一记录：源 PDF 不在仓库里，脚本在有源时
 * 才能复核，因此 CI 能守的是资产之间的关系——每条登记都落在已索引的节上、每处改编号都
 * 指向真实编号、索引里每条 stale 与 2026 转录都能追到一处登记。资产与源 PDF 的逐字比对
 * 由 `tools/guideline-changes.py --check` 在有源的机器上完成。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { IndexAssetError, parseYamlMapping, readMapping, readString } from '@deepseek-ai/dsh-patent-index-asset'
import { loadLawBaselines } from '../src/baseline.ts'
import type { AssetFail } from '@deepseek-ai/dsh-patent-index-asset'

const CHANGES = new URL('../assets/authority/guideline-changes-2026.yaml', import.meta.url)
const AUTHORITY = new URL('../assets/authority/authority-baseline.yaml', import.meta.url)

const fail: AssetFail = message => new IndexAssetError(message, null)

/** 改动点的允许取值；与资产头注释和 `tools/guideline-changes.py` 的 kind 取值同源。 */
const KINDS = ['amended', 'renumbered', 'deleted', 'added']

/** 归一化节路径的语法：第X部分第Y章 + 编号。 */
const PATH = /^第[一二三四五六]部分第[一二三四五六七八九十]+章\d+(?:\.\d+)*$/

type ChangePoint = { path: string; kind: string }
type Rename = { from: string; to: string }
type Addition = { path: string }

/** 读一处字符串数组字段里的 `path` 或编号字段。 */
function readList(root: Record<string, unknown>, field: string): Record<string, unknown>[] {
  const value = root[field]
  if (!Array.isArray(value)) return []
  return value.map(item => readMapping(item, field, fail))
}

function readChanges(): {
  sha256: string
  points: ChangePoint[]
  renames: Rename[]
  added: Addition[]
} {
  const root = parseYamlMapping(readFileSync(CHANGES, 'utf8'), '指南改动点', fail)
  return {
    sha256: readString(root, 'sourceSha256', fail),
    points: readList(root, 'changePoints').map(item => ({
      path: readString(item, 'path', fail),
      kind: readString(item, 'kind', fail),
    })),
    renames: readList(root, 'renames').map(item => ({
      from: readString(item, 'from', fail),
      to: readString(item, 'to', fail),
    })),
    added: readList(root, 'added').map(item => ({ path: readString(item, 'path', fail) })),
  }
}

/** 权威基线里登记的对照表载体哈希。 */
function changeTableHashes(): Set<string> {
  const root = parseYamlMapping(readFileSync(AUTHORITY, 'utf8'), '权威基线', fail)
  const sources = root['sources']
  if (!Array.isArray(sources)) throw new Error('权威基线缺少 sources')
  const hashes = new Set<string>()
  for (const source of sources) {
    const carriers = readMapping(source, 'sources 的每一项', fail)['carriers']
    if (!Array.isArray(carriers)) continue
    for (const carrier of carriers) {
      const sha = readMapping(carrier, 'carriers 的每一项', fail)['sha256']
      if (typeof sha === 'string') hashes.add(sha)
    }
  }
  return hashes
}

describe('2026 年改动点资产', () => {
  it('records the change table hash that the authority baseline already carries', () => {
    const changes = readChanges()
    expect(changeTableHashes().has(changes.sha256)).toBe(true)
  })

  it('names each changed section once with a known kind', () => {
    const { points } = readChanges()
    const paths = points.map(point => point.path)
    expect(new Set(paths).size).toBe(paths.length)
    expect(paths.filter(path => !PATH.test(path))).toEqual([])
    expect(points.filter(point => !KINDS.includes(point.kind))).toEqual([])
  })

  it('renumbers only between two distinct sections', () => {
    const { renames } = readChanges()
    expect(renames.length).toBeGreaterThan(0)
    expect(renames.filter(rename => !PATH.test(rename.from) || !PATH.test(rename.to))).toEqual([])
    expect(renames.filter(rename => rename.from === rename.to)).toEqual([])
    const targets = renames.map(rename => rename.to)
    expect(new Set(targets).size).toBe(targets.length)
  })

  it('lists added sections that are not also recorded as changed 2023 sections', () => {
    const { points, added } = readChanges()
    const changed = new Set(points.map(point => point.path))
    expect(added.filter(item => !PATH.test(item.path))).toEqual([])
    expect(added.filter(item => changed.has(item.path))).toEqual([])
  })

  it('grounds every transcribed 2026 section in a recorded change point', () => {
    const changed = new Set(readChanges().points.map(point => point.path))
    const guideline = loadLawBaselines().get('专利审查指南')
    expect(guideline).toBeDefined()
    const transcribed = (guideline?.versions ?? []).flatMap(version =>
      version.sections.map(section => section.path))
    expect(transcribed.length).toBeGreaterThan(0)
    expect(transcribed.filter(path => !changed.has(path))).toEqual([])
  })

  it('grounds every stale section in a recorded change, renumbering, or addition', () => {
    const { points, renames, added } = readChanges()
    const known = new Set([
      ...points.map(point => point.path),
      ...renames.flatMap(rename => [rename.from, rename.to]),
      ...added.map(item => item.path),
    ])
    const guideline = loadLawBaselines().get('专利审查指南')
    const stale = guideline?.staleSections ?? []
    expect(stale.length).toBeGreaterThan(0)
    expect(stale.filter(section => !known.has(section.path))).toEqual([])
  })
})
