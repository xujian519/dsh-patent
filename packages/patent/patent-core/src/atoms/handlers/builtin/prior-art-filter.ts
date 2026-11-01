/**
 * 检索域原子：prior-art-filter（现有技术时间过滤）。
 *
 * 包装 `evidence/date.ts` 的公开日认定与截止日比较，按 A22.5 只保留截止日前公开的
 * 文献；A24 的四种首次公开情形在宽限期内发生时，标注为不破坏新颖性并从 `prior_art`
 * 中排除。宽限期基准取最早的有效优先权日，无优先权时才用申请日；主张优先权但日期
 * 无法解析时不回退到申请日，而是标为未判定。A24 还要求公开来源与情形匹配（申请人
 * 自己公开、他人从申请人处得知，或 A24.4 的未经同意泄露），来源未知同样不认定。
 * 截止日与申请日必须是具体日期：月级输入无法确定边界，降级而不是按月初或月末猜测。
 * 缺少公开日或宽限期无法判定的文献保留并单列，避免把未知状态误判为非现有技术。
 *
 * 过滤后的每篇文献保留原始检索位次 `dLabel`（D1、D2……），供 citation-check 在
 * 数组缩短后仍按原标号校验引用；未标注 A24 或标注落在宽限期外的公开仍作为现有技术。
 */

import { type Atom } from '../../atom.ts'
import {
  type PipelineState,
  type StageExecuteInput,
  type StageHandler,
  getStateString,
} from '../../handler.ts'
import {
  determinePublicationDate,
  isBeforeReferenceDate,
  isMonthOnlyDate,
  parseDateFlexible,
  type PriorArtReference,
} from '../../../evidence/date.ts'
import { degraded } from './llm.ts'
import { isRecord, resolveConfiguredKey } from './state-keys.ts'

/** A24 四种不丧失新颖性的首次公开情形。 */
export const A24_EXCEPTION_LABELS = {
  'A24.1': '国家出现紧急状态或者非常情况时，为公共利益目的首次公开',
  'A24.2': '在中国政府主办或者承认的国际展览会上首次展出',
  'A24.3': '在规定的学术会议或者技术会议上首次发表',
  'A24.4': '他人未经申请人同意而泄露其内容',
} as const

/** A24 情形的枚举值。 */
export type A24Exception = keyof typeof A24_EXCEPTION_LABELS

/** 检索条目中公开日的默认字段名。 */
export const DEFAULT_PRIOR_ART_PUBLICATION_DATE_KEY = 'publicationDate'

/** 检索条目中 A24 标注的默认字段名。 */
export const DEFAULT_PRIOR_ART_A24_EXCEPTION_KEY = 'a24Exception'

/** 状态中优先权日的默认键；值可以是单个日期字符串或日期字符串数组。 */
const DEFAULT_PRIORITY_DATE_KEY = 'priority_date'

/** 检索条目中 A24 公开来源的默认字段名。 */
const DEFAULT_A24_DISCLOSURE_SOURCE_KEY = 'a24DisclosureSource'

/**
 * A24 公开来源：申请人自己公开、他人从申请人处得知、他人未经同意的泄露，或未标注。
 *
 * A24.1–A24.3 只适用于申请人一侧的首次公开，A24.4 只适用于他人未经同意的泄露；
 * 来源与情形不匹配或来源未知时不认定宽限期。
 */
type A24DisclosureSource =
  | 'applicant'
  | 'derived-from-applicant'
  | 'unauthorized-disclosure'
  | 'unknown'

/** 每种 A24 情形允许的公开来源。 */
const A24_ALLOWED_SOURCES: Record<A24Exception, readonly A24DisclosureSource[]> = {
  'A24.1': ['applicant', 'derived-from-applicant'],
  'A24.2': ['applicant', 'derived-from-applicant'],
  'A24.3': ['applicant', 'derived-from-applicant'],
  'A24.4': ['unauthorized-disclosure'],
}

/** A24 宽限期基准：可判定的日期与来源，或不可判定的原因。 */
type GraceBaseline =
  | { status: 'resolved'; date: string; basis: 'priority-date' | 'filing-date' }
  | { status: 'unverifiable'; reason: string }

/** 单条 A24 标注的判定结果。 */
type GraceAssessment = {
  index: number
  label: string
  title: string
  publicationDate?: string
  a24Exception: A24Exception
  disclosureSource: A24DisclosureSource
} & (
  | { status: 'within-period' }
  | { status: 'outside-period'; reason: string }
  | { status: 'unverifiable'; reason: string }
)

/** prior-art-filter 原子：按截止日与 A24 宽限期过滤检索结果。 */
export const priorArtFilterAtom: Atom = {
  name: 'prior-art-filter',
  description:
    '现有技术时间过滤：只保留截止日前公开的文献；A24 四种首次公开以最早优先权日（无则申请日）为基准，来源未知或日期不可解析时不认定；未知公开日保留待核实',
  category: 'search',
  inputSchema: ['prior_art', 'reference_date', 'reference_basis', 'filing_date', 'priority_date'],
  outputSchema: [
    'prior_art_filter_report',
    'prior_art',
    'prior_art_excluded',
    'prior_art_undated',
    'a24_grace',
    'prior_art_grace',
  ],
}

/** 被排除的条目：保留原始位次与判定依据。 */
type ExcludedEntry = {
  index: number
  label: string
  title: string
  publicationDate: string
  reason: 'not-prior-art' | 'a24-grace-period'
  a24Exception?: A24Exception
  disclosureSource?: A24DisclosureSource
}

/** 无法确定公开日但保留下来的条目。 */
type UndatedEntry = {
  index: number
  label: string
  title: string
  reason: string
}

/** 单篇文献的公开日读取结果：认定成功带日期，否则带原因。 */
type PublicationDateResolution =
  | { date: string; reason?: undefined }
  | { date?: undefined; reason: string }

/** 条目的可读名称：标题 > 专利号 > URL > 位次。 */
function entryTitle(doc: unknown, index: number): string {
  if (!isRecord(doc)) return `#${index + 1}`
  for (const key of ['title', 'patent', 'url']) {
    const value = doc[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return `#${index + 1}`
}

/** 为保留条目补上原始检索位次；已有标注时不覆盖。 */
function withDLabel(doc: unknown, label: string): unknown {
  if (!isRecord(doc)) return doc
  return typeof doc.dLabel === 'string' && doc.dLabel.trim().length > 0 ? doc : { ...doc, dLabel: label }
}

/**
 * 读取并认定条目的公开日。
 * @param doc - 检索条目。
 * @param key - 公开日字段名。
 * @param reference - 截止日。
 * @returns 认定后的公开日，或无法认定的原因。
 */
function resolvePublicationDate(
  doc: unknown,
  key: string,
  reference: PriorArtReference,
): PublicationDateResolution {
  if (!isRecord(doc)) return { reason: '条目不是对象，无法读取公开日' }
  const raw = doc[key]
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    return { reason: `${key} 不是字符串` }
  }
  const claimed = typeof raw === 'string' ? raw.trim() : ''
  const url = typeof doc.url === 'string' ? doc.url : undefined
  const determination = determinePublicationDate(claimed, url, reference)
  if (determination.determined === '' || determination.determined === 'unknown') {
    return { reason: claimed.length > 0 ? `公开日无法解析：${claimed}` : '缺少公开日' }
  }
  return { date: determination.determined }
}

/**
 * 读取 A24 标注。
 * @param doc - 检索条目。
 * @param key - A24 标注字段名。
 * @returns 标注值；字段缺失时为空，非法时返回错误原因。
 */
function resolveA24Exception(doc: unknown, key: string): { value?: A24Exception; error?: string } {
  if (!isRecord(doc)) return {}
  const raw = doc[key]
  if (raw === undefined || raw === null) return {}
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { error: `${key} 必须是非空字符串（A24.1..A24.4）` }
  }
  const value = raw.trim()
  if (!(value in A24_EXCEPTION_LABELS)) {
    return { error: `${key} 不是 A24.1..A24.4：${value}` }
  }
  return { value: value as A24Exception }
}

/** 优先权日读取结果：可用日期列表，或需要降级/标为未判定的原因。 */
type PriorityDatesResolution =
  | { status: 'ok'; dates: string[] }
  | { status: 'malformed'; reason: string }
  | { status: 'unverifiable'; reason: string }

/**
 * 读取优先权日列表。
 *
 * 字符串数组的每一项都可解析才视为可用；任一项仅精确到月或无法解析时，最早的优先权日
 * 不可确定，整组标为未判定，不回退到申请日。
 * @param raw - 状态中的优先权日值。
 * @param key - 优先权日所在的状态键。
 * @returns 可用的日期列表或问题。
 */
function resolvePriorityDates(raw: unknown, key: string): PriorityDatesResolution {
  if (raw === undefined || raw === null) return { status: 'ok', dates: [] }
  const entries = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : undefined
  if (entries === undefined) return { status: 'malformed', reason: `${key} 必须是字符串或字符串数组` }
  const dates: string[] = []
  for (const entry of entries) {
    if (typeof entry !== 'string') return { status: 'malformed', reason: `${key} 的每一项必须是字符串` }
    const trimmed = entry.trim()
    if (trimmed === '') continue
    if (isMonthOnlyDate(trimmed)) {
      return { status: 'unverifiable', reason: `${key} 含仅精确到月的优先权日：${trimmed}` }
    }
    if (parseDateFlexible(trimmed) === null) {
      return { status: 'unverifiable', reason: `${key} 含无法解析的优先权日：${trimmed}` }
    }
    dates.push(trimmed)
  }
  return { status: 'ok', dates }
}

/**
 * 计算 A24 宽限期基准：最早的有效优先权日；无优先权时用申请日。
 * @param filingDate - 已解析的申请日。
 * @param filingText - 申请日原文。
 * @param priority - 优先权日读取结果。
 * @returns 可判定的基准，或不可判定的原因。
 */
function resolveGraceBaseline(
  filingDate: Date | undefined,
  filingText: string,
  priority: PriorityDatesResolution,
): GraceBaseline {
  if (priority.status === 'unverifiable') return { status: 'unverifiable', reason: priority.reason }
  /* v8 ignore next -- malformed priority values degrade before this point. */
  if (priority.status === 'malformed') return { status: 'unverifiable', reason: priority.reason }
  const candidates: { date: string; time: number; basis: 'priority-date' | 'filing-date' }[] = []
  if (filingDate !== undefined) {
    candidates.push({ date: filingText, time: filingDate.getTime(), basis: 'filing-date' })
  }
  for (const date of priority.dates) {
    const parsed = parseDateFlexible(date)
    /* v8 ignore next -- resolvePriorityDates only returns parseable dates. */
    if (parsed === null) continue
    candidates.push({ date, time: parsed.getTime(), basis: 'priority-date' })
  }
  if (candidates.length === 0) {
    return { status: 'unverifiable', reason: '缺少申请日与优先权日，A24 宽限期无法起算' }
  }
  const earliest = candidates.reduce((best, candidate) => (candidate.time < best.time ? candidate : best))
  return { status: 'resolved', date: earliest.date, basis: earliest.basis }
}

/**
 * 读取 A24 公开来源。
 * @param doc - 检索条目。
 * @param key - 公开来源字段名。
 * @returns 来源；字段缺失时为空（unknown），非法时返回错误原因。
 */
function resolveA24DisclosureSource(doc: unknown, key: string): { value: A24DisclosureSource; error?: string } {
  if (!isRecord(doc)) return { value: 'unknown' }
  const raw = doc[key]
  if (raw === undefined || raw === null) return { value: 'unknown' }
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {
      value: 'unknown',
      error: `${key} 必须是非空字符串（applicant|derived-from-applicant|unauthorized-disclosure|unknown）`,
    }
  }
  const value = raw.trim()
  if (value === 'unknown') return { value: 'unknown' }
  if (value !== 'applicant' && value !== 'derived-from-applicant' && value !== 'unauthorized-disclosure') {
    return { value: 'unknown', error: `${key} 不是已知来源：${value}` }
  }
  return { value }
}

/** 申请日前六个月对应的日历日；月末日期收敛到目标月最后一天。 */
function monthsBefore(date: Date, months: number): Date {
  const targetYear = date.getUTCFullYear()
  const targetMonth = date.getUTCMonth() - months
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(date.getUTCDate(), lastDay)))
}

/** 判断公开日是否落在基准日前六个月（含起点、不含基准日；全程 UTC）。 */
function withinGracePeriod(publicationDate: string, baselineDate: Date): boolean {
  const publication = parseDateFlexible(publicationDate)
  /* v8 ignore next -- determinePublicationDate only emits parseable dates. */
  if (publication === null) return false
  const start = monthsBefore(baselineDate, 6)
  return publication.getTime() >= start.getTime() && publication.getTime() < baselineDate.getTime()
}

/**
 * 判定一条 A24 标注：公开日、基准日与公开来源都可用时才给出期内/期外结论。
 * @param entry - 条目的位次、标号、标题与公开日。
 * @param exception - A24 情形。
 * @param disclosureSource - 公开来源。
 * @param baseline - 宽限期基准。
 * @returns 判定结果。
 */
function assessGrace(
  entry: { index: number; label: string; title: string; publicationDate: string | undefined },
  exception: A24Exception,
  disclosureSource: A24DisclosureSource,
  baseline: GraceBaseline,
): GraceAssessment {
  const base = {
    index: entry.index,
    label: entry.label,
    title: entry.title,
    a24Exception: exception,
    disclosureSource,
  }
  if (entry.publicationDate === undefined) {
    return { ...base, status: 'unverifiable', reason: '公开日未知' }
  }
  if (baseline.status === 'unverifiable') {
    return { ...base, publicationDate: entry.publicationDate, status: 'unverifiable', reason: baseline.reason }
  }
  if (!A24_ALLOWED_SOURCES[exception].includes(disclosureSource)) {
    return {
      ...base,
      publicationDate: entry.publicationDate,
      status: 'unverifiable',
      reason: `公开来源 ${disclosureSource} 不属于 ${exception} 允许的来源`,
    }
  }
  const baselineDate = parseDateFlexible(baseline.date)
  /* v8 ignore next -- resolveGraceBaseline only returns parseable dates. */
  if (baselineDate === null) {
    return {
      ...base,
      publicationDate: entry.publicationDate,
      status: 'unverifiable',
      reason: '基准日无法解析',
    }
  }
  if (withinGracePeriod(entry.publicationDate, baselineDate)) {
    return { ...base, publicationDate: entry.publicationDate, status: 'within-period' }
  }
  return {
    ...base,
    publicationDate: entry.publicationDate,
    status: 'outside-period',
    reason: `公开日 ${entry.publicationDate} 在宽限期外（基准日 ${baseline.date} 前 6 个月内）`,
  }
}

/**
 * 生成 A24 判定的报告说明。
 * @param assessment - 判定结果。
 * @returns 一行说明。
 */
function graceNote(assessment: Exclude<GraceAssessment, { status: 'within-period' }>): string {
  const prefix = `${assessment.label} 标注 ${assessment.a24Exception}`
  if (assessment.status === 'unverifiable') {
    return `${prefix}，但${assessment.reason}，A24 未判定（暂按现有技术保留）`
  }
  return `${prefix}，但${assessment.reason}，A24 不适用`
}

/** 过滤报告的输入：保留/排除计数、A24 基准与逐条原因。 */
type FilterReportInput = {
  kept: number
  excluded: readonly ExcludedEntry[]
  undated: readonly UndatedEntry[]
  notes: readonly string[]
  referenceDate: string
  basisLabel: string
  graceBaseline: GraceBaseline
  total: number
}

/**
 * 渲染过滤报告。
 * @param report - 计数、排除与待核实条目、说明、截止日与 A24 基准。
 * @returns 供 `prior_art_filter_report` 输出的多行文本。
 */
function renderFilterReport(report: FilterReportInput): string {
  const lines = [
    `现有技术过滤：保留 ${report.kept} 篇，排除 ${report.excluded.length} 篇（截止日 ${report.referenceDate}，${report.basisLabel}；A22.5）`,
    report.graceBaseline.status === 'resolved'
      ? `A24 宽限期基准：${report.graceBaseline.date}（${report.graceBaseline.basis === 'priority-date' ? '优先权日' : '申请日'}）`
      : `A24 宽限期基准：未判定（${report.graceBaseline.reason}）`,
  ]
  for (const entry of report.excluded) {
    const reason =
      entry.reason === 'a24-grace-period' && entry.a24Exception !== undefined
        ? `A24 宽限期（${entry.a24Exception}：${A24_EXCEPTION_LABELS[entry.a24Exception]}），不破坏新颖性`
        : '公开日不早于截止日，不属于现有技术'
    lines.push(`- ${entry.label} ${entry.title}：公开日 ${entry.publicationDate}，${reason}`)
  }
  for (const entry of report.undated) {
    lines.push(`- ${entry.label} ${entry.title}：${entry.reason}，保留待人工核实`)
  }
  for (const note of report.notes) {
    lines.push(`- 注意：${note}`)
  }
  if (report.total === 0) {
    lines.push('- 检索结果为空，无需过滤')
  }
  return lines.join('\n')
}

/** 阶段读取的状态键与条目字段名。 */
type FilterKeys = {
  priorArt: string
  reference: string
  filing: string
  priority: string
  publication: string
  exception: string
  source: string
}

/** 参数键解析结果：全部合法，或首个非法参数的原因。 */
type FilterKeysResolution =
  | { status: 'ok'; keys: FilterKeys }
  | { status: 'error'; reason: string }

/**
 * 解析阶段参数中可配置的状态键与字段名。
 * @param state - 阶段执行态（`params` 携带覆盖值）。
 * @returns 全部键，或首个非法参数的原因。
 */
function resolveFilterKeys(state: PipelineState): FilterKeysResolution {
  const priorArt = resolveConfiguredKey(state, 'prior_art_key', 'prior_art')
  if (priorArt === undefined) return { status: 'error', reason: 'params.prior_art_key 必须是非空字符串' }
  const reference = resolveConfiguredKey(state, 'reference_date_key', 'reference_date')
  if (reference === undefined) return { status: 'error', reason: 'params.reference_date_key 必须是非空字符串' }
  const filing = resolveConfiguredKey(state, 'filing_date_key', 'filing_date')
  if (filing === undefined) return { status: 'error', reason: 'params.filing_date_key 必须是非空字符串' }
  const priority = resolveConfiguredKey(state, 'priority_date_key', DEFAULT_PRIORITY_DATE_KEY)
  if (priority === undefined) return { status: 'error', reason: 'params.priority_date_key 必须是非空字符串' }
  const publication = resolveConfiguredKey(
    state,
    'publication_date_key',
    DEFAULT_PRIOR_ART_PUBLICATION_DATE_KEY,
  )
  if (publication === undefined) return { status: 'error', reason: 'params.publication_date_key 必须是非空字符串' }
  const exception = resolveConfiguredKey(state, 'a24_exception_key', DEFAULT_PRIOR_ART_A24_EXCEPTION_KEY)
  if (exception === undefined) return { status: 'error', reason: 'params.a24_exception_key 必须是非空字符串' }
  const source = resolveConfiguredKey(state, 'a24_disclosure_source_key', DEFAULT_A24_DISCLOSURE_SOURCE_KEY)
  if (source === undefined) return { status: 'error', reason: 'params.a24_disclosure_source_key 必须是非空字符串' }
  return { status: 'ok', keys: { priorArt, reference, filing, priority, publication, exception, source } }
}

/** prior-art-filter 执行器：按截止日与 A24 宽限期过滤检索结果。 */
export class PriorArtFilterHandler implements StageHandler {
  readonly name = 'prior-art-filter'
  readonly category = 'search' as const

  /**
   * 执行现有技术过滤。
   * @param input - 阶段执行输入（state 携带检索结果、截止日、申请日与优先权日）。
   * @returns `prior_art_filter_report`（主输出）、过滤后的 `prior_art`、被排除与待核实条目，
   * 以及 A24 基准与逐条判定结果。
   */
  // oxlint-disable-next-line typescript/require-await -- StageHandler contract requires async execute
  async execute(input: StageExecuteInput): Promise<PipelineState> {
    const { state } = input
    const keyResolution = resolveFilterKeys(state)
    if (keyResolution.status === 'error') return degraded('prior-art-filter', keyResolution.reason)
    const {
      priorArt: priorArtKey,
      reference: referenceKey,
      filing: filingKey,
      priority: priorityKey,
      publication: publicationKey,
      exception: exceptionKey,
      source: sourceKey,
    } = keyResolution.keys

    const rawDocs = state[priorArtKey]
    if (!Array.isArray(rawDocs)) {
      return degraded('prior-art-filter', `state.${priorArtKey} 不是数组（检索阶段未产出）`)
    }

    const referenceDate = getStateString(state, referenceKey).trim()
    if (referenceDate === '') {
      return degraded('prior-art-filter', `缺少现有技术截止日（state.${referenceKey}）`)
    }
    if (isMonthOnlyDate(referenceDate)) {
      return degraded(
        'prior-art-filter',
        `现有技术截止日（state.${referenceKey}）仅精确到月，需要具体日期（yyyy-MM-dd）：${referenceDate}`,
      )
    }
    if (parseDateFlexible(referenceDate) === null) {
      return degraded('prior-art-filter', `现有技术截止日（state.${referenceKey}）无法解析：${referenceDate}`)
    }

    const filingDateText = getStateString(state, filingKey).trim()
    if (filingDateText !== '' && isMonthOnlyDate(filingDateText)) {
      return degraded(
        'prior-art-filter',
        `申请日（state.${filingKey}）仅精确到月，A24 宽限期判定需要具体日期（yyyy-MM-dd）：${filingDateText}`,
      )
    }
    const filingDate = filingDateText === '' ? undefined : (parseDateFlexible(filingDateText) ?? undefined)
    if (filingDateText !== '' && filingDate === undefined) {
      return degraded('prior-art-filter', `申请日（state.${filingKey}）无法解析：${filingDateText}`)
    }

    const priority = resolvePriorityDates(state[priorityKey], priorityKey)
    if (priority.status === 'malformed') return degraded('prior-art-filter', priority.reason)
    const graceBaseline = resolveGraceBaseline(filingDate, filingDateText, priority)

    const basis = getStateString(state, 'reference_basis') === 'priority-date' ? 'priority-date' : 'filing-date'
    const reference: PriorArtReference = { date: referenceDate, basis }
    const kept: unknown[] = []
    const excluded: ExcludedEntry[] = []
    const undated: UndatedEntry[] = []
    const graceAssessments: GraceAssessment[] = []
    const notes: string[] = []

    for (const [index, doc] of rawDocs.entries()) {
      const label = `D${index + 1}`
      const title = entryTitle(doc, index)
      const exception = resolveA24Exception(doc, exceptionKey)
      if (exception.error !== undefined) {
        return degraded('prior-art-filter', `${label} ${exception.error}`)
      }
      const source = resolveA24DisclosureSource(doc, sourceKey)
      if (source.error !== undefined) {
        return degraded('prior-art-filter', `${label} ${source.error}`)
      }

      const publication = resolvePublicationDate(doc, publicationKey, reference)
      let assessment: GraceAssessment | undefined
      if (exception.value !== undefined) {
        assessment = assessGrace(
          { index, label, title, publicationDate: publication.date },
          exception.value,
          source.value,
          graceBaseline,
        )
        graceAssessments.push(assessment)
      }
      if (publication.date === undefined) {
        kept.push(withDLabel(doc, label))
        undated.push({
          index,
          label,
          title,
          reason: publication.reason,
        })
        if (assessment !== undefined) {
          notes.push(`${label} 标注 ${assessment.a24Exception}，但公开日未知，A24 未判定`)
        }
        continue
      }

      if (assessment !== undefined) {
        if (assessment.status === 'within-period') {
          excluded.push({
            index,
            label,
            title,
            publicationDate: publication.date,
            reason: 'a24-grace-period',
            a24Exception: assessment.a24Exception,
            disclosureSource: assessment.disclosureSource,
          })
          continue
        }
        notes.push(graceNote(assessment))
      }

      if (isBeforeReferenceDate(publication.date, referenceDate)) {
        kept.push(withDLabel(doc, label))
        continue
      }

      excluded.push({
        index,
        label,
        title,
        publicationDate: publication.date,
        reason: 'not-prior-art',
      })
    }

    const basisLabel = basis === 'priority-date' ? '优先权日' : '申请日'
    return {
      prior_art_filter_report: renderFilterReport({
        kept: kept.length,
        excluded,
        undated,
        notes,
        referenceDate,
        basisLabel,
        graceBaseline,
        total: rawDocs.length,
      }),
      prior_art: kept,
      prior_art_excluded: excluded,
      prior_art_undated: undated,
      a24_grace: graceBaseline,
      prior_art_grace: graceAssessments,
    }
  }
}
