/**
 * Studio reads over the Session's `workspaceFiles` Remote: the project
 * document, its budget ledger, and its in-flight task journal. The Host owns
 * the durable validation; these parsers narrow the same files for display and
 * report a document the studio cannot render rather than showing half of it.
 */
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceByteReadOptions, WorkspaceFileBytes, WorkspaceFileStat } from '@deepseek-ai/dsh-api-workspace-files/types'
import { isRecord } from '@deepseek-ai/dsh-value'

/** Journal file beside the project document; mirrors the Host's constant. */
export const TASKS_FILE = 'tasks.json'

/** Ledger file beside the project document; mirrors the Host's constant. */
export const LEDGER_FILE = 'budget.json'

/** Shot states the Host stores. */
const SHOT_STATUSES = ['draft', 'ready', 'generating', 'failed'] as const

/** In-flight task states the journal keeps. */
const PENDING_STATUSES = ['queued', 'submitted', 'running'] as const

/** One shot as the studio displays it. */
export interface StudioShot {
  readonly id: string
  readonly index: number
  readonly prompt: string
  readonly durationSec: number
  readonly status: (typeof SHOT_STATUSES)[number]
  readonly keyframePath?: string
  readonly clipPath?: string
  readonly provider?: string
  readonly model?: string
  readonly costCny?: number
}

/** One recorded render. */
interface StudioRender {
  readonly id: string
  readonly path: string
  readonly durationSec?: number
  readonly costCny?: number
  readonly createdAt: string
}

/** One journaled generation that has not settled. */
interface StudioTask {
  readonly id: string
  readonly provider: string
  readonly model: string
  readonly kind: string
  readonly status: (typeof PENDING_STATUSES)[number]
  readonly submittedAt: number
  readonly outputPath: string
}

/** One media path with the metadata the preview URL needs. */
export interface StudioMedia {
  /** Path as the project declared it, for display. */
  readonly path: string
  /** `image` or `video`, from the suffix. */
  readonly kind: 'image' | 'video'
  /** Present when the Host stat succeeded; absent means the file is missing. */
  readonly absolutePath?: string
  /** File version token paired with the URL. */
  readonly version?: string
}

/** One production the studio renders. */
export interface StudioProject {
  /** Absolute project file path. */
  readonly path: string
  readonly id: string
  readonly title: string
  readonly aspect: string
  readonly targetSeconds: number
  readonly budgetCny: number
  readonly updatedAt: string
  readonly shots: readonly StudioShot[]
  readonly renders: readonly StudioRender[]
  /** Larger of the selected-shot costs and the settled ledger, in CNY. */
  readonly spentCny: number
  /** Settled ledger total as recorded. */
  readonly ledgerCny: number
  readonly tasks: readonly StudioTask[]
  /** Distinct keyframes, clips, and renders with their stat metadata. */
  readonly media: readonly StudioMedia[]
}

/** A read the studio must report instead of rendering the project. */
export class StudioReadError extends Error {
  /**
   * @param message - the Host's message, or a local parsing note.
   * @param code - `missing` for an absent project, `invalid` for unparseable files, `read` for everything else.
   */
  constructor(message: string, readonly code: 'missing' | 'invalid' | 'read') {
    super(message)
    this.name = 'StudioReadError'
  }
}

/** The slice of the Client Remote these reads call. */
export interface StudioRemote {
  /**
   * Read one complete workspace file under the Host's full-file cap.
   * @param sessionId - the session whose workspace resolves the path.
   * @param path - absolute or workspace-relative path.
   * @param options - an empty object reads the complete file.
   * @param signal - cancels the call.
   * @returns the bytes, or the Host's failure.
   */
  readBytes(
    sessionId: SessionId,
    path: string,
    options: WorkspaceByteReadOptions,
    signal?: AbortSignal,
  ): Promise<RemoteResult<WorkspaceFileBytes>>
  /**
   * Read one file's current metadata.
   * @param sessionId - the session whose workspace resolves the path.
   * @param path - absolute or workspace-relative path.
   * @param signal - cancels the call.
   * @returns absolute path and version, or the Host's failure.
   */
  stat(
    sessionId: SessionId,
    path: string,
    signal?: AbortSignal,
  ): Promise<RemoteResult<WorkspaceFileStat>>
}

/** The two files the Host keeps beside `project.json`. */
interface StoreFiles {
  readonly ledger: string
  readonly tasks: string
}

/**
 * Derive the ledger and journal paths beside one project file without Node's path module.
 * @param projectPath - absolute project file path.
 * @returns sibling file paths.
 */
export function storeFilesOf(projectPath: string): StoreFiles {
  const separator = Math.max(projectPath.lastIndexOf('/'), projectPath.lastIndexOf('\\'))
  const directory = separator < 0 ? '' : projectPath.slice(0, separator)
  return { ledger: `${directory}/${LEDGER_FILE}`, tasks: `${directory}/${TASKS_FILE}` }
}

/**
 * Classify a media path by its suffix.
 * @param path - declared keyframe, clip, or render path.
 * @returns `image`, `video`, or undefined for a suffix the studio cannot preview.
 */
export function mediaKindOf(path: string): 'image' | 'video' | undefined {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1).toLowerCase()
  const dot = name.lastIndexOf('.')
  if (dot < 0) return undefined
  const suffix = name.slice(dot + 1)
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'].includes(suffix)) return 'image'
  if (['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(suffix)) return 'video'
  return undefined
}

function textOf(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new StudioReadError('project file is not valid UTF-8', 'invalid')
  }
}

function jsonOf(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(textOf(bytes))
  } catch (error) {
    if (error instanceof StudioReadError) throw error
    throw new StudioReadError('project file is not valid JSON', 'invalid')
  }
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function shotOf(value: unknown): StudioShot {
  if (!isRecord(value)) throw new StudioReadError('shot entry is not an object', 'invalid')
  const status = value.status
  if (!SHOT_STATUSES.some(candidate => candidate === status)) {
    throw new StudioReadError(`unknown shot status ${String(status)}`, 'invalid')
  }
  if (typeof value.id !== 'string' || value.id.length === 0 || typeof value.prompt !== 'string'
    || typeof value.index !== 'number' || !Number.isInteger(value.index)
    || !positive(value.durationSec)) {
    throw new StudioReadError('shot entry is missing required fields', 'invalid')
  }
  const keyframePath = optionalString(value.keyframePath)
  const clipPath = optionalString(value.clipPath)
  const provider = optionalString(value.provider)
  const model = optionalString(value.model)
  return {
    id: value.id,
    index: value.index,
    prompt: value.prompt,
    durationSec: value.durationSec,
    status: status as StudioShot['status'],
    ...keyframePath === undefined ? {} : { keyframePath },
    ...clipPath === undefined ? {} : { clipPath },
    ...provider === undefined ? {} : { provider },
    ...model === undefined ? {} : { model },
    ...nonnegative(value.costCny) ? { costCny: value.costCny } : {},
  }
}

function renderOf(value: unknown): StudioRender {
  if (!isRecord(value)) throw new StudioReadError('render entry is not an object', 'invalid')
  if (typeof value.id !== 'string' || value.id.length === 0 || typeof value.path !== 'string'
    || value.path.length === 0 || typeof value.createdAt !== 'string' || value.createdAt.length === 0) {
    throw new StudioReadError('render entry is missing required fields', 'invalid')
  }
  return {
    id: value.id,
    path: value.path,
    createdAt: value.createdAt,
    ...positive(value.durationSec) ? { durationSec: value.durationSec } : {},
    ...nonnegative(value.costCny) ? { costCny: value.costCny } : {},
  }
}

/** The validated fields of one project document the studio displays. */
interface ParsedProject {
  readonly id: string
  readonly title: string
  readonly aspect: string
  readonly targetSeconds: number
  readonly budgetCny: number
  readonly updatedAt: string
  readonly shots: readonly StudioShot[]
  readonly renders: readonly StudioRender[]
}

/**
 * Validate the project document fields the board renders.
 * @param value - parsed JSON.
 * @returns the display fields in document order.
 * @throws {@link StudioReadError} `invalid` when a rendered field is malformed.
 */
export function parseProjectDocument(value: unknown): ParsedProject {
  if (!isRecord(value)) throw new StudioReadError('project document is not an object', 'invalid')
  if (typeof value.id !== 'string' || value.id.length === 0 || typeof value.title !== 'string'
    || typeof value.aspect !== 'string' || !positive(value.targetSeconds)
    || !nonnegative(value.budgetCny) || typeof value.updatedAt !== 'string'
    || !Array.isArray(value.shots) || !Array.isArray(value.renders)) {
    throw new StudioReadError('project document is missing required fields', 'invalid')
  }
  return {
    id: value.id,
    title: value.title,
    aspect: value.aspect,
    targetSeconds: value.targetSeconds,
    budgetCny: value.budgetCny,
    updatedAt: value.updatedAt,
    shots: value.shots.map(shotOf).sort((left, right) => left.index - right.index),
    renders: value.renders.map(renderOf),
  }
}

/**
 * Sum a ledger by task id in fen, so two entries for one task count once.
 * @param value - parsed ledger JSON; a malformed document reads as zero.
 * @returns the settled CNY total.
 */
export function parseLedgerTotal(value: unknown): number {
  if (!isRecord(value) || !Array.isArray(value.entries)) return 0
  const seen = new Set<string>()
  let fen = 0
  for (const entry of value.entries) {
    if (!isRecord(entry) || typeof entry.taskId !== 'string' || !nonnegative(entry.costCny)) continue
    if (seen.has(entry.taskId)) continue
    seen.add(entry.taskId)
    fen += Math.round(entry.costCny * 100)
  }
  return fen / 100
}

/**
 * List non-terminal journal records.
 * @param value - parsed journal JSON; a malformed document reads as empty.
 * @returns pending tasks in journal order.
 */
export function parsePendingTasks(value: unknown): StudioTask[] {
  if (!isRecord(value) || !Array.isArray(value.tasks)) return []
  const tasks: StudioTask[] = []
  for (const record of value.tasks) {
    if (!isRecord(record) || !isRecord(record.task)) continue
    const task = record.task
    const status = task.status
    if (!PENDING_STATUSES.some(candidate => candidate === status)) continue
    if (typeof task.id !== 'string' || typeof task.provider !== 'string' || typeof task.model !== 'string'
      || typeof task.kind !== 'string' || typeof record.submittedAt !== 'number'
      || !Number.isFinite(record.submittedAt) || typeof record.outputPath !== 'string') continue
    tasks.push({
      id: task.id,
      provider: task.provider,
      model: task.model,
      kind: task.kind,
      status: status as StudioTask['status'],
      submittedAt: record.submittedAt,
      outputPath: record.outputPath,
    })
  }
  return tasks
}

/**
 * The larger of the recorded shot costs and the ledger, in fen.
 * @param shots - selected attempts whose costs the project records.
 * @param ledgerCny - settled ledger total in CNY.
 * @returns the larger total in CNY, with fen-precision rounding.
 */
export function spentCnyOf(shots: readonly StudioShot[], ledgerCny: number): number {
  const shotFen = shots.reduce((sum, shot) => sum + Math.round((shot.costCny ?? 0) * 100), 0)
  return Math.max(shotFen, Math.round(ledgerCny * 100)) / 100
}

/**
 * Read one file that may legitimately be absent.
 * @param remote - the Session Remote face.
 * @param sessionId - owning session.
 * @param path - sibling file to read.
 * @param signal - cancels the reads.
 * @returns parsed JSON, or undefined when the file does not exist.
 */
async function optionalJson(
  remote: StudioRemote, sessionId: SessionId, path: string, signal?: AbortSignal,
): Promise<unknown> {
  const result = await remote.readBytes(sessionId, path, {}, signal)
  if (!result.ok) {
    if (result.error.code === 'workspace-file/not-found') return undefined
    throw new StudioReadError(result.error.message, 'read')
  }
  try {
    return jsonOf(result.value.data)
  } catch {
    // A hand-edited ledger or journal must not hide the production document.
    return undefined
  }
}

/**
 * Read one production, its ledger, its pending tasks, and media metadata.
 * @param remote - the Session Remote face.
 * @param sessionId - owning session.
 * @param projectPath - absolute project file path.
 * @param resolve - maps a declared media path to the path the Host receives.
 * @param signal - cancels every read.
 * @returns the project, or undefined when the file is absent.
 * @throws {@link StudioReadError} when the document cannot be read or validated.
 */
export async function readStudioProject(
  remote: StudioRemote,
  sessionId: SessionId,
  projectPath: string,
  resolve: (path: string) => string,
  signal?: AbortSignal,
): Promise<StudioProject | undefined> {
  const document = await remote.readBytes(sessionId, projectPath, {}, signal)
  if (!document.ok) {
    if (document.error.code === 'workspace-file/not-found') return undefined
    throw new StudioReadError(document.error.message, 'read')
  }
  const parsed = parseProjectDocument(jsonOf(document.value.data))
  const files = storeFilesOf(projectPath)
  const [ledger, journal] = await Promise.all([
    optionalJson(remote, sessionId, files.ledger, signal),
    optionalJson(remote, sessionId, files.tasks, signal),
  ])
  const ledgerCny = parseLedgerTotal(ledger)
  const paths = [...new Set([
    ...parsed.shots.flatMap(shot => [shot.keyframePath, shot.clipPath]),
    ...parsed.renders.map(render => render.path),
  ].filter((path): path is string => path !== undefined))]
  const media: StudioMedia[] = []
  for (const path of paths) {
    const kind = mediaKindOf(path)
    if (kind === undefined) continue
    const stat = await remote.stat(sessionId, resolve(path), signal)
    media.push(stat.ok
      ? { path, kind, absolutePath: stat.value.absolutePath, version: stat.value.version }
      : { path, kind })
  }
  return {
    path: projectPath,
    ...parsed,
    ledgerCny,
    spentCny: spentCnyOf(parsed.shots, ledgerCny),
    tasks: parsePendingTasks(journal),
    media,
  }
}
