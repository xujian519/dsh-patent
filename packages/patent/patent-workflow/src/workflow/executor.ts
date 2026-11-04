/**
 * src/patent/workflow — 单阶段执行器（参数化）。
 *
 * 副作用时序契约（勿改）：
 * - Object.assign(state, segment) 在 handler 产出后立即合并（state 引用共享）；
 * - 主输出键 = atom.outputSchema[0]，兜底 state[stage.id]；executor 阶段的输出同样写入
 *   state[stage.id]（图适配器亦然），使下游阶段能按 consumes 取到它；
 * - handler 的降级诊断键只作为阶段局部输入，不写入共享 state；终态失败输出
 *   [WORKFLOW_DEGRADED] 原因，LLM/检索临时失败按 maxRetries 重试；调用方取消
 *   （StageCancelledError）直接向上抛出，不重试也不转降级；
 * - approvedGate 由 approvalGrants（stageId 白名单）判定，命中时把 APPROVAL_GRANTED_KEY
 *   注入 execState 执行态拷贝；与图路径同一契约——两条路径都只写执行态、都不写共享 state
 *   （写共享 state 会让一次放行泄漏到同 run 内后续所有门，见 patent-core 的 gate.ts）。
 */

import {
  APPROVAL_GRANTED_KEY,
  APPROVAL_GRANTED_OUTPUT,
  DEGRADED_ERROR_KEY,
  DEGRADED_RETRYABLE_KEY,
  REVISION_SIGNALS_KEY,
  isApprovalGateHandler,
  isInterruptStageError,
  isStageCancelledError,
  parseRetrySignals,
} from '@deepseek-ai/dsh-patent-core'
import type {
  AtomRegistry,
  PipelineState,
  RetrySignal,
  StageExecutor,
  StageHandlerRegistry,
  StageProvider,
  WorkflowContext,
  WorkflowInterrupt,
  WorkflowStage,
} from '@deepseek-ai/dsh-patent-core'

/** 单阶段执行选项（handlers/atoms/provider/executor/maxRetries/approvalGrants/ctx/signal）。 */
export type RunStageOnceOptions = {
  handlers: StageHandlerRegistry
  atoms: AtomRegistry
  provider?: StageProvider | undefined
  executor?: StageExecutor | undefined
  maxRetries: number
  approvalGrants?: string[] | undefined
  ctx: WorkflowContext
  /** 调用方取消信号；透传给 handler（LLM 端口流）。 */
  signal?: AbortSignal
  /**
   * 并行组内不写 atom 的共享主输出键：同 atom 的多个阶段会互相覆盖，结果取决于完成
   * 顺序；并行时只写 `state[stage.id]`，主键留给串行阶段。
   */
  isolateMainKey?: boolean
}

/**
 * 执行单个 stage（含重试循环与 degraded 输出构造），不处理信号回退。
 * 供 runWorkflow 串行路径与并行组共用；state 为调用方持有的共享对象（原地合并）。
 * @param stage - 待执行阶段。
 * @param state - 调用方持有的共享执行态（原地合并）。
 * @param options - 执行配置（handlers/atoms/provider/executor/maxRetries 等）。
 * @returns 阶段输出、重试次数与可选中断信号。
 */
export async function runStageOnce(
  stage: WorkflowStage,
  state: PipelineState,
  options: RunStageOnceOptions,
): Promise<{
  output: string
  retries: number
  interrupted?: WorkflowInterrupt
  /** 结构化回退请求（handler 的 `_revision_signals`），未触发时为空数组。 */
  revisionSignals?: RetrySignal[]
}> {
  const handler = stage.atom !== undefined ? options.handlers.lookup(stage.atom) : undefined
  let output = ''
  let retries = 0
  let lastError: unknown
  let revisionSignals: RetrySignal[] = []

  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    try {
      if (handler) {
        // 已人工批准的审批门：把放行标记注入 handler 执行态，由 ApprovalGateHandler
        // 统一判定放行（与图路径同一契约）；此处不跳过执行。标记只写本次 handler
        // 可见的副本——绝不写入共享 state，否则后续未授权审批门会读到泄漏的标记被静默放行。
        const approvedGate = isApprovalGateHandler(handler) && options.approvalGrants?.includes(stage.id)
        // 阶段静态参数合并进执行态（不污染共享 state，仅本次 handler 可见）。
        const execState = stage.params !== undefined || approvedGate
          ? { ...state, ...stage.params }
          : state
        if (approvedGate) {
          execState[APPROVAL_GRANTED_KEY] = true
        }
        const segment = await handler.execute({
          state: execState,
          ...(options.provider !== undefined ? { provider: options.provider } : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        })
        // 审批门在 handler 内取得现场放行时返回同一放行标记；它只表达本次决定，
        // 因此与预批准一样在这里剥离，绝不写入共享 state。
        const grantedByHandler = isApprovalGateHandler(handler) && segment[APPROVAL_GRANTED_KEY] === true
        // 降级诊断是阶段局部契约：剥离后不写入共享 state，避免上一轮错误残留；
        // 终态失败直接产出可读原因，临时失败（LLM/检索）按 maxRetries 重试。
        const diagnostic = segment[DEGRADED_ERROR_KEY]
        const retryable = segment[DEGRADED_RETRYABLE_KEY] === true
        revisionSignals = parseRetrySignals(segment[REVISION_SIGNALS_KEY])
        const delta: PipelineState = { ...segment }
        Reflect.deleteProperty(delta, DEGRADED_ERROR_KEY)
        Reflect.deleteProperty(delta, DEGRADED_RETRYABLE_KEY)
        Reflect.deleteProperty(delta, REVISION_SIGNALS_KEY)
        Reflect.deleteProperty(delta, APPROVAL_GRANTED_KEY)
        // 主输出键 = atom.outputSchema[0]（对齐 Mady 约定，文本/JSON 均可）；兜底按 stage.id 引用。
        const mainKey = stage.atom !== undefined ? options.atoms.lookup(stage.atom)?.outputSchema[0] : undefined
        const raw = mainKey !== undefined ? delta[mainKey] : undefined
        if (options.isolateMainKey === true && mainKey !== undefined) {
          Reflect.deleteProperty(delta, mainKey)
        }
        Object.assign(state, delta)
        if (typeof diagnostic === 'string' && diagnostic.trim().length > 0) {
          const message = diagnostic.trim()
          if (retryable && attempt < options.maxRetries) {
            lastError = new Error(message)
            retries = attempt + 1
            revisionSignals = []
            continue
          }
          output = `[WORKFLOW_DEGRADED] ${message}`
          state[stage.id] = output
          return { output, retries: attempt }
        }
        output = typeof raw === 'string' ? raw : raw === undefined ? '' : JSON.stringify(raw, null, 2)
        if (output.trim().length === 0) {
          const fallback = state[stage.id]
          output = typeof fallback === 'string' ? fallback : fallback === undefined ? '' : JSON.stringify(fallback, null, 2)
        }
        // 审批门放行后无实质输出：占位避免被标记 degraded（语义 = 已人工批准）。
        // 预批准与 handler 内现场放行共享这一占位。
        if ((approvedGate || grantedByHandler) && output.trim().length === 0) {
          output = APPROVAL_GRANTED_OUTPUT
        }
        state[stage.id] = output
        // 结构化缺口信号本身就是阶段产出：它不依赖文本输出，不能被「空输出」的
        // 内部重试吞掉（否则 handler 会原地再跑一次并丢掉信号）。
        if (revisionSignals.length > 0) {
          return { output, retries: attempt, revisionSignals }
        }
      } else if (options.executor) {
        output = await options.executor(stage, options.ctx, state)
        // 阶段输出一律落到 state[stage.id]（与图适配器同一约定）：后续阶段的 executor
        // 按 stage.consumes 从这里取上游产出。
        state[stage.id] = output
      }
      if (output.trim().length > 0) break
      // 保留前一次可重试失败的真实原因；空输出本身不是更有价值的诊断。
      lastError ??= new Error('阶段执行未产生输出')
    } catch (err) {
      // 调用方取消：立即中止，不重试也不产出降级结果。
      if (isStageCancelledError(err)) throw err
      if (isInterruptStageError(err)) {
        return { output: '', retries, interrupted: { stageId: stage.id, message: err.message, data: err.data } }
      }
      // 配置类错误（fail-loud LLM stub 的 setup_required）向上传播，不重试不降级。
      if (err instanceof Error && (err as { code?: unknown }).code === 'setup_required') throw err
      lastError = err
      retries += 1
      if (attempt >= options.maxRetries) {
        output = ''
        break
      }
    }
    retries = attempt + 1
  }

  if (
    output.trim().length === 0 &&
    lastError !== undefined &&
    !(lastError instanceof Error && lastError.message === '阶段执行未产生输出')
  ) {
    // 保留错误信息到输出，便于诊断；仍标记 degraded。
    const detail = lastError instanceof Error ? lastError.message : typeof lastError === 'string' ? lastError : JSON.stringify(lastError)
    output = `[WORKFLOW_DEGRADED] ${stage.id}: ${detail}`
  }
  // 有结构化信号的路径在上面提前返回；这里只剩无信号的终结结果。
  return { output, retries }
}
