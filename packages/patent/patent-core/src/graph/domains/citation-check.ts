/**
 * src/patent/graph/domains/citation-check — 引用真实性校验子图（纯函数，无 LLM 依赖）。
 *
 * 校验创造性/新颖性结论中引用的对比文件（D1/D2 或专利号）是否真实出现在检索结果
 * prior_art 中，杜绝模型幻觉引用。提取规则（对齐 Sati citation-check 移植）：
 * - 优先用专利号正则（如 US11452699B2）从结论/检索命中提取；
 * - 结论为自由文本时仅提取专利号，不做标题/段落硬匹配；
 * - 无专利号时回退提取文档标识（对比文件N / 证据N / D<N>）做归一比对；
 * - prior_art 为空/检索降级时跳过硬校验（不双重惩罚）。
 *
 * 与 Sati 差异：refTexts 按 DSH typed same-process 契约类型化为 string[]（移除
 * 运行时 typeof 过滤）；D 标号改为精确匹配（Sati 的双向 includes 会把 D10 误判为
 * D1 的接地）；并按检索结果数组顺序追加位置标号 D<n>，使「对比文件N」引用与仅带
 * 专利号的 prior_art 一一对应（Sati 对此系统性误报「未接地」）。
 * @module @deepseek-ai/dsh-patent-core/graph/domains/citation-check
 */

import { GraphBuilder } from '../engine.ts'
import type { GraphNode, GraphState } from '../types.ts'
import { getStateArray, getStateString } from '../state.ts'
import { extractCitationIds, extractDocIds } from '../../citation-ids.ts'

export { PATENT_NUMBER_RE, extractCitationIds, extractDocIds } from '../../citation-ids.ts'

/** 读取 prior-art-filter 保留的原始检索位次（D1、D2……）。 */
function originalDocLabel(doc: Record<string, unknown>): string | undefined {
  const label = doc.dLabel
  return typeof label === 'string' && /^D\d+$/.test(label.trim()) ? label.trim() : undefined
}

/** 引用真实性校验结果。 */
type CitationCheckResult = {
  /** 是否全部引用接地（无法校验时恒 true 放行）。 */
  grounded: boolean
  /** 未在检索命中中接地的引用标识。 */
  uncited: string[]
  /** 模型可见的校验报告（中文）。 */
  report: string
}

/** 引用是否接地：D 标号精确匹配（防 D10 被 D1 前缀误接受）；专利号允许互相包含（同族/后缀变体）。 */
function isGrounded(refId: string, docIds: string[]): boolean {
  if (/^D\d+$/.test(refId)) return docIds.includes(refId)
  return docIds.some(d => d === refId || d.includes(refId) || refId.includes(d))
}

/** 校验引用真实性：refTexts 中提取的引用标识须全部在 docs 中接地。
 * 给出 `receiptCitationIds` 时，D 标号改为对照证据台账的 prior-art 收据精确匹配，
 * 使结论引用与运行持久化的 `D<n>` 收据使用同一标号来源；专利号仍按检索命中接地。
 * 无法校验（无引用标识 / 无检索命中标识）时放行并写说明，不误报。
 * @param opts - 引用文本、检索命中与台账收据标号。
 * @returns 接地判定与报告。
 */
export function checkCitations(opts: {
  refTexts: readonly string[]
  docs: readonly unknown[]
  /** 证据台账中 prior-art 收据的 `citationId`；提供时 D 标号按此精确接地。 */
  receiptCitationIds?: readonly string[]
}): CitationCheckResult {
  const { refTexts, docs } = opts
  const receiptIds = opts.receiptCitationIds !== undefined && opts.receiptCitationIds.length > 0
    ? new Set(opts.receiptCitationIds)
    : undefined
  if (docs.length === 0) {
    return { grounded: true, uncited: [], report: '引用真实性校验：检索结果为空，跳过硬校验' }
  }
  const refIds = extractCitationIds(refTexts.filter(t => t.trim().length > 0).join('\n'))
  if (refIds.length === 0) {
    return {
      grounded: true,
      uncited: [],
      report: '引用真实性校验：未提取到可校验的引用标识（专利号或文档标识），跳过硬校验',
    }
  }
  // 每篇检索命中按数组顺序附带位置标号 D<n>，使「对比文件N」引用可与仅带专利号的
  // prior_art 一一对应（防系统性误报未接地）；prior-art-filter 保留的原始位次优先，
  // 避免过滤缩短数组后把 D2 误认成 D1。
  const docIds = docs.flatMap((doc, index) => {
    const ids = extractDocIds(doc)
    // extractDocIds 仅对对象条目产出标识，故此处已可读 dLabel。
    return ids.length > 0 ? [...ids, originalDocLabel(doc as Record<string, unknown>) ?? `D${index + 1}`] : ids
  })
  if (docIds.length === 0 && receiptIds === undefined) {
    return {
      grounded: true,
      uncited: [],
      report: '引用真实性校验：检索结果无法提取标识（无专利号/文档标识），跳过硬校验',
    }
  }
  const uncited: string[] = []
  const unverifiable: string[] = []
  for (const refId of refIds) {
    if (/^D\d+$/.test(refId) && receiptIds !== undefined) {
      if (!receiptIds.has(refId)) uncited.push(refId)
      continue
    }
    // 台账存在收据、但检索命中无法提取该引用对应的标识：无法校验，放行不误报。
    if (docIds.length === 0) {
      unverifiable.push(refId)
      continue
    }
    if (!isGrounded(refId, docIds)) uncited.push(refId)
  }
  if (uncited.length === 0) {
    if (unverifiable.length > 0) {
      const verified = refIds.filter(refId => !unverifiable.includes(refId))
      return {
        grounded: true,
        uncited: [],
        report: `引用真实性校验：可校验引用全部接地（${verified.join('、')}）；无法校验的引用已放行: ${unverifiable.join('、')}`,
      }
    }
    return { grounded: true, uncited: [], report: `引用真实性校验：引用全部接地（${refIds.join('、')}）` }
  }
  return {
    grounded: false,
    uncited,
    report: `引用真实性校验：以下引用未在检索结果中找到对应对比文件: ${uncited.join('、')}（需核实引用或补充检索）`,
  }
}

/** 默认引用文本来源键（覆盖 inventiveness/novelty 结论与原始输入，多键回退）。 */
const DEFAULT_REF_TEXT_KEYS = [
  'inventiveness_conclusion',
  'inventiveness_closest',
  'inventiveness_hint',
  'novelty_report',
  'text',
] as const

/** 构建引用真实性校验子图的选项。 */
export type BuildCitationCheckGraphOptions = {
  /** 引用文本来源键（缺省覆盖 inventiveness/novelty 结论与原始输入，多键回退）。 */
  refTextKeys?: readonly string[]
}

/** 确定性校验节点：比对结论引用与 prior_art，写接地结果到 state。
 * @param refTextKeys - 引用文本来源键（多键回退）。
 * @returns 引用校验图节点。
 */
function citationCheckNode(refTextKeys: readonly string[]): GraphNode {
  // oxlint-disable-next-line typescript/require-await -- GraphNode contract requires Promise<StateDelta>
  return async ({ state }) => {
    const refTexts = refTextKeys.map(key => getStateString(state, key)).filter(text => text.trim().length > 0)
    const docs = getStateArray(state, 'prior_art')
    const result = checkCitations({ refTexts, docs })
    return {
      citation_check_grounded: result.grounded,
      citation_check_failures: result.uncited,
      citation_check_report: result.report,
    }
  }
}

/** 构建引用真实性校验子图（纯函数确定性校验，无 LLM/审批门）。
 * @param options - 子图构建选项。
 * @returns 未编译的图构建器。
 */
export function buildCitationCheckGraph(options: BuildCitationCheckGraphOptions = {}): GraphBuilder {
  const builder = new GraphBuilder()
  builder.addNode('check', citationCheckNode(options.refTextKeys ?? DEFAULT_REF_TEXT_KEYS))
  builder.addEdge('check', '__end__')
  return builder
}

/** 从图运行结果提取引用校验结论（供调用方/评测读取）。
 * @param state - 图运行结果状态。
 * @returns 解析出的引用校验字段（缺键时省略）。
 */
export function extractCitationCheckResult(state: GraphState): {
  grounded?: boolean
  uncited?: string[]
  report?: string
} {
  const grounded = state['citation_check_grounded']
  const uncited = state['citation_check_failures']
  const report = state['citation_check_report']
  return {
    ...(typeof grounded === 'boolean' ? { grounded } : {}),
    ...(Array.isArray(uncited) ? { uncited: uncited.map(String) } : {}),
    ...(typeof report === 'string' ? { report } : {}),
  }
}
