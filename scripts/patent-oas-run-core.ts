/**
 * `patent-oas` 实测采集:把一次真实运行变成门禁能判定的 run 记录。
 *
 * 采集按轮次重复两级编排,与金标的物理隔离一致:
 *   - 执行者(executor)拿到本轮私有的 agent state 副本与该轮公开任务(第 2 轮起为第 1 轮
 *     任务追加脚本化审查意见),产出交付物;
 *   - 评估者(evaluator)在每个轮次内按 rubric 维度各调用一次,只拿到该维度正文与当轮
 *     交付物。引擎的默认评估者一次给整个 case 打分;这里按维度分开调用,是为了让分数能
 *     落到问题空间节点上——代价是每轮每个 case 的评估调用数等于维度数。
 *
 * 后续轮次从上一轮工作目录复制 agent state,并把上一轮交付物留作
 * `previous-deliverable.md` 参考;终局维度只取最后一轮,逐轮观测写入记录的 `rounds`。
 *
 * 被测面(`execution`)有两条:`prompt` 就是上面的提示词调用;`workflow` 让执行者经
 * `patent_workflow_run` 跑问题空间为该 case 声明的 manifest 的全部阶段,把声明的交付阶段正文
 * 另存为本轮交付物,再经 `matter_log_append` 落一条审计记录。工作流设置多记两样东西:记录里的
 * `workflowId`,以及 `rounds[].claimVersions` —— 每轮交付物在 `_matter-log.md` 取代链上的深度,
 * 由 {@link parseMatterEntries} 从日志复算,不是执行者自报。阶段定义、审批门阶段与日志文法都取自
 * patent 包(`builtinPatentManifests`、`MATTER_LOG_FILE`、`parseMatterEntries`),评测器不重实现工作流。
 * headless 组合不挂 agent preset(preset 是 agent 平面,只有 `dsh-agent-preset-registry` 能挂),
 * 所以工作流设置经 overlay 直接挂 patent 工具行,测的是工作流与审计链,不含 preset 的人设层。
 *
 * 与引擎默认接缝的两处必要差异,其余措辞与 `self-evolve-benchmark` 的默认提示词一致:
 *   1. 交付物由执行者写进工作目录的 `deliverable.md`,而不是由子 agent 作为文本返回:
 *      一次性 `dsh --profile` 运行不把助手正文打到 stdout,文件是唯一的可靠观测面。
 *   2. 评估者只输出一个 JSON 对象到 `score.json`,不让模型自由发挥评语字段。
 *
 * 执行者看到的是**本次运行私有的 agent state 副本**:引擎把 `agentStatePath` 交给执行者
 * 读取,这里让该目录同时充当执行者的工作目录,于是交付物落在这份副本里,金标目录始终只读。
 *
 * 真正的 agent 进程通过 {@link RunAgents} 接缝注入,默认实现是
 * {@link spawnAgentProcess}(CLI 用它,测试用桩),因此整条编排、产物契约与超时行为都能在
 * 没有 key 的环境里被验证——这与 `BenchmarkEngineCore` 注入 execute/evaluate 接缝是同一设计。
 *
 * @module
 */

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { CASE_OUTPUTS_REL, CASE_ROOT_REL, caseOutputsDir, caseWorkflowRunsDir } from '@deepseek-ai/dsh-patent-core'
import { builtinPatentManifests } from '@deepseek-ai/dsh-patent-workflow'
import { MATTER_LOG_FILE, parseMatterEntries } from '@deepseek-ai/dsh-patent-tools'
import {
  PATENT_OAS_EXAMPLE_DIR,
  mean,
  parseRubricDimensions,
  roundScore,
  textDigest,
  validateProblemSpace,
  type ExecutionSetting,
  type GoldCase,
  type ProblemSpace,
  type RetrievalSetting,
  type RubricDimension,
  type RunCase,
  type RunDimension,
  type RunRecord,
  type RunRound,
  type RunRoundDimension,
  type WorkflowDeliverable,
} from './patent-oas-gate-core.ts'
import { budgetOf, observeConcision, type ConcisionObservation } from './patent-oas-concision.ts'

/** 执行者写出的交付物文件名,相对于该次调用的工作目录。 */
export const DELIVERABLE_FILENAME = 'deliverable.md'

/** 工作流设置下,交付答复书经 patent 工具面与审计日志所需的 overlay(相对仓库根)。 */
export const WORKFLOW_PATCH_FILE = `${PATENT_OAS_EXAMPLE_DIR}/patent-workflow.patch.yml`

/** 人工确认阶段在 manifest 里由该原子标记;评测采集无人值守,按阶段 id 显式放行。 */
const APPROVAL_ATOM = 'approval-gate'

/** 多轮 case 第 2 轮起,上一轮交付物在该次调用工作目录中的副本文件名。 */
export const PREVIOUS_DELIVERABLE_FILENAME = 'previous-deliverable.md'

/** 评估者写出的分数文件名,相对于该次调用的工作目录。 */
export const SCORE_FILENAME = 'score.json'

/** 每次 agent 进程调用的诊断日志文件名。 */
export const AGENT_LOG_FILENAME = 'agent.log'

/** `--json` 事件流中单行解析缓冲的字符上限;超过的一行不是带 usage 的步末事件,丢弃以免无限累积。 */
const MAX_USAGE_LINE_CHARS = 1024 * 1024

/** 判断一个值是否是普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 可选 token 计数:缺省按 0;给出但不是有限非负数时返回 undefined。 */
function optionalCount(value: unknown): number | undefined {
  if (value === undefined) return 0
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  return undefined
}

/**
 * 从 `dsh --json` 的一行事件里取该步的 usage。
 *
 * token 计数是互斥的:缓存命中的输入单独上报,因此这里把 `cacheReadTokens` 与
 * `cacheWriteTokens` 折进输入,得到计费输入量。只认完整的 `step_end` 事件:json-stream
 * 在任一次尝试未报告 usage 时会省略该步的 usage,因此这里的求和不会把部分值当成完整值。
 * 非 JSON 行或其它事件返回 undefined。
 *
 * @param line 一行 NDJSON 文本。
 * @returns 该步的计费输入/输出 token;不是带 usage 的 step_end 时为 undefined。
 */
export function parseRunEventUsage(line: string): { input: number; output: number } | undefined {
  let event: unknown
  try {
    event = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(event) || event.type !== 'status' || event.phase !== 'step_end') return undefined
  const usage = event.usage
  if (!isRecord(usage)) return undefined
  const input = usage.inputTokens
  const output = usage.outputTokens
  const cacheRead = optionalCount(usage.cacheReadTokens)
  const cacheWrite = optionalCount(usage.cacheWriteTokens)
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) return undefined
  if (typeof output !== 'number' || !Number.isFinite(output) || output < 0) return undefined
  if (cacheRead === undefined || cacheWrite === undefined) return undefined
  return { input: input + cacheRead + cacheWrite, output }
}

/** 交付物字节上限:超过即失败,而不是把一份失控输出复制进每个维度的评估提示词。 */
export const MAX_DELIVERABLE_BYTES = 256 * 1024

/** 一次 agent 进程调用。 */
export interface AgentInvocation {
  /** 该次调用的工作目录;agent 把产物写在这里,目录在调用前已创建。 */
  cwd: string
  /** 交给 agent 的提示词。 */
  prompt: string
  /** 诊断标签,用于失败信息与日志文件名。 */
  label: string
}

/**
 * 运行一个 agent 进程的接缝。
 *
 * 实现必须让 agent 在其 `cwd` 内产出本次调用要求的文件;未能产出时由编排层报错,
 * 因为「agent 没写出产物」与「产物内容不合法」是两种不同的失败。
 */
/** 一次调用的用量(执行器与评估者进程报告多少算多少)。 */
export interface RunCallUsage {
  /** 该次调用的成本(USD,provider 报告);未报告时省略。 */
  cost?: number
  /** 该次调用的 token 使用;未报告时省略。 */
  tokens?: { input: number; output: number }
}

export type RunAgents = (invocation: AgentInvocation) => Promise<RunCallUsage | void>

/** 一个 case 在工作流设置下的采集计划;阶段清单取自 patent workflow manifest,不在这里另立。 */
export interface WorkflowPlan {
  /** 被测的 manifest id。 */
  manifestId: string
  /** 按执行顺序排列的阶段 id。 */
  stages: string[]
  /** 交付物文件名主干:第 N 轮写 `<artifact>-r<N>.md`。 */
  artifact: string
  /** 组成交付物的阶段 id,按声明顺序拼接;由问题空间为该 case 声明。 */
  deliverableStages: string[]
  /** 需要显式放行的人工确认阶段 id(manifest 里由 `approval-gate` 原子标记的阶段)。 */
  approvalStages: string[]
}

/** 计划运行的一个 case。 */
export interface RunPlanCase {
  /** case id。 */
  caseId: string
  /** 该 case 的检索环境。 */
  retrieval: RetrievalSetting
  /** 该 case 的 rubric 维度数(每轮逐维度一次评估调用)。 */
  dimensions: number
  /** 该 case 的轮次。 */
  rounds: number
  /** 工作流设置下该 case 的阶段清单;提示词设置省略。 */
  workflow?: WorkflowPlan
}

/** 一次采集的计划:要跑哪些 case、每个 case 几次、总共多少次调用。 */
export interface RunPlan {
  /** 计划运行的 case,按 case id 排序。 */
  cases: RunPlanCase[]
  /** 本次采集的被测面。 */
  execution: ExecutionSetting
  /** 每个 case 的运行次数。 */
  runsPerCase: number
  /** 计划中的 agent 进程调用总数(含每轮执行者与逐维度评估者)。 */
  calls: number
  /** 工作流设置计划跑过的阶段次数(阶段数 × 轮次 × 运行数 × case 数);提示词设置为 0。 */
  stageRuns: number
}

/** 按百万 token 单价换算一次采集的成本(USD)。 */
export interface RunPricing {
  /** 输入 token 单价(USD / 百万 token);统一适用于含缓存在内的计费输入。 */
  inputPerMillion: number
  /** 输出 token 单价(USD / 百万 token)。 */
  outputPerMillion: number
}

/** {@link collectRunRecord} 与 {@link planRun} 的共同选项。 */
export interface RunPlanOptions {
  /** 问题空间 DAG,提供维度到节点的映射与节点表。 */
  space: ProblemSpace
  /** 金标 case 集。 */
  gold: readonly GoldCase[]
  /** 只跑这些 case;缺省为金标全集(按 case id 排序)。 */
  caseIds?: readonly string[]
  /** 每个 case 的运行次数;缺省 1。 */
  runsPerCase?: number
  /** 被测面;缺省 `prompt`(提示词调用)。 */
  execution?: ExecutionSetting
}

/** {@link collectRunRecord} 的选项。 */
export interface CollectRunOptions extends RunPlanOptions {
  /** 每次运行前复制一份的 agent state 源目录(金标目录,只读)。 */
  agentStateDir: string
  /** 所有中间产物的根目录;每个 case、每次运行、每次调用各占一个子目录。 */
  workDir: string
  /** agent 进程接缝。 */
  runAgents: RunAgents
  /** 记录时间(ISO 8601);缺省为当前时间。 */
  recordedAt?: string
  /** 评估运行的 provider,写进记录;缺省省略。 */
  provider?: string
  /** 评估运行的模型 id,写进记录;缺省省略。 */
  modelId?: string
  /** token 单价;给出时把 usage 换算成记录里的 cost,缺省只记录 tokens。 */
  pricing?: RunPricing
  /** 被测面;缺省 `prompt`(提示词调用),`workflow` 经 patent 工具面跑 manifest。 */
  execution?: ExecutionSetting
}

/**
 * 计划一次采集:解析选中 case 的维度数、工作流阶段清单,并算出调用总数。
 *
 * 计划的唯一来源是这里,`--dry-run` 与真正采集都读它,因此「打印的计划」与「实际跑的
 * 调用」不会各算一遍而分叉。
 *
 * @param options 计划选项。
 * @returns 计划。
 * @throws 选中的 case 在工作流设置下没有声明 manifest、声明的 manifest 不在内置清单里、
 *   或一个 manifest 里不绑定原子的阶段不唯一时抛出。
 */
export function planRun(options: RunPlanOptions): RunPlan {
  const problems = validateProblemSpace(options.space, options.gold)
  if (problems.length > 0) throw new Error(`采集前校验失败:\n${problems.join('\n')}`)
  const execution = options.execution ?? 'prompt'
  const runsPerCase = options.runsPerCase ?? 1
  if (!Number.isInteger(runsPerCase) || runsPerCase < 1) throw new Error(`runsPerCase 必须是正整数,得到 ${runsPerCase}`)
  const selected = [...(options.caseIds ?? options.gold.map(entry => entry.caseId))].sort()
  const seen = new Set<string>()
  for (const caseId of selected) {
    if (seen.has(caseId)) throw new Error(`case "${caseId}" 被选中多次`)
    seen.add(caseId)
  }
  const cases = selected.map((caseId): RunPlanCase => {
    const goldCase = options.gold.find(entry => entry.caseId === caseId)
    if (goldCase === undefined) throw new Error(`case "${caseId}" 不在金标中`)
    const mapping = options.space.cases[caseId]
    if (mapping === undefined) throw new Error(`case "${caseId}" 没有问题空间映射`)
    const base: RunPlanCase = {
      caseId,
      retrieval: mapping.retrieval,
      dimensions: parseRubricDimensions(goldCase.rubric).length,
      rounds: 1 + (goldCase.rounds?.length ?? 0),
    }
    if (execution === 'prompt') return base
    if (mapping.workflow === undefined) {
      throw new Error(`case "${caseId}" 没有声明工作流 manifest,不能在 workflow 设置下采集`)
    }
    if (mapping.workflowDeliverable === undefined) {
      throw new Error(`case "${caseId}" 声明了工作流 manifest 但没有 workflowDeliverable,无法确定交付物`)
    }
    return { ...base, workflow: workflowPlanOf(mapping.workflow, caseId, mapping.workflowDeliverable) }
  })
  const manifestIds = [...new Set(cases.map(entry => entry.workflow?.manifestId).filter(isString))].sort()
  if (manifestIds.length > 1) {
    throw new Error(`workflow 设置一次只测一个 manifest,选中 case 声明了 ${manifestIds.join('、')};请用 --case 收窄`)
  }
  return {
    cases,
    execution,
    runsPerCase,
    calls: cases.reduce((sum, entry) => sum + runsPerCase * entry.rounds * (1 + entry.dimensions), 0),
    stageRuns: execution === 'workflow'
      ? cases.reduce((sum, entry) => sum + runsPerCase * entry.rounds * (entry.workflow?.stages.length ?? 0), 0)
      : 0,
  }
}

/** 字符串守卫,供 `Array.prototype.filter` 收窄 `string | undefined`。 */
function isString(value: string | undefined): value is string {
  return value !== undefined
}

/**
 * 读内置 patent workflow manifest 并算出工作流采集清单。
 *
 * 交付阶段来自问题空间为该 case 的声明,不按 manifest 猜:同一份 manifest 可以交付答复书,
 * 也可以交付权利要求书加说明书。声明里出现 manifest 没有的阶段即报错。
 *
 * @param manifestId 问题空间为 case 声明的 manifest id。
 * @param caseId 诊断用的 case id。
 * @param deliverable 该 case 声明的交付物文件名主干与来源阶段。
 * @returns 该 manifest 的阶段清单。
 */
function workflowPlanOf(
  manifestId: string,
  caseId: string,
  deliverable: WorkflowDeliverable,
): WorkflowPlan {
  const manifest = builtinPatentManifests.find(candidate => candidate.id === manifestId)
  if (manifest === undefined) {
    throw new Error(`case "${caseId}" 声明的 manifest "${manifestId}" 不在内置 patent workflow 清单中`)
  }
  const declared = new Set(manifest.stages.map(stage => stage.id))
  const unknown = deliverable.stages.filter(stage => !declared.has(stage))
  if (unknown.length > 0) {
    throw new Error(
      `case "${caseId}" 的 workflowDeliverable 引用了 manifest "${manifestId}" 没有的阶段:${unknown.join('、')}`,
    )
  }
  return {
    manifestId,
    stages: [...declared],
    artifact: deliverable.artifact,
    deliverableStages: [...deliverable.stages],
    approvalStages: manifest.stages.filter(stage => stage.atom === APPROVAL_ATOM).map(stage => stage.id),
  }
}

/**
 * 渲染一次采集计划的一行摘要。
 *
 * `--dry-run` 与真实采集共用同一个渲染,计划与实际调用数不会各算一遍而分叉。
 *
 * @param plan 采集计划。
 * @param profile 采集使用的 profile 名。
 * @returns 单行摘要。
 */
export function formatRunPlan(plan: RunPlan, profile: string): string {
  const perCase = plan.cases
    .map((entry) => {
      const retrieval = entry.retrieval === 'none' ? '' : `/${entry.retrieval}`
      return `${entry.caseId}:${entry.dimensions}${entry.rounds > 1 ? `×${entry.rounds}轮` : ''}${retrieval}`
    })
    .join(' ')
  const rounds = plan.cases.reduce((sum, entry) => sum + entry.rounds, 0)
  const workflow = plan.cases[0]?.workflow
  const surface = workflow === undefined
    ? '被测面=prompt'
    : `被测面=workflow/${workflow.manifestId}(每轮 ${workflow.stages.length} 阶段,合计 ${plan.stageRuns} 次阶段执行)`
  return `run-patent-oas: 计划 ${plan.cases.length} case × ${plan.runsPerCase} 次运行,共 ${rounds} 轮 = ${plan.calls} 次 agent 调用(${perCase});profile=${profile},${surface}`
}

/** `patent_workflow_run` 落进案件目录的运行记录里,采集需要读的字段。 */
interface WorkflowRunFile {
  /** 引擎判定该次运行是否完成(`requireAllSteps` 下含无降级阶段)。 */
  completed: boolean
  /** 降级阶段 id 清单。 */
  degradedSteps: string[]
  /** 停在人工确认阶段时的中断信息;未中断为 undefined。 */
  interrupted?: { stageId: string }
}

/**
 * 读出工作流设置某一轮的交付物,并从审计日志复算该轮权项版本。
 *
 * 三道检查按失败可能性排序:运行记录缺失说明执行者没有用给定的 caseId/manifestId 调
 * `patent_workflow_run`;`completed` 为假说明工作流停在审批门或有阶段降级,该轮的答复不是
 * 完整工作流的产物;日志里没有本轮产物则取代链无从复算。三者都报错而不是记 0 分,因为
 * 「没走工作流」与「走了但答得差」是两种不同的失败。
 *
 * @param options 该次调用的工作目录、产物定位与工作流清单、诊断标签。
 * @returns 交付物正文与该轮权项版本(取代链深度)。
 */
async function readWorkflowRound(options: {
  cwd: string
  round: WorkflowRound
  plan: WorkflowPlan
  label: string
}): Promise<{ deliverable: string; claimVersion: number }> {
  const { cwd, round, plan, label } = options
  const runsDir = join(cwd, caseWorkflowRunsDir(round.caseId))
  const suffix = `__${plan.manifestId}.json`
  let runNames: string[]
  try {
    runNames = await readdir(runsDir)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') runNames = []
    else throw error
  }
  const runFiles = runNames.filter(name => name.endsWith(suffix)).sort()
  const runFile = runFiles[0]
  if (runFile === undefined) {
    throw new Error(`${label}: ${runsDir} 下没有 "${plan.manifestId}" 的工作流运行记录,执行者没有按给定的 caseId 调用 patent_workflow_run`)
  }
  if (runFiles.length > 1) {
    throw new Error(`${label}: ${runsDir} 下有 ${runFiles.length} 份 "${plan.manifestId}" 运行记录,无法确定本轮读哪一份:${runFiles.join('、')}`)
  }
  const run = JSON.parse(await readFile(join(runsDir, runFile), 'utf8')) as WorkflowRunFile
  if (!run.completed) {
    const stopped = run.interrupted === undefined ? '' : `,停在 "${run.interrupted.stageId}" 等待人工确认`
    throw new Error(`${label}: 工作流未完成(降级阶段:${run.degradedSteps.join('、') || '无'}${stopped}),交付物不是完整 manifest 的产物`)
  }
  const deliverable = await readArtifact(join(cwd, round.deliverablePath), label)
  const logPath = join(cwd, round.caseDir, MATTER_LOG_FILE)
  const logText = await readArtifact(logPath, label)
  const claimVersion = claimVersionOf(logText, round.artifactPath)
  if (claimVersion === undefined) {
    throw new Error(`${label}: ${logPath} 的取代链里没有本轮产物 "${round.artifactPath}",执行者没有按约定留档`)
  }
  return { deliverable, claimVersion }
}

/**
 * 从 `_matter-log.md` 的取代链复算某个产物的权项版本。
 *
 * 版本是该产物所在的「产物 → 被取代产物」链上的产物条数:初版为 1,每取代一次加 1。
 * 取代链按 `matter_log_append` 的判定不分叉,但一条记录可以登记多个被取代产物(答复书与
 * 权项对照表一起走),因此取各条前驱链中最深的一条。
 *
 * @param logText 日志全文。
 * @param artifactPath 相对 `case_dir` 登记的产物路径。
 * @returns 链深(1 起);日志里没有登记该产物的条目时 undefined。
 */
export function claimVersionOf(logText: string, artifactPath: string): number | undefined {
  const predecessors = new Map<string, string[]>()
  for (const entry of parseMatterEntries(logText)) {
    for (const path of entry.artifacts) {
      if (!predecessors.has(path)) predecessors.set(path, entry.supersedes)
    }
  }
  if (!predecessors.has(artifactPath)) return undefined
  const depth = (path: string, visiting: Set<string>): number => {
    const parents = predecessors.get(path)
    if (parents === undefined || visiting.has(path)) return 1
    const nextVisiting = new Set(visiting)
    nextVisiting.add(path)
    let deepest = 0
    for (const parent of parents) {
      deepest = Math.max(deepest, depth(parent, nextVisiting))
    }
    return deepest === 0 ? 1 : deepest + 1
  }
  return depth(artifactPath, new Set())
}

/**
 * 构造某一轮的累积任务文本:第 1 轮为公开任务,后续轮次追加脚本化审查意见。
 *
 * @param goldCase 金标 case。
 * @param round 轮次,1 起。
 * @returns 执行者与评估者共用的任务文本。
 */
export function roundStatement(goldCase: GoldCase, round: number): string {
  if (round === 1) return goldCase.statement
  const extra = goldCase.rounds?.find(entry => entry.round === round)
  if (extra === undefined) throw new Error(`case "${goldCase.caseId}" 没有第 ${round} 轮审查意见`)
  return [goldCase.statement, '', '【再审查意见】', extra.statement].join('\n')
}

/**
 * 执行者提示词:引擎措辞 + 公开任务 + 交付物落点。
 *
 * @param agentStatePath 作业规范目录。
 * @param statement 该轮的累积任务文本。
 * @param previousDeliverable 上一轮交付物在当前工作目录中的副本文件名;第 1 轮省略。
 * @returns 提示词。
 */
export function executorPrompt(agentStatePath: string, statement: string, previousDeliverable?: string): string {
  return [
    '你是任务执行者。请依据目标 agent 状态目录中的作业规范,完成下列任务。',
    '任务(statement):',
    statement,
    ...previousDeliverable === undefined ? [] : [
      '上一轮答复:',
      `当前工作目录中的 ${previousDeliverable};请先阅读它,再按本轮审查意见修订,不要另写一份与前文无关的答复。`,
    ],
    '作业规范目录:',
    agentStatePath,
    `要求:先阅读目录中的指导文档(如 guidance.md),按其 checklist 完成交付物;这是执行任务而非计划,直接完成并只输出交付物正文,不要输出 JSON 包装、计划说明或解释性前缀;把交付物正文写入当前工作目录的 ${DELIVERABLE_FILENAME}。`,
  ].join('\n')
}

/** 工作流设置一次运行、一轮采集的产物定位。 */
export interface WorkflowRound {
  /** 该次运行在 `data/cases/` 下使用的 case id(不含客户案卷信息)。 */
  caseId: string
  /** 案件目录相对该次调用工作目录的路径,交给 `matter_log_append` 的 `case_dir`。 */
  caseDir: string
  /** 本轮交付物相对该次调用工作目录的路径。 */
  deliverablePath: string
  /** 本轮交付物在审计日志里登记的路径(相对 `case_dir`)。 */
  artifactPath: string
}

/**
 * 算出某次运行某一轮的产物定位:case id 由采集器固定,交付物按轮另存新文件。
 *
 * 路径由这里推导而不是执行者自报,`_matter-log.md` 的取代链才能被复算成权项版本;
 * 每轮另存新文件也是 `matter_log_append` 对 `修订` 动作的要求(禁止原地覆盖上一轮)。
 *
 * @param caseId 金标 case id。
 * @param run 运行序号,1 起。
 * @param round 轮次,1 起。
 * @param artifact 交付物文件名主干,由问题空间为该 case 声明。
 * @returns 该次运行该轮的产物定位。
 */
export function workflowRound(caseId: string, run: number, round: number, artifact: string): WorkflowRound {
  const slug = `patent-oas-${caseId}-run${run}`
  const file = `${artifact}-r${round}.md`
  return {
    caseId: slug,
    caseDir: `${CASE_ROOT_REL}/${slug}`,
    deliverablePath: `${caseOutputsDir(slug)}/${file}`,
    artifactPath: `${CASE_OUTPUTS_REL}/${file}`,
  }
}

/**
 * 工作流设置的执行者提示词:一次 `patent_workflow_run` 跑完整 manifest,指定阶段的正文另存为
 * 本轮交付物,再经 `matter_log_append` 留档。
 *
 * 阶段清单与审批门阶段都来自 manifest,提示词只点名 `patent_workflow_run` 一次:阶段推进、
 * 上游产出注入与 `requireAllSteps` 判定由工作流引擎负责,评测器不重实现。无人值守采集要显式
 * 放行审批门,否则 `requireAllSteps` 把停在人工确认的运行判为未完成。
 *
 * `claims` 只对需要单独提供待审权利要求的 manifest(审查意见答复)给出口径:要素级阶段在没有
 * `claims` 时按 `input` 全文切分权项段,而任务文本里审查员论点与步骤列表都是行首编号,会被当
 * 成权项段,逐字子串校验必然失败(实测首轮 `claim-chart` 因此降级)。交底书类任务没有待审
 * 权利要求,传了反而让阶段读到不存在的权项。
 *
 * @param options 该轮的任务文本、工作流清单、产物定位与上一轮交付物。
 * @returns 提示词。
 */
export function workflowExecutorPrompt(options: {
  agentStatePath: string
  statement: string
  plan: WorkflowPlan
  round: WorkflowRound
  roundNumber: number
  previousArtifact?: string
}): string {
  const { plan, round } = options
  const approval = plan.approvalStages.map(stage => `"${stage}"`).join(', ')
  const stages = plan.deliverableStages.map(stage => `"${stage}"`).join('、')
  const claimsBasis = '若该 manifest 需要单独提供待审权利要求(如审查意见答复),claims 传本轮待答复的权利要求原文:'
    + '从任务文本或上一轮交付物里逐字摘录权利要求正文,去掉行首标签;交底书类任务不传 claims。'
    + '不要把审查员论点的编号行或【要求】里的步骤列表放进 claims——要素级阶段按行首编号切分权项段。'
  const steps = [
    `1. 调用 patent_workflow_run 跑完整工作流:manifestId 传 "${plan.manifestId}",caseId 传 "${round.caseId}"${plan.approvalStages.length > 0 ? `,approveStageIds 传 [${approval}]` : ''},input 逐字原样传下面这段任务文本(不要改写、不要省略、不要只传片段);${claimsBasis}任务文本给出申请日或优先权日时,把给出的日期按 ISO 日期传给 filingDate(有优先权日时再传 priorityDate)——时间基准阶段缺日期会降级,连带下游检索过滤失败。`,
    '',
    options.statement,
    '',
    `2. 把工作流 ${stages} 阶段产出的正文按上述顺序原样写入当前工作目录的 ${round.deliverablePath};每段之间空一行、保留各段原有标题,不要改写、不要另写一份与前文无关的正文。`,
    `3. 调用 matter_log_append 留档本轮:case_dir 传 "${round.caseDir}",action 传 "${options.roundNumber === 1 ? '建案' : '修订'}",artifacts 传 ["${round.artifactPath}"],changes 用一句话写清本轮交付了什么、依据是什么、是否影响保护点${options.previousArtifact === undefined ? '' : `,supersedes 传 ["${options.previousArtifact}"]`}。第 3 步不能跳过,也不能用 shell 直接改日志。`,
  ]
  return [
    '你是任务执行者。请依据目标 agent 状态目录中的作业规范,完成下列专利作业任务。',
    '任务(statement):',
    options.statement,
    '作业规范目录:',
    options.agentStatePath,
    '要求:按下面三步依次执行;这是执行任务而非计划,不要输出 JSON 包装、计划说明或解释性前缀,交付物以文件为准。',
    ...steps,
  ].join('\n')
}

/**
 * 评估者提示词:只给公开任务、该维度的评分标准与交付物。
 *
 * 一次调用只拿到一个维度,其他维度既不出现也不被暗示,因此维度分之间不会互相锚定。
 */
export function evaluatorPrompt(statement: string, dimension: RubricDimension, deliverable: string): string {
  return [
    '你是基准评估者。请只依据下列评分维度,对交付物打分,而不是对配置或过程打分。',
    '任务(statement):',
    statement,
    `评分维度(${dimension.label},满分 ${dimension.points}):`,
    dimension.body,
    '交付物(deliverable):',
    deliverable,
    `要求:只输出一个 JSON 对象,形如 {"score": 0 到 100 的数};score 是交付物在该维度上的得分率(满分对应 100)。把该 JSON 写入当前工作目录的 ${SCORE_FILENAME},不要输出其他内容。`,
  ].join('\n')
}

/**
 * 解析评估者写出的分数文件。
 *
 * 只接受内容就是一个 JSON 对象、且 `score` 为 0–100 有限数的情况;其余一律抛错,
 * 因为「评估者没按契约输出」必须显式可见,而不能被当成 0 分混进分数里。
 *
 * @param text `score.json` 的全文。
 * @param label 诊断标签。
 * @returns 该维度的分数。
 */
export function parseScore(text: string, label: string): number {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.trim())
  } catch {
    throw new Error(`${label}: 分数文件不是合法 JSON:${text.trim().slice(0, 200)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label}: 分数文件必须是 JSON 对象`)
  }
  const score = (parsed as Record<string, unknown>).score
  if (typeof score !== 'number' || !Number.isFinite(score)) {
    throw new Error(`${label}: 分数对象缺少有限数 score`)
  }
  if (score < 0 || score > 100) throw new Error(`${label}: score ${score} 超出 0–100`)
  return score
}

/** 真实启动器的一次调用参数。 */
export interface AgentCommandOptions {
  /** 源码启动时的 `apps/cli/src/bin.ts` 绝对路径。 */
  binPath: string
  /** tsx ESM 钩子的模块标识(`node --import <this>`)。 */
  tsxImport: string
  /** 目标 profile 名。 */
  profile: string
  /** 追加的 `--patch` overlay 路径。 */
  patchPaths?: readonly string[]
  /** 是否让 headless app 输出 NDJSON 运行事件(用于采集 usage)。 */
  json?: boolean
  /** 交给 agent 的提示词。 */
  prompt: string
}

/**
 * 构造一次真实 agent 进程的参数向量。
 *
 * 与 `self-evolve-eval` 的 campaign 运行器同形:`node --import <tsx> <bin> --profile <p>
 * [--patch <overlay>] "<prompt>"`。它是纯函数,因此真实启动方式由测试钉住,而不是只在
 * 有 key 时才第一次被执行。
 *
 * @param options 启动参数。
 * @returns 传给 `process.execPath` 的参数数组。
 */
export function agentArgv(options: AgentCommandOptions): string[] {
  return [
    '--import',
    options.tsxImport,
    options.binPath,
    '--profile',
    options.profile,
    ...(options.patchPaths ?? []).flatMap(path => ['--patch', path]),
    ...(options.json === true ? ['--json'] : []),
    options.prompt,
  ]
}

/** {@link spawnAgentProcess} 的选项。 */
export interface AgentProcessOptions {
  /** 本次调用的工作目录、提示词与诊断标签。 */
  invocation: AgentInvocation
  /** 启动参数(不含提示词;提示词取自 `invocation`)。 */
  launcher: Omit<AgentCommandOptions, 'prompt'>
  /** 单次调用的墙钟上限(毫秒)。 */
  timeoutMs: number
  /** 追加到当前进程环境之上的变量。 */
  env?: NodeJS.ProcessEnv
}

/**
 * 默认接缝实现:起一个真实 agent 进程,把 stdout/stderr 落到该次调用目录的日志里,
 * 并从 headless 的 `--json` 事件流汇总该次调用的 token 使用。
 *
 * 日志在子进程 `close` 之后才结束:超时路径是先 `SIGKILL` 再抛错,此时管道里可能还有
 * 未刷出的输出,提前结束目标流会把它丢掉。
 *
 * @param options 调用参数。
 * @returns 该次调用报告的 token 使用;没有报告时省略。
 */
export async function spawnAgentProcess(options: AgentProcessOptions): Promise<RunCallUsage | void> {
  const { invocation } = options
  const logPath = join(invocation.cwd, AGENT_LOG_FILENAME)
  const log = createWriteStream(logPath, { flags: 'a' })
  // 日志写失败(磁盘满等)不得中断采集:本次调用的成败由退出码与产物决定,日志只是定位材料。
  log.on('error', () => {})
  const child = spawn(
    process.execPath,
    agentArgv({ ...options.launcher, prompt: invocation.prompt }),
    {
      cwd: invocation.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  const decoder = new StringDecoder('utf8')
  const tokens = { input: 0, output: 0, seen: false }
  let pending = ''
  const consume = (text: string): void => {
    pending += text
    let newline = pending.indexOf('\n')
    while (newline !== -1) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      const sample = parseRunEventUsage(line)
      if (sample !== undefined) {
        tokens.input += sample.input
        tokens.output += sample.output
        tokens.seen = true
      }
      newline = pending.indexOf('\n')
    }
    // 最后一行(例如不含换行的终端事件)过大时一定不是 usage 行,丢弃以免缓冲无限增长。
    if (pending.length > MAX_USAGE_LINE_CHARS) pending = ''
  }
  child.stdout.on('data', (chunk: Buffer) => {
    log.write(chunk)
    consume(decoder.write(chunk))
  })
  child.stdout.on('end', () => {
    consume(decoder.end())
    if (pending !== '') {
      const sample = parseRunEventUsage(pending)
      if (sample !== undefined) {
        tokens.input += sample.input
        tokens.output += sample.output
        tokens.seen = true
      }
      pending = ''
    }
  })
  child.stderr.pipe(log, { end: false })
  const closed = new Promise<void>(resolveClose => child.once('close', () => {
    resolveClose()
  }))
  try {
    await new Promise<void>((settle, fail) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL')
        fail(new Error(`${invocation.label}: 超过 ${options.timeoutMs}ms 未结束,已终止`))
      }, options.timeoutMs)
      child.once('error', (error: Error) => {
        clearTimeout(timer)
        fail(new Error(`${invocation.label}: 无法启动 agent 进程:${error.message}`))
      })
      child.once('close', (code: number | null) => {
        clearTimeout(timer)
        if (code === 0) settle()
        else fail(new Error(`${invocation.label}: agent 进程退出码 ${String(code)},日志见 ${logPath}`))
      })
    })
  } finally {
    await closed
    await new Promise<void>(resolveEnd => log.end(resolveEnd))
  }
  if (!tokens.seen) return
  return { tokens: { input: tokens.input, output: tokens.output } }
}

/** 读一个必须存在的产物文件。 */
async function readArtifact(path: string, label: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label}: 未产出 ${path}(agent 未按契约写出产物)`)
    }
    throw error
  }
}

/** 一次维度观测的累加器。 */
interface DimensionAccumulator {
  dimension: RubricDimension
  scores: number[]
}

/** 一轮观测的累加器。 */
interface RoundAccumulator {
  round: number
  statementDigest?: string
  dimensions: Map<number, number[]>
  deliverableDigests: string[]
  claimVersions: number[]
  /** 每次运行的篇幅观测:只记录、不计分。 */
  concision: ConcisionObservation[]
}

/**
 * 跑一次完整采集并组装 run 记录。
 *
 * 开始前先按 {@link planRun} 校验问题空间与金标:一份对不上的金标不该消耗任何模型调用。
 * 每次运行把 agent state 复制成该次运行私有的副本,执行者在副本里工作,金标目录只读。
 *
 * @param options 采集选项。
 * @returns 可直接交给门禁判定的 run 记录。
 */
export async function collectRunRecord(options: CollectRunOptions): Promise<RunRecord> {
  const plan = planRun(options)
  const cases: RunCase[] = []
  // 用量汇总:只有每次调用都报告同一项时才写出合计,部分报告不能被当成完整值。
  const usageTotals = { calls: 0, cost: 0, costCalls: 0, input: 0, output: 0, tokenCalls: 0 }
  const addUsage = (reported: void | RunCallUsage): void => {
    usageTotals.calls += 1
    if (reported === undefined) return
    if (reported.cost !== undefined) {
      usageTotals.cost += reported.cost
      usageTotals.costCalls += 1
    }
    if (reported.tokens !== undefined) {
      usageTotals.input += reported.tokens.input
      usageTotals.output += reported.tokens.output
      usageTotals.tokenCalls += 1
    }
  }
  for (const { caseId, retrieval, rounds: roundCount, workflow } of plan.cases) {
    const goldCase = options.gold.find(entry => entry.caseId === caseId)
    if (goldCase === undefined) throw new Error(`case "${caseId}" 不在金标中`)
    const dimensions = parseRubricDimensions(goldCase.rubric)
    const statements = Array.from({ length: roundCount }, (_, index) => roundStatement(goldCase, index + 1))
    const terminalAccumulators: DimensionAccumulator[] = dimensions.map(dimension => ({ dimension, scores: [] }))
    const roundAccumulators: RoundAccumulator[] = statements.map((_, index) => {
      const round = index + 1
      const extra = round === 1 ? undefined : goldCase.rounds?.find(entry => entry.round === round)
      if (round > 1 && extra === undefined) throw new Error(`case "${caseId}" 没有第 ${round} 轮审查意见`)
      return {
        round,
        ...extra === undefined ? {} : { statementDigest: textDigest(extra.statement) },
        dimensions: new Map(dimensions.map(dimension => [dimension.index, []])),
        deliverableDigests: [],
        claimVersions: [],
        concision: [],
      }
    })
    for (let run = 1; run <= plan.runsPerCase; run += 1) {
      const base = join(options.workDir, caseId, `run-${run}`)
      let previousAgentState: string | undefined
      for (let round = 1; round <= roundCount; round += 1) {
        const isFirst = round === 1
        const isTerminal = round === roundCount
        const roundBase = isFirst ? base : join(base, `round-${round}`)
        const agentStatePath = join(roundBase, 'agent-state')
        await mkdir(roundBase, { recursive: true })
        if (isFirst) {
          await cp(options.agentStateDir, agentStatePath, { recursive: true })
        } else {
          if (previousAgentState === undefined) throw new Error(`${caseId} run ${run}: 缺少上一轮工作目录`)
          await cp(previousAgentState, agentStatePath, { recursive: true })
          if (workflow === undefined) {
            await cp(
              join(previousAgentState, DELIVERABLE_FILENAME),
              join(agentStatePath, PREVIOUS_DELIVERABLE_FILENAME),
            )
            // 上一轮产物只能作为参考;删掉它,执行者必须写出本轮的新交付物。
            await rm(join(agentStatePath, DELIVERABLE_FILENAME), { force: true })
          }
          await rm(join(agentStatePath, AGENT_LOG_FILENAME), { force: true })
        }
        const roundText = statements[round - 1]
        if (roundText === undefined) throw new Error(`${caseId}: 缺少第 ${round} 轮任务文本`)
        const roundAccumulator = roundAccumulators[round - 1]
        if (roundAccumulator === undefined) throw new Error(`${caseId}: 缺少第 ${round} 轮的累加器`)
        const executorLabel = `${caseId} run ${run} 第 ${round} 轮执行者`
        const roundFiles = workflowRound(caseId, run, round, workflow?.artifact ?? 'deliverable')
        addUsage(await options.runAgents({
          cwd: agentStatePath,
          prompt: workflow === undefined
            ? executorPrompt(agentStatePath, roundText, isFirst ? undefined : PREVIOUS_DELIVERABLE_FILENAME)
            : workflowExecutorPrompt({
              agentStatePath,
              statement: roundText,
              plan: workflow,
              round: roundFiles,
              roundNumber: round,
              ...(isFirst ? {} : { previousArtifact: workflowRound(caseId, run, round - 1, workflow.artifact).artifactPath }),
            }),
          label: executorLabel,
        }))
        let deliverable: string
        if (workflow === undefined) {
          deliverable = await readArtifact(join(agentStatePath, DELIVERABLE_FILENAME), executorLabel)
        } else {
          const observed = await readWorkflowRound({ cwd: agentStatePath, round: roundFiles, plan: workflow, label: executorLabel })
          deliverable = observed.deliverable
          roundAccumulator.claimVersions.push(observed.claimVersion)
        }
        if (deliverable.trim() === '') throw new Error(`${executorLabel}: 交付物为空`)
        const bytes = Buffer.byteLength(deliverable, 'utf8')
        if (bytes > MAX_DELIVERABLE_BYTES) {
          throw new Error(`${executorLabel}: 交付物为 ${bytes} 字节,超过上限 ${MAX_DELIVERABLE_BYTES};该交付物会被复制进每个维度的评估提示词`)
        }
        roundAccumulator.deliverableDigests.push(textDigest(deliverable))
        // 篇幅观测与评分并行记录:它不改分数,但要能回答「这份答复有多长」——
        // rubric 目前没有篇幅维度,长与短在读数上完全等价。
        roundAccumulator.concision.push(observeConcision(deliverable, budgetOf(caseId)))
        for (const accumulator of terminalAccumulators) {
          const scoreDir = isFirst
            ? join(base, `dim-${accumulator.dimension.index}`)
            : join(roundBase, `dim-${accumulator.dimension.index}`)
          await mkdir(scoreDir, { recursive: true })
          const evaluatorLabel = `${caseId} run ${run} 第 ${round} 轮维度 ${accumulator.dimension.index} 评估者`
          addUsage(await options.runAgents({
            cwd: scoreDir,
            prompt: evaluatorPrompt(roundText, accumulator.dimension, deliverable),
            label: evaluatorLabel,
          }))
          const score = parseScore(await readArtifact(join(scoreDir, SCORE_FILENAME), evaluatorLabel), evaluatorLabel)
          const roundScores = roundAccumulator.dimensions.get(accumulator.dimension.index)
          if (roundScores === undefined) throw new Error(`${caseId}: 第 ${round} 轮缺少维度 ${accumulator.dimension.index}`)
          roundScores.push(score)
          if (isTerminal) accumulator.scores.push(score)
        }
        previousAgentState = agentStatePath
      }
    }
    const rounds: RunRound[] = roundAccumulators.map(accumulator => ({
      round: accumulator.round,
      ...accumulator.statementDigest === undefined ? {} : { statementDigest: accumulator.statementDigest },
      dimensions: [...accumulator.dimensions].map(([index, scores]): RunRoundDimension => ({
        index,
        score: roundScore(mean(scores)),
        ...scores.length > 1 ? { scores: [...scores] } : {},
      })),
      deliverableDigests: [...accumulator.deliverableDigests],
      ...accumulator.claimVersions.length > 0 ? { claimVersions: [...accumulator.claimVersions] } : {},
      ...accumulator.concision.length > 0 ? { concision: [...accumulator.concision] } : {},
    }))
    cases.push({
      caseId,
      retrieval,
      dimensions: terminalAccumulators.map<RunDimension>(accumulator => ({
        index: accumulator.dimension.index,
        label: accumulator.dimension.label,
        points: accumulator.dimension.points,
        score: roundScore(mean(accumulator.scores)),
        ...accumulator.scores.length > 1 ? { scores: [...accumulator.scores] } : {},
      })),
      ...roundCount > 1 ? { rounds } : {},
      // 单轮 case 没有逐轮观测可挂,篇幅读数记在 case 上;多轮 case 只记逐轮那一份,
      // 否则同一份读数存两处,改的时候必然只改一处。
      ...roundCount === 1 && (roundAccumulators[0]?.concision.length ?? 0) > 0
        ? { concision: [...(roundAccumulators[0]?.concision ?? [])] }
        : {},
    })
  }
  const workflowId = plan.cases.find(entry => entry.workflow !== undefined)?.workflow?.manifestId
  const record: RunRecord = {
    benchmarkId: options.space.benchmarkId,
    recordedAt: options.recordedAt ?? new Date().toISOString(),
    execution: plan.execution,
    ...(workflowId === undefined ? {} : { workflowId }),
    runsPerCase: plan.runsPerCase,
    cases,
  }
  if (options.provider !== undefined) record.provider = options.provider
  if (options.modelId !== undefined) record.modelId = options.modelId
  const tokensComplete = usageTotals.calls > 0 && usageTotals.tokenCalls === usageTotals.calls
  if (tokensComplete) record.tokens = { input: usageTotals.input, output: usageTotals.output }
  if (usageTotals.calls > 0 && usageTotals.costCalls === usageTotals.calls) {
    record.cost = Math.round(usageTotals.cost * 1e6) / 1e6
  } else if (tokensComplete && options.pricing !== undefined) {
    // provider 没有直接报告成本时,用调用方给出的单价把完整的 token 合计换算成美元。
    const { inputPerMillion, outputPerMillion } = options.pricing
    record.cost = Math.round(
      (usageTotals.input / 1_000_000 * inputPerMillion + usageTotals.output / 1_000_000 * outputPerMillion) * 1e6,
    ) / 1e6
  }
  return record
}

/** 采集器的命令行选项。 */
export interface RunnerOptions {
  /** 目标 profile 名。 */
  profile: string
  /** 本次采集的被测面。 */
  execution: ExecutionSetting
  /** 只跑这些 case;空数组表示金标全集。重复给出只算一次。 */
  caseIds: string[]
  /** 每个 case 的运行次数。 */
  runs: number
  /** 追加的 `--patch` overlay 绝对路径;重复给出只算一次。 */
  patchPaths: string[]
  /** run 记录的写出路径。 */
  outPath: string
  /** 中间产物根目录。 */
  workDir: string
  /** 单次 agent 进程的墙钟上限(毫秒)。 */
  timeoutMs: number
  /** 整次采集的墙钟上限(毫秒);超出即以失败收尾,而不是无限烧下去。 */
  budgetMs: number
  /** 只打印计划、不做任何模型调用。 */
  dryRun: boolean
  /** 写进记录的 provider;缺省省略。 */
  provider?: string
  /** 写进记录的模型 id;缺省省略。 */
  modelId?: string
  /** token 单价;缺省只记录 tokens,不换算 cost。 */
  pricing?: RunPricing
}

/** 解析选项所需的路径上下文。 */
export interface RunnerPathContext {
  /** 仓库根绝对路径。 */
  root: string
  /** 解析相对路径的基准目录。 */
  cwd: string
  /** 给缺省输出目录命名的戳(如时间戳)。 */
  stamp: string
}

/** 读一个需要单值参数的开关。 */
function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (value === undefined) throw new Error(`${flag} 需要一个值`)
  return value
}

/** 读一个可重复的开关,按出现顺序去重(重复的同一取值不表达额外意图)。 */
function flagValues(args: readonly string[], flag: string): string[] {
  const values: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== flag) continue
    const value = args[index + 1]
    if (value === undefined) throw new Error(`${flag} 需要一个值`)
    if (!values.includes(value)) values.push(value)
  }
  return values
}

/**
 * 解析采集器命令行。
 *
 * 缺省的输出与工作目录落在 `.artifacts/patent-oas/<stamp>/`(该目录不进版本库),
 * 因为 run 记录是证据、日志与交付物是定位失败用的中间产物。
 *
 * `--execution workflow` 把缺省 `--runs` 降为 1:一次运行要把整份 manifest 的阶段跑完,
 * 3 次运行的调用量比提示词设置高一个量级以上。
 *
 * @param args 命令行参数(不含 node 与脚本路径)。
 * @param context 路径上下文。
 * @returns 归一化后的选项。
 */
export function parseRunnerOptions(args: readonly string[], context: RunnerPathContext): RunnerOptions {
  const runsText = flagValue(args, '--runs')
  const timeoutText = flagValue(args, '--timeout-ms')
  const budgetText = flagValue(args, '--budget-ms')
  const base = join(context.root, '.artifacts', 'patent-oas', context.stamp)
  const executionText = flagValue(args, '--execution')
  if (executionText !== undefined && executionText !== 'prompt' && executionText !== 'workflow') {
    throw new Error(`--execution 必须是 prompt 或 workflow,得到 ${executionText}`)
  }
  const execution: ExecutionSetting = executionText ?? 'prompt'
  const options: RunnerOptions = {
    profile: flagValue(args, '--profile') ?? 'headless',
    execution,
    caseIds: flagValues(args, '--case'),
    // 提示词设置按 B7 测量协议取 3 次运行做前后对比;工作流设置每次运行要跑完整 manifest 的阶段,缺省 1 次。
    runs: runsText === undefined ? (execution === 'workflow' ? 1 : 3) : Number(runsText),
    patchPaths: flagValues(args, '--patch').map(path => resolve(context.cwd, path)),
    outPath: resolve(context.cwd, flagValue(args, '--out') ?? join(base, 'run.json')),
    workDir: resolve(context.cwd, flagValue(args, '--work-dir') ?? join(base, 'work')),
    timeoutMs: timeoutText === undefined ? 600_000 : Number(timeoutText),
    budgetMs: budgetText === undefined ? 3_600_000 : Number(budgetText),
    dryRun: args.includes('--dry-run'),
  }
  if (!Number.isInteger(options.runs) || options.runs < 1) throw new Error(`--runs 必须是正整数,得到 ${String(runsText)}`)
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error(`--timeout-ms 必须是正数,得到 ${String(timeoutText)}`)
  if (!Number.isFinite(options.budgetMs) || options.budgetMs <= 0) throw new Error(`--budget-ms 必须是正数,得到 ${String(budgetText)}`)
  const provider = flagValue(args, '--provider')
  if (provider !== undefined) options.provider = provider
  const modelId = flagValue(args, '--model')
  if (modelId !== undefined) options.modelId = modelId
  const inputPriceText = flagValue(args, '--input-usd-per-mtok')
  const outputPriceText = flagValue(args, '--output-usd-per-mtok')
  if ((inputPriceText === undefined) !== (outputPriceText === undefined)) {
    throw new Error('--input-usd-per-mtok 与 --output-usd-per-mtok 必须同时给出')
  }
  if (inputPriceText !== undefined && outputPriceText !== undefined) {
    const inputPerMillion = Number(inputPriceText)
    const outputPerMillion = Number(outputPriceText)
    if (!Number.isFinite(inputPerMillion) || inputPerMillion < 0) {
      throw new Error(`--input-usd-per-mtok 必须是非负数,得到 ${inputPriceText}`)
    }
    if (!Number.isFinite(outputPerMillion) || outputPerMillion < 0) {
      throw new Error(`--output-usd-per-mtok 必须是非负数,得到 ${outputPriceText}`)
    }
    options.pricing = { inputPerMillion, outputPerMillion }
  }
  return options
}

/**
 * 列出可能声明模型凭据的 `.env` 路径:仓库根与 `$DSH_HOME`(缺省 `~/.dsh`)。
 *
 * @param root 仓库根绝对路径。
 * @param env 进程环境。
 * @returns 候选路径,按检查顺序。
 */
export function credentialEnvFiles(root: string, env: NodeJS.ProcessEnv): string[] {
  const dshHome = (env.DSH_HOME ?? '').trim()
  const home = dshHome === '' ? join(env.HOME ?? '', '.dsh') : dshHome
  return [join(root, '.env'), join(home, '.env')]
}

/**
 * 判断是否有可用的模型凭据信号:环境变量非空,或候选 `.env` 之一声明了该键。
 *
 * 只看信号,不作权威判断——权威在子进程:凭据真的不可用时子进程自己失败,而这里误判为
 * 「有」只是让脚本多跑一次失败的运行。
 *
 * @param env 进程环境。
 * @param envFilePaths 候选 `.env` 路径。
 * @returns 是否有凭据信号。
 */
export async function hasCredentialSignal(env: NodeJS.ProcessEnv, envFilePaths: readonly string[]): Promise<boolean> {
  if ((env.DEEPSEEK_API_KEY ?? '').trim() !== '') return true
  for (const path of envFilePaths) {
    try {
      await access(path)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (/^\s*DEEPSEEK_API_KEY\s*=\s*\S/mu.test(await readFile(path, 'utf8'))) return true
  }
  return false
}

/**
 * 写出 run 记录(JSON,末尾一个换行)。
 *
 * @param path 目标路径;父目录会被创建。
 * @param record 记录内容。
 */
export async function writeRunRecord(path: string, record: RunRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
}
