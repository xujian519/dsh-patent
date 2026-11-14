import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RuleSet, RuleSetValidationIssue } from '@deepseek-ai/dsh-patent-core'
import {
  applyRuleOverrides,
  asRecord,
  loadRuleSetDir,
  loadRuleSetFromFile,
  mergeRuleSets,
  parseRuleSetFromYaml,
  validateRuleSet,
} from '@deepseek-ai/dsh-patent-rule'

const ARRAY_YAML = `
version: "1.0"
rules:
  - id: CON-101
    name: 发明定义-技术方案三要素
    domain: patent
    phase: 申请前
    severity: critical
    action: block
    legalBasis: 专利法第二条第二款
    check:
      type: structural_analysis
      requiresAll:
        - element: technical_means
          patterns: ["装置|设备|系统"]
        - element: technical_effect
          patterns: ["提高|改善"]
      minConfidence: 0.5
`

const MAP_YAML = `
rules:
  subject_matter_excluded_art5:
    id: CON-102
    name: 违法排除
    severity: critical
    action: block
    check:
      type: keyword_blocklist
      keywords: ["赌博|博彩"]
      negationContext: true
`

describe('RuleLoader', () => {
  it('parseRuleSetFromYaml parses array form', () => {
    const { ruleSet, issues } = parseRuleSetFromYaml(ARRAY_YAML, 'array.yaml')
    expect(issues.length).toBe(0)
    expect(ruleSet.rules.length).toBe(1)
    const rule = ruleSet.rules[0]
    expect(rule?.id).toBe('CON-101')
    expect(rule?.domain).toBe('patent')
    expect(rule?.phase).toBe('申请前')
    expect(rule?.legalBasis).toBe('专利法第二条第二款')
    expect(rule?.check.type).toBe('structural_analysis')
    if (rule?.check.type === 'structural_analysis') {
      expect(rule.check.requiresAll.length).toBe(2)
      expect(rule.check.minConfidence).toBe(0.5)
    }
  })

  it('parseRuleSetFromYaml parses map form (BCIP style)', () => {
    const { ruleSet, issues } = parseRuleSetFromYaml(MAP_YAML, 'map.yaml')
    expect(issues.length).toBe(0)
    expect(ruleSet.rules.length).toBe(1)
    const rule = ruleSet.rules[0]
    expect(rule?.id).toBe('CON-102')
    expect(rule?.check.type).toBe('keyword_blocklist')
    if (rule?.check.type === 'keyword_blocklist') {
      expect(rule.check.negationContext).toBe(true)
    }
  })

  it('parseRuleSetFromYaml reports invalid severity and missing id', () => {
    const { issues } = parseRuleSetFromYaml(
      `
rules:
  - id: CON-X
    name: bad
    severity: "fatal"
    action: block
    check: { type: keyword_blocklist, keywords: ["x"] }
  - name: no-id
    severity: major
    action: warn
    check: { type: keyword_blocklist, keywords: ["y"] }
`,
    )
    expect(issues.some(i => i.message.includes('severity'))).toBe(true)
    expect(issues.some(i => i.message.includes('缺少 id'))).toBe(true)
  })

  it('parseRuleSetFromYaml rejects invalid regex in pattern_analysis', () => {
    const { issues } = parseRuleSetFromYaml(
      `
rules:
  - id: CON-P
    name: bad regex
    severity: major
    action: warn
    check: { type: pattern_analysis, patterns: ["("] }
`,
    )
    expect(issues.some(i => i.message.includes('非法正则'))).toBe(true)
  })

  it('parseRuleSetFromYaml rejects nested-quantifier regex (ReDoS guard)', () => {
    const { issues } = parseRuleSetFromYaml(
      `
rules:
  - id: CON-REDOS
    name: redos
    severity: major
    action: warn
    check: { type: pattern_analysis, patterns: ["(a+)+"] }
`,
    )
    expect(issues.some(i => i.message.includes('灾难性回溯'))).toBe(true)
  })

  it('parseRuleSetFromYaml rejects a quantifier after a repetition brace', () => {
    const { issues } = parseRuleSetFromYaml(
      `
rules:
  - id: CON-REDOS-BRACE
    name: redos brace
    severity: major
    action: warn
    check: { type: pattern_analysis, patterns: ["a}+"] }
`,
    )
    expect(issues.some(i => i.message.includes('灾难性回溯'))).toBe(true)
  })

  it('parseRuleSetFromYaml rejects overlapping alternation under a quantifier', () => {
    const { issues } = parseRuleSetFromYaml(
      `
rules:
  - id: CON-REDOS-ALT
    name: redos alternation
    severity: major
    action: warn
    check: { type: pattern_analysis, patterns: ["(a|aa)+"] }
`,
    )
    expect(issues.some(i => i.message.includes('灾难性回溯'))).toBe(true)
  })

  it('parseRuleSetFromYaml rejects overlapping alternation inside a non-capturing group', () => {
    const { issues } = parseRuleSetFromYaml(
      `
rules:
  - id: CON-REDOS-NC
    name: redos non-capturing alternation
    severity: major
    action: warn
    check: { type: pattern_analysis, patterns: ["(?:a|aa)+"] }
`,
    )
    expect(issues.some(i => i.message.includes('灾难性回溯'))).toBe(true)
  })

  it('parseRuleSetFromYaml keeps mutually exclusive alternation under a quantifier', () => {
    const { ruleSet, issues } = parseRuleSetFromYaml(
      `
rules:
  - id: CON-OK-ALT
    name: safe alternation
    severity: major
    action: warn
    check: { type: pattern_analysis, patterns: ["(a|b)+"] }
`,
    )
    expect(issues).toEqual([])
    expect(ruleSet.rules).toHaveLength(1)
  })

  it('parseRuleSetFromYaml applies the ReDoS guard to structural_analysis patterns too', () => {
    const { issues } = parseRuleSetFromYaml(
      `
rules:
  - id: CON-REDOS-S
    name: redos structural
    severity: major
    action: warn
    check:
      type: structural_analysis
      requiresAll:
        - element: tech
          patterns: ["(x*)*"]
`,
    )
    expect(issues.some(i => i.message.includes('灾难性回溯'))).toBe(true)
  })

  it('parseRuleSetFromYaml reports duplicate ids and keeps the later rule', () => {
    const { ruleSet, issues } = parseRuleSetFromYaml(
      `
rules:
  - id: CON-DUP
    name: a
    severity: major
    action: block
    check: { type: keyword_blocklist, keywords: ["x"] }
  - id: CON-DUP
    name: b
    severity: major
    action: warn
    check: { type: keyword_blocklist, keywords: ["y"] }
`,
    )
    expect(issues.filter(issue => issue.message.includes('重复的规则 id'))).toHaveLength(1)
    expect(ruleSet.rules).toHaveLength(1)
    expect(ruleSet.rules[0]).toMatchObject({ name: 'b', action: 'warn', check: { keywords: ['y'] } })
  })

  it('loadRuleSetFromFile reads a valid file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rule-test-'))
    const path = join(dir, 'test.yaml')
    writeFileSync(path, ARRAY_YAML, 'utf8')
    const loaded = loadRuleSetFromFile(path)
    expect(loaded.ruleSet.rules.length).toBe(1)
    expect(loaded.warnings.length).toBe(0)
  })

  it('loadRuleSetFromFile keeps valid rules when only a rule is missing id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rule-test-'))
    const path = join(dir, 'mixed.yaml')
    writeFileSync(
      path,
      `
rules:
  - id: CON-OK
    name: good
    severity: major
    action: warn
    check: { type: keyword_blocklist, keywords: ["x"] }
  - name: no-id
    severity: major
    action: warn
    check: { type: keyword_blocklist, keywords: ["y"] }
`,
      'utf8',
    )
    const loaded = loadRuleSetFromFile(path)
    expect(loaded.ruleSet.rules.length).toBe(1)
    expect(loaded.ruleSet.rules[0]?.id).toBe('CON-OK')
    expect(loaded.warnings.some(w => w.message.includes('缺少 id'))).toBe(true)
  })

  it('parseRuleSetFromYaml ignores invalid severityIfFound values', () => {
    const { ruleSet, issues } = parseRuleSetFromYaml(
      `
rules:
  - id: CON-S
    name: s
    severity: major
    action: warn
    check: { type: keyword_blocklist, keywords: ["x"], severityIfFound: "catastrophic" }
`,
    )
    expect(issues.some(i => i.message.includes('severityIfFound'))).toBe(true)
    const rule = ruleSet.rules[0]
    expect(rule?.check.type).toBe('keyword_blocklist')
    if (rule?.check.type === 'keyword_blocklist') {
      expect(rule.check.severityIfFound).toBeUndefined()
    }
  })

  it('parseRuleSetFromYaml reports a non-array additionalNegationWords and ignores the field', () => {
    // 「声明了却不生效」的第二种形态：值本身不是字符串数组。与「缺开关」不同（那条走
    // 正交性告警），此处字段被丢弃，故规则本身仍成立（keywords 合法）。
    const { ruleSet, issues } = parseRuleSetFromYaml(
      `
rules:
  - id: T-NEG-BAD
    name: n
    severity: minor
    action: warn
    check: { type: keyword_blocklist, keywords: ["窃听"], negationContext: true, additionalNegationWords: "防" }
`,
    )
    expect(issues.map(i => i.message)).toEqual([
      'rule T-NEG-BAD: additionalNegationWords 必须是非空字符串数组，已忽略',
    ])
    const rule = ruleSet.rules[0]
    expect(rule?.check.type).toBe('keyword_blocklist')
    if (rule?.check.type === 'keyword_blocklist') {
      expect(rule.check.additionalNegationWords).toBeUndefined()
    }
  })

  it('parseRuleSetFromYaml reports an empty additionalNegationWords instead of dropping it silently', () => {
    // 空数组曾与「值合法但没写词」无法区分：既不告警也不写入字段，资产作者会以为放行词
    // 已生效。字段契约是"非空字符串数组"，故空表与非法类型同责；补丁路径
    // （patent-compliance 的 parseActivationPatch）对同一输入已告警，两侧判据一致。
    const { ruleSet, issues } = parseRuleSetFromYaml(
      `
rules:
  - id: T-NEG-EMPTY
    name: n
    severity: minor
    action: warn
    check: { type: keyword_blocklist, keywords: ["窃听"], negationContext: true, additionalNegationWords: [] }
`,
    )
    expect(issues.map(i => i.message)).toEqual([
      'rule T-NEG-EMPTY: additionalNegationWords 必须是非空字符串数组，已忽略',
    ])
    const rule = ruleSet.rules[0]
    expect(rule?.check.type).toBe('keyword_blocklist')
    if (rule?.check.type === 'keyword_blocklist') {
      expect(rule.check.additionalNegationWords).toBeUndefined()
    }
  })

  it('parseRuleSetFromYaml reports an all-blank additionalNegationWords instead of accepting words that can never apply', () => {
    // 第三种「声明了却不生效」形态：整表皆空串。空串元素被 hasNegationContext 的
    // `word.length > 0` 守卫丢弃，豁免不了任何命中，而资产作者以为放行词已生效——与空表
    // 同责：整表丢弃并告警。带首尾空白的元素不在此列，见下一条用例。
    for (const raw of ['[""]', '["", ""]']) {
      const { ruleSet, issues } = parseRuleSetFromYaml(
        `
rules:
  - id: T-NEG-BLANK
    name: n
    severity: minor
    action: warn
    check: { type: keyword_blocklist, keywords: ["窃听"], negationContext: true, additionalNegationWords: ${raw} }
`,
      )
      expect(issues.map(i => i.message)).toEqual([
        'rule T-NEG-BLANK: additionalNegationWords 必须是非空字符串数组，已忽略',
      ])
      const rule = ruleSet.rules[0]
      expect(rule?.check.type).toBe('keyword_blocklist')
      if (rule?.check.type === 'keyword_blocklist') {
        expect(rule.check.additionalNegationWords).toBeUndefined()
      }
    }
  })

  it('parseRuleSetFromYaml keeps a padded additionalNegationWords entry, which still matches literally', () => {
    // 带首尾空白的元素按字面参与紧邻前缀匹配（hasNegationContext 的 endsWith 不做 trim），
    // 语义窄但会生效；关键词那条路径则先 trim 再 indexOf，同样会命中。拒绝它会连带丢弃
    // 作者真正写下的放行词，故整表保留——判据只拒绝在消费侧恒不生效的形态。
    const { ruleSet, issues } = parseRuleSetFromYaml(
      `
rules:
  - id: T-NEG-PADDED
    name: n
    severity: minor
    action: warn
    check: { type: keyword_blocklist, keywords: ["窃听"], negationContext: true, additionalNegationWords: ["防 ", "反"] }
`,
    )
    expect(issues.length).toBe(0)
    const rule = ruleSet.rules[0]
    expect(rule?.check.type).toBe('keyword_blocklist')
    if (rule?.check.type === 'keyword_blocklist') {
      expect(rule.check.additionalNegationWords).toEqual(['防 ', '反'])
    }
  })

  it('loadRuleSetFromFile throws on structurally invalid file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rule-test-'))
    const path = join(dir, 'bad.yaml')
    writeFileSync(path, 'rules: [not an object', 'utf8')
    expect(() => loadRuleSetFromFile(path)).toThrow(/加载失败/)
  })

  it('loadRuleSetDir skips broken files with warnings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rule-test-'))
    writeFileSync(join(dir, 'a.yaml'), ARRAY_YAML, 'utf8')
    writeFileSync(join(dir, 'broken.yaml'), 'rules: {', 'utf8')
    writeFileSync(join(dir, 'notes.md'), 'not a rule file', 'utf8')
    const { ruleSets, warnings } = loadRuleSetDir(dir)
    expect(ruleSets.length).toBe(1)
    expect(warnings.some(w => w.source?.endsWith('broken.yaml'))).toBe(true)
    expect(warnings.some(w => w.source?.endsWith('notes.md'))).toBe(false)
  })

  it('loadRuleSetDir returns warning when directory missing', () => {
    const { ruleSets, warnings } = loadRuleSetDir('/nonexistent/rules')
    expect(ruleSets.length).toBe(0)
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('mergeRuleSets overrides by id with later wins', () => {
    const first = parseRuleSetFromYaml(ARRAY_YAML).ruleSet
    const second = parseRuleSetFromYaml(
      `
rules:
  - id: CON-101
    name: 覆盖版
    severity: minor
    action: log
    check: { type: keyword_blocklist, keywords: ["x"] }
`,
    ).ruleSet
    const merged = mergeRuleSets([first, second])
    expect(merged.rules.length).toBe(1)
    expect(merged.rules[0]?.name).toBe('覆盖版')
  })

  it('validateRuleSet detects duplicates', () => {
    const set: RuleSet = {
      rules: [
        { id: 'D1', name: 'a', severity: 'major', action: 'warn', check: { type: 'keyword_blocklist', keywords: ['x'] } },
        { id: 'D1', name: 'b', severity: 'major', action: 'warn', check: { type: 'keyword_blocklist', keywords: ['y'] } },
      ],
    }
    const issues = validateRuleSet(set, 'dup.yaml')
    expect(issues.some(i => i.message.includes('重复的规则 id') && i.source === 'dup.yaml')).toBe(true)
  })

  it('asRecord returns null for non-object values', () => {
    expect(asRecord('str')).toBeNull()
    expect(asRecord([1, 2])).toBeNull()
    expect(asRecord(null)).toBeNull()
    expect(asRecord(undefined)).toBeNull()
    expect(asRecord({ a: 1 })).toEqual({ a: 1 })
  })

  it('parseRuleSetFromYaml rejects a non-object top level', () => {
    const { issues } = parseRuleSetFromYaml('- just\n- a list')
    expect(issues.some(i => i.message.includes('顶层必须是对象'))).toBe(true)
  })

  it('parseRuleSetFromYaml rejects a document without a rules field', () => {
    const { issues } = parseRuleSetFromYaml('version: "1.0"\n')
    expect(issues.some(i => i.message.includes('缺少 rules 字段'))).toBe(true)
  })

  it('parseRuleSetFromYaml skips non-object rule entries', () => {
    const { ruleSet, issues } = parseRuleSetFromYaml('rules:\n  - 42\n  - id: OK\n    name: ok\n    severity: minor\n    action: warn\n    check: { type: keyword_blocklist, keywords: ["x"] }\n')
    expect(ruleSet.rules.length).toBe(1)
    expect(ruleSet.rules[0]?.id).toBe('OK')
    expect(issues.some(i => i.message.includes('rules[0]: 条目必须是对象'))).toBe(true)
  })

  it('parseRuleSetFromYaml rejects rules missing a name', () => {
    const { issues } = parseRuleSetFromYaml(
      'rules:\n  - id: NO-NAME\n    severity: major\n    action: warn\n    check: { type: keyword_blocklist, keywords: ["x"] }\n',
    )
    expect(issues.some(i => i.message.includes('缺少 name'))).toBe(true)
  })

  it('parseRuleSetFromYaml defaults a missing action to warn and rejects invalid actions', () => {
    const { ruleSet } = parseRuleSetFromYaml(
      'rules:\n  - id: NO-ACTION\n    name: n\n    severity: minor\n    check: { type: keyword_blocklist, keywords: ["x"] }\n',
    )
    expect(ruleSet.rules[0]?.action).toBe('warn')
    const { issues } = parseRuleSetFromYaml(
      'rules:\n  - id: BAD-ACTION\n    name: n\n    severity: minor\n    action: detonate\n    check: { type: keyword_blocklist, keywords: ["x"] }\n',
    )
    expect(issues.some(i => i.message.includes('action 必须是'))).toBe(true)
  })

  it('parseRuleSetFromYaml rejects a non-object check', () => {
    const { issues } = parseRuleSetFromYaml(
      'rules:\n  - id: C1\n    name: n\n    severity: minor\n    action: warn\n    check: 42\n',
    )
    expect(issues.some(i => i.message.includes('check 必须是对象'))).toBe(true)
  })

  it('parseRuleSetFromYaml rejects unknown check types', () => {
    const { issues } = parseRuleSetFromYaml(
      'rules:\n  - id: C2\n    name: n\n    severity: minor\n    action: warn\n    check: { type: telepathy }\n',
    )
    expect(issues.some(i => i.message.includes('未知检查类型'))).toBe(true)
  })

  it('keyword_blocklist rejects non-array, non-string, and empty keywords', () => {
    const nonArray = parseRuleSetFromYaml(
      'rules:\n  - id: K1\n    name: n\n    severity: minor\n    action: warn\n    check: { type: keyword_blocklist, keywords: "x" }\n',
    )
    expect(nonArray.issues.some(i => i.message.includes('非空关键词'))).toBe(true)
    const mixed = parseRuleSetFromYaml(
      'rules:\n  - id: K2\n    name: n\n    severity: minor\n    action: warn\n    check: { type: keyword_blocklist, keywords: ["x", 42] }\n',
    )
    expect(mixed.issues.some(i => i.message.includes('非空关键词'))).toBe(true)
    const empty = parseRuleSetFromYaml(
      'rules:\n  - id: K3\n    name: n\n    severity: minor\n    action: warn\n    check: { type: keyword_blocklist, keywords: [] }\n',
    )
    expect(empty.issues.some(i => i.message.includes('非空关键词'))).toBe(true)
  })

  it('keyword_blocklist reports a non-boolean negationContext instead of silently disabling it', () => {
    const { ruleSet, issues } = parseRuleSetFromYaml(
      'rules:\n  - id: K-NEG\n    name: n\n    severity: minor\n    action: warn\n    check: { type: keyword_blocklist, keywords: ["x"], negationContext: "true" }\n',
    )
    expect(issues.some(i => i.message.includes('negationContext'))).toBe(true)
    const rule = ruleSet.rules[0]
    if (rule?.check.type === 'keyword_blocklist') expect(rule.check.negationContext).toBe(false)
  })

  it('pattern_analysis reports an invalid minMatches and falls back to 1', () => {
    const { ruleSet, issues } = parseRuleSetFromYaml(
      'rules:\n  - id: P-MIN\n    name: n\n    severity: minor\n    action: warn\n    check: { type: pattern_analysis, patterns: ["x"], minMatches: 0 }\n',
    )
    expect(issues.some(i => i.message.includes('minMatches'))).toBe(true)
    const rule = ruleSet.rules[0]
    if (rule?.check.type === 'pattern_analysis') expect(rule.check.minMatches).toBe(1)
  })

  it('structural_analysis reports an out-of-range minConfidence and falls back to 1', () => {
    const { ruleSet, issues } = parseRuleSetFromYaml(
      'rules:\n  - id: S-CONF\n    name: n\n    severity: minor\n    action: warn\n    check: { type: structural_analysis, minConfidence: 2, requiresAll: [{ element: e, patterns: ["x"] }] }\n',
    )
    expect(issues.some(i => i.message.includes('minConfidence'))).toBe(true)
    const rule = ruleSet.rules[0]
    if (rule?.check.type === 'structural_analysis') expect(rule.check.minConfidence).toBe(1)
  })

  it('synonym_match reports an out-of-range minConfidence and falls back to 1', () => {
    const { ruleSet, issues } = parseRuleSetFromYaml(
      'rules:\n  - id: Y-CONF\n    name: n\n    severity: minor\n    action: warn\n    check: { type: synonym_match, minConfidence: -1, requirements: [{ element: e, keywords: ["x"] }] }\n',
    )
    expect(issues.some(i => i.message.includes('minConfidence'))).toBe(true)
    const rule = ruleSet.rules[0]
    if (rule?.check.type === 'synonym_match') expect(rule.check.minConfidence).toBe(1)
  })

  it('synonym_match rejects empty requirement keywords', () => {
    const { issues } = parseRuleSetFromYaml(
      'rules:\n  - id: Y-EMPTY\n    name: n\n    severity: minor\n    action: warn\n    check: { type: synonym_match, requirements: [{ element: e, keywords: [""] }] }\n',
    )
    expect(issues.some(i => i.message.includes('至少一个非空 keyword'))).toBe(true)
  })

  it('keyword_blocklist keeps a valid severityIfFound override', () => {
    const { ruleSet, issues } = parseRuleSetFromYaml(
      'rules:\n  - id: SIF\n    name: n\n    severity: minor\n    action: warn\n    check: { type: keyword_blocklist, keywords: ["x"], severityIfFound: "critical" }\n',
    )
    expect(issues.length).toBe(0)
    const rule = ruleSet.rules[0]
    expect(rule?.check.type).toBe('keyword_blocklist')
    if (rule?.check.type === 'keyword_blocklist') {
      expect(rule.check.severityIfFound).toBe('critical')
      expect(rule.check.negationContext).toBe(false)
    }
  })

  it('pattern_analysis accepts numeric minMatches through the loader', () => {
    const { ruleSet, issues } = parseRuleSetFromYaml(
      'rules:\n  - id: PM\n    name: n\n    severity: minor\n    action: warn\n    check: { type: pattern_analysis, patterns: ["实施例"], minMatches: 2 }\n',
    )
    expect(issues.length).toBe(0)
    const rule = ruleSet.rules[0]
    expect(rule?.check.type).toBe('pattern_analysis')
    if (rule?.check.type === 'pattern_analysis') {
      expect(rule.check.patterns).toEqual(['实施例'])
      expect(rule.check.minMatches).toBe(2)
    }
  })

  it('pattern_analysis defaults minMatches to 1 through the loader', () => {
    const { ruleSet, issues } = parseRuleSetFromYaml(
      'rules:\n  - id: PM-DEF\n    name: n\n    severity: minor\n    action: warn\n    check: { type: pattern_analysis, patterns: ["实施例"] }\n',
    )
    expect(issues.length).toBe(0)
    const rule = ruleSet.rules[0]
    expect(rule?.check.type).toBe('pattern_analysis')
    if (rule?.check.type === 'pattern_analysis') {
      expect(rule.check.minMatches).toBe(1)
    }
  })

  it('pattern_analysis rejects non-array patterns', () => {
    const { issues } = parseRuleSetFromYaml(
      'rules:\n  - id: PN\n    name: n\n    severity: minor\n    action: warn\n    check: { type: pattern_analysis, patterns: "abc" }\n',
    )
    expect(issues.some(i => i.message.includes('需要非空 patterns'))).toBe(true)
  })

  it('structural_analysis rejects missing or empty requiresAll', () => {
    const { issues } = parseRuleSetFromYaml(
      'rules:\n  - id: SA\n    name: n\n    severity: minor\n    action: warn\n    check: { type: structural_analysis, requiresAll: [] }\n',
    )
    expect(issues.some(i => i.message.includes('需要非空 requiresAll'))).toBe(true)
  })

  it('structural_analysis rejects non-object and malformed requiresAll elements', () => {
    const nonObject = parseRuleSetFromYaml(
      'rules:\n  - id: S1\n    name: n\n    severity: minor\n    action: warn\n    check:\n      type: structural_analysis\n      requiresAll:\n        - just-a-string\n',
    )
    expect(nonObject.issues.some(i => i.message.includes('requiresAll 元素需要 element'))).toBe(true)
    const badElement = parseRuleSetFromYaml(
      'rules:\n  - id: S2\n    name: n\n    severity: minor\n    action: warn\n    check:\n      type: structural_analysis\n      requiresAll:\n        - element: 42\n          patterns: ["x"]\n',
    )
    expect(badElement.issues.some(i => i.message.includes('requiresAll 元素需要 element'))).toBe(true)
  })

  it('citation_analysis rejects missing statutes and bad statute definitions', () => {
    const missing = parseRuleSetFromYaml(
      'rules:\n  - id: CA1\n    name: n\n    severity: minor\n    action: warn\n    check: { type: citation_analysis }\n',
    )
    expect(missing.issues.some(i => i.message.includes('需要非空 statutes'))).toBe(true)
    const badDef = parseRuleSetFromYaml(
      'rules:\n  - id: CA2\n    name: n\n    severity: minor\n    action: warn\n    check:\n      type: citation_analysis\n      statutes:\n        专利法: { max: "78" }\n',
    )
    expect(badDef.issues.some(i => i.message.includes('max 必须是数字'))).toBe(true)
    const fromIndex = parseRuleSetFromYaml(
      'rules:\n  - id: CA3\n    name: n\n    severity: minor\n    action: warn\n    basisKind: statute\n    check:\n      type: citation_analysis\n      statutes:\n        专利法: {}\n',
    )
    expect(fromIndex.issues).toEqual([])
    expect(fromIndex.ruleSet.rules[0]?.basisKind).toBe('statute')
    expect(fromIndex.ruleSet.rules[0]?.check).toEqual({ type: 'citation_analysis', statutes: { 专利法: {} } })
    const explicitMax = parseRuleSetFromYaml(
      'rules:\n  - id: CA3B\n    name: n\n    severity: minor\n    action: warn\n    check:\n      type: citation_analysis\n      statutes:\n        专利法: { max: 82 }\n',
    )
    expect(explicitMax.issues).toEqual([])
    expect(explicitMax.ruleSet.rules[0]?.check).toEqual({ type: 'citation_analysis', statutes: { 专利法: { max: 82 } } })
    const badKind = parseRuleSetFromYaml(
      'rules:\n  - id: CA4\n    name: n\n    severity: minor\n    action: warn\n    basisKind: prose\n    check:\n      type: citation_analysis\n      statutes:\n        专利法: {}\n',
    )
    expect(badKind.issues.some(i => i.message.includes('basisKind'))).toBe(true)
    const numericKind = parseRuleSetFromYaml(
      'rules:\n  - id: CA5\n    name: n\n    severity: minor\n    action: warn\n    basisKind: 1\n    check:\n      type: citation_analysis\n      statutes:\n        专利法: {}\n',
    )
    expect(numericKind.ruleSet.rules).toEqual([])
    expect(numericKind.issues.some(i => i.message.includes('basisKind'))).toBe(true)
  })

  it('citation_analysis rejects a topics declaration instead of ignoring it', () => {
    const declared = parseRuleSetFromYaml(
      'rules:\n  - id: CT1\n    name: n\n    severity: minor\n    action: warn\n    check:\n      type: citation_analysis\n      statutes:\n        专利法:\n          max: 78\n          topics:\n            "2": [新颖性, 创造性]\n',
    )
    expect(declared.ruleSet.rules).toEqual([])
    expect(declared.issues.some(i =>
      i.ruleId === 'CT1' &&
      i.message.includes('法条 "专利法" 的 topics 不受支持') &&
      i.message.includes('删除该字段'),
    )).toBe(true)
    // 形状不合法同样整条拒绝：不存在的字段没有「合法形状」可守。
    const scalar = parseRuleSetFromYaml(
      'rules:\n  - id: CT2\n    name: n\n    severity: minor\n    action: warn\n    check:\n      type: citation_analysis\n      statutes:\n        专利法:\n          max: 78\n          topics: just-a-string\n',
    )
    expect(scalar.ruleSet.rules).toEqual([])
    expect(scalar.issues.some(i => i.message.includes('topics 不受支持'))).toBe(true)
  })

  it('synonym_match rejects malformed requirement entries', () => {
    const nonObject = parseRuleSetFromYaml(
      'rules:\n  - id: Y2\n    name: n\n    severity: minor\n    action: warn\n    check:\n      type: synonym_match\n      requirements:\n        - just-a-string\n',
    )
    expect(nonObject.issues.some(i => i.message.includes('requirements 元素需要 element'))).toBe(true)
    const badElement = parseRuleSetFromYaml(
      'rules:\n  - id: Y3\n    name: n\n    severity: minor\n    action: warn\n    check:\n      type: synonym_match\n      requirements:\n        - element: 42\n          keywords: ["x"]\n',
    )
    expect(badElement.issues.some(i => i.message.includes('requirements 元素需要 element'))).toBe(true)
  })

  it('synonym_match accepts requirements without minConfidence', () => {
    const { ruleSet, issues } = parseRuleSetFromYaml(
      'rules:\n  - id: YN\n    name: n\n    severity: minor\n    action: warn\n    check:\n      type: synonym_match\n      requirements:\n        - element: novelty\n          keywords: [新颖性]\n',
    )
    expect(issues.length).toBe(0)
    const rule = ruleSet.rules[0]
    expect(rule?.check.type).toBe('synonym_match')
    if (rule?.check.type === 'synonym_match') {
      expect(rule.check.requirements[0]?.element).toBe('novelty')
      expect(rule.check.minConfidence).toBe(1)
    }
  })

  it('map-form rule sets report a non-object entry and keep the valid rule', () => {
    const { ruleSet, issues } = parseRuleSetFromYaml(
      'rules:\n  good:\n    id: G1\n    name: n\n    severity: minor\n    action: warn\n    check: { type: keyword_blocklist, keywords: ["x"] }\n  bad: 42\n',
    )
    expect(ruleSet.rules.map(rule => rule.id)).toEqual(['G1'])
    expect(issues.some(issue => issue.message.includes('rules.bad: 条目必须是对象'))).toBe(true)
  })

  it('map-form rule sets skip invalid rules and keep valid ones', () => {
    const { ruleSet, issues } = parseRuleSetFromYaml(
      'rules:\n  good:\n    id: G1\n    name: n\n    severity: minor\n    action: warn\n    check: { type: keyword_blocklist, keywords: ["x"] }\n  bad:\n    id: B1\n    name: n\n    severity: minor\n    action: warn\n    check: { type: keyword_blocklist, keywords: 42 }\n',
    )
    expect(ruleSet.rules.length).toBe(1)
    expect(ruleSet.rules[0]?.id).toBe('G1')
    expect(issues.some(i => i.message.includes('非空关键词'))).toBe(true)
  })

  it('validateRuleSet reports duplicates without a source', () => {
    const set: RuleSet = {
      rules: [
        { id: 'D1', name: 'a', severity: 'major', action: 'warn', check: { type: 'keyword_blocklist', keywords: ['x'] } },
        { id: 'D1', name: 'b', severity: 'major', action: 'warn', check: { type: 'keyword_blocklist', keywords: ['y'] } },
      ],
    }
    const issues = validateRuleSet(set)
    expect(issues.some(i => i.message.includes('重复的规则 id'))).toBe(true)
    expect(issues[0]?.source).toBeUndefined()
  })

  it('applyRuleOverrides preserves the rule-set version when present', () => {
    const base = parseRuleSetFromYaml(
      'version: "2.0"\nrules:\n  - id: A1\n    name: a\n    severity: minor\n    action: warn\n    check: { type: keyword_blocklist, keywords: ["x"] }\n',
    ).ruleSet
    const merged = applyRuleOverrides(base, new Map([['A1', { action: 'log' }]]))
    expect(merged.version).toBe('2.0')
    expect(merged.rules[0]?.action).toBe('log')
  })

  it('applyRuleOverrides reports a patch that leaves negation words behind a closed switch', () => {
    const base = parseRuleSetFromYaml(
      'rules:\n  - id: A1\n    name: a\n    severity: minor\n    action: warn\n    check: { type: keyword_blocklist, keywords: ["x"], negationContext: true, additionalNegationWords: ["防"] }\n',
    ).ruleSet
    const issues: RuleSetValidationIssue[] = []
    const merged = applyRuleOverrides(base, new Map([['A1', { negationContext: false }]]), issues)
    // 补丁自身没追加任何词——判据取合并后的词表才能发现这条自相矛盾的声明。
    expect(issues.map(issue => issue.message)).toEqual([
      '激活覆盖 A1: 声明了 additionalNegationWords 但未开 negationContext: true，放行词不会生效',
    ])
    expect(merged.rules[0]?.check).toEqual({
      type: 'keyword_blocklist',
      keywords: ['x'],
      negationContext: false,
      additionalNegationWords: ['防'],
    })
  })

  it('applyRuleOverrides stays silent when a patch adds negation words with the switch on', () => {
    const base = parseRuleSetFromYaml(
      'rules:\n  - id: A1\n    name: a\n    severity: minor\n    action: warn\n    check: { type: keyword_blocklist, keywords: ["x"], negationContext: true }\n',
    ).ruleSet
    const issues: RuleSetValidationIssue[] = []
    applyRuleOverrides(base, new Map([['A1', { additionalNegationWords: ['防'] }]]), issues)
    expect(issues).toEqual([])
  })
})

describe('RuleLoader premise', () => {
  const ruleYaml = (premise: string): string =>
    `rules:\n  - id: A1\n    name: a\n    severity: minor\n    action: warn\n${premise}    check: { type: keyword_blocklist, keywords: ["x"] }\n`

  it('parses a premise list and keeps it on the rule', () => {
    const { ruleSet, issues } = parseRuleSetFromYaml(ruleYaml('    premise: ["创造性", "三步法"]\n'))
    expect(issues).toEqual([])
    expect(ruleSet.rules[0]?.premise).toEqual(['创造性', '三步法'])
  })

  it('omits the field when the premise is absent', () => {
    const { ruleSet } = parseRuleSetFromYaml(ruleYaml(''))
    expect(ruleSet.rules[0]?.premise).toBeUndefined()
  })

  it('reports a non-array premise and evaluates the rule always', () => {
    const { ruleSet, issues } = parseRuleSetFromYaml(ruleYaml('    premise: 创造性\n'))
    expect(issues.some(i => i.ruleId === 'A1' && i.message.includes('premise'))).toBe(true)
    expect(ruleSet.rules[0]?.premise).toBeUndefined()
  })

  it('reports a blank-only premise list instead of accepting a premise that can never match', () => {
    const { ruleSet, issues } = parseRuleSetFromYaml(ruleYaml('    premise: ["  "]\n'))
    expect(issues.some(i => i.ruleId === 'A1' && i.message.includes('适用前提正则'))).toBe(true)
    expect(ruleSet.rules[0]?.premise).toBeUndefined()
  })

  it('reports an invalid premise regex and evaluates the rule always', () => {
    const { ruleSet, issues } = parseRuleSetFromYaml(ruleYaml('    premise: ["(未闭合"]\n'))
    expect(issues.some(i => i.ruleId === 'A1' && i.message.includes('适用前提正则'))).toBe(true)
    expect(ruleSet.rules[0]?.premise).toBeUndefined()
  })

  it('applyRuleOverrides replaces the whole premise field', () => {
    const base = parseRuleSetFromYaml(ruleYaml('    premise: ["创造性"]\n')).ruleSet
    const issues: RuleSetValidationIssue[] = []
    const merged = applyRuleOverrides(base, new Map([['A1', { premise: ['新颖性', '22.2'] }]]), issues)
    expect(issues).toEqual([])
    expect(merged.rules[0]?.premise).toEqual(['新颖性', '22.2'])
  })

  it('applyRuleOverrides reports an empty premise patch instead of clearing the gate silently', () => {
    const base = parseRuleSetFromYaml(ruleYaml('    premise: ["创造性"]\n')).ruleSet
    const issues: RuleSetValidationIssue[] = []
    const merged = applyRuleOverrides(base, new Map([['A1', { premise: [] }]]), issues)
    expect(issues.some(i => i.ruleId === 'A1' && i.message.includes('premise'))).toBe(true)
    expect(merged.rules[0]?.premise).toEqual(['创造性'])
  })
})

describe('RuleLoader quote handling', () => {
  const keywordYaml = (extra: string): string =>
    `rules:\n  - id: A1\n    name: a\n    severity: minor\n    action: warn\n    check:\n      type: keyword_blocklist\n      keywords: ["一定"]\n${extra}`

  it('parses quoteImmune and leaves it off by default', () => {
    const off = parseRuleSetFromYaml(keywordYaml(''))
    expect(off.issues).toEqual([])
    expect(off.ruleSet.rules[0]?.check).toEqual({
      type: 'keyword_blocklist',
      keywords: ['一定'],
      negationContext: false,
    })
    const on = parseRuleSetFromYaml(keywordYaml('      quoteImmune: true\n'))
    expect(on.issues).toEqual([])
    expect(on.ruleSet.rules[0]?.check).toEqual({
      type: 'keyword_blocklist',
      keywords: ['一定'],
      negationContext: false,
      quoteImmune: true,
    })
  })

  it('reports a non-boolean quoteImmune and ignores the field', () => {
    const { ruleSet, issues } = parseRuleSetFromYaml(keywordYaml('      quoteImmune: "yes"\n'))
    expect(issues.some(i => i.ruleId === 'A1' && i.message.includes('quoteImmune'))).toBe(true)
    expect(ruleSet.rules[0]?.check).toEqual({
      type: 'keyword_blocklist',
      keywords: ['一定'],
      negationContext: false,
    })
  })

  it('parses quote_repetition, materializing the defaults at load time', () => {
    const { ruleSet, issues } = parseRuleSetFromYaml(
      'rules:\n  - id: A1\n    name: a\n    severity: minor\n    action: warn\n    check: { type: quote_repetition }\n',
    )
    expect(issues).toEqual([])
    expect(ruleSet.rules[0]?.check).toEqual({ type: 'quote_repetition', minLength: 12, minOccurrences: 2 })
  })

  it('rejects quote_repetition bounds that would never match', () => {
    const cases = ['minLength: 0', 'minLength: 1.5', 'minOccurrences: 1', 'minOccurrences: 2.5']
    for (const body of cases) {
      const { issues } = parseRuleSetFromYaml(
        `rules:\n  - id: A1\n    name: a\n    severity: minor\n    action: warn\n    check: { type: quote_repetition, ${body} }\n`,
      )
      expect(issues.some(i => i.ruleId === 'A1' && i.message.includes('quote_repetition'))).toBe(true)
    }
  })
})

describe('RuleLoader 空节与句重复', () => {
  const check = (body: string): string =>
    `rules:\n  - id: A1\n    name: a\n    severity: minor\n    action: warn\n    check: { ${body} }\n`

  it('parses empty_section with default minLevel and no placeholders field', () => {
    const { ruleSet, issues } = parseRuleSetFromYaml(check('type: empty_section'))
    expect(issues).toEqual([])
    expect(ruleSet.rules[0]?.check).toEqual({ type: 'empty_section', minLevel: 2 })
  })

  it('keeps an explicit placeholder list on empty_section', () => {
    const { ruleSet, issues } = parseRuleSetFromYaml(check('type: empty_section, minLevel: 3, placeholders: ["待补"]'))
    expect(issues).toEqual([])
    expect(ruleSet.rules[0]?.check).toEqual({
      type: 'empty_section',
      minLevel: 3,
      placeholders: ['待补'],
    })
  })

  it('rejects empty_section bounds and placeholder lists that could never match', () => {
    const cases = ['minLevel: 0', 'minLevel: 7', 'minLevel: 2.5', 'placeholders: []', 'placeholders: ["  "]']
    for (const body of cases) {
      const { issues } = parseRuleSetFromYaml(check(`type: empty_section, ${body}`))
      expect(issues.some(i => i.ruleId === 'A1' && i.message.includes('empty_section')), body).toBe(true)
    }
  })

  it('parses sentence_repetition with the documented defaults', () => {
    const { ruleSet, issues } = parseRuleSetFromYaml(check('type: sentence_repetition'))
    expect(issues).toEqual([])
    expect(ruleSet.rules[0]?.check).toEqual({ type: 'sentence_repetition', minLength: 12, minOccurrences: 3 })
  })

  it('rejects sentence_repetition bounds that would never match', () => {
    const cases = ['minLength: 0', 'minLength: 1.5', 'minOccurrences: 1', 'minOccurrences: 2.5']
    for (const body of cases) {
      const { issues } = parseRuleSetFromYaml(check(`type: sentence_repetition, ${body}`))
      expect(issues.some(i => i.ruleId === 'A1' && i.message.includes('sentence_repetition')), body).toBe(true)
    }
  })
})
