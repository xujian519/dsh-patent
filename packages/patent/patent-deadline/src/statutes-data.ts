/**
 * The fixed regulation facts of the deadline set: the patent term of 专利法第42条,
 * the 2020 amendment's transition day, the period a notice's delivery starts,
 * and the notice kinds a case may receive more than once.
 *
 * These values are an external specification, not deployment preferences, so
 * each one is stated here beside the article or notice it is transcribed from.
 * Only the deployment-varying horizons (warning lead time, annuity horizon) live
 * in the validated configuration. The computations that apply these facts are
 * in `deadline-entries.ts`; the query, validation and assembly are in
 * `statutes.ts`.
 * @module @deepseek-ai/dsh-patent-deadline/statutes-data
 */

import { compareCalendarDates, type CalendarDate } from './calendar.ts'
import type { NoticeKind, OfficeActionStage, PatentKind } from './types.ts'

/**
 * Day the 2020 amendment to 专利法 took effect. A design filed before this day
 * keeps the 10-year term of the earlier 专利法第42条; one filed on or after it
 * has the 15-year term. The filing date, not the grant date, selects the term.
 * 2021-06-01 之前申请的外观设计仍按十年，不适用现行第42条第1款的十五年。
 */
const DESIGN_TERM_TRANSITION: CalendarDate = { year: 2021, month: 6, day: 1 }

/**
 * Maximum granted patent-term compensation in whole years.
 * 专利法第42条第3款把「补偿期限不超过五年」写在新药相关发明专利上。
 * 本引擎不计算补偿长度，只拒绝超过五年的已授予年数。
 * 新药批准上市后总有效专利权期限不超过十四年，不在本计算中。
 */
export const MAX_TERM_COMPENSATION_YEARS = 5

/**
 * Notice kinds a case may receive more than once, each starting its own period.
 *
 * A case commonly receives several 后续审查意见通知书, and a reexamination may produce
 * more than one 复审通知书; each is a separate starting event, so the report carries one
 * entry per notice. Every other kind is issued once in a case, and a second record is a
 * data error that would silently hide the first — it is rejected instead.
 */
export const REPEATABLE_NOTICE_KINDS: ReadonlySet<NoticeKind> = new Set<NoticeKind>([
  'office-action-subsequent',
  'reexamination-notice',
])

/**
 * The statutory term in years for a case, before any granted compensation: 20
 * for an invention, 10 for a utility model, and 10 or 15 for a design depending
 * on whether it was filed before the 2021 amendment took effect (专利法第42条).
 * @param kind - the patent category.
 * @param filingDate - the filing date, which selects a design's term.
 * @returns the statutory term in years.
 */
export function statutoryTermYears(kind: PatentKind, filingDate: CalendarDate): number {
  switch (kind) {
    case 'invention': return 20
    case 'utility-model': return 10
    case 'design':
      return compareCalendarDates(filingDate, DESIGN_TERM_TRANSITION) < 0 ? 10 : 15
  }
}

/** One notice-driven period: the report carries an entry per recorded notice of the kind. */
export type NoticePeriodSpec = {
  id: string
  label: string
  legalBasis: string
  noticeKind: NoticeKind
  /** Why the entry is pending when the case has not recorded that notice. */
  absentReason: string
  /** Months from delivery when the notice itself designates none. */
  months: number
  /**
   * Variants for a period whose designated length depends on the procedure
   * stage. A notice without `stage` uses substantive examination for an
   * invention and preliminary examination for a utility model or design.
   */
  stageVariants?: Partial<Record<OfficeActionStage, { label: string; months: number }>>
}

/**
 * The periods that start at a notice's delivery, each beside its article and
 * the kind that starts it. Nothing else starts them, so a case that has not
 * recorded the notice reports a pending entry naming it.
 */
export const NOTICE_PERIOD_SPECS: readonly NoticePeriodSpec[] = [
  {
    id: 'reexamination-request',
    label: '请求复审（自收到驳回决定之日起3个月）',
    legalBasis: '专利法第41条第1款',
    noticeKind: 'rejection-decision',
    absentReason: '需要驳回决定的送达记录，本查询未提供该通知。',
    months: 3,
  },
  {
    id: 'oa-response-first',
    label: '答复第一次审查意见通知书（指定期限，实质审查程序中为4个月）',
    legalBasis: '专利审查指南第五部分第七章第2.1节',
    noticeKind: 'office-action-first',
    absentReason: '需要第一次审查意见通知书的送达记录，本查询未提供该通知。',
    months: 4,
    stageVariants: {
      substantive: {
        label: '答复第一次审查意见通知书（指定期限，实质审查程序中为4个月）',
        months: 4,
      },
      preliminary: {
        label: '答复第一次审查意见通知书（指定期限，初步审查程序中为2个月）',
        months: 2,
      },
    },
  },
  {
    id: 'oa-response-subsequent',
    label: '答复后续审查意见通知书（指定期限一般为2个月，以通知书指定为准）',
    legalBasis: '专利审查指南第五部分第七章第2.1节',
    noticeKind: 'office-action-subsequent',
    absentReason: '需要后续审查意见通知书的送达记录，本查询未提供该通知。',
    months: 2,
  },
  {
    id: 'reexamination-deficiency-response',
    label: '答复复审通知书（指定期限通常为1个月，以通知书指定为准）',
    legalBasis: '专利法实施细则第67条',
    noticeKind: 'reexamination-notice',
    absentReason: '需要复审通知书的送达记录，本查询未提供该通知。',
    months: 1,
  },
  {
    id: 'invalidation-response',
    label: '答复无效宣告请求（合议组指定期限，通常为1个月）',
    legalBasis: '专利法实施细则第72条、专利审查指南第四部分第三章第4.4.1节',
    noticeKind: 'invalidation-transfer',
    absentReason: '需要无效宣告请求书转送文件的送达记录，本查询未提供该通知。',
    months: 1,
  },
]
