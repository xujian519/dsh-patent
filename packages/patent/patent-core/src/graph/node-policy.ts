/**
 * src/patent/graph — 节点策略执行（移植自 Mady graph/node_policy.go）。
 *
 * 单次节点执行封装：
 * - 超时：timeoutMs 为**总时长（含全部重试）**，超时注入 AbortSignal 并中止重试；
 * - 重试：maxRetries 次，间隔 retryDelayMs * 2^(attempt-1)（指数退避）；
 * - panic 捕获：节点同步抛错统一转为失败结果；
 * - sideEffect：delta 不合并（调用方决定，见 engine）。
 */

import type { GraphNode, GraphNodeContext, NodeOutcome, NodePolicy } from './types.ts'
import { isGraphInterruptError } from './types.ts'
import { isStageCancelledError } from '../atoms/handler.ts'

/** 默认重试间隔基准（ms）。 */
const DEFAULT_RETRY_DELAY_MS = 100

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 硬上界：ms 内未 settle 则以超时错误拒绝。底层 promise 无法取消（节点可能
 * 仍在跑），但调用方不再等待——超时语义是总时长截止后不再采信结果。
 * @param promise - 待竞速的节点调用。
 * @param ms - 硬上界毫秒；<=0 直接返回原 promise。
 * @returns 节点结果或超时错误。
 */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  if (ms <= 0) return promise
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { reject(new Error('节点执行超时（硬上界）')) }, ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    /* v8 ignore next -- the timeout promise's executor always assigns the timer before the race settles */
    if (timer !== undefined) clearTimeout(timer)
  })
}

/**
 * 按策略执行节点（含重试/超时/panic 捕获）。
 * 返回 { ok: true, delta } 或 { ok: false, error }；不抛错（中断错误除外，由 engine 另行处理）。
 * @param node - 要执行的图节点。
 * @param policy - 节点策略（可缺省）。
 * @param ctx - 节点执行上下文。
 * @returns 执行结果（成功携带增量，失败携带错误）。
 */
export async function runNodeWithPolicy(
  node: GraphNode,
  policy: NodePolicy | undefined,
  ctx: GraphNodeContext,
): Promise<NodeOutcome> {
  const maxRetries = policy?.maxRetries ?? 0
  const timeoutMs = policy?.timeoutMs ?? 0
  const retryDelayMs = policy?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : null

  let lastError: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (deadline !== null && Date.now() >= deadline) {
      /* v8 ignore next -- the first attempt cannot start past its own deadline, so lastError is always set here */
      return { ok: false, error: lastError ?? new Error(`节点执行超时（${timeoutMs}ms，含 ${maxRetries} 次重试）`) }
    }
    const controller = new AbortController()
    const remaining = deadline !== null ? Math.max(0, deadline - Date.now()) : 0
    let timedOut = false
    const timer = deadline !== null
      ? setTimeout(() => { timedOut = true; controller.abort() }, remaining)
      : null
    // 调用方取消（引擎 opts.signal）联动节点 abort：不区分来源，节点尽早退出。
    const onCallerAbort = (): void => { controller.abort() }
    ctx.signal?.addEventListener('abort', onCallerAbort, { once: true })
    if (ctx.signal?.aborted === true) controller.abort()
    try {
      // 硬上界：节点不听 signal 而挂起时，race 在 remaining 后拒绝，超步不会无限等待。
      // 剩余时长取整到 0 表示"无上界"，而这里必须保留上界：截止前最后一毫秒算出的 0
      // 会让无视 signal 的节点无限挂起，故按 1ms 起算。
      const delta = await withDeadline(node({ ...ctx, signal: controller.signal }), deadline === null ? 0 : Math.max(1, remaining))
      // 超时后完成的节点视为失败（超时语义：总时长截止后不再采信结果）。
      if (controller.signal.aborted) {
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- timedOut is set by the deadline timer's callback
        return { ok: false, error: new Error(timedOut ? '节点执行超时（结果在超时后返回）' : '节点执行已取消') }
      }
      // sideEffect 节点：delta 不合并（返回空片段，由调用方忽略）。
      return policy?.sideEffect === true ? { ok: true, delta: {} } : { ok: true, delta }
    } catch (err) {
      // 中断错误（审批门等）：穿透不重试（由引擎转为 interrupted 暂停）。
      if (isGraphInterruptError(err)) throw err
      // 调用方取消：穿透不重试；节点级超时（controller 中止、调用方信号未中止）
      // 仍按节点失败处理，避免把超时上报为全图取消。
      if (isStageCancelledError(err) && ctx.signal?.aborted === true) throw err
      lastError = err
      if (controller.signal.aborted) {
        // 超时/取消：中止重试（对齐 Mady 超时跨重试截断）。
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- timedOut is set by the deadline timer's callback
        return { ok: false, error: timedOut ? err : new Error('节点执行已取消') }
      }
      if (attempt < maxRetries) {
        await sleep(retryDelayMs * 2 ** attempt)
      }
    } finally {
      if (timer !== null) clearTimeout(timer)
      ctx.signal?.removeEventListener('abort', onCallerAbort)
    }
  }
  return { ok: false, error: lastError ?? new Error('节点执行失败') }
}
