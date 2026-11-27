/**
 * 附图分析与比对工具共用的 schema 片段。
 *
 * 这些片段只描述字段形状，不含行为；集中一处是为了让同一标号的输入输出在
 * `check_patent_figure_consistency`、`compare_patent_figure_analysis` 与
 * `verify_patent_figure` 之间保持同一口径，也避免逐字重复的 schema 被克隆门禁报出。
 * @module @deepseek-ai/dsh-patent-tools/tool/internal/analysis-schemas
 */

/** 输入侧的标号条目：标号必填，名称可选。 */
export const MARK_COMPONENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ref_number: { type: 'string', required: true, description: '附图标记号（与图面一致）' },
    name: { type: 'string', description: '该标号的部件名称' },
  },
} as const

/** 报告尾部共用的两字段：摘要与结论。 */
export const REPORT_TAIL_FIELDS = {
  summary: { type: 'string', required: true },
  consistent: { type: 'boolean', required: true },
} as const

/** 发现条目的通用字段：检查名与说明。 */
export const FINDING_FIELDS = {
  check: { type: 'string', required: true },
  message: { type: 'string', required: true },
} as const

/**
 * 构造 findings 数组的 schema：外层固定（必填数组、条目禁止额外字段），字段由调用方给。
 * @param properties - 该工具发现条目的字段表。
 * @returns 可直接放进输出 schema 的 findings 片段。
 */
export function findingListSchema<const P extends Record<string, unknown>>(properties: P) {
  return {
    type: 'array',
    required: true,
    items: {
      type: 'object',
      additionalProperties: false,
      properties,
    },
  } as const
}
