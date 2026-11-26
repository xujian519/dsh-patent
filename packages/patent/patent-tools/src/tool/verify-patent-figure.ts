/**
 * `verify_patent_figure` tool: 在既有 SVG 上量测图面事实，报告只在渲染结果上才看得见
 * 的问题。
 *
 * 与输入侧检查（`generate_patent_figure` 的 warnings）互补：输入检查看的是「调用方
 * 声明了什么」，本工具看的是「画出来是什么样」——图面文字（标号、元件名、连线说明）
 * 是否被线条贯穿、文字与图线净距是否够、点划线是否被实线覆盖、相邻零件剖面线是否
 * 可区分、内容是否越出画布。量测在矢量源上进行（见 `figure/render-check`），不依赖
 * 系统栅格化器。
 *
 * 用途：对已交付或由外部工具生成的 SVG 附图做交付前自检，等价于人工「看一眼图」，
 * 但给出可复核的量测值。
 * @module @deepseek-ai/dsh-patent-tools/tool/verify-patent-figure
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { PatentToolError } from '../error.ts'
import { checkFigureDelivery } from '../figure/delivery-review.ts'
import { checkFigureHierarchy } from '../figure/hierarchy-check.ts'
import type { FigureHierarchyEdge } from '../figure/hierarchy-check.ts'
import { checkFigureRendering } from '../figure/render-check.ts'
import type { RenderCheckReport } from '../figure/render-check.ts'
import { SvgAnnotateError } from '../figure/svg-annotate.ts'
import { FINDING_FIELDS } from './internal/analysis-schemas.ts'
import { SVG_PATH_PARAM, SVG_PATH_RESULT_FIELDS, readSvgInput } from './internal/svg-input.ts'

/** 依赖注入。cwd 为路径基准，默认 process.cwd()。 */
export type VerifyPatentFigureDeps = {
  cwd?: string
  /**
   * 部署内控的字高下限（毫米，Config.figureMinFontMm）；模型未传 `min_font_mm` 时按它判定。
   * 缺省不判该判据。
   */
  minFontMm?: number
}

/** 输入：待复核的 SVG 路径与标号净距。 */
export type VerifyPatentFigureInput = {
  /** SVG 图片路径（工作区相对或绝对路径）。 */
  svg_path: string
  /** 标号净距（毫米）；缺省 1.5，`0` 关闭该判据。 */
  text_clearance_mm?: number
  /**
   * 字高下限（毫米），本部署的内控口径：法条只要求「缩小到三分之二仍能清晰地分辨」，
   * 下限由部署给出。缺省不判该判据；某处文字字高低于它即报出。
   */
  min_font_mm?: number
  /** 出图时声明的图内构造层级（父标记 → 直接子标记）；给出时才判「图内层级 ↔ 权项」。 */
  hierarchy?: FigureHierarchyEdge[]
  /** 权利要求书正文；与 `hierarchy` 同时给出时才判构造层级一致性。 */
  claims?: string
  /** 交付前复核：加查图面词语、位图/照片、整幅框线与横向方向。 */
  delivery_review?: boolean
}

/** 输出：量测值 + 发现问题（与 `figure/render-check` 的报告同形）。 */
export type VerifyPatentFigureOutput = {
  /** 复核的图片路径（工作区相对）。 */
  path: string
  /** 绝对路径（被复核文件可能不在工作区内）。 */
  absolutePath: string
  /** 画布宽（毫米）；根元素未声明时为缺省。 */
  widthMm?: number
  /** 画布高（毫米）；根元素未声明时为缺省。 */
  heightMm?: number
  /** 文字元素数。 */
  textCount: number
  /** 最小字高（毫米）；无文字时缺省。 */
  minFontMm?: number
  /** 线宽分布（毫米 → 元素数）。 */
  strokeWidthMm: { widthMm: number; count: number }[]
  /** 线段取向分布（0–180°，按线段数降序）。 */
  orientationDeg: { orientationDeg: number; count: number }[]
  /** 发现的问题（无问题为空数组）。 */
  findings: { check: string; message: string }[]
}

const DESCRIPTION = [
  '复核已生成的 SVG 说明书附图：量测线宽、线段取向、文字元素，并报告只在渲染结果上才看得见的问题——图面文字（标号、元件名、连线说明）被线条贯穿、文字与图线净距不足、中心线（点划线）被同位置的实线覆盖、两个图元叠压（闭合轮廓包围盒部分相交）、相邻零件剖面线难以区分（方向与间距都分不清）、内容越出画布。',
  '',
  '量测在矢量源上进行（线段位置、线宽与字号即渲染输入），不需要栅格化器：根元素的画布尺寸、viewBox 与 preserveAspectRatio 先解析成用户单位到毫米的映射，元素按嵌套逐层继承变换（translate/scale/rotate/matrix）与线宽、描边、字号（含自 `<g>` 继承的 text-anchor 与行内 style），故落版页、拼版页与 px 级用户单位的导出文件同一口径量测。不在量测范围内的结构（CSS 类样式、`<use>`/`<image>`、嵌套 `<svg>` 内层视口、marker 端头、`<tspan>` 位移、dominant-baseline、百分比长度、无法解析的变换/路径/viewBox、按端点弦近似的曲线段）各出一条「未量测」发现：没有它时才等于逐类量测过。',
  '',
  '净距判据（text_clearance_mm，默认 1.5 毫米）来自实测：剖切面上密布剖面线时，标号或零件名贴住剖面线带、轴线便读不出。判据把文字外框外扩该净距后与图元线段求交——绘图侧标注为引线（data-dsh-role="leader"）的线段、以及落在更晚绘制的不透明白填充之下的线段不参与（前者本来就止于文字外框，后者图面上看不见）。电路图、曲线图这类「文字贴着符号放」的图型按本判据会大量播报，复核它们时传 text_clearance_mm: 0 关闭。',
  '',
  '叠压判据（图元×图元）取闭合轮廓的包围盒：相交区两轴都超过 0.2 毫米且任一方的包围盒不严格包含另一方才算叠压——只擦边接触（共边）与有意嵌套（型腔内画零件、模块内画子模块）不报；绘图侧标注同一材料分组（data-dsh-hatch-group 同号）的轮廓是同一零件的几段，不互相判叠压。',
  '',
  '构造层级判据只在同时给出 hierarchy（出图时声明的父标记 → 直接子标记）与 claims（权利要求书正文）时生效：权利要求写出的归属（如「恒电位控制单元31的输入端311」）必须与声明的层级一致，否则报出矛盾。两端标记都必须是声明过的节点，权利要求序号与图号因此不参与。',
  '',
  '与 generate_patent_figure 的返回值配合使用：生成后按本工具复核，把 findings 当作必须处理的图面缺陷。',
  '',
  'delivery_review=true 时加查交付前四项：图面词语（非必需注释、非中文、标号带括号）、`<image>` 位图/照片、覆盖整幅图纸的边框、横向摆放。四项只看 SVG 文本，不判图面内容是否清楚。',
  '',
  'analyze_patent_figure 的结果不是 SVG，不能代替本工具。',
].join('\n')

/**
 * Build the `verify_patent_figure` tool.
 * @param deps - optional cwd.
 * @returns a registry-ready tool definition.
 */
export function createVerifyPatentFigureTool(deps: VerifyPatentFigureDeps = {}): ToolDefinition {
  return defineTool({
    name: 'verify_patent_figure',
    description: DESCRIPTION,
    parameters: {
      svg_path: SVG_PATH_PARAM,
      text_clearance_mm: {
        type: 'number',
        description: '标号净距（毫米），默认 1.5，0 表示不判该判据；文字外框外扩这么多后与图元线段相交即报',
      },
      min_font_mm: {
        type: 'number',
        description: '字高下限（毫米），本部署的内控口径（法条只要求缩小到三分之二仍能分辨）：给出时，字高低于它的文字逐处报出；不给则不判',
      },
      hierarchy: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: { parent: { type: 'string', required: true }, child: { type: 'string', required: true } },
        },
        description: '出图时声明的图内构造层级（父标记 → 直接子标记），与 claims 同时给出时判「图内层级 ↔ 权项构造层级」是否一致',
      },
      claims: {
        type: 'string',
        description: '权利要求书正文：与 hierarchy 同时给出时，核对其中的归属表述（如「控制单元31的输入端311」）与声明的图内层级是否一致',
      },
      delivery_review: {
        type: 'boolean',
        description: '交付前复核（默认 false）：加查图面词语、位图/照片、整幅框线与横向方向',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...SVG_PATH_RESULT_FIELDS,
          widthMm: { type: 'number' },
          heightMm: { type: 'number' },
          textCount: { type: 'integer', required: true },
          minFontMm: { type: 'number' },
          strokeWidthMm: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { widthMm: { type: 'number', required: true }, count: { type: 'integer', required: true } },
            },
          },
          orientationDeg: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { orientationDeg: { type: 'number', required: true }, count: { type: 'integer', required: true } },
            },
          },
          findings: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: FINDING_FIELDS,
            },
          },
        },
      },
      render: (_args, value) => {
        const canvas = value.widthMm === undefined || value.heightMm === undefined
          ? '根元素未声明画布尺寸'
          : `${String(value.widthMm)}×${String(value.heightMm)} 毫米`
        const lines = [
          `附图渲染复核：${value.path}`,
          `绝对路径：${value.absolutePath}`,
          '',
          '## 量测',
          `- 画布 ${canvas}`,
          `- 文字元素 ${String(value.textCount)} 个${value.minFontMm === undefined ? '' : `（最小字高 ${String(value.minFontMm)} 毫米）`}`,
          `- 线宽分布：${value.strokeWidthMm.map(entry => `${String(entry.widthMm)}mm×${String(entry.count)}`).join('、') || '无'}`,
          `- 线段取向（按线段数）：${value.orientationDeg.slice(0, 8).map(entry => `${String(entry.orientationDeg)}°×${String(entry.count)}`).join('、') || '无'}`,
          '',
          ...(value.findings.length === 0
            ? ['## 发现的问题', '- 未发现问题']
            : ['## 发现的问题', ...value.findings.map(finding => `- [${finding.check}] ${finding.message}`)]),
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args) {
      const cwd = deps.cwd ?? process.cwd()
      const clearanceMm = args.text_clearance_mm
      // 模型未给下限时取部署内控值（Config.figureMinFontMm）：本所的字高下限只需配一次。
      const minFontMm = args.min_font_mm ?? deps.minFontMm
      if (minFontMm !== undefined && minFontMm <= 0) {
        throw new PatentToolError(
          'invalid_tool_input',
          `min_font_mm 必须是正数（毫米）：${String(minFontMm)}`,
          { tool: 'verify_patent_figure' },
        )
      }
      if (clearanceMm !== undefined && clearanceMm < 0) {
        throw new PatentToolError(
          'invalid_tool_input',
          `text_clearance_mm 必须是非负数（毫米），0 表示不判该判据：${String(clearanceMm)}`,
          { tool: 'verify_patent_figure' },
        )
      }
      const { absolutePath: absPath, path, svg } = await readSvgInput(args.svg_path, cwd, 'verify_patent_figure')
      let report: RenderCheckReport
      try {
        report = checkFigureRendering(svg, {
          ...(clearanceMm === undefined ? {} : { textClearanceMm: clearanceMm }),
          ...(minFontMm === undefined ? {} : { minFontMm }),
        })
      } catch (error) {
        /* v8 ignore next -- checkFigureRendering only throws SvgAnnotateError; the else arm is invariant drift */
        if (error instanceof SvgAnnotateError) {
          throw new PatentToolError('invalid_tool_input', `SVG 复核被拒：${error.message}`, { tool: 'verify_patent_figure' })
        }
        /* v8 ignore next -- checkFigureRendering 只抛 SvgAnnotateError；其余异常原样上抛 */
        throw error
      }
      // 构造层级判据要两侧同时给出：只有层级没有权利要求正文、或只有正文没有层级，
      // 都判不出「声明与表述是否一致」。
      const hierarchyFindings = args.hierarchy !== undefined && args.claims !== undefined
        ? checkFigureHierarchy(args.hierarchy, args.claims)
        : []
      const deliveryFindings = args.delivery_review === true ? checkFigureDelivery(svg) : []
      return {
        path,
        absolutePath: absPath,
        ...(report.widthMm === undefined ? {} : { widthMm: report.widthMm }),
        ...(report.heightMm === undefined ? {} : { heightMm: report.heightMm }),
        textCount: report.textCount,
        ...(report.minFontMm === undefined ? {} : { minFontMm: report.minFontMm }),
        strokeWidthMm: report.strokeWidthMm.map(entry => ({ ...entry })),
        orientationDeg: report.orientationDeg.map(entry => ({ ...entry })),
        findings: [...report.findings, ...hierarchyFindings, ...deliveryFindings]
          .map(finding => ({ check: finding.check, message: finding.message })),
      }
    },
  })
}
