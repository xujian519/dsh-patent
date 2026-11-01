/**
 * Service Definition for the patent execution pipeline (ctx.patentWorkflow):
 * the workflow executor, the flexible-plan layer, and the plantask HITL state
 * machine. plantask awaiting_approval resolves through ctx.get('approval')
 * (optional composition); workflow-run and plantask state are appended to the
 * calling agent's session as patent/* events when a session is available.
 * @module @deepseek-ai/dsh-patent-workflow
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  StageExecutor,
  WorkflowContext,
  WorkflowManifest,
  WorkflowRunOptions,
  WorkflowRunResult,
} from '@deepseek-ai/dsh-patent-core'
import { registerBuiltinAtoms } from '@deepseek-ai/dsh-patent-core'
import { runWorkflow as runWorkflowPipeline } from './workflow.ts'
import { PlanTaskStateMachine, syncPlanToTasks, type PlanTask, type PlanTaskState } from './plantask.ts'
import { roundCapReached } from './docket-issue.ts'
import type {
  PatentAgent,
  PatentApprovalOutcome,
  PatentApprovalSeam,
  PatentWorkflowRunEvent,
  PlantaskRunOptions,
  PlantaskRunResult,
} from './types.ts'

// ---- pipeline API re-exports ----
export * from './workflow.ts'
export * from './plantask.ts'
export * from './docket-issue.ts'
export * from './flexible-plan.ts'
export * from './flexible-plan-store.ts'
export * from './worker-contract.ts'
export * from './role-contracts.ts'
export * from './workflow-store.ts'
export * from './workflow-dag.ts'
export * from './model-call-log.ts'
export * from './flow-graph.ts'
export type * from './types.ts'

/** Plugin config. */
export interface Config {
  /**
   * 一个案卷允许的规划轮次上限。达到上限后反馈不再驱动重规划，计划只能收在
   * 终态（finished）。轮次按 caseId 累计，计划收到终态时清零；0 表示一次重规划
   * 都不允许。
   */
  maxRounds?: number
}

/** 插件配置的解析结果：每个字段都已定值。 */
export type ResolvedConfig = { maxRounds: number }

/** 校验插件配置：字段级类型与取值下界，缺省值不在这里落定。 */
export const Config: z<Config> = z.object({
  maxRounds: z.natural(),
})

/**
 * 解析插件配置：把缺省值落定一次，之后各处只读 {@link ResolvedConfig}。
 * @param config - 校验后的插件配置（可缺省）。
 * @returns 每个字段都已定值的配置。
 */
export function resolveWorkflowConfig(config: Config = {}): ResolvedConfig {
  return { maxRounds: config.maxRounds ?? 3 }
}

/** A plantask parked at its awaiting_approval gate, awaiting the approve/reject decision. */
interface PendingPlantask {
  agent: PatentAgent
  caseId: string
  machine: PlanTaskStateMachine
  tasks: PlanTask[]
  toRun: string[]
}

/** Turn a closed approval outcome into the feedback that drives a replanning transition. */
function rejectionFeedback(outcome: PatentApprovalOutcome, feedback?: string): string {
  if (feedback !== undefined && feedback.trim() !== '') return feedback
  if (outcome === 'cancelled') return 'approval cancelled'
  if (outcome === 'unavailable') return 'no approval answerer available (fail closed)'
  return 'plan rejected by human approval'
}

/** Convert a workflow-run result into the durable patent/workflow-run event payload. */
function toWorkflowRunEvent(result: WorkflowRunResult, runId?: string): PatentWorkflowRunEvent {
  return { ...result, ...(runId !== undefined ? { runId } : {}) }
}

/**
 * Append one finished run's durable records to an agent session: the run
 * result, its evidence ledger, and its legal-gaps report. Service and tool
 * paths share this so the same manifest run yields the same event set.
 * @param agent - session-owning agent; when absent nothing is logged.
 * @param result - finished workflow run.
 * @param runId - caller-supplied run identity, when any.
 */
export function appendWorkflowRunEvents(
  agent: PatentAgent | undefined,
  result: WorkflowRunResult,
  runId?: string,
): void {
  if (agent === undefined) return
  agent.session.append('patent/workflow-run', toWorkflowRunEvent(result, runId))
  if (result.evidenceLedger !== undefined) {
    agent.session.append('patent/evidence-ledger', {
      manifestId: result.manifestId,
      ledger: result.evidenceLedger,
      ...(runId !== undefined ? { runId } : {}),
    })
  }
  const legalGaps = result.stages.find(stage => stage.atom === 'legal-gaps')
  if (legalGaps !== undefined) {
    agent.session.append('patent/legal-gaps', {
      manifestId: result.manifestId,
      report: legalGaps.output,
      ...(runId !== undefined ? { runId } : {}),
    })
  }
}

/**
 * PatentWorkflow service: the patent execution pipeline (ctx.patentWorkflow),
 * which runs workflow manifests, drives the plantask HITL state machine, and
 * holds the case-docket issue schema whose blocking and terminal grades the
 * state machine's transition guards enforce. `Config.maxRounds` bounds the
 * replanning rounds one case may spend. Approval is an optional seam read via
 * ctx.get('approval'); storage-backed file products are caller-provided stores
 * (see the package README). The constructor registers patent-core's built-in
 * atoms only: the six atoms that `@deepseek-ai/dsh-patent-tools` registers
 * (`eligibility`, `spec-check`, `slop-gate`, `draft-specification`,
 * `response-check`, `legal-gaps`) are absent unless that plugin is mounted or
 * the caller injects their contracts and handlers through the run options, and
 * a manifest declaring one of them fails the unknown-atom check before any
 * stage executes.
 */
export class PatentWorkflow extends Service {
  static Config: z<Config> = Config

  /** 已解析的插件配置。 */
  readonly config: ResolvedConfig

  private readonly pending = new Map<string, PendingPlantask>()
  /** 案卷 → 已完成的规划轮次；计划收到终态时删除登记。 */
  private readonly rounds = new Map<string, number>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'patentWorkflow')
    this.config = resolveWorkflowConfig(config)
    // 内置原子注册进全局注册表（幂等）：服务路径的 runWorkflow 与工具路径共用，
    // 不注册则 atom-bearing manifest 在 fail-fast 处抛错。
    registerBuiltinAtoms()
  }

  /**
   * Run a workflow manifest via the ported executor. When an agent is given,
   * the run result is appended to its session as a patent/workflow-run event.
   * @param manifest - the workflow to run.
   * @param wctx - the workflow context (caseId/input + stage state).
   * @param executor - fallback stage executor for stages without an atom.
   * @param options - handlers/atoms/provider/persist/approvalGrants/runId.
   * @param agent - optional agent whose session records the run.
   * @returns the run result (also persisted via options.persist when given).
   */
  async runWorkflow(
    manifest: WorkflowManifest,
    wctx: WorkflowContext,
    executor?: StageExecutor,
    options?: WorkflowRunOptions,
    agent?: PatentAgent,
  ): Promise<WorkflowRunResult> {
    const result = await runWorkflowPipeline(manifest, wctx, executor, options)
    appendWorkflowRunEvents(agent, result, options?.runId)
    return result
  }

  /**
   * Drive a plantask plan through planning → awaiting_approval → executing.
   * The awaiting_approval gate resolves through ctx.get('approval'); without an
   * approval service the plan fails closed (replanning with a feedback) rather
   * than auto-approving. Set options.autoApprove to false to leave the plan
   * pending for an out-of-band approve/reject.
   * @param agent - the agent whose session records the patent/plantask events.
   * @param caseId - case identity keying the tracked pending plantask.
   * @param planSteps - the ordered plan steps to sync into tasks.
   * @param options - autoApprove and approvalReason.
   * @returns the final plantask state plus tasks and the approval outcome.
   */
  async runPlantask(
    agent: PatentAgent,
    caseId: string,
    planSteps: string[],
    options?: PlantaskRunOptions,
  ): Promise<PlantaskRunResult> {
    const machine = new PlanTaskStateMachine()
    const { tasks, toRun } = syncPlanToTasks(planSteps)
    if (this.pending.has(caseId)) {
      throw new Error(
        `patentWorkflow: caseId "${caseId}" 已有挂起的 plantask，拒绝覆盖（先 approve/reject 或等待其完成）`,
      )
    }
    machine.transition('awaiting_approval')
    this.appendPlantask(agent, caseId, machine.state, tasks)
    this.pending.set(caseId, { agent, caseId, machine, tasks, toRun })

    if (options?.autoApprove === false) {
      return { caseId, state: machine.state, tasks, toRun }
    }

    try {
      const approval = this.ctx.get('approval') as PatentApprovalSeam | undefined
      const outcome: PatentApprovalOutcome = approval !== undefined
        ? await approval.request({ agent, toolName: 'patent_plantask', reason: options?.approvalReason })
        : 'unavailable'
      return this.applyDecision(caseId, outcome)
    } catch (error) {
      // 审批请求或决策迁移抛错时不留僵尸 pending：caseId 必须可重试，
      // 否则该 case 会被"已有挂起 plantask"永久锁死到进程重启。
      this.pending.delete(caseId)
      throw error
    }
  }

  /**
   * Decision entry: approve a pending plantask (resume to executing).
   * Single-session single-case semantics: one pending plantask per caseId;
   * concurrent runs of the same caseId are rejected by runPlantask.
   * @param caseId - the case keying the parked plantask.
   * @returns the final plantask state, tasks, and approval outcome.
   */
  approve(caseId: string): PlantaskRunResult {
    return this.applyDecision(caseId, 'allowed-once')
  }

  /**
   * Decision entry: reject a pending plantask and roll back to replanning.
   * @param caseId - the case keying the parked plantask.
   * @param feedback - optional rejection feedback driving the replanning transition.
   * @returns the final plantask state, tasks, and approval outcome.
   */
  reject(caseId: string, feedback?: string): PlantaskRunResult {
    return this.applyDecision(caseId, 'rejected', feedback)
  }

  private applyDecision(caseId: string, outcome: PatentApprovalOutcome, feedback?: string): PlantaskRunResult {
    const pending = this.pending.get(caseId)
    if (pending === undefined) {
      throw new Error(`patentWorkflow: no pending plantask for caseId "${caseId}"`)
    }
    const rounds = this.rounds.get(caseId) ?? 0
    const { maxRounds } = this.config
    let roundCapExhausted = false
    if (outcome === 'allowed-once') {
      pending.machine.transition('executing', { tasks: pending.tasks })
    } else if (roundCapReached(rounds, maxRounds)) {
      // 轮次封顶：反馈不再驱动重规划，计划直接收在终态；耗尽事实随结果回报。
      pending.machine.transition('finished')
      roundCapExhausted = true
      this.rounds.delete(caseId)
    } else {
      pending.machine.transition('replanning', { feedback: rejectionFeedback(outcome, feedback), rounds, maxRounds })
      this.rounds.set(caseId, rounds + 1)
    }
    const state = pending.machine.state
    this.appendPlantask(pending.agent, caseId, state, pending.tasks, feedback)
    this.pending.delete(caseId)
    return {
      caseId,
      state,
      tasks: pending.tasks,
      toRun: pending.toRun,
      approvalOutcome: outcome,
      ...(roundCapExhausted ? { roundCapExhausted } : {}),
      ...(feedback !== undefined ? { feedback } : {}),
    }
  }

  private appendPlantask(
    agent: PatentAgent,
    caseId: string,
    state: PlanTaskState,
    tasks: PlanTask[],
    feedback?: string,
  ): void {
    agent.session.append('patent/plantask', {
      caseId,
      state,
      tasks,
      ...(feedback !== undefined ? { feedback } : {}),
    })
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    patentWorkflow: PatentWorkflow
  }
}

export default PatentWorkflow
