/**
 * Price a case against the fee index.
 *
 * Applicability is structural and always reported: which items the case owes,
 * how many units of each, and the statutory basis. Money is not: a line carries
 * a status, and a line whose amount is not recorded contributes nothing to a
 * total. With the shipped index every amount is unrecorded, so the honest report
 * is the item checklist plus an explicit refusal to state what it costs.
 * @module @deepseek-ai/dsh-patent-fees/compute
 */

import { applyPercent, formatFen, parseYuan, sumFen } from './money.ts'
import type {
  AmountStatus,
  FeeBasis,
  FeeItem,
  FeeLine,
  FeeQuery,
  FeeReport,
  FeeTable,
  FeeTotal,
  PendingFee,
  ReductionOutcome,
  ReductionRequest,
  ReductionRule,
} from './types.ts'

/** Deployment policy of the tool. */
export type FeePolicy = {
  /**
   * Refuse to state a total while any applicable line lacks a verified payable
   * amount. A partial sum that reads as the price is the failure this exists to
   * prevent; a deployment that has transcribed every amount it relies on can
   * leave it on.
   */
  failOnUnverified: boolean
}

/** The shipped policy: no total while any applicable amount is unverified. */
export const DEFAULT_FEE_POLICY: FeePolicy = { failOnUnverified: true }

/** Options of one computation. */
export type ComputeOptions = {
  policy: FeePolicy
}

/** The reduction a case asked for, resolved against the table. */
type ReductionContext = {
  request: ReductionRequest
  rule: ReductionRule | undefined
  /** Reason the request cannot be honored, or null when it can. */
  blocked: string | null
}

/** A priced line, with its payable amount kept in 分 for the total. */
type ComputedLine = {
  line: FeeLine
  payableFen: number | null
}

/** How an item's quantity was counted, or which input it is waiting for. */
type Counted =
  | { quantity: number; quantityBasis: string }
  | { missing: PendingFee }

/**
 * Price a case.
 * @param table - the loaded fee index.
 * @param query - the case facts.
 * @param options - deployment policy for totals.
 * @returns the report: priced lines, still-unpriceable items, and the total.
 */
export function computeFees(table: FeeTable, query: FeeQuery, options: ComputeOptions): FeeReport {
  const notes: string[] = []
  const reduction = resolveReduction(table, query.reduction, notes)
  const lines: ComputedLine[] = []
  const pending: PendingFee[] = []
  const excludedByType: string[] = []

  for (const item of table.items) {
    if (!query.triggers.includes(item.trigger)) continue
    if (item.patentTypes !== null && !item.patentTypes.includes(query.patentType)) {
      excludedByType.push(item.name)
      continue
    }
    if (item.basis === 'per-annuity-year') {
      lines.push(...annuityLines(item, query, reduction))
      if (query.annuityYears === undefined || query.annuityYears.length === 0) {
        pending.push({
          id: item.id,
          name: item.name,
          requiredInput: 'annuityYears',
          reason: '未给出要计算年费的专利年度：年度序号由 patent_deadlines 的年费条目给出，本工具不自行推算。',
        })
      }
      continue
    }
    const counted = countUnits(item, item.basis, query)
    if ('missing' in counted) {
      pending.push(counted.missing)
      continue
    }
    lines.push(pricedLine(item, item.id, item.name, counted.quantity, counted.quantityBasis, item.amount, reduction))
  }

  if (excludedByType.length > 0) {
    notes.push(`已按专利类型过滤：${excludedByType.join('、')} 不适用本次类型，未列入本报告。`)
  }
  // 已点名但索引没有任何条目的阶段是未知，不是零：保留在 total 里并扣留合计。
  const indexedTriggers = new Set(table.items.map(item => item.trigger))
  const uncoveredTriggers = [...new Set(query.triggers.filter(trigger => !indexedTriggers.has(trigger)))]
  if (uncoveredTriggers.length > 0) {
    notes.push(`索引未收录以下收费阶段：${uncoveredTriggers.join('、')}；本次合计不予给出。`)
  }
  return {
    currency: table.currency,
    lines: lines.map(computed => computed.line),
    pending,
    reduction: reduction === null ? null : reductionOutcome(reduction, lines),
    total: totalOf(lines, options.policy, uncoveredTriggers, pending.map(entry => entry.id)),
    notes,
  }
}

/**
 * Count an item's units, or report the case input it needs. A year-indexed item
 * is priced by {@link annuityLines} before this runs, so its basis is not a case
 * here.
 */
function countUnits(item: FeeItem, basis: Exclude<FeeBasis, 'per-annuity-year'>, query: FeeQuery): Counted {
  const freeUnits = item.freeUnits ?? 0
  switch (basis) {
    case 'per-case':
      return { quantity: 1, quantityBasis: '每件' }
    case 'per-claim-beyond':
      if (query.claims === undefined) return { missing: missingInput(item, 'claims', '未给出权利要求总项数。') }
      return {
        quantity: Math.max(0, query.claims - freeUnits),
        quantityBasis: `权利要求 ${String(query.claims)} 项 − 免费基数 ${String(freeUnits)} 项`,
      }
    case 'per-page-beyond':
      if (query.specificationPages === undefined) {
        return { missing: missingInput(item, 'specificationPages', '未给出说明书总页数。') }
      }
      return {
        quantity: Math.max(0, query.specificationPages - freeUnits),
        quantityBasis: `说明书 ${String(query.specificationPages)} 页 − 免费基数 ${String(freeUnits)} 页`,
      }
    case 'per-priority':
      if (query.priorityClaims === undefined) {
        return { missing: missingInput(item, 'priorityClaims', '未给出优先权要求项数。') }
      }
      return { quantity: query.priorityClaims, quantityBasis: `${String(query.priorityClaims)} 项优先权要求` }
    case 'per-month':
      if (query.extensionMonths === undefined) {
        return { missing: missingInput(item, 'extensionMonths', '未给出请求延长的月数。') }
      }
      return { quantity: query.extensionMonths, quantityBasis: `${String(query.extensionMonths)} 个月` }
  }
}

/** A pending entry naming the input an item waits for. */
function missingInput(item: FeeItem, requiredInput: string, reason: string): PendingFee {
  return { id: item.id, name: item.name, requiredInput, reason }
}

/** Price one item, from the quantity already counted for it. */
function pricedLine(
  item: FeeItem,
  id: string,
  name: string,
  quantity: number,
  quantityBasis: string,
  amount: string | null,
  reduction: ReductionContext | null,
  year?: number,
): ComputedLine {
  const notes: string[] = []
  const unitFen = amountFen(amount)
  const subtotalFen = unitFen === null ? null : unitFen * quantity
  const reduced = applyReduction({
    item,
    subtotalFen,
    notes,
    reduction,
    ...(year === undefined ? {} : { year }),
  })
  return {
    line: {
      id,
      name,
      basis: item.basis,
      quantity,
      quantityBasis,
      unitAmount: amount,
      subtotal: subtotalFen === null ? null : formatFen(subtotalFen),
      payable: reduced.payableFen === null ? null : formatFen(reduced.payableFen),
      status: statusOf(amount !== null, item.verifiedOn !== null),
      reduction: reduced.label,
      legalBasis: item.legalBasis,
      valueSource: valueSourceOf(item),
      notes,
    },
    payableFen: reduced.payableFen,
  }
}

/** Price every requested patent year of an annual-fee item. */
function annuityLines(item: FeeItem, query: FeeQuery, reduction: ReductionContext | null): ComputedLine[] {
  const years = [...new Set(query.annuityYears ?? [])].sort((left, right) => left - right)
  return years.flatMap(year => [
    annuityLine(item, year, reduction),
    ...latePaymentLine(item, year, query.lateMonths),
  ])
}

/** Price one patent year's annual fee from the tier that covers it. */
function annuityLine(item: FeeItem, year: number, reduction: ReductionContext | null): ComputedLine {
  const tier = item.tiers.find(entry => year >= entry.fromYear && year <= entry.toYear)
  const line = pricedLine(
    item,
    `${item.id}-${String(year)}`,
    `${item.name}（第 ${String(year)} 年度）`,
    1,
    `第 ${String(year)} 年度`,
    tier?.amount ?? (item.tiers.length === 0 ? item.amount : null),
    reduction,
    year,
  )
  if (item.tiers.length > 0 && tier === undefined) {
    line.line.notes.push(`第 ${String(year)} 年度未落在已转录的分档内（已转录 ${String(item.tiers.length)} 档）。`)
  }
  return line
}

/** Price the surcharge on a late annual fee, when the case reports a delay. */
function latePaymentLine(item: FeeItem, year: number, lateMonths: number | undefined): ComputedLine[] {
  const rule = item.latePayment
  if (lateMonths === undefined || lateMonths <= 0) return []
  // A delay the index carries no surcharge rule for is unpriced, not free: report
  // the line without a figure so the total is withheld rather than omitting it.
  if (rule === undefined) {
    return [{
      line: {
        ...latePaymentBase(item, year, lateMonths, `超期 ${String(lateMonths)} 个月，每月加收比例未登记`),
        unitAmount: null,
        subtotal: null,
        payable: null,
        status: 'unrecorded',
        reduction: null,
        legalBasis: null,
        valueSource: valueSourceOf(item),
        notes: ['费用索引未登记该年费条目的滞纳金规则：每月加收比例未知，本次不给滞纳金金额。'],
      },
      payableFen: null,
    }]
  }
  const notes: string[] = []
  const amount = amountFen(annualFeeAmount(item, year))
  if (lateMonths > rule.maxMonths) {
    notes.push(`超期 ${String(lateMonths)} 个月已超出 ${String(rule.maxMonths)} 个月的补缴窗口：本项不再可缴，专利权自应当缴纳年费期满之日起终止。`)
  }
  const monthly = amount === null ? null : applyPercent(amount, rule.monthlyPercent)
  const withinWindow = lateMonths <= rule.maxMonths
  const surchargeFen = monthly === null || !withinWindow ? null : monthly * lateMonths
  return [{
    line: {
      ...latePaymentBase(item, year, lateMonths, `超期 ${String(lateMonths)} 个月，每月加收当年全额年费的 ${String(rule.monthlyPercent)}%`),
      unitAmount: monthly === null ? null : formatFen(monthly),
      subtotal: surchargeFen === null ? null : formatFen(surchargeFen),
      payable: surchargeFen === null ? null : formatFen(surchargeFen),
      status: statusOf(amount !== null, item.verifiedOn !== null && rule.verifiedOn !== null),
      reduction: null,
      legalBasis: rule.legalBasis,
      valueSource: {
        sourceDoc: rule.sourceDoc ?? item.sourceDoc,
        effectiveFrom: rule.effectiveFrom ?? item.effectiveFrom,
        verifiedOn: rule.verifiedOn ?? item.verifiedOn,
      },
      notes,
    },
    payableFen: surchargeFen,
  }]
}

/** The identity and count every late-payment line shares. */
function latePaymentBase(
  item: FeeItem,
  year: number,
  lateMonths: number,
  quantityBasis: string,
): Pick<FeeLine, 'id' | 'name' | 'basis' | 'quantity' | 'quantityBasis'> {
  return {
    id: `${item.id}-${String(year)}-late-payment`,
    name: `年费滞纳金（第 ${String(year)} 年度）`,
    basis: 'per-month',
    quantity: lateMonths,
    quantityBasis,
  }
}

/** The amount an annual-fee item charges for one year. */
function annualFeeAmount(item: FeeItem, year: number): string | null {
  const tier = item.tiers.find(entry => year >= entry.fromYear && year <= entry.toYear)
  if (tier !== undefined) return tier.amount
  return item.tiers.length === 0 ? item.amount : null
}

/** Apply the requested reduction to one line's subtotal. */
function applyReduction(args: {
  item: FeeItem
  subtotalFen: number | null
  notes: string[]
  reduction: ReductionContext | null
  year?: number
}): { payableFen: number | null; label: string | null } {
  const { item, subtotalFen, notes, reduction, year } = args
  if (reduction === null) return { payableFen: subtotalFen, label: null }
  const { request, rule } = reduction
  if (item.reducible === false) {
    notes.push('本项不属于费用减缴范围：按全额计。')
    return { payableFen: subtotalFen, label: '未减缴（不适用）' }
  }
  if (item.reducible !== true) {
    notes.push('减缴适用范围未登记：本项按全额计。')
    return { payableFen: subtotalFen, label: '未减缴（适用范围未登记）' }
  }
  if (year !== undefined && item.reductionMaxYears !== undefined && year > item.reductionMaxYears) {
    notes.push(`减缴只覆盖第 ${String(item.reductionMaxYears)} 年度及以前：本年度按全额计。`)
    return { payableFen: subtotalFen, label: `未减缴（仅前 ${String(item.reductionMaxYears)} 年适用）` }
  }
  if (rule === undefined) {
    notes.push('费用索引没有登记该减缴：无法给出减缴后金额。')
    return { payableFen: null, label: '减缴未登记' }
  }
  if (rule.reductionPercent === null) {
    notes.push('减缴比例未转录：无法给出减缴后金额。')
    return { payableFen: null, label: '减缴比例未转录' }
  }
  if (rule.requiresFiling && !request.filed) {
    notes.push('未办理费减备案：不得按减缴计算，本项按全额计。')
    return { payableFen: subtotalFen, label: '未减缴（未备案）' }
  }
  if (subtotalFen === null) return { payableFen: null, label: `减缴 ${String(rule.reductionPercent)}%` }
  return {
    payableFen: applyPercent(subtotalFen, 100 - rule.reductionPercent),
    label: `减缴 ${String(rule.reductionPercent)}%`,
  }
}

/** Resolve the case's reduction request against the table. */
function resolveReduction(
  table: FeeTable,
  request: ReductionRequest | undefined,
  notes: string[],
): ReductionContext | null {
  if (request === undefined) return null
  const rule = table.reductions.find(entry => entry.kind === request.kind)
  if (rule === undefined) {
    notes.push(`费用索引没有登记「${request.kind}」减缴：本次不按减缴计算。`)
  }
  if (rule !== undefined && rule.requiresFiling && !request.filed) {
    notes.push('本次减缴请求未办理费减备案。')
  }
  return { request, rule, blocked: rule === undefined ? `未登记 ${request.kind} 减缴` : null }
}

/** Summarize how the reduction request was handled. */
function reductionOutcome(reduction: ReductionContext, lines: ComputedLine[]): ReductionOutcome {
  const applied = lines.some(line => line.line.reduction?.startsWith('减缴 ') === true)
  const percent = reduction.rule?.reductionPercent
  return {
    kind: reduction.request.kind,
    filed: reduction.request.filed,
    reductionPercent: percent === undefined || percent === null ? null : String(percent),
    applied,
    reason: reductionReason(reduction, applied),
  }
}

/** State why the reduction was or was not applied. */
function reductionReason(reduction: ReductionContext, applied: boolean): string {
  if (reduction.blocked !== null) return reduction.blocked
  if (reduction.rule?.reductionPercent === null || reduction.rule?.reductionPercent === undefined) {
    return '减缴比例未转录：本次不给减缴后金额。'
  }
  if (!reduction.request.filed && reduction.rule.requiresFiling) {
    return '未办理费减备案：仅对不以此为前提的费种适用。'
  }
  return applied
    ? `已按减缴 ${String(reduction.rule.reductionPercent)}% 计算适用费种。`
    : '本案没有落在减缴范围内的费用项。'
}

/** Sum the verified payable amounts, or refuse when one is missing, an item is pending, or a named stage is unindexed. */
function totalOf(
  lines: ComputedLine[],
  policy: FeePolicy,
  uncoveredTriggers: readonly string[],
  pendingIds: readonly string[],
): FeeTotal {
  // A zero-quantity line owes nothing, so an unrecorded unit price for it cannot
  // make the case total incomplete (specification pages ≤ 30, claims ≤ 10).
  const incomplete = lines.filter(line =>
    line.line.quantity > 0 && (line.line.status !== 'verified' || line.payableFen === null))
  const verified = lines.filter((line): line is ComputedLine & { payableFen: number } =>
    line.line.status === 'verified' && line.payableFen !== null)
  const verifiedFen = sumFen(verified.map(line => line.payableFen))
  // An applicable item waiting for a case input is unpriced for the same reason an
  // unverified line is: the sum would read as the price of the case without it.
  const complete = incomplete.length === 0 && pendingIds.length === 0 && uncoveredTriggers.length === 0
  const amount = uncoveredTriggers.length > 0
    ? null
    : complete
      ? formatFen(verifiedFen)
      : policy.failOnUnverified || verified.length === 0
        ? null
        : formatFen(verifiedFen)
  return {
    amount,
    complete,
    unverifiedIds: [...incomplete.map(line => line.line.id), ...pendingIds],
    ...uncoveredTriggers.length === 0 ? {} : { uncoveredTriggers: [...uncoveredTriggers] },
  }
}

/** The amount's status: recorded and verified, recorded only, or absent. */
function statusOf(amountRecorded: boolean, verified: boolean): AmountStatus {
  if (!amountRecorded) return 'unrecorded'
  return verified ? 'verified' : 'unverified'
}

/** Copy an item's recorded source into a line. */
function valueSourceOf(item: FeeItem): FeeLine['valueSource'] {
  return { sourceDoc: item.sourceDoc, effectiveFrom: item.effectiveFrom, verifiedOn: item.verifiedOn }
}

/** Parse a nullable yuan amount into 分. */
function amountFen(amount: string | null): number | null {
  return amount === null ? null : parseYuan(amount)
}
