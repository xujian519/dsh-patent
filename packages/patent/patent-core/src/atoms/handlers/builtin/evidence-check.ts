/**
 * 证据域原子：evidence-check（无效/复审证据形式、期限与关联性审查）。
 *
 * 无效宣告与复审程序中，证据能否被采纳先于证据的证明力判断。本原子做确定性核对：
 * - 形式：证据须有可识别的名称/来源；外文证据须附中文译本；域外证据须公证、认证
 *   （公开出版物等法定免除情形由调用方以 `notarizedExempt`/`legalizedExempt` 声明）；
 *   证人证言须载明证人身份；内容哈希与原文摘录可对应时校验完整性。同一份证据可同时
 *   命中多项形式（例如域外外文对比文件），各项检查独立运行，不按单一分类短路。
 * - 期限：`submittedAt` 晚于举证期限且没有正当理由的，列为阻断项；有理由的降为提示，
 *   由合议组决定是否采纳。举证期限由调用方显式给出，本原子不从程序文书推断。
 * - 关联性：证据须说明所依据的无效/复审理由或关联的权利要求，否则列为提示项。
 *
 * 公开日检查只针对类型为现有技术的证据：公开日不早于现有技术截止日（申请日与
 * 优先权日中较早者）的，不构成现有技术。A24 宽限期标注不在本原子判断，标注后
 * 只降为提示并转交时间基准/检索过滤处理。
 *
 * 证据真实性、证明力与公开内容的实质比对不属于确定性核对范围，报告末尾固定写明
 * 这一限制。未提供证据清单时报告“未执行”并放行，避免把“没有输入”误当成“证据合格”。
 */

import { type Atom } from '../../atom.ts'
import {
  type PipelineState,
  type StageExecuteInput,
  type StageHandler,
} from '../../handler.ts'
import {
  inferredMonthEnd,
  isMonthOnlyDate,
  parseDateFlexible,
  priorArtReference,
} from '../../../evidence/date.ts'
import { CONTENT_HASH_PREFIX, contentHash } from '../../../evidence/receipt.ts'
import { degraded } from './llm.ts'
import { isRecord, resolveTrimmedKey } from './state-keys.ts'

/** 证据清单默认所在的状态键。 */
export const DEFAULT_EVIDENCE_KEY = 'evidence'

/** 举证期限默认所在的状态键。 */
export const DEFAULT_EVIDENCE_DEADLINE_KEY = 'evidence_deadline'

/** 现有技术截止日默认所在的状态键（time-baseline 的产出）。 */
export const DEFAULT_EVIDENCE_REFERENCE_DATE_KEY = 'reference_date'

/** 申请日默认所在的状态键。 */
export const DEFAULT_EVIDENCE_FILING_DATE_KEY = 'filing_date'

/** 优先权日默认所在的状态键。 */
export const DEFAULT_EVIDENCE_PRIORITY_DATE_KEY = 'priority_date'

/**
 * 证据形式属性：同一份证据可以同时是现有技术、外文证据与域外证据，
 * 每项适用检查都须运行，不能按单一分类短路。
 */
type EvidenceForms = {
  priorArt: boolean
  foreignLanguage: boolean
  overseas: boolean
  witness: boolean
  electronic: boolean
}

/** 违规严重度：阻断项使 `evidence_check_passed` 为 false，提示项只报告。 */
export type EvidenceCheckSeverity = 'block' | 'warn'

/** 单条证据的违规项。 */
export type EvidenceCheckViolation = {
  /** 稳定规则代码（EVID-*）。 */
  code: string
  /** 阻断或提示。 */
  severity: EvidenceCheckSeverity
  /** 证据标签（证据1、证据2……）。 */
  label: string
  /** 可复核的中文说明。 */
  message: string
}

/** 需要补充输入或人工核实、尚不能判定的事项。 */
export type EvidenceCheckPending = {
  /** 稳定规则代码（EVID-*）。 */
  code: string
  /** 证据标签；清单级事项用 `-`。 */
  label: string
  /** 可复核的中文说明。 */
  message: string
}

/** evidence-check 原子：核对无效/复审证据的形式、期限与关联性。 */
export const evidenceCheckAtom: Atom = {
  name: 'evidence-check',
  description:
    '无效/复审证据审查：证据形式（名称/来源、外文译本、域外公证认证、证人身份、内容完整性）、举证期限与争点关联性；缺证据清单时报告未执行',
  category: 'gate',
  inputSchema: [
    DEFAULT_EVIDENCE_KEY,
    DEFAULT_EVIDENCE_DEADLINE_KEY,
    DEFAULT_EVIDENCE_REFERENCE_DATE_KEY,
    DEFAULT_EVIDENCE_FILING_DATE_KEY,
    DEFAULT_EVIDENCE_PRIORITY_DATE_KEY,
  ],
  outputSchema: [
    'evidence_check_report',
    'evidence_check_passed',
    'evidence_check_violations',
    'evidence_check_pending',
  ],
}

/** 合法的 A24 宽限期标注。 */
const A24_EXCEPTIONS = new Set(['A24.1', 'A24.2', 'A24.3', 'A24.4'])

/** SHA-256 十六进制摘要（64 位）。 */
const SHA256_HEX = /^[0-9a-f]{64}$/iu

/** 旧版内建哈希（FNV-1a 32 位）的十六进制形态，仅用于兼容校验。 */
const LEGACY_FNV_HEX = /^[0-9a-f]{1,8}$/iu

/** 证据名称的候选字段。 */
const NAME_FIELDS = ['title', 'name', 'publicationNumber', 'patentNumber', 'id', 'evidenceId', 'label'] as const

/** 证据来源的候选字段。 */
const SOURCE_FIELDS = ['sourceUri', 'source', 'url', 'location', 'document', 'fileName'] as const

/** 提交日的候选字段。 */
const SUBMITTED_FIELDS = ['submittedAt', 'submitted_at', 'submissionDate', 'submitDate'] as const

/** 公开日的候选字段。 */
const PUBLICATION_FIELDS = ['publicationDate', 'publication_date', 'publishDate', 'date'] as const

/** 关联理由的候选字段。 */
const GROUND_FIELDS = ['grounds', 'relatedGrounds', 'ground', 'legalBasis', 'basis'] as const

/** 关联权项的候选字段。 */
const CLAIM_FIELDS = ['claimRefs', 'claims', 'relatedClaims'] as const

/** 逾期理由的候选字段。 */
const JUSTIFICATION_FIELDS = ['lateJustification', 'justification', 'lateReason', 'reason'] as const

type DateResolution =
  | { date: Date; text: string }
  | { missing: true }
  | { error: string }

/**
 * 读取候选字段中的第一个非空字符串。
 * @param record - 证据条目。
 * @param fields - 候选字段。
 * @returns 非空字符串，全部缺失时返回 undefined。
 */
function firstText(record: Record<string, unknown>, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const raw = record[field]
    if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim()
  }
  return undefined
}

/**
 * 读取候选字段中的第一个非空字符串，**保留原文不 trim**。
 *
 * 仅用于完整性哈希重算：存储的 contentHash 覆盖原始摘录文本，若先 trim 再重算，
 * 首尾带空白的合法摘录会被误判为哈希不一致（S-PAT-011）。判空仍按 trim 后长度。
 * @param record - 证据条目。
 * @param fields - 候选字段。
 * @returns 原始字符串，全部缺失或仅含空白时返回 undefined。
 */
function firstTextRaw(record: Record<string, unknown>, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const raw = record[field]
    if (typeof raw === 'string' && raw.trim().length > 0) return raw
  }
  return undefined
}

/**
 * 读取布尔字段；非布尔值视为录入错误。
 * @param record - 证据条目。
 * @param field - 字段名。
 * @returns 布尔值、缺失标记或错误原因。
 */
function readBoolean(
  record: Record<string, unknown>,
  field: string,
): { value?: boolean; missing?: true; error?: string } {
  const raw = record[field]
  if (raw === undefined || raw === null) return { missing: true }
  if (typeof raw !== 'boolean') return { error: `${field} 必须是布尔值` }
  return { value: raw }
}

/**
 * 读取日期字段。缺失与格式错误分开：缺失进入待核，格式错误直接降级。
 * @param record - 证据条目。
 * @param fields - 候选字段。
 * @param allowMonthOnly - 是否允许仅到年月的日期（按月末推定）。
 * @returns 解析出的日期、缺失标记或错误原因。
 */
function readDate(
  record: Record<string, unknown>,
  fields: readonly [string, ...string[]],
  allowMonthOnly: boolean,
): DateResolution {
  const field = fields[0]
  const text = firstText(record, fields)
  if (text === undefined) return { missing: true }
  if (isMonthOnlyDate(text)) {
    if (!allowMonthOnly) return { error: `${field} 仅精确到月，判定需要具体日期：${text}` }
    const parsed = parseDateFlexible(text)
    /* v8 ignore next -- isMonthOnlyDate guarantees parseDateFlexible succeeds. */
    if (parsed === null) return { error: `${field} 无法解析：${text}` }
    const monthEndDate = new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, 0))
    return { date: monthEndDate, text: inferredMonthEnd(parsed) }
  }
  const parsed = parseDateFlexible(text)
  if (parsed === null) return { error: `${field} 不是可识别的日期：${text}` }
  return { date: parsed, text: toIsoDate(parsed) }
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * 识别证据的全部适用形式。中英文标签均可，各项独立命中；未知类型不命中任何项。
 * @param raw - 原始类型字段。
 * @returns 证据形式属性集合。
 */
function classifyForms(raw: string | undefined): EvidenceForms {
  if (raw === undefined) {
    return {
      priorArt: false,
      foreignLanguage: false,
      overseas: false,
      witness: false,
      electronic: false,
    }
  }
  const text = raw.trim().toLowerCase()
  return {
    priorArt: /(prior[-_ ]?art|现有技术|对比文件|公开出版物|专利文献)/u.test(text),
    foreignLanguage: /(foreign|外文|译文|translation)/u.test(text),
    overseas: /(overseas|域外|境外证据)/u.test(text),
    witness: /(witness|证人|证言)/u.test(text),
    electronic: /(electronic|电子数据|电子证据)/u.test(text),
  }
}

/**
 * 证据显示名：标题 > 文献号 > 证人 > id > 序号。
 * @param record - 证据条目。
 * @param index - 数组下标。
 * @returns 报告用的显示名。
 */
function displayName(record: Record<string, unknown>, index: number): string {
  return firstText(record, NAME_FIELDS) ?? firstText(record, ['witness']) ?? `#${index + 1}`
}

/**
 * 证据是否有可识别的来源/身份信息。
 * @param record - 证据条目。
 * @returns 是否存在来源或身份字段。
 */
function hasIdentity(record: Record<string, unknown>): boolean {
  return firstText(record, [...SOURCE_FIELDS, ...NAME_FIELDS, 'witness']) !== undefined
}

/** 举证期限解析结果。 */
type DeadlineResolution = { date: Date; text: string } | { missing: true } | { error: string }

/** 执行器已拒绝错误后，期限检查只会看到可用或缺失。 */
type ResolvedDeadline = Exclude<DeadlineResolution, { error: string }>

/**
 * 读取举证期限。非字符串、仅到月或不可解析均视为录入错误（降级）。
 * @param state - 阶段执行态。
 * @param key - 举证期限状态键。
 * @returns 解析出的期限、缺失标记或错误原因。
 */
function resolveDeadline(state: PipelineState, key: string): DeadlineResolution {
  const raw = state[key]
  if (raw === undefined || raw === null) return { missing: true }
  if (typeof raw !== 'string') return { error: `state.${key} 必须是字符串` }
  const text = raw.trim()
  if (text === '') return { missing: true }
  if (isMonthOnlyDate(text)) return { error: `举证期限（state.${key}）仅精确到月：${text}` }
  const date = parseDateFlexible(text)
  if (date === null) return { error: `举证期限（state.${key}）无法解析：${text}` }
  return { date, text: toIsoDate(date) }
}

/** 现有技术截止日解析结果。 */
type ReferenceResolution =
  | { date: Date; text: string; basis: 'reference-date' | 'filing-date' | 'priority-date' }
  | { missing: true }
  | { error: string }

/** 执行器已拒绝错误后，公开日检查只会看到可用或缺失。 */
type ResolvedReference = Exclude<ReferenceResolution, { error: string }>

/**
 * 解析现有技术截止日：优先 `reference_date`，否则取申请日与优先权日中较早者。
 * @param state - 阶段执行态。
 * @param referenceKey - 截止日状态键。
 * @param filingKey - 申请日状态键。
 * @param priorityKey - 优先权日状态键。
 * @returns 截止日、缺失标记或错误原因。
 */
function resolveReference(
  state: PipelineState,
  referenceKey: string,
  filingKey: string,
  priorityKey: string,
): ReferenceResolution {
  const explicit = state[referenceKey]
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    const text = explicit.trim()
    if (isMonthOnlyDate(text)) return { error: `现有技术截止日（state.${referenceKey}）仅精确到月：${text}` }
    const date = parseDateFlexible(text)
    if (date === null) return { error: `现有技术截止日（state.${referenceKey}）无法解析：${text}` }
    return { date, text: toIsoDate(date), basis: 'reference-date' }
  }
  if (explicit !== undefined && explicit !== null && typeof explicit !== 'string') {
    return { error: `state.${referenceKey} 必须是字符串` }
  }

  const readOptional = (key: string): string | undefined | { error: string } => {
    const raw = state[key]
    if (raw === undefined || raw === null) return undefined
    if (typeof raw !== 'string') return { error: `state.${key} 必须是字符串` }
    const text = raw.trim()
    if (text === '') return undefined
    if (isMonthOnlyDate(text) || parseDateFlexible(text) === null) {
      return { error: `state.${key} 无法解析为具体日期：${text}` }
    }
    return text
  }
  const filing = readOptional(filingKey)
  if (filing !== undefined && typeof filing !== 'string') return filing
  const priority = readOptional(priorityKey)
  if (priority !== undefined && typeof priority !== 'string') return priority
  if (filing === undefined && priority === undefined) return { missing: true }

  const reference = priorArtReference({
    ...(filing !== undefined ? { filingDate: filing } : {}),
    ...(priority !== undefined ? { priorityDate: priority } : {}),
  })
  /* v8 ignore next 3 -- both supplied dates were validated above, so priorArtReference resolves one. */
  if (reference === undefined) {
    return { error: `无法从 ${filingKey}/${priorityKey} 解析现有技术截止日` }
  }
  const date = parseDateFlexible(reference.date)
  /* v8 ignore next 3 -- priorArtReference only returns parsed dates. */
  if (date === null) {
    return { error: `现有技术截止日无法解析：${reference.date}` }
  }
  return {
    date,
    text: toIsoDate(date),
    basis: reference.basis === 'priority-date' ? 'priority-date' : 'filing-date',
  }
}

/** 单条证据的读取上下文。 */
type EntryContext = {
  record: Record<string, unknown>
  label: string
  index: number
  forms: EvidenceForms
}

/** 单条证据的核对结果。 */
type EntryResult = {
  violations: EvidenceCheckViolation[]
  pending: EvidenceCheckPending[]
  error?: string
}

function violation(
  ctx: EntryContext,
  code: string,
  severity: EvidenceCheckSeverity,
  message: string,
): EvidenceCheckViolation {
  return { code, severity, label: ctx.label, message }
}

function pending(ctx: EntryContext, code: string, message: string): EvidenceCheckPending {
  return { code, label: ctx.label, message }
}

/**
 * 核对单条证据的形式、公开日与关联性。举证期限由调用方统一核对。
 * @param ctx - 证据读取上下文。
 * @param reference - 现有技术截止日。
 * @returns 违规项、待核项或录入错误。
 */
function checkEntry(ctx: EntryContext, reference: ResolvedReference): EntryResult {
  const { record, forms } = ctx
  const violations: EvidenceCheckViolation[] = []
  const pendingItems: EvidenceCheckPending[] = []

  if (!hasIdentity(record)) {
    violations.push(
      violation(ctx, 'EVID-FORM-IDENTITY', 'block', '证据没有可识别的名称或来源，无法定位与核对'),
    )
  }

  if (forms.foreignLanguage) {
    const translated = readBoolean(record, 'translated')
    if (translated.error !== undefined) return { violations, pending: pendingItems, error: translated.error }
    const translationText = firstText(record, ['translation', 'translationText'])
    if (translated.value === false) {
      violations.push(
        violation(ctx, 'EVID-FORM-TRANSLATION', 'block', '外文证据未附中文译本；未提交译文的，该证据视为未提交'),
      )
    } else if (translated.value === undefined && translationText === undefined) {
      pendingItems.push(pending(ctx, 'EVID-FORM-TRANSLATION', '外文证据未说明是否附中文译本，需补充确认'))
    }
  }

  if (forms.overseas) {
    const notarized = readBoolean(record, 'notarized')
    if (notarized.error !== undefined) return { violations, pending: pendingItems, error: notarized.error }
    const legalized = readBoolean(record, 'legalized')
    if (legalized.error !== undefined) return { violations, pending: pendingItems, error: legalized.error }
    const notarizedExempt = record.notarizedExempt === true
    const legalizedExempt = record.legalizedExempt === true
    if (!notarizedExempt) {
      if (notarized.value === false) {
        violations.push(
          violation(ctx, 'EVID-FORM-NOTARIZATION', 'warn', '域外证据未办理公证，需在指定期限内补正；公开出版物等法定免除情形除外'),
        )
      } else if (notarized.value === undefined) {
        pendingItems.push(pending(ctx, 'EVID-FORM-NOTARIZATION', '域外证据未说明是否已公证，需补充确认'))
      }
    }
    if (!legalizedExempt) {
      if (legalized.value === false) {
        violations.push(
          violation(ctx, 'EVID-FORM-LEGALIZATION', 'warn', '域外证据未办理认证，需在指定期限内补正；条约或法定免除情形除外'),
        )
      } else if (legalized.value === undefined) {
        pendingItems.push(pending(ctx, 'EVID-FORM-LEGALIZATION', '域外证据未说明是否已认证，需补充确认'))
      }
    }
  }

  if (forms.witness) {
    if (firstText(record, ['witness', 'witnessName']) === undefined) {
      violations.push(violation(ctx, 'EVID-FORM-WITNESS', 'block', '证人证言未载明证人身份，无法核对作证资格'))
    }
    const disclosed = readBoolean(record, 'witnessDisclosed')
    if (disclosed.error !== undefined) return { violations, pending: pendingItems, error: disclosed.error }
    if (disclosed.value === false) {
      violations.push(
        violation(ctx, 'EVID-FORM-WITNESS-INTEREST', 'warn', '证人未披露与案件的利害关系，证言可信度需进一步审查'),
      )
    }
  }

  if (forms.priorArt) {
    const publication = readDate(record, PUBLICATION_FIELDS, true)
    if ('error' in publication) return { violations, pending: pendingItems, error: publication.error }
    if ('missing' in publication) {
      pendingItems.push(pending(ctx, 'EVID-TIME-PUBLICATION-DATE', '现有技术证据缺少公开日，无法判断是否构成现有技术'))
    } else if ('date' in reference) {
      if (publication.date.getTime() >= reference.date.getTime()) {
        const a24 = firstText(record, ['a24Exception'])
        if (a24 !== undefined && A24_EXCEPTIONS.has(a24)) {
          violations.push(
            violation(
              ctx,
              'EVID-TIME-A24',
              'warn',
              `公开日 ${publication.text} 不早于截止日 ${reference.text}，但标注 ${a24} 宽限期；宽限期是否适用由时间基准/检索过滤另行核验`,
            ),
          )
        } else {
          violations.push(
            violation(
              ctx,
              'EVID-TIME-NOT-PRIOR-ART',
              'block',
              `公开日 ${publication.text} 不早于现有技术截止日 ${reference.text}，不构成现有技术（A22.5）`,
            ),
          )
        }
      }
    } else {
      pendingItems.push(
        pending(ctx, 'EVID-TIME-REFERENCE', '缺少申请日/优先权日，公开日是否早于现有技术截止日未评估'),
      )
    }
  }

  if (forms.electronic) {
    pendingItems.push(
      pending(
        ctx,
        'EVID-FORM-ELECTRONIC',
        '电子数据形式要件（原始载体、提取过程、完整性校验）需人工核验',
      ),
    )
  }

  const integrity = checkIntegrity(ctx)
  violations.push(...integrity.violations)
  pendingItems.push(...integrity.pending)

  const grounds = readRefs(record, GROUND_FIELDS)
  const claims = readRefs(record, CLAIM_FIELDS)
  if (grounds.length === 0 && claims.length === 0) {
    violations.push(
      violation(ctx, 'EVID-RELEVANCE-UNLINKED', 'warn', '未说明证据所依据的无效/复审理由或关联的权利要求，关联性无法确认'),
    )
  }

  return { violations, pending: pendingItems }
}

/**
 * 读取字符串或字符串数组字段为去重后的非空字符串列表。
 * @param record - 证据条目。
 * @param fields - 候选字段。
 * @returns 去重后的非空字符串列表。
 */
function readRefs(record: Record<string, unknown>, fields: readonly string[]): string[] {
  const values: string[] = []
  for (const field of fields) {
    const raw = record[field]
    if (typeof raw === 'string' && raw.trim().length > 0) values.push(raw.trim())
    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (typeof item === 'string' && item.trim().length > 0) values.push(item.trim())
      }
    }
  }
  return [...new Set(values)]
}

/**
 * 旧版内建哈希（FNV-1a 32 位）；只为校验既有证据保留，新哈希一律用 SHA-256。
 * @param text - 待哈希的原文。
 * @returns 十六进制 FNV-1a 哈希。
 */
function legacyFnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16)
}

/**
 * 内容完整性校验：
 * - `sha256:<64 位十六进制>` 与原文摘录重算一致时通过，不一致阻断；
 * - 旧版 1–8 位十六进制只在能与摘录重算一致时按 legacy 通过，并标记 `legacy-hash` 待核；
 * - 其他格式与无法匹配的短十六进制不自动当作内建哈希，转待核由对应算法核验。
 * @param ctx - 证据读取上下文。
 * @returns 违规项、待核项或录入错误。
 */
function checkIntegrity(ctx: EntryContext): {
  violations: EvidenceCheckViolation[]
  pending: EvidenceCheckPending[]
} {
  const hash = firstText(ctx.record, ['contentHash', 'content_hash'])
  if (hash === undefined) return { violations: [], pending: [] }
  // 摘录用保留原文的读取器：contentHash 覆盖原始文本，trim 后重算会误报（S-PAT-011）。
  const snippet = firstTextRaw(ctx.record, ['snippet', 'excerpt', 'text'])
  const normalized = hash.trim()

  if (normalized.toLowerCase().startsWith(CONTENT_HASH_PREFIX)) {
    const hex = normalized.slice(CONTENT_HASH_PREFIX.length)
    if (!SHA256_HEX.test(hex)) {
      return {
        violations: [],
        pending: [pending(ctx, 'EVID-FORM-INTEGRITY', 'sha256: 哈希缺少 64 位十六进制摘要，无法核验完整性')],
      }
    }
    if (snippet === undefined) {
      return {
        violations: [],
        pending: [pending(ctx, 'EVID-FORM-INTEGRITY', '提供了内容哈希但缺少原文摘录，无法重算校验')],
      }
    }
    if (contentHash(snippet).toLowerCase() !== `${CONTENT_HASH_PREFIX}${hex.toLowerCase()}`) {
      return {
        violations: [
          violation(ctx, 'EVID-FORM-INTEGRITY', 'block', '原文摘录与 SHA-256 内容哈希不一致，证据完整性存疑'),
        ],
        pending: [],
      }
    }
    return { violations: [], pending: [] }
  }

  if (LEGACY_FNV_HEX.test(normalized)) {
    if (snippet === undefined) {
      return {
        violations: [],
        pending: [pending(ctx, 'EVID-FORM-INTEGRITY', '提供了旧版短哈希但缺少原文摘录，无法重算校验')],
      }
    }
    if (legacyFnv1a(snippet).toLowerCase() === normalized.toLowerCase()) {
      return {
        violations: [],
        pending: [
          pending(
            ctx,
            'EVID-FORM-INTEGRITY-LEGACY',
            `legacy-hash：旧版 FNV 哈希校验通过，但该格式为弱哈希；请改用 ${contentHash(snippet)}`,
          ),
        ],
      }
    }
    return {
      violations: [],
      pending: [
        pending(
          ctx,
          'EVID-FORM-INTEGRITY',
          '短十六进制无法确认为内建 FNV 哈希（与摘录不一致），不自动按内建哈希判定，需用对应算法独立核验',
        ),
      ],
    }
  }

  return {
    violations: [],
    pending: [
      pending(
        ctx,
        'EVID-FORM-INTEGRITY',
        '内容哈希不是 sha256:<64 位十六进制> 格式，需用对应算法独立核验，本原子未校验',
      ),
    ],
  }
}

/**
 * 核对举证期限。期限缺失时保留一条清单级待核项；提交日晚于期限且无理由时阻断。
 * @param ctx - 证据读取上下文。
 * @param deadline - 举证期限。
 * @returns 违规项、待核项或录入错误。
 */
function checkDeadline(
  ctx: EntryContext,
  deadline: ResolvedDeadline,
): { violations: EvidenceCheckViolation[]; pending: EvidenceCheckPending[]; error?: string } {
  if ('missing' in deadline) return { violations: [], pending: [] }

  const submitted = readDate(ctx.record, SUBMITTED_FIELDS, false)
  if ('error' in submitted) return { violations: [], pending: [], error: submitted.error }
  if ('missing' in submitted) {
    return {
      violations: [],
      pending: [pending(ctx, 'EVID-TIME-SUBMITTED', `缺少提交日，无法核对是否在举证期限 ${deadline.text} 内提交`)],
    }
  }
  if (submitted.date.getTime() <= deadline.date.getTime()) return { violations: [], pending: [] }

  const justification = firstText(ctx.record, JUSTIFICATION_FIELDS)
  if (justification === undefined) {
    return {
      violations: [
        violation(
          ctx,
          'EVID-TIME-LATE',
          'block',
          `提交日 ${submitted.text} 晚于举证期限 ${deadline.text}，且未说明正当理由；逾期证据可能不被采纳`,
        ),
      ],
      pending: [],
    }
  }
  return {
    violations: [
      violation(
        ctx,
        'EVID-TIME-LATE-JUSTIFIED',
        'warn',
        `提交日 ${submitted.text} 晚于举证期限 ${deadline.text}，已说明理由：${justification}；是否采纳由合议组决定`,
      ),
    ],
    pending: [],
  }
}

/**
 * 渲染证据审查报告。
 * @param params - 证据条数、期限、截止日、逐条结果与清单级待核项。
 * @returns 面向模型与人工复核的报告。
 */
function renderReport(params: {
  count: number
  deadline: ResolvedDeadline
  reference: ResolvedReference
  entries: Array<{ ctx: EntryContext; result: EntryResult }>
  listPending: EvidenceCheckPending[]
}): string {
  const violations = params.entries.flatMap(entry => entry.result.violations)
  const blocks = violations.filter(item => item.severity === 'block').length
  const warns = violations.length - blocks
  const pendingCount =
    params.entries.flatMap(entry => entry.result.pending).length + params.listPending.length
  const verdict = blocks > 0 ? '未通过' : '通过'

  const deadlineText =
    'missing' in params.deadline
      ? '举证期限：未提供（期限检查未评估）'
      : `举证期限：${params.deadline.text}`
  const referenceText =
    'missing' in params.reference
      ? '现有技术截止日：未提供（公开日检查未评估）'
      : `现有技术截止日：${params.reference.text}（${
        params.reference.basis === 'priority-date'
          ? '优先权日'
          : params.reference.basis === 'reference-date'
            ? '指定截止日'
            : '申请日'
      }）`

  const lines = [
    `证据审查（无效/复审）：${verdict}（阻断 ${blocks} 项，提示 ${warns} 项，待核 ${pendingCount} 项）`,
    `- 证据 ${params.count} 条；${deadlineText}；${referenceText}`,
  ]

  for (const { ctx, result } of params.entries) {
    const name = displayName(ctx.record, ctx.index)
    const kindLabel = formLabel(ctx.forms)
    if (result.violations.length === 0 && result.pending.length === 0) {
      lines.push(`- ${ctx.label}《${name}》${kindLabel}：通过`)
      continue
    }
    lines.push(`- ${ctx.label}《${name}》${kindLabel}：`)
    for (const item of result.violations) {
      const flag = item.severity === 'block' ? '阻断' : '提示'
      lines.push(`  - [${flag}] ${item.code}：${item.message}`)
    }
    for (const item of result.pending) {
      lines.push(`  - [待核] ${item.code}：${item.message}`)
    }
  }

  if (params.listPending.length > 0) {
    lines.push('- 清单级待核：')
    for (const item of params.listPending) {
      lines.push(`  - ${item.code}：${item.message}`)
    }
  }

  lines.push(
    '限制说明：本原子只核对形式、举证期限与关联性；证据真实性、证明力以及公开内容的实质比对仍需人工复核。',
  )
  return lines.join('\n')
}

/**
 * 证据形式属性对应的报告标签，按固定顺序拼接。
 * @param forms - 证据形式属性集合。
 * @returns 形如 `[现有技术/外文证据]` 的标签；全部未命中时为空串。
 */
function formLabel(forms: EvidenceForms): string {
  const labels: string[] = []
  if (forms.priorArt) labels.push('现有技术')
  if (forms.foreignLanguage) labels.push('外文证据')
  if (forms.overseas) labels.push('域外证据')
  if (forms.witness) labels.push('证人证言')
  if (forms.electronic) labels.push('电子数据')
  return labels.length > 0 ? `[${labels.join('/')}]` : ''
}

/** evidence-check 执行器：逐条核对证据的形式、期限与关联性。 */
export class EvidenceCheckHandler implements StageHandler {
  readonly name = 'evidence-check'
  readonly category = 'gate' as const

  /**
   * 执行证据审查。
   * @param input - 阶段执行输入（证据清单、举证期限与时间基准）。
   * @returns 报告（主输出）、是否通过、违规项与待核项。
   */
  // oxlint-disable-next-line typescript/require-await -- StageHandler contract requires async execute
  async execute(input: StageExecuteInput): Promise<PipelineState> {
    const state = input.state
    const evidenceKey = resolveTrimmedKey(state, 'evidence_key', DEFAULT_EVIDENCE_KEY)
    if (evidenceKey === undefined) return degraded('evidence-check', 'params.evidence_key 必须是非空字符串')
    const deadlineKey = resolveTrimmedKey(state, 'deadline_key', DEFAULT_EVIDENCE_DEADLINE_KEY)
    if (deadlineKey === undefined) return degraded('evidence-check', 'params.deadline_key 必须是非空字符串')
    const referenceKey = resolveTrimmedKey(state, 'reference_date_key', DEFAULT_EVIDENCE_REFERENCE_DATE_KEY)
    if (referenceKey === undefined) return degraded('evidence-check', 'params.reference_date_key 必须是非空字符串')
    const filingKey = resolveTrimmedKey(state, 'filing_date_key', DEFAULT_EVIDENCE_FILING_DATE_KEY)
    if (filingKey === undefined) return degraded('evidence-check', 'params.filing_date_key 必须是非空字符串')
    const priorityKey = resolveTrimmedKey(state, 'priority_date_key', DEFAULT_EVIDENCE_PRIORITY_DATE_KEY)
    if (priorityKey === undefined) return degraded('evidence-check', 'params.priority_date_key 必须是非空字符串')

    const rawList = state[evidenceKey]
    if (rawList === undefined) {
      return {
        evidence_check_report: [
          '证据审查（无效/复审）：未执行（未提供证据清单）',
          `- 未找到 state.${evidenceKey}；本阶段未核对证据形式、举证期限与关联性`,
          '限制说明：本原子只核对形式、举证期限与关联性；证据真实性、证明力以及公开内容的实质比对仍需人工复核。',
        ].join('\n'),
        evidence_check_passed: true,
        evidence_check_violations: [],
        evidence_check_pending: [],
      }
    }
    if (!Array.isArray(rawList)) {
      return degraded('evidence-check', `state.${evidenceKey} 不是数组（证据清单）`)
    }

    const deadline = resolveDeadline(state, deadlineKey)
    if ('error' in deadline) return degraded('evidence-check', deadline.error)
    const reference = resolveReference(state, referenceKey, filingKey, priorityKey)
    if ('error' in reference) return degraded('evidence-check', reference.error)
    const listPending: EvidenceCheckPending[] = []
    if ('missing' in deadline) {
      listPending.push({
        code: 'EVID-TIME-DEADLINE',
        label: '-',
        message: `未提供举证期限（state.${deadlineKey}），期限检查未评估`,
      })
    }

    const entries: Array<{ ctx: EntryContext; result: EntryResult }> = []
    for (const [index, raw] of rawList.entries()) {
      const label = `证据${index + 1}`
      if (!isRecord(raw)) return degraded('evidence-check', `${label} 条目不是对象`)
      const forms = classifyForms(firstText(raw, ['type', 'evidenceType', 'kind']))
      const ctx: EntryContext = { record: raw, label, index, forms }

      const entryResult = checkEntry(ctx, reference)
      if (entryResult.error !== undefined) return degraded('evidence-check', `${label} ${entryResult.error}`)
      const deadlineResult = checkDeadline(ctx, deadline)
      if (deadlineResult.error !== undefined) return degraded('evidence-check', `${label} ${deadlineResult.error}`)
      entries.push({
        ctx,
        result: {
          violations: [...entryResult.violations, ...deadlineResult.violations],
          pending: [...entryResult.pending, ...deadlineResult.pending],
        },
      })
    }

    const allViolations = entries.flatMap(entry => entry.result.violations)
    const passed = !allViolations.some(item => item.severity === 'block')
    return {
      evidence_check_report: renderReport({
        count: rawList.length,
        deadline,
        reference,
        entries,
        listPending,
      }),
      evidence_check_passed: passed,
      evidence_check_violations: allViolations,
      evidence_check_pending: [...entries.flatMap(entry => entry.result.pending), ...listPending],
    }
  }
}
