/**
 * 33 条替代实施方式索引。
 *
 * 每个独立权利要求需要交底原文里已经写明的三条替代：结构等同、步骤替换、
 * 数值上下界。标签必须是这三词，不把「等同结构」「还可以」之类的说法认成替代。
 * 摘录用 `locateQuote` 在交底原文里定位，索引只保留原文切片；定位不到或没有
 * 这条标签就记缺口，不补写。
 *
 * 标签写在同一行（`权利要求1 结构等同：……`），或写在单独的 `权利要求N` 行之下。
 * 权利要求标题之前的标签行不归属任何权项。从属权利要求不要求这三条。
 *
 * @module @deepseek-ai/dsh-patent-tools/tool/amendment-reserve
 */

import { deriveClaimRefs, locateQuote } from '@deepseek-ai/dsh-patent-core'

/** 三条替代的固定标签，顺序即索引顺序。 */
export const AMENDMENT_RESERVE_KINDS = ['结构等同', '步骤替换', '数值上下界'] as const

/** 一条替代实施方式的种类。 */
export type AmendmentReserveKind = (typeof AMENDMENT_RESERVE_KINDS)[number]

/** 一条未能写入索引的替代。 */
export type AmendmentReserveGap = {
  /** 独立权利要求项号。 */
  claim_no: number
  /** 缺失或未能定位的种类。 */
  kind: AmendmentReserveKind
  /** 没有标签、标签后没有正文，或正文在交底原文中定位不到。 */
  reason: 'missing' | 'empty' | 'anchor-not-found'
}

/** 一条已在交底原文中定位的替代。 */
export type AmendmentReserveEntry = {
  /** 独立权利要求项号。 */
  claim_no: number
  /** 替代种类。 */
  kind: AmendmentReserveKind
  /** 摘录所在的实施例序号；不在任一实施例标题下时缺省。 */
  embodiment_index?: number
  /** 交底原文切片。 */
  quote: string
}

/** 调用方提交的候选摘录；正文仍须在交底原文中定位。 */
export type AmendmentReserveCandidate = {
  /** 权利要求项号。 */
  claim_no: number
  /** 替代种类。 */
  kind: AmendmentReserveKind
  /** 候选摘录。 */
  quote: string
}

/** 索引输入。给出 `reserves` 时不再扫描原文标签。 */
export type AmendmentReserveInput = {
  /** 交底原文。 */
  sourceText: string
  /** 权利要求书原文。没有行首编号时无法判断独权，检查记为未评估。 */
  claimsText: string
  /** 候选摘录。缺省时扫描原文中的三条标签。 */
  reserves?: readonly AmendmentReserveCandidate[]
}

/** 索引结果。`indexText` 只含已定位的原文切片。 */
export type AmendmentReserveResult = {
  /** 通过、因缺口未通过，或权利要求书没有可判断的独立权利要求。 */
  status: 'passed' | 'failed' | 'not-assessed'
  /** 已定位的替代，按权项号与种类顺序排列。 */
  entries: AmendmentReserveEntry[]
  /** 未写入索引的替代。 */
  gaps: AmendmentReserveGap[]
  /** 实施例索引正文；没有已定位条目时为空串。 */
  indexText: string
}

const KIND_PATTERN = AMENDMENT_RESERVE_KINDS.join('|')
const SAME_LINE_RE = new RegExp(`^权利要求\\s*(\\d+)\\s*(${KIND_PATTERN})\\s*[：:]\\s*(.*)$`)
const CLAIM_HEAD_RE = /^权利要求\s*(\d+)\s*$/
const KIND_LINE_RE = new RegExp(`^(${KIND_PATTERN})\\s*[：:]\\s*(.*)$`)

/**
 * 把正则捕获的标签收窄为三种之一。
 * @param value - 捕获文本。
 * @returns 三种标签之一；捕获与标签表不一致时返回 undefined。
 */
function reserveKind(value: string | undefined): AmendmentReserveKind | undefined {
  return AMENDMENT_RESERVE_KINDS.find(kind => kind === value)
}

/**
 * 读出独立权利要求项号。
 * @param claimsText - 权利要求书原文。
 * @returns 项号；原文没有行首编号，或每条都是从权时返回 undefined。
 */
function independentClaimNumbers(claimsText: string): number[] | undefined {
  const refs = deriveClaimRefs(claimsText)
  if (refs.length === 0) return undefined
  const numbers = refs.filter(ref => ref.claimType === 'independent').map(ref => ref.claimNo)
  return numbers.length === 0 ? undefined : numbers
}

/**
 * 按行扫描三条固定标签。
 * @param sourceText - 交底原文。
 * @returns 按出现顺序的候选摘录。同一权项同一标签可出现多次，调用方取第一次。
 */
function scanCandidates(sourceText: string): AmendmentReserveCandidate[] {
  const found: AmendmentReserveCandidate[] = []
  let currentClaim: number | undefined
  for (const rawLine of sourceText.split('\n')) {
    const line = rawLine.trim()
    const sameLine = SAME_LINE_RE.exec(line)
    if (sameLine !== null) {
      const kind = reserveKind(sameLine[2])
      /* v8 ignore next -- 同行正则只捕获三种标签 */
      if (kind === undefined) continue
      currentClaim = Number(sameLine[1])
      /* v8 ignore next -- 同行正则的正文捕获组总在 */
      const sameLineQuote = sameLine[3] ?? ''
      found.push({ claim_no: currentClaim, kind, quote: sameLineQuote.trim() })
      continue
    }
    const heading = CLAIM_HEAD_RE.exec(line)
    if (heading !== null) {
      currentClaim = Number(heading[1])
      continue
    }
    const kindLine = KIND_LINE_RE.exec(line)
    if (kindLine === null || currentClaim === undefined) continue
    const kind = reserveKind(kindLine[1])
    /* v8 ignore next -- 单行正则只捕获三种标签 */
    if (kind === undefined) continue
    /* v8 ignore next -- 单行正则的正文捕获组总在 */
    const kindQuote = kindLine[2] ?? ''
    found.push({ claim_no: currentClaim, kind, quote: kindQuote.trim() })
  }
  return found
}

/**
 * 找包含该摘录的最早实施例。
 * @param sourceText - 交底原文。
 * @param quote - 已定位的原文切片。
 * @returns 实施例序号；摘录不在任一实施例标题之下时返回 undefined。
 */
function embodimentIndex(sourceText: string, quote: string): number | undefined {
  const headingRe = /(?:^|\n)[ \t]*(?:#{1,6}[ \t]*)?(?:实施例|实施方式)[ \t]*(\d+)[^\n]*/g
  const matches = [...sourceText.matchAll(headingRe)]
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]
    /* v8 ignore next -- matchAll 的命中项总有下标 */
    if (match?.index === undefined) continue
    const next = matches[index + 1]
    // 标题行本身可以写下该实施例的方案，摘录算在这一段里，而不是只算标题之后的换行。
    const body = sourceText.slice(match.index, next?.index ?? sourceText.length)
    if (!locateQuote(quote, body).matched) continue
    const rawNumber = match[1]
    /* v8 ignore next -- 实施例标题的捕获组必有数字 */
    if (rawNumber === undefined) continue
    return Number(rawNumber)
  }
  return undefined
}

/**
 * 把候选摘录定位到交底原文。
 * @param sourceText - 交底原文。
 * @param candidate - 候选摘录。
 * @returns 原文切片，或不能写入索引的原因。
 */
function locateEntry(
  sourceText: string,
  candidate: AmendmentReserveCandidate,
): { ok: true; entry: AmendmentReserveEntry } | { ok: false; reason: 'empty' | 'anchor-not-found' } {
  const quote = candidate.quote.trim()
  if (quote.length === 0) return { ok: false, reason: 'empty' }
  const anchor = locateQuote(quote, sourceText)
  if (!anchor.matched) return { ok: false, reason: 'anchor-not-found' }
  const range = anchor.range
  /* v8 ignore next -- matched 时 locateQuote 带回原文区间 */
  if (range === undefined) return { ok: false, reason: 'anchor-not-found' }
  const slice = sourceText.slice(range.start, range.end)
  const index = embodimentIndex(sourceText, slice)
  return {
    ok: true,
    entry: {
      claim_no: candidate.claim_no,
      kind: candidate.kind,
      ...(index === undefined ? {} : { embodiment_index: index }),
      quote: slice,
    },
  }
}

/**
 * 渲染实施例索引。没有实施例序号时不留空列。
 * @param entries - 已定位的替代。
 * @returns 索引正文。
 */
function formatIndex(entries: readonly AmendmentReserveEntry[]): string {
  return entries.map((entry) => {
    const place = entry.embodiment_index === undefined ? '' : `实施例${entry.embodiment_index}｜`
    return `权利要求${entry.claim_no}｜${entry.kind}｜${place}${entry.quote}`
  }).join('\n')
}

const GAP_REASON_TEXT: Record<AmendmentReserveGap['reason'], string> = {
  missing: '交底原文没有这条替代',
  empty: '标签后没有可定位的正文',
  'anchor-not-found': '摘录未命中交底原文',
}

/**
 * 渲染给人工复核看的替代实施方式报告。
 * @param result - 索引结果。
 * @returns 通过、未通过或未执行的报告。未通过只列缺口，不补写摘录。
 */
export function renderAmendmentReserveReport(result: AmendmentReserveResult): string {
  if (result.status === 'not-assessed') {
    return '33 条替代实施方式：未执行（权利要求书没有可解析的独立权利要求）'
  }
  if (result.status === 'passed') return `33 条替代实施方式：通过\n${result.indexText}`
  const lines = result.gaps.map(gap => `权利要求${gap.claim_no} ${gap.kind}：${GAP_REASON_TEXT[gap.reason]}`)
  return `33 条替代实施方式：未通过\n${lines.join('\n')}`
}

/**
 * 说明书警告：只点明哪一条没有定位到，不写入替代正文。
 * @param result - 索引结果。
 * @returns 未通过时的警告；通过或未评估时为空。
 */
export function amendmentReserveWarnings(result: AmendmentReserveResult): string[] {
  if (result.status !== 'failed') return []
  return result.gaps.map(gap => `权利要求${gap.claim_no}的${gap.kind}未在交底原文中定位`)
}

/**
 * 为每条独立权利要求建立三条替代的实施例索引。
 *
 * 未评估时不产生条目和缺口：权利要求书没有可判断的独立权利要求，或没有交底原文
 * 可供定位。已评估但有缺项时 `status` 为 `failed`，索引只含已经定位的原文，不含
 * 补写句子。
 * @param input - 交底原文、权利要求书，以及可选的候选摘录。
 * @returns 索引、缺口与是否通过。
 */
export function buildAmendmentReserve(input: AmendmentReserveInput): AmendmentReserveResult {
  const independents = independentClaimNumbers(input.claimsText)
  if (independents === undefined || input.sourceText.trim().length === 0) {
    return { status: 'not-assessed', entries: [], gaps: [], indexText: '' }
  }
  const candidates = input.reserves ?? scanCandidates(input.sourceText)
  const entries: AmendmentReserveEntry[] = []
  const gaps: AmendmentReserveGap[] = []
  for (const claimNo of independents) {
    for (const kind of AMENDMENT_RESERVE_KINDS) {
      const candidate = candidates.find(item => item.claim_no === claimNo && item.kind === kind)
      if (candidate === undefined) {
        gaps.push({ claim_no: claimNo, kind, reason: 'missing' })
        continue
      }
      const located = locateEntry(input.sourceText, candidate)
      if (!located.ok) {
        gaps.push({ claim_no: claimNo, kind, reason: located.reason })
        continue
      }
      entries.push(located.entry)
    }
  }
  return {
    status: gaps.length === 0 ? 'passed' : 'failed',
    entries,
    gaps,
    indexText: formatIndex(entries),
  }
}
