import { expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EvidenceEngine,
  createSpan,
  isMonthOnlyDate,
  loadEvidenceRulesEngine,
  parseDateFlexible,
} from '@deepseek-ai/dsh-patent-core'
import { STANDARD_CLEAR_CONVINCING, STANDARD_PREPONDERANCE } from '../src/evidence/proof-standard.ts'
import {
  extractWaybackMachineDate,
  isBeforeReferenceDate,
  isPreciseDate,
} from '../src/evidence/date.ts'
import { inferEvidenceType } from '../src/evidence/judgment.ts'
import { platformCredibility } from '../src/evidence/credibility.ts'
import type { EvidenceSpan } from '../src/evidence/span.ts'

function span(overrides: Partial<EvidenceSpan> & { snippet?: string }): EvidenceSpan {
  return createSpan({ snippet: '', direction: 'neutral', ...overrides })
}

// ---------------------------------------------------------------------------
// 三性判定
// ---------------------------------------------------------------------------

it('三性：完整证据（来源+哈希+版本+绑定+方向）三项高分', () => {
  const engine = new EvidenceEngine()
  const j = engine.judge(
    span({
      sourceUri: 'web:https://www.cnipa.gov.cn/page',
      docVersion: '2023-01-01',
      contentHash: 'abc123',
      claimRefs: ['C1'],
      direction: 'supporting',
      snippet: '原文',
    }),
    undefined,
    undefined,
    { integrityVerified: true },
  )
  expect(j.relevanceJudgment!.score >= 0.85).toBeTruthy()
  expect(j.authenticityJudgment!.score >= 0.85).toBeTruthy()
  expect(j.legalityJudgment!.score >= 0.65).toBeTruthy()
  expect(j.flaggedIssues.length).toBe(0)
})

it('三性：仅有摘录的证据评分低并标记问题', () => {
  const engine = new EvidenceEngine()
  const j = engine.judge(span({ snippet: '只有摘录' }))
  expect(j.relevanceJudgment!.score < 0.85).toBeTruthy()
  expect(j.legalityJudgment!.score < 0.85).toBeTruthy()
  expect(j.authenticityJudgment!.score < 0.85).toBeTruthy()
  // 无来源 URI → 合法性存疑（critical）；未绑定结论 → 相关性存疑；不可定位 → 真实性无法核验
  expect(j.flaggedIssues.some(i => i.type === 'legality' && i.severity === 'critical')).toBeTruthy()
  expect(j.flaggedIssues.some(i => i.type === 'relevance')).toBeTruthy()
  expect(j.flaggedIssues.some(i => i.type === 'authenticity' && i.severity === 'critical')).toBeTruthy()
})

it('三性：自报哈希不加分，仅在独立核验后计入真实性', () => {
  const engine = new EvidenceEngine()
  const declared = engine.judge(span({ sourceUri: 'web:https://example.com', contentHash: 'x' }))
  const verified = engine.judge(span({ sourceUri: 'web:https://example.com', contentHash: 'x' }), undefined, undefined, {
    integrityVerified: true,
  })
  // 合法性只看来源记录：哈希与取证合法性无关，不作为加分项
  expect(declared.legalityJudgment!.score).toBe(0.7)
  expect(declared.authenticityJudgment!.score).toBe(0.5)
  expect(verified.authenticityJudgment!.score).toBe(0.8)
})

// ---------------------------------------------------------------------------
// 类型特定判定
// ---------------------------------------------------------------------------

it('类型推断：web_pub: scheme → internet_publication', () => {
  expect(inferEvidenceType(span({ sourceUri: 'web_pub:https://example.com' }))).toBe('internet_publication')
  expect(inferEvidenceType(span({ sourceUri: 'pub_use:2023年销售' }))).toBe('public_use')
  expect(inferEvidenceType(span({ sourceUri: 'witness:证人证言' }))).toBe('witness_testimony')
  expect(inferEvidenceType(span({ sourceUri: 'patent:CN123' }))).toBe('prior_art_date')
  expect(inferEvidenceType(span({ sourceUri: 'file:///tmp/a.pdf' }))).toBe('general')
})

it('互联网公开：平台可信度 + 日期 + 完整性 + 意图', () => {
  const engine = new EvidenceEngine()
  const j = engine.judge(
    span({
      sourceUri: 'web_pub:https://www.cnipa.gov.cn/notice',
      docVersion: '2023-01-15',
      contentHash: 'hash1',
      snippet: '公告',
      direction: 'supporting',
    }),
    { filingDate: '2023-06-01' },
  )
  const ts = j.typeSpecificJudgment!
  expect(ts.platformCredibility).toBe('high')
  // 只有哈希串、未经独立核验 → 部分验证（不宣称 verified）
  expect(ts.contentIntegrity).toBe('partial')
  expect(ts.publicIntent).toBe('public')
  expect(ts.dateDetermination?.determined).toBe('2023-01-15')
  expect(ts.dateDetermination?.reliability).toBe('high')
  expect(ts.dateDetermination?.isPriorArt).toBe(true) // 早于 2023-06-01 申请日
})

it('互联网公开：独立核验哈希后内容完整性为 verified', () => {
  const engine = new EvidenceEngine()
  const j = engine.judge(
    span({ sourceUri: 'web_pub:https://www.cnipa.gov.cn/notice', contentHash: 'hash1', direction: 'supporting' }),
    undefined,
    undefined,
    { integrityVerified: true },
  )
  expect(j.typeSpecificJudgment?.contentIntegrity).toBe('verified')
})

it('互联网公开：无日期时经 Wayback 存档日期提取', () => {
  const engine = new EvidenceEngine()
  const j = engine.judge(
    span({
      sourceUri: 'web_pub:https://web.archive.org/web/20230615000000/https://example.com/page',
      direction: 'neutral',
    }),
  )
  expect(j.typeSpecificJudgment?.dateDetermination?.determined).toBe('2023-06-15')
  expect(j.typeSpecificJudgment?.dateDetermination?.sourceType).toBe('wayback_machine')
})

it('互联网公开：申请日之前的公开日构成现有技术', () => {
  const engine = new EvidenceEngine()
  const j = engine.judge(
    span({ sourceUri: 'web_pub:https://example.com', docVersion: '2022-12-01', direction: 'neutral' }),
    { filingDate: '2023-06-01' },
  )
  expect(j.typeSpecificJudgment?.dateDetermination?.isPriorArt).toBe(true)
})

it('现有技术基准：优先权日早于申请日时，晚于优先权日的公开不构成现有技术', () => {
  const engine = new EvidenceEngine()
  const j = engine.judge(
    span({ sourceUri: 'web_pub:https://example.com', docVersion: '2023-03-01', direction: 'neutral' }),
    { filingDate: '2023-06-01', priorityDate: '2023-01-15' },
  )
  const dd = j.typeSpecificJudgment?.dateDetermination
  expect(dd?.referenceDate).toBe('2023-01-15')
  expect(dd?.referenceBasis).toBe('priority-date')
  // 公开日 2023-03-01 晚于优先权日 → 不构成现有技术（此前按申请日比较会误判为现有技术）
  expect(dd?.isPriorArt).toBe(false)
})

it('现有技术基准：申请日早于优先权日时（同日申请/国内优先权异常记录）取申请日', () => {
  const engine = new EvidenceEngine()
  const j = engine.judge(
    span({ sourceUri: 'web_pub:https://example.com', docVersion: '2023-02-01', direction: 'neutral' }),
    { filingDate: '2023-01-15', priorityDate: '2023-06-01' },
  )
  const dd = j.typeSpecificJudgment?.dateDetermination
  expect(dd?.referenceDate).toBe('2023-01-15')
  expect(dd?.referenceBasis).toBe('filing-date')
})

it('使用公开：销售 + 无保密 → 四要件全部满足', () => {
  const engine = new EvidenceEngine()
  const j = engine.judge(
    span({
      sourceUri: 'pub_use:2023年1月销售',
      docVersion: '2023-01-10',
      snippet: '2023年1月10日在上海公开销售该产品',
      direction: 'contradicting',
    }),
  )
  const fe = j.typeSpecificJudgment?.fourElementsCheck
  expect(fe).toBeTruthy()
  expect(fe!.allMet).toBe(true)
  expect(fe!.methodElement.detail.includes('销售')).toBe(true)
  expect(fe!.accessibility.met).toBe(true)
  expect(j.typeSpecificJudgment?.burdenDifficulty !== undefined).toBeTruthy()
})

it('使用公开规则：四要件条件全部命中时规则成立', () => {
  const engine = new EvidenceEngine(`weights:
  relevance: 0.5
  legality: 0.25
  authenticity: 0.25
rules:
  - ruleId: EVI-015
    name: 使用公开证据审查规则
    description: d
    severity: major
    action: apply
    evidenceType: public_use
    check:
      type: public_use
      method: multi_condition
      conditions:
        - public_use_time_available
        - public_use_place_identified
        - public_use_method_identified
        - public_use_publicly_accessible
`)
  const j = engine.judge(
    span({
      sourceUri: 'pub_use:2023年1月销售',
      docVersion: '2023-01-10',
      snippet: '2023年1月10日在上海公开销售该产品',
      direction: 'contradicting',
    }),
    { filingDate: '2023-02-01' },
  )
  const rule = j.rulesApplied.find(item => item.ruleId === 'EVI-015')
  expect(rule?.satisfied).toBe(true)
  expect(rule?.failedConditions).toEqual([])
  expect(rule?.pendingInputs).toEqual([])
})

it('使用公开：保密协议 → 公众可获取性不满足', () => {
  const engine = new EvidenceEngine()
  const j = engine.judge(
    span({ sourceUri: 'pub_use:内部测试', snippet: '在保密协议约束下的内部测试使用', direction: 'neutral' }),
  )
  const fe = j.typeSpecificJudgment?.fourElementsCheck
  expect(fe).toBeTruthy()
  expect(fe!.accessibility.met).toBe(false)
  expect(fe!.allMet).toBe(false)
})

it('电子证据：社交平台可信度低（显式类型）', () => {
  const engine = new EvidenceEngine()
  const j = engine.judge(
    span({ sourceUri: 'web:https://weibo.com/u/123', direction: 'neutral' }),
    undefined,
    'electronic',
  )
  expect(j.typeSpecificJudgment?.platformCredibility).toBe('low')
  expect(j.typeSpecificJudgment?.credibilityScore).toBe(0.25)
})

it('公知常识：免证', () => {
  const engine = new EvidenceEngine()
  const j = engine.judge(span({ sourceUri: 'common:公知常识', direction: 'neutral' }))
  expect(j.typeSpecificJudgment?.evidenceType).toBe('general') // 未显式标注时不推断公知常识
})

// ---------------------------------------------------------------------------
// 平台可信度
// ---------------------------------------------------------------------------

it('platformCredibility：政府/学术/新闻/社交分级', () => {
  expect(platformCredibility('web:https://www.cnipa.gov.cn/x')).toBe('high')
  expect(platformCredibility('web:https://www.court.gov.cn/x')).toBe('high')
  expect(platformCredibility('web:https://cnki.net/x')).toBe('high')
  expect(platformCredibility('web:https://patents.google.com/patent/CN1')).toBe('medium_high')
  expect(platformCredibility('web:https://www.bbc.com/news')).toBe('medium')
  expect(platformCredibility('web:https://baidu.com/s')).toBe('medium')
  expect(platformCredibility('web:https://weibo.com/u/1')).toBe('low')
  expect(platformCredibility('')).toBe('low')
})

// ---------------------------------------------------------------------------
// 日期判定
// ---------------------------------------------------------------------------

it('parseDateFlexible：多格式解析', () => {
  expect(parseDateFlexible('2023-01-02') !== null).toBeTruthy()
  expect(parseDateFlexible('2023/01/02') !== null).toBeTruthy()
  expect(parseDateFlexible('2023.01.02') !== null).toBeTruthy()
  expect(parseDateFlexible('20230102') !== null).toBeTruthy()
  expect(parseDateFlexible('2023年1月2日') !== null).toBeTruthy()
  expect(parseDateFlexible('2023年01月02日') !== null).toBeTruthy()
  expect(parseDateFlexible('Jan 2, 2023') !== null).toBeTruthy()
  expect(parseDateFlexible('2023年1月') !== null).toBeTruthy()
  expect(parseDateFlexible('not-a-date')).toBeNull()
  expect(parseDateFlexible('2023-02-30')).toBeNull() // 溢出回绕拒绝
})

it('isPreciseDate / isMonthOnlyDate 区分精度', () => {
  expect(isPreciseDate('2023-01-02')).toBe(true)
  expect(isPreciseDate('2023年1月2日')).toBe(true)
  expect(isMonthOnlyDate('2023-01')).toBe(true)
  expect(isMonthOnlyDate('2023年1月')).toBe(true)
  expect(isPreciseDate('2023-01')).toBe(false)
  expect(isMonthOnlyDate('2023-01-02')).toBe(false)
})

it('isBeforeReferenceDate：公开日早于现有技术截止日', () => {
  expect(isBeforeReferenceDate('2023-01-02', '2023-06-01')).toBe(true)
  expect(isBeforeReferenceDate('2023-07-01', '2023-06-01')).toBe(false)
  expect(isBeforeReferenceDate('', '2023-06-01')).toBe(false)
})

it('英文月份日期：精确解析且不被截为年-月（isPriorArt 不反转）', () => {
  // 真实公开日 2023-01-20 晚于申请日 2023-01-15 → 不构成现有技术
  const engine = new EvidenceEngine()
  const j = engine.judge(
    span({ sourceUri: 'web_pub:https://example.com', docVersion: 'Jan 20, 2023', direction: 'neutral' }),
    { filingDate: '2023-01-15' },
  )
  // 英文精确日期被规范化为 ISO（2023-01-20），不再截为年-月（2023-01）
  expect(j.typeSpecificJudgment?.dateDetermination?.determined).toBe('2023-01-20')
  expect(j.typeSpecificJudgment?.dateDetermination?.isPriorArt).toBe(false)

  // Sept 变体（美国专利文件常见）
  expect(parseDateFlexible('Sept 2, 2023') !== null).toBeTruthy()
  expect(isPreciseDate('Sept 2, 2023')).toBe(true)
})

it('Wayback URL：id_ 后缀时间戳可提取，伪造域名被拒绝', () => {
  // 标准浏览器捕获形态 /web/20230615093000id_/
  expect(extractWaybackMachineDate('https://web.archive.org/web/20230615093000id_/http://example.com')).toBe('2023-06-15')
  // 伪造域名（含 archive.org 子串但非该域）
  expect(extractWaybackMachineDate('https://web.archive.org.evil.com/web/20230615/x')).toBe('')
})

// ---------------------------------------------------------------------------
// 举证责任与证明标准
// ---------------------------------------------------------------------------

it('举证责任：无效宣告请求人 / 侵权权利人 / 新产品举证倒置', () => {
  const engine = new EvidenceEngine()
  const invalidation = engine.assessBurdenOfProof('invalidation')
  expect(invalidation.burdenHolder).toBe('claimant')
  expect(invalidation.standard).toBe(STANDARD_PREPONDERANCE)
  expect(invalidation.hasShifted).toBe(false)

  const infringement = engine.assessBurdenOfProof('infringement')
  expect(infringement.standard).toBe(STANDARD_CLEAR_CONVINCING)

  const productMethod = engine.assessBurdenOfProof('new_product_method')
  expect(productMethod.hasShifted).toBe(true)
  expect(productMethod.shiftReason!.includes('倒置')).toBeTruthy()
})

it('证明标准：优势证据 — 支持多于矛盾且置信度 ≥0.5', () => {
  const engine = new EvidenceEngine()
  const strong1 = engine.judge(
    span({
      sourceUri: 'web:https://www.cnipa.gov.cn',
      contentHash: 'a',
      claimRefs: ['C1'],
      direction: 'supporting',
      snippet: 'x',
    }),
  )
  const strong2 = engine.judge(
    span({
      sourceUri: 'web:https://cnki.net',
      contentHash: 'b',
      claimRefs: ['C1'],
      direction: 'supporting',
      snippet: 'y',
    }),
  )
  const weak = engine.judge(span({ snippet: '无来源无哈希' }))
  const result = engine.assessProofStandard([strong1, strong2, weak], STANDARD_PREPONDERANCE)
  expect(result.met).toBe(true)
  expect(result.supportingCount >= 2).toBeTruthy()
})

it('证明标准：优势证据 — 支持与矛盾持平不达标', () => {
  const engine = new EvidenceEngine()
  const strong = engine.judge(
    span({
      sourceUri: 'web:https://www.cnipa.gov.cn',
      contentHash: 'a',
      claimRefs: ['C1'],
      direction: 'supporting',
      snippet: 'x',
    }),
  )
  // 反证按 direction 归类：低分的中性证据不再被当作反证
  const contradicting = engine.judge(span({ snippet: '无来源无哈希', direction: 'contradicting' }))
  const result = engine.assessProofStandard([strong, contradicting], STANDARD_PREPONDERANCE)
  expect(result.supportingCount).toBe(1)
  expect(result.contradictingCount).toBe(1)
  expect(result.met).toBe(false)
})

it('证明标准：中性证据不计入支持或反证', () => {
  const engine = new EvidenceEngine()
  const strong = engine.judge(
    span({ sourceUri: 'web:https://www.cnipa.gov.cn', claimRefs: ['C1'], direction: 'supporting', snippet: 'x' }),
  )
  const neutral = engine.judge(span({ sourceUri: 'web:https://example.com', direction: 'neutral', snippet: 'y' }))
  const result = engine.assessProofStandard([strong, neutral], STANDARD_PREPONDERANCE)
  expect(result.supportingCount).toBe(1)
  expect(result.contradictingCount).toBe(0)
  expect(result.neutralCount).toBe(1)
  expect(result.reasoning).toMatch(/中性 1 件/)
})

it('证明标准：高分反证不得计入支持方', () => {
  const engine = new EvidenceEngine()
  // 记录完备（高评分）但方向为反证：立场由 direction 决定，评分只表示记录完备度
  const strongContradicting = engine.judge(
    span({
      sourceUri: 'web:https://www.cnipa.gov.cn',
      docVersion: '2023-01-01',
      contentHash: 'a',
      claimRefs: ['C1'],
      direction: 'contradicting',
      snippet: 'x',
    }),
  )
  const result = engine.assessProofStandard([strongContradicting], STANDARD_PREPONDERANCE)
  expect(result.supportingCount).toBe(0)
  expect(result.contradictingCount).toBe(1)
  expect(result.met).toBe(false)
  expect(result.gaps.some(g => g.includes('反证'))).toBeTruthy()
})

it('证明标准：高度盖然性 — 置信度 ≥0.7 且支持 > 2×矛盾', () => {
  const engine = new EvidenceEngine()
  const strong1 = engine.judge(
    span({
      sourceUri: 'web:https://www.cnipa.gov.cn',
      contentHash: 'a',
      claimRefs: ['C1'],
      direction: 'supporting',
      snippet: 'x',
    }),
  )
  const strong2 = engine.judge(
    span({
      sourceUri: 'web:https://cnki.net',
      contentHash: 'b',
      claimRefs: ['C1'],
      direction: 'supporting',
      snippet: 'y',
    }),
  )
  const result = engine.assessProofStandard([strong1, strong2], STANDARD_CLEAR_CONVINCING)
  expect(result.met).toBe(true)
})

it('证明标准：无证据 → 不达标', () => {
  const engine = new EvidenceEngine()
  const result = engine.assessProofStandard([], STANDARD_PREPONDERANCE)
  expect(result.met).toBe(false)
  expect(result.status).toBe('evaluated')
  expect(result.gaps.includes('无证据支持')).toBeTruthy()
})

it('证明标准：中文别名按对应标准评估', () => {
  const engine = new EvidenceEngine()
  const strong = engine.judge(
    span({
      sourceUri: 'web:https://www.cnipa.gov.cn',
      contentHash: 'a',
      claimRefs: ['C1'],
      direction: 'supporting',
      snippet: 'x',
    }),
  )
  expect(engine.assessProofStandard([strong], '优势证据').met).toBe(true)
  expect(engine.assessProofStandard([strong], '高度盖然性').status).toBe('evaluated')
})

it('证明标准：空标准与未知标准一样 fail-closed', () => {
  const engine = new EvidenceEngine()
  const strong = engine.judge(
    span({
      sourceUri: 'web:https://www.cnipa.gov.cn',
      contentHash: 'a',
      claimRefs: ['C1'],
      direction: 'supporting',
      snippet: 'x',
    }),
  )
  for (const standard of ['', '   ']) {
    const result = engine.assessProofStandard([strong], standard)
    expect(result.met).toBe(false)
    expect(result.status).toBe('unknown-standard')
    expect(result.gaps).toContain('无法识别的证明标准：未提供标准')
  }
})

// ---------------------------------------------------------------------------
// YAML 规则加载与权重
// ---------------------------------------------------------------------------

it('loadRules：加载证据规则资产后权重生效且规则可查', () => {
  const engine = new EvidenceEngine(
    `
weights:
  relevance: 0.5
  legality: 0.25
  authenticity: 0.25
rules:
  - ruleId: EVI-001
    name: 证据相关性审查
    description: d
    severity: major
    action: apply
    evidenceType: general
    check:
      type: relevance
      method: triple-attribute
  - ruleId: EVI-010
    name: 电子证据审查规则
    description: d
    severity: major
    action: apply
    evidenceType: electronic
    check:
      type: electronic
      method: credibility_scaled
`,
  )
  expect(engine.getRules().length).toBe(2)
  expect(engine.getRulesByType('electronic').length).toBe(1)
  expect(engine.getRulesByType('electronic')[0]!.ruleId).toBe('EVI-010')
})

it('loadRules：坏规则跳过不阻塞整体加载', () => {
  const engine = new EvidenceEngine(
    `
weights:
  relevance: 0.35
  legality: 0.3
  authenticity: 0.35
rules:
  - ruleId: EVI-001
    name: 证据相关性审查
    description: d
    severity: major
    action: apply
    evidenceType: general
  - 缺字段
`,
  )
  expect(engine.getRules().length).toBe(1)
  expect(engine.getWarnings().length > 0).toBeTruthy()
})

it('loadEvidenceRulesEngine：默认无 ruleDirs 时降级为默认权重（P4.1 接线前）', () => {
  const { engine, source, warnings } = loadEvidenceRulesEngine()
  expect(source).toBeNull()
  expect(engine.getRules().length).toBe(0)
  expect(warnings.length > 0).toBeTruthy()
})

it('loadEvidenceRulesEngine：传入 ruleDirs 加载 YAML 资产（P4.1 接线路径）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-rules-'))
  writeFileSync(
    join(dir, 'evidence-rules.yaml'),
    `weights:
  relevance: 0.5
  legality: 0.25
  authenticity: 0.25
rules:
  - ruleId: EVI-011
    name: 域外证据审查规则
    description: d
    severity: major
    action: notify
    evidenceType: overseas
    check:
      type: overseas
      method: multi_condition
      conditions:
        - evidence_notarized
        - evidence_translated
`,
  )
  try {
    const { engine, source } = loadEvidenceRulesEngine([dir])
    expect(source).not.toBeNull()
    const j = engine.judge(span({ snippet: '域外证据' }), undefined, 'overseas', {
      notarized: true,
      translated: true,
    })
    expect(j.rulesApplied.find(r => r.ruleId === 'EVI-011')?.satisfied).toBe(true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 审查回归：web: 推断 / 评分上溢 / confidence / 规则应用
// ---------------------------------------------------------------------------

it('inferEvidenceType：web: 前缀 → internet_publication（工具文档默认格式）', () => {
  expect(inferEvidenceType(span({ sourceUri: 'web:https://blog.example.com/posts/123' }))).toBe('internet_publication')
  const engine = new EvidenceEngine()
  const j = engine.judge(
    span({
      sourceUri: 'web:https://www.cnipa.gov.cn/notice',
      docVersion: '2023-01-15',
      contentHash: 'h',
      direction: 'supporting',
    }),
  )
  const ts = j.typeSpecificJudgment!
  expect(ts.evidenceType).toBe('internet_publication')
  expect(ts.platformCredibility).toBe('high')
  expect(ts.dateDetermination?.determined).toBe('2023-01-15')
})

it('综合评分不超 1.0（可信度修正截断）', () => {
  const engine = new EvidenceEngine()
  const j = engine.judge(
    span({
      sourceUri: 'web:https://www.cnipa.gov.cn/x',
      docVersion: '2023-01-01',
      contentHash: 'h',
      claimRefs: ['C1'],
      direction: 'supporting',
      snippet: '完整证据',
    }),
  )
  expect(j.overallScore <= 1.0).toBeTruthy()
})

it('confidence 与评分关联（低分证据不宣称确信）', () => {
  const engine = new EvidenceEngine()
  const bare = engine.judge(span({ snippet: '无来源无哈希' }))
  expect(bare.confidence < 0.8).toBeTruthy()
  expect(bare.confidence > 0).toBeTruthy()
})

it('规则应用：匹配类型的规则按条件评估（satisfied/pending/failed）', () => {
  const engine = new EvidenceEngine(
    `
weights:
  relevance: 0.35
  legality: 0.3
  authenticity: 0.35
rules:
  - ruleId: EVI-010
    name: 电子证据审查规则
    description: d
    severity: major
    action: apply
    evidenceType: electronic
    check:
      type: electronic
      method: credibility_scaled
      conditions:
        - evidence_has_source_uri
  - ruleId: EVI-011
    name: 域外证据审查规则
    description: d
    severity: major
    action: notify
    evidenceType: overseas
    check:
      type: overseas
      method: multi_condition
      conditions:
        - evidence_notarized
        - evidence_translated
`,
  )
  // 有来源的电子证据：EVI-010 satisfied；EVI-011 不适用（类型不匹配）
  const withSource = engine.judge(
    span({ sourceUri: 'web:https://x.com', direction: 'neutral' }),
    undefined,
    'electronic',
  )
  const e010 = withSource.rulesApplied.find(r => r.ruleId === 'EVI-010')!
  expect(e010.satisfied).toBe(true)
  expect(e010.failedConditions).toEqual([])
  expect(withSource.rulesApplied.some(r => r.ruleId === 'EVI-011')).toBe(false)

  // 域外证据未提供公证/译本输入：EVI-011 pending（不误判为失败）
  const overseas = engine.judge(span({ snippet: '域外证据' }), undefined, 'overseas')
  const e011 = overseas.rulesApplied.find(r => r.ruleId === 'EVI-011')!
  expect(e011.satisfied).toBe(false)
  expect(e011.pendingInputs).toEqual(['evidence_notarized', 'evidence_translated'])

  // 提供外部输入后 satisfied
  const withInputs = engine.judge(span({ snippet: '域外证据' }), undefined, 'overseas', {
    notarized: true,
    translated: true,
  })
  const e011ok = withInputs.rulesApplied.find(r => r.ruleId === 'EVI-011')!
  expect(e011ok.satisfied).toBe(true)
  expect(e011ok.pendingInputs).toEqual([])
})

// ---------------------------------------------------------------------------
// 规则条件补齐（EVI-002/020/030/050/060）：7 个曾无实现的条件
// ---------------------------------------------------------------------------

it('规则条件补齐：EVI-002 收集合法 / EVI-020 案件类型 / EVI-030 计数 / EVI-050 证据链 / EVI-060 内容哈希', () => {
  const engine = new EvidenceEngine(
    `
weights:
  relevance: 0.35
  legality: 0.3
  authenticity: 0.35
rules:
  - ruleId: EVI-002
    name: 证据合法性审查
    description: d
    severity: critical
    action: apply
    evidenceType: general
    check:
      type: legality
      method: triple-attribute
      conditions:
        - evidence_collection_legal
  - ruleId: EVI-020
    name: 举证责任审查
    description: d
    severity: major
    action: apply
    evidenceType: general
    check:
      type: burden
      method: conditional
      conditions:
        - case_type_identified
  - ruleId: EVI-030
    name: 证明标准审查
    description: d
    severity: major
    action: apply
    evidenceType: general
    check:
      type: standard
      method: conditional
      conditions:
        - supporting_evidence_counted
        - contradicting_evidence_counted
  - ruleId: EVI-050
    name: 证据链审查
    description: d
    severity: major
    action: apply
    evidenceType: general
    check:
      type: custody
      method: conditional
      conditions:
        - custody_chain_traceable
        - evidence_integrity_verified
  - ruleId: EVI-060
    name: 电子证据完整性审查
    description: d
    severity: major
    action: apply
    evidenceType: general
    check:
      type: electronic
      method: conditional
      conditions:
        - content_hash_provided
`,
  )

  // 未提供外部输入：外部条件 pending，不误判为失败
  const bare = engine.judge(span({ snippet: 'x' }))
  for (const ruleId of ['EVI-002', 'EVI-020', 'EVI-030', 'EVI-050']) {
    const r = bare.rulesApplied.find(x => x.ruleId === ruleId)!
    expect(r.satisfied).toBe(false)
    expect(r.pendingInputs.length > 0).toBeTruthy()
    expect(r.failedConditions).toEqual([])
  }

  // content_hash_provided 由 span 直接判定：无哈希 → failed（非 pending）
  const e060 = bare.rulesApplied.find(r => r.ruleId === 'EVI-060')!
  expect(e060.pendingInputs).toEqual([])
  expect(e060.failedConditions).toEqual(['content_hash_provided'])

  // 提供全部外部输入后 satisfied
  const full = engine.judge(span({ snippet: 'x', contentHash: 'abc123' }), undefined, undefined, {
    collectionLegal: true,
    caseType: 'invalidation',
    supportingCount: 2,
    contradictingCount: 0,
    custodyChainTraceable: true,
    integrityVerified: true,
  })
  for (const ruleId of ['EVI-002', 'EVI-020', 'EVI-030', 'EVI-050', 'EVI-060']) {
    const r = full.rulesApplied.find(x => x.ruleId === ruleId)!
    expect(r.satisfied).toBe(true)
    expect(r.pendingInputs).toEqual([])
    expect(r.failedConditions).toEqual([])
  }

  // caseType 空串视为未识别（pending）
  const emptyCase = engine.judge(span({ snippet: 'x' }), undefined, undefined, { caseType: '  ' })
  const e020 = emptyCase.rulesApplied.find(r => r.ruleId === 'EVI-020')!
  expect(e020.satisfied).toBe(false)
  expect(e020.pendingInputs).toEqual(['case_type_identified'])
})
