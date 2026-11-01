/**
 * src/draft/figureDescriptions — 附图说明列表项的连续编号。
 *
 * 「图N为……；/。」的序号与末项句号由契约层唯一持有：HTML 通道（dsh-patent-document）
 * 与 docx 通道（dsh-patent-filing）都按这里的结果渲染，两通道图号不可能分叉。
 * @module @deepseek-ai/dsh-patent-core/draft/figureDescriptions
 */

import type { DraftBlock } from './types.ts'

/** 一个附图说明列表项的编号结果。 */
export interface NumberedFigureDescription {
  /** 图号序号（从 1 起，跨该部分全部列表块连续）。 */
  index: number
  /** 模型提供的描述文字（只含图名与内容，不含图号与句末标点）。 */
  text: string
  /** 是否为该部分最后一个列表项（决定句末用句号还是分号）。 */
  last: boolean
}

/**
 * 提取附图说明部分列表块的编号结果：按文档顺序连续编号，末项标记为 last。
 * 非列表块不出现在结果里，由调用方按原样渲染。
 * @param blocks - 附图说明部分的块序列（已通过 validateSpecDraft）。
 * @returns 编号后的附图说明列表项。
 */
export function numberedFigureDescriptions(blocks: readonly DraftBlock[]): NumberedFigureDescription[] {
  let total = 0
  for (const block of blocks) {
    if (block.kind === 'list') total += block.items.length
  }
  const result: NumberedFigureDescription[] = []
  let index = 0
  for (const block of blocks) {
    if (block.kind !== 'list') continue
    block.items.forEach((text, itemIndex) => {
      index += 1
      result.push({ index, text, last: index === total && itemIndex === block.items.length - 1 })
    })
  }
  return result
}
