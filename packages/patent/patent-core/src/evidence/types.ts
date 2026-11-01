/**
 * 证据领域判定类型（移植自 Mady domains/evidence/types.go）。
 *
 * 与 span.ts（记录层）分离：本文件为"三性/证明标准/类型特定"领域判定
 * 的类型契约。记录层只负责"有什么证据"，判定层回答"证据如何采信"。
 */

import type { EvidenceDirection, EvidenceSpan } from './span.ts'

/** 证据类型（对齐 Mady EvidenceType）。 */
export type EvidenceType =
  | 'general'
  | 'foreign_language'
  | 'overseas'
  | 'electronic'
  | 'witness_testimony'
  | 'expert_opinion'
  | 'common_knowledge'
  | 'notarial_certificate'
  | 'burden_of_proof'
  | 'standard_of_proof'
  | 'prior_art_date'
  | 'procedural'
  | 'internet_publication'
  | 'public_use'
  | 'design_comparison'

/** 全部证据类型（对齐 Mady EvidenceType 枚举）。 */
export const EVIDENCE_TYPES: readonly EvidenceType[] = [
  'general',
  'foreign_language',
  'overseas',
  'electronic',
  'witness_testimony',
  'expert_opinion',
  'common_knowledge',
  'notarial_certificate',
  'burden_of_proof',
  'standard_of_proof',
  'prior_art_date',
  'procedural',
  'internet_publication',
  'public_use',
  'design_comparison',
]

/** 平台可信度等级。 */
export type CredibilityLevel = 'high' | 'medium_high' | 'medium' | 'low'

/** 评估方法论（对齐 Mady AssessmentType）。 */
export type AssessmentType =
  | 'triple-attribute'
  | 'binary'
  | 'scored'
  | 'multi_condition'
  | 'credibility_scaled'
  | 'conditional'

/** 日期可靠度。 */
type DateReliability = 'high' | 'medium' | 'low'

/** 日期来源类型。 */
type DateSourceType =
  | 'exact_page_date'
  | 'http_header'
  | 'wayback_machine'
  | 'domain_registration'
  | 'claimed_date'
  | 'inferred'

/** 内容完整性状态（互联网证据）。 */
export type ContentIntegrityStatus = 'verified' | 'partial' | 'unverified'

/** 公开意图（互联网证据）；来源无法解析时是 `unknown`，不得推定为公开。 */
export type PublicIntent = 'public' | 'restricted' | 'unknown'

/** 证据规则（YAML 资产 evidence-rules.yaml 的条目形态）。 */
export type EvidenceRule = {
  ruleId: string
  name: string
  description: string
  legalBasis?: string
  domain?: string
  severity: string
  action: string
  evidenceType: EvidenceType
  check?: {
    type: string
    method: string
    principles?: string[]
    rules?: string[]
    conditions?: string[]
  }
  evidenceAssessment?: {
    assessmentType: AssessmentType
    dimensions?: AssessmentDimension[]
    platformCredibility?: Record<string, { score: number; label: string }>
    exemptions?: string[]
    conditions?: Record<string, string>
  }
}

/** 规则集中的单一评估维度（名称 + 权重 + 分级）。 */
export type AssessmentDimension = {
  name: string
  weight: number
  levels: Array<{ value: string; score: number; description?: string }>
}

/** 完整证据规则集（evidence-rules.yaml 顶层形态）。 */
export type EvidenceRuleSet = {
  weights: { relevance: number; legality: number; authenticity: number }
  rules: EvidenceRule[]
}

/** 单一维度判定结果。 */
export type DimensionJudgment = {
  dimension: string
  score: number
  level: string
  reasoning: string
}

/**
 * 现有技术的时间基准：申请日与优先权日。
 *
 * 专利法第22条第5款的现有技术指申请日以前公开的技术，有优先权的指优先权日；两者同时
 * 提供时以较早者为截止日。基准由调用方给出，本层不从案卷其他字段推断。
 */
export type PriorArtBasis = {
  /** 专利申请日（国际申请为国际申请日）。 */
  filingDate?: string
  /** 优先权日（最早优先权日）。 */
  priorityDate?: string
}

/** 判定所采用的基准来自哪一个日期。 */
export type ReferenceBasis = 'filing-date' | 'priority-date'

/** 日期认定结果。 */
export type DateDetermination = {
  sourceDate: string
  determined: string
  method: string
  isPriorArt: boolean
  /** 本次 isPriorArt 比较所用的截止日（申请日与优先权日中较早者）。 */
  referenceDate?: string
  /** 截止日来自申请日还是优先权日。 */
  referenceBasis?: ReferenceBasis
  reliability?: DateReliability
  sourceType?: DateSourceType
}

/** 四要件单项结果（使用公开）。 */
export type ElementResult = { met: boolean; score: number; detail: string }

/** 使用公开四要件检查结果。 */
export type FourElementsResult = {
  timeElement: ElementResult
  placeElement: ElementResult
  methodElement: ElementResult
  accessibility: ElementResult
  allMet: boolean
  overallScore: number
}

/** 类型特定判定（字段按证据类型按需填充）。 */
export type TypeSpecificJudgment = {
  evidenceType: EvidenceType
  platformCredibility?: CredibilityLevel
  credibilityScore?: number
  translationStatus?: string
  notarizationStatus?: string
  exemptionApplied?: string
  witnessCredibility?: string
  dateDetermination?: DateDetermination
  deadlineStatus?: string
  contentIntegrity?: ContentIntegrityStatus
  publicIntent?: PublicIntent
  platformCategory?: string
  fourElementsCheck?: FourElementsResult
  burdenDifficulty?: string
  chainIntegrity?: string
}

/** 判定中标记的问题。 */
export type JudgmentIssue = { type: string; description: string; severity: string }

/** 外部输入（证据三性之外的人工/流程信息，供规则的不可判定条件）。 */
export type EvidenceExternalInputs = {
  /** 域外证据已公证。 */
  notarized?: boolean
  /** 已认证。 */
  legalized?: boolean
  /** 已附中文译本。 */
  translated?: boolean
  /** 证人与案件利害关系已披露。 */
  witnessDisclosed?: boolean
  /** 待证事实为公知常识。 */
  isWellKnown?: boolean
  /** 待证事实无争议。 */
  isUncontested?: boolean
  /** 举证期限已定义。 */
  deadlineDefined?: boolean
  /** 证据在举证期限内提交。 */
  submissionWithinDeadline?: boolean
  /** 证据收集主体/程序/形式合法（EVI-002 条件）。 */
  collectionLegal?: boolean
  /** 案件类型已识别：invalidation / infringement / new_product_method 等（EVI-020 条件）。 */
  caseType?: string
  /** 支持性证据已计数（EVI-030 证明标准条件）。 */
  supportingCount?: number
  /** 矛盾证据已计数（EVI-030 证明标准条件）。 */
  contradictingCount?: number
  /** 证据保管链可追溯（EVI-050 条件）。 */
  custodyChainTraceable?: boolean
  /** 证据完整性已核验（EVI-050 条件）。 */
  integrityVerified?: boolean
}

/** 单条证据规则的适用结果（judge 时计算，供 rulesMatched 语义与审计）。 */
export type RuleApplication = {
  ruleId: string
  name: string
  action: string
  severity: string
  /** 全部可判定条件满足且无失败条件（规则实际适用）。 */
  satisfied: boolean
  /** 需外部输入才能判定的条件（未提供时规则为 pending 而非失败）。 */
  pendingInputs: string[]
  /** 不满足的条件（规则不适用于本证据）。 */
  failedConditions: string[]
}

/** 单条证据的完整判定结果。 */
export type EvidenceJudgment = {
  spanId: string
  /**
   * 证据方向，取自证据记录。证明标准按本字段归类支持/矛盾证据：方向是立场问题，
   * 评分是证明力问题，二者不能互相替代（高分矛盾证据不是支持证据）。
   */
  direction: EvidenceDirection
  relevanceJudgment?: DimensionJudgment
  legalityJudgment?: DimensionJudgment
  authenticityJudgment?: DimensionJudgment
  typeSpecificJudgment?: TypeSpecificJudgment
  overallScore: number
  confidence: number
  reasoning: string
  flaggedIssues: JudgmentIssue[]
  /** 规则表（evidence-rules.yaml）的适用结果；空表时为空数组。 */
  rulesApplied: RuleApplication[]
}

/** 举证责任分配结果。 */
export type BurdenDetermination = {
  burdenHolder: string
  standard: string
  hasShifted: boolean
  shiftReason?: string
  reasoning: string
}

/** 证明标准评估状态：`unknown-standard` 表示未识别的标准，评估不得认定达标。 */
export type ProofStandardStatus = 'evaluated' | 'unknown-standard'

/** 证明标准评估结果。 */
export type ProofStandardResult = {
  met: boolean
  /** `unknown-standard` 时 `met` 恒为 false，`gaps` 说明原因。 */
  status: ProofStandardStatus
  standard: string
  confidence: number
  supportingCount: number
  contradictingCount: number
  /** 方向为 neutral 的证据件数：既不支持也不反对，不计入达标比较。 */
  neutralCount: number
  reasoning: string
  gaps: string[]
}

/** 证据引擎接口（对齐 Mady EvidenceJudgmentEngine）。 */
export interface EvidenceJudgmentEngine {
  /** 对单条证据做三性 + 类型特定判定（basis/evidenceType/external 为可选增强）。 */
  judge(
    span: EvidenceSpan,
    basis?: PriorArtBasis,
    evidenceType?: EvidenceType,
    external?: EvidenceExternalInputs,
  ): EvidenceJudgment
  /** 批量判定。 */
  batchJudge(
    spans: EvidenceSpan[],
    basis?: PriorArtBasis,
    evidenceType?: EvidenceType,
    external?: EvidenceExternalInputs,
  ): EvidenceJudgment[]
  /** 举证责任分配（caseType: invalidation / infringement / new_product_method 等）。 */
  assessBurdenOfProof(caseType: string, context?: Record<string, string>): BurdenDetermination
  /** 证明标准达成评估（standard: preponderance / clear_and_convincing）。 */
  assessProofStandard(judgments: EvidenceJudgment[], standard: string): ProofStandardResult
  /** 加载 YAML 规则资产（权重/规则表）。 */
  loadRules(yamlText: string, source?: string): void
  getRules(): EvidenceRule[]
  getRulesByType(evidenceType: EvidenceType): EvidenceRule[]
}
