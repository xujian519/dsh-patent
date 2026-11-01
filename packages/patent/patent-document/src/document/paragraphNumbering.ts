/**
 * 说明书段落编号（CNIPA 体例）：模板用 `data-paragraph-numbering` 声明编号范围与编号
 * 形态，引擎按声明把编号写成**字面文本**。
 *
 * 为什么是字面文本而不是 CSS 计数器：同一份 HTML 有两个下游——本引擎的 headless Chrome
 * PDF，以及第三方的 HTML→docx 转制。CSS `::before` 生成的内容只存在于渲染结果里，DOM
 * 文本中没有，转制方要么读不到、要么只能自己再算一遍，同一条编号规则于是出现两个真源。
 * 写成字面文本后，PDF 与 docx 读的是同一串字符。
 *
 * @module @deepseek-ai/dsh-patent-document/document/paragraphNumbering
 */

import { findMatchingCloseTag } from './htmlScan.ts'

/** 声明「本节内逐段编号」的属性名；属性值同时给出编号形态。 */
const PARAGRAPH_NUMBERING_ATTRIBUTE = 'data-paragraph-numbering'

/**
 * 编号形态：值形如 `[0001]`。数字段之前的文本为前缀，之后的文本为后缀，数字段长度即
 * 补零宽度，序号在各自声明区内从 1 起。
 */
interface NumberExemplar {
  /** 数字段之前的字面前缀（`[0001]` 为 `[`）。 */
  prefix: string
  /** 数字段之后的字面后缀（`[0001]` 为 `]`）。 */
  suffix: string
  /** 补零宽度（`[0001]` 为 4）。 */
  width: number
}

/** 可编号的段落元素；`h1`–`h6`、`table`、`pre` 等均不在此列。 */
const NUMBERABLE_TAGS = new Set(['p', 'li'])

/** 声明属性名与其带引号的值，供两处正则共用（一处匹配整条开标签，一处只取值）。 */
const ATTR_PAIR = `${PARAGRAPH_NUMBERING_ATTRIBUTE}\\s*=\\s*"([^"]*)"`

/** 从一条开标签文本中取出声明属性的值。 */
const ATTR_VALUE_RE = new RegExp(`^[\\s\\S]*\\s${ATTR_PAIR}[\\s\\S]*$`)

/** 不参与编号的容器：其内部的段落元素一律跳过。 */
const EXCLUDED_CONTAINERS = new Set(['table', 'figure'])

/**
 * 解析编号形态示例；不含数字段时返回 undefined（调用方按「未声明编号」处理）。
 * @param value - 属性值，如 `[0001]`。
 * @returns 前缀、后缀与补零宽度；无法解析时 undefined。
 */
export function parseNumberExemplar(value: string): NumberExemplar | undefined {
  const match = /^(\D*?)(\d+)(\D*)$/.exec(value.trim())
  if (match === null) return undefined
  const [, prefix = '', digits = '', suffix = ''] = match
  return { prefix, suffix, width: digits.length }
}

/**
 * 转义正则元字符，用于把模板给出的字面前缀与后缀拼进正则。
 * @param value - 字面文本。
 * @returns 可安全嵌入正则的字面文本。
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 剥掉段落已有的编号前缀。重复渲染因此幂等：模型若已手写 `[0001]`，不会叠加成
 * `[0001] [0001]`。
 * @param inner - 段落的 innerHTML。
 * @param exemplar - 编号形态。
 * @returns 去掉首个编号前缀的 innerHTML。
 */
function stripExistingNumber(inner: string, exemplar: NumberExemplar): string {
  const marker = new RegExp(
    `^[\\s\\u3000]*${escapeRegExp(exemplar.prefix)}\\d+${escapeRegExp(exemplar.suffix)}[\\s\\u3000]*`,
  )
  return inner.replace(marker, '')
}

/**
 * 判断段落是否有可见文本；只有图片或纯空白的段落不占用编号。
 * @param inner - 段落的 innerHTML。
 * @returns 去掉标记与空白后仍有内容时为 true。
 */
function hasVisibleText(inner: string): boolean {
  return inner.replace(/<[^>]*>/g, '').replace(/&nbsp;/gu, ' ').trim().length > 0
}

/**
 * 按宽度左补零。
 * @param value - 序号（从 1 起）。
 * @param width - 补零宽度。
 * @returns 补零后的序号文本。
 */
function padNumber(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

/** 一处待写入的编号与其替换范围。 */
interface NumberInsertion {
  /** 段落 innerHTML 的起始下标。 */
  start: number
  /** 段落 innerHTML 的结束下标（配对闭合标签起始位置）。 */
  end: number
  /** 写入的完整 innerHTML（编号 + 正文）。 */
  content: string
}

/**
 * 在一个声明区内逐段写入编号。
 * @param region - 声明元素的 innerHTML。
 * @param exemplar - 编号形态。
 * @returns 改写后的 innerHTML 与本区写入的编号段数。
 */
function numberRegion(region: string, exemplar: NumberExemplar): { html: string; count: number } {
  const insertions: NumberInsertion[] = []
  const tagRe = /<\/?([A-Za-z][A-Za-z0-9]*)\b[^>]*>/g
  let excludedDepth = 0
  let count = 0
  let match: RegExpExecArray | null
  while ((match = tagRe.exec(region)) !== null) {
    // 标签名与配对判定都从 token 文本取，不索引捕获组：正则保证组参与匹配，索引取值只会多出一条不可达的空值回退分支（与 htmlScan.findMatchingCloseTag 同一写法）。
    const name = match[0].replace(/^<\/?([A-Za-z][A-Za-z0-9]*).*/, '$1').toLowerCase()
    const isClose = region[match.index + 1] === '/'
    if (EXCLUDED_CONTAINERS.has(name)) {
      excludedDepth += isClose ? -1 : 1
      continue
    }
    if (excludedDepth > 0) continue
    if (isClose || !NUMBERABLE_TAGS.has(name)) continue
    const innerStart = match.index + match[0].length
    /* v8 ignore start -- 区间落在外层已配对的闭合标签之内，同样的配对扫描不会二次失配 */
    const closeStart = findMatchingCloseTag(region, innerStart)
    if (closeStart === undefined) continue
    /* v8 ignore stop */
    // 段落不嵌套：跳到配对闭合标签，段落内部的内容不会被重复编号。
    tagRe.lastIndex = closeStart
    const stripped = stripExistingNumber(region.slice(innerStart, closeStart), exemplar)
    if (!hasVisibleText(stripped)) continue
    count += 1
    insertions.push({
      start: innerStart,
      end: closeStart,
      content: `${exemplar.prefix}${padNumber(count, exemplar.width)}${exemplar.suffix} ${stripped}`,
    })
  }
  let html = region
  // 从右往左改写，前面的下标才不会因长度变化而失效。
  for (const item of insertions.slice().reverse()) {
    html = html.slice(0, item.start) + item.content + html.slice(item.end)
  }
  return { html, count }
}

/** 一个编号声明区在 HTML 中的位置与其编号形态。 */
interface NumberingScope {
  /** 声明元素 innerHTML 的起始下标。 */
  openEnd: number
  /** 配对闭合标签的起始下标。 */
  closeStart: number
  /** 编号形态。 */
  exemplar: NumberExemplar
}

/**
 * 施加模板声明的段落编号。
 *
 * 编号只作用于带 `data-paragraph-numbering` 的元素内部：`p` 与 `li` 逐个编号，序号从 1
 * 连续；`h1`–`h6` 标题、`table`/`figure` 内的内容，以及只有图片或空白的段落都不编号，
 * 也不占用序号。函数对已编号内容幂等（既有编号先剥后写）。
 * @param html - 已注入 sections 的 HTML。
 * @returns 编号后的 HTML、写入的编号段数与命中的声明区数量。
 */
export function applyParagraphNumbering(html: string): { html: string; numbered: number; scopes: number } {
  const scopes: NumberingScope[] = []
  const attrRe = new RegExp(`<([A-Za-z][A-Za-z0-9]*)\\b[^>]*\\s${ATTR_PAIR}[^>]*>`, 'gi')
  let match: RegExpExecArray | null
  while ((match = attrRe.exec(html)) !== null) {
    const openStart = match.index
    const openEnd = openStart + match[0].length
    const owner = scopes.find(scope => openStart >= scope.openEnd && openStart < scope.closeStart)
    // 外层声明已覆盖本区时不再重复编号（含声明元素紧接内层声明的相邻情形，此时两者的下标相等）；模板不嵌套声明，此处只做防御。
    if (owner !== undefined) continue
    // 形态从 token 文本取，不索引捕获组：正则保证属性值组参与匹配，索引取值只会多出一条不可达的空值回退分支。
    const exemplar = parseNumberExemplar(match[0].replace(ATTR_VALUE_RE, '$1'))
    if (exemplar === undefined) continue
    const closeStart = findMatchingCloseTag(html, openEnd)
    if (closeStart === undefined) continue
    scopes.push({ openEnd, closeStart, exemplar })
  }
  if (scopes.length === 0) return { html, numbered: 0, scopes: 0 }

  let result = html
  let numbered = 0
  // 从右往左改写，前面的下标才不会因长度变化而失效。
  for (const scope of scopes.slice().reverse()) {
    const applied = numberRegion(result.slice(scope.openEnd, scope.closeStart), scope.exemplar)
    numbered += applied.count
    result = result.slice(0, scope.openEnd) + applied.html + result.slice(scope.closeStart)
  }
  return { html: result, numbered, scopes: scopes.length }
}
