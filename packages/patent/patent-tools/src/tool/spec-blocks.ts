/**
 * 说明书「具体实施方式」的实施例分块。
 *
 * 分块只搬运原文：每个块先按实施例标题切分，再用 `locateQuote` 复核它确实出现在
 * 交底书原文中；未命中的块整块丢弃并记录原因，不与相邻块拼接。特征编号按 PFIE
 * 特征顺序稳定分配（`F1`、`F2`…），附图标记只在块正文出现该标记时才写入引用。
 *
 * @module @deepseek-ai/dsh-patent-tools/tool/spec-blocks
 */

import { locateQuote, type AnchorReason } from '@deepseek-ai/dsh-patent-core'

/** 一条可被实施例块引用的 PFIE 特征。 */
export type SpecFeature = {
  /** 稳定编号（`F1`、`F2`…），按输入顺序分配。 */
  id: string
  /** 特征原文。 */
  text: string
}

/** 一个附图标记：图号与图上的数字标记。 */
export type SpecFigureMark = {
  /** 附图序号（1 起）。 */
  figure_number: number
  /** 图上的数字标记，如 `10`。 */
  ref_number: string
}

/** 一个通过原文锚点复核的实施例块。 */
export type EmbodimentBlock = {
  /** 渲染序号（1 起）。 */
  index: number
  /** 原文自带的实施例标题行；块由调用方直接给出时缺省。 */
  heading?: string
  /** 首个实施例标题之前的总述段；渲染时不补 `实施例N` 前缀，也不要求特征/附图引用。 */
  preamble?: boolean
  /** 块正文，也是锚点复核的对象。 */
  text: string
  /** 在块正文中命中的 PFIE 特征编号。 */
  feature_ids: string[]
  /** 在块正文中命中的附图标记。 */
  figure_marks: SpecFigureMark[]
  /** 锚点判定来源。 */
  anchor_reason: AnchorReason
}

/** 一个未进入说明书的实施例块。 */
export type DroppedEmbodimentBlock = {
  /** 被丢弃的块正文。 */
  text: string
  /** 丢弃原因：空块，或摘录未命中原文。 */
  reason: 'empty' | 'anchor-not-found'
}

/** 实施例分块结果。 */
export type EmbodimentBuild = {
  blocks: EmbodimentBlock[]
  dropped: DroppedEmbodimentBlock[]
  warnings: string[]
}

/** 实施例标题行：`实施例1：…`、`## 实施例 2`、`实施方式三 …`。 */
const EMBODIMENT_HEADING_RE = /^[ \t]*(?:#{1,6}[ \t]*)?(?:实施例|实施方式)[ \t]*(?:\d+|[一二三四五六七八九十百]+)[^\n]*$/gm

/** 标题标签本身（含可选 Markdown 前缀与冒号），用于从块里剥出正文。 */
const EMBODIMENT_LABEL_RE = /^[ \t]*(?:#{1,6}[ \t]*)?(?:实施例|实施方式)[ \t]*(?:\d+|[一二三四五六七八九十百]+)[ \t]*[：:]?/

/** 分块输入。 */
export type EmbodimentBuildInput = {
  /** 原文；用于按标题切分，并作为缺省锚点源。 */
  sourceText?: string
  /** 显式实施例的锚点源；缺省时按 `sourceText` 复核，显式给出却为空则跳过复核。 */
  anchorText?: string
  /** 调用方直接给出的实施例正文；给出时不再切分原文。 */
  embodiments?: readonly string[]
  /** PFIE 特征，按数组顺序编号。 */
  features?: readonly SpecFeature[]
  /** 引用候选的附图标记。 */
  figureMarks?: readonly SpecFigureMark[]
}

/**
 * 一个待复核的分块候选。
 *
 * `matchText` 去掉实施例标题行：标题里的序号（`实施例2`）会与附图标记数字
 * 混淆，附图标记只在正文里匹配。
 */
type Candidate = {
  heading?: string
  preamble?: boolean
  text: string
  matchText: string
}

/**
 * 按实施例标题行切分原文；没有标题时整段作为一个候选。
 * @param sourceText - 说明书或交底书原文。
 * @returns 分块候选，按原文顺序。
 */
function splitByEmbodimentHeading(sourceText: string): Candidate[] {
  const candidates: Candidate[] = []
  const matches = [...sourceText.matchAll(EMBODIMENT_HEADING_RE)]
  if (matches.length === 0) {
    // 调用方已裁掉首尾空白；空串由 buildEmbodimentBlocks 的空块分支丢弃。
    const text = sourceText.trim()
    return [{ text, matchText: text }]
  }
  for (const [index, match] of matches.entries()) {
    if (index === 0) {
      const intro = sourceText.slice(0, match.index).trim()
      if (intro.length > 0) candidates.push({ text: intro, matchText: intro, preamble: true })
    }
    const start = match.index + match[0].length
    const next = matches[index + 1]
    const end = next === undefined ? sourceText.length : next.index
    const heading = match[0].trim()
    const body = sourceText.slice(start, end).trim()
    const text = body.length > 0 ? `${heading}\n${body}` : heading
    candidates.push({ heading, text, matchText: text.replace(EMBODIMENT_LABEL_RE, '').trim() })
  }
  return candidates
}

/** 数字标记按整段匹配，避免 `10` 命中 `100` 或 `CN10`。 */
function containsReference(text: string, reference: string): boolean {
  const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^0-9A-Za-z])${escaped}(?![0-9A-Za-z])`).test(text)
}

/**
 * 给 PFIE 特征分配稳定编号；重复文本只保留首次出现，避免同一特征得到两个编号。
 * @param features - 原文特征文本，按提取顺序。
 * @returns 带 `F1`、`F2`… 编号的特征表。
 */
export function numberFeatures(features: readonly string[] | undefined): SpecFeature[] {
  const seen = new Set<string>()
  const numbered: SpecFeature[] = []
  for (const raw of features ?? []) {
    const text = raw.trim()
    if (text.length === 0 || seen.has(text)) continue
    seen.add(text)
    numbered.push({ id: `F${numbered.length + 1}`, text })
  }
  return numbered
}

/**
 * 复核并组装实施例块。
 *
 * 调用方给出 `embodiments` 时逐个复核；否则按原文字段切分。锚点原文缺省取
 * `sourceText` 自身（切分路径）或调用方给出的 `sourceText`（直接给出实施例的路径）。
 * 没有原文时跳过锚点复核，保留直接调用方的既有行为。
 * @param input - 原文、显式实施例、特征与附图标记。
 * @returns 保留块、丢弃块与撰写警告。
 */
export function buildEmbodimentBlocks(input: EmbodimentBuildInput): EmbodimentBuild {
  const sourceText = input.sourceText?.trim() ?? ''
  const explicit = input.embodiments?.map(text => text.trim())
  const explicitMode = explicit !== undefined && explicit.length > 0
  const candidates: Candidate[] = explicitMode
    ? explicit.map(text => ({ text, matchText: text }))
    : sourceText.length > 0
      ? splitByEmbodimentHeading(sourceText)
      : []
  // 显式实施例优先用调用方给的锚点源；切分路径的块本就来自原文。
  const anchorSource = explicitMode
    ? (input.anchorText ?? input.sourceText)?.trim() ?? ''
    : sourceText
  const features = input.features ?? []
  const figureMarks = input.figureMarks ?? []
  const blocks: EmbodimentBlock[] = []
  const dropped: DroppedEmbodimentBlock[] = []
  const warnings: string[] = []
  for (const candidate of candidates) {
    if (candidate.text.length === 0) {
      dropped.push({ text: '', reason: 'empty' })
      continue
    }
    const anchor = anchorSource.length === 0
      ? { matched: true, reason: 'exact' as const }
      : locateQuote(candidate.text, anchorSource)
    if (!anchor.matched) {
      // candidate.text 非空，locateQuote 只会给出 not-found。
      dropped.push({ text: candidate.text, reason: 'anchor-not-found' })
      continue
    }
    const featureIds = [...new Set(features
      .filter(feature => locateQuote(feature.text, candidate.text).matched)
      .map(feature => feature.id))]
    const marks = figureMarks.filter(mark => containsReference(candidate.matchText, mark.ref_number))
    const index = blocks.length + 1
    if (candidate.preamble !== true) {
      if (features.length > 0 && featureIds.length === 0) {
        warnings.push(`实施例 ${index} 未匹配到 PFIE 特征，未标注特征编号`)
      }
      if (figureMarks.length > 0 && marks.length === 0) {
        warnings.push(`实施例 ${index} 未匹配到附图标记`)
      }
    }
    blocks.push({
      index,
      ...(candidate.heading === undefined ? {} : { heading: candidate.heading }),
      ...(candidate.preamble === true ? { preamble: true } : {}),
      text: candidate.text,
      feature_ids: featureIds,
      figure_marks: marks,
      anchor_reason: anchor.reason,
    })
  }
  if (dropped.length > 0) {
    warnings.push(`具体实施方式丢弃 ${dropped.length} 个未命中原文或为空的实施例块`)
  }
  return { blocks, dropped, warnings }
}

/**
 * 把实施例块渲染成「具体实施方式」正文。
 *
 * 原文自带标题的块沿用标题；调用方直接给出的块补 `实施例N：` 前缀。特征编号与
 * 附图标记写在块末的引用行，没有命中时省略。
 * @param blocks - 已复核的实施例块。
 * @returns Markdown 正文；无块时为空串。
 */
export function renderEmbodimentBlocks(blocks: readonly EmbodimentBlock[]): string {
  return blocks.map((block, index) => {
    const body = block.preamble === true || block.heading !== undefined
      ? block.text
      : `实施例${index + 1}：${block.text}`
    const citations: string[] = []
    if (block.feature_ids.length > 0) citations.push(`对应特征 ${block.feature_ids.join('、')}`)
    if (block.figure_marks.length > 0) {
      const refs = [...new Set(block.figure_marks.map(mark => mark.ref_number))].join('、')
      const figures = [...new Set(block.figure_marks.map(mark => mark.figure_number))]
        .map(number => `图${number}`)
        .join('、')
      citations.push(`附图标记 ${refs}（${figures}）`)
    }
    return citations.length > 0 ? `${body}\n（${citations.join('；')}）` : body
  }).join('\n\n')
}
