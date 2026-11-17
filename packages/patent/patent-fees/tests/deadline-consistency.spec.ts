import { describe, expect, it } from 'vitest'
import { evaluateDeadlines, loadWorkCalendar, parseCalendarDate, type DeadlineQuery, type DeadlineReport } from '@deepseek-ai/dsh-patent-deadline'
import { DEFAULT_FEE_POLICY, computeFees } from '../src/compute.ts'
import { loadFeeTable } from '../src/fees.ts'

const OPTIONS = { calendar: loadWorkCalendar(), reminderLeadDays: 30 }

const query = (overrides: Partial<DeadlineQuery> = {}): DeadlineQuery => ({
  kind: 'invention',
  filingDate: parseCalendarDate('2020-01-15'),
  claimsPriority: false,
  today: parseCalendarDate('2026-09-26'),
  ...overrides,
})

/** The patent years a deadline report asks for an annual fee in. */
function reportedYears(report: DeadlineReport): number[] {
  return report.computed
    .map(entry => /^annual-fee-(\d+)$/.exec(entry.id)?.[1])
    .filter((year): year is string => year !== undefined)
    .map(Number)
}

describe('the fee index and the deadline set agree on annual fees', () => {
  const report = evaluateDeadlines(query({ authorizationPublicationDate: parseCalendarDate('2022-03-04') }), OPTIONS)

  it('asks for at least one year, so the comparison is not vacuous', () => {
    expect(reportedYears(report).length).toBeGreaterThan(0)
  })

  it('prices exactly the years the deadline report asks for, one line each', () => {
    const years = reportedYears(report)
    const priced = computeFees(loadFeeTable(), {
      patentType: 'invention',
      triggers: ['annual-fee'],
      annuityYears: years,
    }, { policy: DEFAULT_FEE_POLICY })
    expect(priced.pending).toEqual([])
    expect(priced.lines.map(line => line.quantityBasis)).toEqual(years.map(year => `第 ${String(year)} 年度`))
  })

  it('gives every priced year the surcharge window the deadline report carries', () => {
    const withWindows = report.computed.filter(entry => entry.latePaymentWindow !== undefined)
    expect(withWindows.length).toBe(reportedYears(report).length)
    // A delay belongs to one year, so each year is priced in its own call: its annual
    // fee line and its surcharge line, the window coming from the deadline side and the
    // amount from the fee side.
    for (const year of reportedYears(report)) {
      const priced = computeFees(loadFeeTable(), {
        patentType: 'invention',
        triggers: ['annual-fee'],
        annuityYears: [year],
        lateMonths: 1,
      }, { policy: DEFAULT_FEE_POLICY })
      expect(priced.lines.map(line => line.id)).toEqual([
        `annual-fee-${String(year)}`,
        `annual-fee-${String(year)}-late-payment`,
      ])
    }
  })

  it('refuses on both sides when the granted year is unknown', () => {
    const ungranted = evaluateDeadlines(query(), OPTIONS)
    expect(ungranted.pending.map(entry => entry.id)).toContain('annual-fee')
    const priced = computeFees(loadFeeTable(), {
      patentType: 'invention',
      triggers: ['annual-fee'],
    }, { policy: DEFAULT_FEE_POLICY })
    expect(priced.pending.map(entry => entry.id)).toEqual(['annual-fee'])
  })
})
