/**
 * 宪法规则引擎 — 中文文本处理共享工具。
 *
 * 统一 `hasNegationContext`（否定语境检测）与 `locateMatch` / `locationAt`
 * （命中定位），供 RuleEngine / synonym-engine / 说明书校验复用，避免镜像实现漂移。
 * 中文数字解析随法条引用机制收拢在 `@deepseek-ai/dsh-law-core`。
 */

// ---------------------------------------------------------------------------
// hasNegationContext
// ---------------------------------------------------------------------------

/** 否定语境词（不含单字"不/未/无"以免误放行）。 */
export const DEFAULT_NEGATION_WORDS: readonly string[] = [
  '防止',
  '避免',
  '不用于',
  '排除',
  '禁止',
  '严禁',
  '不得',
  '不应',
  '不为',
  '非用于',
  '不构成',
  '区别于',
  '不属于',
]

/** 否定语境检查窗口（命中词前多少个字符）。 */
export const DEFAULT_NEGATION_WINDOW = 24

/**
 * 否定词被吞入的复合词：这些词含否定词但语义不是否定（"无可避免的侵权"仍是
 * 对侵权的肯定陈述）。匹配时跳过落在这些复合词内的否定词命中。
 * 实现：命中前 2 字符与复合词前缀（"无可"/"不可"）比对即可覆盖全部复合词。
 */
const NEGATION_COMPOUNDS = ['无可避免', '不可避免']

/**
 * 句子/子句边界符：窗口内出现任一边界符时，否定词视为属于上一句，不再影响本句。
 * （含中英文句号/分号、叹号、问号、换行、省略号、破折号；不含逗号——中文逗号
 * 连接的两个子句否定语境可跨逗号延续，如"本方案避免侵权，因而不构成侵权"。）
 */
const SENTENCE_BOUNDARIES = ['。', '；', ';', '！', '？', '?', '!', '\n', '…', '—']

/** 否定语境检查选项：窗口大小、否定词表与紧邻前缀词表。 */
export type NegationContextOptions = {
  /** 否定语境检查窗口（默认 DEFAULT_NEGATION_WINDOW）。 */
  window?: number
  /** 否定语境词表（默认 DEFAULT_NEGATION_WORDS）：窗口内任意位置出现即豁免。 */
  negationWords?: readonly string[]
  /**
   * 紧邻前缀词表：只在**紧接命中位置之前**出现时豁免（「防窃听」的「防」）。
   *
   * 与 `negationWords` 分开是因为两者语义不同——前缀词与被命中词合成一个复合技术
   * 主题，隔开若干字就不再是同一个词（「检测用户行为，诱导其参与赌博」中的「检测」
   * 与该句的「赌博」无关）。走 24 字宽松窗口会让这类词变成远距离旁路。
   */
  adjacentWords?: readonly string[]
}

/**
 * 在命中位置前查找否定语境：紧邻前缀词命中，或窗口内出现否定词且无句界分隔。
 * @param text - 待检查文本。
 * @param matchStart - 命中位置（字符索引）。
 * @param options - 可选检查选项。
 * @returns 命中位置前是否存在否定语境。
 */
export function hasNegationContext(text: string, matchStart: number, options?: NegationContextOptions): boolean {
  const windowSize = options?.window ?? DEFAULT_NEGATION_WINDOW
  const words = options?.negationWords ?? DEFAULT_NEGATION_WORDS
  const start = Math.max(0, matchStart - windowSize)
  const window = text.slice(start, matchStart)
  // 紧邻前缀词与被命中词合成复合词，判定不依赖前文，故先于句界检查
  // （「乙。本发明提供防窃听装置」的前置句号不该取消「防窃听」的复合词地位）。
  const adjacent = options?.adjacentWords
  if (adjacent !== undefined && adjacent.some(word => word.length > 0 && window.endsWith(word))) return true
  if (SENTENCE_BOUNDARIES.some(b => window.includes(b))) return false
  for (const word of words) {
    let searchFrom = 0
    while (true) {
      const idx = window.indexOf(word, searchFrom)
      if (idx < 0) break
      // 复合词吞入检查：命中词若落进 NEGATION_COMPOUNDS（无可避免/不可避免），
      // 其前缀（"无可"/"不可"）直接拼在命中前——跳过该命中
      // （"使用无可避免的侵权风险"中的"避免"不是否定语境）。
      const before2 = window.slice(Math.max(0, idx - 2), idx)
      if (NEGATION_COMPOUNDS.some(c => c.startsWith(`${before2}${word}`))) {
        searchFrom = idx + word.length
        continue
      }
      return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// locateMatch
// ---------------------------------------------------------------------------

/** 命中定位：1 基行号 + 命中句。 */
export type MatchLocation = {
  /** 命中片段所在行号（1 基）。 */
  line: number
  /** 命中片段所在的句子（超长时按命中位置居中截断）。 */
  matchedSentence: string
}

/**
 * 命中句最大字符数。超长句按命中位置居中截断：句边界不一定在近处
 * （无标点的长段、或整段被当作一句时），截断保证返回体有界。
 */
const SENTENCE_MAX = 120

/**
 * 取命中位置所在的句子，超长时按命中位置居中截断。
 * @param text - 被扫描的完整文本。
 * @param index - 命中片段的起始下标。
 * @returns 命中句（句末终止符保留，换行不并入；被截断的一侧补省略号）。
 */
function sentenceAt(text: string, index: number): string {
  let start = index
  while (start > 0 && !SENTENCE_BOUNDARIES.includes(text.charAt(start - 1))) start -= 1
  let end = index
  while (end < text.length && !SENTENCE_BOUNDARIES.includes(text.charAt(end))) end += 1
  // 句末终止符属于这句话；换行只是排版分隔，不并入句子
  if (end < text.length && text.charAt(end) !== '\n') end += 1
  let from = start
  let to = end
  if (to - from > SENTENCE_MAX) {
    from = Math.max(start, index - Math.floor(SENTENCE_MAX / 2))
    to = Math.min(end, from + SENTENCE_MAX)
  }
  return `${from > start ? '…' : ''}${text.slice(from, to).trim()}${to < end ? '…' : ''}`
}

/**
 * 取已知命中位置的行号与命中句。调用方在扫描时已经记下命中的下标（而非只留下
 * 命中词）时用它：这些下标经过豁免判定筛选，`locateMatch` 的字面反查做不到。
 * @param text - 被扫描的完整文本。
 * @param index - 命中片段的起始下标。
 * @returns 行号与命中句。
 */
export function locationAt(text: string, index: number): MatchLocation {
  return { line: text.slice(0, index).split('\n').length, matchedSentence: sentenceAt(text, index) }
}

/**
 * 定位文本中最早出现的一处字面命中，返回行号与其所在句。
 *
 * 规则违规类返回值只说明"命中了什么词"，不说明"命中在哪里"：调用方拿到
 * `命中禁止词：专利性` 无法判断那是正文断言、强制免责样板还是被引原文，
 * 只能人工通读全文裁决。行号让这个判断可以在原处完成。
 *
 * 取**最早**一处：足以让调用方找到并判读上下文；全部片段列举则会让一个
 * 高频词把返回体撑大。
 *
 * 只在片段必为原文子串、且"最早一处"就是违规那一处时使用：它无法区分同一
 * 片段的多次出现，若扫描期丢弃了被豁免命中的位置（否定语境、引文），反查会
 * 落到被豁免的那一处——那种调用方应改用 {@link locationAt}。
 * @param text - 被扫描的完整文本。
 * @param needles - 待定位的字面片段（空片段被忽略）。
 * @returns 行号与命中句；文本中不含任何片段时返回 undefined。
 */
export function locateMatch(text: string, needles: readonly string[]): MatchLocation | undefined {
  let bestIndex = Number.POSITIVE_INFINITY
  for (const needle of needles) {
    if (needle.length === 0) continue
    const index = text.indexOf(needle)
    if (index >= 0 && index < bestIndex) bestIndex = index
  }
  if (bestIndex === Number.POSITIVE_INFINITY) return undefined
  return locationAt(text, bestIndex)
}

// ---------------------------------------------------------------------------
// runeSlice
// ---------------------------------------------------------------------------

/**
 * 按 Unicode 码点截断（对齐 Go runeSlice 语义；码点而非 UTF-16 单元），
 * 超长时可选追加省略号。规则引擎与 anti-slop 引擎共用。
 * @param s - 待截断文本。
 * @param n - 最大码点数。
 * @param ellipsis - 超长时是否追加省略号。
 * @returns 截断后的文本（未超长时原样返回）。
 */
export function runeSlice(s: string, n: number, ellipsis = false): string {
  const runes = Array.from(s)
  if (runes.length <= n) return s
  return `${runes.slice(0, n).join('')}${ellipsis ? '…' : ''}`
}
