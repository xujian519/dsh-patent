/**
 * src/document/draftConverter/specDraft — SpecDraft → claims-spec 槽位 innerHTML。
 *
 * 输出是 `id -> innerHTML` 映射，直接交给 injectSections：模型不再接触标题
 * （h2/h3 由本模块按 SPEC_PART_HEADINGS 生成）、权项编号（自动连续）、表题
 * （自动编号）与占位符。附图说明的「图 N 为……」由列表项序号生成，模型只提供
 * 描述文字（不含图号与句末标点）。
 * @module @deepseek-ai/dsh-patent-document/document/draftConverter/specDraft
 */

import {
  SPEC_PART_HEADINGS,
  SPEC_PART_ORDER,
  numberedFigureDescriptions,
  type SpecDraft,
} from '@deepseek-ai/dsh-patent-core'
import { renderBlocks, type TableCaptionCounter } from './blocks.ts'
import { escapeHtmlText } from './escape.ts'

/** 渲染附图说明部分：列表项按契约层编号生成「图N为……；」，末项句号。 */
function renderDrawingDescriptions(blocks: Parameters<typeof numberedFigureDescriptions>[0], captionCounter: TableCaptionCounter): string {
  const figures = numberedFigureDescriptions(blocks)
  return blocks.map((block) => {
    if (block.kind !== 'list') {
      return renderBlocks([block], captionCounter)
    }
    const items = figures
      .splice(0, block.items.length)
      .map(figure => `<li>图${figure.index}为${escapeHtmlText(figure.text)}${figure.last ? '。' : '；'}</li>`)
      .join('')
    return `<ul class="figure-list">${items}</ul>`
  }).join('')
}

/** 转换产物的槽位映射：键为 claims-spec 骨架中的固定元素 id。 */
export interface SpecDraftSectionMap {
  /** 抬头案卷号（编号行的值位；「案卷号：」标签与版本号留在骨架里）。 */
  'meta-case': string
  /** 发明名称。 */
  'meta-title': string
  /** 申请人。 */
  'meta-applicant': string
  /** 发明人。 */
  'meta-inventor': string
  /** 代理人 / 代理机构。 */
  'meta-agent': string
  /** 撰写日期。 */
  'meta-date': string
  /** 页脚日期。 */
  'footer-date': string
  /** 页脚案卷号。 */
  'footer-case': string
  /** 权利要求书正文容器（claim-item 序列；分区标题留在骨架里，不在本槽位内）。 */
  'claims-body': string
  /** 说明书正文容器（五部分 h3 + 块；分区标题留在骨架里）。 */
  'specification-body': string
  /** 摘要内层（abstract-box，含自带 h3）。 */
  abstract: string
}

/**
 * 将 claims-spec 受控草案转换为槽位注入映射。
 * @param draft - 已通过 validateSpecDraft 的草案。
 * @returns 元素 id → innerHTML 映射（meta 槽位为纯文本，其余为转换器生成的结构）。
 */
export function renderSpecDraftSections(draft: SpecDraft): SpecDraftSectionMap {
  const captionCounter: TableCaptionCounter = { count: 0 }
  const specification = SPEC_PART_ORDER.map((partId) => {
    const heading = `<h3>${SPEC_PART_HEADINGS[partId]}</h3>`
    const blocks = partId === 'drawingDescriptions'
      ? renderDrawingDescriptions(draft.sections[partId], captionCounter)
      : renderBlocks(draft.sections[partId], captionCounter)
    return heading + blocks
  }).join('')
  const claims = draft.claims
    .map((claim, index) => `<div class="claim-item"><span class="claim-num">${index + 1}.</span>${escapeHtmlText(claim)}</div>`)
    .join('')
  const abstractFigure = escapeHtmlText(draft.abstractFigure ?? '1')
  const abstract = '<div class="abstract-box"><h3>摘要</h3>'
    + draft.abstract.map(paragraph => `<p>${escapeHtmlText(paragraph)}</p>`).join('')
    + `<p><strong>摘要附图：</strong>图 <span class="mono">${abstractFigure}</span></p></div>`
  return {
    'meta-case': escapeHtmlText(draft.meta.caseNumber),
    'meta-title': escapeHtmlText(draft.meta.title),
    'meta-applicant': escapeHtmlText(draft.meta.applicant),
    'meta-inventor': escapeHtmlText(draft.meta.inventor),
    'meta-agent': escapeHtmlText(draft.meta.agent),
    'meta-date': escapeHtmlText(draft.meta.date),
    'footer-date': escapeHtmlText(draft.meta.date),
    'footer-case': escapeHtmlText(draft.meta.caseNumber),
    'claims-body': claims,
    'specification-body': specification,
    abstract,
  }
}
