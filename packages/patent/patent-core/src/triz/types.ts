/**
 * TRIZ 矛盾分析与交底书补强的领域类型（发明人侧）。
 *
 * 用途边界：本模块的产物是交底书理解、替代方案方向与补强清单的输入，
 * **不是**《专利审查指南》三步法第二步"实际解决的技术问题"的表述依据——
 * 矛盾对刻画的是发明构思层面的参数取舍，带手段色彩，进入审查答复的法定
 * 论证段会与 `checkAtomic` 的"不绑方案"检验冲突。
 * @module @deepseek-ai/dsh-patent-core/triz/types
 */

/** 一个 TRIZ 工程参数引用：编号 + 随包参数表的名称。 */
export type TrizParameterRef = {
  /** 工程参数编号，1-39。 */
  readonly number: number
  /** 参数名称（由随包参数表补全，不取模型输出）。 */
  readonly name: string
}

/** 一条矛盾对在 39x39 经典矩阵中的落格状态。 */
export type TrizMatrixStatus =
  /** 非对角格且有推荐原理。 */
  | 'recommended'
  /** 对角格（改善参数等于恶化参数）：经典矩阵中的物理矛盾，无条目。 */
  | 'physical'
  /** 矩阵转录的空缺格：既非物理矛盾，也无推荐原理。 */
  | 'gap'

/** 一条矩阵推荐的发明原理（编号 + 名称）。 */
export type TrizPrincipleRef = {
  /** 发明原理编号，1-40。 */
  readonly number: number
  /** 原理名称（由随包原理表补全）。 */
  readonly name: string
}

/** 一条已核验的技术矛盾：证据片段必须能在交底书原文中定位。 */
export type TrizContradiction = {
  /** 稳定标识，形如 `C1`。 */
  readonly id: string
  /** 改善的工程参数。 */
  readonly improving: TrizParameterRef
  /** 随之恶化的工程参数。 */
  readonly worsening: TrizParameterRef
  /** 矛盾表述：改善什么、同时牺牲什么。 */
  readonly statement: string
  /** 交底书原文片段（已核验可定位）。 */
  readonly evidence: string
  /** 矩阵推荐原理；`physical` 与 `gap` 状态为空数组。 */
  readonly principles: readonly TrizPrincipleRef[]
  readonly matrixStatus: TrizMatrixStatus
  /** 借推荐原理给出的候选方案方向（模型输出，逐条非空）。 */
  readonly solutionDirections: readonly string[]
}

/** 交底书中缺失的参数维度。 */
export type TrizGapKind =
  /** 缺现状值（现有技术／传统方案一侧的取值）。 */
  | 'current-value'
  /** 缺目标值（本方案要达到的取值）。 */
  | 'target-value'
  /** 缺单位。 */
  | 'unit'
  /** 缺测量／试验口径（样本量、测试条件、统计方式）。 */
  | 'test-method'
  /** 其它缺口。 */
  | 'other'

/** 一条参数完备性缺口：该工程参数缺少可验证的取值信息。 */
export type TrizParameterGap = {
  readonly parameter: TrizParameterRef
  /** 缺失的维度，至少一项。 */
  readonly missing: readonly TrizGapKind[]
  /** 缺口说明：为何该缺口影响撰写或创造性论证。 */
  readonly detail: string
}

/** 未采纳的表述：未映射到 1-39 参数，或证据未通过核验。 */
export type TrizUnmappedItem = {
  /** 原表述。 */
  readonly statement: string
  /** 未采纳原因。 */
  readonly reason: string
}

/** 一次交底书 TRIZ 矛盾分析的完整产物。 */
export type TrizContradictionAnalysis = {
  readonly contradictions: readonly TrizContradiction[]
  /** 按参数编号合并的完备性缺口。 */
  readonly parameterGaps: readonly TrizParameterGap[]
  readonly unmapped: readonly TrizUnmappedItem[]
  /** 因证据无法在原文定位而丢弃的矛盾数。 */
  readonly droppedForEvidence: number
}

/**
 * 一条由矛盾与矩阵推荐原理折出的候选 PFIE 单元（发明人确认材料）。
 *
 * 候选面与锚定面分离：`contradictionEvidence` 是来源矛盾的已核验原文片段，
 * 而 `feature` 与 `insight` 是模型给出的手段假设，**没有**原文锚点。
 * 因此候选不写进 `pfe_triples`，也不得进入权利要求策略或说明书正文。
 */
export type TrizCandidateUnit = {
  /** 稳定标识，形如 `K1`。 */
  readonly id: string
  /** 来源矛盾 id。 */
  readonly contradictionId: string
  /** 候选的问题：沿用已核验矛盾的表述。 */
  readonly problem: string
  /** 候选的发明认知：按推荐原理给出的机制假设，不是发明人陈述。 */
  readonly insight: string
  /** 候选的特征：矛盾的方案方向文本，无原文锚点。 */
  readonly feature: string
  /** 候选的效果：化解矛盾后期望的参数方向。 */
  readonly effect: string
  /** 来源矛盾格子的推荐原理全集。 */
  readonly principles: readonly TrizPrincipleRef[]
  /** 来源矛盾的原文证据；它支撑矛盾，不支撑候选的特征与效果。 */
  readonly contradictionEvidence: string
  /** 确认状态：本模块产出的候选一律待发明人确认。 */
  readonly status: TrizCandidateStatus
}

/** 候选单元的确认状态。 */
export const TRIZ_CANDIDATE_STATUS = 'pending-inventor-confirmation' as const

/** 候选单元待发明人确认的单一取值。 */
export type TrizCandidateStatus = typeof TRIZ_CANDIDATE_STATUS

/** 有方案方向但无推荐原理可依的矛盾：不生成候选，只报告。 */
export type TrizCandidateSkip = {
  readonly contradictionId: string
  readonly matrixStatus: TrizMatrixStatus
  /** 该矛盾的非空白方案方向数，即本可折出的候选数。 */
  readonly directionCount: number
}

/** 候选单元构建结果。 */
export type TrizCandidateBuild = {
  /** 已折出的候选，按矛盾输入顺序与方向顺序排列。 */
  readonly units: readonly TrizCandidateUnit[]
  /** 有方向但无原理可依的矛盾，按输入顺序排列。 */
  readonly skipped: readonly TrizCandidateSkip[]
}

/** 模型抽取的原始结果：字段在组装时逐项校验，故此处保持未知。 */
export type TrizExtractionInput = {
  /** 矛盾候选数组。 */
  readonly contradictions?: unknown
  /** 参数完备性缺口候选数组。 */
  readonly parameter_gaps?: unknown
  /** 模型自报的未映射表述数组。 */
  readonly unmapped?: unknown
}
