/**
 * 撰写域原子：spec-check（说明书/权利要求合规检查）。
 *
 * 包装既有的确定性校验器，不新写规则：
 * - `mode: 'spec'`：`validateSpecification` 的完整说明书规则（A26.3 充分公开、
 *   A26.4 清楚支持），传 `claims` 时同时做权项特征覆盖；按违规 `family` 另写
 *   `spec_form_check_passed`、`spec_claims_check_passed`、
 *   `spec_figure_check_passed`、`spec_prohibitions_check_passed` 与 `spec_not_assessed`，
 *   供 legal-gaps 分条映射法条；
 * - `mode: 'claims'`：只跑 `checkClaimViolations`（A26.4 特征覆盖 + A31.1 单一性 +
 *   权项-实施例覆盖），避免把说明书形式规则套到权利要求文本上。
 *
 * 上游 `enablement_report` 与 `claim_breadth_report` 只作为评估输入记录：A26.3/A26.4
 * 的实体判定分别由 `enablement-report`、`claim-breadth` 原子作出，确定性规则不重判。
 *
 * 输入键可由阶段参数覆盖：`text_key`、`claims_key`、`title_key`、`abstract_key`、
 * `patent_type_key`、`has_drawings_key`、`figure_analysis_key`、`drawing_count_key`、
 * `abstract_figure_number_key`、`claim_units_key`、`coverage_entries_key`。工作流里
 * 收口阶段的产出落在 `state[stage.id]`，故 W-04 用 `claims_key: 'draft'` 读取布局后的权利要求。
 */

import {
  type Atom,
  type PipelineState,
  type StageExecuteInput,
  type StageHandler,
  degraded,
  getStateString,
} from '@deepseek-ai/dsh-patent-core'
import {
  checkClaimViolations,
  computeSpecScore,
  renderSpecification,
  validateSpecification,
} from '../tool/validate-specification.ts'
import type {
  ClaimUnitInput,
  CoverageEntryInput,
  FigureAnalysisResult,
  SpecFamily,
  ValidateSpecificationInput,
} from '../tool/spec-types.ts'
import { firstStateString, resolvePatentType, resolveTechDomain } from './state-values.ts'

/** Families whose errors make the specification's form check fail. */
const FORM_FAMILIES: readonly SpecFamily[] = ['structure', 'title', 'abstract', 'description', 'prohibitions', 'figures']

/** 检查模式：说明书规则集或权利要求规则集。 */
export type SpecCheckMode = 'spec' | 'claims'

/** spec-check 原子：说明书合规（spec）或权利要求合规（claims）的确定性检查。 */
export const specCheckAtom: Atom = {
  name: 'spec-check',
  description: '说明书/权利要求合规检查（A26.3/A26.4/A31）：spec 模式校验说明书规则集并输出形式、权项、附图、禁止性条款分项判定与未评估清单，claims 模式校验权项特征覆盖、单一性与实施例覆盖',
  category: 'gate',
  inputSchema: [
    'specification',
    'source_text',
    'claims_draft',
    'claims',
    'claim_units',
    'coverage_entries',
    'title',
    'invention_title',
    'abstract',
    'patent_type',
    'has_drawings',
    'figure_analysis',
    'drawing_count',
    'abstract_figure_number',
    'enablement_report',
    'claim_breadth_report',
  ],
  outputSchema: [
    'spec_check_report',
    'spec_check_passed',
    'spec_check_score',
    'spec_check_violations',
    'specification_check_report',
    'specification_check_passed',
    'spec_form_check_report',
    'spec_form_check_passed',
    'spec_claims_check_report',
    'spec_claims_check_passed',
    'spec_figure_check_passed',
    'spec_prohibitions_check_passed',
    'spec_not_assessed',
  ],
}

const SPEC_TEXT_KEYS = ['specification', 'source_text', 'text'] as const
const CLAIMS_TEXT_KEYS = ['claims_draft', 'claims', 'claim_text'] as const

/**
 * 读取可选数组键。
 * @param state - 阶段执行态。
 * @param key - 参数指定的键；为空时使用默认键。
 * @param fallback - 默认键。
 * @returns 数组值；缺失或非数组时返回 undefined。
 */
function optionalArray(state: PipelineState, key: string, fallback: string): unknown[] | undefined {
  const value = state[key.length > 0 ? key : fallback]
  return Array.isArray(value) ? value : undefined
}

/**
 * 解析检查模式。
 * @param state - 阶段执行态（阶段参数已合入）。
 * @returns 合法模式；未知值返回 undefined。
 */
function resolveMode(state: PipelineState): SpecCheckMode | undefined {
  const mode = getStateString(state, 'mode', 'spec')
  return mode === 'spec' || mode === 'claims' ? mode : undefined
}

/**
 * 读取可选数值键（正整数）。
 * @param state - 阶段执行态。
 * @param key - 状态键。
 * @returns 数值；缺失、非数字或非正整数时返回 undefined。
 */
function stateNumber(state: PipelineState, key: string): number | undefined {
  const value = state[key]
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/** spec-check 执行器：按模式调用既有校验器并输出结构化违规项。 */
export class SpecCheckHandler implements StageHandler {
  readonly name = 'spec-check'
  readonly category = 'gate' as const

  /**
   * 执行检查阶段。
   * @param input - 阶段执行输入（state 中已合入阶段参数）。
   * @returns 下一管线状态：报告、通过标记、得分与违规项。
   */
  // oxlint-disable-next-line typescript/require-await -- StageHandler contract requires async execute
  async execute(input: StageExecuteInput): Promise<PipelineState> {
    const { state } = input
    const mode = resolveMode(state)
    if (mode === undefined) {
      return degraded('spec-check', `未知 mode：${getStateString(state, 'mode')}（只支持 spec/claims）`)
    }

    const text = firstStateString(state, [getStateString(state, 'text_key'), ...SPEC_TEXT_KEYS])
    const claims = firstStateString(state, [getStateString(state, 'claims_key'), ...CLAIMS_TEXT_KEYS])
    if (text.trim().length === 0) {
      return degraded('spec-check', `输入为空（mode=${mode}，说明书文本缺失）`)
    }
    if (mode === 'claims' && claims.trim().length === 0) {
      return degraded('spec-check', '输入为空（mode=claims，权利要求文本缺失）')
    }

    const claimUnits = optionalArray(state, getStateString(state, 'claim_units_key'), 'claim_units') as
      | ClaimUnitInput[]
      | undefined
    const coverageEntries = optionalArray(
      state,
      getStateString(state, 'coverage_entries_key'),
      'coverage_entries',
    ) as CoverageEntryInput[] | undefined
    const techDomain = resolveTechDomain(state)
    const title = firstStateString(state, [getStateString(state, 'title_key', 'title'), 'title', 'invention_title'])
    const abstract = firstStateString(state, [getStateString(state, 'abstract_key', 'abstract'), 'abstract'])
    const patentType = resolvePatentType(state)
    const hasDrawings = state[getStateString(state, 'has_drawings_key', 'has_drawings')]
    const figureAnalysis = optionalArray(
      state,
      getStateString(state, 'figure_analysis_key', 'figure_analysis'),
      'figure_analysis',
    ) as FigureAnalysisResult[] | undefined
    const drawingCount = stateNumber(state, getStateString(state, 'drawing_count_key', 'drawing_count'))
    const abstractFigureNumber = stateNumber(
      state,
      getStateString(state, 'abstract_figure_number_key', 'abstract_figure_number'),
    )
    const enablementReport = firstStateString(state, ['enablement_report'])
    const claimBreadthReport = firstStateString(state, ['claim_breadth_report'])
    const validationInput: ValidateSpecificationInput = {
      text,
      ...(claims.trim().length > 0 ? { claims } : {}),
      ...(techDomain !== undefined ? { tech_domain: techDomain } : {}),
      ...(title.length > 0 ? { title } : {}),
      ...(abstract.length > 0 ? { abstract } : {}),
      ...(patentType !== undefined ? { patent_type: patentType } : {}),
      ...(typeof hasDrawings === 'boolean' ? { has_drawings: hasDrawings } : {}),
      ...(figureAnalysis !== undefined ? { figure_analysis: figureAnalysis } : {}),
      ...(drawingCount !== undefined ? { drawing_count: drawingCount } : {}),
      ...(abstractFigureNumber !== undefined ? { abstract_figure_number: abstractFigureNumber } : {}),
      ...(claimUnits !== undefined ? { claim_units: claimUnits } : {}),
      ...(coverageEntries !== undefined ? { coverage_entries: coverageEntries } : {}),
      // 上游 enablement-report 原子的报告只作为评估输入记录；降级标记不是报告。
      ...(enablementReport.length > 0 && !enablementReport.startsWith('[WORKFLOW_DEGRADED]')
        ? { enablement_report: enablementReport }
        : {}),
      ...(claimBreadthReport.length > 0 && !claimBreadthReport.startsWith('[WORKFLOW_DEGRADED]')
        ? { claim_breadth_report: claimBreadthReport }
        : {}),
    }

    if (mode === 'spec') {
      const output = validateSpecification(validationInput)
      const formViolations = output.violations.filter(v => FORM_FAMILIES.includes(v.family))
      const claimsViolations = output.violations.filter(v => v.family === 'claims')
      return {
        spec_check_report: renderSpecification(output, '说明书合规检查（A26.3/A26.4）'),
        spec_check_passed: output.passed,
        spec_check_score: output.score,
        spec_check_violations: output.violations,
        specification_check_report: renderSpecification(output, '说明书合规检查（A26.3/A26.4）'),
        specification_check_passed: output.passed,
        spec_form_check_report: renderSpecification(
          { ...output, violations: formViolations, not_assessed: [] },
          '说明书形式检查（细则第20/21条、指南第二部分第二章）',
        ),
        spec_form_check_passed: !formViolations.some(v => v.severity === 'error'),
        ...(claims.trim().length > 0
          ? {
            spec_claims_check_report: renderSpecification(
              { ...output, violations: claimsViolations, not_assessed: [] },
              '权利要求支持与单一性检查（A26.4/A31.1）',
            ),
            spec_claims_check_passed: !claimsViolations.some(v => v.severity === 'error'),
          }
          : {}),
        spec_figure_check_passed: !output.violations.some(v => v.family === 'figures' && v.severity === 'error'),
        spec_prohibitions_check_passed: !output.violations.some(v => v.family === 'prohibitions' && v.severity === 'error'),
        spec_not_assessed: output.not_assessed,
      }
    }

    const violations = checkClaimViolations(validationInput, text)
    const scored = computeSpecScore(violations)
    const report = renderSpecification(
      { passed: scored.passed, score: scored.score, violations, not_assessed: [], evaluated: [] },
      '权利要求合规检查（A26.4/A31.1）',
    )
    return {
      spec_check_report: report,
      spec_check_passed: scored.passed,
      spec_check_score: scored.score,
      spec_check_violations: violations,
      spec_claims_check_report: report,
      spec_claims_check_passed: scored.passed,
    }
  }
}
