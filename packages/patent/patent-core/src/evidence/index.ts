/**
 * src/patent/evidence — 证据闭环（通用账本层，无领域判定）。
 *
 * 分层（对齐 Mady agentcore/evidence ↔ domains/evidence 分离）：
 * - span.ts：EvidenceSpan 可定位原文切片 + 方向语义
 * - receipt.ts：工具调用账本（Receipt/Ledger）
 * - claimBinding.ts：结论 ↔ 证据绑定 + UnbackedClaims
 * - conflict.ts：冲突检测（claim 冲突 / source 冲突）
 * - 本文件：EvidenceExtension 聚合（实现 tool 层 SatiEvidenceCollector）
 *
 * 领域判定（三性/证明标准）明确留二期 —— 本期只做"记录与回溯"。
 */

import type { SatiEvidenceCollector, SatiEvidenceReceipt } from './protocol.ts'
import { ClaimBinding } from './claimBinding.ts'
import { ConflictDetector, type EvidenceConflict } from './conflict.ts'
import { Ledger, contentHash, type Receipt } from './receipt.ts'
import { createSpan, type EvidenceDirection, type EvidenceSpan } from './span.ts'

export { type EvidenceSpan, type EvidenceDirection, createSpan, isLocatable } from './span.ts'
export { Ledger, contentHash, receiptFromToolExecution, type Receipt } from './receipt.ts'
export {
  buildWorkflowEvidenceLedger,
  EVIDENCE_SNIPPET_LIMIT,
  WORKFLOW_EVIDENCE_SOURCES,
  isWorkflowEvidenceSource,
  priorArtReceiptCitationIds,
  type BuildWorkflowEvidenceLedgerOptions,
  type WorkflowEvidenceLedger,
  type WorkflowEvidenceReceipt,
  type WorkflowEvidenceSource,
} from './ledger.ts'
export { ClaimBinding } from './claimBinding.ts'
export { ConflictDetector, type EvidenceConflict } from './conflict.ts'
export { EvidenceEngine } from './engine.ts'
export { inferEvidenceType } from './judgment.ts'
export { evaluateFourElements } from './public-use.ts'
export { STANDARD_PREPONDERANCE, STANDARD_CLEAR_CONVINCING } from './proof-standard.ts'
export type {
  EvidenceJudgment,
  EvidenceJudgmentEngine,
  EvidenceExternalInputs,
  DimensionJudgment,
  TypeSpecificJudgment,
  BurdenDetermination,
  ProofStandardResult,
  ProofStandardStatus,
  EvidenceRule,
  EvidenceRuleSet,
  EvidenceType,
  CredibilityLevel,
  DateDetermination,
  FourElementsResult,
  PriorArtBasis,
  ReferenceBasis,
} from './types.ts'
export { platformCredibility, credibilityToScore, platformCategory, evaluatePublicIntent } from './credibility.ts'
export {
  parseDateFlexible,
  isPreciseDate,
  isMonthOnlyDate,
  inferredMonthEnd,
  extractDateFromText,
  isBeforeReferenceDate,
  priorArtReference,
  determinePublicationDate,
  extractWaybackMachineDate,
  cleanEvidenceURI,
} from './date.ts'
export { loadEvidenceRulesEngine } from './rule-loader.ts'
export type { PriorArtReference } from './date.ts'

/**
 * EvidenceExtension：证据闭环聚合体（实现 SatiEvidenceCollector）。
 * 经 ToolRuntime 自动收 Receipt 入 Ledger；上层把 Receipt 提升为 EvidenceSpan、
 * 绑定结论，再查询无证据支持结论与冲突。
 */
export class EvidenceExtension implements SatiEvidenceCollector {
  /** 工具调用账本。 */
  readonly ledger = new Ledger()
  /** 结论-证据绑定。 */
  readonly binding = new ClaimBinding()
  /** 冲突检测器。 */
  readonly conflicts = new ConflictDetector()
  private readonly spans = new Map<string, EvidenceSpan>()

  /** 每 turn 开始调用：账本重置（对齐 Mady BeforeTurn 语义）。 */
  startTurn(): void {
    this.ledger.reset()
  }

  /** SatiEvidenceCollector 实现：ToolRuntime 每次工具执行后调用。 */
  recordReceipt(receipt: SatiEvidenceReceipt): void {
    this.ledger.record(receipt)
  }

  /**
   * 把 Receipt 提升为 EvidenceSpan（方向由调用方/领域层指定）。
   * @param receipt - 工具调用收据。
   * @param direction - 证据方向（支持/矛盾/中性）。
   * @param snippet - 原文摘录（可选，缺省取 receipt.resultText）。
   * @returns 构造并注册的证据实体。
   */
  spanFromReceipt(receipt: Receipt, direction: EvidenceDirection, snippet?: string): EvidenceSpan {
    const spanSnippet = snippet ?? receipt.resultText
    const span = createSpan({
      turnId: receipt.turnId,
      receiptId: receipt.toolCallId,
      // 哈希必须覆盖最终存入的摘录文本（可能是调用方传入的自定义片段），
      // 否则完整性校验对 resultText 重算会与存储的 snippet 不一致。
      ...(spanSnippet ? { contentHash: contentHash(spanSnippet) } : {}),
      ...(spanSnippet !== undefined ? { snippet: spanSnippet } : {}),
      ...(receipt.path ? { sourceUri: `file://${receipt.path}` } : {}),
      direction,
    })
    this.spans.set(span.id, span)
    return span
  }

  /**
   * 注册已构造的证据（供跨 turn 恢复/外部导入）。
   * @param span - 证据实体。
   */
  registerSpan(span: EvidenceSpan): void {
    this.spans.set(span.id, span)
  }

  /**
   * 按 id 读取证据。
   * @param spanId - 证据 id。
   * @returns 证据实体，不存在返回 undefined。
   */
  getSpan(spanId: string): EvidenceSpan | undefined {
    return this.spans.get(spanId)
  }

  /**
   * 列出全部证据。
   * @returns 全部证据实体数组。
   */
  listSpans(): EvidenceSpan[] {
    return [...this.spans.values()]
  }

  /**
   * 绑定证据到结论，并回写证据的 claimRefs。
   * @param claimId - 结论 id。
   * @param spanId - 证据 id。
   */
  bind(claimId: string, spanId: string): void {
    this.binding.bind(claimId, spanId)
    const span = this.spans.get(spanId)
    if (span) {
      span.claimRefs = [...new Set([...(span.claimRefs ?? []), claimId])]
    }
  }

  /**
   * 无证据支持的结论列表（结论必须显式登记为 claim）。
   * @param claimIds - 全部已登记结论 id。
   * @returns 无证据支持的结论 id 数组。
   */
  unbackedClaims(claimIds: Iterable<string>): string[] {
    return this.binding.unbackedClaims(claimIds)
  }

  /**
   * 无证据支持提示：存在无证据结论时返回人读提示（供质量门/工具调用），
   * 无则返回 undefined（不打断流程，仅提示降级）。
   * @param claimIds - 全部已登记结论 id。
   * @returns 人读提示，无无证据结论时返回 undefined。
   */
  unbackedNotice(claimIds: Iterable<string>): string | undefined {
    const unbacked = this.binding.unbackedClaims(claimIds)
    if (unbacked.length === 0) return undefined
    return `以下结论缺少证据支持（Unbacked Claims）: ${unbacked.join('、')} —— 请人工复核或补充证据来源。`
  }

  /**
   * 检测给定结论集合内的证据冲突。
   * @param claimIds - 结论 id 集合。
   * @returns 检测到的证据冲突列表。
   */
  detectConflicts(claimIds: Iterable<string>): EvidenceConflict[] {
    const ids = [...claimIds]
    const spansByClaim = new Map<string, string[]>()
    for (const claimId of ids) {
      spansByClaim.set(claimId, this.binding.spansForClaim(claimId))
    }
    return this.conflicts.detect({ claimIds: ids, spansByClaim, spansById: this.spans })
  }

  /** 清空账本、绑定与证据（重置）。 */
  clear(): void {
    this.ledger.reset()
    this.binding.clear()
    this.spans.clear()
  }
}
