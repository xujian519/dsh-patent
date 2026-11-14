import { describe, expect, it } from 'vitest'
import { createSpan, loadEvidenceRulesEngine } from '@deepseek-ai/dsh-patent-core'
import type { EvidenceExternalInputs } from '@deepseek-ai/dsh-patent-core'
import { patentAssetDir } from '@deepseek-ai/dsh-patent-rule'

/** 全部外部输入均已提供：用于区分"条件未实现（pending）"与"条件不满足（failed）"。 */
const ALL_EXTERNAL_INPUTS: EvidenceExternalInputs = {
  notarized: true,
  legalized: true,
  translated: true,
  witnessDisclosed: true,
  isWellKnown: true,
  isUncontested: true,
  deadlineDefined: true,
  submissionWithinDeadline: true,
  collectionLegal: true,
  caseType: 'invalidation',
  supportingCount: 1,
  contradictingCount: 1,
  custodyChainTraceable: true,
  integrityVerified: true,
}

/** 记录完备的使用公开证据：四要件齐备，用于让每条规则的条件都能判定出 true。 */
function completePublicUseSpan() {
  const snippet = '2023年1月10日在上海公开销售该产品，面向不特定公众'
  return createSpan({
    sourceUri: 'pub_use:2023年1月10日在上海公开销售该产品',
    docVersion: '2023-01-10',
    contentHash: 'hash-public-use',
    claimRefs: ['claim-1'],
    direction: 'supporting',
    snippet,
  })
}

function loadPackagedEngine() {
  return loadEvidenceRulesEngine([patentAssetDir()])
}

describe('packaged evidence rules asset', () => {
  it('loads the packaged asset without warnings', () => {
    const { engine, source, warnings } = loadPackagedEngine()
    expect(source).toMatch(/evidence-rules\.yaml$/)
    expect(warnings).toEqual([])
    expect(engine.getRules().length).toBeGreaterThan(0)
  })

  /**
   * 2023 年修正的《民事诉讼法》重排了证据条款：2017 年版的第 63、64、65、72–75 条
   * 现为第 66、67、68、75–78 条。资产曾按旧条号书写，而 `law_verify` 只解析三部专利
   * 文书，跨法引用不会被任何门禁发现，因此在这里钉住现行条号。
   */
  it('cites the current civil-procedure numbering for evidence rules', () => {
    const { engine } = loadPackagedEngine()
    const basis = new Map(engine.getRules().map(rule => [rule.ruleId, rule.legalBasis ?? '']))
    expect(basis.get('EVI-002')).toContain('民事诉讼法第66条')
    expect(basis.get('EVI-012')).toContain('民事诉讼法第75条、第76条、第77条、第78条')
    expect(basis.get('EVI-020')).toContain('民事诉讼法第67条')
    expect(basis.get('EVI-051')).toContain('民事诉讼法第68条')
  })

  it('carries rules for internet publication and public use', () => {
    const { engine } = loadPackagedEngine()
    expect(engine.getRulesByType('internet_publication').map(r => r.ruleId)).toEqual(['EVI-014'])
    expect(engine.getRulesByType('public_use').map(r => r.ruleId)).toEqual(['EVI-015'])
  })

  /**
   * 资产里的每个条件名都必须由引擎实现。未实现的条件恒为 pending，规则永远不会 satisfied，
   * 且在模型的 rulesPending 里长期显示为"待外部输入"——条件名一旦与引擎脱节就会静默失效。
   */
  it('implements every condition name the asset declares', () => {
    const { engine } = loadPackagedEngine()
    const span = completePublicUseSpan()
    for (const rule of engine.getRules()) {
      const applied = engine
        .judge(span, { filingDate: '2023-06-01', priorityDate: '2022-12-01' }, rule.evidenceType, ALL_EXTERNAL_INPUTS)
        .rulesApplied.find(entry => entry.ruleId === rule.ruleId)
      expect(applied, `${rule.ruleId} 未被应用`).toBeDefined()
      expect(applied?.pendingInputs, `${rule.ruleId} 存在引擎未实现的条件`).toEqual([])
    }
  })

  it('satisfies the public-use rule only when all four elements are identified', () => {
    const { engine } = loadPackagedEngine()
    const complete = engine.judge(completePublicUseSpan(), { filingDate: '2023-06-01' }, 'public_use')
    const satisfied = complete.rulesApplied.find(r => r.ruleId === 'EVI-015')
    expect(satisfied?.satisfied).toBe(true)
    expect(satisfied?.failedConditions).toEqual([])

    // 未提及使用地点：该要件不成立，规则不适用并列出未满足的条件
    const noPlace = engine.judge(
      createSpan({ sourceUri: 'pub_use:x', docVersion: '2023-01-10', direction: 'supporting', snippet: '2023年1月10日公开销售该产品' }),
      { filingDate: '2023-06-01' },
      'public_use',
    )
    const unmet = noPlace.rulesApplied.find(r => r.ruleId === 'EVI-015')
    expect(unmet?.satisfied).toBe(false)
    expect(unmet?.failedConditions).toContain('public_use_place_identified')
  })

  it('satisfies the internet-publication rule for a dated, sourced page', () => {
    const { engine } = loadPackagedEngine()
    const judgment = engine.judge(
      createSpan({
        sourceUri: 'web_pub:https://www.cnipa.gov.cn/notice',
        docVersion: '2023-01-15',
        claimRefs: ['claim-1'],
        direction: 'supporting',
        snippet: '公告',
      }),
      { filingDate: '2023-06-01' },
      'internet_publication',
    )
    expect(judgment.rulesApplied.find(r => r.ruleId === 'EVI-014')?.satisfied).toBe(true)

    // 无公开日：条件不满足而非 pending（公开日由证据记录本身决定）
    const undated = engine.judge(
      createSpan({ sourceUri: 'web_pub:https://example.com', direction: 'supporting', snippet: '页面' }),
      { filingDate: '2023-06-01' },
      'internet_publication',
    )
    const rule = undated.rulesApplied.find(r => r.ruleId === 'EVI-014')
    expect(rule?.satisfied).toBe(false)
    expect(rule?.failedConditions).toEqual(['publication_date_available'])
  })

  it('requires a usable prior-art basis date for the date-determination rule', () => {
    const { engine } = loadPackagedEngine()
    const span = createSpan({ sourceUri: 'patent:CN101234567A', docVersion: '2022-01-01', direction: 'supporting' })
    const withoutBasis = engine.judge(span, {}, 'prior_art_date')
    expect(withoutBasis.rulesApplied.find(r => r.ruleId === 'EVI-040')?.failedConditions).toEqual([
      'prior_art_reference_available',
    ])
    const withPriority = engine.judge(span, { filingDate: '2023-06-01', priorityDate: '2022-06-01' }, 'prior_art_date')
    expect(withPriority.rulesApplied.find(r => r.ruleId === 'EVI-040')?.satisfied).toBe(true)
  })
})

/** 资产内出现过的证据类型都必须能被显式指定（防止资产写入引擎未知的类型）。 */
describe('packaged evidence rules asset · type coverage', () => {
  it('declares only evidence types the engine accepts', () => {
    const { engine } = loadPackagedEngine()
    const declared = [...new Set(engine.getRules().map(rule => rule.evidenceType))]
    for (const type of declared) {
      const judgment = engine.judge(completePublicUseSpan(), { filingDate: '2023-06-01' }, type)
      expect(judgment.typeSpecificJudgment?.evidenceType).toBe(type)
    }
  })
})
