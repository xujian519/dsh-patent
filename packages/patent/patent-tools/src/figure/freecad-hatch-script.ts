/**
 * FreeCAD 剖面线脚本构建器（纯函数，无 IO）。
 *
 * `buildHatchScript` 把一次剖面线请求渲染成自包含的 Python 源码；渲染器把源码写入 outputDir
 * 内的临时 .py 再 `freecadcmd <script.py>` 执行。脚本用 `TechDraw.makeGeomHatch` 在**视图帧**
 * 里生成剖面线：材料区域的二维网格点直接写成 z=0 的 XY 平面坐标（三条硬约束与两条静默失败
 * 路径见 `freecad-hatch-geometry.ts` 的模块说明）。
 *
 * 脚本**不建 Document/Page/模板**：`makeGeomHatch` 是几何函数，只要有一个 `Part.Face` 就去
 * 不需要任何绘图对象（实测）；`TechDraw` 模块只用来取这一个函数。
 *
 * 面由**与图上同一个离散轮廓**（`buildSectionScript` 产出的环）重建，故剖面线端点正好落在
 * 画出来的轮廓线上，不存在「按精确曲线裁剪、却画的是内接多边形」造成的伸出。
 *
 * 脚本不会静默产出「有轮廓、没剖面线」的图：`makeGeomHatch` 对「图案名不在 .pat 里」与
 * 「patFile 不可读」返回 `None`、对「面不在 z=0 的 XY 平面」返回空 Compound（实测），脚本对
 * 两者都显式抛错并 `sys.exit(1)`。
 *
 * 写到 outputDir 的 `section-hatch.json` 由 `freecad-hatch-geometry.ts` 解析；同目录还会写出
 * 本次生成的 `.pat`（图案名固定，`delta = 1` 使 `patScale` 等于毫米间距）。
 * @module @deepseek-ai/dsh-patent-tools/figure/freecad-hatch-script
 */

import { HATCH_COORD_DECIMALS, type HatchPattern, type HatchRegion } from './freecad-hatch-geometry.ts'

/** 脚本写出的剖面线几何文件名（渲染器按它读回结果）。 */
export const HATCH_GEOMETRY_FILENAME = 'section-hatch.json'

/** 脚本生成的 `.pat` 文件名（写在输出目录内，随产物一起留档）。 */
export const HATCH_PAT_FILENAME = 'section-hatch.pat'

/** 构建剖面线脚本的入参。 */
type HatchScriptParams = {
  /** 已解析的剖面线请求（含 `.pat` 文本与 patScale）。 */
  pattern: HatchPattern
  /** 材料区域（视图帧毫米）。 */
  regions: readonly HatchRegion[]
  /** 输出目录绝对路径（渲染器负责创建）。 */
  outputDir: string
}

/** 脚本 payload（经双重 JSON 序列化内嵌，规避路径/数值的转义问题）。 */
type ScriptPayload = {
  outputDir: string
  geometryFilename: string
  patFilename: string
  patText: string
  patName: string
  patAngleDeg: number
  patScale: number
  coordDecimals: number
  regions: { outline: (readonly [number, number])[]; holes: (readonly [number, number])[][] }[]
}

/**
 * 构建 FreeCAD 剖面线脚本源码。
 *
 * 纯函数：相同入参恒返回相同 Python 文本，不做任何 IO、不接触 FreeCAD。脚本执行后在
 * outputDir 写出 `section-hatch.json`（逐区域的线段、脚本回填的图案参数）与 `section-hatch.pat`，
 * 并打印 `HATCH_OK <线段数>`。
 * @param params - 图案、材料区域与输出目录。
 * @returns 可交给 `freecadcmd` 执行的 Python 源码。
 */
export function buildHatchScript(params: HatchScriptParams): string {
  const payload: ScriptPayload = {
    outputDir: params.outputDir,
    geometryFilename: HATCH_GEOMETRY_FILENAME,
    patFilename: HATCH_PAT_FILENAME,
    patText: params.pattern.patText,
    patName: params.pattern.patName,
    patAngleDeg: params.pattern.patAngleDeg,
    patScale: params.pattern.patScale,
    coordDecimals: HATCH_COORD_DECIMALS,
    regions: params.regions.map(region => ({
      outline: region.outline.map(point => [point[0], point[1]] as const),
      holes: (region.holes ?? []).map(hole => hole.map(point => [point[0], point[1]] as const)),
    })),
  }
  // 双重序列化：内层是脚本要 json.loads 的对象文本，外层把它转成一个 Python
  // 双引号字符串字面量（JSON 与 Python 的 \" \\ \n \uXXXX 转义规则一致）。
  return PYTHON_TEMPLATE.replace('__PAYLOAD_LITERAL__', JSON.stringify(JSON.stringify(payload)))
}

/**
 * Python 脚本模板（`__PAYLOAD_LITERAL__` 处内嵌参数）。
 *
 * 只使用本机 FreeCAD 1.1.3 实测存在的 API；不需要 Document/Page/模板/TransientDir。
 */
const PYTHON_TEMPLATE = String.raw`import json
import math
import os
import sys
import traceback

import Part
import TechDraw
from FreeCAD import Vector

PARAMS = json.loads(__PAYLOAD_LITERAL__)

OUTPUT_DIR = PARAMS["outputDir"]
GEOMETRY_FILENAME = PARAMS["geometryFilename"]
PAT_FILENAME = PARAMS["patFilename"]
PAT_TEXT = PARAMS["patText"]
PAT_NAME = PARAMS["patName"]
PAT_ANGLE_DEG = float(PARAMS["patAngleDeg"])
PAT_SCALE = float(PARAMS["patScale"])
COORD_DECIMALS = int(PARAMS["coordDecimals"])
REGIONS = PARAMS["regions"]

PAT_PATH = os.path.join(OUTPUT_DIR, PAT_FILENAME)


def closed_wire(points):
    """二维网格点 → z=0 的 XY 平面闭合线框（面的平面由构造满足）。"""
    if len(points) < 3:
        raise RuntimeError("轮廓顶点少于 3 个，无法成面")
    vectors = [Vector(float(x), float(y), 0.0) for x, y in points]
    vectors.append(vectors[0])
    wire = Part.makePolygon(vectors)
    if len(wire.Edges) == 0:
        raise RuntimeError("轮廓线框不含边")
    return wire


def region_face(region, index):
    """
    材料区域 → Part.Face。

    孔环必须与外环一并交给 Bullseye：makeGeomHatch 只接受 Part.Face（传 Compound/Shape 抛
    TypeError），而剖面线正是按这个面裁剪的 —— 少了孔环，孔里就会被打上剖面线。
    """
    wires = [closed_wire(region["outline"])]
    for hole in region["holes"]:
        wires.append(closed_wire(hole))
    try:
        face = Part.makeFace(wires, "Part::FaceMakerBullseye")
    except BaseException as exc:
        raise RuntimeError("区域 #%d 无法成面：%s" % (index + 1, exc))
    if face.isNull():
        raise RuntimeError("区域 #%d 成面得到空形状（轮廓可能自交或非平面）" % (index + 1))
    return face


def region_segments(face, index):
    """
    一个区域的剖面线段（视图帧毫米）。

    makeGeomHatch 的失败是静默的，故两处都显式报错：图案名不在 .pat 里或 patFile 不可读时
    返回 None；面不在 z=0 的 XY 平面时返回空 Compound（0 条边）。
    """
    compound = TechDraw.makeGeomHatch(face, PAT_SCALE, PAT_NAME, PAT_PATH)
    if compound is None:
        raise RuntimeError(
            "区域 #%d 的剖面线生成返回 None：图案名 %s 不在 %s 里，或该文件不可读"
            % (index + 1, PAT_NAME, PAT_PATH)
        )
    edges = list(compound.Edges)
    if len(edges) == 0:
        raise RuntimeError(
            "区域 #%d 的剖面线为 0 条：面不在 z=0 的 XY 平面时 makeGeomHatch 返回空 Compound（实测）"
            % (index + 1)
        )
    segments = []
    for edge in edges:
        vertexes = edge.Vertexes
        if len(vertexes) < 2:
            raise RuntimeError("区域 #%d 有一条剖面线的端点数少于 2" % (index + 1))
        segments.append([
            [round(vertexes[0].Point.x, COORD_DECIMALS), round(vertexes[0].Point.y, COORD_DECIMALS)],
            [round(vertexes[-1].Point.x, COORD_DECIMALS), round(vertexes[-1].Point.y, COORD_DECIMALS)],
        ])
    return segments


def main():
    if not math.isfinite(PAT_SCALE) or PAT_SCALE <= 0:
        raise RuntimeError("patScale 必须是正有限数：%s" % PAT_SCALE)
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with open(PAT_PATH, "w", encoding="ascii") as handle:
        handle.write(PAT_TEXT)

    records = []
    total = 0
    for index, region in enumerate(REGIONS):
        segments = region_segments(region_face(region, index), index)
        total += len(segments)
        records.append({"segments_mm": segments})

    payload = {
        "pattern": {"angle_deg": PAT_ANGLE_DEG, "pat_scale": PAT_SCALE, "pat_name": PAT_NAME},
        "regions": records,
    }
    with open(os.path.join(OUTPUT_DIR, GEOMETRY_FILENAME), "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=1)
    sys.stdout.write("HATCH_OK %d segments\n" % total)


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
