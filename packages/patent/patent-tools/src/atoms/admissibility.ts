/**
 * 受理条件原子（admissibility）：无效宣告与复审的程序性受理条件核对。
 *
 * 受理条件先于实体理由：请求是否在期限内提出、是否援引了法定理由、是否与在先决定
 * 构成一事不再理、主体是否适格。本原子只做可机械核对的部分：
 * - 期限：复审请求自收到驳回决定之日起 3 个月（专利法第41条第1款），按细则第5条起算；
 *   无效宣告没有请求期限，报告写明不适用。逾期但已办理恢复权利手续的降为提示。
 * - 理由援引：没有任何理由，或全部理由处于否定表述中，都视为未援引法定理由
 *   （专利审查指南第四部分第三章3.3）。
 * - 一事不再理：与在先无效宣告审查决定的理由、证据标识全部相同时阻断；仅理由相同
 *   时降为提示，由人工判断是否「实质相同」（同指南3.3与第四部分第三章2.1）。
 * - 主体资格：复审请求人应为被驳回申请的申请人，二者不一致时提示。
 *
 * 请求书份数、委托书、主体证明等文书形式需要人工核对，报告固定写明未评估；
 * 理由是否属于驳回决定所涉范围需要驳回决定原文，本原子不猜。
 */

import {
  degraded,
  isMonthOnlyDate,
  parseDateFlexible,
  type Atom,
  type PipelineState,
  type StageExecuteInput,
  type StageHandler,
} from '@deepseek-ai/dsh-patent-core'
import {
  compareCalendarDates,
  formatCalendarDate,
  loadWorkCalendar,
  periodEnd,
  type CalendarDate,
  type WorkCalendar,
} from '@deepseek-ai/dsh-patent-deadline'

/** 本原子适用的程序类型（与 contested manifest 的 `program` 取值一致）。 */
/** 本原子适用的程序类型（与 contested manifest 的 `program` 取值一致）。 */
type AdmissibilityCaseType = 'invalidation' | 'reexamination'

/** 程序类型的合法取值，用于报错文案与校验。 */
const ADMISSIBILITY_CASE_TYPES: readonly AdmissibilityCaseType[] = ['invalidation', 'reexamination']

/** 违规严重度：阻断项使 `admissibility_passed` 为 false，提示项只报告。 */
export type AdmissibilitySeverity = 'block' | 'warn'

/** 一条受理条件违规。 */
export type AdmissibilityViolation = {
  /** 稳定规则代码（ADM-*）。 */
  code: string
  /** 阻断或提示。 */
  severity: AdmissibilitySeverity
  /** 可复核的中文说明。 */
  message: string
}

/** 需要补充输入、尚不能判定的事项。 */
export type AdmissibilityPending = {
  /** 稳定规则代码（ADM-*）。 */
  code: string
  /** 可复核的中文说明。 */
  message: string
}

/** 程序类型所在的状态键（由 manifest 的阶段参数给出）。 */
const DEFAULT_ADMISSIBILITY_CASE_TYPE_KEY = 'case_type'

/** 理由识别产出所在的状态键。 */
const DEFAULT_ADMISSIBILITY_GROUNDS_KEY = 'grounds'

/** 驳回决定送达日所在的状态键。 */
const DEFAULT_ADMISSIBILITY_DELIVERY_KEY = 'rejection_decision_date'

/** 复审请求提交日所在的状态键。 */
const DEFAULT_ADMISSIBILITY_REQUEST_KEY = 'request_date'

/** 恢复权利手续标志所在的状态键。 */
const DEFAULT_ADMISSIBILITY_RECOVERY_KEY = 'recovery_requested'

/** 在先无效宣告审查决定所在的状态键。 */
const DEFAULT_ADMISSIBILITY_PRIOR_KEY = 'prior_invalidation_decision'

/** 请求人所在的状态键。 */
const DEFAULT_ADMISSIBILITY_REQUESTER_KEY = 'requester'

/** 申请人／专利权人所在的状态键。 */
const DEFAULT_ADMISSIBILITY_OWNER_KEY = 'patentee'

/** 证据清单所在的状态键（用于一事不再理的证据标识比对）。 */
const DEFAULT_ADMISSIBILITY_EVIDENCE_KEY = 'evidence'

/** 复审请求期限：自收到驳回决定之日起 3 个月（专利法第41条第1款，细则第5条起算）。 */
const REEXAMINATION_REQUEST_PERIOD = { unit: 'month', count: 3 } as const

/** admissibility 原子：核对无效/复审的程序性受理条件。 */
export const admissibilityAtom: Atom = {
  name: 'admissibility',
  description:
    '受理条件核对：复审请求期限、法定理由是否被实质援引、与在先决定是否构成一事不再理、复审主体资格；缺理由识别产出时报告未执行。`admissibility_passed` 只表示无阻断项，待核项见 `admissibility_pending`，两者须一起读',
  category: 'gate',
  inputSchema: [
    DEFAULT_ADMISSIBILITY_CASE_TYPE_KEY,
    DEFAULT_ADMISSIBILITY_GROUNDS_KEY,
    DEFAULT_ADMISSIBILITY_DELIVERY_KEY,
    DEFAULT_ADMISSIBILITY_REQUEST_KEY,
    DEFAULT_ADMISSIBILITY_RECOVERY_KEY,
    DEFAULT_ADMISSIBILITY_PRIOR_KEY,
    DEFAULT_ADMISSIBILITY_REQUESTER_KEY,
    DEFAULT_ADMISSIBILITY_OWNER_KEY,
    DEFAULT_ADMISSIBILITY_EVIDENCE_KEY,
  ],
  outputSchema: [
    'admissibility_report',
    'admissibility_passed',
    'admissibility_violations',
    'admissibility_pending',
  ],
}

/** 一条理由识别结果中本原子需要读取的字段。 */
type GroundEntry = {
  ground: string
  negated: boolean
}

/**
 * 判断值是否为普通对象。
 * @param value - 待判定的值。
 * @returns 是否为非数组对象。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 解析程序类型。
 * @param state - 阶段执行态。
 * @returns 程序类型；取值未知时为 undefined。
 */
function resolveCaseType(state: PipelineState): AdmissibilityCaseType | undefined {
  const raw = state[DEFAULT_ADMISSIBILITY_CASE_TYPE_KEY]
  if (typeof raw !== 'string') return undefined
  return (ADMISSIBILITY_CASE_TYPES as readonly string[]).includes(raw)
    ? (raw as AdmissibilityCaseType)
    : undefined
}

/**
 * 解析理由识别产出（`grounds` 原子写回的 JSON 字符串，或已是数组）。
 * @param raw - 原始值。
 * @returns 理由条目，或解析失败原因。
 */
function parseGrounds(raw: unknown): { grounds: GroundEntry[] } | { error: string } {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return { error: `state.${DEFAULT_ADMISSIBILITY_GROUNDS_KEY} 不是合法 JSON` }
    }
  }
  if (!Array.isArray(value)) {
    return { error: `state.${DEFAULT_ADMISSIBILITY_GROUNDS_KEY} 不是理由数组` }
  }
  const grounds: GroundEntry[] = []
  for (const [index, item] of value.entries()) {
    if (!isRecord(item) || typeof item['ground'] !== 'string') {
      return { error: `state.${DEFAULT_ADMISSIBILITY_GROUNDS_KEY}[${index}] 缺少 ground 字段` }
    }
    grounds.push({ ground: item['ground'], negated: item['negated'] === true })
  }
  return { grounds }
}

/**
 * 读取日期字段。缺失与格式错误分开：缺失进入待核，格式错误降级。
 *
 * 解析用 `parseDateFlexible`（与工具入参校验、evidence-check 同一口径），因此
 * `2026/03/01`、`2026年3月1日` 这类写成同一日历日的输入都能接受；换用严格的
 * `parseCalendarDate` 会让工具边界放行的值在阶段内降级。
 * @param state - 阶段执行态。
 * @param key - 状态键。
 * @returns 解析出的日期、缺失标记或错误原因。
 */
function readDate(
  state: PipelineState,
  key: string,
): { date: CalendarDate } | { missing: true } | { imprecise: string } | { error: string } {
  const raw = state[key]
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return { missing: true }
  }
  if (typeof raw !== 'string') return { error: `state.${key} 必须是日期字符串` }
  // 期限起算点必须精确到日：`2026-03` 会被解析成 3 月 1 日，若实际送达在月末，
  // 按 1 日起算会把合法请求判成逾期。只到年月的记未评估，其余非法写法仍降级。
  if (isMonthOnlyDate(raw)) return { imprecise: raw }
  const parsed = parseDateFlexible(raw)
  if (parsed === null) return { error: `state.${key} 不是可识别的日期：${raw}` }
  return {
    date: {
      year: parsed.getUTCFullYear(),
      month: parsed.getUTCMonth() + 1,
      day: parsed.getUTCDate(),
    },
  }
}

/**
 * 读取非空字符串字段。
 * @param state - 阶段执行态。
 * @param key - 状态键。
 * @returns 去空白后的字符串；缺失或空串时返回 undefined。
 */
function readText(state: PipelineState, key: string): string | undefined {
  const raw = state[key]
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  return text.length > 0 ? text : undefined
}

/** 在先决定的解析结果。 */
type PriorDecision =
  | { grounds: string[]; evidenceIds?: string[] }
  | { unusable: string }
  | { absent: true }

/**
 * 解析在先无效宣告审查决定。
 * @param raw - 原始值（对象或 JSON 字符串）。
 * @returns 解析结果。
 */
function parsePriorDecision(raw: unknown): PriorDecision {
  if (raw === undefined || raw === null) return { absent: true }
  let value: unknown = raw
  if (typeof raw === 'string') {
    if (raw.trim() === '') return { absent: true }
    try {
      value = JSON.parse(raw)
    } catch {
      return { unusable: `state.${DEFAULT_ADMISSIBILITY_PRIOR_KEY} 不是合法 JSON` }
    }
  }
  if (!isRecord(value)) return { unusable: `state.${DEFAULT_ADMISSIBILITY_PRIOR_KEY} 不是对象` }
  const groundsRaw = value['grounds']
  if (!Array.isArray(groundsRaw) || !groundsRaw.every(item => typeof item === 'string')) {
    return { unusable: `state.${DEFAULT_ADMISSIBILITY_PRIOR_KEY}.grounds 必须是字符串数组` }
  }
  const evidenceRaw = value['evidenceIds']
  if (evidenceRaw !== undefined && (!Array.isArray(evidenceRaw) || !evidenceRaw.every(item => typeof item === 'string'))) {
    return { unusable: `state.${DEFAULT_ADMISSIBILITY_PRIOR_KEY}.evidenceIds 必须是字符串数组` }
  }
  return {
    grounds: groundsRaw,
    ...(evidenceRaw === undefined ? {} : { evidenceIds: evidenceRaw }),
  }
}

/**
 * 证据标识的候选字段，按优先级排列：稳定标识在前，展示名在后。
 *
 * `evidenceIds`（在先决定里记的证据）用同一套优先级，因此带 `id` 的证据一律以 `id`
 * 参与比对；evidence-check 的报告显示名另有一套优先级（title 优先），两者不要混抄。
 */
const EVIDENCE_ID_FIELDS = ['id', 'evidenceId', 'publicationNumber', 'patentNumber', 'title', 'name'] as const

/**
 * 收集当前证据清单的标识。
 *
 * 无清单、清单不是数组、或清单里没有任何可识别标识时返回 undefined：这三种情况
 * 都不能拿去和「在先决定的证据标识」比较——未提供的清单不等于一份不同的清单。
 * @param state - 阶段执行态。
 * @returns 证据标识数组；清单缺失或不可用时为 undefined。
 */
function evidenceIds(state: PipelineState): string[] | undefined {
  const raw = state[DEFAULT_ADMISSIBILITY_EVIDENCE_KEY]
  if (!Array.isArray(raw)) return undefined
  const ids: string[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    for (const field of EVIDENCE_ID_FIELDS) {
      const value = item[field]
      if (typeof value === 'string' && value.trim().length > 0) {
        ids.push(value.trim())
        break
      }
    }
  }
  return ids.length > 0 ? ids : undefined
}

/**
 * 两个标识集合是否完全相同（与顺序无关）。
 * @param left - 第一个集合。
 * @param right - 第二个集合。
 * @returns 是否相等。
 */
function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const a = [...left].sort()
  const b = [...right].sort()
  return a.every((value, index) => value === b[index])
}

/** 一次核对的结果。 */
type Verdict = {
  violations: AdmissibilityViolation[]
  pending: AdmissibilityPending[]
  /** 报告行，按检查顺序排列。 */
  lines: string[]
}

/**
 * 核对复审请求期限。
 * @param state - 阶段执行态。
 * @param verdict - 结果累加器。
 * @returns 日期录入错误的降级原因；无错误时为 undefined。
 */
function checkReexaminationDeadline(
  state: PipelineState,
  verdict: Verdict,
  calendar: WorkCalendar,
): string | undefined {
  const delivery = readDate(state, DEFAULT_ADMISSIBILITY_DELIVERY_KEY)
  if ('error' in delivery) return delivery.error
  if ('imprecise' in delivery) {
    verdict.pending.push({
      code: 'ADM-TIME-DECISION-DATE',
      message: `驳回决定送达日只到年月（${delivery.imprecise}），期限起算点不精确，期限未评估`,
    })
    verdict.lines.push('- 请求期限：未评估（送达日未精确到日）')
    return undefined
  }
  if ('missing' in delivery) {
    verdict.pending.push({
      code: 'ADM-TIME-DECISION-DATE',
      message: `未提供驳回决定送达日（state.${DEFAULT_ADMISSIBILITY_DELIVERY_KEY}），期限未评估`,
    })
    verdict.lines.push('- 请求期限：未评估（缺驳回决定送达日）')
    return undefined
  }
  const request = readDate(state, DEFAULT_ADMISSIBILITY_REQUEST_KEY)
  if ('error' in request) return request.error
  if ('imprecise' in request) {
    verdict.pending.push({
      code: 'ADM-TIME-REQUEST-DATE',
      message: `复审请求提交日只到年月（${request.imprecise}），期限未评估`,
    })
    verdict.lines.push('- 请求期限：未评估（请求日未精确到日）')
    return undefined
  }
  if ('missing' in request) {
    verdict.pending.push({
      code: 'ADM-TIME-REQUEST-DATE',
      message: `未提供复审请求提交日（state.${DEFAULT_ADMISSIBILITY_REQUEST_KEY}），期限未评估`,
    })
    verdict.lines.push('- 请求期限：未评估（缺复审请求提交日）')
    return undefined
  }

  const end = periodEnd(delivery.date, REEXAMINATION_REQUEST_PERIOD)
  // 届满日落在休息日时顺延到下一个工作日（细则第5条）；日历缺失或未覆盖该年度时
  // 不能凭未知就判逾期，记未评估。
  let effectiveEnd: CalendarDate
  let rolled = false
  try {
    const rolledResult = calendar.rollForward(end)
    effectiveEnd = rolledResult.date
    rolled = rolledResult.rolled
  } catch {
    verdict.pending.push({
      code: 'ADM-TIME-CALENDAR',
      message: `工作日历未覆盖期限届满日 ${formatCalendarDate(end)}，休息日顺延未评估`,
    })
    verdict.lines.push('- 请求期限：未评估（工作日历未覆盖该年度）')
    return undefined
  }
  const late = compareCalendarDates(request.date, effectiveEnd) > 0
  const endText = formatCalendarDate(effectiveEnd)
  const rollNote = rolled ? '，遇休息日顺延' : ''
  if (!late) {
    verdict.lines.push(`- 请求期限：期限内（期限届满日 ${endText}${rollNote}）`)
    return undefined
  }
  const recovered = state[DEFAULT_ADMISSIBILITY_RECOVERY_KEY] === true
  const requestText = formatCalendarDate(request.date)
  verdict.violations.push({
    code: 'ADM-TIME-REQUEST',
    severity: recovered ? 'warn' : 'block',
    message: recovered
      ? `复审请求日 ${requestText} 晚于期限届满日 ${endText}${rollNote}；已办理恢复权利手续的须经批准，本项降为提示（专利法第41条第1款）`
      : `复审请求日 ${requestText} 晚于自收到驳回决定之日起 3 个月的期限届满日 ${endText}${rollNote}（专利法第41条第1款）`,
  })
  verdict.lines.push(`- 请求期限：${recovered ? '逾期（已办恢复手续）' : '逾期'}（期限届满日 ${endText}${rollNote}）`)
  return undefined
}

/**
 * 核对理由是否被实质援引。
 * @param grounds - 理由条目。
 * @param verdict - 结果累加器。
 */
function checkGrounds(grounds: readonly GroundEntry[], verdict: Verdict): void {
  const cited = grounds.filter(entry => !entry.negated)
  if (grounds.length === 0) {
    verdict.violations.push({
      code: 'ADM-GROUNDS-ABSENT',
      severity: 'block',
      message: '请求未援引任何法定理由，受理条件不成立（专利审查指南第四部分第三章3.3）',
    })
    verdict.lines.push('- 理由援引：未识别到任何理由')
    return
  }
  if (cited.length === 0) {
    verdict.violations.push({
      code: 'ADM-GROUNDS-NEGATED',
      severity: 'block',
      message: `识别到 ${String(grounds.length)} 条理由，但全部处于否定表述中，视为未援引（专利审查指南第四部分第三章3.3）`,
    })
    verdict.lines.push(`- 理由援引：${String(grounds.length)} 条理由均处于否定表述中`)
    return
  }
  const labels = cited.map(entry => entry.ground).join('、')
  verdict.lines.push(`- 理由援引：${String(cited.length)} 条（${labels}）`)
}

/**
 * 核对一事不再理。
 *
 * 只有两边都提供了证据标识才比较证据；缺任何一边都记未评估，不能把「没有清单」
 * 读成「清单不同」——后者会得到一句事实错误的结论，并让遗漏的输入通过受理条件。
 * @param state - 阶段执行态。
 * @param cited - 被实质援引的理由标识。
 * @param verdict - 结果累加器。
 * @returns 在先决定录入错误的降级原因；无错误时为 undefined。
 */
function checkResJudicata(state: PipelineState, cited: readonly string[], verdict: Verdict): string | undefined {
  const prior = parsePriorDecision(state[DEFAULT_ADMISSIBILITY_PRIOR_KEY])
  if ('absent' in prior) {
    verdict.pending.push({
      code: 'ADM-RES-JUDICATA',
      message: `未提供在先无效宣告审查决定（state.${DEFAULT_ADMISSIBILITY_PRIOR_KEY}），一事不再理未评估`,
    })
    verdict.lines.push('- 一事不再理：未评估（缺在先决定）')
    return undefined
  }
  if ('unusable' in prior) return prior.unusable
  const overlap = prior.grounds.filter(ground => cited.includes(ground))
  if (overlap.length === 0) {
    verdict.lines.push('- 一事不再理：本次理由与在先决定不同')
    return undefined
  }
  if (prior.evidenceIds === undefined) {
    verdict.pending.push({
      code: 'ADM-RES-JUDICATA-EVIDENCE',
      message: `在先决定（state.${DEFAULT_ADMISSIBILITY_PRIOR_KEY}）未载明证据标识，一事不再理的证据比对未评估`,
    })
    verdict.lines.push('- 一事不再理：理由相同；在先决定未载明证据标识，未评估')
    return undefined
  }
  const currentEvidence = evidenceIds(state)
  if (currentEvidence === undefined) {
    verdict.pending.push({
      code: 'ADM-RES-JUDICATA-EVIDENCE',
      message: `未提供带标识的证据清单（state.${DEFAULT_ADMISSIBILITY_EVIDENCE_KEY}），一事不再理的证据比对未评估`,
    })
    verdict.lines.push('- 一事不再理：理由相同；本次证据清单未提供，未评估')
    return undefined
  }
  const evidenceSame = sameSet(prior.evidenceIds, currentEvidence)
  const groundsSame = sameSet(prior.grounds, cited)
  if (evidenceSame && groundsSame) {
    verdict.violations.push({
      code: 'ADM-RES-JUDICATA',
      severity: 'block',
      message: `本次理由与证据均与在先决定相同（${overlap.join('、')}），属于一事不再理（专利审查指南第四部分第三章2.1）`,
    })
    verdict.lines.push('- 一事不再理：理由与证据均相同')
    return undefined
  }
  // 结论行按两侧的实际差异渲染：「理由部分相同」与「证据相同」是两种不同的提示，
  // 用一句固定文案会把证据相同说成证据不同。
  const difference = groundsSame && !evidenceSame
    ? '理由相同、证据不同'
    : !groundsSame && evidenceSame
      ? '理由部分相同、证据相同'
      : '理由部分相同、证据不同'
  verdict.violations.push({
    code: 'ADM-RES-JUDICATA',
    severity: 'warn',
    message: `${difference}（${overlap.join('、')}），是否构成「实质相同」以及在先决定是否已考虑该理由或证据须人工判断（专利审查指南第四部分第三章2.1）`,
  })
  verdict.lines.push(`- 一事不再理：${difference}，需人工判断是否实质相同`)
  return undefined
}

/**
 * 核对复审主体资格。
 * @param state - 阶段执行态。
 * @param verdict - 结果累加器。
 */
function checkParty(state: PipelineState, verdict: Verdict): void {
  const requester = readText(state, DEFAULT_ADMISSIBILITY_REQUESTER_KEY)
  const owner = readText(state, DEFAULT_ADMISSIBILITY_OWNER_KEY)
  if (requester === undefined || owner === undefined) {
    verdict.lines.push('- 主体资格：未评估（缺请求人或申请人信息）')
    return
  }
  if (requester !== owner) {
    verdict.violations.push({
      code: 'ADM-PARTY',
      severity: 'warn',
      message: `复审请求人「${requester}」与申请人「${owner}」不一致；复审请求应由被驳回申请的申请人提出（专利法第41条第1款）`,
    })
    verdict.lines.push('- 主体资格：请求人与申请人不一致')
    return
  }
  verdict.lines.push('- 主体资格：请求人与申请人一致')
}

/**
 * 渲染受理条件报告。
 * @param caseType - 程序类型。
 * @param verdict - 核对结果。
 * @returns 模型可读的中文报告。
 */
function renderReport(caseType: AdmissibilityCaseType, verdict: Verdict): string {
  const blocks = verdict.violations.filter(item => item.severity === 'block').length
  const warns = verdict.violations.filter(item => item.severity === 'warn').length
  const verdictText = blocks > 0 ? '不通过' : warns > 0 ? '通过（有提示项）' : '通过'
  const label = caseType === 'invalidation' ? '无效宣告' : '复审'
  const lines = [
    `受理条件核对（${label}）：${verdictText}（阻断 ${String(blocks)} 项，提示 ${String(warns)} 项，待核 ${String(verdict.pending.length)} 项）`,
    ...verdict.lines,
  ]
  if (caseType === 'invalidation') {
    lines.splice(1, 0, '- 请求期限：不适用（无效宣告没有请求期限约束）')
  }
  for (const item of verdict.violations) {
    lines.push(`- [${item.severity === 'block' ? '阻断' : '提示'}] ${item.code}：${item.message}`)
  }
  for (const item of verdict.pending) {
    lines.push(`- [待核] ${item.code}：${item.message}`)
  }
  lines.push(
    '- 形式文书（请求书份数、委托书、主体证明）：未评估，需人工核对',
    '限制说明：本原子只核对期限、理由援引、一事不再理与主体资格；理由是否属于驳回决定所涉范围、请求书格式与证据证明力仍需人工复核。',
  )
  return lines.join('\n')
}

/** admissibility 执行器：核对无效/复审的程序性受理条件。 */
export class AdmissibilityHandler implements StageHandler {
  readonly name = 'admissibility'
  readonly category = 'gate' as const

  /** 注入的工作日历；缺省时按需加载随包的 cn-holidays.yaml。 */
  private readonly injectedCalendar: WorkCalendar | undefined
  /** 加载结果缓存；undefined 表示尚未加载。 */
  private loadedCalendar: WorkCalendar | undefined

  /**
   * @param deps - 可选依赖；`calendar` 由测试或部署注入，覆盖随包日历。
   */
  constructor(deps: { calendar?: WorkCalendar } = {}) {
    this.injectedCalendar = deps.calendar
  }

  /**
   * 取工作日历：注入的优先，否则加载随包资产。
   *
   * 加载失败不在此吞掉——随包资产缺失属于打包缺陷，应像 patent-deadline 自身那样
   * 显式失败，而不是把每个案件的期限检查悄悄降成「未评估」。
   * @returns 工作日历。
   */
  private resolveCalendar(): WorkCalendar {
    if (this.injectedCalendar !== undefined) return this.injectedCalendar
    this.loadedCalendar ??= loadWorkCalendar()
    return this.loadedCalendar
  }

  /**
   * 执行受理条件核对。
   * @param input - 阶段执行输入（程序类型、理由识别产出与程序日期）。
   * @returns 报告（主输出）、是否通过、违规项与待核项。
   */
  // oxlint-disable-next-line typescript/require-await -- StageHandler contract requires async execute
  async execute(input: StageExecuteInput): Promise<PipelineState> {
    const state = input.state
    const caseType = resolveCaseType(state)
    if (caseType === undefined) {
      return degraded(
        'admissibility',
        `params.${DEFAULT_ADMISSIBILITY_CASE_TYPE_KEY} 必须是 ${ADMISSIBILITY_CASE_TYPES.join(' / ')} 之一`,
      )
    }

    const rawGrounds = state[DEFAULT_ADMISSIBILITY_GROUNDS_KEY]
    if (rawGrounds === undefined) {
      return {
        admissibility_report: [
          `受理条件核对（${caseType === 'invalidation' ? '无效宣告' : '复审'}）：未执行（未识别程序理由）`,
          `- 未找到 state.${DEFAULT_ADMISSIBILITY_GROUNDS_KEY}；本阶段未核对请求期限、理由援引、一事不再理与主体资格`,
          '限制说明：本原子只核对期限、理由援引、一事不再理与主体资格；请求书格式与证据证明力仍需人工复核。',
        ].join('\n'),
        admissibility_passed: true,
        admissibility_violations: [],
        admissibility_pending: [],
      }
    }

    const parsed = parseGrounds(rawGrounds)
    if ('error' in parsed) return degraded('admissibility', parsed.error)

    const verdict: Verdict = { violations: [], pending: [], lines: [] }
    checkGrounds(parsed.grounds, verdict)
    if (caseType === 'reexamination') {
      const deadlineError = checkReexaminationDeadline(state, verdict, this.resolveCalendar())
      if (deadlineError !== undefined) return degraded('admissibility', deadlineError)
      checkParty(state, verdict)
    } else {
      const resJudicataError = checkResJudicata(
        state,
        parsed.grounds.filter(entry => !entry.negated).map(entry => entry.ground),
        verdict,
      )
      if (resJudicataError !== undefined) return degraded('admissibility', resJudicataError)
    }

    const passed = !verdict.violations.some(item => item.severity === 'block')
    return {
      admissibility_report: renderReport(caseType, verdict),
      admissibility_passed: passed,
      admissibility_violations: verdict.violations,
      admissibility_pending: verdict.pending,
    }
  }
}
