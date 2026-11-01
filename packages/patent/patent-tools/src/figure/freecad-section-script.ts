/**
 * FreeCAD 无文档剖切脚本构建器（纯函数，无 IO）。
 *
 * `buildSectionScript` 把一次剖切几何请求渲染成一段自包含的 Python 源码；渲染器把源码
 * 写入 outputDir 内的临时 .py 再 `freecadcmd <script.py>` 执行。脚本只依赖 FreeCAD 1.1
 * 实测存在的 API：`Part.read`、`Shape.slice`、`Part.Face`、`Part.makeFace` —— **不建
 * Document/Page/模板，也不写 TransientDir**（实测这三者都不需要：`slice` 与成面都只是
 * 几何运算）。脚本只 import `Part`，连 `TechDraw` 都不加载。
 *
 * 写到 outputDir 的 `section-geometry.json` 由 `freecad-section-geometry.ts` 解析。
 *
 * 三条实测约束（FreeCAD 1.1.3，freecadcmd 无界面执行）：
 *
 * 1. **平面位于实体之外时 `slice` 返回空列表**（既不是 Null 也不抛异常），故脚本显式
 *    判定环数为 0 并报错 —— 否则会静默产出一张空图。
 * 2. **`Shape.isNull()` 不足以判定空结果**：不相交布尔的返回是 `Compound`、`isNull()` 为
 *    False、`Solids` 为 0（实测），故另按实体数判定。
 * 3. **`Part.makeFace([])` 抛出的不是 Python `Exception`**（实测 `Base.FreeCADError`），
 *    空环列表会穿透 `except Exception`；故成面之前先判空，且最外层用 `BaseException`。
 *
 * 离散化（`freecad-section-geometry.ts` 的常量随 payload 传入）分三档：直线取两端点
 * （折线轮廓逐值精确）；圆弧按固定角度步长（相对面积误差与半径无关）；其余曲线（椭圆、
 * B 样条）按弦长步长 —— `discretize(Number=N)` 对直线会给出 N 个共线点、`discretize(
 * Distance=d)` 把 d 当步长（6 毫米直线在 d=0.01 时给出 601 点），两者都不适合混合轮廓。
 *
 * 线框的边序可靠但**单条边的朝向不统一**（实测：矩形 4 条边里第 2 条的起点与第 1 条的
 * 起点重合），故脚本按要求逐边衔接成环：每次取与当前末点最近的一端接上，距离相等时取
 * 较小的边序号，同一输入恒得同一组点列。
 * @module @deepseek-ai/dsh-patent-tools/figure/freecad-section-script
 */

import {
  SECTION_ARC_STEP_DEG,
  SECTION_CHORD_STEP_MM,
  SECTION_COORD_DECIMALS,
  SECTION_MAX_EDGE_SAMPLES,
  type SectionFrame,
} from './freecad-section-geometry.ts'

/** 脚本写出的剖切几何文件名（渲染器按它读回结果）。 */
export const SECTION_GEOMETRY_FILENAME = 'section-geometry.json'

/** 构建剖切脚本的入参。 */
type SectionScriptParams = {
  /** 模型文件绝对路径（STEP/IGES/BREP，由 Part.read 载入）。 */
  modelPath: string
  /** 视图帧（由 {@link resolveSectionFrame} 解析；脚本只校验单位长度并照用）。 */
  frame: SectionFrame
  /** 输出目录绝对路径（渲染器负责创建）。 */
  outputDir: string
}

/** 脚本 payload（经双重 JSON 序列化内嵌，规避路径/数值的转义问题）。 */
type ScriptPayload = {
  modelPath: string
  outputDir: string
  geometryFilename: string
  origin: readonly number[]
  normal: readonly number[]
  right: readonly number[]
  down: readonly number[]
  arcStepDeg: number
  chordStepMm: number
  maxEdgeSamples: number
  coordDecimals: number
}

/**
 * 构建 FreeCAD 无文档剖切脚本源码。
 *
 * 纯函数：相同入参恒返回相同 Python 文本，不做任何 IO、不接触 FreeCAD。
 * 脚本执行后在 outputDir 写出 `section-geometry.json`（模型信息、视图帧、逐环点列与
 * OCCT 面面积、整块切片成面面积），并打印 `SECTION_OK <环数>`。
 * @param params - 模型路径、视图帧与输出目录。
 * @returns 可交给 `freecadcmd` 执行的 Python 源码。
 */
export function buildSectionScript(params: SectionScriptParams): string {
  const payload: ScriptPayload = {
    modelPath: params.modelPath,
    outputDir: params.outputDir,
    geometryFilename: SECTION_GEOMETRY_FILENAME,
    origin: params.frame.origin,
    normal: params.frame.normal,
    right: params.frame.right,
    down: params.frame.down,
    arcStepDeg: SECTION_ARC_STEP_DEG,
    chordStepMm: SECTION_CHORD_STEP_MM,
    maxEdgeSamples: SECTION_MAX_EDGE_SAMPLES,
    coordDecimals: SECTION_COORD_DECIMALS,
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
from FreeCAD import Vector

PARAMS = json.loads(__PAYLOAD_LITERAL__)

MODEL_PATH = PARAMS["modelPath"]
OUTPUT_DIR = PARAMS["outputDir"]
GEOMETRY_FILENAME = PARAMS["geometryFilename"]
ORIGIN = Vector(PARAMS["origin"][0], PARAMS["origin"][1], PARAMS["origin"][2])
NORMAL = Vector(PARAMS["normal"][0], PARAMS["normal"][1], PARAMS["normal"][2])
RIGHT = Vector(PARAMS["right"][0], PARAMS["right"][1], PARAMS["right"][2])
DOWN = Vector(PARAMS["down"][0], PARAMS["down"][1], PARAMS["down"][2])
ARC_STEP_RAD = math.radians(float(PARAMS["arcStepDeg"]))
CHORD_STEP_MM = float(PARAMS["chordStepMm"])
MAX_EDGE_SAMPLES = int(PARAMS["maxEdgeSamples"])
COORD_DECIMALS = int(PARAMS["coordDecimals"])

# 衔接容差：OCCT 共享顶点时两点逐值相同，此处只容忍浮点噪声。
JOIN_TOLERANCE_MM = 1e-7


def check_frame():
    """校验视图帧是三个正交单位向量（TS 侧已归一化；跨进程再验一次，失败即报错）。"""
    for name, vector in (("normal", NORMAL), ("right", RIGHT), ("down", DOWN)):
        if abs(vector.Length - 1.0) > 1e-9:
            raise RuntimeError("视图帧 %s 不是单位向量：%s" % (name, vector))
    if abs(NORMAL.dot(RIGHT)) > 1e-9 or abs(NORMAL.dot(DOWN)) > 1e-9 or abs(RIGHT.dot(DOWN)) > 1e-9:
        raise RuntimeError("视图帧的三个基向量不两两正交")


def edge_points(edge):
    """
    单条边的采样点，沿 edge 的参数方向、**不含末点**（环由下一条边接续，末点会与下一条边的首点重合）。

    直线取两端点；圆弧按 ARC_STEP_RAD 的角度步长（相对面积误差与半径无关）；其余曲线按弦长步长。
    """
    first = float(edge.FirstParameter)
    last = float(edge.LastParameter)
    name = type(edge.Curve).__name__
    if name == "Line":
        return [edge.valueAt(first), edge.valueAt(last)]
    if name == "Circle":
        count = int(math.ceil(abs(last - first) / ARC_STEP_RAD))
    else:
        count = int(math.ceil(float(edge.Length) / CHORD_STEP_MM))
    count = max(2, min(count, MAX_EDGE_SAMPLES))
    step = (last - first) / count
    return [edge.valueAt(first + step * index) for index in range(count)]


def wire_loop(wire):
    """把一条闭合线框离散成有序点列：逐边衔接（边的朝向不统一，见模块说明）。"""
    pending = [edge_points(edge) for edge in wire.Edges]
    if not pending:
        raise RuntimeError("剖切轮廓线框不含边")
    loop = list(pending.pop(0))
    while pending:
        tail = loop[-1]
        best_index = 0
        best_at_head = True
        best_distance = None
        for index, points in enumerate(pending):
            head_distance = (points[0] - tail).Length
            tail_distance = (points[-1] - tail).Length
            at_head = head_distance <= tail_distance
            distance = head_distance if at_head else tail_distance
            if best_distance is None or distance < best_distance:
                best_distance = distance
                best_index = index
                best_at_head = at_head
        segment = list(pending.pop(best_index))
        if not best_at_head:
            segment.reverse()
        if (segment[0] - tail).Length <= JOIN_TOLERANCE_MM:
            segment = segment[1:]
        loop.extend(segment)
    if len(loop) > 1 and (loop[-1] - loop[0]).Length <= JOIN_TOLERANCE_MM:
        loop.pop()
    return loop


def frame_point(point):
    """世界坐标 → 视图帧（毫米）：x 向右、y 向下，相对平面内一点量取。"""
    delta = point - ORIGIN
    return [round(delta.dot(RIGHT), COORD_DECIMALS), round(delta.dot(DOWN), COORD_DECIMALS)]


def ring_record(wire, index):
    """一个环的顶点与 OCCT 面面积（面积是后续面积核对的精确基准）。"""
    points = wire_loop(wire)
    if len(points) < 3:
        raise RuntimeError("剖切轮廓 #%d 的离散点数少于 3：%d" % (index + 1, len(points)))
    face = Part.Face(wire)
    if face.isNull():
        raise RuntimeError("剖切轮廓 #%d 无法成面：轮廓可能非平面或自交" % (index + 1))
    return {
        "points_mm": [frame_point(point) for point in points],
        "closed": True,
        "area_mm2": round(face.Area, 6),
    }


def slice_face_area(wires):
    """整块切片成面面积（独立于逐环面积的第二个量测）；空环列表或成面失败时返回 None。"""
    if len(wires) == 0:
        return None
    try:
        face = Part.makeFace(wires, "Part::FaceMakerBullseye")
    except BaseException:
        return None
    if face.isNull():
        return None
    return round(face.Area, 6)


def main():
    check_frame()
    shape = Part.read(MODEL_PATH)
    if shape is None or shape.isNull():
        raise RuntimeError("无法载入模型或模型为空：%s" % MODEL_PATH)
    if len(shape.Solids) == 0:
        raise RuntimeError("模型不含任何实体（Solids = 0）：%s" % MODEL_PATH)

    distance = ORIGIN.dot(NORMAL)
    wires = list(shape.slice(NORMAL, distance))
    if len(wires) == 0:
        raise RuntimeError(
            "剖切平面未与模型相交：origin=[%s, %s, %s] normal=[%s, %s, %s]"
            % (ORIGIN.x, ORIGIN.y, ORIGIN.z, NORMAL.x, NORMAL.y, NORMAL.z)
        )

    rings = []
    for index, wire in enumerate(wires):
        if not wire.isClosed():
            raise RuntimeError("剖切轮廓 #%d 不是闭合线框：剖切面没有切出闭合轮廓" % (index + 1))
        rings.append(ring_record(wire, index))

    box = shape.BoundBox
    payload = {
        "model": {
            "path": MODEL_PATH,
            "solids": len(shape.Solids),
            "bound_box_mm": {
                "min": [box.XMin, box.YMin, box.ZMin],
                "max": [box.XMax, box.YMax, box.ZMax],
            },
        },
        "plane": {
            "origin": [ORIGIN.x, ORIGIN.y, ORIGIN.z],
            "normal": [NORMAL.x, NORMAL.y, NORMAL.z],
            "right": [RIGHT.x, RIGHT.y, RIGHT.z],
            "down": [DOWN.x, DOWN.y, DOWN.z],
            "distance": distance,
        },
        "rings": rings,
        "slice_face_area_mm2": slice_face_area(wires),
    }
    with open(os.path.join(OUTPUT_DIR, GEOMETRY_FILENAME), "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=1)
    sys.stdout.write("SECTION_OK %d rings\n" % len(rings))


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
