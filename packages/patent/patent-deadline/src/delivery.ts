/**
 * Delivery-date determination under 专利法实施细则第四条 and the 2023 审查指南
 * transition recorded in its 修改解读（八）.
 *
 * Delivery is the trigger for every designated period and for the grant and
 * rejection periods, so the date is derived explicitly and reported with the
 * rule it came from. Under the current rule the period is counted from the
 * dispatch date: the 2023 revision made the day a document enters the
 * addressee's electronic system the delivery date, the guideline revision moved
 * the start of designated and some statutory periods from the presumed receipt
 * date to the delivery date, and the guideline presumes the dispatch date to be
 * that delivery date. Electronic delivery therefore carries no 15-day
 * extension; the 15-day presumption applies to postal delivery only.
 * 细则第4条第1款、第2款的递交日不在本引擎推算：申请日由调用方给出。
 * 第3款的送达对象（代理机构或联系人）不产生日期。
 * @module @deepseek-ai/dsh-patent-deadline/delivery
 */

import type { CalendarDate } from './calendar.ts'
import { addCalendarDays } from './calendar.ts'
import { periodEnd } from './period.ts'

/** How the patent administration delivered a document. */
export type DeliveryMode = 'electronic' | 'postal' | 'personal' | 'publication'

/** A delivery record with the mode resolved; which fields it needs depends on that mode. */
export type DeliveryInput = {
  mode: DeliveryMode
  /** Dispatch date on the notice (电子送达 and 邮寄). */
  dispatchDate?: CalendarDate
  /** Day the document entered the addressee's electronic system, when evidenced. */
  enteredDate?: CalendarDate
  /** Actual receipt date, when the addressee can evidence it. */
  actualReceiptDate?: CalendarDate
  /** Hand-over date for a document served by direct delivery (直接送交). */
  handedOverDate?: CalendarDate
  /** Publication date for service by public announcement (公告送达). */
  publicationDate?: CalendarDate
}

/** A caller-supplied delivery record; the mode may be left out. */
export type DeliveryRequest = Omit<DeliveryInput, 'mode'> & { mode?: DeliveryMode }

/** A resolved delivery date and the rule that produced it. */
export type DeliveryDate = {
  date: CalendarDate
  /** The rule applied, for traceability in the report. */
  basis: string
}

/** Thrown when a delivery record omits the field its mode requires. */
export class DeliveryInputError extends Error {
  /**
   * @param message - which field is missing.
   */
  constructor(message: string) {
    super(message)
    this.name = 'DeliveryInputError'
  }
}

/**
 * Resolve the delivery mode of a record: the supplied mode, otherwise
 * electronic. The patent administration serves its notices electronically by
 * default, and the guideline presumes that service's delivery date to be the
 * dispatch date, so an omitted mode yields the dispatch-date rule.
 * @param request - the delivery record.
 * @returns the delivery mode to apply.
 */
export function resolveDeliveryMode(request: DeliveryRequest): DeliveryMode {
  return request.mode ?? 'electronic'
}

/**
 * Resolve the delivery date of a notice.
 *
 * - `electronic`: the day it entered the addressee's electronic system; absent
 *   evidence, the guideline presumes the dispatch date, so the period is
 *   counted from the dispatch date with no 15-day extension.
 * - `postal`: the evidenced actual receipt date, otherwise 15 days after
 *   dispatch (细则第4条第4款); the presumed date is not rolled for rest days.
 * - `personal`: the hand-over date.
 * - `publication`: one month after the announcement date.
 * @param request - the delivery record.
 * @returns the delivery date and its basis.
 */
export function resolveDeliveryDate(request: DeliveryRequest): DeliveryDate {
  switch (resolveDeliveryMode(request)) {
    case 'electronic': {
      const date = request.enteredDate ?? request.dispatchDate
      if (date === undefined) {
        throw new DeliveryInputError('电子送达需要发文日（dispatchDate）或电子系统进入日（enteredDate）。')
      }
      return {
        date,
        basis: request.enteredDate !== undefined
          ? '专利法实施细则第四条：以进入当事人认可的电子系统的日期为送达日'
          : '专利法实施细则第四条 + 专利审查指南第五部分第六章2.3.1：电子送达以发文日为送达日，期限自发文日起算（不再加15日）',
      }
    }
    case 'postal': {
      if (request.actualReceiptDate !== undefined) {
        return {
          date: request.actualReceiptDate,
          basis: '专利法实施细则第四条：当事人举证证明实际收到日期的，以实际收到日为准',
        }
      }
      if (request.dispatchDate === undefined) {
        throw new DeliveryInputError('邮寄送达需要发文日（dispatchDate）或实际收到日（actualReceiptDate）。')
      }
      return {
        date: addCalendarDays(request.dispatchDate, 15),
        basis: '专利法实施细则第四条：邮寄文件自发出之日起满15日推定为收到日（推定收到日遇休假日不顺延）',
      }
    }
    case 'personal': {
      if (request.handedOverDate === undefined) {
        throw new DeliveryInputError('直接送交需要交付日（handedOverDate）。')
      }
      return { date: request.handedOverDate, basis: '专利法实施细则第四条：直接送交的文件以交付日为送达日' }
    }
    case 'publication': {
      if (request.publicationDate === undefined) {
        throw new DeliveryInputError('公告送达需要公告日（publicationDate）。')
      }
      return {
        date: periodEnd(request.publicationDate, { unit: 'month', count: 1 }),
        basis: '专利法实施细则第四条：公告送达自公告之日起满1个月视为已经送达',
      }
    }
  }
}
