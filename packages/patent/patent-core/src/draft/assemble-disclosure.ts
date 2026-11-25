/**
 * 披露工作流成功终态 → {@link SpecDraft}。
 *
 * 纯函数：只读终态里已有的文本键，不调用模型，也不补写缺字段。
 * 成功终态仍可使用 `claims_draft`、`specification` 等文本键；本函数是把它们收成
 * 通过 {@link validateSpecDraft} 的唯一步骤。
 */

import {
  SPEC_PART_HEADINGS,
  SPEC_PART_ORDER,
  type DraftBlock,
  type SpecDraft,
  type SpecPartId,
} from './types.ts'
import { validateSpecDraft } from './validate.ts'

/** 终态装配失败：聚合全部缺口，调用方读 {@link DisclosureAssemblyError.gaps}。 */
export class DisclosureAssemblyError extends Error {
  /** 逐条缺口（终态键或说明书章节）。 */
  readonly gaps: readonly string[]

  /**
   * @param gaps - 已收集的缺口，至少一条。
   */
  constructor(gaps: readonly string[]) {
    super(`披露终态无法装配成 SpecDraft（${gaps.length} 项）：\n- ${gaps.join('\n- ')}`)
    this.name = 'DisclosureAssemblyError'
    this.gaps = gaps
  }
}

/** 读取结果：失败不再携带值，避免用缺省值继续装配。 */
type Read<T> = { ok: true; value: T } | { ok: false }

/** 权利要求行首项号：`1.`、`1、`、`1．`。去掉后才是 SpecDraft 的项正文。 */
const CLAIM_ITEM_PREFIX = /^\d+\s*[.、．]\s*/

/** 附图说明行首图号。渲染器写成「图N为」，草案只保留图名与描述。 */
const DRAWING_ITEM_PREFIX = /^(?:图|附图)\s*(?:\d+|[一二三四五六七八九十百]+)\s*(?:为|是|：|:)?\s*/

/** 附图说明句末标点，由渲染器生成，不进入草案。 */
const DRAWING_TERMINAL_PUNCTUATION = /[。；;]\s*$/

const PART_BY_HEADING = new Map<string, SpecPartId>(
  SPEC_PART_ORDER.map(partId => [SPEC_PART_HEADINGS[partId], partId]),
)

/**
 * 把披露工作流成功终态装配成通过 {@link validateSpecDraft} 的 {@link SpecDraft}。
 *
 * 终态键：`caseId`、`draft_title`、`applicant`、`inventor`、`agent`、`date`、
 * `claims_draft`、`abstract`、`figure_files`、`specification`。`abstractFigure` 可缺省。
 * `figure_files` 可以是空数组（无附图，且说明书不写「附图说明」）。
 * 其它终态键忽略。本函数不写会话、不写文件。
 * @param state - 披露链成功终态。键缺失或空白时失败，不代入别的键。
 * @returns 已通过 {@link validateSpecDraft} 的草案。
 * @throws {DisclosureAssemblyError} 终态缺键、空白，或说明书章节无法对应五部分。
 * @throws {DraftValidationError} 装配结果违反草案规则（如图文条数不一致）。
 */
export function assembleDisclosureSpecDraft(state: Readonly<Record<string, unknown>>): SpecDraft {
  const gaps: string[] = []
  const caseNumber = readRequiredText(state, 'caseId', gaps)
  const title = readRequiredText(state, 'draft_title', gaps)
  const applicant = readRequiredText(state, 'applicant', gaps)
  const inventor = readRequiredText(state, 'inventor', gaps)
  const agent = readRequiredText(state, 'agent', gaps)
  const date = readRequiredText(state, 'date', gaps)
  const claimsText = readRequiredText(state, 'claims_draft', gaps)
  const specificationText = readRequiredText(state, 'specification', gaps)
  const abstractText = readRequiredText(state, 'abstract', gaps)
  const figureFiles = readFigureFiles(state, gaps)
  const abstractFigure = readAbstractFigure(state, gaps)
  const claims = claimsText.ok ? readClaims(claimsText.value, gaps) : { ok: false as const }
  const abstract = abstractText.ok ? readAbstract(abstractText.value) : { ok: false as const }
  const sections = specificationText.ok
    ? readSections(specificationText.value, figureFiles.ok ? figureFiles.value.length : undefined, gaps)
    : { ok: false as const }

  if (
    !caseNumber.ok || !title.ok || !applicant.ok || !inventor.ok || !agent.ok || !date.ok
    || !claims.ok || !abstract.ok || !figureFiles.ok || !abstractFigure.ok || !sections.ok
  ) {
    throw new DisclosureAssemblyError(gaps)
  }

  return validateSpecDraft({
    meta: {
      caseNumber: caseNumber.value,
      title: title.value,
      applicant: applicant.value,
      inventor: inventor.value,
      agent: agent.value,
      date: date.value,
    },
    claims: claims.value,
    abstract: abstract.value,
    figureFiles: figureFiles.value,
    ...(abstractFigure.value !== undefined ? { abstractFigure: abstractFigure.value } : {}),
    sections: sections.value,
  })
}

/**
 * 读取必填非空字符串。
 * @param state - 终态。
 * @param key - 终态键。
 * @param gaps - 缺口收集器。
 * @returns 去掉首尾空白的文本；缺失、非字符串或空白时 `ok: false`。
 */
function readRequiredText(state: Readonly<Record<string, unknown>>, key: string, gaps: string[]): Read<string> {
  if (!Object.hasOwn(state, key)) {
    gaps.push(`${key} 缺失`)
    return { ok: false }
  }
  const value = state[key]
  if (typeof value !== 'string') {
    gaps.push(`${key} 必须是字符串`)
    return { ok: false }
  }
  const text = value.trim()
  if (text.length === 0) {
    gaps.push(`${key} 为空`)
    return { ok: false }
  }
  return { ok: true, value: text }
}

/**
 * 按项号拆开 `claims_draft`，去掉项号。续行并入当前项。
 * @param text - 已确认为非空的权利要求全文。
 * @param gaps - 缺口收集器。
 * @returns 不带项号的权利要求；任一项无法拆开时 `ok: false`。
 */
function readClaims(text: string, gaps: string[]): Read<string[]> {
  const claims: string[] = []
  let current: string[] | undefined
  let ok = true
  const flush = (): void => {
    if (current === undefined) return
    const body = current.join('\n').trim()
    const index = claims.length + 1
    current = undefined
    if (body.length === 0) {
      gaps.push(`claims_draft 第 ${index} 项去掉项号后为空`)
      ok = false
      return
    }
    claims.push(body)
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const prefix = CLAIM_ITEM_PREFIX.exec(trimmed)
    if (prefix !== null) {
      flush()
      const body = trimmed.slice(prefix[0].length).trim()
      current = body.length > 0 ? [body] : []
      continue
    }
    if (current === undefined) {
      gaps.push(`claims_draft 第 ${claims.length + 1} 项缺少项号，无法去掉项号后装配`)
      ok = false
      continue
    }
    current.push(trimmed)
  }
  flush()
  return ok ? { ok: true, value: claims } : { ok: false }
}

/**
 * 按空行拆开摘要。调用前文本已非空，因此至少有一段。
 * @param text - 已确认为非空的摘要。
 * @returns 摘要段落。
 */
function readAbstract(text: string): Read<string[]> {
  const paragraphs = text.split(/\n\s*\n/).map(part => part.trim()).filter(part => part.length > 0)
  return { ok: true, value: paragraphs }
}

/**
 * 读取 `figure_files`。空数组表示无附图，不是缺省补上的空列表。
 * @param state - 终态。
 * @param gaps - 缺口收集器。
 * @returns 非空路径；键缺失或项不合法时 `ok: false`。
 */
function readFigureFiles(state: Readonly<Record<string, unknown>>, gaps: string[]): Read<string[]> {
  if (!Object.hasOwn(state, 'figure_files')) {
    gaps.push('figure_files 缺失')
    return { ok: false }
  }
  const value = state.figure_files
  if (!Array.isArray(value)) {
    gaps.push('figure_files 必须是字符串数组')
    return { ok: false }
  }
  const files: string[] = []
  let ok = true
  for (const [index, item] of value.entries()) {
    if (typeof item !== 'string') {
      gaps.push(`figure_files[${index}] 必须是字符串`)
      ok = false
      continue
    }
    const text = item.trim()
    if (text.length === 0) {
      gaps.push(`figure_files[${index}] 为空`)
      ok = false
      continue
    }
    files.push(text)
  }
  return ok ? { ok: true, value: files } : { ok: false }
}

/**
 * 读取可选的 `abstractFigure`。键不存在则不写入草案，不默认成第 1 幅。
 * @param state - 终态。
 * @param gaps - 缺口收集器。
 * @returns 图号；键存在但不是非空字符串时 `ok: false`。
 */
function readAbstractFigure(state: Readonly<Record<string, unknown>>, gaps: string[]): Read<string | undefined> {
  if (!Object.hasOwn(state, 'abstractFigure')) return { ok: true, value: undefined }
  const value = state.abstractFigure
  if (typeof value !== 'string') {
    gaps.push('abstractFigure 必须是字符串')
    return { ok: false }
  }
  const text = value.trim()
  if (text.length === 0) {
    gaps.push('abstractFigure 为空')
    return { ok: false }
  }
  return { ok: true, value: text }
}

/**
 * 从行首读取 Markdown 二级标题。不是标题时返回 undefined。
 * @param line - 已去掉首尾空白的行。
 * @returns 标题文字。
 */
function headingTitle(line: string): string | undefined {
  const matched = /^##\s+(\S.*?)\s*$/.exec(line)
  if (matched === null) return undefined
  return matched[1]
}

/**
 * 把说明书 Markdown 收成五部分块。
 * 只认 `##` 加 {@link SPEC_PART_HEADINGS} 的标题。`**警告**` 及其后的行不进入正文。
 * @param text - 已确认为非空的说明书 Markdown。
 * @param figureCount - `figure_files` 项数；该键本身不合法时为 undefined，此时不据此要求附图说明。
 * @param gaps - 缺口收集器。
 * @returns 五部分；缺章节或章节为空时 `ok: false`。
 */
function readSections(
  text: string,
  figureCount: number | undefined,
  gaps: string[],
): Read<Record<SpecPartId, DraftBlock[]>> {
  const gapsBefore = gaps.length
  const found = new Map<SpecPartId, string[]>()
  let bucket: string[] | undefined
  let stopped = false
  for (const line of text.split(/\r?\n/)) {
    if (stopped) break
    const trimmed = line.trim()
    if (trimmed === '**警告**') {
      stopped = true
      continue
    }
    const title = headingTitle(trimmed)
    if (title !== undefined) {
      const partId = PART_BY_HEADING.get(title)
      if (partId === undefined) {
        gaps.push(`specification 未知章节「${title}」`)
        bucket = undefined
        continue
      }
      if (found.has(partId)) {
        gaps.push(`specification 重复章节「${SPEC_PART_HEADINGS[partId]}」`)
        bucket = undefined
        continue
      }
      bucket = []
      found.set(partId, bucket)
      continue
    }
    if (bucket !== undefined) bucket.push(line)
  }

  const sections: Partial<Record<SpecPartId, DraftBlock[]>> = {}
  let ok = true
  for (const partId of SPEC_PART_ORDER) {
    const bodyLines = found.get(partId)
    const drawingRequired = figureCount !== undefined && figureCount > 0
    const required = partId !== 'drawingDescriptions' || drawingRequired
    if (bodyLines === undefined) {
      if (required) {
        gaps.push(`specification 缺少「${SPEC_PART_HEADINGS[partId]}」`)
        ok = false
      } else {
        sections[partId] = []
      }
      continue
    }
    const blocks = partId === 'drawingDescriptions'
      ? readDrawingBlocks(bodyLines, gaps)
      : readParagraphBlocks(partId, bodyLines, gaps)
    if (!blocks.ok) {
      ok = false
      continue
    }
    sections[partId] = blocks.value
  }
  if (!ok || gaps.length > gapsBefore) return { ok: false }
  // 五个章节都已写入；缺任一章节时 ok 已为 false。
  return { ok: true, value: sections as Record<SpecPartId, DraftBlock[]> }
}

/**
 * 非附图说明章节：空行分段，每段一个 paragraph。
 * @param partId - 章节 id。
 * @param lines - 标题之下、下一标题之前的原始行。
 * @param gaps - 缺口收集器。
 * @returns 段落块；整节空白时 `ok: false`。
 */
function readParagraphBlocks(partId: SpecPartId, lines: readonly string[], gaps: string[]): Read<DraftBlock[]> {
  const text = lines.join('\n').trim()
  if (text.length === 0) {
    gaps.push(`specification「${SPEC_PART_HEADINGS[partId]}」为空`)
    return { ok: false }
  }
  const paragraphs = text.split(/\n\s*\n/).map(part => part.trim()).filter(part => part.length > 0)
  return { ok: true, value: paragraphs.map(paragraph => ({ kind: 'paragraph', text: paragraph })) }
}

/**
 * 附图说明：每个非空行一条列表项，去掉图号前缀与句末标点。
 * @param lines - 附图说明标题下的原始行。
 * @param gaps - 缺口收集器。
 * @returns 一个 list 块；没有条目或某条去掉图号后为空时 `ok: false`。
 */
function readDrawingBlocks(lines: readonly string[], gaps: string[]): Read<DraftBlock[]> {
  const items: string[] = []
  let ok = true
  let seen = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    seen += 1
    const item = trimmed.replace(DRAWING_ITEM_PREFIX, '').replace(DRAWING_TERMINAL_PUNCTUATION, '').trim()
    if (item.length === 0) {
      gaps.push(`specification「${SPEC_PART_HEADINGS.drawingDescriptions}」第 ${seen} 条去掉图号后为空`)
      ok = false
      continue
    }
    items.push(item)
  }
  if (seen === 0) {
    gaps.push(`specification「${SPEC_PART_HEADINGS.drawingDescriptions}」为空`)
    return { ok: false }
  }
  return ok ? { ok: true, value: [{ kind: 'list', items }] } : { ok: false }
}
