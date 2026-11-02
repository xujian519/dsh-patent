/**
 * src/patent/workflow — 声明式工作流类型契约。
 *
 * 从 workflow.ts 拆出（轮次 1 纯搬移）：类型/接口 + WorkflowError，供执行器
 * 与消费方（workflow-store / workflow-dag / graph/adapter / flexible-plan /
 * 工具层）共享，解除对执行器文件的类型级耦合。
 */

import type { AtomRegistry, PipelineState, StageHandlerRegistry } from '../atoms/index.ts'
import type { WorkflowEvidenceLedger } from '../evidence/index.ts'
import type { StageProvider } from '../types.ts'

/** 阶段执行策略：chain / react / sub_agent。 */
export type WorkflowStrategy = 'chain' | 'react' | 'sub_agent'

/**
 * 阶段执行策略全集。表驱动判定与联合类型保持同步：新增策略却漏写此表会编译失败。
 */
export const WORKFLOW_STRATEGIES = {
  chain: true,
  react: true,
  sub_agent: true,
} as const satisfies Record<WorkflowStrategy, true>

/**
 * 判断值是否为已声明的阶段执行策略。
 * @param value - 待判定的值。
 * @returns 值是否为 WorkflowStrategy。
 */
export function isWorkflowStrategy(value: unknown): value is WorkflowStrategy {
  return typeof value === 'string' && Object.hasOwn(WORKFLOW_STRATEGIES, value)
}

/** 单个工作流阶段：id、策略、描述与可选原子/参数/重试配置。 */
export type WorkflowStage = {
  id: string
  strategy: WorkflowStrategy
  description: string
  /**
   * 可选：Pipeline 原子操作名（如 "extract"/"search"/"compare"/"reasoning"/"approval-gate"）。
   * 声明后 runWorkflow 按 atom 分发到 StageHandler；缺省回退 executor。
   */
  atom?: string
  /**
   * 可选：传递给 StageHandler 的静态参数（执行前合并进 PipelineState，handler 经 state 读取）。
   * 用于同一原子在不同阶段的差异化配置（如 extract 三路的 output_key / extraction_type）。
   */
  params?: Record<string, unknown>
  /**
   * 可选：阶段法律指引（收口阶段由通用执行器拼入系统提示词；原子阶段由 handler 决定是否消费）。
   * 承载该阶段的法条操作框架与输出要求（如三步法边界条件、驳回类型解析表），是纯数据、非运行时路由。
   */
  guidance?: string
  /**
   * 可选：本阶段依赖的上游阶段 id，只能引用其之前出现的阶段。
   *
   * 声明的是**数据依赖**：执行器按此把上游阶段输出（`state[上游阶段 id]`）拼入提示词。
   * 阶段描述与 guidance 都不携带上游产出，未声明即读不到——三步法第二步看不到第一步选定的
   * 最接近现有技术，逐特征新颖性看不到检索证据，都属这一类。原子阶段的 handler 直接读共享
   * state（其中已有全部阶段输出），无需声明。
   *
   * 条目可带一个 `#` 投影键（`'claim-chart#rows'`）：只把该阶段产出的命名投影交给提示词，
   * 而不是全文。投影用于结构化产出（对照表 JSON、解析结果 JSON）——它们的全文既占篇幅，
   * 又带着下游不用的字段。投影键必须在执行器注册过的投影表里，否则 `validateWorkflowManifest`
   * （提供 `projections` 时）与运行时渲染两处都 fail-loud。不带 `#` 即取全文。
   */
  consumes?: readonly string[]
  /**
   * 可选：一致性重试循环（对齐 Mady disclosure 管线的 check_consistency 条件回退边）。
   * 本阶段输出匹配 whenOutputMatches（信号：需要重做）或返回结构化 RetrySignal
   * （whenRevisionRequested）时，回退到 rewindTo 阶段重新执行（含中间阶段），
   * 最多 maxRetries 次。
   */
  retry?: {
    /** 触发回退的输出信号（正则源文本；如 "不一致|矛盾|缺少"）。 */
    whenOutputMatches?: string
    /**
     * 启用结构化触发：阶段返回 `_revision_signals`（RetrySignal[]）时回退。
     * 与 whenOutputMatches 至少给出一个。
     */
    whenRevisionRequested?: boolean
    /** 回退目标阶段 id；缺省重试当前阶段。结构化信号未命中 `routes` 时用它。 */
    rewindTo?: string
    /**
     * 结构化信号的分缺口路由：`RetrySignal.gapId` → 回退目标阶段 id。
     * 只对 `whenRevisionRequested` 生效；未命中的信号使用 `rewindTo`。
     * 一次回退重做所有请求目标中最早的一个，较晚目标随下游阶段一并重跑。
     */
    routes?: Readonly<Record<string, string>>
    /** 最大回退次数（缺省 1）。 */
    maxRetries?: number
  }
}

/**
 * 结构化回退请求：阶段用自己的产出声明「这处缺口需要上游重做」。
 *
 * 与正则信号的区别是触发源由确定性检查给出，而不是模型自述。类型保持通用：
 * 不引用 claim-chart 的 GapKind，任何阶段都可以返回自己的缺口编号。
 */
export type RetrySignal = {
  /** 稳定缺口编号（如 `claim-1-unevaluated` / `evidence-deadline`）。 */
  gapId: string
  /** 为什么需要重做；进入 RevisionRecord，供人工复核。 */
  rationale: string
  /** 可选证据引用（状态键、条文号或原文 span 标识）。 */
  evidence?: string
}

/**
 * 一次回退的留痕记录：哪个缺口触发了回退、重做了哪个阶段、前后产出摘要。
 *
 * `before` / `after` 是产出文本的短摘要（sha256 前 16 位），不保存全文，避免把
 * 每次重做都复制进会话日志。`after` 在回退目标重新产出后补齐；运行中断或耗尽时
 * 可以缺席。
 */
export type RevisionRecord = {
  /** 触发回退的缺口编号；正则信号取阶段 id。 */
  gapId: string
  /** 被重做的阶段 id。 */
  rewindTo: string
  /** 发出信号的阶段 id。 */
  requestedBy: string
  /** 该阶段第几次回退（1 基）。 */
  round: number
  /** 触发回退时被替换产出的摘要。 */
  before: string
  /** 回退目标重新产出后的摘要；耗尽或中断时缺席。 */
  after?: string
  /** 回退原因（结构化信号原文；正则信号为匹配到的模式）。 */
  rationale: string
  /** 可选证据引用。 */
  evidence?: string
  /** 回退是否实际执行；耗尽表示达到上限后保留了原产出。 */
  outcome: 'applied' | 'exhausted'
  /**
   * 记录时间（ISO 8601）；仅在调用方注入时钟时写入。缺省不写，使持久化结果与
   * 录制会话保持确定性（审计轮次与阶段顺序由 `round` / `rewindTo` 给出）。
   */
  at?: string
}

/** 声明式工作流 manifest：id、名称、案例类型、阶段列表与可选校验配置。 */
export type WorkflowManifest = {
  id: string
  name: string
  caseType: string
  /**
   * Revision of 《专利审查指南》 the manifest's law references target, e.g.
   * `2023 年修订版（2024-01-20 施行）`. When a run supplies an expected
   * revision, a different declaration fails before any stage executes.
   */
  guidelineRevision?: string
  stages: WorkflowStage[]
  validation?: {
    /** 是否要求所有步骤都产生输出（缺省 true） */
    requireAllSteps?: boolean
    maxRetries?: number
  }
}

/** 工作流运行上下文：案例 id、输入与可扩展的附加键值。 */
export type WorkflowContext = {
  /** 案例目录或案例 ID，用于输入输出路径（可含 {caseId} 占位） */
  caseId?: string
  /** 用户输入/初始事实 */
  input?: string
  [key: string]: unknown
}

/**
 * 阶段执行器：消费阶段、运行上下文与已累积的执行态，产出阶段输出。
 *
 * `state` 是共享执行态：每个已执行阶段都以自身 id 为键存放其输出（`state[stageId]`，
 * 与图适配器同一约定），故执行器可按 `stage.consumes` 取用上游产出。
 */
export type StageExecutor = (stage: WorkflowStage, ctx: WorkflowContext, state: PipelineState) => Promise<string>

/** 工作流运行选项：处理器/原子注册表、提供方、审批授权、持久化与运行 id。 */
export type WorkflowRunOptions = {
  /** 阶段处理器注册表（缺省全局注册表）。传空注册表可禁用原子执行（收口语义）。 */
  handlers?: StageHandlerRegistry
  /** Atom 声明注册表（缺省全局注册表），用于解析 atom.outputSchema[0] 主输出键。 */
  atoms?: AtomRegistry
  /** 原子执行所需的外部能力（LLM/检索器），由宿主注入。 */
  provider?: StageProvider
  /**
   * 已人工批准的审批门阶段 id 列表：命中时跳过执行直接放行（输出 "APPROVED"），
   * 未命中的审批门照常中断。人工批准后重跑时传入，实现"审批门通过后继续"。
   */
  approvalGrants?: string[]
  /**
   * 结果持久化存储：执行结束时调用 saveRun（可选）。
   * 设计对齐 src/workflow WorkflowPlanStore（save/load/list 三接口），
   * 实现见 ./workflow-store.js。
   */
  persist?: WorkflowRunStore
  /** 持久化键（runId），用于区分同一 manifest 的多次执行；缺省 manifestId。 */
  runId?: string
  /** 并行窗口上限（连续、同 atom、无 retry 的阶段并行数）；缺省 4。 */
  maxParallelStages?: number
  /**
   * 每个阶段开始前通知一次：阶段 id、序号（0 基）与阶段总数（顺序执行与并行窗口内
   * 的阶段都是同一时机）。调用方用它把长运行的进展报给等待方——工作流本身不消费返回值，
   * 也不捕获异常，回调抛错即中止运行。
   */
  onStage?: (stageId: string, index: number, total: number) => void
  /** 调用方取消信号：阶段边界检查；阶段内取消以 StageCancelledError 拒绝整次运行。 */
  signal?: AbortSignal
  /**
   * 可注入时钟：给出时，每条 RevisionRecord 写入 `at`（ISO 8601）。缺省不写时间，
   * 让同一输入在重放/录制会话中产生逐字相同的持久化结果。
   */
  now?: () => string
  /**
   * 本次部署预期使用的《专利审查指南》版本。给出时，manifest 必须声明同一
   * `guidelineRevision`，否则校验失败；用于在加载/运行前拦截按旧版条文编写的清单。
   */
  guidelineRevision?: string
}

/** 单个阶段执行结果：阶段 id、策略、输出、降级标记、重试次数与原子名。 */
export type WorkflowStageResult = {
  stageId: string
  strategy: WorkflowStrategy
  output: string
  /** 该步骤是否降级（无输出时标记，不中断流程） */
  degraded: boolean
  retries: number
  /** 该阶段声明的原子名（如有） */
  atom?: string
  /**
   * 该阶段声明读取的状态键（原子的 `inputSchema`），仅当原子设置
   * `logInputScope` 时记录。用于让隔离型阶段的输入范围随运行结果进入会话日志。
   */
  inputScope?: string[]
}

/** 工作流中断信息（如审批门）：阶段 id、消息与附加数据。 */
export type WorkflowInterrupt = {
  stageId: string
  message: string
  data: Record<string, unknown>
}

/** 一次工作流运行结果：完成状态、各阶段结果、降级步骤、摘要与可选中断/告警。 */
export type WorkflowRunResult = {
  manifestId: string
  caseType: string
  completed: boolean
  stages: WorkflowStageResult[]
  /** 未产生输出的步骤 id */
  degradedSteps: string[]
  summary: string
  /** 审批门等中断信息：存在表示执行被人工介入暂停（暂停 ≠ 失败） */
  interrupted?: WorkflowInterrupt
  /** 可选：结果持久化失败时的告警（执行本身不受影响） */
  persistWarning?: string
  /**
   * Evidence sources the run consumed, one receipt per source with a stable
   * citation id. Lets a persisted run or session log rebuild the documents
   * behind a citation without replaying the stages.
   */
  evidenceLedger?: WorkflowEvidenceLedger
  /**
   * Rewinds the run performed, one record per triggered gap. Absent when no
   * retry signal fired. Digests keep the log bounded; the full stage outputs
   * stay in `stages`.
   */
  revisions?: RevisionRecord[]
  /** True when the revision log hit its record cap and later rewinds were not recorded. */
  revisionsTruncated?: boolean
}

/**
 * WorkflowRun 持久化契约（对齐 src/workflow/persistence/WorkflowPlanStore 的
 * save/load/list 三接口；此处持久化对象为 patent 域的 WorkflowRunResult）。
 * 实现见 ./workflow-store.js（InMemory / JsonFile 两种后端）。
 */
export interface WorkflowRunStore {
  saveRun(result: WorkflowRunResult, runId?: string): Promise<void>
  loadRun(runId: string): Promise<WorkflowRunResult | undefined>
  listRuns(): Promise<string[]>
}

/** 工作流错误：非法 manifest 或运行失败时抛出的领域错误。 */
export class WorkflowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowError'
  }
}
