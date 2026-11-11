import { describe, expect, it } from 'vitest'
import { JudicialInterpretationSearch } from '@deepseek-ai/dsh-legal-knowledge'
import type { GuidingCaseRecord, JudicialInterpretationRecord } from '@deepseek-ai/dsh-legal-knowledge'

const SAMPLE_INTERPRETATIONS: JudicialInterpretationRecord[] = [
  {
    interpretationId: 'interp-001',
    interpretationName: '最高人民法院关于适用《中华人民共和国民法典》合同编通则若干问题的解释',
    interpretationType: 'judicial-interpretation',
    issuingBody: '最高人民法院',
    documentNumber: '法释〔2023〕12号',
    effectiveDate: '2023-12-05',
    publishDate: '2023-06-28',
    expired: 0,
    validity: 'in-force',
    articleNumber: 1,
    articleText: '为了正确审理合同纠纷案件，根据《中华人民共和国民法典》的规定，结合审判实践，制定本解释。',
  },
  {
    interpretationId: 'interp-002',
    interpretationName: '最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释',
    interpretationType: 'judicial-interpretation',
    issuingBody: '最高人民法院',
    documentNumber: '法释〔2009〕21号',
    effectiveDate: '2010-01-01',
    publishDate: '2009-12-28',
    expired: 0,
    validity: 'in-force',
    articleNumber: 1,
    articleText: '人民法院应当根据权利人主张的权利要求，依据专利法第五十九条第一款的规定确定专利权的保护范围。',
  },
  {
    interpretationId: 'interp-003',
    interpretationName: '最高人民法院关于废止部分司法解释及相关规范性文件的决定',
    interpretationType: 'judicial-interpretation',
    issuingBody: '最高人民法院',
    documentNumber: '法释〔2020〕16号',
    effectiveDate: '2021-01-01',
    expiryDate: '2020-12-31',
    publishDate: '2020-12-23',
    expired: 1,
    validity: 'expired',
    articleNumber: 1,
    articleText: '为切实实施民法典，保证国家法律的统一适用，决定废止部分司法解释及相关规范性文件。',
  },
]

const SAMPLE_GUIDING_CASES: GuidingCaseRecord[] = [
  {
    caseId: 'gc-001',
    guidingCaseNumber: '指导案例1号',
    caseName: '上海中原物业顾问有限公司诉陶德华居间合同纠纷案',
    court: '上海市第二中级人民法院',
    decisionDate: '2011-12-20',
    caseType: '民事',
    keyPoints: '房屋买卖居间合同中关于买方独家委托的约定，不违反法律强制性规定，合法有效。',
    relatedLaws: ['民法典第961条', '民法典第962条'],
    fullText: '（指导案例1号全文内容）...',
  },
  {
    caseId: 'gc-002',
    guidingCaseNumber: '指导案例20号',
    caseName: '深圳市斯瑞曼精细化工有限公司诉深圳市坑梓自来水有限公司等侵犯发明专利权纠纷案',
    court: '广东省高级人民法院',
    decisionDate: '2012-04-18',
    caseType: '知识产权',
    keyPoints: '发明专利申请公布后至专利权授予前使用发明而未支付适当费用的，专利权人可以要求支付。',
    relatedLaws: ['专利法第13条', '专利法第68条'],
    fullText: '（指导案例20号全文内容）...',
  },
]

describe('JudicialInterpretationSearch', () => {
  describe('司法解释检索', () => {
    it('空库检索返回空数组', () => {
      const search = new JudicialInterpretationSearch()
      expect(search.search('合同')).toEqual([])
      expect(search.countInterpretations()).toBe(0)
    })

    it('关键词匹配返回司法解释', () => {
      const search = new JudicialInterpretationSearch({ interpretations: SAMPLE_INTERPRETATIONS })
      const results = search.search('合同')
      expect(results.length).toBeGreaterThan(0)
      expect(results.some(r => r.interpretationName.includes('合同'))).toBe(true)
    })

    it('已废止司法解释默认不返回', () => {
      const search = new JudicialInterpretationSearch({ interpretations: SAMPLE_INTERPRETATIONS })
      const results = search.search('废止')
      const expired = results.filter(r => r.validity === 'expired')
      expect(expired).toEqual([])
    })

    it('interpretationType 过滤', () => {
      const search = new JudicialInterpretationSearch({ interpretations: SAMPLE_INTERPRETATIONS })
      const results = search.search('专利权', { interpretationType: 'judicial-interpretation' })
      expect(results.every(r => r.interpretationType === 'judicial-interpretation')).toBe(true)
    })

    it('getById 按 ID 精确查找', () => {
      const search = new JudicialInterpretationSearch({ interpretations: SAMPLE_INTERPRETATIONS })
      const record = search.getById('interp-002')
      expect(record).toBeDefined()
      expect(record?.interpretationName).toContain('专利权')
    })

    it('getById 已废止记录返回 undefined', () => {
      const search = new JudicialInterpretationSearch({ interpretations: SAMPLE_INTERPRETATIONS })
      const record = search.getById('interp-003')
      expect(record).toBeUndefined()
    })

    it('addInterpretations 动态添加记录', () => {
      const search = new JudicialInterpretationSearch()
      expect(search.countInterpretations()).toBe(0)
      search.addInterpretations(SAMPLE_INTERPRETATIONS)
      expect(search.countInterpretations()).toBe(3)
    })
  })

  describe('指导案例检索', () => {
    it('空库检索返回空数组', () => {
      const search = new JudicialInterpretationSearch()
      expect(search.searchGuidingCases('居间')).toEqual([])
      expect(search.countGuidingCases()).toBe(0)
    })

    it('关键词匹配返回指导案例', () => {
      const search = new JudicialInterpretationSearch({ guidingCases: SAMPLE_GUIDING_CASES })
      const results = search.searchGuidingCases('居间')
      expect(results.length).toBe(1)
      expect(results[0]!.caseId).toBe('gc-001')
    })

    it('专利相关指导案例检索', () => {
      const search = new JudicialInterpretationSearch({ guidingCases: SAMPLE_GUIDING_CASES })
      const results = search.searchGuidingCases('专利')
      expect(results.length).toBe(1)
      expect(results[0]!.caseId).toBe('gc-002')
    })

    it('getGuidingCaseById 按 ID 查找', () => {
      const search = new JudicialInterpretationSearch({ guidingCases: SAMPLE_GUIDING_CASES })
      const record = search.getGuidingCaseById('gc-001')
      expect(record).toBeDefined()
      expect(record?.guidingCaseNumber).toBe('指导案例1号')
    })

    it('addGuidingCases 动态添加记录', () => {
      const search = new JudicialInterpretationSearch()
      search.addGuidingCases(SAMPLE_GUIDING_CASES)
      expect(search.countGuidingCases()).toBe(2)
    })

    it('limit 限制返回数量', () => {
      const search = new JudicialInterpretationSearch({ guidingCases: SAMPLE_GUIDING_CASES })
      expect(search.searchGuidingCases('案例')).toHaveLength(2)
      expect(search.searchGuidingCases('案例', 1)).toHaveLength(1)
      expect(search.searchGuidingCases('案例', 0)).toHaveLength(1)
      expect(search.searchGuidingCases('案例', -1)).toHaveLength(1)
    })
  })

  describe('混合检索', () => {
    it('同时拥有司法解释和指导案例的引擎', () => {
      const search = new JudicialInterpretationSearch({
        interpretations: SAMPLE_INTERPRETATIONS,
        guidingCases: SAMPLE_GUIDING_CASES,
      })
      expect(search.countInterpretations()).toBe(3)
      expect(search.countGuidingCases()).toBe(2)

      const interpResults = search.search('合同')
      expect(interpResults.length).toBeGreaterThan(0)

      const caseResults = search.searchGuidingCases('合同')
      expect(caseResults.length).toBeGreaterThan(0)
    })
  })
})
