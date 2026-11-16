/**
 * 法律域证据判断引擎。
 *
 * 对单条证据做三性判定（关联性/合法性/真实性）+ 类型特定判定，综合评分。
 * 判定只使用证据记录本身与调用方声明的外部输入：自报字段不作为采信依据。
 *
 * 设计对齐专利域证据引擎：确定性判定（无 LLM），权重可经 YAML 资产
 * （assets/legal-evidence-rules.yaml）配置；资产缺失时降级为默认权重。
 */

import { DEFAULT_LEGAL_WEIGHTS, parseLegalRuleSet } from './rule-set.ts'
import type {
  LegalEvidenceAssessment,
  LegalEvidenceDimensionJudgment,
  LegalEvidenceEngineInterface,
  LegalEvidenceFinding,
  LegalEvidenceInput,
  LegalEvidenceRule,
  LegalEvidenceRuleSet,
  LegalEvidenceScore,
  LegalEvidenceType,
} from './types.ts'
import { getEvaluator } from './evaluators/index.ts'
import { hasText } from './evaluators/base.ts'

/** 一条通用规则的可执行判定：失败条件与失败说明。 */
type GeneralCheck = {
  failed: (input: LegalEvidenceInput) => boolean
  reason: string
}

/**
 * 通用规则的 `check` 名称 → 可执行判定。
 *
 * YAML 是通用规则的唯一规则源：条目、id 与 severity 取自资产，这里只把 `check`
 * 映射到判定函数。资产改名或写错 check 时规则不会静默跳过，加载期记警告。
 */
const GENERAL_CHECKS: Record<string, GeneralCheck> = {
  hasFactToProve: {
    failed: input => !hasText(input.factToProve),
    reason: '未明确待证事实，关联性无法确认',
  },
  collectionLegal: {
    failed: input => input.collectionLegal !== true,
    reason: '证据收集合法性未确认',
  },
}

/** 未加载资产时的通用规则；与随包资产的两条 `general` 规则一致。 */
const DEFAULT_GENERAL_RULES: readonly LegalEvidenceRule[] = [
  {
    id: 'LEGAL-EVI-GEN-001',
    description: '证据应与待证事实具有关联性',
    evidenceType: 'general',
    check: 'hasFactToProve',
    severity: 'critical',
  },
  {
    id: 'LEGAL-EVI-GEN-002',
    description: '证据收集应合法',
    evidenceType: 'general',
    check: 'collectionLegal',
    severity: 'critical',
  },
]

/** 法律域证据判断引擎。 */
export class LegalEvidenceEngine implements LegalEvidenceEngineInterface {
  /** 已加载的规则资产；资产缺失或不可解析时保持 null，评分回退默认权重。 */
  private ruleSet: LegalEvidenceRuleSet | null = null
  private readonly warnings: string[] = []

  constructor(yamlText?: string, source = '<inline>') {
    if (yamlText !== undefined) this.loadRules(yamlText, source)
  }

  /** 加载 YAML 规则资产。 */
  loadRules(yamlText: string, source = '<inline>'): void {
    const parsed = parseLegalRuleSet(yamlText, source)
    this.warnings.push(...parsed.warnings)
    this.ruleSet = parsed.ruleSet
    for (const rule of this.generalRules()) {
      if (GENERAL_CHECKS[rule.check] === undefined) {
        this.warnings.push(`法律证据通用规则 ${rule.id} 的 check "${rule.check}" 没有可执行判定，该规则不产生发现`)
      }
    }
  }

  /**
   * 规则加载期间累积的警告。
   * @returns 警告列表的副本。
   */
  getWarnings(): string[] {
    return [...this.warnings]
  }

  /** 获取全部规则。 */
  getRules(): LegalEvidenceRule[] {
    return [...(this.ruleSet?.rules ?? [])]
  }

  /** 按证据类型获取规则。 */
  getRulesByType(evidenceType: LegalEvidenceType): LegalEvidenceRule[] {
    return (this.ruleSet?.rules ?? []).filter(r => r.evidenceType === evidenceType || r.evidenceType === 'general')
  }

  /** 通用规则：资产声明的条目；未加载资产时为内置默认。 */
  private generalRules(): readonly LegalEvidenceRule[] {
    return this.ruleSet?.rules.filter(rule => rule.evidenceType === 'general') ?? DEFAULT_GENERAL_RULES
  }

  /** 三性权重；未加载资产时使用默认权重。 */
  private get weights(): typeof DEFAULT_LEGAL_WEIGHTS {
    return this.ruleSet?.weights ?? DEFAULT_LEGAL_WEIGHTS
  }

  /**
   * 对单条证据做三性判定。
   * @param input - 证据评估输入。
   * @returns 该证据的完整评估结果。
   */
  assess(input: LegalEvidenceInput): LegalEvidenceAssessment {
    const evaluator = getEvaluator(input.evidenceType)

    // 三性判定
    const relevance = evaluator.evaluateRelevance(input)
    const legality = evaluator.evaluateLegality(input)
    const authenticity = evaluator.evaluateAuthenticity(input)

    // 规则检查发现
    const findings = [...evaluator.checkFindings(input), ...this.checkGeneralFindings(input)]

    // 综合评分
    const score = this.computeOverallScore(relevance, legality, authenticity)

    // 推理说明
    const reasoning = this.buildReasoning(relevance, legality, authenticity, findings)

    return {
      evidenceId: input.evidenceId,
      evidenceType: input.evidenceType,
      score,
      dimensions: { relevance, legality, authenticity },
      findings,
      ...(input.burdenHolder !== undefined ? { burdenHolder: input.burdenHolder } : {}),
      ...(input.standard !== undefined ? { standard: input.standard } : {}),
      reasoning,
    }
  }

  /** 批量判定。 */
  batchAssess(inputs: LegalEvidenceInput[]): LegalEvidenceAssessment[] {
    return inputs.map(input => this.assess(input))
  }

  /**
   * 通用规则发现：适用于全部八类法定证据的跨类型检查。
   *
   * 规则条目、id 与 severity 取自 YAML 中 `evidence_type: general` 的声明；`check`
   * 映射到 {@link GENERAL_CHECKS} 的判定函数。只在失败时产出发现；未知 `check`
   * 在加载期记警告，不在这里静默跳过或猜测。
   * @param input - 证据评估输入。
   * @returns 触发失败的通用发现列表。
   */
  private checkGeneralFindings(input: LegalEvidenceInput): LegalEvidenceFinding[] {
    const findings: LegalEvidenceFinding[] = []
    for (const rule of this.generalRules()) {
      const check = GENERAL_CHECKS[rule.check]
      if (check === undefined || !check.failed(input)) continue
      findings.push({
        ruleId: rule.id,
        passed: false,
        reason: check.reason,
        severity: rule.severity,
      })
    }
    return findings
  }

  /** 综合三性评分（权重可经 YAML 配置）。 */
  private computeOverallScore(
    relevance: LegalEvidenceDimensionJudgment,
    legality: LegalEvidenceDimensionJudgment,
    authenticity: LegalEvidenceDimensionJudgment,
  ): LegalEvidenceScore {
    const overall =
      relevance.score * this.weights.relevance
      + legality.score * this.weights.legality
      + authenticity.score * this.weights.authenticity
    return {
      relevance: relevance.score,
      legality: legality.score,
      authenticity: authenticity.score,
      overall: Math.min(1, Math.max(0, overall)),
    }
  }

  /** 构建推理说明。 */
  private buildReasoning(
    relevance: LegalEvidenceDimensionJudgment,
    legality: LegalEvidenceDimensionJudgment,
    authenticity: LegalEvidenceDimensionJudgment,
    findings: LegalEvidenceFinding[],
  ): string {
    const parts: string[] = []
    parts.push(`关联性[${relevance.level}]: ${relevance.reasoning}`)
    parts.push(`合法性[${legality.level}]: ${legality.reasoning}`)
    parts.push(`真实性[${authenticity.level}]: ${authenticity.reasoning}`)

    const criticalFindings = findings.filter(f => !f.passed && f.severity === 'critical' && f.notAssessed !== true)
    if (criticalFindings.length > 0) {
      parts.push(`存在 ${criticalFindings.length} 项严重问题：${criticalFindings.map(f => f.reason).join('；')}`)
    }
    const unassessed = findings.filter(f => f.notAssessed === true)
    if (unassessed.length > 0) {
      parts.push(`存在 ${unassessed.length} 项未评估：${unassessed.map(f => f.reason).join('；')}`)
    }

    return parts.join('; ')
  }
}
