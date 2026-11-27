import { expect, it } from 'vitest'
import {
  LevelMust,
  RuleEngine,
  aggregate,
  matchKeyword,
  type CheckRule,
  type RuleCheckResult,
} from '@deepseek-ai/dsh-patent-core'
import { formatRuleResults } from '../src/checker/engine.ts'
import type { Verdict } from '../src/checker/types.ts'

// =============================================================================
// 判级模型（Aggregate）
// =============================================================================

function failure(level: 0 | 1 | 2, passed = false): RuleCheckResult {
  return {
    ruleId: `test-rule-${level}`,
    ruleName: `测试规则${level}`,
    passed,
    level,
    severity: level === 0 ? 'critical' : level === 1 ? 'major' : 'minor',
    message: '测试失败',
    fixSuggestion: '测试建议',
  }
}

it('aggregate: 空结果 → pass', () => {
  expect(aggregate([])).toBe('pass')
})

it('aggregate: Level-0 (Must) 失败 → blocked', () => {
  expect(aggregate([failure(0)])).toBe('blocked')
})

it('aggregate: Level-1 (Should) 失败 → blocked', () => {
  expect(aggregate([failure(1)])).toBe('blocked')
})

it('aggregate: 1-2 条 Level-2 失败 → pass（质量小问题可容忍）', () => {
  expect(aggregate([failure(2)])).toBe('pass')
  expect(aggregate([failure(2), failure(2)])).toBe('pass')
})

it('aggregate: 3 条及以上 Level-2 失败 → needs_revision', () => {
  expect(aggregate([failure(2), failure(2), failure(2)])).toBe('needs_revision')
})

it('aggregate: passed 结果不参与判级', () => {
  expect(aggregate([failure(2, true), failure(2, true)])).toBe('pass')
})

// =============================================================================
// 规则引擎：域过滤、生命周期与报告（规则语料由规则包提供）
// =============================================================================

/** 合成规则：全部要求文本命中“新颖性”，便于用一段文本控制失败面。 */
function syntheticRule(id: string, domain: string): CheckRule {
  return {
    id,
    name: id,
    description: id,
    level: LevelMust,
    severity: 'critical',
    message: `${id} 失败`,
    checkType: 'patent_novelty',
    domain,
    requiredElements: ['新颖性'],
    fixSuggestion: '补充新颖性分析',
  }
}

const engine = new RuleEngine()
engine.registerMany([
  syntheticRule('NOVELTY-SYNTHETIC', 'patent_novelty'),
  syntheticRule('SPEC-SYNTHETIC', 'patent_spec'),
  syntheticRule('GLOBAL-SYNTHETIC', ''),
])

const NO_NOVELTY_TEXT = '本申请具备创造性。'

it('evaluate: 域过滤只评估匹配域的规则（空域规则对所有域生效）', () => {
  const filtered = engine.evaluate(NO_NOVELTY_TEXT, { domain: 'patent_novelty' })
  expect(filtered.map(result => result.ruleId).sort()).toEqual(['GLOBAL-SYNTHETIC', 'NOVELTY-SYNTHETIC'])
})

it('evaluate: 多域过滤（任一匹配即评估）', () => {
  const multi = engine.evaluate(NO_NOVELTY_TEXT, { domain: ['patent_novelty', 'patent_spec'] })
  expect(multi.map(result => result.ruleId).sort()).toEqual([
    'GLOBAL-SYNTHETIC',
    'NOVELTY-SYNTHETIC',
    'SPEC-SYNTHETIC',
  ])
})

it('evaluate: 空串域 = 全部规则（向后兼容）', () => {
  const all = engine.evaluate(NO_NOVELTY_TEXT, { domain: '' })
  const none = engine.evaluate(NO_NOVELTY_TEXT)
  expect(all.length).toBe(none.length)
})

it('RuleEngine: register/get/remove/all 生命周期', () => {
  const local = new RuleEngine()
  local.registerMany([syntheticRule('A', 'patent_novelty'), syntheticRule('B', 'patent_novelty')])
  expect(local.all().length).toBe(2)
  expect(local.get('A')).toBeTruthy()
  local.remove('A')
  expect(local.get('A')).toBeUndefined()
})

it('evaluate: 空文本触发全部失败，aggregate → blocked', () => {
  const failures = engine.evaluate('', { domain: 'patent_novelty' })
  expect(failures.length > 0).toBeTruthy()
  const verdict: Verdict = aggregate(failures)
  expect(verdict).toBe('blocked')
})

it('formatRuleResults: 通过时输出 Markdown 结论行', () => {
  const md = formatRuleResults([], 'pass')
  // The heading and the conclusion are separate lines; joining without a
  // separator would render one run-on heading.
  expect(md.split('\n').slice(0, 3)).toEqual(['## 规则引擎检查', '', '检查结论: ✅ 通过'])
  expect(md).toMatch(/检查结论: ✅ 通过/)
  expect(md).toMatch(/所有规则检查均通过/)
})

it('formatRuleResults: 失败时输出表格行（Must/Should/Quality 级别标签）', () => {
  const md = formatRuleResults([failure(0), failure(1), failure(2)], 'blocked')
  expect(md).toMatch(/检查结论: ⛔ 阻断/)
  expect(md).toMatch(/\| 规则 \| 级别 \| 严重度 \| 问题 \| 修改建议 \|/)
  expect(md).toContain('必须')
  expect(md).toContain('应当')
  expect(md).toContain('质量')
})

// =============================================================================
// 同义词扩展与否定检测
// =============================================================================

it('matchKeyword: 同义词扩展命中（现有技术 → 对比文件）', () => {
  expect(matchKeyword('检索到一篇现有技术文献', '对比文件')).toBe(true)
})

it('matchKeyword: 否定语境不误报（未发现区别特征）', () => {
  expect(matchKeyword('未发现区别技术特征', '区别技术特征')).toBe(false)
})

it('matchKeyword: 直接命中返回 true', () => {
  expect(matchKeyword('本申请具备新颖性', '新颖性')).toBe(true)
})

it('matchKeyword: 无关文本返回 false', () => {
  expect(matchKeyword('今天的天气很好', '新颖性')).toBe(false)
})

it('matchKeyword: 扩充否定词表不误报（缺乏/没有/未给出/未记载）', () => {
  // 扩充前这些表述会被当"肯定提及"→ 规则门漏报
  expect(matchKeyword('缺乏创造性', '创造性')).toBe(false)
  expect(matchKeyword('没有新颖性', '新颖性')).toBe(false)
  expect(matchKeyword('无法体现创造性', '创造性')).toBe(false)
  expect(matchKeyword('未给出技术启示', '技术启示')).toBe(false)
  expect(matchKeyword('说明书未记载技术效果', '技术效果')).toBe(false)
  expect(matchKeyword('难以认定具有创造性', '创造性')).toBe(false)
  // 肯定表述仍正常命中（不误伤）
  expect(matchKeyword('本申请具备新颖性', '新颖性')).toBe(true)
  expect(matchKeyword('对比文件未公开该特征，因此具备新颖性', '新颖性')).toBe(true)
})

it('matchKeyword: 前一处否定不毒化后一处肯定（D1 缺少 X；D2 公开 X）', () => {
  expect(matchKeyword('对比文件1缺少技术特征A；对比文件2公开了技术特征A', '技术特征')).toBe(true)
  expect(matchKeyword('对比文件2缺少技术特征A；对比文件1公开了技术特征A', '技术特征')).toBe(true)
  // 每一次出现都处于否定语境时才判未命中。
  expect(matchKeyword('对比文件1缺少技术特征A；对比文件2也缺少技术特征A', '技术特征')).toBe(false)
})

it('matchKeyword: 双重否定不误判（并非没有/并不缺乏 = 肯定语义）', () => {
  // 窗口含命中词后，嵌目标词的否定模式会命中"并非没有新颖性"——
  // 反否定前缀守卫应将其翻转为肯定（典型紧邻形式）
  expect(matchKeyword('本发明并非没有新颖性', '新颖性')).toBe(true)
  expect(matchKeyword('本申请并不缺乏创造性', '创造性')).toBe(true)
  expect(matchKeyword('该方案并非没有技术启示', '技术启示')).toBe(true)
  // 单纯否定仍判否定（守卫不误放行）
  expect(matchKeyword('本申请没有新颖性', '新颖性')).toBe(false)
  expect(matchKeyword('该方案缺乏技术启示', '技术启示')).toBe(false)
})
