/**
 * src/patent/notice — 程序文书解析 barrel。
 *
 * - office-action.ts：审查意见通知书解析（驳回类型、引用文献、涉及权项、审查员论点，含标注冲突的显式上报）。
 * - grounds.ts：无效、复审、外观设计三类程序的法定理由识别与专利权类型判定。
 *
 * 两个文件都不调用模型，输出是文书中的结构化事实，不是法律结论。
 */

export {
  REJECTION_LABELS,
  REJECTION_ORDER,
  REJECTION_PATTERNS,
  REJECTION_SHORT_LABELS,
  detectRejectionType,
  detectRejectionTypes,
  extractAffectedClaims,
  extractCitations,
  extractExaminerArguments,
  describeCitation,
  formatOfficeActionSummary,
  formatReferenceDocuments,
  parseOfficeAction,
  scanCitations,
  type CitationRelevancy,
  type CitationScan,
  type CitedReference,
  type NoticeRejectionGround,
  type NoticeRejectionType,
  type ParseConflict,
  type ParsedOfficeAction,
} from './office-action.ts'

export {
  detectPatentSubject,
  identifyDesignGrounds,
  identifyInvalidationGrounds,
  identifyReexaminationGrounds,
  type DesignInvalidationGround,
  type GroundFinding,
  type GroundPattern,
  type InvalidationGround,
  type PatentSubject,
  type ReexaminationGround,
  type SharedGround,
} from './grounds.ts'
