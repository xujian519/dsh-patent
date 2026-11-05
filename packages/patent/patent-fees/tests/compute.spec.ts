import { describe, expect, it } from 'vitest'
import { computeFees, DEFAULT_FEE_POLICY } from '../src/compute.ts'
import { loadFeeTable } from '../src/fees.ts'
import type { FeeItem, FeeQuery, FeeTable, ReductionRule } from '../src/types.ts'

const POLICY = { policy: DEFAULT_FEE_POLICY }
const PERMISSIVE = { policy: { failOnUnverified: false } }

/** An item with every optional field defaulted to "not recorded". */
function item(entry: Pick<FeeItem, 'id' | 'name' | 'trigger' | 'basis'> & Partial<FeeItem>): FeeItem {
  return {
    patentTypes: null,
    amount: null,
    reducible: null,
    tiers: [],
    legalBasis: null,
    sourceDoc: null,
    effectiveFrom: null,
    verifiedOn: null,
    ...entry,
  }
}

/** A one- or many-item table over the fixture items. */
function table(items: FeeItem[], reductions: ReductionRule[] = []): FeeTable {
  return {
    document: 'fixture',
    revision: null,
    currency: 'CNY',
    sourceDoc: null,
    effectiveFrom: null,
    verifiedOn: null,
    reductions,
    items,
  }
}

/** A fully transcribed application fee that falls under fee reduction. */
const transcribed = item({
  id: 'application-fee',
  name: '申请费',
  trigger: 'filing',
  basis: 'per-case',
  amount: '900',
  reducible: true,
  sourceDoc: '公告第 1 号',
  verifiedOn: '2026-01-01',
})

const query = (overrides: Partial<FeeQuery> = {}): FeeQuery => ({
  patentType: 'invention',
  triggers: ['filing'],
  ...overrides,
})

const RATIO_85: ReductionRule = {
  kind: 'individual',
  label: '个人',
  reductionPercent: 85,
  requiresFiling: true,
  sourceDoc: null,
  effectiveFrom: null,
  verifiedOn: null,
}

describe('pricing a case', () => {
  it('reports an untranscribed amount as the item and its count, with no figure', () => {
    const report = computeFees(table([item({ id: 'application-fee', name: '申请费', trigger: 'filing', basis: 'per-case' })]), query(), POLICY)
    expect(report.currency).toBe('CNY')
    expect(report.lines).toHaveLength(1)
    expect(report.lines[0]).toMatchObject({
      id: 'application-fee',
      quantity: 1,
      quantityBasis: '每件',
      unitAmount: null,
      subtotal: null,
      payable: null,
      status: 'unrecorded',
      reduction: null,
    })
    expect(report.total).toEqual({ amount: null, complete: false, unverifiedIds: ['application-fee'] })
  })

  it('totals a fully transcribed item', () => {
    const report = computeFees(table([transcribed]), query(), POLICY)
    expect(report.lines[0]).toMatchObject({ subtotal: '900.00', payable: '900.00', status: 'verified' })
    expect(report.lines[0]?.valueSource).toEqual({ sourceDoc: '公告第 1 号', effectiveFrom: null, verifiedOn: '2026-01-01' })
    expect(report.total).toEqual({ amount: '900.00', complete: true, unverifiedIds: [] })
  })

  it('marks a recorded amount without a verification date as unverified', () => {
    const report = computeFees(table([item({ ...transcribed, verifiedOn: null })]), query(), POLICY)
    expect(report.lines[0]?.status).toBe('unverified')
    expect(report.lines[0]?.subtotal).toBe('900.00')
    expect(report.total).toEqual({ amount: null, complete: false, unverifiedIds: ['application-fee'] })
  })

  it('reports a partial sum of the verified lines only when the policy allows it', () => {
    const items = [
      transcribed,
      item({ id: 'record-copy-fee', name: '专利文件副本证明费', trigger: 'filing', basis: 'per-case', amount: '100', verifiedOn: null }),
    ]
    expect(computeFees(table(items), query(), POLICY).total).toEqual({
      amount: null,
      complete: false,
      unverifiedIds: ['record-copy-fee'],
    })
    expect(computeFees(table(items), query(), PERMISSIVE).total).toEqual({
      amount: '900.00',
      complete: false,
      unverifiedIds: ['record-copy-fee'],
    })
  })

  it('withholds a partial sum when no line is verified at all', () => {
    const unrecorded = item({ id: 'record-copy-fee', name: '专利文件副本证明费', trigger: 'filing', basis: 'per-case' })
    expect(computeFees(table([unrecorded]), query(), PERMISSIVE).total.amount).toBeNull()
  })

  it('counts claims beyond the free base', () => {
    const surcharge = item({
      id: 'claims-surcharge',
      name: '权利要求附加费',
      trigger: 'filing',
      basis: 'per-claim-beyond',
      freeUnits: 10,
      amount: '150',
      verifiedOn: '2026-01-01',
    })
    const over = computeFees(table([surcharge]), query({ claims: 12 }), POLICY)
    expect(over.lines[0]).toMatchObject({
      quantity: 2,
      quantityBasis: '权利要求 12 项 − 免费基数 10 项',
      subtotal: '300.00',
    })
    const within = computeFees(table([surcharge]), query({ claims: 8 }), POLICY)
    expect(within.lines[0]).toMatchObject({ quantity: 0, subtotal: '0.00' })
  })

  it('counts specification pages beyond the free base', () => {
    const surcharge = item({
      id: 'specification-surcharge',
      name: '说明书附加费',
      trigger: 'filing',
      basis: 'per-page-beyond',
      freeUnits: 30,
      amount: '50',
      verifiedOn: '2026-01-01',
    })
    const report = computeFees(table([surcharge]), query({ specificationPages: 33 }), POLICY)
    expect(report.lines[0]).toMatchObject({ quantity: 3, quantityBasis: '说明书 33 页 − 免费基数 30 页', subtotal: '150.00' })
  })

  it('counts priority claims and extension months', () => {
    const items = [
      item({ id: 'priority-claim-fee', name: '优先权要求费', trigger: 'filing', basis: 'per-priority', amount: '80', verifiedOn: '2026-01-01' }),
      item({ id: 'extension-fee', name: '延长期限请求费', trigger: 'extension', basis: 'per-month', amount: '200', verifiedOn: '2026-01-01' }),
    ]
    const report = computeFees(table(items), query({ triggers: ['filing', 'extension'], priorityClaims: 2, extensionMonths: 3 }), POLICY)
    expect(report.lines.map(line => [line.quantityBasis, line.subtotal])).toEqual([
      ['2 项优先权要求', '160.00'],
      ['3 个月', '600.00'],
    ])
    expect(report.total).toEqual({ amount: '760.00', complete: true, unverifiedIds: [] })
  })

  it('reports an item whose count input is missing as pending instead of guessing', () => {
    const surcharge = item({
      id: 'claims-surcharge',
      name: '权利要求附加费',
      trigger: 'filing',
      basis: 'per-claim-beyond',
      freeUnits: 10,
    })
    const report = computeFees(table([surcharge]), query(), POLICY)
    expect(report.lines).toEqual([])
    expect(report.pending).toEqual([{
      id: 'claims-surcharge',
      name: '权利要求附加费',
      requiredInput: 'claims',
      reason: '未给出权利要求总项数。',
    }])
    // An item waiting for its count is unknown, not zero: it must keep the total
    // from reading as the price of the case.
    expect(report.total).toEqual({ amount: null, complete: false, unverifiedIds: ['claims-surcharge'] })
  })

  it('keeps the total incomplete for a pending item beside verified lines', () => {
    const items = [
      transcribed,
      item({ id: 'claims-surcharge', name: '权利要求附加费', trigger: 'filing', basis: 'per-claim-beyond', freeUnits: 10, amount: '150', verifiedOn: '2026-01-01' }),
    ]
    expect(computeFees(table(items), query(), POLICY).total).toEqual({
      amount: null,
      complete: false,
      unverifiedIds: ['claims-surcharge'],
    })
    // The permissive policy may report a partial sum, still labelled incomplete.
    expect(computeFees(table(items), query(), PERMISSIVE).total).toEqual({
      amount: '900.00',
      complete: false,
      unverifiedIds: ['claims-surcharge'],
    })
  })

  it.each([
    ['specificationPages', 'per-page-beyond', '未给出说明书总页数。'],
    ['priorityClaims', 'per-priority', '未给出优先权要求项数。'],
    ['extensionMonths', 'per-month', '未给出请求延长的月数。'],
  ])('reports a missing %s as pending', (requiredInput, basis, reason) => {
    const entry = item({
      id: 'fee',
      name: '费用',
      trigger: 'filing',
      basis: basis as FeeItem['basis'],
      ...(basis === 'per-page-beyond' ? { freeUnits: 30 } : {}),
    })
    const report = computeFees(table([entry]), query(), POLICY)
    expect(report.pending).toEqual([{ id: 'fee', name: '费用', requiredInput, reason }])
  })

  it('prices each requested patent year from the tier table', () => {
    const annual = item({
      id: 'annual-fee',
      name: '年费',
      trigger: 'annual-fee',
      basis: 'per-annuity-year',
      reducible: true,
      reductionMaxYears: 6,
      tiers: [
        { fromYear: 1, toYear: 3, amount: '900' },
        { fromYear: 4, toYear: 6, amount: '1200' },
      ],
      verifiedOn: '2026-01-01',
    })
    const report = computeFees(table([annual]), query({ triggers: ['annual-fee'], annuityYears: [5, 2, 2] }), POLICY)
    expect(report.lines.map(line => [line.id, line.quantityBasis, line.subtotal])).toEqual([
      ['annual-fee-2', '第 2 年度', '900.00'],
      ['annual-fee-5', '第 5 年度', '1200.00'],
    ])
    expect(report.total).toEqual({ amount: '2100.00', complete: true, unverifiedIds: [] })
  })

  it('flags a year the transcribed tiers do not cover', () => {
    const annual = item({
      id: 'annual-fee',
      name: '年费',
      trigger: 'annual-fee',
      basis: 'per-annuity-year',
      tiers: [{ fromYear: 1, toYear: 3, amount: '900' }],
      verifiedOn: '2026-01-01',
    })
    const report = computeFees(table([annual]), query({ triggers: ['annual-fee'], annuityYears: [9] }), POLICY)
    expect(report.lines[0]?.unitAmount).toBeNull()
    expect(report.lines[0]?.notes).toEqual(['第 9 年度未落在已转录的分档内（已转录 1 档）。'])
  })

  it('falls back to a flat amount when no tiers are transcribed', () => {
    const annual = item({
      id: 'annual-fee',
      name: '年费',
      trigger: 'annual-fee',
      basis: 'per-annuity-year',
      amount: '900',
      verifiedOn: '2026-01-01',
    })
    const report = computeFees(table([annual]), query({ triggers: ['annual-fee'], annuityYears: [4] }), POLICY)
    expect(report.lines[0]).toMatchObject({ unitAmount: '900', subtotal: '900.00' })
  })

  it('asks for the patent years when the query names none', () => {
    const annual = item({ id: 'annual-fee', name: '年费', trigger: 'annual-fee', basis: 'per-annuity-year' })
    const report = computeFees(table([annual]), query({ triggers: ['annual-fee'] }), POLICY)
    expect(report.pending).toEqual([{
      id: 'annual-fee',
      name: '年费',
      requiredInput: 'annuityYears',
      reason: '未给出要计算年费的专利年度：年度序号由 patent_deadlines 的年费条目给出，本工具不自行推算。',
    }])
    expect(report.total).toEqual({ amount: null, complete: false, unverifiedIds: ['annual-fee'] })
    expect(computeFees(table([annual]), query({ triggers: ['annual-fee'], annuityYears: [] }), POLICY).pending).toHaveLength(1)
  })

  it('adds the surcharge on a late annual fee', () => {
    const annual = item({
      id: 'annual-fee',
      name: '年费',
      trigger: 'annual-fee',
      basis: 'per-annuity-year',
      amount: '900',
      verifiedOn: '2026-01-01',
      latePayment: {
        monthlyPercent: 5,
        maxMonths: 6,
        legalBasis: '专利法实施细则第115条',
        sourceDoc: '公告第 3 号',
        effectiveFrom: null,
        verifiedOn: '2026-03-01',
      },
    })
    const report = computeFees(
      table([annual]),
      query({ triggers: ['annual-fee'], annuityYears: [4], lateMonths: 3 }),
      POLICY,
    )
    expect(report.lines[1]).toMatchObject({
      id: 'annual-fee-4-late-payment',
      name: '年费滞纳金（第 4 年度）',
      quantity: 3,
      quantityBasis: '超期 3 个月，每月加收当年全额年费的 5%',
      unitAmount: '45.00',
      subtotal: '135.00',
      payable: '135.00',
      status: 'verified',
      legalBasis: '专利法实施细则第115条',
      valueSource: { sourceDoc: '公告第 3 号', effectiveFrom: null, verifiedOn: '2026-03-01' },
    })
    expect(report.total).toEqual({ amount: '1035.00', complete: true, unverifiedIds: [] })
  })

  it('refuses the surcharge once the payment window has passed', () => {
    const annual = item({
      id: 'annual-fee',
      name: '年费',
      trigger: 'annual-fee',
      basis: 'per-annuity-year',
      amount: '900',
      verifiedOn: '2026-01-01',
      latePayment: { monthlyPercent: 5, maxMonths: 6, legalBasis: null, sourceDoc: null, effectiveFrom: null, verifiedOn: null },
    })
    const report = computeFees(
      table([annual]),
      query({ triggers: ['annual-fee'], annuityYears: [4], lateMonths: 8 }),
      POLICY,
    )
    const surcharge = report.lines[1]
    expect(surcharge?.subtotal).toBeNull()
    expect(surcharge?.status).toBe('unverified')
    expect(surcharge?.notes[0]).toContain('超出 6 个月的补缴窗口')
    expect(report.total.amount).toBeNull()
  })

  it('takes the surcharge base from the year tier', () => {
    const annual = item({
      id: 'annual-fee',
      name: '年费',
      trigger: 'annual-fee',
      basis: 'per-annuity-year',
      tiers: [{ fromYear: 4, toYear: 6, amount: '1200' }],
      verifiedOn: '2026-01-01',
      latePayment: { monthlyPercent: 5, maxMonths: 6, legalBasis: null, sourceDoc: null, effectiveFrom: null, verifiedOn: '2026-01-01' },
    })
    const covered = computeFees(
      table([annual]),
      query({ triggers: ['annual-fee'], annuityYears: [5], lateMonths: 1 }),
      POLICY,
    )
    expect(covered.lines[1]).toMatchObject({ unitAmount: '60.00', subtotal: '60.00' })

    const uncovered = computeFees(
      table([annual]),
      query({ triggers: ['annual-fee'], annuityYears: [9], lateMonths: 1 }),
      POLICY,
    )
    expect(uncovered.lines[1]?.subtotal).toBeNull()
    expect(uncovered.lines[1]?.notes).toEqual([])
  })

  it('adds no surcharge without a delay', () => {
    const withRule = item({
      id: 'annual-fee',
      name: '年费',
      trigger: 'annual-fee',
      basis: 'per-annuity-year',
      amount: '900',
      verifiedOn: '2026-01-01',
      latePayment: { monthlyPercent: 5, maxMonths: 6, legalBasis: null, sourceDoc: null, effectiveFrom: null, verifiedOn: null },
    })
    const onTime = computeFees(table([withRule]), query({ triggers: ['annual-fee'], annuityYears: [4], lateMonths: 0 }), POLICY)
    expect(onTime.lines).toHaveLength(1)
    expect(onTime.total).toEqual({ amount: '900.00', complete: true, unverifiedIds: [] })
  })

  it('reports a surcharge the index has no rule for as unpriced and withholds the total', () => {
    const withoutRule = item({
      id: 'annual-fee',
      name: '年费',
      trigger: 'annual-fee',
      basis: 'per-annuity-year',
      amount: '900',
      verifiedOn: '2026-01-01',
    })
    const report = computeFees(
      table([withoutRule]),
      query({ triggers: ['annual-fee'], annuityYears: [4], lateMonths: 3 }),
      POLICY,
    )
    expect(report.lines).toHaveLength(2)
    expect(report.lines[1]).toMatchObject({
      id: 'annual-fee-4-late-payment',
      name: '年费滞纳金（第 4 年度）',
      quantity: 3,
      quantityBasis: '超期 3 个月，每月加收比例未登记',
      unitAmount: null,
      subtotal: null,
      payable: null,
      status: 'unrecorded',
      notes: ['费用索引未登记该年费条目的滞纳金规则：每月加收比例未知，本次不给滞纳金金额。'],
    })
    expect(report.total).toEqual({
      amount: null,
      complete: false,
      unverifiedIds: ['annual-fee-4-late-payment'],
    })
    // The permissive policy may state the annual fee alone, still incomplete.
    expect(computeFees(
      table([withoutRule]),
      query({ triggers: ['annual-fee'], annuityYears: [4], lateMonths: 3 }),
      PERMISSIVE,
    ).total).toEqual({
      amount: '900.00',
      complete: false,
      unverifiedIds: ['annual-fee-4-late-payment'],
    })
  })

  it('applies a reduction to the items that fall under it', () => {
    const report = computeFees(
      table([transcribed], [RATIO_85]),
      query({ reduction: { kind: 'individual', filed: true } }),
      POLICY,
    )
    expect(report.lines[0]).toMatchObject({ subtotal: '900.00', payable: '135.00', reduction: '减缴 85%' })
    expect(report.total).toEqual({ amount: '135.00', complete: true, unverifiedIds: [] })
    expect(report.reduction).toEqual({
      kind: 'individual',
      filed: true,
      reductionPercent: '85',
      applied: true,
      reason: '已按减缴 85% 计算适用费种。',
    })
  })

  it('keeps the full amount when the reduction record was not filed', () => {
    const report = computeFees(
      table([transcribed], [RATIO_85]),
      query({ reduction: { kind: 'individual', filed: false } }),
      POLICY,
    )
    expect(report.lines[0]).toMatchObject({ payable: '900.00', reduction: '未减缴（未备案）' })
    expect(report.lines[0]?.notes).toEqual(['未办理费减备案：不得按减缴计算，本项按全额计。'])
    expect(report.reduction?.reason).toBe('未办理费减备案：仅对不以此为前提的费种适用。')
    expect(report.notes).toContain('本次减缴请求未办理费减备案。')
  })

  it('does not report a missing filing for a programme that does not require one', () => {
    const report = computeFees(
      table([transcribed], [{ ...RATIO_85, requiresFiling: false }]),
      query({ reduction: { kind: 'individual', filed: false } }),
      POLICY,
    )
    expect(report.lines[0]).toMatchObject({ payable: '135.00', reduction: '减缴 85%' })
    expect(report.notes).not.toContain('本次减缴请求未办理费减备案。')
    expect(report.reduction?.reason).toBe('已按减缴 85% 计算适用费种。')
  })

  it('reports an unrecorded reduction scope rather than assuming it', () => {
    const fee = item({ id: 'application-fee', name: '申请费', trigger: 'filing', basis: 'per-case', amount: '900', verifiedOn: '2026-01-01' })
    const report = computeFees(table([fee], [{ ...RATIO_85, requiresFiling: false }]), query({ reduction: { kind: 'individual', filed: true } }), POLICY)
    expect(report.lines[0]).toMatchObject({ payable: '900.00', reduction: '未减缴（适用范围未登记）' })
    expect(report.lines[0]?.notes).toEqual(['减缴适用范围未登记：本项按全额计。'])
    expect(report.reduction?.reason).toBe('本案没有落在减缴范围内的费用项。')
  })

  it('refuses a reduced figure while the ratio is untranscribed', () => {
    const report = computeFees(
      table([item({ ...transcribed, reducible: true })], [{ ...RATIO_85, reductionPercent: null }]),
      query({ reduction: { kind: 'individual', filed: true } }),
      POLICY,
    )
    expect(report.lines[0]).toMatchObject({ payable: null, reduction: '减缴比例未转录' })
    expect(report.lines[0]?.notes).toEqual(['减缴比例未转录：无法给出减缴后金额。'])
    expect(report.reduction).toMatchObject({ reductionPercent: null, applied: false })
    expect(report.reduction?.reason).toBe('减缴比例未转录：本次不给减缴后金额。')
    expect(report.total.amount).toBeNull()
  })

  it('reports a reduction programme the index does not carry', () => {
    const report = computeFees(
      table([item({ ...transcribed, reducible: true })]),
      query({ reduction: { kind: 'enterprise', filed: true } }),
      POLICY,
    )
    expect(report.lines[0]).toMatchObject({ payable: null, reduction: '减缴未登记' })
    expect(report.notes).toContain('费用索引没有登记「enterprise」减缴：本次不按减缴计算。')
    expect(report.reduction?.reason).toBe('未登记 enterprise 减缴')
  })

  it('stops the reduction at the year cap of a year-indexed item', () => {
    const annual = item({
      id: 'annual-fee',
      name: '年费',
      trigger: 'annual-fee',
      basis: 'per-annuity-year',
      amount: '900',
      reducible: true,
      reductionMaxYears: 6,
      verifiedOn: '2026-01-01',
    })
    const report = computeFees(
      table([annual], [RATIO_85]),
      query({ triggers: ['annual-fee'], annuityYears: [7], reduction: { kind: 'individual', filed: true } }),
      POLICY,
    )
    expect(report.lines[0]).toMatchObject({ payable: '900.00', reduction: '未减缴（仅前 6 年适用）' })
    expect(report.lines[0]?.notes).toEqual(['减缴只覆盖第 6 年度及以前：本年度按全额计。'])
  })

  it('records a reduction of an untranscribed amount without inventing the figure', () => {
    const fee = item({
      id: 'application-fee',
      name: '申请费',
      trigger: 'filing',
      basis: 'per-case',
      reducible: true,
      verifiedOn: '2026-01-01',
    })
    const report = computeFees(table([fee], [RATIO_85]), query({ reduction: { kind: 'individual', filed: true } }), POLICY)
    expect(report.lines[0]).toMatchObject({ subtotal: null, payable: null, reduction: '减缴 85%', status: 'unrecorded' })
  })

  it('filters by patent type and says what it left out', () => {
    const items = [
      item({ id: 'substantive-examination-fee', name: '实质审查费', trigger: 'substantive-examination', basis: 'per-case', patentTypes: ['invention'] }),
      item({ id: 'application-fee', name: '申请费', trigger: 'filing', basis: 'per-case' }),
    ]
    const report = computeFees(
      table(items),
      query({ patentType: 'design', triggers: ['filing', 'substantive-examination'] }),
      POLICY,
    )
    expect(report.lines.map(line => line.id)).toEqual(['application-fee'])
    expect(report.notes).toEqual(['已按专利类型过滤：实质审查费 不适用本次类型，未列入本报告。'])
  })

  it('prices only the triggers the caller named', () => {
    const items = [
      item({ id: 'application-fee', name: '申请费', trigger: 'filing', basis: 'per-case' }),
      item({ id: 'reexamination-fee', name: '复审请求费', trigger: 'reexamination', basis: 'per-case' }),
    ]
    const report = computeFees(table(items), query({ triggers: ['reexamination'] }), POLICY)
    expect(report.lines.map(line => line.id)).toEqual(['reexamination-fee'])
  })

  it('withholds the total when a named trigger has no indexed item', () => {
    const report = computeFees(loadFeeTable(), query({ triggers: ['grant-registration'] }), POLICY)
    expect(report.lines).toEqual([])
    expect(report.total).toEqual({
      amount: null,
      complete: false,
      unverifiedIds: [],
      uncoveredTriggers: ['grant-registration'],
    })
    expect(report.notes.some(note => note.includes('索引未收录'))).toBe(true)
  })

  it('does not treat a trigger with items excluded by patent type as unindexed', () => {
    const report = computeFees(
      loadFeeTable(),
      query({ patentType: 'design', triggers: ['substantive-examination'] }),
      POLICY,
    )
    expect(report.lines).toEqual([])
    expect(report.total.uncoveredTriggers).toBeUndefined()
  })

  it('does not charge claims or specification surcharges to a design case', () => {
    const report = computeFees(
      loadFeeTable(),
      query({ patentType: 'design', triggers: ['filing'], claims: 15, specificationPages: 40, priorityClaims: 0 }),
      POLICY,
    )
    // The priority-claim fee applies to every type at a zero count; the claim and
    // page surcharges do not apply to a design application at all.
    expect(report.lines.map(line => line.id)).toEqual(['application-fee-utility-design', 'priority-claim-fee'])
    expect(report.lines.find(line => line.id === 'priority-claim-fee')).toMatchObject({ quantity: 0, subtotal: '0.00' })
    expect(report.total.amount).toBe('500.00')
    expect(report.notes.some(note => note.includes('权利要求附加费') && note.includes('说明书附加费'))).toBe(true)
  })

  it('does not withhold the total for an unrecorded surcharge with zero units', () => {
    const report = computeFees(
      loadFeeTable(),
      query({ triggers: ['filing'], claims: 5, specificationPages: 20, priorityClaims: 0 }),
      POLICY,
    )
    expect(report.lines.find(line => line.id === 'specification-surcharge')).toMatchObject({
      quantity: 0,
      status: 'unrecorded',
    })
    expect(report.total).toEqual({
      amount: '950.00',
      complete: true,
      unverifiedIds: [],
    })
  })

  it('prices the shipped index and withholds the total while one item has no amount', () => {
    const report = computeFees(
      loadFeeTable(),
      query({ triggers: ['filing'], claims: 15, specificationPages: 40, priorityClaims: 1 }),
      POLICY,
    )
    expect(report.lines.map(line => line.id)).toEqual([
      'application-fee',
      'publication-printing-fee',
      'claims-surcharge',
      'specification-surcharge',
      'priority-claim-fee',
    ])
    expect(report.lines.find(line => line.id === 'application-fee')).toMatchObject({
      unitAmount: '900',
      payable: '900.00',
      status: 'verified',
    })
    expect(report.lines.find(line => line.id === 'claims-surcharge')?.quantity).toBe(5)
    // The specification surcharge is the item the index records without an
    // amount: its official price has two page bands the item model cannot hold.
    expect(report.lines.find(line => line.id === 'specification-surcharge')).toMatchObject({
      unitAmount: null,
      status: 'unrecorded',
    })
    expect(report.total.amount).toBeNull()
    expect(report.total.unverifiedIds).toEqual(['specification-surcharge'])
  })
})
