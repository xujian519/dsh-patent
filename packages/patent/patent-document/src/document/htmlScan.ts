/**
 * 模板 HTML 的标签扫描工具。模板是随包分发的受控良构 HTML，引擎因此以字符串扫描
 * 代替 DOM 依赖；本模块是渲染与编号两处扫描的唯一实现。
 * @module @deepseek-ai/dsh-patent-document/document/htmlScan
 */

/** HTML void 元素（无闭合标签），标签配平扫描时跳过。 */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

/**
 * 从开标签结束位置向后扫描，找到与之配对的闭合标签起始下标。
 * 用全标签深度计数处理嵌套内容（模板为受控的良构 HTML）。
 * @param html - HTML 文本。
 * @param openEnd - 开标签结束位置。
 * @returns 配对闭合标签起始下标，未找到时 undefined。
 */
export function findMatchingCloseTag(html: string, openEnd: number): number | undefined {
  const tagRe = /<\/?[A-Za-z][^>]*>/g
  tagRe.lastIndex = openEnd
  let depth = 1
  let match: RegExpExecArray | null
  while ((match = tagRe.exec(html)) !== null) {
    const token = match[0]
    // tagRe 保证 token 以字母开头的标签名开始；用捕获组提取标签名。
    const name = token.replace(/^<\/?([A-Za-z][A-Za-z0-9]*).*/, '$1').toLowerCase()
    if (token.startsWith('</')) {
      depth -= 1
      if (depth === 0) return match.index
    } else {
      if (VOID_TAGS.has(name) || /\/>$/.test(token)) continue
      depth += 1
    }
  }
  return undefined
}
