import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  loadPatternCorpus,
  loadPatternStore,
  parsePatternFile,
  patternKeywords,
  PatternStore,
} from '../src/pattern-store.ts'
import { PatternAssetError } from '../src/types.ts'
import { makePattern } from './fixtures/patterns.ts'
import { RETRIEVAL_CASES } from './fixtures/retrieval.ts'

let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/** Write a corpus of YAML files into a fresh temporary directory. */
async function writeCorpus(files: Record<string, string>): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'dsh-writing-patterns-'))
  for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content)
  return root
}

const LISTED = [
  'patterns:',
  '  - id: p1',
  '    name: P1',
  '    category: claim_drafting',
  '    summary: S1',
  '    steps:',
  '      - order: 1',
  '        name: Step',
  '        instruction: Do it',
  '',
].join('\n')

const MINIMAL = [
  'id: p1',
  'name: P1',
  'category: claim_drafting',
  'summary: S1',
  'steps:',
  '  - order: 1',
  '    name: Step',
  '    instruction: Do it',
  '',
].join('\n')

describe('packaged pattern corpus', () => {
  it('loads every shipped seed pattern', () => {
    const store = loadPatternStore()
    expect(store.size).toBe(store.all().length)
    expect(store.size).toBe(new Set(store.all().map(pattern => pattern.id)).size)
    expect(store.all().map(pattern => pattern.id)).toEqual([
      'wp-claim-3step-prior-art-check',
      'wp-claim-dependent-layering',
      'wp-claim-functional-limitation',
      'wp-claim-markush-equivalents',
      'wp-claim-software-trio',
      'wp-claim-unity-special-feature',
      'wp-claim-utility-model',
      'wp-disclosure-pfe',
      'wp-embodiment-enablement-matrix',
      'wp-embodiment-writing',
      'wp-ipc-strategy',
      'wp-oa-clarity-support',
      'wp-oa-inventiveness-3step',
      'wp-oa-novelty-separate',
      'wp-spec-amendment-reserve',
      'wp-spec-background',
      'wp-spec-invention-content',
      'wp-spec-numeric-range-fallback',
    ])
  })

  it('parses the authored fields of a seed pattern', () => {
    const pattern = loadPatternStore().get('wp-oa-inventiveness-3step')
    expect(pattern).toMatchObject({
      name: '创造性三步法 OA 答复框架',
      category: 'oa_inventiveness',
      quality: 0.95,
      version: 1,
    })
    expect(pattern?.steps.map(step => step.order)).toEqual([1, 2, 3, 4])
    expect(pattern?.dos).toHaveLength(3)
    expect(pattern?.donts).toHaveLength(4)
    expect(pattern?.context).toContain('专利法第22条第3款')
  })

  it('indexes patterns by category and by sub-category', () => {
    const store = loadPatternStore()
    expect(store.byCategory('oa_inventiveness').map(pattern => pattern.id)).toEqual(['wp-oa-inventiveness-3step'])
    expect(store.byCategory('claim_drafting')).toHaveLength(7)
    expect(store.byCategory('background').map(pattern => pattern.id)).toEqual(['wp-spec-background'])
    expect(store.byCategory('invalidation')).toEqual([])
    expect(store.get('no-such-pattern')).toBeUndefined()
  })

  it('indexes a pattern once when its sub-category repeats its category', () => {
    const store = new PatternStore([makePattern({ id: 'x', subCategory: 'claim_drafting' })])
    expect(store.byCategory('claim_drafting')).toHaveLength(1)
  })

  it('keeps the last record for a duplicate id, which the file boundary forbids', () => {
    const store = new PatternStore([
      makePattern({ id: 'dup', name: 'first' }),
      makePattern({ id: 'dup', name: 'second' }),
    ])
    expect(store.get('dup')?.name).toBe('second')
  })

  it('extracts a sub-category and tolerates a pattern without authored keywords', () => {
    const pattern = makePattern({ id: 'p2', subCategory: 'background', steps: [] })
    expect(patternKeywords(pattern)).toEqual(['pattern p2', 'claim_drafting', 'background'])
  })

  it('extracts authored keywords and step names, skipping one-character entries and rule text', () => {
    const pattern = makePattern({
      id: 'p1',
      name: 'A',
      keywords: ['术语', '规则'],
      dos: [{ rule: '规则文本' }],
      donts: [{ rule: '禁' }],
      steps: [{ order: 1, name: '步骤', instruction: 'x' }],
    })
    expect(patternKeywords(pattern)).toEqual(['术语', '规则', 'claim_drafting', '步骤'])
  })
})

describe('lexical search', () => {
  it('scores a term hit in the name above a hit in the summary and keeps the best first', () => {
    const store = loadPatternStore()
    const ranked = store.search('三步法', { limit: 5 }).map(pattern => pattern.id)
    expect(ranked[0]).toBe('wp-oa-inventiveness-3step')
    expect(ranked).toContain('wp-claim-3step-prior-art-check')
  })

  it('multiplies the score by the pattern quality', () => {
    // Ids are chosen so that an unweighted tie would sort the low-quality
    // pattern first; only the quality weight can put `b-high` ahead.
    const store = new PatternStore([
      makePattern({ id: 'a-low', name: '共同术语', quality: 0.5 }),
      makePattern({ id: 'b-high', name: '共同术语', quality: 1 }),
    ])
    expect(store.search('共同术语', { limit: 5 }).map(pattern => pattern.id)).toEqual(['b-high', 'a-low'])
  })

  it('breaks an equal score by ascending id', () => {
    const store = new PatternStore([
      makePattern({ id: 'b', name: '共同术语' }),
      makePattern({ id: 'a', name: '共同术语' }),
    ])
    expect(store.search('共同术语', { limit: 5 }).map(pattern => pattern.id)).toEqual(['a', 'b'])
  })

  it('returns the candidates unscored when the query has no term', () => {
    const store = loadPatternStore()
    expect(store.search('', { limit: 3 }).map(pattern => pattern.id)).toEqual([
      'wp-claim-3step-prior-art-check',
      'wp-claim-dependent-layering',
      'wp-claim-functional-limitation',
    ])
    expect(store.search('   ', { category: 'claim_drafting', limit: 5 }).map(pattern => pattern.id)).toEqual([
      'wp-claim-3step-prior-art-check',
      'wp-claim-dependent-layering',
      'wp-claim-functional-limitation',
      'wp-claim-markush-equivalents',
      'wp-claim-software-trio',
    ])
  })

  it('restricts the search to a category and caps the result', () => {
    const store = loadPatternStore()
    expect(store.search('权利要求', { limit: 2 })).toHaveLength(2)
    expect(store.search('权利要求', { category: 'oa_novelty', limit: 5 }).map(pattern => pattern.id))
      .toEqual(['wp-oa-novelty-separate'])
    expect(store.search('权利要求', { category: 'disclosure', limit: 5 })).toEqual([])
  })

  it('returns nothing when no term is contained anywhere', () => {
    expect(loadPatternStore().search('zzzz', { limit: 5 })).toEqual([])
  })

  it('finds patterns from a natural-language Chinese query', () => {
    const store = loadPatternStore()
    expect(store.search('创造性答复怎么写', { limit: 5 })[0]?.id).toBe('wp-oa-inventiveness-3step')
    expect(store.search('从权引用关系怎么写', { limit: 5 })[0]?.id).toBe('wp-claim-dependent-layering')
    expect(store.search('参数范围怎么写', { limit: 5 }).map(pattern => pattern.id))
      .toContain('wp-embodiment-writing')
    expect(store.search('背景技术对比表怎么写', { limit: 5 })[0]?.id).toBe('wp-spec-background')
  })

  it('searches Latin keywords as whole words', () => {
    const store = loadPatternStore()
    expect(store.search('Fallback', { limit: 5 }).map(pattern => pattern.id))
      .toContain('wp-claim-dependent-layering')
    expect(store.search('IPC', { limit: 5 })[0]?.id).toBe('wp-ipc-strategy')
  })

  it('searches do-not rules as well as do rules', () => {
    const store = new PatternStore([makePattern({ id: 'd', donts: [{ rule: '禁用语' }] })])
    expect(store.search('禁用语', { limit: 5 }).map(pattern => pattern.id)).toEqual(['d'])
  })

  it('matches a one-character Chinese run', () => {
    const store = new PatternStore([makePattern({ id: 'one', name: '阀' })])
    expect(store.search('阀', { limit: 5 }).map(pattern => pattern.id)).toEqual(['one'])
  })

  it('retrieves a relevant pattern in the top three for realistic queries', () => {
    const store = loadPatternStore()
    const misses = RETRIEVAL_CASES.filter(({ query, expected }) => {
      const top = store.search(query, { limit: 3 }).map(pattern => pattern.id)
      return !expected.some(id => top.includes(id))
    })
    expect(misses, JSON.stringify(misses)).toHaveLength(0)
  })
})

describe('case-feature match', () => {
  it('scores the case type against the category', () => {
    const store = loadPatternStore()
    const matched = store.match({ caseType: 'oa', limit: 10 })
    expect(matched).toHaveLength(3)
    expect(new Set(matched.map(pattern => pattern.category))).toEqual(
      new Set(['oa_inventiveness', 'oa_novelty', 'oa_clarity']),
    )
  })

  it('scores feature hits in the name, the summary, and step names', () => {
    const store = new PatternStore([
      makePattern({ id: 'a-name', name: '含术语' }),
      makePattern({ id: 'b-summary', summary: '含术语' }),
      makePattern({ id: 'c-step', steps: [{ order: 1, name: '含术语', instruction: 'x' }] }),
      makePattern({ id: 'd-none', name: '不相关', summary: '不相关' }),
    ])
    expect(store.match({ features: ['含术语'], limit: 5 }).map(pattern => pattern.id))
      .toEqual(['a-name', 'b-summary', 'c-step'])
  })

  it('scores an authored keyword above a summary hit', () => {
    const withKeyword = makePattern({ id: 'a', name: '共同', keywords: ['术语'] })
    const withoutKeyword = makePattern({ id: 'b', summary: '术语' })
    const store = new PatternStore([withKeyword, withoutKeyword])
    expect(store.match({ features: ['术语'], limit: 5 }).map(pattern => pattern.id)).toEqual(['a', 'b'])
  })

  it('multiplies the match score by the pattern quality', () => {
    const store = new PatternStore([
      makePattern({ id: 'a-low', name: '共同术语', quality: 0.5 }),
      makePattern({ id: 'b-high', name: '共同术语', quality: 1 }),
    ])
    expect(store.match({ features: ['共同术语'], limit: 5 }).map(pattern => pattern.id)).toEqual(['b-high', 'a-low'])
  })

  it('scores a Chinese category label as the case type', () => {
    expect(loadPatternStore().match({ caseType: '创造性', limit: 5 }).map(pattern => pattern.id))
      .toEqual(['wp-oa-inventiveness-3step'])
  })

  it('scores feature matches against pattern text and caps the result', () => {
    const store = loadPatternStore()
    expect(store.match({ caseType: 'oa', features: ['创造性'], limit: 1 }))
      .toHaveLength(1)
    expect(store.match({ caseType: 'oa', features: ['创造性'], limit: 10 })[0]?.id)
      .toBe('wp-oa-inventiveness-3step')
  })

  it('ignores blank features and returns nothing without any signal', () => {
    const store = loadPatternStore()
    expect(store.match({ features: [''], limit: 5 })).toEqual([])
    expect(store.match({ caseType: '  ', limit: 5 })).toEqual([])
    expect(store.match({ limit: 5 })).toEqual([])
  })
})

describe('corpus loading is fail-loud', () => {
  it('reports an unreadable directory', () => {
    expect(() => loadPatternCorpus(join(tmpdir(), 'dsh-writing-patterns-absent')))
      .toThrow(/无法读取写作模式资产目录/)
  })

  it('reports a directory without a pattern file', async () => {
    const dir = await writeCorpus({ 'notes.md': '# not a pattern' })
    expect(() => loadPatternCorpus(dir)).toThrow(/目录下没有 \.yaml \/ \.yml 写作模式资产/)
  })

  it('ignores a non-YAML file beside a valid pattern', async () => {
    const dir = await writeCorpus({ 'p1.yaml': MINIMAL, 'README.md': '# corpus' })
    expect(loadPatternCorpus(dir)).toHaveLength(1)
  })

  it('loads a .yml asset beside a .yaml one', async () => {
    const dir = await writeCorpus({
      'p1.yaml': MINIMAL,
      'p2.yml': MINIMAL.replace('id: p1', 'id: p2').replace('name: P1', 'name: P2'),
    })
    expect(loadPatternCorpus(dir).map(pattern => pattern.id)).toEqual(['p1', 'p2'])
  })

  it('rejects an unknown field instead of silently dropping it', async () => {
    const dir = await writeCorpus({ 'p1.yaml': `${MINIMAL}qualtiy: 0.9\n` })
    expect(() => loadPatternCorpus(dir)).toThrow(/根节点 含未知字段：qualtiy/)
  })

  it('rejects an unknown field beside a patterns list', async () => {
    const dir = await writeCorpus({
      'p1.yaml': LISTED.replace('patterns:', 'keywords:\n  - shared\npatterns:'),
    })
    expect(() => loadPatternCorpus(dir)).toThrow(/根节点 含未知字段：keywords/)
  })

  it('rejects an unknown field inside a step, an example, and a principle', async () => {
    const step = await writeCorpus({
      'p1.yaml': MINIMAL.replace('    instruction: Do it\n', '    instruction: Do it\n    tip: extra\n'),
    })
    expect(() => loadPatternCorpus(step)).toThrow(/根节点\.steps\[0\] 含未知字段：tip/)
    const example = await writeCorpus({
      'p1.yaml': `${MINIMAL}examples:\n  - text: Example\n    source: upstream\n`,
    })
    expect(() => loadPatternCorpus(example)).toThrow(/根节点\.examples\[0\] 含未知字段：source/)
    const principle = await writeCorpus({
      'p1.yaml': `${MINIMAL}dos:\n  - rule: Follow\n    reason: because\n`,
    })
    expect(() => loadPatternCorpus(principle)).toThrow(/根节点\.dos\[0\] 含未知字段：reason/)
  })

  it('keeps authored example context and note, and omits both when absent', async () => {
    const dir = await writeCorpus({
      'p1.yaml': `${MINIMAL}examples:\n  - text: Example\n    context: 场景\n    note: 备注\n`,
      'p2.yaml': MINIMAL.replace('id: p1', 'id: p2').replace('name: P1', 'name: P2')
        + 'examples:\n  - text: Plain\n',
    })
    expect(loadPatternCorpus(dir).map(pattern => pattern.examples)).toEqual([
      [{ text: 'Example', context: '场景', note: '备注' }],
      [{ text: 'Plain' }],
    ])
  })

  it('reports a YAML syntax error', async () => {
    const dir = await writeCorpus({ 'p1.yaml': 'id: [unclosed\n' })
    expect(() => loadPatternCorpus(dir)).toThrow(/YAML 解析失败/)
  })

  it('reports a root that is not a mapping', async () => {
    const dir = await writeCorpus({ 'p1.yaml': '- one\n- two\n' })
    expect(() => loadPatternCorpus(dir)).toThrow(/根节点 必须是映射/)
  })

  it('reports a patterns list that is not a list, and an empty one', async () => {
    const scalar = await writeCorpus({ 'p1.yaml': 'patterns: nope\n' })
    expect(() => loadPatternCorpus(scalar)).toThrow(/`patterns` 必须是模式数组/)
    const empty = await writeCorpus({ 'p1.yaml': 'patterns: []\n' })
    expect(() => loadPatternCorpus(empty)).toThrow(/`patterns` 列表为空/)
  })

  it('loads every pattern of a list document', async () => {
    const dir = await writeCorpus({
      'p1.yaml': [
        'patterns:',
        '  - id: a',
        '    name: A',
        '    category: disclosure',
        '    summary: SA',
        '  - id: b',
        '    name: B',
        '    category: embodiment',
        '    summary: SB',
        '',
      ].join('\n'),
    })
    expect(loadPatternCorpus(dir).map(pattern => pattern.id)).toEqual(['a', 'b'])
  })

  it('reports a missing required field, naming its position in the document', async () => {
    const dir = await writeCorpus({ 'p1.yaml': 'name: A\ncategory: disclosure\nsummary: S\n' })
    expect(() => loadPatternCorpus(dir)).toThrow(/根节点\.id 必须是非空字符串/)
  })

  it('reports an unknown category with the known set', async () => {
    const dir = await writeCorpus({ 'p1.yaml': 'id: a\nname: A\ncategory: oa_inventivness\nsummary: S\n' })
    expect(() => loadPatternCorpus(dir)).toThrow(/不是已知类目：oa_inventivness/)
  })

  it('reports a mistyped nested field', async () => {
    const bad = await writeCorpus({ 'p1.yaml': MINIMAL.replace('- order: 1', '- order: zero') })
    expect(() => loadPatternCorpus(bad)).toThrow(/根节点\.steps\[0\]\.order 必须是正整数/)
    const missing = await writeCorpus({ 'p1.yaml': MINIMAL.replace('    instruction: Do it\n', '') })
    expect(() => loadPatternCorpus(missing)).toThrow(/根节点\.steps\[0\]\.instruction 必须是非空字符串/)
  })

  it('reports a sub-category that is not a string', async () => {
    const dir = await writeCorpus({ 'p1.yaml': `${MINIMAL}sub_category: [x]\n` })
    expect(() => loadPatternCorpus(dir)).toThrow(/根节点\.sub_category 必须是字符串/)
  })

  it('reports a keywords field that is not a string list', async () => {
    const notList = await writeCorpus({ 'p1.yaml': `${MINIMAL}keywords: 术语\n` })
    expect(() => loadPatternCorpus(notList)).toThrow(/keywords 必须是数组/)
    const blank = await writeCorpus({ 'p1.yaml': `${MINIMAL}keywords: [""]\n` })
    expect(() => loadPatternCorpus(blank)).toThrow(/keywords\[0\] 必须是非空字符串/)
  })

  it('rejects duplicate or non-contiguous step orders and sorts the steps by order', async () => {
    const twoSteps = (first: number, second: number) => [
      'id: p1',
      'name: P1',
      'category: claim_drafting',
      'summary: S1',
      'steps:',
      `  - order: ${String(first)}`,
      '    name: One',
      '    instruction: Do one',
      `  - order: ${String(second)}`,
      '    name: Two',
      '    instruction: Do two',
      '',
    ].join('\n')
    const duplicate = await writeCorpus({ 'p1.yaml': twoSteps(1, 1) })
    expect(() => loadPatternCorpus(duplicate)).toThrow(/order 必须唯一/)
    const gap = await writeCorpus({ 'p1.yaml': twoSteps(1, 3) })
    expect(() => loadPatternCorpus(gap)).toThrow(/order 必须从 1 开始连续/)
    const reversed = await writeCorpus({ 'p1.yaml': twoSteps(2, 1) })
    expect(loadPatternCorpus(reversed)[0]?.steps.map(step => step.order)).toEqual([1, 2])
  })

  it('reports a duplicated pattern id across files', async () => {
    const dir = await writeCorpus({ 'a.yaml': MINIMAL, 'b.yaml': MINIMAL })
    expect(() => loadPatternCorpus(dir)).toThrow(/模式 id "p1" 与 a\.yaml 重复/)
  })

  it('reports an unreadable asset file', () => {
    expect(() => parsePatternFile(tmpdir())).toThrow(/无法读取写作模式资产/)
  })
})

describe('corpus normalization', () => {
  it('fills the default quality for an absent or zero value', async () => {
    const absent = await writeCorpus({ 'p1.yaml': MINIMAL })
    expect(loadPatternCorpus(absent)[0]?.quality).toBe(0.8)
    const zero = await writeCorpus({ 'p1.yaml': `${MINIMAL}quality: 0\n` })
    expect(loadPatternCorpus(zero)[0]?.quality).toBe(0.8)
  })

  it('rejects a quality outside the unit range', async () => {
    const high = await writeCorpus({ 'p1.yaml': `${MINIMAL}quality: 1.5\n` })
    expect(() => loadPatternCorpus(high)).toThrow(/quality 必须在 0 与 1 之间：1\.5/)
    const negative = await writeCorpus({ 'p1.yaml': `${MINIMAL}quality: -0.5\n` })
    expect(() => loadPatternCorpus(negative)).toThrow(/quality 必须在 0 与 1 之间：-0\.5/)
    const textual = await writeCorpus({ 'p1.yaml': `${MINIMAL}quality: high\n` })
    expect(() => loadPatternCorpus(textual)).toThrow(/quality 必须是数字/)
  })

  it('rejects a version that is not a positive integer', async () => {
    const dir = await writeCorpus({ 'p1.yaml': `${MINIMAL}version: 0\n` })
    expect(() => loadPatternCorpus(dir)).toThrow(/version 必须是正整数/)
  })

  it('treats an empty optional string as absent and keeps a filled one', async () => {
    const dir = await writeCorpus({
      'a.yaml': `${MINIMAL}context: ''\nsub_category: ''\nsource_ref: ''\n`,
      'b.yaml': 'id: p2\nname: P2\ncategory: spec_drafting\nsummary: S2\nsub_category: background\nsource_ref: 指南\n',
    })
    const patterns = loadPatternCorpus(dir)
    expect(patterns[0]).not.toHaveProperty('context')
    expect(patterns[0]).not.toHaveProperty('subCategory')
    expect(patterns[0]).not.toHaveProperty('sourceRef')
    expect(patterns[1]).toMatchObject({ subCategory: 'background', sourceRef: '指南' })
  })

  it('reports the asset path and keeps the error type', async () => {
    const dir = await writeCorpus({ 'p1.yaml': 'patterns: nope\n' })
    try {
      loadPatternCorpus(dir)
      throw new Error('expected the load to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(PatternAssetError)
      expect((error as PatternAssetError).source).toBe(join(dir, 'p1.yaml'))
      expect((error as PatternAssetError).name).toBe('PatternAssetError')
    }
  })
})
