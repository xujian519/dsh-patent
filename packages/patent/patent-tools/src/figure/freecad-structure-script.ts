/**
 * FreeCAD TechDraw 结构线稿脚本构建器（纯函数，无 IO）。
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
 * 为什么把脚本作为源码内嵌而非随包 asset：patent-tools 的 `files` 只 ship
 * `lib/index.js` + 类型声明，额外的 `.py` 资产需要打包与路径解析；纯函数返回
 * 源码把「构建脚本」与「执行脚本」彻底分离，前者可在无 FreeCAD 的环境下单测。
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
 * 构建 FreeCAD 结构线稿投影脚本源码。
 *
 * 纯函数：相同入参恒返回相同 Python 文本，不做任何 IO、不接触 FreeCAD。
 * 脚本执行后在 outputDir 写出每视图一个 `fig{N}_{view}.svg`（黑描边、无边框/
 * 标题栏/图号，件号以引线锚定到真实顶点投影）与一个 `manifest.json`
 * （视图名/顺序/件号表/每视图投影锚点与件号归属/包围盒）。
 * @param params - 已解析为绝对路径与数值 defaults 的投影请求。
 * @returns 可交给 `freecadcmd` 执行的 Python 源码。
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
  return PYTHON_TEMPLATE.replace('__PAYLOAD_LITERAL__', payloadLiteral)
}

/**
 * Python 脚本模板（`__PAYLOAD_LITERAL__` 处内嵌参数）。
 *
 * 只使用本机 FreeCAD 1.1.3 实测存在的 API；`DrawProjGroup.addProjection` 在
 * 1.1.3 抛 TypeError，故每个视图独立建 `DrawViewPart` 并显式设 Direction/
 * XDirection。投影只有当视图归属一个带模板的 DrawPage 时才执行，脚本自带一个
 * 最小空白模板（不套 TechDraw 自带模板，输出片段因此不含边框/标题栏/图号）。
 */
const PYTHON_TEMPLATE = String.raw`import json
import math
import os
import sys
import traceback

import FreeCAD as App
import Part
import TechDraw

# freecadcmd 的 stderr 编码取宿主 locale（实测 LANG=C 时 encoding=ascii、
# errors=backslashreplace），中文诊断会被转义成 \uXXXX；而调用方（渲染器）正是
# 从 stderr 里读出失败原因，转义后就是读不懂的乱码。显式改成 UTF-8。
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

PARAMS = json.loads(__PAYLOAD_LITERAL__)

MODEL_PATHS = PARAMS["modelPaths"]
VIEWS = PARAMS["views"]
DIRECTIONS = PARAMS["directions"]
SCALE = float(PARAMS["scale"])
SHOW_HIDDEN = bool(PARAMS["showHidden"])
CALLOUTS = PARAMS["callouts"]
DETAILS = PARAMS["details"]
DETAIL_FILENAMES = PARAMS["detailFilenames"]
MATTING_SLACK = float(PARAMS["mattingSlack"])
ANCHOR_TOLERANCE = float(PARAMS["anchorTolerance"])
FIGURE_NUMBER = int(PARAMS["figureNumber"])
OUTPUT_DIR = PARAMS["outputDir"]
SVG_FILENAMES = PARAMS["svgFilenames"]
MANIFEST_FILENAME = PARAMS["manifestFilename"]
TEMPLATE_FILENAME = PARAMS["templateFilename"]
TRANSIENT_DIRNAME = PARAMS["transientDirname"]
NUMERAL_FONT_SIZE = float(PARAMS["numeralFontSize"])
LEADER_OFFSET = float(PARAMS["leaderOffset"])
# 标号候选：绕首选方向每 30° 试一圈（12 个方向），每个方向再按三档距离外推。
CALLOUT_DIRECTION_STEPS = [0, 30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180]
CALLOUT_DISTANCE_SCALES = [1.0, 1.6, 2.4]
CANVAS_PADDING = float(PARAMS["canvasPadding"])
STROKE_WIDTH = float(PARAMS["strokeWidth"])
EDGE_SAMPLES = int(PARAMS["edgeSamples"])

# 数字占位框的比例：与绘图层 glyph-box.ts 的 textWidthMm/glyphBox 同口径
# （数字宽度 0.62 字号、ascent 0.75、descent 0.12），复核侧按同一组比例判定，
# 故引线止点与复核口径不会各算一套。
GLYPH_WIDTH_RATIO = 0.62
GLYPH_ASCENT_RATIO = 0.75
GLYPH_DESCENT_RATIO = 0.12

# 最小空白 TechDraw 模板：DrawPage 需要一个模板才会执行视图投影；本方案只取
# viewPartAsSvg 的几何片段、不套模板边框，故模板内容仅需一个页面矩形。
MINIMAL_TEMPLATE = (
    '<svg xmlns="http://www.w3.org/2000/svg" width="297mm" height="210mm" '
    'viewBox="0 0 297 210">'
    '<rect x="0" y="0" width="297" height="210" fill="none" stroke="none"/>'
    '</svg>'
)


def fmt(value):
    """坐标格式化：去尾零，保留三位小数。"""
    return ("%.3f" % value).rstrip("0").rstrip(".")


def escape_text(value):
    """XML 文本转义（件号/名称仅出现在文本节点）。"""
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def projected_bounds(view, shapes):
    """
    求投影视图的整体包围盒与逐零件包围盒（一次取样，两种口径）。

    离散化每条边后逐点 projectPoint：TechDraw 按投影后的紧致几何居中片段，
    旋转视图（如 iso）下该中心不等于模型 AABB 中心的投影，故必须实测取样。
    装配体的每个零件都参与取样（片段是所有零件的合并投影）。

    逐零件包围盒是引线布局的输入：判「引线是否穿过别的零件」需要每个零件的
    投影占位，而不是所有零件合并后的整体包围盒。零件在投影中没有几何时记
    None（TechDraw 仍把它放进同一次 HLR，但该朝向看不见它）。
    返回 ((x_min, x_max, y_min, y_max), [每零件同形包围盒或 None])，均在
    projectPoint 的原始帧（y 向上）。
    """
    xs_all = []
    ys_all = []
    per_part = []
    for shape in shapes:
        xs = []
        ys = []
        for edge in shape.Edges:
            for point in edge.discretize(Number=EDGE_SAMPLES):
                projected = view.projectPoint(point)
                xs.append(projected.x)
                ys.append(projected.y)
        if not xs:
            per_part.append(None)
            continue
        per_part.append((min(xs), max(xs), min(ys), max(ys)))
        xs_all.extend(xs)
        ys_all.extend(ys)
    if not xs_all:
        raise RuntimeError("投影未产生任何几何：模型可能为空或视图朝向退化")
    return (min(xs_all), max(xs_all), min(ys_all), max(ys_all)), per_part


def numeral_box(text_x, text_y, value):
    """
    数字占位框：中心与半宽/半高（y-down 画布帧）。

    number_text 把基线按 0.35 字高下沉，故框中心约等于传入的锚点；半高取
    ascent 与 descent 的均值，宽度按每个数字 0.62 字高累加。
    """
    half_w = GLYPH_WIDTH_RATIO * NUMERAL_FONT_SIZE * len(value) / 2.0
    half_h = (GLYPH_ASCENT_RATIO + GLYPH_DESCENT_RATIO) * NUMERAL_FONT_SIZE / 2.0
    center_y = text_y + NUMERAL_FONT_SIZE * (0.35 - (GLYPH_ASCENT_RATIO - GLYPH_DESCENT_RATIO) / 2.0)
    return text_x, center_y, half_w, half_h


def leader_end(center_x, center_y, half_w, half_h, unit_x, unit_y):
    """
    从数字框中心沿 (unit_x, unit_y) 的反方向退到框边（与 glyph-box.ts 的
    leaderEnd 同口径）：各自先出框的轴向决定后退量。引线止于此点，不再穿过
    自己的标号。
    """
    step_x = float("inf") if unit_x == 0 else half_w / abs(unit_x)
    step_y = float("inf") if unit_y == 0 else half_h / abs(unit_y)
    back = min(step_x, step_y)
    return center_x - unit_x * back, center_y - unit_y * back


def number_text(text_x, text_y, value):
    """件号/窗口标号的文本片段（y-down 画布帧；基线按字高的 0.35 倍下沉以视觉居中）。"""
    return (
        '<text x="%s" y="%s" font-size="%s" font-family="sans-serif" '
        'text-anchor="middle" fill="#000000" stroke="none">%s</text>'
        % (
            fmt(text_x),
            fmt(text_y + NUMERAL_FONT_SIZE * 0.35),
            fmt(NUMERAL_FONT_SIZE),
            escape_text(value),
        )
    )


def verify_callout_owners(shapes):
    """
    核对声明了归属的件号锚点确实落在该零件上（未声明归属的不核对）。

    只在渲染前跑：锚点错位是输入错误，不该先花掉一次完整投影再报。
    distToShape 对体外点返回真实偏移（实测 0.3 毫米报 0.3），故容差是尺度明确的阈值。
    point3d 为 None 的件号走自动锚点，其坐标由 resolve_auto_anchors 在建好首个
    视图后填入，故在这里跳过。
    """
    for index, callout in enumerate(CALLOUTS):
        owner = callout["model"]
        if owner is None:
            continue
        if not 0 <= owner < len(shapes):
            raise RuntimeError(
                "callouts[%d].model = %d 超出 modelPaths 范围（共 %d 个模型）"
                % (index, owner, len(shapes))
            )
        if callout["point3d"] is None:
            continue
        px, py, pz = callout["point3d"]
        offset = shapes[owner].distToShape(Part.Vertex(App.Vector(px, py, pz)))[0]
        if offset > ANCHOR_TOLERANCE:
            raise RuntimeError(
                "callouts[%d].point3d [%s, %s, %s] 不在 modelPaths[%d]（%s）上：偏离 %s 毫米，超过容差 %s 毫米；"
                "件号必须锚定到所声明的零件，或改正 model 下标"
                % (index, fmt(px), fmt(py), fmt(pz), owner, MODEL_PATHS[owner], fmt(offset), fmt(ANCHOR_TOLERANCE))
            )


def resolve_auto_anchors(shapes, view):
    """
    给未给 point3d 的件号自动选锚点。

    选点规则：在该零件的真实顶点里，取投影后离该零件投影轮廓中心最远的那个。
    最远的顶点必在轮廓外缘，引线因此从实体外侧向外延伸，不会指向图形内部
    （手填坐标最容易犯的错就是把标号丢进图面中心）。同一零件上有多个自动件号时
    按出现顺序轮转排名，避免全部落在同一个点上；排名以首个视图为准，其余视图对
    同一个 3D 点各自投影，锚定的仍是同一物理位置。

    选完写回 CALLOUTS：之后的归属核对、投影与 manifest 读的都是这一份。
    """
    used = {}
    for index, callout in enumerate(CALLOUTS):
        if callout["point3d"] is not None:
            continue
        owner = callout["model"]
        if owner is None:
            owner = 0
        if not 0 <= owner < len(shapes):
            raise RuntimeError(
                "callouts[%d].model = %d 超出 modelPaths 范围（共 %d 个模型）"
                % (index, owner, len(shapes))
            )
        shape = shapes[owner]
        points = [vertex.Point for vertex in shape.Vertexes]
        if not points:
            raise RuntimeError(
                "callouts[%d] 需要自动锚点，但 modelPaths[%d]（%s）没有可投影的顶点"
                % (index, owner, MODEL_PATHS[owner])
            )
        projected = [view.projectPoint(point) for point in points]
        xs = [projected_point.x for projected_point in projected]
        ys = [projected_point.y for projected_point in projected]
        center_x = (min(xs) + max(xs)) / 2.0
        center_y = (min(ys) + max(ys)) / 2.0
        ranked = sorted(
            range(len(points)),
            key=lambda i: (projected[i].x - center_x) ** 2 + (projected[i].y - center_y) ** 2,
            reverse=True,
        )
        ordinal = used.get(owner, 0)
        used[owner] = ordinal + 1
        pick = points[ranked[ordinal % len(ranked)]]
        callout["point3d"] = [pick.x, pick.y, pick.z]


def make_view(doc, page, shape_objs, view_name, index):
    """建单个 TechDraw::DrawViewPart（显式朝向 + 隐藏线开关）并归属页面后重算。"""
    direction, xdirection = DIRECTIONS[view_name]
    view = doc.addObject("TechDraw::DrawViewPart", "View_%d" % index)
    # 装配体的每个零件一个 Source 项：TechDraw 把它们放进同一次 HLR，零件之间的
    # 遮挡由它统一处理（合成 compound 也能投影，但那样丢失「件号归属哪个零件」）。
    view.Source = shape_objs
    view.Direction = App.Vector(direction[0], direction[1], direction[2])
    view.XDirection = App.Vector(xdirection[0], xdirection[1], xdirection[2])
    view.Scale = SCALE
    view.HardHidden = SHOW_HIDDEN
    view.IsoHidden = SHOW_HIDDEN
    view.SmoothHidden = SHOW_HIDDEN
    view.SeamHidden = SHOW_HIDDEN
    page.addView(view)
    doc.recompute()
    doc.recompute()
    return view


def rotate_direction(unit_x, unit_y, degrees):
    """把单位向量绕原点旋转 degrees 度（画布帧 y 向下，正角在画面上顺时针）。"""
    radians = math.radians(degrees)
    cos_a = math.cos(radians)
    sin_a = math.sin(radians)
    return unit_x * cos_a - unit_y * sin_a, unit_x * sin_a + unit_y * cos_a


def rects_overlap(left, right):
    """两个 (min_x, min_y, max_x, max_y) 矩形是否有面积重叠（贴边不算）。"""
    return not (left[2] <= right[0] or right[2] <= left[0] or left[3] <= right[1] or right[3] <= left[1])


def part_rects_in_canvas(part_bounds, center):
    """
    把逐零件包围盒从 projectPoint 帧（y 向上）转到画布帧（y 向下）。

    返回与 part_bounds 同序的 (min_x, min_y, max_x, max_y) 列表，该朝向看不见的
    零件保持 None——它不参与压盖判定，否则空框会把整幅图面判成禁区。
    """
    c_x, c_y = center
    rects = []
    for bounds in part_bounds:
        if bounds is None:
            rects.append(None)
            continue
        # projectPoint 的 y 向上、画布帧 y 向下，故上下两端互换。
        rects.append((bounds[0] - c_x, -(bounds[3] - c_y), bounds[1] - c_x, -(bounds[2] - c_y)))
    return rects


def choose_callout_position(anchor_x, anchor_y, numeral, preferred_x, preferred_y, own_part, part_rects, placed):
    """
    为首选方向轴上的一个件号选标号位置。

    候选按「距离档 × 方向偏移」两级展开：先试首选距离，绕首选方向每 30° 试一圈；
    该距离全部压盖时再退到更远的档。判定只看两件事——标号框是否压到**别的零件**
    的投影占位、是否压到已放好的标号；自身零件的占位不算，标号本就该贴着自己。

    返回 (text_x, text_y, box_x, box_y, half_w, half_h, dir_x, dir_y, rect)；
    全部候选都不可行时返回 None，由调用方决定退路。
    """
    for scale in CALLOUT_DISTANCE_SCALES:
        for step in CALLOUT_DIRECTION_STEPS:
            dir_x, dir_y = rotate_direction(preferred_x, preferred_y, step)
            text_x = anchor_x + dir_x * LEADER_OFFSET * scale
            text_y = anchor_y + dir_y * LEADER_OFFSET * scale
            box_x, box_y, half_w, half_h = numeral_box(text_x, text_y, numeral)
            rect = (box_x - half_w, box_y - half_h, box_x + half_w, box_y + half_h)
            if any(rects_overlap(rect, other) for other in placed):
                continue
            blocked = False
            for part_index, part_rect in enumerate(part_rects):
                if part_index == own_part or part_rect is None:
                    continue
                if rects_overlap(rect, part_rect):
                    blocked = True
                    break
            if blocked:
                continue
            return text_x, text_y, box_x, box_y, half_w, half_h, dir_x, dir_y, rect
    return None


def callout_fragments(view, center, bbox, part_bounds):
    """
    把件号投影到视图并为每个标号选位置、画引线与数字（y-down SVG 帧）。

    锚点 = projectPoint(point3d) - C，再翻转 y（片段帧 y 向上 → SVG y 向下）。
    首选引线方向取自**所属零件的投影中心**指向锚点，而不是画布中心：零件正好
    位于图面中央时，「画布中心 → 锚点」是任意方向，标号会被丢进图形内部；以
    零件自身中心为基准，方向恒为从该零件向外。

    标号位置在该方向附近按 30° 步长、三档距离找第一个不压别的零件、不压已放
    标号的候选（见 choose_callout_position）。全部候选都不可行时退回首选方向的
    最近档——宁可略微压盖也不丢标号——并记一条警告。

    返回 (svg_片段列表, 锚点信息列表, 扩展包围盒, 警告列表)。
    """
    c_x, c_y = center
    fragments = []
    anchors = []
    warnings = []
    min_x, max_x = bbox[0] - c_x, bbox[1] - c_x
    min_y, max_y = -bbox[3] + c_y, -bbox[2] + c_y  # 翻转后的 y-down 范围
    part_rects = part_rects_in_canvas(part_bounds, center)
    placed = []
    for callout in CALLOUTS:
        px, py, pz = callout["point3d"]
        owner = callout["model"]
        # 未声明归属时按单模型处理：目录批量已由工具层拒绝，走到这里必然是单模型。
        own_part = 0 if owner is None else owner
        projected = view.projectPoint(App.Vector(px, py, pz))
        anchor_x = projected.x - c_x
        anchor_y = -(projected.y - c_y)  # 翻转到 y-down
        # 首选方向：所属零件投影中心 → 锚点。锚点与零件中心重合（退化）时退回 +x。
        unit_x, unit_y = 1.0, 0.0
        own_rect = part_rects[own_part] if 0 <= own_part < len(part_rects) else None
        if own_rect is not None:
            part_cx = (own_rect[0] + own_rect[2]) / 2.0
            part_cy = (own_rect[1] + own_rect[3]) / 2.0
            out_x = anchor_x - part_cx
            out_y = anchor_y - part_cy
            length = math.hypot(out_x, out_y)
            if length >= 1e-9:
                unit_x, unit_y = out_x / length, out_y / length
        chosen = choose_callout_position(
            anchor_x, anchor_y, callout["numeral"], unit_x, unit_y, own_part, part_rects, placed
        )
        if chosen is None:
            # 全部候选都压盖：保留首选方向最近档，记警告而不是丢标号。
            text_x = anchor_x + unit_x * LEADER_OFFSET
            text_y = anchor_y + unit_y * LEADER_OFFSET
            box_x, box_y, half_w, half_h = numeral_box(text_x, text_y, callout["numeral"])
            rect = (box_x - half_w, box_y - half_h, box_x + half_w, box_y + half_h)
            chosen = (text_x, text_y, box_x, box_y, half_w, half_h, unit_x, unit_y, rect)
            warnings.append(
                "件号 %s 找不到不压盖标号的位置（%d 个候选全部压到别的零件或已放标号），已退回首选方向"
                % (callout["numeral"], len(CALLOUT_DISTANCE_SCALES) * len(CALLOUT_DIRECTION_STEPS))
            )
        text_x, text_y, box_x, box_y, half_w, half_h, dir_x, dir_y, rect = chosen
        placed.append(rect)
        end_x, end_y = leader_end(box_x, box_y, half_w, half_h, dir_x, dir_y)
        fragments.append(
            '<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="#000000" '
            'stroke-width="%s" fill="none" data-dsh-role="leader"/>'
            % (fmt(anchor_x), fmt(anchor_y), fmt(end_x), fmt(end_y), fmt(STROKE_WIDTH))
        )
        fragments.append(number_text(text_x, text_y, callout["numeral"]))
        # 按数字真实占位框外扩画布，多位标号不会被右缘裁掉。
        min_x = min(min_x, box_x - half_w)
        max_x = max(max_x, box_x + half_w)
        min_y = min(min_y, box_y - half_h)
        max_y = max(max_y, box_y + half_h)
        anchors.append(
            {
                "numeral": callout["numeral"],
                "label": callout["label"],
                "model": owner,
                "modelPath": None if owner is None else MODEL_PATHS[owner],
                "point3d": [px, py, pz],
                "point2d": [round(anchor_x, 4), round(anchor_y, 4)],
            }
        )
    return fragments, anchors, (min_x, max_x, min_y, max_y), warnings


def detail_label_position(center_x, center_y, radius):
    """窗口标号位置：沿 45° 放在圆外一个字高处（避免数字压到窗口圆或图线上）。"""
    offset = (radius + NUMERAL_FONT_SIZE) * 0.7071067811865476
    return center_x + offset, center_y - offset


def detail_marking_fragments(view, center, view_name):
    """
    基视图上「放大部位」的标记：窗口圆 + 标号（y-down 画布帧）。

    TechDraw 的 ShowHighlight 只在 GUI 页面里画这圈高亮——实测细节视图存在前后
    viewPartAsSvg(基视图) 逐字节相同，故标记圆由脚本自己画。圆心取
    projectPoint(圆心) - C，与传给 DrawViewDetail.AnchorPoint 的是同一个值，
    标记圆与 TechDraw 实际裁剪的窗口因此严丝合缝。
    返回 (片段列表, 外扩包围盒)；该视图上没有窗口时返回 ([], None)。
    """
    c_x, c_y = center
    fragments = []
    boxes = []
    for detail in DETAILS:
        if detail["base"] != view_name:
            continue
        px, py, pz = detail["center3d"]
        projected = view.projectPoint(App.Vector(px, py, pz))
        circle_x = projected.x - c_x
        circle_y = -(projected.y - c_y)
        radius = float(detail["radiusMm"])
        fragments.append(
            '<circle cx="%s" cy="%s" r="%s" stroke="#000000" stroke-width="%s" fill="none"/>'
            % (fmt(circle_x), fmt(circle_y), fmt(radius), fmt(STROKE_WIDTH))
        )
        text_x, text_y = detail_label_position(circle_x, circle_y, radius)
        fragments.append(number_text(text_x, text_y, detail["reference"]))
        boxes.append((circle_x - radius, circle_x + radius, circle_y - radius, circle_y + radius))
        box_x, box_y, half_w, half_h = numeral_box(text_x, text_y, detail["reference"])
        boxes.append((box_x - half_w, box_x + half_w, box_y - half_h, box_y + half_h))
    if not boxes:
        return [], None
    extent = (
        min(box[0] for box in boxes),
        max(box[1] for box in boxes),
        min(box[2] for box in boxes),
        max(box[3] for box in boxes),
    )
    return fragments, extent


def make_detail_view(doc, page, base_view, base_center, detail, index):
    """
    建 TechDraw::DrawViewDetail（局部放大）并归属页面后重算。

    AnchorPoint 是**基视图帧**里的圆心：实测标定得 y_局部 = y_in + (C_y - y_projectPoint)，
    故要传 projectPoint(圆心) - C（传 projectPoint 原始值会把窗口挪到别处）；Radius 是
    窗口半径（基视图坐标 = 模型毫米），Scale 是放大倍数，Reference 是标号（不是坐标）。
    """
    px, py, pz = detail["center3d"]
    projected = base_view.projectPoint(App.Vector(px, py, pz))
    view = doc.addObject("TechDraw::DrawViewDetail", "Detail_%d" % index)
    view.BaseView = base_view
    view.Direction = base_view.Direction
    view.XDirection = base_view.XDirection
    view.AnchorPoint = App.Vector(projected.x - base_center[0], projected.y - base_center[1], 0)
    view.Radius = float(detail["radiusMm"])
    view.Scale = float(detail["scale"])
    view.Reference = detail["reference"]
    page.addView(view)
    doc.recompute()
    doc.recompute()
    return view


def build_detail_view_svg(view, detail, index):
    """
    生成一张局部放大视图的独立黑白 SVG 与其 manifest 元数据。

    实测：DrawViewDetail 的片段已按 Scale 放大（Radius=8 时 Scale=1 与 Scale=2 的坐标
    逐值 2 倍）、已裁到半径 radius*scale 的圆内，并自带一圈半径 1.01 倍的边界圆；
    片段以窗口圆心为原点、y 向下（与基视图片段同帧）。故画布半宽按
    radius*scale*余量 取，物理毫米尺寸**直接**用片段坐标——片段本身已经放大过，
    再乘 SCALE 会把尺寸放大两次。
    """
    fragment = TechDraw.viewPartAsSvg(view)
    if fragment is None or fragment.strip() == "":
        raise RuntimeError("viewPartAsSvg 返回空片段：放大视图 %s 未产生投影几何" % DETAIL_FILENAMES[index])
    radius = float(detail["radiusMm"]) * float(detail["scale"])
    text_x, text_y = detail_label_position(0.0, 0.0, radius)
    half = max(radius * MATTING_SLACK, abs(text_x) + NUMERAL_FONT_SIZE, abs(text_y) + NUMERAL_FONT_SIZE)
    half = half + CANVAS_PADDING
    size = half * 2.0
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="%s %s %s %s" '
        'width="%smm" height="%smm">'
        % (fmt(-half), fmt(-half), fmt(size), fmt(size), fmt(size), fmt(size)),
        fragment,
        number_text(text_x, text_y, detail["reference"]),
        "</svg>",
    ]
    return "".join(parts), {"bbox": [round(-half, 4), round(-half, 4), round(size, 4), round(size, 4)]}


def part_metadata(shapes, part_bounds, center):
    """
    每零件的 manifest 条目：3D 包围盒、体积与本次视图的投影占位（画布帧）。

    投影占位给引线布局判「引线或标号是否压到别的零件」用。画布帧与 anchors 的
    point2d 同帧（y 向下、以 C 居中），消费方不需要再做坐标换算。该朝向看不见
    的零件记 None，而不是退化成零面积框。
    """
    c_x, c_y = center
    parts = []
    for index, shape in enumerate(shapes):
        box = shape.BoundBox
        bounds = part_bounds[index]
        if bounds is None:
            projected = None
        else:
            x_min = bounds[0] - c_x
            x_max = bounds[1] - c_x
            # projectPoint 的 y 向上、画布帧 y 向下，故上下两端互换。
            y_min = -(bounds[3] - c_y)
            y_max = -(bounds[2] - c_y)
            projected = [
                round(x_min, 4),
                round(y_min, 4),
                round(x_max - x_min, 4),
                round(y_max - y_min, 4),
            ]
        parts.append(
            {
                "index": index,
                "bbox3d": [
                    round(box.XMin, 4),
                    round(box.YMin, 4),
                    round(box.ZMin, 4),
                    round(box.XLength, 4),
                    round(box.YLength, 4),
                    round(box.ZLength, 4),
                ],
                "volume": round(shape.Volume, 4),
                "bounds": projected,
            }
        )
    return parts


def build_view_svg(view, shapes, view_name):
    """生成单个视图的独立黑白 SVG 文本与其 manifest 元数据。"""
    bbox, part_bounds = projected_bounds(view, shapes)
    center = ((bbox[0] + bbox[1]) / 2.0, (bbox[2] + bbox[3]) / 2.0)
    c_x, c_y = center
    fragment = TechDraw.viewPartAsSvg(view)
    if fragment is None or fragment.strip() == "":
        raise RuntimeError("viewPartAsSvg 返回空片段：视图 %s 未产生投影几何" % view_name)
    # 片段帧（y-down）几何范围。
    geo_min_x, geo_max_x = bbox[0] - c_x, bbox[1] - c_x
    geo_min_y, geo_max_y = bbox[2] - c_y, bbox[3] - c_y
    callout_svg, anchors, extent, callout_warnings = callout_fragments(view, center, bbox, part_bounds)
    marker_svg, marker_extent = detail_marking_fragments(view, center, view_name)
    if marker_extent is not None:
        extent = (
            min(extent[0], marker_extent[0]),
            max(extent[1], marker_extent[1]),
            min(extent[2], marker_extent[2]),
            max(extent[3], marker_extent[3]),
        )
    min_x = min(geo_min_x, extent[0]) - CANVAS_PADDING
    max_x = max(geo_max_x, extent[1]) + CANVAS_PADDING
    min_y = min(-geo_max_y, extent[2]) - CANVAS_PADDING
    max_y = max(-geo_min_y, extent[3]) + CANVAS_PADDING
    width = max_x - min_x
    height = max_y - min_y
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="%s %s %s %s" '
        'width="%smm" height="%smm">'
        % (fmt(min_x), fmt(min_y), fmt(width), fmt(height), fmt(width * SCALE), fmt(height * SCALE)),
        # 片段已是画布帧（y 向下、按 C 居中），原样进画布；上面 parts 的两处 y 也
        # 都按 C_y - y_projectPoint 算过，故几何与件号/窗口标记同帧，不会互相错开。
        fragment,
    ]
    parts.extend(callout_svg)
    parts.extend(marker_svg)
    parts.append("</svg>")
    return "".join(parts), {
        "center": center,
        "bbox": [round(min_x, 4), round(min_y, 4), round(width, 4), round(height, 4)],
        "anchors": anchors,
        "parts": part_metadata(shapes, part_bounds, center),
        "warnings": callout_warnings,
    }


def main():
    template_path = os.path.join(OUTPUT_DIR, TEMPLATE_FILENAME)
    # 三处文本写出都显式指定 UTF-8：默认编码取宿主 locale（LANG=C 时为 ascii），
    # 写含中文标注的 manifest 会 UnicodeEncodeError 退出码 1。
    with open(template_path, "w", encoding="utf-8") as handle:
        handle.write(MINIMAL_TEMPLATE)

    transient_dir = os.path.join(OUTPUT_DIR, TRANSIENT_DIRNAME)
    os.makedirs(transient_dir, exist_ok=True)
    doc = App.newDocument("structure_figure")
    # TechDraw 拷贝模板以文档 TransientDir 为基准；FreeCAD 只在自身缓存目录可写时
    # 才派生它，沙箱拒绝写缓存时它保持空串、拷贝落到根目录（/）失败，故显式指向
    # outputDir 内的可写子目录。
    doc.TransientDir = transient_dir

    shape_objs = []
    shapes = []
    for index, model_path in enumerate(MODEL_PATHS):
        shape = Part.read(model_path)
        if shape is None or shape.isNull():
            raise RuntimeError("无法载入模型或模型为空：%s" % model_path)
        shape_obj = doc.addObject("Part::Feature", "Model_%d" % index)
        shape_obj.Shape = shape
        shape_objs.append(shape_obj)
        shapes.append(shape)
    doc.recompute()
    verify_callout_owners(shapes)

    page = doc.addObject("TechDraw::DrawPage", "Page")
    template = doc.addObject("TechDraw::DrawSVGTemplate", "Template")
    template.Template = template_path
    page.Template = template
    doc.recompute()

    manifest_views = []
    view_centers = {}
    for index, view_name in enumerate(VIEWS):
        view = make_view(doc, page, shape_objs, view_name, index)
        # 自动锚点以首个视图为选点依据；必须在任何 viewPartAsSvg 之前定稿，
        # 否则后续视图会按各自的投影重新选点，同一件号落到不同物理位置。
        if index == 0 and any(callout["point3d"] is None for callout in CALLOUTS):
            resolve_auto_anchors(shapes, view)
        svg_text, meta = build_view_svg(view, shapes, view_name)
        view_centers[view_name] = (view, meta["center"])
        svg_path = os.path.join(OUTPUT_DIR, SVG_FILENAMES[view_name])
        with open(svg_path, "w", encoding="utf-8") as handle:
            handle.write(svg_text)
        manifest_views.append(
            {
                "name": view_name,
                "kind": "view",
                "order": index,
                "path": svg_path,
                "bbox": meta["bbox"],
                "anchors": meta["anchors"],
                "parts": meta["parts"],
                "warnings": meta["warnings"],
            }
        )

    for index, detail in enumerate(DETAILS):
        # TS 层已校验 base 属于 views；这里再兜一次，避免把 KeyError 当成渲染失败抛出去。
        if detail["base"] not in view_centers:
            raise RuntimeError(
                "放大视图 %s 的 base=%s 不在本次渲染的视图里（%s）"
                % (DETAIL_FILENAMES[index], detail["base"], "、".join(VIEWS))
            )
        base_view, base_center = view_centers[detail["base"]]
        detail_view = make_detail_view(doc, page, base_view, base_center, detail, index)
        svg_text, meta = build_detail_view_svg(detail_view, detail, index)
        svg_path = os.path.join(OUTPUT_DIR, DETAIL_FILENAMES[index])
        with open(svg_path, "w", encoding="utf-8") as handle:
            handle.write(svg_text)
        manifest_views.append(
            {
                "name": "detail%d" % (index + 1),
                "kind": "detail",
                "order": len(manifest_views),
                "path": svg_path,
                "bbox": meta["bbox"],
                "anchors": [],
                # 放大视图是基视图上某个模型坐标窗口的放大，没有独立的零件投影
                # 占位、也不放件号；空数组与普通视图的字段保持对称，消费方不必按
                # kind 分支。
                "parts": [],
                "warnings": [],
                "base": detail["base"],
                "center3d": detail["center3d"],
                "radiusMm": detail["radiusMm"],
                "scale": detail["scale"],
                "reference": detail["reference"],
            }
        )

    manifest = {
        "figureNumber": FIGURE_NUMBER,
        "modelPaths": MODEL_PATHS,
        "scale": SCALE,
        "showHidden": SHOW_HIDDEN,
        "generator": "freecad-structure",
        "views": manifest_views,
    }
    manifest_path = os.path.join(OUTPUT_DIR, MANIFEST_FILENAME)
    with open(manifest_path, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
    sys.stdout.write("STRUCTURE_OK %d views\n" % len(manifest_views))


# freecadcmd 吞掉未捕获异常并以退出码 0 结束（实测），故显式包裹 main：
# 失败时打印 traceback 到 stderr 并 sys.exit(1)，让渲染器据退出码 fail-loud。
try:
    main()
except SystemExit:
    raise
except BaseException:
    traceback.print_exc()
    sys.exit(1)
`
