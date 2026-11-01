/**
 * 灵活计划层（移植自 XiaoNuo legal-bus FlexiblePlan + LegalStateMachine 检查点语义）。
 *
 * 阶段级生命周期管理：运行中增删改阶段、逐阶段确认（confirmStage）、回退重做
 * （rollbackStage：目标阶段及其后已确认阶段置 rolled_back 保留审计）、法条判定挂接
 * （attachArticleJudgment：委托 FactBlackboard.setArticleJudgment）。
 *
 * 纯函数 + 守卫：所有方法接收当前 state 返回新 state（stateless）；非法操作直接
 * 抛 FlexiblePlanError（fail-closed）。toManifest() 生成 WorkflowManifest 交给
 * runWorkflow 执行——本层只管理计划不执行阶段，执行结果经 confirmStage /
 * rollbackStage 回流。
 */

import {
  HIGH_CONFIDENCE_THRESHOLD,
  SAFE_ID_PATTERN,
  classifyIpcTop,
  digestText,
  getIpcDomain,
  manifestToGraph,
  validateRevisionLog,
  type ArticleJudgment,
  type CompiledGraph,
  type FactBlackboard,
  type IpcClassification,
  type ManifestToGraphDeps,
  type RevisionRecord,
  type WorkflowManifest,
  type WorkflowStage,
} from '@deepseek-ai/dsh-patent-core'

/** 阶段状态：pending 未执行 / confirmed 已确认 / rolled_back 曾确认后作废（审计保留）。 */
export type FlexibleStageStatus = 'pending' | 'confirmed' | 'rolled_back'

/** 阶段（对齐 WorkflowStage 的 strategy/atom/params，补阶段级状态）。 */
export type FlexibleStage = {
  id: string
  name: string
  goal: string
  strategy: 'chain' | 'react' | 'sub_agent'
  /** 可选：声明 atom 后 toManifest 生成的阶段交 runWorkflow 原子执行。 */
  atom?: string
  /** 可选：传递给 StageHandler 的静态参数。 */
  params?: Record<string, unknown>
  status: FlexibleStageStatus
  /** 阶段产物清单（供审计/展示）。 */
  artifacts: string[]
  /** 引用 FactBlackboard 规则约束 id。 */
  constraintIds: string[]
  /** 引用 FactBlackboard 法条判定 id（attachArticleJudgment 写入）。 */
  articleJudgments: string[]
}

/** 计划生命周期状态：active 进行中 / completed 已完成 / abandoned 已放弃。 */
export type FlexiblePlanStatus = 'active' | 'completed' | 'abandoned'

/** 灵活计划状态快照（纯数据，可 JSON 持久化）。 */
export type FlexiblePlanState = {
  caseId: string
  /** 对齐 orchestrations id（invalidation / infringement / drafting …）。 */
  caseType: string
  technicalField?: string
  /** 案件原始输入文本（create 时透传，供 run 原子执行复用；可选）。 */
  inputText?: string
  status: FlexiblePlanStatus
  stages: FlexibleStage[]
  /** 当前执行阶段；缺省 = 首个未确认阶段；无待执行阶段时为 undefined。 */
  currentStageId?: string | undefined
  /** abandon 时记录原因（审计）。 */
  abandonReason?: string
  /** 人工回退留痕（有上限）；只存产出摘要，不复制全文。 */
  revisions?: RevisionRecord[]
  createdAt: string
  updatedAt: string
}

/** 灵活计划最多保留的回退记录数。 */
const MAX_PLAN_REVISIONS = 64

/** 灵活计划守卫错误：非法操作（fail-closed）时抛出。 */
export class FlexiblePlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FlexiblePlanError'
  }
}

const now = (): string => new Date().toISOString()

/** 创建灵活计划的选项（技术领域、输入文本、IPC 分类器、初始阶段、时钟）。 */
export type CreateFlexiblePlanOptions = {
  technicalField?: string
  /** 案件原始输入文本（如技术交底书摘要、权利要求主题）。 */
  inputText?: string
  /** 可注入的 IPC 分类器（测试用）。 */
  classifier?: (text: string) => IpcClassification
  /** 初始阶段（新计划全部置 pending）。 */
  stages?: FlexibleStage[]
  /** 可注入时钟（测试用）。 */
  now?: () => string
}

/**
 * 创建新计划：所有传入阶段强制 pending，currentStageId 指向首个阶段。
 * @param caseId - 案件标识（须匹配 SAFE_ID_PATTERN）。
 * @param caseType - 编排类型（invalidation / infringement / drafting …）。
 * @param options - 可选配置（技术领域、输入文本、IPC 分类器、初始阶段、时钟）。
 * @returns 新计划状态快照（status=active）。
 */
export function createFlexiblePlan(
  caseId: string,
  caseType: string,
  options: CreateFlexiblePlanOptions = {},
): FlexiblePlanState {
  if (caseId.trim() === '') throw new FlexiblePlanError('caseId 不能为空')
  if (caseType.trim() === '') throw new FlexiblePlanError('caseType 不能为空')
  if (!SAFE_ID_PATTERN.test(caseId)) {
    throw new FlexiblePlanError(`caseId ${JSON.stringify(caseId)} 含非法字符（仅允许 [A-Za-z0-9._-] 且不以点开头）`)
  }

  const nowFn = options.now ?? now
  const ts = nowFn()
  const stages = (options.stages ?? []).map(s => ({ ...s, status: 'pending' as const }))

  const ids = new Set<string>()
  for (const s of stages) {
    if (s.id.trim() === '') throw new FlexiblePlanError('stage.id 不能为空')
    if (ids.has(s.id)) throw new FlexiblePlanError(`重复的阶段 id: ${s.id}`)
    ids.add(s.id)
  }

  const technicalField =
    options.technicalField !== undefined
      ? options.technicalField
      : inferTechnicalField(options.inputText ?? '', options.classifier)

  return {
    caseId,
    caseType,
    ...(technicalField !== undefined ? { technicalField } : {}),
    ...(options.inputText !== undefined && options.inputText.trim() !== '' ? { inputText: options.inputText } : {}),
    status: 'active',
    stages,
    currentStageId: stages[0]?.id,
    createdAt: ts,
    updatedAt: ts,
  }
}

/**
 * 把 IPC 分类结果格式化为 technicalField（例：H:电学 / H01:基本电气元件）。
 * @param classification - IPC 分类结果。
 * @returns 格式化后的技术领域字符串（"code:label"）。
 */
export function formatTechnicalField(classification: IpcClassification): string {
  const sectionName = getIpcDomain(classification.section)?.name ?? classification.section
  const detail = classification.detail
  const code = detail ? `${classification.section} ${detail}` : classification.section
  const label = detail ? `${sectionName}-${classification.detail}` : sectionName
  return `${code}:${label}`
}

/**
 * 根据案件输入文本推断技术领域。
 * 置信度低于高置信阈值时返回 undefined（避免低质量注入）。
 * @param inputText - 案件输入文本。
 * @param classifier - 可注入的 IPC 分类器（默认 classifyIpcTop）。
 * @returns 技术领域字符串；置信度低于阈值或输入为空时为 undefined。
 */
export function inferTechnicalField(
  inputText: string,
  classifier: (text: string) => IpcClassification = classifyIpcTop,
): string | undefined {
  if (!inputText.trim()) return undefined
  const top = classifier(inputText)
  if (top.confidence < HIGH_CONFIDENCE_THRESHOLD) return undefined
  return formatTechnicalField(top)
}

/**
 * 追加阶段：新阶段置 pending；计划无当前阶段时指向新阶段。
 * @param state - 当前计划状态（须为 active）。
 * @param stage - 待追加的阶段。
 * @returns 追加后的新计划状态。
 */
export function addStage(state: FlexiblePlanState, stage: FlexibleStage): FlexiblePlanState {
  assertActive(state)
  if (stage.id.trim() === '') throw new FlexiblePlanError('stage.id 不能为空')
  if (state.stages.some(s => s.id === stage.id)) {
    throw new FlexiblePlanError(`重复的阶段 id: ${stage.id}`)
  }
  const stages = [...state.stages, { ...stage, status: 'pending' as const }]
  return {
    ...state,
    stages,
    currentStageId: state.currentStageId ?? stage.id,
    updatedAt: now(),
  }
}

/**
 * 删除阶段：currentStageId 若指向被删阶段则回落到首个未确认阶段。
 * @param state - 当前计划状态（须为 active）。
 * @param stageId - 待删除的阶段 id。
 * @returns 删除后的新计划状态。
 */
export function removeStage(state: FlexiblePlanState, stageId: string): FlexiblePlanState {
  assertActive(state)
  const idx = findStageIndex(state, stageId)
  const stages = state.stages.filter((_, i) => i !== idx)
  const currentStageId = state.currentStageId === stageId ? firstUnconfirmed(stages) : state.currentStageId
  return { ...state, stages, currentStageId, updatedAt: now() }
}

/**
 * 重排阶段：stageIds 必须包含全部阶段且无重复（fail-closed）。
 * @param state - 当前计划状态（须为 active）。
 * @param stageIds - 新阶段顺序（须包含全部阶段 id 且无重复）。
 * @returns 重排后的新计划状态。
 */
export function reorderStages(state: FlexiblePlanState, stageIds: string[]): FlexiblePlanState {
  assertActive(state)
  if (stageIds.length !== state.stages.length) {
    throw new FlexiblePlanError('reorderStages: 新顺序必须包含全部阶段')
  }
  const idSet = new Set(stageIds)
  if (idSet.size !== stageIds.length) {
    throw new FlexiblePlanError('reorderStages: 顺序列表不能包含重复 id')
  }
  const byId = new Map(state.stages.map(s => [s.id, s]))
  const stages: FlexibleStage[] = []
  for (const id of stageIds) {
    const s = byId.get(id)
    if (s === undefined) throw new FlexiblePlanError(`reorderStages: 未知阶段 "${id}"`)
    stages.push(s)
  }
  const currentStageId =
    state.currentStageId !== undefined && idSet.has(state.currentStageId)
      ? state.currentStageId
      : firstUnconfirmed(stages)
  return { ...state, stages, currentStageId, updatedAt: now() }
}

/**
 * 确认阶段：置 confirmed，currentStageId 指向首个未确认阶段。
 * @param state - 当前计划状态（须为 active）。
 * @param stageId - 待确认的阶段 id。
 * @returns 确认后的新计划状态。
 */
export function confirmStage(state: FlexiblePlanState, stageId: string): FlexiblePlanState {
  assertActive(state)
  const idx = findStageIndex(state, stageId)
  const stages = state.stages.map((s, i) => (i === idx ? { ...s, status: 'confirmed' as const } : s))
  const currentStageId = firstUnconfirmed(stages)
  return { ...state, stages, currentStageId, updatedAt: now() }
}

/** 人工回退的留痕输入：缺口、原因与前后产出摘要。 */
export type RollbackRevisionOptions = {
  /** 触发回退的缺口编号；缺省取阶段 id。 */
  gapId?: string
  /** 为什么回退；缺省为「人工回退到 <stageId>」。 */
  rationale?: string
  /** 回退前产出的摘要；缺省用阶段 id 与状态生成。 */
  before?: string
  /** 回退后产出的摘要；此时通常尚未产生，可后续补录。 */
  after?: string
  /** 可选证据引用。 */
  evidence?: string
  /** 可注入时钟；给出时写入 RevisionRecord.at。缺省不写，保持持久化结果确定。 */
  now?: () => string
}

/**
 * 回退重做：目标阶段及其后已确认阶段置 rolled_back（审计保留），目标之前已确认保留，
 * pending 保持；currentStageId 回到目标阶段。每次回退追加一条 RevisionRecord，
 * 只存摘要并受上限约束。
 * @param state - 当前计划状态（须为 active）。
 * @param stageId - 回退目标阶段 id。
 * @param options - 可选的缺口/原因/摘要留痕。
 * @returns 回退后的新计划状态（currentStageId 指向目标阶段）。
 */
export function rollbackStage(
  state: FlexiblePlanState,
  stageId: string,
  options: RollbackRevisionOptions = {},
): FlexiblePlanState {
  assertActive(state)
  const { index: idx, stage: target } = requireStage(state, stageId)
  const stages = state.stages.map((s, i) =>
    i >= idx && s.status === 'confirmed' ? { ...s, status: 'rolled_back' as const } : s,
  )
  const round = (state.revisions ?? []).filter(record => record.rewindTo === stageId).length + 1
  const record: RevisionRecord = {
    gapId: options.gapId ?? stageId,
    rewindTo: stageId,
    requestedBy: stageId,
    round,
    before: options.before ?? digestText(`${stageId}:${target.status}`),
    ...(options.after !== undefined ? { after: options.after } : {}),
    rationale: options.rationale ?? `人工回退到 ${stageId}`,
    ...(options.evidence !== undefined ? { evidence: options.evidence } : {}),
    outcome: 'applied',
    ...(options.now !== undefined ? { at: options.now() } : {}),
  }
  const revisions = [...(state.revisions ?? []), record].slice(-MAX_PLAN_REVISIONS)
  return { ...state, stages, currentStageId: stageId, revisions, updatedAt: now() }
}

/**
 * 挂接法条判定：写入 FactBlackboard（locked 时抛错，fail-closed），并在阶段上记录引用。
 * @param state - 当前计划状态（须为 active）。
 * @param stageId - 目标阶段 id。
 * @param judgment - 法条判定。
 * @param blackboard - 与计划同 caseId/caseType 的事实黑板。
 * @returns 记录引用后的新计划状态。
 */
export function attachArticleJudgment(
  state: FlexiblePlanState,
  stageId: string,
  judgment: ArticleJudgment,
  blackboard: FactBlackboard,
): FlexiblePlanState {
  assertActive(state)
  const { index: idx, stage: target } = requireStage(state, stageId)
  if (blackboard.caseId !== state.caseId || blackboard.caseType !== state.caseType) {
    throw new FlexiblePlanError(
      `attachArticleJudgment: 黑板属于 ${blackboard.caseId}/${blackboard.caseType}，` +
        `与计划 ${state.caseId}/${state.caseType} 不一致`,
    )
  }
  if (target.status === 'rolled_back') {
    throw new FlexiblePlanError(`阶段 "${stageId}" 已回退作废，不接受新法条判定`)
  }
  blackboard.setArticleJudgment(judgment)
  const stages = state.stages.map((s, i) => {
    if (i !== idx) return s
    const articleJudgments = s.articleJudgments.includes(judgment.articleId)
      ? s.articleJudgments
      : [...s.articleJudgments, judgment.articleId]
    return { ...s, articleJudgments }
  })
  return { ...state, stages, updatedAt: now() }
}

/**
 * 生成 WorkflowManifest 交 runWorkflow 执行：只发射未完成阶段
 * （pending 待执行 + rolled_back 回退后待重做），confirmed 已确认不重复执行。
 * @param state - 当前计划状态（须为 active）。
 * @returns 仅含未完成阶段的工作流清单。
 */
export function toManifest(state: FlexiblePlanState): WorkflowManifest {
  assertActive(state)
  const stages: WorkflowStage[] = state.stages
    .filter(s => s.status !== 'confirmed')
    .map(s => ({
      id: s.id,
      strategy: s.strategy,
      description: s.goal,
      ...(s.atom !== undefined ? { atom: s.atom } : {}),
      ...(s.params !== undefined ? { params: s.params } : {}),
    }))
  if (stages.length === 0) {
    throw new FlexiblePlanError(`计划 ${state.caseId} 没有待执行阶段（全部已确认）`)
  }
  return {
    id: `flexible_${state.caseId}`,
    name: `灵活计划 ${state.caseId}`,
    caseType: state.caseType,
    stages,
  }
}

/**
 * 灵活计划 → 可执行图（toManifest + manifestToGraph 一步到位）。
 * @param state - 当前计划状态（须为 active）。
 * @param deps - 构图依赖（默认空）。
 * @returns 编译后的可执行图。
 */
export function toCompiledGraph(state: FlexiblePlanState, deps: ManifestToGraphDeps = {}): CompiledGraph {
  return manifestToGraph(toManifest(state), deps)
}

/**
 * 完成计划：全部 pending 置 confirmed（已确认/已回退保留），status → completed。
 * @param state - 当前计划状态（须为 active）。
 * @returns 完成后的新计划状态。
 */
export function complete(state: FlexiblePlanState): FlexiblePlanState {
  assertActive(state)
  const stages = state.stages.map(s => (s.status === 'pending' ? { ...s, status: 'confirmed' as const } : s))
  return { ...state, status: 'completed', stages, currentStageId: undefined, updatedAt: now() }
}

/**
 * 放弃计划：pending 置 rolled_back（已确认保留审计），status → abandoned，记录原因。
 * @param state - 当前计划状态（须为 active）。
 * @param reason - 放弃原因（非空）。
 * @returns 放弃后的新计划状态。
 */
export function abandon(state: FlexiblePlanState, reason: string): FlexiblePlanState {
  assertActive(state)
  if (reason.trim() === '') {
    throw new FlexiblePlanError('abandon: reason 不能为空')
  }
  const stages = state.stages.map(s => (s.status === 'pending' ? { ...s, status: 'rolled_back' as const } : s))
  return {
    ...state,
    status: 'abandoned',
    stages,
    currentStageId: undefined,
    abandonReason: reason.trim(),
    updatedAt: now(),
  }
}

/**
 * 序列化（检查点持久化）。
 * @param state - 计划状态快照。
 * @returns 缩进 JSON 字符串。
 */
export function toJSON(state: FlexiblePlanState): string {
  return JSON.stringify(state, null, 2)
}

/**
 * 反序列化（轻量守卫，非法快照抛错）。
 * @param text - 计划状态快照的 JSON 字符串。
 * @returns 校验通过的计划状态快照。
 */
/** fromJSON 解析目标的宽松形态：校验字段保持未收窄类型，校验通过后再收窄为 FlexiblePlanState。 */
type LoosePlanState = {
  caseId: string
  caseType: string
  status: string | undefined
  stages: Array<{
    id: string
    name: string
    goal: string
    strategy: string | undefined
    status: string | undefined
    artifacts: unknown
    constraintIds: unknown
    articleJudgments: unknown
  } | null>
  currentStageId: string | undefined
  revisions: unknown
}

/**
 * 从 JSON 快照反序列化 FlexiblePlanState，校验每个必填字段与约束。
 * @param text - 计划快照的 JSON 文本。
 * @returns 反序列化并校验后的计划状态。
 * @throws {@link FlexiblePlanError} 当快照缺少或违反必填字段时。
 */
export function fromJSON(text: string): FlexiblePlanState {
  const data = JSON.parse(text) as LoosePlanState
  if (typeof data.caseId !== 'string' || data.caseId.trim() === '') {
    throw new FlexiblePlanError('fromJSON: 非法计划快照（caseId 缺失）')
  }
  if (!SAFE_ID_PATTERN.test(data.caseId)) {
    throw new FlexiblePlanError(
      `fromJSON: caseId ${JSON.stringify(data.caseId)} 含非法字符（仅允许 [A-Za-z0-9._-] 且不以点开头）`,
    )
  }
  if (typeof data.caseType !== 'string' || data.caseType.trim() === '') {
    throw new FlexiblePlanError('fromJSON: 非法计划快照（caseType 缺失）')
  }
  if (data.status !== 'active' && data.status !== 'completed' && data.status !== 'abandoned') {
    throw new FlexiblePlanError(`fromJSON: 未知计划状态 "${String(data.status)}"`)
  }
  if (!Array.isArray(data.stages)) {
    throw new FlexiblePlanError('fromJSON: 非法计划快照（stages 缺失）')
  }
  const ids = new Set<string>()
  for (const stage of data.stages) {
    if (typeof stage !== 'object' || stage === null) {
      throw new FlexiblePlanError('fromJSON: 非法计划快照（stages 含非对象元素）')
    }
    if (typeof stage.id !== 'string' || stage.id.trim() === '') {
      throw new FlexiblePlanError('fromJSON: 非法计划快照（stage.id 缺失）')
    }
    if (ids.has(stage.id)) {
      throw new FlexiblePlanError(`fromJSON: 重复的阶段 id: ${stage.id}`)
    }
    ids.add(stage.id)
    if (typeof stage.name !== 'string') {
      throw new FlexiblePlanError(`fromJSON: 阶段 ${stage.id} 的 name 非法`)
    }
    if (typeof stage.goal !== 'string' || stage.goal.trim() === '') {
      throw new FlexiblePlanError(`fromJSON: 阶段 ${stage.id} 缺少 goal`)
    }
    if (stage.strategy !== 'chain' && stage.strategy !== 'react' && stage.strategy !== 'sub_agent') {
      throw new FlexiblePlanError(`fromJSON: 阶段 ${stage.id} 的 strategy 非法`)
    }
    if (stage.status !== 'pending' && stage.status !== 'confirmed' && stage.status !== 'rolled_back') {
      throw new FlexiblePlanError(`fromJSON: 阶段 ${stage.id} 的 status 非法`)
    }
    if (!Array.isArray(stage.artifacts)) {
      throw new FlexiblePlanError(`fromJSON: 阶段 ${stage.id} 的 artifacts 非法`)
    }
    if (!Array.isArray(stage.constraintIds)) {
      throw new FlexiblePlanError(`fromJSON: 阶段 ${stage.id} 的 constraintIds 非法`)
    }
    if (!Array.isArray(stage.articleJudgments)) {
      throw new FlexiblePlanError(`fromJSON: 阶段 ${stage.id} 的 articleJudgments 非法`)
    }
  }
  if (data.currentStageId !== undefined && !ids.has(data.currentStageId)) {
    throw new FlexiblePlanError(`fromJSON: currentStageId "${data.currentStageId}" 不属于任何阶段`)
  }
  if (data.revisions !== undefined) assertRevisionLog(data.revisions)
  return data as FlexiblePlanState
}

/**
 * 校验持久化的回退留痕：只接受带必填字符串字段的对象数组。
 *
 * 判定规则由 `validateRevisionLog` 统一持有（workflow-run 的磁盘记录消费同一形状），
 * 这里只负责把原因包装成本层的错误类型。
 */
function assertRevisionLog(value: unknown): void {
  const result = validateRevisionLog(value)
  if (!result.ok) throw new FlexiblePlanError(`fromJSON: ${result.reason}`)
}

// ---------------------------------------------------------------------------
// 内部守卫
// ---------------------------------------------------------------------------

function assertActive(state: FlexiblePlanState): void {
  if (state.status !== 'active') {
    throw new FlexiblePlanError(`计划 ${state.caseId} 状态为 "${state.status}"，仅 active 可变更`)
  }
}

function findStageIndex(state: FlexiblePlanState, stageId: string): number {
  return requireStage(state, stageId).index
}

/** 定位阶段并返回下标与阶段本体；阶段不存在时 fail-closed。 */
function requireStage(
  state: FlexiblePlanState,
  stageId: string,
): { index: number; stage: FlexibleStage } {
  const index = state.stages.findIndex(s => s.id === stageId)
  const stage = state.stages[index]
  if (stage === undefined) {
    throw new FlexiblePlanError(`阶段 "${stageId}" 不存在（计划 ${state.caseId}）`)
  }
  return { index, stage }
}

/** 从头找第一个未确认阶段（无待执行阶段时为 undefined）。 */
function firstUnconfirmed(stages: readonly FlexibleStage[]): string | undefined {
  return stages.find(s => s.status !== 'confirmed')?.id
}
