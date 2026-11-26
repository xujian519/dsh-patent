/**
 * 由已核验矛盾折出候选 PFIE 单元（纯函数，不调用模型）。
 *
 * 候选面与锚定面分离：矛盾的证据已逐条在交底书原文中定位，方案方向却是模型给出的
 * 手段假设，没有原文支撑。把两者混进同一张 `pfe_triples` 表会让无锚内容随四元组进入
 * 权利要求策略与说明书正文，正是 `groundedness` 与锚点校验要拦的事。因此本模块只产出
 * 待发明人确认的候选，交付面继续只读已锚定的四元组。
 * @module @deepseek-ai/dsh-patent-core/triz/candidates
 */

import type {
  TrizCandidateBuild,
  TrizCandidateSkip,
  TrizCandidateUnit,
  TrizContradiction,
  TrizPrincipleRef,
} from './types.ts'
import { TRIZ_CANDIDATE_STATUS } from './types.ts'

/** 原理的行内引用「编号 名称」；名称缺失时只给编号。 */
function principleLabel(principle: TrizPrincipleRef): string {
  return principle.name.trim().length === 0 ? String(principle.number) : `${principle.number} ${principle.name}`
}

/**
 * 把矛盾的推荐原理与方案方向折成候选单元。
 *
 * 一条方向一个单元；没有推荐原理可依的矛盾（对角格的物理矛盾、矩阵转录空缺）不生成
 * 候选，因为候选的发明认知必须由原理支撑，否则只是把模型的手段猜测换了个名字。
 * @param contradictions - 已核验的矛盾列表（`buildTrizAnalysis` 的产物）。
 * @returns 候选单元与因缺原理而未折出候选的矛盾计数。
 */
export function buildTrizCandidateUnits(
  contradictions: readonly TrizContradiction[],
): TrizCandidateBuild {
  const units: TrizCandidateUnit[] = []
  const skipped: TrizCandidateSkip[] = []
  for (const contradiction of contradictions) {
    const directions = contradiction.solutionDirections.map(direction => direction.trim()).filter(direction => direction.length > 0)
    if (contradiction.principles.length === 0) {
      if (directions.length > 0) {
        skipped.push({
          contradictionId: contradiction.id,
          matrixStatus: contradiction.matrixStatus,
          directionCount: directions.length,
        })
      }
      continue
    }
    const principleText = contradiction.principles.map(principleLabel).join('、')
    const insight = `借助${principleText}化解「${contradiction.improving.name}」与「${contradiction.worsening.name}」的取舍`
    const effect = `改善${contradiction.improving.name}，且不以牺牲${contradiction.worsening.name}为代价`
    for (const direction of directions) {
      units.push({
        id: `K${units.length + 1}`,
        contradictionId: contradiction.id,
        problem: contradiction.statement,
        insight,
        feature: direction,
        effect,
        principles: contradiction.principles,
        contradictionEvidence: contradiction.evidence,
        status: TRIZ_CANDIDATE_STATUS,
      })
    }
  }
  return { units, skipped }
}
