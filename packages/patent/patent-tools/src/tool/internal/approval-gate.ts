/**
 * Live approval gate for manifest runs.
 *
 * A manifest's `approval-gate` stage normally pauses the run, and the caller
 * passes the stage id back in `approveStageIds` to continue — a model-supplied
 * whitelist, so the "human decision" exists only in the model's account of the
 * previous turn. This handler asks the deployment's `approval` service at the
 * gate instead, and only a granted decision continues the run. A refusal, a
 * cancellation, a missing service, or a `never` policy pauses the run with the
 * reason, so the failure direction stays closed.
 * @module @deepseek-ai/dsh-patent-tools/tool/internal/approval-gate
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { ApprovalOutcome, ApprovalService } from '@deepseek-ai/dsh-user-approval'
import {
  APPROVAL_GRANTED_KEY,
  ApprovalGateHandler,
  InterruptStageError,
  getStateString,
  type PipelineState,
  type StageExecuteInput,
} from '@deepseek-ai/dsh-patent-core'

/** The approval service methods a live gate consumes. */
export type ApprovalFace = Pick<ApprovalService, 'policyOf' | 'request'>

/** What one live gate needs from the calling run. */
export interface LiveApprovalGateOptions {
  /** The agent the approval request is attributed to and audited on. */
  readonly agent: Agent
  /** The `patent_workflow_run` call the prompt attaches to. */
  readonly callId: ToolCallId
  /** Manifest id named in the prompt and refusal text. */
  readonly manifestId: string
  /** Resolve the deployment's approval service when the gate is reached. */
  readonly service: () => ApprovalFace | undefined
  /** Run cancellation, forwarded so an aborted run withdraws the question. */
  readonly signal?: AbortSignal
}

/** The reason text for one gate, from the stage's review context. */
function gateReason(manifestId: string, reviewContext: string): string {
  return `工作流 ${manifestId} 到达人工审批门：${reviewContext}。是否放行并继续后续阶段？`
}

/**
 * Approval gate that asks the deployment's approval service at the stage.
 *
 * A granted decision returns {@link APPROVAL_GRANTED_KEY}; the executor strips
 * that marker before merging the stage output, so it cannot leak to later gates
 * and the run records the same `APPROVED` placeholder a pre-approved gate writes.
 */
export class LiveApprovalGateHandler extends ApprovalGateHandler {
  /**
   * @param options - the calling agent, tool call, manifest, and approval lookup.
   */
  constructor(private readonly options: LiveApprovalGateOptions) {
    super()
  }

  /**
   * Ask for one decision; continue only on `allowed-once`.
   * @param input - the stage execution state carrying the gate's review context.
   * @returns the granted marker on approval, or an empty stage delta.
   * @throws InterruptStageError when no decision granted the stage; its message
   *   names the outcome so the paused run explains itself.
   */
  override async execute(input: StageExecuteInput): Promise<PipelineState> {
    if (input.state[APPROVAL_GRANTED_KEY] === true) return {}
    const reviewContext = getStateString(input.state, 'review_context') || '该阶段产出需要人工确认'
    const service = this.options.service()
    if (service === undefined) {
      throw new InterruptStageError(
        'approval-gate',
        `工作流 ${this.options.manifestId} 到达审批门（${reviewContext}）：本部署未挂载审批服务，按拒绝处理；挂载审批服务或改用显式 approveStageIds 后重跑`,
        { outcome: 'unavailable' },
      )
    }
    const policy = service.policyOf(this.options.agent)
    let outcome: ApprovalOutcome
    try {
      outcome = await service.request({
        agent: this.options.agent,
        toolName: 'patent_workflow_run',
        callId: this.options.callId,
        reason: gateReason(this.options.manifestId, reviewContext),
        ...(this.options.signal !== undefined ? { signal: this.options.signal } : {}),
      })
    } catch (error) {
      // A background job's turn has already closed, and an audit failure leaves
      // no recorded decision; both mean no approval, so the run pauses.
      throw new InterruptStageError(
        'approval-gate',
        `工作流 ${this.options.manifestId} 的审批门（${reviewContext}）无法取得审批（${String(error)}），按拒绝处理；后续阶段未执行`,
        { outcome: 'unavailable' },
      )
    }
    if (outcome === 'allowed-once') return { [APPROVAL_GRANTED_KEY]: true }
    const detail = policy === 'never'
      ? '本会话审批策略为 never：审批提示不会弹出，所有需要审批的操作被自动拒绝。这不是用户对本次运行的否决——请把权限模式切回会弹审批的模式后重跑，不要重复调用'
      : `审批结果为 ${outcome}`
    throw new InterruptStageError(
      'approval-gate',
      `工作流 ${this.options.manifestId} 的审批门（${reviewContext}）未放行：${detail}；后续阶段未执行`,
      { outcome },
    )
  }
}
