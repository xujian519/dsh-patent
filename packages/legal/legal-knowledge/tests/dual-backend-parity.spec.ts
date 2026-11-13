/**
 * D22: the SQLite and in-memory backends must answer the same query with the
 * same records. Ranking may differ (BM25 vs term frequency); the matched set,
 * the filters, the caps, and the empty-result behavior may not.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CaseLawSearchEngine,
  JudicialInterpretationSearch,
  LegalRegulationSearchEngine,
} from '@deepseek-ai/dsh-legal-knowledge'
import type {
  CaseLawHit,
  CaseLawRecord,
  GuidingCaseHit,
  GuidingCaseRecord,
  JudicialInterpretationHit,
  JudicialInterpretationRecord,
  LegalRegulationHit,
  LegalRegulationRecord,
} from '@deepseek-ai/dsh-legal-knowledge'

const tempDirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'legal-knowledge-parity-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const CASES: CaseLawRecord[] = [
  {
    caseId: 'case-1',
    docType: 'judgment',
    caseName: '合同违约纠纷案',
    court: '北京市朝阳区人民法院',
    decisionDate: '2023-01-01',
    caseNumber: '(2023)京0105民初1号',
    caseType: '民事',
    fullText: '原告主张被告承担违约责任。',
    summary: '违约责任',
  },
  {
    caseId: 'case-2',
    docType: 'judgment',
    caseName: '专利侵权案',
    court: '上海知识产权法院',
    decisionDate: '2023-02-02',
    caseNumber: '(2023)沪73民初2号',
    caseType: '知识产权',
    fullText: '被告未经许可实施专利。',
    summary: '专利侵权',
  },
  {
    caseId: 'case-3',
    docType: 'guiding',
    caseName: '指导案例1号买卖合同',
    court: '最高人民法院',
    decisionDate: '2022-12-01',
    caseNumber: '指导案例1号',
    caseType: '民事',
    fullText: '买卖合同违约的损害赔偿范围。',
    summary: '违约损害赔偿',
  },
  {
    caseId: 'case-4',
    docType: 'judgment',
    caseName: '合同违约金调整案',
    court: '广州市中级人民法院',
    decisionDate: '2021-05-05',
    caseNumber: '(2021)粤01民终4号',
    caseType: '民事一审',
    fullText: '违约金过高的调整。',
    summary: '违约金调整',
  },
]

const REGULATIONS: LegalRegulationRecord[] = [
  {
    regulationId: 'reg-1',
    regulationName: '中华人民共和国民法典',
    level: '法律',
    effectiveDate: '2021-01-01',
    validity: 'unverified',
    articleNumber: 577,
    articleText: '当事人一方不履行合同义务的，应当承担违约责任。',
  },
  {
    regulationId: 'reg-2',
    regulationName: '已废止的合同法',
    level: '法律',
    effectiveDate: '1999-10-01',
    expiryDate: '2020-12-31',
    expired: 1,
    validity: 'unverified',
    articleNumber: 107,
    articleText: '违约责任的承担方式。',
  },
]

const INTERPRETATIONS: JudicialInterpretationRecord[] = [
  {
    interpretationId: 'interp-1',
    interpretationName: '关于适用民法典合同编通则若干问题的解释',
    interpretationType: 'judicial-interpretation',
    issuingBody: '最高人民法院',
    documentNumber: '法释〔2023〕13号',
    effectiveDate: '2023-12-05',
    validity: 'unverified',
    articleNumber: 1,
    articleText: '为了正确审理合同纠纷案件。',
  },
  {
    interpretationId: 'interp-2',
    interpretationName: '关于审理侵犯专利权纠纷案件应用法律若干问题的解释',
    interpretationType: 'judicial-interpretation',
    issuingBody: '最高人民法院',
    documentNumber: '法释〔2009〕21号',
    effectiveDate: '2010-01-01',
    validity: 'unverified',
    articleNumber: 1,
    articleText: '依据专利法第五十九条第一款确定保护范围。',
  },
]

const GUIDING_CASES: GuidingCaseRecord[] = [
  {
    caseId: 'gc-1',
    guidingCaseNumber: '指导案例1号',
    caseName: '上海中原物业顾问有限公司诉陶德华居间合同纠纷案',
    court: '上海市第二中级人民法院',
    decisionDate: '2011-12-20',
    caseType: '民事',
    keyPoints: '房屋买卖居间合同中买方独家委托约定的效力。',
    relatedLaws: ['民法典第961条'],
    fullText: '（指导案例1号全文）',
  },
  {
    caseId: 'gc-2',
    guidingCaseNumber: '指导案例2号',
    caseName: '另一起房屋居间合同纠纷案',
    court: '北京市第一中级人民法院',
    decisionDate: '2012-03-01',
    caseType: '民事',
    keyPoints: '居间人未促成合同成立不得要求报酬。',
    relatedLaws: [],
    fullText: '（指导案例2号全文）',
  },
]

function createCaseLawDb(path: string): void {
  const db = new DatabaseSync(path)
  try {
    db.exec(`
      CREATE TABLE case_law (
        id INTEGER PRIMARY KEY, case_id TEXT UNIQUE, doc_type TEXT, case_name TEXT, court TEXT,
        decision_date TEXT, case_number TEXT, case_type TEXT, full_text TEXT, summary TEXT
      );
      CREATE VIRTUAL TABLE case_law_fts USING fts5(
        case_name, full_text, summary, content='case_law', content_rowid='id'
      );
    `)
    for (const [index, record] of CASES.entries()) {
      db.prepare(`
        INSERT INTO case_law VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        index + 1, record.caseId, record.docType, record.caseName, record.court,
        record.decisionDate, record.caseNumber, record.caseType, record.fullText, record.summary ?? null,
      )
      db.prepare(`
        INSERT INTO case_law_fts(rowid, case_name, full_text, summary) VALUES (?, ?, ?, ?)
      `).run(index + 1, record.caseName, record.fullText, record.summary ?? '')
    }
  } finally {
    db.close()
  }
}

function createLegalDb(path: string): void {
  const db = new DatabaseSync(path)
  try {
    db.exec(`
      CREATE TABLE legal_regulations (
        id INTEGER PRIMARY KEY, regulation_id TEXT UNIQUE, regulation_name TEXT, level TEXT,
        publish_date TEXT, effective_date TEXT, expiry_date TEXT, expired INTEGER,
        article_number INTEGER, article_text TEXT
      );
      CREATE VIRTUAL TABLE legal_regulations_fts USING fts5(
        regulation_name, article_text, content='legal_regulations', content_rowid='id'
      );
    `)
    for (const [index, record] of REGULATIONS.entries()) {
      db.prepare(`
        INSERT INTO legal_regulations VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
      `).run(
        index + 1, record.regulationId, record.regulationName, record.level,
        record.effectiveDate, record.expiryDate ?? null, record.expired ?? null,
        record.articleNumber, record.articleText,
      )
      db.prepare(`
        INSERT INTO legal_regulations_fts(rowid, regulation_name, article_text) VALUES (?, ?, ?)
      `).run(index + 1, record.regulationName, record.articleText)
    }
  } finally {
    db.close()
  }
}

function createJudicialDb(path: string): void {
  const db = new DatabaseSync(path)
  try {
    db.exec(`
      CREATE TABLE judicial_interpretations (
        id INTEGER PRIMARY KEY, interpretation_id TEXT UNIQUE, interpretation_name TEXT,
        interpretation_type TEXT, issuing_body TEXT, document_number TEXT, publish_date TEXT,
        effective_date TEXT, expiry_date TEXT, expired INTEGER, article_number INTEGER, article_text TEXT
      );
      CREATE VIRTUAL TABLE judicial_interpretations_fts USING fts5(
        interpretation_name, article_text, document_number,
        content='judicial_interpretations', content_rowid='id'
      );
      CREATE TABLE guiding_cases (
        id INTEGER PRIMARY KEY, case_id TEXT UNIQUE, guiding_case_number TEXT, case_name TEXT,
        court TEXT, decision_date TEXT, case_type TEXT, key_points TEXT, related_laws TEXT, full_text TEXT
      );
    `)
    for (const [index, record] of INTERPRETATIONS.entries()) {
      db.prepare(`
        INSERT INTO judicial_interpretations VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?)
      `).run(
        index + 1, record.interpretationId, record.interpretationName, record.interpretationType,
        record.issuingBody, record.documentNumber, record.effectiveDate,
        record.articleNumber, record.articleText,
      )
      db.prepare(`
        INSERT INTO judicial_interpretations_fts(rowid, interpretation_name, article_text, document_number)
        VALUES (?, ?, ?, ?)
      `).run(index + 1, record.interpretationName, record.articleText, record.documentNumber)
    }
    for (const [index, record] of GUIDING_CASES.entries()) {
      db.prepare(`
        INSERT INTO guiding_cases VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        index + 1, record.caseId, record.guidingCaseNumber, record.caseName, record.court,
        record.decisionDate, record.caseType, record.keyPoints, JSON.stringify(record.relatedLaws),
        record.fullText,
      )
    }
  } finally {
    db.close()
  }
}

function ids(
  hits: Array<CaseLawHit | LegalRegulationHit | JudicialInterpretationHit | GuidingCaseHit>,
): string[] {
  return hits.map((hit) => {
    if ('caseId' in hit) return hit.caseId
    if ('regulationId' in hit) return hit.regulationId
    return hit.interpretationId
  }).sort()
}

describe('case-law dual-backend parity', () => {
  function engines(): { sqlite: CaseLawSearchEngine; memory: CaseLawSearchEngine } {
    const dbPath = join(tempDir(), 'case-law.db')
    createCaseLawDb(dbPath)
    return { sqlite: new CaseLawSearchEngine({ dbPath }), memory: new CaseLawSearchEngine(CASES) }
  }

  it('returns the same records for one keyword', () => {
    const { sqlite, memory } = engines()
    try {
      expect(ids(sqlite.search('违约'))).toEqual(ids(memory.search('违约')))
      expect(ids(sqlite.search('居间'))).toEqual(ids(memory.search('居间')))
    } finally {
      sqlite.close()
      memory.close()
    }
  })

  it('returns the same records for a multi-term query', () => {
    const { sqlite, memory } = engines()
    try {
      expect(ids(sqlite.search('合同 违约'))).toEqual(ids(memory.search('合同 违约')))
      expect(ids(sqlite.search('合同，违约'))).toEqual(ids(memory.search('合同，违约')))
    } finally {
      sqlite.close()
      memory.close()
    }
  })

  it('matches the same searchable columns on both backends', () => {
    const { sqlite, memory } = engines()
    try {
      // Court, case number, and case type are filters, not indexed columns.
      for (const query of ['上海知识产权法院', '(2023)沪73民初2号', '民事一审']) {
        expect(ids(sqlite.search(query))).toEqual(ids(memory.search(query)))
      }
      expect(ids(sqlite.search('上海知识产权法院'))).toEqual([])
    } finally {
      sqlite.close()
      memory.close()
    }
  })

  it('applies enum filters by exact value on both backends', () => {
    const { sqlite, memory } = engines()
    try {
      const options = { caseType: '民事' }
      expect(ids(sqlite.search('违约', options))).toEqual(ids(memory.search('违约', options)))
      // `民事一审` is not the exact value `民事`.
      expect(ids(memory.search('违约', options))).not.toContain('case-4')
    } finally {
      sqlite.close()
      memory.close()
    }
  })

  it('keeps the court filter a containment match on both backends', () => {
    const { sqlite, memory } = engines()
    try {
      const options = { court: '上海' }
      expect(ids(sqlite.search('专利', options))).toEqual(ids(memory.search('专利', options)))
      expect(ids(memory.search('专利', options))).toEqual(['case-2'])
    } finally {
      sqlite.close()
      memory.close()
    }
  })

  it('caps both backends at the requested limit', () => {
    const { sqlite, memory } = engines()
    try {
      for (const limit of [1, 2]) {
        expect(sqlite.search('违约', { limit })).toHaveLength(limit)
        expect(memory.search('违约', { limit })).toHaveLength(limit)
      }
    } finally {
      sqlite.close()
      memory.close()
    }
  })

  it('returns no hits on both backends for empty and unmatched queries', () => {
    const { sqlite, memory } = engines()
    try {
      for (const query of ['', '   ', '\u0000', '，。', '不存在的词条']) {
        expect(sqlite.search(query)).toEqual([])
        expect(memory.search(query)).toEqual([])
      }
    } finally {
      sqlite.close()
      memory.close()
    }
  })
})

describe('regulation dual-backend parity', () => {
  function engines(): { sqlite: LegalRegulationSearchEngine; memory: LegalRegulationSearchEngine } {
    const dbPath = join(tempDir(), 'legal.db')
    createLegalDb(dbPath)
    return { sqlite: new LegalRegulationSearchEngine({ dbPath }), memory: new LegalRegulationSearchEngine(REGULATIONS) }
  }

  it('returns the same visible records and hides expired ones on both backends', () => {
    const { sqlite, memory } = engines()
    try {
      const options = { asOf: '2025-01-01' }
      expect(ids(sqlite.search('违约', options))).toEqual(ids(memory.search('违约', options)))
      expect(ids(memory.search('违约', options))).toEqual(['reg-1'])
      expect(ids(sqlite.search('违约', { ...options, includeUnverified: false })))
        .toEqual(ids(memory.search('违约', { ...options, includeUnverified: false })))
    } finally {
      sqlite.close()
      memory.close()
    }
  })

  it('matches regulation names on both backends', () => {
    const { sqlite, memory } = engines()
    try {
      const options = { asOf: '2025-01-01' }
      expect(ids(sqlite.search('合同法', options))).toEqual(ids(memory.search('合同法', options)))
      expect(ids(memory.search('合同法', options))).toEqual([])
    } finally {
      sqlite.close()
      memory.close()
    }
  })
})

describe('judicial-interpretation dual-backend parity', () => {
  function engines(): { sqlite: JudicialInterpretationSearch; memory: JudicialInterpretationSearch } {
    const dbPath = join(tempDir(), 'judicial.db')
    createJudicialDb(dbPath)
    return {
      sqlite: new JudicialInterpretationSearch({ dbPath }),
      memory: new JudicialInterpretationSearch({
        interpretations: INTERPRETATIONS,
        guidingCases: GUIDING_CASES,
      }),
    }
  }

  it('returns the same interpretations by name, article, and document number', () => {
    const { sqlite, memory } = engines()
    try {
      for (const query of ['合同', '专利法第五十九条', '法释〔2023〕13号']) {
        expect(ids(sqlite.search(query))).toEqual(ids(memory.search(query)))
      }
      expect(ids(memory.search('法释〔2023〕13号'))).toEqual(['interp-1'])
    } finally {
      sqlite.close()
      memory.close()
    }
  })

  it('returns the same guiding cases by number and content', () => {
    const { sqlite, memory } = engines()
    try {
      for (const query of ['指导案例1号', '居间', '指导案例2号']) {
        expect(ids(sqlite.searchGuidingCases(query))).toEqual(ids(memory.searchGuidingCases(query)))
      }
      expect(ids(memory.searchGuidingCases('指导案例1号'))).toEqual(['gc-1'])
    } finally {
      sqlite.close()
      memory.close()
    }
  })

  it('caps guiding cases on both backends', () => {
    const { sqlite, memory } = engines()
    try {
      expect(sqlite.searchGuidingCases('居间', 1)).toHaveLength(1)
      expect(memory.searchGuidingCases('居间', 1)).toHaveLength(1)
    } finally {
      sqlite.close()
      memory.close()
    }
  })
})
