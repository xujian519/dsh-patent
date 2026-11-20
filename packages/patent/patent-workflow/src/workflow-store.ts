/**
 * WorkflowRun 持久化后端（对齐 Sati src/workflow/persistence/WorkflowPlanStore
 * 的 save/load/list 三接口，持久化对象为 patent 域的 WorkflowRunResult）。
 *
 * - InMemoryWorkflowRunStore：内存 Map，适合测试与单次运行上下文
 * - JsonFileWorkflowRunStore：每 run 一个 JSON 文件（<dir>/<runId>.json），
 *   底层复用 JsonFileStore
 *
 * runId 缺省用 manifestId；同一 manifest 的多次独立运行或中断续跑请显式传
 * 不同 runId，否则后写覆盖前写。工具层续跑会派生新 runId，保留中断记录。
 */

import {
  JsonFileStore,
  StoredRecordError,
  isJsonRecord,
  isNonEmptyStringArray,
  isNonNegativeInteger,
  isWorkflowEvidenceSource,
  isWorkflowStrategy,
  parseStoredJsonRecord,
  readNonEmptyString,
  readOptionalNonEmptyString,
  validateRevisionLog,
} from '@deepseek-ai/dsh-patent-core'
import type {
  RevisionRecord,
  WorkflowEvidenceLedger,
  WorkflowEvidenceReceipt,
  WorkflowInterrupt,
  WorkflowRunRecovery,
  WorkflowRunResult,
  WorkflowRunStore,
  WorkflowStageResult,
} from '@deepseek-ai/dsh-patent-core'

/** 记录类型名：进入 StoredRecordError 的消息。 */
const RUN_RECORD_KIND = 'run'

/** 构造带文件来源的结构错误；调用方用 `throw invalid(...)` 保持控制流终止。 */
type Invalid = (detail: string) => StoredRecordError

/** 读取可选的非空字符串数组；缺失返回 undefined，给出但形状不符返回 null。 */
function optionalStringArray(record: Record<string, unknown>, key: string): string[] | undefined | null {
  const value = record[key]
  if (value === undefined) return undefined
  return isNonEmptyStringArray(value) ? value : null
}

/** 读取字符串值对象；含非字符串值时返回 undefined。 */
function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isJsonRecord(value)) return undefined
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') return undefined
    result[key] = entry
  }
  return result
}

/** 校验并构造一条阶段结果。 */
function parseStageResult(value: unknown, where: string, invalid: Invalid): WorkflowStageResult {
  if (!isJsonRecord(value)) throw invalid(`${where} must be a JSON object`)
  const stageId = readNonEmptyString(value, 'stageId')
  if (stageId === undefined) throw invalid(`${where}.stageId must be a non-empty string`)
  const strategy = value['strategy']
  if (!isWorkflowStrategy(strategy)) throw invalid(`${where}.strategy must be chain / react / sub_agent`)
  const output = value['output']
  if (typeof output !== 'string') throw invalid(`${where}.output must be a string`)
  const degraded = value['degraded']
  if (typeof degraded !== 'boolean') throw invalid(`${where}.degraded must be a boolean`)
  const retries = value['retries']
  if (!isNonNegativeInteger(retries)) throw invalid(`${where}.retries must be a non-negative integer`)
  const atom = readOptionalNonEmptyString(value, 'atom')
  if (atom === null) throw invalid(`${where}.atom must be a non-empty string`)
  const inputScope = optionalStringArray(value, 'inputScope')
  if (inputScope === null) throw invalid(`${where}.inputScope must be an array of non-empty strings`)
  return {
    stageId,
    strategy,
    output,
    degraded,
    retries,
    ...(atom !== undefined ? { atom } : {}),
    ...(inputScope !== undefined ? { inputScope } : {}),
  }
}

/** 校验并构造中断信息。 */
function parseInterrupt(value: unknown, invalid: Invalid): WorkflowInterrupt {
  if (!isJsonRecord(value)) throw invalid('interrupted must be a JSON object')
  const stageId = readNonEmptyString(value, 'stageId')
  if (stageId === undefined) throw invalid('interrupted.stageId must be a non-empty string')
  const message = readNonEmptyString(value, 'message')
  if (message === undefined) throw invalid('interrupted.message must be a non-empty string')
  const data = value['data']
  if (!isJsonRecord(data)) throw invalid('interrupted.data must be a JSON object')
  return { stageId, message, data }
}

/** 校验并构造一条证据收据。 */
function parseEvidenceReceipt(value: unknown, where: string, invalid: Invalid): WorkflowEvidenceReceipt {
  if (!isJsonRecord(value)) throw invalid(`${where} must be a JSON object`)
  const toolCallId = readNonEmptyString(value, 'toolCallId')
  if (toolCallId === undefined) throw invalid(`${where}.toolCallId must be a non-empty string`)
  const turnId = readNonEmptyString(value, 'turnId')
  if (turnId === undefined) throw invalid(`${where}.turnId must be a non-empty string`)
  const toolName = readNonEmptyString(value, 'toolName')
  if (toolName === undefined) throw invalid(`${where}.toolName must be a non-empty string`)
  const args = stringRecord(value['args'])
  if (args === undefined) throw invalid(`${where}.args must be an object of strings`)
  const success = value['success']
  if (typeof success !== 'boolean') throw invalid(`${where}.success must be a boolean`)
  const write = value['write']
  if (typeof write !== 'boolean') throw invalid(`${where}.write must be a boolean`)
  const citationId = readNonEmptyString(value, 'citationId')
  if (citationId === undefined) throw invalid(`${where}.citationId must be a non-empty string`)
  const source = value['source']
  if (!isWorkflowEvidenceSource(source)) throw invalid(`${where}.source must be a declared evidence source`)
  const path = readOptionalNonEmptyString(value, 'path')
  if (path === null) throw invalid(`${where}.path must be a non-empty string`)
  const resultText = readOptionalNonEmptyString(value, 'resultText')
  if (resultText === null) throw invalid(`${where}.resultText must be a non-empty string`)
  const title = readOptionalNonEmptyString(value, 'title')
  if (title === null) throw invalid(`${where}.title must be a non-empty string`)
  const publicationDate = readOptionalNonEmptyString(value, 'publicationDate')
  if (publicationDate === null) throw invalid(`${where}.publicationDate must be a non-empty string`)
  // 旧版 FNV 哈希也是合法字符串：内容哈希算法不属于记录格式契约。
  const contentHash = readOptionalNonEmptyString(value, 'contentHash')
  if (contentHash === null) throw invalid(`${where}.contentHash must be a non-empty string`)
  return {
    toolCallId,
    turnId,
    toolName,
    args,
    success,
    write,
    citationId,
    source,
    ...(path !== undefined ? { path } : {}),
    ...(resultText !== undefined ? { resultText } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(publicationDate !== undefined ? { publicationDate } : {}),
    ...(contentHash !== undefined ? { contentHash } : {}),
  }
}

/** 校验并构造证据账本。 */
function parseEvidenceLedger(value: unknown, invalid: Invalid): WorkflowEvidenceLedger {
  if (!isJsonRecord(value)) throw invalid('evidenceLedger must be a JSON object')
  const rawReceipts = value['receipts']
  if (!Array.isArray(rawReceipts)) throw invalid('evidenceLedger.receipts must be an array')
  const receipts = rawReceipts.map((entry, index) =>
    parseEvidenceReceipt(entry, `evidenceLedger.receipts[${index}]`, invalid),
  )
  const digest = readNonEmptyString(value, 'digest')
  if (digest === undefined) throw invalid('evidenceLedger.digest must be a non-empty string')
  const incomplete = value['incomplete']
  if (incomplete !== undefined && typeof incomplete !== 'boolean') {
    throw invalid('evidenceLedger.incomplete must be a boolean')
  }
  return { receipts, digest, ...(incomplete !== undefined ? { incomplete } : {}) }
}

/** 校验并构造中断恢复点。 */
function parseRecovery(value: unknown, invalid: Invalid): WorkflowRunRecovery {
  if (!isJsonRecord(value)) throw invalid('recovery must be a JSON object')
  const nextStageIndex = value['nextStageIndex']
  if (!isNonNegativeInteger(nextStageIndex)) throw invalid('recovery.nextStageIndex must be a non-negative integer')
  const state = value['state']
  if (!isJsonRecord(state)) throw invalid('recovery.state must be a JSON object')
  const rawRewindCounts = value['rewindCounts']
  if (!isJsonRecord(rawRewindCounts)) throw invalid('recovery.rewindCounts must be a JSON object')
  const rewindCounts: Record<string, number> = {}
  for (const [stageId, count] of Object.entries(rawRewindCounts)) {
    if (!isNonNegativeInteger(count)) throw invalid('recovery.rewindCounts values must be non-negative integers')
    rewindCounts[stageId] = count
  }
  const pending = validateRevisionLog(value['pendingRevisions'])
  if (!pending.ok) throw invalid(`recovery.pendingRevisions: ${pending.reason}`)
  return { nextStageIndex, state, rewindCounts, pendingRevisions: pending.value }
}

/**
 * 解析并校验一份持久化的运行结果记录。
 *
 * 磁盘内容不满足 {@link WorkflowRunResult} 契约时抛 {@link StoredRecordError}。
 * 空 `output` / 空 `summary` / 空 `stages` + `interrupted` 都是合法产品输出，
 * 校验只拒绝形状不符的记录。
 * @param raw - 文件原文。
 * @param file - 记录文件路径。
 * @returns 通过校验的运行结果。
 */
export function parseWorkflowRunResult(raw: string, file: string): WorkflowRunResult {
  const record = parseStoredJsonRecord(raw, file, RUN_RECORD_KIND)
  const invalid: Invalid = detail => new StoredRecordError(file, RUN_RECORD_KIND, detail)

  const manifestId = readNonEmptyString(record, 'manifestId')
  if (manifestId === undefined) throw invalid('manifestId must be a non-empty string')
  const caseType = readNonEmptyString(record, 'caseType')
  if (caseType === undefined) throw invalid('caseType must be a non-empty string')
  const completed = record['completed']
  if (typeof completed !== 'boolean') throw invalid('completed must be a boolean')

  const rawStages = record['stages']
  if (!Array.isArray(rawStages)) throw invalid('stages must be an array')
  const stages = rawStages.map((entry, index) => parseStageResult(entry, `stages[${index}]`, invalid))

  const degradedSteps = record['degradedSteps']
  if (!isNonEmptyStringArray(degradedSteps)) throw invalid('degradedSteps must be an array of non-empty strings')
  const summary = record['summary']
  if (typeof summary !== 'string') throw invalid('summary must be a string')

  const rawInterrupted = record['interrupted']
  const interrupted = rawInterrupted === undefined ? undefined : parseInterrupt(rawInterrupted, invalid)
  const rawRecovery = record['recovery']
  const recovery = rawRecovery === undefined ? undefined : parseRecovery(rawRecovery, invalid)

  const persistWarning = readOptionalNonEmptyString(record, 'persistWarning')
  if (persistWarning === null) throw invalid('persistWarning must be a non-empty string')

  const rawLedger = record['evidenceLedger']
  const evidenceLedger = rawLedger === undefined ? undefined : parseEvidenceLedger(rawLedger, invalid)

  const rawRevisions = record['revisions']
  let revisions: RevisionRecord[] | undefined
  if (rawRevisions !== undefined) {
    const result = validateRevisionLog(rawRevisions)
    if (!result.ok) throw invalid(`revisions: ${result.reason}`)
    revisions = result.value
  }
  const revisionsTruncated = record['revisionsTruncated']
  if (revisionsTruncated !== undefined && typeof revisionsTruncated !== 'boolean') {
    throw invalid('revisionsTruncated must be a boolean')
  }

  return {
    manifestId,
    caseType,
    completed,
    stages,
    degradedSteps,
    summary,
    ...(interrupted !== undefined ? { interrupted } : {}),
    ...(recovery !== undefined ? { recovery } : {}),
    ...(persistWarning !== undefined ? { persistWarning } : {}),
    ...(evidenceLedger !== undefined ? { evidenceLedger } : {}),
    ...(revisions !== undefined ? { revisions } : {}),
    ...(revisionsTruncated !== undefined ? { revisionsTruncated } : {}),
  }
}

/** 内存存储——适合测试与单次运行上下文。 */
export class InMemoryWorkflowRunStore implements WorkflowRunStore {
  private readonly runs = new Map<string, WorkflowRunResult>()

  /** 保存一次运行结果；runId 缺省为 manifestId（同 runId 重跑覆盖上次记录）。 */
  // oxlint-disable-next-line typescript/require-await -- WorkflowRunStore 契约与调用方 await 约定要求 Promise 返回，实现为同步 Map 写入
  async saveRun(result: WorkflowRunResult, runId?: string): Promise<void> {
    this.runs.set(runId ?? result.manifestId, structuredClone(result))
  }

  /** 按 runId 加载运行结果。@returns 运行结果；不存在时为 undefined。 */
  // oxlint-disable-next-line typescript/require-await -- WorkflowRunStore 契约与调用方 await 约定要求 Promise 返回，实现为同步 Map 读取
  async loadRun(runId: string): Promise<WorkflowRunResult | undefined> {
    const run = this.runs.get(runId)
    return run ? structuredClone(run) : undefined
  }

  /** 列出全部已保存的运行 ID。@returns 运行 ID 列表。 */
  // oxlint-disable-next-line typescript/require-await -- WorkflowRunStore 契约与调用方 await 约定要求 Promise 返回，实现为同步 Map 键枚举
  async listRuns(): Promise<string[]> {
    return [...this.runs.keys()]
  }
}

/**
 * JSON 文件存储——每 run 一个文件，位于同一目录下。
 *
 * 读取时逐字段校验（含阶段、中断、证据账本与回退留痕）；不满足契约的记录抛
 * `StoredRecordError`，不会作为有效运行结果返回。
 */
export class JsonFileWorkflowRunStore implements WorkflowRunStore {
  private readonly store: JsonFileStore<WorkflowRunResult>

  constructor(dir: string) {
    this.store = new JsonFileStore(dir, parseWorkflowRunResult, 'runId')
  }

  /** 保存一次运行结果；runId 缺省为 manifestId（同 runId 重跑覆盖上次记录）。 */
  async saveRun(result: WorkflowRunResult, runId?: string): Promise<void> {
    await this.store.save(runId ?? result.manifestId, result)
  }

  /** 按 runId 加载运行结果。@returns 运行结果；不存在时为 undefined。 */
  async loadRun(runId: string): Promise<WorkflowRunResult | undefined> {
    return this.store.load(runId)
  }

  /** 列出全部已保存的运行 ID。@returns 运行 ID 列表。 */
  async listRuns(): Promise<string[]> {
    return this.store.listIds()
  }
}
