/**
 * 提取域原子：pfe-consistency（PFIE 四元组一致性检查，纯函数）。
 *
 * 只判定**结构性**事实：某个上游槽位是否有下游结构承接、问题表述是否已含解决手段。
 * 四元组带 `parentId` 时，承接可以是本组特征，也可以是子组特征（下位构思就是上位
 * 问题的实现）；层级只改变判定范围，不改变判定性质。
 *
 * 语义判定（"机制真的承接了吗""方案真的解决问题了吗"）不在此处 fail-closed——它不可
 * 由确定性规则判定，留给交底书理解的人工确认（Insight 逐条待发明人确认）与问题表述层
 * 的规则检验。
 *
 * `insight-encroaches-problem` 与 `problem/atomicChecker.ts` 的
 * `INVENTIVENESS-PROBLEM-SOLUTION-BINDING` 共用不绑方案判定，形成成因—产物两层拦截：
 * 本原子在 PFIE 层拦成因（撰写前的问题/认知文本已经绑定手段），该规则在三步法第二步
 * "实际解决的技术问题"上拦产物。两层各自作用在不同的文本上，不重复实现同一条规则。
 */

import { type Atom } from '../../atom.ts'
import { type PipelineState, type StageExecuteInput, type StageHandler, getStateArray } from '../../handler.ts'
import { checkAtomic } from '../../../problem/atomicChecker.ts'
import { readPfeHierarchy, type PFETriple, type PfeHierarchy } from './extract.ts'
import { degraded } from './llm.ts'

/**
 * PFIE 一致性违规类别（封闭集合）。
 *
 * 前三类各自对应一条可判定的结构事实；新增一类须同时给出确定性判据与用例，否则
 * 该类只会变成又一条无人执行的提示词。
 */
export const PFE_CONSISTENCY_VIOLATION_IDS = [
  /** `S⊨P`：四元组有技术问题，却无技术特征承接（方案未覆盖问题）。 */
  'pfe-problem-without-solution',
  /** `I⇒S`：四元组有发明认知，却无技术特征承接（认知是无从验证的断言）。 */
  'pfe-insight-without-solution',
  /** 发明认知越位：问题表述已绑定解决手段，属三步法问题表述形态（R1 槽位隔离）。 */
  'insight-encroaches-problem',
  /** 上位构思只留下问题陈述：被引为 parent 的组未提炼发明认知，其子组无从承接机制。 */
  'pfe-parent-without-insight',
] as const

/** PFIE 一致性违规类别 id。 */
export type PfeConsistencyViolationId = (typeof PFE_CONSISTENCY_VIOLATION_IDS)[number]

/** 单条 PFIE 一致性违规。 */
export type PfeConsistencyViolation = {
  /** 违规类别。 */
  id: PfeConsistencyViolationId
  /** 出问题的四元组 id（merge 阶段赋的 T1/T2/…）。 */
  tripleId: string
  /** 判定依据与命中文本片段（截断，便于回退重做时模型能定位）。 */
  detail: string
}

/** 摘录片段的最大长度（违规 detail 只用于定位，不承载全文）。 */
const EXCERPT_MAX = 80

/**
 * 截断文本为可定位片段。
 * @param text - 原文本。
 * @returns 至多 EXCERPT_MAX 字符的片段，超出时带省略号。
 */
function excerpt(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= EXCERPT_MAX ? trimmed : `${trimmed.slice(0, EXCERPT_MAX)}…`
}

/**
 * 对 PFIE 四元组做结构性一致性检查（纯函数，不调用模型）。
 *
 * 带层级的四元组按子树判定承接：下位构思的特征就是上位问题的实现，因此上位组自身
 * 没有特征不一定是缺口；子树内仍无特征才是。`insight` 可选只适用于未做问题—认知配对
 * 抽取的管线：一旦某组被引为 parent，层级就在断言存在一个更一般的机制，该槽位为空
 * 是结构事实而不是抽取遗漏。
 * @param triples - merge 阶段产出的 PFIE 四元组。
 * @returns 违规列表；全部四元组承接完整时为空数组。
 */
export function checkPfeConsistency(triples: readonly PFETriple[]): PfeConsistencyViolation[] {
  const violations: PfeConsistencyViolation[] = []
  const hierarchy = readPfeHierarchy(triples)
  const byId = new Map(triples.map(triple => [triple.id, triple]))
  /** 本组或任一子组是否有特征（子树遍历时 `visited` 只防字面构造的环状输入）。 */
  const covered = (triple: PFETriple, visited: Set<string>): boolean => {
    if (triple.features.length > 0) return true
    for (const childId of hierarchy.children.get(triple.id) ?? []) {
      if (visited.has(childId)) continue
      visited.add(childId)
      const child = byId.get(childId)
      if (child !== undefined && covered(child, visited)) return true
    }
    return false
  }
  for (const triple of triples) {
    const hasFeatures = covered(triple, new Set([triple.id]))
    const childIds = hierarchy.children.get(triple.id)
    const subtree = childIds === undefined ? '' : `（含子组 ${childIds.join('、')}）`
    const problem = triple.problem.trim()
    const insight = triple.insight?.trim() ?? ''
    if (problem.length > 0 && !hasFeatures) {
      violations.push({
        id: 'pfe-problem-without-solution',
        tripleId: triple.id,
        detail: `四元组 ${triple.id} 的技术问题没有技术特征承接${subtree}：${excerpt(problem)}`,
      })
    }
    if (problem.length > 0 && !checkAtomic(problem).checks.noSolutionBinding) {
      violations.push({
        id: 'insight-encroaches-problem',
        tripleId: triple.id,
        detail: `四元组 ${triple.id} 的问题表述已绑定解决手段，属发明构思越位到问题槽位：${excerpt(problem)}`,
      })
    }
    if (childIds !== undefined && insight.length === 0) {
      violations.push({
        id: 'pfe-parent-without-insight',
        tripleId: triple.id,
        detail: `四元组 ${triple.id} 是 ${childIds.join('、')} 的上位构思但未提炼发明认知，子组没有可承接的机制：${excerpt(problem)}`,
      })
    }
    if (insight.length === 0) continue
    if (!hasFeatures) {
      violations.push({
        id: 'pfe-insight-without-solution',
        tripleId: triple.id,
        detail: `四元组 ${triple.id} 的发明认知没有技术特征承接${subtree}：${excerpt(insight)}`,
      })
    }
  }
  return violations
}

/** pfe-consistency 原子：PFIE 四元组的结构一致性检查。 */
export const pfeConsistencyAtom: Atom = {
  name: 'pfe-consistency',
  description: 'PFIE 一致性检查：问题与发明认知均有本组或子组特征承接、问题表述未绑定解决手段、上位构思已提炼发明认知（纯函数，不调用模型）',
  category: 'extract',
  inputSchema: ['pfe_triples'],
  outputSchema: ['pfe_consistency_summary', 'pfe_consistency_report'],
}

/**
 * 组装一致性结论文本。
 *
 * 发现违规时，信号词必须出现在**首个句号之前**：回退判定（`signalMatches`）会跳过命中点
 * 前 12 字符内含句界或否定词的位置，把信号词写在后面的句子里等于不触发回退。因此首行以
 * 信号词开头，计数与明细后置。无违规时不出现任何信号词，层级读数也只在那时给出。
 * @param violations - 违规列表。
 * @param tripleCount - 受检四元组数量。
 * @param hierarchy - 四元组的层级读数。
 * @returns 面向模型与日志的一致性结论文本。
 */
function summarize(
  violations: readonly PfeConsistencyViolation[],
  tripleCount: number,
  hierarchy: PfeHierarchy,
): string {
  const layers = hierarchy.maxDepth > 1 ? `，顶层 ${hierarchy.roots} 组共 ${hierarchy.maxDepth} 层` : ''
  if (violations.length === 0) {
    return `PFIE 一致性检查通过（${tripleCount} 组四元组${layers}）：问题与发明认知均有特征承接，问题表述未绑定解决手段。`
  }
  const byId = new Map<PfeConsistencyViolationId, number>()
  for (const violation of violations) {
    byId.set(violation.id, (byId.get(violation.id) ?? 0) + 1)
  }
  const counts = [...byId.entries()].map(([id, count]) => `${id} ${count} 处`).join('，')
  const lines = violations.map((violation, i) => `${i + 1}. [${violation.id}] ${violation.detail}`)
  return [
    `四元组承接缺少结构支撑：共 ${violations.length} 处（受检 ${tripleCount} 组），按类别 ${counts}。`,
    '逐条判据：',
    ...lines,
  ].join('\n')
}

/** pfe-consistency 执行器：读 merge 产出的四元组，输出现与 reports。 */
export class PfeConsistencyHandler implements StageHandler {
  readonly name = 'pfe-consistency'
  readonly category = 'extract' as const

  /**
   * 检查 PFIE 四元组的结构一致性。
   *
   * 四元组缺失时降级并说明原因（须先执行 merge 阶段）；四元组为空数组时视为通过
   * （上游三路提取皆空的情形已由 merge 降级标记，不重复判罚）。
   * @param input - 阶段执行输入（state 携带 pfe_triples）。
   * @returns `pfe_consistency_summary` 与 `pfe_consistency_report`。
   */
  // oxlint-disable-next-line typescript/require-await -- StageHandler contract requires async execute
  async execute(input: StageExecuteInput): Promise<PipelineState> {
    const raw = input.state.pfe_triples
    if (raw === undefined) {
      return degraded('pfe-consistency', '缺少 pfe_triples（须先执行 merge 阶段）')
    }
    if (!Array.isArray(raw)) {
      return degraded('pfe-consistency', 'pfe_triples 不是数组（应为 merge 阶段写出的四元组列表）')
    }
    if (raw.some(value => typeof value !== 'object' || value === null)) {
      return degraded('pfe-consistency', 'pfe_triples 含非对象条目（应为 merge 阶段写出的四元组）')
    }
    // 四元组由本进程的 merge 阶段按 PFETriple 写出；字段形状由写入侧类型保证
    // （同一进程内的类型化传递，不重复校验），此处只补默认值以容忍缺失的可选字段。
    const triples: PFETriple[] = getStateArray(input.state, 'pfe_triples').map((value) => {
      const triple = value as Partial<PFETriple>
      return {
        id: typeof triple.id === 'string' ? triple.id : 'T?',
        problem: typeof triple.problem === 'string' ? triple.problem : '',
        features: Array.isArray(triple.features) ? triple.features.map(String) : [],
        effects: Array.isArray(triple.effects) ? triple.effects.map(String) : [],
        ...(typeof triple.insight === 'string' ? { insight: triple.insight } : {}),
        ...(typeof triple.parentId === 'string' ? { parentId: triple.parentId } : {}),
      }
    })
    const violations = checkPfeConsistency(triples)
    const hierarchy = readPfeHierarchy(triples)
    return {
      pfe_consistency_summary: summarize(violations, triples.length, hierarchy),
      pfe_consistency_report: JSON.stringify({
        passed: violations.length === 0,
        roots: hierarchy.roots,
        maxDepth: hierarchy.maxDepth,
        violations,
      }, null, 2),
    }
  }
}
