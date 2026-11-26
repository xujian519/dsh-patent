import { describe, expect, it } from 'vitest'
import {
  REVISION_LEDGER_ROUNDS_KEY,
  draftReviewActionableFindings,
  draftReviewFindingId,
  draftReviewFindingLocator,
  readLedgerRounds,
  reconcileDraftReviewLedger,
  type DraftReviewLedgerRound,
} from '../src/draft-review/findings.ts'
import type { DraftReviewDispute } from '../src/draft-review/types.ts'
import { RevisionLedgerHandler, revisionLedgerAtom } from '../src/atoms/handlers/builtin/revision-ledger.ts'

/** 构造一条争议点。 */
function dispute(overrides: Partial<DraftReviewDispute> = {}): DraftReviewDispute {
  return {
    category: 'enablement',
    provision: '专利法第26条第3款',
    recommendation: 'add-embodiment',
    ...overrides,
  }
}

describe('draft-review finding 稳定 id', () => {
  it('定位优先权项号，其次特征号，都缺时按全篇', () => {
    expect(draftReviewFindingId(dispute({ claimNumber: 1 }))).toBe('draft-review:enablement:claim1')
    expect(draftReviewFindingId(dispute({ featureId: 'C1F2' }))).toBe('draft-review:enablement:feat-C1F2')
    expect(draftReviewFindingId(dispute({ claimNumber: 2, featureId: 'C1F2' }))).toBe('draft-review:enablement:claim2')
    expect(draftReviewFindingId(dispute())).toBe('draft-review:enablement:doc')
  })

  it('anchor 措辞不影响 id：同一问题跨轮判同一条', () => {
    const first = draftReviewFindingId(dispute({ claimNumber: 1, anchor: '输出步骤由控制器完成。' }))
    const second = draftReviewFindingId(dispute({ claimNumber: 1, anchor: '所述输出步骤由控制器执行' }))
    expect(first).toBe(second)
  })

  it('人可读定位与 finding id 同源', () => {
    expect(draftReviewFindingLocator(dispute({ claimNumber: 3 }))).toBe('权利要求 3')
    expect(draftReviewFindingLocator(dispute({ featureId: 'F1' }))).toBe('特征 F1')
    expect(draftReviewFindingLocator(dispute())).toBe('全篇')
  })

  it('可执行过滤只剔除 none', () => {
    const actionable = draftReviewActionableFindings([
      dispute(),
      dispute({ recommendation: 'none', category: 'clarity' }),
    ])
    expect(actionable).toHaveLength(1)
    expect(actionable[0]?.category).toBe('enablement')
  })
})

describe('账本读取与折叠', () => {
  it('非数组值安全回落为空', () => {
    expect(readLedgerRounds(undefined)).toEqual([])
    expect(readLedgerRounds('not-an-array')).toEqual([])
    expect(readLedgerRounds([{ round: 1, findings: [] }])).toHaveLength(1)
  })

  it('空账本折叠为零计数', () => {
    const summary = reconcileDraftReviewLedger([])
    expect(summary).toMatchObject({ roundCount: 0, lastRound: 0, resolved: 0, persisting: 0, introduced: 0 })
    expect(summary.entries).toEqual([])
  })

  it('首轮标记、末轮消失记已销账', () => {
    const rounds: DraftReviewLedgerRound[] = [
      { round: 1, findings: [dispute({ claimNumber: 1 })] },
      { round: 2, findings: [] },
    ]
    const summary = reconcileDraftReviewLedger(rounds)
    expect(summary.roundCount).toBe(2)
    expect(summary.lastRound).toBe(2)
    expect(summary.entries).toHaveLength(1)
    expect(summary.entries[0]).toMatchObject({
      findingId: 'draft-review:enablement:claim1',
      firstRound: 1,
      lastSeenRound: 1,
      persisting: false,
    })
    expect(summary.resolved).toBe(1)
    expect(summary.persisting).toBe(0)
  })

  it('末轮仍在记仍存在；仅末轮新出现的另记新增', () => {
    const rounds: DraftReviewLedgerRound[] = [
      { round: 1, findings: [dispute({ claimNumber: 1 })] },
      {
        round: 2,
        findings: [
          dispute({ claimNumber: 1 }),
          dispute({ category: 'clarity', provision: '专利法第26条第4款', recommendation: 'clarify-term', claimNumber: 2 }),
        ],
      },
    ]
    const summary = reconcileDraftReviewLedger(rounds)
    expect(summary.persisting).toBe(2)
    expect(summary.introduced).toBe(1)
    expect(summary.resolved).toBe(0)
    const unity = summary.entries.find(entry => entry.findingId === 'draft-review:clarity:claim2')
    expect(unity).toMatchObject({ firstRound: 2, lastSeenRound: 2, persisting: true })
  })
})

describe('revision-ledger 原子', () => {
  it('契约：gate 类，只读账本键，输出三键', () => {
    expect(revisionLedgerAtom.category).toBe('gate')
    expect(revisionLedgerAtom.usesModel).toBeUndefined()
    expect(revisionLedgerAtom.inputSchema).toEqual([REVISION_LEDGER_ROUNDS_KEY])
    expect(revisionLedgerAtom.outputSchema).toEqual([
      'revision_ledger_summary',
      'revision_ledger_report',
      'revision_ledger_reconciliation',
    ])
  })

  it('无轮次记录时报告未执行修订闭环', async () => {
    const out = await new RevisionLedgerHandler().execute({ state: {} })
    expect(out.revision_ledger_report).toContain('无 draft-review 轮次记录')
    expect(out.revision_ledger_reconciliation).toMatchObject({ roundCount: 0 })
  })

  it('首轮即通过：汇总记通过，报告说明无争议点', async () => {
    const out = await new RevisionLedgerHandler().execute({
      state: { [REVISION_LEDGER_ROUNDS_KEY]: [{ round: 1, findings: [] }] },
    })
    expect(out.revision_ledger_summary).toContain('修订对账通过（1 轮审查）')
    expect(out.revision_ledger_report).toContain('首轮审查即通过')
  })

  it('混合轮次：逐条矩阵区分仍存在与已销账', async () => {
    const rounds: DraftReviewLedgerRound[] = [
      { round: 1, findings: [dispute({ claimNumber: 1 }), dispute({ category: 'unity', provision: '专利法第31条第1款', recommendation: 'split-unity' })] },
      { round: 2, findings: [dispute({ claimNumber: 1 })] },
    ]
    const out = await new RevisionLedgerHandler().execute({
      state: { [REVISION_LEDGER_ROUNDS_KEY]: rounds },
    })
    const summary = out.revision_ledger_reconciliation as ReturnType<typeof reconcileDraftReviewLedger>
    expect(summary).toMatchObject({ roundCount: 2, persisting: 1, resolved: 1, introduced: 0 })
    expect(out.revision_ledger_summary).toContain('修订对账未清账（2 轮审查）')
    expect(out.revision_ledger_summary).toContain('共 2 项曾标记，已销账 1 项，仍存在 1 项')
    expect(out.revision_ledger_report).toContain('- draft-review:enablement:claim1（专利法第26条第3款，权利要求 1）：仍存在')
    expect(out.revision_ledger_report).toContain('- draft-review:unity:doc（专利法第31条第1款，全篇）：已销账')
    expect(out.revision_ledger_report).toContain('锚点措辞变化不影响销账判定')
  })

  it('修订过程新增的条目单独计入汇总文本', async () => {
    const rounds: DraftReviewLedgerRound[] = [
      { round: 1, findings: [] },
      { round: 2, findings: [dispute({ claimNumber: 1 })] },
    ]
    const out = await new RevisionLedgerHandler().execute({
      state: { [REVISION_LEDGER_ROUNDS_KEY]: rounds },
    })
    expect(out.revision_ledger_summary).toContain('共 1 项曾标记，已销账 0 项，仍存在 1 项，其中修订过程新增 1 项')
  })

  it('非法账本值安全降级为空记录', async () => {
    const out = await new RevisionLedgerHandler().execute({
      state: { [REVISION_LEDGER_ROUNDS_KEY]: 'corrupted' },
    })
    expect(out.revision_ledger_report).toContain('无 draft-review 轮次记录')
  })
})
