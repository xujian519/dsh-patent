/**
 * FTS5 共享工具：实现在 `@deepseek-ai/dsh-patent-core`，此处保留同名再导出，
 * 维持 legal-knowledge 的模块入口。
 * @module @deepseek-ai/dsh-legal-knowledge/shared/fts
 */

export { escapeFtsPhrase, FTS_MIN_RUNES, joinFtsOrTerms, sanitizeSearchText, sqliteHasFts5 } from '@deepseek-ai/dsh-patent-core'
