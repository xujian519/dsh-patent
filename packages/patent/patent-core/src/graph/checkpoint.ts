/**
 * src/patent/graph — 检查点（移植自 Mady graph/checkpoint.go PregelCheckpointer）。
 *
 * 粒度 = 超步：每个超步开始前持久化 { state, activeNodes, stepIndex }，
 * 崩溃/中断后 loadLatest 恢复，从该超步继续。
 *
 * ⚠️ 超步粒度恢复会重放该超步内已完成的外部副作用调用（LLM/API）——
 * 假定节点幂等（同输入同输出），审批门场景下 LLM 节点在门之前，重放影响有限。
 */

import { basename } from 'node:path'
import { JsonFileStore, StoredRecordError, parseStoredJsonRecord } from '../persist-utils.ts'
import {
  isFiniteNumber,
  isJsonRecord,
  isNonEmptyStringArray,
  isNonNegativeInteger,
  readNonEmptyString,
} from '../llm-json.ts'
import { APPROVAL_GRANTED_NODES_KEY } from '../atoms/index.ts'
import type { CheckpointStore, GraphCheckpoint, GraphRunResult, GraphState, RunOptions } from './types.ts'
import { cloneState } from './state.ts'

/** 记录类型名：进入 StoredRecordError 的消息。 */
const CHECKPOINT_RECORD_KIND = 'checkpoint'

/**
 * 解析并校验一份持久化的检查点记录。
 *
 * 磁盘内容不满足 {@link GraphCheckpoint} 契约时抛 {@link StoredRecordError}。
 * 缺 `state` 的记录若被当作有效值返回，resume 时 `resumeFrom?.state ?? initial`
 * 会把缺失的状态静默换成初始状态，恢复变成无声重跑。
 *
 * `id` 必须等于文件名：`grantApproval` 用记录内的 `id` 回写，不一致时会覆盖另一条检查点。
 * @param raw - 文件原文。
 * @param file - 记录文件路径。
 * @returns 通过校验的检查点。
 */
function parseGraphCheckpoint(raw: string, file: string): GraphCheckpoint {
  const record = parseStoredJsonRecord(raw, file, CHECKPOINT_RECORD_KIND)
  const invalid = (detail: string): StoredRecordError =>
    new StoredRecordError(file, CHECKPOINT_RECORD_KIND, detail)
  const id = readNonEmptyString(record, 'id')
  if (id === undefined) throw invalid('id must be a non-empty string')
  const graphId = readNonEmptyString(record, 'graphId')
  if (graphId === undefined) throw invalid('graphId must be a non-empty string')
  const stepIndex = record['stepIndex']
  if (!isNonNegativeInteger(stepIndex)) throw invalid('stepIndex must be a non-negative integer')
  const state = record['state']
  if (!isJsonRecord(state)) throw invalid('state must be a JSON object')
  const activeNodes = record['activeNodes']
  if (!isNonEmptyStringArray(activeNodes)) throw invalid('activeNodes must be an array of non-empty strings')
  const createdAt = record['createdAt']
  if (!isFiniteNumber(createdAt)) throw invalid('createdAt must be a finite number')
  const fileId = basename(file, '.json')
  if (id !== fileId) throw invalid(`id ${JSON.stringify(id)} does not match file name ${JSON.stringify(fileId)}`)
  return { id, graphId, stepIndex, state, activeNodes, createdAt }
}

/** 内存检查点存储（默认；单进程内可用）。 */
export class InMemoryCheckpointStore implements CheckpointStore {
  private readonly checkpoints = new Map<string, GraphCheckpoint>()

  /** 返回克隆：调用方（resume/loadLatest）不应能通过引用改坏存储内状态。 */
  private cloneCheckpoint(cp: GraphCheckpoint): GraphCheckpoint {
    return { ...cp, state: cloneState(cp.state), activeNodes: [...cp.activeNodes] }
  }

  // oxlint-disable-next-line typescript/require-await -- CheckpointStore contract requires Promise methods
  async save(checkpoint: GraphCheckpoint): Promise<void> {
    this.checkpoints.set(checkpoint.id, this.cloneCheckpoint(checkpoint))
  }

  // oxlint-disable-next-line typescript/require-await -- CheckpointStore contract requires Promise methods
  async load(id: string): Promise<GraphCheckpoint | undefined> {
    const cp = this.checkpoints.get(id)
    return cp === undefined ? undefined : this.cloneCheckpoint(cp)
  }

  // oxlint-disable-next-line typescript/require-await -- CheckpointStore contract requires Promise methods
  async loadLatest(graphId: string): Promise<GraphCheckpoint | undefined> {
    const candidates = [...this.checkpoints.values()]
      .filter(cp => cp.graphId === graphId)
      .sort((a, b) => a.stepIndex - b.stepIndex || a.createdAt - b.createdAt)
    const cp = candidates.at(-1)
    return cp === undefined ? undefined : this.cloneCheckpoint(cp)
  }

  // oxlint-disable-next-line typescript/require-await -- CheckpointStore contract requires Promise methods
  async list(graphId: string): Promise<string[]> {
    return [...this.checkpoints.values()]
      .filter(cp => cp.graphId === graphId)
      .sort((a, b) => a.stepIndex - b.stepIndex || a.createdAt - b.createdAt)
      .map(cp => cp.id)
  }
}

/**
 * 每 id 一个 JSON 文件的检查点存储（复用 JsonFileStore 原子写）。
 *
 * 读取时逐字段校验并核对 `id` 与文件名；不满足契约的记录抛
 * {@link StoredRecordError}，不会作为有效检查点返回。
 */
export class JsonFileCheckpointStore implements CheckpointStore {
  private readonly store: JsonFileStore<GraphCheckpoint>

  constructor(dir: string) {
    this.store = new JsonFileStore<GraphCheckpoint>(dir, parseGraphCheckpoint, 'checkpointId')
  }

  async save(checkpoint: GraphCheckpoint): Promise<void> {
    await this.store.save(checkpoint.id, checkpoint)
  }

  async load(id: string): Promise<GraphCheckpoint | undefined> {
    return this.store.load(id)
  }

  async loadLatest(graphId: string): Promise<GraphCheckpoint | undefined> {
    const ids = await this.list(graphId)
    const last = ids.at(-1)
    if (last === undefined) return undefined
    return this.store.load(last)
  }

  async list(graphId: string): Promise<string[]> {
    const ids = await this.store.listIds()
    const matches: Array<{ id: string; stepIndex: number; createdAt: number }> = []
    for (const id of ids) {
      const cp = await this.store.load(id)
      if (cp?.graphId === graphId) matches.push({ id, stepIndex: cp.stepIndex, createdAt: cp.createdAt })
    }
    return matches.sort((a, b) => a.stepIndex - b.stepIndex || a.createdAt - b.createdAt).map(m => m.id)
  }
}

/** 带检查点的运行选项。 */
export type CheckpointedRunOptions = RunOptions & {
  store: CheckpointStore
  graphId: string
  /** 非空时从该检查点恢复（resume），否则从头运行。 */
  resumeFrom?: GraphCheckpoint
}

/** 带检查点的运行结果。 */
export type CheckpointedRunResult = {
  result: GraphRunResult
  /**
   * 最后一个保存的检查点 id：在**最后超步开始前**保存（state 为该超步起点，
   * 不含该超步合并结果）。中断后可 resume；完成时续跑会重放最后超步（幂等前提）。
   */
  checkpointId?: string
}

/**
 * 人工批准审批门：把**被批准的门节点 id 集合**（= 本检查点的 `activeNodes`，即正在等待的
 * 那道门）写入检查点 state 并持久化，返回更新后的检查点。调用方用返回值 resume——
 * 审批门节点重放时经 `isGateApproved(state, nodeName)` 判定自己已获批，把放行标记注入
 * handler **执行态**并放行（不再中断），后续节点继续执行。
 * 幂等：重复批准同一检查点无副作用。检查点不存在时返回 undefined。
 *
 * ⚠️ 放行是**门粒度**的：只放行该检查点正在等待的门。批准一个非门检查点
 * （`activeNodes` 里没有审批门）不会放行任何门——resume 后仍会在门处暂停
 * （fail-closed，绝不静默放行）。历史形态是往 state 写全局布尔
 * `APPROVAL_GRANTED_KEY=true`，那会让一次批准放行同 run 内**后续所有**门
 * （详见 `atoms/handlers/builtin/gate.ts` 的 `APPROVAL_GRANTED_NODES_KEY` 说明）。
 * @param store - 检查点存储。
 * @param checkpointId - 要批准的检查点 id。
 * @returns 更新后的检查点；检查点不存在时返回 undefined。
 */
export async function grantApproval(
  store: CheckpointStore,
  checkpointId: string,
): Promise<GraphCheckpoint | undefined> {
  const cp = await store.load(checkpointId)
  if (cp === undefined) return undefined
  cp.state[APPROVAL_GRANTED_NODES_KEY] = [...cp.activeNodes]
  await store.save(cp)
  return cp
}

/**
 * 带检查点的图运行：每超步开始前保存 checkpoint。
 * resumeFrom 提供时从该检查点继续（等价"断点续跑"）。
 * 返回最后一个 checkpoint id 供中断后 resume。
 * @param graph - 支持 run/resume 的图。
 * @param initial - 初始图状态。
 * @param opts - 带检查点的运行选项。
 * @returns 图运行结果与最后一个检查点 id。
 */
export async function runGraphWithCheckpoints(
  graph: {
    run(initial: GraphState, opts?: RunOptions): Promise<GraphRunResult>
    resume(checkpoint: GraphCheckpoint, opts?: RunOptions): Promise<GraphRunResult>
  },
  initial: GraphState,
  opts: CheckpointedRunOptions,
): Promise<CheckpointedRunResult> {
  let lastCheckpointId: string | undefined

  const checkpointingOpts: RunOptions = {
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts.failFast !== undefined ? { failFast: opts.failFast } : {}),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    onSuperStepStart: async (step, activeNodes, state) => {
      await opts.onSuperStepStart?.(step, activeNodes, state)
      const checkpoint: GraphCheckpoint = {
        id: `${opts.graphId}-${step}`,
        graphId: opts.graphId,
        stepIndex: step,
        state: cloneState(state),
        activeNodes: [...activeNodes],
        createdAt: Date.now(),
      }
      await opts.store.save(checkpoint)
      lastCheckpointId = checkpoint.id
    },
  }

  const result = opts.resumeFrom
    ? await graph.resume(opts.resumeFrom, checkpointingOpts)
    : await graph.run(initial, checkpointingOpts)

  return { result, ...(lastCheckpointId !== undefined ? { checkpointId: lastCheckpointId } : {}) }
}
