/**
 * 权利要求引用语的单一解析。
 *
 * 句式、全角数字、编号表达式与区间展开只在这里定义；`claim-chart` 的引用关系推导与
 * `claim-lint` 的形式自检都调用它，避免同一句权利要求在两套解析里给出相反的独立／
 * 从属结论。
 *
 * 两处调用方的差别只在搜索窗口：形式自检要求引用语位于权项正文开头（正文中途的
 * 「权利要求 1 所述」是交叉引用），引用关系推导允许带前缀的引用语落在特征部分
 * （长引言的实务写法），并把无前缀的引用语限制在引言内。窗口由调用方显式传入。
 */

/** 引用区间的写法缺陷。 */
export type ClaimReferenceDefect =
  | { kind: 'descending-range'; raw: string }
  | { kind: 'oversized-range'; raw: string }

/**
 * 引用语的搜索窗口。
 *
 * - `clause-start`：引用语必须从权项正文开头开始（形式自检）。
 * - `claim-body`：带前缀的引用语在全文生效，无前缀的引用语只在引言内生效
 *   （引用关系推导）。
 */
export type ClaimReferenceWindow = 'clause-start' | 'claim-body'

/** 一条权项正文中识别到的引用语。 */
export type ClaimReferenceMatch = {
  /** 引用语原文（未做全角转换）。 */
  clause: string
  /** 引用语在正文中的起点。 */
  index: number
  /** 所引权项号，升序去重。 */
  refersTo: number[]
  /** 区间写法缺陷；没有时为空数组。 */
  defects: ClaimReferenceDefect[]
}

/** 区间展开的跨度上限：超限只保留端点，避免把写错的编号展开成上万项。 */
const RANGE_EXPANSION_LIMIT = 1000

/** 编号表达式：多个编号以并列或区间分隔符相连。 */
const REFERENCE_NUMBERS =
  '[0-9]+(?:\\s*(?:或|和|及|至|到|、|,|，|～|~|-|－|—)\\s*[0-9]+)*'

/** 编号后的择一限定（「中任一项」「之一」「中任一权利要求」「各」）。 */
const REFERENCE_QUALIFIER =
  '(?:\\s*(?:中\\s*(?:的\\s*)?(?:任(?:意)?一(?:项|权利要求)|之一)|之一|各))?'

/**
 * 带前缀的引用语。捕获组 1 为编号表达式。
 * `按` 不在此列：`按权利要求 1 所述进行装配` 是对方法的转述，不是引用关系。
 */
const PREFIXED_REFERENCE_RE = new RegExp(
  `(?:根据|如|按照|依)\\s*权利要求\\s*(${REFERENCE_NUMBERS})${REFERENCE_QUALIFIER}\\s*所述`,
)

/** 不带前缀的引用语。捕获组 1 为编号表达式。 */
const BARE_REFERENCE_RE = new RegExp(
  `权利要求\\s*(${REFERENCE_NUMBERS})${REFERENCE_QUALIFIER}\\s*所述`,
)

/** 概括引用：`前述权利要求中任一项`、`上述权利要求之一`、`权利要求中任一项`。 */
const CATCH_ALL_REFERENCE_RE =
  /(?:根据|如|按照|依)?\s*(?:(?:前述|上述|在前|前面|以上)(?:的)?)?权利要求\s*(?:中\s*)?(?:任(?:意)?一项|之一)\s*所述/

/** 特征部分起点；在此之前是引言部分。 */
const CHARACTERIZING_MARKER_RE = /其特征在[于於]|其特征是/

/** 无特征部分标记时引言的结束：第一条句末标点。 */
const SENTENCE_END_RE = /[。；]/

/** 编号表达式里的并列分隔符（区间符不在其中，区间要整段识别）。 */
const DISJUNCTION_RE = /\s*(?:或|和|及|、|,|，)\s*/

/** 区间写法：`1-3`、`1至3`、`1～3`。 */
const RANGE_RE = /^(\d+)\s*(?:至|到|[-－—~～])\s*(\d+)$/

/**
 * 全角数字转半角。
 * @param value - 可能含全角数字的文本。
 * @returns 全角数字替换为半角后的文本。
 */
export function toHalfWidth(value: string): string {
  return value.replace(/[０-９]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0))
}

/**
 * 解析编号表达式为权项号集合：并列项逐个取，区间项按升序展开。
 * @param raw - 编号表达式（如 `1或2`、`1-3`、`1至３`）。
 * @returns 升序去重的权项号。
 */
export function parseReferenceNumbers(raw: string): number[] {
  return parseReferenceNumbersWithDefects(raw).numbers
}

/**
 * 解析编号表达式，并记录无法按原文展开的区间写法。
 * @param raw - 编号表达式。
 * @returns 升序去重的权项号与区间缺陷。
 */
function parseReferenceNumbersWithDefects(raw: string): {
  numbers: number[]
  defects: ClaimReferenceDefect[]
} {
  const numbers = new Set<number>()
  const defects: ClaimReferenceDefect[] = []
  for (const token of toHalfWidth(raw).split(DISJUNCTION_RE)) {
    const trimmed = token.trim()
    if (trimmed.length === 0) continue
    const range = RANGE_RE.exec(trimmed)
    if (range !== null) {
      const from = Number(range[1])
      const to = Number(range[2])
      if (from > to) defects.push({ kind: 'descending-range', raw: trimmed })
      const low = Math.min(from, to)
      const high = Math.max(from, to)
      if (high - low > RANGE_EXPANSION_LIMIT) {
        defects.push({ kind: 'oversized-range', raw: trimmed })
        numbers.add(low)
        numbers.add(high)
        continue
      }
      for (let n = low; n <= high; n += 1) numbers.add(n)
      continue
    }
    if (/^\d+$/.test(trimmed)) {
      numbers.add(Number(trimmed))
      continue
    }
    for (const match of trimmed.matchAll(/\d+/g)) numbers.add(Number(match[0]))
  }
  return { numbers: [...numbers].sort((a, b) => a - b), defects }
}

/**
 * 在一条权项正文中找引用语：取最早出现且落在搜索窗口内的可识别写法。
 * @param body - 已剥离行首编号的权项正文。
 * @param earlierClaimNos - 编号更小的全部权项号，供概括引用展开。
 * @param window - 搜索窗口；调用方按用途显式选择。
 * @returns 引用语位置、原文、所引权项号与区间缺陷；无引用语时为 undefined。
 */
export function findClaimReference(
  body: string,
  earlierClaimNos: readonly number[],
  window: ClaimReferenceWindow,
): ClaimReferenceMatch | undefined {
  const normalized = toHalfWidth(body)
  const bareWindow = window === 'clause-start' ? normalized : preambleOf(normalized)
  const candidates: ClaimReferenceMatch[] = []

  const catchAll = CATCH_ALL_REFERENCE_RE.exec(bareWindow)
  if (catchAll !== null && earlierClaimNos.length > 0) {
    candidates.push({
      clause: body.slice(catchAll.index, catchAll.index + catchAll[0].length),
      index: catchAll.index,
      refersTo: [...earlierClaimNos],
      defects: [],
    })
  }
  for (const pattern of [PREFIXED_REFERENCE_RE, BARE_REFERENCE_RE]) {
    const source = pattern === BARE_REFERENCE_RE ? bareWindow : normalized
    const match = pattern.exec(source)
    if (match === null) continue
    /* v8 ignore next -- both reference patterns always capture the number expression. */
    const parsed = parseReferenceNumbersWithDefects(match[1] ?? '')
    candidates.push({
      clause: body.slice(match.index, match.index + match[0].length),
      index: match.index,
      refersTo: parsed.numbers,
      defects: parsed.defects,
    })
  }

  const allowed = window === 'clause-start' ? candidates.filter(candidate => candidate.index === 0) : candidates
  allowed.sort((left, right) => left.index - right.index)
  return allowed[0]
}

/**
 * 提取权项的引言部分：特征部分标记之前，或（无标记时）第一句之内。
 * @param body - 已做全角转换的权项正文。
 * @returns 引言部分文本。
 */
function preambleOf(body: string): string {
  const marker = CHARACTERIZING_MARKER_RE.exec(body)
  const end = marker?.index ?? body.search(SENTENCE_END_RE)
  return end >= 0 ? body.slice(0, end) : body
}
