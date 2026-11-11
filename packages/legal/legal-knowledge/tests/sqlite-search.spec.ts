import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CaseLawSearchEngine } from '@deepseek-ai/dsh-legal-knowledge'
import { LegalRegulationSearchEngine } from '@deepseek-ai/dsh-legal-knowledge'
import { JudicialInterpretationSearch } from '@deepseek-ai/dsh-legal-knowledge'
import {
  escapeFtsPhrase,
  extractLawKeywords,
  FTS_MIN_RUNES,
  joinFtsOrTerms,
  runFtsSearch,
  sqliteHasFts5,
} from '@deepseek-ai/dsh-legal-knowledge'

/** Create a minimal SQLite database with FTS5 tables for case-law. */
function createCaseLawDb(dbPath: string): void {
  mkdirSync(join(dbPath, '..'), { recursive: true })
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`
      CREATE TABLE case_law (
        id INTEGER PRIMARY KEY,
        case_id TEXT UNIQUE,
        doc_type TEXT,
        case_name TEXT,
        court TEXT,
        decision_date TEXT,
        case_number TEXT,
        case_type TEXT,
        full_text TEXT,
        summary TEXT
      );
      INSERT INTO case_law VALUES (
        1, 'case-001', 'judgment', '张三诉李四合同纠纷案',
        '北京市朝阳区人民法院', '2023-06-15', '(2023)京0105民初1234号',
        '民事', '本案涉及合同违约责任的认定问题。', '合同违约责任认定'
      );
      INSERT INTO case_law VALUES (
        2, 'case-002', 'judgment', '王五知识产权侵权案',
        '上海知识产权法院', '2023-08-20', '(2023)沪73民初5678号',
        '知识产权', '本案涉及专利侵权纠纷。', '专利侵权纠纷'
      );
    `)
    // Create FTS5 virtual table synced with case_law.
    db.exec(`
      CREATE VIRTUAL TABLE case_law_fts USING fts5(
        case_name, full_text, summary,
        content='case_law', content_rowid='id'
      );
      INSERT INTO case_law_fts(rowid, case_name, full_text, summary)
        SELECT id, case_name, full_text, summary FROM case_law;
    `)
  } finally {
    db.close()
  }
}

/** Create a minimal SQLite database with FTS5 tables for legal regulations. */
function createLegalRegulationsDb(dbPath: string): void {
  mkdirSync(join(dbPath, '..'), { recursive: true })
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`
      CREATE TABLE legal_regulations (
        id INTEGER PRIMARY KEY,
        regulation_id TEXT UNIQUE,
        regulation_name TEXT,
        level TEXT,
        publish_date TEXT,
        effective_date TEXT,
        expiry_date TEXT,
        expired INTEGER,
        article_number INTEGER,
        article_text TEXT
      );
      INSERT INTO legal_regulations VALUES (
        1, 'reg-001', '中华人民共和国民法典', '法律',
        '2020-05-28', '2021-01-01', NULL, 0, 577,
        '当事人一方不履行合同义务或者履行合同义务不符合约定的，应当承担继续履行、采取补救措施或者赔偿损失等违约责任。'
      );
      INSERT INTO legal_regulations VALUES (
        2, 'reg-002', '中华人民共和国专利法', '法律',
        '2020-10-17', '2021-06-01', NULL, 0, 22,
        '授予专利权的发明和实用新型，应当具备新颖性、创造性和实用性。'
      );
    `)
    db.exec(`
      CREATE VIRTUAL TABLE legal_regulations_fts USING fts5(
        regulation_name, article_text,
        content='legal_regulations', content_rowid='id'
      );
      INSERT INTO legal_regulations_fts(rowid, regulation_name, article_text)
        SELECT id, regulation_name, article_text FROM legal_regulations;
    `)
  } finally {
    db.close()
  }
}

/** Create a minimal SQLite database with FTS5 tables for judicial interpretations. */
function createJudicialInterpretationsDb(dbPath: string): void {
  mkdirSync(join(dbPath, '..'), { recursive: true })
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`
      CREATE TABLE judicial_interpretations (
        id INTEGER PRIMARY KEY,
        interpretation_id TEXT UNIQUE,
        interpretation_name TEXT,
        interpretation_type TEXT,
        issuing_body TEXT,
        document_number TEXT,
        publish_date TEXT,
        effective_date TEXT,
        expiry_date TEXT,
        expired INTEGER,
        article_number INTEGER,
        article_text TEXT
      );
      INSERT INTO judicial_interpretations VALUES (
        1, 'interp-001', '最高人民法院关于适用民法典合同编通则若干问题的解释',
        'judicial-interpretation', '最高人民法院', '法释〔2023〕12号',
        '2023-12-05', '2023-12-05', NULL, 0, 1,
        '为了正确审理合同纠纷案件，根据民法典的规定，结合审判实践，制定本解释。'
      );
      INSERT INTO judicial_interpretations VALUES (
        2, 'interp-002', '最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释',
        'judicial-interpretation', '最高人民法院', '法释〔2009〕21号',
        '2010-01-01', '2010-01-01', NULL, 0, 1,
        '人民法院应当根据权利人主张的权利要求，依据专利法第五十九条第一款的规定确定专利权的保护范围。'
      );
    `)
    db.exec(`
      CREATE VIRTUAL TABLE judicial_interpretations_fts USING fts5(
        interpretation_name, article_text,
        content='judicial_interpretations', content_rowid='id'
      );
      INSERT INTO judicial_interpretations_fts(rowid, interpretation_name, article_text)
        SELECT id, interpretation_name, article_text FROM judicial_interpretations;
    `)
    // Also create guiding_cases table.
    db.exec(`
      CREATE TABLE guiding_cases (
        id INTEGER PRIMARY KEY,
        case_id TEXT UNIQUE,
        guiding_case_number TEXT,
        case_name TEXT,
        court TEXT,
        decision_date TEXT,
        case_type TEXT,
        key_points TEXT,
        related_laws TEXT,
        full_text TEXT
      );
      INSERT INTO guiding_cases VALUES (
        1, 'gc-001', '指导案例1号', '上海中原物业顾问有限公司诉陶德华居间合同纠纷案',
        '上海市第二中级人民法院', '2011-12-20', '民事',
        '房屋买卖居间合同中关于买方独家委托的约定，不违反法律强制性规定，合法有效。',
        '["民法典第961条", "民法典第962条"]', '（指导案例1号全文内容）'
      );
    `)
  } finally {
    db.close()
  }
}

describe('SQLite FTS5 search', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'legal-knowledge-sqlite-'))
  })

  afterEach(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true })
  })

  describe('CaseLawSearchEngine', () => {
    it('SQLite FTS5 检索返回结果', () => {
      const dbPath = join(tempDir, 'case-law.db')
      createCaseLawDb(dbPath)
      const engine = new CaseLawSearchEngine({ dbPath })
      try {
        const results = engine.search('合同')
        expect(results.length).toBeGreaterThan(0)
        expect(results.some(r => r.caseId === 'case-001')).toBe(true)
        // FTS5 路径应标记 via 为 fts 或 like（取决于 FTS5 运行时可用性）
        expect(['fts', 'like']).toContain(results[0]!.via)
      } finally {
        engine.close()
      }
    })

    it('SQLite LIKE 降级检索', () => {
      const dbPath = join(tempDir, 'case-law-no-fts.db')
      // Create DB without FTS tables.
      mkdirSync(join(dbPath, '..'), { recursive: true })
      const db = new DatabaseSync(dbPath)
      try {
        db.exec(`
          CREATE TABLE case_law (
            id INTEGER PRIMARY KEY, case_id TEXT, doc_type TEXT, case_name TEXT,
            court TEXT, decision_date TEXT, case_number TEXT, case_type TEXT,
            full_text TEXT, summary TEXT
          );
          INSERT INTO case_law VALUES (
            1, 'case-001', 'judgment', '合同纠纷案', '北京法院',
            '2023-06-15', '(2023)001号', '民事', '合同违约', '违约'
          );
        `)
      } finally {
        db.close()
      }
      const engine = new CaseLawSearchEngine({ dbPath })
      try {
        const results = engine.search('合同')
        expect(results.length).toBeGreaterThan(0)
        expect(results[0]!.via).toBe('like')
      } finally {
        engine.close()
      }
    })

    it('内存 fallback 检索', () => {
      const engine = new CaseLawSearchEngine([
        {
          caseId: 'case-001',
          docType: 'judgment',
          caseName: '合同纠纷案',
          court: '北京法院',
          decisionDate: '2023-06-15',
          caseNumber: '(2023)001号',
          caseType: '民事',
          fullText: '合同违约',
          summary: '违约',
        },
      ])
      const results = engine.search('合同')
      expect(results.length).toBeGreaterThan(0)
      expect(results[0]!.via).toBe('memory')
    })

    it('非有限上限回退到案例默认值', () => {
      const engine = new CaseLawSearchEngine([
        {
          caseId: 'case-001',
          docType: 'judgment',
          caseName: '合同纠纷案',
          court: '北京法院',
          decisionDate: '2023-06-15',
          caseNumber: '(2023)001号',
          caseType: '民事',
          fullText: '合同违约',
          summary: '违约',
        },
      ])
      expect(engine.search('合同', { limit: Number.NaN })).toHaveLength(1)
      expect(engine.search('合同\u0000').map(hit => hit.caseId)).toEqual(['case-001'])
      expect(engine.search('\u0000')).toEqual([])
    })
  })

  describe('LegalRegulationSearchEngine', () => {
    it('SQLite FTS5 检索法规', () => {
      const dbPath = join(tempDir, 'legal.db')
      createLegalRegulationsDb(dbPath)
      const engine = new LegalRegulationSearchEngine({ dbPath })
      try {
        const results = engine.search('违约责任')
        expect(results.length).toBeGreaterThan(0)
        expect(results.some(r => r.regulationId === 'reg-001')).toBe(true)
      } finally {
        engine.close()
      }
    })

    it('负上限夹成 1 条，查询中的 NUL 不把 FTS 打成降级', () => {
      const dbPath = join(tempDir, 'legal-limit.db')
      createLegalRegulationsDb(dbPath)
      const engine = new LegalRegulationSearchEngine({ dbPath })
      try {
        expect(engine.search('中华人民共和国', { limit: -1 })).toHaveLength(1)
        expect(engine.ftsAvailable).toBe(true)
        expect(engine.search('违约责任\u0000').some(hit => hit.regulationId === 'reg-001')).toBe(true)
        expect(engine.ftsAvailable).toBe(true)
        expect(engine.search('\u0000')).toEqual([])
      } finally {
        engine.close()
      }
    })

    it('内存 fallback 检索法规', () => {
      const engine = new LegalRegulationSearchEngine([
        {
          regulationId: 'reg-001',
          regulationName: '民法典',
          level: '法律',
          effectiveDate: '2021-01-01',
          expired: 0,
          validity: 'in-force',
          articleNumber: 577,
          articleText: '违约责任条款',
        },
      ])
      const results = engine.search('违约')
      expect(results.length).toBeGreaterThan(0)
      expect(results[0]!.via).toBe('memory')
    })
  })

  describe('JudicialInterpretationSearch', () => {
    it('SQLite FTS5 检索司法解释', () => {
      const dbPath = join(tempDir, 'judicial.db')
      createJudicialInterpretationsDb(dbPath)
      const engine = new JudicialInterpretationSearch({ dbPath })
      try {
        const results = engine.search('合同')
        expect(results.length).toBeGreaterThan(0)
        expect(results.some(r => r.interpretationId === 'interp-001')).toBe(true)
      } finally {
        engine.close()
      }
    })

    it('SQLite 检索指导案例', () => {
      const dbPath = join(tempDir, 'judicial-gc.db')
      createJudicialInterpretationsDb(dbPath)
      const engine = new JudicialInterpretationSearch({ dbPath })
      try {
        const results = engine.searchGuidingCases('居间')
        expect(results.length).toBeGreaterThan(0)
        expect(results[0]!.caseId).toBe('gc-001')
        expect(engine.searchGuidingCases('居间\u0000').map(hit => hit.caseId)).toEqual(['gc-001'])
        expect(engine.searchGuidingCases('\u0000')).toEqual([])
        expect(engine.searchGuidingCases('居间', -1)).toHaveLength(1)
      } finally {
        engine.close()
      }
    })

    it('内存 fallback 检索司法解释', () => {
      const engine = new JudicialInterpretationSearch({
        interpretations: [
          {
            interpretationId: 'interp-001',
            interpretationName: '合同解释',
            interpretationType: 'judicial-interpretation',
            issuingBody: '最高人民法院',
            documentNumber: '法释〔2023〕1号',
            effectiveDate: '2023-01-01',
            expired: 0,
            validity: 'in-force',
            articleNumber: 1,
            articleText: '合同纠纷处理',
          },
        ],
      })
      const results = engine.search('合同')
      expect(results.length).toBeGreaterThan(0)
      expect(results[0]!.via).toBe('memory')
    })
  })
})

describe('FTS5 shared utilities', () => {
  it('FTS_MIN_RUNES 为 3', () => {
    expect(FTS_MIN_RUNES).toBe(3)
  })

  it('escapeFtsPhrase 转义双引号', () => {
    expect(escapeFtsPhrase('test"value')).toBe('"test""value"')
  })

  it('joinFtsOrTerms 构建 OR 查询', () => {
    expect(joinFtsOrTerms(['合同', '违约'])).toBe('"合同" OR "违约"')
  })

  it('extractLawKeywords 切分长查询', () => {
    const keywords = extractLawKeywords('专利侵权的赔偿标准是什么')
    expect(keywords.length).toBeGreaterThan(0)
    expect(keywords.every(k => Array.from(k).length >= FTS_MIN_RUNES)).toBe(true)
  })

  it('extractLawKeywords 过滤短片段', () => {
    const keywords = extractLawKeywords('的')
    expect(keywords).toEqual([])
  })

  it('sqliteHasFts5 探测运行时 FTS5 支持', () => {
    const db = new DatabaseSync(':memory:')
    try {
      const result = sqliteHasFts5(db)
      expect(typeof result).toBe('boolean')
    } finally {
      db.close()
    }
  })

  it('runFtsSearch 短查询直接走 LIKE', () => {
    let likeCalled = false
    const result = runFtsSearch({
      keyword: 'ab', // < FTS_MIN_RUNES
      hasFts: true,
      ftsDegraded: false,
      searchFts: () => { throw new Error('should not be called') },
      searchFtsKeywords: () => { throw new Error('should not be called') },
      searchLike: () => { likeCalled = true; return ['hit'] },
      degrade: () => {},
    })
    expect(likeCalled).toBe(true)
    expect(result).toEqual(['hit'])
  })

  it('runFtsSearch FTS 不可用时走 LIKE', () => {
    let likeCalled = false
    runFtsSearch({
      keyword: '合同违约',
      hasFts: false,
      ftsDegraded: false,
      searchFts: () => { throw new Error('should not be called') },
      searchFtsKeywords: () => { throw new Error('should not be called') },
      searchLike: () => { likeCalled = true; return [] },
      degrade: () => {},
    })
    expect(likeCalled).toBe(true)
  })

  it('runFtsSearch 粘性降级后走 LIKE', () => {
    let ftsCalled = false
    let likeCalled = false
    runFtsSearch({
      keyword: '合同违约',
      hasFts: true,
      ftsDegraded: true, // Already degraded.
      searchFts: () => { ftsCalled = true; return [] },
      searchFtsKeywords: () => { throw new Error('should not be called') },
      searchLike: () => { likeCalled = true; return [] },
      degrade: () => {},
    })
    expect(ftsCalled).toBe(false)
    expect(likeCalled).toBe(true)
  })

  it('runFtsSearch FTS 异常时降级并走 LIKE', () => {
    let degradeReason = ''
    let likeCalled = false
    const result = runFtsSearch({
      keyword: '合同违约',
      hasFts: true,
      ftsDegraded: false,
      searchFts: () => { throw new Error('FTS5 module missing') },
      searchFtsKeywords: () => { throw new Error('should not be called') },
      searchLike: () => { likeCalled = true; return ['fallback'] },
      degrade: (reason) => { degradeReason = reason },
    })
    expect(degradeReason).toBe('FTS5 module missing')
    expect(likeCalled).toBe(true)
    expect(result).toEqual(['fallback'])
  })
})
