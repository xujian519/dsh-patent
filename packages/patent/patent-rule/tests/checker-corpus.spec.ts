import { expect, it } from 'vitest'
import { RuleEngine } from '@deepseek-ai/dsh-patent-core'
import {
  defaultPatentRules,
  infringementRules,
  inventivenessRules,
  noveltyRules,
  reasoningPatternRules,
  specRules,
} from '@deepseek-ai/dsh-patent-rule'

const engine = new RuleEngine()
engine.registerMany(defaultPatentRules())

// =============================================================================
// 新颖性规则（单独对比原则）
// =============================================================================

it('novelty: 违反单独对比原则（多份文件结合）→ 阻断', () => {
  const text = '结合多份对比文件结合，可认定本申请不具备新颖性。'
  const failures = engine.evaluate(text, { rules: noveltyRules() })
  const single = failures.find(f => f.ruleId === 'NOVELTY-SINGLE-COMPARISON')
  expect(single).toBeTruthy()
  expect(single!.level).toBe(0)
  expect(single!.message).toMatch(/单独对比原则/)
})

it('novelty: 规范文本（单独对比+特征覆盖）→ 通过', () => {
  const text =
    '新颖性分析：将权利要求1与对比文件D1进行单独对比。' +
    '逐项比对技术特征，权利要求1的所有技术特征均已被D1公开，故不具备新颖性。'
  const failures = engine.evaluate(text, { rules: noveltyRules() })
  expect(failures).toEqual([])
})

// =============================================================================
// 创造性三步法
// =============================================================================

it('inventiveness: 缺三步法步骤 → 阻断', () => {
  const text = '创造性分析：本领域技术人员有动机结合，故不具备创造性。'
  const failures = engine.evaluate(text, { rules: inventivenessRules() })
  const threeStep = failures.find(f => f.ruleId === 'INVENTIVENESS-THREE-STEP')
  expect(threeStep).toBeTruthy()
  expect(threeStep!.level).toBe(0)
  expect(threeStep!.message).toMatch(/三步法/)
})

it('inventiveness: 三步法齐全 → 通过', () => {
  const text =
    '创造性分析（三步法）：首先确定最接近的现有技术为D1；' +
    '其次，权利要求1相对于D1的区别技术特征为X，本发明实际解决的技术问题是把装配偏差从0.5mm降到0.1mm；' +
    '最后，D2给出了将X应用于D1的技术启示，故不具备创造性。'
  const failures = engine.evaluate(text, { rules: inventivenessRules() })
  expect(failures).toEqual([])
})

// =============================================================================
// 侵权规则（全面覆盖）
// =============================================================================

it('infringement: 缺全面覆盖分析 → 阻断', () => {
  const text = '侵权分析：被控方案的技术特征与权利要求基本相同。'
  const failures = engine.evaluate(text, { rules: infringementRules() })
  const coverage = failures.find(f => f.ruleId === 'INFRINGEMENT-FULL-COVERAGE')
  expect(coverage).toBeTruthy()
  expect(coverage!.level).toBe(0)
})

it('infringement: 全面覆盖+等同+禁止反悔 → 通过', () => {
  const text =
    '侵权分析：将被控方案与权利要求1的技术特征逐一比对（全面覆盖原则），' +
    '特征A构成等同替换；同时审查审查过程修改，不存在禁止反悔情形，亦不适用捐献规则。'
  const failures = engine.evaluate(text, { rules: infringementRules() })
  expect(failures).toEqual([])
})

// =============================================================================
// 推理模式规则（18 模式 × CheckRules = 24 条，PathElements 路径完整性）
// =============================================================================

it('reasoningPatternRules: 24 条且并入 defaultPatentRules', () => {
  expect(reasoningPatternRules().length).toBe(24)
  const all = defaultPatentRules()
  expect(all.some(r => r.id === 'REASON-CREATIVITY-01A')).toBeTruthy()
  expect(all.some(r => r.id === 'REASON-NOVELTY-01A')).toBeTruthy()
  expect(all.some(r => r.id === 'REASON-OTHER-04')).toBeTruthy()
})

it('推理模式: 公知常识路径完整 → 通过', () => {
  const local = new RuleEngine()
  local.registerMany(reasoningPatternRules())
  const text =
    '最接近的现有技术为D1，区别技术特征在于X，该区别特征属于本领域的公知常识/惯用技术手段，' +
    '本领域技术人员无需创造性劳动即可获得（显而易见），故不具备创造性。'
  const failures = local.evaluate(text, { domain: 'patent_inventiveness' })
  expect(!failures.some(f => f.ruleId === 'REASON-CREATIVITY-01A')).toBeTruthy()
})

it('推理模式: 公知常识路径缺步骤 → 阻断并指出缺失步骤', () => {
  const local = new RuleEngine()
  local.registerMany(reasoningPatternRules())
  const text = '最接近的现有技术为D1，区别技术特征在于X，故不具备创造性。'
  const failures = local.evaluate(text, { domain: 'patent_inventiveness' })
  const r = failures.find(f => f.ruleId === 'REASON-CREATIVITY-01A')
  expect(r).toBeTruthy()
  expect(r!.level).toBe(0)
  expect(r!.message).toMatch(/推理路径步骤3不完整/)
})

it('推理模式: 多对比文件路径成立时不报互斥的公知常识路径', () => {
  const local = new RuleEngine()
  local.registerMany(reasoningPatternRules())
  const text =
    '创造性分析：最接近的现有技术为D1；权利要求1相对于D1的区别技术特征为X；' +
    'D2给出了将X应用于D1的技术启示；本领域技术人员认为该结合显而易见，故不具备创造性。'
  const failures = local.evaluate(text, { domain: 'patent_inventiveness' })
  expect(failures.some(f => f.ruleId === 'REASON-CREATIVITY-01A')).toBe(false)
  expect(failures.some(f => f.ruleId === 'REASON-CREATIVITY-02')).toBe(false)
})

it('推理模式: 公知常识路径成立时不报互斥的多对比文件路径', () => {
  const local = new RuleEngine()
  local.registerMany(reasoningPatternRules())
  const text =
    '创造性分析：最接近的现有技术为D1；区别技术特征为X；该区别特征属于本领域公知常识；' +
    '本领域技术人员无需创造性劳动即可获得，显而易见。'
  const failures = local.evaluate(text, { domain: 'patent_inventiveness' })
  expect(failures.some(f => f.ruleId === 'REASON-CREATIVITY-01A')).toBe(false)
  expect(failures.some(f => f.ruleId === 'REASON-CREATIVITY-02')).toBe(false)
})

it('推理模式: 互斥路径都不成立时两条都报', () => {
  const local = new RuleEngine()
  local.registerMany(reasoningPatternRules())
  const text = '最接近的现有技术为D1，区别技术特征在于X，故不具备创造性。'
  const failures = local.evaluate(text, { domain: 'patent_inventiveness' })
  expect(failures.some(f => f.ruleId === 'REASON-CREATIVITY-01A')).toBe(true)
  expect(failures.some(f => f.ruleId === 'REASON-CREATIVITY-02')).toBe(true)
})

it('推理模式: 四相同标准路径（单独对比）→ 通过', () => {
  const local = new RuleEngine()
  local.registerMany(reasoningPatternRules())
  const text =
    '新颖性分析：现有技术D1，采用单独对比原则一一对比。技术领域相同、技术问题相同、' +
    '技术方案相同、技术效果相同，故不具备新颖性。'
  const failures = local.evaluate(text, { domain: 'patent_novelty' })
  expect(!failures.some(f => f.ruleId === 'REASON-NOVELTY-01A')).toBeTruthy()
})

it('推理模式: 四相同标准缺步骤 → 阻断', () => {
  const local = new RuleEngine()
  local.registerMany(reasoningPatternRules())
  const failures = local.evaluate('该申请具备新颖性。', { domain: 'patent_novelty' })
  const r = failures.find(f => f.ruleId === 'REASON-NOVELTY-01A')
  expect(r).toBeTruthy()
  expect(r!.level).toBe(0)
})

it('reasoningPatternRules: 4 组条数 = 7/6/5/6 且 id 唯一', () => {
  const rs = reasoningPatternRules()
  const byGroup = (prefix: string) => rs.filter(r => r.id.startsWith(prefix)).length
  expect(byGroup('REASON-CREATIVITY-')).toBe(7)
  expect(byGroup('REASON-NOVELTY-')).toBe(6)
  expect(byGroup('REASON-CLAIMS-')).toBe(5)
  expect(byGroup('REASON-OTHER-')).toBe(6)
  expect(new Set(rs.map(r => r.id)).size).toBe(rs.length)
})

it('推理模式: pathElements 为 string[][] 层级（每步至少命中其一）', () => {
  const rs = reasoningPatternRules()
  const sample = rs.find(r => r.id === 'REASON-CREATIVITY-01A')
  expect(sample).toBeTruthy()
  const steps = sample!.pathElements
  expect(Array.isArray(steps)).toBeTruthy()
  if (!steps) return
  for (const step of steps) {
    expect(Array.isArray(step) && step.length >= 1).toBeTruthy()
  }
  // 抽样其余三组各一条规则，校验嵌套层级
  for (const id of ['REASON-NOVELTY-01A', 'REASON-CLAIMS-01', 'REASON-OTHER-04']) {
    const rule = rs.find(r => r.id === id)
    expect(rule).toBeTruthy()
    if (rule!.pathElements) {
      expect(rule!.pathElements.every(s => Array.isArray(s))).toBeTruthy()
    }
  }
})

// =============================================================================
// 说明书域规则（patent_spec，spec-checklist 规则化）
// =============================================================================

it('spec: specRules 共 8 条并并入 defaultPatentRules', () => {
  expect(specRules().length).toBe(8)
  const sections = specRules().find(rule => rule.id === 'SPEC-SECTIONS')
  expect(sections?.fixSuggestion).toContain('技术领域')
  expect(sections?.fixSuggestion).not.toContain('七部分')
  const all = defaultPatentRules()
  expect(all.some(r => r.id === 'SPEC-SECTIONS')).toBeTruthy()
  expect(all.some(r => r.id === 'SPEC-COMMERCIAL-BAN')).toBeTruthy()
  expect(all.some(r => r.id === 'SPEC-SCOPE-COMPLIANCE')).toBeTruthy()
})

it('spec: 说明书缺少章节 → 阻断', () => {
  const local = new RuleEngine()
  local.registerMany(specRules())
  const failures = local.evaluate('# 技术领域\n本发明涉及机械技术领域。', { domain: 'patent_spec' })
  const sections = failures.find(f => f.ruleId === 'SPEC-SECTIONS')
  expect(sections).toBeTruthy()
  expect(sections!.level).toBe(1)
})

it('spec: 五部分齐全 + 三段式 + 实施例 + 摘要关键词 → 通过', () => {
  const local = new RuleEngine()
  local.registerMany(specRules())
  const text = [
    '# 技术领域',
    '本发明涉及机械技术领域。',
    '# 背景技术',
    '现有技术存在效率低下的问题。',
    '# 发明内容',
    '本发明要解决的技术问题是提高分拣效率。本发明提供如下技术方案：包括壳体与驱动单元。本发明的有益效果是效率提升30%。',
    '# 附图说明',
    '图1为本发明实施例的整体结构示意图。附图标记：1-壳体；2-驱动单元。',
    '# 具体实施方式',
    '实施例1：驱动单元采用伺服电机，转速为1000rpm。',
    '# 摘要',
    '本发明公开了一种分拣装置。关键词：分拣；驱动。',
  ].join('\n')
  const failures = local.evaluate(text, { domain: 'patent_spec' })
  expect(failures).toEqual([])
})

it('spec: 商业宣传禁语 → 阻断', () => {
  const local = new RuleEngine()
  local.registerMany(specRules())
  const failures = local.evaluate('本方案行业领先，效率突出。', { domain: 'patent_spec' })
  const ban = failures.find(f => f.ruleId === 'SPEC-COMMERCIAL-BAN')
  expect(ban).toBeTruthy()
  expect(ban!.message).toMatch(/行业领先/)
})

it('spec: 超范围表述 → 阻断', () => {
  const local = new RuleEngine()
  local.registerMany(specRules())
  const failures = local.evaluate('该特征超出原申请记载范围，需补充说明。', { domain: 'patent_spec' })
  expect(failures.some(f => f.ruleId === 'SPEC-SCOPE-COMPLIANCE')).toBeTruthy()
})

it('spec: 否定语境（未超出原申请）不误报超范围', () => {
  const local = new RuleEngine()
  local.registerMany(specRules())
  const failures = local.evaluate('说明书内容未超出原申请记载范围，符合专利法第33条。', {
    domain: 'patent_spec',
  })
  expect(!failures.some(f => f.ruleId === 'SPEC-SCOPE-COMPLIANCE')).toBeTruthy()
})

it('spec: 无摘要说明书不被 SPEC-SECTIONS 阻断（摘要为 Quality 级检查）', () => {
  const local = new RuleEngine()
  local.registerMany(specRules())
  const text = [
    '# 技术领域',
    '本发明涉及机械技术领域。',
    '# 背景技术',
    '现有技术存在效率低下的问题。',
    '# 发明内容',
    '本发明要解决的技术问题是提高效率。本发明提供如下技术方案：包括驱动单元。本发明的有益效果是效率提升30%。',
    '# 附图说明',
    '图1为本发明实施例的整体结构示意图。附图标记：1-驱动单元。',
    '# 具体实施方式',
    '实施例1：驱动单元采用伺服电机。',
  ].join('\n')
  const failures = local.evaluate(text, { domain: 'patent_spec' })
  expect(!failures.some(f => f.ruleId === 'SPEC-SECTIONS')).toBeTruthy()
  // 摘要缺失只触发 Quality 级 SPEC-ABSTRACT（不阻断）
  expect(failures.some(f => f.ruleId === 'SPEC-ABSTRACT')).toBeTruthy()
})

it('spec: 双重否定（不仅超出）不误判为否定语境', () => {
  const local = new RuleEngine()
  local.registerMany(specRules())
  const failures = local.evaluate('该修改不仅超出原申请记载范围，且引入新内容。', { domain: 'patent_spec' })
  expect(failures.some(f => f.ruleId === 'SPEC-SCOPE-COMPLIANCE')).toBeTruthy()
})

// =============================================================================
// 规则总数与禁语扩充（防止注释失真/禁语漏网）
// =============================================================================

it('defaultPatentRules: 总条数 = 71（场景规则 47 + 推理模式 24）', () => {
  const all = defaultPatentRules()
  expect(all.length).toBe(71)
  // 每 3 条规则中约 1 条 Quality 级（粗粒度结构校验：各级别均非空）
  expect(all.some(r => r.level === 0)).toBeTruthy()
  expect(all.some(r => r.level === 1)).toBeTruthy()
  expect(all.some(r => r.level === 2)).toBeTruthy()
  // 规则 id 唯一（注册表按 id 覆盖，重复 id 会静默丢规则）
  const ids = new Set(all.map(r => r.id))
  expect(ids.size).toBe(all.length)
})

it('novelty: 单独对比禁语扩充（对比文件1和2结合）→ 阻断', () => {
  // 扩充前 "对比文件1和2结合" 不在禁语表，可绕过 NOVELTY-SINGLE-COMPARISON
  const text = '将对比文件1和2结合，可认定本申请不具备新颖性。'
  const failures = engine.evaluate(text, { rules: noveltyRules() })
  const single = failures.find(f => f.ruleId === 'NOVELTY-SINGLE-COMPARISON')
  expect(single).toBeTruthy()
  expect(single!.message).toMatch(/单独对比原则/)
})
