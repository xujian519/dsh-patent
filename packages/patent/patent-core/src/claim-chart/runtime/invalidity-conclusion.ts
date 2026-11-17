/**
 * 无效／复审的确定性结论：由 claim-chart 的行级映射直接算出（不调用模型）。
 *
 * 装配三类判定：逐权项的对比文件单篇全覆盖、相对主对比文件的区别特征（三步法第二步的
 * 输入）、引用关系与从属权项法条路径的机械检查。结论只能由行级映射与权利要求引用关系
 * 算出，不接受调用方直接给出的"是否具备新颖性"结论。
 *
 * 与侵权侧（`infringement/conclusion.ts`）的分工：本模块判"一篇现有技术是否公开权利要求的
 * 全部技术特征"，覆盖集只含现有技术侧的映射，不含等同；侵权侧判"被诉方案是否落入保护
 * 范围"，覆盖集含等同。两者不共用覆盖集，也不互相调用。
 */

import { assertNever } from '@deepseek-ai/dsh-util-values'
import type {
  ClaimChart,
  ClaimElement,
  ClaimNoveltyCoverage,
  ClaimRefIssue,
  DependentClaimPathIssue,
  InvalidityConclusion,
} from '../protocol/types.ts'
import {
  deriveDistinguishingFeatures,
  deriveNoveltyCoverageByClaim,
  isElementCovered,
} from './mapping-machine.ts'
import { referenceAlternatives, referencedClosure, validateClaimRefs } from './claim-refs.ts'

/** 从属权项法条路径问题与确定性结论的契约见协议层。 */
export type {
  ClaimNoveltyCoverage,
  DependentClaimPathIssue,
  InvalidityConclusion,
} from '../protocol/types.ts'

/** `deriveInvalidityConclusion` 的可选输入。 */
export type InvalidityConclusionInput = {
  /** 主对比文件 id（区别特征基准）；缺省取第一个对比文件目标。 */
  primaryTargetId?: string
}

/**
 * 由图表算出无效／复审的确定性结论。
 *
 * 只计入 `kind: 'prior-art'` 的目标；被控产品目标（侵权侧）不参与判定。
 * @param chart - 无效或复审模式的 claim-chart。
 * @param input - 可选的主对比文件指定。
 * @returns 逐目标的单篇全覆盖判定、区别特征、从属权项法条路径问题与引用关系缺陷。
 */
export function deriveInvalidityConclusion(
  chart: ClaimChart,
  input: InvalidityConclusionInput = {},
): InvalidityConclusion {
  const targets = chart.targets.filter(target => target.kind === 'prior-art')
  const novelty = targets.map(target => ({
    targetId: target.id,
    ...(target.title !== undefined ? { title: target.title } : {}),
    claims: deriveNoveltyCoverageByClaim(chart.rows, target.id, chart.elements, chart.claims),
  }))

  const requested = input.primaryTargetId ?? chart.targets.find(target => target.kind === 'prior-art')?.id
  const primaryTargetId = targets.some(target => target.id === requested) ? requested : undefined
  // 区别特征与覆盖判定同口径：从属权项的技术方案含所引用权项的全部技术特征，故其区别特征
  // 也在同一要素并集上取补集（否则同一权项的新颖性结论与区别特征清单会互相矛盾）。
  const distinguishing = primaryTargetId === undefined
    ? []
    : [...new Set(chart.elements.map(element => element.claimNo))]
      .sort((a, b) => a - b)
      .map((claimNo) => {
        const paths = referenceAlternatives(chart.claims, claimNo)
        const alternatives = (paths.length === 0 ? [[claimNo]] : paths.map(path => [claimNo, ...path]))
          .map(scope => ({
            referredClaimNos: scope.filter(value => value !== claimNo).sort((a, b) => a - b),
            elementIds: deriveDistinguishingFeatures(
              chart.rows,
              primaryTargetId,
              chart.elements.filter(element => scope.includes(element.claimNo)),
            ),
          }))
        return {
          claimNo,
          elementIds: [...new Set(alternatives.flatMap(alternative => alternative.elementIds))],
          ...(paths.length > 1 ? { alternatives } : {}),
        }
      })

  return {
    ...(primaryTargetId !== undefined ? { primaryTargetId } : {}),
    novelty,
    distinguishing,
    dependentClaimIssues: collectDependentClaimIssues(chart, targets.map(target => target.id)),
    claimRefIssues: validateClaimRefs(chart.claims),
  }
}

/**
 * 逐目标检出从属权项的"仅附加特征被覆盖"形态。
 * @param chart - 图表。
 * @param priorArtTargetIds - 参与判定的对比文件目标 id。
 * @returns 检出的问题，按目标顺序、再从属权项号升序。
 */
function collectDependentClaimIssues(
  chart: ClaimChart,
  priorArtTargetIds: readonly string[],
): DependentClaimPathIssue[] {
  const issues: DependentClaimPathIssue[] = []
  for (const targetId of priorArtTargetIds) {
    for (const ref of chart.claims) {
      if (ref.refersTo.length === 0) continue
      const ownElements = elementsOf(chart, ref.claimNo)
      if (ownElements.length === 0 || !allCovered(chart, targetId, ownElements)) continue
      // 多项从属权项：任一替代路径（本权项 + 该路径的引用链）全覆盖，即已构成单篇覆盖，
      // 不得再按"仅附加特征被覆盖"提示。
      const coveredPath = referenceAlternatives(chart.claims, ref.claimNo).some(path =>
        allCovered(chart, targetId, chart.elements.filter(element =>
          element.claimNo === ref.claimNo || path.includes(element.claimNo))))
      if (coveredPath) continue
      for (const referredClaimNo of referencedClosure(chart.claims, ref.claimNo)) {
        const referredElements = elementsOf(chart, referredClaimNo)
        if (allCovered(chart, targetId, referredElements)) continue
        const missing = referredElements
          .filter(element => !isElementCovered(chart.rows, targetId, element.id))
          .map(element => element.id)
        issues.push({
          kind: 'additional-features-only',
          claimNo: ref.claimNo,
          referredClaimNo,
          targetId,
          detail:
            `权利要求 ${ref.claimNo} 自身要素在 ${targetId} 上已全部覆盖，而其引用的权利要求 ${referredClaimNo} `
            + `在 ${targetId} 上未被完整覆盖（缺 ${missing.join('、')}）；从属权利要求的技术方案包含所引用权利要求的全部技术特征，`
            + `不得仅以附加技术特征被 ${targetId} 公开为由认定权利要求 ${ref.claimNo} 不具备新颖性，`
            + '引用权利要求以 A22.3 主张时本权项应以 A22.3 承接。',
        })
      }
    }
  }
  return issues
}

/** 取一条权利要求的要素。 */
function elementsOf(chart: ClaimChart, claimNo: number): ClaimElement[] {
  return chart.elements.filter(element => element.claimNo === claimNo)
}

/** 该组要素是否已被指定的一篇全部公开。 */
function allCovered(chart: ClaimChart, targetId: string, elements: readonly ClaimElement[]): boolean {
  return elements.every(element => isElementCovered(chart.rows, targetId, element.id))
}

/** 区别特征列表的展示文本。 */
function distinguishingText(elementIds: readonly string[]): string {
  return elementIds.length === 0 ? '无区别特征（主对比文件已覆盖全部要素）' : elementIds.join('、')
}

/** 覆盖缺口的展示文本：没有要素的引用权项单独点名，不写成"缺"空列表。 */
function coverageGapText(claim: Pick<ClaimNoveltyCoverage, 'missing' | 'missingReferredClaims'>): string {
  const parts: string[] = []
  if (claim.missing.length > 0) parts.push(`缺 ${claim.missing.join('、')}`)
  if (claim.missingReferredClaims !== undefined) {
    parts.push(`所引权利要求 ${claim.missingReferredClaims.join('、')} 没有要素，不能并入`)
  }
  return parts.map(part => `，${part}`).join('')
}

/** 引用关系缺陷的中文说明。 */
const CLAIM_REF_ISSUE_LABELS: Record<ClaimRefIssue['kind'], string> = {
  'self-reference': '权利要求引用了自身',
  'missing-reference': '所引用的权利要求不存在',
  'later-reference': '所引用的权利要求编号不更小（从属权利要求只能引用在前的权利要求）',
  'reference-cycle': '引用关系成环',
  'reference-range': '引用区间的写法需要核对',
}

/** 渲染一条引用关系缺陷。 */
function claimRefIssueLine(issue: ClaimRefIssue): string {
  switch (issue.kind) {
    case 'self-reference':
      return `- 权利要求 ${issue.claimNo}：${CLAIM_REF_ISSUE_LABELS[issue.kind]}`
    case 'missing-reference':
      return `- 权利要求 ${issue.claimNo}：${CLAIM_REF_ISSUE_LABELS[issue.kind]}（${issue.refersTo.join('、')}）`
    case 'later-reference':
      return `- 权利要求 ${issue.claimNo}：${CLAIM_REF_ISSUE_LABELS[issue.kind]}（${issue.refersTo.join('、')}）`
    case 'reference-cycle':
      return `- ${CLAIM_REF_ISSUE_LABELS[issue.kind]}：${issue.claimNos.join(' → ')}`
    case 'reference-range':
      return `- 权利要求 ${issue.claimNo}：引用区间「${issue.raw}」${
        issue.problem === 'descending-range' ? '为倒序写法，已按升序展开' : '跨度超限，只保留端点'
      }`
    /* v8 ignore next -- closed union: all five kinds are handled above. */
    default:
      return assertNever(issue)
  }
}

/**
 * 渲染确定性结论为可读文本。
 *
 * 由原子阶段（作为下游收口阶段的提示词输入）与 `claim_chart_build` 工具（模型直接读）
 * 共用一处，避免两处各写一份措辞。
 * @param conclusion - 由图表算出的结论。
 * @param chart - 权项号与引用关系条数（表头用；完整图表也满足）。
 * @returns 多行报告文本。
 */
export function renderInvalidityConclusion(
  conclusion: InvalidityConclusion,
  chart: { claimNos: readonly number[]; claims: readonly unknown[] },
): string {
  const lines = ['## 单篇全覆盖与区别特征（程序按行级映射判定，未经模型判断）', '']
  lines.push(
    `主对比文件: ${conclusion.primaryTargetId ?? '（无对比文件目标）'}；参与判定的对比文件 ${conclusion.novelty.length} 篇；权利要求 ${chart.claimNos.join('、') || '（无）'}。`,
    '',
  )

  for (const entry of conclusion.novelty) {
    lines.push(`### ${entry.targetId}${entry.title !== undefined ? `（${entry.title}）` : ''}`)
    if (entry.claims.length === 0) {
      lines.push('- 无权利要求要素可判定（图表未拆分要素）', '')
      continue
    }
    for (const claim of entry.claims) {
      const scope = claim.alternatives !== undefined
        ? '（多项从属，逐替代方案见下）'
        : claim.missingReferredClaims !== undefined
          ? ''
          : claim.includesReferredClaims
            ? `（已并入所引用权利要求 ${claim.referredClaimNos.join('、')} 的全部要素）`
            : ''
      lines.push(
        claim.covered
          ? `- 权利要求 ${claim.claimNo}: 单篇全覆盖成立${scope}`
          : `- 权利要求 ${claim.claimNo}: 未全覆盖${scope}${coverageGapText(claim)}`,
      )
      for (const alternative of claim.alternatives ?? []) {
        lines.push(
          `  - 替代方案（引用 ${alternative.referredClaimNos.join('、')}）: `
          + (alternative.covered ? '单篇全覆盖成立' : `未全覆盖${coverageGapText(alternative)}`),
        )
      }
    }
    lines.push('')
  }

  lines.push('### 区别特征（相对主对比文件）')
  if (conclusion.distinguishing.length === 0) {
    lines.push('- 未计算（图表无对比文件目标）')
  } else {
    for (const entry of conclusion.distinguishing) {
      if (entry.alternatives !== undefined) {
        lines.push(`- 权利要求 ${entry.claimNo}: 各替代方案的区别特征见下`)
        for (const alternative of entry.alternatives) {
          lines.push(`  - 引用 ${alternative.referredClaimNos.join('、')}: ${distinguishingText(alternative.elementIds)}`)
        }
        continue
      }
      lines.push(`- 权利要求 ${entry.claimNo}: ${distinguishingText(entry.elementIds)}`)
    }
  }

  lines.push('', `### 从属权利要求法条路径问题（${conclusion.dependentClaimIssues.length} 条）`)
  if (conclusion.dependentClaimIssues.length === 0) {
    lines.push('- 未检出"仅附加特征被覆盖"形态')
  } else {
    lines.push(...conclusion.dependentClaimIssues.map(
      issue => `- 权利要求 ${issue.claimNo} → 权利要求 ${issue.referredClaimNo}（${issue.targetId}）：${issue.detail}`,
    ))
  }

  lines.push('', `### 引用关系缺陷（${conclusion.claimRefIssues.length} 条）`)
  if (conclusion.claimRefIssues.length === 0) {
    lines.push(chart.claims.length === 0
      ? '- 未计算（权利要求书无行首编号，引用关系未知，不得据此认定全部权项为独立权利要求）'
      : '- 未检出')
  } else {
    lines.push(...conclusion.claimRefIssues.map(claimRefIssueLine))
  }
  return lines.join('\n')
}
