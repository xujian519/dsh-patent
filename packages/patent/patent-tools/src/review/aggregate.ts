/**
 * 把 `claim_lint` 与 `validate_specification` 的输出汇总成统一的 {@link ReviewFinding}。
 *
 * 本模块保留引擎输出顺序，不排序、不编号：`domain_check` 按该顺序投影，
 * `review_patent_application` 在自己的报告层排序并赋 `F` 编号。
 * @module @deepseek-ai/dsh-patent-tools/review/aggregate
 */

import {
  lintClaimText,
  type ClaimLintFinding,
  type PatentType,
  type TechDomain,
} from '@deepseek-ai/dsh-patent-core'
import { evaluatedTexts, type EvaluatedText } from '../internal/evaluated-input.ts'
import { figureFormFindings } from './figure-findings.ts'
import type { FigureFormEvidence } from './figure-findings.ts'
// `validate-specification.ts` owns the deterministic spec engine. The intra-package
// import keeps the aggregator off the package entry; do not re-export these functions
// from the entry.
import { checkClaimViolations, validateSpecification } from '../tool/validate-specification.ts'
import { SPEC_SECTION_HEADINGS } from '../tool/spec-style.ts'
import type {
  FigureAnalysisResult,
  SpecNotAssessed,
  SpecViolation,
  ValidateSpecificationInput,
} from '../tool/spec-types.ts'
import type { ReviewFinding, ReviewLocator } from './types.ts'

/** 说明书的五个法定章节标题；只有这些标题才作为 section 定位。 */
const SPEC_SECTION_SET: ReadonlySet<string> = new Set(SPEC_SECTION_HEADINGS)

/** 汇总层的输入；字段与两个检查器的交界值一一对应。 */
export type AggregateReviewInput = {
  /** 权利要求书全文。 */
  claims?: string
  /** 说明书全文。 */
  specification?: string
  /** 摘要。 */
  abstract?: string
  /** 发明名称。 */
  title?: string
  /** 专利类型；缺省时 `validate_specification` 按发明检查并给出 warning。 */
  patentType?: PatentType
  /** 是否有附图；缺省时由说明书文本与附图分析推断。 */
  hasDrawings?: boolean
  /** 技术领域；`chemical`/`software` 各自启用领域规则。 */
  techDomain?: TechDomain
  /** 声明的附图数量。 */
  drawingCount?: number
  /** 请求书中的摘要附图号。 */
  abstractFigureNumber?: number
  /** 附图分析结果；提供时启用图面标号一致性检查。 */
  figureAnalysis?: FigureAnalysisResult[]
  /** 各幅附图的形式证据（生成/复核工具的输出）；提供时评审附图形式。 */
  figures?: readonly FigureFormEvidence[]
  /** 权利要求项数上限；超出时 `claim_lint` 报 `claim-count`。 */
  maxClaims?: number
}

/** 汇总层的输出：findings 保持引擎顺序，未排序、未编号。 */
export type AggregateReviewResult = {
  /** 按引擎顺序排列的 findings。 */
  findings: ReviewFinding[]
  /** 本次实际评审的输入。 */
  reviewed_scope: { claims: boolean; specification: boolean; figures: boolean }
  /** 本次实际读到的文本与指纹。 */
  evaluated: EvaluatedText[]
}

/**
 * 判断文本是否实际提供；空白串按缺失处理。
 * @param text - 调用方传入的文本。
 * @returns 去空白后非空的原文，或 undefined。
 */
function normalizeText(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  return text.trim().length === 0 ? undefined : text
}

/**
 * 选择 `validate_specification` 违规的定位。
 *
 * 只有五个法定说明书标题（技术领域、背景技术、发明内容、附图说明、具体实施方式）
 * 作为 section；`权利要求书` 等非说明书标题的值落到全篇，避免把权项族记录标到
 * 不存在的章节上。
 * @param violation - 一条 spec 违规。
 * @returns 缺陷位置。
 */
function locatorFor(violation: SpecViolation): ReviewLocator {
  const section = violation.section
  if (section !== undefined && SPEC_SECTION_SET.has(section)) return { kind: 'section', section }
  return { kind: 'document' }
}

/**
 * 把一条 `claim_lint` finding 映射为统一 finding。
 * @param finding - 权利要求形式自检的发现。
 * @returns 统一 finding；`claim` 为空时定位为全篇。
 */
export function reviewFindingFromClaimLint(finding: ClaimLintFinding): ReviewFinding {
  const locator: ReviewLocator = finding.claim === null
    ? { kind: 'document' }
    : { kind: 'claim', claim: finding.claim }
  return {
    source: 'claim_lint',
    rule: finding.rule,
    severity: finding.severity,
    message: finding.message,
    locator,
    evidence: finding.evidence,
    basis: finding.basis,
  }
}

/**
 * 把一条 `validate_specification` 违规映射为统一 finding。
 * @param violation - spec 违规。
 * @param source - 产生该违规的入口：完整说明书检查或仅权项检查。
 * @returns 统一 finding。
 */
export function reviewFindingFromSpecViolation(
  violation: SpecViolation,
  source: 'spec_check' | 'claim_check',
): ReviewFinding {
  const locator = locatorFor(violation)
  return {
    source,
    rule: violation.rule,
    severity: violation.severity,
    message: violation.message,
    ...(violation.suggestion === undefined ? {} : { suggestion: violation.suggestion }),
    locator,
    ...(violation.matchedSentence === undefined ? {} : { evidence: violation.matchedSentence }),
    ...(violation.line === undefined ? {} : { line: violation.line }),
  }
}

/**
 * 把一条“确定性规则不能判定”的项折叠为 info finding。
 * @param item - `validate_specification` 的未评估项。
 * @returns 统一 finding；`rule` 沿用稳定的未评估项 id。
 */
function reviewFindingFromNotAssessed(item: SpecNotAssessed): ReviewFinding {
  return {
    source: 'spec_check',
    rule: item.id,
    severity: 'info',
    not_assessed: true,
    message: `${item.label}：${item.reason}`,
    locator: { kind: 'document' },
  }
}

/**
 * 某一半输入缺失时的范围说明。
 * @param half - 缺失的输入。
 * @returns 一条 info finding，声明该部分的评审未执行。
 */
function missingScopeFinding(half: 'claims' | 'specification'): ReviewFinding {
  const message = half === 'claims'
    ? '权利要求未提供：权利要求形式与单一性未评审'
    : '说明书未提供：说明书形式与充分公开未评审'
  return {
    source: 'review',
    rule: 'review_scope',
    severity: 'info',
    not_assessed: true,
    message,
    locator: { kind: 'document' },
  }
}

/**
 * 把汇总输入收窄成 `validate_specification` 的入参；缺席字段不写入。
 * @param input - 汇总输入。
 * @param text - 说明书全文；只做权项检查时为 undefined。
 * @param claims - 权利要求全文。
 * @param abstract - 摘要。
 * @param title - 发明名称。
 * @returns 校验器入参。
 */
function toValidateInput(
  input: AggregateReviewInput,
  text: string | undefined,
  claims: string | undefined,
  abstract: string | undefined,
  title: string | undefined,
): ValidateSpecificationInput {
  return {
    ...(text === undefined ? {} : { text }),
    ...(claims === undefined ? {} : { claims }),
    ...(abstract === undefined ? {} : { abstract }),
    ...(title === undefined ? {} : { title }),
    ...(input.patentType === undefined ? {} : { patent_type: input.patentType }),
    ...(input.hasDrawings === undefined ? {} : { has_drawings: input.hasDrawings }),
    ...(input.techDomain === undefined ? {} : { tech_domain: input.techDomain }),
    ...(input.drawingCount === undefined ? {} : { drawing_count: input.drawingCount }),
    ...(input.abstractFigureNumber === undefined
      ? {}
      : { abstract_figure_number: input.abstractFigureNumber }),
    ...(input.figureAnalysis === undefined ? {} : { figure_analysis: input.figureAnalysis }),
  }
}

/**
 * 汇总两个检查器的 findings，保持引擎顺序并折叠未评估项。
 *
 * 输入可只给权利要求、只给说明书或两者都给；两者都给时，权项覆盖检查由
 * `validateSpecification` 内部运行一次。
 *
 * 两者都缺失时返回两条 `review_scope` 说明，`reviewed_scope` 为 false/false；
 * 工具边界会先拒绝这种调用。
 * @param input - 汇总输入。
 * @returns findings、实际评审范围与输入指纹。
 */
export function aggregateReviewFindings(input: AggregateReviewInput): AggregateReviewResult {
  const claims = normalizeText(input.claims)
  const specification = normalizeText(input.specification)
  const abstract = normalizeText(input.abstract)
  const title = normalizeText(input.title)
  const figures = input.figures !== undefined && input.figures.length > 0 ? input.figures : undefined
  const reviewedScope = {
    claims: claims !== undefined,
    specification: specification !== undefined,
    figures: figures !== undefined,
  }
  const findings: ReviewFinding[] = []

  if (claims !== undefined) {
    const report = lintClaimText(claims, input.maxClaims === undefined ? {} : { maxClaims: input.maxClaims })
    for (const finding of report.findings) findings.push(reviewFindingFromClaimLint(finding))
  }

  if (specification !== undefined) {
    const output = validateSpecification(toValidateInput(input, specification, claims, abstract, title))
    for (const violation of output.violations) {
      findings.push(reviewFindingFromSpecViolation(violation, 'spec_check'))
    }
    for (const item of output.not_assessed) findings.push(reviewFindingFromNotAssessed(item))
  } else if (claims !== undefined) {
    // 没有说明书时只跑权项集合/客体检查；传空文本让覆盖比对自然跳过，
    // 避免 validateSpecification 把空说明书报成“缺少必要章节”。
    const violations = checkClaimViolations(toValidateInput(input, undefined, claims, abstract, title), '')
    for (const violation of violations) findings.push(reviewFindingFromSpecViolation(violation, 'claim_check'))
  }

  if (figures !== undefined) {
    for (const finding of figureFormFindings({
      figures,
      ...(input.drawingCount === undefined ? {} : { drawingCount: input.drawingCount }),
    })) {
      findings.push(finding)
    }
  } else if (input.hasDrawings === true) {
    findings.push({
      source: 'review',
      rule: 'review_scope',
      severity: 'info',
      not_assessed: true,
      message: '提供了附图但未提供附图形式证据（色彩、图号、字高、渲染复核）：附图形式未评审',
      locator: { kind: 'document' },
    })
  }

  if (!reviewedScope.specification) findings.push(missingScopeFinding('specification'))
  if (!reviewedScope.claims) findings.push(missingScopeFinding('claims'))

  return {
    findings,
    reviewed_scope: reviewedScope,
    evaluated: evaluatedTexts({ claims, specification, abstract, title }),
  }
}
