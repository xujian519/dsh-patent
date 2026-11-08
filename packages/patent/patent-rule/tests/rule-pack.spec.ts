import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'
import {
  assetRulesRoot,
  candidatePackDirs,
  evaluateText,
  loadRulePack,
  loadRuleSetDir,
  mergeRuleSets,
  parseRulePackManifest,
  resolvePackDir,
  resolveRulePackManifestPath,
  summarizeRulePackLayers,
  validatePackManifest,
} from '@deepseek-ai/dsh-patent-rule'

/** 在临时目录搭一个三层 fixture：base + domain + overrides + 项目清单。 */
function makePackFixture(): { manifestPath: string; base: string; domain: string } {
  const root = mkdtempSync(join(tmpdir(), 'sati-rule-pack-'))
  const base = join(root, 'base-pack')
  const domain = join(root, 'mech-pack')
  const local = join(root, 'local-rules')
  mkdirSync(base)
  mkdirSync(domain)
  mkdirSync(local)

  writeFileSync(
    join(base, 'pack.yaml'),
    ['id: sati-rules-test-base', 'version: 0.1.0', 'description: 测试基础包'].join('\n'),
  )
  writeFileSync(
    join(base, 'rules.yaml'),
    [
      'version: "1.0"',
      'rules:',
      '  shared_rule:',
      '    id: RULE-SHARED',
      '    name: 共享规则',
      '    severity: minor',
      '    action: warn',
      '    check:',
      '      type: keyword_blocklist',
      '      keywords:',
      '        - BASEWORD',
      '  base_only:',
      '    id: BASE-ONLY',
      '    name: 基础独有',
      '    severity: minor',
      '    action: warn',
      '    check:',
      '      type: keyword_blocklist',
      '      keywords:',
      '        - BASEONLY',
    ].join('\n'),
  )

  writeFileSync(
    join(domain, 'pack.yaml'),
    ['id: sati-rules-test-domain-mech', 'version: 0.1.0', 'domain: mechanical', 'description: 测试领域包'].join('\n'),
  )
  writeFileSync(
    join(domain, 'rules.yaml'),
    [
      'version: "1.0"',
      'rules:',
      '  shared_rule_override:',
      '    id: RULE-SHARED',
      '    name: 共享规则（领域覆盖版）',
      '    severity: minor',
      '    action: warn',
      '    check:',
      '      type: keyword_blocklist',
      '      keywords:',
      '        - DOMAINWORD',
      '  domain_only:',
      '    id: DOMAIN-ONLY',
      '    name: 领域独有',
      '    severity: minor',
      '    action: warn',
      '    check:',
      '      type: keyword_blocklist',
      '      keywords:',
      '        - DOMAINONLY',
    ].join('\n'),
  )

  // overrides 无 pack.yaml（项目私有层不强制清单）
  writeFileSync(
    join(local, 'rules.yaml'),
    [
      'version: "1.0"',
      'rules:',
      '  local_only:',
      '    id: LOCAL-ONLY',
      '    name: 项目私有',
      '    severity: minor',
      '    action: warn',
      '    check:',
      '      type: keyword_blocklist',
      '      keywords:',
      '        - LOCALWORD',
    ].join('\n'),
  )

  mkdirSync(join(root, '.sati'))
  const manifestPath = join(root, '.sati', 'rules.yaml')
  writeFileSync(manifestPath, [`base: ${base}`, 'domains:', `  - ${domain}`, 'overrides: ../local-rules'].join('\n'))
  return { manifestPath, base, domain }
}

describe('rule pack', () => {
  it('loadRulePack without manifest falls back to packaged rules/base', () => {
    const result = loadRulePack()
    expect(result.manifestPath).toBeNull()
    expect(result.manifestMtimeMs).toBeNull()
    const ids = result.ruleSet.rules.map(r => r.id)
    expect(ids).toContain('INV-METHOD-001')
    expect(ids).toContain('INV-EVIDENCE-001')
    expect(ids).toContain('PAT-RISK-001')
    expect(ids).toContain('BASE-CITE-001')
    for (const id of ids) expect(result.layers.get(id)).toBe('base')
    expect(result.sources.length).toBeGreaterThanOrEqual(3)
  })

  it('loadRulePack merges base → domains → overrides with id override audit', () => {
    const { manifestPath } = makePackFixture()
    const result = loadRulePack({ manifestPath })
    const ids = result.ruleSet.rules.map(r => r.id).sort()
    expect(ids).toEqual(['BASE-ONLY', 'DOMAIN-ONLY', 'LOCAL-ONLY', 'RULE-SHARED'])
    expect(result.manifestPath).toBe(manifestPath)
    expect(typeof result.manifestMtimeMs).toBe('number')
    expect(result.warnings.some(w => /RULE-SHARED 被 domain:.+ 层覆盖（原: base）/.test(w))).toBe(true)
    expect(evaluateText('出现 DOMAINWORD。', result.ruleSet).violations.length).toBe(1)
    expect(evaluateText('出现 BASEWORD。', result.ruleSet).violations.length).toBe(0)
    const summary = summarizeRulePackLayers(result.layers)
    expect(summary).toMatch(/domain:.+ 2/)
    expect(summary).toMatch(/base 1/)
    expect(summary).toMatch(/overrides 1/)
  })

  it('loadRulePack warns when two files in one layer define the same rule id', () => {
    const root = mkdtempSync(join(tmpdir(), 'sati-rule-pack-same-layer-'))
    const base = join(root, 'base-pack')
    mkdirSync(base)
    const ruleFile = (name: string, word: string) => [
      'version: "1.0"',
      'rules:',
      `  ${name}:`,
      '    id: LAYER-DUP',
      `    name: ${name}`,
      '    severity: minor',
      '    action: warn',
      '    check:',
      '      type: keyword_blocklist',
      '      keywords:',
      `        - ${word}`,
    ].join('\n')
    writeFileSync(join(base, 'a.yaml'), ruleFile('先加载', 'FIRSTWORD'))
    writeFileSync(join(base, 'b.yaml'), ruleFile('后加载', 'SECONDWORD'))
    const manifestPath = join(root, 'rules.yaml')
    writeFileSync(manifestPath, [`base: ${base}`, 'domains: []'].join('\n'))

    const result = loadRulePack({ manifestPath })

    // 后加载的文件整条覆盖，前一份的判定词不留任何痕迹——只有告警能让人知道。
    expect(result.ruleSet.rules.map(r => r.id)).toEqual(['LAYER-DUP'])
    expect(evaluateText('出现 FIRSTWORD。', result.ruleSet).violations).toHaveLength(0)
    expect(result.warnings.some(w => w.includes('规则包 base 层内') && w.includes('LAYER-DUP'))).toBe(true)
  })

  it('loadRulePack warns when an explicit manifest path does not exist', () => {
    const result = loadRulePack({ manifestPath: join(tmpdir(), 'dsh-no-such-manifest.yml') })
    expect(result.manifestPath).toBeNull()
    expect(result.warnings.some(w => w.includes('清单不存在') && w.includes('回退仅加载 base 包'))).toBe(true)
  })

  it('loadRulePack skips missing domain layer with warning', () => {
    const root = mkdtempSync(join(tmpdir(), 'sati-rule-pack-missing-'))
    const base = join(root, 'base-pack')
    mkdirSync(base)
    writeFileSync(join(base, 'pack.yaml'), ['id: sati-rules-test-base', 'version: 0.1.0', 'description: 测试基础包'].join('\n'))
    writeFileSync(
      join(base, 'rules.yaml'),
      [
        'version: "1.0"',
        'rules:',
        '  base_only:',
        '    id: BASE-ONLY',
        '    name: 基础独有',
        '    severity: minor',
        '    action: warn',
        '    check:',
        '      type: keyword_blocklist',
        '      keywords:',
        '        - BASEONLY',
      ].join('\n'),
    )
    const manifestPath = join(root, 'rules.yaml')
    writeFileSync(manifestPath, [`base: ${base}`, 'domains:', `  - ${join(root, 'not-exist')}`].join('\n'))
    const result = loadRulePack({ manifestPath })
    expect(result.warnings.some(w => w.includes('规则目录不存在'))).toBe(true)
    expect(result.ruleSet.rules.length).toBe(1)
  })

  it('parseRulePackManifest parses valid manifest and rejects malformed ones', () => {
    const manifest = parseRulePackManifest('base: base\ndomains: [mechanical, medical]\noverrides: ./local\n')
    expect(manifest).toEqual({ base: 'base', domains: ['mechanical', 'medical'], overrides: './local' })
    expect(parseRulePackManifest('base: base').domains).toEqual([])
    expect(() => parseRulePackManifest('domains: [mechanical]')).toThrow(/base/)
    expect(() => parseRulePackManifest('base: base\ndomains: mechanical')).toThrow(/字符串数组/)
    expect(() => parseRulePackManifest('base: [unclosed')).toThrow(/YAML/)
  })

  it('bundled rules/base and rules/domains/* load via loadRuleSetDir with zero issues', () => {
    const root = assetRulesRoot()
    const dirs = [
      join(root, 'base'),
      join(root, 'domains', 'mechanical'),
      join(root, 'domains', 'medical'),
      join(root, 'domains', 'chemical'),
      join(root, 'domains', 'software'),
    ]
    let totalRules = 0
    for (const dir of dirs) {
      const { ruleSets, warnings } = loadRuleSetDir(dir)
      expect(warnings).toEqual([])
      totalRules += ruleSets.reduce((n, rs) => n + rs.rules.length, 0)
    }
    expect(totalRules).toBeGreaterThanOrEqual(6)
  })

  it('validatePackManifest accepts bundled pack manifests and rejects invalid ones', () => {
    const root = assetRulesRoot()
    const parse = (p: string): unknown => parseDocument(readFileSync(p, 'utf8')).toJS()
    expect(validatePackManifest(parse(join(root, 'base', 'pack.yaml')))).toEqual([])
    expect(validatePackManifest(parse(join(root, 'domains', 'mechanical', 'pack.yaml')), { requireDomain: true })).toEqual([])
    expect(validatePackManifest(parse(join(root, 'domains', 'medical', 'pack.yaml')), { requireDomain: true })).toEqual([])
    const issues = validatePackManifest(parse(join(root, 'base', 'pack.yaml')), { requireDomain: true })
    expect(issues.some(i => i.field === 'domain')).toBe(true)
    const bad = validatePackManifest({ id: 'wrong-id', version: '1.0', description: '' })
    expect(bad.some(i => i.field === 'id')).toBe(true)
    expect(bad.some(i => i.field === 'version')).toBe(true)
    expect(bad.some(i => i.field === 'description')).toBe(true)
    expect(validatePackManifest({ id: 'sati-rules-x', version: '0.1.0', description: 'ok', extra: 1 }).some(i => i.field === 'extra')).toBe(true)
  })

  it('evaluateText domain option skips foreign-domain rules but keeps universal ones', () => {
    const root = assetRulesRoot()
    const mech = loadRuleSetDir(join(root, 'domains', 'mechanical')).ruleSets
    const medical = loadRuleSetDir(join(root, 'domains', 'medical')).ruleSets
    const ruleSet = mergeRuleSets([...mech, ...medical])
    const text = '该区别特征在于治疗用途，据此认定具备创造性。'
    const unfiltered = evaluateText(text, ruleSet)
    expect(unfiltered.violations.some(v => v.ruleId === 'MED-INV-001')).toBe(true)
    const mechanical = evaluateText(text, ruleSet, undefined, { domain: 'mechanical' })
    expect(mechanical.violations.some(v => v.ruleId === 'MED-INV-001')).toBe(false)
    const medicalScoped = evaluateText(text, ruleSet, undefined, { domain: 'medical' })
    expect(medicalScoped.violations.some(v => v.ruleId === 'MED-INV-001')).toBe(true)
  })

  it('MECH-INV-001 只在等效性论证语境（premise）下评估', () => {
    const mech = loadRuleSetDir(join(assetRulesRoot(), 'domains', 'mechanical')).ruleSets
    const ruleSet = mergeRuleSets(mech)
    const hit = (text: string): boolean =>
      evaluateText(text, ruleSet).violations.some(v => v.ruleId === 'MECH-INV-001')
    // 不含等效/等同的文本根本不评估：此前无 premise，任意说明书都会命中 0/3。
    expect(hit('所述壳体设置在底座上，起到支撑作用。')).toBe(false)
    // 语境锚点在，但只给了对应结构、没给作用或技术效果 → 论证不完整。
    expect(hit('对比文件1的压板与本申请的结构等效。')).toBe(true)
    // 锚点 + 两要素齐备 → 通过。
    expect(hit('对比文件1的压板与本申请的结构等效，二者均通过弹性变形产生密封作用，效果相同。')).toBe(false)
  })

  it('SOFT-INV-001 只在客体论证语境（premise）下评估', () => {
    const soft = loadRuleSetDir(join(assetRulesRoot(), 'domains', 'software')).ruleSets
    const ruleSet = mergeRuleSets(soft)
    const hit = (text: string): boolean =>
      evaluateText(text, ruleSet).violations.some(v => v.ruleId === 'SOFT-INV-001')
    // 不讨论客体的文本根本不评估。
    expect(hit('所述壳体设置在底座上，起到支撑作用。')).toBe(false)
    // 锚点在，但只写了技术问题与技术手段，未写技术效果 → 三要素不完整。
    expect(hit('本方案不属于智力活动规则，技术问题为识别准确率低，技术手段为神经网络。')).toBe(true)
    // 三要素齐备 → 通过。
    expect(hit('本方案不属于智力活动规则：技术问题为识别准确率低，技术手段为卷积神经网络，技术效果为准确率提升 3%。')).toBe(false)
  })

  it('CHEM-INV-001 只在马库什论证语境（premise）下评估', () => {
    const chemical = loadRuleSetDir(join(assetRulesRoot(), 'domains', 'chemical')).ruleSets
    const ruleSet = mergeRuleSets(chemical)
    const hit = (text: string): boolean =>
      evaluateText(text, ruleSet).violations.some(v => v.ruleId === 'CHEM-INV-001')
    // 不讨论马库什/通式/共同结构的文本根本不评估。
    expect(hit('所述壳体设置在底座上，起到支撑作用。')).toBe(false)
    // 锚点在，但既没写共同结构的区别，也没写取代基变化的效果 → 论证不完整。
    expect(hit('本申请的通式化合物具备创造性。')).toBe(true)
    // 共同结构的区别与取代基变化的效果齐备 → 通过。
    expect(hit('本申请的通式化合物与对比文件的共同结构存在区别技术特征，取代基变化带来活性提升的技术效果。')).toBe(false)
  })

  it('CHEM-DIS-001 只在保藏语境（premise）下评估，四要素齐备才通过', () => {
    const chemical = loadRuleSetDir(join(assetRulesRoot(), 'domains', 'chemical')).ruleSets
    const ruleSet = mergeRuleSets(chemical)
    const hit = (text: string): boolean =>
      evaluateText(text, ruleSet).violations.some(v => v.ruleId === 'CHEM-DIS-001')
    // 没有保藏字样或保藏机构编号的文本不评估。
    expect(hit('本发明涉及一种化合物及其制备方法。')).toBe(false)
    // 只在正文提「已保藏」并给编号，缺保藏单位、日期与分类命名 → 命中。
    expect(hit('菌株已保藏，保藏编号为 CCTCC NO: C2024123。')).toBe(true)
    // 四要素齐备 → 通过。
    expect(hit('菌株保藏于中国典型培养物保藏中心，保藏日期 2024-01-01，保藏编号 CCTCC NO: C2024123，分类命名为 Escherichia coli。')).toBe(false)
  })

  it('candidatePackDirs and resolvePackDir resolution semantics', () => {
    const root = assetRulesRoot()
    expect(candidatePackDirs('base')).toEqual([join(root, 'base'), join(root, 'domains', 'base')])
    const fixture = mkdtempSync(join(tmpdir(), 'sati-rule-pack-abs-'))
    expect(resolvePackDir(fixture)).toBe(fixture)
    expect(resolvePackDir(join(tmpdir(), 'definitely-not-exist-xyz'))).toBeNull()
    expect(resolvePackDir('base')).toBe(join(root, 'base'))
    expect(resolvePackDir('nonexistent-pack-xyz')).toBeNull()
  })

  it('loadRulePack result is consumable by evaluateText end-to-end', () => {
    const { ruleSet, layers } = loadRulePack()
    const found = evaluateText('该区别特征容易想到，故不具备创造性。', ruleSet)
    expect(found.violations.some(v => v.ruleId === 'INV-EVIDENCE-001' && v.action === 'review')).toBe(true)
    const negated = evaluateText('该特征不属于容易想到的情形。', ruleSet)
    expect(negated.violations.some(v => v.ruleId === 'INV-EVIDENCE-001')).toBe(false)
    expect(summarizeRulePackLayers(layers)).toMatch(/^base \d+$/)
  })

  it('every bundled pack dir ships a pack.yaml manifest', () => {
    const root = assetRulesRoot()
    for (const dir of readdirSync(join(root, 'domains'))) {
      const manifest = join(root, 'domains', dir, 'pack.yaml')
      expect(() => readFileSync(manifest, 'utf8')).not.toThrow()
    }
    expect(() => readFileSync(join(root, 'base', 'pack.yaml'), 'utf8')).not.toThrow()
  })

  it('resolveRulePackManifestPath returns null for an explicit missing path', () => {
    expect(resolveRulePackManifestPath(join(tmpdir(), 'no-manifest-xyz.yaml'))).toBeNull()
    expect(resolveRulePackManifestPath()).toBeNull()
  })

  it('parseRulePackManifest rejects a non-object document', () => {
    expect(() => parseRulePackManifest('- a\n- b')).toThrow(/顶层必须是对象/)
    expect(() => parseRulePackManifest('42')).toThrow(/顶层必须是对象/)
  })

  it('validatePackManifest rejects non-object raw values and bad domain fields', () => {
    expect(validatePackManifest('oops').some(i => i.field === '(root)')).toBe(true)
    expect(validatePackManifest(['id']).some(i => i.field === '(root)')).toBe(true)
    const badDomain = validatePackManifest({ id: 'sati-rules-x', version: '0.1.0', description: 'ok', domain: 42 })
    expect(badDomain.some(i => i.field === 'domain')).toBe(true)
  })

  it('loadRulePack warns on a missing builtin pack, a broken manifest, and a missing builtin domain', () => {
    const root = mkdtempSync(join(tmpdir(), 'sati-rule-pack-missing-base-'))
    const manifestPath = join(root, 'rules.yaml')

    writeFileSync(manifestPath, 'base: definitely-missing-pack\n', 'utf8')
    const missingBase = loadRulePack({ manifestPath })
    expect(missingBase.warnings.some(w => w.includes('规则包 base 未找到'))).toBe(true)
    expect(missingBase.ruleSet.rules.length).toBe(0)

    writeFileSync(manifestPath, 'base: [unclosed\n', 'utf8')
    const broken = loadRulePack({ manifestPath })
    expect(broken.warnings.some(w => w.includes('规则包清单加载失败'))).toBe(true)
    expect(broken.ruleSet.rules.length).toBeGreaterThan(0)

    writeFileSync(manifestPath, 'base: base\ndomains:\n  - missing-domain-pack\n', 'utf8')
    const missingDomain = loadRulePack({ manifestPath })
    expect(missingDomain.warnings.some(w => w.includes('规则包 domain:missing-domain-pack 未找到'))).toBe(true)
    expect(missingDomain.ruleSet.rules.length).toBeGreaterThan(0)
  })

  it('loadRulePack warns on unparsable, invalid, or unreadable pack.yaml manifests', () => {
    const root = mkdtempSync(join(tmpdir(), 'sati-rule-pack-bad-manifest-'))
    const base = join(root, 'base-pack')
    mkdirSync(base)
    writeFileSync(
      join(base, 'rules.yaml'),
      'rules:\n  - id: B1\n    name: b\n    severity: minor\n    action: warn\n    check: { type: keyword_blocklist, keywords: ["x"] }\n',
      'utf8',
    )
    const manifestPath = join(root, 'rules.yaml')
    writeFileSync(manifestPath, `base: ${base}\n`, 'utf8')

    writeFileSync(join(base, 'pack.yaml'), 'pack: [', 'utf8')
    const unparsable = loadRulePack({ manifestPath })
    expect(unparsable.warnings.some(w => w.includes('清单解析失败'))).toBe(true)
    expect(unparsable.ruleSet.rules.length).toBe(1)

    writeFileSync(join(base, 'pack.yaml'), 'id: wrong\n', 'utf8')
    const invalid = loadRulePack({ manifestPath })
    expect(invalid.warnings.some(w => w.includes('清单非法'))).toBe(true)

    rmSync(join(base, 'pack.yaml'))
    mkdirSync(join(base, 'pack.yaml'))
    try {
      const unreadable = loadRulePack({ manifestPath })
      expect(unreadable.warnings.some(w => w.includes('清单读取失败'))).toBe(true)
      expect(unreadable.ruleSet.rules.length).toBe(1)
    } finally {
      rmSync(join(base, 'pack.yaml'), { recursive: true, force: true })
    }
  })
})
