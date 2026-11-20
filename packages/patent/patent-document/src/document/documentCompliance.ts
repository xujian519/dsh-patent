/**
 * 对外文书的机械合规检查：章节编号唯一有序、无内部工作记录、证据编号与证据清单相互覆盖、
 * 修改对照表与修改后独权全文互相对应、三张表不留空表头。
 *
 * 这些约束写在 `templates/patent/invalidation-opinion/references/conventions.md` 与
 * `checklist.md` 中，但只有文字约束时依赖逐项自觉执行。本模块把它们变成可执行检查，
 * 由渲染管线在注入后调用，并可由 `scripts/verify-patent-document-output.ts` 离线复用。
 *
 * 内部工作记录的两条来源不同，分别处理：标题命中标题词表（待办／核验记录／口径等），
 * 正文命中正文词表（成功概率分档、缺口汇总、内部文件路径等）。标题词表按裸词匹配，
 * 正文词表按语义表达式匹配（`成功率|胜诉率|成功概率`），目的是让正文检查只命中内部
 * 记录特有的表达，不命中对外文书中正常的同形词。
 *
 * 「修改对照表 + 修改后独权全文」与「证据清单 + 引用日志」两处双份是所内口径（D-1 裁决，
 * 见 oa-response `conventions.md` §11）：双份保留，不合并。本模块守的是**两份对得上**——
 * 表里登记了修改、却没有对应的全文，或全文写的权项在表里没有登记，都报出来。文字是否
 * 逐字一致不判：对照表是差异摘要，允许省略中间段落，按子串比对必然误伤。
 * @module @deepseek-ai/dsh-patent-document/document/documentCompliance
 */

import { escapeRegExp } from '@deepseek-ai/dsh-value'

import { parseCnNumber } from '@deepseek-ai/dsh-patent-core'
import { findMatchingCloseTag } from './htmlScan.ts'

/** 合规问题类别。 */
export type ComplianceRule =
  | 'section-numbering'
  | 'internal-section'
  | 'internal-body'
  | 'evidence-cross-reference'
  | 'amendment-cross-reference'
  | 'empty-table'

/**
 * 检查范围。对外文书不得含内部工作记录；内部记录模板（如内部无效分析意见）正是这些
 * 记录的存放处，只接受章节编号与证据编号核对。
 */
export type ComplianceScope = 'external-filing' | 'internal-record'

/** 一条合规问题。 */
export interface ComplianceIssue {
  /** 命中的规则。 */
  rule: ComplianceRule
  /** 问题的可读描述，含命中的标题或用语。 */
  message: string
}

/** 标题元素：开标签到配对闭标签的整体匹配。 */
const HEADING_RE = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi

/** 非正文元素：样式表、脚本与注释都不呈现给读者，不作为内部记录的证据。 */
const NON_VISIBLE_RE = /<(style|script)\b[^>]*>[\s\S]*?<\/\1>|<!--[\s\S]*?-->/gi

/**
 * 章节编号的数码部分（不含后缀「、」）。数码的写法受限，因为编号要两两比大小：
 * `一二`、`二十三五` 这类无法确定数值的写法按非章节编号跳过，不猜。
 *
 * 导出给 sectionFold 的重编号共用：两处各自维护词表时，重编号可能把合规检查不认的
 * 写法当成节号去改，改完两边都自认为没问题。
 */
export const CN_SECTION_NUMERAL =
  '十[一二三四五六七八九]?|[一二三四五六七八九]十[一二三四五六七八九]?|[一二三四五六七八九]'

/** 章节编号：标题文本以中文数码（一至九十九）开头并后接「、」。命中的数码交给 {@link parseCnNumber} 取值。 */
const SECTION_NUMBER_RE = new RegExp(`^(${CN_SECTION_NUMERAL})、`)

/** 内部工作章节的标题用语。命中即表示内部工作记录进入了对外件。 */
const INTERNAL_SECTION_KEYWORDS = [
  '待办',
  '待填',
  '核验记录',
  '引用核验',
  '修订记录',
  '修订说明',
  '最坏情形',
  '缺口汇总',
  '口径',
] as const

/**
 * 正文中的内部工作记录用语。只收对外文书不可能出现的表达：成功概率分档是内部评估的
 * 结论形态，缺口汇总与待办是内部待办，`source_path` 是内部数据键。
 */
const INTERNAL_BODY_MARKERS: readonly { label: string; pattern: RegExp }[] = [
  { label: '待办/待填', pattern: /待办|待填|TODO|FIXME/ },
  { label: '核验记录', pattern: /核验记录|引用核验/ },
  { label: '修订记录', pattern: /修订记录|修订说明/ },
  { label: '最坏情形', pattern: /最坏情形/ },
  { label: '缺口汇总', pattern: /缺口汇总|缺口清单/ },
  { label: '成功概率分档', pattern: /成功率|胜诉率|成功概率|胜率/ },
  { label: '内部文件路径', pattern: /source_?path/i },
]

/**
 * 剥掉标签，返回元素或片段的可见文本。
 * @param html - 含标签的 HTML 片段。
 * @returns 去除标签并修剪空白后的文本。
 */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, '').trim()
}

/**
 * 检查文书 HTML 的章节编号、内部工作记录与证据编号引用。
 *
 * 章节编号规则：章节级标题以中文数码开头（如 `一、总体立场`），其余层级不使用该编号形式。
 * 章节编号在同一文书内不得重复，且须按出现顺序递增。模板骨架编号与 section 内容自带的
 * 编号并存时，重复编号与层级冲突都会被检出。章节层级取文档中第一个带中文编号标题的层级，
 * 随包模板样例中带该编号的都用 h2（claims-spec 全篇不带该编号）；不写死 h2 是因为部署可
 * 自带编号层级不同的模板，写死会把合规文书整篇误报。
 *
 * 标题与正文两处检查都先剥掉不呈现给读者的内容（样式表、脚本、注释）：注释里的标题既不是
 * 章节编号，也不构成内部记录泄漏，与正文用语检查取自同一段可见文本。
 *
 * 证据编号核对（见 {@link evidenceIssues}）在两种范围内都做：内部记录件同样按一套编号
 * 记账，清单与正文对不上时先修草案再出件。
 *
 * 双份核对（{@link amendmentIssues}）与空表核对（{@link emptyTableIssues}）只针对答复体例
 * 的三张表与「本次修改」章节；其余模板没有这些标记，检查自然跳过，不因模板差异误报。
 * @param html - 渲染后的文书 HTML。
 * @param scope - 检查范围；`internal-record` 不做内部工作记录检查。
 * @returns 命中的合规问题；全部通过时为空数组。
 */
export function checkDocumentCompliance(html: string, scope: ComplianceScope = 'external-filing'): ComplianceIssue[] {
  const issues: ComplianceIssue[] = []
  const seen = new Map<number, string>()
  const isExternal = scope === 'external-filing'
  let sectionLevel: number | undefined
  let previous = 0
  for (const match of html.replace(NON_VISIBLE_RE, ' ').matchAll(HEADING_RE)) {
    const level = Number(match[1])
    /* v8 ignore next -- 捕获组 2 由 HEADING_RE 保证存在；空值分支只为满足 noUncheckedIndexedAccess。 */
    const text = visibleText(match[2] ?? '')
    if (text === '') continue
    const hitKeyword = INTERNAL_SECTION_KEYWORDS.find(keyword => text.includes(keyword))
    if (isExternal && hitKeyword !== undefined) {
      issues.push({
        rule: 'internal-section',
        message: `标题含内部工作记录用语「${hitKeyword}」：${text}`,
      })
    }
    const numbered = SECTION_NUMBER_RE.exec(text)
    if (numbered === null) continue
    /* v8 ignore next -- 捕获组 1 由 SECTION_NUMBER_RE 保证存在；空值分支只为满足 noUncheckedIndexedAccess。 */
    const numeral = numbered[1] ?? ''
    if (sectionLevel === undefined) {
      sectionLevel = level
    } else if (level !== sectionLevel) {
      issues.push({
        rule: 'section-numbering',
        message: `章节编号只用于章节级标题（h${sectionLevel}），「${numeral}、」出现在 h${level}：${text}`,
      })
      continue
    }
    const value = parseCnNumber(numeral)
    /* v8 ignore next -- 数码写法已由 SECTION_NUMBER_RE 限定为良构，parseCnNumber 不返回 null。 */
    if (value === null) continue
    const duplicate = seen.get(value)
    if (duplicate !== undefined) {
      issues.push({
        rule: 'section-numbering',
        message: `章节编号「${numeral}、」重复：${duplicate} / ${text}`,
      })
      continue
    }
    if (value < previous) {
      issues.push({
        rule: 'section-numbering',
        message: `章节编号乱序：「${numeral}、」出现在编号 ${previous} 之后（${text}）`,
      })
    }
    seen.set(value, text)
    previous = Math.max(previous, value)
  }
  issues.push(...evidenceIssues(html))
  issues.push(...amendmentIssues(html))
  issues.push(...emptyTableIssues(html))
  if (isExternal) issues.push(...bodyIssues(html))
  return issues
}

/**
 * 正文内部用语检查。标题及其用语已由标题检查覆盖，故先从正文里剥掉标题元素，避免同一处
 * 内容重复报告。
 * @param html - 渲染后的文书 HTML。
 * @returns 命中的正文问题。
 */
function bodyIssues(html: string): ComplianceIssue[] {
  const text = visibleText(html.replace(NON_VISIBLE_RE, ' ').replace(HEADING_RE, ' '))
  const issues: ComplianceIssue[] = []
  for (const marker of INTERNAL_BODY_MARKERS) {
    if (!marker.pattern.test(text)) continue
    issues.push({
      rule: 'internal-body',
      message: `正文含内部工作记录用语「${marker.label}」：内部评估与待办事项写入案卷内部文件`,
    })
  }
  return issues
}

/**
 * 证据清单表与清单节的定位标记。模板把清单节标成 `aria-label="证据清单"`，渲染管线另给
 * 表体挂 `id="evidence-table"` 注入锚点；随包样例保留 aria-label 而去掉注入锚点，故两者
 * 都认，先认节点后认锚点，任一命中即可核对。
 */
const EVIDENCE_SECTION_OPEN_RE = /<section[^>]*\saria-label=["']证据清单["'][^>]*>/i
const EVIDENCE_TABLE_BODY_RE = /<tbody[^>]*\sid=["']evidence-table["'][^>]*>/i

/** 证据编号的形态：前缀（`D`、`附件`…）+ 十进制序号。前缀取自清单编号列，不预设词表。 */
const EVIDENCE_ID_RE = /^(\D+?)\s*(\d+)$/

/** 未填写的编号列：空单元格，或模板占位的下划线。 */
const BLANK_ID_RE = /^_*$/

/** 编号区间的最大跨度：`D1–D4` 按四条展开，跨度更大的写法按普通文字处理。 */
const MAX_ID_RANGE_SPAN = 9

/**
 * 取捕获组文本。捕获组由本模块各正则的必选分组保证存在，空值分支不可达，只为满足
 * noUncheckedIndexedAccess（仓内禁用非空断言）。
 * @param match - 正则匹配结果。
 * @param index - 捕获组序号。
 * @returns 捕获组文本。
 */
function group(match: RegExpExecArray, index: number): string {
  /* v8 ignore next -- 捕获组由调用方正则的必选分组保证存在。 */
  return match[index] ?? ''
}

/** 编号的规范形态：前缀 + 十进制序号（去掉前导零），清单与正文两侧比对用同一形态。 */
function canonicalId(prefix: string, number: number): string {
  return `${prefix}${number}`
}

/**
 * 清单编号列取值 → 规范编号与前缀；取值不是「前缀 + 序号」形态时返回 undefined。
 * @param id - 编号列单元格的可见文本（已去掉中间空白）。
 * @returns 规范编号（`D01` → `D1`）与该编号的前缀；无法识别时为 undefined。
 */
function parseEvidenceId(id: string): { id: string; prefix: string } | undefined {
  const match = EVIDENCE_ID_RE.exec(id)
  if (match === null) return undefined
  const prefix = group(match, 1)
  return { id: canonicalId(prefix, Number(group(match, 2))), prefix }
}

/**
 * 取证据清单表在 HTML 中的区间（含 `<table>` 与 `</table>`）。
 * @param html - 渲染后的文书 HTML。
 * @returns 清单表的起止下标；文档没有带标记的清单表时 undefined。
 */
function evidenceTableRange(html: string): { start: number; end: number } | undefined {
  const section = EVIDENCE_SECTION_OPEN_RE.exec(html)
  let start: number
  if (section === null) {
    const body = EVIDENCE_TABLE_BODY_RE.exec(html)
    if (body === null) return undefined
    start = html.lastIndexOf('<table', body.index)
  } else {
    const bodyStart = section.index + section[0].length
    const sectionEnd = findMatchingCloseTag(html, bodyStart) ?? html.length
    const table = /<table[^>]*>/i.exec(html.slice(bodyStart, sectionEnd))
    if (table === null) return undefined
    start = bodyStart + table.index
  }
  // 定位失败时 start 为 -1 或落在非开标签处，下面的正则匹配不中，按没有清单表处理。
  const open = /^<table[^>]*>/i.exec(html.slice(start))
  if (open === null) return undefined
  const close = findMatchingCloseTag(html, start + open[0].length)
  if (close === undefined) return undefined
  return { start, end: close + '</table>'.length }
}

/**
 * 取表格首列：每个数据行第一个单元格的可见文本（去掉中间空白）。
 *
 * 证据清单的编号列与修改对照表的权项列都是「首列是键、其余是内容」的形态，两处共用。
 * @param table - 表格 HTML（含表头与表体）。
 * @returns 按行序排列的首列文本；单元格未填写时为空串；没有表体时为空数组。
 */
function firstColumnCells(table: string): string[] {
  const cells: string[] = []
  for (const tbody of table.matchAll(/<tbody[^>]*>([\s\S]*?)<\/tbody>/gi)) {
    for (const row of group(tbody, 1).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cell = /<td[^>]*>([\s\S]*?)<\/td>/i.exec(group(row, 1))
      cells.push(cell === null ? '' : visibleText(group(cell, 1)).replace(/\s+/g, ''))
    }
  }
  return cells
}

/**
 * 取正文文本里的证据编号引用。只认清单编号列出现过的前缀，因此专利号与附图标记里的数字
 * 不会被当成证据编号，编号列写成纯数字的清单也不参与核对（无法与正文中的序号区分）。
 * 区间写法（`D1–D4`、`D1 至 D4`）按逐个编号展开，登记为一条范围证据时不会误报未引用。
 * @param text - 清单表之外的可见正文文本。
 * @param prefixes - 清单编号列出现过的前缀。
 * @returns 正文引用到的编号（规范形态）。
 */
function citedIds(text: string, prefixes: readonly string[]): Set<string> {
  const cited = new Set<string>()
  for (const prefix of prefixes) {
    const escaped = escapeRegExp(prefix)
    // 前缀左侧不是字母数字，避免把单词尾部的同形前缀当成编号（如 `END2`）。
    for (const match of text.matchAll(new RegExp(`(?<![A-Za-z0-9])${escaped}\\s*(\\d+)`, 'g'))) {
      cited.add(canonicalId(prefix, Number(match[1])))
    }
    const range = new RegExp(`(?<![A-Za-z0-9])${escaped}\\s*(\\d+)\\s*[-–—~～至]\\s*(?:${escaped}\\s*)?(\\d+)`, 'g')
    for (const match of text.matchAll(range)) {
      const from = Number(match[1])
      const to = Number(match[2])
      if (to <= from || to - from > MAX_ID_RANGE_SPAN) continue
      for (let number = from + 1; number <= to; number += 1) cited.add(canonicalId(prefix, number))
    }
  }
  return cited
}

/**
 * 证据编号与清单的相互覆盖检查。
 *
 * 两侧的编号形态都取自清单编号列，不预设编号词表：正文引用的编号必须在清单里登记，清单
 * 登记的编号必须在正文（清单表之外）出现一次。清单表本身不计入引用位置——表里的编号只是
 * 登记，不是使用。编号列留空的行无法被正文引用，单独报出。
 * @param html - 渲染后的文书 HTML。
 * @returns 命中的合规问题；文档没有证据清单表时为空数组。
 */
function evidenceIssues(html: string): ComplianceIssue[] {
  const range = evidenceTableRange(html)
  if (range === undefined) return []
  const issues: ComplianceIssue[] = []
  const registered = new Map<string, string>()
  firstColumnCells(html.slice(range.start, range.end)).forEach((id, index) => {
    if (BLANK_ID_RE.test(id)) {
      issues.push({
        rule: 'evidence-cross-reference',
        message: `证据清单第 ${index + 1} 行未填编号：正文无法引用该条证据，登记编号后正文与清单共用同一写法`,
      })
      return
    }
    const parsed = parseEvidenceId(id)
    if (parsed !== undefined) registered.set(parsed.id, parsed.prefix)
  })
  const prefixes = [...new Set(registered.values())]
  if (prefixes.length === 0) return issues
  const rest = html.slice(0, range.start) + html.slice(range.end)
  const cited = citedIds(visibleText(rest.replace(NON_VISIBLE_RE, ' ')), prefixes)
  for (const id of registered.keys()) {
    if (cited.has(id)) continue
    issues.push({
      rule: 'evidence-cross-reference',
      message: `证据清单登记的「${id}」在正文中未被引用：删除该条，或在支撑的理由、结论表中引用它`,
    })
  }
  for (const id of cited) {
    if (registered.has(id)) continue
    issues.push({
      rule: 'evidence-cross-reference',
      message: `正文引用的「${id}」未登记在证据清单：在清单中补登该条证据`,
    })
  }
  return issues
}

/**
 * 「本次修改」章节的定位标记。答复体例把这个章节标成 `aria-label="本次修改"`；其余模板
 * 没有该章节，双份核对随即跳过。
 */
const AMENDMENT_SECTION_OPEN_RE = /<section[^>]*\saria-label=["']本次修改["'][^>]*>/i

/**
 * 修改后独权全文块的定位标记：带 `claim-text` 类的元素。模板用 `<div>`，手改件可能用
 * `<p>`，故只按 class 认、不限标签。全局正则只用于 `matchAll`（不改 `lastIndex`）。
 */
const CLAIM_TEXT_OPEN_RE = /<[a-z][^>]*\sclass=["'][^"']*\bclaim-text\b[^"']*["'][^>]*>/gi

/** 表 1 首列的权项号写法：`权1`、`权利要求 1`、`1`（匹配前已去掉空白）。 */
const CLAIM_LABEL_RE = /^(?:权利要求|权项|权)?(\d+)$/

/** 权项全文里的权项号：`权利要求 1：`、`权1`。全局正则只用于 `matchAll`。 */
const CLAIM_MENTION_RE = /权(?:利要求)?\s*(\d+)/g

/**
 * 取表 1 首列的权项号。
 * @param table - 修改对照表 HTML（含表头与表体）。
 * @returns 可识别的权项号，按行序；首列写法不是权项编号的行不进结果。
 */
function claimRowNumbers(table: string): number[] {
  const numbers: number[] = []
  for (const cell of firstColumnCells(table)) {
    const match = CLAIM_LABEL_RE.exec(cell)
    if (match === null) continue
    numbers.push(Number(group(match, 1)))
  }
  return numbers
}

/**
 * 修改对照表与修改后独权全文的对应检查（D-1 裁决：双份保留，不合并）。
 *
 * `conventions.md` §6 要求修改后的独立权利要求全文呈现，不能只写「参见修改对照表」；§11
 * 说明两处双份是刻意的，守的是两份对得上。两个方向各报一种：
 *
 * 1. 表 1 登记了修改，章节里却没有全文 → 只做了差异视图，没有生效文本。
 * 2. 全文写的权项在表 1 没有登记 → 生效文本对应的修改项在差异视图里查不到。
 *
 * 反向不报（表 1 有权项而全文没有）：从属权项的修改只出现在对照表里是合规体例，
 * §6 只要求独立权利要求全文呈现。逐字比对也不做：对照表是差异摘要，允许省略中间段落。
 * @param html - 渲染后的文书 HTML。
 * @returns 命中的合规问题；文档没有「本次修改」章节时为空数组。
 */
function amendmentIssues(html: string): ComplianceIssue[] {
  const section = AMENDMENT_SECTION_OPEN_RE.exec(html)
  if (section === null) return []
  const start = section.index + section[0].length
  const end = findMatchingCloseTag(html, start) ?? html.length
  const inner = html.slice(start, end)

  let rowNumbers: number[] = []
  const table = /<table[^>]*>/i.exec(inner)
  if (table !== null) {
    const tableStart = start + table.index
    const tableClose = findMatchingCloseTag(html, tableStart + table[0].length)
    if (tableClose !== undefined) {
      rowNumbers = claimRowNumbers(html.slice(tableStart, tableClose + '</table>'.length))
    }
  }

  const fullTextNumbers = new Set<number>()
  let hasFullText = false
  for (const block of inner.matchAll(CLAIM_TEXT_OPEN_RE)) {
    hasFullText = true
    const blockStart = start + block.index + block[0].length
    const blockEnd = findMatchingCloseTag(html, blockStart) ?? end
    for (const mention of visibleText(html.slice(blockStart, blockEnd)).matchAll(CLAIM_MENTION_RE)) {
      fullTextNumbers.add(Number(group(mention, 1)))
    }
  }

  const issues: ComplianceIssue[] = []
  // 表 1 首列没有可识别的权项号（如整列写「权利要求书」）时无从对照，不猜。
  if (rowNumbers.length === 0) return issues
  if (!hasFullText) {
    issues.push({
      rule: 'amendment-cross-reference',
      message: `表 1 登记了 ${rowNumbers.length} 项修改，本章没有「修改后的独立权利要求」全文：conventions §6 要求全文呈现，不能只写「参见修改对照表」`,
    })
    return issues
  }
  for (const number of fullTextNumbers) {
    if (rowNumbers.includes(number)) continue
    issues.push({
      rule: 'amendment-cross-reference',
      message: `修改后全文写的是权利要求 ${number}，表 1 没有登记该权项的修改：对照表（差异视图）与全文（生效文本）必须互相对应`,
    })
  }
  return issues
}

/**
 * 答复体例三张表的数据体 id 与表名。按 id 定位而不按「所有 `<table>`」：别的模板的表格
 * 不在本条口径内，按标签定位会把表单模板的空白表当缺陷。
 */
const CHECKED_TABLE_BODIES: readonly (readonly [string, string])[] = [
  ['amendment-table', '表 1 权利要求修改对照'],
  ['evidence-table', '表 2 证据与对比文件清单'],
  ['citation-table', '表 3 关键断言溯源'],
]

/** 未填写的单元格：空，或模板占位的连续下划线。 */
const PLACEHOLDER_CELL_RE = /^_*$/

/**
 * 一个数据行是否全部未填写（空或占位下划线）。
 * @param row - 一个 `<tr>` 的内容。
 * @returns 该行没有任何单元填写内容时为 true；没有 `<td>` 的行按未填写处理。
 */
function rowIsBlank(row: string): boolean {
  for (const cell of row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)) {
    if (!PLACEHOLDER_CELL_RE.test(visibleText(group(cell, 1)).replace(/\s+/g, ''))) return false
  }
  return true
}

/**
 * 三张表不留空表头：只有表头没有数据行，或数据行整行都是模板占位符。
 *
 * 草案校验已拒绝空行数组（`validateRows` 要求至少一行），故「没有数据行」只可能来自
 * 手改 HTML；「整行占位」则是模型把模板占位符当内容抄进草案的形态——两种都会让读者
 * 分不清是本案确无此类内容还是漏填，故一并报出。
 * @param html - 渲染后的文书 HTML。
 * @returns 命中的合规问题；文档没有这三张表时为空数组。
 */
function emptyTableIssues(html: string): ComplianceIssue[] {
  const issues: ComplianceIssue[] = []
  for (const [id, label] of CHECKED_TABLE_BODIES) {
    const body = new RegExp(`<tbody[^>]*\\bid=["']${id}["'][^>]*>([\\s\\S]*?)</tbody>`, 'i').exec(html)
    if (body === null) continue
    // 没有单元格的行不承载数据（行容器写坏了），与「一行都没有」同判：这张表没有数据。
    const rows = [...group(body, 1).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map(row => group(row, 1))
      .filter(row => /<td[^>]*>/i.test(row))
    if (rows.length === 0) {
      issues.push({
        rule: 'empty-table',
        message: `${label}只有表头没有数据行：无内容时整表删除，有内容时至少填一行`,
      })
      continue
    }
    if (!rows.every(row => rowIsBlank(row))) continue
    issues.push({
      rule: 'empty-table',
      message: `${label}的数据行全是模板占位符：占位符不是内容，按实际条目填写或整表删除`,
    })
  }
  return issues
}
