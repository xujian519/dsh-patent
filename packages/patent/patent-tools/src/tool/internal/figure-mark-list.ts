/**
 * 附图标记工具共用的输入词汇：figures 参数 schema、「至少一张附图且图号不重复」
 * 的校验，以及把模型输入还原成内部条目的转换。
 *
 * `check_patent_figure_consistency` 与 `check_claim_figure_coverage` 接受同一个
 * 逐图条目，两处若各自定义 schema 与转换，字段漂移会让同一份附图数据在两个工具间
 * 不可互换。
 * @module @deepseek-ai/dsh-patent-tools/tool/internal/figure-mark-list
 */

import { PatentToolError } from '../../error.ts'
import { MARK_COMPONENT_SCHEMA } from './analysis-schemas.ts'
import { assertUniqueFigureNumbers } from './tool-input.ts'

/** 模型给出的逐图标号条目。 */
export type FigureListInput = readonly {
  /** 图号（1 起，同一案件内唯一）。 */
  figure_number: number
  /** 本图识别出的标号与名称。 */
  components: readonly { ref_number: string; name?: string | undefined }[]
}[]

/** 还原后的逐图条目（内部口径）。 */
export type FigureMarkListEntry = {
  /** 图号（1 起）。 */
  figureNumber: number
  /** 本图的标号与名称。 */
  components: { refNumber: string; name: string }[]
}

/**
 * 构造 figures 参数 schema。两个工具的措辞不同但结构必须一致，因此结构在此单点
 * 定义，只把描述文案留给调用方。
 * @param componentsDescription - `components` 字段的模型可见描述。
 * @param listDescription - `figures` 字段自身的模型可见描述。
 * @returns 可直接放进 `parameters` 的 schema 片段。
 */
export function figureMarkListParameter(componentsDescription: string, listDescription: string): {
  type: 'array'
  required: true
  items: {
    type: 'object'
    additionalProperties: false
    properties: {
      figure_number: { type: 'integer'; required: true; description: string }
      components: { type: 'array'; required: true; items: typeof MARK_COMPONENT_SCHEMA; description: string }
    }
  }
  description: string
} {
  return {
    type: 'array',
    required: true,
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        figure_number: { type: 'integer', required: true, description: '图号（1 起，同一案件内唯一）' },
        components: {
          type: 'array',
          required: true,
          items: MARK_COMPONENT_SCHEMA,
          description: componentsDescription,
        },
      },
    },
    description: listDescription,
  } as const
}

/**
 * 断言附图列表非空，且每个图号都是互不重复的正整数。
 * @param figures - 待校验的附图条目；只读 `figure_number`。
 * @param tool - 错误归属的工具名。
 * @throws PatentToolError(`invalid_tool_input`) 列表为空、图号不是正整数或重复时。
 */
export function requireFigureList(figures: FigureListInput, tool: string): void {
  if (figures.length === 0) {
    throw new PatentToolError('invalid_tool_input', 'figures 至少需要一张附图', { tool })
  }
  assertUniqueFigureNumbers(figures, tool)
}

/**
 * 把模型输入还原成内部逐图条目；缺省名称按空串处理。
 * @param figures - 已通过 {@link requireFigureList} 校验的附图条目。
 * @returns 图号与标号名称的内部条目。
 */
export function toFigureMarkEntries(figures: FigureListInput): FigureMarkListEntry[] {
  return figures.map(figure => ({
    figureNumber: figure.figure_number,
    components: figure.components.map(component => ({
      refNumber: component.ref_number,
      name: component.name ?? '',
    })),
  }))
}
