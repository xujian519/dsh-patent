/**
 * 门控域原子：approval-gate（人机审批门，人工介入中断）。
 *
 * 审批闭环（双路径共享同一放行契约，均为**门粒度**）：
 * - manifest 路径（runWorkflow）：宿主按 approvalGrants（stageId 集合）判定，命中时把
 *   放行标记注入 handler 执行态；
 * - 图路径：grantApproval 把**被批准的门节点 id 集合**写入检查点 state，resume 重放时
 *   节点按自身节点名判定（`isGateApproved`）并把标记注入 handler 执行态。
 * 两条路径的"放行判定"都收敛在本 handler 读取的同一个 `APPROVAL_GRANTED_KEY` 上——
 * 该键**只存在于 handler 的局部执行态**，由节点/宿主按门粒度注入，绝不写入共享 state
 * （写入共享 state 会让一次放行泄漏到同 run 内后续所有门，见 `workflow/executor.ts`
 * 与 `APPROVAL_GRANTED_NODES_KEY` 的说明）。
 */

import { type Atom } from '../../atom.ts'
import {
  type PipelineState,
  type StageExecuteInput,
  type StageHandler,
  InterruptStageError,
  getStateString,
} from '../../handler.ts'

/**
 * 审批门放行标记键：**只存在于 handler 的局部执行态**。节点/宿主（`graph/adapter.ts`、
 * `graph/domains/shared.ts`、`workflow/executor.ts`）按门粒度判定后注入执行态拷贝，
 * 共享 state 永不出现该键——否则一次放行会污染同 run 内后续所有审批门。
 * 键名以 `_` 开头 ⇒ 天然被 `collectStateText` 等"业务文本汇总"跳过。
 */
export const APPROVAL_GRANTED_KEY = '__approval_granted__'

/**
 * 门粒度放行记录键（**共享 state**）：值是本次 run 内**被批准的门节点 id 集合**。
 * 图路径由 `grantApproval` 按检查点 `activeNodes` 写入；节点读它判定自己是否被放行，
 * 再把 `APPROVAL_GRANTED_KEY` 注入自己的执行态拷贝（分工见上）。
 * 键名以 `_` 开头 ⇒ 天然被 `collectStateText` 等"业务文本汇总"跳过。
 */
export const APPROVAL_GRANTED_NODES_KEY = '__approval_granted_nodes__'

/**
 * 门粒度放行判定：共享 state 的放行记录是否包含该门节点 id。
 *
 * 调用方须传**自己在图内的节点名**（节点经 `GraphNodeContext.nodeName` 获得；
 * 拿不到节点名时不得退化为"任意放行"——fail-closed 更安全）。
 * @param state - 共享 state（含可选的放行记录键）。
 * @param nodeName - 调用方在图内的节点名。
 * @returns 该门节点是否已获人工批准。
 */
export function isGateApproved(state: PipelineState, nodeName: string): boolean {
  const granted = state[APPROVAL_GRANTED_NODES_KEY]
  return Array.isArray(granted) && granted.includes(nodeName)
}

/** 已批准审批门在 manifest 路径的占位输出（图路径无输出概念，不需要）。 */
export const APPROVAL_GRANTED_OUTPUT = 'APPROVED'

/**
 * 判断 handler 是否为审批门（按 name 契约，供 runWorkflow 注入放行标记）。
 * @param handler - 待判断的 StageHandler。
 * @returns 是否为审批门 handler。
 */
export function isApprovalGateHandler(handler: StageHandler): boolean {
  return handler.name === 'approval-gate'
}

/**
 * approval-gate 原子：人机审批门。
 *
 * `review_keys` 列出这次放行决定应看到的产出键（如 `['draft']`）：现场取用户决策的审批门
 * 把这些键的正文摘要附在审批问题上，放行者据此判断待确认内容；预批准路径与自定义门可省略。
 */
export const approvalGateAtom: Atom = {
  name: 'approval-gate',
  description: '人机审批门：挂起等待人工确认（返回中断错误，由上层恢复后继续；已批准时放行）',
  category: 'gate',
  inputSchema: ['review_context', 'guardrail_level', 'review_keys'],
  outputSchema: [],
}

/** approval-gate 执行器：挂起等待人工确认。 */
export class ApprovalGateHandler implements StageHandler {
  readonly name = 'approval-gate'
  readonly category = 'gate' as const

  /**
   * 执行 approval-gate 阶段（挂起等待人工确认），返回下一管线状态。
   * @param input - 阶段执行输入（state）。
   * @returns 下一管线状态（可能带降级标记）。
   */
  // oxlint-disable-next-line typescript/require-await -- StageHandler contract requires async execute
  async execute(input: StageExecuteInput): Promise<PipelineState> {
    const { state } = input
    // 已批准（调用方按门粒度判定后注入执行态拷贝）：放行不中断。
    if (state[APPROVAL_GRANTED_KEY]) {
      return {}
    }
    const reviewContext = getStateString(state, 'review_context') || '该阶段产出需要人工确认'
    const guardrailLevel = getStateString(state, 'guardrail_level') || 'high'
    throw new InterruptStageError('approval-gate', reviewContext, {
      guardrail_level: guardrailLevel,
      review_context: reviewContext,
    })
  }
}
