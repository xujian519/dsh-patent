/**
 * src/patent/infringement — 全面覆盖原则的确定性判定（被诉方案 vs 权利要求要素）。
 *
 * 输入 claim-chart 的行级映射（`ChartRow`）与权利要求要素（`ClaimElement`），对指名的
 * 被诉方案目标判定：全部要素是否被字面覆盖、哪些要素只能走等同、哪些要素既无字面覆盖
 * 也无等同认定。
 *
 * 判定口径（全面覆盖原则：被诉方案包含权利要求的全部技术特征——相同或等同——才落入保护
 * 范围）：要素被字面覆盖取 `literal` 与 `literal-construction-dependent` 两种映射；后者
 * 的结论依赖权利要求解释，单独记为待解释要素，不计入字面结论。司法依据的具体条号见
 * `FULL_COVERAGE_BASIS`。
 *
 * 判定逐权利要求进行：同一目标上每条权项只比对其自身的要素，整体结论取覆盖最佳的权项
 * （落入任一权利要求的保护范围即侵害该专利）。要素表为空时没有可判定的要素，结论为
 * `undetermined` 而不是 `not-covered`——后者是"存在缺项"的实质法律结论。
 *
 * 与 claim-chart 既有派生的分工：`deriveNoveltyCoverage` 判的是"单篇对比文件是否公开
 * 全部要素"（新颖性），覆盖集只含现有技术侧的映射；本模块判的是"被诉方案是否落入保护
 * 范围"，覆盖集含等同，且把未覆盖要素拆成"需等同判断"与"缺项"两类。两者不共用覆盖集，
 * 也不互相调用。
 *
 * 与上游 Mady `domains/infringement/nodes.go` 的差异：上游由模型节点给出
 * `all_elements_met` 布尔值，特征映射表由同一次模型输出携带，程序只做汇总；本模块的结论
 * 只能由行级映射算出，不接受调用方直接给出的全面覆盖结论（确定性纪律：结论来自可复核
 * 的输入列）。
 */

import type { ChartRowMatch, ClaimElementRef, Mapping } from '../claim-chart/protocol/types.ts'

/** 单条权利要求的全面覆盖结论。 */
type ClaimCoverageOutcome = 'literal' | 'construction-dependent' | 'equivalence-required' | 'not-covered'

/** 全面覆盖的判定结果；`undetermined` 表示要素表为空，没有可判定的要素。 */
export type AllElementsOutcome = ClaimCoverageOutcome | 'undetermined'

/** 单条权利要求的全面覆盖判定。 */
type ClaimCoverage = {
  claimNo: number
  /** 该权项的要素总数。 */
  elementCount: number
  outcome: ClaimCoverageOutcome
  /** 字面覆盖的要素 id（按要素表序）。 */
  literalElements: string[]
  /** 字面覆盖依赖权利要求解释的要素 id。 */
  constructionDependentElements: string[]
  /** 未获字面覆盖、需按等同判断的要素 id（已有等同行）。 */
  equivalenceCandidates: string[]
  /** 既无字面覆盖也无等同行的要素 id——该权项的缺项。 */
  missingElements: string[]
}

/** 全面覆盖判定结果：整体结论与要素明细取覆盖最佳的权项。 */
export type AllElementsCoverage = {
  targetId: string
  /**
   * 整体结论：落入任一权利要求的保护范围即落入该专利的保护范围，故取逐权项结论中覆盖
   * 最佳者（`literal` > `construction-dependent` > `equivalence-required` > `not-covered`）；
   * 要素表为空时为 `undetermined`。
   */
  outcome: AllElementsOutcome
  /** 决定整体结论的权项号；要素表为空时省略。 */
  claimNo?: number
  /** 该权项的要素总数；要素表为空时为 0。 */
  elementCount: number
  /** 该权项字面覆盖的要素 id（按要素表序）。 */
  literalElements: string[]
  /** 该权项字面覆盖依赖权利要求解释的要素 id。 */
  constructionDependentElements: string[]
  /** 该权项未获字面覆盖、需按等同判断的要素 id（已有等同行）。 */
  equivalenceCandidates: string[]
  /** 该权项既无字面覆盖也无等同行的要素 id——该权项的缺项。 */
  missingElements: string[]
  /** 逐权项判定，按权项号升序；要素表为空时为空数组。 */
  claims: ClaimCoverage[]
}

/** 结论优劣次序：覆盖越充分越靠前，整体结论取次序最高的权项。 */
const OUTCOME_RANK: Record<ClaimCoverageOutcome, number> = {
  literal: 3,
  'construction-dependent': 2,
  'equivalence-required': 1,
  'not-covered': 0,
}

/** 全面覆盖原则的依据（条号待法律口径裁决后回填，见计划 §11.7）。 */
export const FULL_COVERAGE_BASIS = '全面覆盖原则：被诉技术方案包含权利要求记载的全部技术特征（相同或等同）时落入保护范围'

/** 计入字面覆盖的映射：原文相同，或原文相同但结论依赖权利要求解释。 */
const LITERAL_MAPPINGS = new Set<Mapping>(['literal', 'literal-construction-dependent'])

/** 权利要求解释依赖的映射。 */
const CONSTRUCTION_MAPPINGS = new Set<Mapping>(['literal-construction-dependent', 'construction-dependent'])

/**
 * 判定被诉方案是否落入权利要求的覆盖范围：逐权项判定，整体取覆盖最佳的权项。
 * @param rows - claim-chart 的行级映射。
 * @param targetId - 被诉方案（`kind: 'accused-product'`）目标 id。
 * @param elements - 权利要求要素列表（含所属权项号）。
 * @returns 全面覆盖判定结果；要素表为空时 `outcome` 为 `undetermined`。
 */
export function deriveAllElementsCoverage(
  rows: readonly ChartRowMatch[],
  targetId: string,
  elements: readonly ClaimElementRef[],
): AllElementsCoverage {
  const targetRows = rows.filter(row => row.targetId === targetId)
  const claims = groupByClaim(elements).map(([claimNo, claimElements]) =>
    deriveClaimCoverage(targetRows, claimNo, claimElements))
  const best = claims.reduce<ClaimCoverage | undefined>(
    (left, right) => left === undefined || OUTCOME_RANK[right.outcome] > OUTCOME_RANK[left.outcome] ? right : left,
    undefined,
  )
  if (best === undefined) {
    return {
      targetId,
      outcome: 'undetermined',
      elementCount: 0,
      literalElements: [],
      constructionDependentElements: [],
      equivalenceCandidates: [],
      missingElements: [],
      claims: [],
    }
  }
  return {
    targetId,
    outcome: best.outcome,
    claimNo: best.claimNo,
    elementCount: best.elementCount,
    literalElements: best.literalElements,
    constructionDependentElements: best.constructionDependentElements,
    equivalenceCandidates: best.equivalenceCandidates,
    missingElements: best.missingElements,
    claims,
  }
}

/**
 * 按权项号分组：组内保持要素表顺序，组间按权项号升序。
 * @param elements - 权利要求要素列表。
 * @returns 权项号到要素列表的映射项。
 */
function groupByClaim(elements: readonly ClaimElementRef[]): [number, ClaimElementRef[]][] {
  const groups = new Map<number, ClaimElementRef[]>()
  for (const element of elements) {
    const group = groups.get(element.claimNo)
    if (group === undefined) groups.set(element.claimNo, [element])
    else group.push(element)
  }
  return [...groups.entries()].sort(([left], [right]) => left - right)
}

/**
 * 判定单条权利要求的全部要素是否被目标覆盖。
 * @param targetRows - 该目标的映射行。
 * @param claimNo - 权利要求序号。
 * @param elements - 该权项的要素列表。
 * @returns 该权项的覆盖判定结果。
 */
function deriveClaimCoverage(
  targetRows: readonly ChartRowMatch[],
  claimNo: number,
  elements: readonly ClaimElementRef[],
): ClaimCoverage {
  const literalElements: string[] = []
  const constructionDependentElements: string[] = []
  const equivalenceCandidates: string[] = []
  const missingElements: string[] = []

  for (const element of elements) {
    const literal = targetRows.find(row => row.elementId === element.id && LITERAL_MAPPINGS.has(row.mapping))
    if (literal !== undefined) {
      if (CONSTRUCTION_MAPPINGS.has(literal.mapping)) constructionDependentElements.push(element.id)
      else literalElements.push(element.id)
      continue
    }
    if (targetRows.some(row => row.elementId === element.id && row.mapping === 'doe')) {
      equivalenceCandidates.push(element.id)
      continue
    }
    missingElements.push(element.id)
  }

  return {
    claimNo,
    elementCount: elements.length,
    outcome: outcomeOf(
      constructionDependentElements.length,
      equivalenceCandidates.length,
      missingElements.length,
    ),
    literalElements,
    constructionDependentElements,
    equivalenceCandidates,
    missingElements,
  }
}

/**
 * 汇总单条权项的判定结果：缺项即不落入；无缺项时按是否存在待解释要素与等同要素区分三态。
 * @param constructionDependentCount - 待解释要素数。
 * @param equivalenceCandidateCount - 需等同判断的要素数。
 * @param missingCount - 缺项要素数。
 * @returns 该权项的判定结果。
 */
function outcomeOf(
  constructionDependentCount: number,
  equivalenceCandidateCount: number,
  missingCount: number,
): ClaimCoverageOutcome {
  if (missingCount > 0) return 'not-covered'
  if (constructionDependentCount > 0) return 'construction-dependent'
  return equivalenceCandidateCount > 0 ? 'equivalence-required' : 'literal'
}
