/**
 * The entry computation of the deadline set: one builder per family of periods,
 * each beside the article it comes from, plus the primitives that turn a start
 * date and a period into a reported entry.
 *
 * The fixed regulation tables this module reads — the notice period
 * specifications, the repeatable notice kinds, and the term table — live in
 * `statutes-data.ts`. The query validation, notice indexing and report assembly
 * live in `statutes.ts`.
 * @module @deepseek-ai/dsh-patent-deadline/deadline-entries
 */

import {
  addCalendarMonths,
  compareCalendarDates,
  daysBetween,
  formatCalendarDate,
  type CalendarDate,
} from './calendar.ts'
import {
  DeliveryInputError,
  resolveDeliveryDate,
  type DeliveryDate,
} from './delivery.ts'
import { periodEnd, type Period } from './period.ts'
import { WorkCalendarCoverageError } from './work-calendar.ts'
import { NOTICE_PERIOD_SPECS, statutoryTermYears, type NoticePeriodSpec } from './statutes-data.ts'
import {
  DEFAULT_ANNUITY_HORIZON_YEARS,
  UNCOVERED_YEAR_CAVEAT_PREFIX,
  type ComputedDeadline,
  type DeadlineQuery,
  type DeadlineStatus,
  type EvaluateOptions,
  type LatePaymentWindow,
  type NoticeInput,
  type NoticeKind,
  type PendingDeadline,
} from './types.ts'

/** A deadline definition: either a computed entry or a statement of what is missing. */
export type DeadlineItem = ComputedDeadline | PendingDeadline

/** The query and evaluator options every entry of one report shares. */
type EntryContext = {
  query: DeadlineQuery
  options: EvaluateOptions
}

/** The identity and legal citation every reported entry carries. */
type EntrySpec = {
  id: string
  label: string
  legalBasis: string
  /** The delivery or trigger rule that produced the start date. */
  triggerBasis?: string
}

/** An entry's identity and citation together with the evaluation it belongs to. */
type EntryBase = EntrySpec & EntryContext

/** The registration step and the divisional filing it bounds, both starting at the grant notice's delivery. */
const REGISTRATION_ENTRIES = [
  {
    id: 'registration',
    label: '办理登记手续并缴纳授权当年年费（自收到授权通知之日起2个月）',
    pendingLabel: '办理登记手续并缴纳授权当年年费',
    legalBasis: '专利法实施细则第60条第1款、第114条',
  },
  {
    id: 'divisional-application',
    label: '提出分案申请（须在办理登记手续期限届满前）',
    pendingLabel: '提出分案申请（须在办理登记手续期限届满前）',
    legalBasis: '专利法实施细则第48条、第60条第1款',
  },
] as const

/**
 * Build every entry of the deadline set for one case.
 * @param query - case dates, notices, and the report date.
 * @param options - work calendar and reminder policy.
 * @param notices - the case's notices indexed by kind.
 * @returns the entries before chronological sorting and splitting.
 */
export function buildDeadlineItems(
  query: DeadlineQuery,
  options: EvaluateOptions,
  notices: ReadonlyMap<NoticeKind, readonly NoticeInput[]>,
): DeadlineItem[] {
  const ctx: EntryContext = { query, options }
  return [
    ...priorityItems(ctx),
    ...applicationFeeItems(ctx),
    ...substantiveExamRequestItems(ctx),
    ...voluntaryAmendmentItems(ctx, notices),
    ...registrationItems(ctx, notices),
    ...patentTermItems(ctx),
    ...annualFeeItems(ctx),
    ...pctNationalEntryItems(ctx),
    ...pctPriorityFeeItems(ctx),
    ...invalidationRequestItems(ctx),
    ...noticeDrivenItems(ctx, notices),
    ...termCompensationItems(ctx),
  ]
}

/**
 * Build the priority family: the window for a later application on the same
 * subject, the restoration request that follows it, and — when the case claims
 * priority — the request to add or correct the claim.
 * @param ctx - the case inputs and evaluator options.
 * @returns the priority entries.
 */
function priorityItems(ctx: EntryContext): DeadlineItem[] {
  const filing = ctx.query.filingDate
  const priority = ctx.query.priorityDate
  const items: DeadlineItem[] = []

  // ── 专利法第29条 — the window for a later application on the same subject.
  const priorityMonths = ctx.query.kind === 'design' ? 6 : 12
  items.push(periodEntry(ctx, {
    id: 'priority-window',
    label: `优先权期限（可就相同主题提出后续申请并主张优先权，${String(priorityMonths)}个月自本申请日起算）`,
    legalBasis: ctx.query.kind === 'design' ? '专利法第29条第2款' : '专利法第29条第1款',
  }, filing, { unit: 'month', count: priorityMonths }))

  // ── 细则第36条 — restoration is limited to an invention or utility model.
  if (ctx.query.kind !== 'design') {
    items.push(periodEntry(ctx, {
      id: 'priority-restoration',
      label: '请求恢复优先权（有正当理由且在优先权期限届满后2个月内）',
      legalBasis: '专利法实施细则第36条',
    }, periodEnd(filing, { unit: 'month', count: priorityMonths }), { unit: 'month', count: 2 }))
  }

  // ── 细则第37条 — add or correct a priority claim; it presupposes a priority
  // claim and, like restoration, applies only to an invention or utility model.
  if (ctx.query.kind !== 'design' && ctx.query.claimsPriority && priority !== undefined) {
    const fromPriority = periodEnd(priority, { unit: 'month', count: 16 })
    const fromFiling = periodEnd(filing, { unit: 'month', count: 4 })
    items.push(dateEntry(ctx, {
      id: 'priority-addition-or-correction',
      label: '请求增加或改正优先权要求（自优先权日起16个月与自申请日起4个月，以较晚届满者为准）',
      legalBasis: '专利法实施细则第37条',
    }, compareCalendarDates(fromPriority, fromFiling) >= 0 ? fromPriority : fromFiling))
  }

  return items
}

/**
 * Build the application-fee entry: from the filing date for a domestic
 * application, or bounded by the national-phase entry deadline for a PCT
 * application, where the fee is paid while completing entry.
 * @param ctx - the case inputs and evaluator options.
 * @returns the fee entry.
 */
function applicationFeeItems(ctx: EntryContext): DeadlineItem[] {
  const filing = ctx.query.filingDate

  // ── 细则第112条 — application fee; a priority claim adds its fee to the same payment.
  const priorityFee = ctx.query.claimsPriority ? '及优先权要求费' : ''

  // ── 细则第121条第1款第(二)项 — a PCT applicant pays the application fee and
  // publication printing fee while completing the national-phase entry
  // formalities, whose deadline 细则第120条 fixes at 30 months from the priority
  // date (32 with the grace fee). The two-month period from the entry date
  // belongs to the priority claim fee (细则第127条), reported separately.
  if (ctx.query.isPctNationalPhase === true) {
    const base = ctx.query.priorityDate ?? filing
    const baseLabel = ctx.query.priorityDate !== undefined ? '优先权日' : '国际申请日（未主张优先权）'
    return [periodEntry(ctx, {
      id: 'application-fee',
      label: '在办理进入中国国家阶段手续时缴纳申请费、公布印刷费、必要的申请附加费'
        + `（自${baseLabel}起30个月内办理进入手续；缴纳宽限费后可延至32个月）`,
      legalBasis: '专利法实施细则第121条、第120条',
    }, base, { unit: 'month', count: 30 })]
  }

  return [periodEntry(ctx, {
    id: 'application-fee',
    label: `缴纳申请费、公布印刷费、必要的申请附加费${priorityFee}（或自收到受理通知书之日起15日内）`,
    legalBasis: '专利法实施细则第112条',
  }, filing, { unit: 'month', count: 2 })]
}

/**
 * Build the substantive-examination request, which only an invention runs and
 * which counts from the priority date when the case claims one.
 * @param ctx - the case inputs and evaluator options.
 * @returns the request entry, or none for a utility model or a design.
 */
function substantiveExamRequestItems(ctx: EntryContext): DeadlineItem[] {
  const filing = ctx.query.filingDate
  const priority = ctx.query.priorityDate

  // ── 专利法第35条 — substantive examination request, counted from the priority date
  // when the case claims priority (the start date the office uses in practice).
  if (ctx.query.kind !== 'invention') return []
  const start = ctx.query.claimsPriority && priority !== undefined ? priority : filing
  const startLabel = start === filing ? '申请日' : '优先权日'
  return [periodEntry(ctx, {
    id: 'substantive-exam-request',
    label: `请求实质审查并缴纳审查费（自${startLabel}起3年）`,
    legalBasis: '专利法第35条',
  }, start, { unit: 'year', count: 3 })]
}

/**
 * Build the voluntary-amendment window. Both arms of the kind branch stay here:
 * an invention amends at the examination-request notice, a utility model or a
 * design within two months of the filing date.
 * @param ctx - the case inputs and evaluator options.
 * @param notices - the notices recorded on the case, by kind.
 * @returns the amendment entry, or a pending entry when the invention's notice is missing.
 */
function voluntaryAmendmentItems(
  ctx: EntryContext,
  notices: ReadonlyMap<NoticeKind, readonly NoticeInput[]>,
): DeadlineItem[] {
  // ── 细则第57条 — voluntary amendment windows.
  if (ctx.query.kind === 'invention') {
    return fromNotices({
      id: 'voluntary-amendment-invention',
      label: '主动修改（发明：提出实质审查请求时，或收到进入实质审查阶段通知书之日起3个月内）',
      legalBasis: '专利法实施细则第57条第1款',
      noticeKind: 'substantive-exam-notice',
      absentReason: '需要“进入实质审查阶段通知书”的送达记录，本查询未提供该通知。',
      months: 3,
      notices,
      ctx,
    })
  }
  return [periodEntry(ctx, {
    id: 'voluntary-amendment-utility-design',
    label: '主动修改（自申请日起2个月内）',
    legalBasis: '专利法实施细则第57条第2款',
  }, ctx.query.filingDate, { unit: 'month', count: 2 })]
}

/**
 * Build the registration and divisional-filing periods, both of which start at
 * the grant notice's delivery and therefore stay pending until the case records it.
 * @param ctx - the case inputs and evaluator options.
 * @param notices - the notices recorded on the case, by kind.
 * @returns the two entries, computed or pending.
 */
function registrationItems(
  ctx: EntryContext,
  notices: ReadonlyMap<NoticeKind, readonly NoticeInput[]>,
): DeadlineItem[] {
  // ── 细则第60条第1款 + 第48条 — registration, which also bounds divisional filing.
  // A case is granted once, so duplicates of this kind are rejected in indexNotices;
  // the first record is the only one.
  // 细则第114条 puts the granted year's annuity in the registration step; 印花税 is not
  // a fee the current schedule charges.
  const grantNotice = notices.get('grant-notice')?.[0]
  if (grantNotice === undefined) {
    return registrationPending({
      requiredInput: 'grant-notice（授权通知的送达记录）',
      registrationReason: '该期限自收到授予专利权通知之日起算；未记录该通知送达日即无法计算，不以申请日起算的固定年数替代。',
      divisionalReason: '分案申请须在办理登记手续期限届满前提出，该期限自收到授权通知之日起算。',
    })
  }

  let grant: DeliveryDate
  try {
    grant = resolveDeliveryDate(grantNotice.delivery)
  } catch (error) {
    /* v8 ignore next -- resolveDeliveryDate throws only DeliveryInputError */
    if (!(error instanceof DeliveryInputError)) throw error
    const requiredInput = `grant-notice.delivery（${error.message}）`
    const reason = '授权通知已记录，但送达记录尚缺上述字段；补齐后即可计算，不以其他日期猜测送达日。'
    return registrationPending({
      requiredInput,
      registrationReason: reason,
      divisionalReason: `分案申请须在办理登记手续期限届满前提出；${reason}`,
    })
  }

  return REGISTRATION_ENTRIES.map(entry => periodEntry(ctx, {
    id: entry.id,
    label: entry.label,
    legalBasis: entry.legalBasis,
    triggerBasis: grant.basis,
  }, grant.date, { unit: 'month', count: 2 }))
}

/**
 * Build the registration and divisional entries that still need the grant
 * notice or a complete delivery record.
 * @param args - the input still required and the reason stated for each entry.
 * @returns both pending entries.
 */
function registrationPending(args: {
  requiredInput: string
  registrationReason: string
  divisionalReason: string
}): PendingDeadline[] {
  return REGISTRATION_ENTRIES.map(entry => ({
    id: entry.id,
    label: entry.pendingLabel,
    legalBasis: entry.legalBasis,
    requiredInput: args.requiredInput,
    reason: entry.id === 'divisional-application' ? args.divisionalReason : args.registrationReason,
  }))
}

/**
 * Build the patent-term expiry, always counted from the filing date.
 * @param ctx - the case inputs and evaluator options.
 * @returns the term entry.
 */
function patentTermItems(ctx: EntryContext): DeadlineItem[] {
  const baseYears = statutoryTermYears(ctx.query.kind, ctx.query.filingDate)
  const compensation = ctx.query.termCompensationYears ?? 0
  const label = compensation === 0
    ? `专利权期限届满（${String(baseYears)}年，自申请日起算）`
    : `专利权期限届满（${String(baseYears)}年+期限补偿${String(compensation)}年，自申请日起算）`

  // ── 专利法第42条第1款 — patent term, always counted from the filing date.
  return [periodEntry(ctx, {
    id: 'patent-term',
    label,
    legalBasis: '专利法第42条第1款',
  }, ctx.query.filingDate, { unit: 'year', count: baseYears + compensation })]
}

/**
 * The last patent year of the term, including granted compensation.
 * @param query - the case inputs.
 * @returns the term length in years.
 */
export function termYearCap(query: DeadlineQuery): number {
  return statutoryTermYears(query.kind, query.filingDate) + (query.termCompensationYears ?? 0)
}

/**
 * Build the annual-fee entries after the granted year (细则第115条), each carrying its
 * six-month surcharge window.
 * @param ctx - the case inputs and evaluator options.
 * @returns the fee entries, or a pending entry when the granted year is unknown.
 */
function annualFeeItems(ctx: EntryContext): DeadlineItem[] {
  const query = ctx.query
  const filing = query.filingDate
  const grant = query.authorizationPublicationDate
  if (grant === undefined) {
    return [{
      id: 'annual-fee',
      label: '缴纳授予专利权当年以后各年度的年费',
      legalBasis: '专利法实施细则第115条、第114条',
      requiredInput: 'authorizationPublicationDate（授权公告日）',
      reason:
        '费用年度取决于授予专利权当年的专利年度：授权当年年费在办理登记手续时缴纳，'
        + '以后年度年费在上一年度期满前缴纳。未提供授权公告日即无法确定年度序号。',
    }]
  }
  const grantedYear = patentYearOf(filing, grant)
  const items: DeadlineItem[] = []
  const horizonYears = ctx.options.annuityHorizonYears ?? DEFAULT_ANNUITY_HORIZON_YEARS
  const horizon = periodEnd(query.today, { unit: 'year', count: horizonYears })
  // A patent year is one year of term; no annual fee exists past the last one.
  // Granted term compensation extends both the term and its fee years.
  const lastFeeYear = termYearCap(query)
  const lastYear = Math.min(
    lastFeeYear,
    Math.max(grantedYear + 1, patentYearOf(filing, horizon)),
  )
  const firstYear = Math.max(grantedYear + 1, (query.paidThroughYear ?? 0) + 1)
  for (let year = firstYear; year <= lastYear; year++) {
    // 细则第115条: the fee for year N is due before year N-1 ends.
    const due = addCalendarMonths(filing, (year - 1) * 12)
    items.push(annualFeeDeadline(ctx, {
      id: `annual-fee-${String(year)}`,
      label: `缴纳第${String(year)}年度年费（授予专利权当年以后的年费应在上一年度期满前缴纳）`,
      legalBasis: '专利法实施细则第115条',
    }, due))
  }
  return items
}

/**
 * Build the PCT national-phase entry and its surcharge grace period, both
 * counted from the priority date when the case claims one and from the
 * international filing date otherwise.
 * @param ctx - the case inputs and evaluator options.
 * @returns the two entries, or none when the case is not in the national phase.
 */
function pctNationalEntryItems(ctx: EntryContext): DeadlineItem[] {
  const priority = ctx.query.priorityDate
  const filing = ctx.query.filingDate

  // ── 细则第120条 — PCT national-phase entry; the PCT route does not cover designs.
  if (ctx.query.kind === 'design' || ctx.query.isPctNationalPhase !== true) return []
  const base = priority ?? filing
  const baseLabel = priority !== undefined ? '优先权日' : '国际申请日（未主张优先权）'
  return [
    periodEntry(ctx, {
      id: 'pct-national-entry',
      label: `办理进入中国国家阶段手续（自${baseLabel}起30个月内；缴纳宽限费后可延至32个月）`,
      legalBasis: '专利法实施细则第120条',
    }, base, { unit: 'month', count: 30 }),
    periodEntry(ctx, {
      id: 'pct-national-entry-grace',
      label: `宽限期内办理进入中国国家阶段手续（自${baseLabel}起32个月内，须缴宽限费）`,
      legalBasis: '专利法实施细则第120条',
    }, base, { unit: 'month', count: 32 }),
  ]
}

/**
 * Build the PCT priority-claim fee, the only PCT fee that runs from the entry
 * date: a priority claim carried into the national phase is kept only when its
 * fee is paid within two months of that date.
 * @param ctx - the case inputs and evaluator options.
 * @returns the fee entry, a pending entry when a PCT case has no entry date, or none without a priority claim.
 */
function pctPriorityFeeItems(ctx: EntryContext): DeadlineItem[] {
  if (ctx.query.isPctNationalPhase !== true || !ctx.query.claimsPriority) return []
  const label = '缴纳优先权要求费（自进入中国国家阶段之日起2个月内）'
  const legalBasis = '专利法实施细则第127条'
  const entry = ctx.query.nationalPhaseEntryDate
  return entry === undefined
    ? [{
      id: 'priority-claim-fee',
      label,
      legalBasis,
      requiredInput: 'nationalPhaseEntryDate（进入中国国家阶段之日）',
      reason: 'PCT 国家阶段的优先权要求费自进入日起算；未记录进入日时无法计算，'
        + '不以国际申请日或优先权日替代。',
    }]
    : [periodEntry(ctx, { id: 'priority-claim-fee', label, legalBasis }, entry, { unit: 'month', count: 2 })]
}

/**
 * Build the invalidation-procedure period that runs from the request date.
 *
 * The request date is not the filing date, so a case that has not recorded it
 * reports a pending entry naming the input rather than counting from anything
 * else.
 * @param ctx - the case inputs and evaluator options.
 * @returns the request-driven entry, computed or pending.
 */
function invalidationRequestItems(ctx: EntryContext): DeadlineItem[] {
  const label = '增加无效理由或补充证据（自提出无效宣告请求之日起1个月）'
  const legalBasis = '专利法实施细则第71条'
  const requestDate = ctx.query.invalidationRequestDate
  if (requestDate === undefined) {
    return [{
      id: 'invalidation-evidence-supplement',
      label,
      legalBasis,
      requiredInput: 'invalidationRequestDate（提出无效宣告请求之日）',
      reason: '该期限自提出无效宣告请求之日起算；未记录请求日即无法计算，不以申请日等其他日期替代。',
    }]
  }
  return [periodEntry(ctx, {
    id: 'invalidation-evidence-supplement',
    label,
    legalBasis,
  }, requestDate, { unit: 'month', count: 1 })]
}

/**
 * Build the notice-driven periods, one entry per recorded notice of the kind.
 * @param ctx - the case inputs and evaluator options.
 * @param notices - the notices recorded on the case, by kind.
 * @returns the computed entries, or one pending entry per period whose notice is missing.
 */
function noticeDrivenItems(
  ctx: EntryContext,
  notices: ReadonlyMap<NoticeKind, readonly NoticeInput[]>,
): DeadlineItem[] {
  return NOTICE_PERIOD_SPECS.flatMap(spec => fromNotices({ ...spec, notices, ctx }))
}

/**
 * Build the term-compensation requests: the delay request stays pending until
 * the grant publication date is recorded, the new-drug request exists only for
 * a case with a marketing approval date.
 * @param ctx - the case inputs and evaluator options.
 * @returns the request entries.
 */
function termCompensationItems(ctx: EntryContext): DeadlineItem[] {
  // ── 细则第77条、第81条 — compensation exists only for an invention patent.
  if (ctx.query.kind !== 'invention') return []

  const items: DeadlineItem[] = []
  // ── 细则第77条、第81条 — term-compensation requests.
  if (ctx.query.authorizationPublicationDate !== undefined) {
    items.push(periodEntry(ctx, {
      id: 'term-compensation-request',
      label: '请求专利权期限补偿（发明专利授权过程中的不合理延迟）',
      legalBasis: '专利法第42条第2款、专利法实施细则第77条',
    }, ctx.query.authorizationPublicationDate, { unit: 'month', count: 3 }))
  } else {
    items.push({
      id: 'term-compensation-request',
      label: '请求专利权期限补偿（发明专利授权过程中的不合理延迟）',
      legalBasis: '专利法第42条第2款、专利法实施细则第77条',
      requiredInput: 'authorizationPublicationDate（授权公告日）',
      reason: '该请求应自公告授予专利权之日起3个月内提出，未提供授权公告日即无法计算。',
    })
  }
  if (ctx.query.marketingApprovalDate !== undefined) {
    items.push(periodEntry(ctx, {
      id: 'new-drug-compensation-request',
      label: '请求新药相关发明专利权期限补偿',
      legalBasis: '专利法第42条第3款、专利法实施细则第81条',
    }, ctx.query.marketingApprovalDate, { unit: 'month', count: 3 }))
  }
  return items
}

/**
 * The patent year containing a date, counted from the filing date.
 * @param filingDate - the filing date that starts year one.
 * @param date - the date to place.
 * @returns the patent year number (1-based).
 */
function patentYearOf(filingDate: CalendarDate, date: CalendarDate): number {
  const months = (date.year - filingDate.year) * 12 + (date.month - filingDate.month)
  const candidate = Math.max(1, Math.floor(months / 12) + 1)
  // The candidate year starts on the filing date's anniversary; when that day
  // falls after `date`, the date is still in the preceding patent year.
  return compareCalendarDates(addCalendarMonths(filingDate, (candidate - 1) * 12), date) <= 0
    ? candidate
    : candidate - 1
}

/**
 * Build an entry whose end date comes from a start date plus a period.
 * @param ctx - the case inputs and evaluator options.
 * @param spec - the entry's identity and legal citation.
 * @param start - the day the period starts.
 * @param period - the period length.
 * @returns the computed deadline.
 */
function periodEntry(
  ctx: EntryContext,
  spec: EntrySpec,
  start: CalendarDate,
  period: Period,
): ComputedDeadline {
  return finish(baseOf(ctx, spec), periodEnd(start, period))
}

/**
 * Build an entry whose end date is already known.
 * @param ctx - the case inputs and evaluator options.
 * @param spec - the entry's identity and legal citation.
 * @param due - the period's own end date.
 * @returns the computed deadline.
 */
function dateEntry(ctx: EntryContext, spec: EntrySpec, due: CalendarDate): ComputedDeadline {
  return finish(baseOf(ctx, spec), due)
}

/**
 * Attach the shared evaluation inputs to an entry specification.
 * @param ctx - the case inputs and evaluator options.
 * @param spec - the entry's identity and legal citation.
 * @returns the entry base.
 */
function baseOf(ctx: EntryContext, spec: EntrySpec): EntryBase {
  return { ...spec, query: ctx.query, options: ctx.options }
}

/**
 * Build a deadline that starts at a notice's delivery date, or a pending entry
 * naming that notice when the case has not recorded it or its delivery record
 * is incomplete.
 *
 * A repeatable kind yields one entry per recorded notice: its id is the base id
 * for the first record and carries the record's ordinal (`<id>-2`, `<id>-3`) for
 * the rest, so every period a case actually runs has its own row.
 * @param args - the entry definition.
 * @returns the computed deadlines, or one pending entry per unusable record.
 */
function fromNotices(args: NoticePeriodSpec & {
  notices: ReadonlyMap<NoticeKind, readonly NoticeInput[]>
  ctx: EntryContext
}): DeadlineItem[] {
  const recorded = args.notices.get(args.noticeKind) ?? []
  if (recorded.length === 0) {
    return [{
      id: args.id,
      label: args.label,
      legalBasis: args.legalBasis,
      requiredInput: `${args.noticeKind}（通知的送达记录）`,
      reason: args.absentReason,
    }]
  }
  return recorded.map((notice, index) => {
    const id = index === 0 ? args.id : `${args.id}-${String(index + 1)}`
    const stage = notice.stage
      ?? (args.stageVariants === undefined
        ? undefined
        : args.ctx.query.kind === 'invention' ? 'substantive' : 'preliminary')
    const variant = stage === undefined ? undefined : args.stageVariants?.[stage]
    const baseLabel = variant?.label ?? args.label
    const label = recorded.length === 1
      ? baseLabel
      : `${baseLabel}（第 ${String(index + 1)} 份通知）`
    let resolved: DeliveryDate
    try {
      resolved = resolveDeliveryDate(notice.delivery)
    } catch (error) {
      /* v8 ignore next -- resolveDeliveryDate throws only DeliveryInputError */
      if (!(error instanceof DeliveryInputError)) throw error
      return {
        id,
        label,
        legalBasis: args.legalBasis,
        requiredInput: `${args.noticeKind}.delivery（${error.message}）`,
        reason: '该通知已记录，但送达记录尚缺上述字段；补齐后即可计算，不以其他日期猜测送达日。',
      }
    }
    const designated = notice.designatedMonths !== undefined
      ? `；通知书指定期限 ${String(notice.designatedMonths)} 个月`
      : ''
    return periodEntry(args.ctx, {
      id,
      label,
      legalBasis: args.legalBasis,
      triggerBasis: `${resolved.basis}${designated}`,
    }, resolved.date, { unit: 'month', count: notice.designatedMonths ?? variant?.months ?? args.months })
  })
}

/** An end date after the query's rest-day rule has been applied. */
type ResolvedEnd = {
  date: CalendarDate
  rolledForward: boolean
  calendarCaveat?: string
}

/**
 * Apply the query's rest-day rule to an end date. An uncovered year keeps the
 * raw date and carries the caveat rather than assuming the day is a working day.
 * @param due - the period's own end date.
 * @param query - the case inputs, whose rest-day rule selects the criterion.
 * @param options - the loaded work calendar.
 * @returns the reported date and whether the rule moved it.
 */
function resolveEnd(due: CalendarDate, query: DeadlineQuery, options: EvaluateOptions): ResolvedEnd {
  if ((query.restDayRule ?? 'apply') === 'omit') return { date: due, rolledForward: false }
  try {
    const rolled = options.calendar.rollForward(due)
    return { date: rolled.date, rolledForward: rolled.rolled }
  } catch (error) {
    if (!(error instanceof WorkCalendarCoverageError)) throw error
    // The arrangement for that year is not loaded, so the rest-day rule could
    // not be applied. Report the raw end date and say which year is unverified
    // rather than dropping the entry or assuming the day is a working day.
    return {
      date: due,
      rolledForward: false,
      calendarCaveat: `${UNCOVERED_YEAR_CAVEAT_PREFIX}${String(error.year)}`,
    }
  }
}

/**
 * Report one computed entry from an already-resolved end date.
 * @param base - the entry's identity, legal basis, and trigger basis.
 * @param due - the period's own end date.
 * @param resolved - the reported end date after the rest-day rule.
 * @param latePaymentWindow - the surcharge window, when the entry carries one.
 * @returns the computed deadline.
 */
function computedFrom(
  base: EntryBase,
  due: CalendarDate,
  resolved: ResolvedEnd,
  latePaymentWindow?: LatePaymentWindow,
): ComputedDeadline {
  const daysRemaining = daysBetween(base.query.today, resolved.date)
  const status: DeadlineStatus = daysRemaining < 0
    ? 'overdue'
    : daysRemaining <= base.options.reminderLeadDays ? 'urgent' : 'normal'
  return {
    id: base.id,
    label: base.label,
    legalBasis: base.legalBasis,
    rawDueDate: formatCalendarDate(due),
    dueDate: formatCalendarDate(resolved.date),
    daysRemaining,
    status,
    rolledForward: resolved.rolledForward,
    ...(resolved.calendarCaveat !== undefined ? { calendarCaveat: resolved.calendarCaveat } : {}),
    ...(base.triggerBasis !== undefined ? { triggerBasis: base.triggerBasis } : {}),
    ...(latePaymentWindow !== undefined ? { latePaymentWindow } : {}),
  }
}

/**
 * Report one entry: keep the period's own end date, apply the rest-day rule
 * when the query asks for it, and derive the status from the reported date.
 * @param base - the entry's identity, legal basis, and trigger basis.
 * @param due - the period's own end date.
 * @returns the computed deadline.
 */
function finish(base: EntryBase, due: CalendarDate): ComputedDeadline {
  return computedFrom(base, due, resolveEnd(due, base.query, base.options))
}

/**
 * Report one annual fee and its six-month surcharge window. Both the window's
 * start and its end follow the same rest-day rule as the fee's own due date:
 * the window runs from the day the payment period actually ended, and a window
 * end on a rest day rolls to the next working day.
 * @param ctx - the case inputs and evaluator options.
 * @param spec - the entry's identity and legal citation.
 * @param due - the patent year's own end date.
 * @returns the computed deadline with its late-payment window.
 */
function annualFeeDeadline(ctx: EntryContext, spec: EntrySpec, due: CalendarDate): ComputedDeadline {
  const base = baseOf(ctx, spec)
  const resolved = resolveEnd(due, base.query, base.options)
  const windowEnd = resolveEnd(
    periodEnd(resolved.date, { unit: 'month', count: 6 }),
    base.query,
    base.options,
  )
  return computedFrom(base, due, resolved, {
    from: formatCalendarDate(resolved.date),
    to: formatCalendarDate(windowEnd.date),
    legalBasis: '专利法实施细则第115条',
    note:
      '未缴或者未缴足的，可在应缴年费期满之日起6个月内补缴，同时缴纳滞纳金'
      + '（每超过规定的缴费时间1个月，加收当年全额年费的5%）；期满未缴纳的，'
      + '专利权自应当缴纳年费期满之日起终止。',
    ...(windowEnd.calendarCaveat !== undefined ? { calendarCaveat: windowEnd.calendarCaveat } : {}),
  })
}
