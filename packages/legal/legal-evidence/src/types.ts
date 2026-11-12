/**
 * 法律域证据类型定义（《民事诉讼法》第 66 条八类法定证据）。
 *
 * 与专利域证据类型分离：专利域关注现有技术/专利文献/产品文献，法律域关注
 * 诉讼/仲裁中的法定证据种类。本文件定义法律域证据三性（关联性、合法性、真实性）
 * 判定的类型契约。
 */

/** 法定证据种类（《民事诉讼法》第 66 条）。 */
export type LegalEvidenceType =
  | 'party_statement'      // 当事人的陈述
  | 'documentary'          // 书证
  | 'physical'             // 物证
  | 'audio_visual'         // 视听资料
  | 'electronic'           // 电子数据
  | 'witness_testimony'    // 证人证言
  | 'expert_opinion'       // 鉴定意见
  | 'inspection_record'    // 勘验笔录

/** 全部法定证据种类。 */
export const LEGAL_EVIDENCE_TYPES: readonly LegalEvidenceType[] = [
  'party_statement',
  'documentary',
  'physical',
  'audio_visual',
  'electronic',
  'witness_testimony',
  'expert_opinion',
  'inspection_record',
]

/** 证据三性评分。 */
export type LegalEvidenceScore = {
  /** 关联性（0-1）：证据与待证事实的逻辑关联程度。 */
  relevance: number
  /** 合法性（0-1）：证据收集主体、程序、形式的合法性。 */
  legality: number
  /** 真实性（0-1）：证据本身的真实可靠程度。 */
  authenticity: number
  /** 综合评分（0-1）：按权重计算的加权平均分。 */
  overall: number
}

/** 单维度判定结果。 */
export type LegalEvidenceDimensionJudgment = {
  /** 维度名称。 */
  dimension: 'relevance' | 'legality' | 'authenticity'
  /** 评分（0-1）。 */
  score: number
  /** 等级（high/medium_high/medium/low）。 */
  level: string
  /** 判定理由。 */
  reasoning: string
}

/** 证据判定发现（单条规则的适用结果）。 */
export type LegalEvidenceFinding = {
  /** 规则 id。 */
  ruleId: string
  /** 是否通过。 */
  passed: boolean
  /** 判定理由。 */
  reason: string
  /** 严重程度。 */
  severity: 'critical' | 'warning' | 'info'
}

/**
 * 证据规则（YAML 资产 legal-evidence-rules.yaml 的条目形态）。
 *
 * 规则是声明性元数据：`check` 与 `conditions` 记录判定器执行的检查，
 * 引擎不解释它们；可执行逻辑位于各类型判定器。
 */
export type LegalEvidenceRule = {
  /** 规则 id（如 LEGAL-EVI-001）。 */
  id: string
  /** 规则描述。 */
  description: string
  /** 适用的证据类型。 */
  evidenceType: LegalEvidenceType | 'general'
  /** 判定器中对应检查的名称。 */
  check: string
  /** 严重程度。 */
  severity: 'critical' | 'warning' | 'info'
  /** 法律依据（可选）。 */
  legalBasis?: string
  /** 检查条件（可选）。 */
  conditions?: string[]
}

/** 完整证据规则集（legal-evidence-rules.yaml 顶层形态）。 */
export type LegalEvidenceRuleSet = {
  /** 三维度权重。 */
  weights: { relevance: number; legality: number; authenticity: number }
  /** 规则条目列表。 */
  rules: LegalEvidenceRule[]
}

/** 证据评估输入（调用方提供）。 */
export type LegalEvidenceInput = {
  /** 证据 id（唯一标识）。 */
  evidenceId: string
  /** 证据类型。 */
  evidenceType: LegalEvidenceType
  /** 证据来源描述（书证来源、物证来源等）。 */
  source?: string
  /** 证据内容摘要或原文。 */
  content?: string
  /** 是否提供原件/原物。 */
  hasOriginal?: boolean
  /** 未提供原件的原因说明。 */
  originalAbsenceReason?: string
  /** 签章/签名是否核验。 */
  signatureVerified?: boolean
  /** 形成时间是否明确。 */
  formationTimeClear?: boolean
  /** 内容哈希（电子数据/视听资料）。 */
  contentHash?: string
  /** 哈希是否已独立核验。 */
  hashVerified?: boolean
  /** 时间戳（电子数据）。 */
  timestamp?: string
  /** 存储完整性是否核验。 */
  storageIntegrityVerified?: boolean
  /** 证人与案件是否有利害关系。 */
  witnessHasConflict?: boolean
  /** 利害关系是否已披露。 */
  conflictDisclosed?: boolean
  /** 证人证言是否有其他证据佐证。 */
  corroborated?: boolean
  /** 鉴定机构/鉴定人资质是否核验。 */
  expertQualified?: boolean
  /** 鉴定程序是否合法。 */
  expertProcedureLegal?: boolean
  /** 鉴定结论是否明确。 */
  expertConclusionClear?: boolean
  /** 勘验笔录是否有见证人在场。 */
  inspectionHasWitness?: boolean
  /** 勘验过程是否记录完整。 */
  inspectionRecordComplete?: boolean
  /** 证据收集是否合法。 */
  collectionLegal?: boolean
  /** 证据形式是否合法。 */
  formLegal?: boolean
  /** 待证事实。 */
  factToProve?: string
  /** 举证责任方。 */
  burdenHolder?: 'plaintiff' | 'defendant'
  /** 证明标准。 */
  standard?: string
}

/** 证据评估结果。 */
export type LegalEvidenceAssessment = {
  /** 证据 id。 */
  evidenceId: string
  /** 证据类型。 */
  evidenceType: LegalEvidenceType
  /** 三性评分。 */
  score: LegalEvidenceScore
  /** 各维度判定详情。 */
  dimensions: {
    relevance: LegalEvidenceDimensionJudgment
    legality: LegalEvidenceDimensionJudgment
    authenticity: LegalEvidenceDimensionJudgment
  }
  /** 规则检查发现。 */
  findings: LegalEvidenceFinding[]
  /** 举证责任方（可选）。 */
  burdenHolder?: 'plaintiff' | 'defendant'
  /** 证明标准（可选）。 */
  standard?: string
  /** 综合推理说明。 */
  reasoning: string
}

/** 证据引擎接口。 */
export interface LegalEvidenceEngineInterface {
  /** 对单条证据做三性判定。 */
  assess(input: LegalEvidenceInput): LegalEvidenceAssessment
  /** 批量判定。 */
  batchAssess(inputs: LegalEvidenceInput[]): LegalEvidenceAssessment[]
  /** 加载 YAML 规则资产。 */
  loadRules(yamlText: string, source?: string): void
  /** 获取全部规则。 */
  getRules(): LegalEvidenceRule[]
  /** 按证据类型获取规则。 */
  getRulesByType(evidenceType: LegalEvidenceType): LegalEvidenceRule[]
}
