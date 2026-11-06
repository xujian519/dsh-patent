/**
 * 中文数字 → 阿拉伯数字的解析（纯函数）。
 *
 * 法条引用的条/款/项号以中文数字书写，两个域的引用语法在归一化前都要先读数。
 * 该读者与渲染对偶 {@link formatCnNumber} 同包，避免读写两侧漂移。
 * @module @deepseek-ai/dsh-law-core/cn-number
 */

/** Chinese numeral digits and the zero placeholder, by value. */
const CN_DIGITS: Record<string, number> = {
  〇: 0,
  零: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
}

const CN_UNITS: Record<string, number> = {
  十: 10,
  百: 100,
  千: 1000,
}

/**
 * 中文数字 → 阿拉伯数字。支持十/百/千位组合与零占位（"第一百零二条" → 102，
 * "一千二百三十四" → 1234）；"十"开头按 10 计（"第十条" → 10）。
 * 阿拉伯数字直接返回；含非法字符、单位顺序错误，或单位前出现连续非零数字
 * （"第十二三条"）时返回 null，避免把畸形数字读成另一条。
 * @param raw - 待解析的中文数字字符串。
 * @returns 解析出的阿拉伯数字，非法输入返回 null。
 */
export function parseCnNumber(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  if (/^[0-9]+$/.test(trimmed)) {
    const value = Number.parseInt(trimmed, 10)
    return Number.isSafeInteger(value) ? value : null
  }
  let total = 0
  let pending: number | null = null
  let lastUnit = Number.POSITIVE_INFINITY
  for (const ch of trimmed) {
    const digit = CN_DIGITS[ch]
    if (digit !== undefined) {
      // A second nonzero digit before a unit is not a numeral this parser can
      // read (第十二三条 is not 123); a zero placeholder (一百零五) is.
      if (pending !== null && pending !== 0) return null
      pending = digit
      continue
    }
    const unit = CN_UNITS[ch]
    if (unit === undefined || unit >= lastUnit) return null
    // 十 may stand alone (十五 = 15); 百 and 千 need a leading digit.
    if (unit !== 10 && pending === null) return null
    total += (pending ?? 1) * unit
    pending = null
    lastUnit = unit
  }
  return total + (pending ?? 0)
}
