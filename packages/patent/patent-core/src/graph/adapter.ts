/**
 * src/patent/graph — 适配层：现有 StageHandler / WorkflowManifest → 图节点。
 *
 * 兼容策略（新引擎 + 兼容层）：
 * - runStageHandler / handlerNode（domains/shared）：现有原子 handler 直接作为
 *   图节点，保留降级/中断语义；
 * - manifestToGraph：现有 WorkflowManifest（线性阶段 + retry 信号回退）转为图，
 *   行为与 runWorkflow 尽力等价（重试/降级文本等已知差异见 ../../README.md 的
 *   「Graph engine / Graph 引擎」一节）——retry 回退转条件边（受控循环），
 *   approval-gate 中断转 GraphInterruptError（引擎暂停）。
 */

import { validateWorkflowManifest } from '../workflow/manifest.ts'
import { compileSignal, signalMatches } from '../workflow/signal.ts'
import type { StageExecutor, WorkflowManifest, WorkflowStage } from '../workflow/types.ts'
import { clearStageOutputs } from '../workflow/stage-outputs.ts'
import type { AtomRegistry, StageHandler, StageHandlerRegistry } from '../atoms/index.ts'
import type { StageProvider } from '../types.ts'
import {
  APPROVAL_GRANTED_KEY,
  globalAtomRegistry,
  globalStageHandlerRegistry,
  isApprovalGateHandler,
  isGateApproved,
  isInterruptStageError,
} from '../atoms/index.ts'
import type { EdgeRouter, GraphNode, GraphState, StateDelta } from './types.ts'
import { GRAPH_END, GraphEngineError, GraphInterruptError } from './types.ts'
import { GraphBuilder, type CompiledGraph } from './engine.ts'
import { absorbHandlerDegradation } from './degradation.ts'
import { getStateString } from './state.ts'

// ---------------------------------------------------------------------------
// runStageHandler —— StageHandler → 图节点执行（统一中断转换）
// ---------------------------------------------------------------------------

/**
 * 执行 StageHandler 并统一中断转换（供 handlerNode / makeStageNode 复用）：
 * - InterruptStageError（审批门）→ GraphInterruptError（引擎暂停）；
 * - 普通错误重新抛出（引擎经节点策略转为节点级降级标记，不中断全图）。
 * @param handler - 要执行的 StageHandler。
 * @param state - 传入 handler 的图状态。
 * @param provider - 注入 handler 的 StageProvider（可选，缺省由 handler 内部 provider 兜底）。
 * @param signal - 可选的中断信号，透传给 handler 用于协作取消。
 * @returns handler 执行产生的状态增量片段。
 */
export async function runStageHandler(
  handler: StageHandler,
  state: GraphState,
  provider?: StageProvider,
  signal?: AbortSignal,
): Promise<StateDelta> {
  try {
    return await handler.execute({
      state,
      ...(provider !== undefined ? { provider } : {}),
      ...(signal !== undefined ? { signal } : {}),
    })
  } catch (err) {
    if (isInterruptStageError(err)) {
      throw new GraphInterruptError(err.message, err.data)
    }
    throw err
  }
}

// ---------------------------------------------------------------------------
// manifestToGraph
// ---------------------------------------------------------------------------

/** manifestToGraph 的依赖注入（缺省全局注册表，测试可替换）。 */
export type ManifestToGraphDeps = {
  /** 缺省 globalStageHandlerRegistry。 */
  handlers?: StageHandlerRegistry
  /** 缺省 globalAtomRegistry（解析 atom.outputSchema[0] 主输出键）。 */
  atoms?: AtomRegistry
  /** 未声明 atom 阶段的执行器（与 runWorkflow 的 executor 参数同一类型）。 */
  executor?: StageExecutor
  provider?: StageProvider
}

/**
 * 现有 WorkflowManifest → 图（顺序边 + retry 条件边）。
 * 与 runWorkflow 语义对齐点：
 * - 阶段输出写入 state[stage.id]（主输出键 = atom.outputSchema[0]，兜底 stage.id）；
 * - retry 信号回退：条件边 router 判定输出文本（含否定窗口），命中且未超限 →
 *   回退 rewindTo（删除被回退阶段 state 键）；超限 → fail-open 继续；
 * - approval-gate 阶段抛 GraphInterruptError → 引擎暂停。
 * @param manifest - 要转换的工作流清单。
 * @param deps - 依赖注入（handlers/atoms/executor/provider）。
 * @returns 编译后的可执行图。
 */
export function manifestToGraph(manifest: WorkflowManifest, deps: ManifestToGraphDeps = {}): CompiledGraph {
  // 校验对齐 runWorkflow：先 validateWorkflowManifest，再 fail-fast atom 契约存在性。
  validateWorkflowManifest(manifest)
  const handlers = deps.handlers ?? globalStageHandlerRegistry
  const atoms = deps.atoms ?? globalAtomRegistry
  for (const stage of manifest.stages) {
    if (stage.atom !== undefined && atoms.lookup(stage.atom) === undefined) {
      throw new GraphEngineError(
        `阶段 "${stage.id}" 声明了未知 atom "${stage.atom}"（请先 RegisterAtom；若为内置 manifest，请确认已加载提供该原子的插件）`,
      )
    }
  }

  const builder = new GraphBuilder()
  for (const stage of manifest.stages) {
    builder.addNode(
      stage.id,
      makeStageNode(stage, {
        handlers,
        atoms,
        ...(deps.executor !== undefined ? { executor: deps.executor } : {}),
        ...(deps.provider !== undefined ? { provider: deps.provider } : {}),
      }),
    )
  }

  for (let i = 0; i < manifest.stages.length; i += 1) {
    const stage = manifest.stages[i]
    /* v8 ignore next -- sparse stages arrays crash validateWorkflowManifest first */
    if (stage === undefined) break
    const nextId = manifest.stages[i + 1]?.id ?? GRAPH_END
    if (stage.retry !== undefined) {
      builder.setConditionalEdge(stage.id, makeRetryRouter(stage, manifest.stages, nextId, atoms))
    } else {
      builder.addEdge(stage.id, nextId)
    }
  }

  const first = manifest.stages[0]
  /* v8 ignore next -- validateWorkflowManifest rejects empty stages before this point */
  if (first === undefined) throw new GraphEngineError('manifest 无阶段，无法编译图')
  return builder.compile(first.id)
}

/** 阶段 → 图节点（对齐 runWorkflow.runStageOnce 语义）。
 *
 * 审批门放行按**门粒度**判定：本节点在图中以 `stage.id` 注册（见 manifestToGraph 的
 * addNode），故门 id 直接取闭包内的 `stage.id`——与 manifest 路径的
 * `approvalGrants: stageId[]` 同构。命中时把 `APPROVAL_GRANTED_KEY` 注入执行态拷贝，
 * 共享 state 不出现该键（否则一次放行会泄漏到同 run 内后续所有门）。
 */
function makeStageNode(
  stage: WorkflowStage,
  deps: {
    handlers: StageHandlerRegistry
    atoms: AtomRegistry
    executor?: ManifestToGraphDeps['executor']
    provider?: StageProvider
  },
): GraphNode {
  const handler = stage.atom !== undefined ? deps.handlers.lookup(stage.atom) : undefined
  const mainKey = stage.atom !== undefined ? deps.atoms.lookup(stage.atom)?.outputSchema[0] : undefined
  return async ({ state, provider, signal }) => {
    const approvedGate =
      handler !== undefined && isApprovalGateHandler(handler) && isGateApproved(state, stage.id)
    const execState =
      stage.params !== undefined || approvedGate
        ? { ...state, ...stage.params, ...(approvedGate ? { [APPROVAL_GRANTED_KEY]: true } : {}) }
        : state
    const delta: StateDelta = {}
    let output = ''
    if (handler !== undefined) {
      const segment = absorbHandlerDegradation(
        await runStageHandler(handler, execState, deps.provider ?? provider, signal),
        stage.id,
      )
      Object.assign(delta, segment)
      const raw = mainKey !== undefined ? segment[mainKey] : undefined
      if (typeof raw === 'string') output = raw
      else if (raw !== undefined) output = JSON.stringify(raw, null, 2)
      // 既有阶段输出兜底：params 与恢复的检查点状态都可能带同名键，只接受字符串。
      const existing = execState[stage.id]
      const existingOutput = typeof existing === 'string' ? existing : undefined
      if (output.trim().length === 0) output = existingOutput ?? ''
    } else if (deps.executor !== undefined) {
      // 图路径的执行态同时充当 executor 的运行上下文（图以 ctx 为初始状态），
      // 故第二、三参数同为 execState，与 runWorkflow 的 (stage, ctx, state) 语义一致。
      output = await deps.executor(stage, execState, execState)
    }
    delta[stage.id] = output
    if (output.trim().length === 0 && handler === undefined && deps.executor === undefined) {
      // 无 handler 无 executor：降级标记（对齐 runWorkflow 的 degraded 阶段）。
      delta[`${stage.id}__degraded`] = true
    }
    return delta
  }
}

// ---------------------------------------------------------------------------
// retry 信号回退（signalMatches 实现在 ../workflow/signal.ts，graph 与执行器共用）
// ---------------------------------------------------------------------------

/** 重试计数/超限标记 key（state 内部键，带 __ 前缀防污染业务数据）。 */
const rewindCountKey = (stageId: string): string => `_rewind_count_${stageId}`
const retryExhaustedKey = (stageId: string): string => `${stageId}__retry_exhausted`

/** retry 阶段 → 条件边 router：命中信号回退 rewindTo，否则继续 nextId。 */
function makeRetryRouter(
  stage: WorkflowStage,
  stages: WorkflowStage[],
  nextId: string,
  atoms: AtomRegistry,
): EdgeRouter {
  const retry = stage.retry
  /* v8 ignore next -- callers only reach here when stage.retry is defined */
  if (retry === undefined) throw new GraphEngineError(`阶段 ${stage.id} 缺少 retry 配置`)

  const rewindTo = retry.rewindTo ?? stage.id
  const maxRetries = retry.maxRetries ?? 1
  // 结构化触发（whenRevisionRequested）由 workflow 执行器消费；图路径只认识文本信号，
  // 未声明 whenOutputMatches 时该阶段没有条件回退边。
  const signal = retry.whenOutputMatches === undefined ? undefined : compileSignal(retry.whenOutputMatches)
  // 被回退阶段集合（rewindTo .. 当前阶段），回退时删除其 state 键防陈旧复用。
  const rewindIndex = stages.findIndex(s => s.id === rewindTo)
  const currentIndex = stages.findIndex(s => s.id === stage.id)
  /* v8 ignore next -- validateWorkflowManifest rejects unknown rewindTo targets */
  const rewindedStages = rewindIndex === -1 || currentIndex === -1 ? [stage] : stages.slice(rewindIndex, currentIndex + 1)

  return (state) => {
    const text = getStateString(state, stage.id, '')
    if (text.length === 0 || signal === undefined || !signalMatches(text, signal)) {
      return [nextId]
    }
    const countKey = rewindCountKey(stage.id)
    const count = typeof state[countKey] === 'number' ? (state[countKey]) : 0
    if (count >= maxRetries) {
      // 超限：fail-open 继续（对齐 runWorkflow 的 WORKFLOW_RETRY_EXHAUSTED 降级）。
      state[retryExhaustedKey(stage.id)] = true
      return [nextId]
    }
    state[countKey] = count + 1
    clearStageOutputs({ state, stages: rewindedStages, atoms })
    return [rewindTo]
  }
}
