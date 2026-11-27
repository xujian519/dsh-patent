/**
 * src/patent/graph/domains/novelty — 新颖性分析子图（专利法 A22.2）。
 *
 * 节点链：extract（复用）→ keywords（复用）→ search（复用）→ compare（复用
 * novelty 原子，单独对比）→ numeric_range（新增：数值范围专项判定）→ conclude
 * （LLM 完整报告）→ approval（复用审批门）。
 *
 * 输入契约（state）：text / extraction_input（技术方案或权利要求文本，多键回退）；
 * prior_art（可选，用户已提供的现有技术证据）。
 */

import { GraphBuilder } from '../engine.ts'
import type { GraphNode } from '../types.ts'
import { markDegraded } from '../degradation.ts'
import { getStateArray, getStateString } from '../state.ts'
import { globalStageHandlerRegistry, type StageHandlerRegistry } from '../../atoms/index.ts'
import { dataBlock } from '../../prompt-hygiene.ts'
import {
  analyzeNumericRanges,
  crossCheckNumericVerdict,
  extractNumericRanges,
  readNumericVerdict,
  type NumericRangeInput,
} from '../../novelty/index.ts'
import {
  formatPriorArtLines,
  handlerNode,
  llmNode,
  requireRuleEvaluator,
  resolveInput,
  ruleGateNode,
  type RuleGateOptions,
} from './shared.ts'

export { extractNumericRanges }

/** 构建新颖性分析子图的选项。 */
export type BuildNoveltyGraphOptions = RuleGateOptions & {
  handlers?: StageHandlerRegistry
  /** 注入 approval-gate 审批门（缺省 true：HITL 暂停；自动执行/评测场景置 false 直达规则门）。 */
  includeApproval?: boolean
}

const NOVELTY_SCOPE = '单独对比原则（新颖性，专利法 A22.2）'

// ---------------------------------------------------------------------------
// numeric_range —— 数值范围/上下位概念专项判定（确定性轨 + LLM 语义轨）
// ---------------------------------------------------------------------------

const NUMERIC_RANGE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      description: '整体结论：overlapped（破坏新颖性）/ inside_without_endpoint（数值点落入范围且无共同端点）/ no_overlap / inconclusive',
    },
    assessments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          range: { type: 'string', description: '数值范围表述' },
          category: { type: 'string', description: '情形分类（端点值/重叠区间/参数特征/用途限定/其他）' },
          disclosed: { type: 'boolean', description: '是否被现有技术公开' },
          reasoning: { type: 'string', description: '判定依据（审查指南数值范围规则）' },
        },
        required: ['range', 'category', 'disclosed'],
      },
    },
  },
  required: ['verdict', 'assessments'],
} as const

/**
 * 对比文件条目 → 确定性核验输入。
 *
 * 条目形状沿用 compare/novelty 提示词里的同一条 JSON 投影，因此摘要里的
 * `prior_art_<n>` 与提示词中 `[n]` 的序号一一对应。
 */
function priorArtInput(priorArt: readonly unknown[]): NumericRangeInput['priorArt'] {
  return priorArt.map((doc, index) => ({
    docId: `prior_art_${index + 1}`,
    text: formatPriorArtLines([doc]),
  }))
}

const numericRangeNode: GraphNode = async ({ state, provider, signal }) => {
  const features = getStateArray(state, 'features').map(String).join('；')
  // 检测源：特征 + 权利要求 + 原始输入文本（数值范围常出现在说明书而非提炼后的特征）。
  const claim = resolveInput(state, ['claim', 'claim_text'])
  const rawText = resolveInput(state, ['text', 'extraction_input'])
  // 确定性轨与 LLM 可用性无关：无论语义轨是否降级，结论都进状态。
  const analysis = analyzeNumericRanges({
    claims: [{ id: 'claim', text: `${features} ${claim} ${rawText}` }],
    priorArt: priorArtInput(getStateArray(state, 'prior_art')),
  })
  // 门槛取内核的带单位发现，而不是 extractNumericRanges：后者只列区间与单边表述
  // （面向模型的"数值范围"清单），而数值点同样参与判定——权利要求只写单值参数
  // （"输送温度为 70℃"）时，落在对比文件范围内、与对比文件端点相同都要判出来。
  const expressions = analysis.claimRanges
    .filter(finding => finding.strong)
    .map(finding => finding.expression)
  if (expressions.length === 0) {
    return { numeric_range_result: '未检测到带单位的数值表述，无需专项分析', numeric_ranges: [] }
  }
  const deterministic = {
    numeric_range_verdict: analysis.verdict,
    numeric_range_agreement: analysis.llmAgreement,
    numeric_range_deterministic: analysis.summary,
  }
  const degradedRanges = (fallback: string, message: string): Record<string, unknown> => {
    const delta: Record<string, unknown> = {}
    markDegraded(delta, 'numeric_range_result', fallback, 'llm_unavailable', message)
    delta.numeric_ranges = expressions
    return { ...delta, ...deterministic }
  }
  if (!provider?.callLLM) {
    return degradedRanges(
      `检测到带单位数值表述 ${expressions.length} 处，需 LLM 专项判定（provider 缺失）`,
      '数值范围专项判定需要 LLM',
    )
  }
  const priorArt = getStateArray(state, 'prior_art')
  const priorArtText = formatPriorArtLines(priorArt)
  const prompt = [
    `你是专利新颖性分析专家。对比范围：${NOVELTY_SCOPE}`,
    '对以下数值表述做专项新颖性判定（审查指南第二部分第三章：数值范围/端点值/上下位概念规则）：',
    '- 端点值落入现有技术公开范围 → 通常不具备新颖性',
    '- 区间与现有技术区间重叠 → 需比较端点与公开程度',
    '- 参数/性能特征：仅当现有技术明确公开相同参数定义',
    '- 用途限定：不影响方案实质时一般不具有限定作用',
    '',
    '【数值表述】',
    expressions.map((expression, i) => `[${i + 1}] ${expression}`).join('\n'),
    '',
    '【现有技术证据】',
    priorArtText.length > 0 ? dataBlock(priorArtText.slice(0, 4000)) : '（无证据，标注 confidence 低）',
    '',
    '请严格输出 JSON：verdict 为整体结论，assessments 为每个数值表述的 { range, category, disclosed, reasoning }。',
  ].join('\n')
  try {
    // 与 llmNode 一致地转发取消信号：否则图取消后仍会等这次调用结束。
    const raw = await provider.callLLM(prompt, { jsonSchema: NUMERIC_RANGE_SCHEMA, temperature: 0.1 }, signal)
    const checked = crossCheckNumericVerdict(analysis, readNumericVerdict(raw))
    return {
      numeric_range_result: raw,
      numeric_ranges: expressions,
      numeric_range_verdict: checked.verdict,
      numeric_range_agreement: checked.llmAgreement,
      numeric_range_deterministic: checked.summary,
    }
  } catch (err) {
    return degradedRanges(
      '数值范围专项判定失败（LLM 错误）',
      `numeric_range LLM 调用失败: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

// ---------------------------------------------------------------------------
// 子图构建
// ---------------------------------------------------------------------------

/** 构建新颖性分析子图（A22.2）。
 * @param options - 子图构建选项。
 * @returns 未编译的图构建器。
 */
export function buildNoveltyGraph(options: BuildNoveltyGraphOptions = {}): GraphBuilder {
  const handlers = options.handlers ?? globalStageHandlerRegistry
  const builder = new GraphBuilder()

  const extract = handlers.lookup('extract')
  if (extract === undefined) throw new Error('buildNoveltyGraph: 缺少内置原子 extract（请先 registerBuiltinAtoms）')
  const keywords = handlers.lookup('keywords')
  const search = handlers.lookup('search')
  const novelty = handlers.lookup('novelty')
  const approval = handlers.lookup('approval-gate')

  builder.addNode(
    'extract',
    handlerNode(extract, {
      extraction_type: '提取权利要求与现有技术中的技术特征',
      output_key: 'features',
      domain: '专利',
    }),
  )
  if (keywords !== undefined) {
    builder.addNode('keywords', handlerNode(keywords))
  }
  if (search !== undefined) {
    builder.addNode('search', handlerNode(search))
  }
  if (novelty !== undefined) {
    builder.addNode('compare', handlerNode(novelty, { novelty_scope: NOVELTY_SCOPE }))
  }
  builder.addNode('numeric_range', numericRangeNode)
  builder.addNode(
    'conclude',
    llmNode({
      outputKey: 'novelty_report',
      temperature: 0.1,
      buildPrompt: (state) => {
        const compareResult = getStateString(state, 'novelty_result') || getStateString(state, 'novelty_conclusion')
        const numeric = getStateString(state, 'numeric_range_result')
        const deterministic = getStateString(state, 'numeric_range_deterministic')
        const coverage = getStateString(state, 'evidence_coverage')
        return [
          '你是专利新颖性分析专家。基于以下逐特征对比结果与数值范围专项判定，生成完整新颖性分析报告。',
          '要求：',
          '- 明确区分对比文件，遵循单独对比原则（不得将多份文件结合）',
          '- 逐特征列出公开情况，标注证据来源',
          '- 结论附置信度，回避绝对化表述',
          '',
          '【逐特征对比】',
          compareResult.length > 0 ? dataBlock(compareResult.slice(0, 6000)) : '（无对比结果）',
          '',
          '【数值范围专项判定】',
          numeric.length > 0 ? dataBlock(numeric.slice(0, 4000)) : '（无）',
          '',
          '【数值范围确定性核验】',
          deterministic.length > 0 ? dataBlock(deterministic.slice(0, 2000)) : '（无）',
          '',
          `【证据覆盖】${coverage || 'unknown'}`,
          '',
          '输出新颖性分析报告（具备/不具备新颖性 + 逐特征对比表 + 置信度）。',
        ].join('\n')
      },
    }),
  )

  // 边：extract → (keywords) → (search) → compare → numeric_range → conclude → 尾链
  // compare（novelty handler）缺失时跳过，链路直连 numeric_range（features 由 extract 产出）。
  const compareTail = novelty !== undefined ? 'compare' : 'numeric_range'
  builder.addEdge('extract', keywords !== undefined ? 'keywords' : compareTail)
  if (keywords !== undefined) builder.addEdge('keywords', search !== undefined ? 'search' : compareTail)
  if (search !== undefined) builder.addEdge('search', compareTail)
  if (novelty !== undefined) builder.addEdge('compare', 'numeric_range')
  builder.addEdge('numeric_range', 'conclude')

  // 尾链：conclude → (approval) → (rule_gate) → END；无中间节点时直连 END。
  const withRuleGate = options.ruleGate !== false
  if (withRuleGate) {
    builder.addNode('rule_gate', ruleGateNode({
      domains: ['patent_novelty'],
      sourceKeys: ['novelty_report'],
      evaluator: requireRuleEvaluator(options),
    }))
  }
  if (approval !== undefined && options.includeApproval !== false) {
    builder.addNode('approval', handlerNode(approval, { review_context: '新颖性分析报告需人工复核' }))
    builder.addEdge('conclude', 'approval')
    builder.addEdge('approval', withRuleGate ? 'rule_gate' : '__end__')
  } else {
    builder.addEdge('conclude', withRuleGate ? 'rule_gate' : '__end__')
  }
  if (withRuleGate) builder.addEdge('rule_gate', '__end__')

  return builder
}
