import { describe, expect, it } from 'vitest'
import {
  createFtsLadder,
  runFtsSearch,
  type FtsSearchLadder,
  type FtsSearchOps,
} from '@deepseek-ai/dsh-knowledge-core'

/** A ladder whose three query paths and degrade callback are recorded. */
function ladder(overrides: Partial<FtsSearchLadder<string>> = {}): FtsSearchLadder<string> {
  return {
    keyword: '创造性判断',
    hasFts: true,
    ftsDegraded: false,
    searchFts: () => ['fts'],
    searchFtsKeywords: () => ['fts-keywords'],
    searchLike: () => ['like'],
    degrade: () => {},
    ...overrides,
  }
}

describe('runFtsSearch', () => {
  it('uses LIKE when the runtime has no FTS support', () => {
    expect(runFtsSearch(ladder({ hasFts: false }))).toEqual(['like'])
  })

  it('uses LIKE after a sticky degradation', () => {
    expect(runFtsSearch(ladder({ ftsDegraded: true }))).toEqual(['like'])
  })

  it('uses LIKE for a query shorter than the trigram minimum', () => {
    expect(runFtsSearch(ladder({ keyword: '新颖' }))).toEqual(['like'])
  })

  it('returns the whole-phrase FTS hits when the phrase matches', () => {
    expect(runFtsSearch(ladder())).toEqual(['fts'])
  })

  it('falls back to the split-keyword FTS query when the phrase misses', () => {
    const calls: string[] = []
    const result = runFtsSearch(ladder({
      keyword: '专利侵权的赔偿标准是什么',
      searchFts: () => {
        calls.push('fts')
        return []
      },
      searchFtsKeywords: (keywords) => {
        calls.push(`fts-keywords:${keywords.join('/')}`)
        return ['fts-keywords']
      },
    }))
    expect(result).toEqual(['fts-keywords'])
    expect(calls).toEqual(['fts', 'fts-keywords:专利侵权/赔偿标准'])
  })

  it('skips the split-keyword query when the phrase is already one fragment', () => {
    const calls: string[] = []
    const result = runFtsSearch(ladder({
      keyword: '赔偿标准',
      searchFts: () => {
        calls.push('fts')
        return []
      },
      searchFtsKeywords: () => {
        calls.push('fts-keywords')
        return ['fts-keywords']
      },
      searchLike: () => {
        calls.push('like')
        return ['like']
      },
    }))
    expect(result).toEqual(['like'])
    expect(calls).toEqual(['fts', 'like'])
  })

  it('skips the split-keyword query when no fragment reaches the minimum length', () => {
    const calls: string[] = []
    const result = runFtsSearch(ladder({
      keyword: '赔偿 标准',
      searchFts: () => {
        calls.push('fts')
        return []
      },
      searchFtsKeywords: () => {
        calls.push('fts-keywords')
        return ['fts-keywords']
      },
      searchLike: () => {
        calls.push('like')
        return ['like']
      },
    }))
    expect(result).toEqual(['like'])
    expect(calls).toEqual(['fts', 'like'])
  })

  it('falls back to LIKE when the split-keyword query also misses', () => {
    const result = runFtsSearch(ladder({
      searchFts: () => [],
      searchFtsKeywords: () => [],
    }))
    expect(result).toEqual(['like'])
  })

  it('degrades and retries with LIKE when the FTS query throws', () => {
    const reasons: string[] = []
    const result = runFtsSearch(ladder({
      searchFts: () => {
        throw new Error('no such module: fts5')
      },
      degrade: (reason) => {
        reasons.push(reason)
      },
    }))
    expect(result).toEqual(['like'])
    expect(reasons).toEqual(['no such module: fts5'])
  })
})

describe('createFtsLadder', () => {
  it('binds the three query paths to the given options and limit', () => {
    const seen: Array<[string, string, number]> = []
    const ops: FtsSearchOps<{ tag: string }, string> = {
      searchFts: (keyword, options, limit) => {
        seen.push(['fts', keyword, limit])
        return [options.tag]
      },
      searchFtsKeywords: (keywords, options, limit) => {
        seen.push(['fts-keywords', keywords.join('/'), limit])
        return [options.tag]
      },
      searchLike: (keyword, options, limit) => {
        seen.push(['like', keyword, limit])
        return [options.tag]
      },
      degrade: () => {},
    }
    const options = { tag: 'hit' }
    const built = createFtsLadder(
      { keyword: '创造性判断', hasFts: true, ftsDegraded: false },
      options,
      7,
      ops,
    )
    expect(built.keyword).toBe('创造性判断')
    expect(built.hasFts).toBe(true)
    expect(built.ftsDegraded).toBe(false)
    expect(built.searchFts('创造性判断')).toEqual(['hit'])
    expect(built.searchFtsKeywords(['创造性', '判断'])).toEqual(['hit'])
    expect(built.searchLike('创造性判断')).toEqual(['hit'])
    built.degrade('reason')
    expect(seen).toEqual([
      ['fts', '创造性判断', 7],
      ['fts-keywords', '创造性/判断', 7],
      ['like', '创造性判断', 7],
    ])
  })
})
