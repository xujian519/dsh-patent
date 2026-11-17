import { describe, expect, it } from 'vitest'
import { isBeforeReferenceDate } from '../src/evidence/date.ts'
import { timeBaselineAtom, TimeBaselineHandler } from '../src/atoms/handlers/builtin/time-baseline.ts'

const handler = new TimeBaselineHandler()

describe('time-baseline atom', () => {
  it('声明的输出键以报告为主输出，截止日与来源分别为第二、第三键', () => {
    expect(timeBaselineAtom.name).toBe('time-baseline')
    expect(timeBaselineAtom.category).toBe('extract')
    expect(timeBaselineAtom.outputSchema.slice(0, 3)).toEqual([
      'time_baseline_report',
      'reference_date',
      'reference_basis',
    ])
  })

  it('只有申请日时以申请日为截止日', async () => {
    const out = await handler.execute({ state: { filing_date: '2024-06-01' } })
    expect(out.reference_date).toBe('2024-06-01')
    expect(out.reference_basis).toBe('filing-date')
    expect(out.filing_date).toBe('2024-06-01')
    expect(out.priority_date).toBe('')
    expect(String(out.time_baseline_report)).toContain('申请日')
  })

  it('优先权日早于申请日时取优先权日', async () => {
    const out = await handler.execute({ state: { filing_date: '2024-06-01', priority_date: '2023-06-01' } })
    expect(out.reference_date).toBe('2023-06-01')
    expect(out.reference_basis).toBe('priority-date')
    expect(String(out.time_baseline_report)).toContain('优先权日')
  })

  it('只有优先权日时以优先权日为截止日，申请日留空', async () => {
    const out = await handler.execute({ state: { priority_date: '2023-06-01' } })
    expect(out.reference_date).toBe('2023-06-01')
    expect(out.reference_basis).toBe('priority-date')
    expect(out.filing_date).toBe('')
  })

  it('优先权日晚于申请日时仍取申请日', async () => {
    const out = await handler.execute({ state: { filing_date: '2024-06-01', priority_date: '2024-07-01' } })
    expect(out.reference_date).toBe('2024-06-01')
    expect(out.reference_basis).toBe('filing-date')
  })

  it('截止日可直接驱动公开日判定（G-1 两种走向）', async () => {
    const out = await handler.execute({ state: { filing_date: '2024-01-01' } })
    const reference = String(out.reference_date)
    expect(isBeforeReferenceDate('2023-05-01', reference)).toBe(true)
    expect(isBeforeReferenceDate('2024-05-01', reference)).toBe(false)
  })

  it('申请日与优先权日都缺失时降级', async () => {
    const out = await handler.execute({ state: { filing_date: '  ' } })
    expect(String(out._error)).toContain('[time-baseline]')
    expect(String(out._error)).toContain('缺少申请日与优先权日')
    expect(out.reference_date).toBeUndefined()
  })

  it('已提供的日期无法解析时降级，不静默改用另一个日期', async () => {
    const badFiling = await handler.execute({ state: { filing_date: '2024-13-01', priority_date: '2023-06-01' } })
    expect(String(badFiling._error)).toContain('申请日')
    expect(String(badFiling._error)).toContain('2024-13-01')
    const badPriority = await handler.execute({ state: { filing_date: '2024-06-01', priority_date: '不是日期' } })
    expect(String(badPriority._error)).toContain('优先权日')
  })

  it('月级申请日或优先权日降级，要求具体日期', async () => {
    const filing = await handler.execute({ state: { filing_date: '2024-06' } })
    expect(String(filing._error)).toContain('申请日')
    expect(String(filing._error)).toContain('仅精确到月')
    expect(filing.reference_date).toBeUndefined()

    const priority = await handler.execute({
      state: { filing_date: '2024-06-01', priority_date: '2023年6月' },
    })
    expect(String(priority._error)).toContain('优先权日')
    expect(String(priority._error)).toContain('仅精确到月')
    expect(priority.reference_date).toBeUndefined()
  })

  it('params 可指定日期来源键', async () => {
    const out = await handler.execute({
      state: {
        filing_date_key: 'applicationDate',
        priority_date_key: 'earliestPriority',
        applicationDate: '2024-06-01',
        earliestPriority: '2023-12-01',
      },
    })
    expect(out.reference_date).toBe('2023-12-01')
  })

  it('日期来源键保留首尾空格，按原样读取 state', async () => {
    const out = await handler.execute({
      state: {
        filing_date_key: ' application date ',
        ' application date ': '2024-06-01',
      },
    })
    expect(out.reference_date).toBe('2024-06-01')
    expect(out.reference_basis).toBe('filing-date')
  })

  it('日期来源键配置非法时降级', async () => {
    const filing = await handler.execute({ state: { filing_date_key: 3, filing_date: '2024-06-01' } })
    expect(String(filing._error)).toContain('filing_date_key')
    const priority = await handler.execute({ state: { priority_date_key: [], filing_date: '2024-06-01' } })
    expect(String(priority._error)).toContain('priority_date_key')
  })
})
