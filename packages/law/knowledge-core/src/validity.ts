/**
 * 法规时间效力判定（纯函数，不依赖数据库）。
 *
 * 数据源可能有三类时间列：`expired`（0/1 废止标记）、`valid_from`（施行日）与
 * `valid_to`（失效日）。三列都允许缺失：缺失表示「时间效力未核验」，不能当作
 * 现行有效。判定只回答「在给定日期是否可见」，不改变法条正文或位阶。
 * @module @deepseek-ai/dsh-knowledge-core/validity
 */

/** 法规在某一时点的效力状态。 */
export type LawValidity = 'in-force' | 'expired' | 'not-yet-effective' | 'unverified'

/** 时间效力判定的输入列；`null` / `undefined` 均表示该列缺失。 */
export type LawValidityInput = {
  /** 施行日（YYYY-MM-DD）。 */
  validFrom?: string | null | undefined
  /** 失效日（YYYY-MM-DD）。 */
  validTo?: string | null | undefined
  /** 废止标记：0=未废止，1=已废止；缺失表示未核验。 */
  expired?: number | null | undefined
}

/** 日期字符串（YYYY-MM-DD）是否合法；只做形状与日历校验，不做时区换算。 */
function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** 合法日期原样返回；缺失、空串或非法日期按「未核验」处理。 */
function isoDateOrUndefined(value: string | null | undefined): string | undefined {
  return value !== null && value !== undefined && isIsoDate(value) ? value : undefined
}

/**
 * 今天的 UTC 日期（YYYY-MM-DD）；作为未显式给定时点的默认值。
 * @returns 当前 UTC 日期的 YYYY-MM-DD 文本。
 */
export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * 解析调用方给出的时点；非法日期直接抛错，避免把拼错的日期当作「今天」。
 * @param value - 调用方给出的时点（YYYY-MM-DD）。
 * @returns 规范化后的日期；未给出时返回今天。
 * @throws Error 日期不是合法的 YYYY-MM-DD。
 */
export function resolveAsOf(value: string | undefined): string {
  if (value === undefined) return todayIsoDate()
  const trimmed = value.trim()
  if (!isIsoDate(trimmed)) {
    throw new Error(`asOf 必须是 YYYY-MM-DD 格式的合法日期（收到 ${JSON.stringify(value)}）`)
  }
  return trimmed
}

/**
 * 判定法规在给定时点的效力状态。
 *
 * 规则按可见性从强到弱：
 * 1. `expired=1` 或 `valid_to < asOf` → 已废止；
 * 2. `valid_from > asOf` → 尚未生效；
 * 3. 有任一有效时间列且未命中上述情形 → 在效；
 * 4. 三列全缺失 → 未核验（不把「不知道」当成「有效」）。
 * @param input - 时间列。
 * @param asOf - 判定时点（YYYY-MM-DD）。
 * @returns 效力状态。
 */
export function resolveLawValidity(input: LawValidityInput, asOf: string): LawValidity {
  if (input.expired === 1) return 'expired'
  // 只有规范的 ISO 日期参与比较：拼错或越界的日期不能被字符串序当成「在效」。
  const validFrom = isoDateOrUndefined(input.validFrom)
  const validTo = isoDateOrUndefined(input.validTo)
  if (validTo !== undefined && asOf > validTo) return 'expired'
  if (validFrom !== undefined && asOf < validFrom) return 'not-yet-effective'
  if (validFrom !== undefined || validTo !== undefined || input.expired === 0) return 'in-force'
  return 'unverified'
}

/**
 * 该效力状态在检索结果中是否可见。
 *
 * 已废止与尚未生效的记录不返回；未核验记录默认返回（由调用方决定是否收紧），
 * 以兼容尚未回填时间列的存量库。
 * @param validity - 效力状态。
 * @param includeUnverified - 是否返回未核验记录。
 * @returns 是否可见。
 */
export function isLawVisible(validity: LawValidity, includeUnverified: boolean): boolean {
  if (validity === 'expired' || validity === 'not-yet-effective') return false
  if (validity === 'unverified') return includeUnverified
  return true
}
