/**
 * 渲染族回归快照（D12）：把 `patent-tools/figure` 各渲染器的完整产物按固定输入钉住，
 * 供后续「几何 / 渲染 / 检查」分层拆分时比对行为是否等价（D12 拆分方案见执行卡 §38）。
 *
 * 输入同时覆盖正常图面与退化输入（零面积多边形、常量数据、空集合、CJK 文本），
 * 快照内容为完整片段/报告，不截断——拆文件属纯移动时，本文件不得改动。
 * FreeCAD 投影脚本约 30 KB，按 SHA-256 摘要锁定全文并另断言关键结构，避免快照不可读。
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildCircuitDiagram } from '../src/figure/circuit-diagram.ts'
import { buildBlockDiagramDOT, buildFlowchartDOT } from '../src/figure/dot-builder.ts'
import { buildStructureScript } from '../src/figure/freecad-structure-script.ts'
import { glyphBox, textWidthMm } from '../src/figure/glyph-box.ts'
import { annotateSvgWithLeaderLines } from '../src/figure/leader-line.ts'
import { buildPlotDiagram } from '../src/figure/plot-diagram.ts'
import { checkFigureRendering } from '../src/figure/render-check-findings.ts'
import { buildSectionDiagram } from '../src/figure/section-diagram.ts'
import { buildSequenceDiagram } from '../src/figure/sequence-diagram.ts'
import { vectorFigureSvg } from '../src/figure/vector-figure.ts'

/** 剖视图固定输入：外轮廓 + 两个零件（方向相反的剖面线）+ 中心线 + 断裂线 + 剖切符号 + 引线标号。 */
const SECTION_INPUT = {
  outline: [[0, 0], [60, 0], [60, 36], [0, 36]],
  parts: [
    { label: '壳体', outline: [[6, 6], [34, 6], [34, 30], [6, 30]], hatch: { angleDeg: 45, spacingMm: 3 } },
    {
      label: '端盖',
      outline: [[40, 6], [54, 6], [54, 30], [40, 30]],
      hatch: { angleDeg: 45, spacingMm: 2, direction: 'backward' as const },
      strokeWidthMm: 0.7,
    },
  ],
  centerlines: [{ from: [30, -4], to: [30, 40] }],
  breakLines: [{ from: [0, 18], to: [4, 18], teeth: 4 }],
  cuttingMarks: [{ id: 'A', from: [0, -6], to: [60, -6], arrow: 'up' as const }],
  labels: [{ text: '7', at: [70, 18], from: [54, 18] }],
} as const

/** 电路图固定输入：三元件 + 三条连线（含 CJK 连线说明与 T 形结点）。 */
const CIRCUIT_INPUT = {
  components: [
    { id: 'r1', kind: 'resistor' as const, label: '电阻 R1', col: 0, row: 0 },
    { id: 'c1', kind: 'capacitor' as const, label: '电容 C1', col: 2, row: 0 },
    { id: 'g1', kind: 'ground' as const, label: '接地', col: 1, row: 1 },
  ],
  connections: [
    { from: 'r1', to: 'c1', label: '信号线' },
    { from: 'r1', to: 'g1', label: '屏蔽层' },
    { from: 'c1', to: 'g1' },
  ],
} as const

/** 生成 Graphviz 风格的节点组（组坐标系与真实 dot 输出同构）。 */
function graphvizNode(id: string, label: string, points: string): string {
  return [
    `<g id="node-${id}" class="node">`,
    `<title>${id}</title>`,
    `<polygon fill="none" stroke="black" points="${points}"/>`,
    `<text text-anchor="middle" x="30" y="-44" font-size="10">${label}</text>`,
    '</g>',
  ].join('\n')
}

/** 固定 Graphviz SVG：两个中文节点 + 一条边，供引线标注快照。 */
const LEADER_SVG = [
  '<svg width="200pt" height="100pt" viewBox="0.00 0.00 200.00 100.00" xmlns="http://www.w3.org/2000/svg">',
  '<g id="graph0" class="graph" transform="scale(1 1) rotate(0) translate(4 66)">',
  graphvizNode('a', '壳体', '0,-44 0,-12 60,-12 60,-44'),
  graphvizNode('b', '端盖', '0,-84 0,-52 60,-52 60,-84'),
  '<g id="edge-ab" class="edge">',
  '<title>a&#45;&gt;b</title>',
  '<path fill="none" stroke="black" d="M30,-44 C30,-48 30,-48 30,-52"/>',
  '</g>',
  '</g>',
  '</svg>',
].join('\n')

/** FreeCAD 结构线稿固定输入：单模型、两视图、一个显式锚点 + 一个自动锚点。 */
const STRUCTURE_INPUT = {
  modelPaths: ['/tmp/d12-regression/bracket.step'],
  views: ['iso', 'front'] as const,
  scale: 1,
  showHidden: false,
  callouts: [
    { numeral: '1', point3d: [10, 20, 5] as const, label: '壳体', model: 0 },
    { numeral: '2', label: '端盖', model: 0 },
  ],
  figureNumber: 2,
  outputDir: '/tmp/d12-regression/structure',
}

describe('D12 渲染回归快照：矢量直绘图型', () => {
  it('剖视图：外轮廓、双向剖面线、中心线、断裂线、剖切符号与中文标号', () => {
    const spec = buildSectionDiagram(SECTION_INPUT)
    expect({ widthMm: spec.widthMm, heightMm: spec.heightMm, labels: spec.labels, body: spec.body }).toMatchSnapshot()
  })

  it('剖视图退化输入：零面积轮廓不打剖面线，标号仍按顶点平均位置引出', () => {
    const spec = buildSectionDiagram({ parts: [{ label: '退化件', outline: [[0, 0], [10, 0], [20, 0]] }] })
    expect({ widthMm: spec.widthMm, heightMm: spec.heightMm, labels: spec.labels, body: spec.body }).toMatchSnapshot()
  })

  it('电路图：中文元件名/连线说明、T 形结点与符号叠放顺序', () => {
    const spec = buildCircuitDiagram(CIRCUIT_INPUT)
    expect({ widthMm: spec.widthMm, heightMm: spec.heightMm, labels: spec.labels, body: spec.body }).toMatchSnapshot()
  })

  it('曲线图：双序列、网格与中文轴标目', () => {
    const spec = buildPlotDiagram({
      series: [
        { name: '升温', points: [[0, 20], [10, 40], [20, 55]], marker: 'circle' },
        { name: '保温', points: [[20, 55], [30, 55], [40, 55]], marker: 'square' },
      ],
      xLabel: '时间',
      xUnit: 's',
      yLabel: '温度',
      yUnit: '℃',
      showGrid: true,
      tickCount: 4,
    })
    expect({ widthMm: spec.widthMm, heightMm: spec.heightMm, labels: spec.labels, body: spec.body }).toMatchSnapshot()
  })

  it('曲线图退化输入：常量序列（零跨度）按默认半跨度展开', () => {
    const spec = buildPlotDiagram({
      series: [{ name: '恒温', points: [[0, 60], [30, 60], [60, 60]] }],
      xLabel: '时间',
      yLabel: '温度',
    })
    expect({ widthMm: spec.widthMm, heightMm: spec.heightMm, labels: spec.labels, body: spec.body }).toMatchSnapshot()
  })

  it('时序图：同步/返回/异步消息与激活条', () => {
    const spec = buildSequenceDiagram({
      participants: [
        { id: 'u', label: '用户' },
        { id: 'c', label: '控制模块' },
        { id: 's', label: '存储单元' },
      ],
      messages: [
        { from: 'u', to: 'c', label: '请求' },
        { from: 'c', to: 's', label: '查询' },
        { from: 's', to: 'c', label: '返回', kind: 'return' },
        { from: 'c', to: 'u', label: '完成', kind: 'async', activate: true },
      ],
    })
    expect({ widthMm: spec.widthMm, heightMm: spec.heightMm, labels: spec.labels, body: spec.body }).toMatchSnapshot()
  })

  it('引线标注：Graphviz 组坐标平移下的中文节点标号与画布扩边', () => {
    const result = annotateSvgWithLeaderLines(LEADER_SVG, [
      { label: '壳体', numeral: '1' },
      { label: '端盖', numeral: '2' },
    ])
    expect({ warnings: result.warnings, svg: result.svg }).toMatchSnapshot()
  })
})

describe('D12 渲染回归快照：DOT 与投影脚本', () => {
  it('流程图 DOT：中文步骤、决策边标签与 A4 页边距', () => {
    const dot = buildFlowchartDOT(
      [
        { id: 'start', label: '接收交底书', next: ['check'] },
        { id: 'check', label: '是否清楚', shape: 'diamond', next: [{ id: 'draft', label: '清楚' }, { id: 'ask', label: '不清楚' }] },
        { id: 'ask', label: '补充材料', next: ['check'] },
        { id: 'draft', label: '撰写申请文件', next: [] },
      ],
      { figureNumber: 1, fontName: 'PingFang SC', fontPt: 12, page: { pageSize: 'a4', marginCm: 1.5 } },
    )
    expect(dot).toMatchSnapshot()
  })

  it('框图 DOT：语义填充、中文块名与跨图续号', () => {
    const dot = buildBlockDiagramDOT(
      [
        { id: 'in', label: '技术交底', type: 'input' },
        { id: 'core', label: '撰写引擎', type: 'process' },
        { id: 'out', label: '申请文件', type: 'output' },
      ],
      [{ from: 'in', to: 'core' }, { from: 'core', to: 'out' }],
      { figureNumber: 2, style: 'semantic', fontName: 'PingFang SC' },
    )
    expect(dot).toMatchSnapshot()
  })

  it('FreeCAD 结构线稿脚本：全文摘要稳定且仍内嵌双重 JSON 参数', () => {
    const script = buildStructureScript(STRUCTURE_INPUT)
    // 摘要钉住模板全文；模板或 payload 字段变化时测试失败，需人工核对差异后更新。
    expect(createHash('sha256').update(script, 'utf8').digest('hex'))
      .toBe('0cc64a87034b03211e8dfaed4e03265764a884dca258322bcc5c36f724a30011')
    expect(script).toContain('PARAMS = json.loads(')
    expect(script).toContain('"callouts"')
    // 自动锚点（省略 point3d）必须以 null 传入，脚本据此走 resolve_auto_anchors；
    // 参数经双重 JSON 序列化，内层引号在脚本文本里带反斜杠。
    expect(script).toContain('\\"point3d\\":null')
  })
})

describe('D12 渲染回归快照：渲染复核报告', () => {
  /** 合规图面：单一闭合轮廓 + 轮廓内的中文标号，不应报出任何发现。 */
  const CLEAN_SVG = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="40mm" viewBox="0 0 40 40">',
    '<polygon points="2,2 38,2 38,38 2,38" fill="none" stroke="black" stroke-width="0.5"/>',
    '<text x="20" y="22" text-anchor="middle" font-size="3.5">壳体</text>',
    '</svg>',
  ].join('\n')

  /** 含缺陷图面：线条贯穿文字、字高低于下限、内容越出画布。 */
  const DEFECT_SVG = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="30mm" viewBox="0 0 50 30">',
    '<line x1="0" y1="10" x2="50" y2="10" stroke="black" stroke-width="0.25"/>',
    '<text x="20" y="10" text-anchor="middle" font-size="2">A</text>',
    '<rect x="45" y="25" width="10" height="10" fill="none" stroke="black" stroke-width="0.5"/>',
    '</svg>',
  ].join('\n')

  it('合规图面不报发现', () => {
    expect(checkFigureRendering(CLEAN_SVG)).toMatchSnapshot()
  })

  it('缺陷图面报出穿字、字高与越界', () => {
    expect(checkFigureRendering(DEFECT_SVG, { minFontMm: 3.5 })).toMatchSnapshot()
  })

  it('退化输入：只有根元素、没有任何可量测图元', () => {
    expect(checkFigureRendering('<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm" viewBox="0 0 10 10"></svg>'))
      .toMatchSnapshot()
  })
})

describe('D12 渲染回归快照：CJK 文字度量与重复构建确定性', () => {
  it('CJK/西文混排宽度与占位框：全角按 1 倍、大写 0.75、其余 0.6', () => {
    // 3.95 倍字号：壳、体各 1，空格 0.6，R 0.75，1 0.6。
    expect(textWidthMm('壳体 R1', 3.5)).toBeCloseTo(13.825, 12)
    expect(glyphBox('壳体', [0, 0], 3.5, 'middle')).toEqual({
      minX: -3.5,
      maxX: 3.5,
      minY: -2.625,
      maxY: 0.42,
    })
  })

  it('同一输入重复构建输出逐字节一致（无随机、无时钟、无本地化依赖）', () => {
    const sectionA = buildSectionDiagram(SECTION_INPUT)
    const sectionB = buildSectionDiagram(SECTION_INPUT)
    expect(vectorFigureSvg(sectionB)).toBe(vectorFigureSvg(sectionA))

    const circuitA = buildCircuitDiagram(CIRCUIT_INPUT)
    expect(vectorFigureSvg(buildCircuitDiagram(CIRCUIT_INPUT))).toBe(vectorFigureSvg(circuitA))

    const plotInput = {
      series: [{ name: '序列', points: [[0, 1], [2, 3]] as const }],
      xLabel: '时间',
      yLabel: '温度',
    }
    expect(vectorFigureSvg(buildPlotDiagram(plotInput))).toBe(vectorFigureSvg(buildPlotDiagram(plotInput)))

    const sequenceInput = {
      participants: [{ id: 'a', label: '甲' }, { id: 'b', label: '乙' }],
      messages: [{ from: 'a', to: 'b', label: '发送' }],
    }
    expect(vectorFigureSvg(buildSequenceDiagram(sequenceInput))).toBe(vectorFigureSvg(buildSequenceDiagram(sequenceInput)))

    expect(buildStructureScript(STRUCTURE_INPUT)).toBe(buildStructureScript(STRUCTURE_INPUT))
  })
})
