/**
 * 通用文档模板的空节折叠与章节重编号。
 *
 * 模板骨架里可选的章节（审查意见答复的「六、其他缺陷的处理」「5.3 其他争点」）在草案
 * 没有对应槽位内容时，整块都不得进入成品：只留一个空标题，读者无从判断是本案确无此类
 * 缺陷还是漏填了。折叠的依据是模板作者的显式授权——带 `data-omit-if-empty="<槽位 id>"`
 * 的块；未标记的章节无论内容多少都不动。
 *
 * 折叠会让章节序号出现缺号（一二三四五**七**八），而 `checkDocumentCompliance` 只查
 * 编号重复与乱序、不查缺号，因此缺号不会被报出来，只会留在成品里。故折叠之后同一处
 * 一并重编：章节级标题按出现顺序改为 1..N，其下小节标题的 `<节号>.` 前缀随之改写。
 *
 * 重编号只在确实折叠过东西时调用（见 renderPatentDocument）：没有折叠就连号，
 * 其他模板的既有编号一个字符都不动。
 * @module @deepseek-ai/dsh-patent-document/document/sectionFold
 */

import { formatCnNumber, parseCnNumber } from '@deepseek-ai/dsh-patent-core'
import { CN_SECTION_NUMERAL } from './documentCompliance.ts'
import { DocumentRenderError } from './errors.ts'
import { findMatchingCloseTag } from './htmlScan.ts'

/** 折叠标记：`data-omit-if-empty` 的值是被绑定槽位的 id。 */
const OMIT_BLOCK_RE = /<([A-Za-z][A-Za-z0-9]*)[^>]*\bdata-omit-if-empty=["']([^"']+)["'][^>]*>/g

/** 标题元素：开标签、属性、内容。重编号取文档顺序遍历。 */
const HEADING_RE = /<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/gi

/** 块内第一个标题（折叠告警用标题文本报出被删的是哪一节）。 */
const FIRST_HEADING_RE = /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i

/** 章节级标题的中文序号（含缩进，供重写时保留原有缩进）。 */
const SECTION_NUMBER_RE = new RegExp(`^([ \\t]*)(${CN_SECTION_NUMERAL})、`)

/** 小节标题的 `<节号>.` 前缀；只取第一段数字，`7.1.2` 这类三级编号改写节号后仍保留其余段。 */
const SUBSECTION_NUMBER_RE = /^([ \t]*)(\d+)(?=\.\d)/

/** 被折叠的一个块。 */
interface FoldedSection {
  /** 块绑定的槽位 id。 */
  id: string
  /** 块的标题文本（去标签后的可见文本）；块内没有标题时退化为槽位 id。 */
  title: string
}

/** 折叠结果。 */
interface SectionFoldResult {
  /** 折叠后的 HTML。 */
  html: string
  /** 被移除的块，按文档顺序。 */
  folded: FoldedSection[]
}

/**
 * 去掉标签取可见文本，空白折叠为单空格。
 * @param html - HTML 片段。
 * @returns 可见文本。
 */
function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
}

/**
 * 块起始行的行首下标：连同整行缩进一起移除，成品里不留空白行。
 * @param html - HTML 文本。
 * @param index - 块的起始下标。
 * @returns 行首下标。
 */
function lineStartOf(html: string, index: number): number {
  let start = index
  while (start > 0 && (html[start - 1] === ' ' || html[start - 1] === '\t')) start -= 1
  return start
}

/**
 * 取块的标题文本：块内第一个标题元素。
 * @param inner - 块内容。
 * @param fallback - 块内没有标题时的替代文本（槽位 id）。
 * @returns 标题文本。
 */
function blockTitle(inner: string, fallback: string): string {
  const heading = FIRST_HEADING_RE.exec(inner)
  if (heading === null) return fallback
  /* v8 ignore next -- 捕获组 1 由 FIRST_HEADING_RE 保证存在；空值分支只为满足 noUncheckedIndexedAccess。 */
  return visibleText(heading[1] ?? '')
}

/**
 * 移除「槽位无内容」的可选块（含标题、容器与其间的空元素），连同整行缩进。
 *
 * 只处理带 `data-omit-if-empty` 标记的块；标记的槽位 id 出现在 `present` 里时原样保留。
 * 标记元素必须以同名闭标签收尾——随包模板是良构 HTML，闭合标签带空白意味着模板作者
 * 手改了骨架，此时报错比按错误长度截断、静默产出缺角 HTML 好。
 * @param html - 草案注入后的文档 HTML。
 * @param present - 本次草案确实提供了内容的槽位 id 集合。
 * @returns 折叠后的 HTML 与被移除的块。
 */
export function foldEmptyOptionalSections(html: string, present: ReadonlySet<string>): SectionFoldResult {
  const folded: FoldedSection[] = []
  let result = html
  let from = 0
  for (;;) {
    OMIT_BLOCK_RE.lastIndex = from
    const match = OMIT_BLOCK_RE.exec(result)
    if (match === null) break
    /* v8 ignore next -- 捕获组 1 由 OMIT_BLOCK_RE 的必选分组保证存在；空值分支只为满足 noUncheckedIndexedAccess。 */
    const tag = match[1] ?? ''
    /* v8 ignore next -- 捕获组 2 同上。 */
    const id = match[2] ?? ''
    const openEnd = match.index + match[0].length
    if (present.has(id)) {
      from = openEnd
      continue
    }
    const closeStart = findMatchingCloseTag(result, openEnd)
    if (closeStart === undefined) {
      from = openEnd
      continue
    }
    const closeTag = `</${tag}>`
    if (!result.startsWith(closeTag, closeStart)) {
      throw new DocumentRenderError(`空节折叠：槽位 ${id} 的块以 <${tag}> 开启，闭合标签却不是 ${closeTag}`)
    }
    const blockEnd = closeStart + closeTag.length
    folded.push({ id, title: blockTitle(result.slice(openEnd, closeStart), id) })
    const lineEnd = result.startsWith('\n', blockEnd) ? blockEnd + 1 : blockEnd
    const lineStart = lineStartOf(result, match.index)
    result = result.slice(0, lineStart) + result.slice(lineEnd)
    from = lineStart
  }
  return { html: result, folded }
}

/**
 * 按出现顺序把章节级标题重编为 1..N，并改写其下小节标题的 `<节号>.` 前缀。
 *
 * 章节层级取文档中第一个带中文序号的标题所在层级（与 `checkDocumentCompliance` 同一判定），
 * 不写死 h2：部署自带的模板可能用别的层级。小节前缀按「所属章节的旧节号 → 新节号」映射改写，
 * 前缀不是任何已知旧节号时原样保留，不猜。
 * @param html - 文档 HTML。
 * @returns 重编号后的 HTML；文档没有中文序号章节时原样返回。
 */
export function renumberSections(html: string): string {
  const matches = [...html.matchAll(HEADING_RE)]
  let sectionLevel: number | undefined
  for (const match of matches) {
    /* v8 ignore next -- 捕获组 3 由 HEADING_RE 保证存在；空值分支只为满足 noUncheckedIndexedAccess。 */
    if (!SECTION_NUMBER_RE.test(visibleText(match[3] ?? ''))) continue
    sectionLevel = Number(match[1])
    break
  }
  if (sectionLevel === undefined) return html

  let out = ''
  let cursor = 0
  let expected = 0
  /** 旧节号 → 新节号；小节前缀按它改写。 */
  const mapping = new Map<number, number>()
  for (const match of matches) {
    const start = match.index
    /* v8 ignore next -- 捕获组 3 由 HEADING_RE 保证存在；空值分支只为满足 noUncheckedIndexedAccess。 */
    const inner = match[3] ?? ''
    const numbered = Number(match[1]) === sectionLevel ? SECTION_NUMBER_RE.exec(inner) : null
    let next: string | undefined
    if (numbered !== null) {
      /* v8 ignore next -- 捕获组 2 由 SECTION_NUMBER_RE 保证存在。 */
      const oldValue = parseCnNumber(numbered[2] ?? '')
      /* v8 ignore next -- 数码写法已由 CN_SECTION_NUMERAL 限定为良构，parseCnNumber 不返回 null。 */
      if (oldValue !== null) {
        expected += 1
        mapping.set(oldValue, expected)
        /* v8 ignore next -- 捕获组 1 由 SECTION_NUMBER_RE 保证存在。 */
        if (oldValue !== expected) {
          // 「、」由本处补回：numbered[0] 含数码与后缀，整体换掉时后缀必须重新写。
          next = `${numbered[1] ?? ''}${formatCnNumber(expected)}、${inner.slice(numbered[0].length)}`
        }
      }
    } else {
      const sub = SUBSECTION_NUMBER_RE.exec(inner)
      if (sub !== null) {
        /* v8 ignore next -- 捕获组 1 由 SUBSECTION_NUMBER_RE 保证存在。 */
        const lead = sub[1] ?? ''
        /* v8 ignore next -- 捕获组 2 同上。 */
        const digits = sub[2] ?? ''
        const oldPrefix = Number(digits)
        const target = mapping.get(oldPrefix)
        if (target !== undefined && target !== oldPrefix) {
          // 只换节号本身：`.1`、`.1.2` 等等级后缀原样留着，节内小节序不因折叠而变。
          next = `${lead}${target}${inner.slice(lead.length + digits.length)}`
        }
      }
    }
    if (next === undefined) continue
    // 开标签在标题元素内的首个「>」处结束（属性和内容里不会有裸「>」）。
    const openEnd = match[0].indexOf('>') + 1
    out += html.slice(cursor, start) + match[0].slice(0, openEnd) + next + match[0].slice(openEnd + inner.length)
    cursor = start + match[0].length
  }
  return out + html.slice(cursor)
}
