/** A26.3 原子的桩模型记录；特征 ID 由被测原子从权利要求派生。 */
export type EnablementModelRecord = {
  /** 派生特征 ID，形如 `C1F2`。 */
  feature_id: string
  /** 说明书原文摘录；没有支撑时为空串。 */
  quote: string
  /** 实施例标识。 */
  embodiment_id: string
  /** 支撑该特征可实现的参数或技术效果。 */
  parameter_or_effect: string
  /** 模型判定该特征是否能够实现。 */
  enabled: boolean
}

/** A26.4 原子的桩模型记录。 */
export type ClaimBreadthModelRecord = {
  /** 权利要求项号。 */
  claim_no: number
  /** 权利要求中的上位表达。 */
  generalization: string
  /** 说明书原文摘录；没有支撑时为空串。 */
  quote: string
  /** 说明书中的并列下位实施方式。 */
  parallel_lower_levels: string[]
  /** 并列下位是否都能达到同一效果。 */
  all_parallel_same_effect: boolean
  /** 模型判定的缺陷类型。 */
  defect:
    | 'none'
    | 'no-embodiment-support'
    | 'parallel-lower-level-gap'
    | 'functional-limitation-without-embodiment'
    | 'term-inconsistency'
  /** 判定说明。 */
  reason: string
}

/** `legal-gaps` 中与本夹具集相关的检查项 id。 */
export type DraftingDefectCheck = 'enablement' | 'claim-support-breadth'

/** 一条种植缺陷夹具：固定原文、桩模型记录与期望判定。 */
export type DraftingDefectFixture = {
  /** 夹具编号，如 `D01`。 */
  id: string
  /** 缺陷名称。 */
  title: string
  /** 覆盖的法条。 */
  provision: 'A26.3' | 'A26.4' | 'A26.3+A26.4'
  /** 期望的 `legal-gaps` 状态。 */
  expected: 'passed' | 'failed'
  /** 说明书片段。 */
  specification: string
  /** 权利要求片段。 */
  claims: string
  /** `state.tech_domain`；领域分叉夹具需要它。 */
  tech_domain?: string
  /** 断言哪些 `legal-gaps` 检查项。 */
  checks: readonly DraftingDefectCheck[]
  /** `enablement-report` 的桩模型输出；夹具不覆盖该原子时省略。 */
  enablement?: {
    records: readonly EnablementModelRecord[]
    notes?: string
  }
  /** `claim-breadth` 的桩模型输出；夹具不覆盖该原子时省略。 */
  breadth?: {
    records: readonly ClaimBreadthModelRecord[]
    notes?: string
  }
  /** 可选的锚点复核期望，用于证明失败来自程序复核而非模型判定。 */
  anchor_reason?: 'exact' | 'normalized' | 'not-found' | 'empty'
}
