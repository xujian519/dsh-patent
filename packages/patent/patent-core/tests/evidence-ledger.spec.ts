import { describe, expect, it } from 'vitest'
import { buildWorkflowEvidenceLedger, contentHash } from '@deepseek-ai/dsh-patent-core'
import { EVIDENCE_SNIPPET_LIMIT } from '../src/evidence/ledger.ts'

const OPTIONS = { manifestId: 'patent_novelty_v1', runId: 'run-1' }

describe('buildWorkflowEvidenceLedger — empty and material sources', () => {
  it('returns an empty ledger with a stable digest when the run consumed nothing', () => {
    const ledger = buildWorkflowEvidenceLedger({}, OPTIONS)
    expect(ledger.receipts).toEqual([])
    expect(ledger.digest).toBe(contentHash('[]'))
    expect(ledger.incomplete).toBeUndefined()
  })

  it('records the material and claims as separate receipts with bounded snippets', () => {
    const ledger = buildWorkflowEvidenceLedger(
      { input: '长'.repeat(EVIDENCE_SNIPPET_LIMIT + 20), claims: '权利要求 1：一种装置' },
      OPTIONS,
    )
    expect(ledger.receipts.map(receipt => receipt.citationId)).toEqual(['MATERIAL', 'CLAIMS'])
    const material = ledger.receipts[0]!
    expect(material.source).toBe('material')
    expect(material.resultText).toHaveLength(EVIDENCE_SNIPPET_LIMIT)
    expect(material.toolName).toBe('patent_workflow_run')
    expect(material.toolCallId).toBe('run-1:MATERIAL')
    expect(material.turnId).toBe('run-1')
    expect(material.success).toBe(true)
    expect(material.write).toBe(false)
    expect(material.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(ledger.digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(material.args).toMatchObject({ source: 'material', citationId: 'MATERIAL' })
    expect(ledger.receipts[1]!.source).toBe('claims')
  })

  it('falls back to the manifest id as the run key and omits blank or non-string material', () => {
    const blank = buildWorkflowEvidenceLedger(
      { input: '   ', claims: 42, prior_art: [] },
      { manifestId: 'patent_disclosure_v1' },
    )
    expect(blank.receipts).toEqual([])

    const withMaterial = buildWorkflowEvidenceLedger({ input: '交底书' }, { manifestId: 'patent_disclosure_v1' })
    expect(withMaterial.receipts[0]!.toolCallId).toBe('patent_disclosure_v1:MATERIAL')
    expect(withMaterial.receipts[0]!.turnId).toBe('patent_disclosure_v1')
  })

  it('omits the content hash when a source carries no identifying text', () => {
    const ledger = buildWorkflowEvidenceLedger({ prior_art: [{}] }, OPTIONS)
    expect(ledger.receipts[0]!.citationId).toBe('D1')
    expect(ledger.receipts[0]!.contentHash).toBeUndefined()
    expect(ledger.receipts[0]!.title).toBeUndefined()
  })
})

describe('buildWorkflowEvidenceLedger — prior art', () => {
  it('keeps the D label, document title, URL, publication date, and A24 marker', () => {
    const ledger = buildWorkflowEvidenceLedger(
      {
        prior_art: [
          { title: '无标号文献', abstract: '摘要' },
          {
            dLabel: 'D2',
            title: '一种装置',
            url: 'https://example.test/D2',
            publicationDate: '2020-01-01',
            snippet: '公开了特征 X',
            a24Exception: 'A24.2',
          },
        ],
      },
      OPTIONS,
    )
    expect(ledger.receipts.map(receipt => receipt.citationId)).toEqual(['D1', 'D2'])
    expect(ledger.receipts[0]!.source).toBe('prior-art')
    expect(ledger.receipts[0]!.resultText).toBe('摘要')
    expect(ledger.receipts[1]!.title).toBe('一种装置')
    expect(ledger.receipts[1]!.publicationDate).toBe('2020-01-01')
    expect(ledger.receipts[1]!.args['sourceUri']).toBe('https://example.test/D2')
    expect(ledger.receipts[1]!.args['a24Exception']).toBe('A24.2')
    expect(ledger.receipts[1]!.resultText).toBe('公开了特征 X')
  })

  it('uses the array position when the dLabel is malformed', () => {
    const ledger = buildWorkflowEvidenceLedger(
      { prior_art: [{ dLabel: '对比文件2', title: 'A' }, { dLabel: ' D3 ', title: 'B' }] },
      OPTIONS,
    )
    expect(ledger.receipts.map(receipt => receipt.citationId)).toEqual(['D1', 'D3'])
  })

  it('records excluded and undated entries under their own sources and reasons', () => {
    const ledger = buildWorkflowEvidenceLedger(
      {
        prior_art_excluded: [
          { label: 'D1', title: '公开过早', publicationDate: '2019-01-01', reason: 'not-prior-art' },
        ],
        prior_art_undated: [{ label: 'D3', title: '无公开日', reason: '缺少公开日' }],
      },
      OPTIONS,
    )
    expect(ledger.receipts.map(receipt => [receipt.citationId, receipt.source])).toEqual([
      ['D1', 'prior-art-excluded'],
      ['D3', 'prior-art-undated'],
    ])
    expect(ledger.receipts[0]!.args['reason']).toBe('not-prior-art')
    expect(ledger.receipts[1]!.resultText).toBe('无公开日')
  })

  it('keeps one receipt when a retained document is also listed as undated', () => {
    const ledger = buildWorkflowEvidenceLedger(
      {
        prior_art: [{ dLabel: 'D1', title: '无公开日' }],
        prior_art_undated: [{ label: 'D1', title: '无公开日', reason: '缺少公开日' }],
      },
      OPTIONS,
    )
    expect(ledger.receipts.map(receipt => [receipt.citationId, receipt.source])).toEqual([
      ['D1', 'prior-art'],
    ])
  })

  it('marks the ledger incomplete when an array carries a non-object entry', () => {
    const ledger = buildWorkflowEvidenceLedger({ prior_art: ['not-a-document'] }, OPTIONS)
    expect(ledger.receipts).toEqual([])
    expect(ledger.incomplete).toBe(true)
  })

  it('ignores a prior-art value that is not an array', () => {
    const ledger = buildWorkflowEvidenceLedger({ prior_art: { title: '对象不是数组' } }, OPTIONS)
    expect(ledger.receipts).toEqual([])
    expect(ledger.incomplete).toBeUndefined()
  })
})

describe('buildWorkflowEvidenceLedger — evidence and conflicting applications', () => {
  it('numbers evidence entries and records their source URI and content hash', () => {
    const ledger = buildWorkflowEvidenceLedger(
      {
        evidence: [
          { title: '证据 1', type: '现有技术', sourceUri: 'file:///e1.pdf', snippet: '公开内容' },
          { name: '证据 2' },
          'not-a-document',
        ],
      },
      OPTIONS,
    )
    expect(ledger.receipts.map(receipt => receipt.citationId)).toEqual(['EV-1', 'EV-2'])
    expect(ledger.receipts[0]!.source).toBe('evidence')
    expect(ledger.receipts[0]!.args['sourceUri']).toBe('file:///e1.pdf')
    expect(ledger.receipts[0]!.contentHash).toBeTruthy()
    expect(ledger.receipts[1]!.title).toBe('证据 2')
    expect(ledger.incomplete).toBe(true)
  })

  it('records confirmed, excluded, and unknown conflicting applications separately', () => {
    const ledger = buildWorkflowEvidenceLedger(
      {
        conflicting_applications: [
          { label: '候选1', title: '同样的发明', publicationDate: '2024-06-01' },
        ],
        conflicting_application_excluded: [{ title: '不同发明', reason: 'different-invention' }],
        conflicting_application_unknown: [{ title: '待核实', reason: '未提供同样的发明判定' }],
      },
      OPTIONS,
    )
    expect(ledger.receipts.map(receipt => [receipt.citationId, receipt.source])).toEqual([
      ['CA-1', 'conflicting-application'],
      ['CA-1', 'conflicting-application-excluded'],
      ['CA-1', 'conflicting-application-unknown'],
    ])
    expect(ledger.receipts[1]!.args['reason']).toBe('different-invention')
  })

  it('ignores non-array evidence and conflict values', () => {
    const ledger = buildWorkflowEvidenceLedger(
      { evidence: null, conflicting_applications: 'x', conflicting_application_excluded: {} },
      OPTIONS,
    )
    expect(ledger.receipts).toEqual([])
    expect(ledger.incomplete).toBeUndefined()
  })
})

describe('buildWorkflowEvidenceLedger — digest', () => {
  it('is independent of run metadata and sensitive to content', () => {
    const state = { input: '交底书', prior_art: [{ title: 'D1 文献' }] }
    const first = buildWorkflowEvidenceLedger(state, OPTIONS)
    const second = buildWorkflowEvidenceLedger(state, {
      manifestId: 'patent_novelty_v1',
      runId: 'run-2',
    })
    expect(first.digest).toBe(second.digest)
    const changed = buildWorkflowEvidenceLedger({ ...state, input: '另一份交底书' }, OPTIONS)
    expect(changed.digest).not.toBe(first.digest)
  })

  it('keeps field identity so title and sourceUri carrying the same value do not collide (S-PAT-009)', () => {
    const byTitle = buildWorkflowEvidenceLedger({ prior_art: [{ title: 'x', snippet: 's' }] }, OPTIONS)
    const byUrl = buildWorkflowEvidenceLedger({ prior_art: [{ url: 'x', snippet: 's' }] }, OPTIONS)
    const titleHash = byTitle.receipts[0]!.contentHash
    const urlHash = byUrl.receipts[0]!.contentHash
    expect(titleHash).toBeTruthy()
    expect(urlHash).toBeTruthy()
    expect(titleHash).not.toBe(urlHash)
  })
})
