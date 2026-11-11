/**
 * FTS5 检索降级阶梯：实现在 `@deepseek-ai/dsh-knowledge-core`，此处保留同名再导出，
 * 维持 patent-knowledge 的模块入口。
 * @module @deepseek-ai/dsh-patent-knowledge/shared/fts-search
 */

export { createFtsLadder, runFtsSearch } from '@deepseek-ai/dsh-knowledge-core'
export type { FtsSearchLadder, FtsSearchOps } from '@deepseek-ai/dsh-knowledge-core'
