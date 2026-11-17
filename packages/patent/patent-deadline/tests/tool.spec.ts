import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { loadWorkCalendar, WorkCalendar } from '../src/work-calendar.ts'
import { createPatentDeadlinesTool, type PatentDeadlinesOutput } from '../src/tool/patent-deadlines.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const FIXED_TODAY = { year: 2026, month: 9, day: 20 }

async function host(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.tools.register(createPatentDeadlinesTool({
    calendar: loadWorkCalendar(),
    reminderLeadDays: 30,
    now: () => FIXED_TODAY,
  }))
  return ctx
}

function execute(ctx: Context, args: unknown) {
  return executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId('patent-deadlines'),
    name: 'patent_deadlines',
    arguments: args,
  })
}

describe('patent_deadlines tool', () => {
  it('computes the deadline set and renders it with the report date and criterion', async () => {
    const ctx = await host()
    const result = await execute(ctx, {
      patentType: 'invention',
      filingDate: '2023-10-01',
      claimsPriority: false,
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const value = result.value as PatentDeadlinesOutput
    expect(value.asOf).toBe('2026-09-20')
    expect(value.claimsPriority).toBe(false)
    expect(value.restDayRule).toBe('apply')
    const exam = value.computed.find(entry => entry.id === 'substantive-exam-request')
    expect(exam).toMatchObject({ rawDueDate: '2026-10-01', dueDate: '2026-10-08', rolledForward: true })
    expect(value.pending.map(entry => entry.id)).toContain('registration')

    const text = result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
    expect(text).toContain('patent_deadlines: 发明专利 · 申请日 2023-10-01 · 基准日 2026-09-20 · 未主张优先权')
    expect(text).toContain('| 期限事项 | 届满日 | 原始届满日（未顺延） | 剩余 | 状态 | 法律依据 |')
    expect(text).toContain('已应用专利法实施细则第5条的届满日顺延')
    expect(text).toContain('无法计算的期限')
    expect(text).toContain('grant-notice（授权通知的送达记录）')
  })

  it('counts the substantive-examination request from the priority date when priority is claimed', async () => {
    const ctx = await host()
    const result = await execute(ctx, {
      patentType: 'invention',
      filingDate: '2020-01-15',
      claimsPriority: true,
      priorityDate: '2019-06-01',
    })
    if (result.isError) throw new Error('expected success')
    const value = result.value as PatentDeadlinesOutput
    expect(value.priorityDate).toBe('2019-06-01')
    expect(value.computed.find(entry => entry.id === 'substantive-exam-request')).toMatchObject({
      dueDate: '2022-06-01',
      label: '请求实质审查并缴纳审查费（自优先权日起3年）',
    })
    const text = result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
    expect(text).toContain('主张优先权（优先权日 2019-06-01）')
  })

  it('reports the un-rolled criterion when asked for it', async () => {
    const ctx = await host()
    const result = await execute(ctx, {
      patentType: 'invention',
      filingDate: '2023-10-01',
      claimsPriority: false,
      restDayRule: 'omit',
    })
    if (result.isError) throw new Error('expected success')
    const value = result.value as PatentDeadlinesOutput
    expect(value.restDayRule).toBe('omit')
    expect(value.computed.find(entry => entry.id === 'substantive-exam-request')).toMatchObject({
      rawDueDate: '2026-10-01',
      dueDate: '2026-10-01',
      rolledForward: false,
    })
    const text = result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
    expect(text).toContain('**不顺延**')
  })

  it('rejects contradictory priority inputs instead of picking one', async () => {
    const ctx = await host()
    const claimedWithoutDate = await execute(ctx, {
      patentType: 'invention',
      filingDate: '2020-01-15',
      claimsPriority: true,
    })
    expect(claimedWithoutDate.isError).toBe(true)
    expect(JSON.stringify(claimedWithoutDate.content)).toContain('priorityDate')

    const dateWithoutClaim = await execute(ctx, {
      patentType: 'invention',
      filingDate: '2020-01-15',
      claimsPriority: false,
      priorityDate: '2019-06-01',
    })
    expect(dateWithoutClaim.isError).toBe(true)
    expect(JSON.stringify(dateWithoutClaim.content)).toContain('两者矛盾')
  })

  it('applies a delivered notice to its designated period, dating it at dispatch', async () => {
    const ctx = await host()
    const result = await execute(ctx, {
      patentType: 'invention',
      filingDate: '2023-10-01',
      claimsPriority: false,
      notices: [{ kind: 'office-action-first', dispatchDate: '2026-08-20' }],
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const value = result.value as PatentDeadlinesOutput
    expect(value.computed.find(entry => entry.id === 'oa-response-first')).toMatchObject({ dueDate: '2026-12-21' })
  })

  it('reports a postal notice with the 15-day presumption', async () => {
    const ctx = await host()
    const result = await execute(ctx, {
      patentType: 'utility-model',
      filingDate: '2025-02-10',
      claimsPriority: false,
      notices: [{ kind: 'office-action-first', mode: 'postal', dispatchDate: '2026-08-20' }],
    })
    if (result.isError) throw new Error('expected success')
    const value = result.value as PatentDeadlinesOutput
    const entry = value.computed.find(item => item.id === 'oa-response-first')
    expect(entry?.triggerBasis).toContain('满15日')
    // 2026-08-20 + 15 days = 2026-09-04, plus the two-month period that
    // 初步审查 designates for a utility model = 2026-11-04.
    expect(entry?.dueDate).toBe('2026-11-04')
    expect(entry?.label).toBe('答复第一次审查意见通知书（指定期限，初步审查程序中为2个月）')
    expect(entry?.calendarCaveat).toBeUndefined()
  })

  it('overrides the first office-action stage the notice records', async () => {
    const ctx = await host()
    const utility = await execute(ctx, {
      patentType: 'utility-model',
      filingDate: '2025-02-10',
      claimsPriority: false,
      notices: [{ kind: 'office-action-first', dispatchDate: '2026-08-20', stage: 'substantive' }],
    })
    expect(utility.isError).toBe(true)
    expect(JSON.stringify(utility.content)).toContain('实质审查阶段')

    const invention = await execute(ctx, {
      patentType: 'invention',
      filingDate: '2023-10-01',
      claimsPriority: false,
      notices: [{ kind: 'office-action-first', dispatchDate: '2026-08-20', stage: 'preliminary' }],
    })
    if (invention.isError) throw new Error('expected success')
    const value = invention.value as PatentDeadlinesOutput
    expect(value.computed.find(entry => entry.id === 'oa-response-first')).toMatchObject({
      dueDate: '2026-10-20',
      label: '答复第一次审查意见通知书（指定期限，初步审查程序中为2个月）',
    })
  })

  it('keeps a notice with no delivery date pending instead of failing the query', async () => {
    const ctx = await host()
    const result = await execute(ctx, {
      patentType: 'invention',
      filingDate: '2023-10-01',
      claimsPriority: false,
      notices: [{ kind: 'office-action-first' }],
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const value = result.value as PatentDeadlinesOutput
    expect(value.computed.some(entry => entry.id === 'oa-response-first')).toBe(false)
    expect(value.pending.find(entry => entry.id === 'oa-response-first')?.requiredInput)
      .toContain('office-action-first.delivery')
  })

  it('rejects a non-positive designated period instead of throwing a raw period error', async () => {
    const ctx = await host()
    const result = await execute(ctx, {
      patentType: 'invention',
      filingDate: '2023-10-01',
      claimsPriority: false,
      notices: [{ kind: 'office-action-first', dispatchDate: '2026-08-20', designatedMonths: 0 }],
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('designatedMonths')
  })

  it('rejects a designated period on a notice whose period is statutory', async () => {
    const ctx = await host()
    const result = await execute(ctx, {
      patentType: 'invention',
      filingDate: '2024-01-10',
      claimsPriority: false,
      notices: [{ kind: 'rejection-decision', dispatchDate: '2026-01-05', designatedMonths: 1 }],
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('专利法第41条')
  })

  it('rejects marketing approval for a utility model as a contradiction', async () => {
    const ctx = await host()
    const result = await execute(ctx, {
      patentType: 'utility-model',
      filingDate: '2024-01-10',
      claimsPriority: false,
      marketingApprovalDate: '2026-07-01',
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('新药')
  })

  it('passes the PCT entry date through to the priority claim fee', async () => {
    const ctx = await host()
    const result = await execute(ctx, {
      patentType: 'invention',
      filingDate: '2024-01-01',
      claimsPriority: true,
      priorityDate: '2023-01-01',
      isPctNationalPhase: true,
      nationalPhaseEntryDate: '2025-07-01',
    })
    if (result.isError) throw new Error('expected success')
    const value = result.value as PatentDeadlinesOutput
    // The entry fee follows the 30-month period, which starts at the priority date.
    expect(value.computed.find(entry => entry.id === 'application-fee')).toMatchObject({
      dueDate: '2025-07-01',
      legalBasis: '专利法实施细则第121条、第120条',
    })
    expect(value.computed.find(entry => entry.id === 'priority-claim-fee')).toMatchObject({
      dueDate: '2025-09-01',
      legalBasis: '专利法实施细则第127条',
    })
  })

  it('accepts every optional case date and echoes the compensation and paid-through inputs', async () => {
    const ctx = await host()
    const result = await execute(ctx, {
      patentType: 'invention',
      filingDate: '2020-01-15',
      claimsPriority: true,
      priorityDate: '2019-06-01',
      isPctNationalPhase: false,
      authorizationPublicationDate: '2026-09-01',
      termCompensationYears: 2,
      paidThroughYear: 8,
      notices: [{
        kind: 'office-action-first',
        mode: 'electronic',
        dispatchDate: '2026-08-20',
        enteredDate: '2026-08-21',
        actualReceiptDate: '2026-08-22',
        handedOverDate: '2026-08-23',
        publicationDate: '2026-08-24',
        designatedMonths: 1,
      }],
      restDayRule: 'omit',
    })
    if (result.isError) throw new Error('expected success')
    const value = result.value as PatentDeadlinesOutput
    expect(value.termCompensationYears).toBe(2)
    expect(value.paidThroughYear).toBe(8)
    expect(value.computed.find(entry => entry.id === 'oa-response-first')).toMatchObject({
      dueDate: '2026-09-21',
      triggerBasis: expect.stringContaining('通知书指定期限 1 个月') as string,
    })
    // Year 7 is the granted year and year 8 is recorded as paid: fees start at year 9.
    expect(value.computed.some(entry => entry.id === 'annual-fee-8')).toBe(false)
    expect(value.computed.some(entry => entry.id === 'annual-fee-9')).toBe(true)
    const text = result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
    expect(text).toContain('年费记录：已缴至第 8 年度（含该年度），之前年度不再列出。')
  })

  it('reads today from the default zone when no clock is injected', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.tools.register(createPatentDeadlinesTool({
      calendar: loadWorkCalendar(),
      reminderLeadDays: 30,
    }))
    const result = await execute(ctx, {
      patentType: 'invention',
      filingDate: '2023-10-01',
      claimsPriority: false,
    })
    if (result.isError) throw new Error('expected success')
    expect((result.value as PatentDeadlinesOutput).asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('accepts a notice dated by the day it entered the electronic system', async () => {
    const ctx = await host()
    const result = await execute(ctx, {
      patentType: 'invention',
      filingDate: '2023-10-01',
      claimsPriority: false,
      notices: [{ kind: 'office-action-first', mode: 'electronic', enteredDate: '2026-08-21' }],
    })
    if (result.isError) throw new Error('expected success')
    expect((result.value as PatentDeadlinesOutput).computed.find(entry => entry.id === 'oa-response-first'))
      .toMatchObject({ dueDate: '2026-12-21' })
  })

  it('rejects an out-of-domain paid-through year', async () => {
    const ctx = await host()
    const result = await execute(ctx, {
      patentType: 'invention',
      filingDate: '2020-01-15',
      claimsPriority: false,
      paidThroughYear: -1,
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('paidThroughYear')
  })

  it('propagates an unexpected calendar failure as a tool error', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    class BrokenCalendar extends WorkCalendar {
      override rollForward(): never {
        throw new Error('calendar exploded')
      }
    }
    ctx.tools.register(createPatentDeadlinesTool({
      calendar: new BrokenCalendar([]),
      reminderLeadDays: 30,
      now: () => FIXED_TODAY,
    }))
    const result = await execute(ctx, {
      patentType: 'invention',
      filingDate: '2023-10-01',
      claimsPriority: false,
      restDayRule: 'apply',
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('calendar exploded')
  })

  it('fails loud on a malformed date instead of guessing one', async () => {
    const ctx = await host()
    const result = await execute(ctx, { patentType: 'invention', filingDate: '2025-02-29', claimsPriority: false })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('filingDate')
  })

  it('rejects an unknown notice kind at the schema boundary', async () => {
    const ctx = await host()
    const result = await execute(ctx, {
      patentType: 'invention',
      filingDate: '2023-10-01',
      claimsPriority: false,
      notices: [{ kind: 'not-a-notice', mode: 'electronic', dispatchDate: '2026-08-20' }],
    })
    expect(result.isError).toBe(true)
  })

  it('counts the invalidation evidence period from the request date when given', async () => {
    const ctx = await host()
    const withRequest = await execute(ctx, {
      patentType: 'invention',
      filingDate: '2023-10-01',
      claimsPriority: false,
      invalidationRequestDate: '2026-09-10',
    })
    if (withRequest.isError) throw new Error('expected success')
    const value = withRequest.value as PatentDeadlinesOutput
    expect(value.computed.find(entry => entry.id === 'invalidation-evidence-supplement')).toMatchObject({
      dueDate: '2026-10-10',
      legalBasis: '专利法实施细则第71条',
    })
    expect(value.pending.map(entry => entry.id)).not.toContain('invalidation-evidence-supplement')

    const withoutRequest = await execute(ctx, {
      patentType: 'invention',
      filingDate: '2023-10-01',
      claimsPriority: false,
    })
    if (withoutRequest.isError) throw new Error('expected success')
    const bare = withoutRequest.value as PatentDeadlinesOutput
    expect(bare.pending.find(entry => entry.id === 'invalidation-evidence-supplement')?.requiredInput)
      .toBe('invalidationRequestDate（提出无效宣告请求之日）')
  })
})
