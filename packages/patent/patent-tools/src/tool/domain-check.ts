/**
 * `domain_check` tool: run one patent domain's drafting-defect checklist through
 * the deterministic engines and report each checklist item's result.
 *
 * The value over calling `claim_lint` and `validate_specification` separately is
 * the checklist: every item is either decided by named engine rules or listed as
 * remaining for human judgement, so "the checklist was run" stops depending on
 * the agent remembering which rules map to which defect.
 * @module @deepseek-ai/dsh-patent-tools/tool/domain-check
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { lintClaimText, type ClaimLintFinding } from '@deepseek-ai/dsh-patent-core'
import { requireNonBlankText } from './internal/tool-input.ts'
import { FIGURE_ANALYSIS_INPUT_SCHEMA } from './internal/figure-schemas.ts'
import { validateSpecification } from './validate-specification.ts'
import type { ValidateSpecificationInput } from './spec-types.ts'
import type { PatentType } from './draft-claims.ts'

/** Domain whose defect checklist is executable today. */
export type DomainCheckDomain = 'mechanical' | 'software'

/** Submission fields a checklist item's rules read; without them the item stays open. */
type ChecklistInput = 'claims' | 'abstract' | 'figure_analysis' | 'patent_type'

/** One checklist entry. */
interface ChecklistItem {
  /** Checklist id carried over from the source defect list. */
  readonly id: string
  /** Short defect name. */
  readonly title: string
  /** Engine rule ids that decide this item; empty when only a human can. */
  readonly rules: readonly string[]
  /** Fields the rules read; a missing field leaves the item open instead of passing it. */
  readonly needs?: readonly ChecklistInput[]
  /** Why a clean run still cannot be called a pass: the rules cover only part of the defect. */
  readonly partial?: string
}

/**
 * Mechanical-domain drafting defects, in checklist order. Rule ids come from
 * `claim_lint` (claim form) and `validate_specification` (specification text);
 * an empty `rules` list means the judgement is not mechanical.
 */
const MECHANICAL_CHECKLIST: readonly ChecklistItem[] = [
  { id: 'MECH-DC-001', title: '标号不统一（权要/说明书/附图三处）', rules: ['figure_mark_consistency', 'term_mark_consistency'], needs: ['claims', 'figure_analysis'] },
  { id: 'MECH-DC-002', title: '组件命名不一致（一物多名）', rules: ['term_mark_consistency'], partial: '规则只核带标号的名称配对（同号多名、同名多号）；不含标号的部件用不同叫法需人工通读比对' },
  { id: 'MECH-DC-003', title: '附图标号缺失（漏标号）', rules: [] },
  { id: 'MECH-DC-004', title: '含宣传性用语', rules: ['commercial-language', 'commercial_advertising', 'title_prohibited_word', 'abstract_commercial_advertising', 'placeholder_content'] },
  { id: 'MECH-DC-005', title: '法条条号引用过时', rules: [] },
  { id: 'MECH-DC-006', title: '结构限定优先级错误', rules: [] },
  { id: 'MECH-DC-007', title: '独立权要缺必要技术特征', rules: [] },
  { id: 'MECH-DC-008', title: '必要技术特征误入从属权要', rules: [] },
  { id: 'MECH-DC-009', title: '多项从属用「和」', rules: ['multiple-dependent'], needs: ['claims'] },
  { id: 'MECH-DC-010', title: '多项从属嵌套（链式引用）', rules: ['multiple-dependent'], needs: ['claims'] },
  { id: 'MECH-DC-011', title: '保护范围不清（上位概念过宽）', rules: [] },
  { id: 'MECH-DC-012', title: 'fallback 路径不足', rules: [] },
  { id: 'MECH-DC-013', title: '步骤顺序未明确', rules: ['step-order'], needs: ['claims'], partial: '规则只在方法权利要求用「包括步骤」句式列举操作时检查；S1/S2 式列举或未用该句式的不触发' },
  { id: 'MECH-DC-014', title: '参数范围端值无实施例', rules: ['numeric_range_endpoints', 'numeric_range_midpoint'] },
  { id: 'MECH-DC-015', title: '相对参数基准缺失', rules: [] },
  { id: 'MECH-DC-016', title: '非公知设备未公开结构', rules: [] },
  { id: 'MECH-DC-017', title: '参数依赖关系未公开', rules: [] },
  { id: 'MECH-DC-018', title: '功能性限定无实施例支撑', rules: ['functional-limitation', 'claim_coverage'], needs: ['claims'], partial: '规则只核功能性句式与特征是否在说明书中出现；说明书记载是否实际支撑该功能限定需人工判断' },
  { id: 'MECH-DC-019', title: '功能性限定违反三层许可条件', rules: [] },
  { id: 'MECH-DC-020', title: '用功能/效果替代结构特征', rules: ['functional-limitation'], needs: ['claims'] },
  { id: 'MECH-DC-021', title: '实用新型含方法主题', rules: ['utility_model_method_claim'], needs: ['claims', 'patent_type'] },
  { id: 'MECH-DC-022', title: '实用新型含组合物/无固定形状', rules: ['utility_model_composition'], needs: ['claims', 'patent_type'] },
  { id: 'MECH-DC-023', title: '实用新型改进点在材料/方法', rules: [] },
  { id: 'MECH-DC-024', title: '机械产品缺附图', rules: ['drawings', 'drawing_count', 'declared_no_drawings_with_refs', 'utility_model_drawings'], needs: ['patent_type'], partial: '规则只核附图说明与正文引用的一致性、声明数量，以及实用新型是否缺附图；机械产品本身是否必须有附图需人工判断' },
  { id: 'MECH-DC-025', title: '附图标号与权要/说明书不一致', rules: ['figure_mark_consistency', 'term_mark_consistency'], needs: ['claims', 'figure_analysis'] },
  { id: 'MECH-DC-026', title: '背景技术未引证（自认陷阱）', rules: ['background_citation'], partial: '规则只核背景技术引证是否给出国别、公开号与公开日；是否构成技术问题自认需人工判断' },
  { id: 'MECH-DC-027', title: '背景技术大段抄录对比文件', rules: [] },
  { id: 'MECH-DC-028', title: '修改超范围', rules: [] },
  { id: 'MECH-DC-029', title: '等同替换未在说明书列举', rules: [] },
  { id: 'MECH-DC-030', title: '实施例单一（无法支撑修改）', rules: ['embodiments'], partial: '规则只在完全没有实施例时命中；只有一个实施例（清单本意）需人工判断' },
]

/**
 * Software/AI domain drafting defects, in checklist order. 客体 items
 * (SOFT-DC-006/007/008/010) are decided by the `software_*` rules only when
 * `tech_domain` is `software`; each of them carries `partial` because whether a
 * scheme falls under A25.1.2 stays a legal judgement.
 */
const SOFTWARE_CHECKLIST: readonly ChecklistItem[] = [
  { id: 'SOFT-DC-001', title: '法条条号过时', rules: [] },
  { id: 'SOFT-DC-002', title: 'AI/算法术语不一致', rules: ['software_abbreviation_undefined'], partial: '规则只核缩写是否给出中文全称；同一概念在全文多种叫法需人工通读比对' },
  { id: 'SOFT-DC-003', title: '用商品名/商标替代技术术语', rules: [] },
  { id: 'SOFT-DC-004', title: '含宣传性用语', rules: ['commercial-language', 'commercial_advertising', 'title_prohibited_word', 'abstract_commercial_advertising'] },
  { id: 'SOFT-DC-005', title: '摘要超长', rules: ['abstract_length'], needs: ['abstract'] },
  { id: 'SOFT-DC-006', title: '仅是智力活动规则', rules: ['software_no_technical_means', 'software_business_rule_feature'], needs: ['claims'], partial: '规则只按技术载体与商业词汇判断风险；是否落入专利法第二十五条第一款第二项须按技术三要素作法律判断' },
  { id: 'SOFT-DC-007', title: '算法未关联具体技术', rules: ['software_no_technical_means'], needs: ['claims'], partial: '规则只核是否出现技术载体；关联是否充分须人工判断' },
  { id: 'SOFT-DC-008', title: '纯商业方法', rules: ['software_business_rule_feature'], needs: ['claims'], partial: '规则只命中商业/管理词汇；是否另有技术手段须人工判断' },
  { id: 'SOFT-DC-009', title: '技术效果不可量化', rules: ['effect_data_quantified'], partial: '规则只核有益效果是否带定量数据；效果是否由技术手段带来需人工判断' },
  { id: 'SOFT-DC-010', title: '纯算法权利要求', rules: ['software_algorithm_subject', 'software_no_technical_means'], needs: ['claims'], partial: '规则只看主题名称与全文技术载体；算法是否已结合技术特征须人工判断' },
  { id: 'SOFT-DC-011', title: '装置功能过概括', rules: ['functional-limitation'], needs: ['claims'], partial: '规则只核功能性/效果性句式；模块划分是否过概括需人工判断' },
  { id: 'SOFT-DC-012', title: '模块与方法步骤不对应', rules: [] },
  { id: 'SOFT-DC-013', title: '介质权要写成信号/传输介质', rules: ['software_signal_medium'], needs: ['claims'] },
  { id: 'SOFT-DC-014', title: '多项从属用「和」', rules: ['multiple-dependent'], needs: ['claims'] },
  { id: 'SOFT-DC-015', title: '独立权要缺必要技术特征', rules: [] },
  { id: 'SOFT-DC-016', title: '算法描述过于概括', rules: ['software_model_structure_disclosure'], partial: '规则只核是否记载模型结构要素；是否达到可复现程度需人工判断' },
  { id: 'SOFT-DC-017', title: '训练数据未公开', rules: ['software_training_data_disclosure'], partial: '规则只核是否记载数据来源/规模/标注；公开是否充分需人工判断' },
  { id: 'SOFT-DC-018', title: '模型结构缺失', rules: ['software_model_structure_disclosure'], partial: '规则只核是否出现结构要素；具体层数、类型与连接方式是否清楚需人工判断' },
  { id: 'SOFT-DC-019', title: '关键参数缺失', rules: [] },
  { id: 'SOFT-DC-020', title: '技术效果无数据支撑', rules: ['effect_data_quantified', 'effect_prior_art_comparison'], partial: '规则只核效果数据的定量性与现有技术对比；对比是否成立需人工判断' },
  { id: 'SOFT-DC-021', title: '算法流程图缺失', rules: ['drawings', 'drawing_section_without_drawings', 'drawing_count'], partial: '规则只核附图章节与正文引用的有无；是否为算法流程图需人工判断' },
  { id: 'SOFT-DC-022', title: '实施例单一', rules: ['embodiments'], partial: '规则只在完全没有实施例时命中；只有一个实施例需人工判断' },
  { id: 'SOFT-DC-023', title: '训练与应用跨技术领域（单一性）', rules: [] },
  { id: 'SOFT-DC-024', title: '多场景仅因同一模型拼接（单一性）', rules: [] },
  { id: 'SOFT-DC-025', title: '修改新增说明书未记载的算法步骤', rules: [] },
  { id: 'SOFT-DC-026', title: '修改新增无支撑的技术效果', rules: [] },
  { id: 'SOFT-DC-027', title: '涉外申请的中国布局权要过宽', rules: [] },
  { id: 'SOFT-DC-028', title: '背景技术自认陷阱', rules: ['background_citation'], partial: '规则只核背景技术引证是否给出国别、公开号与公开日；是否构成技术问题自认需人工判断' },
]

/** Checklists by domain; adding a domain means adding its table. */
const CHECKLISTS: Readonly<Record<DomainCheckDomain, readonly ChecklistItem[]>> = {
  mechanical: MECHANICAL_CHECKLIST,
  software: SOFTWARE_CHECKLIST,
}

/** Domains the tool accepts. */
export const DOMAIN_CHECK_DOMAINS: readonly DomainCheckDomain[] = ['mechanical', 'software']

/** One violation as the tool reports it. */
export type DomainCheckFinding = {
  /** Engine that produced the finding. */
  source: 'claim_lint' | 'specification'
  /** Stable rule id from that engine. */
  rule: string
  severity: 'error' | 'warning'
  message: string
  /** Fix suggestion, or the statute and guideline clause the rule enforces. */
  detail?: string
}

/** One checklist item's result. */
export type DomainCheckItemResult = {
  /** Checklist id, e.g. `MECH-DC-021`. */
  id: string
  /** Defect name. */
  title: string
  /** `hit` when a mapped rule fired; `pass` when a mapped rule was evaluated clean; `manual` otherwise. */
  status: 'hit' | 'pass' | 'manual'
  /** Engine rules that decide this item; empty for a manual item. */
  rules: string[]
  /** What the status means for this item, in one phrase. */
  reason: string
}

/** Output of the `domain_check` tool. */
export type DomainCheckOutput = {
  domain: DomainCheckDomain
  passed: boolean
  error_count: number
  warning_count: number
  items: DomainCheckItemResult[]
  findings: DomainCheckFinding[]
}

/** Rule ids no engine decides, used to explain a manual item. */
const MANUAL_REASON = '判据不可机械判定（需法律判断或结构化输入）'

/** Why a rule could not run, per missing submission field. */
const MISSING_INPUT_REASON: Readonly<Record<ChecklistInput, string>> = {
  claims: '未提供 claims，权项相关检查未运行',
  abstract: '未提供 abstract，摘要相关检查未运行',
  figure_analysis: '未提供可用的附图分析结果（缺省、空数组或全部不可用），图面标号未核',
  patent_type: '未提供 patent_type，按实用新型客体判定的检查项未运行',
}

/**
 * Collect the findings of both engines for one submission.
 * @param text - the specification text.
 * @param inputs - the optional submission fields (claims, abstract, type, figures).
 * @param techDomain - the declared technical domain; the checklist domain fills it in.
 * @returns findings in claim order, then specification order.
 */
function collectFindings(
  text: string,
  inputs: {
    claims: string
    abstract: string | undefined
    patentType: PatentType | undefined
    figureAnalysis: ValidateSpecificationInput['figure_analysis']
    techDomain: DomainCheckDomain
  },
): DomainCheckFinding[] {
  const findings: DomainCheckFinding[] = []
  if (inputs.claims.trim().length > 0) {
    for (const finding of lintClaimText(inputs.claims).findings) {
      findings.push(toClaimFinding(finding))
    }
  }
  const specification = validateSpecification({
    text,
    ...(inputs.claims.trim().length > 0 ? { claims: inputs.claims } : {}),
    ...(inputs.abstract === undefined ? {} : { abstract: inputs.abstract }),
    ...(inputs.patentType === undefined ? {} : { patent_type: inputs.patentType }),
    ...(inputs.figureAnalysis === undefined ? {} : { figure_analysis: inputs.figureAnalysis }),
    tech_domain: inputs.techDomain,
  })
  for (const violation of specification.violations) {
    findings.push({
      source: 'specification',
      rule: violation.rule,
      severity: violation.severity,
      message: violation.message,
      ...(violation.suggestion === undefined ? {} : { detail: violation.suggestion }),
    })
  }
  return findings
}

/**
 * Project one claim-lint finding onto the tool's field set.
 * @param finding - the finding reported by the claims linter.
 * @returns the finding with its claim scope folded into the message.
 */
function toClaimFinding(finding: ClaimLintFinding): DomainCheckFinding {
  const scope = finding.claim === null ? '权利要求书' : `权利要求 ${finding.claim}`
  return {
    source: 'claim_lint',
    rule: finding.rule,
    severity: finding.severity,
    message: `${scope}：${finding.message}`,
    detail: finding.basis,
  }
}

/**
 * Decide each checklist item from the collected findings.
 * @param items - the domain checklist.
 * @param findings - all findings collected for this submission.
 * @param available - the submission fields the caller supplied.
 * @returns one result per item, in checklist order.
 */
function evaluateItems(
  items: readonly ChecklistItem[],
  findings: readonly DomainCheckFinding[],
  available: ReadonlySet<ChecklistInput>,
): DomainCheckItemResult[] {
  const hitRules = new Set(findings.map(finding => finding.rule))
  return items.map((item) => {
    const missing = item.needs?.find(input => !available.has(input))
    if (missing !== undefined) {
      return { id: item.id, title: item.title, status: 'manual', rules: [], reason: MISSING_INPUT_REASON[missing] }
    }
    if (item.rules.length === 0) {
      return { id: item.id, title: item.title, status: 'manual', rules: [], reason: MANUAL_REASON }
    }
    const hitRulesOfItem = item.rules.filter(rule => hitRules.has(rule))
    if (hitRulesOfItem.length > 0) {
      return { id: item.id, title: item.title, status: 'hit', rules: [...item.rules], reason: `命中规则：${hitRulesOfItem.join('、')}` }
    }
    if (item.partial !== undefined) {
      return { id: item.id, title: item.title, status: 'manual', rules: [...item.rules], reason: `规则未命中，但不能据此判定通过：${item.partial}` }
    }
    return { id: item.id, title: item.title, status: 'pass', rules: [...item.rules], reason: '已核通过，未发现该缺陷' }
  })
}

/**
 * Render the checklist result into model-facing prose.
 * @param value - the tool output as the declared schema types it.
 * @returns the rendered Markdown text.
 */
function renderDomainCheck(value: {
  domain: string
  passed: boolean
  error_count: number
  warning_count: number
  items: DomainCheckItemResult[]
  findings: DomainCheckFinding[]
}): string {
  const automated = value.items.filter(item => item.status !== 'manual')
  const hits = value.items.filter(item => item.status === 'hit')
  const passes = value.items.filter(item => item.status === 'pass')
  const manual = value.items.filter(item => item.status === 'manual')
  const header = `domain_check: ${value.domain} 域缺陷清单 ${value.items.length} 项——自动化 ${automated.length} 项（通过 ${passes.length}、命中 ${hits.length}），人工 ${manual.length} 项；${value.error_count} 项 error、${value.warning_count} 项 warning，${value.passed ? '通过' : '未通过'}。`
  const hitLines = hits.map((item) => {
    const related = value.findings.filter(finding => item.rules.includes(finding.rule))
    const detail = related.map(finding => `[${finding.severity}] ${finding.message}`).join('；')
    return `- ${item.id} ${item.title}：${detail}`
  })
  const mappedRules = new Set(value.items.flatMap(item => item.rules))
  const unmappedLines = value.findings
    .filter(finding => !mappedRules.has(finding.rule))
    .map(finding => `- [${finding.severity}] ${finding.message}`)
  const sections: Array<[string, string[]]> = [
    ['## 命中（按清单项）', hitLines],
    ['## 其他命中（未归入清单项）', unmappedLines],
    ['## 已核通过', passes.map(item => `- ${item.id} ${item.title}`)],
    ['## 未自动化（须人工判断，不得视为通过）', manual.map(item => `- ${item.id} ${item.title}：${item.reason}`)],
  ]
  return [header, ...sections.flatMap(([title, lines]) => [title, ...(lines.length === 0 ? ['- 无'] : lines)])].join('\n')
}

/**
 * Build the `domain_check` tool.
 * @returns a registry-ready tool definition.
 */
export function createDomainCheckTool(): ToolDefinition {
  return defineTool({
    name: 'domain_check',
    description: [
      '按专利领域缺陷清单对一份申请文件跑确定性自检（不调用模型）。当前支持 mechanical（机械域 30 项）与 software（软件/AI 域 28 项）。',
      '它把 claim_lint（权利要求形式）与 validate_specification（说明书）的结论按清单项汇总：每项给出 pass（已核干净）、hit（命中，附规则与说明）或 manual（须人工判断，不得视为通过）。',
      'manual 有两种来源：判据本身不可机械判定；或规则只覆盖该缺陷的一部分（未命中不等于通过，reason 会说明覆盖到哪）。',
      '输入 text 为说明书全文；传 claims 才能跑权项相关项；传 abstract 才能跑摘要项；传 patent_type 才能跑实用新型客体项。software 域会自动按 tech_domain=software 运行软件客体与模型公开规则。',
      'passed 只表示已运行的确定性规则未发现 error，不表示符合专利法；manual 项必须由人复核。',
    ].join(''),
    parameters: {
      domain: { type: 'string', required: true, enum: [...DOMAIN_CHECK_DOMAINS], description: '领域：mechanical（机械）/ software（软件与 AI）。' },
      text: { type: 'string', required: true, description: '说明书全文（markdown 或纯文本）。' },
      claims: { type: 'string', description: '权利要求书全文（可选）；不传时权项相关清单项报 manual。' },
      abstract: { type: 'string', description: '摘要（可选）；不传时摘要相关清单项报 manual。' },
      patent_type: { type: 'string', enum: ['invention', 'utility_model'], description: '专利类型（可选）；实用新型客体项需要它。' },
      figure_analysis: {
        ...FIGURE_ANALYSIS_INPUT_SCHEMA,
        description: '附图分析结果（可选）；提供至少一张可用结果后，MECH-DC-001/025 的图面标号才能真正核过。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          domain: { type: 'string', required: true },
          passed: { type: 'boolean', required: true },
          error_count: { type: 'number', required: true },
          warning_count: { type: 'number', required: true },
          items: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                title: { type: 'string', required: true },
                status: { type: 'string', required: true, enum: ['hit', 'pass', 'manual'] },
                rules: { type: 'array', required: true, items: { type: 'string' } },
                reason: { type: 'string', required: true },
              },
            },
          },
          findings: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                source: { type: 'string', required: true, enum: ['claim_lint', 'specification'] },
                rule: { type: 'string', required: true },
                severity: { type: 'string', required: true, enum: ['error', 'warning'] },
                message: { type: 'string', required: true },
                detail: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderDomainCheck(value) }],
    },
    execute: (args) => {
      const domain = args.domain
      const checklist = CHECKLISTS[domain]
      requireNonBlankText(args.text, 'domain_check', 'text 为空（须为说明书全文）')
      const claims = args.claims ?? ''
      const findings = collectFindings(args.text, {
        claims,
        abstract: args.abstract,
        patentType: args.patent_type,
        figureAnalysis: args.figure_analysis,
        techDomain: domain,
      })
      const available = new Set<ChecklistInput>()
      if (claims.trim().length > 0) available.add('claims')
      if (args.abstract !== undefined && args.abstract.trim().length > 0) available.add('abstract')
      // 空数组是附图分析被跳过时写入的状态（`atoms/figure-analysis.ts`），不是「已分析」；
      // 只有拿到至少一张可用图的分析结果，图面标号才算核过。
      if (args.figure_analysis?.some(figure => figure.usable) === true) available.add('figure_analysis')
      if (args.patent_type !== undefined) available.add('patent_type')
      const items = evaluateItems(checklist, findings, available)
      return Promise.resolve({
        domain,
        passed: !findings.some(finding => finding.severity === 'error'),
        error_count: findings.filter(finding => finding.severity === 'error').length,
        warning_count: findings.filter(finding => finding.severity === 'warning').length,
        items,
        findings,
      })
    },
  })
}
