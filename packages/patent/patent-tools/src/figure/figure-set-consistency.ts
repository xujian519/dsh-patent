/**
 * 跨图一致性：同一案件多张附图的数字标记归并、跨图名称冲突、图号连续性与
 * 权利要求/说明书引用对齐。
 *
 * 纯函数、无模型依赖：输入是各图已识别的标记（`analyze_patent_figure` 的结果），
 * 输出可直接判定的报告，使识图结论从自由文本变成可校验结果。电学符号与网络
 * （Sati 的 `globalComponents` / `globalNets` / `orphanNets`）不在本模块：电学
 * 分析引擎在本仓尚未移植，符号库与网表没有生产者。
 * @module @deepseek-ai/dsh-patent-tools/figure/figure-set-consistency
 */

/**
 * 回看窗口（字符）：须容纳最长前缀（`formula `、`实施例`）。窗口写小了英文
 * 前缀会整类失效，而规则本身看着仍然正确。
 */
const NUMERAL_PREFIX_WINDOW = 24

/**
 * 专用编号词：不作元件名后缀，出现即判为编号（允许句点、空白与一个左括号）。
 * `式` 在此列，但排除 `方式`/`形式`/`样式`/`模式`/`程式` 结尾的名词——「连接方式(20)」
 * 里的 20 是附图标记。
 */
const STRONG_PREFIX =
  /(?:(?<![方形样模程])式|公式|步骤|实施例|第|共|约|claims?|steps?|formula|figures?|fig)\.?\s*[（(]?\s*$/iu

/**
 * 单字编号词：同时也是常见元件名结尾（视图/水表/密封条），故只在左侧是边界、
 * 图示引用词或虚词之后才排除；否则「所述密封条（20）」会被误判成编号。
 */
const SOFT_PREFIX =
  /(?:^|[，。；：、,.;:!?（）()〔〕【】[\]「」“”"'《》\s如见参附前后上下本该此其与和及或在由对至从把将的])(?:图|表|条|项|章|节|款|例)\s*[（(]?\s*$/u

/**
 * 数字前文是否以编号词收尾（是则这个数字不是附图标记）。
 * @param textBeforeNumeral - 该数字在原文中的前文。
 * @returns 前文命中编号词时为 true。
 */
export function hasNumeralPrefix(textBeforeNumeral: string): boolean {
  const window = textBeforeNumeral.slice(-NUMERAL_PREFIX_WINDOW)
  return STRONG_PREFIX.test(window) || SOFT_PREFIX.test(window)
}

/** `matchAll` 的匹配对象总带 `index`。 */
function matchOffset(match: RegExpExecArray): number {
  return match.index
}

/**
 * 抽取权利要求/说明书中的纯数字附图标记（机械/实用新型口径：`壳体(10)`、`盖板20`）。
 * @param text - 权利要求书或说明书正文。
 * @param limit - 最多收集的标记数。
 * @returns 去重升序的标记数字。
 */
export function extractClaimNumeralRefs(text: string | undefined, limit = 40): number[] {
  if (text === undefined || text === '') return []
  const found = new Set<number>()
  // ① 括号形：`(10)` / `（10）`；`(?<!\d)`/`(?!\d)` 防四位年份被截出三位数字。
  for (const match of text.matchAll(/(?<!\d)[（(]\s*(\d{1,3})\s*[)）](?!\d)/gu)) {
    const digits = match[1]
    /* v8 ignore next -- the pattern's only group always participates in a match */
    if (digits === undefined) continue
    if (hasNumeralPrefix(text.slice(0, matchOffset(match)))) continue
    found.add(Number(digits))
    if (found.size >= limit) return [...found].sort((a, b) => a - b)
  }
  // ② 直连形：≥2 个汉字直接跟数字，其后是列举分隔符或行尾；只认枚举式裸标记，
  //    避免把数量词/数值范围判成附图标记。
  for (const match of text.matchAll(/[一-鿿]{2,}\s*(\d{1,3})(?=\s*(?:[，,；;、。：:]|$))/gmu)) {
    const digits = match[1]
    /* v8 ignore next -- the pattern's only group always participates in a match */
    if (digits === undefined) continue
    const digitsStart = matchOffset(match) + match[0].length - digits.length
    if (hasNumeralPrefix(text.slice(0, digitsStart))) continue
    found.add(Number(digits))
    if (found.size >= limit) break
  }
  return [...found].sort((a, b) => a - b)
}

/** 一张附图参与跨图校验所需的最小事实。 */
export type FigureSetEntry = {
  /** 图号（1 起）。 */
  figureNumber: number
  /** 该图识别出的标记与名称。 */
  components: readonly { readonly refNumber: string; readonly name: string }[]
}

/** 同一数字标记在不同图中的名称不一致。 */
export type FigureSetConflict = {
  /** 冲突维度（目前只有名称）。 */
  kind: 'name'
  /** 冲突的标记。 */
  ref: string
  /** 该标记出现过的图号。 */
  figureNumbers: number[]
  /** 各图号下的取值。 */
  values: { figureNumber: number; value: string }[]
  /** 人类可读说明。 */
  message: string
}

/** 跨图一致性报告。 */
export type FigureSetReport = {
  /** 参与校验的附图数量。 */
  figureCount: number
  /** 数字标记的全局索引：同一标记跨图合并后的名称与图号。 */
  numericComponents: Record<string, { name: string; figureNumbers: number[] }>
  /** 跨图名称冲突。 */
  conflicts: FigureSetConflict[]
  /** 1 到最大图号之间缺失的图号。 */
  missingFigureNumbers: number[]
  /** 在输入中重复出现的图号（同一图号标了两张图）。 */
  duplicateFigureNumbers: number[]
  /** 权利要求/说明书引用、但任何图中都未识别的数字标记。 */
  missingRefs: number[]
  /** 人类可读警告。 */
  warnings: string[]
  /** 文本摘要。 */
  summary: string
  /** 无冲突、无缺号、无缺标。 */
  consistent: boolean
}

/**
 * 检查多个附图分析结果的一致性。
 *
 * 名称冲突只在两侧名称都非空时报告：空名称是识别缺口，不是「名称不同」。
 * 权利要求对齐仅在附图中确实存在数字标记时启用，否则电学案的普通数字会被判成
 * 「未在附图中识别」的假警告。
 * @param figures - 各图的标记清单（未排序时内部按图号排序）。
 * @param claimContext - 权利要求或说明书文本，用于提取期望出现的标记。
 * @returns 跨图一致性报告。
 */
export function checkFigureSetConsistency(
  figures: readonly FigureSetEntry[],
  claimContext?: string,
): FigureSetReport {
  const sorted = [...figures].sort((left, right) => left.figureNumber - right.figureNumber)
  const figureNumbers = sorted.map(figure => figure.figureNumber)

  const numericComponents: Record<string, { name: string; figureNumbers: number[] }> = {}
  /**
   * 每个标记首个非空名称及其所在图号，用于冲突报告里的「原值」一侧。
   *
   * 不能把「首个出现该标记的图号」当成原值的归属：首图可以没写名称，名称是后图
   * 补上的，把补上的名称记到首图号下会指错要改的附图。
   */
  const nameOrigins: Record<string, { figureNumber: number; name: string }> = {}
  const conflicts: FigureSetConflict[] = []
  const warnings: string[] = []

  for (const figure of sorted) {
    for (const component of figure.components) {
      const ref = component.refNumber.trim()
      if (!/^\d{1,3}$/u.test(ref)) continue
      const name = component.name.trim()
      const existing = numericComponents[ref]
      const figureNumbersForRef = [...new Set([...(existing?.figureNumbers ?? []), figure.figureNumber])].sort((a, b) => a - b)
      if (existing === undefined) {
        numericComponents[ref] = { name, figureNumbers: figureNumbersForRef }
        if (name.length > 0) nameOrigins[ref] = { figureNumber: figure.figureNumber, name }
        continue
      }
      existing.figureNumbers = figureNumbersForRef
      if (name.length > 0) {
        const origin = nameOrigins[ref]
        if (origin === undefined) {
          nameOrigins[ref] = { figureNumber: figure.figureNumber, name }
          existing.name = name
        } else if (origin.name !== name) {
          conflicts.push({
            kind: 'name',
            ref,
            figureNumbers: figureNumbersForRef,
            values: [
              { figureNumber: origin.figureNumber, value: origin.name },
              { figureNumber: figure.figureNumber, value: name },
            ],
            message: `标记 ${ref} 在图 ${origin.figureNumber}、图 ${figure.figureNumber} 中名称不一致：${origin.name} / ${name}`,
          })
        }
      }
    }
  }

  const missingFigureNumbers: number[] = []
  const duplicateFigureNumbers: number[] = []
  if (figureNumbers.length > 0) {
    const max = Math.max(...figureNumbers)
    for (let number = 1; number <= max; number += 1) {
      if (!figureNumbers.includes(number)) missingFigureNumbers.push(number)
    }
    const seen = new Set<number>()
    for (const number of figureNumbers) {
      if (seen.has(number) && !duplicateFigureNumbers.includes(number)) duplicateFigureNumbers.push(number)
      seen.add(number)
    }
  }
  if (missingFigureNumbers.length > 0) warnings.push(`附图编号不连续，缺失图号：${missingFigureNumbers.join(', ')}`)
  if (duplicateFigureNumbers.length > 0) warnings.push(`附图编号重复：${duplicateFigureNumbers.join(', ')}`)
  warnings.push(...conflicts.map(conflict => conflict.message))

  const numericRefs = new Set(Object.keys(numericComponents))
  const extracted = claimContext === undefined ? [] : extractClaimNumeralRefs(claimContext)
  const missingRefs = numericRefs.size === 0 ? [] : extracted.filter(ref => !numericRefs.has(String(ref)))
  if (missingRefs.length > 0) {
    warnings.push(`权利要求/说明书中引用但未在附图中识别：${missingRefs.join(', ')}`)
  }

  const consistent = conflicts.length === 0
    && missingFigureNumbers.length === 0
    && duplicateFigureNumbers.length === 0
    && missingRefs.length === 0
  const summary = buildSummary({
    figureCount: sorted.length,
    componentCount: numericRefs.size,
    conflictCount: conflicts.length,
    missingFigureCount: missingFigureNumbers.length,
    duplicateFigureCount: duplicateFigureNumbers.length,
    missingRefCount: missingRefs.length,
  })

  return {
    figureCount: sorted.length,
    numericComponents,
    conflicts,
    missingFigureNumbers,
    duplicateFigureNumbers,
    missingRefs,
    warnings,
    summary,
    consistent,
  }
}

/** 摘要：只报出发生过的事，通过时明说通过。 */
function buildSummary(stats: {
  figureCount: number
  componentCount: number
  conflictCount: number
  missingFigureCount: number
  duplicateFigureCount: number
  missingRefCount: number
}): string {
  const parts = [`附图 ${String(stats.figureCount)} 张，合并识别 ${String(stats.componentCount)} 个数字标记。`]
  if (stats.conflictCount > 0) parts.push(`跨图标记冲突 ${String(stats.conflictCount)} 处。`)
  if (stats.missingFigureCount > 0) parts.push(`缺失图号 ${String(stats.missingFigureCount)} 个。`)
  if (stats.duplicateFigureCount > 0) parts.push(`重复图号 ${String(stats.duplicateFigureCount)} 个。`)
  if (stats.missingRefCount > 0) parts.push(`权利要求/说明书中有 ${String(stats.missingRefCount)} 个引用未在附图中识别。`)
  if (stats.conflictCount + stats.missingFigureCount + stats.duplicateFigureCount + stats.missingRefCount === 0) {
    parts.push('跨图一致性检查通过。')
  }
  return parts.join('')
}
