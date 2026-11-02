/**
 * src/draft-review/isolation — 撰写链换位审查的输入隔离。
 *
 * 审查只看交付正文与事实来源，不看己方决策过程：
 * - 策略表（`claim_strategy*`）记录特征归属与从权分层，是撰写方的选择；
 * - `merge_result` 是融合后的己方表述；
 * - `draft_claims_result` / `review_context` 带从权专员改写与人工复核上下文。
 *
 * 隔离由三层保证：原子的 `inputSchema` 白名单、执行器只读白名单键，以及
 * 组装输入时对禁用键的显式检查。
 */

/** 审查允许读取的状态键。 */
export const DRAFT_REVIEW_ALLOWED_KEYS: readonly string[] = [
  'specification',
  'claims_draft',
  'pfe_triples',
  'features',
  'prior_art',
]

/** 审查禁止读取的状态键（己方中间推理）。 */
export const DRAFT_REVIEW_FORBIDDEN_KEYS: readonly string[] = [
  'claim_strategy',
  'claim_strategy_report',
  'merge_result',
  'draft_claims_result',
  'review_context',
]

/** 禁止出现在审查输出中的术语：己方决策过程与推理叙述。 */
export const DRAFT_REVIEW_FORBIDDEN_OUTPUT_TERMS: readonly string[] = [
  'claim_strategy',
  'merge_result',
  'draft_claims_result',
  '思维链',
  '推理过程',
  '内部分析',
]

/** 隔离检查结果。 */
export type DraftReviewIsolationResult = {
  /** 是否没有禁用键或术语。 */
  clean: boolean
  /** 检测到的禁用键或术语。 */
  leakedKeys: string[]
}

/**
 * 检查一份已组装输入是否携带禁用键。
 * @param input - 键值输入。
 * @returns 检查结果与泄漏的键。
 */
export function checkDraftReviewInput(
  input: Readonly<Record<string, unknown>>,
): DraftReviewIsolationResult {
  const leakedKeys = DRAFT_REVIEW_FORBIDDEN_KEYS.filter(key => key in input)
  return { clean: leakedKeys.length === 0, leakedKeys }
}

/**
 * 检查审查说明是否夹带推理过程或己方决策术语。
 * @param notes - 模型给出的审查说明。
 * @returns 检查结果与命中的术语。
 */
export function scanDraftReviewOutput(notes: string): DraftReviewIsolationResult {
  const leakedKeys = DRAFT_REVIEW_FORBIDDEN_OUTPUT_TERMS.filter(term => notes.includes(term))
  return { clean: leakedKeys.length === 0, leakedKeys }
}
