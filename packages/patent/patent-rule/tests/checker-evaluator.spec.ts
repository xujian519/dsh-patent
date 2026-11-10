import { expect, it } from 'vitest'
import { ruleGateNode, type RuleGateState } from '@deepseek-ai/dsh-patent-core'
import {
  CHECKER_RULE_EVALUATOR_ID,
  createCheckerRuleEvaluator,
  defaultPatentRules,
} from '@deepseek-ai/dsh-patent-rule'

const NOVELTY_VIOLATION = '结合多份对比文件结合，可认定本申请不具备新颖性。'

/** 规则门写入的是 `unknown` 状态增量；只在字段齐全时当成 `RuleGateState` 读。 */
function asRuleGate(value: unknown): RuleGateState {
  if (typeof value !== 'object' || value === null) throw new Error('rule_gate missing')
  if (!('status' in value) || !('verdict' in value) || !('evaluatedKeys' in value) || !('failures' in value)) {
    throw new Error('rule_gate missing fields')
  }
  if (!Array.isArray(value.failures)) throw new Error('rule_gate.failures is not an array')
  return value as RuleGateState
}

// ---------------------------------------------------------------------------
// checker 规则评估器：patent-core 规则门端口的 patent-rule 实现
// ---------------------------------------------------------------------------

it('createCheckerRuleEvaluator: 声明可评估领域且排除空域规则', () => {
  const evaluator = createCheckerRuleEvaluator()
  expect(evaluator.id).toBe(CHECKER_RULE_EVALUATOR_ID)
  expect(evaluator.domains).toContain('patent_novelty')
  expect(evaluator.domains).toContain('patent_spec')
  expect(evaluator.domains).not.toContain('')
  // 空域规则（引擎语义为全局生效）不构成可声明的支持域。
  expect(evaluator.domains).toEqual(
    [...new Set(defaultPatentRules().map(rule => rule.domain))].filter(domain => domain !== ''),
  )
})

it('createCheckerRuleEvaluator: 单域评估只跑该域与全局规则', () => {
  const evaluator = createCheckerRuleEvaluator()
  const assessment = evaluator.evaluate({ text: NOVELTY_VIOLATION, domains: ['patent_novelty'] })
  expect(assessment.verdict).toBe('blocked')
  expect(assessment.failures.map(failure => failure.ruleId)).toContain('NOVELTY-SINGLE-COMPARISON')
  const applicable = defaultPatentRules().filter(rule => rule.domain === 'patent_novelty' || rule.domain === '')
  expect(assessment.evaluatedRules).toBe(applicable.length)
})

it('createCheckerRuleEvaluator: 多域评估扩大规则集', () => {
  const evaluator = createCheckerRuleEvaluator()
  const one = evaluator.evaluate({ text: NOVELTY_VIOLATION, domains: ['patent_novelty'] })
  const two = evaluator.evaluate({ text: NOVELTY_VIOLATION, domains: ['patent_novelty', 'patent_spec'] })
  expect(two.evaluatedRules).toBeGreaterThan(one.evaluatedRules)
})

it('规则门执行真实 checker：单独对比违规写入 rule_gate', async () => {
  const delta = await ruleGateNode({
    domains: ['patent_novelty'],
    sourceKeys: ['novelty_report'],
    evaluator: createCheckerRuleEvaluator(),
  })({ state: { novelty_report: NOVELTY_VIOLATION } })

  const gate = asRuleGate(delta.rule_gate)
  expect(gate.status).toBe('blocked')
  expect(gate.verdict).toBe('blocked')
  expect(gate.evaluatedKeys).toEqual(['novelty_report'])
  expect(gate.failures.map(failure => failure.ruleId)).toContain('NOVELTY-SINGLE-COMPARISON')
})

it('createCheckerRuleEvaluator: 合规文本 → pass 且零失败', () => {
  const evaluator = createCheckerRuleEvaluator()
  const assessment = evaluator.evaluate({
    text:
      '侵权分析：将被控方案与权利要求1的技术特征逐一比对（全面覆盖原则），特征A构成等同替换；' +
      '同时审查审查过程修改，不存在禁止反悔情形，亦不适用捐献规则。',
    domains: ['patent_infringement'],
  })
  expect(assessment.failures).toEqual([])
  expect(assessment.verdict).toBe('pass')
  expect(assessment.evaluatedRules).toBe(4)
})
