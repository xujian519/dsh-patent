/**
 * `generate_patent_figure` 的落版：把渲染产物按目标法域的幅面、页边距与图号/页码写法
 * 落成固定幅面附图页，并汇总落版指标与合规核算警告。
 * @module @deepseek-ai/dsh-patent-tools/tool/figure-submission
 */

import { readFile, writeFile } from 'node:fs/promises'
import { PatentToolError } from '../error.ts'
import { drawingComplianceWarnings } from '../figure/compliance.ts'
import type { DotFormat } from '../figure/dot-builder.ts'
import { captionMatches, figureCaption, officeProfile, sheetNumberText } from '../figure/office-profile.ts'
import type { OfficeProfile, TargetOffice } from '../figure/office-profile.ts'
import { buildSubmissionPage, DEFAULT_CAPTION_FONT_MM, DEFAULT_CAPTION_GAP_MM, DEFAULT_SHEET_FONT_MM, SUBMISSION_ROTATIONS } from '../figure/submission-page.ts'
import type { SubmissionRotation } from '../figure/submission-page.ts'
import type { SubmissionPageMetrics } from '../figure/submission-page.ts'
import type { GeneratePatentFigureLayout } from './figure-input.ts'

/**
 * DOT 正文字号的历史默认（与 buildDotHeader 的 node fontsize 一致），用于落版后的字高核算。
 * 部署配置了图面字号（Config.figureFontMm）时以它为准——那时代入的正是 DOT 实际用的 pt 值。
 */
const FIGURE_BODY_FONT_SIZE = 10

/** 落版参数（target_office 给定时解析；字号与间距已填默认并校验为正）。 */
type SubmissionPlan = {
  profile: OfficeProfile
  caption?: string | undefined
  sheetNumber: string
  bodyFontSize: number
  fitToPage: boolean
  /** 图号字高（毫米）。 */
  captionFontMm: number
  /** 图号与图形之间的间距（毫米）。 */
  captionGapMm: number
  /** 页码字高（毫米）。 */
  sheetFontMm: number
  /** 图形绕绘图区中心顺时针旋转的角度。 */
  rotateDeg: SubmissionRotation
  /** 本幅是否为摘要附图。 */
  abstractFigure: boolean
}

/** 落版执行结果（指标 + 实际写上图面的图号与页码）。 */
type AppliedSubmission = {
  metrics: SubmissionPageMetrics
  caption?: string | undefined
  sheetNumber: string
}

/** 解析落版参数所需的输入字段（结构化输入在 exactOptionalPropertyTypes 下不能直接当作完整工具输入传入）。 */
export type SubmissionPlanInput = {
  target_office?: TargetOffice | undefined
  figure_number?: number | undefined
  figure_count?: number | undefined
  sheet_index?: number | undefined
  sheet_total?: number | undefined
  /** 是否编页码，默认 true。false 时页码计划值为空字符串，不调用页码写法，也不校验页序。 */
  sheet_number?: boolean | undefined
  caption?: string | undefined
  abstract_figure?: boolean | undefined
  fit_to_page?: boolean | undefined
  caption_font_mm?: number | undefined
  caption_gap_mm?: number | undefined
  sheet_font_mm?: number | undefined
  rotate_deg?: number | undefined
}

/**
 * 解析落版参数：图号按目标法域生成（panels 模式追加面板后缀），页码按法域写法生成。
 * `sheet_number: false` 时不调用页码写法，计划值为空字符串。图号/页码字号与间距填默认并校验为正。
 * @param input - 工具输入（或归一化后的结构化输入）。
 * @param suffix - 面板后缀（单图为空串）。
 * @param bodyFontSize - 图面字号（用户单位：DOT 图为 pt、直绘图型为毫米）；未给时用历史默认 10pt。
 * @returns 落版参数；未指定 target_office 时 undefined。
 * @throws PatentToolError('invalid_tool_input') 图号、附图总数或页序超出法域写法允许范围，或字号/间距非正时。
 */
export function resolveSubmission(
  input: SubmissionPlanInput,
  suffix: string,
  bodyFontSize?: number,
): SubmissionPlan | undefined {
  const office = input.target_office
  if (office === undefined) return undefined
  const profile = officeProfile(office)
  let caption: string | undefined
  let sheetNumber: string
  try {
    const figureNumber = input.figure_number ?? 1
    const figureCount = input.figure_count ?? 1
    if (input.caption !== undefined && input.caption !== '' && !captionMatches(profile, input.caption, figureNumber, figureCount)) {
      const expected = figureCaption(profile, figureNumber, figureCount)
      throw new Error(
        expected === undefined
          ? `该法域在附图不足两幅时不编号，不能自定义 caption「${input.caption}」`
          : `自定义 caption「${input.caption}」不符合该法域写法，应为「${expected}」`,
      )
    }
    const base = input.caption ?? figureCaption(profile, figureNumber, figureCount)
    caption = base === undefined || base === '' ? undefined : `${base}${suffix}`
    sheetNumber = input.sheet_number === false
      ? ''
      : sheetNumberText(profile, input.sheet_index ?? 1, input.sheet_total ?? 1)
  } catch (error) {
    throw new PatentToolError('invalid_tool_input', `落版参数非法：${error instanceof Error ? error.message : String(error)}`, { tool: 'generate_patent_figure' })
  }
  return {
    profile,
    caption,
    sheetNumber,
    bodyFontSize: bodyFontSize ?? FIGURE_BODY_FONT_SIZE,
    fitToPage: input.fit_to_page ?? true,
    captionFontMm: positiveMm(input.caption_font_mm, DEFAULT_CAPTION_FONT_MM, 'caption_font_mm'),
    captionGapMm: positiveMm(input.caption_gap_mm, DEFAULT_CAPTION_GAP_MM, 'caption_gap_mm'),
    sheetFontMm: positiveMm(input.sheet_font_mm, DEFAULT_SHEET_FONT_MM, 'sheet_font_mm'),
    rotateDeg: readRotation(input.rotate_deg),
    abstractFigure: input.abstract_figure === true,
  }
}

/**
 * 落版旋转角的边界校验：schema 的 enum 只约束模型 JSON，这里对全部调用方收口。
 * @param value - 模型传入的角度；undefined 表示不旋转。
 * @returns 闭集内的旋转角。
 * @throws PatentToolError('invalid_tool_input') 角度不在闭集内时。
 */
function readRotation(value: number | undefined): SubmissionRotation {
  if (value === undefined) return 0
  const match = SUBMISSION_ROTATIONS.find(rotation => rotation === value)
  if (match === undefined) {
    throw new PatentToolError('invalid_tool_input', `落版参数非法：rotate_deg 只支持 ${SUBMISSION_ROTATIONS.join('/')}（度），收到 ${String(value)}`, { tool: 'generate_patent_figure' })
  }
  return match
}

/**
 * 数值参数的落版校验：缺省取默认值，给了就必须是正的有限数。
 *
 * 校验放在解析步骤而不是落版函数里：`buildSubmissionPage` 抛的是裸 `RangeError`，
 * 到了工具层只会变成内部错误；这里转成 `invalid_tool_input`，模型才知道是自己传错了。
 * @param value - 模型传入的值；undefined 表示用默认值。
 * @param fallback - 缺省值。
 * @param field - 字段名（用于报错定位）。
 * @returns 校验通过的值。
 * @throws PatentToolError('invalid_tool_input') 值非正或非有限数时。
 */
function positiveMm(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0) {
    throw new PatentToolError('invalid_tool_input', `落版参数非法：${field} 必须是正的有限数（毫米），收到 ${String(value)}`, { tool: 'generate_patent_figure' })
  }
  return value
}

/**
 * 把渲染产物落版到目标法域的固定幅面附图页并写回原文件。
 * @param outcomePath - 渲染产物路径（原地改写）。
 * @param plan - 落版参数。
 * @param format - 输出格式（仅 svg 支持落版）。
 * @param warnings - 收集提示的警告数组。
 * @returns 落版指标与实际图号/页码；格式不支持落版时 undefined。
 */
export async function applySubmissionPage(
  outcomePath: string,
  plan: SubmissionPlan,
  format: DotFormat,
  warnings: string[],
): Promise<AppliedSubmission | undefined> {
  if (format !== 'svg') {
    warnings.push(`落版仅支持 SVG 输出；本次 ${format} 未落版到 ${plan.profile.office} 幅面——本机装好 Inkscape（Config.inkscapeExecutable 或 PATH）后，本工具会先出 SVG 再导出 ${format}；否则请改用 format="svg" 或自行拼版`)
    return undefined
  }
  const rendered = await readFile(outcomePath, 'utf8')
  const page = buildSubmissionPage({
    drawingSvg: rendered,
    profile: plan.profile,
    caption: plan.caption,
    sheetNumber: plan.sheetNumber,
    bodyFontSize: plan.bodyFontSize,
    captionFontMm: plan.captionFontMm,
    captionGapMm: plan.captionGapMm,
    sheetFontMm: plan.sheetFontMm,
    rotateDeg: plan.rotateDeg,
  })
  warnings.push(...page.warnings.map(w => `落版：${w}`))
  if (plan.fitToPage) await writeFile(outcomePath, page.svg, 'utf8')
  return { metrics: page.metrics, caption: plan.caption, sheetNumber: plan.sheetNumber }
}

/**
 * 组装落版输出并追加合规核算警告（单图与 panels 共用）。
 * @param plan - 落版参数。
 * @param applied - 落版执行结果。
 * @param style - 本次色彩策略。
 * @param figureCount - 本案附图总数。
 * @param warnings - 收集提示的警告数组。
 * @returns 工具输出的 layout 字段。
 */
export function buildLayout(
  plan: SubmissionPlan,
  applied: AppliedSubmission,
  style: 'grayscale' | 'semantic',
  figureCount: number,
  warnings: string[],
): GeneratePatentFigureLayout {
  const { metrics } = applied
  warnings.push(...drawingComplianceWarnings({
    profile: plan.profile,
    style,
    figureCount,
    hasCaption: applied.caption !== undefined,
    abstractFigure: plan.abstractFigure,
    metrics,
  }))
  return {
    office: plan.profile.office,
    pageScale: metrics.pageScale,
    placedWidthMm: metrics.placedWidthMm,
    placedHeightMm: metrics.placedHeightMm,
    ...(metrics.charHeightMm === undefined ? {} : { charHeightMm: metrics.charHeightMm }),
    ...(metrics.reducedCharHeightMm === undefined ? {} : { reducedCharHeightMm: metrics.reducedCharHeightMm }),
    ...(applied.caption === undefined ? {} : { caption: applied.caption }),
    sheetNumber: applied.sheetNumber,
  }
}
