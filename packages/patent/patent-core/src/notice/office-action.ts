/**
 * src/patent/notice — 审查意见通知书（OA）的确定性解析。
 *
 * 输入通知书正文，输出结构化事实：驳回类型（按首次出现位置排序并去重）、引用文献
 * （文献号、通知书标注的相关性类别、同句内提到的权项）、涉及的权项编号（区间展开为
 * 逐个编号）、审查员论点句。全部由关键词表与正则完成，不调用模型。
 *
 * 与上游 Mady `domains/rules/oa_parser.go` 的差异：
 * - 相关性不再默认 `A`。上游以"文献号紧邻字母 X"判定相关性，其余一律落 `A` 兜底，
 *   等于把"仅一般背景技术"当成已认定的事实；本模块只在文献号之后紧邻的位置出现
 *   `X类`/`（X）` 一类标注时返回相关性，未标注即省略该字段。
 * - 引用文献的权项不再恒空。上游 `CitedReference.ClaimsAffected` 无写入点，故全链路
 *   恒为空；本模块按文献号所在语句内的权项编号填充，并列枚举（`权利要求1、2和3`）
 *   逐项计入，该字段是**同句共现**而非审查员的权威对应，见
 *   `CitedReference.claimsAffected`。
 * - 审查员论点按码位截取。上游以字节下标切分中文正文，可切出半个字符。
 * - 权项区间带宽度与编号上限，异常区间不展开。
 * - 同一文献的多处相关性标注不一致时列入 `parseConflicts`（冲突源/候选值/采用依据），
 *   按首现标注继续输出，不静默取单一结论。
 */

/**
 * 通知书驳回类型。`other` 表示未识别到具体驳回条款。
 */
export type NoticeRejectionType =
  | 'inventiveness'
  | 'novelty'
  | 'clarity'
  | 'support'
  | 'disclosure'
  | 'scope'
  | 'formal'
  | 'other'

/** 具体驳回类型（不含 `other`）。 */
export type NoticeRejectionGround = Exclude<NoticeRejectionType, 'other'>

/**
 * 驳回类型的中文标签，直接进中文报告。
 */
export const REJECTION_LABELS: Record<NoticeRejectionType, string> = {
  inventiveness: '创造性（专利法第22条第3款）',
  novelty: '新颖性（专利法第22条第2款）',
  clarity: '不清楚（专利法第26条第4款）',
  support: '得不到说明书支持（专利法第26条第4款）',
  disclosure: '公开不充分（专利法第26条第3款）',
  scope: '修改超范围（专利法第33条）',
  formal: '形式缺陷',
  other: '未识别到具体驳回条款',
}

/**
 * 各驳回类型的关键词与条款写法（大小写不敏感）。同一类型内任一词命中即算命中，
 * 位置取该类型全部命中中的最早值。
 */
export const REJECTION_PATTERNS: Record<NoticeRejectionGround, readonly string[]> = {
  inventiveness: ['创造性', '显而易见', '22条第3款', '不具备创造性'],
  novelty: ['新颖性', '不具备新颖性', '22条第2款', '技术方案被公开'],
  clarity: ['不清楚', '26条第4款', '简明'],
  support: ['不支持', '得不到说明书支持'],
  disclosure: ['公开不充分', '26条第3款', '无法实现'],
  scope: ['33条', '修改超范围', '超出原说明书', '超出原始记载'],
  formal: ['形式', '格式', '书写', '明显错误'],
}

/**
 * 驳回类型的简称，用于表格与标题（`REJECTION_LABELS` 带法条，适合正文陈述）。
 */
export const REJECTION_SHORT_LABELS: Record<NoticeRejectionType, string> = {
  inventiveness: '创造性',
  novelty: '新颖性',
  clarity: '不清楚',
  support: '不支持',
  disclosure: '公开不充分',
  scope: '修改超范围',
  formal: '形式缺陷',
  other: '未识别条款',
}

/**
 * 驳回类型的遍历顺序，同时是"首次出现位置相同"时的稳定次序。
 *
 * 与 `REJECTION_PATTERNS`、`REJECTION_LABELS`、`REJECTION_SHORT_LABELS` 四者的键集由穷尽
 * `Record` 类型约束保持一致：新增一种驳回类型必须同时补齐四处。
 */
export const REJECTION_ORDER: readonly NoticeRejectionGround[] = [
  'inventiveness',
  'novelty',
  'clarity',
  'support',
  'disclosure',
  'scope',
  'formal',
]

/** 通知书标注的对比文件相关性类别：X（影响新颖性/创造性）、Y（与其它文件结合影响创造性）、A（一般背景技术）、E（抵触申请）、P（申请日介于对比文件公开日与申请日之间）。 */
export type CitationRelevancy = 'X' | 'Y' | 'A' | 'E' | 'P'

/** 相关性类别的闭集，未列出的标注字母不识别，视为未标注。 */
const CITATION_RELEVANCIES: readonly CitationRelevancy[] = ['X', 'Y', 'A', 'E', 'P']

/** 括号形式的相关性标注：`（X）`。 */
const PARENTHESIZED_RELEVANCY = /[（(]\s*([XYAEP])\s*[）)]/i

/** 后缀形式的相关性标注：`X类`。 */
const SUFFIXED_RELEVANCY = /([XYAEP])\s*类/i

/**
 * 相关性标注的检索窗口宽度（UTF-16 码元）。
 *
 * 只取文献号**之后**该宽度内的标注，对应中文通知书的"文献号（X类）"写法。标注写在
 * 文献号之前的体裁（如外文检索报告的 `(X) CN…`）不被识别，回落为未标注；跨文献号取
 * 标注会把一篇文献的类别安到另一篇上，故不按语句范围放宽。
 */
const RELEVANCY_WINDOW_CHARS = 8

/** 专利文献号：国家/组织代码 + 至少 6 位数字 + 可选种类代码。 */
const PATENT_NUMBER = /(?:CN|US|WO|EP|JP|KR)\d{6,}[A-Z]?/g

/**
 * 本文书自身文献号的指代标记：紧接文献号之前的「本申请/本发明/本专利/本案」
 * （可带"的"、开括号与"公开号/申请号/公告号/专利号"）。
 *
 * 通知书的抬头与本申请自身号码相邻的写法正是这一种，含 `本申请（申请号CN…）`
 * 这类括号写法；而「本申请与 CN… 的区别」这类对照写法中，标记与文献号之间隔着
 * 别的字，故不落在此式内。
 */
const SELF_REFERENCE_BEFORE = /(?:本申请|本发明|本专利|本案)\s*(?:的)?\s*[（(]?\s*(?:公开号|申请号|公告号|专利号)?\s*[）)\s]*$/

/** 文献号之后的自身指代写法：`CN117000000A（本申请）`。 */
const SELF_REFERENCE_AFTER = /^\s*[（(]?\s*(?:本申请|本发明|本专利|本案)/

/** 上述两个窗口的宽度（UTF-16 码元）。 */
const SELF_REFERENCE_WINDOW_CHARS = 12

/**
 * 权利要求编号写法：单个编号或并列枚举（`权利要求1、2和3`）。
 *
 * 枚举符不含区间符：`权利要求1至3` 由 `CLAIM_RANGE_QUALIFIED` 整段展开，若这里也按
 * `至` 拆分，超宽区间会退化成两个端点编号。
 */
const CLAIM_NUMBER = /权利要求\s*(\d+(?:\s*(?:、|，|,|和|及|与|或|以及)\s*\d+)*)/g

/** 并列枚举的分隔符。 */
const CLAIM_NUMBER_SEPARATOR = /\s*(?:、|，|,|和|及|与|或|以及)\s*/

/**
 * 权利要求区间写法：`权利要求1至3`（前缀限定）与 `第1-5项`（后缀限定）。
 *
 * 两种写法各一条正则，是因为限定位不同：只写「第」的开区间会把「第2-3页」
 * 「第3至5段」这类页/段区间当成权项展开。两条都不带可选后缀，故页段区间不命中。
 */
const CLAIM_RANGE_QUALIFIED = /权利要求\s*(\d+)\s*[-至到]\s*(\d+)/g
const CLAIM_RANGE_SUFFIXED = /第\s*(\d+)\s*[-至到]\s*(\d+)\s*项/g

/** 单个权项编号上限：四位数编号在实务中不存在。 */
const MAX_CLAIM_NUMBER = 999

/** 区间宽度上限：更宽的区间按笔误忽略，避免异常正文把编号表撑成上万项。 */
const CLAIM_RANGE_SPAN_LIMIT = 200

/**
 * 审查员论点的起始标记。
 *
 * 每个标记是一个固定字面量的正则；在原文上直接匹配，避免先整体转小写再按下标切分——
 * 个别字符的小写形式长度不同会让下标与原文错位。
 */
const ARGUMENT_MARKERS: readonly RegExp[] = [
  /审查员认为/iu,
  /对比文件/iu,
  /本领域技术人员/iu,
  /因此/iu,
  /所以/iu,
  /综上/iu,
]

/** 审查员论点片段的最大长度（码位）。 */
const ARGUMENT_SNIPPET_LIMIT = 200

/** 审查员论点的最短长度（码位）：更短的片段是残句，不进报告。 */
const ARGUMENT_MIN_LENGTH = 10

/** 审查员论点条数上限。 */
const ARGUMENT_MAX_COUNT = 5

/** 句末标点，用于把论点截到一句。 */
const SENTENCE_ENDINGS: readonly string[] = ['。', '；']

/** 语句分隔符，用于界定引用文献所在语句。 */
const SEGMENT_DELIMITERS = '。；;\n'

/** 通知书引用的对比文件。 */
export type CitedReference = {
  /** 文献号，如 `CN101234567A`。 */
  documentNumber: string
  /** 通知书标注的相关性类别：取文献号之后紧邻位置的 `（X）` 或 `X类`；未标注时省略该字段，不以 `A` 兜底。 */
  relevancy?: CitationRelevancy
  /**
   * 该文献号所在语句内提到的权项编号（升序去重）。
   *
   * 这是同句共现，不是审查员对"哪篇文献评述哪些权项"的权威对应；需要权威对应时以
   * 通知书正文为准。
   */
  claimsAffected: number[]
}

/** 一处解析冲突：同一字段在正文不同位置出现不同取值；解析按确定性规则继续输出，但把冲突显式列出。 */
export type ParseConflict = {
  /** 冲突源（字段与对象，如 `引用文献 CN112345678A 的相关性类别`）。 */
  source: string
  /** 正文出现过的候选取值，按出现顺序去重；未标注写 `未标注`。 */
  candidates: string[]
  /** 采用的取值与依据（按首现标注继续输出；解析不裁定冲突，须人工核对）。 */
  basis: string
}

/** 引用文献扫描结果：去重后的引用与检出的解析冲突。 */
export type CitationScan = {
  citations: CitedReference[]
  conflicts: ParseConflict[]
}

/** 通知书的结构化解析结果。 */
export type ParsedOfficeAction = {
  /** 主驳回类型：`rejectionTypes` 的首项；未识别到具体条款时为 `other`。 */
  rejectionType: NoticeRejectionType
  /** 全部驳回类型，按在正文中首次出现的位置排序去重。 */
  rejectionTypes: NoticeRejectionGround[]
  citations: CitedReference[]
  /** 正文提到的权项编号，升序去重，区间已展开。 */
  affectedClaims: number[]
  /** 审查员论点句，最多 5 条；无标记命中时为空数组。 */
  examinerArguments: string[]
  /** 解析冲突（同一字段多处取值不一致）；无冲突时为空数组。 */
  parseConflicts: ParseConflict[]
}

/**
 * 读取必需捕获组的文本。
 *
 * 本模块的正则把捕获组写在必需分支上，匹配成功即意味着该组已参与匹配。
 * @param match - 成功的正则匹配结果。
 * @param index - 捕获组序号，0 表示整个匹配。
 * @returns 捕获组文本。
 */
function capture(match: RegExpExecArray, index: number): string {
  return match[index] as string
}

/**
 * 逐个返回正则命中。
 * @param text - 待扫描文本。
 * @param pattern - 带 `g` 标志的模块级正则。
 * @returns 命中数组，按出现顺序；进入前重置 `lastIndex`，避免上一次调用的残留位置造成漏匹配。
 */
function eachMatch(text: string, pattern: RegExp): RegExpExecArray[] {
  pattern.lastIndex = 0
  const matches: RegExpExecArray[] = []
  let match = pattern.exec(text)
  while (match !== null) {
    matches.push(match)
    match = pattern.exec(text)
  }
  return matches
}

/**
 * 返回文本中首个命中的模式下标。
 * @param loweredText - 已转小写的正文。
 * @param patterns - 待检查的模式，逐个小写后比较。
 * @returns 最早命中的下标；都未命中时为 -1。
 */
function earliestPatternIndex(loweredText: string, patterns: readonly string[]): number {
  let earliest = -1
  for (const pattern of patterns) {
    const index = loweredText.indexOf(pattern.toLowerCase())
    if (index >= 0 && (earliest < 0 || index < earliest)) earliest = index
  }
  return earliest
}

/**
 * 识别正文中的全部驳回类型。
 * @param text - 通知书正文。
 * @returns 驳回类型，按首次出现位置排序去重；位置相同时按 `REJECTION_ORDER` 取序。
 */
export function detectRejectionTypes(text: string): NoticeRejectionGround[] {
  const loweredText = text.toLowerCase()
  const hits: { position: number; ground: NoticeRejectionGround }[] = []
  for (const ground of REJECTION_ORDER) {
    const position = earliestPatternIndex(loweredText, REJECTION_PATTERNS[ground])
    if (position >= 0) hits.push({ position, ground })
  }
  // 位置相同时保持表序：hits 按 REJECTION_ORDER 构造，而 Array.prototype.sort
  // 自 ES2019 起要求稳定，故无需显式次序键。
  hits.sort((left, right) => left.position - right.position)
  return hits.map(hit => hit.ground)
}

/**
 * 识别主驳回类型。通知书常同时引用多个条款，需要逐条答复时改用 `detectRejectionTypes`。
 * @param text - 通知书正文。
 * @returns 正文中最先出现的驳回类型；未识别到具体条款时为 `other`。
 */
export function detectRejectionType(text: string): NoticeRejectionType {
  return detectRejectionTypes(text)[0] ?? 'other'
}

/**
 * 取下标所在的语句。语句以句号、分号、换行为界。
 * @param text - 全文。
 * @param index - 语句内任一位置的下标。
 * @returns 不含分隔符的语句文本。
 */
function enclosingSegment(text: string, index: number): string {
  let start = 0
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (SEGMENT_DELIMITERS.includes(text.charAt(cursor))) {
      start = cursor + 1
      break
    }
  }
  let end = text.length
  for (let cursor = index; cursor < text.length; cursor += 1) {
    if (SEGMENT_DELIMITERS.includes(text.charAt(cursor))) {
      end = cursor
      break
    }
  }
  return text.slice(start, end)
}

/**
 * 读取文献号之后标注的相关性类别。
 * @param text - 通知书全文。
 * @param end - 文献号的结束下标。
 * @returns 标注的类别；窗口内未标注或标注字母不在闭集内时为 `undefined`。
 */
function citationRelevancy(text: string, end: number): CitationRelevancy | undefined {
  const window = text.slice(end, end + RELEVANCY_WINDOW_CHARS)
  const marker = PARENTHESIZED_RELEVANCY.exec(window)?.[1] ?? SUFFIXED_RELEVANCY.exec(window)?.[1]
  if (marker === undefined) return undefined
  const upper = marker.toUpperCase()
  return CITATION_RELEVANCIES.find(relevancy => relevancy === upper)
}

/**
 * 提取正文提到的权项编号，展开 `权利要求1至3`、`第1-5项` 一类区间，并列枚举
 * （`权利要求1、2和3`）逐项计入。
 * @param text - 通知书正文或其中一段。
 * @returns 升序去重的权项编号；未提到权项时为空数组。
 */
export function extractAffectedClaims(text: string): number[] {
  const claims = new Set<number>()
  for (const match of eachMatch(text, CLAIM_NUMBER)) {
    for (const token of capture(match, 1).split(CLAIM_NUMBER_SEPARATOR)) {
      const number = Number.parseInt(token, 10)
      if (number > 0 && number <= MAX_CLAIM_NUMBER) claims.add(number)
    }
  }
  for (const pattern of [CLAIM_RANGE_QUALIFIED, CLAIM_RANGE_SUFFIXED]) {
    for (const match of eachMatch(text, pattern)) {
      const start = Number.parseInt(capture(match, 1), 10)
      const end = Number.parseInt(capture(match, 2), 10)
      const withinRange = end - start <= CLAIM_RANGE_SPAN_LIMIT && end <= MAX_CLAIM_NUMBER
      if (start > 0 && start <= end && withinRange) {
        for (let number = start; number <= end; number += 1) claims.add(number)
      }
    }
  }
  return [...claims].sort((left, right) => left - right)
}

/**
 * 一处文献号是否指本条通知书的收件申请本身。
 * @param text - 通知书正文。
 * @param match - 文献号在正文中的匹配，`0` 组为号码。
 * @returns true 表示该号码是本文书自身号码的指代，不是审查员引用的对比文件。
 */
function isSelfReference(text: string, match: RegExpExecArray): boolean {
  const number = capture(match, 0)
  const before = text.slice(Math.max(0, match.index - SELF_REFERENCE_WINDOW_CHARS), match.index)
  if (SELF_REFERENCE_BEFORE.test(before)) return true
  const end = match.index + number.length
  return SELF_REFERENCE_AFTER.test(text.slice(end, end + SELF_REFERENCE_WINDOW_CHARS))
}

/**
 * 扫描正文引用的对比文件与相关性标注冲突。
 *
 * 本文书自身的公开号/申请号按 `SELF_REFERENCE_BEFORE` / `SELF_REFERENCE_AFTER` 排除：
 * 它们出现在通知书抬头，不是审查员引用的对比文件，落进 `citations` 会被下游当成比对对象。
 * 同一文献号出现多次时，各次标注按出现顺序收集；取值不一致（含"未标注与标注并存"）即列
 * 一条 `parseConflicts`，引用仍按首现标注继续——解析不裁定哪一处为准，交由人工核对。
 * @param text - 通知书正文。
 * @returns 去重后的引用文献（相关性取首现标注、权项取同句共现）与冲突列表。
 */
export function scanCitations(text: string): CitationScan {
  const seen = new Set<string>()
  const citations: CitedReference[] = []
  const occurrences = new Map<string, { first: CitationRelevancy | undefined; candidates: string[] }>()
  for (const match of eachMatch(text, PATENT_NUMBER)) {
    const documentNumber = capture(match, 0)
    if (isSelfReference(text, match)) continue
    const relevancy = citationRelevancy(text, match.index + documentNumber.length)
    const display = relevancy === undefined ? '未标注' : `${relevancy} 类`
    const recorded = occurrences.get(documentNumber)
    if (recorded === undefined) {
      occurrences.set(documentNumber, { first: relevancy, candidates: [display] })
    } else if (!recorded.candidates.includes(display)) {
      recorded.candidates.push(display)
    }
    if (seen.has(documentNumber)) continue
    seen.add(documentNumber)
    const reference: CitedReference = {
      documentNumber,
      claimsAffected: extractAffectedClaims(enclosingSegment(text, match.index)),
    }
    if (relevancy !== undefined) reference.relevancy = relevancy
    citations.push(reference)
  }
  const conflicts: ParseConflict[] = []
  for (const [documentNumber, recorded] of occurrences) {
    if (recorded.candidates.length <= 1) continue
    const chosen = recorded.first === undefined ? '未标注' : `${recorded.first} 类`
    conflicts.push({
      source: `引用文献 ${documentNumber} 的相关性类别`,
      candidates: recorded.candidates,
      basis: `按首现标注继续（${chosen}）；解析不裁定标注冲突，须人工核对`,
    })
  }
  return { citations, conflicts }
}

/**
 * 提取正文引用的对比文件，按首次出现顺序去重。
 *
 * 标注冲突不在此处丢弃：`scanCitations` 的 `parseConflicts` 单独示出，本函数只保留引用面
 * （下游既有的文献清单消费者照旧）。
 * @param text - 通知书正文。
 * @returns 引用文献；每项的相关性取文献号之后的标注，权项取同句共现，见 `CitedReference`。
 */
export function extractCitations(text: string): CitedReference[] {
  return scanCitations(text).citations
}

/**
 * 取字符串开头的至多 `limit` 个码位。
 * @param text - 原文。
 * @param limit - 码位上限。
 * @returns 不切断代理对的字符串前缀。
 */
function leadingCodePoints(text: string, limit: number): string {
  let units = 0
  let points = 0
  while (units < text.length && points < limit) {
    const code = text.charCodeAt(units)
    units += code >= 0xd800 && code <= 0xdbff ? 2 : 1
    points += 1
  }
  return text.slice(0, units)
}

/**
 * 自 `position` 起截取一句论点。
 * @param text - 全文。
 * @param position - 论点起始下标。
 * @returns 至首个句末标点（含标点）的片段；句末标点超窗时取至窗尾。
 */
function argumentSnippet(text: string, position: number): string {
  const window = leadingCodePoints(text.slice(position), ARGUMENT_SNIPPET_LIMIT)
  const points = Array.from(window)
  const end = points.findIndex((point, offset) => offset > 0 && SENTENCE_ENDINGS.includes(point))
  return (end > 0 ? points.slice(0, end + 1).join('') : window).trim()
}

/**
 * 提取审查员论点句。
 * @param text - 通知书正文。
 * @returns 论点片段，按 `ARGUMENT_MARKERS` 的表序取，最多 5 条。
 */
export function extractExaminerArguments(text: string): string[] {
  const arguments_: string[] = []
  for (const marker of ARGUMENT_MARKERS) {
    if (arguments_.length >= ARGUMENT_MAX_COUNT) break
    const match = marker.exec(text)
    if (match === null) continue
    const snippet = argumentSnippet(text, match.index)
    if (Array.from(snippet).length > ARGUMENT_MIN_LENGTH) arguments_.push(snippet)
  }
  return arguments_
}

/**
 * 解析审查意见通知书，组合上述各步。
 * @param text - 通知书正文。
 * @returns 驳回类型、引用文献、涉及权项与审查员论点。
 */
export function parseOfficeAction(text: string): ParsedOfficeAction {
  const rejectionTypes = detectRejectionTypes(text)
  const { citations, conflicts } = scanCitations(text)
  return {
    rejectionType: rejectionTypes[0] ?? 'other',
    rejectionTypes,
    citations,
    affectedClaims: extractAffectedClaims(text),
    examinerArguments: extractExaminerArguments(text),
    parseConflicts: conflicts,
  }
}

/**
 * 单篇引用文献的简短描述。
 * @param reference - 引用文献。
 * @returns `文献号（X 类）`；未标注相关性时只有文献号。
 */
export function describeCitation(reference: CitedReference): string {
  return reference.relevancy === undefined
    ? reference.documentNumber
    : `${reference.documentNumber}（${reference.relevancy} 类）`
}

/**
 * 把通知书引用的对比文件格式化为换位审查可读的 `reference_documents` 文本。
 *
 * @param citations - `oa-parse` / `ParsedOfficeAction.citations`。
 * @returns 用顿号连接的文献描述；无引用时为空串。
 */
export function formatReferenceDocuments(citations: readonly CitedReference[]): string {
  if (citations.length === 0) return ''
  return citations.map(describeCitation).join('、')
}

/**
 * 把解析结果渲染为中文摘要，供答复报告直接引用。
 *
 * 类型按中文标签呈现（上游输出英文枚举值，直接进中文报告不可读）；未识别到条款时
 * 明示"未识别"，不以某一类型兜底。
 * @param parsed - `parseOfficeAction` 的结果。
 * @returns 逐行摘要文本。
 */
export function formatOfficeActionSummary(parsed: ParsedOfficeAction): string {
  const grounds =
    parsed.rejectionTypes.length > 0
      ? parsed.rejectionTypes.map(ground => REJECTION_LABELS[ground]).join('、')
      : REJECTION_LABELS.other
  const claims = parsed.affectedClaims.length > 0 ? parsed.affectedClaims.join(', ') : '无'
  const citations =
    parsed.citations.length > 0 ? parsed.citations.map(describeCitation).join('、') : '无'
  const lines = [`驳回类型: ${grounds}`, `影响权利要求: ${claims}`, `引用文献: ${citations}`]
  if (parsed.examinerArguments.length > 0) {
    lines.push(`审查员论点: ${parsed.examinerArguments.join(' ')}`)
  }
  if (parsed.parseConflicts.length > 0) {
    lines.push('解析冲突（解析不裁定，须人工核对）:')
    for (const conflict of parsed.parseConflicts) {
      lines.push(`- ${conflict.source}：候选值 ${conflict.candidates.join('、')}（${conflict.basis}）`)
    }
  }
  return lines.join('\n')
}
