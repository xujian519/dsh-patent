import { describe, expect, it } from 'vitest'
import {
  LevelMust,
  LevelQuality,
  buildAnalysisReport,
  classifyIpc,
  type RuleCheckResult,
} from '@deepseek-ai/dsh-patent-core'
import {
  computeClarityScore,
  computeCompletenessScore,
  mergeScores,
  toIpcSummary,
} from '../src/analysis-report/build.ts'
import {
  computeFeatureStatistics,
  determineFeatureType,
  determineImportance,
  extractTechnicalFeatures,
} from '../src/analysis-report/feature-extract.ts'

const ABSTRACT = '本发明公开一种智能机器人控制方法及系统，基于多传感器数据生成控制指令。'

const CLAIMS = [
  '一种智能机器人控制方法，其特征在于，包括：获取传感器数据；基于所述数据生成控制指令；执行所述控制指令。',
  '如权利要求1所述的方法，其特征在于，所述传感器数据包括视觉图像与激光测距数据。',
  '一种机器人控制系统，包括：处理器、存储器与执行机构。',
]

describe('feature extract', () => {
  it('classifies feature type by domain keywords', () => {
    expect(determineFeatureType('一种实时数据压缩算法')).toBe('data')
    expect(determineFeatureType('一种耐腐蚀合金材料')).toBe('material')
    expect(determineFeatureType('一种在线检测步骤')).toBe('method')
    expect(determineFeatureType('某无关描述')).toBe('other')
  })

  it('assigns importance by claim position and substance', () => {
    expect(determineImportance(1, '独立权利要求')).toBe('high')
    expect(determineImportance(2, '包含足够实质限定的具体从属权利要求文本内容。')).toBe('medium')
    expect(determineImportance(3, '极短')).toBe('low')
  })

  it('extracts one feature per claim in claim order', () => {
    const features = extractTechnicalFeatures(CLAIMS)
    expect(features).toHaveLength(3)
    expect(features.map(f => f.claimNo)).toEqual([1, 2, 3])
    expect(features[0]!.type).toBe('method')
    expect(features[2]!.type).toBe('system')
    expect(features[0]!.importance).toBe('high')
    expect(features.every(f => f.confidence > 0)).toBe(true)
  })

  it('uses the fallback confidence when the feature type is unknown', () => {
    const [feature] = extractTechnicalFeatures(['某无关描述'])
    expect(feature?.type).toBe('other')
    expect(feature?.confidence).toBeLessThan(extractTechnicalFeatures(CLAIMS)[0]!.confidence)
  })

  it('computes full-key statistics', () => {
    const stats = computeFeatureStatistics(extractTechnicalFeatures(CLAIMS))
    expect(stats.total).toBe(3)
    expect(stats.byType.method).toBe(2)
    expect(stats.byType.system).toBe(1)
    expect(stats.byType.other).toBe(0)
    expect(stats.byImportance.high).toBe(1)
  })
})

describe('deterministic quality scores', () => {
  it('penalizes fuzzy terms for clarity', () => {
    const clear = computeClarityScore(CLAIMS)
    expect(clear.domain).toBe('clarity')
    expect(clear.basis).toBe('deterministic')
    expect(clear.score).toBe(100)
    expect(clear.rationale).toBe('未检出模糊限定词')

    const fuzzy = computeClarityScore(['范围为约 5 厘米左右，大约 10 毫米'])
    expect(fuzzy.score).toBeLessThan(100)
    expect(fuzzy.rationale).toContain('左右')
  })

  it('returns a zero score when no claim text is available', () => {
    expect(computeClarityScore([])).toMatchObject({ score: 0, rationale: '缺少权利要求文本' })
    expect(computeCompletenessScore([])).toMatchObject({ score: 0, rationale: '缺少权利要求文本' })
  })

  it('penalizes missing abstract and single claim for completeness', () => {
    const complete = computeCompletenessScore(CLAIMS, ABSTRACT)
    expect(complete.score).toBe(100)
    expect(complete.rationale).toBe('权利要求与摘要要素较完整')

    const missing = computeCompletenessScore(CLAIMS, undefined)
    expect(missing.score).toBe(85)
    expect(missing.rationale).toContain('缺摘要')

    const single = computeCompletenessScore(['一种装置'], ABSTRACT)
    expect(single.score).toBeLessThan(100)
    expect(single.rationale).toContain('仅 1 条权利要求')
  })
})

describe('mergeScores', () => {
  it('orders deterministically then overlays model scores', () => {
    const deterministic = [
      computeClarityScore(CLAIMS),
      computeCompletenessScore(CLAIMS, ABSTRACT),
    ]
    const merged = mergeScores(deterministic, {
      novelty: { score: 82, rationale: 'LLM 评估' },
      technical_strength: { score: 76, rationale: 'LLM 评估' },
    })
    expect(merged.map(s => s.domain)).toEqual(['novelty', 'clarity', 'completeness', 'technical_strength'])
    const novelty = merged.find(s => s.domain === 'novelty')
    expect(novelty?.basis).toBe('model')
    expect(novelty?.score).toBe(82)
  })
})

describe('toIpcSummary', () => {
  it('resolves domain name from the IPC table and keeps detail + keywords', () => {
    const summary = toIpcSummary({ section: 'G', confidence: 0.9, matchedKeywords: ['控制', '算法'] })
    expect(summary.domainName).toBe('物理')
    expect(summary.detail).toBeUndefined()

    const withDetail = toIpcSummary({ section: 'G', confidence: 0.9, matchedKeywords: ['计算'], detail: 'G06', detailConfidence: 0.8 })
    expect(withDetail.detail).toBe('G06')
  })
})

describe('buildAnalysisReport', () => {
  const blockedFailures: RuleCheckResult[] = [
    { ruleId: 'nov-1', ruleName: '新颖性单独对比', passed: false, level: LevelMust, severity: 'critical', message: '缺少单独对比', fixSuggestion: '补充单独对比' },
    { ruleId: 'qua-1', ruleName: '说明书支持', passed: false, level: LevelQuality, severity: 'minor', message: '支持不足', fixSuggestion: '补充实施例' },
    { ruleId: 'qua-2', ruleName: '清楚性', passed: false, level: LevelQuality, severity: 'minor', message: '指代不清', fixSuggestion: '明确指代' },
  ]

  it('assembles the report deterministically without model scores', () => {
    const report = buildAnalysisReport({
      patentId: 'CN123456789A',
      title: '智能机器人控制方法',
      claims: CLAIMS,
      abstract: ABSTRACT,
      checkerFailures: blockedFailures,
      ipc: classifyIpc('机器人的图像处理模型与控制方法'),
      evidenceReceiptCount: 0,
      kgAnalysis: { matchedEntities: 4, relatedEntities: 6, confidence: 0.62 },
      graphConclusions: { novelty: '相对于 D1 具备新颖性' },
      searchStrategy: { query: '机器人 控制', ipc: ['G06'], keywords: ['机器人', '控制'] },
    })

    expect(report.patentId).toBe('CN123456789A')
    expect(report.checkerVerdict).toBe('blocked')
    expect(report.checkerFailures).toHaveLength(3)
    expect(report.technicalFeatures).toHaveLength(3)
    expect(report.featureStatistics.total).toBe(3)
    expect(report.evidenceReceiptCount).toBe(0)
    expect(report.kgAnalysis?.confidence).toBe(0.62)
    expect(report.searchStrategy?.query).toBe('机器人 控制')
    expect(report.searchStrategy?.ipc).toEqual(['G06'])

    // Deterministic-only: clarity + completeness present, no model dimension.
    const domains = report.scores.map(s => s.domain)
    expect(domains).toContain('clarity')
    expect(domains).toContain('completeness')
    expect(domains).not.toContain('novelty')

    // Rule-derived insights/considerations.
    expect(report.innovationInsights.length).toBeGreaterThan(0)
    expect(report.expertConsiderations.some(c => c.includes('critical'))).toBe(true)
    expect(report.expertConsiderations.some(c => c.includes('知识图谱关联置信度较低'))).toBe(true)
  })

  it('produces a pass verdict and asserts an evidence gap consideration', () => {
    const report = buildAnalysisReport({
      claims: CLAIMS,
      abstract: ABSTRACT,
      checkerFailures: [],
      graphConclusions: { citationsOk: true },
    })
    expect(report.checkerVerdict).toBe('pass')
    expect(report.checkerFailures).toHaveLength(0)
    expect(report.expertConsiderations.some(c => c.includes('尚未记录证据收据'))).toBe(true)
  })

  it('uses an unknown domain name for unrecognized IPC sections', () => {
    const summary = toIpcSummary({ section: 'Z', confidence: 0.4, matchedKeywords: [] })
    expect(summary.domainName).toBe('未知')
    expect(summary.noveltyImplications).toBeUndefined()
  })

  it('derives insights for high-confidence IPC, score bands and one-claim input', () => {
    const high = buildAnalysisReport({
      claims: CLAIMS,
      abstract: ABSTRACT,
      ipc: [{ section: 'G', confidence: 0.9, matchedKeywords: ['控制'] }],
      modelScores: {
        novelty: { score: 90, rationale: 'LLM 评估' },
        technical_strength: { score: 60, rationale: 'LLM 评估' },
      },
      evidenceReceiptCount: 2,
    })
    expect(high.innovationInsights.some(item => item.includes('置信度 0.90'))).toBe(true)
    expect(high.innovationInsights.some(item => item.includes('新颖性评估良好'))).toBe(true)
    expect(high.expertConsiderations.some(item => item.includes('尚未记录证据收据'))).toBe(false)

    const low = buildAnalysisReport({
      claims: CLAIMS,
      abstract: ABSTRACT,
      modelScores: { novelty: { score: 50, rationale: 'LLM 评估' } },
    })
    expect(low.innovationInsights.some(item => item.includes('新颖性评估偏低'))).toBe(true)

    const single = buildAnalysisReport({ claims: ['一种装置'], abstract: ABSTRACT })
    expect(single.innovationInsights.some(item => item.includes('可区别技术特征'))).toBe(true)
    expect(single.expertConsiderations.some(item => item.includes('仅一条权利要求'))).toBe(true)
  })

  it('skips feature insights when there are no claims', () => {
    const report = buildAnalysisReport({ claims: [], ipc: [] })
    expect(report.technicalFeatures).toEqual([])
    expect(report.innovationInsights.some(item => item.includes('可区别技术特征'))).toBe(false)
  })

  it('keeps checkerVerdict undefined when the checker was not run', () => {
    const report = buildAnalysisReport({ claims: CLAIMS, abstract: ABSTRACT })
    expect(report.checkerVerdict).toBeUndefined()
    expect(report.checkerFailures).toHaveLength(0)
  })
})
