/**
 * 附图工具共用的输出 schema 片段：组件类型枚举、组件条目与标号映射条目。
 *
 * `analyze_patent_figure`、`generate_patent_figure` 与
 * `generate_structure_figure` 返回同一组件与标号结构，因此三者的输出 schema
 * 在此单点定义：字段或枚举漂移会让同一份附图数据在不同工具间不可互换。
 *
 * @module @deepseek-ai/dsh-patent-tools/tool/internal/figure-schemas
 */

/** 组件类型（PatentVision ComponentType 对齐）。 */
export const FIGURE_COMPONENT_KINDS = [
  'mechanical',
  'electrical',
  'software',
  'interface',
  'sensor',
  'actuator',
  'controller',
  'unknown',
] as const

/** Component kind (mechanical / electrical / software / ... / unknown). */
export type FigureComponentKind = (typeof FIGURE_COMPONENT_KINDS)[number]

/** 标号映射条目（组件 id → 图面标号）。 */
export const NUMERAL_MAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    componentId: { type: 'string', required: true },
    label: { type: 'string', required: true },
    numeral: { type: 'string', required: true },
    figure: { type: 'integer', required: true },
  },
} as const

/**
 * `figure_analysis` 工具参数：`validate_specification` 与 `domain_check` 接受
 * 同一份附图分析结果，两处参数 schema 共用本片段，避免字段漂移。
 * `components` 未设为必填：分析不可用时调用方没有组件列表，读取方按空列表处理。
 */
export const FIGURE_ANALYSIS_INPUT_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      usable: { type: 'boolean', required: true, description: '分析结果是否可用（组件提取成功）' },
      components: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            refNumber: { type: 'string', required: true, description: '附图标记号（与图面标号一致）' },
          },
        },
        description: '识别的组件列表',
      },
    },
  },
} as const

/** 组件条目（附图标记号、名称、类型与功能描述）。 */
export const COMPONENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    refNumber: { type: 'string', required: true },
    name: { type: 'string', required: true },
    kind: { type: 'string', required: true, enum: FIGURE_COMPONENT_KINDS },
    description: { type: 'string', required: true },
  },
} as const
