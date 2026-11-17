/**
 * `workbench_link_patent_case` tool: bridge a patent case directory into the
 * personal-workbench task tree over the workbench plugin's loopback HTTP API.
 * Idempotent: ensures the `patent_*` type dictionary entries, finds or creates
 * the root task (title = case number, `source='patent'`) plus the five L1–L5
 * stage subtasks, and projects `_matter-log.md` stage progress onto subtask
 * statuses. Never writes the case directory and never patches the root task's
 * status (the workbench PATCH cascade would then complete open subtasks).
 * @module @deepseek-ai/dsh-patent-tools/tool/workbench-link-patent-case
 */

import { readFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { PatentToolError } from '../error.ts'
import { listOrEmpty, namedLabel, recordFlag, recordString, recordText, textOrEmpty } from './internal/json-read.ts'

/** 工作台 API 是同机 loopback 服务；单次请求的固定上限（协议预算，不随部署变化）。 */
const WORKBENCH_REQUEST_TIMEOUT_MS = 15_000

/** The five patent pipeline stages, keyed by their short code. */
export type WorkbenchStage = 'l1' | 'l2' | 'l3' | 'l4' | 'l5'

/** Workbench task status codes the bridge projects onto. */
export type WorkbenchTaskStatusCode = 'todo' | 'doing' | 'done'

/** All stages in pipeline order. */
export const WORKBENCH_STAGES: readonly WorkbenchStage[] = ['l1', 'l2', 'l3', 'l4', 'l5']

/** Type dictionary code per stage. */
export const STAGE_TYPE_CODE: Record<WorkbenchStage, string> = {
  l1: 'patent_stage_l1',
  l2: 'patent_stage_l2',
  l3: 'patent_stage_l3',
  l4: 'patent_stage_l4',
  l5: 'patent_stage_l5',
}

/** Chinese stage name per stage, used as the subtask title. */
export const STAGE_NAME: Record<WorkbenchStage, string> = {
  l1: 'L1 交底书理解',
  l2: 'L2 现有技术检索',
  l3: 'L3 申请文件撰写',
  l4: 'L4 审查意见答复',
  l5: 'L5 无效与侵权',
}

/** The `type` dictionary entries the bridge ensures before creating tasks. */
export const PATENT_TYPE_DICTIONARIES = [
  { kind: 'type', code: 'patent_case', name: '专利案件', sortOrder: 5, config: { color: '#2980B9', defaultAiPolicy: 'execute' } },
  { kind: 'type', code: 'patent_stage_l1', name: 'L1 交底书理解', sortOrder: 51, config: { color: '#16A085', defaultAiPolicy: 'execute' } },
  { kind: 'type', code: 'patent_stage_l2', name: 'L2 现有技术检索', sortOrder: 52, config: { color: '#2980B9', defaultAiPolicy: 'execute' } },
  { kind: 'type', code: 'patent_stage_l3', name: 'L3 申请文件撰写', sortOrder: 53, config: { color: '#8E44AD', defaultAiPolicy: 'execute' } },
  { kind: 'type', code: 'patent_stage_l4', name: 'L4 审查意见答复', sortOrder: 54, config: { color: '#F39C12', defaultAiPolicy: 'execute' } },
  { kind: 'type', code: 'patent_stage_l5', name: 'L5 无效与侵权', sortOrder: 55, config: { color: '#E74C3C', defaultAiPolicy: 'execute' } },
] as const

/** Tool input: the case number plus optional overrides. */
export type WorkbenchLinkPatentCaseInput = {
  /** Case number; becomes the root task title and the case directory name. */
  caseNumber: string
  /** Case root directory override; defaults to the plugin-configured root. */
  caseRoot?: string
  /** Explicit stage statuses; when given they override the matter-log parse. */
  stages?: Array<{ stage: WorkbenchStage; statusCode: WorkbenchTaskStatusCode }>
  /** Compute the projection without writing anything. */
  dryRun?: boolean
}

/** Tool canonical result. */
export type WorkbenchLinkPatentCaseOutput = {
  /** Whether the link + projection completed. */
  ok: boolean
  /** The case number echoed back. */
  caseNumber: string
  /** Absolute case directory the bridge resolved. */
  caseDir: string
  /** Root task id in the workbench (empty string in dryRun when it does not exist yet). */
  rootTaskId: string
  /** Whether `_matter-log.md` was found and parsed. */
  matterLogFound: boolean
  /** Dictionary codes this call created (empty when all existed). */
  dictionariesEnsured: string[]
  /** Per-stage projection outcome, in pipeline order. */
  stages: Array<{
    stage: WorkbenchStage
    typeCode: string
    taskId: string | null
    /** Status after projection (wire vocabulary; null only in dryRun before creation). */
    statusCode: string | null
    created: boolean
    changed: boolean
  }>
  /** Dry-run marker (projection only, no writes). */
  dryRun?: boolean
  /** Fail-closed reason (only when ok is false). */
  error?: string
}

/** Injectable seams; production defaults talk HTTP and read the case dir. */
export interface WorkbenchLinkPatentCaseDeps {
  /** Workbench API base, e.g. `http://127.0.0.1:3080`; absent → setup failure. */
  baseUrl?: string
  /** Directory holding `<案号>/` case directories; required. */
  caseRoot: string
  /** JSON-over-HTTP seam (tests inject a stub). Must forward `init.signal` to its transport. */
  fetchJson?: (url: string, init?: { method?: string; body?: string; signal?: AbortSignal }) => Promise<{ status: number; json: unknown }>
  /** Matter-log reader seam returning the file text, or null when absent. */
  readMatterLog?: (caseDir: string) => Promise<string | null>
}

const DESCRIPTION = [
  '把专利案件目录桥接进个人工作台任务树（幂等）：确保 patent_* 类型字典项；找到或创建根任务（标题=案号，source=patent，workspace_path=案件目录）与 L1–L5 五个阶段子任务；读取案件目录的 _matter-log.md，把阶段进展投影为子任务状态。',
  '投影优先级：显式 stages 入参 > _matter-log 解析 > 保持现状。_matter-log 解析为行级启发式：一行同时含 L1–L5 阶段码与完成词（完成/通过/✅/已交付/归档）记 done，含进行词（进行/开始/推进/启动）记 doing，后行覆盖前行；一行多阶段共用该行判定。',
  '只经工作台 HTTP API 写任务；不写案件目录任何文件；不修改根任务状态（避免级联完成子任务）。工作台插件未挂载或 web 服务不可用时失败（setup_required）。dryRun 只算投影不写。',
].join('')

/**
 * Parse stage statuses out of an append-only matter log.
 * @param content - the `_matter-log.md` text.
 * @returns per-stage status; stages never mentioned are absent.
 */
export function parseMatterLogStages(content: string): Partial<Record<WorkbenchStage, WorkbenchTaskStatusCode>> {
  const result: Partial<Record<WorkbenchStage, WorkbenchTaskStatusCode>> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    const codes = new Set<WorkbenchStage>()
    for (const match of line.matchAll(/\bL([1-5])\b/g)) codes.add(`l${match[1]}` as WorkbenchStage)
    if (codes.size === 0) continue
    const status: WorkbenchTaskStatusCode = /完成|通过|✅|已交付|归档/.test(line)
      ? 'done'
      : /进行|开始|推进|启动/.test(line)
        ? 'doing'
        : 'todo'
    for (const code of codes) result[code] = status
  }
  return result
}

interface WireTask {
  id: string
  parentId: string | null
  title: string
  typeCode: string
  statusCode: string
  source: string
}

/** Read the matter log from the case directory; null when absent or unreadable as text. */
async function defaultReadMatterLog(caseDir: string): Promise<string | null> {
  try {
    return await readFile(join(caseDir, '_matter-log.md'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/** Validate one wire task row; throws on a malformed shape at this wire boundary. */
function expectTask(json: unknown, what: string): WireTask {
  if (typeof json !== 'object' || json === null) throw new PatentToolError('tool_execution_failed', `工作台返回的${what}不是对象`)
  const row = json as Record<string, unknown>
  if (typeof row.id !== 'string' || typeof row.title !== 'string' || typeof row.typeCode !== 'string' || typeof row.statusCode !== 'string') {
    throw new PatentToolError('tool_execution_failed', `工作台返回的${what}缺少 id/title/typeCode/statusCode 字段`)
  }
  return { id: row.id, parentId: typeof row.parentId === 'string' ? row.parentId : null, title: row.title, typeCode: row.typeCode, statusCode: row.statusCode, source: typeof row.source === 'string' ? row.source : '' }
}

/** Seams the factory resolves once: the workbench call path and the matter-log reader. */
type LinkSeams = {
  /** Workbench API base; absent → setup failure. */
  baseUrl?: string
  /** Directory holding `<案号>/` case directories. */
  caseRoot: string
  /** One workbench API call with the request deadline applied (see the factory's `call`). */
  call: <T>(signal: AbortSignal, path: string, init?: { method?: string; body?: unknown }, what?: string) => Promise<T>
  /** Matter-log reader seam. */
  readMatterLog: (caseDir: string) => Promise<string | null>
}

/** One link run: the validated input, the seams, and the caller's cancellation signal. */
type LinkRun = {
  input: WorkbenchLinkPatentCaseInput
  signal: AbortSignal
  /** Absolute case directory; also the root task's workspace path. */
  caseDir: string
  dryRun: boolean
  /** Explicit per-stage statuses; they take precedence over the matter-log parse. */
  explicit: Map<WorkbenchStage, WorkbenchTaskStatusCode>
  call: LinkSeams['call']
  readMatterLog: LinkSeams['readMatterLog']
}

/**
 * Validate the tool input and resolve the run. Every rejection happens before
 * the first workbench call.
 * @param args - raw tool arguments.
 * @param exec - tool execution context (cancellation signal).
 * @param seams - the factory's resolved seams.
 * @returns the run to execute.
 * @throws PatentToolError when the case number, base URL, or case root is unusable.
 */
function resolveLinkRun(args: unknown, exec: Pick<ToolRunContext, 'signal'>, seams: LinkSeams): LinkRun {
  // schema 校验后的模型 JSON 边界。
  const input = args as WorkbenchLinkPatentCaseInput
  if (input.caseNumber.trim() === '') {
    throw new PatentToolError('invalid_tool_input', 'caseNumber 不能为空')
  }
  // caseNumber 同时是案件目录名（也作为工作台 workspacePath）：必须是单段目录名。
  // 名称检查挡分隔符与 `.`/`..`；包含性检查是最终不变量，同时覆盖 Windows 盘符相对名（`C:案号`）。
  if (basename(input.caseNumber) !== input.caseNumber || input.caseNumber === '.' || input.caseNumber === '..'
    || input.caseNumber.includes('\\') || input.caseNumber.includes('\0')) {
    throw new PatentToolError('invalid_tool_input', `caseNumber 必须是单个案件目录名（不含路径分隔符）：${input.caseNumber}`)
  }
  if (seams.baseUrl === undefined) {
    throw new PatentToolError('setup_required', '工作台 API 基址不可用：web 服务未运行或未配置 workbenchBaseUrl（dsh web profile 内自动取本进程端口）')
  }
  const caseRoot = (input.caseRoot ?? seams.caseRoot).trim()
  if (caseRoot === '') {
    throw new PatentToolError('invalid_tool_input', 'caseRoot 不能为空（入参或插件配置 workbenchCaseRoot）')
  }
  const caseDir = join(caseRoot, input.caseNumber)
  const escaped = relative(caseRoot, caseDir)
  /* v8 ignore start -- caseNumber is a single directory name, so the join always stays under caseRoot */
  if (escaped.startsWith('..') || isAbsolute(escaped)) {
    throw new PatentToolError('invalid_tool_input', `caseNumber 越出案件根目录：${input.caseNumber}`)
  }
  /* v8 ignore stop */
  return {
    input,
    signal: exec.signal,
    caseDir,
    dryRun: input.dryRun === true,
    explicit: new Map((input.stages ?? []).map(s => [s.stage, s.statusCode])),
    call: seams.call,
    readMatterLog: seams.readMatterLog,
  }
}

/**
 * Ensure the `patent_*` type dictionary entries, creating only the missing ones.
 * @param run - the link run.
 * @returns the dictionary codes this call created (empty in dryRun).
 */
async function ensureTypeDictionaries(run: LinkRun): Promise<string[]> {
  // 1) 幂等确保 patent_* 类型字典项。
  const dictList = await run.call<{ ok?: boolean; dictionaries?: Array<{ code?: unknown }> }>(run.signal, '/api/workbench/dictionaries?kind=type', undefined, '字典列表')
  const existing = new Set((dictList.dictionaries ?? []).map(d => (typeof d.code === 'string' ? d.code : '')).filter(code => code !== ''))
  const dictionariesEnsured: string[] = []
  if (!run.dryRun) {
    for (const entry of PATENT_TYPE_DICTIONARIES) {
      if (existing.has(entry.code)) continue
      await run.call(run.signal, '/api/workbench/dictionaries', { method: 'POST', body: entry }, `字典创建 ${entry.code}`)
      dictionariesEnsured.push(entry.code)
    }
  }
  return dictionariesEnsured
}

/**
 * Fetch the full task list once and locate the case root task.
 * @param run - the link run.
 * @returns every task row and the root task when it already exists.
 */
async function loadWorkbenchTasks(run: LinkRun): Promise<{ tasks: WireTask[]; root: WireTask | null }> {
  // 2) 一次拉全量任务，找根任务与既有阶段子任务。
  const taskList = await run.call<{ ok?: boolean; tasks?: unknown[] }>(run.signal, '/api/workbench/tasks', undefined, '任务列表')
  const tasks = (taskList.tasks ?? []).map(row => expectTask(row, '任务行'))
  const root = tasks.find(t => t.parentId === null && t.title === run.input.caseNumber && t.source === 'patent') ?? null
  return { tasks, root }
}

/**
 * Create the case root task when it is missing. A dryRun keeps the empty marker
 * instead of creating it.
 * @param run - the link run.
 * @param root - the existing root task, if any.
 * @returns the root task id (empty only in dryRun without an existing root).
 */
async function ensureRootTask(run: LinkRun, root: WireTask | null): Promise<string> {
  // 3) 建根任务（dryRun 且不存在时保持空串标记）。
  let rootTaskId = root?.id ?? ''
  if (rootTaskId === '' && !run.dryRun) {
    const created = await run.call<{ task?: unknown }>(run.signal, '/api/workbench/tasks', {
      method: 'POST',
      body: {
        title: run.input.caseNumber,
        typeCode: 'patent_case',
        priorityCode: 'p2',
        aiPolicyCode: 'execute',
        source: 'patent',
        workspacePath: run.caseDir,
        extra: { patentCase: true },
      },
    }, '根任务创建')
    rootTaskId = expectTask(created.task, '新建根任务').id
  }
  return rootTaskId
}

/**
 * Project the resolved stage statuses onto the stage subtasks, creating the
 * missing ones. A stage is PATCHed only when its status actually changes.
 * @param run - the link run.
 * @param args - the root task id, the fetched task rows, and the matter-log parse.
 * @returns one row per stage, in pipeline order.
 */
async function projectStageStatuses(
  run: LinkRun,
  args: { rootTaskId: string; tasks: readonly WireTask[]; heuristic: Partial<Record<WorkbenchStage, WorkbenchTaskStatusCode>> },
): Promise<WorkbenchLinkPatentCaseOutput['stages']> {
  // 4) matter-log 投影（显式入参 > 启发式解析 > 保持现状）。
  const { rootTaskId, tasks, heuristic } = args
  const stages: WorkbenchLinkPatentCaseOutput['stages'] = []
  for (const stage of WORKBENCH_STAGES) {
    const typeCode = STAGE_TYPE_CODE[stage]
    const existingStage = rootTaskId === '' ? undefined : tasks.find(t => t.parentId === rootTaskId && t.typeCode === typeCode)
    let taskId = existingStage?.id ?? null
    let current: string | null = existingStage?.statusCode ?? null
    let created = false
    if (existingStage === undefined && !run.dryRun && rootTaskId !== '') {
      const target = run.explicit.get(stage) ?? heuristic[stage]
      const createdRow = await run.call<{ task?: unknown }>(run.signal, '/api/workbench/tasks', {
        method: 'POST',
        body: {
          title: STAGE_NAME[stage],
          typeCode,
          priorityCode: 'p2',
          aiPolicyCode: 'execute',
          source: 'patent',
          parentId: rootTaskId,
          extra: { patentStage: stage },
          ...(target === undefined ? {} : { statusCode: target }),
        },
      }, `阶段任务创建 ${stage}`)
      const newTask = expectTask(createdRow.task, `新建阶段任务 ${stage}`)
      taskId = newTask.id
      current = newTask.statusCode
      created = true
    }
    const target = run.explicit.get(stage) ?? heuristic[stage] ?? (current === null ? undefined : (current as WorkbenchTaskStatusCode))
    let changed = false
    if (!run.dryRun && taskId !== null && target !== undefined && target !== current) {
      await run.call(run.signal, `/api/workbench/tasks/${taskId}`, { method: 'PATCH', body: { statusCode: target } }, `阶段状态更新 ${stage}`)
      changed = true
    }
    stages.push({ stage, typeCode, taskId, statusCode: target ?? current, created, changed })
  }
  return stages
}

/**
 * Bridge one case into the workbench task tree: ensure the dictionaries, find or
 * create the root task and the five stage subtasks, then project the matter-log
 * progress. Writes go to the workbench API only.
 * @param args - raw tool arguments.
 * @param exec - tool execution context (cancellation signal).
 * @param seams - the factory's resolved seams.
 * @returns the link result.
 */
async function linkPatentCase(
  args: unknown,
  exec: Pick<ToolRunContext, 'signal'>,
  seams: LinkSeams,
): Promise<WorkbenchLinkPatentCaseOutput> {
  const run = resolveLinkRun(args, exec, seams)
  const dictionariesEnsured = await ensureTypeDictionaries(run)
  const { tasks, root } = await loadWorkbenchTasks(run)
  const rootTaskId = await ensureRootTask(run, root)
  const logContent = await run.readMatterLog(run.caseDir)
  const heuristic = logContent === null ? {} : parseMatterLogStages(logContent)
  const stages = await projectStageStatuses(run, { rootTaskId, tasks, heuristic })

  return {
    ok: true,
    caseNumber: run.input.caseNumber,
    caseDir: run.caseDir,
    rootTaskId,
    matterLogFound: logContent !== null,
    dictionariesEnsured,
    stages,
    ...(run.dryRun ? { dryRun: true } : {}),
  }
}

/**
 * Build the `workbench_link_patent_case` tool.
 * @param deps - base URL, case root, and the injectable HTTP / matter-log seams.
 * @returns a registry-ready tool definition.
 */
export function createWorkbenchLinkPatentCaseTool(deps: WorkbenchLinkPatentCaseDeps): ToolDefinition {
  const defaultFetchJson =
    async (url: string, init?: { method?: string; body?: string; signal?: AbortSignal }): Promise<{ status: number; json: unknown }> => {
      const response = await fetch(url, {
        method: init?.method ?? 'GET',
        ...(init?.body === undefined ? {} : { body: init.body, headers: { 'content-type': 'application/json' } }),
        /* v8 ignore next -- call() always composes a signal before invoking the transport */
        ...(init?.signal === undefined ? {} : { signal: init.signal }),
      })
      return { status: response.status, json: await response.json().catch(() => undefined) }
    }
  const fetchJson = deps.fetchJson ?? defaultFetchJson
  const readMatterLog = deps.readMatterLog ?? defaultReadMatterLog

  /**
   * 调一次工作台 API。每次请求都有期限：调用方取消与 15s 到点先到者胜，
   * 否则一条挂起的 loopback 连接会无限期占住这次工具调用。
   * @param signal - 调用方取消信号（`exec.signal`）。
   * @param path - API 路径（相对 `deps.baseUrl`）。
   * @param init - 方法与 JSON body。
   * @param what - 失败文案里的动作名。
   * @returns 响应的 JSON 载荷。
   * @throws PatentToolError 调用方取消（tool_aborted）、请求失败或非 2xx（tool_execution_failed）。
   */
  const call = async <T>(signal: AbortSignal, path: string, init?: { method?: string; body?: unknown }, what = path): Promise<T> => {
    const request = {
      ...(init?.method === undefined ? {} : { method: init.method }),
      ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(WORKBENCH_REQUEST_TIMEOUT_MS)]),
    }
    let response: { status: number; json: unknown }
    try {
      response = await fetchJson(`${deps.baseUrl}${path}`, request)
    } catch (error) {
      if (signal.aborted) throw new PatentToolError('tool_aborted', 'workbench_link_patent_case aborted')
      throw new PatentToolError('tool_execution_failed', `工作台 API ${what} 请求失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const { status, json } = response
    if (status < 200 || status >= 300) {
      const detail = typeof json === 'object' && json !== null && typeof (json as Record<string, unknown>).error === 'string'
        ? `: ${(json as Record<string, unknown>).error as string}`
        : ''
      throw new PatentToolError('tool_execution_failed', `工作台 API ${what} 返回 HTTP ${status}${detail}`)
    }
    return json as T
  }

  return defineTool({
    name: 'workbench_link_patent_case',
    description: DESCRIPTION,
    parameters: {
      caseNumber: { type: 'string', required: true, description: '案件编号（同时是案件目录名与根任务标题）。' },
      caseRoot: { type: 'string', description: '案件根目录覆盖（默认取插件配置 workbenchCaseRoot）。' },
      stages: {
        type: 'array',
        description: '显式阶段状态（可选，优先于 _matter-log 解析）。',
        items: { type: 'object', additionalProperties: true },
      },
      dryRun: { type: 'boolean', description: '只计算投影，不写入（默认 false）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          caseNumber: { type: 'string', required: true },
          caseDir: { type: 'string', required: true },
          rootTaskId: { type: 'string' },
          matterLogFound: { type: 'boolean', required: true },
          dictionariesEnsured: { type: 'array', items: { type: 'string' } },
          stages: { type: 'array' },
          dryRun: { type: 'boolean' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderLinkResult(value) }],
    },
    execute: (args, exec) => linkPatentCase(args, exec, {
      ...(deps.baseUrl === undefined ? {} : { baseUrl: deps.baseUrl }),
      caseRoot: deps.caseRoot,
      call,
      readMatterLog,
    }),
  })
}

/**
 * Render the canonical link result into model-facing prose.
 * @param value - the link result.
 * @returns the multi-line summary.
 */
export function renderLinkResult(value: WorkbenchLinkPatentCaseOutput | {
  ok: boolean
  error?: string
  caseNumber: string
  rootTaskId?: string
  matterLogFound: boolean
  dictionariesEnsured?: readonly string[]
  stages?: readonly unknown[]
  dryRun?: boolean
}): string {
  if (!value.ok) return `workbench_link_patent_case: ${value.error ?? '失败'}`
  const lines = listOrEmpty(value.stages).map((stage) => {
    const stageId = recordText(stage, 'stage')
    const status = recordString(stage, 'statusCode')
    return `- ${stageId} ${namedLabel(STAGE_NAME, stageId)}: ${status ?? '（无状态）'}${recordFlag(stage, 'created') ? '（新建）' : ''}${recordFlag(stage, 'changed') ? '（已同步）' : ''}`
  })
  const ensuredList = listOrEmpty(value.dictionariesEnsured)
  const ensured = ensuredList.length > 0 ? `新增字典: ${ensuredList.join(', ')}\n` : ''
  const rootTaskId = textOrEmpty(value.rootTaskId)
  return [
    `workbench_link_patent_case: 案件 ${value.caseNumber} → 根任务 ${rootTaskId === '' ? '（dryRun 未创建）' : rootTaskId}${value.dryRun === true ? ' [dryRun]' : ''}`,
    `${ensured}matter-log: ${value.matterLogFound ? '已解析' : '未找到'}`,
    ...lines,
  ].join('\n')
}
