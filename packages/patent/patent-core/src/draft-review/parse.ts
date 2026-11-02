/**
 * src/draft-review/parse — 严格解析模型给出的争议点。
 *
 * 模型只输出结构化字段，不输出推理过程。锚点必须逐字命中说明书或权利要求，
 * 否则整份输出判失败：让「定位不到原文」的争议点静默通过，会把模型臆测当成事实。
 */

import { locateQuote } from '../anchor/index.ts'
import { isJsonRecord, readJsonString } from '../llm-json.ts'
import {
  DRAFT_REVIEW_CATEGORIES,
  DRAFT_REVIEW_PROVISIONS,
  DRAFT_REVIEW_RECOMMENDATIONS,
  type DraftReviewCategory,
  type DraftReviewDispute,
  type DraftReviewInput,
  type DraftReviewRecommendation,
} from './types.ts'

/** 模型输出的一条争议点；字段已通过形状校验，锚点尚未复核。 */
export type ModelDispute = {
  category: DraftReviewCategory
  recommendation: DraftReviewRecommendation
  claimNumber?: number
  featureId?: string
  anchor?: string
}

/** 形状校验结果：通过携带字段，失败携带可读原因。 */
export type ModelDisputeRead = { ok: true; dispute: ModelDispute } | { ok: false; reason: string }

/**
 * 读取一条模型争议点。
 * @param record - 模型返回的数组项。
 * @param index - 数组下标，用于错误文案。
 * @returns 解析结果，或可直接展示的原因。
 */
export function readModelDispute(record: unknown, index: number): ModelDisputeRead {
  if (!isJsonRecord(record)) return { ok: false, reason: `disputes 第 ${index + 1} 项不是对象` }
  const category = readJsonString(record['category'])
  if (category === undefined || !(DRAFT_REVIEW_CATEGORIES as readonly string[]).includes(category)) {
    return {
      ok: false,
      reason: `disputes 第 ${index + 1} 项的 category 必须是 ${DRAFT_REVIEW_CATEGORIES.join(' / ')} 之一`,
    }
  }
  const recommendation = readJsonString(record['recommendation'])
  if (
    recommendation === undefined
    || !(DRAFT_REVIEW_RECOMMENDATIONS as readonly string[]).includes(recommendation)
  ) {
    return {
      ok: false,
      reason: `disputes 第 ${index + 1} 项的 recommendation 必须是 ${DRAFT_REVIEW_RECOMMENDATIONS.join(' / ')} 之一`,
    }
  }
  const rawClaim = record['claimNumber']
  if (rawClaim !== undefined && (!Number.isInteger(rawClaim) || (rawClaim as number) < 1)) {
    return { ok: false, reason: `disputes 第 ${index + 1} 项的 claimNumber 必须是正整数` }
  }
  const featureId = record['featureId'] === undefined ? undefined : readJsonString(record['featureId'])
  if (record['featureId'] !== undefined && featureId === undefined) {
    return { ok: false, reason: `disputes 第 ${index + 1} 项的 featureId 必须是非空字符串` }
  }
  const anchor = record['anchor'] === undefined ? undefined : readJsonString(record['anchor'])
  if (record['anchor'] !== undefined && anchor === undefined) {
    return { ok: false, reason: `disputes 第 ${index + 1} 项的 anchor 必须是非空字符串` }
  }
  return {
    ok: true,
    dispute: {
      category: category as DraftReviewCategory,
      recommendation: recommendation as DraftReviewRecommendation,
      ...(rawClaim !== undefined ? { claimNumber: rawClaim as number } : {}),
      ...(featureId !== undefined ? { featureId } : {}),
      ...(anchor !== undefined ? { anchor } : {}),
    },
  }
}

/** 一条争议点与复核后的锚点位置。 */
export type CheckedDispute = {
  dispute: DraftReviewDispute
  /** 锚点命中哪份原文；未给锚点时省略。 */
  anchorSource?: 'specification' | 'claims'
}

/** 构建结果：成功携带争议点，失败携带模型输出不可用的原因。 */
export type BuildResult =
  | { ok: true; disputes: CheckedDispute[] }
  | { ok: false; reason: string }

/** 去重键：同一类问题在同一权项/特征上的重复条目只保留第一条。 */
function disputeKey(dispute: ModelDispute): string {
  return [dispute.category, dispute.claimNumber ?? '', dispute.featureId ?? '', dispute.anchor ?? ''].join('\u0000')
}

/**
 * 复核锚点并构造争议点。
 *
 * 锚点按说明书优先、权利要求其次复核；两处都不命中即判失败。
 * @param modelDisputes - 已通过形状校验的模型争议点。
 * @param input - 审查输入（用于复核锚点）。
 * @returns 争议点列表，或首个不可用原因。
 */
export function buildCheckedDisputes(
  modelDisputes: readonly ModelDispute[],
  input: DraftReviewInput,
): BuildResult {
  const seen = new Set<string>()
  const checked: CheckedDispute[] = []
  for (const modelDispute of modelDisputes) {
    const key = disputeKey(modelDispute)
    if (seen.has(key)) continue
    seen.add(key)
    let anchorSource: 'specification' | 'claims' | undefined
    if (modelDispute.anchor !== undefined) {
      if (locateQuote(modelDispute.anchor, input.specification).matched) {
        anchorSource = 'specification'
      } else if (locateQuote(modelDispute.anchor, input.claims).matched) {
        anchorSource = 'claims'
      } else {
        return {
          ok: false,
          reason: `争议点「${modelDispute.category}」的锚点未在说明书或权利要求中命中：${modelDispute.anchor}`,
        }
      }
    }
    const dispute: DraftReviewDispute = {
      category: modelDispute.category,
      provision: DRAFT_REVIEW_PROVISIONS[modelDispute.category],
      recommendation: modelDispute.recommendation,
      ...(modelDispute.claimNumber !== undefined ? { claimNumber: modelDispute.claimNumber } : {}),
      ...(modelDispute.featureId !== undefined ? { featureId: modelDispute.featureId } : {}),
      ...(modelDispute.anchor !== undefined ? { anchor: modelDispute.anchor } : {}),
    }
    checked.push({ dispute, ...(anchorSource !== undefined ? { anchorSource } : {}) })
  }
  return { ok: true, disputes: checked }
}
