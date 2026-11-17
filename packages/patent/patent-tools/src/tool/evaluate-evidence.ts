/**
 * `evaluate_evidence` tool: deterministic triple-attribute evidence judgment
 * (relevance / legality / authenticity) plus type-specific checks and burden
 * allocation. Ported from Sati's evaluateEvidence.ts; the engine and evidence
 * rules live in @deepseek-ai/dsh-patent-core (rules asset shipped by dsh-patent-rule).
 *
 * The EVI-011 guard fields (notarized / legalized / translated) are carried
 * through as external inputs; the monotonic deny guard is registered separately
 * by @deepseek-ai/dsh-patent-rule.
 * @module @deepseek-ai/dsh-patent-tools/tool/evaluate-evidence
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { isDataRecord, recordChild, recordFlag, recordList, recordNumberOr, recordText, recordValue, textList } from './internal/json-read.ts'
import { toJsonArray, toJsonValue } from './internal/json-value.ts'
import {
  createSpan,
  loadEvidenceRulesEngine,
} from '@deepseek-ai/dsh-patent-core'
import type { EvidenceDirection, EvidenceType } from '@deepseek-ai/dsh-patent-core'
import { EvidenceEngine } from '@deepseek-ai/dsh-patent-core'

/** Input for the evaluate_evidence tool (triple-attribute evidence judgment). */
export type EvaluateEvidenceInput = {
  /** Evidence description (verbatim excerpt; public-use four-elements identification). */
  snippet: string
  /** Source URI (web:https://... / patent:CN... / file://...). */
  sourceUri?: string
  /** Evidence date (multi-format). */
  docVersion?: string
  /** Content hash (authenticity/integrity check). */
  contentHash?: string
  /** Evidence direction: supporting / contradicting / neutral. */
  direction?: EvidenceDirection
  /** Bound conclusion ids (relevance bonus). */
  claimRefs?: string[]
  /** Explicit evidence type (defaults to sourceUri-scheme inference). */
  evidenceType?: EvidenceType
  /** 证据原文语言（zh/中文/en/ja 等）；域外证据声明非中文时 EVI-011 同时要求中文译本。 */
  language?: string
  /** Filing date (prior-art date determination). */
  filingDate?: string
  /** Earliest priority date; the earlier of the two bounds prior-art status. */
  priorityDate?: string
  /** Case type (burden allocation): invalidation / infringement / new_product_method. */
  caseType?: string
  /** Overseas evidence notarized (EVI-011). */
  notarized?: boolean
  /** Overseas evidence legalized (EVI-011). */
  legalized?: boolean
  /** Foreign evidence translated (EVI-011). */
  translated?: boolean
  /** Witness interest disclosed (EVI-012). */
  witnessDisclosed?: boolean
  /** Well-known fact (EVI-013). */
  isWellKnown?: boolean
  /** Uncontested fact (EVI-013). */
  isUncontested?: boolean
  /** Deadline defined (EVI-051). */
  deadlineDefined?: boolean
  /** Submitted within deadline (EVI-051). */
  submissionWithinDeadline?: boolean
  /** Collection legality (EVI-002). */
  collectionLegal?: boolean
  /** Supporting evidence count (EVI-030). */
  supportingCount?: number
  /** Contradicting evidence count (EVI-030). */
  contradictingCount?: number
  /** Custody chain traceable (EVI-050). */
  custodyChainTraceable?: boolean
  /** Integrity verified (EVI-050). */
  integrityVerified?: boolean
}

/** Output of the evaluate_evidence tool (judgment, burden, matched/pending rules). */
export type EvaluateEvidenceOutput = {
  judgment: {
    spanId: string
    overallScore: number
    confidence: number
    relevance: { score: number; level: string }
    legality: { score: number; level: string }
    authenticity: { score: number; level: string }
    typeSpecific?: Record<string, unknown>
    flaggedIssues: Array<{ type: string; description: string; severity: string }>
    reasoning: string
  }
  burden?: { burdenHolder: string; standard: string; hasShifted: boolean; reasoning: string }
  /** Actually-applied rules (all conditions satisfied). */
  rulesMatched: Array<{ ruleId: string; name: string; action: string; severity: string }>
  /** Rules awaiting external inputs. */
  rulesPending: Array<{ ruleId: string; name: string; pendingInputs: string[] }>
}

/** Injected engine + rule-asset dirs (tests override; production wires the core evidence engine). */
export type EvaluateEvidenceDeps = {
  engine?: EvidenceEngine
  ruleDirs?: readonly string[]
}

const DESCRIPTION = '对专利证据做确定性三性判定（相关性/合法性/真实性）与类型特定检查（电子证据/互联网公开/使用公开四要件/域外证据/公知常识），输出综合评分、举证责任分配与实际适用的证据规则。在 OA 答复、无效宣告论证引用证据前调用，可提前发现证据缺陷。'

/** Render the canonical evidence judgment into model-facing prose. */
function scoreLine(label: string, value: unknown): string {
  return `- ${label}: ${recordNumberOr(value, 'score', 0)} (${recordText(value, 'level')})`
}

function renderEvidence(value: {
  judgment: unknown
  burden?: unknown
  rulesMatched: readonly unknown[]
  rulesPending: readonly unknown[]
}): string {
  const judgment = value.judgment
  const lines = [
    `evaluate_evidence(${recordText(judgment, 'spanId')}): 综合 ${recordNumberOr(judgment, 'overallScore', 0)} / 置信度 ${recordNumberOr(judgment, 'confidence', 0)}`,
    scoreLine('相关性', recordChild(judgment, 'relevance')),
    scoreLine('合法性', recordChild(judgment, 'legality')),
    scoreLine('真实性', recordChild(judgment, 'authenticity')),
    '',
    recordText(judgment, 'reasoning'),
  ]
  const burden = value.burden
  if (isDataRecord(burden)) {
    lines.push('', `举证责任: ${recordText(burden, 'burdenHolder')}（标准 ${recordText(burden, 'standard')}${recordFlag(burden, 'hasShifted') ? '，已转移' : ''}）`, recordText(burden, 'reasoning'))
  }
  if (value.rulesMatched.length > 0) {
    lines.push('', '适用规则:', ...value.rulesMatched.map(rule => `- [${recordText(rule, 'action')}] ${recordText(rule, 'ruleId')} ${recordText(rule, 'name')}`))
  }
  if (value.rulesPending.length > 0) {
    lines.push('', '待外部输入:', ...value.rulesPending.map(rule => `- ${recordText(rule, 'ruleId')} ${recordText(rule, 'name')}: 需 ${textList(recordValue(rule, 'pendingInputs')).join('、')}`))
  }
  const issues = recordList(judgment, 'flaggedIssues')
  if (issues.length > 0) {
    lines.push('', '问题:', ...issues.map(issue => `- [${recordText(issue, 'severity')}] ${recordText(issue, 'type')}: ${recordText(issue, 'description')}`))
  }
  return lines.join('\n')
}

/**
 * Build the `evaluate_evidence` tool over an injectable judgment engine.
 * @param deps - optional engine + rule-asset dir injection.
 * @returns a registry-ready tool definition.
 */
export function createEvaluateEvidenceTool(deps: EvaluateEvidenceDeps = {}): ToolDefinition {
  let loadedEngine: EvidenceEngine | undefined = deps.engine
  const resolveEngine = (): EvidenceEngine => {
    loadedEngine ??= loadEvidenceRulesEngine(deps.ruleDirs ?? []).engine
    return loadedEngine
  }
  return defineTool({
    name: 'evaluate_evidence',
    description: DESCRIPTION,
    parameters: {
      snippet: { type: 'string', required: true, description: '待判定证据描述（原文摘录）。' },
      sourceUri: { type: 'string', description: '来源 URI，如 web:https://example.com/page、patent:CN123、file:///path。判定平台可信度与证据类型。' },
      docVersion: { type: 'string', description: '证据日期，如 2023-01-02、2023年1月、20230102、Jan 15, 2023。' },
      contentHash: { type: 'string', description: '内容哈希（真实性/完整性校验）。' },
      direction: { type: 'string', enum: ['supporting', 'contradicting', 'neutral'], description: '证据方向。' },
      claimRefs: { type: 'array', items: { type: 'string' }, description: '绑定的结论 id 列表。' },
      evidenceType: { type: 'string', description: '显式证据类型（缺省按 sourceUri 推断）。', enum: ['general','foreign_language','overseas','electronic','witness_testimony','expert_opinion','common_knowledge','notarial_certificate','burden_of_proof','standard_of_proof','prior_art_date','procedural','internet_publication','public_use','design_comparison'] },
      language: { type: 'string', description: '证据原文语言（zh/中文/en/ja 等）。域外证据声明非中文时，EVI-011 同时要求中文译本；中文原件不要求。' },
      filingDate: { type: 'string', description: '专利申请日（公开日是否早于申请日）。' },
      priorityDate: { type: 'string', description: '优先权日。有优先权的，现有技术截止日取申请日与优先权日中较早者（专利法第22条第5款）。' },
      caseType: { type: 'string', description: '案件类型：invalidation / infringement / new_product_method。' },
      notarized: { type: 'boolean', description: '域外证据已公证（EVI-011 条件）。' },
      legalized: { type: 'boolean', description: '域外证据已认证（EVI-011 条件）。' },
      translated: { type: 'boolean', description: '外文证据已附中文译本（EVI-011 条件）。' },
      witnessDisclosed: { type: 'boolean', description: '证人利害关系已披露（EVI-012 条件）。' },
      isWellKnown: { type: 'boolean', description: '待证事实为公知常识（EVI-013 条件）。' },
      isUncontested: { type: 'boolean', description: '待证事实无争议（EVI-013 条件）。' },
      deadlineDefined: { type: 'boolean', description: '举证期限已定义（EVI-051 条件）。' },
      submissionWithinDeadline: { type: 'boolean', description: '证据在期限内提交（EVI-051 条件）。' },
      collectionLegal: { type: 'boolean', description: '证据收集主体/程序/形式合法（EVI-002 条件）。' },
      supportingCount: { type: 'number', description: '支持性证据已计数（EVI-030 证明标准条件）。' },
      contradictingCount: { type: 'number', description: '矛盾证据已计数（EVI-030 证明标准条件）。' },
      custodyChainTraceable: { type: 'boolean', description: '证据保管链可追溯（EVI-050 条件）。' },
      integrityVerified: { type: 'boolean', description: '证据完整性已核验（EVI-050 条件）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          judgment: { type: 'json', required: true },
          burden: { type: 'json' },
          rulesMatched: { type: 'array', required: true },
          rulesPending: { type: 'array', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderEvidence(value) }],
    },
    // oxlint-disable-next-line typescript/require-await -- tool contract requires async execute
    async execute(args) {
      const engine = resolveEngine()
      const span = createSpan({
        snippet: args.snippet,
        ...(args.sourceUri !== undefined ? { sourceUri: args.sourceUri } : {}),
        ...(args.docVersion !== undefined ? { docVersion: args.docVersion } : {}),
        ...(args.contentHash !== undefined ? { contentHash: args.contentHash } : {}),
        direction: args.direction ?? 'neutral',
        ...(args.claimRefs !== undefined ? { claimRefs: args.claimRefs } : {}),
      })
      const external = {
        ...(args.notarized !== undefined ? { notarized: args.notarized } : {}),
        ...(args.legalized !== undefined ? { legalized: args.legalized } : {}),
        ...(args.translated !== undefined ? { translated: args.translated } : {}),
        ...(args.witnessDisclosed !== undefined ? { witnessDisclosed: args.witnessDisclosed } : {}),
        ...(args.isWellKnown !== undefined ? { isWellKnown: args.isWellKnown } : {}),
        ...(args.isUncontested !== undefined ? { isUncontested: args.isUncontested } : {}),
        ...(args.deadlineDefined !== undefined ? { deadlineDefined: args.deadlineDefined } : {}),
        ...(args.submissionWithinDeadline !== undefined ? { submissionWithinDeadline: args.submissionWithinDeadline } : {}),
        ...(args.collectionLegal !== undefined ? { collectionLegal: args.collectionLegal } : {}),
        ...(args.caseType !== undefined ? { caseType: args.caseType } : {}),
        ...(args.supportingCount !== undefined ? { supportingCount: args.supportingCount } : {}),
        ...(args.contradictingCount !== undefined ? { contradictingCount: args.contradictingCount } : {}),
        ...(args.custodyChainTraceable !== undefined ? { custodyChainTraceable: args.custodyChainTraceable } : {}),
        ...(args.integrityVerified !== undefined ? { integrityVerified: args.integrityVerified } : {}),
      }
      const basis = {
        ...(args.filingDate !== undefined ? { filingDate: args.filingDate } : {}),
        ...(args.priorityDate !== undefined ? { priorityDate: args.priorityDate } : {}),
      }
      const judgment = engine.judge(span, basis, args.evidenceType, external)
      const burden = args.caseType !== undefined ? engine.assessBurdenOfProof(args.caseType) : undefined

      return {
        judgment: toJsonValue({
          spanId: judgment.spanId,
          overallScore: Number(judgment.overallScore.toFixed(3)),
          confidence: judgment.confidence,
          relevance: { score: judgment.relevanceJudgment?.score ?? 0, level: judgment.relevanceJudgment?.level ?? 'low' },
          legality: { score: judgment.legalityJudgment?.score ?? 0, level: judgment.legalityJudgment?.level ?? 'low' },
          authenticity: { score: judgment.authenticityJudgment?.score ?? 0, level: judgment.authenticityJudgment?.level ?? 'low' },
          ...(judgment.typeSpecificJudgment !== undefined
            ? { typeSpecific: judgment.typeSpecificJudgment as Record<string, unknown> }
            : {}),
          flaggedIssues: judgment.flaggedIssues,
          reasoning: judgment.reasoning,
        }),
        ...(burden !== undefined ? { burden: toJsonValue(burden) } : {}),
        rulesMatched: toJsonArray(judgment.rulesApplied
          .filter(r => r.satisfied)
          .map(r => ({ ruleId: r.ruleId, name: r.name, action: r.action, severity: r.severity }))),
        rulesPending: toJsonArray(judgment.rulesApplied
          .filter(r => r.pendingInputs.length > 0)
          .map(r => ({ ruleId: r.ruleId, name: r.name, pendingInputs: r.pendingInputs }))),
      }
    },
  })
}
