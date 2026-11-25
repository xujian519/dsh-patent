import { describe, expect, it } from 'vitest'
import {
  globalAtomRegistry,
  globalStageHandlerRegistry,
  registerBuiltinAtoms,
  REVISION_LEDGER_ROUNDS_KEY,
  type DraftReviewLedgerRound,
  type DraftReviewLedgerSummary,
  type PipelineState,
  type StageProvider,
  type WorkflowManifest,
} from '@deepseek-ai/dsh-patent-core'
import { runWorkflow } from '../src/index.ts'

/** 说明书夹具：第二轮补上实施例，首轮 26.3 争议点随之可销账。 */
const SPEC_WITHOUT_EMBODIMENT = '## 具体实施方式\n本说明书描述一种数据处理方法，包括采集步骤与输出步骤。'
const SPEC_WITH_EMBODIMENT = `${SPEC_WITHOUT_EMBODIMENT}\n实施例1：采集步骤由传感器完成，输出步骤由控制器完成。`
const CLAIMS = [
  '1. 一种数据处理方法，其特征在于，包括：',
  '  采集步骤，由传感器完成；',
  '  输出步骤，由控制器完成。',
].join('\n')

/**
 * 按轮次返回审查结论的 provider：首轮报 26.3 缺实施例，次轮起无争议。
 * @returns 阶段能力提供者。
 */
function reviewProvider(): StageProvider {
  let calls = 0
  return {
    callLLM: async () => {
      calls += 1
      return calls === 1
        ? JSON.stringify({
          disputes: [{ category: 'enablement', recommendation: 'add-embodiment', claimNumber: 1, anchor: '包括采集步骤与输出步骤' }],
        })
        : JSON.stringify({ disputes: [] })
    },
  }
}

describe('修订账本跨回退保留（真实原子与真实回退循环）', () => {
  it('回退清理不抹掉账本键；revision-ledger 与 draft-quality-ledger 按全部轮次对账', async () => {
    // 审查、对账、质量三个原子取内置注册表的真实实现；只有改稿与法条门是 stub，
    // 本用例证明的是账本键跨回退保留，不是那两个门自身。
    registerBuiltinAtoms()
    let specRounds = 0
    /** 下游可见的账本快照：证明回退后轮次记录仍在共享 state 中。 */
    let seenRounds: DraftReviewLedgerRound[] | undefined
    let seenReconciliation: DraftReviewLedgerSummary | undefined
    const disposeAtom = globalAtomRegistry.register({
      name: 'loop_draft_spec',
      description: 'stub',
      category: 'extract',
      inputSchema: [],
      outputSchema: ['specification', 'claims_draft'],
    })
    const disposeHandler = globalStageHandlerRegistry.register({
      name: 'loop_draft_spec',
      category: 'extract',
      execute: async (): Promise<PipelineState> => {
        specRounds += 1
        return {
          specification: specRounds === 1 ? SPEC_WITHOUT_EMBODIMENT : SPEC_WITH_EMBODIMENT,
          claims_draft: CLAIMS,
        }
      },
    })
    const disposeGapAtom = globalAtomRegistry.register({
      name: 'loop_legal_gaps',
      description: 'stub',
      category: 'gate',
      inputSchema: [],
      outputSchema: ['legal_gaps_passed', 'legal_gaps_report'],
    })
    const disposeGapHandler = globalStageHandlerRegistry.register({
      name: 'loop_legal_gaps',
      category: 'gate',
      execute: async (input): Promise<PipelineState> => {
        const rounds = input.state[REVISION_LEDGER_ROUNDS_KEY]
        seenRounds = Array.isArray(rounds) ? (rounds as DraftReviewLedgerRound[]) : undefined
        seenReconciliation = input.state.revision_ledger_reconciliation as DraftReviewLedgerSummary | undefined
        return { legal_gaps_passed: true, legal_gaps_report: '法条缺口无阻断项' }
      },
    })

    try {
      const manifest: WorkflowManifest = {
        id: 'revision_ledger_loop',
        name: '修订账本回退循环',
        caseType: 'disclosure_analysis',
        stages: [
          { id: 'draft_specification', strategy: 'chain', description: '重写说明书', atom: 'loop_draft_spec' },
          {
            id: 'draft_review',
            strategy: 'chain',
            description: '换位审查',
            atom: 'draft-review',
            retry: {
              whenRevisionRequested: true,
              rewindTo: 'draft_specification',
              routes: { 'draft-review:enablement': 'draft_specification' },
              maxRetries: 3,
            },
          },
          { id: 'revision_ledger', strategy: 'chain', description: '修订对账', atom: 'revision-ledger' },
          { id: 'legal_gaps', strategy: 'chain', description: '法条缺口', atom: 'loop_legal_gaps' },
          { id: 'draft_quality', strategy: 'chain', description: '质量账本', atom: 'draft-quality-ledger' },
        ],
        validation: { requireAllSteps: true },
      }

      const result = await runWorkflow(manifest, { input: '技术交底书' }, undefined, { provider: reviewProvider() })
      const ledger = result.stages.find(stage => stage.stageId === 'revision_ledger')
      const quality = result.stages.find(stage => stage.stageId === 'draft_quality')

      // 首轮审查发信号触发回退，次轮通过：改稿阶段执行两次。
      expect(result.completed).toBe(true)
      expect(specRounds).toBe(2)
      expect(seenRounds?.map(round => round.round)).toEqual([1, 2])
      // 下游读到的是回退循环收敛后的完整账本，而非被清理后的单轮记录。
      expect(seenReconciliation).toMatchObject({ roundCount: 2, resolved: 1, persisting: 0, introduced: 0 })
      expect(ledger?.output).toContain('修订对账通过（2 轮审查）：曾标记 1 项已全部销账。')

      // 未跑的门判未评估，不并入通过：已判定的两行（修订销账与法条缺口）计满分。
      expect(quality?.output).toContain('已判定 2/5 项')
      expect(quality?.output).toContain('未评估 3 项')
    } finally {
      disposeAtom()
      disposeHandler()
      disposeGapAtom()
      disposeGapHandler()
    }
  })
})
