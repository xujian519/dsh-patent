/**
 * src/adversary/isolation-check — 信息隔离检查。
 *
 * 隔离分三层，判定各自独立：
 * 1. 声明层：adversary-model 的 inputSchema 只声明可读键，不包含 {@link FORBIDDEN_KEYS}；
 * 2. 运行时层：{@link checkInputIsolation} 供宿主按 key 列表自检。adversary-model 不调用它，
 *    因为共享 state 必然含上游产出（claim_chart、draft 等），按整份 state 的键判失败会把
 *    每次运行都判成泄漏；该原子以"只读 office_action/claims/response_plan/response_plan_summary"
 *    保证隔离；
 * 3. 输出层：{@link scanOutputForLeaks} 扫描报告文本是否包含禁止术语。
 */

/** 禁止出现在 adversary 输入中的键（己方中间推理产物）。 */
export const FORBIDDEN_KEYS: readonly string[] = [
  'dispute_framing_report',
  'dispute_framing_candidates',
  'dispute_framing_claims',
  'dispute_framing_refined',
  'dispute_framing_refined_candidates',
  'claim_chart',
  'draft',
]

/** 禁止出现在 adversary 输出中的术语（防止反向泄漏）。 */
export const FORBIDDEN_OUTPUT_TERMS: readonly string[] = [
  'dispute_framing',
  'claim_chart',
  '己方推理',
  '内部分析',
]

/** 隔离检查结果。 */
export type IsolationCheckResult = {
  /** 是否通过检查（clean=true 表示无泄漏）。 */
  clean: boolean
  /** 检测到的禁止键或术语列表。 */
  leakedKeys: string[]
}

/**
 * 检查 PipelineState 是否包含禁止键（运行时层隔离检查）。
 * @param stateKeys - PipelineState 的键列表。
 * @returns 检查结果，包含是否通过及泄漏的键列表。
 */
export function checkInputIsolation(stateKeys: readonly string[]): IsolationCheckResult {
  const leakedKeys = FORBIDDEN_KEYS.filter(key => stateKeys.includes(key))
  return {
    clean: leakedKeys.length === 0,
    leakedKeys,
  }
}

/**
 * 扫描输出文本是否包含禁止术语（输出层隔离检查）。
 * @param report - 待扫描的报告文本。
 * @param forbiddenTerms - 禁止术语列表（默认使用 FORBIDDEN_OUTPUT_TERMS）。
 * @returns 检查结果，包含是否通过及检测到的术语列表。
 */
export function scanOutputForLeaks(
  report: string,
  forbiddenTerms: readonly string[] = FORBIDDEN_OUTPUT_TERMS,
): IsolationCheckResult {
  const leakedKeys = forbiddenTerms.filter(term => report.includes(term))
  return {
    clean: leakedKeys.length === 0,
    leakedKeys,
  }
}
