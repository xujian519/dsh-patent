/**
 * src/claim-lint — 权利要求书形式自检的类型与规则标识。
 *
 * 覆盖权利要求书撰写形式中可机械判定的项目：编号、引用方向、
 * 多项从属、引用基础、主题名称、两部分式、用语（功能性、工艺、非技术效果、
 * 商业宣传、引用说明书或附图）、结尾句号，以及权利要求正文之外的内容。
 * 保护范围、新颖性、创造性不在本模块内判定——那些需要对比文件与人工判断。
 */

/** 规则标识；稳定值，报告与用例按此断言。 */
export type ClaimLintRuleId =
  | 'numbering'
  | 'reference-direction'
  | 'multiple-dependent'
  | 'antecedent-basis'
  | 'subject-consistency'
  | 'dependent-limitation'
  | 'two-part-form'
  | 'functional-limitation'
  | 'process-feature'
  | 'step-order'
  | 'non-technical-feature'
  | 'commercial-language'
  | 'external-reference'
  | 'terminator'
  | 'claim-count'
  | 'non-claim-content'

/**
 * 发现级别。
 *
 * `error` 是初审会直接指出的形式缺陷（编号断裂、引用在后、引用基础缺失、主题名称
 * 不一致、结尾标点不合规、正文混入非权利要求内容）；`warning` 是指南要求「尽量
 * 避免」或需要代理师自行判断的写法（功能性限定、工艺特征、两部分式缺省）。
 */
export type ClaimLintSeverity = 'error' | 'warning'

/** 一条 lint 发现。 */
export type ClaimLintFinding = {
  /** 规则标识。 */
  rule: ClaimLintRuleId
  /** 涉及的权利要求序号；文档级发现为 null。 */
  claim: number | null
  /** 严重度。 */
  severity: ClaimLintSeverity
  /** 面向模型与代理师的可读说明。 */
  message: string
  /** 命中处的原文片段。 */
  evidence: string
  /** 规范依据。 */
  basis: string
}

/** 一项解析后的权利要求。 */
export type ParsedClaim = {
  /** 权利要求序号（原文所写，未必连续）。 */
  number: number
  /** 权利要求全文；折行按中文直接拼接。 */
  text: string
  /** 是否独立权利要求（句首没有「根据权利要求…所述」的引用部分）。 */
  independent: boolean
  /** 引用部分原文；独立权利要求为 null。 */
  referenceClause: string | null
  /** 引用部分引用的权项号，升序去重；独立权利要求为空。 */
  references: readonly number[]
  /**
   * 正文中引用部分的权项交叉引用（如「所述转子为权利要求 1 所述的转子」）。
   *
   * 这类引用不使本项成为从属权利要求，但它所指向的权项仍是引用基础的来源，
   * 故与 {@link ParsedClaim.references} 一并进入引用链。
   */
  crossReferences: readonly number[]
  /** 主题名称：从权取引用部分「所述」之后，独权取「一种」之后。 */
  subject: string
}

/** lint 选项。 */
export type ClaimLintOptions = {
  /**
   * 权利要求项数上限；给出时超出即报 `claim-count`。
   *
   * 项数上限是案件撰写约束（费用与策略），不是法定上限，故缺省不检查。
   */
  maxClaims?: number
}

/** 一次自检的完整结果。 */
export type ClaimLintReport = {
  /** 解析出的权利要求（按原文顺序）。 */
  claims: readonly ParsedClaim[]
  /** 全部发现（文档级在前，其后按权利要求序号与规则顺序）。 */
  findings: readonly ClaimLintFinding[]
  /** error 级发现数。 */
  errorCount: number
  /** warning 级发现数。 */
  warningCount: number
  /** 是否存在 error 级发现。 */
  passed: boolean
}
