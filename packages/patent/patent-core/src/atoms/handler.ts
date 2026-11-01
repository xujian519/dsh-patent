/**
 * StageHandler 运行时层（移植自 Mady agentcore/pipeline_handler.go 设计）。
 *
 * StageHandler 负责具体执行：读取 PipelineState，调用外部能力（LLM/检索器，
 * 经 StageProvider 注入），返回新的状态片段供后续阶段使用。
 *
 * 错误模型：
 * - 预期失败：handler 返回 {@link degraded} 片段，执行器标记该阶段 degraded，不中断流程
 * - InterruptStageError：需要人工介入的中断（如审批门），上层捕获后暂停等待恢复
 * - StageCancelledError：调用方取消信号触发，执行器与图引擎必须中止，不重试也不降级
 * - 其它异常：执行器按阶段失败重试/降级；图路径由节点策略转节点级标记
 */

import type { AtomCategory } from './atom.ts'
import type { StageProvider } from '../types.ts'

/** 键值状态容器（字符串键 → 任意值），阶段间数据流管道。 */
export type PipelineState = Record<string, unknown>

/**
 * 降级诊断键：handler 返回该键表示本阶段未产出业务结果。
 * 执行器把它作为阶段局部诊断读取并输出 `[WORKFLOW_DEGRADED]`，不写入共享 state。
 */
export const DEGRADED_ERROR_KEY = '_error'

/**
 * 降级重试标记键：与 {@link DEGRADED_ERROR_KEY} 同时出现时，`true` 表示该失败
 * 属于 LLM/检索等临时故障，可由执行器重试；缺省或 `false` 表示终态失败。
 */
export const DEGRADED_RETRYABLE_KEY = '_retryable'

/**
 * 结构化回退信号键：handler 返回该键表示本阶段要求上游重做；值须为
 * `RetrySignal[]`。执行器把它作为阶段局部结果读取（不写入共享 state），
 * 由工作流按阶段的 `retry.whenRevisionRequested` 决定是否回退。
 */
export const REVISION_SIGNALS_KEY = '_revision_signals'

/**
 * 类型安全读取：键不存在或非字符串时返回缺省值。
 * @param state - 状态容器。
 * @param key - 要读取的键。
 * @param fallback - 键不存在或非字符串时的缺省值。
 * @returns 字符串值或缺省值。
 */
export function getStateString(state: PipelineState, key: string, fallback = ''): string {
  const v = state[key]
  return typeof v === 'string' ? v : fallback
}

/**
 * 类型安全读取数组：非数组时返回空数组。
 * @param state - 状态容器。
 * @param key - 要读取的键。
 * @returns 数组值，非数组时为空数组。
 */
export function getStateArray(state: PipelineState, key: string): unknown[] {
  const v = state[key]
  return Array.isArray(v) ? v : []
}

/** collectStateText 选项：追加跳过键与空结果兜底。 */
type CollectStateTextOptions = {
  /** 额外跳过键谓词（在 _ 前缀过滤之后执行）。 */
  skipKey?: (key: string) => boolean
  /** 无文本块时的兜底文本（缺省空字符串）。 */
  fallback?: string
}

/**
 * 汇总状态为文本块：跳过 _ 前缀元数据键，字符串（trim 非空）与非空数组
 * 各自格式化为 `## key` 块，块间空行分隔。graph 规则门与 reasoning 兜底共用。
 * @param state - 状态容器。
 * @param options - 可选过滤/兜底配置。
 * @returns 拼接后的文本块；无块时返回兜底文本。
 */
export function collectStateText(state: PipelineState, options: CollectStateTextOptions = {}): string {
  const blocks: string[] = []
  for (const [key, value] of Object.entries(state)) {
    if (key.startsWith('_')) continue
    if (options.skipKey !== undefined && options.skipKey(key)) continue
    if (typeof value === 'string' && value.trim().length > 0) {
      blocks.push(`## ${key}\n${value}`)
    } else if (Array.isArray(value) && value.length > 0) {
      blocks.push(`## ${key}\n${JSON.stringify(value, null, 2)}`)
    }
  }
  return blocks.join('\n\n') || (options.fallback ?? '')
}

/** 阶段执行输入：当前状态、可选的能力提供者与取消信号。 */
export type StageExecuteInput = {
  state: PipelineState
  provider?: StageProvider
  /** 调用方取消信号；透传给 LLM 端口调用，检索在调用前后检查。中止时 handler 以 StageCancelledError 拒绝。 */
  signal?: AbortSignal
}

/** 阶段执行器契约：声明 name/category 元数据并实现 execute。 */
export interface StageHandler {
  /** 与 Atom.name 一致 */
  name: string
  category: AtomCategory
  execute(input: StageExecuteInput): Promise<PipelineState>
}

/** 中断错误（如审批门）：上层捕获后暂停执行，等待人工恢复。 */
export class InterruptStageError extends Error {
  /** 中断发生的阶段 id。 */
  readonly stageId: string
  override readonly message: string
  /** 随中断携带的数据（如审批上下文）。 */
  readonly data: Record<string, unknown>

  constructor(stageId: string, message: string, data: Record<string, unknown> = {}) {
    super(message)
    this.name = 'InterruptStageError'
    this.stageId = stageId
    this.message = message
    this.data = data
  }
}

/**
 * 类型守卫：判断错误是否为中断错误。
 * @param err - 待判断的错误。
 * @returns 是否属于 InterruptStageError。
 */
export function isInterruptStageError(err: unknown): err is InterruptStageError {
  return err instanceof InterruptStageError
}

/**
 * 取消错误：调用方取消信号（AbortSignal）在阶段执行中生效。
 * 执行器与图引擎捕获后必须中止执行，不得重试或转为降级结果。
 */
export class StageCancelledError extends Error {
  /** 取消发生的阶段或原子 id。 */
  readonly stageId: string

  /**
   * @param stageId - 取消发生的阶段或原子 id。
   */
  constructor(stageId: string) {
    super(`阶段 ${stageId} 执行已取消`)
    this.name = 'StageCancelledError'
    this.stageId = stageId
  }
}

/**
 * 类型守卫：判断错误是否为调用方取消。
 * @param err - 待判断的错误。
 * @returns 是否属于 StageCancelledError。
 */
export function isStageCancelledError(err: unknown): err is StageCancelledError {
  return err instanceof StageCancelledError
}

/** StageHandler 注册表：按 name 登记、查询执行器。 */
export class StageHandlerRegistry {
  private readonly handlers = new Map<string, StageHandler>()
  /** 每次注册的独立令牌：同名覆盖时旧 disposer 不能删除后继，即使对象相同。 */
  private readonly tokens = new Map<string, object>()

  /**
   * 同名注册覆盖先前定义（对齐 Mady 覆盖语义，便于测试与扩展）。
   *
   * 注册是 effect：返回的 disposer 只撤销本次注册。名称已被后续注册覆盖时，旧
   * disposer 不删除后继（插件卸载不得拆掉后来者的贡献），重复注册同一对象亦然。
   * @param handler - 待注册的 StageHandler。
   * @returns 撤销本次注册的 disposer；可重复调用。
   */
  register(handler: StageHandler): () => void {
    if (!handler.name.trim()) throw new StageHandlerRegistryError('StageHandler 缺少 name')
    const token = {}
    this.handlers.set(handler.name, handler)
    this.tokens.set(handler.name, token)
    return () => {
      if (this.tokens.get(handler.name) !== token) return
      this.tokens.delete(handler.name)
      this.handlers.delete(handler.name)
    }
  }

  /**
   * 按 name 查询已注册的 StageHandler。
   * @param name - 执行器名称。
   * @returns 匹配的 StageHandler，未注册时返回 undefined。
   */
  lookup(name: string): StageHandler | undefined {
    return this.handlers.get(name)
  }

  /**
   * 列出全部已注册的 StageHandler。
   * @returns 已注册执行器数组。
   */
  list(): StageHandler[] {
    return [...this.handlers.values()]
  }
}

/** StageHandler 注册表错误：用于注册校验失败（如缺少 name）。 */
class StageHandlerRegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StageHandlerRegistryError'
  }
}

/** 全局注册表（内置 handler 经 registerBuiltinAtoms 注册于此）。 */
export const globalStageHandlerRegistry = new StageHandlerRegistry()

/**
 * 按 name 查询全局注册表中的 StageHandler。
 * @param name - 执行器名称。
 * @returns 匹配的 StageHandler，未注册时返回 undefined。
 */
export function LookupStageHandler(name: string): StageHandler | undefined {
  return globalStageHandlerRegistry.lookup(name)
}
