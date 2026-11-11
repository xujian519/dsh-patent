/** SQLite and memory branches of the legal-knowledge engines, row mapping, and shared helpers. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { CaseLawSearchEngine } from '../src/case-law/search.ts'
import { LegalRegulationSearchEngine } from '../src/legal/search.ts'
import { JudicialInterpretationSearch } from '../src/judicial-interpretation/search.ts'
import { SqliteFtsTable, type SqliteSearchShape } from '../src/shared/sqlite-search.ts'
import { articleRowColumns, assignDatedColumns, columnText } from '../src/shared/row-text.ts'
import { filterRecords, searchInMemory, toVisibleMemoryHits } from '../src/shared/memory-store.ts'
import { filterByValidity } from '../src/shared/validity.ts'
import type { LegalRegulationRecord } from '../src/types.ts'

const tempDirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'legal-knowledge-branches-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function createDb(path: string, statements: string): void {
  const db = new DatabaseSync(path)
  try {
    db.exec(statements)
  } finally {
    db.close()
  }
}

function caseLawDb(): string {
  const path = join(tempDir(), 'case.db')
  createDb(path, `
    CREATE TABLE case_law (
      id INTEGER PRIMARY KEY, case_id TEXT, doc_type TEXT, case_name TEXT, court TEXT,
      decision_date TEXT, case_number TEXT, case_type TEXT, full_text TEXT, summary TEXT,
      caseId TEXT, docType TEXT, caseName TEXT, decisionDate TEXT, caseNumber TEXT, caseType TEXT, fullText TEXT
    );
    INSERT INTO case_law VALUES (
      1, 'case-1', 'judgment', 'Contract breach', 'Beijing court', '2023-01-01', 'N-1', 'civil',
      'breach of contract', 'summary one', NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    INSERT INTO case_law VALUES (
      2, NULL, NULL, 'Second English', NULL, NULL, NULL, NULL, 'second text', NULL,
      'case-2', 'guiding', 'Second case', '2024-01-01', 'N-2', 'ip', NULL
    );
    INSERT INTO case_law VALUES (
      3, 'case-3', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, 'judgment', 'Third case', '2022-03-04', 'N-3', 'civil', NULL
    );
    INSERT INTO case_law VALUES (
      4, 'case-4', 'judgment', '合同违约案', '上海法院', '2021-01-01', 'N-4', 'civil',
      '合同违约的认定', '合同责任', NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    INSERT INTO case_law VALUES (
      5, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'baretext', NULL,
      'case-5', NULL, 'Camel name', NULL, NULL, NULL, NULL
    );
    INSERT INTO case_law VALUES (
      6, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'bareboth', NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    INSERT INTO case_law VALUES (
      7, NULL, NULL, 'Seven', NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, 'camel full text'
    );
    CREATE VIRTUAL TABLE case_law_fts USING fts5(
      case_name, full_text, summary, content='case_law', content_rowid='id'
    );
    INSERT INTO case_law_fts(rowid, case_name, full_text, summary)
      SELECT id, coalesce(case_name, ''), coalesce(full_text, ''), coalesce(summary, '') FROM case_law;
  `)
  return path
}

function legalDb(): string {
  const path = join(tempDir(), 'legal.db')
  createDb(path, `
    CREATE TABLE legal_regulations (
      id INTEGER PRIMARY KEY, regulation_id TEXT, regulation_name TEXT, level TEXT,
      publish_date TEXT, effective_date TEXT, expiry_date TEXT, expired INTEGER,
      article_number INTEGER, article_text TEXT, source_path TEXT,
      regulationId TEXT, regulationName TEXT, publishDate TEXT, effectiveDate TEXT,
      expiryDate TEXT, articleNumber INTEGER, articleText TEXT, sourcePath TEXT
    );
    INSERT INTO legal_regulations VALUES (
      1, 'reg-1', 'Contract law', '法律', '2020-05-28', '2021-01-01', NULL, 0, 577,
      'contract obligations', 'docs/reg-1.yaml', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    INSERT INTO legal_regulations VALUES (
      2, 'reg-2', '民法典', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'reg-camel', '民法典（别名）', '2021-02-03', '2021-03-04', '2030-01-01', 12, 'camel article', 'camel/reg.yaml'
    );
    INSERT INTO legal_regulations VALUES (
      3, 'reg-3', 'Expired law', '法律', NULL, '2000-01-01', '2001-01-01', 1, 1, 'expired text', NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    INSERT INTO legal_regulations VALUES (
      4, 'reg-4', 'Unknown validity', '其他', NULL, NULL, NULL, NULL, 1, 'unknown text', NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    INSERT INTO legal_regulations VALUES (
      5, 'reg-5', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, 'Camel record name', '2021-04-05', '2021-05-06', '2030-02-02', 21, 'camel record text', 'camel/record.yaml'
    );
    INSERT INTO legal_regulations VALUES (
      6, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'reg-camel-hit', 'Camel hit', '2021-06-07', '2021-07-08', '2030-03-03', 22, 'camel hit text', 'camel/hit.yaml'
    );
    CREATE VIRTUAL TABLE legal_regulations_fts USING fts5(
      regulation_name, article_text, content='legal_regulations', content_rowid='id'
    );
    INSERT INTO legal_regulations_fts(rowid, regulation_name, article_text)
      SELECT id, coalesce(regulation_name, ''), coalesce(article_text, '') FROM legal_regulations WHERE id <> 6;
    INSERT INTO legal_regulations_fts(rowid, regulation_name, article_text) VALUES (6, 'Camel hit', 'camelhit');
  `)
  return path
}

function judicialDb(): string {
  const path = join(tempDir(), 'judicial.db')
  createDb(path, `
    CREATE TABLE judicial_interpretations (
      id INTEGER PRIMARY KEY, interpretation_id TEXT, interpretation_name TEXT, interpretation_type TEXT,
      issuing_body TEXT, document_number TEXT, publish_date TEXT, effective_date TEXT, expiry_date TEXT,
      expired INTEGER, article_number INTEGER, article_text TEXT, source_path TEXT,
      interpretationId TEXT, interpretationName TEXT, interpretationType TEXT, issuingBody TEXT,
      documentNumber TEXT, publishDate TEXT, effectiveDate TEXT, expiryDate TEXT,
      articleNumber INTEGER, articleText TEXT, sourcePath TEXT
    );
    INSERT INTO judicial_interpretations VALUES (
      1, 'interp-1', 'Contract interpretation', 'judicial-interpretation', 'SPC', '法释1',
      '2023-01-01', '2023-02-01', NULL, 0, 1, 'contract guidance', 'docs/i1.yaml',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    INSERT INTO judicial_interpretations VALUES (
      2, 'interp-2', 'Camel interpretation', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'interp-camel', 'Camel name', 'guiding-case', 'SPC camel', '法释2',
      '2022-01-01', '2022-02-01', '2030-01-01', 7, 'camel interpretation text', 'camel/i2.yaml'
    );
    INSERT INTO judicial_interpretations VALUES (
      3, 'interp-3', 'Expired interpretation', 'judicial-interpretation', 'SPC', '法释3',
      NULL, '2000-01-01', '2001-01-01', 1, 1, 'expired', NULL,
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    INSERT INTO judicial_interpretations VALUES (
      4, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'interp-camel-hit', 'Camel hit', 'guiding-case', 'SPC camel hit', '法释4',
      '2022-03-04', '2022-04-05', '2030-04-04', 8, 'camel hit text', 'camel/hit.yaml'
    );
    INSERT INTO judicial_interpretations VALUES (
      5, 'interp-5', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, 'Camel record', 'guiding-case', 'SPC record', '法释5',
      '2022-05-06', '2022-06-07', '2030-05-05', 9, 'camel record text', 'camel/record.yaml'
    );
    INSERT INTO judicial_interpretations VALUES (
      6, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'bareinterp', NULL,
      'interp-bare', 'Bare name', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    CREATE VIRTUAL TABLE judicial_interpretations_fts USING fts5(
      interpretation_name, article_text, document_number, content='judicial_interpretations', content_rowid='id'
    );
    INSERT INTO judicial_interpretations_fts(rowid, interpretation_name, article_text, document_number)
      SELECT id, coalesce(interpretation_name, ''), coalesce(article_text, ''), coalesce(document_number, '')
      FROM judicial_interpretations WHERE id <> 4;
    INSERT INTO judicial_interpretations_fts(rowid, interpretation_name, article_text, document_number)
      VALUES (4, 'Camel hit', 'camelhit', '法释4');
    CREATE TABLE guiding_cases (
      id INTEGER PRIMARY KEY, case_id TEXT, guiding_case_number TEXT, case_name TEXT, court TEXT,
      decision_date TEXT, case_type TEXT, key_points TEXT, related_laws TEXT, full_text TEXT,
      caseId TEXT, guidingCaseNumber TEXT, caseName TEXT, decisionDate TEXT, caseType TEXT,
      keyPoints TEXT, relatedLaws TEXT, fullText TEXT
    );
    INSERT INTO guiding_cases VALUES (
      1, 'gc-1', 'Case 1', 'Alpha guiding case', 'Court A', '2011-01-01', 'civil',
      'alpha key point', '["Article 1", "Article 2"]', 'alpha full text',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    INSERT INTO guiding_cases VALUES (
      2, 'gc-2', 'Case 2', 'Beta guiding case', 'Court B', '2012-02-02', 'civil',
      'beta key point', 'Article 1, Article 2', 'beta full text',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    INSERT INTO guiding_cases VALUES (
      3, 'gc-3', 'Case 3', 'Gamma English', 'Court C', '2013-03-03', 'ip',
      'gamma key point', '{"not":"an array"}', 'gamma full text',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    INSERT INTO guiding_cases VALUES (
      4, 'gc-4', 'Case 4', 'Delta English', 'Court D', '2014-04-04', 'ip',
      'delta key point', 42, 'delta full text',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    INSERT INTO guiding_cases VALUES (
      5, 'gc-5', 'Case 5', 'Epsilon English', 'Court E', '2015-05-05', 'ip',
      'epsilon key point', '[not json', 'epsilon full text',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
    INSERT INTO guiding_cases VALUES (
      6, NULL, NULL, 'Zeta English', NULL, NULL, NULL, NULL, NULL, NULL,
      'gc-6', 'Case 6', 'Zeta camel', '2016-06-06', 'ip', 'zeta key point', '[]', 'zeta full text'
    );
    INSERT INTO guiding_cases VALUES (
      7, 'gc-7', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      NULL, 'Case 7', 'Camel record case', '2017-07-07', 'civil', 'eta key point', '[]', 'eta full text'
    );
    INSERT INTO guiding_cases VALUES (
      8, 'gc-8', 'Case 8', 'Theta guiding case', 'Court F', '2018-08-08', 'civil',
      'theta key point', X'00', 'theta full text',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    );
  `)
  return path
}

describe('CaseLawSearchEngine SQLite branches', () => {
  it('maps FTS, camel-case, and bare rows into hits', () => {
    const engine = new CaseLawSearchEngine({ dbPath: caseLawDb() })
    try {
      expect(engine.ftsAvailable).toBe(true)
      const fts = engine.search('contract')
      expect(fts[0]).toMatchObject({ caseId: 'case-1', court: 'Beijing court', via: 'fts', summary: 'summary one' })
      expect(typeof fts[0]?.relevanceScore).toBe('number')

      const camel = engine.search('second')
      expect(camel[0]).toMatchObject({
        caseId: 'case-2', docType: 'guiding', caseName: 'Second English', decisionDate: '2024-01-01',
        caseNumber: 'N-2', caseType: 'ip', via: 'fts',
      })
      expect(camel[0]).not.toHaveProperty('summary')

      const chinese = engine.search('合同')
      expect(chinese.some(hit => hit.caseId === 'case-4')).toBe(true)

      const bare = engine.search('baretext')[0]
      expect(bare).toMatchObject({ caseId: 'case-5', docType: 'judgment', caseName: 'Camel name' })
      const both = engine.search('bareboth')[0]
      expect(both).toMatchObject({ caseId: '', docType: 'judgment', caseName: '' })
      const camelFull = engine.search('Seven')[0]
      expect(camelFull).toMatchObject({ caseName: 'Seven', fullText: 'camel full text' })
    } finally {
      engine.close()
    }
  })

  it('applies docType, court escaping, and caseType filters in SQL', () => {
    const engine = new CaseLawSearchEngine({ dbPath: caseLawDb() })
    try {
      expect(engine.search('contract', { docType: 'guiding' })).toEqual([])
      expect(engine.search('contract', { court: 'Beijing' })[0]?.caseId).toBe('case-1')
      expect(engine.search('contract', { court: 'Beijing%' })).toEqual([])
      expect(engine.search('contract', { court: 'No_such' })).toEqual([])
      expect(engine.search('contract', { caseType: 'civil' })[0]?.caseId).toBe('case-1')
      expect(engine.search('contract', { limit: 1 })).toHaveLength(1)
    } finally {
      engine.close()
    }
  })

  it('reads records, counts, and additions through the database', () => {
    const engine = new CaseLawSearchEngine({ dbPath: caseLawDb() })
    try {
      expect(engine.getById('case-1')?.summary).toBe('summary one')
      expect(engine.getById('case-3')).toMatchObject({
        caseId: 'case-3', docType: 'judgment', caseName: '', decisionDate: '', caseNumber: '',
        caseType: '', fullText: '',
      })
      expect(engine.getById('missing')).toBeUndefined()
      expect(engine.count()).toBe(7)
      engine.addRecords([{
        caseId: 'ignored', docType: 'judgment', caseName: 'ignored', court: '', decisionDate: '',
        caseNumber: '', caseType: '', fullText: '',
      }])
      expect(engine.count()).toBe(7)
      expect(engine.ftsAvailable).toBe(true)
    } finally {
      engine.close()
    }
  })

  it('searches memory records that carry no summary', () => {
    const engine = new CaseLawSearchEngine([{
      caseId: 'no-summary', docType: 'judgment', caseName: 'Memory case', court: 'Court',
      decisionDate: '2020-01-01', caseNumber: 'N', caseType: 'civil', fullText: 'memory text',
    }])
    try {
      expect(engine.search('memory')[0]).toMatchObject({ caseId: 'no-summary', via: 'memory' })
    } finally {
      engine.close()
    }
  })

  it('falls back to LIKE when a summary column is absent', () => {
    const path = join(tempDir(), 'no-summary.db')
    createDb(path, `
      CREATE TABLE case_law (
        id INTEGER PRIMARY KEY, case_id TEXT, doc_type TEXT, case_name TEXT, court TEXT,
        decision_date TEXT, case_number TEXT, case_type TEXT, full_text TEXT
      );
      INSERT INTO case_law VALUES (1, 'c1', 'judgment', 'No summary', 'Court', '2020-01-01', 'N', 'civil', 'text');
    `)
    const engine = new CaseLawSearchEngine({ dbPath: path })
    try {
      expect(engine.search('summary')).toEqual([])
      expect(engine.getById('c1')?.caseId).toBe('c1')
    } finally {
      engine.close()
    }
  })
})

describe('LegalRegulationSearchEngine SQLite branches', () => {
  it('maps snake and camel rows with validity filtering', () => {
    const engine = new LegalRegulationSearchEngine({ dbPath: legalDb() })
    try {
      const hits = engine.search('contract', { asOf: '2025-01-01' })
      expect(hits[0]).toMatchObject({
        regulationId: 'reg-1', regulationName: 'Contract law', level: '法律', validity: 'in-force',
        effectiveDate: '2021-01-01', articleNumber: 577, articleText: 'contract obligations',
      })
      expect(hits[0]?.publishDate).toBe('2020-05-28')
      expect(hits[0]?.expired).toBe(0)
      expect(hits[0]?.sourcePath).toBe('docs/reg-1.yaml')
      expect(hits[0]?.via).toBe('fts')
    } finally {
      engine.close()
    }
  })

  it('maps camel-case hits and the level fallback', () => {
    const engine = new LegalRegulationSearchEngine({ dbPath: legalDb() })
    try {
      const camel = engine.search('camelhit', { asOf: '2025-01-01' })
      expect(camel[0]).toMatchObject({
        regulationId: 'reg-camel-hit', regulationName: 'Camel hit', level: '其他', validity: 'in-force',
        effectiveDate: '2021-07-08', expiryDate: '2030-03-03', articleNumber: 22,
        articleText: 'camel hit text', sourcePath: 'camel/hit.yaml', via: 'fts',
      })
      expect(camel[0]?.publishDate).toBe('2021-06-07')

      const named = engine.search('民法典', { asOf: '2025-01-01' })
      expect(named[0]).toMatchObject({
        regulationId: 'reg-2', regulationName: '民法典', level: '其他', validity: 'in-force',
      })
    } finally {
      engine.close()
    }
  })

  it('filters expired and unverified records through the query options', () => {
    const engine = new LegalRegulationSearchEngine({ dbPath: legalDb() })
    try {
      expect(engine.search('expired', { asOf: '2025-01-01' })).toEqual([])
      expect(engine.search('unknown', { asOf: '2025-01-01' }).map(hit => hit.regulationId)).toEqual(['reg-4'])
      expect(engine.search('unknown', { asOf: '2025-01-01', includeUnverified: false })).toEqual([])
      expect(engine.search('合同', { asOf: '2025-01-01', level: '其他' })).toEqual([])
    } finally {
      engine.close()
    }
  })

  it('finds by name, reads by id, counts, and caps in SQL', () => {
    const engine = new LegalRegulationSearchEngine({ dbPath: legalDb() })
    try {
      expect(engine.findByName('民法典', 10, { asOf: '2025-01-01' }).map(item => item.regulationId))
        .toEqual(['reg-2'])
      expect(engine.search('民法典', { asOf: '2025-01-01' })[0]?.regulationId).toBe('reg-2')
      expect(engine.findByName('law', 1, { asOf: '2025-01-01' })).toHaveLength(1)
      expect(engine.findByName('missing')).toEqual([])
      expect(engine.findByName('expired', 10, { asOf: '2025-01-01' })).toEqual([])
      expect(engine.getById('reg-1', { asOf: '2025-01-01' })?.validity).toBe('in-force')
      expect(engine.getById('reg-2', { asOf: '2025-01-01' })).toMatchObject({
        regulationName: '民法典', level: '其他', articleNumber: 12, articleText: 'camel article',
      })
      expect(engine.getById('reg-5', { asOf: '2025-01-01' })).toMatchObject({
        regulationId: 'reg-5', regulationName: 'Camel record name', level: '其他',
        effectiveDate: '2021-05-06', expiryDate: '2030-02-02', articleNumber: 21,
        articleText: 'camel record text', sourcePath: 'camel/record.yaml',
      })
      expect(engine.getById('missing')).toBeUndefined()
      expect(engine.getById('reg-4', { includeUnverified: false })).toBeUndefined()
      expect(engine.count()).toBe(6)
      engine.addRecords([{
        regulationId: 'ignored', regulationName: 'ignored', level: '其他', effectiveDate: '',
        validity: 'unverified', articleNumber: 1, articleText: '',
      }])
      expect(engine.count()).toBe(6)
    } finally {
      engine.close()
    }
  })

  it('filters and caps the in-memory path', () => {
    const records: LegalRegulationRecord[] = [
      {
        regulationId: 'mem-1', regulationName: '民法典', level: '法律', effectiveDate: '2021-01-01',
        validity: 'unverified', articleNumber: 1, articleText: '合同规定',
      },
      {
        regulationId: 'mem-2', regulationName: '专利法', level: '法律', effectiveDate: '2000-01-01',
        expiryDate: '2001-01-01', expired: 1, validity: 'unverified', articleNumber: 1, articleText: '合同专利',
      },
      {
        regulationId: 'mem-3', regulationName: '无日期法', level: '其他', effectiveDate: '', validity: 'unverified',
        articleNumber: 1, articleText: '合同未知',
      },
    ]
    const engine = new LegalRegulationSearchEngine(records)
    try {
      expect(engine.search('合同', { limit: 1 })).toHaveLength(1)
      expect(engine.search('   ')).toEqual([])
      expect(engine.search('合同', { level: '其他' }).map(hit => hit.regulationId)).toEqual(['mem-3'])
      expect(engine.search('合同', { includeUnverified: false }).map(hit => hit.regulationId)).toEqual(['mem-1'])
      expect(engine.findByName('法', 1)).toHaveLength(1)
      expect(engine.findByName('missing')).toEqual([])
      expect(engine.getById('mem-1')?.validity).toBe('in-force')
      expect(engine.getById('mem-2')).toBeUndefined()
      expect(engine.getById('missing')).toBeUndefined()
      expect(engine.count()).toBe(3)
      engine.addRecords([])
      expect(engine.count()).toBe(3)
    } finally {
      engine.close()
    }
  })
})

describe('JudicialInterpretationSearch branches', () => {
  it('maps interpretation rows and validity in SQL', () => {
    const engine = new JudicialInterpretationSearch({ dbPath: judicialDb() })
    try {
      const hits = engine.search('contract', { asOf: '2025-01-01' })
      expect(hits[0]).toMatchObject({
        interpretationId: 'interp-1', interpretationName: 'Contract interpretation',
        interpretationType: 'judicial-interpretation', issuingBody: 'SPC', documentNumber: '法释1',
        validity: 'in-force', effectiveDate: '2023-02-01', articleNumber: 1, articleText: 'contract guidance',
        publishDate: '2023-01-01', sourcePath: 'docs/i1.yaml', via: 'fts',
      })
      expect(engine.search('expired', { asOf: '2025-01-01' })).toEqual([])
      expect(engine.search('expired', { asOf: '2000-06-01' })).toEqual([])
      expect(engine.search('contract', { interpretationType: 'judicial-interpretation' })).toHaveLength(1)
      expect(engine.search('contract', { interpretationType: 'guiding-case' })).toEqual([])
      expect(engine.search('   ')).toEqual([])
      expect(engine.getById('interp-3', { asOf: '2025-01-01' })).toBeUndefined()

      const bare = engine.search('bareinterp')[0]
      expect(bare).toMatchObject({
        interpretationId: 'interp-bare', interpretationName: 'Bare name',
        interpretationType: 'judicial-interpretation',
      })
    } finally {
      engine.close()
    }
  })

  it('maps camel-case interpretation columns and type fallback', () => {
    const engine = new JudicialInterpretationSearch({ dbPath: judicialDb() })
    try {
      const camel = engine.search('camelhit', { asOf: '2025-01-01' })
      expect(camel[0]).toMatchObject({
        interpretationId: 'interp-camel-hit', interpretationName: 'Camel hit',
        interpretationType: 'guiding-case', issuingBody: 'SPC camel hit', documentNumber: '法释4',
        publishDate: '2022-03-04', effectiveDate: '2022-04-05', expiryDate: '2030-04-04',
        articleNumber: 8, articleText: 'camel hit text', sourcePath: 'camel/hit.yaml', via: 'fts',
      })

      const mixed = engine.search('camel interpretation', { asOf: '2025-01-01' })
      expect(mixed[0]).toMatchObject({
        interpretationId: 'interp-2', interpretationName: 'Camel interpretation',
        interpretationType: 'guiding-case', issuingBody: 'SPC camel', documentNumber: '法释2',
      })
    } finally {
      engine.close()
    }
  })

  it('reads interpretations and counts in SQL', () => {
    const engine = new JudicialInterpretationSearch({ dbPath: judicialDb() })
    try {
      expect(engine.getById('interp-1', { asOf: '2025-01-01' })?.validity).toBe('in-force')
      expect(engine.getById('interp-2', { asOf: '2025-01-01' })).toMatchObject({
        interpretationName: 'Camel interpretation', interpretationType: 'guiding-case',
      })
      expect(engine.getById('interp-5', { asOf: '2025-01-01' })).toMatchObject({
        interpretationId: 'interp-5', interpretationName: 'Camel record', interpretationType: 'guiding-case',
        issuingBody: 'SPC record', documentNumber: '法释5', effectiveDate: '2022-06-07',
        articleNumber: 9, articleText: 'camel record text', sourcePath: 'camel/record.yaml',
      })
      expect(engine.getById('missing')).toBeUndefined()
      expect(engine.countInterpretations()).toBe(6)
      expect(engine.countGuidingCases()).toBe(8)
      engine.addInterpretations([])
      engine.addGuidingCases([])
      expect(engine.countInterpretations()).toBe(6)
    } finally {
      engine.close()
    }
  })

  it('maps guiding cases from SQL, including every related-laws form', () => {
    const engine = new JudicialInterpretationSearch({ dbPath: judicialDb() })
    try {
      expect(engine.searchGuidingCases('')).toEqual([])
      expect(engine.searchGuidingCases('Alpha')[0]).toMatchObject({
        caseId: 'gc-1', guidingCaseNumber: 'Case 1', caseName: 'Alpha guiding case', court: 'Court A',
        decisionDate: '2011-01-01', caseType: 'civil', relatedLaws: ['Article 1', 'Article 2'], via: 'like',
      })
      expect(engine.searchGuidingCases('Beta')[0]?.relatedLaws).toEqual(['Article 1', 'Article 2'])
      expect(engine.searchGuidingCases('Gamma')[0]?.relatedLaws).toEqual([])
      expect(engine.searchGuidingCases('Delta')[0]?.relatedLaws).toEqual([])
      expect(engine.searchGuidingCases('Epsilon')[0]?.relatedLaws).toEqual(['[not json'])
      expect(engine.searchGuidingCases('Zeta')[0]).toMatchObject({
        caseId: 'gc-6', guidingCaseNumber: 'Case 6', caseName: 'Zeta English', decisionDate: '2016-06-06',
      })
      expect(engine.searchGuidingCases('Theta')[0]?.relatedLaws).toEqual([])
      expect(engine.searchGuidingCases('missing')).toEqual([])
      expect(engine.getGuidingCaseById('gc-1')?.caseName).toBe('Alpha guiding case')
      expect(engine.getGuidingCaseById('gc-6')).toBeUndefined()
      expect(engine.getGuidingCaseById('gc-7')).toMatchObject({
        caseId: 'gc-7', guidingCaseNumber: 'Case 7', caseName: 'Camel record case',
        court: '', decisionDate: '2017-07-07', caseType: 'civil', keyPoints: 'eta key point',
        fullText: 'eta full text',
      })
      expect(engine.getGuidingCaseById('missing')).toBeUndefined()
    } finally {
      engine.close()
    }
  })

  it('searches and reads guiding cases in memory', () => {
    const engine = new JudicialInterpretationSearch({
      interpretations: [{
        interpretationId: 'mem-1', interpretationName: 'Mem interpretation', interpretationType: 'judicial-interpretation',
        issuingBody: 'SPC', documentNumber: '法释', effectiveDate: '2021-01-01', validity: 'unverified',
        articleNumber: 1, articleText: 'memory text',
      }, {
        interpretationId: 'mem-2', interpretationName: 'Expired interpretation', interpretationType: 'guiding-case',
        issuingBody: 'SPC', documentNumber: '法释', effectiveDate: '2000-01-01', expiryDate: '2001-01-01',
        expired: 1, validity: 'unverified', articleNumber: 1, articleText: 'memory expired',
      }],
      guidingCases: [{
        caseId: 'gc-mem', guidingCaseNumber: 'Mem 1', caseName: 'Memory guiding case', court: 'Court',
        decisionDate: '2020-01-01', caseType: 'civil', keyPoints: 'memory key', relatedLaws: [], fullText: 'memory full',
      }],
    })
    try {
      expect(engine.search('memory', { asOf: '2025-01-01' }).map(hit => hit.interpretationId)).toEqual(['mem-1'])
      expect(engine.search('memory', { interpretationType: 'guiding-case', asOf: '2025-01-01' })).toEqual([])
      expect(engine.searchGuidingCases('Memory')[0]?.via).toBe('memory')
      expect(engine.getById('mem-1', { asOf: '2025-01-01' })?.validity).toBe('in-force')
      expect(engine.getById('mem-2', { asOf: '2025-01-01' })).toBeUndefined()
      expect(engine.getById('missing')).toBeUndefined()
      expect(engine.getGuidingCaseById('gc-mem')?.caseName).toBe('Memory guiding case')
      expect(engine.getGuidingCaseById('missing')).toBeUndefined()
      expect(engine.countInterpretations()).toBe(2)
      expect(engine.countGuidingCases()).toBe(1)
      expect(engine.ftsAvailable).toBe(false)
    } finally {
      engine.close()
    }
  })
})

describe('SqliteFtsTable branches', () => {
  type Options = { limit?: number; flag?: string }
  type Hit = { id: string; via: string; rank: number }

  const baseShape = (overrides: Partial<SqliteSearchShape<Options, Hit>> = {}): SqliteSearchShape<Options, Hit> => ({
    table: 'items',
    alias: 'i',
    ftsTable: 'items_fts',
    likeColumns: ['name', 'text'],
    label: 'items',
    toHit: (row, via) => ({
      id: String(row.id), via, rank: typeof row.rank === 'number' ? row.rank : 0,
    }),
    filterClause: options => options.flag === undefined
      ? { sql: '', params: [] }
      : { sql: ' AND i.id = ?', params: [options.flag] },
    ...overrides,
  })

  function ftsDb(): DatabaseSync {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, text TEXT);
      INSERT INTO items VALUES (1, 'alpha', 'first');
      INSERT INTO items VALUES (2, 'beta', 'second');
      CREATE VIRTUAL TABLE items_fts USING fts5(name, text, content='items', content_rowid='id');
      INSERT INTO items_fts(rowid, name, text) SELECT id, name, text FROM items;
    `)
    return db
  }

  it('reports an unconnected table and returns empty results', () => {
    const table = new SqliteFtsTable<Options, Hit>({}, baseShape())
    expect(table.connected).toBe(false)
    expect(table.ftsAvailable).toBe(false)
    expect(table.search('alpha', {}, 10)).toEqual([])
    expect(table.findRow('name', 'alpha')).toBeUndefined()
    expect(table.findRowsLike('name', 'alpha', 10)).toEqual([])
    expect(table.findRowsLikeAny(['name'], 'alpha', 10)).toEqual([])
    expect(table.count()).toBe(0)
    table.close()
  })

  it('rethrows when the database cannot be opened', () => {
    const path = join(tempDir(), 'not-a-database.db')
    writeFileSync(path, 'not a database')
    expect(() => new SqliteFtsTable<Options, Hit>({ dbPath: path }, baseShape())).toThrow(/not a database/)
  })

  it('leaves a caller-owned connection open when the FTS probe fails', () => {
    const path = join(tempDir(), 'caller-owned.db')
    writeFileSync(path, 'not a database')
    const db = new DatabaseSync(path, { readOnly: true })
    try {
      expect(() => new SqliteFtsTable<Options, Hit>({ db }, baseShape())).toThrow(/not a database/)
    } finally {
      db.close()
    }
  })

  it('closes a connection it opened when the FTS probe fails', () => {
    const path = join(tempDir(), 'corrupt.db')
    const db = new DatabaseSync(path)
    try {
      db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO items VALUES (1, 'alpha')")
    } finally {
      db.close()
    }
    const bytes = readFileSync(path)
    for (let index = 100; index < Math.min(bytes.length, 200); index += 1) bytes[index] = 0xff
    writeFileSync(path, bytes)
    expect(() => new SqliteFtsTable<Options, Hit>({ dbPath: path }, baseShape())).toThrow(/malformed|not a database/)
  })

  it('serves FTS and LIKE queries with every lookup helper', () => {
    const db = ftsDb()
    const table = new SqliteFtsTable<Options, Hit>({ db }, baseShape())
    try {
      expect(table.connected).toBe(true)
      expect(table.ftsAvailable).toBe(true)
      expect(table.search('alpha', {}, 10)[0]).toMatchObject({ id: '1', via: 'fts' })
      expect(table.search('alpha beta', {}, 10).length).toBeGreaterThan(0)
      expect(table.search('alpha', { flag: '1' }, 10)[0]?.id).toBe('1')
      expect(table.findRow('name', 'alpha')).toMatchObject({ id: 1 })
      expect(table.findRow('name', 'alpha', 'items')).toMatchObject({ id: 1 })
      expect(table.findRow('missing_column', 'alpha')).toBeUndefined()
      expect(table.findRowsLike('name', 'a', 10)).toHaveLength(2)
      expect(table.findRowsLike('name', 'a%', 10)).toEqual([])
      expect(table.findRowsLike('name', 'a_l\\pha', 10)).toEqual([])
      expect(table.findRowsLike('missing_column', 'alpha', 10)).toEqual([])
      expect(table.findRowsLikeAny(['name', 'text'], 'alpha', 10)).toHaveLength(1)
      expect(table.findRowsLikeAny(['name'], 'alpha', 10, 'items')).toHaveLength(1)
      expect(table.findRowsLikeAny(['missing_column'], 'alpha', 10)).toEqual([])
      expect(table.count()).toBe(2)
      expect(table.count('items')).toBe(2)
      expect(table.count('missing_table')).toBe(0)
    } finally {
      table.close()
    }
  })

  it('degrades on an FTS query error and warns once', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, text TEXT);
      INSERT INTO items VALUES (1, 'alpha', 'first');
      CREATE TABLE items_fts (id INTEGER PRIMARY KEY, name TEXT, text TEXT);
    `)
    const warnings: string[] = []
    const table = new SqliteFtsTable<Options, Hit>(
      { db, logger: { warn: (message) => { warnings.push(message) } } },
      baseShape(),
    )
    try {
      expect(table.ftsAvailable).toBe(true)
      expect(table.search('alpha', {}, 10)[0]?.via).toBe('like')
      expect(table.ftsAvailable).toBe(false)
      expect(warnings[0]).toContain('FTS5 不可用，已降级 LIKE')
      expect(table.search('alpha', {}, 10)[0]?.via).toBe('like')
    } finally {
      table.close()
    }
  })

  it('falls back to the original multi-word query when the FTS query fails', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, text TEXT);
      INSERT INTO items VALUES (1, 'alpha beta', 'first');
      CREATE TABLE items_fts (id INTEGER PRIMARY KEY, name TEXT, text TEXT);
    `)
    const table = new SqliteFtsTable<Options, Hit>({ db }, baseShape())
    try {
      expect(table.search('alpha beta', {}, 10)[0]).toMatchObject({ id: '1', via: 'like' })
    } finally {
      table.close()
    }
  })

  it('returns no hits when the LIKE query itself fails', () => {
    const db = new DatabaseSync(':memory:')
    db.exec(`
      CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);
      INSERT INTO items VALUES (1, 'alpha');
    `)
    const table = new SqliteFtsTable<Options, Hit>({ db }, baseShape())
    try {
      expect(table.search('alpha', {}, 10)).toEqual([])
    } finally {
      table.close()
    }
  })

  it('degrades when building the FTS query throws', () => {
    const db = ftsDb()
    const warnings: string[] = []
    let calls = 0
    const table = new SqliteFtsTable<Options, Hit>(
      { db, logger: { warn: (message) => { warnings.push(message) } } },
      baseShape({
        filterClause: () => {
          calls += 1
          if (calls === 1) throw new Error('bad filter')
          return { sql: '', params: [] }
        },
      }),
    )
    try {
      expect(table.search('alpha', {}, 10)[0]?.id).toBe('1')
      expect(table.ftsAvailable).toBe(false)
      expect(warnings[0]).toContain('bad filter')
    } finally {
      table.close()
    }
  })

  it('applies fetchFactor and postFilter only when declared', () => {
    const db = ftsDb()
    const filtered = new SqliteFtsTable<Options, Hit>({ db }, baseShape({
      fetchFactor: 2,
      postFilter: hits => hits.slice(0, 1),
    }))
    const unfiltered = new SqliteFtsTable<Options, Hit>({ db }, baseShape())
    try {
      expect(filtered.search('alpha beta', {}, 10)).toHaveLength(1)
      expect(unfiltered.search('alpha beta', {}, 10).length).toBeGreaterThan(1)
    } finally {
      filtered.close()
    }
  })
})

describe('row-text helpers', () => {
  it('renders scalar columns and drops non-scalars', () => {
    expect(columnText('x')).toBe('x')
    expect(columnText(42)).toBe('42')
    expect(columnText(42n)).toBe('42')
    expect(columnText(true)).toBe('true')
    expect(columnText(null)).toBe('')
    expect(columnText(undefined)).toBe('')
    expect(columnText({})).toBe('')
  })

  it('reads article columns from either naming style', () => {
    expect(articleRowColumns({
      effective_date: '2021-01-01', article_number: 3, article_text: 'text',
    })).toEqual({ effectiveDate: '2021-01-01', articleNumber: 3, articleText: 'text' })
    expect(articleRowColumns({
      effectiveDate: '2022-01-01', articleNumber: 4, articleText: 'camel',
    })).toEqual({ effectiveDate: '2022-01-01', articleNumber: 4, articleText: 'camel' })
    expect(articleRowColumns({})).toEqual({ effectiveDate: '', articleNumber: 0, articleText: '' })
  })

  it('writes only the dated columns a row carries', () => {
    const full = assignDatedColumns({}, {
      publish_date: '2020-01-01', expiry_date: '2030-01-01', expired: 0, source_path: 'a.yaml',
    })
    expect(full).toEqual({
      publishDate: '2020-01-01', expiryDate: '2030-01-01', expired: 0, sourcePath: 'a.yaml',
    })
    const camel = assignDatedColumns({}, {
      publishDate: '2021-01-01', expiryDate: '2031-01-01', sourcePath: 'b.yaml',
    })
    expect(camel).toEqual({ publishDate: '2021-01-01', expiryDate: '2031-01-01', sourcePath: 'b.yaml' })
    const empty = assignDatedColumns({ publishDate: 'keep' }, {
      publish_date: null, expiry_date: null, expired: '0', source_path: null,
    })
    expect(empty).toEqual({ publishDate: 'keep' })
  })
})

describe('memory-store and validity helpers', () => {
  it('returns nothing for a query with no usable terms', () => {
    expect(searchInMemory([{ name: 'alpha' }], 'a', record => record.name, 10)).toEqual([])
    expect(searchInMemory([{ name: 'alpha' }], '，。', record => record.name, 10)).toEqual([])
  })

  it('filters records by absent, present, and missing field values', () => {
    const records = [{ court: 'Beijing' }, { court: undefined }, { court: 'Shanghai' }]
    expect(filterRecords(records, record => record.court, undefined)).toBe(records)
    expect(filterRecords(records, record => record.court, 'bei')).toEqual([records[0]])
    expect(filterRecords(records, record => record.court, 'nowhere')).toEqual([])
  })

  it('maps visible memory hits and honors the limit', () => {
    const hits = [
      { record: { effectiveDate: '2021-01-01', id: 'a' }, score: 2 },
      { record: { effectiveDate: '2021-01-01', id: 'b' }, score: 1 },
    ]
    expect(toVisibleMemoryHits(hits, { limit: 1 }, 10)).toEqual([
      { effectiveDate: '2021-01-01', id: 'a', relevanceScore: 2, via: 'memory', validity: 'in-force' },
    ])
    expect(toVisibleMemoryHits(hits, {}, 1).map(hit => hit.id)).toEqual(['a'])
  })

  it('breaks at the validity limit and skips invisible rows', () => {
    const hits = [
      { effectiveDate: '2000-01-01', expiryDate: '2001-01-01', expired: 1, id: 'expired' },
      { effectiveDate: '2021-01-01', id: 'visible-1' },
      { effectiveDate: '2021-01-01', id: 'visible-2' },
    ]
    expect(filterByValidity(hits, { asOf: '2025-01-01', limit: 1 }).map(hit => hit.id)).toEqual(['visible-1'])
    expect(filterByValidity(hits, { asOf: '2000-06-01', includeUnverified: false })).toEqual([])
  })
})
