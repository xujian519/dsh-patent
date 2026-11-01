/**
 * `generate_patent_figure` 的模型输入 schema：各图型自己的输入结构，以及单图与 panels
 * 共用的落版结果 schema。
 *
 * 枚举取值直接引用各绘制模块导出的名字表（内置模板、电气符号种类、外观视图名、目标法域），
 * 使 schema 与绘制实现共用同一份取值来源。
 * @module @deepseek-ai/dsh-patent-tools/tool/figure-tool-schemas
 */

import { DIAGRAM_TEMPLATE_NAMES } from '../figure/dot-builder.ts'
import { TARGET_OFFICES } from '../figure/office-profile.ts'
import { APPEARANCE_VIEW_NAMES_ALL, CIRCUIT_SYMBOL_KIND_NAMES } from '../figure/vector-figure-build.ts'

/** 落版结果 schema（单图与 panels 共用）。 */
export const LAYOUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    office: { type: 'string', required: true, enum: TARGET_OFFICES, description: '目标法域' },
    pageScale: { type: 'number', required: true, description: '落版缩放比' },
    placedWidthMm: { type: 'number', required: true, description: '落版后图形宽（毫米）' },
    placedHeightMm: { type: 'number', required: true, description: '落版后图形高（毫米）' },
    charHeightMm: { type: 'number', description: '落版后图中数字与字母字高（毫米）' },
    reducedCharHeightMm: { type: 'number', description: '再缩小到三分之二后的字高（毫米）' },
    caption: { type: 'string', description: '落版页上的图号' },
    sheetNumber: { type: 'string', required: true, description: '落版页上的页码' },
  },
} as const


/** 电路图元件条目 schema。 */
const CIRCUIT_COMPONENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    kind: { type: 'string', required: true, enum: CIRCUIT_SYMBOL_KIND_NAMES, description: '电气符号种类' },
    label: { type: 'string', description: '元件名（简短词）' },
    col: { type: 'integer', required: true, description: '网格列（0 起）' },
    row: { type: 'integer', required: true, description: '网格行（0 起）' },
  },
} as const

/** 电路图输入 schema。 */
export const CIRCUIT_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    components: { type: 'array', required: true, items: CIRCUIT_COMPONENT_SCHEMA },
    connections: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { from: { type: 'string', required: true }, to: { type: 'string', required: true }, label: { type: 'string' } },
      },
    },
    cell_width_mm: { type: 'number', description: '单元格宽（毫米），默认 18' },
    cell_height_mm: { type: 'number', description: '单元格高（毫米），默认 14' },
  },
} as const

/** 曲线图数据序列 schema。 */
const PLOT_SERIES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    points: { type: 'array', required: true, items: { type: 'array', items: { type: 'number' } } },
    marker: { type: 'string', enum: ['none', 'circle', 'square', 'triangle'] },
  },
} as const

/** 曲线图输入 schema。 */
export const PLOT_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    series: { type: 'array', required: true, items: PLOT_SERIES_SCHEMA },
    x_label: { type: 'string', required: true },
    y_label: { type: 'string', required: true },
    x_unit: { type: 'string' },
    y_unit: { type: 'string' },
    x_range: { type: 'array', items: { type: 'number' } },
    y_range: { type: 'array', items: { type: 'number' } },
    tick_count: { type: 'integer', description: '每轴刻度数（2..11），默认 5' },
    show_grid: { type: 'boolean', description: '是否画网格线，默认 false' },
    width_mm: { type: 'number', description: '画布宽（毫米），默认 120' },
    height_mm: { type: 'number', description: '画布高（毫米），默认 80' },
  },
} as const

/** 二维点 schema（[x, y]，毫米）。 */
const POINT_SCHEMA = { type: 'array', required: true, items: { type: 'number' } } as const

/**
 * 三维坐标 schema（剖切平面参数与零件尺寸共用；模型坐标不是图面坐标，故与 {@link POINT_SCHEMA} 分开）。
 * 必填与否由各字段自己写 `required: true`：本 schema 的三个使用者（方向、参考方向、零件尺寸）里只有前两个必填。
 */
const VEC3_SCHEMA = { type: 'array', items: { type: 'number' } } as const

/** 剖切来源 schema（`sections.source`）：模型文件 + 剖切平面 + 图面比例。 */
const SECTION_SOURCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    model_path: { type: 'string', required: true, description: '模型文件路径（STEP/IGES/BREP），工作区相对或绝对' },
    plane: {
      type: 'object',
      required: true,
      additionalProperties: false,
      properties: {
        origin: { ...VEC3_SCHEMA, required: true, description: '剖切平面上的一点（毫米，模型坐标）' },
        normal: { ...VEC3_SCHEMA, required: true, description: '剖切平面法向（任意非零长度，模型坐标）；观察者位于法向正侧，沿 −normal 方向看剖切面' },
        reference: { ...VEC3_SCHEMA, description: '图面「向右」参考方向（任意非零、与法向不平行）；缺省按 +X → +Y → +Z 取第一个可用轴。它决定视图绕法向的旋转，要复现同一张图就显式给出' },
      },
    },
    scale: { type: 'number', description: '图面比例（默认 1）：切出的轮廓与剖面线坐标乘以它；labels/centerlines/cutting_marks 请按同一比例给图面坐标' },
    part_size_mm: { ...VEC3_SCHEMA, description: '零件整体尺寸（毫米，三个数，顺序无关）：与模型包围盒比对，不符即报错。STEP/IGES/BREP 的单位声明不一致会让图面比例整体错，给出它才能挡住（不核对就画出一张比例错的图）' },
  },
} as const

/** 剖视图输入 schema。 */
export const SECTION_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    outline: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: '外轮廓顶点对数组（[[x,y],…]）' },
    parts: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string', description: '零件名（数字落在轮廓包围盒右上角之外，自轮廓重心引细实线相连；同一零件由多个轮廓拼成时不要用本字段，用 labels 指定唯一标号落点）' },
          outline: { type: 'array', items: { type: 'array', items: { type: 'number' } }, description: '零件闭合轮廓（[[x,y],…]，至少 3 点）；给了 source 时不要给本字段（轮廓由模型切出）' },
          anchor: { type: 'array', items: { type: 'number' }, description: '落在本零件所属材料区域内的图面坐标点（毫米，已含 scale）：给 source 时必填，用它把本项与模型切出的材料区域对上（区域顺序由 OCCT 决定，不能按序号对）' },
          hatch: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  angle_deg: { type: 'number', description: '剖面线倾角（度），默认 45' },
                  spacing_mm: { type: 'number', description: '剖面线间距（毫米），默认 3' },
                  direction: { type: 'string', enum: ['forward', 'backward'], description: '相邻零件取相反方向或不同间距以区分' },
                },
              },
              { type: 'string', enum: ['none'] },
            ],
            description: '剖面线参数；"none" 表示该轮廓不是被剖切实体（轴线、引出线、非剖切件），只画轮廓。缺省按 45°/3mm 打剖面线',
          },
          stroke_width_mm: { type: 'number', description: '该零件轮廓的粗实线线宽（毫米），不小于 0.18（GB/T 4457.4）；缺省用顶层 stroke_width_mm' },
        },
      },
      description: '被剖切零件轮廓（同一零件的多个轮廓各给一段）',
    },
    source: { ...SECTION_SOURCE_SCHEMA, description: '剖切来源：从 CAD 模型切出零件轮廓（含孔）与剖面线，代替手写坐标；给出时 parts 只给 label、hatch、stroke_width_mm 与 anchor，不要给 outline' },
    labels: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true, description: '标号文本（阿拉伯数字）' },
          at: { ...POINT_SCHEMA, description: '数字视觉中心落点（毫米），应在零件轮廓之外' },
          from: { ...POINT_SCHEMA, description: '引线起点：零件上的指称点（毫米）；给出时自该点画细实线到数字外框，数字不被线条贯穿' },
        },
      },
      description: '引线标号：数字置于零件轮廓之外并以引线相连（一个零件由多个轮廓拼成时用本字段，避免每个轮廓各画一处标号）',
    },
    centerlines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { from: POINT_SCHEMA, to: POINT_SCHEMA },
      },
      description: '中心线（细点划线）：轴类零件的轴线；不要用细长多边形伪造',
    },
    cutting_marks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true, description: '剖切标记字母（如 A）' },
          from: POINT_SCHEMA,
          to: POINT_SCHEMA,
          arrow: { type: 'string', required: true, enum: ['left', 'right', 'up', 'down'], description: '投射方向' },
        },
      },
    },
    break_lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { ...POINT_SCHEMA, required: true, description: '断口起点（图面毫米）' },
          to: { ...POINT_SCHEMA, required: true, description: '断口终点：与起点不同，方向即断口横跨方向' },
          style: { type: 'string', enum: ['zigzag', 'wavy'], description: '线型：锯齿（默认）或波浪' },
          amplitude_mm: { type: 'number', description: '齿高/波幅（毫米），默认 1.5' },
          teeth: { type: 'integer', description: '锯齿数/波数，默认按断口长度每 3 毫米一个（至少 2）' },
        },
      },
      description: '断裂线（折断线，细实线）：长零件省略中段时，在被断开的两端各画一条；零件轮廓由调用方拆成两段给出，断口之间留出省略区',
    },
    label_font_size_mm: { type: 'number', description: '图面字号（毫米），默认 3.5；附图标记与剖切字母同用' },
    stroke_width_mm: { type: 'number', description: '轮廓与剖切位置线的粗实线线宽（毫米），不小于 0.18（GB/T 4457.4），默认 0.5' },
    thin_stroke_width_mm: { type: 'number', description: '剖面线、中心线与引线的细实线线宽（毫米），不小于 0.18，默认 0.25' },
    padding_mm: { type: 'number', description: '画布留白（毫米），默认 4' },
  },
} as const

/** 时序图输入 schema。 */
export const SEQUENCE_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    participants: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { id: { type: 'string', required: true }, label: { type: 'string', required: true } },
      },
    },
    messages: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          from: { type: 'string', required: true },
          to: { type: 'string', required: true },
          label: { type: 'string', required: true },
          kind: { type: 'string', enum: ['sync', 'return', 'async'], description: '默认 sync' },
          activate: { type: 'boolean', description: '是否在目标生命线上画激活条，默认 false' },
        },
      },
    },
    box_width_mm: { type: 'number', description: '参与者盒宽（毫米），默认 30' },
    message_spacing_mm: { type: 'number', description: '消息垂直间距（毫米），默认 10' },
    padding_mm: { type: 'number', description: '画布留白（毫米），默认 5' },
  },
} as const

/** 外观设计视图排布输入 schema。 */
export const APPEARANCE_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    views: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true, enum: APPEARANCE_VIEW_NAMES_ALL, description: '视图名（六面正投影视图）' },
          body: { type: 'string', required: true, description: '调用方提供的视图片段（毫米坐标 SVG 片段）' },
          width_mm: { type: 'number', required: true },
          height_mm: { type: 'number', required: true },
          note: { type: 'string', description: '备注（写入结果 warnings，不落图面；如省略视图的原因）' },
        },
      },
    },
    extras: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          body: { type: 'string', required: true },
          width_mm: { type: 'number', required: true },
          height_mm: { type: 'number', required: true },
        },
      },
      description: '额外单元格（立体图/使用状态参考图）',
    },
    cell_mm: { type: 'number', description: '单元格最大边长（毫米），默认 60' },
    caption_gap_mm: { type: 'number', description: '视图名与图形的间距（毫米），默认 3' },
    caption_font_mm: { type: 'number', description: '视图名字高（毫米），默认 3.5' },
    padding_mm: { type: 'number', description: '画布留白（毫米），默认 8' },
    first_angle: { type: 'boolean', description: '默认 true：按中国第一角投影排布；false 为第三角' },
  },
} as const

/** 流程图步骤 schema：`next` 是纯 id 字符串，或带边标签的 `{id,label}`（判断分支必须带标签）。 */
export const STEP_SCHEMA = {  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true, description: '步骤标识（[A-Za-z0-9_-]，自动清洗）' },
    label: { type: 'string', required: true, description: '步骤显示文本' },
    shape: { type: 'string', enum: ['box', 'ellipse', 'diamond', 'parallelogram', 'cylinder'], description: 'box（默认）/ellipse/diamond/parallelogram/cylinder' },
    next: {
      type: 'array',
      required: true,
      description: '后继：字符串 id，或 {id,label}（判断分支必须带边标签）',
      items: {
        oneOf: [
          { type: 'string' },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              label: { type: 'string', required: true },
            },
          },
        ],
      },
    },
  },
} as const

/** 状态图状态 schema：initial 伪状态用空 label，只画实心小圆。 */
export const STATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true, description: '状态标识（[A-Za-z0-9_-]，自动清洗）' },
    label: { type: 'string', required: true, description: '状态名（initial 伪状态填空串）' },
    kind: { type: 'string', enum: ['normal', 'initial', 'final'], description: 'normal（默认，圆角框）/initial（实心小圆，无标号）/final（双圆框）' },
  },
} as const

/** 状态转移 schema：端点必须存在于同组 states。 */
export const TRANSITION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
    label: { type: 'string', description: '转移条件（简短词语，可选）' },
  },
} as const

/** 框图块 schema：label 用 `\\n` 换行。 */
export const BLOCK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    label: { type: 'string', required: true, description: '块名（\\n 换行）' },
    type: { type: 'string', enum: ['input', 'output', 'process', 'storage', 'decision', 'default'], description: 'input/output/process/storage/decision/default' },
  },
} as const

/** 框图连接 schema：端点必须存在于同组 blocks。 */
export const CONNECTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: { type: 'string', required: true },
    to: { type: 'string', required: true },
    label: { type: 'string', description: '数据流说明（可选）' },
  },
} as const

/** 组件层级树节点 schema：children 递归，深度不限。 */
export const TREE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    label: { type: 'string', required: true },
    children: { type: 'array', items: { type: 'object', additionalProperties: true } },
  },
} as const

/** 多面板子图 schema：面板图型限于 DOT 图型（矢量图型字段不在其中）。 */
export const PANEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    suffix: { type: 'string', required: true, description: '面板后缀（字母/数字/下划线/连字符；写入 figN+后缀，如 A → fig1A.svg）' },
    figure_type: { type: 'string', enum: ['flowchart', 'state_diagram', 'block_diagram', 'component_hierarchy', 'raw_dot', 'template'], description: '面板图型；缺省从该面板唯一结构输入推断' },
    steps: { type: 'array', items: STEP_SCHEMA, description: '面板流程步骤' },
    states: { type: 'array', items: STATE_SCHEMA, description: '面板状态图状态' },
    transitions: { type: 'array', items: TRANSITION_SCHEMA, description: '面板状态转移' },
    blocks: { type: 'array', items: BLOCK_SCHEMA, description: '面板框图块' },
    connections: { type: 'array', items: CONNECTION_SCHEMA, description: '面板框图连接（blocks 面板）' },
    tree: { type: 'array', items: TREE_SCHEMA, description: '面板组件层级树' },
    template: { type: 'string', enum: DIAGRAM_TEMPLATE_NAMES, description: '面板内置模板' },
    dot: { type: 'string', description: '面板原始 DOT（须自包含：不接受 image/shapefile/fontpath 等文件引用属性）' },
    numerals: { type: 'object', additionalProperties: true, description: '面板显式标号（组件 id → 标号；标号可为字符串或数字，其他类型会被拒绝；优先于顶层 numerals）' },
  },
} as const
