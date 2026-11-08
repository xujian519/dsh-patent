/**
 * `generate_structure_figure` 的输入/输出、manifest 与依赖类型。
 * @module @deepseek-ai/dsh-patent-tools/tool/structure-types
 */

import type { FigureComponent } from './analyze-patent-figure.ts'
import type { StructureRenderOutcome, StructureRenderSpec } from '../figure/freecad-renderer.ts'
import type { StructureViewName } from '../figure/freecad-structure-script.ts'
import type { FigureIndexEntry } from '../figure/index-store.ts'
import type { OutlineTextPort } from '../figure/inkscape-renderer.ts'
import type { TargetOffice } from '../figure/office-profile.ts'
import type { StructureHiddenLineStyle } from '../figure/structure-svg-postprocess.ts'
import type { SubmissionLayout } from '../figure/submission-page.ts'

export type { StructureViewName } from '../figure/freecad-structure-script.ts'

/** 结构线稿在索引中的模型标识（FreeCAD TechDraw 投影，无 LLM 参与）。 */
export const STRUCTURE_FIGURE_MODEL_USED = 'freecad-structure'

/** 缺省 TechDraw 投影比例。 */
export const DEFAULT_STRUCTURE_SCALE = 1

/** 局部放大视图的缺省放大倍数（2 倍是机械图「放大图」的常用档）。 */
export const DEFAULT_DETAIL_SCALE = 2

/** manifest 中单个件号锚点（Python 侧投影后写回）。 */
export type StructureManifestAnchor = {
  numeral: string
  label: string
  /** 件号声明的归属零件下标；`null` 表示未声明归属（脚本未核对）。 */
  model: number | null
  /** 归属零件的绝对路径；未声明归属时为 `null`。 */
  modelPath: string | null
  point3d: number[]
  point2d: number[]
}

/**
 * manifest 中单个零件在该视图下的几何事实。
 *
 * `bounds` 是投影占位（画布帧 `[x, y, width, height]`，与 {@link StructureManifestAnchor}
 * 的 `point2d` 同帧）；该朝向看不见这个零件时为 `null`。引线布局判「标号或引线压到
 * 别的零件」需要逐零件占位，不能用所有零件合并后的视图包围盒。
 */
export type StructureManifestPart = {
  /** 零件在渲染请求的模型列表中的下标（与 `anchors[].model` 同一口径）。 */
  index: number
  /** 模型 3D 包围盒 `[x, y, z, xLength, yLength, zLength]`（毫米）。 */
  bbox3d: number[]
  /** 零件体积（模型单位的三次方）。 */
  volume: number
  /** 该视图下的投影占位；该朝向看不见时为 `null`。 */
  bounds: number[] | null
}

/** manifest 中单个视图条目（`kind` 区分普通投影视图与局部放大视图）。 */
export type StructureManifestView = {
  name: string
  /** `view` 为普通投影视图；`detail` 为局部放大视图（带 base/center3d/radiusMm/scale/reference）。 */
  kind: 'view' | 'detail'
  order: number
  path: string
  bbox: number[]
  anchors: StructureManifestAnchor[]
  /** 每零件的投影占位；旧版 manifest 无此字段（局部放大视图恒为空数组）。 */
  parts?: StructureManifestPart[]
  /** 标号放置的降级说明（找不到不压盖的位置等）；旧版 manifest 无此字段。 */
  warnings?: string[]
  /** 该视图是否为分解图（逐件 HLR + 沿装配轴排布）；旧版 manifest 无此字段。 */
  exploded?: boolean
  /** 放大视图的基视图名（仅 `kind='detail'`）。 */
  base?: string
  /** 放大视图的窗口圆心（模型 3D 坐标，仅 `kind='detail'`）。 */
  center3d?: number[]
  /** 放大视图的窗口半径（模型毫米，仅 `kind='detail'`）。 */
  radiusMm?: number
  /** 放大视图的放大倍数（仅 `kind='detail'`）。 */
  scale?: number
  /** 放大视图的标号（仅 `kind='detail'`）。 */
  reference?: string
}

/** freecad-structure-script 写出的 manifest.json 结构（渲染产物契约）。 */
export type StructureManifest = {
  figureNumber: number
  /** 该图用到的模型文件绝对路径（装配体为多个，顺序即 `callouts[].model` 的下标口径）。 */
  modelPaths: string[]
  scale: number
  showHidden: boolean
  generator: string
  views: StructureManifestView[]
}

/** 单张结构附图的渲染结果（目录批量时逐模型一条；装配体一条含多个模型）。 */
export type StructureFigureView = {
  /** 图号。 */
  figureNumber: number
  /** 该图用到的模型文件绝对路径（装配体为多个）。 */
  modelPaths: string[]
  /** 该图各视图 SVG 路径（工作区相对）。 */
  paths: string[]
  /** 解析后的 manifest。 */
  manifest: StructureManifest
}

/** 件号锚定输入（与 schema 一致）。 */
export type StructureCalloutInput = {
  /** 参考标号（阿拉伯数字字符串）。 */
  numeral: string
  /**
   * 锚定的模型 3D 坐标（毫米）。省略时由渲染脚本在该零件的真实顶点里自动选一个
   * 投影后离零件轮廓中心最远的点（单模型默认归属零件 0，装配体须给 `model`）。
   */
  point3d?: [number, number, number]
  /** 可选部件名称（写入标号表/manifest，不进图面像素）。 */
  label?: string
  /** 该件号所属零件在输入模型列表中的下标（0 起）；给定时渲染脚本核对锚点确实落在该零件上。 */
  model?: number
}

/** 局部放大视图输入（与 schema 一致）：窗口按模型坐标给出，与视图朝向、投影比例无关。 */
export type StructureDetailInput = {
  /** 窗口所在的基视图名（必须是本次 `views` 里的视图）。 */
  base: string
  /** 窗口圆心的模型 3D 坐标（毫米）。 */
  center: [number, number, number]
  /** 窗口半径（模型毫米）。 */
  radius_mm: number
  /** 放大倍数；缺省 2。 */
  scale?: number
  /** 窗口标号（如「Ⅰ」）；缺省该细节的序号。 */
  reference?: string
}

/** 工具输入（与 schema 一致）。 */
export type GenerateStructureFigureInput = {
  /** 模型文件路径，或其目录（批量：目录内每个受支持模型生成一图，图号自 base 递增）；与 `model_paths` 二选一。 */
  model_path?: string
  /** 装配体：多个模型文件一起投影成一张图（每个文件一个零件，件号可各自声明归属）；与 `model_path` 二选一。 */
  model_paths?: string[]
  /** 请求视图；缺省 iso/front/top/right。 */
  views?: StructureViewName[]
  /** TechDraw 投影比例；缺省取 Config.structureFigureScale 或 1。 */
  scale?: number
  /** 是否绘制隐藏线；缺省 false。 */
  show_hidden?: boolean
  /**
   * 可见线线宽（毫米）；缺省保持 FreeCAD 输出的档位（FC 0.70mm 档的 0.70）。
   * 取值须属于 {@link STRUCTURE_LINE_WIDTH_SERIES}（schema 的 enum 即此收口）。
   */
  line_width_mm?: number
  /** 隐藏线线型：`solid`（缺省，FreeCAD 原始实线）或 `dashed`。 */
  hidden_line_style?: StructureHiddenLineStyle
  /**
   * 分解图：沿装配轴把零件拉开成一维串后逐件投影（零件之间互不遮挡）。
   * 需要 `model_paths` 传至少两个零件；视图视线不得与装配轴近乎平行。
   */
  exploded?: boolean
  /** 件号锚定（可为空）。 */
  callouts?: StructureCalloutInput[]
  /** 局部放大视图（可为空）：把某个基视图上的一块圆形窗口放大成一张独立视图。 */
  details?: StructureDetailInput[]
  /** 图号，默认 1（批量时作为起始图号）。 */
  figure_number?: number
  /** 发明名称（附图说明模板句）。 */
  invention_name?: string
  /** 目标法域（cnipa/pct/uspto）：给定时把每个视图 SVG 落版到该法域的固定幅面附图页（A4 + 页边距）并核算尺寸。 */
  target_office?: TargetOffice
  /** 附图页序号与总页数（默认 1/1），写入页码。 */
  sheet_index?: number
  sheet_total?: number
  /** 图号文字（如「图1」）；缺省不落图号——一个模型的多个视图最终如何编号由调用方按整案附图顺序决定。 */
  caption?: string
  /** 默认 true：落版到目标法域幅面；false 时只核算尺寸、不改写画布。 */
  fit_to_page?: boolean
  /** 默认 true：写入附图索引（供 search_patent_figure 检索）。 */
  persist_index?: boolean
}

/**
 * 单个模型的几何事实摘要（装配体为它的全部零件）。
 *
 * 由渲染脚本在同一次投影里量出，供调用方判断「哪个零件叫什么、该标几号」，
 * 不必再手填 `callouts[].point3d`。`viewBounds` 与 `modelPaths` 同序，是引线布局
 * 判「标号或引线压到别的零件」的输入。只在本次调用只出一张图时给出：目录批量
 * 逐模型各出一图，摘要只描述其中一张，给出会让调用方以为它覆盖全部。
 */
export type StructureAssembly = {
  /** 模型文件绝对路径，顺序即 `callouts[].model` 的下标口径。 */
  modelPaths: string[]
  /** 每零件的尺寸与体积（与视图无关）。 */
  parts: { index: number; path: string; bbox3d: number[]; volume: number }[]
  /** 视图名 → 该视图下每零件的投影占位（与 `parts` 同序；`null` 表示该朝向看不见）。 */
  viewBounds: Record<string, (number[] | null)[]>
}

/** 工具输出（与 schema 一致）。 */
export type GenerateStructureFigureOutput = {
  /** 全部视图 SVG 路径（工作区相对，跨批量图合并）。 */
  paths: string[]
  /** 逐图结果（单模型一条；批量多条）。 */
  figures: StructureFigureView[]
  /** 几何事实摘要（单模型或装配体给出；目录批量出多图时不给）。 */
  assembly?: StructureAssembly
  /** 附图说明文字（「图N是…的结构示意图」，可直接落说明书）。 */
  figureDescription: string
  /** 落版与尺寸核算结果（给定 target_office 时）。 */
  layout?: SubmissionLayout
  /** 标号映射表（件号 → 名称 → 图号）。 */
  numeralMap: { componentId: string; label: string; numeral: string; figure: number }[]
  /** 组件列表（与 analyze_patent_figure 输出同构）。 */
  components: FigureComponent[]
  /** 警告（生成方式说明、非阿拉伯数字标号等）。 */
  warnings: string[]
  /** 是否已写入附图索引。 */
  indexed: boolean
}

/** 依赖注入。render 为 FreeCAD 结构投影；enabled 为 Config.structureFigureEnabled 门禁。 */
export type GenerateStructureFigureDeps = {
  /** 结构投影渲染（freecad-renderer 的 renderStructureViews 或测试注入）。 */
  render: (spec: StructureRenderSpec) => Promise<StructureRenderOutcome>
  /** Config.structureFigureEnabled 门禁；缺省（未开启）时 execute 返回 setup_required。 */
  enabled?: boolean
  /** 输出目录（绝对路径），默认 <cwd>/patent/figures。 */
  outputDir?: string
  /** 可选 upsert 进附图索引（写入失败降级为警告）。 */
  upsertIndex?: (entry: FigureIndexEntry) => Promise<void>
  /** 工作目录（相对路径基准），默认 process.cwd()。 */
  cwd?: string
  /** 投影比例默认（Config.structureFigureScale）。 */
  defaultScale?: number
  /** 视图默认（Config.structureFigureViews）。 */
  defaultViews?: readonly StructureViewName[]
  /**
   * 渲染复核门禁（Config.figureFailOnRenderFindings）：为 true 时任一视图的复核
   * 发现除 `not-measured` 外的问题即判本次生成失败，已写入的视图保留供修正；
   * 缺省只把发现折成警告。
   */
  failOnRenderFindings?: boolean
  /**
   * 版面利用率内控下限（0–1，Config.figureMinSheetFillRatio）：渲染复核按
   * 「内容包围盒 ÷ 该图自己的画布」判，低于下限只记一条提示级发现
   * （`sheet-underfill`），不阻断交付。缺省或 0 关闭该判据。
   */
  minSheetFillRatio?: number
  /**
   * 可选文字转路径（Config.figureTextToPath 注入的 port）：把每个视图 SVG 的 `<text>`
   * 换成轮廓路径。Config 未开启时缺省，视为不转换。
   */
  outlineText?: OutlineTextPort
}
