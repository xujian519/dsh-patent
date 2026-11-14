/**
 * 宪法规则引擎 — 评估器。
 *
 * 对文本逐条执行规则检查，产出 RuleViolation[]。全部为确定性规则检查
 * （无 LLM 调用），用于输出门禁与工具拦截的底层判定。
 * @module @deepseek-ai/dsh-patent-rule/runtime/RuleEngine
 */

import type {
  CitationAnalysisCheck,
  ConstitutionalRule,
  EmptySectionCheck,
  KeywordBlocklistCheck,
  PatternAnalysisCheck,
  QuoteRepetitionCheck,
  RuleEvaluation,
  RuleSeverity,
  RuleSet,
  RuleViolation,
  SentenceRepetitionCheck,
  StructuralAnalysisCheck,
} from '@deepseek-ai/dsh-patent-core'
import { hasNegationContext, locateMatch, locationAt } from '@deepseek-ai/dsh-patent-core'
import { extractLawReferences, loadLawBaselines } from '@deepseek-ai/dsh-patent-law'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { checkSynonymRequirements, type SynonymMap } from './synonym-engine.ts'

/** 证据截断长度。 */
const EVIDENCE_MAX = 80

/**
 * 规则正则按「pattern + flags」缓存：同一份规则集会在长文上反复评估，
 * 每条规则每次 `new RegExp` 的开销没有必要。加载期已校验语法，缓存未命中时
 * 仍防御性返回 null；带 g 的正则使用前重置 lastIndex。
 */
const REGEX_CACHE = new Map<string, RegExp>()

function regexOf(pattern: string, flags: string): RegExp | null {
  const key = `${flags}\u0000${pattern}`
  const cached = REGEX_CACHE.get(key)
  if (cached !== undefined) return cached
  try {
    const compiled = new RegExp(pattern, flags)
    REGEX_CACHE.set(key, compiled)
    return compiled
  } catch {
    return null
  }
}

function truncate(text: string): string {
  return text.length > EVIDENCE_MAX ? `${text.slice(0, EVIDENCE_MAX)}…` : text
}

/** 成对引号（开→闭），引文豁免与引文重复统计共用同一套配对规则。 */
const QUOTE_PAIRS: ReadonlyArray<readonly [open: string, close: string]> = [
  ['「', '」'],
  ['『', '』'],
  ['“', '”'],
]

/**
 * 计算引述范围（内容区间，半开）。同种引号可嵌套，异种引号按最近配对闭合；
 * 未闭合的开引号不产生范围——宁可误报，不静默放行红线命中。
 * @param text - 待扫描文本。
 * @returns 引述内容区间列表（按出现顺序）。
 */
function quotedSpans(text: string): Array<readonly [number, number]> {
  const openToClose = new Map(QUOTE_PAIRS.map(([open, close]) => [open, close]))
  const closeToOpen = new Map(QUOTE_PAIRS.map(([open, close]) => [close, open]))
  const stack: Array<{ open: string; at: number }> = []
  const spans: Array<readonly [number, number]> = []
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    /* v8 ignore next -- index is in range; the undefined arm only satisfies noUncheckedIndexedAccess. */
    if (ch === undefined) break
    if (openToClose.has(ch)) {
      stack.push({ open: ch, at: i })
      continue
    }
    const opener = closeToOpen.get(ch)
    if (opener === undefined) continue
    for (let k = stack.length - 1; k >= 0; k -= 1) {
      const entry = stack[k]
      /* v8 ignore next -- k is within the stack. */
      if (entry?.open !== opener) continue
      spans.push([entry.at + 1, i])
      stack.length = k
      break
    }
  }
  return spans
}

/**
 * 引述位置掩码（1 = 落在成对引号内）；仅在规则声明 quoteImmune 时构造。
 * @param text - 待扫描文本。
 * @returns 与文本等长的掩码。
 */
function quoteMask(text: string): Uint8Array {
  const mask = new Uint8Array(text.length)
  for (const [start, end] of quotedSpans(text)) mask.fill(1, start, end)
  return mask
}

/**
 * 一条计入违规的 keyword_blocklist 命中：词与它在文本中的起始下标。
 * 下标是豁免判定与定位共用的产物，故一并留下——只留词的话，定位只能反查字面，
 * 会落到被豁免的那一处。
 */
type KeywordHit = {
  /** 命中的词。 */
  word: string
  /** 命中词在文本中的起始下标。 */
  index: number
}

/** 检查单个 keyword_blocklist 条目（"a|b|c" OR 组），返回计入违规的命中。 */
function checkKeywordEntry(
  entry: string,
  text: string,
  negationContext: boolean,
  adjacentWords: readonly string[] | undefined,
  immunity: Uint8Array | undefined,
): KeywordHit[] {
  const alternatives = entry
    .split('|')
    .map(s => s.trim())
    .filter(s => s.length > 0)
  if (alternatives.length === 0) return []
  const hits: KeywordHit[] = []
  // 默认否定词表由 hasNegationContext 自己填，这里只补领域前缀表；可选属性在
  // exactOptionalPropertyTypes 下不接受显式 undefined，故按需构造一次（循环不变量）。
  const contextOptions = adjacentWords === undefined ? undefined : { adjacentWords }
  let searchFrom = 0
  let guard = 0
  while (searchFrom < text.length && guard < 200) {
    guard += 1
    let best: { index: number; word: string } | null = null
    for (const word of alternatives) {
      const index = text.indexOf(word, searchFrom)
      if (index >= 0 && (best === null || index < best.index)) best = { index, word }
    }
    if (best === null) break
    const quoted = immunity !== undefined && immunity[best.index] === 1
    if (!quoted && (!negationContext || !hasNegationContext(text, best.index, contextOptions))) {
      hits.push({ word: best.word, index: best.index })
    }
    searchFrom = best.index + best.word.length
  }
  return hits
}

function checkKeywordBlocklist(check: KeywordBlocklistCheck, text: string): KeywordHit[] {
  // 两个键正交：`negationContext` 是唯一的开关，`additionalNegationWords` 只提供词。
  // 「声明了词却没开开关」由 RuleLoader 的加载校验与补丁路径告警（不在这里静默开启，
  // 否则 `negationContext: false` + 词表这种自相矛盾的组合会变成"词表说了算"，读代码看不出来谁生效）。
  // 领域词走 adjacentWords（紧邻前缀）而非并入 DEFAULT_NEGATION_WORDS：后者是**全局**词表，
  // 并入会同时放大所有否定语境规则（PAT-RISK-001 / PAT-ABS-001 / INV-EVIDENCE-001 …）
  // 的放行面，且 24 字窗口会让「防」这类单字前缀对窗口内任意命中生效。
  const negationContext = check.negationContext === true
  const immunity = check.quoteImmune === true ? quoteMask(text) : undefined
  const hits: KeywordHit[] = []
  for (const entry of check.keywords) {
    hits.push(
      ...checkKeywordEntry(entry, text, negationContext, check.additionalNegationWords, immunity),
    )
  }
  return hits
}

/**
 * 引文重复检查：统计长度达标的引述片段，同一片段出现达到阈值即违规。
 * 片段按「忽略空白与省略号后逐字相同」归一，故「……<截断>」写法与完整引用算同一条。
 */
function checkQuoteRepetition(check: QuoteRepetitionCheck, text: string): string[] {
  const minLength = check.minLength ?? 12
  const minOccurrences = check.minOccurrences ?? 2
  const seen = new Map<string, { quote: string; count: number }>()
  for (const [start, end] of quotedSpans(text)) {
    const quote = text.slice(start, end)
    if (quote.length < minLength) continue
    const key = quote.replace(/\s+/g, '').replace(/…+/g, '')
    const entry = seen.get(key)
    if (entry === undefined) {
      seen.set(key, { quote, count: 1 })
    } else {
      entry.count += 1
    }
  }
  const evidence: string[] = []
  for (const { quote, count } of seen.values()) {
    if (count >= minOccurrences) evidence.push(`${quote}（${count} 次）`)
  }
  return evidence
}

/**
 * 视为「没有正文」的占位语（归一后的形态：小写、无空白、无括号、无句末标点）。
 *
 * 表里放的是编辑实稿里真出现过的写法。判定是**整段逐字相等**，故收窄词表不会误伤
 * 「无。理由如下……」这类带说明的答复；不收「不适用」是因为它在实务里常是格式要求
 * 的一部分（「本次修改：不适用」），删掉会改变官方格式的节次结构，不是可删的空节。
 */
const EMPTY_SECTION_PLACEHOLDERS: readonly string[] = [
  '无',
  '无内容',
  '本节无内容',
  '暂无',
  '略',
  'n/a',
  '—',
  '——',
]

/** 归一分节占位语：去空白、去包裹式括号、去句末标点、统一小写。 */
function normalizePlaceholder(text: string): string {
  return text
    .replace(/\s+/gu, '')
    .replace(/[（）()【】[\]]/gu, '')
    .replace(/[。.！!？?；;]+$/gu, '')
    .toLowerCase()
}

/** 一个标题的层级、可读标题与其在全文中的区间（`end` 为标题行末尾）。 */
type HeadingHit = {
  level: number
  title: string
  start: number
  end: number
}

/** Markdown ATX 标题（`## 标题`）；缩进至多三格，与 CommonMark 一致。 */
const MD_HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u

/** 围栏代码块的起始行（``` 或 ~~~）；块内的 `#` 不是标题。 */
const FENCE_LINE = /^\s{0,3}(?:```|~~~)/u

/** HTML 标题（`<h2>…</h2>`），与模板渲染出的成品同形。 */
const HTML_HEADING = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/giu

/** 去掉行内标签，用于把 HTML 标题转成可读标题。 */
function stripInlineTags(html: string): string {
  return html.replace(/<[^>]*>/gu, ' ')
}

/**
 * 扫描全文标题，按出现位置排序。
 *
 * 两种语法必须一起扫：答复正文在上游是 Markdown，`render_patent_document` 的成品
 * 是 HTML，同一条规则要能在两条路径上都生效。
 * @param text - 待扫描文本。
 * @returns 标题层级、标题文字与区间。
 */
function scanHeadings(text: string): HeadingHit[] {
  const hits: HeadingHit[] = []
  let inFence = false
  let offset = 0
  for (const line of text.split('\n')) {
    const lineEnd = offset + line.length
    if (FENCE_LINE.test(line)) {
      inFence = !inFence
    } else if (!inFence) {
      const match = MD_HEADING.exec(line)
      if (match !== null) {
        /* v8 ignore next -- the prefix group always participates. */
        const level = match[1]?.length ?? 0
        /* v8 ignore next -- the title group always participates. */
        const title = (match[2] ?? '').trim()
        if (title.length > 0) hits.push({ level, title, start: offset, end: lineEnd })
      }
    }
    offset = lineEnd + 1
  }
  for (const match of text.matchAll(HTML_HEADING)) {
    /* v8 ignore next -- the title group always participates. */
    const title = stripInlineTags(match[2] ?? '').trim()
    if (title.length === 0) continue
    const start = match.index
    hits.push({ level: Number(match[1]), title, start, end: start + match[0].length })
  }
  hits.sort((a, b) => a.start - b.start)
  return hits
}

/**
 * 取小节正文里「看得见的字」：去注释、去标签、去列表/引用/表格分隔行与强调符号。
 * 只用于判定有无正文，不用于计数——故不保留空白与标点的原始位置。
 */
function sectionBodyText(body: string): string {
  return body
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<[^>]*>/gu, ' ')
    .replace(/^\s{0,3}(?:[-*+]|\d+[.)])\s+/gmu, ' ')
    .replace(/^\s{0,3}>\s?/gmu, ' ')
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gmu, ' ')
    .replace(/[|*_`~#>-]/gu, ' ')
    .replace(/\s+/gu, '')
}

/**
 * 空节检查：标题到下一个标题之间没有正文，或只有「无」一类占位语。
 *
 * 只含子标题的父节不算空——正文全在子节里是正常的层级结构，`三、本案事实` 下面
 * 直接接 `3.1` 不该报空节。占位语在整段逐字相等时才算命中，故「无。理由如下」不误伤。
 * @param check - 检查参数（层级下限、占位语表）。
 * @param text - 待扫描文本。
 * @returns 命中空节的可读标题。
 */
function checkEmptySection(check: EmptySectionCheck, text: string): string[] {
  const minLevel = check.minLevel ?? 2
  const placeholders = new Set(
    (check.placeholders ?? EMPTY_SECTION_PLACEHOLDERS).map(normalizePlaceholder),
  )
  const headings = scanHeadings(text)
  const evidence: string[] = []
  for (const [index, heading] of headings.entries()) {
    if (heading.level < minLevel) continue
    const next = headings[index + 1]
    if (next !== undefined && next.level > heading.level) continue
    const body = text.slice(heading.end, next === undefined ? text.length : next.start)
    const visible = sectionBodyText(body)
    if (visible.length === 0 || placeholders.has(normalizePlaceholder(visible))) {
      evidence.push(heading.title)
    }
  }
  return evidence
}

/** 句子边界：句末标点与换行。 */
const SENTENCE_BOUNDARY = /[。！？；!?;\n]+/u

/**
 * 非正文区：HTML 注释、`style`/`script` 块。成品的样式表里同一句声明会出现十几次，
 * 不剔除就会把 CSS 读成「同一句重复出现 12 处」。
 */
const NON_PROSE_BLOCK =
  /<!--[\s\S]*?-->|<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/giu

/** 含文字或数字才算句子；纯符号行（如 Markdown 表格分隔行 `|---|---|`）不参与计数。 */
const PROSE_CHARS = /[\p{L}\p{N}]/u

/**
 * 句子重复检查：同一句（通常是同一个结论）在全文出现达到阈值即违规。
 * 句子按「去空白与强调标记后逐字相同」归一，故换行与格式不影响判定。
 * @param check - 检查参数（最短句长、出现次数）。
 * @param text - 待扫描文本。
 * @returns 重复出现的句子（原样，供定位）。
 */
function checkSentenceRepetition(check: SentenceRepetitionCheck, text: string): string[] {
  const minLength = check.minLength ?? 12
  const minOccurrences = check.minOccurrences ?? 3
  const seen = new Map<string, { sentence: string; count: number }>()
  for (const raw of text.replace(NON_PROSE_BLOCK, ' ').split(SENTENCE_BOUNDARY)) {
    const sentence = stripInlineTags(raw).replace(/[#>*_`]/gu, ' ').trim()
    const key = sentence.replace(/\s+/gu, '')
    if (key.length < minLength || !PROSE_CHARS.test(key)) continue
    const entry = seen.get(key)
    if (entry === undefined) seen.set(key, { sentence, count: 1 })
    else entry.count += 1
  }
  const evidence: string[] = []
  for (const { sentence, count } of seen.values()) {
    if (count >= minOccurrences) evidence.push(sentence)
  }
  return evidence
}

function checkPatternAnalysis(check: PatternAnalysisCheck, text: string): string[] {
  const minMatches = check.minMatches ?? 1
  const evidence: string[] = []
  for (const pattern of check.patterns) {
    let count = 0
    const matches: string[] = []
    const regex = regexOf(pattern, 'gi')
    if (regex === null) continue
    regex.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = regex.exec(text)) !== null) {
      const fullMatch = match[0]
      count += 1
      if (matches.length < 4) matches.push(fullMatch)
      if (fullMatch.length === 0) regex.lastIndex += 1
    }
    // 禁止模式语义：命中次数达到 minMatches 才判定违规
    if (count >= minMatches) {
      evidence.push(...matches)
    }
  }
  return evidence
}

function checkStructuralAnalysis(
  check: StructuralAnalysisCheck,
  text: string,
): { confidence: number; missing: string[] } {
  let hit = 0
  const missing: string[] = []
  for (const element of check.requiresAll) {
    const matched = element.patterns.some(pattern => regexOf(pattern, 'i')?.test(text) ?? false)
    if (matched) {
      hit += 1
    } else {
      missing.push(element.element)
    }
  }
  const total = check.requiresAll.length
  return { confidence: total === 0 ? 1 : hit / total, missing }
}

/**
 * 提取法条引用（存在性检查用）。
 *
 * 同时接受不带书名号的 `专利法第22条` 与中文文书通行的 `《专利法》第二十二条`；
 * N 支持阿拉伯数字与中文数字。书名号只作为可选外层，不进入法名分组。
 */
/** Article ceilings from the shipped index, filled on the first citation check that needs them. */
let shippedCeilings: Map<string, number> | undefined

/**
 * The shipped index's article ceilings.
 *
 * A rule that names a statute without `max` uses this map, so the asset does not
 * keep its own copy of the article count.
 * @returns law name to `maxArticle`.
 */
function statuteCeilings(): Map<string, number> {
  if (shippedCeilings !== undefined) return shippedCeilings
  shippedCeilings = new Map()
  for (const [law, baseline] of loadLawBaselines()) {
    if (baseline.maxArticle !== null) shippedCeilings.set(law, baseline.maxArticle)
  }
  return shippedCeilings
}

function checkCitationAnalysis(check: CitationAnalysisCheck, text: string): string[] {
  const evidence: string[] = []
  const ceilings = statuteCeilings()
  for (const reference of extractLawReferences(text)) {
    if (reference.kind !== 'law-article') continue
    const statute = check.statutes[reference.law]
    if (statute === undefined) continue
    const max = statute.max ?? ceilings.get(reference.law)
    if (max !== undefined && reference.article > max) evidence.push(reference.raw)
  }
  return evidence
}

/**
 * 构造置信度不足的违规消息；达到阈值时返回 null（不违规）。
 * @param noun - 要素类别名词（"结构" / "同义"）。
 * @param confidence - 实际置信度（0..1）。
 * @param missing - 缺失要素清单。
 * @param minConfidence - 置信度阈值。
 * @returns 违规消息；达到阈值时为 null。
 */
function confidenceViolation(noun: string, confidence: number, missing: string[], minConfidence: number): string | null {
  if (confidence >= minConfidence) return null
  return `${noun}要素不完整：缺失 ${missing.join('、')}（置信度 ${(confidence * 100).toFixed(0)}% < ${(minConfidence * 100).toFixed(0)}%）`
}

/** evaluateText 可选评估选项。 */
export type EvaluateTextOptions = {
  /**
   * 领域过滤（分层规则包与作业 scope 场景）：单个域或域列表；已声明 `domain`
   * 且不在其中的规则跳过，未声明 `domain` 的规则（通用规则）始终评估。
   * 空串与空数组等同于不过滤。缺省不过滤（向后兼容）。
   */
  domain?: string | readonly string[]
}

/** 归一化域过滤参数：undefined / "" / 空数组 → 不过滤；单字符串 → 单元素数组。 */
function normalizeDomains(rawDomain: string | readonly string[] | undefined): readonly string[] {
  if (rawDomain === undefined || rawDomain === '') return []
  return typeof rawDomain === 'string' ? [rawDomain] : rawDomain
}

/**
 * 评估一段文本，返回全部违规（synonyms 为同义词表，供 synonym_match 检查；缺省空表）。
 * @param text - 待评估文本。
 * @param ruleSet - 规则集。
 * @param synonyms - 同义词表（缺省空表）。
 * @param options - 可选评估选项（领域过滤）。
 * @returns 评估结果（含全部违规）。
 */
export function evaluateText(
  text: string,
  ruleSet: RuleSet,
  synonyms?: SynonymMap,
  options?: EvaluateTextOptions,
): RuleEvaluation {
  const violations: RuleViolation[] = []
  const domains = normalizeDomains(options?.domain)
  for (const rule of ruleSet.rules) {
    if (domains.length > 0 && rule.domain && !domains.includes(rule.domain)) continue
    const found = evaluateRule(rule, text, synonyms)
    if (found !== null) violations.push(found)
  }
  return { violations }
}

/**
 * 规则前提是否满足：任一 premise 正则命中即适用；未声明 premise 始终适用。
 * 语义见 `ConstitutionalRule.premise`——前提不满足 = 不评估（不产生违规）。
 * @param premise - 规则声明的适用前提（正则列表）。
 * @param text - 待评估文本。
 * @returns 是否适用。
 */
function premiseSatisfied(premise: readonly string[] | undefined, text: string): boolean {
  if (premise === undefined || premise.length === 0) return true
  for (const pattern of premise) {
    if (regexOf(pattern, 'i')?.test(text) === true) return true
  }
  return false
}

/**
 * 评估单条规则；不适用或无违规返回 null。
 * @param rule - 待评估规则。
 * @param text - 待评估文本。
 * @param synonyms - 同义词表（synonym_match 检查用）。
 * @returns 违规对象，不适用或无违规为 null。
 */
export function evaluateRule(rule: ConstitutionalRule, text: string, synonyms?: SynonymMap): RuleViolation | null {
  if (!premiseSatisfied(rule.premise, text)) return null
  const check = rule.check
  let evidence: string[] = []
  // 扫描期已记录下标的检查（keyword_blocklist）在这里交出最早一处命中；其余检查按
  // 证据片段字面反查。见文件末尾的 location 计算。
  let locatedAt: number | undefined
  let message: string | null = null
  let severity: RuleSeverity = rule.severity

  switch (check.type) {
    case 'keyword_blocklist': {
      const hits = checkKeywordBlocklist(check, text)
      if (hits.length === 0) return null
      evidence = hits.map(hit => hit.word)
      // 取最早一处计入违规的命中：被豁免的命中（否定语境、引文）不在 hits 内，
      // 拿 evidence 反查文本会落到被豁免的那一处。
      locatedAt = hits.reduce((min, hit) => Math.min(min, hit.index), Number.POSITIVE_INFINITY)
      severity = check.severityIfFound ?? rule.severity
      message = `命中禁止词：${[...new Set(evidence)].join('、')}`
      break
    }
    case 'pattern_analysis': {
      evidence = checkPatternAnalysis(check, text)
      if (evidence.length === 0) return null
      message = `命中禁止模式：${[...new Set(evidence)].slice(0, 4).join('、')}`
      break
    }
    case 'structural_analysis': {
      const { confidence, missing } = checkStructuralAnalysis(check, text)
      const violation = confidenceViolation('结构', confidence, missing, check.minConfidence ?? 1)
      if (violation === null) return null
      message = violation
      break
    }
    case 'citation_analysis': {
      evidence = checkCitationAnalysis(check, text)
      if (evidence.length === 0) return null
      message = `法条引用超出范围：${[...new Set(evidence)].join('、')}`
      break
    }
    case 'synonym_match': {
      const { confidence, missing } = checkSynonymRequirements(text, check.requirements, synonyms ?? new Map())
      const violation = confidenceViolation('同义', confidence, missing, check.minConfidence ?? 1)
      if (violation === null) return null
      message = violation
      break
    }
    case 'quote_repetition': {
      evidence = checkQuoteRepetition(check, text)
      if (evidence.length === 0) return null
      message = `重复引证：同一引文重复出现（${[...new Set(evidence)].slice(0, 3).map(truncate).join('；')}）`
      break
    }
    case 'empty_section': {
      evidence = checkEmptySection(check, text)
      if (evidence.length === 0) return null
      message = `空节：${evidence.length} 个小节标题后没有正文——无内容的小节整节删除，已折叠的槽位不要在成品里留标题`
      break
    }
    case 'sentence_repetition': {
      evidence = checkSentenceRepetition(check, text)
      if (evidence.length === 0) return null
      message = `同一句重复出现 ${evidence.length} 处：一个结论只写一处，其余以「见前述结论」指代`
      break
    }
    case 'notice_ground_coverage':
    case 'unraised_statute_citation':
      // 双输入检查族：需要通知书解析结果，单文本评估跳过（由 evaluateDualRule 执行）。
      return null
    /* v8 ignore next -- closed-union backstop; the compiler rejects a new check type here. */
    default:
      assertNever(check, 'rule check type')
  }

  const location = locatedAt === undefined ? locateMatch(text, evidence) : locationAt(text, locatedAt)
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    severity,
    action: rule.action,
    ...(rule.legalBasis !== undefined ? { legalBasis: rule.legalBasis } : {}),
    message,
    evidence: [...new Set(evidence)].map(truncate),
    ...(location === undefined ? {} : { line: location.line, matchedSentence: location.matchedSentence }),
  }
}

/**
 * 便捷入口：按 action 分组违规（block / review / warn / log）。
 * @param evaluation - 评估结果。
 * @returns 按 action 分组的违规映射。
 */
export function groupByAction(evaluation: RuleEvaluation): Record<string, RuleViolation[]> {
  const grouped: Record<string, RuleViolation[]> = { block: [], review: [], warn: [], log: [] }
  for (const violation of evaluation.violations) {
    (grouped[violation.action] ??= []).push(violation)
  }
  return grouped
}
