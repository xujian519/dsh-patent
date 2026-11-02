/**
 * src/draft-review/types — 撰写链换位审查的稳定契约。
 *
 * 审查只从说明书、权利要求、PFIE 特征与检索文献出发，输出可路由的争议点；
 * 不读取策略表、融合结果或从权专员的中间推理。
 */

/** 五类审查口径；每条争议点必须归入其中一类。 */
export const DRAFT_REVIEW_CATEGORIES = [
  'enablement',
  'support',
  'clarity',
  'unity',
  'amendment',
] as const

/** 审查口径。 */
export type DraftReviewCategory = (typeof DRAFT_REVIEW_CATEGORIES)[number]

/** 可执行建议；`none` 表示审查认为无需修改。 */
export const DRAFT_REVIEW_RECOMMENDATIONS = [
  'tighten-claim',
  'add-embodiment',
  'clarify-term',
  'split-unity',
  'none',
] as const

/** 建议动作。 */
export type DraftReviewRecommendation = (typeof DRAFT_REVIEW_RECOMMENDATIONS)[number]

/** 每类审查口径对应的法条；报告与回退留痕使用同一映射。 */
export const DRAFT_REVIEW_PROVISIONS: Readonly<Record<DraftReviewCategory, string>> = {
  enablement: '专利法第26条第3款',
  support: '专利法第26条第4款',
  clarity: '专利法第26条第4款',
  unity: '专利法第31条第1款',
  amendment: '专利法第33条',
}

/** 一类争议点的中文名称。 */
export const DRAFT_REVIEW_CATEGORY_LABELS: Readonly<Record<DraftReviewCategory, string>> = {
  enablement: '充分公开',
  support: '权利要求支持',
  clarity: '清楚性',
  unity: '单一性',
  amendment: '修改依据',
}

/** 一条可路由的争议点。 */
export type DraftReviewDispute = {
  /** 审查口径。 */
  category: DraftReviewCategory
  /** 法条或指南节号，由口径派生。 */
  provision: string
  /** 可执行建议。 */
  recommendation: DraftReviewRecommendation
  /** 涉及的权利要求序号；未指向具体权项时省略。 */
  claimNumber?: number
  /** 涉及的 PFIE 特征编号；未指向具体特征时省略。 */
  featureId?: string
  /** 复核过的原文摘录；给出时已命中说明书或权利要求。 */
  anchor?: string
}

/** 一次审查的完整产出；报告与判定只由同一构造路径产生。 */
export type DraftReviewResult = {
  /** 主输出：争议点报告。 */
  draft_review_report: string
  /** 是否存在可执行争议点。 */
  draft_review_passed: boolean
  /** 结构化争议点；顺序与模型输出一致。 */
  draft_review_disputes: DraftReviewDispute[]
}

/** 审查输入：只允许这四个来源。 */
export type DraftReviewInput = {
  /** 说明书原文。 */
  specification: string
  /** 权利要求草稿原文。 */
  claims: string
  /** PFIE 特征或四元组文本；为空时不进入提示词。 */
  pfe: string
  /** 检索文献文本；为空时不进入提示词。 */
  priorArt: string
}

/**
 * 一类争议点对应的回退缺口编号。
 * @param category - 审查口径。
 * @returns 形如 `draft-review:unity` 的缺口编号。
 */
export function draftReviewGapId(category: DraftReviewCategory): string {
  return `draft-review:${category}`
}
