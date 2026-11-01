/**
 * The `document_deliver` tool: the document agent's structured deliverable
 * registration. The model calls it after its own quality-gate checks pass; the
 * call's arguments are session-logged, so the GUI derives the deliverable list
 * (paths, formats, claimed gate state) without a new session event type. The
 * tool itself validates, checks, and confirms — it writes no file and touches
 * no persistence outside the normal tool/result log.
 *
 * The model declares which quality checks it ran; the tool reads the delivered
 * bytes and reports its own deterministic findings beside that declaration
 * (see `./checks.ts`), without verifying the declaration itself. A finding the
 * checker rates `block` throws instead of registering, so a deliverable that
 * still carries an unfilled variable never reaches the registration path on the
 * model's word alone.
 *
 * Registration holds the declaration too, because a declaration is what a
 * consumer reads back. A path whose extension contradicts the declared format
 * is read the way its extension says and the contradiction is reported beside
 * the check outcome; a file the checker cannot read has to carry an
 * `unreadable_ack` reason unless the read hit the size cap, so "not checked"
 * can never be read as "checked"; the P0 checklist a call names is compared
 * with the gate's stable ids, so a result can name the id the call left out;
 * and a `brief_ref` that names no file is reported while the registration
 * proceeds, because a brief may legitimately be gone by delivery time.
 * @module @deepseek-ai/dsh-document-deliver/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import { findStyleByName, type DocumentStyle } from '@deepseek-ai/dsh-doc-style'
import { extractDocxText, type ZipReadLimits } from '@deepseek-ai/dsh-docx-kit'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { errorMessage } from '@deepseek-ai/dsh-value'
import { checkDocumentText, type DocumentCheckFinding } from './checks.ts'
import {
  briefReferenceWarnings,
  p0ChecklistWarnings,
  READ_CAP_REASON_PREFIX,
  resolveAckIdentities,
  resolveCheckFormat,
  resolveTarget,
  resolveUnreadableReports,
} from './registration.ts'
import type { UnreadableAckInput } from './registration.ts'

export {
  briefReferenceWarnings,
  p0ChecklistWarnings,
  P0_CHECKLIST,
  resolveAckIdentities,
  resolveCheckFormat,
  resolveUnreadableReports,
} from './registration.ts'
export type { P0ChecklistEntry, ResolvedCheckFormat, UnreadableAckInput } from './registration.ts'

/** The formats the document workline delivers. */
export const DELIVERABLE_FORMATS = ['markdown', 'html', 'pdf', 'docx', 'pptx', 'other'] as const

/** One claimed deliverable format. */
export type DeliverableFormat = (typeof DELIVERABLE_FORMATS)[number]

/** Formats the checker reads as text directly; the rest need a projector or have none. */
const TEXT_FORMATS: readonly DeliverableFormat[] = ['markdown', 'html']

/** Largest deliverable the checker reads, matching the studio's preview cap. */
export const DEFAULT_MAX_CHECK_BYTES = 4 * 1024 * 1024

/** One registered deliverable file. */
export interface DeliverFileInput {
  path: string
  format: DeliverableFormat
}

/** The model's quality-gate self-report for one registration. */
export interface DeliverGateInput {
  /**
   * P0 checklist ids the model reports as passed (see {@link P0_CHECKLIST}). The
   * tool records this list beside its own deterministic findings and reports the
   * ids it left out or cannot recognize; it does not verify the claim itself.
   */
  p0: string[]
  /** Met P1 checklist items as the model reports them; empty when none were met or none apply. */
  p1?: string[]
}

/** The `document_deliver` arguments (schema-validated field names). */
export interface DocumentDeliverInput {
  files: DeliverFileInput[]
  gate: DeliverGateInput
  brief_ref?: string
  /** Writing style to check against; the configured default when omitted. */
  style?: string
  /** Declared length budget of the delivered document, in characters. */
  char_budget?: number
  /** One reason per file the checker reported `unreadable`; the read-cap case needs none. */
  unreadable_ack?: UnreadableAckInput[]
}

/**
 * One deliverable's check outcome. `unchecked` means no reader exists for the
 * format, `unreadable` that reading or projecting it failed; neither claims the
 * file passes the checks. A `checked` report may still carry a reason when the
 * checks ran over incompletely projected text.
 */
export interface DeliverableCheckReport {
  /** The path as the call declared it; the spelling stays verbatim because display is human. */
  path: string
  /**
   * Host-resolved canonical path of the file this report checked; absent on
   * results recorded before it existed.
   *
   * Two spellings of one file — workspace-relative and absolute, a symlink and
   * its target — share this value, so a consumer keys a deliverable on it while
   * `path` keeps what the call wrote. It is the same canonical absolute path a
   * file mutation records in its result metadata.
   */
  identity?: string
  format: DeliverableFormat
  status: 'checked' | 'unchecked' | 'unreadable'
  /** Why the checks did not run, or ran over incomplete text; absent when they ran over the whole file. */
  reason?: string
  /** The caller's declared reason for shipping an `unreadable` file, when one was required. */
  ack?: string
  findings: DocumentCheckFinding[]
}

/** The canonical registration result (echoes the validated declaration). */
export interface DocumentDeliverResult {
  registered: Array<{ path: string; format: DeliverableFormat }>
  gate: {
    p0: string[]
    p1: string[]
    /** Style the deterministic checks ran against. */
    style: string
    /** One check report per registered file, in declaration order. */
    checks: DeliverableCheckReport[]
  }
  /** Registration-level warnings: what the declaration got wrong, one line each; absent when nothing did. */
  warnings?: string[]
  brief_ref?: string
}

/** Parsed, validated registration (camelCased, defaults applied). */
export interface DocumentDeliverSpec {
  files: Array<{ path: string; format: DeliverableFormat }>
  gate: { p0: string[]; p1: string[] }
  briefRef?: string
  /** Style the call named, absent when it named none. */
  styleName?: string
  /** Declared character budget, absent when the call declared none. */
  charBudget?: number
  /** One declared reason per unreadable file, when the call declared any. */
  unreadableAck?: Array<{ path: string; reasonText: string }>
}

/** The loaded styles and the default one, resolved once at plugin load. */
export interface DocumentDeliverDeps {
  /** Every loaded style, which a call may name. */
  readonly styles: readonly DocumentStyle[]
  /** The style a call that names none is checked against. */
  readonly defaultStyle: DocumentStyle
  /** Largest deliverable the checker reads, in bytes (Config `maxCheckBytes`). */
  readonly maxCheckBytes: number
  /** Fraction of a declared character budget a document may deviate by (Config `lengthTolerance`). */
  readonly lengthTolerance: number
  /** Findings kept per check before the rest are summarized into one line (Config `maxFindingsPerCheck`). */
  readonly maxFindingsPerCheck: number
  /** Budgets the DOCX archive read must stay within (Config `maxArchiveEntries` / `maxUncompressedBytes`). */
  readonly docxReadLimits: ZipReadLimits
}

/** Read, tolerance, and report budgets one check run applies, resolved from the deployment's `Config`. */
type DeliverableCheckLimits = Pick<DocumentDeliverDeps, 'maxCheckBytes' | 'lengthTolerance' | 'maxFindingsPerCheck' | 'docxReadLimits'>

/** The style a registration resolves to, or a fail-loud error naming the loaded set. */
function resolveStyle(deps: DocumentDeliverDeps, spec: DocumentDeliverSpec): DocumentStyle {
  if (spec.styleName === undefined) return deps.defaultStyle
  const style = findStyleByName(deps.styles, spec.styleName)
  if (style === undefined) {
    const known = deps.styles.map(entry => entry.name).join('、')
    throw new Error(`document_deliver: 未加载样式 ${JSON.stringify(spec.styleName)}；可用样式：${known}`)
  }
  return style
}

function isNonBlank(value: string): boolean {
  return value.trim().length > 0
}

/**
 * Validate the schema-validated arguments into a normalized spec. The JSON
 * schema covers shape and enums; this covers the semantic invariants the
 * schema subset cannot express: at least one file, no blank or duplicate
 * paths, a non-empty P0 list, no blank checklist items, a non-blank style
 * name, a positive whole character budget, and one non-blank reason per
 * declared unreadable path.
 * @param args - the schema-validated raw arguments.
 * @returns the normalized spec, or throws on the first violation.
 */
export function parseDocumentDeliverArgs(args: DocumentDeliverInput): DocumentDeliverSpec {
  if (!Array.isArray(args.files) || args.files.length === 0) {
    throw new Error('document_deliver: files must list at least one deliverable')
  }
  const seen = new Set<string>()
  const files: DocumentDeliverSpec['files'] = []
  for (const file of args.files) {
    if (!isNonBlank(file.path)) throw new Error('document_deliver: every file path must be a non-empty string')
    if (seen.has(file.path)) throw new Error(`document_deliver: duplicate deliverable path "${file.path}"`)
    seen.add(file.path)
    files.push({ path: file.path, format: file.format })
  }
  if (!isNonBlank(args.gate.p0[0] ?? '') || !args.gate.p0.every(isNonBlank)) {
    throw new Error('document_deliver: gate.p0 must list the P0 checks that passed (non-empty, no blank items)')
  }
  const p1 = args.gate.p1 ?? []
  if (!p1.every(isNonBlank)) {
    throw new Error('document_deliver: gate.p1 items must be non-empty strings')
  }
  if (args.brief_ref !== undefined && !isNonBlank(args.brief_ref)) {
    throw new Error('document_deliver: brief_ref must be a non-empty path when provided')
  }
  if (args.style !== undefined && !isNonBlank(args.style)) {
    throw new Error('document_deliver: style must be a non-empty style name when provided')
  }
  if (args.char_budget !== undefined && (args.char_budget <= 0 || !Number.isInteger(args.char_budget))) {
    throw new Error('document_deliver: char_budget must be a positive whole number of characters')
  }
  const unreadableAck: NonNullable<DocumentDeliverSpec['unreadableAck']> = []
  const acked = new Set<string>()
  for (const entry of args.unreadable_ack ?? []) {
    if (!isNonBlank(entry.path) || !isNonBlank(entry.reason_text)) {
      throw new Error('document_deliver: every unreadable_ack entry needs a non-empty path and reason_text')
    }
    if (acked.has(entry.path)) throw new Error(`document_deliver: duplicate unreadable_ack path "${entry.path}"`)
    acked.add(entry.path)
    unreadableAck.push({ path: entry.path, reasonText: entry.reason_text })
  }
  return {
    files,
    gate: { p0: args.gate.p0, p1 },
    ...args.brief_ref !== undefined ? { briefRef: args.brief_ref } : {},
    ...args.style !== undefined ? { styleName: args.style } : {},
    ...args.char_budget !== undefined ? { charBudget: args.char_budget } : {},
    ...unreadableAck.length > 0 ? { unreadableAck } : {},
  }
}

/** Format the parsed input and the check reports into the canonical JSON result. */
function toResult(
  spec: DocumentDeliverSpec, checks: readonly DeliverableCheckReport[], style: DocumentStyle, warnings: readonly string[],
): DocumentDeliverResult {
  const result: DocumentDeliverResult = {
    registered: spec.files.map(file => ({ path: file.path, format: file.format })),
    gate: { p0: spec.gate.p0, p1: spec.gate.p1, style: style.name, checks: [...checks] },
  }
  if (spec.briefRef !== undefined) result.brief_ref = spec.briefRef
  if (warnings.length > 0) result.warnings = [...warnings]
  return result
}

/**
 * Confirm every registered file exists in the workspace. Registration is the
 * pre-delivery enforcement point: a file the session cannot resolve is not a
 * deliverable, and the model must fix it or drop it instead of registering a
 * ghost.
 * @param ctx - plugin context carrying `ctx.fs`.
 * @param exec - the current tool execution (signal, agent).
 * @param paths - the registered workspace-relative paths.
 * @returns the missing paths, empty when every file exists.
 */
export async function missingDeliverableFiles(
  ctx: Context, exec: ToolRunContext, paths: readonly string[],
): Promise<string[]> {
  const missing: string[] = []
  for (const path of paths) {
    const target = await resolveTarget(ctx, exec, path)
    const info = await ctx.fs.stat(target, exec.signal)
    if (info === undefined) missing.push(path)
  }
  return missing
}

/**
 * Read one deliverable and run the deterministic checks over its text.
 *
 * A format with no text reader, a read that fails (an oversized file, a
 * removed one), and a DOCX package that projects no text all report their own
 * status with the reason attached: the registration stays possible, and the
 * result never implies a check that did not run.
 *
 * The file is read as {@link resolveCheckFormat} says, not as the call labelled
 * it, so a `.html` declared `pdf` still gets its placeholders checked and the
 * contradiction goes into the same `reason` the studio renders beside the
 * badge. A reason that already explains a failed read keeps both halves, in
 * that order.
 *
 * The report carries the file's canonical `identity` whatever the check
 * outcome: a consumer keys a deliverable on that value, so a format with no
 * reader needs it just as much as a checked one.
 * @param ctx - plugin context carrying `ctx.fs`.
 * @param exec - the current tool execution (signal, agent).
 * @param file - the declared path and format.
 * @param style - the style whose forbidden words are enforced.
 * @param charBudget - the declared character budget, when the call declared one.
 * @param limits - the read and tolerance budgets this deployment configured.
 * @returns the check report for this file.
 */
async function checkDeliverable(
  ctx: Context, exec: ToolRunContext, file: { path: string; format: DeliverableFormat },
  style: DocumentStyle, charBudget: number | undefined, limits: DeliverableCheckLimits,
): Promise<DeliverableCheckReport> {
  const resolved = resolveCheckFormat(file.path, file.format)
  const format = resolved.format
  const target = await resolveTarget(ctx, exec, file.path)
  const base = { path: file.path, identity: ctx.fs.processPath(target), format }
  /**
   * The `reason` field of a report, omitted when there is nothing to say.
   *
   * The declaration contradiction comes first, so a reader sees why the file
   * was read this way before the outcome of reading it.
   */
  const reasonField = (...rest: Array<string | undefined>): { reason?: string } => {
    const all = [resolved.mismatch, ...rest].filter((entry): entry is string => entry !== undefined && entry !== '')
    return all.length === 0 ? {} : { reason: all.join('；') }
  }
  const options = {
    style,
    lengthTolerance: limits.lengthTolerance,
    maxFindingsPerCheck: limits.maxFindingsPerCheck,
    // The budget counts prose, so HTML is measured after its markup is removed
    // (checks.ts owns that projection); a Markdown body is already prose.
    ...format === 'html' ? { format: 'html' as const } : {},
    ...charBudget === undefined ? {} : { charBudget },
  }
  if (!TEXT_FORMATS.includes(format) && format !== 'docx') {
    return { ...base, status: 'unchecked', ...reasonField(`${format} 格式没有文本读取器`), findings: [] }
  }
  try {
    if (format === 'docx') {
      const bytes = await ctx.fs.readBytes(target, exec.signal, limits.maxCheckBytes)
      const projected = extractDocxText(bytes, limits.docxReadLimits)
      const problems = projected.problems.map(problem => problem.code).join('、')
      // An empty projection always carries at least the `no-text` problem, so
      // the joined codes are the reason.
      if (projected.text === '') {
        return { ...base, status: 'unreadable', ...reasonField(problems), findings: [] }
      }
      // A package whose parts did not all project is reported as unreadable even
      // though the projected part was checked: a passing status would claim
      // coverage the reader did not have.
      return {
        ...base,
        status: problems === '' ? 'checked' : 'unreadable',
        ...problems === '' ? {} : reasonField(`DOCX 结构报告 ${problems}，投影文本可能不完整`),
        findings: checkDocumentText(projected.text, options),
      }
    }
    // The text branch reads under the same cap as the DOCX branch, so an oversized
    // file is reported below instead of being read whole.
    const bytes = await ctx.fs.readBytes(target, exec.signal, limits.maxCheckBytes)
    const text = new TextDecoder().decode(bytes)
    return {
      ...base,
      status: 'checked',
      ...reasonField(),
      findings: checkDocumentText(text, options),
    }
  } catch (error) {
    // A file the checker cannot read is reported with its reason, never skipped silently.
    // The read cap is named with this tool's own marker, so the registration can
    // tell a deployment budget apart from a defect without reading a backend's
    // message (see `stoppedAtDeploymentBudget`).
    const reason = error instanceof FsError && error.code === 'FS_TOO_LARGE'
      ? `${READ_CAP_REASON_PREFIX}${errorMessage(error)}`
      : errorMessage(error)
    return { ...base, status: 'unreadable', ...reasonField(reason), findings: [] }
  }
}

/**
 * Check every declared deliverable.
 * @param ctx - plugin context carrying `ctx.fs`.
 * @param exec - the current tool execution (signal, agent).
 * @param spec - the validated registration.
 * @param style - the style the checks run against.
 * @param limits - the read and tolerance budgets this deployment configured.
 * @returns one report per file, in declaration order.
 *
 * The files are checked one after another: every check reads the same
 * registration through `ctx.fs` and admits a DOCX package up to that package's
 * own budget, so a concurrent sweep would raise peak memory to the sum of the
 * in-flight reads. Wall-clock is the file count times the per-file check, which
 * is the trade this tool makes deliberately.
 */
export async function checkDeliverables(
  ctx: Context, exec: ToolRunContext, spec: DocumentDeliverSpec, style: DocumentStyle,
  limits: DeliverableCheckLimits,
): Promise<DeliverableCheckReport[]> {
  const reports: DeliverableCheckReport[] = []
  for (const file of spec.files) {
    reports.push(await checkDeliverable(ctx, exec, file, style, spec.charBudget, limits))
  }
  return reports
}

/** Every blocking finding of one check run, phrased as the remediation list. */
function blockingLines(checks: readonly DeliverableCheckReport[]): string[] {
  return checks.flatMap(report => report.findings
    .filter(finding => finding.level === 'block')
    .map(finding => `- ${report.path} [${finding.check}] ${finding.detail}`))
}

/** The one-line status of a file's check, as the model and the studio read it. */
function statusText(report: DeliverableCheckReport): string {
  if (report.status === 'unchecked') return '未核验'
  if (report.status === 'unreadable') return '无法核验'
  return report.findings.length === 0 ? '通过' : `${String(report.findings.length)} 项提示`
}

/** One file's check outcome as one line, with the reason it did not fully run and any declared reason. */
function describeCheck(report: DeliverableCheckReport): string {
  const status = `${report.path} ${statusText(report)}`
  const withReason = report.reason === undefined ? status : `${status}（${report.reason}）`
  return report.ack === undefined ? withReason : `${withReason}（已声明：${report.ack}）`
}

/** Model-facing text of one registration result. */
function renderResult(result: DocumentDeliverResult): string {
  const warnings = result.gate.checks.flatMap(report => report.findings
    .filter(finding => finding.level === 'warn')
    .map(finding => `- ${report.path} [${finding.check}] ${finding.detail}`))
  const lines = [
    `已登记 ${String(result.registered.length)} 个交付文件：${result.registered.map(file => file.path).join('、')}`,
    `质量门：P0 ${String(result.gate.p0.length)} 项通过${result.gate.p1.length > 0 ? `，P1 ${String(result.gate.p1.length)} 项` : ''}`,
    `确定性核验（样式 ${result.gate.style}）：${result.gate.checks.map(describeCheck).join('；')}`,
  ]
  if (result.brief_ref !== undefined) lines.push(`brief 参考：${result.brief_ref}`)
  if (warnings.length > 0) lines.push(`提示（${String(warnings.length)}）：`, ...warnings)
  if (result.warnings !== undefined && result.warnings.length > 0) {
    lines.push(`登记提示（${String(result.warnings.length)}）：`, ...result.warnings.map(line => `- ${line}`))
  }
  return lines.join('\n')
}

/**
 * Project the check reports into the presentation metadata persisted on the
 * tool result.
 *
 * The projection is written out field by field rather than passing the reports
 * through: this object is what the log keeps and what the delivery studio
 * narrows back on replay, so its fields are a wire commitment, not an alias for
 * whatever the in-process report happens to carry. `identity` is the canonical
 * key a consumer joins entries on; `path` stays the declared spelling.
 * @param checks - the check reports of one registration.
 * @returns the metadata value for `tool/result`.
 */
function checksMeta(checks: readonly DeliverableCheckReport[]) {
  return {
    checks: checks.map(report => ({
      path: report.path,
      ...report.identity === undefined ? {} : { identity: report.identity },
      format: report.format,
      status: report.status,
      ...report.reason === undefined ? {} : { reason: report.reason },
      ...report.ack === undefined ? {} : { ack: report.ack },
      findings: report.findings.map(finding => ({
        check: finding.check,
        level: finding.level,
        detail: finding.detail,
        ...finding.line === undefined ? {} : { line: finding.line },
      })),
    })),
  }
}

/**
 * The tool description, parameterized with the deployment's length tolerance:
 * the model must be able to predict whether its document passes the budget
 * check, and the tolerance is a `Config` value.
 * @param lengthTolerance - the configured fraction of a declared budget a document may deviate by.
 * @returns the `document_deliver` description.
 */
function deliverDescription(lengthTolerance: number): string {
  const percent = Math.round(lengthTolerance * 100 * 100) / 100
  return `登记一份文档交付物：声明成品文件、导出格式与质量门自述（P0/P1 自检项）。在你自己核完 P0 全过之后、向用户交付之前调用一次；文件必须在工作区中存在。

工具会自己读成品并做确定性核验：残余占位符（{{变量}}、[TBD] 等）、本文档未声明的锚点、空章节、所选风格（style）的禁用词、以及声明的字数预算（char_budget，本部署按 ±${String(percent)}% 容差核验）。P0/P1 是你的自述，工具不核验它，只把自述项数与这些核验结论并列写入会话日志，交付物面板同时展示两列。命中禁用级问题（未填变量、风格禁用词）时调用会被拒绝并列出问题，修复后重新登记。

两条与声明本身有关的判定：文件按扩展名决定用哪种读取器（声明格式与扩展名不一致会提示，并按扩展名核验）；读不出内容的文件必须在 unreadable_ack 里写一条原因（path + reason_text）才允许登记，超出本部署读取上限的文件除外。p0 用质量门技能里的稳定 id（P0-1 … P0-6）填写，工具会把缺失或无法识别的项列出来。`
}

const PARAMETERS = {

  files: {
    type: 'array',
    required: true,
    description: '本次交付的全部成品文件与格式（至少一个）；path 为工作区相对路径（或绝对路径），如 out/report.html',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', required: true, description: '工作区相对路径（或绝对路径）' },
        format: { type: 'string', required: true, enum: [...DELIVERABLE_FORMATS], description: '成品导出格式' },
      },
    },
  },
  gate: {
    type: 'object',
    required: true,
    additionalProperties: false,
    description: '质量门自述：P0 由你声明，工具只把机器可判定的核验结论并列记录，不核验这份自述；缺失或无法识别的 id 会在结果里列出',
    properties: {
      p0: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: '你自述已通过的 P0 自检项，填质量门技能 P0 清单的稳定 id（P0-1 命名、P0-2 自包含、P0-3 无占位残留、P0-4 断链、P0-5 来源、P0-6 语言）；工具不核验这份自述，只把缺失项与无法识别的写法在结果里列出',
      },
      p1: {
        type: 'array',
        items: { type: 'string' },
        description: '你自述已满足的 P1 自检项（无则省略）；工具同样不核验这份自述',
      },
    },
  },
  brief_ref: {
    type: 'string',
    description: '本次交付依据的 brief 文件路径（如 brief.md），可省略',
  },
  style: {
    type: 'string',
    description: '核验所用的书写风格名（如 assistant-neutral、patent-standard）；省略时用本部署配置的默认风格',
  },
  char_budget: {
    type: 'integer',
    description: '全文声明的字数预算（非空白字符数），用于核验篇幅；省略则不核验篇幅',
  },
  unreadable_ack: {
    type: 'array',
    description: '为每个"无法核验"（unreadable）的交付文件写一条原因；缺失时登记被拒，超出本部署读取上限的文件不需要',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', required: true, description: '无法核验的文件路径，与 files 中的 path 一致' },
        reason_text: { type: 'string', required: true, description: '为什么该文件在无法核验的情况下仍要交付' },
      },
    },
  },

} as const satisfies ParameterSchemaSpec

const OUTPUT_SCHEMA = {

  type: 'object',
  additionalProperties: false,
  properties: {
    registered: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          format: { type: 'string', required: true, enum: [...DELIVERABLE_FORMATS] },
        },
      },
      required: true,
    },
    gate: {
      type: 'object',
      additionalProperties: false,
      properties: {
        p0: { type: 'array', items: { type: 'string' }, required: true },
        p1: { type: 'array', items: { type: 'string' }, required: true },
        style: { type: 'string', required: true },
        checks: {
          type: 'array',
          required: true,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', required: true },
              identity: { type: 'string' },
              format: { type: 'string', required: true, enum: [...DELIVERABLE_FORMATS] },
              status: { type: 'string', required: true, enum: ['checked', 'unchecked', 'unreadable'] },
              reason: { type: 'string' },
              ack: { type: 'string' },
              findings: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    check: { type: 'string', required: true, enum: ['placeholder', 'broken_anchor', 'empty_section', 'anti_pattern', 'length_budget'] },
                    level: { type: 'string', required: true, enum: ['block', 'warn'] },
                    detail: { type: 'string', required: true },
                    line: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
      required: true,
    },
    brief_ref: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
  },

} as const satisfies ValueSchemaSpec

/**
 * Register one `document_deliver` tool definition over the plugin's context.
 * @param ctx - the Cordis context with the tools and fs services.
 * @param deps - the loaded styles, the default style, and the budgets of this deployment.
 * @returns a registry-ready tool definition.
 */
export function createDocumentDeliverTool(ctx: Context, deps: DocumentDeliverDeps): ToolDefinition {
  const limits: DeliverableCheckLimits = {
    maxCheckBytes: deps.maxCheckBytes,
    lengthTolerance: deps.lengthTolerance,
    maxFindingsPerCheck: deps.maxFindingsPerCheck,
    docxReadLimits: deps.docxReadLimits,
  }
  return defineTool({
    name: 'document_deliver',
    description: deliverDescription(deps.lengthTolerance),
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderResult(value) }],
      // The deliverable panel reads the same computed reports back on replay;
      // the model-facing text above is only their summary.
      presentationMeta: (_args, value) => checksMeta(value.gate.checks),
    },
    presentCall: (args) => {
      try {
        const spec = parseDocumentDeliverArgs(args)
        return {
          card: 'generic',
          title: `登记文档交付物（${spec.files.length} 个文件）`,
          rawInput: {
            files: spec.files.map(file => `${file.path} (${file.format})`),
            p0: spec.gate.p0.length,
            p1: spec.gate.p1.length,
            ...spec.briefRef !== undefined ? { brief_ref: spec.briefRef } : {},
          },
          locations: spec.files.map(file => ({ path: file.path })),
        }
      } catch {
        // A UI may project the pending call during streaming, before the
        // validator-narrowed arguments reach the semantically-valid state; the
        // fallback card (tool name + raw args) still renders the call.
        return undefined
      }
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const spec = parseDocumentDeliverArgs(args)
      const style = resolveStyle(deps, spec)
      const missing = await missingDeliverableFiles(ctx, exec, spec.files.map(file => file.path))
      if (missing.length > 0) {
        throw new Error(`document_deliver: 以下交付文件在工作区中不存在，先修复或从登记中移除: ${missing.join('、')}`)
      }
      const warnings = p0ChecklistWarnings(spec.gate.p0)
      if (spec.briefRef !== undefined) {
        warnings.push(...await briefReferenceWarnings(ctx, exec, spec.briefRef))
      }
      const checks = await checkDeliverables(ctx, exec, spec, style, limits)
      const blocking = blockingLines(checks)
      if (blocking.length > 0) {
        throw new Error([
          'document_deliver: 确定性核验未通过，修复以下问题后重新登记：',
          ...blocking,
        ].join('\n'))
      }
      const readable = resolveUnreadableReports(spec, checks, await resolveAckIdentities(ctx, exec, spec))
      warnings.push(...readable.warnings)
      return toResult(spec, readable.reports, style, warnings)
    },
  })
}
