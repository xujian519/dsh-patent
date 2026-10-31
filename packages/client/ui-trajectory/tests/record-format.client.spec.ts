/** Trajectory record duration formatting. */
import { describe, expect, it } from 'vitest'
import {
  formatDurationMillis as formatDurationMillisWithLocale,
  formatElapsedSeconds as formatElapsedSecondsWithLocale,
} from '../src/client/trajectory-record.ts'
import { t } from './locale.client.ts'

const formatDurationMillis = (value: number | null) => formatDurationMillisWithLocale(value, t)
const formatElapsedSeconds = (value: number | null) => formatElapsedSecondsWithLocale(value, t)

describe('formatDurationMillis', () => {
  it('formats exact millisecond labels with thousands separators', () => {
    expect(formatDurationMillis(0)).toBe('0 ms')
    expect(formatDurationMillis(29)).toBe('29 ms')
    expect(formatDurationMillis(500)).toBe('500 ms')
    expect(formatDurationMillis(1_500)).toBe('1,500 ms')
    expect(formatDurationMillis(235_200)).toBe('235,200 ms')
    expect(formatDurationMillis(null)).toBe('—')
    expect(formatDurationMillis(Number.NaN)).toBe('—')
  })
})

describe('formatElapsedSeconds', () => {
  it('formats known durations and uses an em dash when absent', () => {
    expect(formatElapsedSeconds(null)).toBe('—')
    expect(formatElapsedSeconds(235)).toBe('235,000 ms')
    expect(formatElapsedSeconds(235.0)).toBe('235,000 ms')
    expect(formatElapsedSeconds(235.2)).toBe('235,200 ms')
    expect(formatElapsedSeconds(235.25)).toBe('235,250 ms')
    expect(formatElapsedSeconds(0)).toBe('0 ms')
    expect(formatElapsedSeconds(0.029)).toBe('29 ms')
    expect(formatElapsedSeconds(0.5)).toBe('500 ms')
    expect(formatElapsedSeconds(1.5)).toBe('1,500 ms')
    expect(formatElapsedSeconds(Number.NaN)).toBe('—')
  })
})
