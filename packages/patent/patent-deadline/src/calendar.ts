/**
 * Civil-date arithmetic for patent periods. Every value is a calendar date
 * without a time zone or time of day, so period arithmetic never drifts with
 * the host clock or the process time zone.
 * @module @deepseek-ai/dsh-patent-deadline/calendar
 */

import { HarnessError } from '@deepseek-ai/dsh-error'

/** A civil date; `month` is 1-12. */
export type CalendarDate = {
  year: number
  /** Month of year, 1-12. */
  month: number
  /** Day of month, 1-31. */
  day: number
}

const DATE_PATTERN = /^(\d{4})-(\d{1,2})-(\d{1,2})$/

/**
 * Lowest year a patent date can carry. The four-digit form admits leading zeros,
 * and `Date.UTC` reads years 0-99 as 19xx: a mistyped `0025-01-15` would then
 * shift by whole days into a different century while month arithmetic kept the
 * original year, so those years are rejected at the parse boundary instead.
 */
const MIN_DATE_YEAR = 1900

/**
 * Thrown when a date string is not a real `YYYY-MM-DD` civil date.
 * Extends {@link HarnessError} so the stable code reaches `tool/result`.
 */
export class CalendarDateError extends HarnessError {
  /** The rejected input. */
  readonly input: string

  /**
   * @param input - the rejected date string.
   */
  constructor(input: string) {
    super(`不是有效的日期（需要 YYYY-MM-DD 且为真实存在的日期）: ${JSON.stringify(input)}`, 'invalid_calendar_date')
    this.input = input
  }
}

/**
 * Days in a month of a proleptic Gregorian calendar.
 * @param year - four-digit year.
 * @param month - month of year, 1-12.
 * @returns the number of days in that month.
 */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * Parse a `YYYY-MM-DD` civil date, accepting unpadded month and day. Rejects
 * impossible months and days the month does not have (so `2025-02-29` fails) —
 * a mistyped filing date must never silently become a different day. Years below
 * {@link MIN_DATE_YEAR} are rejected for the same reason: day arithmetic reads
 * them as 19xx.
 * @param text - the date string.
 * @returns the parsed date.
 */
export function parseCalendarDate(text: string): CalendarDate {
  const match = DATE_PATTERN.exec(text.trim())
  if (match === null) throw new CalendarDateError(text)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < MIN_DATE_YEAR || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new CalendarDateError(text)
  }
  return { year, month, day }
}

/**
 * Format a civil date as `YYYY-MM-DD`.
 * @param date - the date.
 * @returns the ISO-style date string.
 */
export function formatCalendarDate(date: CalendarDate): string {
  const month = String(date.month).padStart(2, '0')
  const day = String(date.day).padStart(2, '0')
  return `${String(date.year).padStart(4, '0')}-${month}-${day}`
}

/**
 * UTC milliseconds for a civil date, used only for ordering and day counts.
 * @param date - the date.
 * @returns milliseconds since the epoch at UTC midnight.
 */
function utcMillis(date: CalendarDate): number {
  return Date.UTC(date.year, date.month - 1, date.day)
}

/**
 * Order two civil dates.
 * @param left - first date.
 * @param right - second date.
 * @returns -1 when left is earlier, 0 when equal, 1 when later.
 */
export function compareCalendarDates(left: CalendarDate, right: CalendarDate): -1 | 0 | 1 {
  const delta = utcMillis(left) - utcMillis(right)
  if (delta < 0) return -1
  return delta > 0 ? 1 : 0
}

/**
 * Day of week.
 * @param date - the date.
 * @returns 0 for Sunday through 6 for Saturday.
 */
export function weekday(date: CalendarDate): number {
  return new Date(utcMillis(date)).getUTCDay()
}

/**
 * Shift a civil date by whole days.
 * @param date - the starting date.
 * @param days - days to add; negative shifts backwards.
 * @returns the shifted date.
 */
export function addCalendarDays(date: CalendarDate, days: number): CalendarDate {
  const shifted = new Date(utcMillis(date) + days * 86_400_000)
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() }
}

/**
 * Shift a civil date by whole months, taking the corresponding day of the
 * target month and clamping to that month's last day when it has no such day —
 * the Implementing Regulations' rule for a period measured in months or years
 * (细则第5条第2句). `1999-12-31` plus two months is `2000-02-29`, not `2000-03-02`.
 * @param date - the starting date.
 * @param months - months to add; negative shifts backwards.
 * @returns the shifted date.
 */
export function addCalendarMonths(date: CalendarDate, months: number): CalendarDate {
  const total = date.year * 12 + (date.month - 1) + months
  const year = Math.floor(total / 12)
  const month = total - year * 12 + 1
  return { year, month, day: Math.min(date.day, daysInMonth(year, month)) }
}

/**
 * Whole calendar days from `from` to `to`, ignoring any time of day.
 * @param from - the earlier date.
 * @param to - the later date.
 * @returns the signed day count (`to - from`).
 */
export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  return Math.round((utcMillis(to) - utcMillis(from)) / 86_400_000)
}
