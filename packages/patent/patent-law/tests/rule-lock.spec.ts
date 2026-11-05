import { describe, expect, it } from 'vitest'
import {
  lockProvisions,
  renderRuleLockReport,
  ruleLockAtom,
  RuleLockHandler,
  DEFAULT_RULE_LOCK_PROVISIONS_KEY,
  DEFAULT_RULE_LOCK_AS_OF_KEY,
  type RuleLockEntry,
} from '../src/rule-lock.ts'
import { testBaselines } from './fixtures.ts'
import { lawLineageFile } from '../src/asset-location.ts'
import { loadLawBaselines } from '../src/baseline.ts'
import { loadLawLineageFile } from '../src/lineage.ts'
import type { LawLineageSnapshot } from '../src/types.ts'

const handler = new RuleLockHandler(testBaselines())

describe('rule-lock atom declaration', () => {
  it('声明正确的名称、分类与输入输出键', () => {
    expect(ruleLockAtom.name).toBe('rule-lock')
    expect(ruleLockAtom.category).toBe('gate')
    expect(ruleLockAtom.inputSchema).toContain(DEFAULT_RULE_LOCK_PROVISIONS_KEY)
    expect(ruleLockAtom.inputSchema).toContain(DEFAULT_RULE_LOCK_AS_OF_KEY)
    expect(ruleLockAtom.outputSchema).toEqual([
      'rule_lock_report',
      'rule_lock_locked',
      'rule_lock_unverified',
    ])
  })

  it('handler 与 atom 名称一致', () => {
    expect(handler.name).toBe(ruleLockAtom.name)
    expect(handler.category).toBe(ruleLockAtom.category)
  })
})

describe('lockProvisions — 单条法条判定', () => {
  it('active：已验证的法条返回 active', () => {
    const result = lockProvisions(['专利法第22条第3款'], testBaselines())
    expect(result.locked).toHaveLength(1)
    const entry = result.locked[0]!
    expect(entry.validityStatus).toBe('active')
    expect(entry.stale).toBe(false)
    expect(entry.level).toBe('section')
    expect(entry.effectiveDate).toBe('2026-01-01')
    expect(result.unverified).toEqual([])
  })

  it('revised：staleSection 覆盖的指南节返回 revised', () => {
    const result = lockProvisions(['审查指南第二部分第四章3.2.1.1'], testBaselines())
    expect(result.locked).toHaveLength(1)
    const entry = result.locked[0]!
    expect(entry.validityStatus).toBe('revised')
    expect(entry.stale).toBe(true)
    expect(entry.level).toBe('section')
    expect(result.unverified).toEqual([])
  })

  it('unverified：超出索引范围的法条返回 unverified', () => {
    const result = lockProvisions(['专利法第99条'], testBaselines())
    expect(result.locked).toHaveLength(1)
    const entry = result.locked[0]!
    expect(entry.validityStatus).toBe('unverified')
    expect(entry.stale).toBe(false)
    expect(result.unverified).toEqual(['专利法第99条'])
  })

  it('unverified：无法解析的引用文本返回 unverified', () => {
    const result = lockProvisions(['这不是一个法条引用'], testBaselines())
    expect(result.locked).toHaveLength(1)
    expect(result.locked[0]!.validityStatus).toBe('unverified')
    expect(result.unverified).toEqual(['这不是一个法条引用'])
  })

  it('unverified：未转录核验的条文返回 unverified', () => {
    const result = lockProvisions(['专利法实施细则第5条'], testBaselines())
    expect(result.locked).toHaveLength(1)
    expect(result.locked[0]!.validityStatus).toBe('unverified')
    expect(result.unverified).toEqual(['专利法实施细则第5条'])
  })

  it('unverified：引用了条文未载明的款号时不再判现行有效', () => {
    const result = lockProvisions(['专利法第22条第9款'], testBaselines())
    expect(result.locked).toHaveLength(1)
    expect(result.locked[0]!.validityStatus).toBe('unverified')
    expect(result.locked[0]!.level).toBe('section')
    expect(result.unverified).toEqual(['专利法第22条第9款'])
  })
})

describe('lockProvisions — 粒度级别推断', () => {
  it('article：仅引用条时 level 为 article', () => {
    const result = lockProvisions(['专利法第22条'], testBaselines())
    expect(result.locked[0]!.level).toBe('article')
  })

  it('section：引用到款时 level 为 section', () => {
    const result = lockProvisions(['专利法第22条第3款'], testBaselines())
    expect(result.locked[0]!.level).toBe('section')
  })

  it('clause：引用到项时 level 为 clause', () => {
    const result = lockProvisions(['专利法第22条第3款第1项'], testBaselines())
    expect(result.locked[0]!.level).toBe('clause')
  })

  it('section：指南节引用时 level 为 section', () => {
    const result = lockProvisions(['审查指南第二部分第四章3.2'], testBaselines())
    expect(result.locked[0]!.level).toBe('section')
  })
})

describe('lockProvisions — 多条法条批量判定', () => {
  it('混合状态：部分 active、部分 revised、部分 unverified', () => {
    const result = lockProvisions(
      ['专利法第22条第3款', '审查指南第二部分第四章3.2.1.1', '专利法第99条'],
      testBaselines(),
    )
    expect(result.locked).toHaveLength(3)
    expect(result.locked[0]!.validityStatus).toBe('active')
    expect(result.locked[1]!.validityStatus).toBe('revised')
    expect(result.locked[2]!.validityStatus).toBe('unverified')
    expect(result.unverified).toEqual(['专利法第99条'])
  })

  it('全部 active 时 unverified 为空', () => {
    const result = lockProvisions(
      ['专利法第22条', '专利法第22条第2款'],
      testBaselines(),
    )
    expect(result.locked).toHaveLength(2)
    expect(result.locked.every(e => e.validityStatus === 'active')).toBe(true)
    expect(result.unverified).toEqual([])
  })

  it('全部 unverified 时 locked 条目标记 unverified', () => {
    const result = lockProvisions(
      ['专利法第99条', '无法解析的文本'],
      testBaselines(),
    )
    expect(result.locked).toHaveLength(2)
    expect(result.locked.every(e => e.validityStatus === 'unverified')).toBe(true)
    expect(result.unverified).toHaveLength(2)
  })
})

describe('lockProvisions — asOf 时间点判定', () => {
  it('传入 asOf 不影响当前索引的判定结果（预留扩展）', () => {
    const withoutAsOf = lockProvisions(['专利法第22条第3款'], testBaselines())
    const withAsOf = lockProvisions(['专利法第22条第3款'], testBaselines(), '2025-06-01')
    expect(withoutAsOf.locked[0]!.validityStatus).toBe(withAsOf.locked[0]!.validityStatus)
    expect(withAsOf.locked[0]!.provision).toBe('专利法第22条第3款')
  })
})

describe('renderRuleLockReport', () => {
  it('空列表报告未提供', () => {
    const report = renderRuleLockReport({ locked: [], unverified: [] })
    expect(report).toContain('未提供法条引用列表')
  })

  it('包含统计摘要与逐条结果', () => {
    const output = lockProvisions(
      ['专利法第22条第3款', '审查指南第二部分第四章3.2.1.1', '专利法第99条'],
      testBaselines(),
    )
    const report = renderRuleLockReport(output)
    expect(report).toContain('共 3 条')
    expect(report).toContain('现行有效 1')
    expect(report).toContain('已修订 1')
    expect(report).toContain('未判定 1')
    expect(report).toContain('专利法第22条第3款')
    expect(report).toContain('现行有效')
    expect(report).toContain('审查指南第二部分第四章3.2.1.1')
    expect(report).toContain('已修订')
    expect(report).toContain('未判定法条')
    expect(report).toContain('限制说明')
  })

  it('全部 active 时不显示未判定法条段', () => {
    const output = lockProvisions(['专利法第22条'], testBaselines())
    const report = renderRuleLockReport(output)
    expect(report).not.toContain('未判定法条')
  })
})

describe('RuleLockHandler.execute', () => {
  it('空 provisions → 报告未提供', async () => {
    const out = await handler.execute({ state: {} })
    expect(out.rule_lock_report).toContain('未提供')
    expect(out.rule_lock_locked).toEqual([])
    expect(out.rule_lock_unverified).toEqual([])
  })

  it('从 state 数组读取 provisions 并逐条判定', async () => {
    const out = await handler.execute({
      state: {
        rule_lock_provisions: ['专利法第22条第3款', '专利法第99条'],
      },
    })
    const locked = out.rule_lock_locked as RuleLockEntry[]
    expect(locked).toHaveLength(2)
    expect(locked[0]!.validityStatus).toBe('active')
    expect(locked[1]!.validityStatus).toBe('unverified')
    expect(out.rule_lock_unverified).toEqual(['专利法第99条'])
  })

  it('从 JSON 字符串读取 provisions', async () => {
    const out = await handler.execute({
      state: {
        rule_lock_provisions: JSON.stringify(['专利法第22条']),
      },
    })
    const locked = out.rule_lock_locked as RuleLockEntry[]
    expect(locked).toHaveLength(1)
    expect(locked[0]!.validityStatus).toBe('active')
  })

  it('非法 JSON 字符串 → 降级报告', async () => {
    const out = await handler.execute({
      state: {
        rule_lock_provisions: 'not-json',
      },
    })
    expect(out.rule_lock_report).toContain('不可读')
    expect(out.rule_lock_locked).toEqual([])
  })

  it('读取 rule_lock_as_of 作为判定时间点', async () => {
    const out = await handler.execute({
      state: {
        rule_lock_provisions: ['专利法第22条第3款'],
        rule_lock_as_of: '2025-06-01',
      },
    })
    const locked = out.rule_lock_locked as RuleLockEntry[]
    expect(locked).toHaveLength(1)
    expect(locked[0]!.validityStatus).toBe('active')
  })

  it('过滤非字符串元素', async () => {
    const out = await handler.execute({
      state: {
        rule_lock_provisions: ['专利法第22条', 42, null, '', '专利法第99条'],
      },
    })
    const locked = out.rule_lock_locked as RuleLockEntry[]
    expect(locked).toHaveLength(2)
    expect(locked[0]!.provision).toBe('专利法第22条')
    expect(locked[1]!.provision).toBe('专利法第99条')
  })

  it('空数组元素 → 报告空列表', async () => {
    const out = await handler.execute({
      state: {
        rule_lock_provisions: [],
      },
    })
    expect(out.rule_lock_report).toContain('未提供')
  })
})

describe('沿革快照接入', () => {
  it('量产资产：生效日期取最近一次修订，而不是转录核验日期', () => {
    const result = lockProvisions(
      ['专利法第22条'],
      loadLawBaselines(),
      undefined,
      loadLawLineageFile(lawLineageFile()),
    )
    expect(result.locked[0]).toMatchObject({
      validityStatus: 'active',
      stale: false,
      effectiveDate: '2021-06-01',
    })
  })

  it('沿革记录为 repealed 时锁定结果标记 stale', () => {
    const lineage: LawLineageSnapshot = {
      law: '专利法',
      document: '中华人民共和国专利法',
      lineageVersion: '1.0.0',
      revisions: [],
      articles: [{ articleId: 22, title: null, currentStatus: 'repealed', revisionHistory: [] }],
    }
    const result = lockProvisions(['专利法第22条'], testBaselines(), undefined, lineage)
    expect(result.locked[0]).toMatchObject({ validityStatus: 'repealed', stale: true })
  })
})
