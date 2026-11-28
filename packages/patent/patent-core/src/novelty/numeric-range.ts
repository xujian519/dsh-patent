/**
 * src/patent/novelty — 数值范围新颖性的确定性核验（LLM 语义轨之外的判定轨）。
 *
 * 从权利要求与对比文件文本提取数值表述，按审查指南第二部分第三章关于数值和
 * 数值范围的新颖性规定做区间重叠判定（仓库内同一口径的法条依据见 patent-rule
 * 资产的 EX-NOV-004）：
 * - 数值范围重叠，或与对比文件存在共同端点 → 破坏新颖性（overlapped）；
 * - 数值点落在对比文件范围内且无共同端点 → 不破坏新颖性，但要提示
 *   （inside_without_endpoint）；
 * - 未与对比文件发生区间相交 → no_overlap；
 * - 任一侧未提取到带单位的强数值表述 → 无法判定（inconclusive）。
 *
 * 判定是保守的：只有带单位/百分号的"强发现"参与，无单位的数字（"权利要求1-3"
 * 这类编号文本）仅记录不参与，避免系统性误报。同量纲的单位先换算到基单位再比较
 * （5-10mg 与 0.005-0.01g 相等）；量纲不同或单位表外且写法不同则不可比，只要存在
 * 不可比的对，结论就降为 inconclusive——除非另有确定的破坏性重叠。
 *
 * 数值可带正负号（`-5至-10℃`、Unicode 减号 `−`），单边表述支持方向词（不低于）
 * 与后缀（`70℃以上`）两种写法。
 *
 * 与语义轨的对照：LLM 轨给出同名结论即记为一致，给出不同的具体结论记为不一致。
 * 上游只在"确定性判为重叠、LLM 判为不重叠"时记不一致；本模块对任一具体分歧都记
 * 不一致，因为分歧本身就是交人工复核的信号，且隐藏分歧会让报告读起来比事实更确定。
 *
 * 上游把重叠细分为审查指南的若干"情形"编号；本模块改用语义命名，不对未核验的
 * 条文编号作断言。
 */

import { tryParseJson } from '../llm-json.ts'
import {
  NUMERIC_ANY_UNIT_ALTERNATION,
  NUMERIC_RANGE_SEPARATOR_CLASS,
  normalizeNumericUnit,
  resolveNumericUnit,
} from './numeric-vocabulary.ts'

/** 确定性核验结论。 */
export type NumericRangeVerdict = 'overlapped' | 'inside_without_endpoint' | 'no_overlap' | 'inconclusive'

/** 确定性结论与语义轨结论的对照结果；n_a 表示缺少可比对的结论。 */
export type NumericLlmAgreement = 'agree' | 'disagree' | 'n_a'

/** 一处提取出的数值表述。 */
export type NumericRangeFinding = {
  /** 原文片段。 */
  expression: string
  /** 闭区间下界；单边表述的另一侧为 ±Infinity。 */
  lower: number
  /** 闭区间上界；单边表述的另一侧为 ∓Infinity。 */
  upper: number
  /** 单个数值（非范围）。 */
  isPoint: boolean
  /** 归一化单位；空串表示无单位（弱发现）。 */
  unit: string
  /** 带单位的强发现；只有强发现参与判定。 */
  strong: boolean
  /** 权利要求标识（权利要求侧发现）。 */
  claimId?: string
  /** 对比文件标识（对比文件侧发现）。 */
  docId?: string
}

/** 一对数值表述的重叠关系。 */
export type NumericRangeOverlap = {
  claim: NumericRangeFinding
  prior: NumericRangeFinding
  kind: Exclude<NumericRangeVerdict, 'no_overlap' | 'inconclusive'>
  note: string
}

/** 一对强发现不可比的原因。 */
export type NumericRangeIncomparableReason = 'dimension-mismatch' | 'unknown-unit'

/** 无法比较的一对数值表述。 */
export type NumericRangeIncomparablePair = {
  claim: NumericRangeFinding
  prior: NumericRangeFinding
  reason: NumericRangeIncomparableReason
  /** 可直接展示给用户的说明。 */
  detail: string
}

/** 确定性核验的完整结果。 */
export type NumericRangeAnalysis = {
  claimRanges: NumericRangeFinding[]
  priorRanges: NumericRangeFinding[]
  overlaps: NumericRangeOverlap[]
  /** 因量纲不同或单位表外而未能比较的强发现对。 */
  incomparablePairs: NumericRangeIncomparablePair[]
  verdict: NumericRangeVerdict
  llmAgreement: NumericLlmAgreement
  summary: string
  /** 不可比对的说明；无不可比对时为空串。 */
  reason: string
}

/** 核验输入：一侧为权利要求文本，另一侧为对比文件文本，各自带标识。 */
export type NumericRangeInput = {
  claims: ReadonlyArray<{ id: string; text: string }>
  priorArt: ReadonlyArray<{ docId: string; text: string }>
}

/** 核验结论的可读名（报告与提示词共用）。 */
const VERDICT_TEXT: Readonly<Record<NumericRangeVerdict, string>> = {
  overlapped: '发现破坏性数值重叠，建议人工复核数值特征',
  inside_without_endpoint: '数值点落入对比文件范围但无共同端点（不破坏新颖性）',
  no_overlap: '未发现数值范围重叠',
  inconclusive: '未提取到足够的带单位数值表述，无法判定',
}

/**
 * 带符号数值：可选正负号，负号兼容 ASCII `-`、全角 `－` 与 Unicode 减号 `−`。
 *
 * 符号必须并入数值 token，否则 `-5至-10℃` 会被读成 `5` 与 `10` 两个正数，重叠判定
 * 整体反转。
 */
const SIGNED_NUMBER = '[+\\-−－]?\\d+(?:\\.\\d+)?'

/**
 * 闭区间式数值范围：5-10、5～10、5~10、5至10、5到10、20–90、-5至-10。
 *
 * 连接符前允许出现单位（20℃至90℃、5mg-10mg、10mm~20mm）：这是专利文本的常见写法。
 * 区间的单位取片段末尾的单位，末尾未写时退回连接符前的那个（`20℃至90`、`70%—75`）。
 * 词表来自 {@link ./numeric-vocabulary.ts}，与规格校验侧共用。
 */
const RANGE_PATTERN = new RegExp(
  `(${SIGNED_NUMBER})\\s*(?:(${NUMERIC_ANY_UNIT_ALTERNATION}))?\\s*(?:[${NUMERIC_RANGE_SEPARATOR_CLASS}])\\s*(${SIGNED_NUMBER})`,
  'g',
)

/**
 * 单边数值表述（长方向词在前，否则"大于等于"会被"大于"截断）。
 * 允许方向词后跟"为/是/约"等连接字，匹配片段因此包含这些连接字。
 */
const BOUNDED_PATTERN = new RegExp(
  `(大于等于|小于等于|不少于|不大于|不低于|不高于|不超过|不多于|不小于|多于|少于|大于|小于|超过|低于|高于|至少|≥|≤|>|<)\\s*[为是约]?\\s*(${SIGNED_NUMBER})`,
  'g',
)

/**
 * 后缀式单边表述：`70℃以上`、`80%以下`、`-5℃及以上`。
 *
 * 后缀词的取舍必须长词优先（`及以上` 先于 `以上`），否则 `70℃及以上` 会留下一个
 * 未消费的「及」并让单位提取落到错误位置。
 */
const SUFFIX_BOUND_PATTERN = new RegExp(
  `(${SIGNED_NUMBER})\\s*(?:(${NUMERIC_ANY_UNIT_ALTERNATION}))?\\s*(?:及以上|及以下|或以上|或以下|以上|以下)`,
  'g',
)

/** 弱发现兜底：仅当同段文本没有范围或单边表述时才提取的独立数值。 */
const PLAIN_NUMBER_PATTERN = new RegExp(SIGNED_NUMBER, 'g')

/** 数值后的拉丁/符号单位（1-8 位：mm、MPa、mL、℃、%）。 */
const LATIN_UNIT_PATTERN = /^\s*([A-Za-zμ%％℃°]{1,8})/

/** 数值后的汉字单位候选（最多两个汉字，由 {@link HAN_UNITS} 判定是否成立）。 */
const HAN_UNIT_PATTERN = /^\s*(\p{Script=Han}{1,2})/u

/**
 * 汉字单位表。
 *
 * 汉字之间没有词边界，"数值 + 两个汉字"的贪心匹配会把后续普通词当成单位
 * （"权利要求1-3任一"得到"任一"、"D1 公开了…"得到"公开"），把编号类文本抬成强发现。
 * 因此只承认下表内的单位；表外的书写方式退化为弱发现，不参与判定。
 * 漏掉一个生僻单位只会让结论更保守，误认一个非单位会把结论推向错误方向。
 */
const HAN_UNITS = new Set([
  '度', '毫米', '厘米', '微米', '纳米', '米', '千米',
  '克', '千克', '毫克', '吨', '升', '毫升', '摩尔',
  '秒', '分钟', '小时', '天', '日', '周', '月', '年', '倍', '次', '转',
  '帕', '千帕', '兆帕', '伏', '安', '瓦', '焦', '欧', '赫兹', '分贝',
])

/** 破坏性重叠的说明。 */
const OVERLAP_NOTE = '数值范围重叠或存在共同端点，破坏新颖性'
/** 提示性重叠的说明。 */
const INSIDE_NOTE = '数值点落在对比文件范围内且无共同端点，不破坏新颖性'

/**
 * 对权利要求与对比文件做确定性数值范围核验。
 * @param input - 两侧文本与标识。
 * @returns 含结论、重叠对与可读摘要的核验结果。
 */
export function analyzeNumericRanges(input: NumericRangeInput): NumericRangeAnalysis {
  const claimRanges = input.claims.flatMap(claim => extractNumericFindings(claim.text, { claimId: claim.id }))
  const priorRanges = input.priorArt.flatMap(doc => extractNumericFindings(doc.text, { docId: doc.docId }))
  const scan = findOverlaps(claimRanges, priorRanges)
  const verdict = judgeVerdict(scan, claimRanges, priorRanges)
  const analysis: NumericRangeAnalysis = {
    claimRanges,
    priorRanges,
    overlaps: scan.overlaps,
    incomparablePairs: scan.incomparable,
    verdict,
    llmAgreement: 'n_a',
    summary: '',
    reason: '',
  }
  analysis.reason = buildReason(analysis)
  analysis.summary = buildSummary(analysis)
  return analysis
}

/**
 * 与语义轨结论对照，并在不一致时更新摘要。
 * @param analysis - 确定性核验结果。
 * @param llmVerdict - 语义轨给出的结论（来自 LLM 输出的 verdict 字段）。
 * @returns 带对照结论的新结果；确定性结论为无法判定或 LLM 结论缺失/不可识别时为 n_a。
 */
export function crossCheckNumericVerdict(
  analysis: NumericRangeAnalysis,
  llmVerdict: string | undefined,
): NumericRangeAnalysis {
  if (analysis.verdict === 'inconclusive' || !isNumericVerdict(llmVerdict)) {
    return { ...analysis, llmAgreement: 'n_a', summary: buildSummary({ ...analysis, llmAgreement: 'n_a' }) }
  }
  const llmAgreement: NumericLlmAgreement = llmVerdict === analysis.verdict ? 'agree' : 'disagree'
  return { ...analysis, llmAgreement, summary: buildSummary({ ...analysis, llmAgreement }) }
}

/**
 * 类型守卫：字符串是否为核验结论枚举成员。
 * @param value - 待判定的值。
 * @returns 是核验结论枚举成员时为 true。
 */
export function isNumericVerdict(value: unknown): value is NumericRangeVerdict {
  return value === 'overlapped'
    || value === 'inside_without_endpoint'
    || value === 'no_overlap'
    || value === 'inconclusive'
}

/**
 * 从 LLM 输出的 JSON 文本读取结论字段。
 * @param raw - LLM 返回的 JSON 文本（可为空或不合法）。
 * @returns 可识别的结论，否则 undefined。
 */
export function readNumericVerdict(raw: string): NumericRangeVerdict | undefined {
  const parsed = tryParseJson(raw)
  const verdict = parsed?.verdict
  return isNumericVerdict(verdict) ? verdict : undefined
}

/**
 * 提取一段文本中的数值表述：范围与单边表述优先，均未命中时兜底提取独立数值。
 * @param text - 待提取文本。
 * @param owner - 发现归属方的标识（权利要求或对比文件）。
 * @returns 按出现位置排序的发现列表。
 */
export function extractNumericFindings(
  text: string,
  owner: { claimId?: string; docId?: string } = {},
): NumericRangeFinding[] {
  const raw: Array<{
    index: number
    expression: string
    lower: number
    upper: number
    isPoint: boolean
    /** 连接符前写的单位（`20℃至90℃` 的 `℃`）；组不参与匹配时空串。 */
    leadingUnit: string
  }> = []

  for (const match of text.matchAll(RANGE_PATTERN)) {
    const first = toNumber(capture(match, 1))
    const second = toNumber(capture(match, 3))
    raw.push({
      index: match.index,
      expression: match[0],
      lower: Math.min(first, second),
      upper: Math.max(first, second),
      isPoint: false,
      // 组 2 是可选的连接符前单位，缺席是正常书写形式（`50-80`），故不按编程错误抛出。
      leadingUnit: match[2] ?? '',
    })
  }
  const pushBounded = (match: RegExpExecArray, value: number, isLowerBound: boolean, leadingUnit: string): void => {
    raw.push({
      index: match.index,
      expression: match[0],
      lower: isLowerBound ? value : Number.NEGATIVE_INFINITY,
      upper: isLowerBound ? Number.POSITIVE_INFINITY : value,
      isPoint: false,
      leadingUnit,
    })
  }
  for (const match of text.matchAll(BOUNDED_PATTERN)) {
    pushBounded(match, toNumber(capture(match, 2)), LOWER_BOUND_DIRECTIONS.has(capture(match, 1)), '')
  }
  for (const match of text.matchAll(SUFFIX_BOUND_PATTERN)) {
    // 后缀以「以上」/「以下」结尾，「及以上」「或以下」取末尾两字即可判定方向。
    pushBounded(match, toNumber(capture(match, 1)), match[0].endsWith('以上'), match[2] ?? '')
  }
  // 独立数值（数值点）与范围/单边表述并存时也要提取：上游只在整段文本没有任何
  // 范围表述时才兜底扫描，会把"50-80℃，湿度 70%"里的 70% 丢掉。已匹配片段先用
  // 等长空白遮蔽，避免同一数值被重复提取。
  const remainder = maskMatches(text, [RANGE_PATTERN, BOUNDED_PATTERN, SUFFIX_BOUND_PATTERN])
  for (const match of remainder.matchAll(PLAIN_NUMBER_PATTERN)) {
    const value = toNumber(match[0])
    raw.push({ index: match.index, expression: match[0], lower: value, upper: value, isPoint: true, leadingUnit: '' })
  }

  raw.sort((left, right) => left.index - right.index)
  return raw.map((finding) => {
    // 区间的单位取片段末尾的单位；末尾没写时退回连接符前写的那个（`20℃至90`、`70%—75`），
    // 否则文本已写明的单位会被丢掉，一条本该参与判定的强发现会静默降级为弱发现。
    const trailing = extractUnit(text, finding.index + finding.expression.length)
    const unit = trailing.length > 0 ? trailing : normalizeWrittenUnit(finding.leadingUnit)
    return {
      expression: finding.expression,
      lower: finding.lower,
      upper: finding.upper,
      isPoint: finding.isPoint,
      unit,
      strong: unit.length > 0,
      ...(owner.claimId === undefined ? {} : { claimId: owner.claimId }),
      ...(owner.docId === undefined ? {} : { docId: owner.docId }),
    }
  })
}

/**
 * 提取数值范围与单边表述的原文片段（去重，按出现位置）。
 *
 * 独立数值不在此列：本清单面向模型的"数值范围"条目，数值点由判定侧处理——`findOverlaps`
 * 会把带单位的数值点判为落入对比文件范围或与端点相同（见 `analyzeNumericRanges`），
 * 故调用方判断"是否需要专项分析"时应看判定结果，而不是本清单是否为空。
 * @param text - 待提取文本。
 * @returns 去重后的片段列表。
 */
export function extractNumericRanges(text: string): string[] {
  const expressions = extractNumericFindings(text)
    .filter(finding => !finding.isPoint)
    .map(finding => finding.expression.trim())
  return [...new Set(expressions)]
}

/** 下界方向词；未列出的方向词按上界构造，与保守判定一致（宁多提示不漏报）。 */
const LOWER_BOUND_DIRECTIONS = new Set([
  '大于等于', '不小于', '不少于', '不低于', '多于', '大于', '超过', '高于', '至少', '≥', '>',
])

/**
 * 把数值片段转为数字：Unicode 减号 `−` 与全角减号 `－` 先归一为 ASCII 负号，
 * 否则 `Number()` 会返回 NaN 并让比较全部落空。
 * @param text - 数值片段（可带符号）。
 * @returns 解析出的数值。
 */
function toNumber(text: string): number {
  return Number(text.replace(/[−－]/g, '-'))
}

/**
 * 读取正则捕获组文本。
 *
 * 本模块的数值模式都保证被读的组必然参与匹配，但组缺失在数值判定里会静默变成
 * 0 或 false 并产生错判，因此按编程错误直接抛出，不取默认值。
 * @param match - 匹配结果。
 * @param group - 组序号（1 起）。
 * @returns 捕获的文本。
 */
function capture(match: RegExpMatchArray, group: number): string {
  const value = match[group]
  /* v8 ignore next 3 -- every numeric pattern guarantees the group participates. */
  if (value === undefined) {
    throw new Error(`numeric-range pattern group ${String(group)} did not participate in the match`)
  }
  return value
}

/**
 * 把给定模式命中的片段替换为等长空白，保持其余文本的偏移不变。
 * @param text - 原始文本。
 * @param patterns - 需要遮蔽的模式（须带 g 标志）。
 * @returns 遮蔽后的文本。
 */
function maskMatches(text: string, patterns: readonly RegExp[]): string {
  let masked = text
  for (const pattern of patterns) {
    masked = masked.replace(pattern, match => ' '.repeat(match.length))
  }
  return masked
}

/**
 * 归一化文本里写出的单位：拉丁单位统一小写（本模块的既有行为），摄氏度四种写法统一为 `°`。
 * @param written - 原文里写出的单位。
 * @returns 归一后的单位；空文本返回空串。
 */
function normalizeWrittenUnit(written: string): string {
  return normalizeNumericUnit(written.trim().toLowerCase())
}

/**
 * 提取紧跟数值片段之后的单位并归一化。
 * @param text - 片段所在文本。
 * @param offset - 片段末尾的字符偏移。
 * @returns 归一化单位；无单位或表外汉字时返回空串。
 */
function extractUnit(text: string, offset: number): string {
  const rest = text.slice(offset)
  const latin = LATIN_UNIT_PATTERN.exec(rest)?.[1]
  if (latin !== undefined) return normalizeWrittenUnit(latin)
  const han = HAN_UNIT_PATTERN.exec(rest)?.[1]
  if (han === undefined) return ''
  if (HAN_UNITS.has(han)) return han
  const single = han.slice(0, 1)
  return HAN_UNITS.has(single) ? single : ''
}

/** 重叠扫描结果：可比较对的重叠关系与不可比较对。 */
type OverlapScan = {
  overlaps: NumericRangeOverlap[]
  incomparable: NumericRangeIncomparablePair[]
}

/** 单位换算系数：两侧数值分别乘以自己的系数后落在同一基单位上。 */
type UnitConversion = {
  claimFactor: number
  priorFactor: number
}

/** 不可比原因的展示文本。 */
const INCOMPARABLE_TEXT: Readonly<Record<NumericRangeIncomparableReason, string>> = {
  'dimension-mismatch': '单位量纲不同，不可直接比较',
  'unknown-unit': '单位不在可比词表中，仅同单位可比',
}

/**
 * 求一对单位的换算系数。
 *
 * 单位写法完全相同即视为可比（表外单位也能同单位比较）；否则两侧都必须在换算表内、
 * 属于同一量纲。温度只按摄氏刻度同基准比较，不在此处做温标偏置换算。
 * @param claimUnit - 权利要求侧归一单位。
 * @param priorUnit - 对比文件侧归一单位。
 * @returns 两侧换算系数；不可比时返回原因。
 */
function unitConversion(claimUnit: string, priorUnit: string): UnitConversion | NumericRangeIncomparableReason {
  const claimScale = resolveNumericUnit(claimUnit)
  const priorScale = resolveNumericUnit(priorUnit)
  if (claimUnit === priorUnit) {
    return { claimFactor: claimScale?.factor ?? 1, priorFactor: priorScale?.factor ?? 1 }
  }
  if (claimScale === undefined || priorScale === undefined) return 'unknown-unit'
  if (claimScale.dimension !== priorScale.dimension) return 'dimension-mismatch'
  return { claimFactor: claimScale.factor, priorFactor: priorScale.factor }
}

/**
 * 换算后的两个数值是否可视为同一点。
 *
 * 调用点都先经过严格不等式，因此此处只需处理"接近"：换算因子是十进制小数，
 * 数学上相等的两端点（700mg 与 0.7g）可能差一个 ulp。任一换算值溢出为 ±Infinity
 * 时返回 false，避免把溢出当成共同端点而误报破坏性重叠。
 * @param left - 第一个换算值。
 * @param right - 第二个换算值。
 * @returns 相对误差在 1e-9 内且两侧有限时为 true。
 */
function approximatelyEqual(left: number, right: number): boolean {
  if (!Number.isFinite(left) || !Number.isFinite(right)) return false
  const scale = Math.max(Math.abs(left), Math.abs(right))
  return Math.abs(left - right) <= scale * 1e-9
}

/** 计算重叠对与不可比对：仅强发现参与。 */
function findOverlaps(
  claims: readonly NumericRangeFinding[],
  priors: readonly NumericRangeFinding[],
): OverlapScan {
  const overlaps: NumericRangeOverlap[] = []
  const incomparable: NumericRangeIncomparablePair[] = []
  for (const claim of claims) {
    if (!claim.strong) continue
    for (const prior of priors) {
      if (!prior.strong) continue
      const conversion = unitConversion(claim.unit, prior.unit)
      if (typeof conversion === 'string') {
        incomparable.push({
          claim,
          prior,
          reason: conversion,
          detail: `${claim.expression}（${claim.unit}）× ${prior.expression}（${prior.unit}）：${INCOMPARABLE_TEXT[conversion]}`,
        })
        continue
      }
      const claimLower = claim.lower * conversion.claimFactor
      const claimUpper = claim.upper * conversion.claimFactor
      const priorLower = prior.lower * conversion.priorFactor
      const priorUpper = prior.upper * conversion.priorFactor
      const disjoint =
        (claimLower > priorUpper && !approximatelyEqual(claimLower, priorUpper))
        || (priorLower > claimUpper && !approximatelyEqual(priorLower, claimUpper))
      if (disjoint) continue
      const inside = claim.isPoint
        && claimLower > priorLower
        && claimUpper < priorUpper
        && !approximatelyEqual(claimLower, priorLower)
        && !approximatelyEqual(claimUpper, priorUpper)
      overlaps.push(
        inside
          ? { claim, prior, kind: 'inside_without_endpoint', note: INSIDE_NOTE }
          : { claim, prior, kind: 'overlapped', note: OVERLAP_NOTE },
      )
    }
  }
  return { overlaps, incomparable }
}

/**
 * 汇总结论：破坏性重叠优先；存在不可比对时降为无法判定，除非已有确定的重叠结论。
 * @param scan - 重叠扫描结果。
 * @param claims - 权利要求侧发现。
 * @param priors - 对比文件侧发现。
 * @returns 核验结论。
 */
function judgeVerdict(
  scan: OverlapScan,
  claims: readonly NumericRangeFinding[],
  priors: readonly NumericRangeFinding[],
): NumericRangeVerdict {
  if (!claims.some(finding => finding.strong) || !priors.some(finding => finding.strong)) return 'inconclusive'
  if (scan.overlaps.some(overlap => overlap.kind === 'overlapped')) return 'overlapped'
  if (scan.incomparable.length > 0) return 'inconclusive'
  return scan.overlaps.length > 0 ? 'inside_without_endpoint' : 'no_overlap'
}

/** 生成不可比对的可读说明；无不可比对时为空串。 */
function buildReason(analysis: NumericRangeAnalysis): string {
  if (analysis.incomparablePairs.length === 0) return ''
  return `不可比 ${analysis.incomparablePairs.length} 对：${analysis.incomparablePairs.map(pair => pair.detail).join('；')}`
}

function countStrong(findings: readonly NumericRangeFinding[]): number {
  return findings.filter(finding => finding.strong).length
}

/** 生成可读摘要：两侧发现计数、结论、不可比对说明，以及每个重叠对与对照分歧。 */
function buildSummary(analysis: NumericRangeAnalysis): string {
  const { claimRanges, priorRanges, overlaps, verdict, llmAgreement, reason } = analysis
  const head = '确定性数值范围核验：'
    + `权利要求 ${claimRanges.length} 处数值表述（强 ${countStrong(claimRanges)}），`
    + `对比文件 ${priorRanges.length} 处（强 ${countStrong(priorRanges)}）；`
  const pairs = overlaps.map((overlap) => {
    /* v8 ignore next -- analyzeNumericRanges always supplies the claim id. */
    const claimId = overlap.claim.claimId ?? ''
    /* v8 ignore next -- analyzeNumericRanges always supplies the prior-art id. */
    const priorDocId = overlap.prior.docId ?? ''
    return `；[${claimId} × ${priorDocId}] `
      + `${overlap.claim.expression} ↔ ${overlap.prior.expression}（${overlap.kind}）`
  })
  const reasonNote = reason.length > 0 ? `；${reason}` : ''
  const disagreement = llmAgreement === 'disagree' ? '；与语义轨结论不一致，请重点复核' : ''
  return `${head}${VERDICT_TEXT[verdict]}${reasonNote}${pairs.join('')}${disagreement}`
}
