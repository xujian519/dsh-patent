import { describe, expect, it } from 'vitest'
import { loadFeeTable, parseFeeTable } from '../src/fees.ts'

const parse = (source: string) => parseFeeTable(source, 'test.yaml')

/** The fields every fixture item states; a case adds the ones it is about. */
const ITEM = ['id: application-fee', 'name: 申请费', 'trigger: filing']

/**
 * Build a one-item table. Item lines are indented under the sequence entry, so a
 * nested block (tiers, latePayment) is written with its own relative indent, and
 * no field is ever stated twice.
 */
function doc(itemLines: string[], topLines: string[] = []): string {
  const body = itemLines.map((line, index) => `${index === 0 ? '  - ' : '    '}${line}`).join('\n')
  const top = topLines.length === 0 ? '' : `${topLines.join('\n')}\n`
  return `document: 测试收费标准\ncurrency: CNY\n${top}items:\n${body}\n`
}

/** Reduction blocks at the table level, each block one programme. */
const reduction = (blocks: string[][]): string[] => [
  'reductions:',
  ...blocks.flatMap(block => block.map((line, index) => `${index === 0 ? '  - ' : '    '}${line}`)),
]

/** One reduction programme. */
const programme = (lines: string[]): string[][] => [lines]

describe('fee index parsing', () => {
  it('parses a complete table', () => {
    const parsed = parse(doc([
      ...ITEM,
      'patentTypes: [invention, design]',
      'basis: per-annuity-year',
      'amount: 900',
      'reducible: true',
      'reductionMaxYears: 6',
      'tiers:',
      '  - fromYear: 1',
      '    toYear: 3',
      '    amount: 900',
      '  - fromYear: 4',
      '    toYear: 6',
      '    amount: 1200',
      'latePayment:',
      '  monthlyPercent: 5',
      '  maxMonths: 6',
      '  legalBasis: 专利法实施细则第115条',
      '  sourceDoc: 公告第 3 号',
      '  effectiveFrom: 2026-01-01',
      '  verifiedOn: 2026-03-01',
      'legalBasis: 专利法实施细则第115条',
      'sourceDoc: 公告第 1 号',
      'effectiveFrom: 2026-01-01',
      'verifiedOn: 2026-03-01',
    ], [
      'revision: 2026 版',
      'sourceDoc: 公告第 1 号',
      'effectiveFrom: 2026-01-01',
      'verifiedOn: 2026-02-01',
      ...reduction(programme([
        'kind: individual',
        'label: 个人',
        'reductionPercent: 85',
        'requiresFiling: true',
        'sourceDoc: 公告第 2 号',
        'effectiveFrom: 2026-01-01',
        'verifiedOn: 2026-02-02',
      ])),
    ]))
    expect(parsed.document).toBe('测试收费标准')
    expect(parsed.revision).toBe('2026 版')
    expect(parsed.sourceDoc).toBe('公告第 1 号')
    expect(parsed.reductions).toEqual([{
      kind: 'individual',
      label: '个人',
      reductionPercent: 85,
      requiresFiling: true,
      sourceDoc: '公告第 2 号',
      effectiveFrom: '2026-01-01',
      verifiedOn: '2026-02-02',
    }])
    expect(parsed.items[0]).toMatchObject({
      id: 'application-fee',
      amount: '900',
      reducible: true,
      reductionMaxYears: 6,
      patentTypes: ['invention', 'design'],
      tiers: [{ fromYear: 1, toYear: 3, amount: '900' }, { fromYear: 4, toYear: 6, amount: '1200' }],
      latePayment: {
        monthlyPercent: 5,
        maxMonths: 6,
        legalBasis: '专利法实施细则第115条',
        sourceDoc: '公告第 3 号',
        effectiveFrom: '2026-01-01',
        verifiedOn: '2026-03-01',
      },
      legalBasis: '专利法实施细则第115条',
      effectiveFrom: '2026-01-01',
      verifiedOn: '2026-03-01',
    })
  })

  it('leaves what an asset may omit unset rather than guessed', () => {
    const parsed = parse(doc([...ITEM, 'basis: per-case']))
    expect(parsed.revision).toBeNull()
    expect(parsed.sourceDoc).toBeNull()
    expect(parsed.effectiveFrom).toBeNull()
    expect(parsed.verifiedOn).toBeNull()
    expect(parsed.reductions).toEqual([])
    expect(parsed.items[0]).toMatchObject({
      patentTypes: null,
      amount: null,
      reducible: null,
      tiers: [],
      legalBasis: null,
      sourceDoc: null,
      effectiveFrom: null,
      verifiedOn: null,
    })
    expect(parsed.items[0]?.freeUnits).toBeUndefined()
    expect(parsed.items[0]?.reductionMaxYears).toBeUndefined()
    expect(parsed.items[0]?.latePayment).toBeUndefined()
  })

  it.each([
    ['a root that is not a mapping', '- 1\n', /根节点必须是映射/],
    ['YAML that does not parse', '{', /YAML 解析失败/],
    ['a missing document', 'currency: CNY\nitems:\n  - id: a\n    name: 费\n    trigger: filing\n    basis: per-case\n', /字段 document 必须是非空字符串/],
    ['a missing currency', 'document: 收费标准\nitems:\n  - id: a\n    name: 费\n    trigger: filing\n    basis: per-case\n', /字段 currency 必须是非空字符串/],
    ['an empty revision', doc([...ITEM, 'basis: per-case'], ['revision: ""']), /字段 revision 必须是 null 或非空字符串/],
    ['a non-string sourceDoc', doc([...ITEM, 'basis: per-case'], ['sourceDoc: 7']), /字段 sourceDoc 必须是 null 或非空字符串/],
    ['a malformed effectiveFrom', doc([...ITEM, 'basis: per-case'], ['effectiveFrom: 2026/01/01']), /字段 effectiveFrom 必须是 null 或 YYYY-MM-DD/],
    ['a malformed verifiedOn', doc([...ITEM, 'basis: per-case'], ['verifiedOn: 20260101']), /字段 verifiedOn 必须是 null 或 YYYY-MM-DD/],
    ['reductions that are not a list', doc([...ITEM, 'basis: per-case'], ['reductions: 个人']), /字段 reductions 必须是数组/],
    ['a reduction that is not a mapping', doc([...ITEM, 'basis: per-case'], ['reductions:', '  - 个人']), /reductions 的每一项 必须是映射/],
    ['an unknown reduction kind', doc([...ITEM, 'basis: per-case'], reduction(programme(['kind: 机关', 'label: 机关', 'requiresFiling: false']))), /reductions.kind 必须是/],
    ['a duplicated reduction kind', doc([...ITEM, 'basis: per-case'], reduction([['kind: individual', 'label: 个人', 'requiresFiling: false'], ['kind: individual', 'label: 个人', 'requiresFiling: false']])), /reductions 重复声明了 individual/],
    ['a reduction without requiresFiling', doc([...ITEM, 'basis: per-case'], reduction(programme(['kind: individual', 'label: 个人']))), /reductions.requiresFiling 必须是布尔值/],
    ['a reduction percentage above 100', doc([...ITEM, 'basis: per-case'], reduction(programme(['kind: individual', 'label: 个人', 'reductionPercent: 101', 'requiresFiling: false']))), /reductions.individual.reductionPercent 必须是 \(0, 100\]/],
    ['a zero reduction percentage', doc([...ITEM, 'basis: per-case'], reduction(programme(['kind: enterprise', 'label: 企业', 'reductionPercent: 0', 'requiresFiling: false']))), /reductions.enterprise.reductionPercent 必须是 \(0, 100\]/],
    ['items that are not a list', 'document: 收费标准\ncurrency: CNY\nitems: 申请费\n', /字段 items 必须是非空数组/],
    ['an empty item list', 'document: 收费标准\ncurrency: CNY\nitems: []\n', /字段 items 必须是非空数组/],
    ['an item that is not a mapping', 'document: 收费标准\ncurrency: CNY\nitems:\n  - 申请费\n', /items 的每一项 必须是映射/],
    ['an item without a name', 'document: 收费标准\ncurrency: CNY\nitems:\n  - id: a\n    trigger: filing\n    basis: per-case\n', /字段 name 必须是非空字符串/],
    ['an unknown trigger', doc(['id: application-fee', 'name: 申请费', 'trigger: 缴费', 'basis: per-case']), /application-fee.trigger 必须是/],
    ['an unknown basis', doc([...ITEM, 'basis: per-year']), /application-fee.basis 必须是/],
    ['an empty patent-type list', doc([...ITEM, 'basis: per-case', 'patentTypes: []']), /patentTypes 必须是 null 或非空数组/],
    ['an unknown patent type', doc([...ITEM, 'basis: per-case', 'patentTypes: [plant]']), /patentTypes 的取值 必须是/],
    ['a duplicated patent type', doc([...ITEM, 'basis: per-case', 'patentTypes: [invention, invention]']), /patentTypes 有重复取值/],
    ['an amount that is not yuan', doc([...ITEM, 'basis: per-case', 'amount: 900 元']), /字段 amount 必须是 null 或元金额/],
    ['a non-boolean reducible', doc([...ITEM, 'basis: per-case', 'reducible: 是']), /字段 reducible 必须是 null 或布尔值/],
    ['a fractional reduction year cap', doc([...ITEM, 'basis: per-annuity-year', 'reductionMaxYears: 6.5']), /字段 reductionMaxYears 必须是正整数/],
    ['a beyond basis without freeUnits', doc([...ITEM, 'basis: per-claim-beyond']), /basis 为 per-claim-beyond 时必须给出 freeUnits/],
    ['freeUnits on a per-case basis', doc([...ITEM, 'basis: per-case', 'freeUnits: 10']), /basis 为 per-case 时不得给出 freeUnits/],
    ['a non-integer freeUnits', doc([...ITEM, 'basis: per-page-beyond', 'freeUnits: 三十']), /字段 freeUnits 必须是正整数/],
    ['reductionMaxYears outside a year basis', doc([...ITEM, 'basis: per-case', 'reductionMaxYears: 6']), /basis 为 per-case 时不得给出 reductionMaxYears/],
    ['tiers that are not a list', doc([...ITEM, 'basis: per-annuity-year', 'tiers: 一档']), /application-fee.tiers 必须是数组/],
    ['tiers on a non-year basis', doc([...ITEM, 'basis: per-case', 'tiers:', '  - fromYear: 1', '    toYear: 3', '    amount: 900']), /basis 为 per-case 时不得给出 tiers/],
    ['a tier that is not a mapping', doc([...ITEM, 'basis: per-annuity-year', 'tiers:', '  - 900']), /application-fee.tiers 的每一项 必须是映射/],
    ['a tier without a positive fromYear', doc([...ITEM, 'basis: per-annuity-year', 'tiers:', '  - fromYear: 0', '    toYear: 3', '    amount: 900']), /application-fee.tiers.fromYear 必须是正整数/],
    ['a tier whose range runs backwards', doc([...ITEM, 'basis: per-annuity-year', 'tiers:', '  - fromYear: 4', '    toYear: 3', '    amount: 900']), /toYear 不得早于 fromYear/],
    ['a tier without an amount', doc([...ITEM, 'basis: per-annuity-year', 'tiers:', '  - fromYear: 1', '    toYear: 3']), /application-fee.tiers 的 amount 必须是元金额/],
    ['overlapping tiers', doc([...ITEM, 'basis: per-annuity-year', 'tiers:', '  - fromYear: 1', '    toYear: 4', '    amount: 900', '  - fromYear: 4', '    toYear: 6', '    amount: 1200']), /tiers 的年度区间重叠/],
    ['latePayment outside a year basis', doc([...ITEM, 'basis: per-case', 'latePayment:', '  monthlyPercent: 5', '  maxMonths: 6']), /basis 为 per-case 时不得给出 latePayment/],
    ['a latePayment that is not a mapping', doc([...ITEM, 'basis: per-annuity-year', 'latePayment: 5%']), /application-fee.latePayment 必须是映射/],
    ['a latePayment without a percentage', doc([...ITEM, 'basis: per-annuity-year', 'latePayment:', '  maxMonths: 6']), /latePayment.monthlyPercent 必须是 \(0, 100\]/],
    ['a latePayment without a window', doc([...ITEM, 'basis: per-annuity-year', 'latePayment:', '  monthlyPercent: 5', '  maxMonths: 0']), /latePayment.maxMonths 必须是正整数/],
  ])('rejects %s', (_case, source, message) => {
    expect(() => parse(source)).toThrow(message)
  })

  it('rejects a duplicated item id', () => {
    const source = `document: 收费标准
currency: CNY
items:
  - id: application-fee
    name: 申请费
    trigger: filing
    basis: per-case
  - id: application-fee
    name: 公布印刷费
    trigger: filing
    basis: per-case
`
    expect(() => parse(source)).toThrow(/费用条目 id 重复：application-fee/)
  })

  it('reads a YAML number as a yuan amount', () => {
    const parsed = parse(doc([...ITEM, 'basis: per-case', 'amount: 900']))
    expect(parsed.items[0]?.amount).toBe('900')
  })

  it('reports an unreadable index file with its path', () => {
    expect(() => loadFeeTable('/nonexistent/fees.yaml')).toThrow(/费用索引不可读：\/nonexistent\/fees\.yaml/)
  })

  it('loads the packaged index and records where each amount came from', () => {
    const shipped = loadFeeTable()
    expect(shipped.document).toBe('专利和集成电路布图设计缴费服务指南（附件2 收费标准）')
    expect(shipped.currency).toBe('CNY')
    expect(shipped.items).toHaveLength(19)
    expect(shipped.revision).not.toBeNull()
    expect(shipped.sourceDoc).not.toBeNull()
    expect(shipped.verifiedOn).not.toBeNull()
    // The guide prints no effective date for the domestic table, so the field
    // stays null rather than repeating the guide's own publication date.
    expect(shipped.effectiveFrom).toBeNull()

    // An annual fee states its price as tier rows, so "price absent" means
    // neither an amount nor a tier.
    const unpriced = shipped.items
      .filter(entry => entry.amount === null && entry.tiers.length === 0)
      .map(entry => entry.id)
    expect(unpriced).toEqual(['specification-surcharge', 'extension-fee'])
    expect(shipped.items
      .filter(entry => entry.amount !== null || entry.tiers.length > 0)
      .every(entry => entry.sourceDoc !== null && entry.verifiedOn !== null)).toBe(true)
  })

  it('carries the thresholds, the surcharge rule, and the annual-fee tiers', () => {
    const shipped = loadFeeTable()
    const claims = shipped.items.find(entry => entry.id === 'claims-surcharge')
    const pages = shipped.items.find(entry => entry.id === 'specification-surcharge')
    const annual = shipped.items.find(entry => entry.id === 'annual-fee')
    expect(claims).toMatchObject({
      basis: 'per-claim-beyond',
      freeUnits: 10,
      amount: '150',
      patentTypes: ['invention', 'utility-model'],
    })
    expect(pages).toMatchObject({
      basis: 'per-page-beyond',
      freeUnits: 30,
      amount: null,
      patentTypes: ['invention', 'utility-model'],
    })
    expect(annual?.latePayment).toMatchObject({ monthlyPercent: 5, maxMonths: 6 })
    expect(shipped.items.find(entry => entry.id === 'substantive-examination-fee')?.legalBasis)
      .toContain('专利法实施细则第110条第1款第（二）项')
    expect(annual?.tiers).toEqual([
      { fromYear: 1, toYear: 3, amount: '900' },
      { fromYear: 4, toYear: 6, amount: '1200' },
      { fromYear: 7, toYear: 9, amount: '2000' },
      { fromYear: 10, toYear: 12, amount: '4000' },
      { fromYear: 13, toYear: 15, amount: '6000' },
      { fromYear: 16, toYear: 20, amount: '8000' },
    ])
    expect(annual?.reductionMaxYears).toBe(10)
  })

  it('carries the reduction ratios and keeps them gated on a filed record', () => {
    const shipped = loadFeeTable()
    expect(shipped.reductions.map(rule => rule.kind)).toEqual(['individual', 'enterprise'])
    expect(shipped.reductions.map(rule => rule.reductionPercent)).toEqual([85, 70])
    expect(shipped.reductions.every(rule => rule.requiresFiling)).toBe(true)
  })
})
