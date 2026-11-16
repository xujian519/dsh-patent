/**
 * mapping 状态机（纯函数）：行级场景合法性 + 跨行法理推导
 * （新颖性单篇全覆盖、区别特征提取 —— 三步法第二步的输入）。
 */

import type { ChartMode, ChartRow, ChartTarget, ClaimElement, ClaimNoveltyCoverage, ClaimRef } from '../protocol/types.ts'
import { referenceAlternatives, referencedClosure } from './claim-refs.ts'

const PRIOR_ART_ONLY = new Set(['anticipation', 'obviousness-combination'])
const COVERED_MAPPINGS = new Set(['literal', 'anticipation', 'literal-construction-dependent'])

/**
 * 该映射是否计入覆盖：计入覆盖的行在源文可读时必须给出逐字引用。
 * @param mapping - 映射类型。
 * @returns 是否计入覆盖。
 */
export function mappingRequiresQuote(mapping: ChartRow['mapping']): boolean {
  return COVERED_MAPPINGS.has(mapping)
}

/** 过滤 targetId + mapping 集合命中的行，返回要素 id 列表。 */
function mappedElementIds(rows: readonly ChartRow[], targetId: string, mappings: ReadonlySet<string>): string[] {
  return rows.filter(r => r.targetId === targetId && mappings.has(r.mapping)).map(r => r.elementId)
}

/**
 * 该要素是否已被指定的一篇公开（原文相同，或原文相同但结论依赖权利要求解释）。
 *
 * 新颖性、从属权项路径检查与区别特征提取共用这一条覆盖口径，避免三处各写一份映射集合。
 * @param rows - 映射行列表。
 * @param targetId - 对比文件目标 id。
 * @param elementId - 要素 id。
 * @returns 是否已覆盖。
 */
export function isElementCovered(rows: readonly ChartRow[], targetId: string, elementId: string): boolean {
  return rows.some(row => row.targetId === targetId && row.elementId === elementId && COVERED_MAPPINGS.has(row.mapping))
}

/**
 * 行级合法性：返回违规描述列表（空 = 合法）。
 * @param row - 待校验的映射行。
 * @param target - 行指向的目标（可能未定义）。
 * @param mode - 图表分析模式。
 * @returns 违规描述列表（空表示合法）。
 */
export function validateRowMapping(row: ChartRow, target: ChartTarget | undefined, mode: ChartMode): string[] {
  const errors: string[] = []
  if (PRIOR_ART_ONLY.has(row.mapping) && target?.kind !== 'prior-art') {
    errors.push(`行 [${row.elementId}→${row.targetId}] 的 mapping "${row.mapping}" 仅适用于 prior-art 目标`)
  }
  if (row.mapping === 'doe' && mode !== 'infringement') {
    errors.push(`行 [${row.elementId}→${row.targetId}] 的 mapping "doe" 仅适用于侵权模式`)
  }
  return errors
}

/**
 * 新颖性（单独对比）：目标上每个要素须 mapped（单篇全覆盖，专利法 A22.2）。
 * @param rows - 映射行列表。
 * @param targetId - 目标 id。
 * @param elements - 权利要求要素列表。
 * @returns 覆盖结果：covered 是否全覆盖，missing 为未覆盖要素 id 列表。
 */
export function deriveNoveltyCoverage(
  rows: readonly ChartRow[],
  targetId: string,
  elements: readonly ClaimElement[],
): { covered: boolean; missing: string[] } {
  const coveredIds = new Set(mappedElementIds(rows, targetId, COVERED_MAPPINGS))
  const missing = elements.filter(el => !coveredIds.has(el.id)).map(el => el.id)
  return { covered: missing.length === 0, missing }
}

/** 单条权利要求在一篇对比文件上的单篇全覆盖判定（契约见协议层）。 */
export type { ClaimNoveltyCoverage } from '../protocol/types.ts'

/**
 * 逐权利要求的单篇全覆盖判定：从属权项的比对对象是其全部要素与所引用权项全部要素的组合
 * （从属权利要求的技术方案包含所引用权利要求的全部技术特征；本仓口径见
 * `patent-document` 的 `templates/patent/invalidation-opinion/references/conventions.md` §2.1），
 * 故覆盖判定须并入引用链上的要素。多项从属权项以择一方式引用，每个直接引用是一个独立替代
 * 方案：任一路径全覆盖即该权项全覆盖，`missing` 取缺口最少的路径，逐路径结果保留在
 * `alternatives`。缺 `claims` 时按全部权项独立处理。
 * @param rows - 映射行列表。
 * @param targetId - 对比文件目标 id。
 * @param elements - 权利要求要素列表。
 * @param claims - 逐权项的引用关系；空数组表示引用关系未知（按独立处理）。
 * @returns 逐权项的覆盖判定，按权项号升序。
 */
export function deriveNoveltyCoverageByClaim(
  rows: readonly ChartRow[],
  targetId: string,
  elements: readonly ClaimElement[],
  claims: readonly ClaimRef[] = [],
): ClaimNoveltyCoverage[] {
  const coveredIds = new Set(mappedElementIds(rows, targetId, COVERED_MAPPINGS))
  const claimNosWithElements = new Set(elements.map(el => el.claimNo))
  const claimNos = [...claimNosWithElements].sort((a, b) => a - b)
  return claimNos.map((claimNo) => {
    const referredClaimNos = referencedClosure(claims, claimNo)
    const paths = referenceAlternatives(claims, claimNo)
    const alternatives = (paths.length === 0 ? [[claimNo]] : paths.map(path => [claimNo, ...path]))
      .map((scope) => {
        const missing = elements.filter(el => scope.includes(el.claimNo) && !coveredIds.has(el.id)).map(el => el.id)
        // 引用链上的权项没有被拆出任何要素时，该路径无法证明"已并入其全部要素"。
        const missingReferredClaims = scope
          .filter(value => value !== claimNo && !claimNosWithElements.has(value))
          .sort((a, b) => a - b)
        return {
          referredClaimNos: scope.filter(value => value !== claimNo).sort((a, b) => a - b),
          covered: missing.length === 0 && missingReferredClaims.length === 0,
          missing,
          ...(missingReferredClaims.length > 0 ? { missingReferredClaims } : {}),
        }
      })
    const best = alternatives.reduce((left, right) => {
      const leftUnassessed = left.missingReferredClaims?.length ?? 0
      const rightUnassessed = right.missingReferredClaims?.length ?? 0
      if (rightUnassessed !== leftUnassessed) return rightUnassessed < leftUnassessed ? right : left
      return right.missing.length < left.missing.length ? right : left
    })
    return {
      claimNo,
      covered: best.covered,
      missing: best.missing,
      includesReferredClaims: referredClaimNos.length > 0,
      referredClaimNos,
      ...(best.missingReferredClaims !== undefined ? { missingReferredClaims: best.missingReferredClaims } : {}),
      ...(paths.length > 1 ? { alternatives } : {}),
    }
  })
}

/**
 * 区别特征 = 主目标（D1）上未获覆盖的要素（供三步法第二步与 draft-claims 规避布局）。
 *
 * 与覆盖判定共用 {@link isElementCovered}：不仅 `not-found`／`needs-evidence`，`partial`、
 * `construction-dependent` 与"该目标上根本没有映射行"都算未覆盖——区别特征是"主对比文件
 * 是否公开了该要素"的补集，不是"映射行写了哪个词"。
 * @param rows - 映射行列表。
 * @param primaryTargetId - 主目标（D1）id。
 * @param elements - 权利要求要素列表。
 * @returns 区别特征要素 id 列表，按要素表序。
 */
export function deriveDistinguishingFeatures(
  rows: readonly ChartRow[],
  primaryTargetId: string,
  elements: readonly ClaimElement[],
): string[] {
  return elements.filter(el => !isElementCovered(rows, primaryTargetId, el.id)).map(el => el.id)
}
