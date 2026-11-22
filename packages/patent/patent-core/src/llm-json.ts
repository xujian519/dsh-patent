/**
 * src/patent — LLM JSON 容错解析（patent 域共享）。
 *
 * 收敛 atoms（llm.ts）与 figure（analyze.ts）两处重复的 JSON 解析逻辑：
 * 直接解析 → 去 ```json 代码围栏后解析。新增 LLM 结构化输出消费方时复用本模块，
 * 不要复制实现。
 */

/**
 * 去掉 ```json ... ``` 围栏（LLM 输出格式漂移兜底）。
 * @param raw - 待处理的原始 LLM 输出文本。
 * @returns 去除代码围栏后的文本；未命中围栏时原样返回 raw。
 */
export function stripCodeFence(raw: string): string {
  const match = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)
  const body = match?.[1]
  return body !== undefined ? body.trim() : raw
}

/**
 * JSON 容错解析：直接解析 → 去代码围栏解析；失败返回 undefined。
 * @param raw - 待解析的原始文本。
 * @returns 解析出的对象；解析失败或结果不是对象时返回 undefined。
 */
export function tryParseJson(raw: string): Record<string, unknown> | undefined {
  const candidates = [raw, stripCodeFence(raw)]
  for (const candidate of candidates) {
    let value: unknown
    try {
      value = JSON.parse(candidate)
    } catch (error) {
      // 解析失败：尝试下一个候选
      void error
      continue
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  }
  return undefined
}

/**
 * 判断值是否为 JSON 对象（非 null、非数组）。
 *
 * 需要抛错语义的调用方用本守卫判定并抛自己的错误类型，不要复制这段条件：
 * `dsh-patent-filing` 的引擎报告解析是同一判定的抛错版。
 * @param value - 待判定的值。
 * @returns 值是否为 JSON 对象。
 */
export function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 读取一个 JSON 对象；其它形状返回 undefined。
 * @param value - 待窄化的值（LLM 输出或工具输出的 JSON 值）。
 * @returns 对象形状的值，或 undefined。
 */
export function asJsonRecord(value: unknown): Record<string, unknown> | undefined {
  return isJsonRecord(value) ? value : undefined
}

/**
 * 判断值是否为有限数字（排除 NaN 与 ±Infinity）。
 *
 * 持久化记录的数值字段用它判定：`typeof value === 'number'` 会放过 NaN，
 * 而 `JSON.parse` 无法产出 NaN，只有损坏或手改的记录才会带进这种值。
 * @param value - 待判定的值。
 * @returns 值是否为有限数字。
 */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/**
 * 判断值是否为非负整数。
 * @param value - 待判定的值。
 * @returns 值是否为非负整数。
 */
export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * 判断值是否为非空字符串数组。
 *
 * 空串元素在领域层没有含义（节点名、阶段 id、状态键都非空），却会让下游按名字
 * 查找时静默失配，因此在 durable 边界直接拒绝。
 * @param value - 待判定的值。
 * @returns 值是否为非空字符串数组（空数组合法）。
 */
export function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string' && entry.trim() !== '')
}

/**
 * 读取一个 JSON 数组；其它形状返回空数组。
 * @param value - 待窄化的值。
 * @returns 数组形状的值，或空数组。
 */
export function asJsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * 读取非空字符串（去首尾空白后非空）；其它形状返回 undefined。
 * @param value - 待窄化的值。
 * @returns 去空白后的字符串，或 undefined。
 */
export function readJsonString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * 读取记录中必填的非空字符串字段；缺失或形状不符返回 undefined。
 *
 * 返回写入时的原值而不去空白：持久化记录按写入内容回读，校验只判断非空，
 * 不改写字段内容（需要去空白的容错消费方用 {@link readJsonString}）。
 * @param record - 待读取的 JSON 对象。
 * @param key - 字段名。
 * @returns 字段原值，或 undefined。
 */
export function readNonEmptyString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * 读取记录中可选的非空字符串字段：字段缺失返回 undefined，给出但形状不符返回 null。
 *
 * 三态返回让调用方区分「没写这个字段」与「写了但非法」：前者保持字段缺省，
 * 后者必须按结构错误拒绝。
 * @param record - 待读取的 JSON 对象。
 * @param key - 字段名。
 * @returns 字段原值、undefined（缺失）或 null（非法）。
 */
export function readOptionalNonEmptyString(
  record: Record<string, unknown>,
  key: string,
): string | undefined | null {
  const value = record[key]
  if (value === undefined) return undefined
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * 读取 JSON 数字；其它形状返回 undefined。
 * @param value - 待窄化的值。
 * @returns 数字，或 undefined。
 */
export function readJsonNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}

/**
 * 读取字符串数组，逐项去空丢弃。
 * @param value - 待窄化的值。
 * @returns 非空字符串数组（非数组或非字符串项被丢弃）。
 */
export function readJsonStringArray(value: unknown): string[] {
  return asJsonArray(value).map(readJsonString).filter((entry): entry is string => entry !== undefined)
}

/** 严格字符串数组解析结果：成功携带原数组顺序，失败携带可直接展示的原因。 */
export type JsonStringArrayResult =
  | { ok: true; values: string[] }
  | { ok: false; reason: string }

/**
 * 严格读取字符串数组：非数组或含非字符串项时失败，并指出首个非法下标。
 *
 * 与 {@link readJsonStringArray} 的宽容过滤不同，本函数用于承载交付物的字段
 * （权利要求、关键词、提取特征等）：静默丢弃或 `String()` 强转会让非法模型输出
 * 变成 `[object Object]` 或缺失项。
 * @param value - 待校验的 JSON 值。
 * @param label - 字段名，用于错误文案。
 * @returns 原序字符串数组，或失败原因。
 */
export function parseJsonStringArray(value: unknown, label: string): JsonStringArrayResult {
  if (!Array.isArray(value)) return { ok: false, reason: `${label} 不是数组` }
  const values: string[] = []
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string') {
      return { ok: false, reason: `${label} 数组含非字符串项（下标 ${index}）` }
    }
    values.push(entry)
  }
  return { ok: true, values }
}

/**
 * 读取可选字符串数组：字段缺失视为空数组，存在时按 {@link parseJsonStringArray} 严格校验。
 *
 * 用于 schema 中非必需、但一旦给出就必须是字符串数组的字段（如 extract 的 problems/effects）。
 * @param value - 待校验的 JSON 值。
 * @param label - 字段名，用于错误文案。
 * @returns 原序字符串数组（缺失时为空数组），或失败原因。
 */
export function parseOptionalJsonStringArray(value: unknown, label: string): JsonStringArrayResult {
  return value === undefined ? { ok: true, values: [] } : parseJsonStringArray(value, label)
}

/** 严格对象数组解析结果：成功携带原序对象，失败携带可直接展示的原因。 */
export type JsonRecordArrayResult =
  | { ok: true; values: Record<string, unknown>[] }
  | { ok: false; reason: string }

/**
 * 严格读取对象数组：非数组或含非对象项时失败，并指出首个非法下标。
 *
 * 用于承载逐项结构化输出的字段（compare 的 claim_chart、novelty 的 assessments）：
 * 静默保留 `null` 或标量项会让下游按记录字段读取时崩溃，或把非法项写进报告。
 * @param value - 待校验的 JSON 值。
 * @param label - 字段名，用于错误文案。
 * @returns 原序对象数组，或失败原因。
 */
export function parseJsonRecordArray(value: unknown, label: string): JsonRecordArrayResult {
  if (!Array.isArray(value)) return { ok: false, reason: `${label} 不是数组` }
  const values: Record<string, unknown>[] = []
  for (const [index, entry] of value.entries()) {
    if (!isJsonRecord(entry)) {
      return { ok: false, reason: `${label} 数组含非对象项（下标 ${index}）` }
    }
    values.push(entry)
  }
  return { ok: true, values }
}
