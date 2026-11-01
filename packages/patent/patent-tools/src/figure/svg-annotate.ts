/**
 * SVG 附图标号后处理（纯函数，无 IO；移植自 Claude-Patent-Creator 的
 * add_reference_numbers，详见 README 归属）。
 *
 * 对 Graphviz 输出的 SVG 按 `<text>`/`<tspan>` 结构在匹配文本末尾追加
 * ` (n)` 参考标号。安全约束：拒绝 DOCTYPE/ENTITY/CDATA（防 XXE/实体
 * 膨胀），输入有大小上限；未命中任何元素的参考列为 warning 返回而非
 * 静默——与图面「标号缺失」可追溯原则一致。
 *
 * @module @deepseek-ai/dsh-patent-tools/figure/svg-annotate
 */

/** SVG 标注错误码。 */
type SvgAnnotateErrorCode = 'unsafe_svg' | 'invalid_svg' | 'too_large' | 'invalid_reference'

/** SVG 标注错误。 */
export class SvgAnnotateError extends Error {
  /** 标注错误码（工具层映射为 invalid_tool_input）。 */
  readonly code: SvgAnnotateErrorCode

  constructor(code: SvgAnnotateErrorCode, message: string) {
    super(message)
    this.name = 'SvgAnnotateError'
    this.code = code
  }
}

/** 一条标注参考：label 匹配图内文本；numeral 追加到匹配文本末尾。 */
export type SvgAnnotateReference = {
  /** 待匹配的组件文本（子串匹配，大小写不敏感）。 */
  label: string
  /** 参考标号（如 "20"、"101"），插入形式为 ` (numeral)`。 */
  numeral: string
}

/** 标注结果：新 SVG 文本 + 未命中警告。 */
type SvgAnnotateResult = {
  svg: string
  /** 未在任何文本元素中匹配到的参考 label（按传入顺序）。 */
  warnings: string[]
}

/** 默认 SVG 输入大小上限（字节）。 */
export const DEFAULT_SVG_MAX_BYTES = 2_000_000

/**
 * 转义 XML 文本（插入内容仅允许出现在文本节点）。
 * @param text - 待转义原文。
 * @returns 文本节点安全的转义结果。
 */
export function escapeXmlText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 解码文本节点中常见的 XML 实体（仅用于匹配比较，输出保持原文）。 */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
}

/**
 * 检查 SVG 文本中的不安全结构（实体定义/CDATA）、大小与根元素——
 * SVG 后处理模块（annotateSvg / leader-line）共享的输入安全校验。
 * @param svgText - 原始 SVG 文本。
 * @param maxBytes - 输入大小上限（字节）。
 * @throws SvgAnnotateError 校验不通过时（unsafe_svg / too_large / invalid_svg）。
 */
export function assertSafeSvg(svgText: string, maxBytes: number): void {
  const lower = svgText.toLowerCase()
  // Graphviz 自带标准 <!DOCTYPE svg PUBLIC ...>（无实体声明）；本模块不做 XML
  // 解析，实体不会展开，因此只拒绝实体定义与 CDATA（未来接解析器时的防线）。
  if (lower.includes('<!entity') || lower.includes('<![cdata[')) {
    throw new SvgAnnotateError('unsafe_svg', 'SVG 包含 ENTITY/CDATA 等不安全结构，拒绝处理')
  }
  // 上限按 UTF-8 字节计（与文案一致）：中文附图的码元数远小于字节数，按 length 比较会
  // 放过三倍体量的输入。
  if (Buffer.byteLength(svgText, 'utf8') > maxBytes) {
    throw new SvgAnnotateError('too_large', `SVG 过大（>${maxBytes} 字节），拒绝处理`)
  }
  if (!/<svg[\s>]/i.test(svgText) || !/<\/svg>/i.test(svgText)) {
    throw new SvgAnnotateError('invalid_svg', '非 SVG 文档：缺少 <svg> 根元素')
  }
}

/**
 * 提取文本元素的可见文本（实体解码、子标签剥离），供匹配比较——
 * annotateSvg 与 leader-line 共用的匹配规范化。
 * @param textElement - 单个 `<text>...</text>` 片段。
 * @returns 可见文本（未做大小写归一）。
 */
export function textElementContent(textElement: string): string {
  return decodeEntities(stripTags(textElement))
}

/**
 * 校验参考标号列表：每个参考的 label 与 numeral 均不得为空（trim 后）。
 * @param references - 参考标号列表。
 * @throws SvgAnnotateError 任一参考的 label 或 numeral 为空。
 */
export function validateSvgReferences(references: readonly SvgAnnotateReference[]): void {
  for (const ref of references) {
    if (ref.label.trim() === '') {
      throw new SvgAnnotateError('invalid_reference', '参考 label 不能为空')
    }
    if (ref.numeral.trim() === '') {
      throw new SvgAnnotateError('invalid_reference', `参考 "${ref.label}" 的 numeral 不能为空`)
    }
  }
}

/**
 * 在 SVG 文本元素的匹配文本末尾追加参考标号。
 *
 * 每个 `<text>` 元素至多命中一个参考（按 references 传入顺序取首个匹配），
 * 同一个参考可命中多个文本元素（同一组件在图内多处出现时同号标注）。
 * @param svgText - 原始 SVG 文本（Graphviz 输出或同结构 SVG）。
 * @param references - 参考标号列表。
 * @param maxBytes - 输入大小上限（默认 {@link DEFAULT_SVG_MAX_BYTES}）。
 * @returns 标注后的 SVG 文本与未命中警告。
 */
export function annotateSvg(
  svgText: string,
  references: readonly SvgAnnotateReference[],
  maxBytes: number = DEFAULT_SVG_MAX_BYTES,
): SvgAnnotateResult {
  assertSafeSvg(svgText, maxBytes)
  validateSvgReferences(references)
  if (references.length === 0) return { svg: svgText, warnings: [] }

  const matched = new Set<number>()
  let cursor = 0
  let result = ''
  const textPattern = /<text\b[^>]*>([\s\S]*?)<\/text>/gi
  let match: RegExpExecArray | null
  while ((match = textPattern.exec(svgText)) !== null) {
    const whole = match[0]
    /* v8 ignore start -- the regex group always matches (empty text allowed); ?? guards only against hypothetical undefined */
    const content = textElementContent(match[1] ?? '').toLowerCase()
    /* v8 ignore stop */
    let hit: number | undefined
    for (let i = 0; i < references.length; i += 1) {
      const ref = references[i] as SvgAnnotateReference
      if (content.includes(ref.label.trim().toLowerCase())) {
        hit = i
        break
      }
    }
    if (hit === undefined) {
      result += svgText.slice(cursor, match.index + whole.length)
      cursor = match.index + whole.length
      continue
    }
    matched.add(hit)
    const reference = references[hit] as SvgAnnotateReference
    const suffix = ` (${escapeXmlText(reference.numeral.trim())})`
    // 在当前 <text> 尾部追加：优先最后一个 <tspan> 文本末尾；否则 <text> 自身末尾。
    const lastTspan = whole.lastIndexOf('</tspan>')
    const insertAt = lastTspan >= 0 ? lastTspan : whole.length - '</text>'.length
    result += svgText.slice(cursor, match.index) + whole.slice(0, insertAt) + suffix + whole.slice(insertAt)
    cursor = match.index + whole.length
  }
  result += svgText.slice(cursor)

  const warnings = references
    .map((ref, index) => ({ ref, index }))
    .filter(({ index }) => !matched.has(index))
    .map(({ ref }) => ref.label)
  return { svg: result, warnings }
}

/** 移除 XML 标签（用于提取文本内容做匹配比较）。 */
function stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, '')
}
