import { describe, expect, it } from 'vitest'
import {
  checkClaimUnity,
  claimSimilarity,
  normalizeClaimText,
  type UnityClaim,
} from '../../src/claim-coverage/unity.ts'

// 用例表转写自 Mady domains/claimdrafting/unity_test.go（MIT，同作者）；
// 相似度期望值按本模块的清洗与权重重新计算（上游综合评分公式见模块头注释）。

const LOCK_CLAIMS: UnityClaim[] = [
  {
    number: 1,
    kind: 'independent',
    preamble: '一种智能门锁',
    characterized: '包括锁体、指纹识别模块、控制模块和驱动电机，指纹识别模块采集指纹后由控制模块驱动电机开合锁体',
  },
  {
    number: 2,
    kind: 'independent',
    preamble: '一种智能门锁的指纹解锁方法',
    characterized: '通过指纹识别模块采集指纹，由控制模块比对指纹特征后驱动电机开合锁体',
  },
]

const UNRELATED_CLAIMS: UnityClaim[] = [
  { number: 1, kind: 'independent', preamble: '一种太阳能发电装置', characterized: '包括光伏板、逆变器和支架' },
  { number: 2, kind: 'independent', preamble: '一种中药煎煮设备', characterized: '包括药罐、加热盘和温控器' },
]

describe('checkClaimUnity: 独立权利要求数量', () => {
  it('单项独立权利要求天然满足单一性，无配对且评分满分', () => {
    const verdict = checkClaimUnity([
      { number: 1, kind: 'independent', preamble: '一种加热装置', characterized: '包括加热元件' },
    ])
    expect(verdict).toEqual({
      hasUnity: true,
      score: 100,
      grade: 'good',
      pairScores: [],
      diagnostics: [],
    })
  })

  it('无独立权利要求天然满足单一性', () => {
    const verdict = checkClaimUnity([
      { number: 1, kind: 'dependent', preamble: '根据权利要求1所述的装置', characterized: '还包括显示模块' },
    ])
    expect(verdict.hasUnity).toBe(true)
    expect(verdict.grade).toBe('good')
  })
})

describe('checkClaimUnity: 评级与判定自洽', () => {
  it('共享大量技术特征的独立权利要求满足单一性，落入 fair 档', () => {
    const verdict = checkClaimUnity(LOCK_CLAIMS)
    expect(verdict.hasUnity).toBe(true)
    expect(verdict.grade).toBe('fair')
    expect(verdict.diagnostics).toEqual([])
    expect(verdict.pairScores[0]?.similarity).toBeCloseTo(0.7751, 4)
    expect(verdict.score).toBeCloseTo(77.51, 2)
  })

  it('技术主题无关的独立权利要求判为 poor 并给出诊断', () => {
    const verdict = checkClaimUnity(UNRELATED_CLAIMS)
    expect(verdict.hasUnity).toBe(false)
    expect(verdict.grade).toBe('poor')
    expect(verdict.diagnostics.join('')).toMatch(/单一性/)
    expect(verdict.pairScores[0]?.similarity).toBeCloseTo(0.0339, 4)
    expect(verdict.score).toBeLessThan(60)
  })

  it('近乎相同的独立权利要求评为 good', () => {
    const verdict = checkClaimUnity([
      { number: 1, kind: 'independent', preamble: '一种智能门锁', characterized: '包括锁体、指纹识别模块、控制模块和驱动电机' },
      {
        number: 2,
        kind: 'independent',
        preamble: '一种智能门锁',
        characterized: '包括锁体、指纹识别模块、控制模块、驱动电机和报警模块',
      },
    ])
    expect(verdict.hasUnity).toBe(true)
    expect(verdict.grade).toBe('good')
    expect(verdict.score).toBeCloseTo(92.7, 2)
  })

  it('评分即最弱对相似度百分数（短板原则，三项独立权利要求）', () => {
    const verdict = checkClaimUnity([
      { number: 1, kind: 'independent', preamble: '一种锁体', characterized: '包括指纹识别模块和控制模块' },
      { number: 2, kind: 'independent', preamble: '一种锁体', characterized: '包括指纹识别模块和控制模块' },
      { number: 3, kind: 'independent', preamble: '一种煎煮设备', characterized: '包括药罐和加热盘' },
    ])
    expect(verdict.pairScores).toHaveLength(3)
    const weakest = Math.min(...verdict.pairScores.map(pair => pair.similarity))
    expect(verdict.score).toBeCloseTo(weakest * 100, 10)
    expect(verdict.grade).toBe('poor')
  })

  it('配对编号取自权利要求原文而不是数组下标', () => {
    const verdict = checkClaimUnity([
      { number: 1, kind: 'independent', preamble: '一种装置A' },
      { number: 5, kind: 'independent', preamble: '一种装置B' },
    ])
    expect(verdict.pairScores.map(pair => [pair.leftNumber, pair.rightNumber])).toEqual([[1, 5]])
  })

  it('从属权利要求不进配对，缺省特征部分时只比较前序部分', () => {
    const verdict = checkClaimUnity([
      { number: 1, kind: 'independent', preamble: '一种智能门锁' },
      { number: 2, kind: 'dependent', preamble: '一种煎煮设备' },
      { number: 3, kind: 'independent', preamble: '一种智能门锁' },
    ])
    expect(verdict.pairScores).toEqual([{ leftNumber: 1, rightNumber: 3, similarity: 1 }])
    expect(verdict.grade).toBe('good')
  })
})

describe('claimSimilarity: 相似度度量', () => {
  it('相同文本相似度为 1', () => {
    const text = '一种智能门锁包括锁体、指纹识别模块和控制模块'
    expect(claimSimilarity(text, text)).toBe(1)
  })

  it('不相关文本低于单一性阈值', () => {
    expect(claimSimilarity('一种太阳能发电装置包括光伏板和逆变器', '一种中药煎煮设备包括药罐和加热盘')).toBeLessThan(0.6)
  })

  it('清洗后为空则相似度为 0，单字文本无 bigram 仍可比', () => {
    expect(normalizeClaimText('一种装置，其特征在于：包括所述和或的')).toBe('装置')
    expect(claimSimilarity('一种所述包括', '所述的一种')).toBe(0)
    expect(claimSimilarity('锁', '锁')).toBeGreaterThan(0)
  })
})
