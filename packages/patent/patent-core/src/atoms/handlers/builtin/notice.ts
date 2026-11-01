/**
 * 程序文书域原子：oa-parse（审查意见通知书解析）、grounds（程序法定理由识别）与
 * response-plan（答复计划骨架）。
 *
 * 三个原子都是确定性内核的声明式包装：读工作流 state 里的文书与解析产出，输出结构化事实
 * 或骨架，全程不调用模型，也不判定理由是否成立。原子只负责把确定性内核接进工作流，解析
 * 口径归 `notice/office-action.ts` 与 `notice/grounds.ts`，计划口径归 `response/plan.ts`。
 *
 * 输入约定：正文取工作流材料 `input`（`patent_workflow_run.input` 与 `flexible_plan.inputText`
 * 都映射到该键）；`grounds` 另需显式的 `ground_program` 选定理由表——正文里同时出现无效与
 * 复审措辞时无从推断，故不做猜测，缺失或非法取值一律降级并说明取值域。`response-plan`
 * 读 parse 阶段写出的 `office_action`；独立权项检测取调用方另传的 `claims`，缺该键时独立
 * 权项编号留空，由计划缺口提示人工确认。
 */

import { type Atom } from '../../atom.ts'
import { type PipelineState, type StageExecuteInput, type StageHandler, getStateString } from '../../handler.ts'
import {
  REJECTION_LABELS,
  REJECTION_PATTERNS,
  formatOfficeActionSummary,
  formatReferenceDocuments,
  parseOfficeAction,
  type NoticeRejectionGround,
  type NoticeRejectionType,
  type ParsedOfficeAction,
} from '../../../notice/office-action.ts'
import {
  detectPatentSubject,
  identifyDesignGrounds,
  identifyInvalidationGrounds,
  identifyReexaminationGrounds,
  type GroundFinding,
  type PatentSubject,
} from '../../../notice/grounds.ts'
import {
  buildResponsePlan,
  detectIndependentClaims,
  formatResponsePlan,
  type ResponsePlanNotice,
} from '../../../response/plan.ts'
import { isJsonRecord } from '../../../llm-json.ts'
import { degraded } from './llm.ts'

/** oa-parse 原子：审查意见通知书结构化解析。 */
export const oaParseAtom: Atom = {
  name: 'oa-parse',
  description: '审查意见通知书解析：驳回类型、引用文献、涉及权项、审查员论点（纯函数，不调用模型）',
  category: 'extract',
  inputSchema: ['input'],
  outputSchema: ['office_action', 'office_action_summary', 'reference_documents'],
}

/** oa-parse 执行器：解析通知书正文，输出结构化结果与中文摘要。 */
export class OaParseHandler implements StageHandler {
  readonly name = 'oa-parse'
  readonly category = 'extract' as const

  /**
   * 解析通知书正文；正文为空时降级。
   * @param input - 阶段执行输入（state 携带文书正文）。
   * @returns `office_action`（JSON）、`office_action_summary`（中文摘要）与
   *   `reference_documents`（引用文献可读文本，供 adversary-review 等下游消费）。
   */
  // oxlint-disable-next-line typescript/require-await -- StageHandler contract requires async execute
  async execute(input: StageExecuteInput): Promise<PipelineState> {
    const text = getStateString(input.state, 'input')
    if (text.trim().length === 0) {
      return degraded('oa-parse', '通知书正文为空（state.input 未提供）')
    }
    const parsed: ParsedOfficeAction = parseOfficeAction(text)
    return {
      office_action: JSON.stringify(parsed),
      office_action_summary: formatOfficeActionSummary(parsed),
      reference_documents: formatReferenceDocuments(parsed.citations),
    }
  }
}

/** 理由表取值域：无效宣告 / 复审 / 外观设计无效。 */
export const GROUND_PROGRAMS = ['invalidation', 'reexamination', 'design'] as const

/** 程序类型（决定使用哪张法定理由表）。 */
export type GroundProgram = (typeof GROUND_PROGRAMS)[number]

/** grounds 原子：程序法定理由识别与专利权类型判定。 */
export const groundsAtom: Atom = {
  name: 'grounds',
  description: '程序法定理由识别：按 ground_program 选定理由表并标注否定表述（纯函数，不调用模型）',
  category: 'compare',
  inputSchema: ['input', 'ground_program'],
  outputSchema: ['grounds', 'grounds_summary', 'patent_subject'],
}

/** 类型守卫：值是否为已知的程序类型。 */
function isGroundProgram(value: string): value is GroundProgram {
  return (GROUND_PROGRAMS as readonly string[]).includes(value)
}

/** 未识别到理由时的摘要，与解析器"不兜底造理由"的口径一致。 */
const NO_GROUND_SUMMARY = '未识别到具体法条依据（须人工判读文书是否援引理由）'

/**
 * 渲染理由摘要：逐条给出中文标签、法条依据与命中的原文片段。
 *
 * 片段随摘要一起给出，是因为关键词表只能回答"文中提到了该条款"；把命中处摆在同一条里，
 * 判读"是否被实质论证"时不必再回原文定位。命中词处于否定表述作用范围时额外标注，避免
 * 把"请求人未主张……"读成请求人主张了该理由。
 * @param findings - 识别到的理由。
 * @returns 逐条摘要文本；未识别到理由时返回明示文案。
 */
function summarizeGrounds(findings: readonly GroundFinding<string>[]): string {
  if (findings.length === 0) return NO_GROUND_SUMMARY
  return findings
    .map((finding) => {
      const scope = finding.negated ? `${finding.article}，文中为否定表述` : finding.article
      return `${finding.label}（${scope}）：「${finding.matched}」`
    })
    .join('、')
}

/** grounds 执行器：按程序类型识别法定理由（复审另判专利权类型）。 */
export class GroundsHandler implements StageHandler {
  readonly name = 'grounds'
  readonly category = 'compare' as const

  /**
   * 按 `ground_program` 识别正文援引的法定理由；程序类型缺失/非法或正文为空时降级。
   * @param input - 阶段执行输入（state 携带正文与 ground_program）。
   * @returns `grounds`（JSON）与 `grounds_summary`（中文摘要）两键；复审另带 `patent_subject`。
   */
  // oxlint-disable-next-line typescript/require-await -- StageHandler contract requires async execute
  async execute(input: StageExecuteInput): Promise<PipelineState> {
    const state = input.state
    const program = getStateString(state, 'ground_program')
    if (!isGroundProgram(program)) {
      const shown = program.trim().length > 0 ? program : '(缺失)'
      return degraded('grounds', `ground_program 非法: ${shown}（须为 ${GROUND_PROGRAMS.join(' / ')}）`)
    }
    const text = getStateString(state, 'input')
    if (text.trim().length === 0) {
      return degraded('grounds', '程序文书正文为空（state.input 未提供）')
    }

    let findings: readonly GroundFinding<string>[]
    let subject: PatentSubject | undefined
    switch (program) {
      case 'invalidation':
        findings = identifyInvalidationGrounds(text)
        break
      case 'reexamination': {
        const reexamination = identifyReexaminationGrounds(text)
        findings = reexamination
        subject = detectPatentSubject(text, reexamination)
        break
      }
      case 'design':
        findings = identifyDesignGrounds(text)
        break
    }
    return {
      grounds: JSON.stringify(findings),
      grounds_summary: summarizeGrounds(findings),
      ...(subject !== undefined ? { patent_subject: subject } : {}),
    }
  }
}

/** response-plan 原子：答复计划骨架（策略/必答段落/逐权项修改对照/缺口）。 */
export const responsePlanAtom: Atom = {
  name: 'response-plan',
  description: '答复计划骨架：策略摘要、逐理由必答段落、逐权项修改对照与缺口（纯函数，不调用模型）',
  category: 'compare',
  inputSchema: ['office_action', 'claims'],
  outputSchema: ['response_plan', 'response_plan_summary'],
}

/** 类型守卫：值是否为已知的驳回理由（程序类型以外的状态由 `other` 表达）。 */
function isRejectionGround(value: unknown): value is NoticeRejectionGround {
  return typeof value === 'string' && Object.hasOwn(REJECTION_PATTERNS, value)
}

/** 类型守卫：值是否为已知的驳回类型（含 `other`）。 */
function isRejectionType(value: unknown): value is NoticeRejectionType {
  return typeof value === 'string' && Object.hasOwn(REJECTION_LABELS, value)
}

/** 读取结果：成功携带计划需要的字段，失败携带可直接展示的原因。 */
type ResponsePlanNoticeResult =
  | { ok: true; notice: ResponsePlanNotice }
  | { ok: false; reason: string }

/**
 * 从持久化的通知书解析 JSON 中读出计划需要的字段。
 *
 * `office_action` 是上一阶段写出的 JSON；本原子只做形状校验，不重新解析正文。未知驳回
 * 理由会让策略表取到 `undefined`，因此逐项校验取值域；受影响权项须为正整数（权项号）。
 * @param parsed - 已确认是 JSON 对象的解析结果。
 * @returns 计划输入，或可操作的失败原因。
 */
function readResponsePlanNotice(parsed: Record<string, unknown>): ResponsePlanNoticeResult {
  const typesRaw = parsed.rejectionTypes
  if (!Array.isArray(typesRaw)) {
    return { ok: false, reason: '解析结果缺少 rejectionTypes 数组（office_action 应为 oa-parse 产出的对象）' }
  }
  const rejectionTypes: NoticeRejectionGround[] = []
  for (const [index, ground] of typesRaw.entries()) {
    if (!isRejectionGround(ground)) {
      return { ok: false, reason: `解析结果的 rejectionTypes[${index}] 非法: ${JSON.stringify(ground)}` }
    }
    rejectionTypes.push(ground)
  }

  const claimsRaw = parsed.affectedClaims
  if (!Array.isArray(claimsRaw)) {
    return { ok: false, reason: '解析结果缺少 affectedClaims 数组（office_action 应为 oa-parse 产出的对象）' }
  }
  const affectedClaims: number[] = []
  for (const [index, claim] of claimsRaw.entries()) {
    if (typeof claim !== 'number' || !Number.isInteger(claim) || claim < 1) {
      return { ok: false, reason: `解析结果的 affectedClaims[${index}] 不是正整数: ${JSON.stringify(claim)}` }
    }
    affectedClaims.push(claim)
  }

  const rejectionType = parsed.rejectionType
  if (!isRejectionType(rejectionType)) {
    return { ok: false, reason: `解析结果缺少合法的 rejectionType: ${JSON.stringify(rejectionType)}` }
  }
  return { ok: true, notice: { rejectionType, rejectionTypes, affectedClaims } }
}

/** response-plan 执行器：把通知书解析结果拼装为起草阶段的输入层骨架。 */
export class ResponsePlanHandler implements StageHandler {
  readonly name = 'response-plan'
  readonly category = 'compare' as const

  /**
   * 由 `office_action` 拼装答复计划；解析产出缺失或不可读时降级。
   * @param input - 阶段执行输入（state 携带解析产出与权利要求书）。
   * @returns `response_plan`（输入层文本）与 `response_plan_summary`（策略摘要）两键。
   */
  // oxlint-disable-next-line typescript/require-await -- StageHandler contract requires async execute
  async execute(input: StageExecuteInput): Promise<PipelineState> {
    const state = input.state
    const raw = getStateString(state, 'office_action')
    if (raw.trim().length === 0) {
      return degraded('response-plan', '缺少解析结果（state.office_action 未提供）')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return degraded('response-plan', '解析结果不可读（office_action 不是合法 JSON）')
    }
    if (!isJsonRecord(parsed)) {
      return degraded('response-plan', '解析结果不是 JSON 对象（office_action 应为 oa-parse 产出的对象）')
    }
    const read = readResponsePlanNotice(parsed)
    if (!read.ok) return degraded('response-plan', read.reason)
    const plan = buildResponsePlan(read.notice, {
      independentClaims: detectIndependentClaims(getStateString(state, 'claims')),
    })
    return {
      response_plan: formatResponsePlan(plan),
      response_plan_summary: plan.strategySummary,
    }
  }
}
