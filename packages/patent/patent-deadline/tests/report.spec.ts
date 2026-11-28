import { describe, expect, it } from 'vitest'
import { formatCalendarDate } from '../src/calendar.ts'
import { renderDeadlineReport } from '../src/report.ts'
import { evaluateDeadlines, type DeadlineQuery, type DeadlineReport } from '../src/statutes.ts'
import { loadWorkCalendar } from '../src/work-calendar.ts'

const OPTIONS = { calendar: loadWorkCalendar(), reminderLeadDays: 30 }

/** One invention claiming priority, granted, with a postal first office action. */
const grantedCase: DeadlineQuery = {
  kind: 'invention',
  filingDate: { year: 2023, month: 10, day: 1 },
  claimsPriority: true,
  priorityDate: { year: 2022, month: 9, day: 15 },
  authorizationPublicationDate: { year: 2026, month: 9, day: 1 },
  notices: [{
    kind: 'office-action-first',
    delivery: { mode: 'postal', dispatchDate: { year: 2026, month: 8, day: 20 } },
  }],
  today: { year: 2026, month: 9, day: 20 },
}

const META = {
  kind: 'invention',
  filingDate: '2023-10-01',
  today: '2026-09-20',
  claimsPriority: true,
  priorityDate: '2022-09-15',
} as const

/** Render the report for a case, deriving the heading from that case's own inputs. */
function render(query: DeadlineQuery): string {
  return renderDeadlineReport(evaluateDeadlines(query, OPTIONS), {
    kind: query.kind,
    filingDate: formatCalendarDate(query.filingDate),
    today: formatCalendarDate(query.today),
    claimsPriority: query.claimsPriority,
    ...(query.priorityDate === undefined ? {} : { priorityDate: formatCalendarDate(query.priorityDate) }),
  })
}

function row(text: string, label: string): string {
  const line = text.split('\n').find(candidate => candidate.startsWith(`| ${label}`))
  if (line === undefined) throw new Error(`the report has no row for ${label}`)
  return line
}

describe('deadline report rendering', () => {
  it('names the case, the basis date, the priority basis, and the criterion before the table', () => {
    const lines = render(grantedCase).split('\n')
    expect(lines[0]).toBe(
      'patent_deadlines: 发明专利 · 申请日 2023-10-01 · 基准日 2026-09-20 · 主张优先权（优先权日 2022-09-15）',
    )
    expect(lines[2]).toBe(
      '期限口径：已应用专利法实施细则第5条的届满日顺延（届满日为法定休假日或移用周休息日的，'
      + '顺延至其后第一个工作日）；表中「原始届满日（未顺延）」列为不顺延的原始届满日。',
    )
    const { priorityDate: _dropped, ...withoutPriorityDate } = grantedCase
    expect(render({ ...withoutPriorityDate, claimsPriority: false })).toContain(
      '· 基准日 2026-09-20 · 未主张优先权',
    )
  })

  it('renders every computed entry with its reported date, raw date, countdown, status, and legal basis', () => {
    const text = render(grantedCase)
    expect(text).toContain('可计算期限 10 项（已逾期 5 项，1 项临近）。')
    expect(text).toContain('| 期限事项 | 届满日 | 原始届满日（未顺延） | 剩余 | 状态 | 法律依据 |')
    expect(text).toContain('| --- | --- | --- | --- | --- | --- |')
    // 2026-10-01 is 国庆, so the reported date rolls while the raw date stays visible.
    expect(row(text, '缴纳第4年度年费')).toBe(
      '| 缴纳第4年度年费（授予专利权当年以后的年费应在上一年度期满前缴纳） | 2026-10-08 | 2026-10-01 | 18 天 '
      + '| 🔴 紧急 | 专利法实施细则第115条 |',
    )
    // An un-rolled entry reports one date: the raw column stays empty.
    expect(row(text, '请求实质审查')).toBe(
      '| 请求实质审查并缴纳审查费（自优先权日起3年） | 2025-09-15 | — | 已逾期 370 天 '
      + '| ⛔ 已逾期 | 专利法第35条 |',
    )
  })

  it('lists the deadlines that still need a notice delivery record instead of approximating them', () => {
    const text = render(grantedCase)
    expect(text).toContain('无法计算的期限 8 项——需补充下列记录后重算，本工具不以固定年数代替通知书送达日：')
    expect(text).toContain(
      '- 提出分案申请（须在办理登记手续期限届满前）（专利法实施细则第48条、第60条第1款）'
      + '｜缺少：grant-notice（授权通知的送达记录）｜分案申请须在办理登记手续期限届满前提出，该期限自收到授权通知之日起算。',
    )
  })

  it('names the year whose holiday arrangement is missing rather than the caveat token', () => {
    const text = render(grantedCase)
    expect(text).toContain('⚠️ 下列届满日未应用顺延规则（本地节假日安排未覆盖 2023、2024、2027、2043 年）：')
    expect(text).toContain('2043-10-01（专利权期限届满（20年，自申请日起算））。')
    expect(text).not.toContain('calendar-uncovered-year')
    expect(row(text, '专利权期限届满')).toBe(
      '| 专利权期限届满（20年，自申请日起算） | 2043-10-01 ⚠️ | — | 6220 天 '
      + '| 🟢 正常 | 专利法第42条第1款 |',
    )
  })

  it('reports the un-rolled criterion without consulting the holiday arrangement', () => {
    const text = render({ ...grantedCase, restDayRule: 'omit' })
    expect(text).toContain(
      '期限口径：**不顺延**——每个期限只报其自身届满日，未应用专利法实施细则第5条的顺延规则。'
      + '此口径适用于记录期限本身（如专利权期限届满日），答复、缴费类期限请改用顺延口径。',
    )
    expect(text).not.toContain('⚠️')
    expect(row(text, '缴纳第4年度年费')).toBe(
      '| 缴纳第4年度年费（授予专利权当年以后的年费应在上一年度期满前缴纳） | 2026-10-01 | — | 11 天 '
      + '| 🔴 紧急 | 专利法实施细则第115条 |',
    )
  })

  it('lists the six-month annual-fee surcharge windows after the table', () => {
    const text = render(grantedCase)
    expect(text).toContain('年费补缴窗口（逾期后 6 个月内仍可补缴并缴滞纳金，期满未缴专利权自应缴年费期满之日起终止）：')
    // The window starts at the fee's reported (rolled) due date; the window end
    // rolls under the same criterion and names an uncovered year.
    expect(text).toContain(
      '- 缴纳第4年度年费（授予专利权当年以后的年费应在上一年度期满前缴纳）：2026-10-08 起算，'
      + '最迟 2027-04-08（窗口终点所在 2027 年节假日安排未覆盖，未应用顺延）。',
    )
    expect(text).toContain(
      '- 缴纳第5年度年费（授予专利权当年以后的年费应在上一年度期满前缴纳）：2027-10-01 起算，'
      + '最迟 2028-04-01（窗口终点所在 2028 年节假日安排未覆盖，未应用顺延）。',
    )
  })

  it('states the recovery and extension rules once an entry is overdue', () => {
    expect(render(grantedCase)).toContain(
      '已逾期项请先判断是否仍在救济期内：因不可抗拒的事由延误的，可自障碍消除之日起2个月内'
      + '且自期限届满之日起2年内请求恢复权利；因其他正当理由延误的，可自收到通知之日起2个月内'
      + '请求恢复（延误复审请求期限的，自该期限届满之日起2个月内），并缴纳恢复权利请求费'
      + '（专利法实施细则第6条）。专利权期限（专利法第42条）与优先权期限（专利法第29条）'
      + '不适用恢复（专利法实施细则第6条第5款）。指定期限在届满前还可请求延长，延长不超过两个月'
      + '（专利审查指南第五部分第七章第4.2节）；但无效宣告请求审查程序中指定的期限不得延长'
      + '（专利法实施细则第75条）。',
    )
    expect(render({ ...grantedCase, today: { year: 2019, month: 1, day: 1 } })).not.toContain('已逾期项请先判断')
  })

  it('renders the delivery rule that started each notice-driven period', () => {
    const text = render(grantedCase)
    expect(text).toContain('起算依据（通知书送达规则）：')
    expect(text).toContain('- 答复第一次审查意见通知书（指定期限，实质审查程序中为4个月）：')
    expect(text).toContain('满15日')
  })

  it('does not offer recovery for a period excluded by 细则第6条第5款', () => {
    const report: DeadlineReport = {
      computed: [{
        id: 'patent-term',
        label: '专利权期限届满（20年，自申请日起算）',
        legalBasis: '专利法第42条第1款',
        rawDueDate: '2020-01-01',
        dueDate: '2020-01-01',
        daysRemaining: -1,
        status: 'overdue',
        rolledForward: false,
      }],
      pending: [],
      restDayRule: 'apply',
    }
    const text = renderDeadlineReport(report, META)
    expect(text).not.toContain('已逾期项请先判断')
    expect(text).toContain('不适用恢复权利（专利法实施细则第6条第5款）')
  })

  it('states the paid-through year so omitted annual fees are explained', () => {
    const text = renderDeadlineReport(
      { computed: [], pending: [], restDayRule: 'apply' },
      { ...META, paidThroughYear: 8 },
    )
    expect(text).toContain('年费记录：已缴至第 8 年度（含该年度），之前年度不再列出。')
  })

  it('renders a priority claim whose date the caller did not supply', () => {
    const { priorityDate: _dropped, ...meta } = META
    const text = renderDeadlineReport(
      { computed: [], pending: [], restDayRule: 'apply' },
      meta,
    )
    expect(text.split('\n')[0]).toBe(
      'patent_deadlines: 发明专利 · 申请日 2023-10-01 · 基准日 2026-09-20 · 主张优先权',
    )
  })

  it('keeps a PCT case alive until the 32-month grace window closes', () => {
    const pctCase = (today: { year: number; month: number; day: number }): DeadlineQuery => ({
      kind: 'utility-model',
      filingDate: { year: 2023, month: 7, day: 15 },
      claimsPriority: false,
      isPctNationalPhase: true,
      today,
    })
    // 30 个月（2026-01-15）已过、32 个月（2026-03-15）未到：正是缴宽限费的窗口。
    const inGrace = render(pctCase({ year: 2026, month: 2, day: 1 }))
    expect(inGrace).toContain('宽限期未满')
    expect(inGrace).not.toContain('效力终止')

    const afterGrace = render(pctCase({ year: 2026, month: 4, day: 1 }))
    expect(afterGrace).toContain('效力终止')
  })

  it('reports an empty result without inventing a deadline', () => {
    const empty: DeadlineReport = { computed: [], pending: [], restDayRule: 'apply' }
    expect(renderDeadlineReport(empty, META)).toBe([
      'patent_deadlines: 发明专利 · 申请日 2023-10-01 · 基准日 2026-09-20 · 主张优先权（优先权日 2022-09-15）',
      '',
      '期限口径：已应用专利法实施细则第5条的届满日顺延（届满日为法定休假日或移用周休息日的，顺延至其后第一个工作日）；表中「原始届满日（未顺延）」列为不顺延的原始届满日。',
      '',
      '本次查询未产出可计算的期限。',
    ].join('\n'))
  })
})
