/**
 * `validate_specification` tool: deterministic patent-specification compliance
 * checker ported from Sati's `validateSpecification.ts`.
 *
 * Deterministic rules: five-part structure completeness and order, the heading
 * set, invention-title length, abstract length / keywords / drawing / headings,
 * specification figure-reference form (parentheses, figure-number spacing,
 * paragraph numbering), vague wording, drawing-description and figure-mark
 * consistency, embodiment presence, numeric-range endpoints and midpoints,
 * effect-data quantification, chemical characterization, claim-specification
 * feature coverage (A26.4), independent-claim unity (A31.1), and the
 * claim-to-embodiment coverage matrix.
 *
 * Sati's SMILES-validity spot-check is gated behind the injected
 * `isRdkitAvailable` dependency; RDKit is not bundled in dsh, so that check
 * reports nothing by default.
 * @module @deepseek-ai/dsh-patent-tools/tool/validate-specification
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { locateMatch } from '@deepseek-ai/dsh-patent-core'
import { evaluatedTexts, EVALUATED_TEXT_SCHEMA, renderEvaluatedTexts } from '../internal/evaluated-input.ts'
import { checkAbstract } from './spec-abstract.ts'
import { checkClaimCoverage, checkClaimSet } from './spec-claim-coverage.ts'
import { checkClarity } from './spec-clarity.ts'
import {
  checkBackgroundCitations,
  checkEffectComparison,
  checkSequenceListing,
  checkTermConsistency,
  checkTextMedia,
  checkUtilityModelFigureContent,
} from './spec-description-extras.ts'
import {
  checkFigureDescriptionName,
  checkFigureMarkConsistency,
  checkFigureNumberDuplicate,
  checkFigureNumberSequence,
  checkFigureReferenceMissing,
  checkDrawingCount,
  countInDrawingSection,
  figureNumbersIn,
  hasFigureNumberSuffix,
} from './spec-figure-marks.ts'
import { checkNumericRangeCoverage, formatRange } from './spec-numeric.ts'
import { checkEmptySections, checkPlaceholderContent, sectionBodies } from './spec-placeholder.ts'
import { checkSpecProhibitions, checkTitle } from './spec-prohibitions.ts'
import { checkSpecStyle } from './spec-style.ts'
import { checkStructure, requiredSections } from './spec-structure.ts'
import {
  CHEM_CHARACTERIZATION_TERMS,
  checkChemicalCharacterization,
  checkEffectQuantification,
  checkSmilesValidity,
} from './spec-quantification.ts'
import type {
  SpecNotAssessed,
  SpecViolation,
  ValidateSpecificationDeps,
  ValidateSpecificationInput,
  ValidateSpecificationOutput,
} from './spec-types.ts'

/** Sections whose headings appear in the text. */
function presentSections(text: string): Set<string> {
  return new Set(sectionBodies(text).map(section => section.name))
}

/**
 * Score: each error deducts 0.25, each warning 0.1, floor 0; passed depends only on errors.
 * @param violations - the violations to score.
 * @returns whether the specification passed and the computed score.
 */
export function computeSpecScore(violations: SpecViolation[]): { passed: boolean; score: number } {
  const errors = violations.filter(v => v.severity === 'error').length
  const warnings = violations.filter(v => v.severity === 'warning').length
  const score = Math.max(0, Math.min(1, 1 - errors * 0.25 - warnings * 0.1))
  return { passed: errors === 0, score: Math.round(score * 100) / 100 }
}

/**
 * Pure entry point: validate the specification against the rule set.
 *
 * The rule families run in the order the report lists their violations.
 * @param input - the specification fields to validate.
 * @returns the validation result (passed, score, violations, evaluated inputs).
 */
export function validateSpecification(input: ValidateSpecificationInput): ValidateSpecificationOutput {
  const text = input.text ?? ''
  const title = input.title?.trim() ?? ''
  const present = presentSections(text)
  const structure = checkStructure(input, text, present)
  const required = requiredSections(structure.patentType, structure.hasDrawings)
  const violations: SpecViolation[] = [
    ...structure.violations,
    ...checkTitle(title),
    ...checkSpecStyle(text, input.abstract, required),
    ...checkPlaceholderContent(text),
    ...checkEmptySections(text),
    ...checkSpecProhibitions(text),
    ...checkAbstract(input, structure.hasDrawings),
    ...checkClarity(text),
    ...checkBackgroundCitations(text),
    ...checkEffectComparison(text),
    ...checkSequenceListing(text),
    ...checkTextMedia(text),
    ...checkTermConsistency(text),
    ...drawingViolations(input, text),
    ...checkUtilityModelFigureContent(text, input.patent_type),
    ...embodimentViolations(text),
    ...effectViolations(text),
    ...chemicalViolations(input, text),
    ...checkClaimViolations(input, text),
  ]
  const scored = computeSpecScore(violations)
  return {
    passed: scored.passed,
    score: scored.score,
    violations,
    not_assessed: notAssessedItems(input, structure.hasDrawings),
    evaluated: evaluatedTexts({
      text: input.text,
      title: input.title,
      abstract: input.abstract,
      claims: input.claims,
      enablement_report: input.enablement_report,
    }),
  }
}

/**
 * Build the not-assessed list: every item deterministic rules cannot decide,
 * with the reason it stays open.
 * @param input - the specification input under validation.
 * @param hasDrawings - whether the specification has drawings.
 * @returns the not-assessed items.
 */
function notAssessedItems(input: ValidateSpecificationInput, hasDrawings: boolean): SpecNotAssessed[] {
  // A26.3 由 enablement-report 原子（带原文锚点）判定，确定性规则不再把它列为未评估。
  const items: SpecNotAssessed[] = [
    { id: 'claim-support-breadth', label: '权利要求概括范围（A26.4）', reason: '概括是否超出实施例支持需要实体判断' },
  ]
  if (input.title !== undefined && input.title.trim().length > 0) {
    items.push({ id: 'title-name-place', label: '发明名称中的人名、地名', reason: '名称是否属于非技术词语需要语义判断' })
  }
  if (hasDrawings) {
    items.push(
      { id: 'drawing-legibility', label: '附图清晰度', reason: '缩小到三分之二后是否清晰需要图面判断' },
      { id: 'drawing-same-scale', label: '同一附图的比例一致性', reason: '比例是否一致需要制图信息' },
      { id: 'photo-suitability', label: '照片是否属于特殊情况', reason: '照片适用性需要审查判断' },
    )
    if (input.figure_analysis === undefined || input.figure_analysis.length === 0) {
      items.push({ id: 'figure-analysis', label: '图面标号一致性', reason: '未提供附图分析结果，图面标号未核' })
    }
    if (input.abstract_figure_number === undefined) {
      items.push({ id: 'abstract-drawing-designation', label: '摘要附图指定', reason: '未提供请求书中的摘要附图号' })
    }
    if (hasFigureNumberSuffix(input.text ?? '')) {
      items.push({ id: 'figure-number-suffix', label: '带字母后缀的图号', reason: '首期只核纯数字与中文数字图号' })
    }
  }
  return items
}

/**
 * Body figure references against the drawing section, and, when figure
 * analysis is supplied, the figure-mark consistency check.
 * @param input - the specification input under validation.
 * @param text - the specification text.
 * @param present - the required sections found in the text.
 * @returns drawing violations.
 */
function drawingViolations(input: ValidateSpecificationInput, text: string): SpecViolation[] {
  const violations: SpecViolation[] = []
  const present = presentSections(text)
  const hasDrawingSection = present.has('附图说明')
  const bodyRefs = figureNumbersIn(text).length - countInDrawingSection(text)
  if (hasDrawingSection && bodyRefs === 0) {
    violations.push({
      rule: 'drawings',
      family: 'figures',
      severity: 'warning',
      section: '附图说明',
      message: '存在附图说明章节但正文未引用任何附图（图1、图2...）',
      suggestion: '在具体实施方式中引用附图标记，与附图说明对应',
    })
  }
  if (!hasDrawingSection && bodyRefs > 0) {
    violations.push({
      rule: 'drawings',
      family: 'figures',
      severity: 'warning',
      message: `正文引用了 ${bodyRefs} 处附图但缺少附图说明章节`,
      suggestion: '补充附图说明章节，逐图说明图名和内容',
    })
  }

  violations.push(
    ...checkFigureNumberSequence(text),
    ...checkFigureNumberDuplicate(text),
    ...checkFigureReferenceMissing(text),
    ...checkFigureDescriptionName(text),
    ...checkDrawingCount(text, input.drawing_count),
  )
  if (input.figure_analysis?.length) {
    violations.push(...checkFigureMarkConsistency(text, input.figure_analysis, input.claims))
  }
  return violations
}

/**
 * Embodiment presence and the numeric-range endpoint / midpoint coverage of
 * 具体实施方式.
 * @param text - the specification text.
 * @returns embodiment and numeric-range violations.
 */
function embodimentViolations(text: string): SpecViolation[] {
  const violations: SpecViolation[] = []
  const embodimentCount = (text.match(/(?:本|该)?实施例(?:\s*[一二三四五六七八九十\d]+)?/g) ?? []).length
  if (text.trim().length > 0 && embodimentCount === 0) {
    violations.push({
      rule: 'embodiments',
      family: 'description',
      severity: 'error',
      section: '具体实施方式',
      message: '说明书未记载任何实施例',
      suggestion: '撰写至少一个可实施实施例，覆盖权利要求的全部技术特征',
    })
  }

  if (text.trim().length > 0) {
    const { endpointMissing, midpointMissing } = checkNumericRangeCoverage(text)
    if (endpointMissing.length > 0) {
      violations.push({
        rule: 'numeric_range_endpoints',
        family: 'description',
        severity: 'error',
        section: '具体实施方式',
        message: `数值范围缺少端点值实施例：${endpointMissing.map(formatRange).join('、')}`,
        suggestion: '为每个数值范围补充两端值附近（最好是两端值）的实施例',
      })
    }
    if (midpointMissing.length > 0) {
      violations.push({
        rule: 'numeric_range_midpoint',
        family: 'description',
        severity: 'warning',
        section: '具体实施方式',
        message: `数值范围缺少中间值实施例：${midpointMissing.map(formatRange).join('、')}`,
        suggestion: '范围较宽时补充至少一个中间值的实施例，支持中间范围内的概括',
      })
    }
  }
  return violations
}

/**
 * Effect statements lacking quantitative data. Only the first three are named.
 * @param text - the specification text.
 * @returns effect-quantification violations.
 */
function effectViolations(text: string): SpecViolation[] {
  const violations: SpecViolation[] = []
  const vagueEffects = checkEffectQuantification(text)
  if (vagueEffects.length > 0) {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- vagueEffects are slices of text, so a match always exists
    const location = locateMatch(text, vagueEffects)!
    violations.push({
      rule: 'effect_data_quantified',
      family: 'description',
      severity: 'warning',
      section: '发明内容',
      message: `效果表述缺少定量数据支撑：${vagueEffects.slice(0, 3).join('；')}`,
      suggestion: '补充定量效果数据（对比实验/百分比/提升幅度），建立效果与区别技术特征的对应',
      line: location.line,
      matchedSentence: location.matchedSentence,
    })
  }
  return violations
}

/**
 * Chemical-domain product characterization data. Reported only when none of
 * the characterization terms appear at all.
 * @param input - the specification input under validation.
 * @param text - the specification text.
 * @returns chemical-characterization violations.
 */
function chemicalViolations(input: ValidateSpecificationInput, text: string): SpecViolation[] {
  const violations: SpecViolation[] = []
  if (input.tech_domain === 'chemical' && text.trim().length > 0) {
    const missingTerms = checkChemicalCharacterization(text)
    if (missingTerms.length === CHEM_CHARACTERIZATION_TERMS.length) {
      violations.push({
        rule: 'chemical_characterization',
        family: 'description',
        severity: 'warning',
        section: '具体实施方式',
        message: '化学领域说明书未提供任何产物表征数据',
        suggestion: '补充产物表征数据（NMR/MS/IR/元素分析/XRPD/晶胞参数等至少其一），并与具体实施例对应',
      })
    }
  }
  return violations
}

/**
 * Claim-feature coverage of the specification (A26.4), then independent-claim
 * unity and the claim-to-embodiment coverage matrix from the structured inputs.
 *
 * Exposed for the `spec-check` atom's claims mode, which runs only the claim
 * rules instead of the whole specification rule set.
 * @param input - the specification input under validation.
 * @param text - the specification text.
 * @returns claim violations, in claim order.
 */
export function checkClaimViolations(input: ValidateSpecificationInput, text: string): SpecViolation[] {
  const violations: SpecViolation[] = []
  if (input.claims && input.claims.trim().length > 0 && text.trim().length > 0) {
    const { missing: missingFeatures, total } = checkClaimCoverage(input.claims, text)
    if (total >= 3 && missingFeatures.length > 0) {
      const rate = missingFeatures.length / total
      violations.push({
        rule: 'claim_coverage',
        family: 'claims',
        severity: rate > 0.5 ? 'error' : 'warning',
        section: '发明内容',
        message: `权利要求中的 ${missingFeatures.length}/${total} 个技术特征未在说明书记载：${missingFeatures.join('、')}`,
        suggestion: '在发明内容/具体实施方式中补充记载上述技术特征，确保说明书支持权利要求（A26.3/A26.4）',
      })
    }
  }

  violations.push(...checkClaimSet(input))
  return violations
}

/**
 * Render the canonical validation result into model-facing prose.
 * @param value - the validation result.
 * @param heading - report heading; the claims mode names the narrower rule set.
 * @returns the rendered Markdown text.
 */
export function renderSpecification(value: ValidateSpecificationOutput, heading = '专利说明书校验'): string {
  const errors = value.violations.filter(v => v.severity === 'error')
  const warnings = value.violations.filter(v => v.severity === 'warning')
  const evaluated = renderEvaluatedTexts(value.evaluated)
  const trailer = evaluated === '' ? '' : `\n\n${evaluated}`
  const open = value.not_assessed.length === 0
    ? '未评估项：无'
    : ['未评估项（确定性规则不能判断，需人工或实体审查）：', ...value.not_assessed.map(item => `- ${item.id}：${item.label}——${item.reason}`)].join('\n')
  // `passed` 只表示已运行的确定性规则未发现 error，不表示符合专利法。
  const head = `${heading}：${value.passed ? '通过（确定性规则未发现 error）' : '未通过'}（得分 ${value.score}）`
  if (value.violations.length === 0) {
    return `${head}\n共 0 项违规（error 0、warning 0）\n\n${open}${trailer}`
  }
  const rows = value.violations.map((v) => {
    const where = v.section === undefined ? '' : `（${v.section}）`
    const at = v.line !== undefined && v.matchedSentence !== undefined ? `（第 ${v.line} 行「${v.matchedSentence}」）` : ''
    const line = `- [${v.severity}]${where} ${v.message}${at}`
    return v.suggestion === undefined ? line : `${line}\n  → ${v.suggestion}`
  })
  return [
    head,
    '',
    `共 ${value.violations.length} 项违规（error ${errors.length}、warning ${warnings.length}）：`,
    '',
    ...rows,
    '',
    open,
  ].join('\n') + trailer
}

const DESCRIPTION = [
  '验证专利说明书是否符合撰写要求（确定性规则，无 LLM 调用）。',
  '- 结构完整性：按专利类型与有无附图计算必要章节，且顺序符合《专利法实施细则》第二十条；实用新型必须有附图；占位标记与空章节报 error',
  '- 标题集合：说明书只允许规定章节标题（正文内的「要解决的技术问题／技术方案／有益效果／实施例一」等一律不是标题）',
  '- 附图引用形式：说明书记载标记不加括号（指南第二部分第二章 §2.2.6）、图号写作图1、图号连续且不重复、附图说明有图名、正文引用可解析、段落编号提示',
  '- 发明名称长度（>40 字 error、26–40 字 warning）与摘要长度（≤300 字）、摘要关键词、摘要附图号、摘要不得引用权利要求或使用宣传语',
  '- 禁止性条款：说明书不得引用权利要求编号，不得使用商业宣传用语或残留内部流程标记（细则第二十条第三款）',
  '- 模糊表述（按上下文匹配「约 10%」「10% 左右」，不误伤「约束」「左右两侧」）、附图说明与图引用一致性、实施例存在性',
  '- 权利要求-说明书特征覆盖（A26.4）、数值范围端点与中间值实施例',
  '- 独立权利要求之间的单一性（A31.1，传 claim_units 时）',
  '- 权项—实施例覆盖矩阵（A26.3/A26.4，传 coverage_entries 时；覆盖度由 features 与 embodiment_refs 计算，不接受调用方给定的覆盖度结论）',
  '- 效果数据定量性、化学领域产物表征数据（tech_domain=chemical 时）',
  '- 背景技术引证的国别/公开号/日期、有益效果与现有技术的对比、序列表引用、正文图片与表格位置、术语与附图标记一致性、实用新型附图内容（均为 warning，启发式）',
  '',
  '用法：说明书初稿完成后调用；传入 text（说明书全文）即可，另可传 title / abstract / claims / tech_domain / patent_type / has_drawings / drawing_count / abstract_figure_number / figure_analysis / claim_units / coverage_entries 启用相应校验。',
  '',
  'patent_type 未传时按发明检查并给出 warning；has_drawings 未传时从图号与附图分析推断。',
  '',
  'passed 只表示已运行的确定性规则未发现 error，不表示符合专利法；not_assessed 列出确定性规则不能判断的事项，需人工或实体审查。',
  '',
  '注意：SMILES 合法性抽检依赖 RDKit（本环境未内置），自动跳过，不影响其余规则。',
  '',
  '结果末尾的「评估输入」给出本次实际读到的各文本字段的字数与指纹：转述结果时请一并保留，便于与另一次运行对照是否读的是同一份文本。',
].join('\n')
/**
 * Build the `validate_specification` tool.
 * @param deps - optional injected `isRdkitAvailable` probe (defaults to false).
 * @returns a registry-ready tool definition.
 */
export function createValidateSpecificationTool(deps?: ValidateSpecificationDeps): ToolDefinition {
  const isRdkitAvailable = deps?.isRdkitAvailable ?? (() => false)
  return defineTool({
    name: 'validate_specification',
    description: DESCRIPTION,
    parameters: {
      text: { type: 'string', description: '说明书全文（markdown，含章节标题）' },
      title: { type: 'string', description: '发明名称（可选，单独校验长度）' },
      abstract: { type: 'string', description: '摘要（可选，校验长度/关键词/附图标记括号/宣传语）' },
      claims: { type: 'string', description: '权利要求书全文（可选，用于特征覆盖比对）' },
      tech_domain: {
        type: 'string',
        enum: ['mechanical', 'electrical', 'chemical', 'software', 'general'],
        description: '技术领域（chemical 时附加化学表征数据校验）',
      },
      patent_type: {
        type: 'string',
        enum: ['invention', 'utility_model'],
        description: '专利类型；未传时按发明检查并给出 warning。实用新型必须附图',
      },
      has_drawings: { type: 'boolean', description: '是否有附图；未传时从图号、附图说明与附图分析推断' },
      drawing_count: { type: 'number', description: '声明的附图数量（可选，与附图说明条目数比对）' },
      abstract_figure_number: { type: 'number', description: '请求书中的摘要附图号（可选，有附图时校验该图存在）' },
      figure_analysis: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            usable: { type: 'boolean', required: true, description: '分析结果是否可用（组件提取成功）' },
            components: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  refNumber: { type: 'string', required: true, description: '附图标记号（与图面标号一致）' },
                },
              },
              description: '识别的组件列表',
            },
          },
        },
        description: '附图智能分析结果（可选）：提供时执行图文一致性校验',
      },
      claim_units: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            number: { type: 'number', required: true, description: '权利要求编号（与权利要求书一致）' },
            kind: {
              type: 'string',
              required: true,
              enum: ['independent', 'dependent'],
              description: '独立或从属权利要求（仅独立权利要求进入单一性比较）',
            },
            preamble: { type: 'string', required: true, description: '前序部分，如"一种智能门锁"' },
            characterized: { type: 'string', description: '"其特征在于"之后的特征部分' },
          },
        },
        description: '结构化权利要求（可选）：提供时执行独立权利要求单一性自检（A31.1）',
      },
      coverage_entries: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            claim_id: { type: 'string', required: true, description: '权利要求标识，形如 claim_1' },
            features: {
              type: 'array',
              required: true,
              items: { type: 'string' },
              description: '该权利要求的技术特征',
            },
            embodiment_refs: {
              type: 'array',
              required: true,
              items: { type: 'string' },
              description: '支持该权利要求的实施例原文片段',
            },
          },
        },
        description: '权项—实施例覆盖条目（可选）：提供时计算覆盖矩阵，逐特征判定是否有实施例支持',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          passed: { type: 'boolean', required: true },
          score: { type: 'number', required: true },
          violations: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                rule: { type: 'string', required: true },
                family: {
                  type: 'string',
                  required: true,
                  enum: ['structure', 'title', 'abstract', 'description', 'prohibitions', 'figures', 'claims'],
                },
                severity: { type: 'string', required: true, enum: ['error', 'warning'] },
                section: { type: 'string' },
                message: { type: 'string', required: true },
                suggestion: { type: 'string' },
                line: { type: 'number' },
                matchedSentence: { type: 'string' },
              },
            },
          },
          not_assessed: {
            type: 'array',
            required: true,
            description: '确定性规则不能判断、需要人工或实体审查的事项',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true, description: '稳定标识，与工作流状态及 legal-gaps 共用' },
                label: { type: 'string', required: true, description: '未评估项名称' },
                reason: { type: 'string', required: true, description: '确定性规则不能判断的原因' },
              },
            },
          },
          evaluated: { type: 'array', required: true, items: EVALUATED_TEXT_SCHEMA },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSpecification(value) }],
    },
    execute: (args) => {
      const input = args as unknown as ValidateSpecificationInput
      const output = validateSpecification(input)
      // Sati's SMILES spot-check appends warnings only when RDKit is available;
      // dsh does not bundle RDKit, so this is a no-op (see checkSmilesValidity).
      /* v8 ignore start -- checkSmilesValidity always returns [] in dsh (RDKit unbundled). */
      const smileChecks = checkSmilesValidity(input.text ?? '', isRdkitAvailable)
      if (smileChecks.length > 0) {
        output.violations.push(...smileChecks)
        const scored = computeSpecScore(output.violations)
        output.passed = scored.passed
        output.score = scored.score
      }
      /* v8 ignore stop */
      return Promise.resolve(output)
    },
  })
}
