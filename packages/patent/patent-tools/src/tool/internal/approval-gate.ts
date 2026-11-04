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

/** Characters of each pending deliverable quoted in the approval question. */
const REVIEW_PREVIEW_CHARS = 140

/** Deliverables quoted at most, so the question stays one readable approval headline. */
const REVIEW_PREVIEW_LIMIT = 2

/**
 * Read the pending deliverables named by the gate stage's `review_keys` param.
 * @param state - the gate's execution state, with the stage params merged in.
 * @returns one single-line preview per key that carries text, at most
 *   {@link REVIEW_PREVIEW_LIMIT}.
 */
function reviewPreviews(state: PipelineState): string[] {
  const keys = state['review_keys']
  if (!Array.isArray(keys)) return []
  const previews: string[] = []
  for (const key of keys) {
    if (previews.length >= REVIEW_PREVIEW_LIMIT) break
    if (typeof key !== 'string') continue
    const value = state[key]
    if (typeof value !== 'string') continue
    const text = value.replace(/\s+/gu, ' ').trim()
    if (text === '') continue
    const excerpt = text.slice(0, REVIEW_PREVIEW_CHARS)
    previews.push(`${key}：${excerpt}${text.length > REVIEW_PREVIEW_CHARS ? '…' : ''}`)
  }
  return previews
}

/**
 * The reason text for one gate, from the stage's review context and pending deliverables.
 * @param manifestId - the manifest id named in the question.
 * @param reviewContext - the stage's review context sentence.
 * @param state - the gate's execution state.
 * @returns the approval question with bounded deliverable previews.
 */
function gateReason(manifestId: string, reviewContext: string, state: PipelineState): string {
  const previews = reviewPreviews(state)
  const pending = previews.length === 0 ? '' : `待确认产出：${previews.join('；')}。`
  return `工作流 ${manifestId} 到达人工审批门：${reviewContext}。${pending}是否放行并继续后续阶段？`
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
        `工作流 ${this.options.manifestId} 到达审批门（${reviewContext}）：本部署的审批服务在运行中不可用，按拒绝处理；关闭 approveStageGates 或改用后台运行后重跑`,
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
        reason: gateReason(this.options.manifestId, reviewContext, input.state),
        ...(this.options.signal !== undefined ? { signal: this.options.signal } : {}),
      })
    } catch (error) {
      // A closed turn (the audit pair cannot commit) or a failed audit append
      // leaves no recorded decision; both mean no approval, so the run pauses.
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
