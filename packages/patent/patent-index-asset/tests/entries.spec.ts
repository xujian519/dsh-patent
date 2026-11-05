import { describe, expect, it } from 'vitest'
import {
  IndexAssetError,
  checkRecordedSource,
  parseYamlMapping,
  readArticleEntries,
  readEntryTopics,
  type AssetFail,
  type RecordedSource,
} from '../src/index.ts'

/** The error a fixture index raises, the way an index package binds its own. */
class FixtureIndexError extends IndexAssetError {
  constructor(message: string) {
    super(message, 'fixture.yaml')
    this.name = 'FixtureIndexError'
  }
}

const fail: AssetFail = (message: string) => new FixtureIndexError(message)

/** An article entry carrying only the fields every entry states. */
function article(fields: Record<string, unknown>): Record<string, unknown> {
  return { topics: ['新颖性'], text: null, ...fields }
}

/** The transcription record of an untranscribed entry. */
const noSource: RecordedSource = { sourceDoc: null, verifiedOn: null }

describe('reading the article list', () => {
  it('treats an absent or null list as empty', () => {
    expect(readArticleEntries(undefined, fail)).toEqual([])
    expect(readArticleEntries(null, fail)).toEqual([])
  })

  it('keeps declaration order and every declared field', () => {
    const entries = readArticleEntries([
      article({
        article: 22,
        paragraphs: [1, 2, 3],
        topics: ['新颖性', '创造性'],
        text: '条文',
        sourceDoc: '公告第 1 号',
        verifiedOn: '2026-01-01',
      }),
      article({ article: 23 }),
    ], fail)
    expect(entries.map(entry => entry.article)).toEqual([22, 23])
    expect(entries[0]).toEqual({
      article: 22,
      paragraphs: [1, 2, 3],
      topics: ['新颖性', '创造性'],
      text: '条文',
      sourceDoc: '公告第 1 号',
      verifiedOn: '2026-01-01',
    })
    // An entry that has not recorded its paragraphs omits the field rather than
    // defaulting to an empty or inferred list.
    expect(entries[1]).not.toHaveProperty('paragraphs')
    expect(entries[1]?.topics).toEqual(['新颖性'])
  })

  it.each([
    ['a mapping instead of a list', () => readArticleEntries({}, fail), /字段 articles 必须是数组/],
    ['a scalar entry', () => readArticleEntries([1], fail), /articles 的每一项 必须是映射/],
    ['an entry without an article number', () => readArticleEntries([article({})], fail), /article 必须是正整数/],
    ['article 0', () => readArticleEntries([article({ article: 0 })], fail), /字段 article 必须是正整数/],
    ['a fractional article', () => readArticleEntries([article({ article: 22.5 })], fail), /字段 article 必须是正整数/],
    ['a textual article', () => readArticleEntries([article({ article: '22' })], fail), /字段 article 必须是正整数/],
    [
      'a duplicate article number',
      () => readArticleEntries([article({ article: 22 }), article({ article: 22 })], fail),
      /article 重复：22/,
    ],
    ['a missing topic list', () => readArticleEntries([{ article: 22, text: null }], fail), /第22条 的 topics 必须是非空数组/],
    ['an empty topic list', () => readArticleEntries([article({ article: 22, topics: [] })], fail), /第22条 的 topics 必须是非空数组/],
    ['a non-string topic', () => readArticleEntries([article({ article: 22, topics: ['新颖性', 7] })], fail), /第22条 的 topics 只能包含非空字符串/],
    ['a blank topic', () => readArticleEntries([article({ article: 22, topics: ['  '] })], fail), /第22条 的 topics 只能包含非空字符串/],
  ])('rejects %s', (_case, run, message) => {
    expect(run).toThrow(message)
  })
})

describe('reading the paragraph list', () => {
  it('keeps an absent or null list absent', () => {
    expect(readArticleEntries([article({ article: 22 })], fail)[0]).not.toHaveProperty('paragraphs')
    expect(readArticleEntries([article({ article: 22, paragraphs: null })], fail)[0]).not.toHaveProperty('paragraphs')
  })

  it.each([
    ['an empty list', [], /第22条的 paragraphs 必须是 null 或非空数组/],
    ['a scalar', '1,2', /第22条的 paragraphs 必须是 null 或非空数组/],
    ['a zero paragraph', [0], /第22条的 paragraphs 只能是正整数/],
    ['a fractional paragraph', [1.5], /第22条的 paragraphs 只能是正整数/],
    ['a textual paragraph', ['1'], /第22条的 paragraphs 只能是正整数/],
    ['a repeated paragraph', [1, 1, 2], /第22条的 paragraphs 有重复款号/],
  ])('rejects %s', (_case, paragraphs, message) => {
    expect(() => readArticleEntries([article({ article: 22, paragraphs })], fail)).toThrow(message)
  })
})

describe('the transcription record of an entry', () => {
  it('accepts an entry whose text, source, and verification date agree', () => {
    const [entry] = readArticleEntries([
      article({ article: 22, text: '条文', sourceDoc: '公告第 1 号', verifiedOn: '2026-01-01' }),
    ], fail)
    expect(entry).toMatchObject({ text: '条文', sourceDoc: '公告第 1 号', verifiedOn: '2026-01-01' })
  })

  it.each([
    ['text without a source document', { text: '条文', verifiedOn: '2026-01-01' }],
    ['text without a verification date', { text: '条文', sourceDoc: '公告第 1 号' }],
    ['a source document without text', { sourceDoc: '公告第 1 号', verifiedOn: '2026-01-01' }],
    ['a verification date without text', { verifiedOn: '2026-01-01' }],
  ])('rejects %s', (_case, fields) => {
    expect(() => readArticleEntries([article({ article: 22, ...fields })], fail)).toThrow(/第22条/)
  })

  it('keeps an untranscribed entry empty rather than recording half a source', () => {
    const [entry] = readArticleEntries([article({ article: 22 })], fail)
    expect(entry).toEqual({
      article: 22,
      topics: ['新颖性'],
      text: null,
      sourceDoc: null,
      verifiedOn: null,
    })
  })

  it('decides the all-or-nothing rule on the two fields directly', () => {
    expect(() => { checkRecordedSource(null, noSource, fail, '第1条') }).not.toThrow()
    expect(() => { checkRecordedSource('条文', { sourceDoc: 'a', verifiedOn: '2026-01-01' }, fail, '第1条') }).not.toThrow()
    expect(() => { checkRecordedSource('条文', { sourceDoc: 'a', verifiedOn: null }, fail, '第1条') })
      .toThrow(/第1条 的 text 已转录，但 sourceDoc 与 verifiedOn 必须同时记录/)
    expect(() => { checkRecordedSource(null, { sourceDoc: 'a', verifiedOn: null }, fail, '第1条') })
      .toThrow(/第1条 尚未转录 text，不能单独记录 sourceDoc 或 verifiedOn/)
  })
})

describe('reading topic keywords', () => {
  it('rejects a missing, empty, or non-string list', () => {
    expect(() => readEntryTopics(undefined, fail, '第1条')).toThrow(/第1条 的 topics 必须是非空数组/)
    expect(() => readEntryTopics([], fail, '第1条')).toThrow(/第1条 的 topics 必须是非空数组/)
    expect(() => readEntryTopics(['a', ''], fail, '第1条')).toThrow(/第1条 的 topics 只能包含非空字符串/)
  })

  it('keeps the declared order and trims surrounding whitespace', () => {
    expect(readEntryTopics([' 创造性 ', '新颖性'], fail, '第1条')).toEqual(['创造性', '新颖性'])
  })
})

describe('reading the asset file', () => {
  it('rejects duplicate keys instead of keeping one of the two values', () => {
    expect(() => parseYamlMapping('articles: []\narticles: []\n', '法条索引', fail)).toThrow(/YAML 解析失败/)
  })

  it('rejects a file holding more than one document', () => {
    expect(() => parseYamlMapping('law: 专利法\n---\nlaw: 专利法实施细则\n', '法条索引', fail)).toThrow(/YAML 解析失败/)
  })
})
