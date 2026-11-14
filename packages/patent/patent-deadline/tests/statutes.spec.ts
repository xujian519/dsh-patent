import { describe, expect, it } from 'vitest'
import {
  DeadlineQueryError,
  describePatentKind,
  evaluateDeadlines,
  type DeadlineQuery,
} from '../src/statutes.ts'
import { WorkCalendar, loadWorkCalendar } from '../src/work-calendar.ts'

const date = (text: string) => {
  const [year, month, day] = text.split('-').map(Number) as [number, number, number]
  return { year, month, day }
}

/** A calendar with no holidays and no moved weekend days, covering the years a test needs. */
function plainCalendar(from: number, to: number): WorkCalendar {
  const years = []
  for (let year = from; year <= to; year++) {
    years.push({ year, source: 'test', holidays: new Set<string>(), workdays: new Set<string>() })
  }
  return new WorkCalendar(years)
}

const base = { calendar: plainCalendar(2019, 2041), reminderLeadDays: 30 }

const find = (query: DeadlineQuery, id: string, options = base) =>
  evaluateDeadlines(query, options).computed.find(entry => entry.id === id)

const pendingIds = (query: DeadlineQuery, options = base) =>
  evaluateDeadlines(query, options).pending.map(entry => entry.id)

describe('statutory deadline set', () => {
  const invention: DeadlineQuery = {
    kind: 'invention',
    filingDate: date('2020-01-15'),
    claimsPriority: false,
    today: date('2026-09-20'),
  }

  it('computes the periods that run from the filing date', () => {
    expect(find(invention, 'priority-window')).toMatchObject({
      dueDate: '2021-01-15',
      rawDueDate: '2021-01-15',
      status: 'overdue',
      legalBasis: '专利法第29条第1款',
    })
    expect(find(invention, 'priority-restoration')).toMatchObject({
      dueDate: '2021-03-15',
      legalBasis: '专利法实施细则第36条',
    })
    expect(find(invention, 'application-fee')).toMatchObject({
      dueDate: '2020-03-16',
      legalBasis: '专利法实施细则第112条',
    })
    // 2023-01-15 is a Sunday, so the rest-day rule moves it to Monday while the
    // period's own end date is kept.
    expect(find(invention, 'substantive-exam-request')).toMatchObject({
      rawDueDate: '2023-01-15',
      dueDate: '2023-01-16',
      rolledForward: true,
      label: '请求实质审查并缴纳审查费（自申请日起3年）',
      legalBasis: '专利法第35条',
    })
    // 2040-01-15 is a Sunday, so the 20-year term is reported on Monday.
    expect(find(invention, 'patent-term')).toMatchObject({
      rawDueDate: '2040-01-15',
      dueDate: '2040-01-16',
      rolledForward: true,
      legalBasis: '专利法第42条第1款',
    })
  })

  it('reports the notice-driven deadlines as pending, naming the missing notice', () => {
    const report = evaluateDeadlines(invention, base)
    const ids = report.pending.map(entry => entry.id)
    expect(ids).toEqual([
      'annual-fee',
      'divisional-application',
      'invalidation-evidence-supplement',
      'invalidation-response',
      'oa-response-first',
      'oa-response-subsequent',
      'reexamination-deficiency-response',
      'reexamination-request',
      'registration',
      'term-compensation-request',
      'voluntary-amendment-invention',
    ])
    const registration = report.pending.find(entry => entry.id === 'registration')
    expect(registration?.requiredInput).toBe('grant-notice（授权通知的送达记录）')
    expect(registration?.reason).toContain('不以申请日起算的固定年数替代')
    const supplement = report.pending.find(entry => entry.id === 'invalidation-evidence-supplement')
    expect(supplement?.requiredInput).toBe('invalidationRequestDate（提出无效宣告请求之日）')
    expect(supplement?.reason).toContain('自提出无效宣告请求之日起算')
  })

  it('counts the invalidation period for adding grounds or evidence from the request date', () => {
    const query: DeadlineQuery = { ...invention, invalidationRequestDate: date('2024-03-05'), today: date('2024-03-20') }
    expect(find(query, 'invalidation-evidence-supplement')).toMatchObject({
      dueDate: '2024-04-05',
      rawDueDate: '2024-04-05',
      status: 'urgent',
      label: '增加无效理由或补充证据（自提出无效宣告请求之日起1个月）',
      legalBasis: '专利法实施细则第71条',
    })
    expect(pendingIds(query)).not.toContain('invalidation-evidence-supplement')
  })

  it('counts the answer to a transferred invalidation request from its delivery date', () => {
    const query: DeadlineQuery = {
      ...invention,
      today: date('2024-03-20'),
      notices: [{
        kind: 'invalidation-transfer',
        delivery: { mode: 'electronic', dispatchDate: date('2024-03-01') },
      }],
    }
    expect(find(query, 'invalidation-response')).toMatchObject({
      dueDate: '2024-04-01',
      label: '答复无效宣告请求（合议组指定期限，通常为1个月）',
      legalBasis: '专利法实施细则第72条、专利审查指南第四部分第三章第4.4.1节',
    })
    expect(pendingIds(query)).not.toContain('invalidation-response')
  })

  it('counts the substantive-examination request from the priority date when priority is claimed', () => {
    const query: DeadlineQuery = {
      ...invention,
      claimsPriority: true,
      priorityDate: date('2019-06-01'),
    }
    expect(find(query, 'substantive-exam-request')).toMatchObject({
      dueDate: '2022-06-01',
      label: '请求实质审查并缴纳审查费（自优先权日起3年）',
    })
    // 细则第37条 presupposes a priority claim: the entry exists only here.
    expect(find(query, 'priority-addition-or-correction')).toMatchObject({ dueDate: '2020-10-01' })
    expect(find(invention, 'priority-addition-or-correction')).toBeUndefined()
  })

  it('fails loud when the priority inputs contradict each other', () => {
    expect(() => evaluateDeadlines({ ...invention, claimsPriority: true }, base))
      .toThrow(DeadlineQueryError)
    expect(() => evaluateDeadlines({ ...invention, priorityDate: date('2019-06-01') }, base))
      .toThrow(/两者矛盾/)
  })

  it('reports the period\'s own end date under the un-rolled criterion', () => {
    const query: DeadlineQuery = { ...invention, restDayRule: 'omit' }
    const exam = find(query, 'substantive-exam-request')
    expect(exam).toMatchObject({ rawDueDate: '2023-01-15', dueDate: '2023-01-15', rolledForward: false })
    expect(evaluateDeadlines(query, base).restDayRule).toBe('omit')
    expect(evaluateDeadlines(invention, base).restDayRule).toBe('apply')
  })

  it('does not consult the holiday arrangement under the un-rolled criterion', () => {
    // The packaged calendar covers 2025-2026, so 2043 would carry a caveat under
    // the default criterion; omitting roll-forward needs no calendar at all.
    const query: DeadlineQuery = {
      kind: 'invention',
      filingDate: date('2023-10-01'),
      claimsPriority: false,
      today: date('2026-09-20'),
      restDayRule: 'omit',
    }
    expect(find(query, 'patent-term', { calendar: loadWorkCalendar(), reminderLeadDays: 30 })).toMatchObject({
      dueDate: '2043-10-01',
    })
  })

  it('starts registration and divisional filing at the grant notice delivery', () => {
    const query: DeadlineQuery = {
      ...invention,
      notices: [{ kind: 'grant-notice', delivery: { mode: 'electronic', dispatchDate: date('2026-09-01') } }],
    }
    expect(find(query, 'registration')).toMatchObject({
      dueDate: '2026-11-02',
      rawDueDate: '2026-11-01',
      rolledForward: true,
      legalBasis: '专利法实施细则第60条第1款、第114条',
    })
    expect(find(query, 'divisional-application')).toMatchObject({ dueDate: '2026-11-02' })
    expect(pendingIds(query)).not.toContain('registration')
  })

  it('numbers annual fees from the granted patent year and carries the six-month window', () => {
    const query: DeadlineQuery = {
      ...invention,
      authorizationPublicationDate: date('2026-09-01'),
    }
    // The grant falls in patent year 7, so fees run from year 8.
    expect(find(query, 'annual-fee-8')).toMatchObject({
      dueDate: '2027-01-15',
      legalBasis: '专利法实施细则第115条',
      latePaymentWindow: { from: '2027-01-15', to: '2027-07-15' },
    })
    expect(find(query, 'annual-fee-9')).toMatchObject({ dueDate: '2028-01-17', rolledForward: true })
    expect(pendingIds(query)).not.toContain('annual-fee')
  })

  it('does not add an annual fee for the granted year itself', () => {
    const query: DeadlineQuery = { ...invention, authorizationPublicationDate: date('2026-09-01') }
    const { computed } = evaluateDeadlines(query, base)
    expect(computed.some(entry => entry.id === 'annual-fee-7')).toBe(false)
  })

  it('counts a designated period from the notice dispatch date and honours its own designation', () => {
    const query: DeadlineQuery = {
      ...invention,
      notices: [
        { kind: 'office-action-first', delivery: { dispatchDate: date('2026-08-20') } },
        {
          kind: 'office-action-subsequent',
          delivery: { mode: 'postal', dispatchDate: date('2026-08-20') },
          designatedMonths: 1,
        },
      ],
    }
    expect(find(query, 'oa-response-first')).toMatchObject({
      dueDate: '2026-12-21',
      rolledForward: true,
      triggerBasis: '专利法实施细则第四条 + 专利审查指南第五部分第六章2.3.1：电子送达以发文日为送达日，期限自发文日起算（不再加15日）',
    })
    // Postal delivery adds 15 days: 2026-09-04 plus one designated month.
    expect(find(query, 'oa-response-subsequent')).toMatchObject({
      dueDate: '2026-10-05',
      rolledForward: true,
    })
  })

  it('computes one period per recorded notice of a repeatable kind', () => {
    const query: DeadlineQuery = {
      ...invention,
      notices: [
        { kind: 'office-action-subsequent', delivery: { dispatchDate: date('2025-03-01') } },
        { kind: 'office-action-subsequent', delivery: { dispatchDate: date('2026-06-01') } },
      ],
    }
    const { computed } = evaluateDeadlines(query, base)
    // Each notice starts its own two-month period; the earlier one is overdue and stays visible.
    expect(computed.map(entry => entry.id)).toContain('oa-response-subsequent')
    expect(computed.map(entry => entry.id)).toContain('oa-response-subsequent-2')
    expect(find(query, 'oa-response-subsequent')).toMatchObject({ dueDate: '2025-05-01', status: 'overdue' })
    expect(find(query, 'oa-response-subsequent-2')).toMatchObject({ dueDate: '2026-08-03' })
    expect(find(query, 'oa-response-subsequent')?.label).toBe('答复后续审查意见通知书（指定期限一般为2个月，以通知书指定为准）（第 1 份通知）')
  })

  it('rejects a second record of a kind a case receives once', () => {
    const duplicate: DeadlineQuery = {
      ...invention,
      notices: [
        { kind: 'grant-notice', delivery: { dispatchDate: date('2026-09-01') } },
        { kind: 'grant-notice', delivery: { dispatchDate: date('2026-10-01') } },
      ],
    }
    expect(() => evaluateDeadlines(duplicate, base)).toThrow(DeadlineQueryError)
  })

  it('uses the 6-month priority window and 15-year term for a design patent', () => {
    const query: DeadlineQuery = {
      kind: 'design',
      filingDate: date('2024-03-10'),
      claimsPriority: false,
      today: date('2026-09-20'),
    }
    expect(find(query, 'priority-window')).toMatchObject({ dueDate: '2024-09-10' })
    expect(find(query, 'patent-term')).toMatchObject({ dueDate: '2039-03-10' })
    expect(find(query, 'voluntary-amendment-utility-design')).toMatchObject({ dueDate: '2024-05-10' })
    expect(find(query, 'substantive-exam-request')).toBeUndefined()
  })

  it('gives a utility model the ten-year term of 专利法第42条第1款', () => {
    const utility: DeadlineQuery = {
      kind: 'utility-model',
      filingDate: date('2024-01-10'),
      claimsPriority: false,
      today: date('2026-09-20'),
    }
    expect(find(utility, 'patent-term')).toMatchObject({
      rawDueDate: '2034-01-10',
      legalBasis: '专利法第42条第1款',
      label: '专利权期限届满（10年，自申请日起算）',
    })
  })

  it('applies the 10-year term to a design filed before the 2021 transition', () => {
    const oldDesign: DeadlineQuery = {
      kind: 'design',
      filingDate: date('2020-05-31'),
      claimsPriority: false,
      today: date('2026-09-20'),
    }
    expect(find(oldDesign, 'patent-term')).toMatchObject({
      rawDueDate: '2030-05-31',
      label: '专利权期限届满（10年，自申请日起算）',
    })
    // The filing date selects the term: the day the amendment took effect starts 15 years.
    expect(find({ ...oldDesign, filingDate: date('2021-06-01') }, 'patent-term'))
      .toMatchObject({ rawDueDate: '2036-06-01' })
  })

  it('stops annual fees at the last year of the patent term', () => {
    const oldInvention: DeadlineQuery = {
      kind: 'invention',
      filingDate: date('2000-01-01'),
      claimsPriority: false,
      authorizationPublicationDate: date('2005-01-01'),
      today: date('2026-10-17'),
    }
    expect(find(oldInvention, 'annual-fee-20')).toBeDefined()
    expect(find(oldInvention, 'annual-fee-21')).toBeUndefined()
  })

  it('omits annual fees already recorded as paid', () => {
    const query: DeadlineQuery = {
      kind: 'invention',
      filingDate: date('2000-01-01'),
      claimsPriority: false,
      authorizationPublicationDate: date('2005-01-01'),
      paidThroughYear: 19,
      today: date('2026-10-17'),
    }
    expect(find(query, 'annual-fee-19')).toBeUndefined()
    expect(find(query, 'annual-fee-20')).toBeDefined()
    expect(find({ ...query, paidThroughYear: 20 }, 'annual-fee-20')).toBeUndefined()
  })

  it('extends the term and its fee years by a granted compensation period', () => {
    const options = { calendar: plainCalendar(2019, 2046), reminderLeadDays: 30 }
    const query: DeadlineQuery = {
      ...invention,
      authorizationPublicationDate: date('2026-09-01'),
      termCompensationYears: 5,
      today: date('2044-09-20'),
    }
    expect(find(query, 'patent-term', options)).toMatchObject({
      rawDueDate: '2045-01-15',
      label: '专利权期限届满（20年+期限补偿5年，自申请日起算）',
    })
    expect(find(query, 'annual-fee-25', options)).toBeDefined()
    expect(find(query, 'annual-fee-26', options)).toBeUndefined()
  })

  it('offers term compensation only to an invention', () => {
    const utility: DeadlineQuery = {
      kind: 'utility-model',
      filingDate: date('2024-01-10'),
      claimsPriority: false,
      authorizationPublicationDate: date('2026-06-10'),
      today: date('2026-09-20'),
    }
    expect(find(utility, 'term-compensation-request')).toBeUndefined()
    expect(pendingIds(utility)).not.toContain('term-compensation-request')
    expect(() => evaluateDeadlines({ ...utility, marketingApprovalDate: date('2026-07-01') }, base))
      .toThrow(/新药/)
  })

  it('omits priority restoration and addition for a design', () => {
    const design: DeadlineQuery = {
      kind: 'design',
      filingDate: date('2024-03-10'),
      claimsPriority: true,
      priorityDate: date('2023-11-10'),
      today: date('2026-09-20'),
    }
    expect(find(design, 'priority-window')).toBeDefined()
    expect(find(design, 'priority-restoration')).toBeUndefined()
    expect(find(design, 'priority-addition-or-correction')).toBeUndefined()
    expect(() => evaluateDeadlines({ ...design, isPctNationalPhase: true }, base)).toThrow(/PCT/)
  })

  it('uses the two-month first office-action period for a utility model and a design', () => {
    const notice = {
      kind: 'office-action-first' as const,
      delivery: { mode: 'electronic' as const, dispatchDate: date('2026-08-20') },
    }
    const utility: DeadlineQuery = {
      kind: 'utility-model',
      filingDate: date('2025-02-10'),
      claimsPriority: false,
      notices: [notice],
      today: date('2026-09-20'),
    }
    expect(find(utility, 'oa-response-first')).toMatchObject({
      dueDate: '2026-10-20',
      label: '答复第一次审查意见通知书（指定期限，初步审查程序中为2个月）',
    })
    expect(find({ ...utility, kind: 'design' }, 'oa-response-first')).toMatchObject({ dueDate: '2026-10-20' })
    expect(find({ ...utility, kind: 'invention' }, 'oa-response-first')).toMatchObject({ dueDate: '2026-12-21' })
  })

  it('defaults the reexamination-notice answer to one month', () => {
    const query: DeadlineQuery = {
      ...invention,
      notices: [{
        kind: 'reexamination-notice',
        delivery: { mode: 'electronic', dispatchDate: date('2026-08-20') },
      }],
    }
    // 2026-09-20 is a Sunday, so the reported date rolls to Monday.
    expect(find(query, 'reexamination-deficiency-response')).toMatchObject({
      rawDueDate: '2026-09-20',
      dueDate: '2026-09-21',
      label: '答复复审通知书（指定期限通常为1个月，以通知书指定为准）',
    })
  })

  it('rejects dates that contradict each other in time', () => {
    expect(() => evaluateDeadlines({
      ...invention,
      claimsPriority: true,
      priorityDate: date('2020-02-01'),
    }, base)).toThrow(/优先权日/)
    expect(() => evaluateDeadlines({
      ...invention,
      authorizationPublicationDate: date('2019-01-01'),
    }, base)).toThrow(/授权公告日/)
  })

  it('rejects a PCT entry date on a non-PCT case and dates that predate the filing', () => {
    expect(() => evaluateDeadlines({
      ...invention,
      nationalPhaseEntryDate: date('2024-01-01'),
    }, base)).toThrow(/PCT/)
    expect(() => evaluateDeadlines({
      ...invention,
      isPctNationalPhase: true,
      nationalPhaseEntryDate: date('2019-01-01'),
    }, base)).toThrow(/进入中国国家阶段之日/)
    expect(() => evaluateDeadlines({
      ...invention,
      invalidationRequestDate: date('2019-01-01'),
    }, base)).toThrow(/无效宣告请求之日/)
    expect(() => evaluateDeadlines({
      ...invention,
      marketingApprovalDate: date('2019-01-01'),
    }, base)).toThrow(/新药上市许可日/)
    expect(() => evaluateDeadlines({
      ...invention,
      claimsPriority: true,
      priorityDate: date('2020-01-15'),
    }, base)).toThrow(/同一天或更晚/)
  })

  it('honours an explicitly recorded first office-action stage', () => {
    const delivery = { mode: 'electronic' as const, dispatchDate: date('2026-08-20') }
    const utility: DeadlineQuery = {
      kind: 'utility-model',
      filingDate: date('2025-02-10'),
      claimsPriority: false,
      notices: [{ kind: 'office-action-first', delivery, stage: 'preliminary' }],
      today: date('2026-09-20'),
    }
    expect(find(utility, 'oa-response-first')).toMatchObject({
      dueDate: '2026-10-20',
      label: '答复第一次审查意见通知书（指定期限，初步审查程序中为2个月）',
    })
    // An invention can also receive a preliminary-examination action before entering substantive examination.
    expect(find({ ...utility, kind: 'invention' }, 'oa-response-first')).toMatchObject({ dueDate: '2026-10-20' })
  })

  it('rejects a stage that contradicts the notice kind or the patent category', () => {
    const delivery = { dispatchDate: date('2026-08-20') }
    expect(() => evaluateDeadlines({
      kind: 'utility-model',
      filingDate: date('2025-02-10'),
      claimsPriority: false,
      notices: [{ kind: 'office-action-first', delivery, stage: 'substantive' }],
      today: date('2026-09-20'),
    }, base)).toThrow(/实质审查阶段/)
    expect(() => evaluateDeadlines({
      ...invention,
      notices: [{ kind: 'office-action-subsequent', delivery, stage: 'preliminary' }],
    }, base)).toThrow(/office-action-first/)
  })

  it('keeps a recorded notice pending when its delivery record lacks the required date', () => {
    const query: DeadlineQuery = {
      ...invention,
      notices: [{ kind: 'office-action-first', delivery: {} }],
    }
    const report = evaluateDeadlines(query, base)
    expect(report.computed.some(entry => entry.id === 'oa-response-first')).toBe(false)
    expect(report.pending.find(entry => entry.id === 'oa-response-first')).toMatchObject({
      legalBasis: '专利审查指南第五部分第七章第2.1节',
      requiredInput: 'office-action-first.delivery（电子送达需要发文日（dispatchDate）或电子系统进入日（enteredDate）。）',
    })
  })

  it('keeps registration and divisional filing pending when the grant notice lacks a delivery date', () => {
    const query: DeadlineQuery = {
      ...invention,
      notices: [{ kind: 'grant-notice', delivery: {} }],
    }
    const report = evaluateDeadlines(query, base)
    expect(report.computed.some(entry => entry.id === 'registration')).toBe(false)
    expect(report.pending.find(entry => entry.id === 'registration')?.requiredInput)
      .toContain('grant-notice.delivery（')
    expect(report.pending.find(entry => entry.id === 'divisional-application')?.requiredInput)
      .toContain('grant-notice.delivery（')
  })

  it('counts PCT national-phase dates from the international filing date without priority', () => {
    const query: DeadlineQuery = {
      kind: 'utility-model',
      filingDate: date('2023-07-15'),
      claimsPriority: false,
      isPctNationalPhase: true,
      today: date('2026-09-20'),
    }
    expect(find(query, 'pct-national-entry')).toMatchObject({
      dueDate: '2026-01-15',
      label: '办理进入中国国家阶段手续（自国际申请日（未主张优先权）起30个月内；缴纳宽限费后可延至32个月）',
    })
  })

  it('treats the PCT application fee as an entry formality counted from the 30-month period', () => {
    const query: DeadlineQuery = {
      kind: 'invention',
      filingDate: date('2024-01-01'),
      claimsPriority: false,
      isPctNationalPhase: true,
      nationalPhaseEntryDate: date('2025-07-01'),
      today: date('2025-07-10'),
    }
    // The entry date does not start a separate fee period: 细则第121条 requires
    // the fee when entering, and 细则第120条 bounds the entry at 30 months.
    expect(find(query, 'application-fee')).toMatchObject({
      dueDate: '2026-07-01',
      rawDueDate: '2026-07-01',
      legalBasis: '专利法实施细则第121条、第120条',
      label: '在办理进入中国国家阶段手续时缴纳申请费、公布印刷费、必要的申请附加费'
        + '（自国际申请日（未主张优先权）起30个月内办理进入手续；缴纳宽限费后可延至32个月）',
    })
  })

  it('counts the 30-month entry period from the priority date when priority is claimed', () => {
    const query: DeadlineQuery = {
      kind: 'invention',
      filingDate: date('2024-01-01'),
      claimsPriority: true,
      priorityDate: date('2023-01-01'),
      isPctNationalPhase: true,
      today: date('2025-07-10'),
    }
    expect(find(query, 'application-fee')).toMatchObject({ dueDate: '2025-07-01' })
  })

  it('counts the PCT priority claim fee from the national-phase entry date', () => {
    const query: DeadlineQuery = {
      kind: 'invention',
      filingDate: date('2024-01-01'),
      claimsPriority: true,
      priorityDate: date('2023-01-01'),
      isPctNationalPhase: true,
      nationalPhaseEntryDate: date('2025-07-01'),
      today: date('2025-07-10'),
    }
    expect(find(query, 'priority-claim-fee')).toMatchObject({
      dueDate: '2025-09-01',
      legalBasis: '专利法实施细则第127条',
      label: '缴纳优先权要求费（自进入中国国家阶段之日起2个月内）',
    })
    expect(pendingIds(query)).not.toContain('priority-claim-fee')
  })

  it('keeps the PCT priority claim fee pending until the entry date is recorded', () => {
    const query: DeadlineQuery = {
      kind: 'invention',
      filingDate: date('2024-01-01'),
      claimsPriority: true,
      priorityDate: date('2023-01-01'),
      isPctNationalPhase: true,
      today: date('2025-07-10'),
    }
    const report = evaluateDeadlines(query, base)
    expect(report.computed.some(entry => entry.id === 'priority-claim-fee')).toBe(false)
    expect(report.pending.find(entry => entry.id === 'priority-claim-fee')).toMatchObject({
      legalBasis: '专利法实施细则第127条',
      requiredInput: 'nationalPhaseEntryDate（进入中国国家阶段之日）',
    })
  })

  it('omits the PCT priority claim fee for an international application without priority', () => {
    const query: DeadlineQuery = {
      kind: 'invention',
      filingDate: date('2024-01-01'),
      claimsPriority: false,
      isPctNationalPhase: true,
      nationalPhaseEntryDate: date('2025-07-01'),
      today: date('2025-07-10'),
    }
    expect(find(query, 'priority-claim-fee')).toBeUndefined()
    expect(pendingIds(query)).not.toContain('priority-claim-fee')
  })

  it('computes the new-drug compensation request from the marketing approval date', () => {
    const query: DeadlineQuery = {
      ...invention,
      marketingApprovalDate: date('2026-07-01'),
    }
    expect(find(query, 'new-drug-compensation-request')).toMatchObject({
      dueDate: '2026-10-01',
      legalBasis: '专利法第42条第3款、专利法实施细则第81条',
    })
  })

  it('rejects compensation and paid-through values outside their domain', () => {
    expect(() => evaluateDeadlines({ ...invention, paidThroughYear: -1 }, base))
      .toThrow(/paidThroughYear/)
    expect(() => evaluateDeadlines({ ...invention, paidThroughYear: 1.5 }, base))
      .toThrow(/paidThroughYear/)
    expect(() => evaluateDeadlines({ ...invention, paidThroughYear: 21 }, base))
      .toThrow(/超出专利权期限/)
    expect(() => evaluateDeadlines({ ...invention, termCompensationYears: 6 }, base))
      .toThrow(/termCompensationYears/)
    expect(() => evaluateDeadlines({ ...invention, termCompensationYears: -1 }, base))
      .toThrow(/termCompensationYears/)
    expect(() => evaluateDeadlines({
      kind: 'utility-model',
      filingDate: date('2024-01-10'),
      claimsPriority: false,
      termCompensationYears: 2,
      today: date('2026-09-20'),
    }, base)).toThrow(/只适用于发明专利/)

    let designMessage = ''
    try {
      evaluateDeadlines({
        kind: 'design',
        filingDate: date('2024-03-10'),
        claimsPriority: false,
        paidThroughYear: 16,
        today: date('2026-09-20'),
      }, base)
    } catch (error) {
      if (error instanceof Error) designMessage = error.message
    }
    expect(designMessage).toContain('超出专利权期限')
    expect(designMessage).not.toContain('termCompensationYears')
  })

  it('names every patent category and propagates unexpected calendar failures', () => {
    expect(describePatentKind('invention')).toBe('发明专利')
    expect(describePatentKind('utility-model')).toBe('实用新型专利')
    expect(describePatentKind('design')).toBe('外观设计专利')
    class BrokenCalendar extends WorkCalendar {
      override rollForward(): never {
        throw new Error('calendar exploded')
      }
    }
    expect(() => evaluateDeadlines(invention, { calendar: new BrokenCalendar([]), reminderLeadDays: 30 }))
      .toThrow('calendar exploded')
  })

  it('computes both PCT national-phase dates from the priority date', () => {
    const query: DeadlineQuery = {
      kind: 'invention',
      filingDate: date('2023-07-15'),
      claimsPriority: true,
      priorityDate: date('2023-01-15'),
      isPctNationalPhase: true,
      today: date('2026-09-20'),
    }
    expect(find(query, 'pct-national-entry')).toMatchObject({
      dueDate: '2025-07-15',
      legalBasis: '专利法实施细则第120条',
    })
    expect(find(query, 'pct-national-entry-grace')).toMatchObject({ dueDate: '2025-09-15' })
  })

  it('computes the term-compensation request from the grant publication date', () => {
    const query: DeadlineQuery = { ...invention, authorizationPublicationDate: date('2026-06-10') }
    expect(find(query, 'term-compensation-request')).toMatchObject({
      dueDate: '2026-09-10',
      status: 'overdue',
      legalBasis: '专利法第42条第2款、专利法实施细则第77条',
    })
  })

  it('warns on a deployment horizon rather than a fixed one', () => {
    const query: DeadlineQuery = { ...invention, today: date('2026-09-25') }
    const strict = { calendar: base.calendar, reminderLeadDays: 5000 }
    expect(find(query, 'patent-term', strict)?.status).toBe('urgent')
    expect(find(query, 'patent-term', base)?.status).toBe('normal')
  })

  it('marks an end date outside the holiday arrangement instead of rolling it', () => {
    const query: DeadlineQuery = {
      kind: 'invention',
      filingDate: date('2023-10-01'),
      claimsPriority: false,
      today: date('2026-09-20'),
    }
    // The packaged calendar covers 2025-2026, so the 2043 term date is unverified.
    const calendar = loadWorkCalendar()
    const term = find(query, 'patent-term', { calendar, reminderLeadDays: 30 })
    expect(term).toMatchObject({ dueDate: '2043-10-01', calendarCaveat: 'calendar-uncovered-year:2043' })
    // 申请日 2023-10-01 + 3年 = 2026-10-01, the first day of 国庆节 → 2026-10-08.
    const exam = find(query, 'substantive-exam-request', { calendar, reminderLeadDays: 30 })
    expect(exam).toMatchObject({ rawDueDate: '2026-10-01', dueDate: '2026-10-08', rolledForward: true })
  })

  it('sorts computed deadlines chronologically', () => {
    const { computed } = evaluateDeadlines(invention, base)
    const dates = computed.map(entry => entry.dueDate)
    expect([...dates].sort()).toEqual(dates)
  })
})
