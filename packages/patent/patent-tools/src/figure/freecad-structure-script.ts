/**
 * FreeCAD TechDraw 结构线稿脚本构建器。
 *
 * `buildStructureScript` 把一次结构视图投影请求渲染成一段自包含的 Python
 * 源码；调用方（freecad-renderer）把源码写入 outputDir 内的临时 .py 再
 * `freecadcmd <script.py>` 执行。脚本只依赖本机 FreeCAD 1.1 实测存在的 API：
 * `Part.read`、`Shape.distToShape`、`TechDraw::DrawViewPart`（Source/Direction/
 * XDirection/Scale/HardHidden…）、`TechDraw.viewPartAsSvg`、
 * `DrawViewPart.projectPoint`。
 *
 * 装配体：`modelPaths` 的每个文件是一个独立 `Part::Feature`，一起挂到同一视图的
 * `Source` 上（TechDraw 一次 HLR 处理全部零件），故件号可以各自声明归属零件、
 * 由脚本按该零件的真实几何核对锚点（见 `STRUCTURE_ANCHOR_TOLERANCE_MM`）。
 *
 * 局部放大：`details` 的每一项在某个基视图上建一个 `TechDraw::DrawViewDetail`，
 * 窗口按模型坐标（圆心 + 半径）给出，TechDraw 负责裁剪与放大；基视图上那圈「放大
 * 部位」标记圆由脚本自己画（`ShowHighlight` 只进 GUI 页面，不进 `viewPartAsSvg`）。
 *
 * 脚本正文是同目录的 `freecad-structure-script.py`，构建时读入一次并缓存，再把参数
 * 替换进 `__PAYLOAD_LITERAL__`：Python 侧因此可以独立做语法检查与高亮，本模块只保留
 * 参数装配与两个调用方共享的常量。读入发生在首次构建，没有 FreeCAD 的环境仍可单测。
 *
 * 坐标系（本机实测，两帧不同）：`projectPoint` 返回**未居中、y 向上**的帧；
 * `viewPartAsSvg` 的 `<g>` 片段则是**已按投影紧致几何居中、y 向下**的帧，也就是
 * 独立 SVG 画布自己的约定，二者关系为 `y_片段 = C_y - y_projectPoint`。因此片段
 * 原样进画布、不做任何翻转（脚本曾按「片段 y 向上」把它整体 `scale(1,-1)`，那是
 * 把图上下镜像）；件号锚点同样按 `C_y - y_projectPoint` 归到片段帧，落点即该坐标的
 * 真实投影。C 是密集投影几何的包围盒中心：TechDraw 按**投影后**的紧致几何居中，
 * 旋转视图下它不等于模型 AABB 中心的投影，故必须逐边取样求。片段不含模板边框/
 * 标题栏/图号，天然满足《专利审查指南》4.3。
 *
 * @module @deepseek-ai/dsh-patent-tools/figure/freecad-structure-script
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 支持的标准投影视图（顺序无关；每个视图映射一组 TechDraw Direction/XDirection）。 */
export const STRUCTURE_VIEWS = ['iso', 'front', 'rear', 'top', 'bottom', 'left', 'right'] as const

/** 结构视图名。 */
export type StructureViewName = (typeof STRUCTURE_VIEWS)[number]

/** 缺省视图集（等轴测 + 三视图常用组合）。 */
export const DEFAULT_STRUCTURE_VIEWS: readonly StructureViewName[] = ['iso', 'front', 'top', 'right']

/**
 * 件号锚定：把一个参考标号绑定到模型 3D 坐标，脚本投影到每个视图的真实 2D 位置。
 * point3d 落在实体表面/顶点上时，件号即锚定到该几何在各视图的投影。
 */
export type StructureCallout = {
  /** 参考标号（阿拉伯数字字符串；非数字由工具层 figureWordingWarnings 告警）。 */
  numeral: string
  /**
   * 锚定的模型 3D 坐标（毫米，与 STEP/IGES/BREP 单位一致）。省略时脚本在该零件的
   * 真实顶点里自动选一个（见模板内 `resolve_auto_anchors`）。
   */
  point3d?: readonly [number, number, number]
  /** 可选部件名称（写入 manifest 件号表供检索，不进图面像素）。 */
  label?: string | undefined
  /**
   * 该件号所属零件在 {@link StructureScriptParams.modelPaths} 中的下标（0 起）。
   * 给定时脚本核对锚点确实落在该零件上（见 {@link STRUCTURE_ANCHOR_TOLERANCE_MM}），
   * 不符即退出码 1；未给定时不核对，manifest 记 `null`。
   */
  model?: number | undefined
}

/**
 * 局部放大视图（`TechDraw::DrawViewDetail`）：把某个基视图上的一块圆形窗口放大成
 * 一张独立视图。
 *
 * 窗口按**模型坐标**给出（圆心 + 半径），故与视图朝向、投影比例无关；脚本把圆心
 * 投影到基视图后作为窗口中心（见 `make_detail_view` 的实测标定），TechDraw 负责裁剪
 * 与放大，并自带一圈边界圆。
 */
export type StructureDetail = {
  /** 窗口所在的基视图（必须在 {@link StructureScriptParams.views} 里）。 */
  base: StructureViewName
  /** 窗口圆心（模型 3D 坐标，毫米）。 */
  center: readonly [number, number, number]
  /** 窗口半径（模型毫米）。 */
  radiusMm: number
  /** 放大倍数（写入 `DrawViewDetail.Scale`）；等于 1 即原尺寸窗口。 */
  scale: number
  /** 窗口标号（如「Ⅰ」）：画在基视图的窗口圆旁，也画在放大视图上。 */
  reference: string
}

/** buildStructureScript 的输入（全部由渲染器/工具层解析为绝对值后传入）。 */
export type StructureScriptParams = {
  /**
   * 模型文件绝对路径列表（STEP/IGES/BREP，由 Part.read 逐个载入）。
   * 多个文件即装配体：每个文件一个 `Part::Feature`，一起挂到同一个视图的
   * `Source` 上投影，故各零件之间的遮挡/隐藏线由 TechDraw 统一处理。
   */
  modelPaths: readonly string[]
  /** 请求视图（顺序即输出与 manifest 顺序）。 */
  views: readonly StructureViewName[]
  /** TechDraw 投影比例（写入 DrawViewPart.Scale；不改变片段坐标，仅记录于 manifest）。 */
  scale: number
  /** 是否绘制隐藏线（HardHidden/IsoHidden/SmoothHidden/SeamHidden 四个布尔）。 */
  showHidden: boolean
  /** 件号锚定（可为空）。 */
  callouts: readonly StructureCallout[]
  /**
   * 分解图：沿装配轴把每个零件拉开成一维串后分别投影。
   *
   * 真值时每个零件单独建一个 `DrawViewPart`（逐件消隐，零件之间互不遮挡），
   * 再按主轴排布拼接。要求 `modelPaths` 至少两个零件，且视图视线不得与
   * 装配轴近乎平行——那样主轴在投影面上退化成一个点，无从排布。
   */
  exploded?: boolean | undefined
  /** 局部放大视图（可为空；每个落在它的基视图上）。 */
  details?: readonly StructureDetail[] | undefined
  /** 图号（决定输出文件名 fig{N}_{view}.svg 与 manifest）。 */
  figureNumber: number
  /** 输出目录绝对路径（脚本在此写 SVG/manifest/临时模板）。 */
  outputDir: string
}

/** 单个视图的 [Direction(x,y,z), XDirection(x,y,z)] 朝向对。 */
type StructureViewDirection = readonly [readonly [number, number, number], readonly [number, number, number]]

/** 视图名 → [Direction(x,y,z), XDirection(x,y,z)]（与 Direction 正交，本机实测稳定）。 */
export const STRUCTURE_VIEW_DIRECTIONS: Readonly<Record<StructureViewName, StructureViewDirection>> = {
  front: [[0, -1, 0], [1, 0, 0]],
  rear: [[0, 1, 0], [-1, 0, 0]],
  top: [[0, 0, 1], [1, 0, 0]],
  bottom: [[0, 0, -1], [1, 0, 0]],
  right: [[1, 0, 0], [0, 0, -1]],
  left: [[-1, 0, 0], [0, 0, 1]],
  iso: [[1, -1, 1], [1, 0, 1]],
}

/**
 * 输出 SVG 文件名（fig{N}_{view}.svg；Python 与 TS 共享同一约定，manifest 为准）。
 * @param figureNumber - 图号。
 * @param view - 视图名。
 * @returns 该视图的 SVG 文件名。
 */
export function structureSvgFilename(figureNumber: number, view: StructureViewName): string {
  return `fig${figureNumber}_${view}.svg`
}

/**
 * 局部放大视图的输出 SVG 文件名（fig{N}_detail{M}.svg，M 从 1 起，即 details 里的序号）。
 * Python 与 TS 共享同一约定，manifest 为准。
 * @param figureNumber - 图号。
 * @param index - 该放大视图在 details 里的一起序号。
 * @returns 该放大视图的 SVG 文件名。
 */
export function structureDetailSvgFilename(figureNumber: number, index: number): string {
  return `fig${figureNumber}_detail${index}.svg`
}

/** manifest.json 文件名（脚本写入 outputDir，渲染器读回作为产物契约）。 */
export const STRUCTURE_MANIFEST_FILENAME = 'manifest.json'

/** 脚本内嵌的最小空白 TechDraw 模板文件名（写入 outputDir；不依赖 FreeCAD 自带模板路径）。 */
export const STRUCTURE_TEMPLATE_FILENAME = '.freecad-structure-template.svg'

/**
 * 文档 TransientDir 所用的 outputDir 内子目录名（TechDraw 拷贝模板的基准目录）。
 *
 * FreeCAD 只在自身缓存目录可写时才派生 TransientDir；沙箱拒绝写
 * `~/Library/Caches/FreeCAD` 时它保持空串，模板拷贝解析到根目录（/）并失败。
 */
export const STRUCTURE_TRANSIENT_DIRNAME = '.freecad-transient'

/** 件号字高（用户单位/毫米；与片段几何同帧，随 scale 一并缩放到画布尺寸）。 */
const STRUCTURE_NUMERAL_FONT_SIZE = 6

/** 引线长度（件号相对锚点的外向偏移，用户单位/毫米）。 */
const STRUCTURE_LEADER_OFFSET = 10

/** 画布内边距（片段包围盒外扩，容纳引线件号与描边，用户单位/毫米）。 */
const STRUCTURE_CANVAS_PADDING = 6

/** 引线/件号描边宽度（片段几何沿用 TechDraw 的 0.7，引线略细以区分）。 */
const STRUCTURE_STROKE_WIDTH = 0.5

/** 密集投影采样点/边（用于求紧致投影包围盒中心 C；覆盖圆弧极值）。 */
const STRUCTURE_EDGE_SAMPLES = 32

/**
 * 件号归属核对的锚点容差（毫米）。
 *
 * 只对**声明了归属**（`callouts[].model`）的件号生效：锚点到该零件表面的距离超过
 * 它就判为「不在该零件上」并退出码 1。0.5 毫米是「模型手写的整数/一位小数坐标」
 * 与「张冠李戴」（通常偏出数十毫米）之间的分界——实测 `Shape.distToShape` 对体表
 * 外的一点返回其真实偏移（0.3 毫米报 0.3、1.2 毫米报 1.2），故这是一个尺度明确的
 * 阈值而不是凑出来的容差。
 */
export const STRUCTURE_ANCHOR_TOLERANCE_MM = 0.5

/**
 * 放大视图边界圆的画布余量倍数（实测）。
 *
 * TechDraw 在放大视图里画的那圈边界（matting）圆比裁剪圆大 1%：`Radius=5、Scale=1`
 * 时片段里的边界点落在半径 5.05，`Radius=8、Scale=2` 时落在 16.16。画布要放得下这圈
 * 线，否则边界会被 viewBox 裁掉一截。
 */
export const STRUCTURE_DETAIL_MATTING_SLACK = 1.01

/** 脚本 payload（经双重 JSON 序列化内嵌，规避路径/标号的转义问题）。 */
type ScriptPayload = {
  modelPaths: readonly string[]
  views: readonly StructureViewName[]
  directions: Record<string, StructureViewDirection>
  scale: number
  showHidden: boolean
  callouts: readonly { numeral: string; point3d: readonly number[] | null; label: string; model: number | null }[]
  details: readonly { base: string; center3d: readonly number[]; radiusMm: number; scale: number; reference: string }[]
  detailFilenames: readonly string[]
  mattingSlack: number
  anchorTolerance: number
  exploded: boolean
  figureNumber: number
  outputDir: string
  svgFilenames: Record<string, string>
  manifestFilename: string
  templateFilename: string
  transientDirname: string
  numeralFontSize: number
  leaderOffset: number
  canvasPadding: number
  strokeWidth: number
  edgeSamples: number
}

/**
 * 脚本模板资产的两条候选路径：源码运行取同目录，`lib/index.js` 打包运行取包内 `src/figure`。
 *
 * 资产随 `files` 里的 `src` 发布，Desktop 运行时按原样复制进 asar；Node 的
 * `readFileSync` 能直接读 asar 内路径，因此不需要 `asarUnpack`。
 */
const PYTHON_TEMPLATE_CANDIDATES = ['./freecad-structure-script.py', '../src/figure/freecad-structure-script.py'] as const

/**
 * 读取 FreeCAD 脚本模板资产。
 *
 * 两条候选路径都基于当前模块 URL，源码运行与被 `lib/index.js` 打包后运行共用
 * 一份实现。资产缺失说明打包漏带文件，直接抛错而不是回退到空脚本，避免产出空图。
 * @param moduleUrl - 当前模块的 `import.meta.url`（字符串或其 `URL` 形式）。
 * @returns `.py` 模板全文。
 * @throws Error 两条候选路径都不存在时。
 */
export function readStructureScriptTemplate(moduleUrl: string | URL): string {
  const tried: string[] = []
  for (const relativePath of PYTHON_TEMPLATE_CANDIDATES) {
    const path = fileURLToPath(new URL(relativePath, moduleUrl))
    tried.push(path)
    if (existsSync(path)) return readFileSync(path, 'utf8')
  }
  throw new Error(`FreeCAD structure script template asset is missing; looked for ${tried.join(', ')}`)
}

/** 首次构建读入后的模板文本；资产随包发布且不随请求变化。 */
let pythonTemplate: string | undefined

/**
 * 构建 FreeCAD 结构线稿投影脚本源码。
 *
 * 确定性：相同入参恒返回相同 Python 文本；唯一副作用是首次调用时读取模板资产并缓存。
 * 脚本执行后在 outputDir 写出每视图一个 `fig{N}_{view}.svg`（黑描边、无边框/
 * 标题栏/图号，件号以引线锚定到真实顶点投影）与一个 `manifest.json`
 * （视图名/顺序/件号表/每视图投影锚点与件号归属/包围盒）。
 * @param params - 已解析为绝对路径与数值 defaults 的投影请求。
 * @returns 可交给 `freecadcmd` 执行的 Python 源码。
 * @throws Error 模板资产缺失时（打包漏带 `src/figure/freecad-structure-script.py`）。
 */
export function buildStructureScript(params: StructureScriptParams): string {
  const payload: ScriptPayload = {
    modelPaths: [...params.modelPaths],
    views: params.views,
    directions: Object.fromEntries(
      params.views.map((view): [string, StructureViewDirection] => {
        const [direction, xDirection] = STRUCTURE_VIEW_DIRECTIONS[view]
        return [view, [direction, xDirection]]
      }),
    ),
    scale: params.scale,
    showHidden: params.showHidden,
    callouts: params.callouts.map(callout => ({
      numeral: callout.numeral,
      point3d: callout.point3d === undefined ? null : [...callout.point3d],
      label: callout.label ?? '',
      model: callout.model ?? null,
    })),
    anchorTolerance: STRUCTURE_ANCHOR_TOLERANCE_MM,
    exploded: params.exploded === true,
    details: (params.details ?? []).map(detail => ({
      base: detail.base,
      center3d: [...detail.center],
      radiusMm: detail.radiusMm,
      scale: detail.scale,
      reference: detail.reference,
    })),
    detailFilenames: (params.details ?? []).map((_, index) => structureDetailSvgFilename(params.figureNumber, index + 1)),
    mattingSlack: STRUCTURE_DETAIL_MATTING_SLACK,
    figureNumber: params.figureNumber,
    outputDir: params.outputDir,
    svgFilenames: Object.fromEntries(params.views.map(view => [view, structureSvgFilename(params.figureNumber, view)])),
    manifestFilename: STRUCTURE_MANIFEST_FILENAME,
    templateFilename: STRUCTURE_TEMPLATE_FILENAME,
    transientDirname: STRUCTURE_TRANSIENT_DIRNAME,
    numeralFontSize: STRUCTURE_NUMERAL_FONT_SIZE,
    leaderOffset: STRUCTURE_LEADER_OFFSET,
    canvasPadding: STRUCTURE_CANVAS_PADDING,
    strokeWidth: STRUCTURE_STROKE_WIDTH,
    edgeSamples: STRUCTURE_EDGE_SAMPLES,
  }
  // 双重序列化：内层是脚本要 json.loads 的对象文本，外层把它转成一个 Python
  // 双引号字符串字面量（JSON 与 Python 的 \" \\ \n \uXXXX 转义规则一致）。
  const payloadLiteral = JSON.stringify(JSON.stringify(payload))
  pythonTemplate ??= readStructureScriptTemplate(import.meta.url)
  return pythonTemplate.replace('__PAYLOAD_LITERAL__', payloadLiteral)
}
