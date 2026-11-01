/**
 * SQLite 行值到文本的窄化。
 *
 * `node:sqlite` 返回的行是 `Record<string, unknown>`；模板插值或 `String()`
 * 直接作用于未知值会把对象渲染成 `[object Object]`。检索引擎只接受标量列，
 * 因此这里把非标量显式收敛为空串，避免把占位字符串当成检索结果。
 * @module @deepseek-ai/dsh-legal-knowledge/shared/row-text
 */

/**
 * 把一个未知列值渲染为文本。
 * @param value - 数据库行中的列值。
 * @returns 字符串原样返回；数字、bigint、布尔值转为字面量；其余为空串。
 */
export function columnText(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value)
  }
  return ''
}

/** 带时间效力列的检索记录。 */
type DatedRowRecord = {
  /** 公布日（YYYY-MM-DD）。 */
  publishDate?: string | undefined
  /** 失效日（YYYY-MM-DD）。 */
  expiryDate?: string | undefined
  /** 废止标记：0=未废止，1=已废止；缺失表示未核验。 */
  expired?: number | undefined
  /** 来源文件路径。 */
  sourcePath?: string | undefined
}

/** 条号与条文列，法规、司法解释与指导性案例均有。 */
type ArticleRowColumns = {
  /** 施行日（YYYY-MM-DD）。 */
  effectiveDate: string
  /** 条号。 */
  articleNumber: number
  /** 条文内容。 */
  articleText: string
}

/**
 * 读取行里的施行日、条号与条文列。
 * @param row - 原始数据库行。
 * @returns 三列的值；缺失列按空串或 0 处理。
 */
export function articleRowColumns(row: Record<string, unknown>): ArticleRowColumns {
  return {
    effectiveDate: columnText(row.effective_date ?? row.effectiveDate),
    articleNumber: typeof row.article_number === 'number' ? row.article_number : Number(row.articleNumber ?? 0),
    articleText: columnText(row.article_text ?? row.articleText),
  }
}

/**
 * 把行里的可选时间效力与来源列写入记录。
 *
 * 四列在数据库中均可缺失；只有实际出现时才写入对象属性，
 * 以保留 `exactOptionalPropertyTypes` 下「缺失」与「显式 null」的区别。
 * @param record - 已构建的记录。
 * @param row - 原始数据库行。
 * @returns 同一记录对象。
 */
export function assignDatedColumns<T extends DatedRowRecord>(record: T, row: Record<string, unknown>): T {
  const publishDateVal = row.publish_date ?? row.publishDate
  if (publishDateVal != null) record.publishDate = columnText(publishDateVal)
  const expiryDateVal = row.expiry_date ?? row.expiryDate
  if (expiryDateVal != null) record.expiryDate = columnText(expiryDateVal)
  if (typeof row.expired === 'number') record.expired = row.expired
  const sourcePathVal = row.source_path ?? row.sourcePath
  if (sourcePathVal != null) record.sourcePath = columnText(sourcePathVal)
  return record
}
