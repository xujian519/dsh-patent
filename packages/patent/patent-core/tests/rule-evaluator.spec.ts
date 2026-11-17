import { expect, it } from 'vitest'
import {
  ruleGateNode,
  type RuleCheckResult,
  type RuleEvaluator,
  type RuleGateState,
} from '@deepseek-ai/dsh-patent-core'
import { evaluateRuleGate, requireRuleEvaluator } from '../src/graph/domains/shared.ts'
import type { RuleGateAssessment, RuleGateRequest } from '../src/checker/evaluator.ts'

// ---------------------------------------------------------------------------
// 规则门 fail-closed 语义
// ---------------------------------------------------------------------------

function stubEvaluator(overrides: Partial<RuleEvaluator> = {}): RuleEvaluator {
  return {
    id: 'test:evaluator',
    evaluate: () => ({ verdict: 'pass', failures: [], evaluatedRules: 1 }),
    ...overrides,
  }
}

function failureOf(result: { failures: RuleCheckResult[] }): RuleCheckResult {
  const failure = result.failures[0]
  if (failure === undefined) throw new Error('expected one gate failure')
  return failure
}

it('evaluateRuleGate: 空领域 → fail-closed', () => {
  const assessment = evaluateRuleGate(stubEvaluator(), { text: 'x', domains: [] })
  expect(assessment.verdict).toBe('blocked')
  expect(assessment.evaluatedRules).toBe(0)
  const failure = failureOf(assessment)
  expect(failure.ruleId).toBe('RULE-GATE-NO-DOMAINS')
  expect(failure.level).toBe(0)
  expect(failure.severity).toBe('critical')
})

it('evaluateRuleGate: 评估器未声明的领域 → fail-closed', () => {
  const evaluator = stubEvaluator({ domains: ['patent_novelty'] })
  const assessment = evaluateRuleGate(evaluator, { text: 'x', domains: ['patent_novelty', 'patent_foo'] })
  expect(assessment.verdict).toBe('blocked')
  const failure = failureOf(assessment)
  expect(failure.ruleId).toBe('RULE-GATE-UNKNOWN-DOMAIN')
  expect(failure.message).toContain('patent_foo')
  expect(failure.message).not.toContain('patent_novelty')
})

it('evaluateRuleGate: 未限制领域的评估器 → 原样返回结论', () => {
  const expected: RuleGateAssessment = { verdict: 'needs_revision', failures: [], evaluatedRules: 3 }
  const evaluator = stubEvaluator({ evaluate: () => expected })
  expect(evaluateRuleGate(evaluator, { text: 'x', domains: ['patent_any'] })).toBe(expected)
})

it('evaluateRuleGate: 评估器抛错 → fail-closed（Error 与非 Error）', () => {
  const throwingError = stubEvaluator({
    evaluate: () => {
      throw new Error('规则资产损坏')
    },
  })
  const fromError = evaluateRuleGate(throwingError, { text: 'x', domains: ['patent_novelty'] })
  expect(fromError.verdict).toBe('blocked')
  expect(failureOf(fromError).ruleId).toBe('RULE-GATE-EVALUATOR-ERROR')
  expect(failureOf(fromError).message).toContain('规则资产损坏')

  const throwingValue = stubEvaluator({
    evaluate: () => {
      throw '规则资产离线'
    },
  })
  const fromValue = evaluateRuleGate(throwingValue, { text: 'x', domains: ['patent_novelty'] })
  expect(failureOf(fromValue).message).toContain('规则资产离线')
})

it('evaluateRuleGate: 零规则参与 → fail-closed', () => {
  const evaluator = stubEvaluator({
    evaluate: () => ({ verdict: 'pass', failures: [], evaluatedRules: 0 }),
  })
  const assessment = evaluateRuleGate(evaluator, { text: 'x', domains: ['patent_novelty'] })
  expect(assessment.verdict).toBe('blocked')
  expect(failureOf(assessment).ruleId).toBe('RULE-GATE-EMPTY-RULESET')
})

// ---------------------------------------------------------------------------
// ruleGateNode：来源键范围、降级阻断与结构化结论
// ---------------------------------------------------------------------------

const TEST_FAILURE: RuleCheckResult = {
  ruleId: 'TEST-RULE',
  ruleName: '测试规则',
  passed: false,
  level: 2,
  severity: 'minor',
  message: '测试失败',
  fixSuggestion: '测试建议',
}

/** 违禁词评估器：文本含 `绝对新颖` 即判失败，其余放行。 */
function bannedWordEvaluator(requests?: RuleGateRequest[]): RuleEvaluator {
  return {
    id: 'test:banned-words',
    domains: ['patent_novelty'],
    evaluate: (request) => {
      requests?.push(request)
      return request.text.includes('绝对新颖')
        ? { verdict: 'needs_revision', failures: [TEST_FAILURE], evaluatedRules: 1 }
        : { verdict: 'pass', failures: [], evaluatedRules: 1 }
    },
  }
}

it('ruleGateNode: 只汇总声明的来源键，结构化结论写入 rule_gate', async () => {
  const requests: RuleGateRequest[] = []
  const evaluator: RuleEvaluator = {
    id: 'test:injected',
    domains: ['patent_novelty'],
    evaluate: (request) => {
      requests.push(request)
      return { verdict: 'needs_revision', failures: [TEST_FAILURE], evaluatedRules: 5 }
    },
  }

  const delta = await ruleGateNode({
    domains: ['patent_novelty'],
    sourceKeys: ['novelty_report'],
    evaluator,
  })({
    state: {
      novelty_report: '新颖性分析报告',
      novelty_result: '绝对新颖',
      text: '原始输入：绝对新颖',
      _meta: 'ignored',
      rule_gate: { status: 'pass' },
    },
  })

  expect(requests).toEqual([{ text: '## novelty_report\n新颖性分析报告', domains: ['patent_novelty'] }])
  expect(delta).toEqual({
    rule_gate: {
      status: 'fail',
      verdict: 'needs_revision',
      domains: ['patent_novelty'],
      failures: [TEST_FAILURE],
      evaluator: 'test:injected',
      evaluatedRules: 5,
      evaluatedKeys: ['novelty_report'],
      degradedSources: [],
    },
  })
})

it('ruleGateNode: 原始输入含违禁词、最终报告干净 → pass', async () => {
  const requests: RuleGateRequest[] = []
  const delta = await ruleGateNode({
    domains: ['patent_novelty'],
    sourceKeys: ['novelty_report'],
    evaluator: bannedWordEvaluator(requests),
  })({ state: { text: '绝对新颖', novelty_report: '权利要求具备新颖性' } })

  expect(requests).toHaveLength(1)
  expect(requests[0]?.text).not.toContain('绝对新颖')
  expect(delta.rule_gate).toMatchObject({ status: 'pass', verdict: 'pass', evaluatedKeys: ['novelty_report'] })
})

it('ruleGateNode: 最终报告含违禁词 → fail', async () => {
  const delta = await ruleGateNode({
    domains: ['patent_novelty'],
    sourceKeys: ['novelty_report'],
    evaluator: bannedWordEvaluator(),
  })({ state: { novelty_report: '本方案绝对新颖' } })

  expect(delta.rule_gate).toMatchObject({
    status: 'fail',
    verdict: 'needs_revision',
    failures: [TEST_FAILURE],
  })
})

it('ruleGateNode: 最终报告为空 → blocked 且不调用评估器', async () => {
  const requests: RuleGateRequest[] = []
  const delta = await ruleGateNode({
    domains: ['patent_novelty'],
    sourceKeys: ['novelty_report'],
    evaluator: bannedWordEvaluator(requests),
  })({ state: { novelty_report: '   ' } })

  expect(requests).toHaveLength(0)
  expect(delta.rule_gate).toMatchObject({
    status: 'blocked',
    verdict: 'blocked',
    evaluatedRules: 0,
    evaluatedKeys: [],
    degradedSources: ['novelty_report'],
  })
  expect(failureOf(delta.rule_gate as RuleGateState).ruleId).toBe('RULE-GATE-SOURCES-UNAVAILABLE')
  expect(failureOf(delta.rule_gate as RuleGateState).message).toContain('novelty_report（为空）')
})

it('ruleGateNode: 最终报告缺失或非字符串 → blocked', async () => {
  const gate = ruleGateNode({
    domains: ['patent_novelty'],
    sourceKeys: ['novelty_report', 'numeric_range_result'],
    evaluator: bannedWordEvaluator(),
  })
  const missing = await gate({ state: { numeric_range_result: '50-80℃ 已公开' } })
  expect(missing.rule_gate).toMatchObject({
    status: 'blocked',
    degradedSources: ['novelty_report'],
  })
  expect(failureOf(missing.rule_gate as RuleGateState).message).toContain('novelty_report（缺失）')

  const notText = await gate({ state: { novelty_report: 42, numeric_range_result: '50-80℃ 已公开' } })
  expect(notText.rule_gate).toMatchObject({ status: 'blocked', degradedSources: ['novelty_report'] })
  expect(failureOf(notText.rule_gate as RuleGateState).message).toContain('novelty_report（非字符串）')
})

it('ruleGateNode: 来源阶段降级 → blocked（即使 fallback 非空）', async () => {
  const requests: RuleGateRequest[] = []
  const delta = await ruleGateNode({
    domains: ['patent_novelty'],
    sourceKeys: ['novelty_report'],
    evaluator: bannedWordEvaluator(requests),
  })({
    state: {
      novelty_report: '数值范围专项判定失败（LLM 错误）',
      novelty_report__degradation: { reason: 'llm_unavailable', message: '降级', severity: 'warning' },
    },
  })

  expect(requests).toHaveLength(0)
  expect(delta.rule_gate).toMatchObject({
    status: 'blocked',
    evaluatedKeys: [],
    degradedSources: ['novelty_report'],
  })
  expect(failureOf(delta.rule_gate as RuleGateState).message).toContain('novelty_report（已降级）')
})

it('ruleGateNode: 多来源键只评估声明键，未声明键不参与', async () => {
  const requests: RuleGateRequest[] = []
  const delta = await ruleGateNode({
    domains: ['patent_novelty'],
    sourceKeys: ['report_a', 'report_b'],
    evaluator: bannedWordEvaluator(requests),
  })({
    state: {
      report_a: '报告 A 干净',
      report_b: '报告 B 干净',
      report_c: '绝对新颖',
    },
  })

  expect(requests[0]?.text).toBe('## report_a\n报告 A 干净\n\n## report_b\n报告 B 干净')
  expect(requests[0]?.text).not.toContain('报告 C')
  expect(delta.rule_gate).toMatchObject({
    status: 'pass',
    evaluatedKeys: ['report_a', 'report_b'],
    degradedSources: [],
  })
})

it('ruleGateNode: 未声明来源键 → 构图期报错', () => {
  expect(() => ruleGateNode({ domains: ['patent_novelty'], sourceKeys: [], evaluator: bannedWordEvaluator() }))
    .toThrow(/sourceKeys 不能为空/)
})

// ---------------------------------------------------------------------------
// requireRuleEvaluator：启用规则门却未注入评估器 → 构图期报错
// ---------------------------------------------------------------------------

it('requireRuleEvaluator: 返回注入的评估器', () => {
  const evaluator = stubEvaluator()
  expect(requireRuleEvaluator({ ruleEvaluator: evaluator })).toBe(evaluator)
})

it('requireRuleEvaluator: 缺少评估器 → 报错指向注入方式与关闭开关', () => {
  expect(() => requireRuleEvaluator({})).toThrow(/未注入 ruleEvaluator/)
  expect(() => requireRuleEvaluator({})).toThrow(/createCheckerRuleEvaluator/)
  expect(() => requireRuleEvaluator({})).toThrow(/ruleGate: false/)
})
