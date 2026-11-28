/**
 * 撰写域原子：amendment-basis（A33 修改依据检查）。
 *
 * 专利法第三十三条：对发明和实用新型专利申请文件的修改不得超出原说明书和
 * 权利要求书记载的范围。判断标准是修改后的内容能否由原申请文件直接、毫无
 * 疑义地确定（审查指南第二部分第八章）。
 *
 * 本原子做字符级对照，不替代语义判断：
 * - 从答复正文中提取“修改后权利要求”段，按权项编号拆分；
 * - 与同号原权利要求对比，找出修改后新增的连续片段；
 * - 新片段在原说明书/原权利要求书中找不到记载时，列为疑似超范围项。单字片段
 *   也参与判定：插入一个 `不` 足以反转技术特征的限定方向，不能因为片段短而忽略。
 *
 * 没有修改后权利要求段时视为未修改权利要求（A33 不适用），放行并写明原因；
 * 检测到修改但缺少原申请文件时降级，避免用审查意见通知书冒充修改依据。
 * 字符级对照只能定位“未记载片段”，是否可直接、毫无疑义地确定仍需人工复核，
 * 报告末尾固定写明这一限制。
 */

import { type Atom } from '../../atom.ts'
import { type PipelineState, type StageExecuteInput, type StageHandler } from '../../handler.ts'
import { degraded } from './llm.ts'
import { findMalformedKey, readStateText, resolveKeyList } from './state-keys.ts'

/** 默认修改后权利要求文本键：显式修改稿优先，其次是答复正文。 */
export const DEFAULT_AMENDMENT_AMENDED_TEXT_KEYS: readonly string[] = [
  'amended_claims',
  'claims_draft',
  'draft',
  'response',
  'response_text',
]

/**
 * 默认原申请文件文本键。
 *
 * 只收明确表示“原申请”的键：`claim_text`/`claim`/`source_text` 在工作流里可能
 * 指向审查意见通知书或技术交底书，不能当作修改依据。
 */
export const DEFAULT_AMENDMENT_ORIGINAL_TEXT_KEYS: readonly string[] = [
  'original_text',
  'original_description',
  'description',
  'specification',
  'claims',
]

/** 连续匹配时单次尝试的最大长度；技术特征片段通常远短于此。 */
const MAX_MATCH_LENGTH = 24

/** 权利要求段标题（独占一行）。 */
const CLAIM_HEADING =
  /^(?:#{1,6}\s*)?(?:修改后(?:的)?)?(?:独立)?权利要求(?:书)?(?:全文)?\s*[:：]?\s*(?:如下)?\s*$/

/** 标题后直接跟正文的一行，如“修改后权利要求书：1. 一种……”。 */
const CLAIM_HEADING_PREFIX =
  /^(?:#{1,6}\s*)?(?:修改后(?:的)?)?(?:独立)?权利要求(?:书)?(?:全文)?\s*[:：]\s*(.+)$/

/** 权利要求段之后的结构性标题（Markdown 标题、编号标题、分隔线）。 */
const SECTION_MARKER =
  /^(?:#{1,6}\s+.+|[一二三四五六七八九十]+[、.．]|[（(][一二三四五六七八九十]+[)）].*|[-*_]{3,})$/

/** 权利要求段之后的文本节标题（含 Markdown 强调与声明行）。 */
const SECTION_KEYWORD =
  /^(?:\*{1,2}\s*)?(?:修改对照表|本案事实|适用规则|意见陈述|其他缺陷|证据与引用|结论与请求|结论|证据|附件|声明|申请人声明|代理人声明)\s*[:：]?/

/** 权项起始标记：行首编号，可带“权利要求”前缀。 */
const CLAIM_MARKER = /^\s*(?:权利要求\s*)?(\d+)\s*[.、．：:)）]\s*/

/** 权利要求中不承载技术特征的连接词；规范化时去除，避免制造假新增片段。 */
const CLAIM_BOILERPLATE = /其特征在于|其特征是|所述/gu

/** 新增片段两端可剥离的虚词；剥离后为空即忽略。 */
const FUNCTION_CHARS = new Set('的了和与及或在中上下内外前后所其该一种为是有无等地得之并且则而就都也把被将对于由从到以还'.split(''))

/** 字符级差异的最大对照长度乘积；超过后退回线性前缀匹配，避免长文本占满内存。 */
const MAX_DIFF_CELLS = 4_000_000

/** 一条修改后权项及其编号。 */
type ClaimSegment = {
  /** 权项编号（原样字符串）。 */
  number: string
  /** 权项正文。 */
  text: string
}

/** 修改后文本中新增的连续片段及其起始下标。 */
type AddedSpan = {
  /** 片段文本。 */
  text: string
  /** 片段首个字符在规范化修改文本中的下标。 */
  start: number
}

/** 原申请文件读取结果。 */
type OriginalBasis =
  | {
    kind: 'available'
    /** 原申请文件全文（用于片段检索）。 */
    text: string
    /** 原申请文件中的权项（可空）。 */
    claims: ClaimSegment[]
    /** 参与比对的状态键，按读取顺序。 */
    sources: string[]
  }
  | { kind: 'malformed'; key: string }
  | { kind: 'missing' }

/** 修改后文本读取结果。 */
type AmendedText =
  | { kind: 'text'; text: string }
  | { kind: 'malformed'; key: string }
  | { kind: 'missing' }

/** 疑似超范围项：修改后新增片段在原申请文件中无记载。 */
export type AmendmentBasisViolation = {
  /** 修改后权项编号。 */
  claimNo: string
  /** 未在原申请文件中找到的连续片段。 */
  addedSpan: string
  /** 可直接展示给用户的说明。 */
  detail: string
}

/** amendment-basis 原子：A33 修改依据的确定性检查。 */
export const amendmentBasisAtom: Atom = {
  name: 'amendment-basis',
  description:
    '修改依据检查（A33）：提取修改后权利要求，逐项核对新增技术特征是否记载于原说明书或原权利要求书',
  category: 'gate',
  inputSchema: [...DEFAULT_AMENDMENT_AMENDED_TEXT_KEYS, ...DEFAULT_AMENDMENT_ORIGINAL_TEXT_KEYS],
  outputSchema: [
    'amendment_basis_report',
    'amendment_basis_passed',
    'amendment_basis_violations',
    'amendment_basis_scope',
  ],
}

/**
 * 将“没有读到文本”区分为类型错误与输入缺失。
 * @param state - 阶段执行态。
 * @param keys - 候选键。
 * @returns 首个类型错误的键，或缺失标记。
 */
function missingOrMalformed(
  state: PipelineState,
  keys: readonly string[],
): { kind: 'malformed'; key: string } | { kind: 'missing' } {
  const malformed = findMalformedKey(state, keys)
  return malformed === undefined ? { kind: 'missing' } : { kind: 'malformed', key: malformed }
}

/**
 * 读取修改后权利要求文本。
 * @param state - 阶段执行态。
 * @param keys - 候选键，按优先级排列。
 * @returns 第一个可读文本；全部缺失或类型错误时说明原因。
 */
function readAmendedText(state: PipelineState, keys: readonly string[]): AmendedText {
  for (const key of keys) {
    const text = readStateText(state, key)
    if (text !== undefined) return { kind: 'text', text }
  }
  return missingOrMalformed(state, keys)
}

/**
 * 从文本中截取“修改后权利要求”段。
 * @param text - 答复正文或修改稿。
 * @returns 权利要求段正文；没有该标题时返回 undefined。
 */
function extractClaimsSection(text: string): string | undefined {
  const lines = text.split(/\r?\n/u)
  let start = -1
  let inline = ''
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim()
    if (CLAIM_HEADING.test(trimmed)) {
      start = index + 1
      break
    }
    const prefix = CLAIM_HEADING_PREFIX.exec(trimmed)
    if (prefix !== null) {
      start = index + 1
      /* v8 ignore next -- CLAIM_HEADING_PREFIX always captures the inline body. */
      inline = prefix[1]?.trim() ?? ''
      break
    }
  }
  if (start < 0) return undefined

  const body: string[] = inline.length > 0 ? [inline] : []
  for (const line of lines.slice(start)) {
    const trimmed = line.trim()
    if (SECTION_MARKER.test(trimmed) || SECTION_KEYWORD.test(trimmed)) break
    body.push(line)
  }
  const content = body.join('\n').trim()
  return content.length > 0 ? content : undefined
}

/**
 * 按权项编号拆分权利要求段。
 * @param section - 权利要求段正文。
 * @returns 权项列表；没有编号标记时整段视为权项 1。
 */
function parseClaims(section: string): ClaimSegment[] {
  const claims: ClaimSegment[] = []
  let current: { number: string; lines: string[] } | undefined
  for (const line of section.split(/\r?\n/u)) {
    const marker = CLAIM_MARKER.exec(line)
    if (marker !== null) {
      if (current !== undefined) {
        claims.push({ number: current.number, text: current.lines.join('\n').trim() })
      }
      /* v8 ignore next -- CLAIM_MARKER always captures the claim number. */
      current = { number: marker[1] ?? '1', lines: [line.slice(marker[0].length)] }
      continue
    }
    if (current !== undefined) current.lines.push(line)
  }
  if (current !== undefined) {
    claims.push({ number: current.number, text: current.lines.join('\n').trim() })
  }
  if (claims.length === 0) claims.push({ number: '1', text: section.trim() })
  return claims.filter(claim => claim.text.length > 0)
}

/**
 * 读取原申请文件。
 * @param state - 阶段执行态。
 * @param keys - 候选键，按优先级排列。
 * @returns 可用文本与权项；缺失或类型错误时说明原因。
 */
function readOriginalBasis(state: PipelineState, keys: readonly string[]): OriginalBasis {
  const texts: string[] = []
  const sources: string[] = []
  const claims: ClaimSegment[] = []
  const seen = new Set<string>()
  for (const key of keys) {
    const text = readStateText(state, key)
    if (text === undefined) continue
    if (seen.has(text)) continue
    seen.add(text)
    texts.push(text)
    sources.push(key)
    if (key === 'claims' || key === 'original_claims') {
      claims.push(...parseClaims(text))
    } else {
      const section = extractClaimsSection(text)
      if (section !== undefined) claims.push(...parseClaims(section))
    }
  }
  if (texts.length > 0) {
    return { kind: 'available', text: texts.join('\n'), claims, sources }
  }
  return missingOrMalformed(state, keys)
}

/**
 * 规范化文本：去空白、标点与权利要求连接词，统一小写。
 * @param text - 原始文本。
 * @returns 只保留字符与数字的规范化文本。
 */
function normalize(text: string): string {
  return text
    .replace(/^根据权利要求\s*\d+(?:\s*或\s*\d+)*\s*所述的?/u, '')
    .replace(CLAIM_BOILERPLATE, '')
    .replace(/^一种/u, '')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLowerCase()
}

/**
 * 找出修改文本中相对原文新增的连续片段。
 *
 * 优先用字符级最长公共子序列（LCS）做差异：只有修改稿中插入的连续字符才算
 * 新增，替换与保留的部分不误报。LCS 表按对照长度的乘积设上限，超长文本退回
 * 线性前缀匹配（更保守，可能多报）。
 * @param amended - 规范化后的修改文本。
 * @param source - 规范化后的对照文本。
 * @returns 新增连续片段及其起点，按出现顺序。
 */
function addedSpans(amended: string, source: string): AddedSpan[] {
  if (amended.length === 0 || source.length === 0) {
    return amended.length > 0 ? [{ text: amended, start: 0 }] : []
  }
  if ((amended.length + 1) * (source.length + 1) > MAX_DIFF_CELLS) {
    return prefixAddedSpans(amended, source)
  }

  const width = amended.length + 1
  const cells = new Uint16Array((source.length + 1) * width)
  // 下标全部落在已分配的 (source.length + 1) × width 表内。
  const cellAt = (index: number): number => Number(cells[index])
  for (let i = source.length - 1; i >= 0; i -= 1) {
    const rowBase = i * width
    const nextBase = rowBase + width
    for (let j = amended.length - 1; j >= 0; j -= 1) {
      cells[rowBase + j] = source.charCodeAt(i) === amended.charCodeAt(j)
        ? cellAt(nextBase + j + 1) + 1
        : Math.max(cellAt(nextBase + j), cellAt(rowBase + j + 1))
    }
  }

  const spans: AddedSpan[] = []
  let current = ''
  let currentStart = 0
  let i = 0
  let j = 0
  while (j < amended.length) {
    if (i < source.length && source.charCodeAt(i) === amended.charCodeAt(j)) {
      if (current.length > 0) {
        spans.push({ text: current, start: currentStart })
        current = ''
      }
      i += 1
      j += 1
      continue
    }
    if (i < source.length && cellAt((i + 1) * width + j) >= cellAt(i * width + j + 1)) {
      i += 1
      continue
    }
    if (current.length === 0) currentStart = j
    current += amended.charAt(j)
    j += 1
  }
  if (current.length > 0) spans.push({ text: current, start: currentStart })
  return spans
}

/**
 * 线性前缀匹配：LCS 超限时的保守兜底。
 * @param amended - 规范化后的修改文本。
 * @param source - 规范化后的对照文本。
 * @returns 原文中不存在的连续片段及其起点。
 */
function prefixAddedSpans(amended: string, source: string): AddedSpan[] {
  const spans: AddedSpan[] = []
  let current = ''
  let currentStart = 0
  let index = 0
  while (index < amended.length) {
    let matched = 0
    const maxLength = Math.min(MAX_MATCH_LENGTH, amended.length - index)
    for (let length = maxLength; length >= 2; length -= 1) {
      if (source.includes(amended.slice(index, index + length))) {
        matched = length
        break
      }
    }
    if (matched > 0) {
      if (current.length > 0) {
        spans.push({ text: current, start: currentStart })
        current = ''
      }
      index += matched
      continue
    }
    if (current.length === 0) currentStart = index
    current += amended.charAt(index)
    index += 1
  }
  if (current.length > 0) spans.push({ text: current, start: currentStart })
  return spans
}

/**
 * 剥离片段两端的虚词。
 * @param span - 新增片段。
 * @returns 去掉首尾虚词后的片段。
 */
function trimFunctionEdges(span: string): string {
  let start = 0
  let end = span.length
  while (start < end && FUNCTION_CHARS.has(span.charAt(start))) start += 1
  while (end > start && FUNCTION_CHARS.has(span.charAt(end - 1))) end -= 1
  return span.slice(start, end)
}

/**
 * 判断新增片段是否构成待复核的修改依据缺口。
 *
 * 多字片段按整段检索。单字片段（例如插入的 `不`）只在该字连同相邻上下文都见于
 * 原申请文件时才算已记载：单个 `不` 几乎在任何说明书中都出现过，按单字命中会把
 * 反转限定方向的修改静默放行。
 * @param span - 相对原权项新增的片段及其起点。
 * @param amended - 规范化后的修改文本。
 * @param basis - 规范化后的原申请文件全文。
 * @returns 缺口片段；已记载或仅由虚词组成时返回 undefined。
 */
function findBasisGap(span: AddedSpan, amended: string, basis: string): string | undefined {
  const trimmed = trimFunctionEdges(span.text)
  if (trimmed.length === 0) return undefined
  if (trimmed.length > 1) return basis.includes(trimmed) ? undefined : trimmed
  const start = span.start + span.text.indexOf(trimmed)
  const context = amended.slice(Math.max(0, start - 1), start + 2)
  return basis.includes(context) ? undefined : trimmed
}

/** amendment-basis 执行器：修改后权项对原申请文件的确定性核对。 */
export class AmendmentBasisHandler implements StageHandler {
  readonly name = 'amendment-basis'
  readonly category = 'gate' as const

  /**
   * 执行修改依据检查。
   * @param input - 阶段执行输入（state 携带答复正文与原申请文件）。
   * @returns 报告、通过标记、疑似超范围项与比对来源。
   */
  // oxlint-disable-next-line typescript/require-await -- StageHandler contract requires async execute
  async execute(input: StageExecuteInput): Promise<PipelineState> {
    const { state } = input
    const amendedKeys = resolveKeyList(state, 'amended_text_keys', DEFAULT_AMENDMENT_AMENDED_TEXT_KEYS)
    if (amendedKeys === undefined) {
      return degraded('amendment-basis', 'params.amended_text_keys 必须是非空字符串数组')
    }
    const originalKeys = resolveKeyList(state, 'original_text_keys', DEFAULT_AMENDMENT_ORIGINAL_TEXT_KEYS)
    if (originalKeys === undefined) {
      return degraded('amendment-basis', 'params.original_text_keys 必须是非空字符串数组')
    }

    const amended = readAmendedText(state, amendedKeys)
    if (amended.kind === 'missing') {
      return degraded('amendment-basis', '缺少答复正文（draft/response/amended_claims 均未提供）')
    }
    if (amended.kind === 'malformed') {
      return degraded('amendment-basis', `${amended.key} 必须是字符串或字符串数组`)
    }

    const section = extractClaimsSection(amended.text)
    if (section === undefined) {
      return {
        amendment_basis_report:
          '修改依据检查（A33）：通过（未检测到“修改后权利要求”段，视为未修改权利要求，A33 不适用）',
        amendment_basis_passed: true,
        amendment_basis_violations: [],
        amendment_basis_scope: '未检测到修改后权利要求',
      }
    }

    const original = readOriginalBasis(state, originalKeys)
    if (original.kind === 'malformed') {
      return degraded('amendment-basis', `${original.key} 必须是字符串或字符串数组`)
    }
    if (original.kind === 'missing') {
      return degraded(
        'amendment-basis',
        '检测到修改后权利要求，但缺少原申请文件（original_text/description/specification/claims）',
      )
    }

    const amendedClaims = parseClaims(section)
    const originalByNumber = new Map(original.claims.map(claim => [claim.number, claim.text]))
    const basis = normalize(original.text)
    const violations: AmendmentBasisViolation[] = []

    for (const claim of amendedClaims) {
      const sameNumber = originalByNumber.get(claim.number)
      const comparison =
        sameNumber ??
        (original.claims.length === 1 ? original.claims[0]?.text : undefined)
      const amendedText = normalize(claim.text)
      const spans =
        comparison !== undefined
          ? addedSpans(amendedText, normalize(comparison))
          : addedSpans(amendedText, basis)
      for (const span of spans) {
        const gap = findBasisGap(span, amendedText, basis)
        if (gap === undefined) continue
        violations.push({
          claimNo: claim.number,
          addedSpan: gap,
          detail: `修改后权利要求 ${claim.number} 新增片段「${gap}」未在原申请文件中记载`,
        })
      }
    }

    const passed = violations.length === 0
    return {
      amendment_basis_report: renderReport({
        passed,
        violations,
        claimNumbers: amendedClaims.map(claim => claim.number),
        scope: describeScope(original.sources),
      }),
      amendment_basis_passed: passed,
      amendment_basis_violations: violations,
      amendment_basis_scope: describeScope(original.sources),
    }
  }
}

/**
 * 描述比对来源。
 * @param sources - 参与比对的状态键。
 * @returns 人类可读的来源说明。
 */
function describeScope(sources: readonly string[]): string {
  const description = sources
    .map((source) => {
      if (source === 'claims' || source === 'original_claims') return '原权利要求书'
      if (source === 'specification' || source === 'description' || source === 'original_description') {
        return '原说明书'
      }
      return '原申请文件'
    })
    .filter((item, index, all) => all.indexOf(item) === index)
  return description.join(' + ')
}

/** 渲染检查报告。 */
function renderReport(options: {
  passed: boolean
  violations: readonly AmendmentBasisViolation[]
  claimNumbers: readonly string[]
  scope: string
}): string {
  const lines = [
    `修改依据检查（A33）：${options.passed ? '通过' : `未通过（${String(options.violations.length)} 处疑似新增）`}`,
    `- 比对来源：${options.scope}`,
    `- 修改后权项：${options.claimNumbers.join('、')}`,
  ]
  if (options.violations.length === 0) {
    lines.push('- 结论：修改后权项的新增内容均可在原申请文件中找到记载')
  } else {
    for (const violation of options.violations) {
      lines.push(`- ${violation.detail}`)
    }
  }
  lines.push('- 说明：字符级对照只定位未记载片段；是否可直接、毫无疑义地确定仍需人工复核')
  return lines.join('\n')
}
