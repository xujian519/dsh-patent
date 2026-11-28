/**
 * 单条证据的判定：三性评分、证据类型推断、类型特定检查与综合分/理由。
 * @module @deepseek-ai/dsh-patent-core/evidence/judgment
 */

import {
  determinePublicationDate,
  extractDateFromText,
  inferredMonthEnd,
  isBeforeReferenceDate,
  isPreciseDate,
  parseDateFlexible,
  type PriorArtReference,
} from './date.ts'
import { credibilityToScore, evaluatePublicIntent, platformCategory, platformCredibility } from './credibility.ts'
import { assessBurdenDifficulty, assessChainIntegrity, evaluateFourElements } from './public-use.ts'
import { LEVEL_HIGH, LEVEL_LOW, LEVEL_MEDIUM, LEVEL_MEDIUM_HIGH, hasText, levelFor, TRIPLE_ATTRIBUTE_BASE } from './signals.ts'
import type { EvidenceSpan } from './span.ts'
import type {
  ContentIntegrityStatus,
  DateDetermination,
  DimensionJudgment,
  EvidenceExternalInputs,
  EvidenceJudgment,
  EvidenceRuleSet,
  EvidenceType,
  TypeSpecificJudgment,
} from './types.ts'

/**
 * 相关性评分：来源、权利要求绑定、方向与片段四项完备度累加。
 * @param span - 证据实体。
 * @returns 相关性判定。
 */
export function evaluateRelevance(span: EvidenceSpan): DimensionJudgment {
  let score = TRIPLE_ATTRIBUTE_BASE
  if (hasText(span.sourceUri)) score += 0.1
  if ((span.claimRefs?.length ?? 0) > 0) score += 0.2
  if (span.direction === 'supporting' || span.direction === 'contradicting') score += 0.1
  if (hasText(span.snippet)) score += 0.1
  score = Math.min(score, 1.0)
  return {
    dimension: 'relevance',
    score,
    level: levelFor(
      score,
      [
        { min: 0.85, level: LEVEL_HIGH },
        { min: 0.65, level: LEVEL_MEDIUM_HIGH },
        { min: 0.45, level: LEVEL_MEDIUM },
      ],
      LEVEL_LOW,
    ),
    reasoning: '相关性评估完成',
  }
}

/**
 * 真实性评分。只有当事人自报字段可用的，一律按记录完备度计分：内容哈希在判定阶段无法
 * 重算，只在调用方声明已独立核验（`integrityVerified`）时才计入。
 * @param span - 证据实体。
 * @param external - 外部输入（是否已独立核验完整性）。
 * @returns 真实性判定。
 */
export function evaluateAuthenticity(span: EvidenceSpan, external: EvidenceExternalInputs): DimensionJudgment {
  let score = TRIPLE_ATTRIBUTE_BASE
  if (hasText(span.docVersion)) score += 0.1
  if (hasText(span.contentHash) && external.integrityVerified === true) score += 0.3
  score = Math.min(score, 1.0)
  return {
    dimension: 'authenticity',
    score,
    level: levelFor(
      score,
      [
        { min: 0.85, level: LEVEL_HIGH },
        { min: 0.65, level: LEVEL_MEDIUM_HIGH },
      ],
      LEVEL_LOW,
    ),
    reasoning: '真实性评估完成',
  }
}

/**
 * 合法性评分。来源记录是唯一可核对的输入：内容哈希与合法性无关（哈希证明内容未被改动，
 * 不证明取证合法），不作为合法性的加分项。
 * @param span - 证据实体。
 * @returns 合法性判定。
 */
export function evaluateLegality(span: EvidenceSpan): DimensionJudgment {
  const score = hasText(span.sourceUri) ? 0.7 : TRIPLE_ATTRIBUTE_BASE
  return {
    dimension: 'legality',
    score,
    level: levelFor(
      score,
      [
        { min: 0.85, level: LEVEL_HIGH },
        { min: 0.65, level: LEVEL_MEDIUM_HIGH },
      ],
      LEVEL_LOW,
    ),
    reasoning: '合法性评估完成',
  }
}

/**
 * 从证据特征推断证据类型；显式类型优先，否则按 URI scheme/内容启发式。
 * @param span - 证据实体。
 * @returns 推断出的证据类型。
 */
export function inferEvidenceType(span: EvidenceSpan): EvidenceType {
  const uri = span.sourceUri ?? ''
  if (uri.startsWith('web_pub:') || uri.startsWith('http_archive:')) return 'internet_publication'
  // web: 是工具文档约定的默认格式（"web:https://…判定平台可信度"）：网络来源
  // 走互联网公开类型特定检查（公开日/平台可信度/完整性/公开意图），
  // 而不是落回 general 仅做三性启发式评分。
  if (uri.startsWith('web:')) return 'internet_publication'
  if (uri.startsWith('pub_use:') || uri.startsWith('public_use:')) return 'public_use'
  if (uri.startsWith('witness:')) return 'witness_testimony'
  if (uri.startsWith('patent:') || uri.startsWith('prior_art:')) return 'prior_art_date'
  if (uri.startsWith('notary:') || uri.includes('notariz')) return 'notarial_certificate'
  return 'general'
}

/**
 * 内容完整性状态。当事人自报的哈希串只是可核验锚点，判定路径不重算哈希，因此仅有哈希
 * 记为 `partial`（部分验证）；只有调用方声明已独立核验（`integrityVerified`）才记
 * `verified`。
 */
function evaluateContentIntegrity(span: EvidenceSpan, external: EvidenceExternalInputs): ContentIntegrityStatus {
  if (!hasText(span.contentHash)) return 'unverified'
  return external.integrityVerified === true ? 'verified' : 'partial'
}

/** 互联网公开日期推定（页面标注日期 > Wayback Machine）。 */
function determineInternetPublicationDate(span: EvidenceSpan, reference?: PriorArtReference): DateDetermination {
  return determinePublicationDate(span.docVersion, span.sourceUri, reference)
}

/**
 * 类型特定检查：按证据类型补平台可信度、日期、完整性、公开意图与四要件。
 * @param span - 证据实体。
 * @param evType - 证据类型。
 * @param external - 外部输入。
 * @param reference - 解析出的现有技术截止日。
 * @returns 类型特定判定。
 */
export function evaluateTypeSpecific(
  span: EvidenceSpan,
  evType: EvidenceType,
  external: EvidenceExternalInputs,
  reference?: PriorArtReference,
): TypeSpecificJudgment {
  const ts: TypeSpecificJudgment = { evidenceType: evType }
  const uri = span.sourceUri ?? ''

  switch (evType) {
    case 'electronic': {
      const level = platformCredibility(uri)
      ts.platformCredibility = level
      ts.credibilityScore = credibilityToScore(level)
      break
    }
    case 'foreign_language':
      ts.translationStatus = 'unknown'
      break
    case 'notarial_certificate':
      // 声明证据类型不等于公证已完成：公证状态只来自公证文书记载（外部输入 notarized）。
      ts.notarizationStatus = external.notarized === true ? 'confirmed' : 'unverified'
      break
    case 'witness_testimony':
      ts.witnessCredibility = 'medium'
      break
    case 'common_knowledge':
      // 公知常识免证以 EVI-013 的两项条件（待证事实为公知常识、且无争议）均满足为前提；
      // 外部输入未提供或为 false 时不得宣称「无需举证」，仍按普通证据评分并在 rulesApplied 中标记 pending。
      if (external.isWellKnown === true && external.isUncontested === true) {
        ts.exemptionApplied = '无需举证'
      }
      break
    case 'prior_art_date':
      ts.dateDetermination = determineInternetPublicationDate(span, reference)
      break
    case 'internet_publication': {
      ts.dateDetermination = determineInternetPublicationDate(span, reference)
      const level = platformCredibility(uri)
      ts.platformCredibility = level
      ts.credibilityScore = credibilityToScore(level)
      ts.platformCategory = platformCategory(uri)
      ts.contentIntegrity = evaluateContentIntegrity(span, external)
      ts.publicIntent = evaluatePublicIntent(uri)
      break
    }
    case 'public_use': {
      ts.dateDetermination = determinePublicUseDate(span, reference)
      ts.fourElementsCheck = evaluateFourElements(span)
      ts.burdenDifficulty = assessBurdenDifficulty(ts.fourElementsCheck)
      ts.chainIntegrity = assessChainIntegrity(span, external, ts.fourElementsCheck)
      break
    }
    default:
      break
  }
  return ts
}

/** 使用公开日期推定（主张日期 > 描述文本提取）。 */
function determinePublicUseDate(span: EvidenceSpan, reference?: PriorArtReference): DateDetermination {
  const result: DateDetermination = {
    sourceDate: span.docVersion ?? '',
    determined: 'unknown',
    method: 'public_use',
    isPriorArt: false,
    ...(reference !== undefined ? { referenceDate: reference.date, referenceBasis: reference.basis } : {}),
    reliability: 'low',
    sourceType: 'claimed_date',
  }
  if (span.docVersion !== undefined && span.docVersion !== '') {
    const parsed = parseDateFlexible(span.docVersion)
    if (parsed !== null) {
      if (isPreciseDate(span.docVersion)) {
        // 精确日期（含英文月份格式 "Jan 15, 2023"）：直接采用，不得截为年-月
        result.determined = span.docVersion
        result.reliability = 'medium'
      } else {
        result.determined = inferredMonthEnd(parsed)
        result.reliability = 'low'
      }
      result.isPriorArt = isBeforeReferenceDate(result.determined, reference?.date)
      return result
    }
  }
  const extracted = extractDateFromText(span.snippet ?? '')
  if (extracted !== '') {
    result.sourceDate = extracted
    result.determined = extracted
    result.reliability = 'low'
    result.sourceType = 'inferred'
    result.isPriorArt = isBeforeReferenceDate(extracted, reference?.date)
  }
  return result
}

export function computeOverallScore(judgment: EvidenceJudgment, weights: Readonly<EvidenceRuleSet['weights']>): number {
  const dims: Array<DimensionJudgment | undefined> = [
    judgment.relevanceJudgment,
    judgment.legalityJudgment,
    judgment.authenticityJudgment,
  ]
  const weightValues = [weights.relevance, weights.legality, weights.authenticity]
  let total = 0
  let weightSum = 0
  dims.forEach((d, i) => {
    const weight = weightValues[i]
    /* v8 ignore next -- judge() always sets all three dimension judgments and weights are numbers */
    if (d !== undefined && weight !== undefined) {
      total += d.score * weight
      weightSum += weight
    }
  })
  if (weightSum === 0) return 0.5
  let base = total / weightSum

  const ts = judgment.typeSpecificJudgment
  if (ts?.credibilityScore !== undefined) {
    const modifier = 0.9 + 0.2 * ts.credibilityScore
    base *= modifier
  }
  // 0-1 评分契约：可信度修正可能使综合分超过 1.0（官方平台 0.95 → 修正 1.09），必须截断
  return Math.min(1, base)
}

/**
 * 生成人读判定理由：三性档位与类型检查摘要。
 * @param judgment - 判定结果。
 * @param evType - 证据类型。
 * @returns 以分号分隔的理由文本。
 */
export function buildReasoning(judgment: EvidenceJudgment, evType: EvidenceType): string {
  const parts: string[] = []
  /* v8 ignore next 2 -- judge() always sets the relevance judgment */
  if (judgment.relevanceJudgment !== undefined) {
    parts.push(`关联性[${judgment.relevanceJudgment.level}]: ${judgment.relevanceJudgment.reasoning}`)
  }
  /* v8 ignore next 2 -- judge() always sets the legality judgment */
  if (judgment.legalityJudgment !== undefined) {
    parts.push(`合法性[${judgment.legalityJudgment.level}]: ${judgment.legalityJudgment.reasoning}`)
  }
  /* v8 ignore next 2 -- judge() always sets the authenticity judgment */
  if (judgment.authenticityJudgment !== undefined) {
    parts.push(`真实性[${judgment.authenticityJudgment.level}]: ${judgment.authenticityJudgment.reasoning}`)
  }
  const ts = judgment.typeSpecificJudgment
  /* v8 ignore next -- judge() always sets the type-specific judgment */
  if (ts !== undefined) {
    switch (evType) {
      case 'internet_publication': {
        const dd = ts.dateDetermination
        /* v8 ignore next -- internet_publication always carries a date determination */
        const dateStr = dd !== undefined ? `${dd.determined}(${dd.reliability}/${dd.sourceType})` : '未知'
        /* v8 ignore next -- internet_publication always sets platform credibility, integrity and intent */
        parts.push(
          `类型检查[互联网公开]: 日期=${dateStr}, 可信度=${ts.platformCredibility ?? '未知'}(${(ts.credibilityScore ?? 0).toFixed(2)}), 完整性=${ts.contentIntegrity ?? '未知'}, 意图=${ts.publicIntent ?? '未知'}`,
        )
        break
      }
      case 'electronic':
        /* v8 ignore next -- electronic always sets platform credibility and score */
        parts.push(
          `类型检查[电子证据]: 可信度=${ts.platformCredibility ?? '未知'}(${(ts.credibilityScore ?? 0).toFixed(2)})`,
        )
        break
      case 'public_use': {
        const fe = ts.fourElementsCheck
        /* v8 ignore next -- public_use always sets fourElements, burden difficulty and chain integrity */
        parts.push(
          `类型检查[使用公开]: 四要件=${fe === undefined ? '未评估' : fe.allMet ? '全部满足' : '未全部满足'}, 举证难度=${ts.burdenDifficulty ?? '未知'}, 证据链=${ts.chainIntegrity ?? '未知'}`,
        )
        break
      }
      case 'common_knowledge':
        parts.push(`类型检查[公知常识]: ${ts.exemptionApplied ?? '已完成'}`)
        break
      default:
        parts.push(`类型检查[${evType}]: 已完成`)
        break
    }
  }
  /* v8 ignore next -- the three dimension judgments above always populate parts */
  return parts.length === 0 ? '未执行评估' : parts.join('; ')
}
