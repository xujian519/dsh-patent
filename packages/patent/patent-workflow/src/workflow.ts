/**
 * 声明式工作流执行器（门面）。
 *
 * 只保留一条声明式路径 —— WorkflowManifest（JSON/YAML 可序列化）+ 单一执行器 runWorkflow。
 * 类型契约、WorkflowError 与 validateWorkflowManifest 已在 dsh-patent-core 前置
 * （src/workflow/types.ts + manifest.ts），本文件保留执行器本体并 re-export。
 *
 * 原子执行（v2，移植自 Mady agentcore/atom.go + pipeline_handler.go）：
 * - WorkflowStage 可声明 atom；runWorkflow 优先按 atom 分发到 StageHandler
 *   （经注入的 handlers 注册表或全局注册表），handler 内部调用 LLM/检索器。
 * - 未声明 atom 的阶段回退到调用方 executor。
 * - 审批门等 handler 抛 InterruptStageError 时，runWorkflow 暂停并返回 interrupted。
 */

import {
  WorkflowError,
  buildWorkflowEvidenceLedger,
  clearStageOutputs,
  digestText,
  globalAtomRegistry,
  globalStageHandlerRegistry,
  validateWorkflowManifest,
  type PipelineState,
  type RetrySignal,
  type RevisionRecord,
  type StageExecutor,
  type WorkflowContext,
  type WorkflowInterrupt,
  type WorkflowManifest,
  type WorkflowRunOptions,
  type WorkflowRunResult,
  type WorkflowStage,
  type WorkflowStageResult,
} from '@deepseek-ai/dsh-patent-core'
import { signalFor, signalMatches } from './workflow/signal.ts'
import { runStageOnce, type RunStageOnceOptions } from './workflow/executor.ts'

// ---- 门面再导出（保持消费面不变） ----
export { WorkflowError, validateWorkflowManifest } from '@deepseek-ai/dsh-patent-core'
export type {
  RetrySignal,
  RevisionRecord,
  StageExecutor,
  WorkflowContext,
  WorkflowInterrupt,
  WorkflowManifest,
  WorkflowRunOptions,
  WorkflowRunResult,
  WorkflowRunStore,
  WorkflowStage,
  WorkflowStageResult,
  WorkflowStrategy,
} from '@deepseek-ai/dsh-patent-core'
export {
  builtinPatentManifests,
  OA_RESPONSE_DRAFT_BUDGET,
  patentDisclosureManifest,
  patentInfringementManifest,
  patentInventivenessManifest,
  patentInvalidationManifest,
  patentNoveltyManifest,
  patentOaResponseManifest,
  patentPatentabilityManifest,
  patentReexaminationManifest,
  SHIPPED_GUIDELINE_REVISION,
} from './workflow/manifests.ts'
export { runStageOnce, type RunStageOnceOptions } from './workflow/executor.ts'
export { compileSignal, signalFor, signalMatches } from './workflow/signal.ts'

/**
 * 单一执行器：按顺序执行各阶段。
 * - 声明 atom 的阶段经 StageHandler 执行，输出合并进 PipelineState
 * - 未声明 atom 的阶段回退调用方 executor（输出为空时标记 degraded 而非中断）
 * - 审批门等中断（InterruptStageError）：暂停执行并返回 interrupted（不执行后续阶段）
 * @param manifest - 工作流清单。
 * @param ctx - 工作流上下文。
 * @param executor - 可选调用方阶段执行器（未声明 atom 的阶段回退使用；接收已累积的执行态，
 *                   按 `stage.consumes` 取上游阶段输出）。
 * @param options - 可选执行配置（handlers/atoms/provider/approvalGrants/persist/runId）。
 * @returns 工作流执行结果。
 */
export async function runWorkflow(
  manifest: WorkflowManifest,
  ctx: WorkflowContext,
  executor?: StageExecutor,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult> {
  validateWorkflowManifest(manifest, {
    ...(options.guidelineRevision !== undefined ? { guidelineRevision: options.guidelineRevision } : {}),
  })
  assertApprovalGrants(manifest, options.approvalGrants)
  const atoms = options.atoms ?? globalAtomRegistry
  assertKnownAtoms(manifest, atoms)
  const run: StageRun = {
    manifest,
    options,
    state: { ...ctx },
    stageOptions: {
      handlers: options.handlers ?? globalStageHandlerRegistry,
      atoms,
      provider: options.provider,
      executor,
      maxRetries: manifest.validation?.maxRetries ?? 2,
      approvalGrants: options.approvalGrants,
      ctx,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
    atoms,
    requireAll: manifest.validation?.requireAllSteps ?? true,
    maxParallelStages: options.maxParallelStages ?? 4,
    stageIds: new Map(manifest.stages.map((s, i) => [s.id, i])),
    rewindCounts: new Map(),
    signalCache: new Map(),
    results: [],
    revisions: [],
    pendingRevisions: [],
    revisionsTruncated: false,
    now: options.now,
  }
  const interrupted = await runStages(run)
  return await assembleRunResult(run, interrupted)
}

/** atom 契约注册表（执行配置的 atoms 字段，缺省取全局注册表）。 */
type StageAtoms = NonNullable<WorkflowRunOptions['atoms']>

/** 单次 runWorkflow 的累积态：阶段执行选项、重试记账与已产出的阶段结果。 */
type StageRun = {
  manifest: WorkflowManifest
  options: WorkflowRunOptions
  /** 累积的执行态；阶段输出合并进该对象，回退时按阶段清除。 */
  state: PipelineState
  stageOptions: RunStageOnceOptions
  atoms: StageAtoms
  /** requireAllSteps：存在降级阶段时是否判定未完成。 */
  requireAll: boolean
  maxParallelStages: number
  /** 阶段 id → 序号，供 rewindTo 定位。 */
  stageIds: ReadonlyMap<string, number>
  /** 阶段 id → 已回退次数。 */
  rewindCounts: Map<string, number>
  signalCache: Map<string, RegExp>
  results: WorkflowStageResult[]
  /** 回退留痕（有上限）；只存产出摘要，不复制全文。 */
  revisions: RevisionRecord[]
  /** 等待回退目标重新产出后补 `after` 的记录。 */
  pendingRevisions: RevisionRecord[]
  /** 留痕达到上限后置 true，后续回退仍执行但不记录。 */
  revisionsTruncated: boolean
  /** 可注入时钟；缺省时 RevisionRecord 不写 `at`。 */
  now: (() => string) | undefined
}

/** 单次运行最多保留的回退记录数；超过后只标记截断，不无限增长。 */
const MAX_REVISIONS = 64

/** 单阶段之后的走向：下一阶段序号（null 表示停止循环），或中断。 */
type StageStep = {
  nextIndex: number | null
  interrupted?: WorkflowInterrupt | undefined
}

/**
 * 原子契约存在性 fail-fast：声明了未知 atom（连契约都没有）直接抛错；
 * 已知 atom 但 handler 未注册时回退 executor（atom 是契约，handler 是实现，可延迟注册）。
 * @param manifest - 工作流清单。
 * @param atoms - atom 契约注册表。
 * @throws WorkflowError 阶段声明了未注册的 atom。
 */
function assertKnownAtoms(manifest: WorkflowManifest, atoms: StageAtoms): void {
  for (const stage of manifest.stages) {
    if (stage.atom !== undefined && !atoms.lookup(stage.atom)) {
      throw new WorkflowError(
        `阶段 ${stage.id} 声明了未知 atom "${stage.atom}"（请先 RegisterAtom；若为内置 manifest，请确认已加载提供该原子的插件）`,
      )
    }
  }
}

/**
 * 审批放行名单 fail-fast：只接受本 manifest 的审批门阶段 id。
 *
 * 放行按阶段 id 命中；拼错或指向非门阶段的条目在运行时会被静默跳过，运行再次停在
 * 门口且没有任何诊断，调用方无法区分「放行名单写错」与「门被拒绝」。因此在执行前拒绝。
 * @param manifest - 工作流清单。
 * @param grants - 宿主给出的已批准阶段 id 列表。
 * @throws WorkflowError 名单含非审批门阶段（含不存在的阶段）的 id。
 */
function assertApprovalGrants(manifest: WorkflowManifest, grants: readonly string[] | undefined): void {
  if (grants === undefined) return
  const gateIds = new Set(
    manifest.stages.filter(stage => stage.atom === 'approval-gate').map(stage => stage.id),
  )
  for (const grant of grants) {
    if (gateIds.has(grant)) continue
    const available = gateIds.size > 0 ? [...gateIds].join('、') : '该 manifest 没有审批门'
    throw new WorkflowError(`approvalGrants 中的 "${grant}" 不是本 manifest 的审批门阶段（可用: ${available}）`)
  }
}

/**
 * 调用方取消：阶段边界检查，中止时中止执行（stage 内部的长调用由调用方另行取消）。
 * @param signal - 调用方取消信号。
 * @throws WorkflowError 信号已中止。
 */
function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new WorkflowError('工作流执行已取消')
}

/**
 * 把一次阶段产出记入结果列表：空输出与降级标记都算 degraded。
 * @param run - 执行态。
 * @param stage - 产出所属阶段。
 * @param outcome - 阶段的输出与重试次数。
 */
/**
 * The stage's declared input keys, recorded only when its atom opts in.
 * @param run - 执行态，携带本次运行的原子契约。
 * @param stage - 产出所属阶段。
 * @returns 输入键列表；原子未声明记录能力或未注册时返回 undefined。
 */
function inputScopeFor(run: StageRun, stage: WorkflowStage): string[] | undefined {
  if (stage.atom === undefined) return undefined
  const atom = run.atoms.lookup(stage.atom)
  if (atom?.logInputScope !== true || atom.inputSchema.length === 0) return undefined
  return [...atom.inputSchema]
}

function stageResult(
  run: StageRun,
  stage: WorkflowStage,
  outcome: { output: string; degraded: boolean; retries: number },
): WorkflowStageResult {
  const inputScope = inputScopeFor(run, stage)
  return {
    stageId: stage.id,
    strategy: stage.strategy,
    output: outcome.output,
    degraded: outcome.degraded,
    retries: outcome.retries,
    ...(stage.atom !== undefined ? { atom: stage.atom } : {}),
    ...(inputScope !== undefined ? { inputScope } : {}),
  }
}

function pushStageResult(run: StageRun, stage: WorkflowStage, outcome: { output: string; retries: number }): void {
  // 回退后第一个落地的阶段就是回退目标：用它的产出补 before/after 里的 after。
  if (run.pendingRevisions.length > 0) {
    const digest = digestText(outcome.output)
    for (const record of run.pendingRevisions) {
      record.after = digest
    }
    run.pendingRevisions = []
  }
  run.results.push(stageResult(run, stage, {
    output: outcome.output,
    degraded: outcome.output.trim().length === 0 || outcome.output.startsWith('[WORKFLOW_DEGRADED]'),
    retries: outcome.retries,
  }))
}

/**
 * 计算可并行窗口（从当前 stage 起，连续且无 retry、无 consumes、同 atom 的阶段）。
 * @param manifest - 工作流清单。
 * @param index - 窗口起始阶段序号。
 * @param maxParallelStages - 窗口长度上限。
 * @returns 窗口长度；起始阶段不存在时为 0。
 */
function stageWindow(manifest: WorkflowManifest, index: number, maxParallelStages: number): number {
  let window = 1
  const current = manifest.stages[index]
  if (current === undefined) return 0
  // 声明 retry 的阶段必须单跑：并行窗口走 Promise.all，回退/重试会被静默跳过。
  // 声明 consumes 的首阶段同样单跑，避免与同组上游并发读写同一 state。
  // 审批门一次只取一个人工决策：同一窗口内的两个门会并发询问，拒绝第一个门也拦不住
  // 第二个门已经被追问，因此门阶段不进入并行窗口。
  if (current.retry !== undefined || current.consumes !== undefined || current.atom === 'approval-gate') return 1
  const groupAtom = current.atom
  while (index + window < manifest.stages.length && window < maxParallelStages) {
    const candidate = manifest.stages[index + window]
    if (candidate === undefined) break
    // 声明 consumes 的阶段排除在并行窗口外：同组阶段并发读写同一 state，
    // 它可能读到同组上游尚未合并的产出。
    if (
      candidate.retry !== undefined ||
      candidate.consumes !== undefined ||
      candidate.atom !== groupAtom ||
      groupAtom === undefined
    ) break
    window += 1
  }
  return window
}

/**
 * 并行组：各阶段独立执行，组内出现中断即停止本组。
 * @param run - 执行态。
 * @param group - 本组阶段（并行窗口切片）。
 * @returns 组内中断；无中断时为 undefined。
 */
async function runParallelGroup(
  run: StageRun,
  group: readonly WorkflowStage[],
  startIndex: number,
): Promise<WorkflowInterrupt | undefined> {
  // 通知与顺序路径同一时机（阶段开始前）；稀疏阶段数组在窗口内可能有空洞，故按
  // 既有守卫写法逐位读取，遇空即止。
  for (let gi = 0; gi < group.length; gi += 1) {
    const groupStage = group[gi]
    if (groupStage === undefined) break
    run.options.onStage?.(groupStage.id, startIndex + gi, run.manifest.stages.length)
  }
  const outcomes = await Promise.all(group.map(stage =>
    runStageOnce(stage, run.state, { ...run.stageOptions, isolateMainKey: true })))
  for (let gi = 0; gi < outcomes.length; gi += 1) {
    const outcome = outcomes[gi]
    const groupStage = group[gi]
    if (outcome === undefined || groupStage === undefined) break
    if (outcome.interrupted) return outcome.interrupted
    pushStageResult(run, groupStage, outcome)
  }
  return undefined
}

/**
 * 单阶段执行，含一致性重试回退：输出触发信号时回退到 rewindTo 阶段重新执行，
 * 超过最大回退次数则保留不一致输出并标记 degraded。
 * @param run - 执行态。
 * @param index - 当前阶段序号。
 * @returns 下一阶段序号（null 表示停止循环），或中断。
 */
async function runSingleStage(run: StageRun, index: number): Promise<StageStep> {
  const stage = run.manifest.stages[index]
  if (stage === undefined) return { nextIndex: null }
  run.options.onStage?.(stage.id, index, run.manifest.stages.length)
  const outcome = await runStageOnce(stage, run.state, run.stageOptions)
  if (outcome.interrupted) return { nextIndex: null, interrupted: outcome.interrupted }
  const { output, retries, revisionSignals = [] } = outcome

  // 一致性重试循环：文本信号或结构化缺口信号命中时回退到 rewindTo 阶段重新执行。
  // 结构化信号不依赖输出文本：门阶段可能以空输出加缺口信号表达「需要上游补事实」。
  const structuredRequested = stage.retry?.whenRevisionRequested === true && revisionSignals.length > 0
  const textAvailable = output.trim().length > 0
  if (stage.retry !== undefined && (textAvailable || structuredRequested)) {
    const signal = textAvailable && stage.retry.whenOutputMatches !== undefined
      ? signalFor(stage, run.signalCache)
      : undefined
    const textMatched = signal !== undefined && signalMatches(output, signal)
    if (textMatched || structuredRequested) {
      const retry = stage.retry
      const defaultRewindTo = retry.rewindTo ?? stage.id
      // 结构化信号可按缺口路由到不同上游；一次回退只能选一个起点，取请求目标中
      // 最早的一个，较晚的目标随其下游阶段一并重跑。
      const targetFor = (revisionSignal: RetrySignal): string =>
        retry.routes?.[revisionSignal.gapId] ?? defaultRewindTo
      const targetIds = structuredRequested
        ? [...new Set(revisionSignals.map(signal => targetFor(signal)))]
        : [defaultRewindTo]
      const targets = targetIds
        .map(id => ({ id, index: run.stageIds.get(id) }))
        .filter((entry): entry is { id: string; index: number } => entry.index !== undefined)
      if (targets.length !== targetIds.length) return { nextIndex: null }
      const first = targets.reduce((left, right) => (right.index < left.index ? right : left))
      const rewindIndex = first.index
      const rewindTo = first.id
      const rewindCount = (run.rewindCounts.get(stage.id) ?? 0) + 1
      const maxRewind = stage.retry.maxRetries ?? 1
      const exhausted = rewindCount > maxRewind
      const records = revisionRecords({
        stage,
        // before/after 必须描述同一个阶段：before 取被替换的回退目标产出，而不是
        // 发出信号的阶段产出，否则两个摘要不可比较。
        before: target => digestText(
          /* v8 ignore next -- 回退目标必然已执行；空串分支只防稀疏结果 */
          run.results[run.stageIds.get(target) ?? rewindIndex]?.output ?? (target === stage.id ? output : ''),
        ),
        rewindTo,
        targetFor,
        round: rewindCount,
        outcome: exhausted ? 'exhausted' : 'applied',
        signals: revisionSignals,
        textPattern: textMatched ? stage.retry.whenOutputMatches : undefined,
        now: run.now,
      })
      for (const record of records) appendRevision(run, record)

      if (exhausted) {
        // 文本信号沿用旧语义：保留不一致输出并标记 degraded。结构化信号是确定性
        // 缺口的「再试一次」，耗尽时保留阶段原产出，由缺口报告本身说明未覆盖项。
        if (textMatched) {
          run.results.push(stageResult(run, stage, {
            output: `[WORKFLOW_RETRY_EXHAUSTED] ${stage.id}: ${output}`,
            degraded: true,
            retries,
          }))
        } else {
          pushStageResult(run, stage, { output, retries })
        }
        return { nextIndex: index + 1 }
      }
      // 覆盖从 rewindTo 起的结果与 state 键（防陈旧输出被兜底复用），回退重执行。
      run.rewindCounts.set(stage.id, rewindCount)
      run.results.splice(rewindIndex)
      clearStageOutputs({ state: run.state, stages: run.manifest.stages.slice(rewindIndex), atoms: run.atoms })
      run.pendingRevisions.push(...records.filter(record => record.outcome === 'applied'))
      return { nextIndex: rewindIndex }
    }
  }

  pushStageResult(run, stage, { output, retries })
  return { nextIndex: index + 1 }
}

/**
 * 生成一次回退的留痕记录。
 * @param options - 阶段、回退目标被替换产出的摘要、轮次、触发源与可选时钟。
 * @returns 每个结构化信号一条记录；纯正则触发时一条记录。
 */
function revisionRecords(options: {
  stage: WorkflowStage
  /** 某个回退目标被替换产出的摘要（与 `after` 同一阶段）。 */
  before: (rewindTo: string) => string
  /** 本次回退的起点（所有请求目标中最早的一个）。 */
  rewindTo: string
  /** 单个结构化信号实际请求的回退目标。 */
  targetFor: (signal: RetrySignal) => string
  round: number
  outcome: RevisionRecord['outcome']
  signals: readonly RetrySignal[]
  textPattern: string | undefined
  now: (() => string) | undefined
}): RevisionRecord[] {
  const base = {
    requestedBy: options.stage.id,
    round: options.round,
    outcome: options.outcome,
    ...(options.now !== undefined ? { at: options.now() } : {}),
  }
  if (options.signals.length > 0) {
    return options.signals.map((signal) => {
      const rewindTo = options.targetFor(signal)
      return {
        ...base,
        rewindTo,
        before: options.before(rewindTo),
        gapId: signal.gapId,
        rationale: signal.rationale,
        ...(signal.evidence !== undefined ? { evidence: signal.evidence } : {}),
      }
    })
  }
  return [{
    ...base,
    rewindTo: options.rewindTo,
    before: options.before(options.rewindTo),
    gapId: options.stage.id,
    /* v8 ignore next -- 文本触发时 textPattern 必然已定义 */
    rationale: `输出匹配回退信号 /${options.textPattern ?? ''}/`,
  }]
}

/**
 * 追加留痕，超过上限时只标记截断。
 * @param run - 执行态。
 * @param record - 待追加的记录。
 */
function appendRevision(run: StageRun, record: RevisionRecord): void {
  if (run.revisions.length >= MAX_REVISIONS) {
    run.revisionsTruncated = true
    return
  }
  run.revisions.push(record)
}

/**
 * 主循环：按并行窗口推进阶段。
 * @param run - 执行态。
 * @returns 中断（审批门暂停）；无中断时为 undefined。
 */
async function runStages(run: StageRun): Promise<WorkflowInterrupt | undefined> {
  for (let index = 0; index < run.manifest.stages.length; ) {
    assertNotAborted(run.options.signal)
    const window = stageWindow(run.manifest, index, run.maxParallelStages)
    if (window > 1) {
      const group = run.manifest.stages.slice(index, index + window)
      const interrupted = await runParallelGroup(run, group, index)
      if (interrupted !== undefined) return interrupted
      index += window
      continue
    }
    const step = await runSingleStage(run, index)
    if (step.interrupted !== undefined) return step.interrupted
    if (step.nextIndex === null) break
    index = step.nextIndex
  }
  return undefined
}

/**
 * 汇总执行结果，并把持久化失败降级为结果里的告警。
 * @param run - 执行态。
 * @param interrupted - 中断（审批门暂停），无中断时为 undefined。
 * @returns 工作流执行结果。
 */
async function assembleRunResult(run: StageRun, interrupted: WorkflowInterrupt | undefined): Promise<WorkflowRunResult> {
  const degradedSteps = run.results.filter(r => r.degraded).map(r => r.stageId)
  // 中断（审批门暂停）≠ 完成：即使 requireAllSteps=false（容忍降级），暂停中的
  // 运行也必须报告 incomplete，否则"未确认"会被误读为"已完成"。
  const completed = interrupted === undefined
    && (run.requireAll ? degradedSteps.length === 0 : true)
  const okCount = run.results.filter(r => !r.degraded).length

  let summary: string
  if (interrupted) {
    summary = `工作流 ${run.manifest.id}（${run.manifest.name}）: 已执行 ${run.results.length}/${run.manifest.stages.length} 阶段，在 "${interrupted.stageId}" 暂停等待人工确认`
  } else {
    summary = `工作流 ${run.manifest.id}（${run.manifest.name}）: ${okCount}/${run.results.length} 阶段完成${degradedSteps.length > 0 ? `，降级阶段: ${degradedSteps.join('、')}` : ''}`
  }

  const evidenceLedger = buildWorkflowEvidenceLedger(run.state, {
    manifestId: run.manifest.id,
    ...(run.options.runId !== undefined ? { runId: run.options.runId } : {}),
  })
  const result: WorkflowRunResult = {
    manifestId: run.manifest.id,
    caseType: run.manifest.caseType,
    completed,
    stages: run.results,
    degradedSteps,
    summary,
    // 没有证据来源时不写空台账：缺席表示"未记录"，空台账会被读成"已确认没有证据"。
    ...(evidenceLedger.receipts.length > 0 ? { evidenceLedger } : {}),
    ...(run.revisions.length > 0 ? { revisions: run.revisions } : {}),
    ...(run.revisionsTruncated ? { revisionsTruncated: true } : {}),
    ...(interrupted ? { interrupted } : {}),
  }
  // 持久化失败不阻断执行结果，仅把告警带回结果供调用方展示。
  try {
    await run.options.persist?.saveRun(result, run.options.runId)
  } catch (error) {
    result.persistWarning = `持久化失败（不影响执行结果）: ${error instanceof Error ? error.message : String(error)}`
  }
  return result
}
