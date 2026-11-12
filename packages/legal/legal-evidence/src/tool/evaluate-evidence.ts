/**
 * `evaluate_legal_evidence` tool: 评估法律证据的三性（关联性、合法性、真实性）。
 *
 * 工具接收证据输入，调用 LegalEvidenceEngine 做确定性评分，返回三性评分与发现。
 * @module @deepseek-ai/dsh-legal-evidence/tool/evaluate-evidence
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { LegalEvidenceEngine } from '../engine.ts'
import type { LegalEvidenceAssessment, LegalEvidenceInput, LegalEvidenceType } from '../types.ts'
import { LEGAL_EVIDENCE_TYPES } from '../types.ts'

/** Thrown when the tool input cannot be processed. */
export class EvaluateLegalEvidenceToolError extends Error {
  /** 稳定的错误码。 */
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'EvaluateLegalEvidenceToolError'
    this.code = code
  }
}

/** Output of the evaluate_legal_evidence tool. */
export type EvaluateLegalEvidenceOutput = {
  assessment: LegalEvidenceAssessment
  summary: string
}

const DESCRIPTION = [
  '- 评估法律证据的三性（关联性、合法性、真实性），按《民事诉讼法》第 66 条八类法定证据分别判定。',
  '- 输入证据 id、证据类型与相关属性，输出三性评分（0-1）、各维度判定详情与规则检查发现。',
  '- 证据类型包括：当事人陈述(party_statement)、书证(documentary)、物证(physical)、视听资料(audio_visual)、电子数据(electronic)、证人证言(witness_testimony)、鉴定意见(expert_opinion)、勘验笔录(inspection_record)。',
  '- 确定性评分，无模型调用；权重可经 YAML 资产配置。',
  '',
  'Usage notes:',
  '  - 书证应提供原件并核验签章；电子数据应记录哈希并核验完整性；证人证言应披露利害关系并有佐证。',
  '  - 评分低于 0.5 的证据需补强或另行举证。',
].join('\n')

/**
 * Create the `evaluate_legal_evidence` tool.
 * @param engine - the legal evidence engine.
 * @returns the tool definition.
 */
export function createEvaluateLegalEvidenceTool(engine: LegalEvidenceEngine): ToolDefinition {
  return defineTool({
    name: 'evaluate_legal_evidence',
    description: DESCRIPTION,
    parameters: {
      evidenceId: { type: 'string', description: '证据 id（唯一标识）', required: true },
      evidenceType: {
        type: 'string',
        description: '证据类型',
        enum: [...LEGAL_EVIDENCE_TYPES],
        required: true,
      },
      source: { type: 'string', description: '证据来源描述' },
      content: { type: 'string', description: '证据内容摘要' },
      factToProve: { type: 'string', description: '待证事实' },
      hasOriginal: { type: 'boolean', description: '是否提供原件/原物' },
      originalAbsenceReason: { type: 'string', description: '未提供原件的原因' },
      signatureVerified: { type: 'boolean', description: '签章是否核验' },
      formationTimeClear: { type: 'boolean', description: '形成时间是否明确' },
      contentHash: { type: 'string', description: '内容哈希' },
      hashVerified: { type: 'boolean', description: '哈希是否已独立核验' },
      timestamp: { type: 'string', description: '时间戳' },
      storageIntegrityVerified: { type: 'boolean', description: '存储完整性是否核验' },
      witnessHasConflict: { type: 'boolean', description: '证人是否有利害关系' },
      conflictDisclosed: { type: 'boolean', description: '利害关系是否已披露' },
      corroborated: { type: 'boolean', description: '是否有其他证据佐证' },
      expertQualified: { type: 'boolean', description: '鉴定资质是否核验' },
      expertProcedureLegal: { type: 'boolean', description: '鉴定程序是否合法' },
      expertConclusionClear: { type: 'boolean', description: '鉴定结论是否明确' },
      inspectionHasWitness: { type: 'boolean', description: '勘验是否有见证人在场' },
      inspectionRecordComplete: { type: 'boolean', description: '勘验记录是否完整' },
      collectionLegal: { type: 'boolean', description: '证据收集是否合法' },
      formLegal: { type: 'boolean', description: '证据形式是否合法' },
      burdenHolder: { type: 'string', description: '举证责任方', enum: ['plaintiff', 'defendant'] },
      standard: { type: 'string', description: '证明标准' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          assessment: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              evidenceId: { type: 'string' },
              evidenceType: { type: 'string' },
              score: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  relevance: { type: 'number' },
                  legality: { type: 'number' },
                  authenticity: { type: 'number' },
                  overall: { type: 'number' },
                },
              },
              dimensions: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  relevance: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      dimension: { type: 'string' },
                      score: { type: 'number' },
                      level: { type: 'string' },
                      reasoning: { type: 'string' },
                    },
                  },
                  legality: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      dimension: { type: 'string' },
                      score: { type: 'number' },
                      level: { type: 'string' },
                      reasoning: { type: 'string' },
                    },
                  },
                  authenticity: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      dimension: { type: 'string' },
                      score: { type: 'number' },
                      level: { type: 'string' },
                      reasoning: { type: 'string' },
                    },
                  },
                },
              },
              findings: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    ruleId: { type: 'string' },
                    passed: { type: 'boolean' },
                    reason: { type: 'string' },
                    severity: { type: 'string', enum: ['critical', 'warning', 'info'] },
                  },
                },
              },
              burdenHolder: { type: 'string', enum: ['plaintiff', 'defendant'] },
              standard: { type: 'string' },
              reasoning: { type: 'string' },
            },
          },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderToolReport(value as EvaluateLegalEvidenceOutput),
      }],
    },
    execute(args, _ctx) {
      return Promise.resolve(runEvaluate(args, engine))
    },
  })
}

/** Build a LegalEvidenceInput from raw args, filtering out undefined values. */
function buildInput(args: Record<string, unknown>): LegalEvidenceInput {
  const input: LegalEvidenceInput = {
    evidenceId: args.evidenceId as string,
    evidenceType: args.evidenceType as LegalEvidenceType,
  }

  // Only set optional properties if they are defined
  const optionalFields: Array<keyof LegalEvidenceInput> = [
    'source', 'content', 'factToProve', 'hasOriginal', 'originalAbsenceReason',
    'signatureVerified', 'formationTimeClear', 'contentHash', 'hashVerified',
    'timestamp', 'storageIntegrityVerified', 'witnessHasConflict', 'conflictDisclosed',
    'corroborated', 'expertQualified', 'expertProcedureLegal', 'expertConclusionClear',
    'inspectionHasWitness', 'inspectionRecordComplete', 'collectionLegal', 'formLegal',
    'burdenHolder', 'standard',
  ]

  for (const field of optionalFields) {
    const value = args[field]
    if (value !== undefined) {
      // Use type assertion since we know the field names match
      ;(input as Record<string, unknown>)[field] = value
    }
  }

  return input
}

/** Run the evaluation and return the output. */
function runEvaluate(
  args: Record<string, unknown>,
  engine: LegalEvidenceEngine,
): EvaluateLegalEvidenceOutput {
  // `evidenceType` is required and enum-constrained by the parameter schema;
  // `evidenceId` still needs a check because an empty string passes `string`.
  const evidenceId = args.evidenceId as string
  if (evidenceId.trim() === '') {
    throw new EvaluateLegalEvidenceToolError('no_evidence_id', '必须提供证据 id')
  }

  const input = buildInput(args)
  const assessment = engine.assess(input)
  const summary = buildSummary(assessment)
  return { assessment, summary }
}

/** Build a human-readable summary from the assessment. */
function buildSummary(assessment: LegalEvidenceAssessment): string {
  const { score, findings } = assessment
  const criticalFindings = findings.filter(f => !f.passed && f.severity === 'critical')
  const warningFindings = findings.filter(f => !f.passed && f.severity === 'warning')

  const parts: string[] = []
  parts.push(`证据 ${assessment.evidenceId}（${assessment.evidenceType}）三性评估：`)
  parts.push(`  关联性 ${score.relevance.toFixed(2)}，合法性 ${score.legality.toFixed(2)}，真实性 ${score.authenticity.toFixed(2)}`)
  parts.push(`  综合评分 ${score.overall.toFixed(2)}`)

  if (criticalFindings.length > 0) {
    parts.push(`  严重问题 ${criticalFindings.length} 项：${criticalFindings.map(f => f.reason).join('；')}`)
  }
  if (warningFindings.length > 0) {
    parts.push(`  警告 ${warningFindings.length} 项：${warningFindings.map(f => f.reason).join('；')}`)
  }

  if (score.overall < 0.5) {
    parts.push('  建议：评分偏低，需补强证据或另行举证。')
  }

  return parts.join('\n')
}

/** Render the tool report for display. */
function renderToolReport(output: EvaluateLegalEvidenceOutput): string {
  const { assessment } = output
  const lines: string[] = [output.summary]
  lines.push('', '── 评估详情 ──')
  lines.push(`关联性: ${assessment.dimensions.relevance.score.toFixed(2)} [${assessment.dimensions.relevance.level}]`)
  lines.push(`  ${assessment.dimensions.relevance.reasoning}`)
  lines.push(`合法性: ${assessment.dimensions.legality.score.toFixed(2)} [${assessment.dimensions.legality.level}]`)
  lines.push(`  ${assessment.dimensions.legality.reasoning}`)
  lines.push(`真实性: ${assessment.dimensions.authenticity.score.toFixed(2)} [${assessment.dimensions.authenticity.level}]`)
  lines.push(`  ${assessment.dimensions.authenticity.reasoning}`)

  if (assessment.findings.length > 0) {
    lines.push('', '── 规则检查 ──')
    for (const finding of assessment.findings) {
      const status = finding.passed ? '✓' : '✗'
      lines.push(`  ${status} [${finding.severity}] ${finding.ruleId}: ${finding.reason}`)
    }
  }

  return lines.join('\n')
}
