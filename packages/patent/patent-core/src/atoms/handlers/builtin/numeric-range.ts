/**
 * 对比域原子：numeric-range（数值范围新颖性核验）。
 *
 * 包装 `novelty/numeric-range.ts` 的确定性核验：从权利要求侧文本提取带单位的
 * 数值表述，与 `prior_art` 各篇文献的文本做区间重叠判定（审查指南第二部分第三章）。
 * 区间重叠或存在共同端点 → 破坏新颖性；数值点落入对比文件范围且无
 * 共同端点 → 不破坏新颖性。同量纲单位先换算到基单位再比较；量纲不同或单位在词表外
 * 且写法不同则不可比，存在不可比对时结论降为 `inconclusive`（除非另有破坏性重叠）。
 * 无单位数字（权项编号等）只记录，不参与判定。
 *
 * 本原子不做语义判断：它不决定对比文件是否“公开”了该数值，只按已给出的文本
 * 比对，因此结论需与语义新颖性分析并列阅读。缺少现有技术文本时给出
 * `inconclusive` 而非降级——没有可比对对象不等于阶段执行失败。
 */

import { type Atom } from '../../atom.ts'
import { type PipelineState, type StageExecuteInput, type StageHandler } from '../../handler.ts'
import { analyzeNumericRanges, type NumericRangeOverlap } from '../../../novelty/index.ts'
import { degraded } from './llm.ts'
import { isNonEmptyString, isRecord, readStateText, resolveConfiguredKey, resolveKeyList } from './state-keys.ts'

/** 默认权利要求侧文本键：显式权利要求优先，其次是抽取出的技术特征。 */
export const DEFAULT_NUMERIC_RANGE_CLAIM_TEXT_KEYS: readonly string[] = ['claim', 'claim_text', 'features']

/** 权利要求侧文本全部缺失时依次尝试的兜底键（技术交底书/原始材料）。 */
export const DEFAULT_NUMERIC_RANGE_FALLBACK_TEXT_KEYS: readonly string[] = [
  'source_text',
  'text',
  'input',
  'extraction_input',
]

/** 默认现有技术结果键。 */
export const DEFAULT_NUMERIC_RANGE_PRIOR_ART_KEY = 'prior_art'

/** 现有技术条目中按顺序读取的文本字段：全文优先，其次摘要片段与标题。 */
const PRIOR_ART_TEXT_FIELDS: readonly string[] = ['text', 'snippet', 'abstract', 'title']

/** 各结论的法条后果，单独成句，避免摘要的工程措辞替代法律结论。 */
const VERDICT_CONCLUSION = {
  overlapped: '结论：数值范围重叠或存在共同端点，破坏新颖性',
  inside_without_endpoint: '结论：数值点落入对比文件范围且无共同端点，不破坏新颖性',
  no_overlap: '结论：未发现数值范围重叠',
  inconclusive: '结论：无法判定',
} as const

/** numeric-range 原子：权利要求数值范围与现有技术文本的确定性比对。 */
export const numericRangeAtom: Atom = {
  name: 'numeric-range',
  description:
    '数值范围新颖性核验：带单位的区间/端点与现有技术文本比对（重叠或共同端点破坏新颖性；数值点落入范围且无共同端点不破坏）',
  category: 'compare',
  inputSchema: [
    ...DEFAULT_NUMERIC_RANGE_CLAIM_TEXT_KEYS,
    ...DEFAULT_NUMERIC_RANGE_FALLBACK_TEXT_KEYS,
    DEFAULT_NUMERIC_RANGE_PRIOR_ART_KEY,
  ],
  outputSchema: [
    'numeric_range_report',
    'numeric_range_verdict',
    'numeric_range_overlaps',
    'numeric_ranges',
  ],
}

/** 权利要求侧的一段文本及其标识（报告与核验结果共用）。 */
type ClaimTextSegment = {
  id: string
  text: string
}

/** 现有技术侧的一段文本及其标号。 */
type PriorArtTextSegment = {
  docId: string
  text: string
}

/** 对外输出的重叠对（展平核心类型，避免把提取细节泄漏给下游）。 */
type NumericRangeOverlapEntry = {
  claimId: string
  claimExpression: string
  priorDocId: string
  priorExpression: string
  kind: NumericRangeOverlap['kind']
  note: string
}

/**
 * 解析权利要求侧文本键列表：缺省用内置键表，显式给出时须为非空字符串数组。
 * @param state - 阶段执行态（含 params 合并值）。
 * @returns 可用的键列表；配置非法时返回 undefined。
 */
function resolveClaimTextKeys(state: PipelineState): string[] | undefined {
  return resolveKeyList(state, 'claim_text_keys', DEFAULT_NUMERIC_RANGE_CLAIM_TEXT_KEYS)
}

/**
 * 读取一段权利要求侧文本。字符串按共享读者裁剪；字符串数组只保留非空字符串并按行拼接，
 * 非字符串项忽略，供 `features` 这类特征列表使用。
 * @param state - 阶段执行态。
 * @param key - 状态键。
 * @returns 可比对文本；缺失、空数组或没有有效项时返回 undefined。
 */
function readClaimText(state: PipelineState, key: string): string | undefined {
  const raw = state[key]
  if (typeof raw === 'string') return readStateText(state, key)
  if (!Array.isArray(raw)) return undefined
  const text = raw
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => item.length > 0)
    .join('\n')
  return text.length > 0 ? text : undefined
}

/**
 * 汇总权利要求侧文本；相同文本只保留首次出现的键，避免 claim/claim_text
 * 指向同一材料时重复计数。
 * @param state - 阶段执行态。
 * @param keys - 配置的文本键。
 * @returns 文本分段；全部缺失时取第一个非空的兜底键。
 */
function collectClaimSegments(state: PipelineState, keys: readonly string[]): ClaimTextSegment[] {
  const segments: ClaimTextSegment[] = []
  const seen = new Set<string>()
  for (const key of keys) {
    const text = readClaimText(state, key)
    if (text === undefined || seen.has(text)) continue
    seen.add(text)
    segments.push({ id: key, text })
  }
  if (segments.length > 0) return segments
  for (const key of DEFAULT_NUMERIC_RANGE_FALLBACK_TEXT_KEYS) {
    const text = readClaimText(state, key)
    if (text !== undefined) return [{ id: key, text }]
  }
  return []
}

/**
 * 判断给定键里是否存在类型错误的文本值。
 *
 * 键缺失是信息不足（交给报告说明），类型错误是状态写入错误，直接降级暴露。
 * @param state - 阶段执行态。
 * @param keys - 待检查的文本键。
 * @returns 存在非字符串且非数组的值时为该键名，否则 undefined。
 */
function findMalformedTextKey(state: PipelineState, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const raw = state[key]
    if (raw !== undefined && typeof raw !== 'string' && !Array.isArray(raw)) return key
  }
  return undefined
}

/**
 * 读取一篇现有技术的可比对文本。
 * @param doc - 检索条目。
 * @returns 全文优先，其次摘要、摘要片段与标题；均缺失时返回 undefined。
 */
function readPriorArtText(doc: unknown): string | undefined {
  if (typeof doc === 'string') {
    const text = doc.trim()
    return text.length > 0 ? text : undefined
  }
  if (!isRecord(doc)) return undefined
  for (const field of PRIOR_ART_TEXT_FIELDS) {
    const value = doc[field]
    if (isNonEmptyString(value)) return value.trim()
  }
  return undefined
}

/**
 * 读取现有技术标号：保留检索阶段写入的 D 标号，缺省按位次生成。
 * @param doc - 检索条目。
 * @param index - 数组位次（0 起）。
 * @returns 报告与重叠对使用的标号。
 */
function priorArtLabel(doc: unknown, index: number): string {
  if (isRecord(doc) && isNonEmptyString(doc.dLabel)) return doc.dLabel
  return `D${index + 1}`
}

/**
 * 汇总现有技术侧文本，并记录无可读文本的条目数。
 * @param rawDocs - `state.prior_art` 数组。
 * @returns 可比对文本与跳过条目数。
 */
function collectPriorArtSegments(rawDocs: readonly unknown[]): {
  segments: PriorArtTextSegment[]
  skipped: number
} {
  const segments: PriorArtTextSegment[] = []
  let skipped = 0
  for (const [index, doc] of rawDocs.entries()) {
    const text = readPriorArtText(doc)
    if (text === undefined) {
      skipped += 1
      continue
    }
    segments.push({ docId: priorArtLabel(doc, index), text })
  }
  return { segments, skipped }
}

/**
 * 展平重叠对：核心类型带完整发现对象，下游只需要可复核的字段。
 * @param overlaps - 核心核验的重叠对。
 * @returns 展平后的输出条目。
 */
function toOverlapEntries(overlaps: readonly NumericRangeOverlap[]): NumericRangeOverlapEntry[] {
  return overlaps.map(overlap => ({
    /* v8 ignore next -- the handler always supplies the claim id. */
    claimId: overlap.claim.claimId ?? 'claim',
    claimExpression: overlap.claim.expression,
    /* v8 ignore next -- the handler always supplies the prior-art id. */
    priorDocId: overlap.prior.docId ?? '',
    priorExpression: overlap.prior.expression,
    kind: overlap.kind,
    note: overlap.note,
  }))
}

/** numeric-range 执行器：权利要求数值范围与现有技术文本的确定性比对。 */
export class NumericRangeHandler implements StageHandler {
  readonly name = 'numeric-range'
  readonly category = 'compare' as const

  /**
   * 执行数值范围核验。
   * @param input - 阶段执行输入（state 携带权利要求文本与检索结果）。
   * @returns `numeric_range_report`（主输出）、结论、重叠对与提取到的数值表述。
   */
  // oxlint-disable-next-line typescript/require-await -- StageHandler contract requires async execute
  async execute(input: StageExecuteInput): Promise<PipelineState> {
    const { state } = input
    const claimKeys = resolveClaimTextKeys(state)
    if (claimKeys === undefined) {
      return degraded('numeric-range', 'params.claim_text_keys 必须是非空字符串数组')
    }
    const priorArtKey = resolveConfiguredKey(state, 'prior_art_key', DEFAULT_NUMERIC_RANGE_PRIOR_ART_KEY)
    if (priorArtKey === undefined) {
      return degraded('numeric-range', 'params.prior_art_key 必须是非空字符串')
    }

    const malformed = findMalformedTextKey(state, [...claimKeys, ...DEFAULT_NUMERIC_RANGE_FALLBACK_TEXT_KEYS])
    if (malformed !== undefined) {
      return degraded('numeric-range', `state.${malformed} 不是字符串或字符串数组`)
    }

    const claims = collectClaimSegments(state, claimKeys)
    if (claims.length === 0) {
      return {
        numeric_range_report: `确定性数值范围核验（指南第二部分第三章）：缺少权利要求文本（state.${claimKeys.join(' / ')} 与 ${DEFAULT_NUMERIC_RANGE_FALLBACK_TEXT_KEYS.map(key => `state.${key}`).join(' / ')} 均无内容），无法判定`,
        numeric_range_verdict: 'inconclusive',
        numeric_range_overlaps: [],
        numeric_ranges: [],
      }
    }

    const rawDocs = state[priorArtKey]
    if (rawDocs !== undefined && !Array.isArray(rawDocs)) {
      return degraded('numeric-range', `state.${priorArtKey} 不是数组（检索阶段未产出）`)
    }
    const priorArt = collectPriorArtSegments(Array.isArray(rawDocs) ? rawDocs : [])
    const analysis = analyzeNumericRanges({ claims, priorArt: priorArt.segments })
    const strongClaims = analysis.claimRanges.filter(finding => finding.strong)
    const expressions = [...new Set(strongClaims.map(finding => finding.expression.trim()))]
    const skippedNote =
      priorArt.skipped > 0 ? `；${String(priorArt.skipped)} 篇现有技术条目无可读取文本，未参与比对` : ''

    if (strongClaims.length === 0) {
      return {
        numeric_range_report: `确定性数值范围核验（指南第二部分第三章）：未检测到带单位的数值表述，无需专项分析${skippedNote}`,
        numeric_range_verdict: 'inconclusive',
        numeric_range_overlaps: [],
        numeric_ranges: [],
      }
    }

    if (priorArt.segments.length === 0) {
      const supplied = Array.isArray(rawDocs) && rawDocs.length > 0
      const detail = supplied
        ? `提供的 ${String(rawDocs.length)} 篇现有技术条目均无可读取文本`
        : `未提供现有技术文本（state.${priorArtKey}）`
      return {
        numeric_range_report: `确定性数值范围核验（指南第二部分第三章）：检测到带单位数值表述 ${String(strongClaims.length)} 处，但${detail}，无法判定`,
        numeric_range_verdict: 'inconclusive',
        numeric_range_overlaps: [],
        numeric_ranges: expressions,
      }
    }

    return {
      numeric_range_report: `${VERDICT_CONCLUSION[analysis.verdict]}。${analysis.summary}；判定仅覆盖带单位的数值表述，不替代语义新颖性分析${skippedNote}`,
      numeric_range_verdict: analysis.verdict,
      numeric_range_overlaps: toOverlapEntries(analysis.overlaps),
      numeric_ranges: expressions,
    }
  }
}
