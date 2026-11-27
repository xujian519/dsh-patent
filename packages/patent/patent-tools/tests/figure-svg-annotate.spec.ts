import { describe, expect, it } from 'vitest'
import {
  annotateSvg,
  DEFAULT_SVG_MAX_BYTES,
} from '../src/figure/svg-annotate.ts'
import { annotateSvgWithLeaderLines } from '../src/figure/leader-line.ts'

/** Graphviz 风格的两文本元素 SVG（其一含 tspan 多行）。 */
const SVG = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">
<g id="a">
<polygon points="0,0 100,0 100,40 0,40"/>
<text text-anchor="middle" x="50" y="25">Input Sensor</text>
</g>
<g id="b">
<text text-anchor="middle" x="100" y="70"><tspan x="100" dy="0">Central</tspan><tspan x="100" dy="12">Processor</tspan></text>
</g>
</svg>`

describe('annotateSvg', () => {
  it('在匹配文本末尾追加标号：tspan 尾插与 text 尾插', () => {
    const { svg, warnings } = annotateSvg(SVG, [
      { label: 'Input Sensor', numeral: '20' },
      { label: 'Processor', numeral: '100' },
    ])
    expect(svg).toContain('Input Sensor (20)')
    expect(svg).toContain('</tspan>')
    expect(svg).toContain('Processor (100)</tspan>')
    expect(warnings).toEqual([])
  })

  it('同一参考命中多个文本元素（同名组件同号）；未命中项进入 warnings', () => {
    const svgTwo = `${SVG}\n<text>Input Sensor</text>`
    const { svg, warnings } = annotateSvg(svgTwo, [
      { label: 'Input Sensor', numeral: '20' },
      { label: 'Ghost', numeral: '30' },
    ])
    expect(svg.match(/Input Sensor \(20\)/g)?.length).toBe(2)
    expect(warnings).toEqual(['Ghost'])
  })

  it('每个文本元素至多命中一个参考（按传入顺序取首个）', () => {
    const { svg, warnings } = annotateSvg(SVG, [
      { label: 'Sensor', numeral: '20' },
      { label: 'Input Sensor', numeral: '99' },
    ])
    expect(svg).toContain('Input Sensor (20)')
    expect(svg).not.toContain('(99)')
    expect(warnings).toEqual(['Input Sensor'])
  })

  it('无参考时原样返回', () => {
    expect(annotateSvg(SVG, [])).toEqual({ svg: SVG, warnings: [] })
  })

  it('允许无实体 DOCTYPE（Graphviz 标准输出），拒绝 ENTITY / CDATA / 过大 / 非 SVG', () => {
    const doctype = '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">'
    const ok = annotateSvg(`${doctype}<svg xmlns="http://www.w3.org/2000/svg"><text>Sensor</text></svg>`, [{ label: 'Sensor', numeral: '10' }])
    expect(ok.svg).toContain('Sensor (10)')
    expect(ok.warnings).toEqual([])
    expect(() => annotateSvg('<!ENTITY x "y"><svg></svg>', [])).toThrow(/不安全/)
    expect(() => annotateSvg('<svg><![CDATA[x]]></svg>', [])).toThrow(/不安全/)
    expect(() => annotateSvg('<svg>' + 'x'.repeat(DEFAULT_SVG_MAX_BYTES + 1) + '</svg>', [])).toThrow(/过大/)
    // 上限按 UTF-8 字节计：3000 个汉字只有 3000 码元、却是 9000 字节。
    expect(() => annotateSvg(`<svg>${'一'.repeat(3000)}</svg>`, [], 6000)).toThrow(/过大/)
    expect(() => annotateSvg('<html></html>', [])).toThrow(/非 SVG/)
  })

  it('数字实体解码后参与匹配（&#32; 空格）', () => {
    const { svg, warnings } = annotateSvg('<svg><text>Input&#32;Sensor</text></svg>', [
      { label: 'Input Sensor', numeral: '20' },
    ])
    expect(svg).toContain('Input&#32;Sensor (20)')
    expect(warnings).toEqual([])
  })

  it('拒绝空 label / 空 numeral；escape 插入字符', () => {
    expect(() => annotateSvg(SVG, [{ label: '  ', numeral: '1' }])).toThrow(/label 不能为空/)
    expect(() => annotateSvg(SVG, [{ label: 'x', numeral: '  ' }])).toThrow(/numeral 不能为空/)
    const { svg } = annotateSvg(SVG, [{ label: 'Input Sensor', numeral: 'a&b "c"' }])
    expect(svg).toContain('Input Sensor (a&amp;b &quot;c&quot;)')
  })

  it('重跑幂等：同一标号表反复标注结果不变，不叠加标号', () => {
    const references = [
      { label: 'Input Sensor', numeral: '20' },
      { label: 'Processor', numeral: '100' },
    ]
    const first = annotateSvg(SVG, references)
    const second = annotateSvg(first.svg, references)
    expect(second.svg).toBe(first.svg)
    expect(second.svg.match(/Input Sensor \(20\)/g)?.length).toBe(1)
    expect(second.svg.match(/Processor \(100\)/g)?.length).toBe(1)
    expect(second.warnings).toEqual([])
  })

  it('重跑改号：已有内嵌标号被替换，旧标号不残留', () => {
    const first = annotateSvg(SVG, [{ label: 'Input Sensor', numeral: '20' }])
    const second = annotateSvg(first.svg, [{ label: 'Input Sensor', numeral: '30' }])
    expect(second.svg).toContain('Input Sensor (30)')
    expect(second.svg).not.toContain('Input Sensor (20)')
    expect(second.svg.match(/Input Sensor/g)?.length).toBe(1)
  })

  it('非数字标号（S101 / A-1）重跑同样替换而非叠加', () => {
    const repeated = annotateSvg(
      annotateSvg(SVG, [{ label: 'Input Sensor', numeral: 'S101' }]).svg,
      [{ label: 'Input Sensor', numeral: 'S101' }],
    )
    expect(repeated.svg).toContain('Input Sensor (S101)')
    expect(repeated.svg.match(/Input Sensor/g)?.length).toBe(1)

    const changed = annotateSvg(
      annotateSvg(SVG, [{ label: 'Input Sensor', numeral: 'S101' }]).svg,
      [{ label: 'Input Sensor', numeral: 'A-1' }],
    )
    expect(changed.svg).toContain('Input Sensor (A-1)')
    expect(changed.svg).not.toContain('S101')
    expect(changed.svg.match(/Input Sensor/g)?.length).toBe(1)
  })

  it('命中文本末尾的纯文字括号不是标号，重跑时保留', () => {
    const tagged = '<svg><text>端口 (优选)</text></svg>'
    const first = annotateSvg(tagged, [{ label: '端口', numeral: '20' }])
    expect(first.svg).toContain('端口 (优选) (20)')
    const second = annotateSvg(first.svg, [{ label: '端口', numeral: '20' }])
    expect(second.svg).toContain('端口 (优选) (20)')
    expect(second.svg.match(/端口 \(优选\)/g)?.length).toBe(1)
  })

  it('重跑只清理命中文本：未匹配文本末尾的括号数字原样保留', () => {
    const mixed = '<svg><text>版本 (2024)</text><text>Input Sensor</text></svg>'
    const { svg } = annotateSvg(mixed, [{ label: 'Input Sensor', numeral: '20' }])
    expect(svg).toContain('版本 (2024)')
    expect(svg).toContain('Input Sensor (20)')
  })
})

/** Graphviz 节点组结构 fixture（WASM 引擎采样：title=DOT 节点 id + polygon/ellipse + text）。 */
const WASM_GRAPH_SVG = `<svg width="150pt" height="120pt" viewBox="0 0 150 120" xmlns="http://www.w3.org/2000/svg">
<g id="graph0" class="graph">
<title>fig1</title>
<g id="node1" class="node">
<title>sensor</title>
<polygon fill="none" stroke="black" points="10,10 10,50 110,50 110,10"/>
<text text-anchor="middle" x="60" y="34" font-family="Helvetica" font-size="10.00">温度传感器</text>
</g>
<g id="node2" class="node">
<title>controller</title>
<ellipse fill="none" stroke="black" cx="60" cy="85" rx="45" ry="18"/>
<text text-anchor="middle" x="60" y="89" font-family="Helvetica" font-size="10.00">控制单元</text>
</g>
</g>
</svg>`

/** 同结构的 dot CLI 采样变体（仅坐标与 generated-by 注释不同，Phase 0 实测结论）。 */
const CLI_GRAPH_SVG = `<!--Generated by graphviz CLI-->
<svg width="170pt" height="140pt" viewBox="0 0 170 140" xmlns="http://www.w3.org/2000/svg">
<g id="graph0" class="graph">
<g id="node1" class="node">
<title>sensor</title>
<polygon fill="none" stroke="black" points="30,30 30,70 130,70 130,30"/>
<text text-anchor="middle" x="80" y="54" font-family="Helvetica" font-size="10.00">温度传感器</text>
</g>
<g id="node2" class="node">
<title>controller</title>
<ellipse fill="none" stroke="black" cx="80" cy="105" rx="45" ry="18"/>
<text text-anchor="middle" x="80" y="109" font-family="Helvetica" font-size="10.00">控制单元</text>
</g>
</g>
</svg>`

/** 画布紧贴最右节点（与真实 dot 输出同构：viewBox 即布局加约 4pt 边距），右向标号必然越界。 */
const TIGHT_RIGHT_SVG = `<svg width="150pt" height="60pt" viewBox="0.00 0.00 150.00 60.00" xmlns="http://www.w3.org/2000/svg">
<g id="graph0" class="graph" transform="scale(1 1) rotate(0) translate(4 56)">
<title>fig1</title>
<polygon fill="white" stroke="none" points="-4,4 -4,-56 146,-56 146,4 -4,4"/>
<g id="node1" class="node">
<title>sensor</title>
<polygon fill="none" stroke="black" points="0,-44 0,-12 140,-12 140,-44 0,-44"/>
<text text-anchor="middle" x="70" y="-24" font-family="Helvetica" font-size="10.00">温度传感器</text>
</g>
</g>
</svg>`

/** 仅左侧有空位（右/上/下各有相邻节点），左向标号落在画布左边界之外。 */
const TIGHT_LEFT_SVG = `<svg width="150pt" height="60pt" viewBox="0.00 0.00 150.00 60.00" xmlns="http://www.w3.org/2000/svg">
<g id="graph0" class="graph" transform="translate(4 56)">
<g id="node1" class="node">
<title>target</title>
<polygon fill="none" stroke="black" points="0,-44 0,-12 20,-12 20,-44"/>
<text text-anchor="middle" x="10" y="-24" font-size="10.00">靶件</text>
</g>
<g id="node2" class="node">
<title>wall-r</title>
<polygon fill="none" stroke="black" points="24,-46 24,-10 150,-10 150,-46"/>
<text text-anchor="middle" x="87" y="-24" font-size="10.00">右墙</text>
</g>
<g id="node3" class="node">
<title>wall-t</title>
<polygon fill="none" stroke="black" points="0,-52 0,-46 20,-46 20,-52"/>
<text text-anchor="middle" x="10" y="-47" font-size="10.00">顶墙</text>
</g>
<g id="node4" class="node">
<title>wall-b</title>
<polygon fill="none" stroke="black" points="0,-10 0,-4 20,-4 20,-10"/>
<text text-anchor="middle" x="10" y="-5" font-size="10.00">底墙</text>
</g>
</g>
</svg>`

/** 根元素声明的画布（viewBox 与 width/height 数值一致时以 viewBox 为准）。 */
function declaredCanvas(svg: string): { minX: number; minY: number; width: number; height: number } {
  const viewBox = /viewBox="([^"]+)"/.exec(svg)
  if (viewBox !== null) {
    const [minX, minY, width, height] = viewBox[1]!.split(/\s+/).map(Number)
    return { minX: minX!, minY: minY!, width: width!, height: height! }
  }
  const root = /<svg[^>]*>/.exec(svg)![0]
  return {
    minX: 0,
    minY: 0,
    width: Number(/(?:^|\s)width="([\d.]+)/.exec(root)?.[1]),
    height: Number(/(?:^|\s)height="([\d.]+)/.exec(root)?.[1]),
  }
}

/** 引线组内每个标号的文本锚点框（测试侧保守估算：宽 6/字符 + 2、高 12，只用于“是否落在画布内”的包含判定）。 */
function numeralBoxes(svg: string): { minX: number; minY: number; maxX: number; maxY: number }[] {
  const group = /<g id="leader-lines">([\s\S]*?)<\/g>/.exec(svg)?.[1] ?? ''
  const boxes: { minX: number; minY: number; maxX: number; maxY: number }[] = []
  for (const match of group.matchAll(/<text x="([\d.-]+)" y="([\d.-]+)"[^>]*text-anchor="(\w+)"[^>]*>([^<]*)<\/text>/g)) {
    const x = Number(match[1])
    const y = Number(match[2])
    const width = match[4]!.length * 6 + 2
    const minX = match[3] === 'end' ? x - width : match[3] === 'middle' ? x - width / 2 : x
    boxes.push({ minX, minY: y - 9, maxX: minX + width, maxY: y + 3 })
  }
  return boxes
}

/** 标号文本框是否完整落在声明画布内。 */
function numeralsInsideCanvas(svg: string): boolean {
  const canvas = declaredCanvas(svg)
  return numeralBoxes(svg).every(box =>
    box.minX >= canvas.minX && box.maxX <= canvas.minX + canvas.width
    && box.minY >= canvas.minY && box.maxY <= canvas.minY + canvas.height)
}

describe('annotateSvgWithLeaderLines', () => {
  it('WASM 与 CLI 采样结构均在轮廓外侧画引线 + 图外标号，标签保持无标号', () => {
    for (const fixture of [WASM_GRAPH_SVG, CLI_GRAPH_SVG]) {
      const { svg, warnings } = annotateSvgWithLeaderLines(fixture, [
        { label: '温度传感器', numeral: '100' },
        { label: '控制单元', numeral: '200' },
      ])
      expect(svg.match(/<line /g)?.length).toBe(2)
      expect(svg).toContain('>100</text>')
      expect(svg).toContain('>200</text>')
      expect(svg).toContain('>温度传感器<')
      expect(svg).toContain('>控制单元<')
      expect(svg).not.toContain('(100)')
      expect(warnings).toEqual([])
    }
  })

  it('引线从轮廓边缘出发、标号位于线端外侧（右向优先）', () => {
    const { svg } = annotateSvgWithLeaderLines(WASM_GRAPH_SVG, [{ label: '温度传感器', numeral: '100' }])
    // 节点 bbox [10,10]-[110,50]，右向：线 [110,30]→[120,30]，标号在线端外侧。
    expect(svg).toContain('<line x1="110" y1="30" x2="120" y2="30"')
    expect(svg).toMatch(/<text x="123" y="33\.5" [^>]*>100<\/text>/)
  })

  it('椭圆节点同样获得引线；同参考命中多个节点时同号多处标注且互不重叠', () => {
    const twoControllers = WASM_GRAPH_SVG.replace(
      '</g>\n</g>\n</svg>',
      `</g>
<g id="node3" class="node">
<title>backup</title>
<ellipse fill="none" stroke="black" cx="60" cy="85" rx="45" ry="18"/>
<text text-anchor="middle" x="60" y="89" font-family="Helvetica" font-size="10.00">备用控制单元</text>
</g>
</g>
</svg>`,
    )
    const { svg, warnings } = annotateSvgWithLeaderLines(twoControllers, [{ label: '控制单元', numeral: '300' }])
    expect(svg.match(/<line /g)?.length).toBe(2)
    expect(svg.match(/>300<\/text>/g)?.length).toBe(2)
    expect(warnings).toEqual([])
  })

  it('未命中参考进入 warnings', () => {
    const { svg, warnings } = annotateSvgWithLeaderLines(WASM_GRAPH_SVG, [{ label: 'Ghost', numeral: '30' }])
    expect(svg).not.toContain('<line ')
    expect(warnings).toEqual(['参考 "Ghost" 未命中任何节点'])
  })

  it('命中组缺轮廓（无法定位 bbox）时退化为内嵌标号并告警', () => {
    const noShape = WASM_GRAPH_SVG.replace(
      '<ellipse fill="none" stroke="black" cx="60" cy="85" rx="45" ry="18"/>',
      '',
    )
    const { svg, warnings } = annotateSvgWithLeaderLines(noShape, [{ label: '控制单元', numeral: '30' }])
    expect(svg).toContain('控制单元 (30)')
    expect(svg).not.toContain('<line ')
    expect(warnings).toEqual(['节点 "controller" 缺少形状轮廓，标号 30 已内嵌'])
  })

  it('四向候选均被相邻节点占用时退化为内嵌标号并告警，不画压盖引线', () => {
    const crowded = `<svg xmlns="http://www.w3.org/2000/svg">
<g id="node1" class="node">
<title>core</title>
<polygon fill="none" stroke="black" points="50,50 50,100 100,100 100,50"/>
<text text-anchor="middle" x="75" y="79" font-size="10.00">主控板</text>
</g>
<g id="node2" class="node">
<title>wall-r</title>
<polygon fill="none" stroke="black" points="95,60 95,90 140,90 140,60"/>
<text text-anchor="middle" x="117" y="79" font-size="10.00">右墙</text>
</g>
<g id="node3" class="node">
<title>wall-l</title>
<polygon fill="none" stroke="black" points="5,60 5,90 45,90 45,60"/>
<text text-anchor="middle" x="25" y="79" font-size="10.00">左墙</text>
</g>
<g id="node4" class="node">
<title>wall-t</title>
<polygon fill="none" stroke="black" points="40,5 40,45 110,45 110,5"/>
<text text-anchor="middle" x="75" y="29" font-size="10.00">顶墙</text>
</g>
<g id="node5" class="node">
<title>wall-b</title>
<polygon fill="none" stroke="black" points="40,105 40,145 110,145 110,105"/>
<text text-anchor="middle" x="75" y="129" font-size="10.00">底墙</text>
</g>
</svg>`
    const { svg, warnings } = annotateSvgWithLeaderLines(crowded, [{ label: '主控板', numeral: '10' }])
    expect(svg).not.toContain('<line ')
    expect(svg).toContain('主控板 (10)')
    expect(warnings).toEqual(['节点 "core" 周边无引线空间，标号 10 已内嵌'])
  })

  it('复用 svg-annotate 的输入安全校验：ENTITY/CDATA/非 SVG/过大/空字段均拒绝', () => {
    expect(() => annotateSvgWithLeaderLines('<!ENTITY x "y"><svg></svg>', [{ label: 'a', numeral: '1' }])).toThrow(/不安全/)
    expect(() => annotateSvgWithLeaderLines('<svg><![CDATA[x]]></svg>', [])).toThrow(/不安全/)
    expect(() => annotateSvgWithLeaderLines('<html></html>', [])).toThrow(/非 SVG/)
    expect(() =>
      annotateSvgWithLeaderLines(`<svg>${'x'.repeat(DEFAULT_SVG_MAX_BYTES + 1)}</svg>`, []),
    ).toThrow(/过大/)
    expect(() => annotateSvgWithLeaderLines(WASM_GRAPH_SVG, [{ label: ' ', numeral: '1' }])).toThrow(/label 不能为空/)
    expect(() => annotateSvgWithLeaderLines(WASM_GRAPH_SVG, [{ label: 'a', numeral: ' ' }])).toThrow(/numeral 不能为空/)
  })

  it('无参考时原样返回；SVG 片段注入在根元素闭合前', () => {
    expect(annotateSvgWithLeaderLines(WASM_GRAPH_SVG, [])).toEqual({ svg: WASM_GRAPH_SVG, warnings: [] })
    const { svg } = annotateSvgWithLeaderLines(WASM_GRAPH_SVG, [{ label: '温度传感器', numeral: '100' }])
    const leaderGroup = svg.indexOf('<g id="leader-lines">')
    expect(leaderGroup).toBeGreaterThan(-1)
    expect(svg.indexOf('</svg>')).toBeGreaterThan(leaderGroup)
  })

  it('右向标号越出画布时扩展画布：标号与引线完整可见，大幅扩边告警', () => {
    const { svg, warnings } = annotateSvgWithLeaderLines(TIGHT_RIGHT_SVG, [{ label: '温度传感器', numeral: '100' }])
    // 单边扩边 18%（>15% 阈值）→ B3 告警（同一物理页面下字号会被压细）。
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('扩边')
    // 节点右边缘（用户坐标 144）加 10pt 引线再加标号文本框越出 150pt 画布，向右扩 2pt 安全边距。
    expect(declaredCanvas(svg)).toEqual({ minX: 0, minY: 0, width: 177.5, height: 60 })
    expect(svg).toContain('width="177.5pt"')
    expect(svg).toContain('height="60pt"')
    expect(numeralsInsideCanvas(svg)).toBe(true)
    expect(svg).toContain('<line x1="144" y1="28" x2="154" y2="28"')
  })

  it('左向标号越出画布左边界时把 viewBox 起点左移，其余内容不动', () => {
    const { svg, warnings } = annotateSvgWithLeaderLines(TIGHT_LEFT_SVG, [{ label: '靶件', numeral: '100' }])
    // 单边扩边 20%（>15% 阈值）→ B3 告警。
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('扩边')
    expect(svg).toContain('<line x1="4" y1="28" x2="-6" y2="28"')
    expect(declaredCanvas(svg)).toEqual({ minX: -29.5, minY: 0, width: 179.5, height: 60 })
    expect(svg).toContain('viewBox="-29.5 0 179.5 60"')
    expect(svg).toContain('width="179.5pt"')
    expect(numeralsInsideCanvas(svg)).toBe(true)
  })

  it('标号未越界时画布与尺寸属性原样保留', () => {
    const { svg } = annotateSvgWithLeaderLines(WASM_GRAPH_SVG, [{ label: '温度传感器', numeral: '100' }])
    expect(declaredCanvas(svg)).toEqual({ minX: 0, minY: 0, width: 150, height: 120 })
    expect(svg).toContain('width="150pt"')
    expect(svg).toContain('viewBox="0 0 150 120"')
  })

  it('根元素未声明画布（无 viewBox/width/height）时不改根元素', () => {
    const noCanvas = `<svg xmlns="http://www.w3.org/2000/svg">
<g id="node1" class="node">
<title>a</title>
<polygon fill="none" stroke="black" points="10,10 10,50 110,50 110,10"/>
<text text-anchor="middle" x="60" y="34" font-size="10.00">A</text>
</g>
</svg>`
    const { svg, warnings } = annotateSvgWithLeaderLines(noCanvas, [{ label: 'A', numeral: '10' }])
    expect(warnings).toEqual([])
    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg">')
    expect(svg).toContain('<line ')
  })

  it('重跑幂等：再次标注替换引线组，不叠加引线与标号', () => {
    const references = [
      { label: '温度传感器', numeral: '100' },
      { label: '控制单元', numeral: '200' },
    ]
    const first = annotateSvgWithLeaderLines(WASM_GRAPH_SVG, references)
    const second = annotateSvgWithLeaderLines(first.svg, references)
    expect(second.svg.match(/<g id="leader-lines">/g)?.length).toBe(1)
    expect(second.svg.match(/<line /g)?.length).toBe(2)
    expect(second.svg.match(/>100<\/text>/g)?.length).toBe(1)
    expect(second.svg.match(/>200<\/text>/g)?.length).toBe(1)
    expect(second.svg).not.toContain('(100)')
    expect(second.warnings).toEqual([])
  })

  it('内嵌标注的 SVG 改用引线模式：既有内嵌标号被清理，只剩外置标号', () => {
    const embedded = annotateSvg(WASM_GRAPH_SVG, [{ label: '温度传感器', numeral: '100' }])
    expect(embedded.svg).toContain('温度传感器 (100)')
    const { svg, warnings } = annotateSvgWithLeaderLines(embedded.svg, [{ label: '温度传感器', numeral: '100' }])
    expect(svg).not.toContain('(100)')
    expect(svg.match(/<line /g)?.length).toBe(1)
    expect(svg).toContain('>100</text>')
    expect(warnings).toEqual([])
  })

  it('引线标注的 SVG 改用内嵌模式：引线组被移除，只剩内嵌标号', () => {
    const leader = annotateSvgWithLeaderLines(WASM_GRAPH_SVG, [{ label: '温度传感器', numeral: '100' }])
    const { svg } = annotateSvg(leader.svg, [{ label: '温度传感器', numeral: '100' }])
    expect(svg).not.toContain('leader-lines')
    expect(svg).not.toContain('<line ')
    expect(svg).toContain('温度传感器 (100)')
  })
})
