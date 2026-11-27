/**
 * 权利要求技术特征 → 图面元素覆盖：把「特征 → 附图标记」的指认与图面识别到的
 * 标号清单做确定性核对。
 *
 * 输入是模型给出的两列事实（特征文本、该特征在图面上的标号），覆盖结论由本模块
 * **计算**得出；不读模型的自评。这补的是标号级检查够不到的一层：现有
 * `checkFigureMarkConsistency` 回答「这个标号在不在图/说明书里」，
 * `checkFigureSetConsistency` 回答「同一标号跨图是否同名」，都不回答
 * 「权利要求里的某个技术特征能不能在图面指认到元素」。
 *
 * 边界：本模块只保证指认的标号真实存在于某张附图中，不判断「该标号是否真的体现
 * 了该特征」——那需要语义判断，不是确定性检查能给出的结论。特征拆分同样由调用方
 * 给出，本模块不做 NLP 抽取。
 * @module @deepseek-ai/dsh-patent-tools/figure/claim-figure-coverage
 */

/** 一条权项特征的图面指认。 */
export type ClaimFeatureBinding = {
  /** 权利要求标识（如 `claim_1`）。 */
  claimId: string
  /** 技术特征原文。 */
  feature: string
  /** 该特征在图面上对应的附图标记号；至少一个才构成指认。 */
  refNumbers: readonly string[]
}

/** 一张图面的标号清单；与 `figure-set-consistency` 的 `FigureSetEntry` 同形。 */
export type FigureMarkEntry = {
  /** 图号（1 起）。 */
  figureNumber: number
  /** 该图识别出的标号与名称。 */
  components: readonly { refNumber: string; name: string }[]
}

/** 一条覆盖发现。 */
export type ClaimFigureCoverageFinding = {
  /** 发现类型。 */
  check: 'feature-empty' | 'feature-unbound' | 'ref-not-on-figure'
  /** 所属权利要求标识。 */
  claimId: string
  /** 该特征原文（特征为空时为空串）。 */
  feature: string
  /** 涉及的附图标记；未指定标号且特征为空时不带。 */
  ref?: string
  /** 人类可读说明。 */
  message: string
}

/** 覆盖报告。 */
export type ClaimFigureCoverageReport = {
  /** 已在图面完整指认的特征数。 */
  boundFeatureCount: number
  /** 未在图面完整指认的特征数。 */
  unboundFeatureCount: number
  /** 逐条发现，按输入顺序。 */
  findings: ClaimFigureCoverageFinding[]
  /** 文本摘要。 */
  summary: string
  /** 无任何发现。 */
  covered: boolean
}

/**
 * 核对权项特征在图面的覆盖。
 *
 * 标号按原样比较（含 `U1` 这类结构图无标号部件的占位标号）：与
 * `spec-figure-marks` 只认纯数字不同，这里不限定标号形态，因为结构线稿的无标号
 * 部件由 `analyze_patent_figure` 以 `U1/U2…` 表示。
 * @param bindings - 特征到标号的指认清单。
 * @param figures - 各图的标号清单。
 * @returns 覆盖报告；每个特征至少有一个标号且全部标号都在图面时计入已指认。
 */
export function checkClaimFigureCoverage(
  bindings: readonly ClaimFeatureBinding[],
  figures: readonly FigureMarkEntry[],
): ClaimFigureCoverageReport {
  const knownRefs = new Set<string>()
  for (const figure of figures) {
    for (const component of figure.components) {
      const ref = component.refNumber.trim()
      if (ref !== '') knownRefs.add(ref)
    }
  }

  const findings: ClaimFigureCoverageFinding[] = []
  let boundFeatureCount = 0

  for (const binding of bindings) {
    const feature = binding.feature.trim()
    if (feature === '') {
      findings.push({
        check: 'feature-empty',
        claimId: binding.claimId,
        feature: '',
        message: `${binding.claimId} 有一条技术特征为空，无法核对图面覆盖`,
      })
      continue
    }

    const refs = binding.refNumbers.map(ref => ref.trim()).filter(ref => ref !== '')
    if (refs.length === 0) {
      findings.push({
        check: 'feature-unbound',
        claimId: binding.claimId,
        feature,
        message: `${binding.claimId} 的技术特征「${feature}」未指定任何附图标记`,
      })
      continue
    }

    const missing = refs.filter(ref => !knownRefs.has(ref))
    for (const ref of missing) {
      findings.push({
        check: 'ref-not-on-figure',
        claimId: binding.claimId,
        feature,
        ref,
        message: `${binding.claimId} 的技术特征「${feature}」指向标号 ${ref}，但该标号不在任何附图中`,
      })
    }
    if (missing.length === 0) boundFeatureCount += 1
  }

  return {
    boundFeatureCount,
    unboundFeatureCount: bindings.length - boundFeatureCount,
    findings,
    summary: buildSummary(bindings.length, findings),
    covered: findings.length === 0,
  }
}

/** 摘要：只报出发生过的事，通过时明说通过。 */
function buildSummary(
  total: number,
  findings: readonly ClaimFigureCoverageFinding[],
): string {
  const parts = [`共 ${String(total)} 条权利要求技术特征。`]
  const empty = findings.filter(finding => finding.check === 'feature-empty').length
  const unbound = findings.filter(finding => finding.check === 'feature-unbound').length
  const missing = findings.filter(finding => finding.check === 'ref-not-on-figure').length
  if (empty > 0) parts.push(`特征文本为空 ${String(empty)} 条。`)
  if (unbound > 0) parts.push(`未指定附图标记 ${String(unbound)} 条。`)
  if (missing > 0) parts.push(`指向的标号不在图面 ${String(missing)} 处。`)
  if (findings.length === 0) parts.push('权项要素图面覆盖检查通过。')
  return parts.join('')
}
