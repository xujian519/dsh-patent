/**
 * `patent_deadlines` tool: the statutory deadline set of a Chinese patent case.
 *
 * The current day comes from the injected clock rather than the tool input: a
 * model-chosen "today" would let a deadline report be produced against an
 * invented date, and every "urgent"/"overdue" verdict depends on it.
 * @module @deepseek-ai/dsh-patent-deadline/tool/patent-deadlines
 */

import { HarnessError } from '@deepseek-ai/dsh-error'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { formatCalendarDate, parseCalendarDate, type CalendarDate } from '../calendar.ts'
import type { DeliveryMode, DeliveryRequest } from '../delivery.ts'
import { renderDeadlineReport } from '../report.ts'
import {
  DeadlineQueryError,
  describePatentKind,
  evaluateDeadlines,
  type DeadlineQuery,
  type DeadlineReport,
  type EvaluateOptions,
  type NoticeInput,
  type NoticeKind,
  type OfficeActionStage,
  type PatentKind,
  type RestDayRule,
} from '../statutes.ts'
import type { WorkCalendar } from '../work-calendar.ts'

/**
 * Thrown when the tool input cannot be turned into a deadline query.
 * Extends {@link HarnessError} so the code reaches `tool/result`.
 */
export class DeadlineToolError extends HarnessError {
  /**
   * @param code - stable error code for the model and logs.
   * @param message - what is wrong with the input.
   */
  constructor(code: string, message: string) {
    super(message, code)
  }
}

/** One notice as the model supplies it. */
export type PatentDeadlinesNoticeInput = {
  kind: NoticeKind
  /** Delivery mode; omitted means electronic, which the guideline dates at the dispatch date. */
  mode?: DeliveryMode
  dispatchDate?: string
  enteredDate?: string
  actualReceiptDate?: string
  handedOverDate?: string
  publicationDate?: string
  designatedMonths?: number
  /** Stage of a first office action; defaults to substantive for an invention, preliminary otherwise. */
  stage?: OfficeActionStage
}

/** Input for the patent_deadlines tool. */
export type PatentDeadlinesInput = {
  patentType: PatentKind
  filingDate: string
  /** Whether the case claims priority; supplied explicitly rather than inferred. */
  claimsPriority: boolean
  priorityDate?: string
  isPctNationalPhase?: boolean
  /** Date the applicant completed the national-phase entry formalities (进入日). */
  nationalPhaseEntryDate?: string
  authorizationPublicationDate?: string
  marketingApprovalDate?: string
  /** Granted patent-term compensation in whole years (invention only, 0–5). */
  termCompensationYears?: number
  /** Date the invalidation request was filed (提出无效宣告请求之日). */
  invalidationRequestDate?: string
  /** Last patent year whose annual fee is recorded as paid. */
  paidThroughYear?: number
  notices?: PatentDeadlinesNoticeInput[]
  /** `apply` (default) rolls an end date off a rest day; `omit` reports the period's own end date. */
  restDayRule?: RestDayRule
}

/** Output of the patent_deadlines tool. */
export type PatentDeadlinesOutput = {
  patentType: PatentKind
  filingDate: string
  claimsPriority: boolean
  priorityDate?: string
  termCompensationYears?: number
  paidThroughYear?: number
  asOf: string
  restDayRule: RestDayRule
  computed: DeadlineReport['computed']
  pending: DeadlineReport['pending']
}

/** Injected collaborators (tests fix the clock and the calendar). */
export type PatentDeadlinesToolOptions = {
  calendar: WorkCalendar
  /** Warn when an end date falls within this many days. */
  reminderLeadDays: number
  /** Years of future annual fees to report; defaults to two. */
  annuityHorizonYears?: number
  /** Zone used to read the current day; defaults to Asia/Shanghai. */
  timeZone?: string
  /** Current-day source; overrides the zone-derived clock. */
  now?: () => CalendarDate
}

const DESCRIPTION = [
  '- Computes the Chinese patent statutory and designated deadlines of one case: priority window and its restoration, priority-claim addition/correction, application fee, substantive-examination request, voluntary amendment, registration and divisional filing, patent term, annual fees with the six-month surcharge window, PCT national-phase entry, the invalidation period for adding grounds or evidence, reexamination, office-action and invalidation responses, and term-compensation requests.',
  '- Counts periods from the delivery date. Under 专利法实施细则第4条 as revised and the 2023 审查指南, electronic delivery is the day the document enters the electronic system, presumed to be the dispatch date, so a designated period runs from the dispatch date with no 15-day extension; postal delivery is the evidenced receipt date or 15 days after dispatch, direct delivery is the hand-over day, and service by announcement is one month after publication.',
  '- Applies 专利法实施细则第5条 by default: the start day is not counted, a month/year period ends on the corresponding day (or the last day of a month that has none), and an end date on a holiday or moved rest day rolls to the next working day. Set restDayRule to "omit" for the un-rolled criterion, which reports each period\'s own end date; both dates are always returned, with rawDueDate holding the un-rolled one.',
  '- Counts the substantive-examination request from the priority date when the case claims priority, and from the filing date otherwise. Whether the case claims priority is an explicit input, not something inferred from a priority date.',
  '- Counts a PCT application fee, publication printing fee, and any surcharge as part of the national-phase entry formalities within the 30-month entry period from the priority date (32 months with the grace fee). The separate two-month period from nationalPhaseEntryDate belongs to the priority claim fee and stays pending until that date is supplied.',
  '- Counts a first office-action response from its delivery with the stage\'s designated period: four months in substantive examination and two months in preliminary examination. A notice records stage as "substantive" or "preliminary"; an invention defaults to substantive and a utility model or design to preliminary.',
  '- Deadlines that start at a notice\'s delivery (grant, rejection, office-action, reexamination, invalidation) are reported as pending with the exact missing input until that notice\'s delivery record is supplied or completed; they are never approximated from the filing date.',
  '',
  'Usage notes:',
  '  - Dates are YYYY-MM-DD. Supply the notices the case actually received, with how each was delivered.',
  '  - Read-only and offline; makes no network request.',
  '  - Results are decision support, not a filing instruction: verify against the notice and the current 审查指南 before acting.',
].join('\n')

const DATE = { type: 'string', description: 'Date as YYYY-MM-DD' } as const

/** Zone of the patent office's calendar; "today" is read in this zone. */
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai'

const COMPUTED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    label: { type: 'string', required: true },
    legalBasis: { type: 'string', required: true },
    rawDueDate: { type: 'string', required: true },
    dueDate: { type: 'string', required: true },
    daysRemaining: { type: 'number', required: true },
    status: { type: 'string', required: true, enum: ['overdue', 'urgent', 'normal'] },
    rolledForward: { type: 'boolean', required: true },
    calendarCaveat: { type: 'string' },
    triggerBasis: { type: 'string' },
    latePaymentWindow: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from: { type: 'string', required: true },
        to: { type: 'string', required: true },
        legalBasis: { type: 'string', required: true },
        note: { type: 'string', required: true },
        calendarCaveat: { type: 'string' },
      },
    },
  },
} as const

const PENDING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    label: { type: 'string', required: true },
    legalBasis: { type: 'string', required: true },
    requiredInput: { type: 'string', required: true },
    reason: { type: 'string', required: true },
  },
} as const

const NOTICE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: {
      type: 'string',
      required: true,
      enum: [
        'office-action-first',
        'office-action-subsequent',
        'substantive-exam-notice',
        'rejection-decision',
        'grant-notice',
        'reexamination-notice',
        'invalidation-transfer',
      ],
      description: 'Which document was delivered',
    },
    mode: {
      type: 'string',
      enum: ['electronic', 'postal', 'personal', 'publication'],
      description: 'How it was delivered; omitted means electronic (dispatch date is the delivery date)',
    },
    dispatchDate: { ...DATE, description: 'Dispatch date on the notice (electronic/postal)' },
    enteredDate: { ...DATE, description: 'Day it entered the electronic system, when evidenced later than dispatch' },
    actualReceiptDate: { ...DATE, description: 'Actual receipt date, when evidenced' },
    handedOverDate: { ...DATE, description: 'Hand-over date for direct delivery' },
    publicationDate: { ...DATE, description: 'Announcement date for service by publication' },
    designatedMonths: {
      type: 'number',
      description: 'Months the notice itself designates; only for office-action-first, office-action-subsequent, reexamination-notice, and invalidation-transfer',
    },
    stage: {
      type: 'string',
      enum: ['substantive', 'preliminary'],
      description: 'Stage of a first office action: substantive (4 months) or preliminary (2 months); defaults by patent category',
    },
  },
} as const

/**
 * Build the `patent_deadlines` tool.
 * @param options - work calendar, reminder policy, and clock injection.
 * @returns a registry-ready tool definition.
 */
export function createPatentDeadlinesTool(options: PatentDeadlinesToolOptions): ToolDefinition {
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE
  // An unusable zone fails when the tool is built, not on the first call.
  new Intl.DateTimeFormat('en-CA', { timeZone })
  const now = options.now ?? (() => localToday(timeZone))
  const evaluateOptions: EvaluateOptions = {
    calendar: options.calendar,
    reminderLeadDays: options.reminderLeadDays,
    ...(options.annuityHorizonYears !== undefined
      ? { annuityHorizonYears: options.annuityHorizonYears }
      : {}),
  }
  return defineTool({
    name: 'patent_deadlines',
    description: DESCRIPTION,
    parameters: {
      patentType: {
        type: 'string',
        required: true,
        enum: ['invention', 'utility-model', 'design'],
        description: 'Patent category',
      },
      filingDate: { ...DATE, required: true, description: 'Application date (international filing date for a PCT case)' },
      claimsPriority: {
        type: 'boolean',
        required: true,
        description: 'Whether the case claims priority, as stated by the agent or the human handling the case',
      },
      priorityDate: { ...DATE, description: 'Earliest priority date; required when claimsPriority is true' },
      isPctNationalPhase: { type: 'boolean', description: 'Whether the case is a PCT application entering the Chinese national phase' },
      nationalPhaseEntryDate: {
        ...DATE,
        description: 'Date the PCT national-phase entry formalities were completed (进入日); the priority claim fee runs from it',
      },
      authorizationPublicationDate: { ...DATE, description: 'Grant publication date (授权公告日)' },
      marketingApprovalDate: { ...DATE, description: 'Date the drug obtained marketing approval in China (invention only)' },
      termCompensationYears: {
        type: 'number',
        description: 'Granted patent-term compensation in whole years (invention only, 0-5); extends the term and its annual fees',
      },
      invalidationRequestDate: { ...DATE, description: 'Date the invalidation request was filed; starts the 1-month period for adding grounds or evidence' },
      paidThroughYear: {
        type: 'number',
        description: 'Last patent year whose annual fee is recorded as paid; fees through that year are omitted from the report',
      },
      notices: { type: 'array', items: NOTICE_SCHEMA, description: 'Notices received, with their delivery' },
      restDayRule: {
        type: 'string',
        enum: ['apply', 'omit'],
        description: 'apply (default) rolls an end date off a rest day; omit reports the period\'s own end date',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          patentType: { type: 'string', required: true, enum: ['invention', 'utility-model', 'design'] },
          filingDate: { type: 'string', required: true },
          claimsPriority: { type: 'boolean', required: true },
          priorityDate: { type: 'string' },
          termCompensationYears: { type: 'number' },
          paidThroughYear: { type: 'number' },
          asOf: { type: 'string', required: true },
          restDayRule: { type: 'string', required: true, enum: ['apply', 'omit'] },
          computed: { type: 'array', required: true, items: COMPUTED_SCHEMA },
          pending: { type: 'array', required: true, items: PENDING_SCHEMA },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderDeadlineReport(
          { computed: value.computed, pending: value.pending, restDayRule: value.restDayRule },
          {
            kind: value.patentType,
            filingDate: value.filingDate,
            today: value.asOf,
            claimsPriority: value.claimsPriority,
            ...(value.priorityDate !== undefined ? { priorityDate: value.priorityDate } : {}),
            ...(value.paidThroughYear !== undefined ? { paidThroughYear: value.paidThroughYear } : {}),
          },
        ),
      }],
    },
    execute(args) {
      const asOf = now()
      const query = toQuery(args, asOf)
      const report = evaluateOrThrow(query, evaluateOptions)
      // The deadline set is pure date arithmetic, so the result is already settled.
      return Promise.resolve({
        patentType: query.kind,
        filingDate: formatCalendarDate(query.filingDate),
        claimsPriority: query.claimsPriority,
        ...(query.priorityDate !== undefined ? { priorityDate: formatCalendarDate(query.priorityDate) } : {}),
        ...(query.termCompensationYears !== undefined
          ? { termCompensationYears: query.termCompensationYears }
          : {}),
        ...(query.paidThroughYear !== undefined ? { paidThroughYear: query.paidThroughYear } : {}),
        asOf: formatCalendarDate(asOf),
        restDayRule: report.restDayRule,
        computed: report.computed,
        pending: report.pending,
      })
    },
  })
}

/**
 * Evaluate a query, translating a contradictory query into the tool's stable error.
 * @param query - the case inputs.
 * @param options - calendar and horizon policy.
 * @returns the evaluated report.
 * @throws DeadlineToolError when the query contradicts itself.
 */
function evaluateOrThrow(query: DeadlineQuery, options: EvaluateOptions): DeadlineReport {
  try {
    return evaluateDeadlines(query, options)
  } catch (error) {
    if (error instanceof DeadlineQueryError) {
      throw new DeadlineToolError('invalid_query', error.message)
    }
    throw error
  }
}

/**
 * Turn validated tool arguments into a deadline query.
 * @param args - the tool arguments.
 * @param today - the current day from the injected clock.
 * @returns the query.
 * @throws DeadlineToolError when a date or a designated period is malformed.
 */
function toQuery(args: PatentDeadlinesInput, today: CalendarDate): DeadlineQuery {
  return {
    kind: args.patentType,
    filingDate: parseDate(args.filingDate, 'filingDate'),
    claimsPriority: args.claimsPriority,
    today,
    ...(args.priorityDate !== undefined ? { priorityDate: parseDate(args.priorityDate, 'priorityDate') } : {}),
    ...(args.isPctNationalPhase !== undefined ? { isPctNationalPhase: args.isPctNationalPhase } : {}),
    ...(args.nationalPhaseEntryDate !== undefined
      ? { nationalPhaseEntryDate: parseDate(args.nationalPhaseEntryDate, 'nationalPhaseEntryDate') }
      : {}),
    ...(args.authorizationPublicationDate !== undefined
      ? { authorizationPublicationDate: parseDate(args.authorizationPublicationDate, 'authorizationPublicationDate') }
      : {}),
    ...(args.marketingApprovalDate !== undefined
      ? { marketingApprovalDate: parseDate(args.marketingApprovalDate, 'marketingApprovalDate') }
      : {}),
    ...(args.termCompensationYears !== undefined
      ? { termCompensationYears: args.termCompensationYears }
      : {}),
    ...(args.invalidationRequestDate !== undefined
      ? { invalidationRequestDate: parseDate(args.invalidationRequestDate, 'invalidationRequestDate') }
      : {}),
    ...(args.paidThroughYear !== undefined ? { paidThroughYear: args.paidThroughYear } : {}),
    ...(args.notices !== undefined ? { notices: args.notices.map(toNotice) } : {}),
    ...(args.restDayRule !== undefined ? { restDayRule: args.restDayRule } : {}),
  }
}

/**
 * Convert one notice argument; the date its delivery mode needs is checked when
 * the delivery date is resolved.
 * @param notice - the notice argument.
 * @returns the notice input.
 */
function toNotice(notice: PatentDeadlinesNoticeInput): NoticeInput {
  if (notice.designatedMonths !== undefined
    && (!Number.isInteger(notice.designatedMonths) || notice.designatedMonths <= 0)) {
    throw new DeadlineToolError(
      'invalid_designated_months',
      `${notice.kind}.designatedMonths 必须为正整数: ${String(notice.designatedMonths)}`,
    )
  }
  const delivery: DeliveryRequest = {
    ...(notice.mode !== undefined ? { mode: notice.mode } : {}),
    ...(notice.dispatchDate !== undefined ? { dispatchDate: parseDate(notice.dispatchDate, `${notice.kind}.dispatchDate`) } : {}),
    ...(notice.enteredDate !== undefined ? { enteredDate: parseDate(notice.enteredDate, `${notice.kind}.enteredDate`) } : {}),
    ...(notice.actualReceiptDate !== undefined
      ? { actualReceiptDate: parseDate(notice.actualReceiptDate, `${notice.kind}.actualReceiptDate`) }
      : {}),
    ...(notice.handedOverDate !== undefined
      ? { handedOverDate: parseDate(notice.handedOverDate, `${notice.kind}.handedOverDate`) }
      : {}),
    ...(notice.publicationDate !== undefined
      ? { publicationDate: parseDate(notice.publicationDate, `${notice.kind}.publicationDate`) }
      : {}),
  }
  return {
    kind: notice.kind,
    delivery,
    ...(notice.designatedMonths !== undefined ? { designatedMonths: notice.designatedMonths } : {}),
    ...(notice.stage !== undefined ? { stage: notice.stage } : {}),
  }
}

/**
 * Parse a required date argument, attributing a bad value to its field.
 * @param value - the date string.
 * @param field - field name for the error message.
 * @returns the parsed date.
 */
function parseDate(value: string, field: string): CalendarDate {
  try {
    return parseCalendarDate(value)
  } catch (error) {
    throw new DeadlineToolError('invalid_date', `${field}: ${String(error)}`)
  }
}

/**
 * The calendar day in the patent office's zone. The host may run in another
 * zone, where its local date would differ from the date the office is using.
 * @param timeZone - IANA zone name.
 * @returns today's date in that zone.
 */
function localToday(timeZone: string): CalendarDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const byType = new Map(parts.map(part => [part.type, part.value]))
  return { year: Number(byType.get('year')), month: Number(byType.get('month')), day: Number(byType.get('day')) }
}

/** Patent-kind label for reports, re-exported for consumers. */
export { describePatentKind }
