/**
 * src/claim-lint — 权利要求书形式自检。
 *
 * 入口 {@link lintClaimText}：解析文本、逐项执行结构性与用语规则，返回带法条依据的
 * 发现列表。`parseClaimDocument` 与 `referencedTerms` 单独导出，供只需要解析或术语
 * 切分的调用方复用。
 */

export { findAntecedentGaps, referencedTerms, type AntecedentGap, type ReferencedTerm } from './antecedent.ts'
export { lintClaimText } from './checks.ts'
export { parseClaimDocument, type ParsedClaimDocument } from './parse.ts'
export type { ClaimReferenceDefect } from './references.ts'
export type {
  ClaimLintFinding,
  ClaimLintOptions,
  ClaimLintReport,
  ClaimLintRuleId,
  ClaimLintSeverity,
  ParsedClaim,
} from './types.ts'
