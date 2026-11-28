/**
 * Registration helpers for `document_deliver`: the quality-gate P0 checklist,
 * the format a declared path is read as, the reasons an unreadable file must
 * carry, and the brief reference probe.
 *
 * These run inside the tool's execute path and read the contract types from
 * {@link ./tool.ts}; keeping them here leaves the tool factory to the schema
 * and the orchestration of one registration.
 * @module @deepseek-ai/dsh-document-deliver/registration
 */

import { extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-error'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { errorMessage } from '@deepseek-ai/dsh-value'
import type { DeliverableCheckReport, DeliverableFormat, DocumentDeliverSpec } from './tool.ts'

/** One quality-gate P0 item: the stable id a call reports and the label it stands for. */
export interface P0ChecklistEntry {
  /** Stable id written in `gate.p0` and named back in a diagnostic. */
  readonly id: string
  /** Chinese label the delivery checklist and every diagnostic use. */
  readonly label: string
}

/**
 * The delivery quality gate's P0 checklist, in the order the skill prints it.
 *
 * These ids are a product constant, not a deployment tunable: they mirror the
 * list `packages/bundle/web-app/skills/document/document-quality-gate/SKILL.md`
 * prints, and `tests/document-deliver.spec.ts` fails when the two sets drift
 * apart. A registration naming one of them is compared against the whole set so
 * the result can name what the call left out; a name outside the set is
 * reported as unknown rather than refused, which keeps a transcript recorded
 * before the ids existed replayable.
 */
export const P0_CHECKLIST: readonly P0ChecklistEntry[] = [
  { id: 'P0-1', label: '命名' },
  { id: 'P0-2', label: '自包含' },
  { id: 'P0-3', label: '无占位残留' },
  { id: 'P0-4', label: '断链' },
  { id: 'P0-5', label: '来源' },
  { id: 'P0-6', label: '语言' },
]

/**
 * Extension to the format the checker reads that file with, lowercased.
 *
 * Only extensions whose reading is not in doubt appear here. A claimed format
 * the extension contradicts is read the way the extension says: the bytes on
 * disk decide what a reader is able to do with them, and the caller's label is
 * a claim about those bytes.
 */
const FORMAT_BY_EXTENSION: Readonly<Record<string, DeliverableFormat>> = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.html': 'html',
  '.htm': 'html',
  '.docx': 'docx',
  '.pdf': 'pdf',
  '.pptx': 'pptx',
}

/** The format one report reads a file as, plus the contradiction when the declaration disagrees. */
export interface ResolvedCheckFormat {
  /** Format the checks read the file as. */
  readonly format: DeliverableFormat
  /** Declaration-versus-extension text, absent when the two agree. */
  readonly mismatch?: string
}

/**
 * Resolve the format a declared path is checked as.
 *
 * A declaration of `other` keeps today's behaviour: the call says the file has
 * no reading, so no extension is allowed to contradict it (a `.dat` attachment
 * is the caller's call to make). Otherwise a known extension wins over the
 * declaration and says so, and an unknown or absent extension leaves the
 * declaration standing.
 * @param path - the registered path, as the call declared it.
 * @param declared - the format the call declared.
 * @returns the format to read the file as, and the mismatch text when the declaration was contradicted.
 */
export function resolveCheckFormat(path: string, declared: DeliverableFormat): ResolvedCheckFormat {
  if (declared === 'other') return { format: declared }
  const extension = extname(path).toLowerCase()
  const expected = FORMAT_BY_EXTENSION[extension]
  if (expected === undefined || expected === declared) return { format: declared }
  return {
    format: expected,
    mismatch: `声明格式 ${declared} 与扩展名 ${extension} 不一致，已按 ${expected} 核验`,
  }
}

/** One declared reason for registering a file the checker could not read. */
export interface UnreadableAckInput {
  /** Path the reason belongs to; must match a registered file. */
  path: string
  /** Why the file still ships unread; kept in the result beside the check outcome. */
  reason_text: string
}

/**
 * Compare the P0 ids a call reported with the gate's checklist.
 *
 * A name outside the checklist is reported as unknown rather than refused: a
 * transcript recorded before the ids existed still replays, and a model that
 * guessed a wording learns the id without losing the registration. Every id
 * the call left out is named, because "one of six" and "six of six" are the
 * same count in a transcript and different claims about the delivery. An
 * unknown id satisfies no checklist item, so a call that names only unknown
 * items also gets that line: the unknown-id line reports the wording that
 * missed, and the missing line reports the checks left unstated.
 * @param p0 - the P0 items the call reported.
 * @returns one warning line per unknown id and one naming the ids the call left out.
 */
export function p0ChecklistWarnings(p0: readonly string[]): string[] {
  const known = new Set(P0_CHECKLIST.map(entry => entry.id))
  const reported = new Set(p0)
  const warnings: string[] = []
  for (const item of p0) {
    if (known.has(item)) continue
    warnings.push(`未知的 P0 项 ${JSON.stringify(item)}：本技能 P0 清单用稳定 id（${P0_CHECKLIST.map(entry => `${entry.id} ${entry.label}`).join('、')}）`)
  }
  const missing = P0_CHECKLIST.filter(entry => !reported.has(entry.id))
  if (missing.length > 0) {
    warnings.push(`缺少 P0 项：${missing.map(entry => `${entry.id} ${entry.label}`).join('、')}`)
  }
  return warnings
}

/**
 * Report a brief reference that names no readable file.
 *
 * The brief is context, not a deliverable: a session may legitimately deliver
 * after its brief was cleaned up, so a missing brief never refuses the
 * registration — the result reports it and the delivery summary is the place
 * to correct it.
 * @param ctx - plugin context carrying `ctx.fs`.
 * @param exec - the current tool execution (signal, agent).
 * @param briefRef - the brief path the call declared.
 * @returns one warning line, or none when the brief exists.
 */
export async function briefReferenceWarnings(
  ctx: Context, exec: ToolRunContext, briefRef: string,
): Promise<string[]> {
  try {
    const target = await resolveTarget(ctx, exec, briefRef)
    const info = await ctx.fs.stat(target, exec.signal)
    if (info !== undefined) return []
  } catch (error) {
    return [`brief 参考文件无法读取，登记继续但要修正或省略：${briefRef}（${errorMessage(error)}）`]
  }
  return [`brief 参考文件不存在，登记继续但要修正或省略：${briefRef}`]
}

/**
 * Prefix this tool writes into a reason when the read stopped at `maxCheckBytes`.
 *
 * The cap is a deployment budget rather than a defect in the document, so that
 * reason needs no declared explanation; detecting it here by this tool's own
 * marker keeps the decision independent of any backend's error wording.
 */
export const READ_CAP_REASON_PREFIX = '超过读取上限（too-large）：'

/** The DOCX reader's code for a package that exceeds this deployment's archive budgets. */
const DOCX_BUDGET_PROBLEM = 'too-large'

/**
 * Whether the checker refused a file at a deployment budget rather than failing on its content.
 *
 * Both budgets are `Config` values: the byte cap this tool passes to
 * `ctx.fs.readBytes`, and the DOCX archive budgets it passes to
 * `extractDocxText`. Hitting either says nothing about the document, so the
 * file registers with the budget named in its reason; `not-a-zip`,
 * `malformed-xml`, and `no-text` are properties of the document and still need
 * a declared reason.
 * @param report - the check report of one unreadable file.
 * @returns true when a deployment budget, not the document, stopped the check.
 */
function stoppedAtDeploymentBudget(report: DeliverableCheckReport): boolean {
  const reason = report.reason ?? ''
  // The cap marker is this tool's own prefix on any format's read failure. The
  // DOCX archive code is matched only for a DOCX report: that reason is the
  // reader's problem list, while a text report's reason quotes the source path,
  // where the word could occur in a file name that failed for another reason.
  return reason.includes(READ_CAP_REASON_PREFIX)
    || (report.format === 'docx' && reason.includes(DOCX_BUDGET_PROBLEM))
}

/** What to do about one file the checker could not read, chosen from its reason. */
function unreadableAdvice(report: DeliverableCheckReport): string {
  const reason = report.reason ?? ''
  if (reason.includes('not-a-zip')) return '这不是有效的 docx 包：重新渲染或检查写盘方式'
  if (reason.includes('no-text')) return '包内没有可读正文：检查是否只写了页眉、图片或空正文'
  if (reason.includes('malformed-xml')) return '包内 XML 无法解析：重新渲染该文件'
  return '修复文件后重新登记'
}

/**
 * Whether one declared reason designates the same file as one check report.
 *
 * The declared spellings match exactly, which is how an ack written the way
 * `files[].path` was written attaches. Failing that, two canonical identities
 * match: a workspace-relative `report.md` and an absolute `/work/report.md` are
 * one file, and an ack naming either spelling belongs to it. An ack whose path
 * the registration could not resolve has no identity, so it matches on its
 * spelling alone.
 * @param ack - one declared reason and the canonical path it resolved to, when it did.
 * @param report - one check report, carrying the canonical path of the file it checked.
 * @returns true when the two designate the same deliverable.
 */
function sameDeliverable(
  ack: { path: string; identity?: string }, report: DeliverableCheckReport,
): boolean {
  return ack.path === report.path
    || (ack.identity !== undefined && ack.identity === report.identity)
}

/**
 * Resolve the canonical identity of every declared `unreadable_ack` path.
 *
 * An ack may spell the file differently from `files[].path` — absolute against
 * workspace-relative, a symlink against its target — while meaning the same
 * file. {@link resolveUnreadableReports} compares declarations only, so the
 * caller resolves the ack paths the same way the checks resolved the deliverable
 * paths and passes the results in.
 *
 * An ack path this workspace cannot resolve gets no entry: it then matches on
 * its spelling alone, and one naming no registered file is still reported as
 * unregistered rather than refused, which is what an unreadable_ack naming a
 * ghost path has always done. Cancellation propagates instead of being read as
 * an unresolvable path.
 * @param ctx - plugin context carrying `ctx.fs`.
 * @param exec - the current tool execution (signal, agent).
 * @param spec - the validated registration, carrying any declared reasons.
 * @returns the canonical identity per declared ack path, for the paths that resolved.
 */
export async function resolveAckIdentities(
  ctx: Context, exec: ToolRunContext, spec: DocumentDeliverSpec,
): Promise<ReadonlyMap<string, string>> {
  const identities = new Map<string, string>()
  for (const ack of spec.unreadableAck ?? []) {
    try {
      identities.set(ack.path, ctx.fs.processPath(await resolveTarget(ctx, exec, ack.path)))
    } catch {
      exec.signal.throwIfAborted()
      // An ack path under a non-directory cannot resolve to any file, so no
      // report can be about it; the registration reports it as unregistered.
    }
  }
  return identities
}

/**
 * Require a declared reason for every file the checker could not read.
 *
 * "Not checked" must not read as "checked": an unreadable file is refused
 * unless the call says why it still ships, and the reason is kept beside the
 * check outcome so a reader of the log sees the trade the caller made. The one
 * exception is the deployment's own read cap, which says nothing about the
 * document; an oversized file registers with the cap named in its reason.
 *
 * A reason attaches to the file it designates, not to the spelling it used: with
 * `ackIdentities` (see {@link resolveAckIdentities}) an ack written as an
 * absolute path explains a file the call declared relatively, and the "names no
 * registered path" warning stays quiet for the same file spelled two ways. Two
 * declarations that resolve to one file are one deliverable, so a single ack
 * explains both reports. Without that map this function compares spellings, as
 * a caller with no filesystem access must.
 * @param spec - the validated registration, carrying any declared reasons.
 * @param reports - one check report per declared file, in declaration order.
 * @param ackIdentities - canonical identity per declared ack path, from {@link resolveAckIdentities}; absent when the caller resolved none.
 * @returns the reports with their declared reasons attached, plus warnings for reasons that matched nothing.
 * @throws Error naming every file that needs a reason and what to do about it.
 */
export function resolveUnreadableReports(
  spec: DocumentDeliverSpec, reports: readonly DeliverableCheckReport[],
  ackIdentities?: ReadonlyMap<string, string>,
): { reports: DeliverableCheckReport[]; warnings: string[] } {
  const acks: Array<{ path: string; reasonText: string; identity?: string }> = []
  for (const ack of spec.unreadableAck ?? []) {
    const identity = ackIdentities?.get(ack.path)
    acks.push({ ...ack, ...identity === undefined ? {} : { identity } })
  }
  const resolved: DeliverableCheckReport[] = []
  const needed: DeliverableCheckReport[] = []
  for (const report of reports) {
    if (report.status !== 'unreadable') {
      resolved.push(report)
      continue
    }
    const ack = acks.find(entry => sameDeliverable(entry, report))
    if (ack !== undefined) {
      resolved.push({ ...report, ack: ack.reasonText })
      continue
    }
    if (stoppedAtDeploymentBudget(report)) {
      resolved.push(report)
      continue
    }
    needed.push(report)
    resolved.push(report)
  }
  if (needed.length > 0) {
    throw new HarnessError([
      'document_deliver: 以下交付文件无法核验，且没有 unreadable_ack 说明原因：',
      ...needed.map(report => `- ${report.path}：${report.reason ?? '读取失败'} → ${unreadableAdvice(report)}`),
      '给每个文件补一条 unreadable_ack（path + reason_text）说明为什么仍要交付；修复文件后重新登记也可以。',
    ].join('\n'), 'deliver_unreadable_unacked')
  }
  const warnings: string[] = []
  for (const ack of acks) {
    const designated = reports.filter(report => sameDeliverable(ack, report))
    if (designated.length === 0) {
      warnings.push(`unreadable_ack 指向未登记的路径：${ack.path}`)
      continue
    }
    if (!designated.some(report => report.status === 'unreadable')) {
      warnings.push(`unreadable_ack 的 ${ack.path} 不是无法核验状态，不需要说明原因`)
    }
  }
  return { reports: resolved, warnings }
}


/**
 * Resolve one registered path against the calling session's workspace.
 * @param ctx - plugin context carrying `ctx.fs`.
 * @param exec - the current tool execution (signal, agent).
 * @param path - the path as the call declared it.
 * @returns the resolved target.
 */
export async function resolveTarget(
  ctx: Context, exec: ToolRunContext, path: string,
): Promise<FsTarget> {
  const cwd = exec.agent?.session.header.cwd
  return ctx.fs.resolve(path, {
    ...cwd !== undefined ? { cwd } : {},
    signal: exec.signal,
  })
}
