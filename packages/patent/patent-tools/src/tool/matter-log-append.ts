/**
 * `matter_log_append` tool: the single writer of a case's `_matter-log.md`, and
 * the point the case audit trail's revision chain is judged at.
 *
 * The audit trail (`_matter-log.md`, the case's source of truth) was append-only
 * by convention: the model wrote it with the generic file tools, so its field
 * set, the appended-only rule, and the revision chain rested on compliance. A
 * version number was a self-declared line in a file header, so nothing recorded
 * which deliverable replaced which, or why, and nothing stopped a round from
 * being written over the previous one or from not being recorded at all.
 *
 * This tool makes the round's archival record a structured entry and the
 * revision chain an explicit relation. The delivery gate requires a successful
 * call before a deliverable may be rendered or built, so a round cannot ship
 * unrecorded.
 *
 * @module @deepseek-ai/dsh-patent-tools/tool/matter-log-append
 */

import { appendFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { PatentToolError } from '../error.ts'

/** The case-relative name of the append-only event log this tool owns. */
export const MATTER_LOG_FILE = '_matter-log.md'

/** The closed action vocabulary of a log entry (the skill's 动作 column). */
export const MATTER_ACTIONS = ['建案', '检索', '分析', '撰写', '门禁', '修订', '交付', '归档'] as const

/** One action an entry may record. */
export type MatterAction = (typeof MATTER_ACTIONS)[number]

/**
 * Actions that produce the artifact they record. A producing round must save a
 * new file, so its artifact paths may not repeat one the log already carries;
 * 门禁/交付/归档 entries name references, whose repetition is normal.
 */
const PRODUCING_ACTIONS: ReadonlySet<string> = new Set(['撰写', '修订'])

/** One round's archival record, as the caller declares it. */
export type MatterLogRequest = {
  /** 本轮动作（`建案`/`检索`/`分析`/`撰写`/`门禁`/`修订`/`交付`/`归档`）。 */
  action: string
  /** 本轮产物文件路径（须已存在；日志记事实，不记计划）。 */
  artifacts: string[]
  /** 本轮改了什么、为什么、是否影响保护点——留档段的正文。 */
  changes: string
  /** 被本轮产物取代的既有产物路径（显式取代链）。 */
  supersedes?: string[]
  /** 审批人（ask_user_question 确认者）。 */
  approver?: string
  /** 附加备注。 */
  note?: string
}

/** One way the declared record contradicts the log or the filesystem. */
export interface MatterLogDefect {
  /** Stable programmatic discriminator. */
  rule: string
  /** Model-facing statement of the defect and the fix. */
  message: string
}

/** One structured entry parsed back out of the log. */
export interface MatterLogEntry {
  /** 1-based line number. */
  line: number
  /** Local-time stamp the entry was written with. */
  localTime: string
  /** 动作. */
  action: string
  /** 产物路径. */
  artifacts: string[]
  /** 取代路径（未声明时为空）. */
  supersedes: string[]
}

/** Result of one append. */
export interface MatterLogAppendResult {
  /** The log file written to. */
  logPath: string
  /** The line appended, without its trailing newline. */
  entry: string
  /** Entries the log carried before this append. */
  priorEntries: number
  /** 本轮取代的路径（声明为空时省略）。 */
  superseded?: string[]
}

/** `产物 a、b` / `取代 a、b` field values, with `—` standing for "none". */
const NONE = '—'

/** Two spaces, one pipe, two spaces: the entry's field separator. */
const FIELD_SEP = ' | '

/**
 * The fields an entry line carries, in the order the renderer writes them. Only
 * the fields before the free text are fixed; the change summary runs to the end
 * of the line, so a `|` or a `、` inside it cannot shift a field.
 */
const ENTRY_FIELDS = [
  '^- (?<time>\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}[+-]\\d{2}:\\d{2})',
  ' \\| UTC (?<utc>\\S+)',
  ' \\| (?<action>\\S+)',
  ' \\| 产物 (?<artifacts>.+?)',
  ' \\| 取代 (?<supersedes>.+?)',
  ' \\| (?<approver>[^|]*?)',
  ' \\| (?<changes>.+)$',
].join('')

/** The structured entry's shape. */
const ENTRY_RE = new RegExp(ENTRY_FIELDS, 'u')
/** One whitespace/`|`/`、`-delimited token, the unit the legacy path scan reads. */
const LINE_TOKEN_RE = /[^\s|、]+/gu

/**
 * Local wall-clock and UTC stamps of one instant, both in ISO 8601.
 * @param now - the instant to stamp.
 * @returns the local stamp (with offset) and the UTC stamp.
 */
export function matterStamps(now: Date): { local: string; utc: string } {
  const offsetMinutes = -now.getTimezoneOffset()
  const sign = offsetMinutes < 0 ? '-' : '+'
  const absolute = Math.abs(offsetMinutes)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return {
    local: `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T`
      + `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
      + `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`,
    utc: now.toISOString(),
  }
}

/** Split one `产物`/`取代` field value into paths (`—` means none). */
function fieldPaths(value: string): string[] {
  if (value === NONE) return []
  return value.split('、').map(path => path.trim()).filter(path => path.length > 0)
}

/**
 * Parse every structured entry the log carries. Lines outside the format are
 * skipped here and accounted for by {@link loggedText} instead.
 * @param existing - the log's current text.
 * @returns the parsed entries, in line order.
 */
export function parseMatterEntries(existing: string): MatterLogEntry[] {
  const entries: MatterLogEntry[] = []
  for (const [index, line] of existing.split('\n').entries()) {
    const match = ENTRY_RE.exec(line)
    if (match?.groups === undefined) continue
    entries.push({
      line: index + 1,
      localTime: match.groups.time as string,
      action: match.groups.action as string,
      artifacts: fieldPaths(match.groups.artifacts as string),
      supersedes: fieldPaths(match.groups.supersedes as string),
    })
  }
  return entries
}

/**
 * Every path the log already carries, from structured entries and from the
 * path-shaped tokens of any line written before this tool existed.
 * @param existing - the log's current text.
 * @returns the recorded paths.
 */
function loggedPaths(existing: string): Set<string> {
  const paths = new Set<string>()
  for (const entry of parseMatterEntries(existing)) {
    for (const path of [...entry.artifacts, ...entry.supersedes]) paths.add(path)
  }
  for (const line of existing.split('\n')) {
    if (ENTRY_RE.test(line)) continue
    for (const token of line.match(LINE_TOKEN_RE) ?? []) {
      if (token.includes('/')) paths.add(token)
    }
  }
  return paths
}

/**
 * Judge a round's declared record against the log and the filesystem.
 * @param existing - the log's current text (`''` when the case has no log yet).
 * @param request - the round as declared.
 * @param pathExists - whether a declared path exists on disk.
 * @returns every defect; empty means the record may be appended.
 */
export function matterLogDefects(
  existing: string,
  request: MatterLogRequest,
  pathExists: (path: string) => boolean,
): MatterLogDefect[] {
  const defects: MatterLogDefect[] = []
  const artifacts = request.artifacts
  const supersedes = request.supersedes ?? []

  if (artifacts.length === 0) {
    defects.push({
      rule: 'no_artifacts',
      message: '未给出本轮产物：留档条目必须点明本轮的产物文件路径。',
    })
  }
  if (request.changes.trim().length === 0) {
    defects.push({
      rule: 'no_changes',
      message: '未给出本轮变更说明：写清改了什么、为什么、是否影响保护点，这是留档段要交代的内容。',
    })
  }
  for (const path of artifacts) {
    if (pathExists(path)) continue
    defects.push({
      rule: 'artifact_missing',
      message: `${path} 不存在：日志记事实不记计划，先把产物写出来再留档。`,
    })
  }
  for (const path of supersedes) {
    if (artifacts.includes(path)) {
      defects.push({
        rule: 'overwrite_in_place',
        message: `${path} 同时是本轮产物与被取代件：交付物一律另存新文件、禁止覆盖上一轮，请改用新路径并在 supersedes 里写旧路径。`,
      })
    }
  }
  const recorded = loggedPaths(existing)
  const supersededBefore = new Set(parseMatterEntries(existing).flatMap(entry => entry.supersedes))
  for (const path of supersedes) {
    if (!recorded.has(path)) {
      defects.push({
        rule: 'unknown_supersede',
        message: `supersedes 里的 ${path} 在日志中没有先出现的记录：取代链必须指向既有产物，不能凭空引用。`,
      })
    }
    if (supersededBefore.has(path)) {
      defects.push({
        rule: 'forked_chain',
        message: `${path} 已被更早的条目取代过：一个旧版只能有一个取代者，取代链不得分叉。`,
      })
    }
  }
  if (PRODUCING_ACTIONS.has(request.action)) {
    for (const path of artifacts) {
      if (!recorded.has(path)) continue
      defects.push({
        rule: 'reused_artifact_path',
        message: `${request.action} 轮的产物 ${path} 已在日志中登记过：修订必须另存新文件，用新路径重写并把旧路径写进 supersedes。`,
      })
    }
  }
  return defects
}

/**
 * Render one entry line: local time, UTC, action, artifacts, the paths this
 * round replaces, the approver, then the free-text change summary (and an
 * optional note) — free text last, so field parsing never depends on its content.
 * @param request - the round as declared.
 * @param now - the instant to stamp.
 * @returns the entry line, without a trailing newline.
 */
export function renderMatterEntry(request: MatterLogRequest, now: Date): string {
  const stamps = matterStamps(now)
  const artifacts = request.artifacts.join('、')
  const supersedes = (request.supersedes ?? []).join('、')
  const changes = request.note === undefined
    ? request.changes
    : `${request.changes}（备注：${request.note}）`
  return `- ${stamps.local}${FIELD_SEP}UTC ${stamps.utc}${FIELD_SEP}${request.action}`
    + `${FIELD_SEP}产物 ${artifacts}${FIELD_SEP}取代 ${supersedes.length > 0 ? supersedes : NONE}`
    + `${FIELD_SEP}${request.approver ?? NONE}${FIELD_SEP}${changes}`
}

/** Render the append result into model-facing prose. */
function renderMatterLogAppend(value: MatterLogAppendResult): string {
  const lines = [
    `已留档：${value.entry}`,
    `日志 ${value.logPath}，本条之前已有 ${String(value.priorEntries)} 条结构化条目。`,
  ]
  if (value.superseded !== undefined && value.superseded.length > 0) {
    lines.push(`取代链：${value.superseded.join('、')} → 本轮产物。`)
  }
  lines.push('日志只追加：发现记录错误时追加更正行，不得改写既有行。')
  return lines.join('\n')
}

const DESCRIPTION = [
  '把本轮作业写进案卷的只追加事件日志 _matter-log.md（案件的唯一事实源），并登记本轮的取代关系。',
  '- 每次撰写、修订、交付、门禁都在这里留档：写清改了什么、为什么、是否影响保护点（changes 字段），并列出本轮产物（artifacts，须已存在）',
  '- 取代关系显式登记：supersedes 列出本轮产物取代的既有文件。交付物一律另存新文件，禁止覆盖上一轮',
  '- 确定性判定，拒绝：产物不存在、产物路径与取代路径相同（原地覆盖）、supersedes 指向日志中没有的路径（凭空的取代链）、同一旧版被取代两次（取代链分叉）、撰写/修订轮复用已有产物路径',
  '- 条目只追加，既有行不改写；每条同时记本地时间与 UTC',
  '',
  '用法：出件前调用 matter_log_append({case_dir, action, artifacts, changes, supersedes?, approver?})。交付前置门禁要求本会话成功留档过，才允许 render_patent_document / build_patent_filing。',
].join('\n')

/**
 * Normalize one declared path to case-relative when it resolves inside the case
 * directory. Entries are compared path to path, so the chain has to hold one
 * spelling per file: a case addressed by absolute path in one round and by
 * relative path in the next would otherwise read as two different artifacts.
 * @param caseDir - the case directory the entry belongs to.
 * @param path - the path as declared.
 * @returns the case-relative path, or the input when it lies outside the case.
 */
export function toCasePath(caseDir: string, path: string): string {
  const trimmed = path.trim()
  if (!isAbsolute(trimmed)) return trimmed
  const inside = relative(caseDir, trimmed)
  return inside.length === 0 || inside.startsWith('..') ? trimmed : inside
}

/**
 * Build the `matter_log_append` tool (atomic append; no injected services).
 * @returns a registry-ready tool definition.
 */
export function createMatterLogAppendTool(): ToolDefinition {
  return defineTool({
    name: 'matter_log_append',
    description: DESCRIPTION,
    parameters: {
      case_dir: { type: 'string', required: true, description: '案件目录（内含 _matter-log.md；相对当前工作目录或绝对路径）' },
      action: { type: 'string', required: true, enum: [...MATTER_ACTIONS], description: '本轮动作' },
      artifacts: { type: 'array', required: true, items: { type: 'string' }, description: '本轮产物文件路径（须已存在）' },
      changes: { type: 'string', required: true, description: '本轮改了什么、为什么、是否影响保护点（留档段正文）' },
      supersedes: { type: 'array', items: { type: 'string' }, description: '被本轮产物取代的既有产物路径（可选）' },
      approver: { type: 'string', description: '审批人（ask_user_question 确认者，可选）' },
      note: { type: 'string', description: '附加备注（可选）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          logPath: { type: 'string', required: true },
          entry: { type: 'string', required: true },
          priorEntries: { type: 'integer', required: true },
          superseded: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderMatterLogAppend(value) }],
    },
    async execute(args) {
      const logPath = join(args.case_dir, MATTER_LOG_FILE)
      // 读快照 → 按快照判定 → 追加，是一段读改写：两个并发留档会基于同一份过期日志
      // 各自通过校验，把同一产物登记两次或给同一旧版挂两个后继。跨进程写者锁由
      // atomic-write 提供，锁内重读保证判定看到的是已提交状态。
      return withFileLock(logPath, async () => {
        if (!existsSync(logPath) && args.action !== '建案') {
          throw new PatentToolError(
            'file_not_found',
            `${logPath} 不存在：案件先经「建案」动作初始化日志（动作=建案），后续动作才可追加。`,
            { tool: 'matter_log_append', path: logPath },
          )
        }
        const existing = existsSync(logPath) ? await readFile(logPath, 'utf8') : ''
        const request: MatterLogRequest = {
          action: args.action,
          artifacts: args.artifacts.map(path => toCasePath(args.case_dir, path)),
          changes: args.changes,
          ...(args.supersedes === undefined
            ? {}
            : { supersedes: args.supersedes.map(path => toCasePath(args.case_dir, path)) }),
          ...(args.approver === undefined ? {} : { approver: args.approver }),
          ...(args.note === undefined ? {} : { note: args.note }),
        }
        const defects = matterLogDefects(existing, request, path => existsSync(resolve(args.case_dir, path)))
        if (defects.length > 0) {
          throw new PatentToolError(
            'invalid_tool_input',
            ['留档被拒（条目未写入）：', ...defects.map(defect => `- [${defect.rule}] ${defect.message}`)].join('\n'),
            { tool: 'matter_log_append', defects },
          )
        }
        const entry = renderMatterEntry(request, new Date())
        const header = existing.length === 0 || existing.endsWith('\n') ? '' : '\n'
        await appendFile(logPath, `${header}${entry}\n`, 'utf8')
        const superseded = request.supersedes ?? []
        return {
          logPath,
          entry,
          priorEntries: parseMatterEntries(existing).length,
          ...(superseded.length === 0 ? {} : { superseded }),
        }
      })
    },
  })
}
