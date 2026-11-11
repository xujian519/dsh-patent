import { describe, expect, it } from 'vitest'
import { LegalRegulationSearchEngine } from '@deepseek-ai/dsh-legal-knowledge'
import type { LegalRegulationRecord } from '@deepseek-ai/dsh-legal-knowledge'

const SAMPLE_RECORDS: LegalRegulationRecord[] = [
  {
    regulationId: 'reg-001',
    regulationName: '中华人民共和国民法典',
    level: '法律',
    effectiveDate: '2021-01-01',
    publishDate: '2020-05-28',
    expired: 0,
    validity: 'in-force',
    articleNumber: 577,
    articleText: '当事人一方不履行合同义务或者履行合同义务不符合约定的，应当承担继续履行、采取补救措施或者赔偿损失等违约责任。',
  },
  {
    regulationId: 'reg-002',
    regulationName: '中华人民共和国专利法',
    level: '法律',
    effectiveDate: '2021-06-01',
    publishDate: '2020-10-17',
    expired: 0,
    validity: 'in-force',
    articleNumber: 22,
    articleText: '授予专利权的发明和实用新型，应当具备新颖性、创造性和实用性。',
  },
  {
    regulationId: 'reg-003',
    regulationName: '中华人民共和国合同法（已废止）',
    level: '法律',
    effectiveDate: '1999-10-01',
    expiryDate: '2020-12-31',
    publishDate: '1999-03-15',
    expired: 0,
    validity: 'expired',
    articleNumber: 107,
    articleText: '当事人一方不履行合同义务或者履行合同义务不符合约定的，应当承担继续履行、采取补救措施或者赔偿损失等违约责任。',
  },
  {
    regulationId: 'reg-004',
    regulationName: '最高人民法院关于适用《中华人民共和国民法典》合同编通则若干问题的解释',
    level: '司法解释',
    effectiveDate: '2023-12-05',
    publishDate: '2023-06-28',
    expired: 0,
    validity: 'in-force',
    articleNumber: 1,
    articleText: '为了正确审理合同纠纷案件，根据《中华人民共和国民法典》的规定，结合审判实践，制定本解释。',
  },
]

describe('LegalRegulationSearchEngine', () => {
  it('空库检索返回空数组', () => {
    const engine = new LegalRegulationSearchEngine()
    expect(engine.search('合同')).toEqual([])
    expect(engine.count()).toBe(0)
  })

  it('关键词匹配返回法规条文', () => {
    const engine = new LegalRegulationSearchEngine(SAMPLE_RECORDS)
    const results = engine.search('违约责任')
    expect(results.length).toBeGreaterThan(0)
    // reg-001 and reg-003 both contain "违约责任" in articleText
    const ids = results.map(r => r.regulationId)
    expect(ids).toContain('reg-001')
  })

  it('去掉查询里的 NUL，只剩 NUL 时没有命中', () => {
    const engine = new LegalRegulationSearchEngine(SAMPLE_RECORDS)
    expect(engine.search('违约责任\u0000').map(hit => hit.regulationId)).toContain('reg-001')
    expect(engine.search('\u0000')).toEqual([])
    expect(engine.findByName('民法典\u0000').map(row => row.regulationId)).toContain('reg-001')
    expect(engine.findByName('\u0000')).toEqual([])
  })

  it('小于 1 或非有限的上限夹成至少一条，而不是清空或丢掉末条', () => {
    const engine = new LegalRegulationSearchEngine(SAMPLE_RECORDS)
    const visible = engine.search('中华人民共和国')
    expect(visible.map(hit => hit.regulationId).sort()).toEqual(['reg-001', 'reg-002', 'reg-004'])
    expect(engine.search('中华人民共和国', { limit: 0 })).toHaveLength(1)
    expect(engine.search('中华人民共和国', { limit: -1 })).toHaveLength(1)
    expect(engine.search('中华人民共和国', { limit: Number.NaN })).toEqual(visible)
  })

  it('已废止法规默认不返回', () => {
    const engine = new LegalRegulationSearchEngine(SAMPLE_RECORDS)
    const results = engine.search('合同法')
    // reg-003 is expired; should be filtered out by default
    const expiredIds = results.filter(r => r.validity === 'expired').map(r => r.regulationId)
    expect(expiredIds).toEqual([])
  })

  it('includeUnverified=false 收紧只返回可核验有效的记录', () => {
    const engine = new LegalRegulationSearchEngine(SAMPLE_RECORDS)
    const results = engine.search('民法典', { includeUnverified: false })
    expect(results.every(r => r.validity === 'in-force')).toBe(true)
  })

  it('level 过滤按法律层级筛选', () => {
    const engine = new LegalRegulationSearchEngine(SAMPLE_RECORDS)
    const results = engine.search('解释', { level: '司法解释' })
    expect(results.every(r => r.level === '司法解释')).toBe(true)
    expect(results.length).toBe(1)
    expect(results[0]!.regulationId).toBe('reg-004')
  })

  it('findByName 按法规名称模糊查找', () => {
    const engine = new LegalRegulationSearchEngine(SAMPLE_RECORDS)
    const results = engine.findByName('民法典')
    expect(results.length).toBeGreaterThan(0)
    expect(results.some(r => r.regulationName.includes('民法典'))).toBe(true)
  })

  it('getById 按 ID 精确查找', () => {
    const engine = new LegalRegulationSearchEngine(SAMPLE_RECORDS)
    const record = engine.getById('reg-002')
    expect(record).toBeDefined()
    expect(record?.regulationName).toBe('中华人民共和国专利法')
  })

  it('getById 已废止法规返回 undefined', () => {
    const engine = new LegalRegulationSearchEngine(SAMPLE_RECORDS)
    const record = engine.getById('reg-003')
    expect(record).toBeUndefined()
  })

  it('asOf 时点判定：法规在指定日期是否有效', () => {
    const engine = new LegalRegulationSearchEngine(SAMPLE_RECORDS)
    // reg-003 was effective from 1999-10-01 to 2020-12-31
    const results = engine.search('合同法', { asOf: '2020-06-01' })
    // At 2020-06-01, reg-003 should be in force (before expiry)
    const reg003 = results.find(r => r.regulationId === 'reg-003')
    expect(reg003).toBeDefined()
    expect(reg003?.validity).toBe('in-force')
  })

  it('addRecords 动态添加记录', () => {
    const engine = new LegalRegulationSearchEngine()
    expect(engine.count()).toBe(0)
    engine.addRecords(SAMPLE_RECORDS)
    expect(engine.count()).toBe(4)
  })

  it('结果包含 via 标记为 memory', () => {
    const engine = new LegalRegulationSearchEngine(SAMPLE_RECORDS)
    const results = engine.search('合同')
    expect(results.every(r => r.via === 'memory')).toBe(true)
  })
})
