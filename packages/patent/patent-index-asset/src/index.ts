/**
 * The asset format shared by the shipped fact indexes.
 *
 * `@deepseek-ai/dsh-patent-law`, `@deepseek-ai/dsh-patent-fees`, and
 * `@deepseek-ai/dsh-legal-law` each ship a YAML index transcribed by hand and
 * read at plugin load; each refuses a malformed field instead of coercing it,
 * and each records where every entry came from. This package owns that format so
 * the indexes share one set of field rules rather than a copy each.
 *
 * It is a pure library: no plugin, no service, no state.
 * @module @deepseek-ai/dsh-patent-index-asset
 */

export { IndexAssetError, type AssetFail } from './errors.ts'
export {
  checkRecordedSource,
  readArticleEntries,
  readEntryTopics,
  type IndexedArticle,
} from './entries.ts'
export {
  parseYamlMapping,
  readCount,
  readEnum,
  readMapping,
  readOptionalBoolean,
  readOptionalCount,
  readOptionalDate,
  readOptionalString,
  readString,
} from './fields.ts'
export { readRecordedSource, type RecordedSource } from './source.ts'
