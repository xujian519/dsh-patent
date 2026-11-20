import json
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
EXPLODED = bool(PARAMS["exploded"])
# 分解图的零件间隙：取各零件沿轴尺寸中位数的 1.2 倍。中位数而不是总跨度——
# 总跨度会把「零件本来就排得开」的装配体拉得更散，而中位尺寸跟着零件尺度走。
EXPLODED_GAP_RATIO = 1.2
# 单位装配轴向量投影后的长度（即视线与轴夹角的正弦）低于此值时主轴在投影面上
# 退化成一个点，分解图无从排布，当场报错。
EXPLODED_MIN_AXIS_PROJECTION = 0.2
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

    选完写回 CALLOUTS：之后的投影与 manifest 读的都是这一份。自动锚点取自该零件
    自己的顶点，故不需要归属核验。
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


def callout_fragments(project_point, canvas_extent, part_rects):
    """
    把件号投影到画布并为每个标号选位置、画引线与数字（y-down 画布帧）。

    project_point(part_index, point) 把模型点转到画布坐标：总装图是一个视图
    共享一个投影，分解图是每个零件各自的视图加上各自的排布位移，故由调用方
    给定，不在函数里假设。

    首选引线方向取自**所属零件的投影中心**指向锚点，而不是画布中心：零件正好
    位于图面中央时，「画布中心 → 锚点」是任意方向，标号会被丢进图形内部；以
    零件自身中心为基准，方向恒为从该零件向外。

    标号位置在该方向附近按 30° 步长、三档距离找第一个不压别的零件、不压已放
    标号的候选（见 choose_callout_position）。全部候选都不可行时退回首选方向的
    最近档——宁可略微压盖也不丢标号——并记一条警告。

    包围盒一律用 (min_x, max_x, min_y, max_y)（与 projected_bounds 同序）；
    part_rects 里的矩形用 (min_x, min_y, max_x, max_y)（与 rects_overlap 同序）。

    返回 (svg_片段列表, 锚点信息列表, 扩展包围盒, 警告列表)，包围盒同序。
    """
    fragments = []
    anchors = []
    warnings = []
    min_x, max_x, min_y, max_y = canvas_extent
    placed = []
    for callout in CALLOUTS:
        px, py, pz = callout["point3d"]
        owner = callout["model"]
        # 未声明归属时按单模型处理：目录批量已由工具层拒绝，走到这里必然是单模型。
        own_part = 0 if owner is None else owner
        anchor_x, anchor_y = project_point(own_part, App.Vector(px, py, pz))
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


def principal_axis(shapes):
    """
    求装配主轴：各零件质心点云的第一主成分方向（幂迭代求最大特征向量）。

    质心几乎共点时协方差塌成 0，主轴无从确定——分解图需要零件沿轴分开，
    这种情况当场报错，而不是编一个方向出来。
    """
    # Part.Shape 没有 CenterOfMass（实测 AttributeError），包围盒中心对所有形状
    # 都存在，且在「沿轴排布」这件事上与质心等效。
    centers = [shape.BoundBox.Center for shape in shapes]
    count = float(len(centers))
    mean_x = sum(point.x for point in centers) / count
    mean_y = sum(point.y for point in centers) / count
    mean_z = sum(point.z for point in centers) / count
    covariance = [[0.0, 0.0, 0.0], [0.0, 0.0, 0.0], [0.0, 0.0, 0.0]]
    for point in centers:
        delta = (point.x - mean_x, point.y - mean_y, point.z - mean_z)
        for row in range(3):
            for column in range(3):
                covariance[row][column] += delta[row] * delta[column]
    spread = max(abs(value) for row in covariance for value in row)
    if spread < 1e-9:
        raise RuntimeError("分解图需要各零件沿装配轴分开，但所有零件质心重合，无法确定装配轴")
    # 种子取协方差矩阵范数最大的那一列，而不是固定的 (1,1,1)：零件恰好沿 (1,-1,0)
    # 这类方向排布时协方差是该方向的秩 1 矩阵，与 (1,1,1) 正交，幂迭代第一步就塌成
    # 零向量，函数会静默返回一个与真实主轴垂直的方向。取列则不会：设该列为 s，
    # 第一步是 C·s = C²[:,j]，其第 j 个分量 (C²)_jj = Σ_k C_jk² = |s|² > 0。
    # （半正定只给出 xᵀCx = 0 则 Cx = 0，秩亏时零空间非平凡，故不能靠
    # 「C x = 0 则 x = 0」论证——那是正定矩阵的性质。）
    seed_column = max(
        range(3),
        key=lambda column: sum(covariance[row][column] ** 2 for row in range(3)),
    )
    seed = tuple(covariance[row][seed_column] for row in range(3))
    seed_norm = math.sqrt(sum(component * component for component in seed))
    vector = tuple(component / seed_norm for component in seed)
    for _ in range(64):
        next_vector = tuple(
            sum(covariance[row][column] * vector[column] for column in range(3))
            for row in range(3)
        )
        norm = math.sqrt(sum(component * component for component in next_vector))
        # 从非零的协方差列出发后，迭代向量始终落在 C 的值域里，而对半正定矩阵
        # 值域与零空间正交，故理论上不会再塌成零向量；这一条留作外部脚本的防御。
        if norm < 1e-12:
            raise RuntimeError("分解图的装配主轴退化，无法排布零件")
        vector = tuple(component / norm for component in next_vector)
    return vector


def exploded_part_offsets(shapes, view, axis):
    """
    求每个零件的画布位移：沿装配轴排成一维串后的位置减去原始位置。

    目标位置按装配序逐段累加——每段前进「该零件自身沿轴尺寸 + 间隙」，间隙取
    各零件沿轴尺寸中位数的 EXPLODED_GAP_RATIO 倍，整串再移回原点居中。用中位
    尺寸而不是串总长：总长会把本来就排得开的装配体拉得更散，中位尺寸跟着零件
    自身的尺度走。

    projectPoint 是线性的，故「每毫米轴长对应多少画布单位」由
    projectPoint(axis) − projectPoint(0) 一次求得，不必对每个零件重复投影。
    视线与主轴近乎平行时轴在投影面上退化成一个点，零件无从排开，当场报错。
    """
    origin = view.projectPoint(App.Vector(0.0, 0.0, 0.0))
    tip = view.projectPoint(App.Vector(axis[0], axis[1], axis[2]))
    axis_dx = tip.x - origin.x
    axis_dy = -(tip.y - origin.y)
    projected_length = math.hypot(axis_dx, axis_dy)
    if projected_length < EXPLODED_MIN_AXIS_PROJECTION:
        raise RuntimeError(
            "分解图的视线方向与装配轴过近（轴在投影面上只有 %.3f 毫米/毫米），"
            "主轴退化成点、零件排不开；换一个垂直于装配轴的视图"
            % projected_length
        )
    along = []
    for shape in shapes:
        box_center = shape.BoundBox.Center
        along.append(
            box_center.x * axis[0] + box_center.y * axis[1] + box_center.z * axis[2]
        )
    sizes = []
    for shape in shapes:
        box = shape.BoundBox
        sizes.append(
            abs(box.XLength * axis[0]) + abs(box.YLength * axis[1]) + abs(box.ZLength * axis[2])
        )
    ordered_sizes = sorted(sizes)
    middle = len(ordered_sizes) // 2
    if len(ordered_sizes) % 2 == 0:
        median = (ordered_sizes[middle - 1] + ordered_sizes[middle]) / 2.0
    else:
        median = ordered_sizes[middle]
    gap = median * EXPLODED_GAP_RATIO
    if gap <= 1e-6:
        gap = 1.0
    order = sorted(range(len(shapes)), key=lambda part_index: along[part_index])
    # 目标位置按「各零件沿轴尺寸 + 间隙」逐段累加，而不是 rank × gap：后者
    # 只在零件尺寸不超过间隙时成立，大件与小件混排时仍会互相压叠。整串再
    # 平移回原点，图面保持居中。
    targets = [0.0] * len(shapes)
    cursor = 0.0
    for part_index in order:
        targets[part_index] = cursor + sizes[part_index] / 2.0
        cursor += sizes[part_index] + gap
    for part_index in order:
        targets[part_index] -= cursor / 2.0
    offsets = [None] * len(shapes)
    for part_index in range(len(shapes)):
        displacement = targets[part_index] - along[part_index]
        offsets[part_index] = (displacement * axis_dx, displacement * axis_dy)
    return offsets


def part_metadata(shapes, part_bounds, center, layout_rects=None):
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
        if layout_rects is not None:
            # 分解图：占位取排布后的画布矩形，直接给出，不必再从 C 换算。
            rect = layout_rects[index]
            projected = [
                round(rect[0], 4),
                round(rect[1], 4),
                round(rect[2] - rect[0], 4),
                round(rect[3] - rect[1], 4),
            ]
        elif bounds is None:
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


def build_exploded_view_svg(doc, page, shape_objs, shapes, view_name, index):
    """
    逐件投影后沿装配轴排成一维串，生成一张分解图。

    每个零件单独一个 DrawViewPart（Source 只挂它自己），故 HLR 逐件进行、
    零件之间互不遮挡——总装图是「全部零件一次 HLR」，这是另一条路径，两者
    不可互换。各片段已按自身几何居中，排布只需在外层加平移。
    """
    axis = principal_axis(shapes)
    views = []
    centers = []
    bounds_list = []
    fragments = []
    for part_index, shape_obj in enumerate(shape_objs):
        part_view = make_view(doc, page, [shape_obj], view_name, index * 1000 + part_index)
        bounds, _ = projected_bounds(part_view, [shapes[part_index]])
        centers.append(((bounds[0] + bounds[1]) / 2.0, (bounds[2] + bounds[3]) / 2.0))
        fragment = TechDraw.viewPartAsSvg(part_view)
        if fragment is None or fragment.strip() == "":
            raise RuntimeError(
                "viewPartAsSvg 返回空片段：分解视图 %s 的零件 %d 未产生投影几何"
                % (view_name, part_index)
            )
        views.append(part_view)
        bounds_list.append(bounds)
        fragments.append(fragment)
    # 自动锚点的选点需要视图；逐件视图已建好，用首个零件视图作依据（其余视图
    # 投影同一个 3D 点，选点与总装图同源）。
    if any(callout["point3d"] is None for callout in CALLOUTS):
        resolve_auto_anchors(shapes, views[0])
    offsets = exploded_part_offsets(shapes, views[0], axis)
    # 排布后的逐零件画布占位（y-down）。
    rects = []
    for part_index in range(len(shapes)):
        c_x, c_y = centers[part_index]
        dx, dy = offsets[part_index]
        bounds = bounds_list[part_index]
        rects.append(
            (
                bounds[0] - c_x + dx,
                -(bounds[3] - c_y) + dy,
                bounds[1] - c_x + dx,
                -(bounds[2] - c_y) + dy,
            )
        )
    min_x = min(rect[0] for rect in rects) - CANVAS_PADDING
    min_y = min(rect[1] for rect in rects) - CANVAS_PADDING
    max_x = max(rect[2] for rect in rects) + CANVAS_PADDING
    max_y = max(rect[3] for rect in rects) + CANVAS_PADDING

    def project_point(part_index, point):
        c_x, c_y = centers[part_index]
        dx, dy = offsets[part_index]
        projected = views[part_index].projectPoint(point)
        return projected.x - c_x + dx, -(projected.y - c_y) + dy

    callout_svg, anchors, extent, callout_warnings = callout_fragments(
        project_point, (min_x, max_x, min_y, max_y), rects
    )
    min_x = min(min_x, extent[0] - CANVAS_PADDING)
    max_x = max(max_x, extent[1] + CANVAS_PADDING)
    min_y = min(min_y, extent[2] - CANVAS_PADDING)
    max_y = max(max_y, extent[3] + CANVAS_PADDING)
    width = max_x - min_x
    height = max_y - min_y
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="%s %s %s %s" '
        'width="%smm" height="%smm">'
        % (fmt(min_x), fmt(min_y), fmt(width), fmt(height), fmt(width * SCALE), fmt(height * SCALE)),
    ]
    for part_index, fragment in enumerate(fragments):
        dx, dy = offsets[part_index]
        parts.append('<g transform="translate(%s %s)">%s</g>' % (fmt(dx), fmt(dy), fragment))
    parts.extend(callout_svg)
    parts.append("</svg>")
    return "".join(parts), {
        "center": ((min_x + max_x) / 2.0, (min_y + max_y) / 2.0),
        "bbox": [round(min_x, 4), round(min_y, 4), round(width, 4), round(height, 4)],
        "anchors": anchors,
        "parts": part_metadata(shapes, bounds_list, (0.0, 0.0), rects),
        "warnings": callout_warnings,
        "exploded": True,
    }


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
    def project_point(part_index, point):
        projected = view.projectPoint(point)
        return projected.x - c_x, -(projected.y - c_y)

    canvas_extent = (bbox[0] - c_x, bbox[1] - c_x, -(bbox[3] - c_y), -(bbox[2] - c_y))
    callout_svg, anchors, extent, callout_warnings = callout_fragments(
        project_point, canvas_extent, part_rects_in_canvas(part_bounds, center)
    )
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
    if EXPLODED and len(MODEL_PATHS) < 2:
        raise RuntimeError(
            "分解图需要至少两个零件（用 model_paths 传多个文件），单模型没有可分解的装配关系"
        )
    if EXPLODED and DETAILS:
        raise RuntimeError(
            "分解图不支持 details：放大窗口按模型坐标给出，而分解图每个零件各有一个视图，没有统一的基视图"
        )
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
        if EXPLODED:
            # 分解图逐件建视图，自动锚点在建完首个零件视图后定稿，见该函数内。
            svg_text, meta = build_exploded_view_svg(doc, page, shape_objs, shapes, view_name, index)
        else:
            view = make_view(doc, page, shape_objs, view_name, index)
            # 自动锚点以首个视图为选点依据；必须在任何 viewPartAsSvg 之前定稿，
            # 否则后续视图会按各自的投影重新选点，同一件号落到不同物理位置。
            if index == 0 and any(callout["point3d"] is None for callout in CALLOUTS):
                resolve_auto_anchors(shapes, view)
            svg_text, meta = build_view_svg(view, shapes, view_name)
            # 放大窗口挂在这个基视图上，分解图没有单一基视图（逐件各一个），
            # 故只在总装路径登记；分解图 + details 在 main 开头即被拒绝。
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
                "exploded": meta.get("exploded", False),
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
