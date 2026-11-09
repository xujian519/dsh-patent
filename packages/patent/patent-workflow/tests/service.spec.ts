// Real-service test: mounts the patent-workflow service on a real Context with a
// real approval provider (dsh-user-approval + a fake answerer) and a real
// Session, drives a plantask run, and asserts the approval_pending -> approve
// -> resume flow and the patent/* session events on the real session log.
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import {
  globalAtomRegistry,
  globalStageHandlerRegistry,
  registerBuiltinAtoms,
  type PipelineState,
  type StageHandler,
  type StageProvider,
  type WorkflowManifest,
} from '@deepseek-ai/dsh-patent-core'
import PatentWorkflow, { patentNoveltyManifest } from '@deepseek-ai/dsh-patent-workflow'

// 镜像生产装配（B1）：内置原子注册进全局注册表，novelty 等 manifest 的 atom 阶段才能通过 fail-fast。
registerBuiltinAtoms()
// legal-gaps 的真实注册在 patent-tools apply()；此处注册契约 stub 使内置 manifest 通过校验。
globalAtomRegistry.register({
  name: 'legal-gaps',
  category: 'gate',
  description: 'test stub — 真实注册在 patent-tools apply()',
  inputSchema: [],
  outputSchema: ['legal_gaps_report'],
})

function makeAgent(id: string): { session: Session } {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  return { session }
}

function okExecutor(stage: { id: string }): Promise<string> {
  return Promise.resolve('[' + stage.id + '] 完成')
}

/**
 * 原子检索所需的最小 provider：关键词生成给出稳定 JSON，检索返回空语料。
 * 空语料让 prior-art-filter 通过“检索结果为空”分支，而无需伪造外部检索。
 */
const emptySearchProvider: StageProvider = {
  callLLM: async () => '{"keywords":["装置"]}',
  search: async () => [],
}

describe('PatentWorkflow service', () => {
  it('drives a plantask run through approval_pending -> approve -> resume', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(ApprovalService)
    await ctx.plugin(PatentWorkflow)
    try {
      const agent = makeAgent('plantask-approve')
      ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))

      const result = await ctx.patentWorkflow.runPlantask(agent, 'case-1', ['解析交底书', '检索现有技术'])

      expect(result.state).toBe('executing')
      expect(result.approvalOutcome).toBe('allowed-once')
      expect(result.tasks).toHaveLength(2)

      const states = agent.session.snapshotEvents()
        .filter(e => e.type === 'patent/plantask')
        .map(e => e.data.state)
      expect(states).toEqual(['awaiting_approval', 'executing'])

      expect(agent.session.snapshotEvents().some(e => e.type === 'approval/asked')).toBe(true)
      expect(agent.session.snapshotEvents().some(e => e.type === 'approval/decided')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails closed (replanning) when no approval answerer is composed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(ApprovalService)
    await ctx.plugin(PatentWorkflow)
    try {
      const agent = makeAgent('plantask-no-answerer')
      const result = await ctx.patentWorkflow.runPlantask(agent, 'case-2', ['步骤A'])

      expect(result.state).toBe('replanning')
      expect(result.approvalOutcome).toBe('unavailable')
      const states = agent.session.snapshotEvents()
        .filter(e => e.type === 'patent/plantask')
        .map(e => e.data.state)
      expect(states).toEqual(['awaiting_approval', 'replanning'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('supports an out-of-band approve/reject decision entry', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(ApprovalService)
    await ctx.plugin(PatentWorkflow)
    try {
      const agent = makeAgent('plantask-oob')
      const pending = await ctx.patentWorkflow.runPlantask(agent, 'case-3', ['步骤A', '步骤B'], { autoApprove: false })
      expect(pending.state).toBe('awaiting_approval')

      const approved = ctx.patentWorkflow.approve('case-3')
      expect(approved.state).toBe('executing')
      expect(approved.approvalOutcome).toBe('allowed-once')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records the paused and resumed attempts of one runId as separate workflow-run events', async () => {
    const manifest: WorkflowManifest = {
      id: 'recovery_event_v1',
      name: '恢复事件',
      caseType: 'test',
      stages: [
        {
          id: 'review',
          strategy: 'chain',
          description: '人工确认结论',
          atom: 'approval-gate',
          params: { review_context: '确认结论' },
        },
      ],
    }
    const ctx = new Context()
    await ctx.plugin(PatentWorkflow)
    try {
      const agent = makeAgent('workflow-recovery-events')
      const paused = await ctx.patentWorkflow.runWorkflow(manifest, {}, undefined, { runId: 'run-recover' }, agent)
      expect(paused.completed).toBe(false)
      expect(paused.interrupted?.stageId).toBe('review')

      const resumed = await ctx.patentWorkflow.runWorkflow(
        manifest,
        {},
        undefined,
        { runId: 'run-recover', approvalGrants: ['review'] },
        agent,
      )
      expect(resumed.completed).toBe(true)

      const events = agent.session.snapshotEvents().filter(e => e.type === 'patent/workflow-run')
      expect(events.map(e => e.data.completed)).toEqual([false, true])
      expect(events[0]!.data.interrupted?.stageId).toBe('review')
      expect(events[1]!.data.interrupted).toBeUndefined()
      expect(events.map(e => e.data.runId)).toEqual(['run-recover', 'run-recover'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('consumes a pending plantask decision once; repeated approve/reject throw', async () => {
    const ctx = new Context()
    await ctx.plugin(PatentWorkflow)
    try {
      const agent = makeAgent('plantask-double-decision')
      await ctx.patentWorkflow.runPlantask(agent, 'case-double', ['步骤A'], { autoApprove: false })
      expect(ctx.patentWorkflow.approve('case-double').state).toBe('executing')
      expect(() => ctx.patentWorkflow.approve('case-double')).toThrow(/no pending plantask/)
      expect(() => ctx.patentWorkflow.reject('case-double')).toThrow(/no pending plantask/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('only locks awaiting_approval: an approved caseId can start a new plan', async () => {
    const ctx = new Context()
    await ctx.plugin(PatentWorkflow)
    try {
      const agent = makeAgent('plantask-reinvoke')
      await ctx.patentWorkflow.runPlantask(agent, 'case-reinvoke', ['步骤A'], { autoApprove: false })
      ctx.patentWorkflow.approve('case-reinvoke')

      // executing 之后没有服务端状态可查；同一 caseId 再次发起等于新计划，而不是被旧计划锁死。
      const again = await ctx.patentWorkflow.runPlantask(agent, 'case-reinvoke', ['步骤B'], { autoApprove: false })
      expect(again.state).toBe('awaiting_approval')
      expect(again.tasks.map(task => task.description)).toEqual(['步骤B'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records a workflow run as a patent/workflow-run session event', async () => {
    const ctx = new Context()
    await ctx.plugin(PatentWorkflow)
    try {
      const agent = makeAgent('workflow-run')
      const result = await ctx.patentWorkflow.runWorkflow(
        patentNoveltyManifest,
        { input: '一种装置', filing_date: '2024-06-01' },
        okExecutor,
        { provider: emptySearchProvider, approvalGrants: ['approval'] },
        agent,
      )

      expect(result.completed).toBe(true)
      const events = agent.session.snapshotEvents().filter(e => e.type === 'patent/workflow-run')
      expect(events).toHaveLength(1)
      expect(events[0]!.data.manifestId).toBe('patent_novelty_v1')
      expect(events[0]!.data.summary).toContain('专利新颖性分析')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records the run evidence ledger as a patent/evidence-ledger session event', async () => {
    const ctx = new Context()
    await ctx.plugin(PatentWorkflow)
    try {
      const agent = makeAgent('workflow-ledger')
      const result = await ctx.patentWorkflow.runWorkflow(
        patentNoveltyManifest,
        {
          input: '一种装置',
          filing_date: '2024-06-01',
          prior_art: [{ dLabel: 'D1', title: '对比文件', url: 'https://example.test/D1' }],
        },
        okExecutor,
        { provider: emptySearchProvider, approvalGrants: ['approval'], runId: 'run-ledger' },
        agent,
      )

      expect(result.evidenceLedger?.receipts.map(receipt => receipt.citationId)).toEqual(['MATERIAL', 'D1'])
      const events = agent.session.snapshotEvents().filter(e => e.type === 'patent/evidence-ledger')
      expect(events).toHaveLength(1)
      expect(events[0]!.data.manifestId).toBe('patent_novelty_v1')
      expect(events[0]!.data.runId).toBe('run-ledger')
      expect(events[0]!.data.ledger.receipts.map(receipt => receipt.citationId)).toEqual(['MATERIAL', 'D1'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('runWorkflow without an agent records no session event; runId travels with the event', async () => {
    const ctx = new Context()
    await ctx.plugin(PatentWorkflow)
    try {
      const noAgent = await ctx.patentWorkflow.runWorkflow(
        patentNoveltyManifest,
        { input: '一种装置', filing_date: '2024-06-01' },
        okExecutor,
        { provider: emptySearchProvider, approvalGrants: ['approval'] },
      )
      expect(noAgent.completed).toBe(true)

      const agent = makeAgent('workflow-run-id')
      const withRunId = await ctx.patentWorkflow.runWorkflow(
        patentNoveltyManifest,
        { input: '一种装置', filing_date: '2024-06-01' },
        okExecutor,
        { provider: emptySearchProvider, runId: 'run-42', approvalGrants: ['approval'] },
        agent,
      )
      expect(withRunId.completed).toBe(true)
      const events = agent.session.snapshotEvents().filter(e => e.type === 'patent/workflow-run')
      expect(events).toHaveLength(1)
      expect(events[0]!.data.runId).toBe('run-42')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('records a legal-gaps stage as a patent/legal-gaps session event', async () => {
    class StubLegalGapsHandler implements StageHandler {
      readonly name = 'legal-gaps'
      readonly category = 'gate' as const
      execute(): Promise<PipelineState> {
        return Promise.resolve({ legal_gaps_report: '法条缺口汇总（审查意见答复）：无阻断项' })
      }
    }
    globalStageHandlerRegistry.register(new StubLegalGapsHandler())
    const manifest: WorkflowManifest = {
      id: 'legal_gaps_event_v1',
      name: '法条缺口事件',
      caseType: 'oa_response',
      stages: [
        {
          id: 'legal_gaps',
          strategy: 'chain',
          description: '汇总法条缺口',
          atom: 'legal-gaps',
          params: { profile: 'oa-response' },
        },
      ],
    }
    const ctx = new Context()
    await ctx.plugin(PatentWorkflow)
    try {
      const agent = makeAgent('legal-gaps-event')
      const result = await ctx.patentWorkflow.runWorkflow(manifest, {}, okExecutor, { runId: 'run-gaps' }, agent)
      expect(result.completed).toBe(true)
      const events = agent.session.snapshotEvents().filter(e => e.type === 'patent/legal-gaps')
      expect(events).toHaveLength(1)
      expect(events[0]!.data.manifestId).toBe('legal_gaps_event_v1')
      expect(events[0]!.data.runId).toBe('run-gaps')
      expect(events[0]!.data.report).toContain('无阻断项')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('runPlantask rejects a duplicate pending caseId (no overwrite)', async () => {
    const ctx = new Context()
    await ctx.plugin(PatentWorkflow)
    try {
      const agent = makeAgent('plantask-duplicate')
      await ctx.patentWorkflow.runPlantask(agent, 'case-dup', ['步骤A'], { autoApprove: false })
      await expect(ctx.patentWorkflow.runPlantask(agent, 'case-dup', ['步骤B'], { autoApprove: false }))
        .rejects.toThrow(/已有挂起的 plantask/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects an empty plan before asking for approval, leaving the caseId usable', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(ApprovalService)
    await ctx.plugin(PatentWorkflow)
    try {
      const agent = makeAgent('plantask-empty-plan')
      let asked = 0
      ctx.on('approval/request', () => {
        asked += 1
        return Promise.resolve<ApprovalOutcome>('allowed-once')
      })

      await expect(ctx.patentWorkflow.runPlantask(agent, 'case-empty', []))
        .rejects.toThrow(/计划步骤不能为空/)

      // 没有可取审批的任务：不询问、不落 pending、不写 plantask 事件。
      expect(asked).toBe(0)
      expect(agent.session.snapshotEvents().some(event => event.type === 'patent/plantask')).toBe(false)

      // caseId 没有被"已有挂起 plantask"锁死。
      const again = await ctx.patentWorkflow.runPlantask(agent, 'case-empty', ['步骤A'], { autoApprove: false })
      expect(again.state).toBe('awaiting_approval')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails closed to replanning when no approval service is composed at all', async () => {
    const ctx = new Context()
    await ctx.plugin(PatentWorkflow)
    try {
      const agent = makeAgent('plantask-no-service')
      const result = await ctx.patentWorkflow.runPlantask(agent, 'case-none', ['步骤A'])
      expect(result.state).toBe('replanning')
      expect(result.approvalOutcome).toBe('unavailable')
      // 拒绝反馈未显式传入 → 结果不含 feedback 字段（驱动迁移的默认文案不进结果）。
      expect(result.feedback).toBeUndefined()
      const states = agent.session.snapshotEvents()
        .filter(e => e.type === 'patent/plantask')
        .map(e => e.data.state)
      expect(states).toEqual(['awaiting_approval', 'replanning'])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('a cancelled approval decision replans with the cancellation feedback', async () => {
    const ctx = new Context()
    await ctx.plugin(PatentWorkflow)
    try {
      ctx.provide('approval', { request: async () => 'cancelled' as const })
      const agent = makeAgent('plantask-cancelled')
      const result = await ctx.patentWorkflow.runPlantask(agent, 'case-cancel', ['步骤A'])
      expect(result.state).toBe('replanning')
      expect(result.approvalOutcome).toBe('cancelled')
      expect(result.feedback).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reject with and without feedback drives the replanning transition', async () => {
    const ctx = new Context()
    await ctx.plugin(PatentWorkflow)
    try {
      const agent = makeAgent('plantask-reject')
      await ctx.patentWorkflow.runPlantask(agent, 'case-reject', ['步骤A'], { autoApprove: false })

      const blank = ctx.patentWorkflow.reject('case-reject', '   ')
      expect(blank.state).toBe('replanning')
      expect(blank.approvalOutcome).toBe('rejected')
      // 空白反馈原样透传（驱动迁移的反馈由 rejectionFeedback 兜底为默认文案）。
      expect(blank.feedback).toBe('   ')

      await ctx.patentWorkflow.runPlantask(agent, 'case-reject-2', ['步骤A'], { autoApprove: false })
      const withFeedback = ctx.patentWorkflow.reject('case-reject-2', '对比文件不足')
      expect(withFeedback.state).toBe('replanning')
      expect(withFeedback.feedback).toBe('对比文件不足')

      await ctx.patentWorkflow.runPlantask(agent, 'case-reject-3', ['步骤A'], { autoApprove: false })
      const silent = ctx.patentWorkflow.reject('case-reject-3')
      expect(silent.state).toBe('replanning')
      expect(silent.feedback).toBeUndefined()
      expect(silent.approvalOutcome).toBe('rejected')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('轮次上限封顶：第 maxRounds+1 次反馈把计划收在终态并回报耗尽', async () => {
    const ctx = new Context()
    await ctx.plugin(PatentWorkflow)
    try {
      const agent = makeAgent('plantask-cap')
      for (const [idx, feedback] of ['第1次', '第2次', '第3次'].entries()) {
        await ctx.patentWorkflow.runPlantask(agent, 'case-cap', [`步骤${idx + 1}`], { autoApprove: false })
        const rejected = ctx.patentWorkflow.reject('case-cap', feedback)
        expect(rejected.state).toBe('replanning')
        expect(rejected.roundCapExhausted).toBeUndefined()
      }

      await ctx.patentWorkflow.runPlantask(agent, 'case-cap', ['步骤4'], { autoApprove: false })
      const capped = ctx.patentWorkflow.reject('case-cap', '第4次')
      expect(capped.state).toBe('finished')
      expect(capped.roundCapExhausted).toBe(true)
      expect(capped.approvalOutcome).toBe('rejected')

      // 封顶时登记清零：同一案卷可重新起一轮。
      const again = await ctx.patentWorkflow.runPlantask(agent, 'case-cap', ['步骤5'], { autoApprove: false })
      expect(again.state).toBe('awaiting_approval')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('maxRounds 为 0 时首次反馈直接收在终态', async () => {
    const ctx = new Context()
    await ctx.plugin(PatentWorkflow, { maxRounds: 0 })
    try {
      const agent = makeAgent('plantask-cap-zero')
      await ctx.patentWorkflow.runPlantask(agent, 'case-zero', ['步骤A'], { autoApprove: false })
      const capped = ctx.patentWorkflow.reject('case-zero', '不批')
      expect(capped.state).toBe('finished')
      expect(capped.roundCapExhausted).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('approve 不受轮次上限影响', async () => {
    const ctx = new Context()
    await ctx.plugin(PatentWorkflow, { maxRounds: 0 })
    try {
      const agent = makeAgent('plantask-cap-approve')
      await ctx.patentWorkflow.runPlantask(agent, 'case-approve', ['步骤A'], { autoApprove: false })
      const approved = ctx.patentWorkflow.approve('case-approve')
      expect(approved.state).toBe('executing')
      expect(approved.roundCapExhausted).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('approve/reject on a case without a pending plantask throw', async () => {
    const ctx = new Context()
    await ctx.plugin(PatentWorkflow)
    try {
      expect(() => ctx.patentWorkflow.approve('ghost-case')).toThrow(/no pending plantask/)
      expect(() => ctx.patentWorkflow.reject('ghost-case')).toThrow(/no pending plantask/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('runPlantask cleans up the pending entry when approval.request throws (caseId stays retryable)', async () => {
    const ctx = new Context()
    await ctx.plugin(PatentWorkflow)
    // 抛错的 approval 服务：runPlantask 必须先落 pending 再请求，抛错后必须清掉。
    ctx.provide('approval', { request: async () => { throw new Error('approval unavailable') } })
    try {
      const agent = makeAgent('plantask-throw')
      await expect(ctx.patentWorkflow.runPlantask(agent, 'case-throw', ['解析交底书']))
        .rejects.toThrow('approval unavailable')
      // pending 已清理：同 caseId 可再次发起（不会被"已有挂起 plantask"锁死）。
      const again = await ctx.patentWorkflow.runPlantask(agent, 'case-throw', ['解析交底书'], { autoApprove: false })
      expect(again.state).toBe('awaiting_approval')
      expect(again.caseId).toBe('case-throw')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('removes ctx.patentWorkflow when its fiber disposes (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(ApprovalService)
    const fiber = ctx.plugin(PatentWorkflow)
    await fiber
    expect(ctx.patentWorkflow).toBeInstanceOf(PatentWorkflow)
    await fiber.dispose()
    expect(ctx.get('patentWorkflow')).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
