/**
 * 比较域原子：conflicting-application（抵触申请排查）。
 *
 * 专利法 A22.2 第二句：申请日以前由任何单位或个人向国务院专利行政部门提出过、
 * 并在申请日以后（含申请日）公布的同样的发明或者实用新型，构成抵触申请，
 * 只破坏新颖性，不得与其它文件组合评价创造性。
 *
 * 本原子只做时间关系与法条后果的确定性判定；“同样的发明或者实用新型”需要语义
 * 比对，由调用方以 `sameInvention` 显式给出。缺省视为未判定并单列，不默认为
 * “是”。候选条目须是向国家知识产权局提出的申请——外国申请不适用 A22.2 第二句，
 * 由调用方在录入时保证。
 *
 * 候选来自调用方提供的 `conflicting_applications`，不读取现有技术检索结果：抵触
 * 申请在目标申请日以前尚未公布，现有技术检索（published-before-filing）按定义
 * 找不到它们。目标时间基准取 `reference_date`（time-baseline 的产出），缺失时
 * 回退到 `filing_date`。
 */

import { type Atom } from '../../atom.ts'
import { type PipelineState, type StageExecuteInput, type StageHandler } from '../../handler.ts'
import { formatIsoDate, isMonthOnlyDate, parseDateFlexible } from '../../../evidence/date.ts'
import { degraded } from './llm.ts'
import { isRecord, resolveTrimmedKey } from './state-keys.ts'

/** 候选列表默认所在的状态键。 */
export const DEFAULT_CONFLICTING_APPLICATIONS_KEY = 'conflicting_applications'

/** 目标时间基准的默认状态键（time-baseline 的产出）。 */
export const DEFAULT_TARGET_DATE_KEY = 'reference_date'

/** 目标申请日的回退状态键。 */
export const DEFAULT_TARGET_FILING_DATE_KEY = 'filing_date'

/** conflicting-application 原子：按时间关系与同样性判定抵触申请。 */
export const conflictingApplicationAtom: Atom = {
  name: 'conflicting-application',
  description:
    '抵触申请排查：申请日以前提出、申请日以后（含申请日）公布、同样的发明或者实用新型 → 仅破坏新颖性（A22.2 第二句）；同样性由调用方判定',
  category: 'compare',
  inputSchema: [
    DEFAULT_CONFLICTING_APPLICATIONS_KEY,
    DEFAULT_TARGET_DATE_KEY,
    DEFAULT_TARGET_FILING_DATE_KEY,
  ],
  outputSchema: [
    'conflicting_application_report',
    'conflicting_applications',
    'conflicting_application_excluded',
    'conflicting_application_unknown',
  ],
}

/** 已确认的抵触申请。 */
type ConfirmedConflict = {
  index: number
  label: string
  applicationNumber?: string
  publicationNumber?: string
  title: string
  applicant?: string
  effectiveFilingDate: string
  filingBasis: 'filing-date' | 'priority-date'
  publicationDate: string
  sameInvention: true
}

/** 时间关系不满足或同样性判定为否的候选项。 */
type ExcludedEntry = {
  index: number
  label: string
  id: string
  title: string
  reason: 'published-before-target' | 'filed-on-same-day' | 'filed-after-target' | 'different-invention'
  filingDate?: string
  publicationDate?: string
}

/** 无法完成时间/同样性判定、保留待核实的候选项。 */
type UnknownEntry = {
  index: number
  label: string
  id: string
  title: string
  reason: string
}

/** 日期读取结果。 */
type DateResolution = {
  date?: Date
  text?: string
  missing?: boolean
  error?: string
}

/** 目标时间基准。 */
type TargetDate = {
  date: Date
  text: string
  basis: 'filing-date' | 'priority-date' | 'unspecified'
}

/** 有效申请日：申请日与优先权日较早者。 */
type EffectiveFiling = {
  date: Date
  text: string
  basis: 'filing-date' | 'priority-date'
}

/** 状态中的非空字符串，缺失或类型不符时返回 undefined。 */
function readStateString(state: PipelineState, key: string): string | undefined {
  const raw = state[key]
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined
}

/** 读取可选文本字段；非字符串按缺失处理（不参与法律判定）。 */
function optionalText(record: Record<string, unknown>, key: string): string | undefined {
  const raw = record[key]
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : undefined
}

/**
 * 读取一个日期字段。缺失与格式错误分开：缺失进入“待定”，格式错误直接降级，
 * 避免把录入错误悄悄当成“未提供”。
 * @param record - 候选条目。
 * @param key - 字段名。
 * @returns 解析出的日期、缺失标记或错误原因。
 */
function readDateField(record: Record<string, unknown>, key: string): DateResolution {
  const raw = record[key]
  if (raw === undefined || raw === null) return { missing: true }
  if (typeof raw !== 'string') return { error: `${key} 必须是字符串` }
  const text = raw.trim()
  if (text === '') return { missing: true }
  if (isMonthOnlyDate(text)) return { error: `${key} 仅精确到月，抵触申请判定需要具体日期：${text}` }
  const date = parseDateFlexible(text)
  if (date === null) return { error: `${key} 不是可识别的日期：${text}` }
  return { date, text: formatIsoDate(date) }
}

/**
 * 解析目标时间基准：优先 `reference_date`，缺失时回退 `filing_date`。
 * 已提供但不可解析的日期不再回退，避免静默换成另一个日期。
 * @param state - 阶段执行态。
 * @returns 目标日期或错误原因。
 */
function resolveTargetDate(
  state: PipelineState,
  referenceKey: string,
  filingKey: string,
): TargetDate | { error: string } {
  const reference = readStateString(state, referenceKey)
  const filing = readStateString(state, filingKey)

  if (reference !== undefined) {
    if (isMonthOnlyDate(reference)) {
      return { error: `目标时间基准（state.${referenceKey}）仅精确到月，抵触申请判定需要具体日期：${reference}` }
    }
    const date = parseDateFlexible(reference)
    if (date === null) return { error: `目标时间基准（state.${referenceKey}）无法解析：${reference}` }
    const declared = readStateString(state, 'reference_basis')
    const basis =
      declared === 'priority-date' ? 'priority-date' : declared === 'filing-date' ? 'filing-date' : 'unspecified'
    return { date, text: formatIsoDate(date), basis }
  }

  if (filing !== undefined) {
    if (isMonthOnlyDate(filing)) {
      return { error: `目标申请日（state.${filingKey}）仅精确到月，抵触申请判定需要具体日期：${filing}` }
    }
    const date = parseDateFlexible(filing)
    if (date === null) return { error: `目标申请日（state.${filingKey}）无法解析：${filing}` }
    return { date, text: formatIsoDate(date), basis: 'filing-date' }
  }

  return { error: `缺少目标申请日/优先权日（state.${referenceKey} 或 state.${filingKey}）` }
}

/**
 * 计算在先申请的有效申请日：优先权日早于申请日时取优先权日。
 * @param filing - 申请日读取结果。
 * @param priority - 优先权日读取结果。
 * @returns 较早的有效申请日。
 */
function effectiveFiling(filing: DateResolution, priority: DateResolution): EffectiveFiling {
  /* v8 ignore next 3 -- callers only reach this after both required dates resolve. */
  if (filing.date === undefined || filing.text === undefined) {
    throw new Error('effectiveFiling called without a filing date')
  }
  if (priority.date !== undefined && priority.text !== undefined && priority.date.getTime() < filing.date.getTime()) {
    return { date: priority.date, text: priority.text, basis: 'priority-date' }
  }
  return { date: filing.date, text: filing.text, basis: 'filing-date' }
}

function targetBasisLabel(target: TargetDate): string {
  if (target.basis === 'priority-date') return '优先权日'
  if (target.basis === 'filing-date') return '申请日'
  return '时间基准'
}

function filingLabel(basis: 'filing-date' | 'priority-date'): string {
  return basis === 'priority-date' ? '有效申请日（优先权日）' : '申请日'
}

function buildReport(
  target: TargetDate,
  confirmed: ConfirmedConflict[],
  excluded: ExcludedEntry[],
  unknown: UnknownEntry[],
  supplied: boolean,
): string {
  const lines: string[] = []
  if (!supplied) {
    lines.push(
      `抵触申请排查：未提供候选（目标${targetBasisLabel(target)} ${target.text}；A22.2 第二句）`,
      '- 未提供抵触申请候选（state.conflicting_applications）；本阶段未发现抵触申请，不等同于已排除抵触申请（需在 CNIPA 申请库中检索在先申请）',
    )
    return lines.join('\n')
  }

  lines.push(
    `抵触申请排查：确认 ${confirmed.length} 件，排除 ${excluded.length} 件，待定 ${unknown.length} 件（目标${targetBasisLabel(target)} ${target.text}；A22.2 第二句）`,
  )

  for (const entry of confirmed) {
    const id = entry.publicationNumber ?? entry.applicationNumber ?? entry.label
    lines.push(
      `- ${entry.label} ${id}${entry.title === id ? '' : `《${entry.title}》`}：${filingLabel(entry.filingBasis)} ${entry.effectiveFilingDate}，公开日 ${entry.publicationDate}，构成抵触申请；仅用于新颖性判断，不得与其它文件组合评价创造性（A22.2 第二句）`,
    )
  }

  const targetLabel = targetBasisLabel(target)
  const reasonText: Record<ExcludedEntry['reason'], string> = {
    'published-before-target': `公开日早于目标${targetLabel}，属于现有技术（A22.5），应由现有技术检索/过滤处理，不按抵触申请处理`,
    'filed-on-same-day': `申请日与目标${targetLabel}相同，不属于“申请日以前”提出的申请；同日申请可能涉及 A9 重复授权，需另行核查`,
    'filed-after-target': `申请日不早于目标${targetLabel}，不属于抵触申请`,
    'different-invention': '时间条件满足，但“同样的发明或者实用新型”判定为否，不构成抵触申请',
  }

  for (const entry of excluded) {
    const dates = [
      `申请日 ${entry.filingDate}`,
      ...(entry.publicationDate !== undefined ? [`公开日 ${entry.publicationDate}`] : []),
    ]
    const prefix = `${dates.join('，')}，`
    lines.push(`- ${entry.label} ${entry.id}${entry.title === entry.id ? '' : `《${entry.title}》`}：${prefix}${reasonText[entry.reason]}`)
  }

  for (const entry of unknown) {
    lines.push(`- ${entry.label} ${entry.id}${entry.title === entry.id ? '' : `《${entry.title}》`}：${entry.reason}，保留待核实`)
  }

  if (confirmed.length === 0 && excluded.length === 0 && unknown.length === 0) {
    lines.push('- 候选列表为空，未发现抵触申请')
  }

  return lines.join('\n')
}

/** conflicting-application 执行器：判定时间关系与同样性。 */
export class ConflictingApplicationHandler implements StageHandler {
  readonly name = 'conflicting-application'
  readonly category = 'compare' as const

  /**
   * 执行抵触申请排查。
   * @param input - 阶段执行输入（候选列表 + 目标时间基准）。
   * @returns 报告（主输出）、确认列表、排除列表与待定列表。
   */
  // oxlint-disable-next-line typescript/require-await -- StageHandler contract requires async execute
  async execute(input: StageExecuteInput): Promise<PipelineState> {
    const { state } = input
    const referenceKey = resolveTrimmedKey(state, 'target_date_key', DEFAULT_TARGET_DATE_KEY)
    if (referenceKey === undefined) return degraded('conflicting-application', 'params.target_date_key 必须是非空字符串')
    const filingKey = resolveTrimmedKey(state, 'target_filing_date_key', DEFAULT_TARGET_FILING_DATE_KEY)
    if (filingKey === undefined) {
      return degraded('conflicting-application', 'params.target_filing_date_key 必须是非空字符串')
    }
    const applicationsKey = resolveTrimmedKey(
      state,
      'conflicting_applications_key',
      DEFAULT_CONFLICTING_APPLICATIONS_KEY,
    )
    if (applicationsKey === undefined) {
      return degraded('conflicting-application', 'params.conflicting_applications_key 必须是非空字符串')
    }

    const target = resolveTargetDate(state, referenceKey, filingKey)
    if ('error' in target) return degraded('conflicting-application', target.error)

    const rawList = state[applicationsKey]
    const supplied = rawList !== undefined
    if (supplied && !Array.isArray(rawList)) {
      return degraded('conflicting-application', `state.${applicationsKey} 不是数组（抵触申请候选列表）`)
    }
    const entries = Array.isArray(rawList) ? rawList : []

    const confirmed: ConfirmedConflict[] = []
    const excluded: ExcludedEntry[] = []
    const unknown: UnknownEntry[] = []

    for (const [index, raw] of entries.entries()) {
      const label = `E${index + 1}`
      if (!isRecord(raw)) {
        return degraded('conflicting-application', `${label} 条目不是对象`)
      }

      const applicationNumber = optionalText(raw, 'applicationNumber')
      const publicationNumber = optionalText(raw, 'publicationNumber')
      const title = optionalText(raw, 'title') ?? publicationNumber ?? applicationNumber ?? `#${index + 1}`
      const id = publicationNumber ?? applicationNumber ?? `#${index + 1}`
      const applicant = optionalText(raw, 'applicant')
      const base = {
        index,
        label,
        id,
        title,
        ...(applicationNumber !== undefined ? { applicationNumber } : {}),
        ...(publicationNumber !== undefined ? { publicationNumber } : {}),
      }
      const exclude = (
        reason: ExcludedEntry['reason'],
        filingDate: string,
        publicationDate?: string,
      ): void => {
        excluded.push({
          ...base,
          reason,
          filingDate,
          ...(publicationDate !== undefined ? { publicationDate } : {}),
        })
      }

      const filing = readDateField(raw, 'filingDate')
      if (filing.error !== undefined) return degraded('conflicting-application', `${label} ${filing.error}`)
      const publication = readDateField(raw, 'publicationDate')
      if (publication.error !== undefined) return degraded('conflicting-application', `${label} ${publication.error}`)
      const priority = readDateField(raw, 'priorityDate')
      if (priority.error !== undefined) return degraded('conflicting-application', `${label} ${priority.error}`)

      const sameRaw = raw.sameInvention
      if (sameRaw !== undefined && sameRaw !== null && typeof sameRaw !== 'boolean') {
        return degraded('conflicting-application', `${label} sameInvention 必须是布尔值`)
      }
      const sameInvention = typeof sameRaw === 'boolean' ? sameRaw : undefined

      if (filing.missing === true) {
        unknown.push({ ...base, reason: '缺少申请日' })
        continue
      }

      const effective = effectiveFiling(filing, priority)

      if (effective.date.getTime() > target.date.getTime()) {
        exclude('filed-after-target', effective.text, publication.text)
        continue
      }
      if (effective.date.getTime() === target.date.getTime()) {
        exclude('filed-on-same-day', effective.text, publication.text)
        continue
      }

      if (publication.missing === true) {
        unknown.push({ ...base, reason: '缺少公开日' })
        continue
      }
      /* v8 ignore next 4 -- missing is handled above; a parsed date always carries text. */
      if (publication.date === undefined || publication.text === undefined) {
        unknown.push({ ...base, reason: '公开日无法解析' })
        continue
      }

      if (publication.date.getTime() < target.date.getTime()) {
        exclude('published-before-target', effective.text, publication.text)
        continue
      }

      if (sameInvention === undefined) {
        unknown.push({ ...base, reason: '未提供同样的发明或者实用新型判定（本原子不做语义比对）' })
        continue
      }
      if (!sameInvention) {
        exclude('different-invention', effective.text, publication.text)
        continue
      }

      confirmed.push({
        ...base,
        ...(applicant !== undefined ? { applicant } : {}),
        effectiveFilingDate: effective.text,
        filingBasis: effective.basis,
        publicationDate: publication.text,
        sameInvention: true,
      })
    }

    return {
      conflicting_application_report: buildReport(target, confirmed, excluded, unknown, supplied),
      conflicting_applications: confirmed,
      conflicting_application_excluded: excluded,
      conflicting_application_unknown: unknown,
    }
  }
}
