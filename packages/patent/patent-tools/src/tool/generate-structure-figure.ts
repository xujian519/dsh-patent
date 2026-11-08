/**
 * `generate_structure_figure` tool: 用本机 FreeCAD 把 3D 模型投影为结构线稿附图。
 *
 * 与 `generate_patent_figure`（Graphviz 示意图）平行的独立工具：输入
 * STEP/IGES/BREP 模型（或其目录批量），经 freecad-renderer 子进程调用
 * FreeCAD TechDraw 投影出多视图黑白线稿 SVG（无边框/标题栏/图号，件号以引线
 * 锚定到真实顶点投影），返回标号映射表与「图N是…的结构示意图」附图说明，并按
 * persist_index 写入既有附图索引（figureIndexStore，figureType='structure'），
 * 使生成图可被 search_patent_figure 检索、被 analyze_patent_figure 回读核验。
 *
 * CAD 隔离、默认关闭、fail-loud：结构线稿依赖本机 FreeCAD，默认
 * `Config.structureFigureEnabled=false`，未开启或 freecadcmd 缺失均返回
 * setup_required 与配置/安装引导，绝不静默降级为示意图。风格依据《专利审查
 * 指南》第一部分第一章 4.3：黑色墨水线条、阿拉伯数字标记、图号不落在几何片段内
 * （片段本身不含图号；附图总数在两幅以上时由 target_office 落版阶段把「图N」写在
 * 图形正下方，符合该条「该编号应当标注在相应附图的正下方」）。
 * @module @deepseek-ai/dsh-patent-tools/tool/generate-structure-figure
 */


import { resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { PatentToolError } from '../error.ts'
import { FIGURE_TYPE_NAMES } from './analyze-patent-figure.ts'
import type { FigureAnalysisResult, FigureComponent } from './analyze-patent-figure.ts'
import { clearanceMmForFigure } from '../figure/render-check.ts'
import { gateRenderedSvg } from '../figure/render-check-gate.ts'
import { figureWordingWarnings } from '../figure/wording-rules.ts'
import { STRUCTURE_VIEWS } from '../figure/freecad-structure-script.ts'
import { STRUCTURE_LINE_WIDTH_SERIES } from '../figure/structure-svg-postprocess.ts'
import { TARGET_OFFICES } from '../figure/office-profile.ts'
import { COMPONENT_SCHEMA, NUMERAL_MAP_SCHEMA } from './internal/figure-schemas.ts'
import { upsertFigureIndex } from './figure-output.ts'
import { WARNINGS_SCHEMA, warningSection } from './internal/tool-output.ts'
import { STRUCTURE_FIGURE_MODEL_USED } from './structure-types.ts'
export { STRUCTURE_FIGURE_MODEL_USED } from './structure-types.ts'
export type {
  GenerateStructureFigureDeps,
  GenerateStructureFigureInput,
  GenerateStructureFigureOutput,
  StructureCalloutInput,
  StructureFigureView,
  StructureManifest,
  StructureManifestAnchor,
  StructureManifestView,
} from './structure-types.ts'
import type { GenerateStructureFigureDeps, GenerateStructureFigureOutput, StructureFigureView } from './structure-types.ts'
import {
  applyStructureLayout,
  applyViewLineStyles,
  describeStructureFigures,
  outlineStructureViews,
  renderStructureFigures,
  resolveStructureRun,
  structureAssembly,
  structureComponents,
  structureNumeralMap,
} from './structure-render.ts'

const CALLOUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    numeral: { type: 'string', required: true, description: '参考标号（阿拉伯数字字符串）' },
    point3d: {
      type: 'array',
      description: '锚定的模型 3D 坐标 [x,y,z]（毫米，与模型单位一致）；省略时脚本在该零件的真实顶点里自动选一个（投影后离零件轮廓中心最远者）',
      items: { type: 'number' },
    },
    label: { type: 'string', description: '可选部件名称（写入标号表/manifest，不进图面像素）' },
    model: { type: 'integer', description: '该件号所属零件在输入模型列表中的下标（0 起）；给定时核对锚点确实落在该零件上（偏离超过 0.5 毫米即报错）。装配体（model_paths）下必填' },
  },
} as const

const DETAIL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    base: { type: 'string', required: true, enum: STRUCTURE_VIEWS, description: '窗口所在的基视图，必须是本次 views 里的视图' },
    center: {
      type: 'array',
      required: true,
      description: '窗口圆心的模型 3D 坐标 [x,y,z]（毫米，与模型单位一致）',
      items: { type: 'number' },
    },
    radius_mm: { type: 'number', required: true, description: '窗口半径（模型毫米），必须为正' },
    scale: { type: 'number', description: '放大倍数（正数），缺省 2' },
    reference: { type: 'string', description: '窗口标号（如「Ⅰ」），缺省该细节的序号' },
  },
} as const

/**
 * 装配体几何事实的输出 schema。
 *
 * `viewBounds` 是「视图名 → 每零件投影占位」的映射，键随 `views` 变化，故以
 * `additionalProperties: true` 放行而不再逐键约束。
 */
const ASSEMBLY_SCHEMA = {
  type: 'object',
  description: '几何事实：每零件 3D 包围盒与体积、各视图下的投影占位；用于判断零件归属与标号位置，不必再手填 callouts[].point3d。只在本次调用只出一张图时给出（目录批量多图时没有）',
  additionalProperties: false,
  properties: {
    modelPaths: { type: 'array', required: true, items: { type: 'string' } },
    parts: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'integer', required: true },
          path: { type: 'string', required: true },
          bbox3d: { type: 'array', required: true, items: { type: 'number' } },
          volume: { type: 'number', required: true },
        },
      },
    },
    viewBounds: { type: 'object', required: true, additionalProperties: true },
  },
} as const

const DESCRIPTION = [
  '从 3D 模型生成专利结构线稿附图：用本机 FreeCAD（TechDraw）把 STEP/IGES/BREP 投影为多视图黑白线稿 SVG（等轴测/三视图等），件号以引线锚定到真实顶点投影，输出到工作区 patent/figures/，返回标号映射表与「图N是…的结构示意图」附图说明。需要机械结构真实投影（而非示意框图）时使用。',
  '',
  '默认关闭：结构线稿依赖本机 FreeCAD，需先设 Config.structureFigureEnabled=true；未开启或未安装 freecadcmd 时返回 setup_required 与配置/安装引导。',
  '',
  '视图：views 缺省 iso/front/top/right，可选 iso/front/rear/top/bottom/left/right；scale 为 TechDraw 投影比例；show_hidden 开启时绘制隐藏线（细实线，FreeCAD 1.1.3 实测隐藏线 0.35 毫米、可见线 0.7 毫米，输出不含 stroke-dasharray，不是虚线）。',
  '',
  '线宽与线型：line_width_mm 取 GB/T 4457.4 线宽系列之一改写可见线线宽，hidden_line_style="dashed" 把隐藏线画成虚线；缺省两者都不改写，输出与 FreeCAD 原始投影一致。',
  '',
  '件号锚定：callouts 传 [{numeral, point3d:[x,y,z], label?, model?}]，把参考标号绑定到模型 3D 坐标，脚本投影到每个视图的真实 2D 位置并以引线标注；标号应为阿拉伯数字，非数字标号与部件名会触发图面用语告警。省略 point3d 时由脚本自动选点——在该零件的真实顶点里取投影后离零件轮廓中心最远的一个，标号因此落在实体外侧；此时须给出 model（单模型可省，默认零件 0），同一零件上的多个自动件号会轮流选不同顶点。',
  '',
  '装配体：model_paths 传多个模型文件时，所有零件投影到同一张图（TechDraw 一次投影处理零件之间的遮挡），callouts[].model 指明该件号属于第几个零件（0 起，对应 model_paths 的顺序），脚本按该零件的真实几何核对锚点确实落在它上面，偏离超过 0.5 毫米即报错；装配体下每个件号都必须写明归属，以免标号指错零件。',
  '',
  '几何事实：结果附带 assembly——每零件在 model_paths 中的下标与路径、3D 包围盒 [x,y,z,xLength,yLength,zLength] 与体积，以及各视图下该零件的投影占位 [x,y,width,height]（画布帧，与该视图件号落点同帧；该朝向看不见的零件为 null）。用它判断「哪个零件叫什么、该标几号」，并按占位避开标号压到别的零件。目录批量（一个 model_path 出多图）不给出 assembly：摘要只描述其中一张，会给错印象。',
  '',
  '分解图：exploded=true 时沿装配轴（各零件包围盒中心的第一主成分方向）把零件拉开成一维串，每个零件单独投影——零件之间互不遮挡，装配顺序一目了然；这是总装图「全部零件一次消隐」之外的另一条路径。需要 model_paths 传至少两个零件。位置按各零件自身沿轴尺寸加「中位尺寸 × 1.2」的间隙逐段累加。视线与装配轴近乎平行时主轴在投影面上退化成点、零件排不开，工具报错而不是画一张叠在一起的图；此时换一个垂直于轴的视图（轴为 z 时用 front/top）。',
  '',
  '局部放大：details 传 [{base, center:[x,y,z], radius_mm, scale?, reference?}]，把 base 视图上以模型坐标 center 为圆心、radius_mm 为半径的圆形区域按 scale（缺省 2）放大成一张独立视图（fig{N}_detail{M}.svg），并在 base 视图上画出该窗口的圆与标号。窗口按模型坐标给出，故与视图朝向、投影比例无关；base 必须是本次 views 里的视图，放大视图随 paths/manifest 一并返回（manifest 里该视图带 kind="detail" 与 base/center3d/radiusMm/scale/reference）。',
  '',
  '批量：model_path 传目录时，对目录内每个受支持模型各出一图，图号自 figure_number 起递增；批量模式不支持 callouts（件号 3D 锚点仅对单个模型有效），多个零件要合成一张图时改用 model_paths。',
  '',
  '产物为纯几何片段，不含模板边框、标题栏与图号，符合《专利审查指南》第一部分第一章 4.3 对线条与版面的要求；给定 target_office 时按该法域的 A4 幅面与页边距落版，并可在图形正下方落图号。',
].join('\n')

/**
 * Build the `generate_structure_figure` tool over the injected FreeCAD renderer.
 * @param deps - renderer + gate/outputDir/index/cwd/scale/views defaults.
 * @returns a registry-ready tool definition.
 */
export function createGenerateStructureFigureTool(deps: GenerateStructureFigureDeps): ToolDefinition {
  return defineTool({
    name: 'generate_structure_figure',
    description: DESCRIPTION,
    parameters: {
      model_path: { type: 'string', description: '模型文件路径（STEP/IGES/BREP），或其目录（批量：目录内每个受支持模型各出一图）；与 model_paths 二选一' },
      model_paths: { type: 'array', items: { type: 'string' }, description: '装配体：多个模型文件一起投影成一张图（每个文件一个零件）；与 model_path 二选一' },
      views: { type: 'array', items: { type: 'string', enum: STRUCTURE_VIEWS }, description: '请求视图，缺省 iso/front/top/right' },
      exploded: { type: 'boolean', description: '分解图：沿装配轴把零件拉开成一维串后逐件投影（零件之间互不遮挡），需要 model_paths 传至少两个零件；视线与装配轴近乎平行时会报错' },
      scale: { type: 'number', description: 'TechDraw 投影比例（正数）；缺省取部署配置或 1' },
      show_hidden: { type: 'boolean', description: '绘制隐藏线（细实线，实测 0.35 毫米；不是虚线），默认 false' },
      line_width_mm: { type: 'number', enum: STRUCTURE_LINE_WIDTH_SERIES, description: '可见线线宽（毫米），须取 GB/T 4457.4 线宽系列之一；缺省保持 FreeCAD 输出的 0.7 毫米档' },
      hidden_line_style: { type: 'string', enum: ['solid', 'dashed'], description: '隐藏线线型，默认 solid（FreeCAD 原始细实线）；dashed 时按线宽加 stroke-dasharray 画成虚线' },
      callouts: { type: 'array', items: CALLOUT_SCHEMA, description: '件号锚定 [{numeral, point3d:[x,y,z], label?, model?}]；model 为所属零件下标，装配体下必填；目录批量不支持' },
      details: { type: 'array', items: DETAIL_SCHEMA, description: '局部放大视图 [{base, center:[x,y,z], radius_mm, scale?, reference?}]：把 base 视图上以模型坐标 center 为圆心、radius_mm 为半径的区域放大成独立视图；目录批量不支持' },
      figure_number: { type: 'integer', description: '图号（正整数），默认 1（批量时作为起始图号）' },
      invention_name: { type: 'string', description: '发明名称（附图说明模板句）' },
      target_office: { type: 'string', enum: TARGET_OFFICES, description: '目标法域：给定时把每个视图 SVG 落版到该法域的 A4 幅面与页边距，并返回落版尺寸（仅 SVG 产物生效）' },
      sheet_index: { type: 'integer', description: '附图页序号，默认 1' },
      sheet_total: { type: 'integer', description: '附图页总数，默认 1' },
      caption: { type: 'string', description: '图号文字（如「图1」）；缺省不落图号——多视图如何编号由调用方按整案附图顺序决定' },
      fit_to_page: { type: 'boolean', description: '默认 true：落版到目标法域幅面；false 时只核算尺寸' },
      persist_index: { type: 'boolean', description: '默认 true：写入附图索引（供 search_patent_figure 检索）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          paths: { type: 'array', required: true, items: { type: 'string' } },
          figures: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                figureNumber: { type: 'integer', required: true },
                modelPaths: { type: 'array', required: true, items: { type: 'string' } },
                paths: { type: 'array', required: true, items: { type: 'string' } },
                manifest: { type: 'object', required: true, additionalProperties: true },
              },
            },
          },
          figureDescription: { type: 'string', required: true },
          layout: {
            type: 'object',
            description: '落版与尺寸核算结果（给定 target_office 时）',
            additionalProperties: false,
            properties: {
              office: { type: 'string', required: true, enum: TARGET_OFFICES },
              pageScale: { type: 'number', required: true },
              placedWidthMm: { type: 'number', required: true },
              placedHeightMm: { type: 'number', required: true },
              charHeightMm: { type: 'number' },
              reducedCharHeightMm: { type: 'number' },
              caption: { type: 'string' },
              sheetNumber: { type: 'string', required: true },
            },
          },
          numeralMap: { type: 'array', required: true, items: NUMERAL_MAP_SCHEMA },
          components: { type: 'array', required: true, items: COMPONENT_SCHEMA },
          assembly: ASSEMBLY_SCHEMA,
          warnings: WARNINGS_SCHEMA,
          indexed: { type: 'boolean', required: true },
        },
      },
      // value 由输出 schema 推断（manifest 宽化为 Record）；execute 恒返回该领域类型，此处收窄回 presentation 用类型。
      render: (_args, value) => renderStructureResult(value as unknown as GenerateStructureFigureOutput),
    },
    async execute(args, exec) {
      // 门禁：结构线稿默认关闭，未显式开启即 fail-loud（不静默降级为示意图）。
      if (deps.enabled !== true) {
        throw new PatentToolError('setup_required', '结构线稿默认关闭，设 Config.structureFigureEnabled=true 后重试（需本机安装 FreeCAD 1.1+）。', { tool: 'generate_structure_figure' })
      }
      const run = await resolveStructureRun(args, deps)
      const warnings: string[] = ['由 3D 模型（FreeCAD TechDraw）投影生成的结构线稿']
      const figures = await renderStructureFigures(run, exec.signal)
      await applyViewLineStyles({ run, figures, warnings })
      // 标号放置的降级说明随 manifest 回来：脚本退回首选方向时那句话必须到调用方手上，
      // 否则「图面有标号」与「标号位置合规」会被混为一谈。
      for (const figure of figures) {
        for (const view of figure.manifest.views) {
          for (const note of view.warnings ?? []) {
            warnings.push(`图${figure.figureNumber} ${view.name}：${note}`)
          }
        }
      }
      // 组件列表只派生一次，不随图数累加，否则每个索引条目会被其他图的组件重复污染。
      const components = structureComponents(run.callouts)
      const numeralMap = structureNumeralMap(figures, run.callouts)
      const { figureDescription, numeralText } = describeStructureFigures({
        figures,
        numeralMap,
        inventionName: run.input.invention_name,
      })
      warnings.push(...figureWordingWarnings(
        run.callouts.flatMap(callout => (callout.label === undefined ? [] : [callout.label])),
        run.callouts.map(callout => callout.numeral),
      ))
      const layout = await applyStructureLayout({ run, figures, warnings })
      // 复核放在落版之后、文字转路径之前：落版改写坐标与画布，转路径后图面已无 `<text>`。
      for (const figure of figures) {
        for (const viewPath of figure.paths) {
          await gateRenderedSvg({
            path: resolve(run.cwd, viewPath),
            warnings,
            clearanceMm: clearanceMmForFigure('structure'),
            failOnFindings: deps.failOnRenderFindings === true,
            ...(deps.minSheetFillRatio === undefined ? {} : { minSheetFillRatio: deps.minSheetFillRatio }),
            tool: 'generate_structure_figure',
            label: `图${figure.figureNumber} `,
          })
        }
      }
      await outlineStructureViews({ run, figures, signal: exec.signal })
      let indexed = false
      if ((run.input.persist_index ?? true) && deps.upsertIndex !== undefined) {
        indexed = true
        for (const figure of figures) {
          if (!await upsertFigureIndex({
            upsertIndex: deps.upsertIndex,
            /* v8 ignore next -- the manifest validates at least one view, so paths[0] always exists */
            imagePath: figure.paths[0] ?? '',
            analysis: structureAnalysis(figure, components, numeralText, warnings),
            warnings,
            label: `图${figure.figureNumber} `,
          })) {
            indexed = false
          }
        }
      }
      const assembly = structureAssembly(figures)
      return {
        paths: figures.flatMap(figure => figure.paths),
        figures,
        ...(assembly === undefined ? {} : { assembly }),
        figureDescription,
        ...(layout === undefined ? {} : { layout }),
        numeralMap,
        components,
        warnings,
        indexed,
      }
    },
  })
}

/** 构造索引用 analysis（确定性投影：组件由 callouts 还原，置信度 1）。 */
function structureAnalysis(
  figure: StructureFigureView,
  components: FigureComponent[],
  numeralText: string,
  warnings: string[],
): FigureAnalysisResult {
  return {
    /* v8 ignore next -- the manifest validates at least one view, so paths[0] always exists */
    imagePath: figure.paths[0] ?? '',
    figureNumber: figure.figureNumber,
    figureType: 'structure',
    overallDescription: `由 generate_structure_figure 生成（FreeCAD TechDraw 投影，模型 ${figure.modelPaths.join('、')}）。${numeralText}`,
    components,
    connections: [],
    figureDescription: `图${figure.figureNumber}是${FIGURE_TYPE_NAMES.structure}`,
    confidence: 1,
    warnings,
    usable: figure.manifest.views.length > 0,
    modelUsed: STRUCTURE_FIGURE_MODEL_USED,
  }
}

/** 简单文本渲染：标号表 + 附图说明 + 路径。 */
function renderStructureResult(value: GenerateStructureFigureOutput): { type: 'text'; text: string }[] {
  const lines = [
    `已生成结构线稿附图（${value.figures.length} 张图，${value.paths.length} 个视图）：`,
    ...value.figures.map(figure => `- 图${figure.figureNumber}（${figure.manifest.views.map(v => v.name).join('/')}）：${figure.paths.join('、')}`),
    '',
    value.figureDescription,
    ...(value.layout === undefined
      ? []
      : ['', `## 落版（${value.layout.office}）`, `- 缩放 ${value.layout.pageScale}，图形 ${value.layout.placedWidthMm}×${value.layout.placedHeightMm} 毫米`, `- 页码 ${value.layout.sheetNumber}`]),
    ...(value.numeralMap.length > 0 ? ['', '## 参考标号', ...value.numeralMap.map(m => `- ${m.numeral} ${m.label}`.trimEnd())] : []),
    ...warningSection(value.warnings),
  ]
  return [{ type: 'text', text: lines.join('\n') }]
}
