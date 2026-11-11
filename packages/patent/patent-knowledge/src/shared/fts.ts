/**
 * FTS5 共享工具：实现在 `@deepseek-ai/dsh-knowledge-core`，此处保留同名再导出，
 * 维持 patent-knowledge 的模块入口。
 * @module @deepseek-ai/dsh-patent-knowledge/shared/fts
 */

export { escapeFtsPhrase, FTS_MIN_RUNES, joinFtsOrTerms, sanitizeSearchText, sqliteHasFts5 } from '@deepseek-ai/dsh-knowledge-core'
