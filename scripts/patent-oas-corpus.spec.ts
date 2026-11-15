import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadPublicGrantCorpus } from './patent-oas-corpus.ts'

const checkedInCorpus = resolve(
  import.meta.dirname,
  '../packages/self-evolve/self-evolve-benchmark/examples/patent-oas/corpus',
)

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 写一份只含一件公开授权文本的最小语料,供单点破坏。 */
function writeMinimalCorpus(mutate?: (dir: string) => void): string {
  const root = mkdtempSync(join(tmpdir(), 'patent-oas-corpus-'))
  roots.push(root)
  const itemDir = join(root, 'items', 'cn214853374u')
  mkdirSync(itemDir, { recursive: true })
  writeFileSync(join(root, 'manifest.yaml'), [
    'kind: public-grant',
    'plannedDelegalizedGrants: 1',
    'plannedAttorneyRevisions: 5',
    'items:',
    '  - id: cn214853374u',
    '    publication: CN214853374U',
    '    source: https://patents.google.com/patent/CN214853374U/zh',
    '    figures: 6',
    '    title: 一种智能浇灌控制器',
    '',
  ].join('\n'))
  writeFileSync(
    join(itemDir, 'statement'),
    '公开授权文本 CN214853374U《一种智能浇灌控制器》转述室外浇灌控制器的壳体与出线。附图6幅。不是客户材料。\n',
  )
  mutate?.(root)
  return root
}

describe('loadPublicGrantCorpus', () => {
  it('counts the checked-in public grants and their figures', async () => {
    const status = await loadPublicGrantCorpus(checkedInCorpus)
    expect(status.problems).toEqual([])
    expect(status.grants).toBe(30)
    expect(status.figures).toBe(147)
    expect(status.attorneyRevisions).toBe(0)
    expect(status.plannedAttorneyRevisions).toBe(5)
  })

  it('reports a missing manifest instead of skipping the corpus', async () => {
    const root = mkdtempSync(join(tmpdir(), 'patent-oas-corpus-'))
    roots.push(root)
    const status = await loadPublicGrantCorpus(root)
    expect(status.problems.join('\n')).toContain('manifest.yaml')
    expect(status.grants).toBe(0)
  })

  it('rejects a non-positive figure count', async () => {
    const root = writeMinimalCorpus((dir) => {
      const manifest = join(dir, 'manifest.yaml')
      writeFileSync(manifest, [
        'kind: public-grant',
        'plannedDelegalizedGrants: 1',
        'plannedAttorneyRevisions: 5',
        'items:',
        '  - id: cn214853374u',
        '    publication: CN214853374U',
        '    source: https://patents.google.com/patent/CN214853374U/zh',
        '    figures: 0',
        '    title: 一种智能浇灌控制器',
        '',
      ].join('\n'))
    })
    const status = await loadPublicGrantCorpus(root)
    expect(status.problems.join('\n')).toContain('figures')
  })

  it('rejects a statement that omits the publication number', async () => {
    const root = writeMinimalCorpus((dir) => {
      writeFileSync(
        join(dir, 'items', 'cn214853374u', 'statement'),
        '公开授权文本转述室外浇灌控制器的壳体与出线。附图6幅。不是客户材料。\n',
      )
    })
    const status = await loadPublicGrantCorpus(root)
    expect(status.problems.join('\n')).toContain('CN214853374U')
  })

  it('rejects an item directory that also holds a rubric', async () => {
    const root = writeMinimalCorpus((dir) => {
      writeFileSync(join(dir, 'items', 'cn214853374u', 'rubric'), '1. 形式(100 分):\n')
    })
    const status = await loadPublicGrantCorpus(root)
    expect(status.problems.join('\n')).toContain('rubric')
  })

  it('rejects a client or attorney-revision kind', async () => {
    const root = writeMinimalCorpus((dir) => {
      const text = [
        'kind: client',
        'plannedDelegalizedGrants: 1',
        'plannedAttorneyRevisions: 5',
        'items:',
        '  - id: cn214853374u',
        '    publication: CN214853374U',
        '    source: https://patents.google.com/patent/CN214853374U/zh',
        '    figures: 6',
        '    title: 一种智能浇灌控制器',
        '',
      ].join('\n')
      writeFileSync(join(dir, 'manifest.yaml'), text)
    })
    const status = await loadPublicGrantCorpus(root)
    expect(status.problems.join('\n')).toContain('未获授权')
  })

  it('rejects a statement that calls itself a client disclosure', async () => {
    const root = writeMinimalCorpus((dir) => {
      writeFileSync(
        join(dir, 'items', 'cn214853374u', 'statement'),
        '公开授权文本 CN214853374U 来自客户交底。附图6幅。不是客户材料。\n',
      )
    })
    const status = await loadPublicGrantCorpus(root)
    expect(status.problems.join('\n')).toContain('客户交底')
  })

  it('rejects a grant count that disagrees with the planned count', async () => {
    const root = writeMinimalCorpus((dir) => {
      const text = [
        'kind: public-grant',
        'plannedDelegalizedGrants: 2',
        'plannedAttorneyRevisions: 5',
        'items:',
        '  - id: cn214853374u',
        '    publication: CN214853374U',
        '    source: https://patents.google.com/patent/CN214853374U/zh',
        '    figures: 6',
        '    title: 一种智能浇灌控制器',
        '',
      ].join('\n')
      writeFileSync(join(dir, 'manifest.yaml'), text)
    })
    const status = await loadPublicGrantCorpus(root)
    expect(status.problems.join('\n')).toContain('plannedDelegalizedGrants')
  })
})
