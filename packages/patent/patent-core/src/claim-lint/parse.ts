/**
 * src/claim-lint — 权利要求书文本解析。
 *
 * 输入是工作区的 markdown 权利要求书（标题、说明、对照表都可能混在其中），输出按
 * 项切分的权利要求与权利要求正文之外的行。切分只认行首的「数字 + 句点/顿号」，
 * 因此项内的编号列表（「1）」「（1）」）不会被误当成新的一项。
 *
 * 引用部分由 `references.ts` 的单一解析识别：句式、全角数字与区间展开与对比表引擎
 * 共用一处，避免同一句权利要求在两个工具里得到相反的独立／从属结论。形式自检只认
 * 从正文开头开始的引用语——正文中途的「权利要求 1 所述」是交叉引用。
 *
 * 折行按中文直接拼接：权利要求书是中文文书，行末断字不产生词间空格；英文词被
 * 折行切断的能力损失由此换来，起诉状需要时再按语言分支处理。
 */

import { findClaimReference, toHalfWidth } from './references.ts'
import type { ParsedClaim } from './types.ts'

/** 权利要求行首：`1.` / `2、` / `3．`，编号后可有空白，且分隔符后必须还有正文。 */
const CLAIM_START = /^\d+\s*[.、．]\s*(?=\S)/

/** 非权利要求正文的行首：标题、引用块、表格、分隔线、图片。 */
const EXTRANEOUS_LINE = /^(?:#{1,6}(?:\s|$)|>|\||-{3,}|\*\*\*|!\[)/

/** 正文中的交叉引用：「权利要求 N 所述」。 */
const CROSS_REFERENCE = /权利要求\s*\d+\s*所述/g

/** 从属权利要求的主题名称：引用部分「所述（的）」之后至标点。 */
const DEPENDENT_SUBJECT = /所述(?:的)?([^，,；。]+)/

/** 独立权利要求的主题名称：「一种」之后至标点。 */
const INDEPENDENT_SUBJECT = /^一种([^，,；。]+)/

/** 解析结果：权利要求 + 正文之外的行。 */
export type ParsedClaimDocument = {
  /** 按原文顺序切分的权利要求。 */
  claims: ParsedClaim[]
  /** 权利要求正文之外的行（标题、说明、表格等），行号自 1 起。 */
  extraneous: Array<{ line: number; text: string }>
}

/**
 * 取主题名称。
 * @param text - 权利要求全文。
 * @param dependent - 是否为从属权利要求。
 * @returns 主题名称；无法识别时为空串。
 */
function subjectOf(text: string, dependent: boolean): string {
  const match = (dependent ? DEPENDENT_SUBJECT : INDEPENDENT_SUBJECT).exec(text)
  const subject = match?.[1] ?? ''
  return subject.trim()
}

/**
 * 由序号与全文构造一项权利要求。
 * @param number - 原文所写的序号。
 * @param text - 拼接后的全文。
 * @param earlierClaimNos - 编号更小的权项号，供概括引用展开。
 * @returns 解析后的权利要求。
 */
function buildClaim(number: number, text: string, earlierClaimNos: readonly number[]): ParsedClaim {
  const reference = findClaimReference(text, earlierClaimNos, 'clause-start')
  const references = reference?.refersTo ?? []
  const cross = new Set<number>()
  for (const match of toHalfWidth(text).matchAll(CROSS_REFERENCE)) {
    const target = Number(match[0].replace(/\D/g, ''))
    if (target !== number && !references.includes(target)) cross.add(target)
  }
  return {
    number,
    text,
    independent: reference === undefined,
    referenceClause: reference?.clause ?? null,
    references,
    ...(reference !== undefined && reference.defects.length > 0 ? { referenceDefects: reference.defects } : {}),
    crossReferences: [...cross].sort((a, b) => a - b),
    subject: subjectOf(text, reference !== undefined),
  }
}

/**
 * 把权利要求书文本切分为权利要求与正文之外的行。
 * @param source - 权利要求书全文（markdown 或纯文本）。
 * @returns 权利要求列表与正文之外的行。
 */
export function parseClaimDocument(source: string): ParsedClaimDocument {
  const raw: Array<{ number: number; lines: string[] }> = []
  const extraneous: ParsedClaimDocument['extraneous'] = []
  let current: { number: number; lines: string[] } | null = null
  const flush = (): void => {
    if (current === null) return
    raw.push(current)
    current = null
  }
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim()
    if (line === '') continue
    const start = CLAIM_START.exec(line)
    if (start !== null) {
      flush()
      current = { number: Number.parseInt(line, 10), lines: [line.slice(start[0].length)] }
      continue
    }
    if (EXTRANEOUS_LINE.test(line)) {
      flush()
      extraneous.push({ line: index + 1, text: line })
      continue
    }
    if (current !== null) {
      current.lines.push(line)
      continue
    }
    extraneous.push({ line: index + 1, text: line })
  }
  flush()
  const claimNos = raw.map(entry => entry.number)
  const claims = raw.map(entry =>
    buildClaim(entry.number, entry.lines.join(''), claimNos.filter(claimNo => claimNo < entry.number)),
  )
  return { claims, extraneous }
}
