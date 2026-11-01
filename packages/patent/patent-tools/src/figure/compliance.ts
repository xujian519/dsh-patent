/**
 * 附图合规核算（纯函数）：按目标法域规格核对落版后的物理尺寸、色彩策略与
 * 图号标注，产出面向模型/用户的中文警告。
 *
 * 只核算工具自己产出的量（落版尺寸、字高、图号有无、色彩模式），不评价图面
 * 内容是否清楚——那是审查员的判断。依据条文：
 * - 中国：《专利审查指南》第一部分第一章 4.3（附图总数在两幅以上的应当编号并
 *   标注在相应附图的正下方；附图一般使用黑色墨水绘制，必要时可以提交彩色附图）、
 *   第一部分第二章 7.3(5)（缩小到三分之二仍能清晰分辨细节）。
 * - PCT：Rule 11.13(a)（不得着色）、11.13(c)（线性缩小到三分之二仍可辨）、
 *   11.13(h)（数字与字母高度不小于 0.32 厘米）、11.13(k)（图序编号）。
 * - USPTO：37 CFR 1.84(a)(2)（实用申请彩色附图须经呈请）、1.84(k)（缩小到
 *   三分之二复制仍不拥挤）、1.84(p)(3)（数字、字母与标记高度不小于 0.32 厘米）、
 *   1.84(u)（视图号须冠 "FIG."）。
 * @module @deepseek-ai/dsh-patent-tools/figure/compliance
 */

import type { OfficeProfile } from './office-profile.ts'
import type { SubmissionPageMetrics } from './submission-page.ts'

/** 核算输入。 */
type DrawingComplianceInput = {
  /** 目标法域规格。 */
  profile: OfficeProfile
  /** 本次生成使用的色彩策略。 */
  style: 'grayscale' | 'semantic'
  /** 本案附图总数（≥1）。 */
  figureCount: number
  /** 本次落版是否已标注图号。 */
  hasCaption: boolean
  /** 本幅是否为请求书指定的摘要附图。 */
  abstractFigure?: boolean
  /** 落版尺寸。 */
  metrics: SubmissionPageMetrics
}

/** 毫米数值的可读文本（两位小数，去掉尾随零）。 */
function mm(value: number): string {
  return `${String(Math.round(value * 100) / 100)} 毫米`
}

/**
 * 生成合规核算警告。
 * @param input - 法域规格、色彩策略、附图总数与落版尺寸。
 * @returns 警告文本列表；全部满足时为空数组。
 */
export function drawingComplianceWarnings(input: DrawingComplianceInput): string[] {
  const { profile, style, figureCount, hasCaption, metrics } = input
  const warnings: string[] = []

  if (style === 'semantic') {
    if (profile.color === 'monochrome') {
      warnings.push(
        profile.office === 'pct'
          ? 'PCT 附图不得着色（PCT 实施细则 11.13(a)）：semantic 彩色图不能用于国际申请，请改用 grayscale'
          : '美国实用申请提交彩色附图须先呈请并经准（37 CFR 1.84(a)(2)）：semantic 彩色图仅在外观设计或已获准时可用，请改用 grayscale',
      )
    } else {
      warnings.push(
        '《专利审查指南》第一部分第一章 4.3 规定附图一般使用黑色墨水绘制、必要时才可以提交彩色附图：彩色仅当色彩本身承载技术内容时使用，请确认必要性',
      )
    }
  }

  if (!hasCaption && figureCount >= 2) {
    const basis = profile.office === 'cnipa'
      ? '《专利审查指南》第一部分第一章 4.3'
      : profile.office === 'pct'
        ? 'PCT 实施细则 11.13(k) 与申请人指南 IP 5.141'
        : '37 CFR 1.84(u)'
    warnings.push(`本案附图共 ${figureCount} 幅，本幅未标注图号：${basis} 要求逐幅编号，请开启图号入图或自行排版补标`)
  }

  const minCharHeightMm = profile.minCharHeightMm
  if (minCharHeightMm !== undefined && metrics.charHeightMm !== undefined && metrics.charHeightMm < minCharHeightMm) {
    warnings.push(
      `落版后图中数字与字母字高约 ${mm(metrics.charHeightMm)}，低于该法域要求的 ${mm(minCharHeightMm)}（${profile.office === 'pct' ? 'PCT 实施细则 11.13(h)' : '37 CFR 1.84(p)(3)'}）：请减少图面元件或缩小图幅后重排`,
    )
  }

  // 摘要附图另有 40×60 毫米的缩放可辨要求（《专利审查指南》第二部分第二章 2.4）。
  // 只报告缩放后的字高，不宣称「清晰」——清晰与否仍由人工判断。
  if (input.abstractFigure === true && metrics.charHeightMm !== undefined
    && metrics.placedWidthMm > 0 && metrics.placedHeightMm > 0) {
    const scale = Math.min(40 / metrics.placedWidthMm, 60 / metrics.placedHeightMm)
    const scaled = metrics.charHeightMm * scale
    warnings.push(
      `摘要附图缩小到 40×60 毫米时图中数字与字母字高约 ${mm(scaled)}：请人工确认各细节仍可分辨（《专利审查指南》第二部分第二章 2.4）；本工具不判定“清晰”`,
    )
  }

  return warnings
}
