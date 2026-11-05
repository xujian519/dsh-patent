/**
 * The Chinese patent statutory and designated deadline set: the query layer.
 *
 * This module validates a case's inputs, indexes its notices, delegates the
 * period computation to `deadline-entries.ts`, and assembles the report. The
 * fixed regulation facts the computation reads are in `statutes-data.ts`; the
 * vocabulary of the inputs and report is in `types.ts`.
 *
 * The periods are an external specification (专利法, 专利法实施细则, 专利审查指南),
 * not a deployment preference, so each one lives in code beside its article. What
 * a deployment may vary — how far ahead to warn — is a validated configuration
 * field, not a period.
 *
 * Every entry is either computed from dates the caller supplied or reported as
 * pending together with the exact input still missing. A period that depends on
 * delivery of a notice is never guessed from the filing date: the grant,
 * rejection, and office-action periods start at delivery, so the report names
 * the missing notice instead of substituting a fixed number of years.
 * @module @deepseek-ai/dsh-patent-deadline/statutes
 */

import { compareCalendarDates } from './calendar.ts'
import { buildDeadlineItems, termYearCap, type DeadlineItem } from './deadline-entries.ts'
import {
  MAX_TERM_COMPENSATION_YEARS,
  REPEATABLE_NOTICE_KINDS,
} from './statutes-data.ts'
import {
  DeadlineQueryError,
  type ComputedDeadline,
  type DeadlineQuery,
  type DeadlineReport,
  type EvaluateOptions,
  type NoticeInput,
  type NoticeKind,
  type PendingDeadline,
  type PatentKind,
} from './types.ts'

// The vocabulary is re-exported here so this module keeps the import surface it
// had when it declared these names; `types.ts` owns their definitions.
export * from './types.ts'

/**
 * Evaluate the deadline set for one case.
 * @param query - case dates, notices, and the report date.
 * @param options - work calendar and reminder policy.
 * @returns computed deadlines (chronological) and deadlines still needing inputs.
 * @throws DeadlineQueryError when the inputs contradict each other or do not apply to the kind.
 */
export function evaluateDeadlines(query: DeadlineQuery, options: EvaluateOptions): DeadlineReport {
  assertQuery(query)
  const items = buildDeadlineItems(query, options, indexNotices(query.notices ?? []))
  return assemble(items, query)
}

/**
 * Reject a query whose inputs contradict themselves: priority inputs, dates out
 * of order, or a field that does not apply to the patent category. Each would
 * otherwise produce a period counted from the wrong date or for the wrong kind.
 * @param query - the case inputs.
 */
function assertQuery(query: DeadlineQuery): void {
  assertPriorityInputs(query)
  if (query.authorizationPublicationDate !== undefined
    && compareCalendarDates(query.authorizationPublicationDate, query.filingDate) < 0) {
    throw new DeadlineQueryError(
      '授权公告日早于申请日：授权公告不可能发生在申请之前，请核对两项日期。',
    )
  }
  if (query.isPctNationalPhase === true && query.kind === 'design') {
    throw new DeadlineQueryError(
      '外观设计不能通过 PCT 进入中国国家阶段：请将 isPctNationalPhase 设为 false 或更正专利类型。',
    )
  }
  if (query.isPctNationalPhase !== true && query.nationalPhaseEntryDate !== undefined) {
    throw new DeadlineQueryError(
      'nationalPhaseEntryDate 只适用于 PCT 进入中国国家阶段案件：'
      + '请将 isPctNationalPhase 设为 true，或删除该日期。',
    )
  }
  if (query.nationalPhaseEntryDate !== undefined
    && compareCalendarDates(query.nationalPhaseEntryDate, query.filingDate) < 0) {
    throw new DeadlineQueryError(
      '进入中国国家阶段之日在申请日之前：进入日不可能早于国际申请日，请核对两项日期。',
    )
  }
  if (query.invalidationRequestDate !== undefined
    && compareCalendarDates(query.invalidationRequestDate, query.filingDate) < 0) {
    throw new DeadlineQueryError(
      '提出无效宣告请求之日在申请日之前：请核对 invalidationRequestDate 与申请日。',
    )
  }
  if (query.marketingApprovalDate !== undefined
    && compareCalendarDates(query.marketingApprovalDate, query.filingDate) < 0) {
    throw new DeadlineQueryError(
      '新药上市许可日在申请日之前：请核对 marketingApprovalDate 与申请日。',
    )
  }
  for (const notice of query.notices ?? []) {
    if (notice.stage === undefined) continue
    if (notice.kind !== 'office-action-first') {
      throw new DeadlineQueryError(
        `stage 只适用于第一次审查意见通知书（office-action-first），不能用于 ${notice.kind}。`,
      )
    }
    if (notice.stage === 'substantive' && query.kind !== 'invention') {
      throw new DeadlineQueryError(
        '实质审查阶段的第一次审查意见答复只适用于发明专利：'
        + '请将 stage 设为 preliminary，或更正专利类型。',
      )
    }
  }
  if (query.kind !== 'invention') {
    if (query.marketingApprovalDate !== undefined) {
      throw new DeadlineQueryError(
        '新药相关专利权期限补偿只适用于发明专利：请删除 marketingApprovalDate 或更正专利类型。',
      )
    }
    if ((query.termCompensationYears ?? 0) !== 0) {
      throw new DeadlineQueryError(
        '专利权期限补偿只适用于发明专利：请删除 termCompensationYears 或更正专利类型。',
      )
    }
  }
  if (query.termCompensationYears !== undefined
    && (!Number.isInteger(query.termCompensationYears)
      || query.termCompensationYears < 0
      || query.termCompensationYears > MAX_TERM_COMPENSATION_YEARS)) {
    throw new DeadlineQueryError(
      `termCompensationYears 必须是 0 至 ${String(MAX_TERM_COMPENSATION_YEARS)} 的整数年: ${String(query.termCompensationYears)}`,
    )
  }
  if (query.paidThroughYear !== undefined) {
    if (!Number.isInteger(query.paidThroughYear) || query.paidThroughYear < 0) {
      throw new DeadlineQueryError(
        `paidThroughYear 必须是 0 或正整数专利年度: ${String(query.paidThroughYear)}`,
      )
    }
    const cap = termYearCap(query)
    if (query.paidThroughYear > cap) {
      const hint = query.kind === 'invention'
        ? '如已获期限补偿，请同时提供 termCompensationYears。'
        : ''
      throw new DeadlineQueryError(
        `paidThroughYear 超出专利权期限（${String(cap)} 年）: ${String(query.paidThroughYear)}。${hint}`,
      )
    }
  }
}

/**
 * Reject priority inputs that contradict each other or run out of order: a
 * claim with no date, a date with no claim, or a priority date that is not
 * before the filing date. Each would otherwise pick a start date silently.
 * @param query - the case inputs.
 */
function assertPriorityInputs(query: DeadlineQuery): void {
  if (query.priorityDate !== undefined
    && compareCalendarDates(query.priorityDate, query.filingDate) >= 0) {
    throw new DeadlineQueryError(
      '优先权日必须在申请日之前（不能是同一天或更晚）：请核对两项日期。',
    )
  }
  if (query.claimsPriority && query.priorityDate === undefined) {
    throw new DeadlineQueryError(
      '已声明本案主张优先权（claimsPriority: true），但未提供优先权日（priorityDate）：'
      + '实审请求等期限自优先权日起算，缺该日期无法计算。',
    )
  }
  if (!query.claimsPriority && query.priorityDate !== undefined) {
    throw new DeadlineQueryError(
      '本案声明不主张优先权（claimsPriority: false），却提供了优先权日（priorityDate）：'
      + '两者矛盾，请按案卷事实改其一。',
    )
  }
}

/**
 * Index the supplied notices by kind, keeping every record of a repeatable kind.
 * @param supplied - the notices the caller recorded on the case.
 * @returns the notices per kind, oldest first as supplied.
 * @throws DeadlineQueryError when a kind that a case receives once is supplied twice.
 */
function indexNotices(supplied: readonly NoticeInput[]): ReadonlyMap<NoticeKind, readonly NoticeInput[]> {
  const byKind = new Map<NoticeKind, NoticeInput[]>()
  for (const notice of supplied) {
    const list = byKind.get(notice.kind)
    if (list === undefined) {
      byKind.set(notice.kind, [notice])
      continue
    }
    if (!REPEATABLE_NOTICE_KINDS.has(notice.kind)) {
      throw new DeadlineQueryError(
        `通知书记录重复：${notice.kind} 在一个案子里只有一份，收到两份记录时无法确定以哪一份为准。`
        + '请核对通知书，或把多份记录合并为实际送达情形后的那一份。',
      )
    }
    list.push(notice)
  }
  return byKind
}

/**
 * Split entries into computed and pending, sorting computed ones chronologically
 * and pending ones by id.
 * @param items - the built entries.
 * @param query - the case inputs, whose roll-forward rule the report records.
 * @returns the report.
 */
function assemble(items: readonly DeadlineItem[], query: DeadlineQuery): DeadlineReport {
  const computed = items.filter((item): item is ComputedDeadline => 'dueDate' in item)
  const uncomputed = items.filter((item): item is PendingDeadline => !('dueDate' in item))
  computed.sort((left, right) => left.dueDate.localeCompare(right.dueDate) || left.id.localeCompare(right.id))
  uncomputed.sort((left, right) => left.id.localeCompare(right.id))
  return { computed, pending: uncomputed, restDayRule: query.restDayRule ?? 'apply' }
}

/**
 * Human label for a patent kind, used in reports.
 * @param kind - the patent category.
 * @returns the Chinese label.
 */
export function describePatentKind(kind: PatentKind): string {
  switch (kind) {
    case 'invention': return '发明专利'
    case 'utility-model': return '实用新型专利'
    case 'design': return '外观设计专利'
  }
}
