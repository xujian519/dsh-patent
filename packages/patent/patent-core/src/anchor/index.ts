/**
 * 锚点校验：判断模型给出的说明书摘录是否真的出现在说明书原文中，并回填
 * 原文坐标下的命中区间。
 *
 * 复核只做文本层归一化：全角/常用 CJK 标点统一、连续空白折叠、换行视为段落分隔。
 * 不做同义词替换，不做数字改写；命中区间始终指向原文下标，不指向归一化文本。
 *
 * @module @deepseek-ai/dsh-patent-core/anchor
 */

/** 原文命中区间，`end` 为开区间（`sourceText.slice(start, end)` 取回原片段）。 */
export interface AnchorRange {
  start: number
  end: number
}

/**
 * 判定来源：
 *
 * - `exact`：摘录逐字出现在原文中；
 * - `normalized`：归一化后出现（全半角标点、空白或段边界差异）；
 * - `not-found`：归一化后仍不出现；
 * - `empty`：摘录为空或纯空白，调用方必须按未通过处理。
 */
export type AnchorReason = 'exact' | 'normalized' | 'not-found' | 'empty'

/** 锚点判定结果；`matched` 为 true 时 `range` 一并返回。 */
export interface AnchorResult {
  matched: boolean
  range?: AnchorRange
  reason: AnchorReason
}

/** 归一化文本中的段边界占位符；专利正文不会出现 NUL。 */
const PARAGRAPH_MARKER = '\u0000'

/** 跨段匹配时替代段边界的固定分隔符。 */
const PARAGRAPH_FOLD = ' '

/** 视为段落分隔的换行字符。 */
const NEWLINE_CHARS: ReadonlySet<string> = new Set(['\n', '\r', '\u2028', '\u2029'])

/** 空白字符（含制表、全角空格与不换行空格）。 */
const WHITESPACE_RE = /\s/u

/** 全角标点区段；数字与字母的全角形式不在内，避免改写数字。 */
const FULL_WIDTH_PUNCTUATION_RE = /[\uFF01-\uFF0F\uFF1A-\uFF20\uFF3B-\uFF40\uFF5B-\uFF5E]/u

/** CJK 标点到 ASCII 的补充映射（全角形式由上表统一处理）。 */
const CJK_PUNCTUATION: Readonly<Record<string, string>> = {
  '。': '.',
  '、': ',',
  '“': '"',
  '”': '"',
  '‘': "'",
  '’': "'",
  '「': '"',
  '」': '"',
  '『': '"',
  '』': '"',
  '【': '[',
  '】': ']',
  '〔': '(',
  '〕': ')',
  '—': '-',
  '–': '-',
  '…': '...',
}

/** 归一化文本，以及每个归一化字符对应的原文区间。 */
interface NormalizedText {
  text: string
  /** 归一化下标 → 原文起始下标；多字符替换（如省略号）共享同一起点。 */
  starts: number[]
  /** 归一化下标 → 原文结束下标（开区间）。 */
  ends: number[]
}

/**
 * 将全角或 CJK 标点折为 ASCII；其余字符原样返回。
 * @param char - 单个 UTF-16 码元。
 * @returns 折叠后的一个或多个字符。
 */
function foldPunctuation(char: string): string {
  if (FULL_WIDTH_PUNCTUATION_RE.test(char)) {
    return String.fromCharCode(char.charCodeAt(0) - 0xfee0)
  }
  return CJK_PUNCTUATION[char] ?? char
}

/**
 * 按原文下标构建归一化文本：标点逐字折叠，非换行空白折叠为一个空格，
 * 含换行的空白串折叠为一个段边界占位符。
 * @param text - 原文。
 * @returns 归一化文本及逐字符的原文区间。
 */
function normalize(text: string): NormalizedText {
  let result = ''
  const starts: number[] = []
  const ends: number[] = []
  let index = 0
  while (index < text.length) {
    const char = text.charAt(index)
    if (WHITESPACE_RE.test(char)) {
      const runStart = index
      let hasNewline = false
      while (index < text.length) {
        const current = text.charAt(index)
        if (!WHITESPACE_RE.test(current)) break
        if (NEWLINE_CHARS.has(current)) hasNewline = true
        index += 1
      }
      result += hasNewline ? PARAGRAPH_MARKER : ' '
      starts.push(runStart)
      ends.push(index)
      continue
    }
    const folded = foldPunctuation(char)
    for (let offset = 0; offset < folded.length; offset += 1) {
      starts.push(index)
      ends.push(index + 1)
    }
    result += folded
    index += 1
  }
  return { text: result, starts, ends }
}

/**
 * 把归一化文本中的段边界替换为固定分隔符，用于跨段匹配。
 * @param text - 归一化文本。
 * @returns 段边界已折叠的文本；原下标映射不变。
 */
function foldParagraphBoundaries(text: string): string {
  return text.replaceAll(PARAGRAPH_MARKER, PARAGRAPH_FOLD)
}

/**
 * 在归一化源文中查找归一化摘录，并把命中区间还原到原文下标。
 * @param source - 归一化源文。
 * @param needle - 归一化摘录（非空）。
 * @returns 原文区间；未命中返回 undefined。
 */
function matchRange(source: NormalizedText, needle: string): AnchorRange | undefined {
  const index = source.text.indexOf(needle)
  if (index < 0) return undefined
  const start = source.starts[index]
  const end = source.ends[index + needle.length - 1]
  /* v8 ignore next -- indexOf 保证下标落在两个平行数组内，缺省分支仅为类型收窄 */
  if (start === undefined || end === undefined) return undefined
  return { start, end }
}

/**
 * 判断说明书摘录是否真的出现在说明书原文中，并给出原文坐标下的命中区间。
 *
 * 摘录先做首尾空白裁剪。完全一致最高优先；否则双方做可逆的文本层归一化：
 * 全角/常用 CJK 标点折为 ASCII、连续空白折叠为一个空格、换行折叠为段边界。
 * 归一化匹配先要求段边界结构一致（摘录不含换行时即等价于逐段匹配），
 * 失败后再把段边界折为固定空格，允许摘录跨段或在线尾处使用空格。
 * 同一判定层级内多次出现时取最早命中；exact 层级先于归一化层级。
 *
 * 本函数只证明「原文有这句话」，不证明这句话支持该特征；`matched: false`
 * 且 `reason: 'empty'` 必须被调用方当作未通过，不能降级为「通过但无依据」。
 *
 * @param quote - 模型给出的说明书摘录。
 * @param sourceText - 说明书原文。
 * @returns 判定结果；`range` 指向 `sourceText` 的下标，`end` 为开区间。
 */
export function locateQuote(quote: string, sourceText: string): AnchorResult {
  const excerpt = quote.trim()
  if (excerpt.length === 0) {
    return { matched: false, reason: 'empty' }
  }

  const exact = sourceText.indexOf(excerpt)
  if (exact >= 0) {
    return {
      matched: true,
      reason: 'exact',
      range: { start: exact, end: exact + excerpt.length },
    }
  }

  const source = normalize(sourceText)
  const needle = normalize(excerpt)

  const direct = matchRange(source, needle.text)
  if (direct !== undefined) {
    return { matched: true, reason: 'normalized', range: direct }
  }

  const hasParagraphBoundary = source.text.includes(PARAGRAPH_MARKER) || needle.text.includes(PARAGRAPH_MARKER)
  if (hasParagraphBoundary) {
    const cross = matchRange(
      { ...source, text: foldParagraphBoundaries(source.text) },
      foldParagraphBoundaries(needle.text),
    )
    if (cross !== undefined) {
      return { matched: true, reason: 'normalized', range: cross }
    }
  }

  return { matched: false, reason: 'not-found' }
}
