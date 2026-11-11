/**
 * 法规时间效力判定：实现在 `@deepseek-ai/dsh-knowledge-core`，此处保留同名再导出，
 * 维持 patent-knowledge 的模块入口。
 * @module @deepseek-ai/dsh-patent-knowledge/legal/validity
 */

export { isLawVisible, resolveAsOf, resolveLawValidity, todayIsoDate } from '@deepseek-ai/dsh-knowledge-core'
export type { LawValidity, LawValidityInput } from '@deepseek-ai/dsh-knowledge-core'
