/**
 * 子进程截止期：把内部超时与调用方取消合到同一个 AbortSignal 上。
 *
 * 专利域四处子进程调用（附图渲染、ego-browser、Chrome 打印、Python 引擎）此前各写
 * 一份同样的控制器 + 计时器 + 监听摘除骨架。骨架是纯 `AbortSignal` 逻辑，不依赖
 * subprocess 类型，因此落在 core 内由各处共用；超时是否触发由调用方查询，用于把
 * 「内部超时」与「调用方取消/外部信号」区分开。
 * @module @deepseek-ai/dsh-patent-core/subprocess-deadline
 */

/** 一次子进程截止期。 */
export interface SpawnDeadline {
  /** 交给 spawn 的终止信号。 */
  readonly signal: AbortSignal
  /** 内部超时是否触发。 */
  readonly timedOut: () => boolean
  /** 清理计时器与调用方监听；必须与创建成对调用。 */
  readonly dispose: () => void
}

/**
 * 启动子进程截止期。
 * @param timeoutMs - 内部超时（毫秒）。
 * @param callerSignal - 调用方取消信号（可缺省）。
 * @returns 截止期句柄：交给 spawn 的信号、超时查询与清理函数。
 */
export function startSpawnDeadline(timeoutMs: number, callerSignal?: AbortSignal): SpawnDeadline {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  timer.unref()
  // 调用方取消后内部计时器已无意义：留着它会让 `timedOut()` 在子进程收尾期间
  // 翻成 true，把用户主动取消误报成内部超时。
  const onCallerAbort = (): void => {
    clearTimeout(timer)
    controller.abort()
  }
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true })
  // 已中止的信号不会再派发事件：这里必须走同一处理函数，否则计时器留到 timeoutMs 后
  // 把 timedOut() 翻成 true（与上一条注释描述的是同一个误报）。
  if (callerSignal?.aborted === true) onCallerAbort()
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer)
      callerSignal?.removeEventListener('abort', onCallerAbort)
    },
  }
}
