import { describe, expect, it } from 'vitest'
import { resolveDeliveryDate } from '../src/delivery.ts'
import { periodEnd } from '../src/period.ts'
import { evaluateDeadlines, type DeadlineQuery, type NoticeInput } from '../src/statutes.ts'
import { WorkCalendar, loadWorkCalendar } from '../src/work-calendar.ts'

const date = (text: string) => {
  const [year, month, day] = text.split('-').map(Number) as [number, number, number]
  return { year, month, day }
}

/** A calendar with no holidays and no moved weekend days, covering every year these cases reach. */
function plainCalendar(from: number, to: number): WorkCalendar {
  const years = []
  for (let year = from; year <= to; year++) {
    years.push({ year, source: 'test', holidays: new Set<string>(), workdays: new Set<string>() })
  }
  return new WorkCalendar(years)
}

const plain = { calendar: plainCalendar(2019, 2045), reminderLeadDays: 30 }
const packaged = { calendar: loadWorkCalendar(), reminderLeadDays: 30 }

const find = (query: DeadlineQuery, id: string, options = plain) =>
  evaluateDeadlines(query, options).computed.find(entry => entry.id === id)

const invention: DeadlineQuery = {
  kind: 'invention',
  filingDate: date('2020-01-15'),
  claimsPriority: false,
  today: date('2026-09-15'),
}

describe('deadline boundaries: month end and leap year', () => {
  it('clamps a two-month period starting on 31 December to the leap day', () => {
    // 2023-12-31 + 2 months has no corresponding day in February 2024.
    const query: DeadlineQuery = {
      kind: 'utility-model',
      filingDate: date('2023-12-31'),
      claimsPriority: false,
      today: date('2024-01-10'),
    }
    expect(find(query, 'application-fee')).toMatchObject({
      rawDueDate: '2024-02-29',
      dueDate: '2024-02-29',
    })
    expect(find(query, 'voluntary-amendment-utility-design')).toMatchObject({
      rawDueDate: '2024-02-29',
      dueDate: '2024-02-29',
    })
    // The 10-year term ends on Saturday 2033-12-31 and rolls past the year boundary.
    expect(find(query, 'patent-term')).toMatchObject({
      rawDueDate: '2033-12-31',
      dueDate: '2034-01-02',
      rolledForward: true,
    })
  })

  it('clamps a filing day of 29 February and keeps the leap day when the target year has one', () => {
    const query: DeadlineQuery = {
      kind: 'invention',
      filingDate: date('2024-02-29'),
      claimsPriority: false,
      today: date('2024-03-01'),
    }
    // 2025 is not a leap year, so the one-year priority window ends on 28 February.
    expect(find(query, 'priority-window')).toMatchObject({ rawDueDate: '2025-02-28' })
    expect(find(query, 'application-fee')).toMatchObject({ rawDueDate: '2024-04-29' })
    // 2027 is not a leap year; the end date is a Sunday and rolls to Monday.
    expect(find(query, 'substantive-exam-request')).toMatchObject({
      rawDueDate: '2027-02-28',
      dueDate: '2027-03-01',
      rolledForward: true,
    })
    // 2044 is a leap year, so the 20-year term keeps the leap day.
    expect(find(query, 'patent-term')).toMatchObject({
      rawDueDate: '2044-02-29',
      dueDate: '2044-02-29',
    })
  })

  it('clamps a design term that starts on 29 February to a non-leap anniversary', () => {
    const query: DeadlineQuery = {
      kind: 'design',
      filingDate: date('2024-02-29'),
      claimsPriority: false,
      today: date('2024-03-01'),
    }
    // 2039 is not a leap year: the 15-year term ends on 28 February.
    expect(find(query, 'patent-term')).toMatchObject({
      rawDueDate: '2039-02-28',
      dueDate: '2039-02-28',
      label: '专利权期限届满（15年，自申请日起算）',
    })
  })

  it('uses the last day of the month for a period that crosses a short month', () => {
    expect(periodEnd(date('2024-03-31'), { unit: 'month', count: 1 })).toEqual(date('2024-04-30'))
    expect(periodEnd(date('2023-08-31'), { unit: 'month', count: 6 })).toEqual(date('2024-02-29'))
    expect(periodEnd(date('2024-02-29'), { unit: 'year', count: 1 })).toEqual(date('2025-02-28'))
    expect(periodEnd(date('2024-02-29'), { unit: 'year', count: 4 })).toEqual(date('2028-02-29'))
  })
})

describe('deadline boundaries: holiday roll-forward', () => {
  const noticeQuery = (notice: NoticeInput): DeadlineQuery =>
    ({ ...invention, today: date('2026-09-15'), notices: [notice] })

  it('rolls an end date inside the 2025 eight-day National Day holiday', () => {
    // 2025 国庆节、中秋节: 10月1日至8日放假, so 10-01 rolls to 10-09.
    const query = noticeQuery({
      kind: 'reexamination-notice',
      delivery: { mode: 'electronic', dispatchDate: date('2025-09-01') },
    })
    expect(find(query, 'reexamination-deficiency-response', packaged)).toMatchObject({
      rawDueDate: '2025-10-01',
      dueDate: '2025-10-09',
      rolledForward: true,
    })
  })

  it('rolls an end date inside the 2026 National Day holiday', () => {
    const query = noticeQuery({
      kind: 'reexamination-notice',
      delivery: { mode: 'electronic', dispatchDate: date('2026-09-01') },
    })
    expect(find(query, 'reexamination-deficiency-response', packaged)).toMatchObject({
      rawDueDate: '2026-10-01',
      dueDate: '2026-10-08',
      rolledForward: true,
    })
  })

  it('keeps an end date on a weekend day moved to a working day', () => {
    // 2026 国庆节调休: 10月10日(周六)上班, so the end date does not roll.
    const query = noticeQuery({
      kind: 'office-action-subsequent',
      delivery: { mode: 'electronic', dispatchDate: date('2026-08-10') },
    })
    expect(find(query, 'oa-response-subsequent', packaged)).toMatchObject({
      rawDueDate: '2026-10-10',
      dueDate: '2026-10-10',
      rolledForward: false,
    })
  })

  it('rolls across the 2026 Spring Festival holiday', () => {
    // 2026 春节: 2月15日至23日放假, so 02-15 rolls to 02-24.
    const query = noticeQuery({
      kind: 'office-action-subsequent',
      delivery: { mode: 'electronic', dispatchDate: date('2025-12-15') },
    })
    expect(find(query, 'oa-response-subsequent', packaged)).toMatchObject({
      rawDueDate: '2026-02-15',
      dueDate: '2026-02-24',
      rolledForward: true,
    })
  })

  it('leaves the raw end date with a caveat when the roll crosses into an uncovered year', () => {
    const yearEnd = new WorkCalendar([{
      year: 2026,
      source: 'test',
      holidays: new Set(['2026-12-31']),
      workdays: new Set<string>(),
    }])
    const query = noticeQuery({
      kind: 'office-action-subsequent',
      delivery: { mode: 'electronic', dispatchDate: date('2026-10-31') },
    })
    expect(find(query, 'oa-response-subsequent', { calendar: yearEnd, reminderLeadDays: 30 })).toMatchObject({
      rawDueDate: '2026-12-31',
      dueDate: '2026-12-31',
      rolledForward: false,
      calendarCaveat: 'calendar-uncovered-year:2027',
    })
  })
})

describe('deadline boundaries: delivery date', () => {
  it('presumes postal delivery 15 days after dispatch without rolling the presumed date', () => {
    const delivery = resolveDeliveryDate({ mode: 'postal', dispatchDate: date('2026-02-27') })
    // 15 days after 2026-02-27 is Saturday 2026-03-14; the presumed receipt day is not rolled.
    expect(delivery.date).toEqual(date('2026-03-14'))
    const query: DeadlineQuery = {
      ...invention,
      today: date('2026-03-01'),
      notices: [{
        kind: 'reexamination-notice',
        delivery: { mode: 'postal', dispatchDate: date('2026-02-27') },
      }],
    }
    expect(find(query, 'reexamination-deficiency-response')).toMatchObject({
      rawDueDate: '2026-04-14',
      dueDate: '2026-04-14',
      triggerBasis: expect.stringContaining('满15日') as string,
    })
  })

  it('counts an electronic period from the dispatch date with no 15-day extension', () => {
    const query: DeadlineQuery = {
      ...invention,
      today: date('2027-01-01'),
      notices: [{
        kind: 'reexamination-notice',
        delivery: { mode: 'electronic', dispatchDate: date('2026-12-31') },
      }],
    }
    expect(find(query, 'reexamination-deficiency-response')).toMatchObject({
      rawDueDate: '2027-01-31',
      dueDate: '2027-02-01',
      rolledForward: true,
    })
  })

  it('clamps service by publication on 31 January to the leap day', () => {
    const delivery = resolveDeliveryDate({ mode: 'publication', publicationDate: date('2024-01-31') })
    expect(delivery.date).toEqual(date('2024-02-29'))
  })

  it('adds one month to service by publication across the year boundary', () => {
    const delivery = resolveDeliveryDate({ mode: 'publication', publicationDate: date('2025-12-31') })
    // The delivery date itself is the month-end date and is not rolled for the weekend.
    expect(delivery.date).toEqual(date('2026-01-31'))
  })
})

describe('deadline boundaries: status against the report day', () => {
  const query: DeadlineQuery = {
    ...invention,
    invalidationRequestDate: date('2026-04-15'),
    restDayRule: 'omit',
  }
  const remaining = (today: string) =>
    find({ ...query, today: date(today) }, 'invalidation-evidence-supplement')

  it('turns a deadline overdue only after its end date has passed', () => {
    expect(remaining('2026-04-14')).toMatchObject({ daysRemaining: 31, status: 'normal' })
    expect(remaining('2026-04-15')).toMatchObject({ daysRemaining: 30, status: 'urgent' })
    expect(remaining('2026-05-15')).toMatchObject({ daysRemaining: 0, status: 'urgent' })
    expect(remaining('2026-05-16')).toMatchObject({ daysRemaining: -1, status: 'overdue' })
  })

  it('warns when the remaining days exactly equal a zero lead time', () => {
    const zeroLead = { calendar: plain.calendar, reminderLeadDays: 0 }
    expect(find({ ...query, today: date('2026-05-15') }, 'invalidation-evidence-supplement', zeroLead))
      .toMatchObject({ daysRemaining: 0, status: 'urgent' })
    expect(find({ ...query, today: date('2026-05-14') }, 'invalidation-evidence-supplement', zeroLead))
      .toMatchObject({ daysRemaining: 1, status: 'normal' })
  })
})
