/**
 * The approval seam for the two team mutations a case owner decides: creating a team and
 * closing it.
 *
 * The captain is the calling model, so it creates and deletes teams itself; a deployment
 * that wants the user to make those two decisions turns on the matching `Config` flag, and
 * the tool layer asks the mounted `approval` service for one decision before the mutation
 * runs. A missing answerer is a refusal rather than a pass: a fail-open path would be dead
 * on exactly the deployments that asked for the decision, which is why both outcomes raise
 * the same error type.
 * @module @deepseek-ai/dsh-patent-teams/approval
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
// Type-only: makes `ctx.get('approval')` resolve to the service this module asks.
import type {} from '@deepseek-ai/dsh-user-approval'

/** A gated team mutation the approval seam did not allow. */
export class TeamApprovalError extends Error {
  /** The decision that stopped the mutation, or `unavailable` when no answerer was reachable. */
  readonly outcome: ApprovalOutcome

  /**
   * @param outcome - the decision that stopped the mutation.
   * @param message - model-facing refusal naming the mutation and the decision behind it.
   */
  constructor(outcome: ApprovalOutcome, message: string) {
    super(message)
    this.name = 'TeamApprovalError'
    this.outcome = outcome
  }
}

/** One decision a gated mutation asks for. */
export interface TeamApprovalAsk {
  /** The calling captain; the approval service attributes the request to it. */
  readonly agent: Agent
  /** Tool whose mutation is being decided (`patent_teams_create` / `patent_teams_delete`). */
  readonly toolName: string
  /** The exact tool call, paired into the approval audit events. */
  readonly callId: ToolCallId
  /** Human-readable reason for the question, recorded in the audit events. */
  readonly reason: string
  /** Caller cancellation: an aborted question settles `cancelled` and blocks the mutation. */
  readonly signal: AbortSignal
}

/**
 * Ask the deployment's approval answerers for one decision; settle only when it was granted.
 * @param ctx - the plugin context; the `approval` service is resolved from it when mounted.
 * @param ask - the captain, tool, reason, and cancellation for the question.
 * @returns nothing; the promise settles only on an `allowed-once` decision.
 * @throws TeamApprovalError when no answerer is mounted or the decision was not a grant;
 *   a `never` policy is named as an automatic refusal rather than a user rejection.
 */
export async function requireTeamApproval(ctx: Context, ask: TeamApprovalAsk): Promise<void> {
  const approval = ctx.get('approval')
  if (approval === undefined) {
    throw new TeamApprovalError('unavailable', `${ask.reason}（本部署未挂载审批服务，按拒绝处理；挂载审批服务或关闭该审批开关后再执行）`)
  }
  // Read before asking: the policy decides whether any interactive answerer can
  // see this request, so a `never` refusal must not be reported as the user
  // rejecting the plan.
  const policy = approval.policyOf(ask.agent)
  const outcome = await approval.request({
    agent: ask.agent,
    toolName: ask.toolName,
    callId: ask.callId,
    reason: ask.reason,
    signal: ask.signal,
  })
  if (outcome !== 'allowed-once') {
    if (policy === 'never') {
      throw new TeamApprovalError(outcome, `${ask.reason}（本会话审批策略为 never：审批提示不会弹出，所有需要审批的操作被自动拒绝。这不是用户对本次操作的否决——请用户把权限模式切回会弹审批的模式后重试；不要重复调用）`)
    }
    throw new TeamApprovalError(outcome, `${ask.reason}（审批结果为 ${outcome}，本次操作未执行）`)
  }
}
