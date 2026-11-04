/**
 * Result-cap normalization shared by the knowledge tools.
 *
 * The implementation lives in `@deepseek-ai/dsh-patent-core` so the tool layer
 * and the knowledge engines apply one bound rule; this module keeps the import
 * path the tools already use.
 * @module @deepseek-ai/dsh-patent-tools/tool/internal/query-limit
 */

export { resolveResultLimit } from '@deepseek-ai/dsh-patent-core'
