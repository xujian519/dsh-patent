/**
 * src/filing/fromDraft — SpecDraft → FilingContent 的确定性映射。
 *
 * docx 通道与 HTML 通道（dsh-patent-document 的 draftConverter）消费同一份受控草案：
 * 权项项号（「1. 」前缀）、附图说明的「图N为……；/。」、表题（取自 patent-core 的
 * formatTableCaption，HTML 通道读同一函数）与摘要附图号都按草案决定，两通道同形。
 * 内容模型没有列表节点，列表块落成逐项正文段。
 * 入参必须是已通过 validateSpecDraft 的草案（tool JSON 边界在校验处收窄）。
 * @module @deepseek-ai/dsh-patent-filing/filing/fromDraft
 */

import {
  SPEC_PART_HEADINGS,
  SPEC_PART_ORDER,
  formatTableCaption,
  numberedFigureDescriptions,
  type DraftBlock,
  type SpecDraft,
} from '@deepseek-ai/dsh-patent-core'
import type { FilingContent, SpecificationNode } from '../types.ts'

/** 表题计数器；一次转换共用一个实例，与 HTML 通道一样全文档连续编号。 */
interface CaptionCounter {
  /** 已产出的表格数；表题序号从 1 起。 */
  count: number
}

/** 渲染一个表格块：「表 N · 名称」表题段 + 首行表头的 table 节点。 */
function tableNodes(block: Extract<DraftBlock, { kind: 'table' }>, counter: CaptionCounter): SpecificationNode[] {
  counter.count += 1
  return [
    { kind: 'p', text: formatTableCaption(counter.count, block.name) },
    { kind: 'table', rows: [block.header, ...block.rows] },
  ]
}

/** 渲染普通部分的块序列；列表块每项一个正文段。 */
function blockNodes(blocks: readonly DraftBlock[], counter: CaptionCounter): SpecificationNode[] {
  const nodes: SpecificationNode[] = []
  for (const block of blocks) {
    if (block.kind === 'paragraph') {
      nodes.push({ kind: 'p', text: block.text })
    } else if (block.kind === 'list') {
      for (const item of block.items) {
        nodes.push({ kind: 'p', text: item })
      }
    } else {
      nodes.push(...tableNodes(block, counter))
    }
  }
  return nodes
}

/** 渲染附图说明部分：列表项按契约层编号生成「图N为……；」，末项句号。 */
function drawingNodes(blocks: readonly DraftBlock[], counter: CaptionCounter): SpecificationNode[] {
  const figures = numberedFigureDescriptions(blocks)
  const nodes: SpecificationNode[] = []
  for (const block of blocks) {
    if (block.kind === 'paragraph') {
      nodes.push({ kind: 'p', text: block.text })
    } else if (block.kind === 'table') {
      nodes.push(...tableNodes(block, counter))
    } else {
      for (const figure of figures.splice(0, block.items.length)) {
        nodes.push({ kind: 'p', text: `图${figure.index}为${figure.text}${figure.last ? '。' : '；'}` })
      }
    }
  }
  return nodes
}

/**
 * 交付核对用的规范文本投影：与 docx 通道同一份 {@link contentFromDraft} 映射摊平出的
 * 纯文本形态。交付前置门禁（dsh-patent-rule）按它对「前置检查读过的文本」与「本次交付的
 * draft」做 digest 比对，形式预检（dsh-patent-tools）按它重建形式规则的全文输入；两处
 * 消费同一投影，核对文本与成文文本必然同源。
 */
export interface FilingTexts {
  /** 说明书全文：h3 标题（`### ` 前缀）与正文段按空行摊平；表格节点不带文字，不进文本。 */
  text: string
  /** 权利要求全文：带项号（「1. 」前缀）逐行。 */
  claims: string
  /** 摘要全文：逐段一行。 */
  abstract: string
  /** 发明名称（`draft.meta.title`）。 */
  title: string
}

/**
 * 把 claims-spec 受控草案投影为规范文本。
 * @param draft - 已通过 validateSpecDraft 的草案。
 * @returns 说明书、权利要求、摘要与发明名称的纯文本投影；同一草案投影稳定。
 */
export function filingTextsFromDraft(draft: SpecDraft): FilingTexts {
  const content = contentFromDraft(draft)
  const lines: string[] = []
  for (const node of content.specification) {
    if (node.kind === 'h3') {
      /* v8 ignore next -- contentFromDraft 的 h3 标题由 SPEC_PART_HEADINGS 生成，text 必然存在 */
      lines.push(`### ${node.text ?? ''}`)
    } else if (node.kind === 'p') {
      /* v8 ignore next -- p 节点的 text 来自草案正文、列表项或表题，必然存在 */
      lines.push(node.text ?? '')
    }
  }
  return {
    text: lines.join('\n\n'),
    claims: content.claims.join('\n'),
    abstract: content.abstract.join('\n'),
    title: draft.meta.title,
  }
}

/**
 * 把 claims-spec 受控草案转换为内容模型。
 * @param draft - 已通过 validateSpecDraft 的草案。
 * @returns 可直接交给 buildFiling 的内容模型（再经 validateContent 交叉校验）。
 */
export function contentFromDraft(draft: SpecDraft): FilingContent {
  const counter: CaptionCounter = { count: 0 }
  const specification: SpecificationNode[] = []
  for (const partId of SPEC_PART_ORDER) {
    // 指南第二部分第二章 2.3：无附图发明不写空的附图说明章节。
    if (partId === 'drawingDescriptions' && draft.figureFiles.length === 0) continue
    specification.push({ kind: 'h3', text: SPEC_PART_HEADINGS[partId] })
    const blocks = draft.sections[partId]
    specification.push(
      ...(partId === 'drawingDescriptions' ? drawingNodes(blocks, counter) : blockNodes(blocks, counter)),
    )
  }
  return {
    abstract: [...draft.abstract],
    claims: draft.claims.map((claim, index) => `${index + 1}. ${claim}`),
    specification,
    figures: [...draft.figureFiles],
    // 摘要附图号在草案里是 1 起的图号，内容模型用 0 起下标；无附图时不设该字段。
    ...(draft.abstractFigure !== undefined && draft.figureFiles.length > 0
      ? { abstractFigureIndex: Number(draft.abstractFigure) - 1 }
      : {}),
  }
}
