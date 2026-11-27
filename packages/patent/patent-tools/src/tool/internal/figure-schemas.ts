/**
 * 附图相关工具共用的 schema 片段：组件类型枚举、组件条目、标号映射条目，
 * 以及 `review_patent_application` 接受的附图形式证据。
 *
 * `analyze_patent_figure`、`generate_patent_figure` 与
 * `generate_structure_figure` 返回同一组件与标号结构，因此三者的输出 schema
 * 在此单点定义：字段或枚举漂移会让同一份附图数据在不同工具间不可互换。
 *
 * @module @deepseek-ai/dsh-patent-tools/tool/internal/figure-schemas
 */

import { TARGET_OFFICES } from '../../figure/office-profile.ts'

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

/**
 * 附图形式证据（`review_patent_application` 的 `figures` 参数）：生成与复核
 * 工具给出的落版尺寸、色彩策略、图号与图面检查项。
 */
export const FIGURE_FORM_EVIDENCE_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      figure_number: { type: 'integer', required: true, description: '图号（1 起）' },
      office: { type: 'string', required: true, enum: TARGET_OFFICES, description: '目标法域' },
      style: {
        type: 'string',
        enum: ['grayscale', 'semantic'],
        description: '色彩策略（缺省 grayscale）',
      },
      has_caption: { type: 'boolean', required: true, description: '落版页上是否已标注图号' },
      abstract_figure: { type: 'boolean', description: '本幅是否为请求书指定的摘要附图' },
      char_height_mm: { type: 'number', description: '落版后正文数字与字母的字高（毫米）' },
      placed_width_mm: { type: 'number', description: '落版后图形占用的宽（毫米）' },
      placed_height_mm: { type: 'number', description: '落版后图形占用的高（毫米）' },
      render_findings: {
        type: 'array',
        description: '`verify_patent_figure` 的 findings（check 与 message 原样给出）',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            check: { type: 'string', required: true },
            message: { type: 'string', required: true },
          },
        },
      },
      delivery_findings: {
        type: 'array',
        description: '交付复核（`delivery_review=true`）的 findings',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            check: { type: 'string', required: true },
            message: { type: 'string', required: true },
          },
        },
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
