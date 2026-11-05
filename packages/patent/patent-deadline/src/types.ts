/**
 * Vocabulary of the Chinese patent deadline set: the case inputs a report is
 * computed from, the entries and report it produces, and the evaluator options.
 *
 * The fixed regulation facts — term lengths, the design transition day, the
 * notice period specifications — are not here; they are held in
 * `statutes-data.ts` beside the computation that applies them. The query,
 * validation and report assembly are in `statutes.ts`.
 * @module @deepseek-ai/dsh-patent-deadline/types
 */

import type { CalendarDate } from './calendar.ts'
import type { DeliveryRequest } from './delivery.ts'
import type { WorkCalendar } from './work-calendar.ts'

/** Patent category, which selects the applicable period lengths. */
export type PatentKind = 'invention' | 'utility-model' | 'design'

/**
 * Whether rest-day roll-forward (细则第5条) is applied to the reported end dates.
 *
 * `apply` is the statutory reading and the default. `omit` reports each period's
 * own end date with no roll-forward, for records whose subject is the period
 * itself rather than an act to perform on the last day.
 */
export type RestDayRule = 'apply' | 'omit'

/** A notice issued in the case that starts a designated or statutory period. */
export type NoticeKind =
  | 'office-action-first'
  | 'office-action-subsequent'
  | 'substantive-exam-notice'
  | 'rejection-decision'
  | 'grant-notice'
  | 'reexamination-notice'
  | 'invalidation-transfer'

/** Procedure stage that fixes a first office action's designated answer period. */
export type OfficeActionStage = 'substantive' | 'preliminary'

/** A notice together with how it was delivered. */
export type NoticeInput = {
  kind: NoticeKind
  delivery: DeliveryRequest
  /** Months the notice itself designates, overriding the usual designated length. */
  designatedMonths?: number
  /**
   * Stage in which a first office action was issued: four months in substantive
   * examination, two in preliminary examination. Defaults to substantive for an
   * invention and preliminary for a utility model or design.
   */
  stage?: OfficeActionStage
}

/** The late-payment window attached to an annual fee. */
export type LatePaymentWindow = {
  /** The fee's reported due date: the window starts on the day the payment period ended. */
  from: string
  /** Last day of the six-month surcharge window. */
  to: string
  legalBasis: string
  note: string
  /** Set when the loaded holiday arrangement does not cover the window end's year. */
  calendarCaveat?: string
}

/** Everything the deadline set is computed from. */
export type DeadlineQuery = {
  kind: PatentKind
  /** Application date; for an international application, the international filing date. */
  filingDate: CalendarDate
  /**
   * Whether the case claims priority. Supplied explicitly by the agent or the
   * human handling the case; it is never inferred from the presence of a
   * priority date, because the periods that follow the priority date must not
   * silently change with a half-filled record.
   */
  claimsPriority: boolean
  /** Earliest priority date; required when claimsPriority is true. */
  priorityDate?: CalendarDate
  /** Whether the case is a PCT application entering the Chinese national phase. */
  isPctNationalPhase?: boolean
  /**
   * Date the applicant completed the formalities for entering the Chinese
   * national phase (进入日). The PCT priority claim fee runs from this date;
   * when it is absent that entry stays pending instead of counting from the
   * international filing date.
   */
  nationalPhaseEntryDate?: CalendarDate
  /** Grant publication date (授权公告日), which fixes the granted patent year. */
  authorizationPublicationDate?: CalendarDate
  /** Date the drug obtained marketing approval in China (新药上市许可日). */
  marketingApprovalDate?: CalendarDate
  /**
   * Granted patent-term compensation in whole years (发明专利，0–5). Extends both
   * the term and the annual-fee years; a patent still awaiting a decision omits it.
   */
  termCompensationYears?: number
  /** Date the invalidation request was filed (提出无效宣告请求之日). */
  invalidationRequestDate?: CalendarDate
  /**
   * Last patent year whose annual fee is recorded as paid. Fees up to and
   * including this year are not reported; omitting it reports every fee in the
   * horizon, including historical ones.
   */
  paidThroughYear?: number
  /** Notices of this case whose delivery starts a period. */
  notices?: readonly NoticeInput[]
  /** Whether 细则第5条 roll-forward applies; defaults to `apply`. */
  restDayRule?: RestDayRule
  /** The day the report is produced; supplied by the caller so the report is reproducible. */
  today: CalendarDate
}

/** How close a deadline is, or whether it can be computed at all. */
export type DeadlineStatus = 'overdue' | 'urgent' | 'normal'

/** A deadline whose end date is known. */
export type ComputedDeadline = {
  id: string
  label: string
  legalBasis: string
  /** The period's own end date, before any rest-day roll-forward. */
  rawDueDate: string
  /**
   * The reported end date: the rolled date under `apply`, the raw date under
   * `omit`.
   */
  dueDate: string
  /** Days from `today` to the reported end date; negative once overdue. */
  daysRemaining: number
  status: DeadlineStatus
  /** Whether the rest-day rule moved the reported end date past the raw one. */
  rolledForward: boolean
  /** Set when the loaded holiday arrangement does not cover the end date's year. */
  calendarCaveat?: string
  /** The delivery or trigger rule that produced the start date. */
  triggerBasis?: string
  /** Six-month surcharge window following an annual fee's due date. */
  latePaymentWindow?: LatePaymentWindow
}

/** A deadline that cannot be computed from the supplied inputs. */
export type PendingDeadline = {
  id: string
  label: string
  legalBasis: string
  /** The input whose value is required. */
  requiredInput: string
  reason: string
}

/** The deadline report. */
export type DeadlineReport = {
  computed: ComputedDeadline[]
  pending: PendingDeadline[]
  /** The roll-forward rule the reported end dates were produced under. */
  restDayRule: RestDayRule
}

/** Default years of future annual fees a report covers when no policy overrides it. */
export const DEFAULT_ANNUITY_HORIZON_YEARS = 2

/** Options the evaluator needs beyond the case inputs. */
export type EvaluateOptions = {
  calendar: WorkCalendar
  /** Warn when an end date falls within this many days; a deployment policy. */
  reminderLeadDays: number
  /**
   * Years of future annual fees to report, counted from `today`; a deployment
   * policy. Defaults to two so the report shows the next charge and the one after.
   */
  annuityHorizonYears?: number
}

/** Thrown when the query contradicts itself, e.g. a priority date without a priority claim. */
export class DeadlineQueryError extends Error {
  /**
   * @param message - what the query contradicts.
   */
  constructor(message: string) {
    super(message)
    this.name = 'DeadlineQueryError'
  }
}

/**
 * Prefix of a {@link ComputedDeadline.calendarCaveat} whose rest-day rule could
 * not be applied, followed by the uncovered year. Consumers that render prose
 * name the year; the prefixed token itself is for machine consumers.
 */
export const UNCOVERED_YEAR_CAVEAT_PREFIX = 'calendar-uncovered-year:'
