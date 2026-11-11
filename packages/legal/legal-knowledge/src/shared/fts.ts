/**
 * FTS5 共享工具：实现在 `@deepseek-ai/dsh-patent-core`，此处保留同名再导出，
 * 维持 legal-knowledge 的模块入口。
 * @module @deepseek-ai/dsh-legal-knowledge/shared/fts
 */

import { sanitizeSearchText } from '@deepseek-ai/dsh-patent-core'

export { escapeFtsPhrase, FTS_MIN_RUNES, joinFtsOrTerms, sanitizeSearchText, sqliteHasFts5 } from '@deepseek-ai/dsh-patent-core'

/**
 * 去掉 NUL 再 trim。SQLite 在 NUL 处截断绑定文本，这个字符必须在 FTS 或 LIKE 之前离开查询。
 * @param value - 调用方给出的检索文本。
 * @returns 用于匹配的文本；没有可检索内容时为空串。
 */
export function prepareSearchText(value: string): string {
  return sanitizeSearchText(value).trim()
}
