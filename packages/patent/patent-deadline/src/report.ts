/**
 * Model-facing rendering of a deadline report.
 * @module @deepseek-ai/dsh-patent-deadline/report
 */

import {
  describePatentKind,
  UNCOVERED_YEAR_CAVEAT_PREFIX,
  type ComputedDeadline,
  type DeadlineReport,
  type LatePaymentWindow,
  type PatentKind,
} from './statutes.ts'

/** Context the report prose names, so the model does not have to restate it. */
export type DeadlineReportMeta = {
  kind: PatentKind
  filingDate: string
  today: string
  /** Whether the case claims priority, as supplied by the caller. */
  claimsPriority: boolean
  /** The priority date, when one applies. */
  priorityDate?: string
  /** Last patent year recorded as paid, when the caller supplied one. */
  paidThroughYear?: number
}

const STATUS_LABEL = {
  overdue: '⛔ 已逾期',
  urgent: '🔴 紧急',
  normal: '🟢 正常',
} as const

/**
 * Periods that 专利法实施细则第6条第5款 excludes from restoration.
 * 第24条与第74条规定的期限不是本引擎计算的期限项。
 */
const RECOVERY_EXCLUDED_IDS: ReadonlySet<string> = new Set(['patent-term', 'priority-window'])

/**
 * Periods whose lapse terminates the international application's effect in
 * China; 专利法实施细则第122条 excludes them from restoration.
 */
const PCT_ENTRY_IDS: ReadonlySet<string> = new Set(['pct-national-entry', 'pct-national-entry-grace'])

/**
 * Render a deadline report as Markdown: computed deadlines in chronological
 * order, then the deadlines that still need a notice, then the caveats that
 * qualify the dates above.
 * @param report - the evaluated report.
 * @param meta - case context for the heading.
 * @returns the Markdown report.
 */
export function renderDeadlineReport(report: DeadlineReport, meta: DeadlineReportMeta): string {
  const priority = meta.claimsPriority
    ? ` · 主张优先权${meta.priorityDate !== undefined ? `（优先权日 ${meta.priorityDate}）` : ''}`
    : ' · 未主张优先权'
  const lines: string[] = [
    `patent_deadlines: ${describePatentKind(meta.kind)} · 申请日 ${meta.filingDate} · 基准日 ${meta.today}${priority}`,
    '',
  ]

  lines.push(
    report.restDayRule === 'apply'
      ? '期限口径：已应用专利法实施细则第5条的届满日顺延（届满日为法定休假日或移用周休息日的，顺延至其后第一个工作日）；表中「原始届满日（未顺延）」列为不顺延的原始届满日。'
      : '期限口径：**不顺延**——每个期限只报其自身届满日，未应用专利法实施细则第5条的顺延规则。此口径适用于记录期限本身（如专利权期限届满日），答复、缴费类期限请改用顺延口径。',
    '',
  )

  if (meta.paidThroughYear !== undefined) {
    lines.push(
      `年费记录：已缴至第 ${String(meta.paidThroughYear)} 年度（含该年度），之前年度不再列出。`,
      '',
    )
  }

  if (report.computed.length === 0) {
    lines.push('本次查询未产出可计算的期限。', '')
  } else {
    const overdue = report.computed.filter(entry => entry.status === 'overdue').length
    const urgent = report.computed.filter(entry => entry.status === 'urgent').length
    lines.push(
      `可计算期限 ${String(report.computed.length)} 项（已逾期 ${String(overdue)} 项，${String(urgent)} 项临近）。`,
      '',
      '| 期限事项 | 届满日 | 原始届满日（未顺延） | 剩余 | 状态 | 法律依据 |',
      '| --- | --- | --- | --- | --- | --- |',
    )
    for (const entry of report.computed) {
      const remaining = entry.daysRemaining < 0
        ? `已逾期 ${String(-entry.daysRemaining)} 天`
        : `${String(entry.daysRemaining)} 天`
      const caveat = entry.calendarCaveat !== undefined ? ' ⚠️' : ''
      const raw = entry.rolledForward ? entry.rawDueDate : '—'
      lines.push(
        `| ${entry.label} | ${entry.dueDate}${caveat} | ${raw} | ${remaining} | ${STATUS_LABEL[entry.status]} | ${entry.legalBasis} |`,
      )
    }
    lines.push('')
  }

  const triggered = report.computed.filter(
    (entry): entry is ComputedDeadline & { triggerBasis: string } => entry.triggerBasis !== undefined,
  )
  if (triggered.length > 0) {
    lines.push('起算依据（通知书送达规则）：', '')
    for (const entry of triggered) {
      lines.push(`- ${entry.label}：${entry.triggerBasis}`)
    }
    lines.push('')
  }

  if (report.pending.length > 0) {
    lines.push(
      `无法计算的期限 ${String(report.pending.length)} 项——需补充下列记录后重算，本工具不以固定年数代替通知书送达日：`,
      '',
    )
    for (const entry of report.pending) {
      lines.push(`- ${entry.label}（${entry.legalBasis}）｜缺少：${entry.requiredInput}｜${entry.reason}`)
    }
    lines.push('')
  }

  const caveats = report.computed.filter(
    (entry): entry is ComputedDeadline & { calendarCaveat: string } => entry.calendarCaveat !== undefined,
  )
  if (caveats.length > 0) {
    // The prose names the years; the prefixed token stays in the structured
    // result for machine consumers.
    const years = [...new Set(caveats.map(entry =>
      entry.calendarCaveat.slice(UNCOVERED_YEAR_CAVEAT_PREFIX.length)))].sort()
    lines.push(
      `⚠️ 下列届满日未应用顺延规则（本地节假日安排未覆盖 ${years.join('、')} 年）：`
      + `${caveats.map(entry => `${entry.dueDate}（${entry.label}）`).join('；')}。`,
      '',
    )
  }

  const lateWindows = report.computed.filter(
    (entry): entry is ComputedDeadline & { latePaymentWindow: LatePaymentWindow } =>
      entry.latePaymentWindow !== undefined,
  )
  if (lateWindows.length > 0) {
    lines.push('年费补缴窗口（逾期后 6 个月内仍可补缴并缴滞纳金，期满未缴专利权自应缴年费期满之日起终止）：', '')
    for (const entry of lateWindows) {
      const window = entry.latePaymentWindow
      const caveat = window.calendarCaveat === undefined
        ? ''
        : `（窗口终点所在 ${window.calendarCaveat.slice(UNCOVERED_YEAR_CAVEAT_PREFIX.length)} 年`
          + '节假日安排未覆盖，未应用顺延）'
      lines.push(`- ${entry.label}：${window.from} 起算，最迟 ${window.to}${caveat}。`)
    }
    lines.push('')
  }

  // 细则第6条第5款 excludes the patent term and the priority window from restoration;
  // 细则第122条 excludes a lapsed PCT national-phase entry.
  const overdueEntries = report.computed.filter(entry => entry.status === 'overdue')
  const excluded = overdueEntries.filter(entry => RECOVERY_EXCLUDED_IDS.has(entry.id))
  const pctEntries = overdueEntries.filter(entry => PCT_ENTRY_IDS.has(entry.id))
  const recoverable = overdueEntries.filter(entry =>
    !RECOVERY_EXCLUDED_IDS.has(entry.id) && !PCT_ENTRY_IDS.has(entry.id))
  if (recoverable.length > 0) {
    lines.push(
      '已逾期项请先判断是否仍在救济期内：因不可抗拒的事由延误的，可自障碍消除之日起2个月内'
      + '且自期限届满之日起2年内请求恢复权利；因其他正当理由延误的，可自收到通知之日起2个月内'
      + '请求恢复（延误复审请求期限的，自该期限届满之日起2个月内），并缴纳恢复权利请求费'
      + '（专利法实施细则第6条）。专利权期限（专利法第42条）与优先权期限（专利法第29条）'
      + '不适用恢复（专利法实施细则第6条第5款）。指定期限在届满前还可请求延长，延长不超过两个月'
      + '（专利审查指南第五部分第七章第4.2节）；但无效宣告请求审查程序中指定的期限不得延长'
      + '（专利法实施细则第75条）。',
    )
  } else if (excluded.length > 0) {
    lines.push(
      '已逾期项为专利权期限或优先权期限，二者不适用恢复权利（专利法实施细则第6条第5款）。',
    )
  }
  if (pctEntries.length > 0) {
    lines.push(
      'PCT 国家阶段的进入期限（专利法实施细则第120条）届满未办理的，国际申请在中国的效力终止，'
      + '不适用恢复（专利法实施细则第122条）；30个月期限可在缴纳宽限费后延至32个月'
      + '（宽限期限已单列）。',
    )
  }

  return lines.join('\n').trimEnd()
}
