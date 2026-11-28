import { expect, it } from 'vitest'
import {
  DEGRADED_ERROR_KEY,
  DEGRADED_RETRYABLE_KEY,
  DOMAIN_GRAPHS,
  StageHandlerRegistry,
  globalStageHandlerRegistry,
  registerBuiltinAtoms,
  type RuleEvaluator,
  type RuleGateState,
  type StageHandler,
  type StageProvider,
} from '@deepseek-ai/dsh-patent-core'
import { DEGRADATION_SUFFIX, isDegraded } from '../../src/graph/degradation.ts'
import { GRAPH_END } from '../../src/graph/types.ts'
import { GraphBuilder } from '../../src/graph/engine.ts'
import { StageCancelledError, isStageCancelledError } from '../../src/atoms/handler.ts'
import {
  buildCitationCheckGraph,
  checkCitations,
  extractCitationCheckResult,
} from '../../src/graph/domains/citation-check.ts'
import {
  buildEnablementGraph,
  detectTechnicalDomain,
  extractEnablementResult,
} from '../../src/graph/domains/enablement.ts'
import { buildInventivenessGraph, extractInventivenessResult } from '../../src/graph/domains/inventiveness.ts'
import { buildNoveltyGraph } from '../../src/graph/domains/novelty.ts'
import { extractCitationIds, extractDocIds } from '../../src/citation-ids.ts'
import { extractNumericRanges } from '../../src/novelty/numeric-range.ts'
import { handlerNode, llmNode } from '../../src/graph/domains/shared.ts'
import type { RuleGateRequest } from '../../src/checker/evaluator.ts'

registerBuiltinAtoms()

/** 放行 approval-gate 的 handler 注册表（完整测试用）。 */
function passthroughHandlers(): StageHandlerRegistry {
  const passthroughApproval: StageHandler = {
    name: 'approval-gate',
    category: 'gate',
    execute: async () => ({ review_passed: true }),
  }
  const handlers = new StageHandlerRegistry()
  for (const h of globalStageHandlerRegistry.list()) handlers.register(h)
  handlers.register(passthroughApproval)
  return handlers
}

/** 规则门评估器替身：核心图测试不加载规则语料，门只验证接线与审计键。 */
const stubRuleEvaluator: RuleEvaluator = {
  id: 'test:stub-rules',
  evaluate: () => ({ verdict: 'pass', failures: [], evaluatedRules: 1 }),
}

/** 读取规则门写入 state 的结构化结论。 */
function ruleGateOf(state: Record<string, unknown>): RuleGateState {
  return state.rule_gate as RuleGateState
}

// ---------------------------------------------------------------------------
// 确定性节点：extractNumericRanges / detectTechnicalDomain
// ---------------------------------------------------------------------------

it('extractNumericRanges: 检测数值范围/端点/带单位表述', () => {
  const ranges = extractNumericRanges('温度范围为 50-80°C，厚度至少 5mm，速度大于 10m/s，压力 ≤ 2MPa，重量 1.5-2.5kg')
  expect(ranges).toEqual(['50-80', '至少 5', '大于 10', '≤ 2', '1.5-2.5'])
  expect(extractNumericRanges('无任何数值')).toEqual([])
})

it('detectTechnicalDomain: 化学/计算机/机械/通用检测', () => {
  expect(detectTechnicalDomain('一种化合物及其制备方法').domain).toBe('chemical')
  expect(detectTechnicalDomain('一种数据处理方法及电子设备').domain).toBe('software')
  expect(detectTechnicalDomain('一种传动装置').domain).toBe('mechanical')
  expect(detectTechnicalDomain('一种日常用品').domain).toBe('generic')
})

it('领域子图：启用规则门但未注入评估器 → 构图期报错', () => {
  expect(() => buildNoveltyGraph()).toThrow(/未注入 ruleEvaluator/)
  expect(() => buildInventivenessGraph()).toThrow(/未注入 ruleEvaluator/)
  expect(() => buildEnablementGraph()).toThrow(/未注入 ruleEvaluator/)
})

// ---------------------------------------------------------------------------
// novelty 子图
// ---------------------------------------------------------------------------

const noveltyProvider = (): StageProvider => ({
  callLLM: async (prompt) => {
    // 注意：conclude prompt 含"数值范围"标题字样，须先匹配最具体者。
    if (prompt.includes('完整新颖性分析报告')) {
      return '新颖性分析报告：权利要求相对于现有技术 D1 具备新颖性（单独对比原则，逐技术特征比对见附表）。置信度：高。'
    }
    if (prompt.includes('数值范围')) {
      return JSON.stringify({
        assessments: [{ range: '50-80', category: '重叠区间', disclosed: false, reasoning: '端点未公开' }],
      })
    }
    if (prompt.includes('技术分析助手')) {
      return JSON.stringify({ features: ['传送带', '识别传感器'], problems: [], effects: [] })
    }
    if (prompt.includes('检索关键词')) {
      return JSON.stringify({ keywords: ['分拣', '传感器'] })
    }
    if (prompt.includes('新颖性分析专家')) {
      return JSON.stringify({
        assessments: [{ feature: '传送带', prior_art: 'D1', disclosed: false, reasoning: '未公开' }],
        conclusion: '具备新颖性（置信度 0.8）',
      })
    }
    return '默认'
  },
  search: async query => [{ title: `文献: ${query}`, snippet: '摘要', url: 'https://example.com/1' }],
})

it('novelty: mock provider + 放行审批 → 跑完全图 + 规则门收口', async () => {
  const graph = buildNoveltyGraph({ handlers: passthroughHandlers(), ruleEvaluator: stubRuleEvaluator }).compile('extract')
  const result = await graph.run(
    {
      text: '一种分拣装置，温度范围为 50-80°C，包含传送带与识别传感器',
      prior_art: [{ title: 'D1', snippet: '公开传送带' }],
    },
    { provider: noveltyProvider() },
  )
  expect(result.completed).toBe(true)
  expect((result.state.novelty_report as string).includes('新颖性分析报告')).toBe(true)
  expect(result.state.numeric_ranges).toEqual(['50-80'])
  // 规则门收口：评估器替身判 pass，门只汇总声明的最终报告键。
  const gate = ruleGateOf(result.state)
  expect(gate.status).toBe('pass')
  expect(gate.evaluator).toBe('test:stub-rules')
  expect(gate.evaluatedKeys).toEqual(['novelty_report'])
})

it('novelty: 注入 ruleEvaluator 后规则门使用注入实现', async () => {
  const requests: RuleGateRequest[] = []
  const evaluator: RuleEvaluator = {
    id: 'test:novelty-gate',
    domains: ['patent_novelty'],
    evaluate: (request) => {
      requests.push(request)
      return { verdict: 'pass', failures: [], evaluatedRules: 3 }
    },
  }
  const graph = buildNoveltyGraph({
    handlers: passthroughHandlers(),
    includeApproval: false,
    ruleEvaluator: evaluator,
  }).compile('extract')
  const result = await graph.run(
    { text: '一种分拣装置，包含传送带与识别传感器', prior_art: [{ title: 'D1', snippet: '公开传送带' }] },
    { provider: noveltyProvider() },
  )
  expect(result.completed).toBe(true)
  const gate = ruleGateOf(result.state)
  expect(gate.status).toBe('pass')
  expect(gate.evaluator).toBe('test:novelty-gate')
  expect(gate.evaluatedRules).toBe(3)
  expect(requests).toHaveLength(1)
  expect(requests[0]?.domains).toEqual(['patent_novelty'])
  // 只评估最终报告：原始输入（含"分拣装置"）不参与，避免输入措辞触发规则失败。
  expect(requests[0]?.text).toContain('新颖性分析报告')
  expect(requests[0]?.text).not.toContain('分拣装置')
})

it('novelty: 无数值表述时确定性核验段标记（无）', async () => {
  const prompts: string[] = []
  const base = noveltyProvider()
  const provider: StageProvider = {
    callLLM: async (prompt, options) => {
      prompts.push(prompt)
      return await base.callLLM!(prompt, options)
    },
    search: base.search!,
  }
  const graph = buildNoveltyGraph({ handlers: passthroughHandlers(), ruleEvaluator: stubRuleEvaluator }).compile('extract')
  await graph.run(
    {
      text: '一种分拣装置，包含传送带与识别传感器',
      prior_art: [{ title: 'D1', snippet: '公开传送带' }],
    },
    { provider },
  )
  expect(prompts.some(prompt => prompt.includes('【数值范围确定性核验】\n（无）'))).toBe(true)
})

it('novelty: 无 provider → LLM 节点降级 + approval 中断', async () => {
  const graph = buildNoveltyGraph({ handlers: globalStageHandlerRegistry, ruleEvaluator: stubRuleEvaluator }).compile('extract')
  const result = await graph.run({ text: '一种分拣装置' })
  expect(result.completed).toBe(false)
  expect(result.interrupted?.node).toBe('approval')
  // extract/compare/conclude 等 LLM 节点降级（有降级标记；outputKey 为 novelty_report）。
  expect(isDegraded(result.state, 'novelty_report')).toBe(true)
  expect(result.degraded.length >= 1).toBe(true)
})

it('novelty: includeApproval=false → 无审批门，conclude 直达 END（可完整跑完）', async () => {
  const graph = buildNoveltyGraph({
    ruleGate: false,
    includeApproval: false,
    handlers: globalStageHandlerRegistry,
  }).compile('extract')
  const desc = graph.describe()
  expect(desc.nodes.includes('approval')).toBe(false)
  expect(desc.nodes.includes('rule_gate')).toBe(false)
  // 无审批：LLM 节点降级后仍直达 END，completed=true（自动执行语义）。
  const result = await graph.run({ text: '一种分拣装置' })
  expect(result.completed).toBe(true)
})

it('novelty: 无 provider → conclude 降级，规则门 blocked 而非静默通过', async () => {
  const graph = buildNoveltyGraph({
    includeApproval: false,
    handlers: globalStageHandlerRegistry,
    ruleEvaluator: stubRuleEvaluator,
  }).compile('extract')
  const result = await graph.run({ text: '一种分拣装置' })
  expect(result.completed).toBe(true)
  const gate = ruleGateOf(result.state)
  expect(gate.status).toBe('blocked')
  expect(gate.degradedSources).toEqual(['novelty_report'])
  expect(gate.evaluatedRules).toBe(0)
})

// ---------------------------------------------------------------------------
// inventiveness 子图
// ---------------------------------------------------------------------------

const inventivenessProvider = (): StageProvider => ({
  callLLM: async (prompt) => {
    if (prompt.includes('三步法第一步')) {
      return JSON.stringify({
        document: 'D1',
        technical_field: '机械分拣',
        disclosed_features: ['传送带'],
        rationale: '技术领域相同且公开特征最多',
      })
    }
    if (prompt.includes('三步法第二步')) {
      return JSON.stringify({
        distinguishing_features: ['识别传感器'],
        actual_technical_problem: '如何自动识别分拣目标',
        effect_of_diff: '提高分拣准确率',
      })
    }
    if (prompt.includes('三步法第三步')) {
      return JSON.stringify({
        obvious: false,
        motivation: 'D1 无结合启示',
        evidence: [],
        dissenting_factors: ['D2 反向教导'],
      })
    }
    if (prompt.includes('辅助判断因素')) {
      return JSON.stringify({
        unexpected_effect: '准确率提升 30%',
        long_felt_need: '',
        technical_prejudice: '',
        commercial_success: '',
      })
    }
    if (prompt.includes('综合三步法')) {
      return JSON.stringify({
        inventive: true,
        confidence: 'medium',
        key_rationale: '区别特征带来预料不到的技术效果',
        report:
          '三步法分析报告：D1 为最接近现有技术，区别特征为识别传感器，D1/D2 无结合启示，对本领域技术人员而言并非显而易见，具备创造性。',
      })
    }
    if (prompt.includes('创造性分析专家')) {
      return JSON.stringify({
        features: ['传送带', '识别传感器'],
        field: '机械分拣',
        filing_date: '2024-01-01',
        inventor_claimed_effect: '提高分拣准确率',
      })
    }
    if (prompt.includes('检索策略')) {
      return '检索策略：1) 分拣 AND 传感器；2) 传送带 AND 识别；3) IPC B07C'
    }
    return '默认'
  },
  search: async query => [{ title: `文献: ${query}`, snippet: '摘要', url: 'https://example.com/1' }],
})

it('inventiveness: mock provider → 三步法全流程 + 结论提取（ruleGate 关闭）', async () => {
  const graph = buildInventivenessGraph({ ruleGate: false, handlers: passthroughHandlers() }).compile('parse')
  const result = await graph.run(
    { text: '一种分拣装置，包括传送带与识别传感器' },
    { provider: inventivenessProvider() },
  )
  expect(result.completed).toBe(true)
  const extracted = extractInventivenessResult(result.state)
  expect(extracted.inventive).toBe(true)
  expect(extracted.confidence).toBe('medium')
  expect(extracted.report?.includes('三步法')).toBe(true)
})

it('inventiveness: 规则门收口输出 verdict（评估器替身）', async () => {
  const graph = buildInventivenessGraph({ handlers: passthroughHandlers(), ruleEvaluator: stubRuleEvaluator }).compile('parse')
  const result = await graph.run(
    { text: '一种分拣装置，包括传送带与识别传感器' },
    { provider: inventivenessProvider() },
  )
  expect(result.completed).toBe(true)
  const gate = ruleGateOf(result.state)
  expect(gate.status).toBe('pass')
  expect(gate.evaluatedKeys).toEqual(['inventiveness_conclusion'])
})

it('inventiveness: 注入 ruleEvaluator 后规则门使用注入实现', async () => {
  const requests: RuleGateRequest[] = []
  const evaluator: RuleEvaluator = {
    id: 'test:inventiveness-gate',
    domains: ['patent_inventiveness'],
    evaluate: (request) => {
      requests.push(request)
      return { verdict: 'pass', failures: [], evaluatedRules: 4 }
    },
  }
  const graph = buildInventivenessGraph({
    handlers: passthroughHandlers(),
    includeApproval: false,
    ruleEvaluator: evaluator,
  }).compile('parse')
  const result = await graph.run(
    { text: '一种分拣装置，包括传送带与识别传感器' },
    { provider: inventivenessProvider() },
  )
  expect(result.completed).toBe(true)
  const gate = ruleGateOf(result.state)
  expect(gate.evaluator).toBe('test:inventiveness-gate')
  expect(gate.evaluatedRules).toBe(4)
  expect(gate.evaluatedKeys).toEqual(['inventiveness_conclusion'])
  expect(requests).toHaveLength(1)
  expect(requests[0]?.domains).toEqual(['patent_inventiveness'])
})

it('inventiveness: 无 provider → 全 LLM 节点降级 + approval 中断', async () => {
  const graph = buildInventivenessGraph({ handlers: globalStageHandlerRegistry, ruleEvaluator: stubRuleEvaluator }).compile('parse')
  const result = await graph.run({ text: '一种分拣装置' })
  expect(result.completed).toBe(false)
  expect(result.interrupted?.node).toBe('approval')
  expect(isDegraded(result.state, 'inventiveness_conclusion')).toBe(true)
})

// ---------------------------------------------------------------------------
// enablement 子图
// ---------------------------------------------------------------------------

const enablementProvider = (): StageProvider => ({
  callLLM: async (prompt) => {
    // 注意：conclude prompt 含"结构完整性"等标题字样，须先匹配最具体者。
    if (prompt.includes('充分公开审查报告')) {
      return JSON.stringify({
        sufficiently_disclosed: false,
        confidence: 'medium',
        key_rationale: '缺少实施例与实验数据',
        report: 'A26.3 审查报告：说明书未充分公开，缺少实施例，本领域技术人员无法实现。',
      })
    }
    if (prompt.includes('结构完整性')) {
      return JSON.stringify({
        missing_sections: ['附图说明'],
        completeness_ok: false,
        notes: '缺少附图说明章节',
      })
    }
    if (prompt.includes('清楚性')) {
      return JSON.stringify({
        issues: [{ problem: '术语未定义', location: '发明内容', severity: 'major' }],
        clarity_ok: false,
      })
    }
    if (prompt.includes('能够实现性')) {
      return JSON.stringify({
        gaps: ['未给出实施例参数'],
        enablement_ok: false,
        skilled_person_assessment: '无法实现',
      })
    }
    return '默认'
  },
})

it('enablement: mock provider → A26.3 全流程 + 领域规则 + 规则门', async () => {
  const graph = buildEnablementGraph({ handlers: passthroughHandlers(), ruleEvaluator: stubRuleEvaluator }).compile('load')
  const result = await graph.run(
    {
      text: '一种化合物及其制备方法。技术领域：化学。背景技术…发明内容…具体实施方式…附图说明…实施例1：制备 50-80°C。',
    },
    { provider: enablementProvider() },
  )
  expect(result.completed).toBe(true)
  expect(result.state.technical_domain).toBe('chemical')
  expect(Array.isArray(result.state.domain_requirements) && result.state.domain_requirements.length > 0).toBe(true)
  const extracted = extractEnablementResult(result.state)
  expect(extracted.sufficientlyDisclosed).toBe(false)
  const gate = ruleGateOf(result.state)
  expect(gate.status).toBe('pass')
  expect(gate.evaluatedKeys).toEqual(['enablement_conclusion'])
})

it('enablement: 注入 ruleEvaluator 后规则门使用注入实现', async () => {
  const requests: RuleGateRequest[] = []
  const evaluator: RuleEvaluator = {
    id: 'test:enablement-gate',
    domains: ['patent_disclosure'],
    evaluate: (request) => {
      requests.push(request)
      return { verdict: 'pass', failures: [], evaluatedRules: 6 }
    },
  }
  const graph = buildEnablementGraph({
    handlers: passthroughHandlers(),
    includeApproval: false,
    ruleEvaluator: evaluator,
  }).compile('load')
  const result = await graph.run(
    { text: '一种化合物及其制备方法。技术领域：化学。背景技术…发明内容…具体实施方式…附图说明…实施例1。' },
    { provider: enablementProvider() },
  )
  expect(result.completed).toBe(true)
  const gate = ruleGateOf(result.state)
  expect(gate.evaluator).toBe('test:enablement-gate')
  expect(gate.evaluatedRules).toBe(6)
  expect(gate.evaluatedKeys).toEqual(['enablement_conclusion'])
  expect(requests).toHaveLength(1)
  expect(requests[0]?.domains).toEqual(['patent_disclosure'])
})

it('enablement: load 节点确定性结构检查', async () => {
  const graph = buildEnablementGraph({ handlers: globalStageHandlerRegistry, ruleEvaluator: stubRuleEvaluator }).compile('load')
  const result = await graph.run({ text: '技术领域…具体实施方式…' }, { provider: enablementProvider() })
  // 无 approval 放行 → 会中断，但 load/completeness 等已执行。
  expect(result.completed).toBe(false)
  expect(result.state.spec_sections_present).toEqual(['技术领域', '具体实施方式'])
  const missing = result.state.spec_sections_missing
  expect(Array.isArray(missing) && missing.includes('背景技术')).toBe(true)
})

it('enablement: 提示词带上确定性缺失章节与领域特殊要求', async () => {
  const prompts: string[] = []
  const delegate = enablementProvider().callLLM
  if (delegate === undefined) throw new Error('enablementProvider must declare callLLM')
  const capturing: StageProvider = {
    callLLM: async (prompt) => {
      prompts.push(prompt)
      return delegate(prompt)
    },
  }
  const graph = buildEnablementGraph({ handlers: passthroughHandlers(), ruleEvaluator: stubRuleEvaluator }).compile('load')
  await graph.run({ text: '技术领域：化学。具体实施方式…' }, { provider: capturing })

  // Both keys are arrays; reading them as strings would render the missing-section
  // list as "（无缺失）" and drop the domain requirements entirely.
  const completeness = prompts.find(p => p.includes('结构完整性')) ?? ''
  expect(completeness).toContain('背景技术')
  const conclude = prompts.find(p => p.includes('充分公开审查报告')) ?? ''
  expect(conclude).toContain('化合物须给出制备方法')
})

// ---------------------------------------------------------------------------
// citation-check：引用真实性校验子图（纯函数 + 确定性图）
// ---------------------------------------------------------------------------

it('extractCitationIds: 专利号优先提取并去重', () => {
  expect(extractCitationIds('对比文件 US11452699B2 与 US11452699B2 公开了该特征')).toEqual(['US11452699B2'])
  expect(extractCitationIds('无任何引用标识')).toEqual([])
})

it('extractCitationIds: 无专利号时回退归一文档标识（对比文件N/证据N/D<N>）', () => {
  expect(extractCitationIds('参见对比文件2和证据1，另见 D3 的图2。')).toEqual(['D2', 'D1', 'D3'])
})

it('extractDocIds: 非对象/空字段返回空列表', () => {
  expect(extractDocIds(null)).toEqual([])
  expect(extractDocIds(42)).toEqual([])
  expect(extractDocIds({ title: 123, url: null })).toEqual([])
})

it('extractDocIds: 从 title/url/patent 提取专利号与文档标识', () => {
  expect(extractDocIds({ title: 'D1 的检索结果', url: 'https://x/US11452699B2', patent: 'CN111222333A' })).toEqual([
    'US11452699B2',
    'CN111222333A',
  ])
})

it('checkCitations: 检索结果为空/无引用标识/无文档标识时放行不误报', () => {
  const noDocs = checkCitations({ refTexts: ['引用 US11111111'], docs: [] })
  expect(noDocs.grounded).toBe(true)
  expect(noDocs.report).toContain('检索结果为空')

  const noRefs = checkCitations({ refTexts: ['   '], docs: [{ title: 'D1' }] })
  expect(noRefs.grounded).toBe(true)
  expect(noRefs.report).toContain('未提取到可校验的引用标识')

  const noDocIds = checkCitations({ refTexts: ['引用 US11111111'], docs: [{ title: '一篇无标识的摘要' }] })
  expect(noDocIds.grounded).toBe(true)
  expect(noDocIds.report).toContain('检索结果无法提取标识')
})

it('checkCitations: 台账收据存在但检索命中无标识时，专利号列入无法校验', () => {
  const result = checkCitations({
    refTexts: ['对比文件1 与 US11111111'],
    docs: [{ title: '一篇无标识的摘要' }],
    receiptCitationIds: ['D1'],
  })
  expect(result.grounded).toBe(true)
  expect(result.uncited).toEqual([])
  expect(result.report).toContain('无法校验的引用已放行')
  expect(result.report).toContain('US11111111')
})

it('checkCitations: 非对象检索条目不参与标号推导', () => {
  const result = checkCitations({
    refTexts: ['引用 US12345678'],
    docs: [{ patent: 'US12345678' }, '纯文本条目'],
  })
  expect(result.grounded).toBe(true)
})

it('checkCitations: isGrounded 三种接地方式（相等/包含/被包含）', () => {
  const exact = checkCitations({ refTexts: ['引用 US12345678'], docs: [{ patent: 'US12345678' }] })
  expect(exact.grounded).toBe(true)
  expect(exact.report).toContain('引用全部接地')

  const docContainsRef = checkCitations({ refTexts: ['引用 US12345678'], docs: [{ url: 'https://x/US12345678B2' }] })
  expect(docContainsRef.grounded).toBe(true)

  const refContainsDoc = checkCitations({ refTexts: ['引用 CN201910000000A'], docs: [{ patent: 'CN201910000000' }] })
  expect(refContainsDoc.grounded).toBe(true)
})

it('checkCitations: D 标号精确匹配（D10 不被 D1 前缀误接受）', () => {
  const result = checkCitations({ refTexts: ['另引用 D10'], docs: [{ title: 'D1 的某专利' }] })
  expect(result.grounded).toBe(false)
  expect(result.uncited).toEqual(['D10'])
})

it('checkCitations: 台账收据标号存在时 D 标号按收据精确接地', () => {
  const grounded = checkCitations({
    refTexts: ['对比文件2 公开了区别特征'],
    docs: [{ title: '一篇没有专利号但可定位的检索结果' }],
    receiptCitationIds: ['D1', 'D2'],
  })
  expect(grounded.grounded).toBe(true)
  expect(grounded.report).toContain('引用全部接地')

  const ungrounded = checkCitations({
    refTexts: ['另引用 D3'],
    docs: [{ title: 'D1 的检索结果' }],
    receiptCitationIds: ['D1', 'D2'],
  })
  expect(ungrounded.grounded).toBe(false)
  expect(ungrounded.uncited).toEqual(['D3'])
})

it('checkCitations: 对比文件N 引用经数组位置标号与仅带专利号的 prior_art 接地', () => {
  const result = checkCitations({
    refTexts: ['对比文件2 公开了区别特征'],
    docs: [{ patent: 'CN111111111A' }, { patent: 'CN222222222A' }],
  })
  expect(result.grounded).toBe(true)
  expect(result.report).toContain('引用全部接地')
})

it('checkCitations: 超范围的 D 标号引用仍报未接地（防幻觉保留）', () => {
  const result = checkCitations({
    refTexts: ['另引用 D7 佐证'],
    docs: [{ patent: 'CN111111111A' }, { patent: 'CN222222222A' }, { patent: 'CN333333333A' }],
  })
  expect(result.grounded).toBe(false)
  expect(result.uncited).toEqual(['D7'])
})

it('checkCitations: 部分引用未接地 → grounded false + uncited 列表', () => {
  const result = checkCitations({
    refTexts: ['US11111111 已核实，另引用了 US22222222'],
    docs: [{ patent: 'US11111111' }],
  })
  expect(result.grounded).toBe(false)
  expect(result.uncited).toEqual(['US22222222'])
  expect(result.report).toContain('US22222222')
})

it('citation-check: 确定性图节点从 prior_art 校验结论引用', async () => {
  const graph = buildCitationCheckGraph().compile('check')
  const grounded = await graph.run({ text: '相对于 D1 不具备新颖性', prior_art: [{ title: 'D1' }] })
  expect(grounded.completed).toBe(true)
  expect(grounded.state.citation_check_grounded).toBe(true)
  expect(grounded.state.citation_check_report).toContain('引用全部接地')

  const ungrounded = await graph.run({ text: '引用 US99999999', prior_art: [{ patent: 'US11111111' }] })
  expect(ungrounded.state.citation_check_grounded).toBe(false)
  expect(ungrounded.state.citation_check_failures).toEqual(['US99999999'])
})

it('citation-check: 自定义 refTextKeys 从指定键提取引用文本', async () => {
  const graph = buildCitationCheckGraph({ refTextKeys: ['inventiveness_conclusion'] }).compile('check')
  const result = await graph.run({ inventiveness_conclusion: '本方案与 D2 不同', prior_art: [{ title: 'D2' }] })
  expect(result.state.citation_check_grounded).toBe(true)
})

it('extractCitationCheckResult: 缺键时省略，有值时解析类型', () => {
  expect(extractCitationCheckResult({})).toEqual({})
  const full = extractCitationCheckResult({
    citation_check_grounded: false,
    citation_check_failures: ['US22222222'],
    citation_check_report: '未接地',
  })
  expect(full.grounded).toBe(false)
  expect(full.uncited).toEqual(['US22222222'])
  expect(full.report).toBe('未接地')
})

it('citation-check: 注册进 DOMAIN_GRAPHS（工具层可按名取构建函数与入口）', () => {
  expect(DOMAIN_GRAPHS['citation-check'].entry).toBe('check')
  const graph = DOMAIN_GRAPHS['citation-check'].build().compile('check')
  expect(graph.describe().nodes).toContain('check')
})

// ---------------------------------------------------------------------------
// numeric_range 节点：确定性轨与语义轨的接线
// ---------------------------------------------------------------------------

/** 数值范围专项判定返回指定结论，其余提示词原样回显（便于断言提示词内容）。 */
function verdictProvider(verdict: string): StageProvider {
  return {
    callLLM: async (prompt: string) =>
      prompt.includes('专项新颖性判定') ? JSON.stringify({ verdict, assessments: [] }) : prompt,
  }
}

const NUMERIC_TEXT = '一种分拣装置，温度范围为 50-80°C'

it('numeric_range: 无 LLM 时确定性轨仍进状态（降级文本保留）', async () => {
  const graph = buildNoveltyGraph({ includeApproval: false, ruleGate: false })
  const r = await graph.compile('extract').run({ text: NUMERIC_TEXT, prior_art: [{ title: 'D1', snippet: '温度 60-90°C' }] })
  expect(String(r.state.numeric_range_result)).toMatch(/需 LLM 专项判定/)
  expect(r.state.numeric_range_verdict).toBe('overlapped')
  expect(r.state.numeric_range_agreement).toBe('n_a')
  expect(String(r.state.numeric_range_deterministic)).toContain('破坏性数值重叠')
})

it('numeric_range: 权利要求只写单值参数时同样进确定性轨', async () => {
  const graph = buildNoveltyGraph({ includeApproval: false, ruleGate: false })
  const r = await graph
    .compile('extract')
    .run({ text: '一种分拣装置，输送温度为 70℃', prior_art: [{ title: 'D1', snippet: '输送温度为 60-90℃' }] })
  expect(r.state.numeric_ranges).toEqual(['70'])
  expect(r.state.numeric_range_verdict).toBe('inside_without_endpoint')
  expect(String(r.state.numeric_range_result)).not.toMatch(/无需专项分析/)
})

it('numeric_range: 两侧都无数值表述时跳过专项轨', async () => {
  const graph = buildNoveltyGraph({ includeApproval: false, ruleGate: false })
  const r = await graph
    .compile('extract')
    .run({ text: '一种分拣装置，包括传送带', prior_art: [{ title: 'D1', snippet: '公开传送带' }] })
  expect(String(r.state.numeric_range_result)).toMatch(/无需专项分析/)
  expect(r.state.numeric_range_verdict).toBeUndefined()
})

it('numeric_range: 语义轨结论一致时记为 agree', async () => {
  const graph = buildNoveltyGraph({ includeApproval: false, ruleGate: false })
  const r = await graph
    .compile('extract')
    .run({ text: NUMERIC_TEXT, prior_art: [{ title: 'D1', snippet: '温度 60-90°C' }] }, { provider: verdictProvider('overlapped') })
  expect(r.state.numeric_range_verdict).toBe('overlapped')
  expect(r.state.numeric_range_agreement).toBe('agree')
  expect(String(r.state.numeric_range_deterministic)).not.toContain('与语义轨结论不一致')
})

it('numeric_range: 语义轨结论相反时记为 disagree 并在摘要中点名', async () => {
  const graph = buildNoveltyGraph({ includeApproval: false, ruleGate: false })
  const r = await graph
    .compile('extract')
    .run({ text: NUMERIC_TEXT, prior_art: [{ title: 'D1', snippet: '温度 60-90°C' }] }, { provider: verdictProvider('no_overlap') })
  expect(r.state.numeric_range_agreement).toBe('disagree')
  expect(String(r.state.numeric_range_deterministic)).toContain('与语义轨结论不一致，请重点复核')
})

it('numeric_range: 确定性与语义轨两条结论都进结论节点的提示词', async () => {
  const graph = buildNoveltyGraph({ includeApproval: false, ruleGate: false })
  const r = await graph
    .compile('extract')
    .run({ text: NUMERIC_TEXT, prior_art: [{ title: 'D1', snippet: '温度 60-90°C' }] }, { provider: verdictProvider('overlapped') })
  const report = String(r.state.novelty_report)
  expect(report).toContain('【数值范围确定性核验】')
  expect(report).toContain('破坏性数值重叠')
  expect(report).toContain('【数值范围专项判定】')
})

it('handlerNode: handler 返回 _error → 节点级降级标记对图结果可见', async () => {
  const handler: StageHandler = {
    name: 'degraded',
    category: 'extract',
    execute: async () => ({
      partial: '部分结果',
      [DEGRADED_ERROR_KEY]: '[degraded] 缺少输入',
      [DEGRADED_RETRYABLE_KEY]: true,
    }),
  }
  const node = handlerNode(handler)
  const graph = new GraphBuilder()
  graph.addNode('node', node).addEdge('node', GRAPH_END)
  const result = await graph.compile('node').run({})
  expect(result.completed).toBe(true)
  expect(result.state.partial).toBe('部分结果')
  expect(result.state[DEGRADED_ERROR_KEY]).toBeUndefined()
  expect(result.state[DEGRADED_RETRYABLE_KEY]).toBeUndefined()
  expect(result.state[`node${DEGRADATION_SUFFIX}`]).toEqual({
    reason: 'node_failed',
    message: '[degraded] 缺少输入（可重试）',
    severity: 'critical',
  })
  expect(result.degraded).toHaveLength(1)

  // 直接调用节点时引擎不注入 nodeName，标记回退到 handler.name。
  const direct = await node({ state: {} })
  expect(direct[`degraded${DEGRADATION_SUFFIX}`]).toMatchObject({ reason: 'node_failed' })
})

it('numeric_range: 无对比文件数值表述时结论为无法判定', async () => {
  const graph = buildNoveltyGraph({ includeApproval: false, ruleGate: false })
  const r = await graph.compile('extract').run({ text: NUMERIC_TEXT, prior_art: [{ title: 'D1', snippet: '公开传送带' }] })
  expect(r.state.numeric_range_verdict).toBe('inconclusive')
  expect(String(r.state.numeric_range_deterministic)).toContain('无法判定')
})

it('numeric_range: 调用方取消以 StageCancelledError 穿透，不被降级吞掉（S-PAT-012）', async () => {
  const controller = new AbortController()
  const provider: StageProvider = {
    callLLM: async (prompt: string) => {
      if (prompt.includes('专项新颖性判定')) {
        // 模拟调用方在节点执行中取消：abort 后以 AbortError 拒绝，callLlm 会转换为
        // StageCancelledError；旧实现的 catch 会把它降级吞掉，新实现应穿透。
        controller.abort()
        throw new DOMException('aborted', 'AbortError')
      }
      return prompt
    },
  }
  const graph = buildNoveltyGraph({ includeApproval: false, ruleGate: false })
  try {
    await graph.compile('extract').run(
      { text: NUMERIC_TEXT, prior_art: [{ title: 'D1', snippet: '温度 60-90°C' }] },
      { provider, signal: controller.signal },
    )
    throw new Error('预期取消应拒绝，但 run 正常完成')
  } catch (err) {
    expect(isStageCancelledError(err)).toBe(true)
    expect((err as StageCancelledError).stageId).toBe('numeric_range')
  }
})

it('llmNode: 节点内取消以 StageCancelledError 穿透，不写降级标记（S-PAT-014）', async () => {
  const node = llmNode({ outputKey: 'inventiveness_conclusion', buildPrompt: () => 'prompt' })
  const controller = new AbortController()
  const aborting: StageProvider = {
    callLLM: async () => {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    },
  }
  try {
    await node({ state: {}, provider: aborting, signal: controller.signal })
    throw new Error('预期取消应拒绝，但节点正常返回')
  } catch (err) {
    expect(isStageCancelledError(err)).toBe(true)
    expect((err as StageCancelledError).stageId).toBe('inventiveness_conclusion')
  }

  // 已中止的信号即使 provider 抛普通错误也按取消处理。
  const aborted = new AbortController()
  aborted.abort()
  await expect(node({
    state: {},
    provider: { callLLM: async () => { throw new Error('boom') } },
    signal: aborted.signal,
  })).rejects.toBeInstanceOf(StageCancelledError)

  // 已是 StageCancelledError 的错误原样穿透，不包装成新实例。
  const cancelled = new StageCancelledError('inventiveness_conclusion')
  await expect(node({
    state: {},
    provider: { callLLM: async () => { throw cancelled } },
  })).rejects.toBe(cancelled)

  // provider 自身抛 AbortError（调用方信号未标记）同样按取消处理。
  const portAbort = new Error('aborted')
  portAbort.name = 'AbortError'
  await expect(node({
    state: {},
    provider: { callLLM: async () => { throw portAbort } },
  })).rejects.toBeInstanceOf(StageCancelledError)

  // 普通失败仍降级为 llm_unavailable，取消修复不改变失败语义。
  const delta = await node({ state: {}, provider: { callLLM: async () => { throw new Error('timeout') } } })
  const mark = delta[`inventiveness_conclusion${DEGRADATION_SUFFIX}`] as { reason?: unknown; message?: unknown }
  expect(mark.reason).toBe('llm_unavailable')
  expect(String(mark.message)).toContain('timeout')
})
