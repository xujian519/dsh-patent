import { describe, expect, it } from 'vitest'
import { blockingFindings, checkFigureRendering, clearanceMmForFigure } from '../src/figure/render-check.ts'
import { scanSvg } from '../src/figure/render-check-scan.ts'
import { buildSectionDiagram } from '../src/figure/section-diagram.ts'
import { SvgAnnotateError } from '../src/figure/svg-annotate.ts'
import { vectorFigureSvg } from '../src/figure/vector-figure.ts'

/**
 * 构造一张最小矢量附图：`body` 里的元素放入与工具同形的十号描边组，
 * `width`/`height` 为画布尺寸（毫米）。
 * @param body - 图元文本。
 * @param size - 画布尺寸文本，默认 `120mm`×`40mm`。
 * @returns SVG 文本。
 */
function svg(body: string, size = 'width="120mm" height="40mm" viewBox="0 0 120 40"'): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg" ${size}>
  <g fill="none" stroke="#000000" stroke-width="0.35" stroke-linecap="round" stroke-linejoin="round">
${body}
  </g>
</svg>`
}

/** 上下两半剖：两半共用 y=20 的公共边（实线落在中心线位置上）。 */
const SPLIT_HALVES = [
  '<polygon points="10,10 50,10 50,20 10,20" stroke-width="0.5"/>',
  '<polygon points="10,20 50,20 50,30 10,30" stroke-width="0.5"/>',
].join('\n')

/** 细点划线：长划—点—长划—点……交错，间隔 2 毫米。 */
const DASH_DOT = [
  '<line x1="4" y1="20" x2="12" y2="20" stroke-width="0.25"/>',
  '<line x1="14" y1="20" x2="14.4" y2="20" stroke-width="0.25"/>',
  '<line x1="16" y1="20" x2="24" y2="20" stroke-width="0.25"/>',
  '<line x1="26" y1="20" x2="26.4" y2="20" stroke-width="0.25"/>',
  '<line x1="28" y1="20" x2="36" y2="20" stroke-width="0.25"/>',
  '<line x1="38" y1="20" x2="38.4" y2="20" stroke-width="0.25"/>',
  '<line x1="40" y1="20" x2="48" y2="20" stroke-width="0.25"/>',
].join('\n')

/** 一条取向为 `deg`、长 `lengthMm` 的线（起点 `x,y`）。 */
function stroke(x: number, y: number, deg: number, lengthMm = 6): string {
  const radians = (deg * Math.PI) / 180
  return `<line x1="${x}" y1="${y}" x2="${x + lengthMm * Math.cos(radians)}" y2="${y + lengthMm * Math.sin(radians)}" stroke-width="0.25"/>`
}

/** `deg` 取向的一族平行线：`count` 条、起点沿 y 递增 `step` 毫米（同一零件的剖面线）。 */
function hatchFamily(x: number, y: number, deg: number, count: number, step: number): string {
  return Array.from({ length: count }, (_, index) => stroke(x, y + index * step, deg)).join('\n')
}

/**
 * 两个相邻零件（右件带切角，与左件不互为镜像）各打一族剖面线，取向由调用方给出。
 * @param leftDeg - 左件剖面线取向（度）。
 * @param rightDeg - 右件剖面线取向（度）。
 * @param group - 两轮廓同属一个材料时给出的分组号；undefined 时各自成组。
 * @returns 图元文本。
 */
function adjacentHatch(leftDeg: number, rightDeg: number, group?: number): string {
  const mark = group === undefined ? '' : ` data-dsh-hatch-group="${String(group)}"`
  return [
    `<polygon points="0,0 40,0 40,20 0,20" stroke-width="0.5"${mark}/>`,
    `<polygon points="40,0 80,0 80,20 60,20 40,12" stroke-width="0.5"${mark}/>`,
    hatchFamily(6, 4, leftDeg, 3, 2),
    hatchFamily(46, 4, rightDeg, 3, 2),
  ].join('\n')
}

describe('checkFigureRendering 量测', () => {
  it('报告线宽分布、线段取向分布与文字数', () => {
    const report = checkFigureRendering(svg([
      '<polygon points="0,0 40,0 40,20 0,20" stroke-width="0.5"/>',
      '<line x1="0" y1="0" x2="10" y2="10" stroke-width="0.25"/>',
      '<line x1="0" y1="5" x2="10" y2="5" stroke-width="0.25"/>',
      '<text x="60" y="10" font-size="3.5" text-anchor="middle" fill="#000000" stroke="none">1</text>',
    ].join('\n')))
    expect(report.widthMm).toBe(120)
    expect(report.heightMm).toBe(40)
    expect(report.textCount).toBe(1)
    expect(report.strokeWidthMm).toEqual([{ widthMm: 0.25, count: 2 }, { widthMm: 0.5, count: 1 }])
    // 45° 的线段与竖直/水平的多边形边各成一桶，按线段数降序。
    expect(report.orientationDeg.map(entry => entry.orientationDeg)).toEqual([0, 90, 45])
  })

  it('未声明 stroke-width 的图元继承祖先组的线宽，声明 stroke: none 的不计入分布', () => {
    // 与电路图同形：外壳给线宽，符号自己不给；实心箭头取消描边。
    const report = checkFigureRendering(svg([
      '<polyline points="0,0 10,0 10,10" stroke-width="0.25"/>',
      '<rect x="20" y="0" width="10" height="10"/>',
      '<circle cx="50" cy="5" r="4"/>',
      '<polygon points="60,0 70,0 65,8" fill="#000000" stroke="none"/>',
    ].join('\n')))
    // 三个描边图元按外壳的 0.35 计入；取消描边的箭头不计入。
    expect(report.strokeWidthMm).toEqual([{ widthMm: 0.25, count: 1 }, { widthMm: 0.35, count: 2 }])
    expect(report.findings).toEqual([])
  })

  it('画布尺寸取自根元素本身，子元素的 width/height 不当画布', () => {
    // 外部 SVG 只给 viewBox，子图元自带 width/height：不得把它当成画布而误报越界。
    const report = checkFigureRendering(svg('<rect x="0" y="0" width="10" height="80"/>', 'viewBox="0 0 120 40"'))
    expect(report.widthMm).toBeUndefined()
    expect(report.heightMm).toBeUndefined()
    expect(report.findings).toEqual([])
  })

  it('标号在零件外且引线止于数字外框：无发现', () => {
    const report = checkFigureRendering(svg([
      '<polygon points="10,10 50,10 50,30 10,30" stroke-width="0.5"/>',
      // 引线按绘图侧口径标注 data-dsh-role="leader"：它止于数字外框，不参与净距判据。
      '<line x1="30" y1="20" x2="78.2" y2="9.16" stroke-width="0.25" data-dsh-role="leader"/>',
      '<text x="80" y="9.2" font-size="3.5" text-anchor="middle" fill="#000000" stroke="none">3</text>',
    ].join('\n')))
    expect(report.findings).toEqual([])
    // 同一段线不标注引线时按图元处理：距数字外框 0.8 毫米，净距判据报出。
    const unmarked = checkFigureRendering(svg([
      '<polygon points="10,10 50,10 50,30 10,30" stroke-width="0.5"/>',
      '<line x1="30" y1="20" x2="78.2" y2="9.16" stroke-width="0.25"/>',
      '<text x="80" y="9.2" font-size="3.5" text-anchor="middle" fill="#000000" stroke="none">3</text>',
    ].join('\n')))
    expect(unmarked.findings.map(finding => finding.check)).toEqual(['text-clearance'])
    expect(unmarked.findings[0]?.message).toContain('仅 0.8 毫米')
  })
})

describe('checkFigureRendering 与直绘图型同源', () => {
  it('工具自己画的剖视图（标号外置 + 引线）无发现', () => {
    // 引线止点由 leaderEnd 解在占位框边界上，坐标只保留三位小数；复核侧必须用同一
    // 口径量测，否则工具自己画的引线会被报成「贯穿文字」（这里止点落在边界内侧
    // 1.8e-15 毫米处，按「与边相交」判定就会误报）。
    const spec = buildSectionDiagram({
      parts: [{ outline: [[0, 0], [5, 0], [5, 3.1], [0, 3.1]], label: '1', hatch: 'none' }],
      paddingMm: 0.7,
    })
    expect(checkFigureRendering(vectorFigureSvg(spec, '剖视图')).findings).toEqual([])
  })

  it('多字标号按内容宽度计入画布：标号不被裁切', () => {
    // 标号是画布右边界的最外元素；按字号正方形估算会画窄，标号右半被裁掉。
    const spec = buildSectionDiagram({
      parts: [{ outline: [[0, 0], [40, 0], [40, 25], [0, 25]], label: '上盖板组件' }],
    })
    expect(checkFigureRendering(vectorFigureSvg(spec, '剖视图')).findings).toEqual([])
  })
})

describe('checkFigureRendering 视口换算', () => {
  it('viewBox 用 px 级用户单位时按 viewBox 换算毫米：满页图形不算越界', () => {
    const page = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 744.09 1052.36">
  <rect x="0" y="0" width="744.09" height="1052.36" stroke="#000000" stroke-width="0.5"/>
</svg>`
    const report = checkFigureRendering(page)
    expect(report.findings).toEqual([])
    expect(report.widthMm).toBe(210)
    expect(report.heightMm).toBe(297)
    // 线宽按 viewBox 换算到毫米：0.5 用户单位 = 0.141 毫米，而不是 0.5「毫米」。
    expect(report.strokeWidthMm[0]?.widthMm).toBeCloseTo(0.141, 3)
  })

  it('嵌套 <svg> 的内层视口不当画布：整段记为未量测，不按内层尺寸误报越界', () => {
    const nested = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg" width="120mm" height="40mm" viewBox="0 0 120 40">
  <text x="4" y="14" font-size="3.5" fill="#000000" stroke="none">A</text>
  <svg x="50" y="5" width="30" height="30"><rect x="0" y="0" width="60" height="60" stroke-width="0.5"/></svg>
</svg>`
    const report = checkFigureRendering(nested)
    expect(report.widthMm).toBe(120)
    expect(report.heightMm).toBe(40)
    expect(report.textCount).toBe(1)
    // 内层矩形的几何整段不量测：线宽分布里没有它。
    expect(report.strokeWidthMm).toEqual([])
    expect(report.findings.map(finding => finding.check)).toEqual(['not-measured'])
    expect(report.findings[0]?.message).toContain('嵌套')
  })

  it('preserveAspectRatio="none" 的拉伸与 slice 裁剪各记一条近似说明', () => {
    const stretched = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="50mm" viewBox="0 0 100 100" preserveAspectRatio="none">
  <rect x="0" y="0" width="100" height="100" stroke-width="0.5"/>
</svg>`
    expect(checkFigureRendering(stretched).findings[0]?.message).toContain('none')
    expect(checkFigureRendering(stretched.replace(' preserveAspectRatio="none"', ''))).toMatchObject({})
  })
})

describe('checkFigureRendering 点划线（虚线元素）', () => {
  it('stroke-dasharray 画出的点划线同样按虚线段量测：被同位置实线覆盖时报出', () => {
    const dashed = svg([
      '<polygon points="0,20 40,20 40,25 0,25" stroke-width="0.5"/>',
      '<polygon points="0,20 40,20 40,15 0,15" stroke-width="0.5"/>',
      '<line x1="2" y1="20" x2="38" y2="20" stroke-width="0.25" stroke-dasharray="8 2 0.4 2"/>',
    ].join('\n'))
    const report = checkFigureRendering(dashed)
    expect(report.findings.map(finding => finding.check)).toEqual(['centerline-covered'])
    expect(report.findings[0]?.message).toContain('连续墨迹')
  })

  it('点划线自身间隔小于 1 毫米但无实线覆盖时不报（不把自身间隔当实线）', () => {
    const fine = svg('<line x1="2" y1="20" x2="38" y2="20" stroke-width="0.25" stroke-dasharray="7 0.6 0.4 0.6"/>')
    expect(checkFigureRendering(fine).findings).toEqual([])
  })

  it('虚线元素的虚线段计入签名，长划长度不超过上界：单独一条点划线不报', () => {
    const dashed = svg('<line x1="2" y1="20" x2="38" y2="20" stroke-width="0.25" stroke-dasharray="8 2 0.4 2"/>')
    expect(checkFigureRendering(dashed).findings).toEqual([])
  })
})

describe('checkFigureRendering 字号与对齐的继承', () => {
  it('未声明 font-size 的文字按 CSS 初值估框：贯穿仍报出（框不再退化为一点）', () => {
    // 整幅下移 2 毫米：按 16 用户单位估框后，占位框仍落在画布内。
    const report = checkFigureRendering(svg([
      '<polygon points="10,12 50,12 50,32 10,32" stroke-width="0.5"/>',
      '<line x1="30" y1="22" x2="80" y2="12" stroke-width="0.25"/>',
      '<text x="80" y="13.2" text-anchor="middle" fill="#000000" stroke="none">3</text>',
    ].join('\n')))
    expect(report.textCount).toBe(1)
    expect(report.findings.map(finding => finding.check)).toEqual(['text-crossed-by-line'])
  })

  it('<g> 上的 text-anchor 与行内 style 的字号参与换算', () => {
    const grouped = svg([
      '<g text-anchor="middle"><polygon points="10,10 50,10 50,30 10,30" stroke-width="0.5"/>',
      '<line x1="30" y1="20" x2="78.2" y2="9.16" stroke-width="0.25" data-dsh-role="leader"/>',
      '<text x="80" y="9.2" font-size="3.5" fill="#000000" stroke="none">3</text></g>',
    ].join('\n'))
    expect(checkFigureRendering(grouped).findings).toEqual([])
    // style 的 7 号字：占位框 y∈[4.75,10.84]，y=3 的线在框外 1.75 毫米；若按 16 号初值算框
    // 会把 y=3 的线算进框内，报出贯穿。
    const styled = svg([
      '<text x="10" y="10" style="font-size:7;text-anchor:middle" fill="#000000" stroke="none">接地</text>',
      '<line x1="0" y1="3" x2="20" y2="3" stroke-width="0.25"/>',
    ].join('\n'))
    expect(checkFigureRendering(styled).findings).toEqual([])
    expect(checkFigureRendering(styled.replace('font-size:7;', '')).findings.map(finding => finding.check))
      .toContain('text-crossed-by-line')
  }, 20_000)
})

describe('checkFigureRendering 未量测结构', () => {
  it('样式表、tspan 偏移、端头标记、基线属性、百分比长度各记一条', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['<style>.n{fill:none}</style>', '样式表'],
      ['<defs><style>.n{stroke-width:1}</style></defs>', '样式表'],
      ['<text x="4" y="10" font-size="3.5"><tspan x="4" dy="4">A</tspan></text>', 'tspan'],
      ['<line x1="0" y1="0" x2="5" y2="5" stroke-width="0.25" marker-end="url(#a)"/>', 'marker'],
      ['<text x="4" y="10" font-size="3.5" dominant-baseline="middle">A</text>', 'dominant-baseline'],
      ['<rect x="0" y="0" width="50%" height="10" stroke-width="0.5"/>', '百分比'],
    ]
    for (const [element, expected] of cases) {
      const report = checkFigureRendering(svg(element))
      expect([element, report.findings.some(finding => finding.message.includes(expected))]).toEqual([element, true])
    }
  })

  it('display: none 的子树按不渲染跳过：不算墨迹，也不报未量测', () => {
    const hidden = svg([
      '<rect x="200" y="0" width="50" height="50" stroke-width="0.5" display="none"/>',
      '<rect x="0" y="0" width="10" height="10" stroke-width="0.5" style="display:none"/>',
      '<rect x="0" y="0" width="10" height="10" stroke-width="0.5"/>',
    ].join('\n'))
    const report = checkFigureRendering(hidden)
    expect(report.findings).toEqual([])
    expect(report.strokeWidthMm).toEqual([{ widthMm: 0.5, count: 1 }])
  })
})

describe('checkFigureRendering 文字被线条贯穿', () => {
  it('引线穿过文字占位框时报 text-crossed-by-line', () => {
    const report = checkFigureRendering(svg([
      '<polygon points="10,10 50,10 50,30 10,30" stroke-width="0.5"/>',
      '<line x1="30" y1="20" x2="80" y2="10" stroke-width="0.25"/>',
      '<text x="80" y="11.2" font-size="3.5" text-anchor="middle" fill="#000000" stroke="none">3</text>',
    ].join('\n')))
    expect(report.findings.map(finding => finding.check)).toEqual(['text-crossed-by-line'])
    expect(report.findings[0]?.message).toContain('图面文字「3」被线条贯穿')
  })

  it('标号落在零件内部被剖面线压住时同样报出', () => {
    const report = checkFigureRendering(svg([
      '<polygon points="10,10 50,10 50,30 10,30" stroke-width="0.5"/>',
      '<line x1="12" y1="26" x2="28" y2="14" stroke-width="0.25"/>',
      '<text x="20" y="20" font-size="3.5" text-anchor="middle" fill="#000000" stroke="none">5</text>',
    ].join('\n')))
    expect(report.findings.map(finding => finding.check)).toEqual(['text-crossed-by-line'])
  })

  it('折线、矩形、椭圆与路径的边同样计入贯穿判定', () => {
    for (const element of [
      '<polyline points="30,20 80,10" stroke-width="0.25"/>',
      '<rect x="70" y="4" width="9" height="14" stroke-width="0.25"/>',
      '<ellipse cx="70" cy="11" rx="9" ry="6" stroke-width="0.25"/>',
      '<path d="M 30 20 L 80 10" stroke-width="0.25"/>',
    ]) {
      const report = checkFigureRendering(svg([
        '<polygon points="10,10 50,10 50,30 10,30" stroke-width="0.5"/>',
        element,
        '<text x="80" y="11.2" font-size="3.5" text-anchor="middle" fill="#000000" stroke="none">3</text>',
      ].join('\n')))
      expect([element, report.findings.map(finding => finding.check)])
        .toEqual([element, ['text-crossed-by-line']])
    }
  })

  it('纵排数字按自身旋转换算占位框：转成竖条后不再被轴线贯穿', () => {
    // 曲线图的纵轴名绕锚点旋转 −90°：占位框随之转成竖条，不再横跨轴线。
    const vertical = [
      '<polygon points="10,0 12,0 12,40 10,40" stroke-width="0.5"/>',
      '<text x="9.4" y="20" font-size="3.5" text-anchor="middle" transform="rotate(-90 9.4 20)">温</text>',
    ].join('\n')
    const rotated = svg(vertical)
    expect(checkFigureRendering(rotated, { textClearanceMm: 0 }).findings).toEqual([])
    // 这里是刻意贴轴放置（转成竖条后右边界距轴线 0.18 毫米），净距判据因此仍报出——两条
    // 判据管的事不同：贯穿判定管「字被线压住」，净距判定管「字离线太近」。
    expect(checkFigureRendering(rotated).findings.map(finding => finding.check)).toEqual(['text-clearance'])
    // 同一段文字若不旋转，占位框横跨轴线，正是贯穿判定要报的图面缺陷。
    expect(checkFigureRendering(svg(vertical.replace(' transform="rotate(-90 9.4 20)"', ''))).findings
      .map(finding => finding.check)).toEqual(['text-crossed-by-line'])
  })
})

describe('checkFigureRendering 点划线被实线覆盖', () => {
  it('公共边压在中心线位置上时报 centerline-covered', () => {
    const report = checkFigureRendering(svg([SPLIT_HALVES, DASH_DOT].join('\n')))
    expect(report.findings.map(finding => finding.check)).toEqual(['centerline-covered'])
    expect(report.findings[0]?.message).toContain('y=20')
  })

  it('点划线间隔可见时（无同位置实线）不报', () => {
    const report = checkFigureRendering(svg(DASH_DOT))
    expect(report.findings).toEqual([])
  })

  it('零件轮廓的零碎短边不被误判为点划线', () => {
    // 一行里只有轮廓边：两条长边 + 四条短边，跨度足够但没有 3 个「点」。
    const report = checkFigureRendering(svg([
      '<polygon points="0,20 40,20 40,25 0,25" stroke-width="0.5"/>',
      '<polygon points="0,20 40,20 40,15 0,15" stroke-width="0.5"/>',
    ].join('\n')))
    expect(report.findings).toEqual([])
  })
})

describe('checkFigureRendering 相邻剖面线难以区分', () => {
  it('相邻两件取向仅差 15°、间距也比不出差别时报 hatch-orientation-collision', () => {
    const report = checkFigureRendering(svg(adjacentHatch(135, 150)))
    expect(report.findings.map(finding => finding.check)).toEqual(['hatch-orientation-collision'])
    expect(report.findings[0]?.message).toContain('15°')
    // 两件间距 1.4 与 1.7 毫米（比 1.22），相差不足 1.5 倍，仍读作同一种疏密。
    expect(report.findings[0]?.message).toContain('间距 1.4 毫米')
    expect(report.findings[0]?.message).toContain('间距 1.7 毫米')
  })

  it('相邻两件取向相同但间距相差 1.7 倍时不报：间距不等已可区分', () => {
    const report = checkFigureRendering(svg([
      '<polygon points="0,0 40,0 40,20 0,20" stroke-width="0.5"/>',
      '<polygon points="40,0 80,0 80,20 60,20 40,12" stroke-width="0.5"/>',
      hatchFamily(6, 4, 135, 3, 2),
      hatchFamily(46, 4, 135, 3, 3.4),
    ].join('\n')))
    expect(report.findings).toEqual([])
  })

  it('相邻两件方向差 30° 且间距不等时不报：两项判据有一项可区分即可', () => {
    const report = checkFigureRendering(svg([
      '<polygon points="0,0 40,0 40,20 0,20" stroke-width="0.5"/>',
      '<polygon points="40,0 80,0 80,20 60,20 40,12" stroke-width="0.5"/>',
      hatchFamily(6, 4, 135, 3, 2),
      hatchFamily(46, 4, 165, 3, 3),
    ].join('\n')))
    expect(report.findings).toEqual([])
  })

  it('一侧量不出间距（同取向线段投影重合）时按分不清处理：判据只放宽不收紧', () => {
    // 右件的三条 0° 线共线，同取向达 3 条却量不出相邻间距；左件间距 1.5 毫米。
    const report = checkFigureRendering(svg([
      '<polygon points="0,0 40,0 40,20 0,20" stroke-width="0.5"/>',
      '<polygon points="40,0 80,0 80,20 60,20 40,12" stroke-width="0.5"/>',
      '<line x1="6" y1="6" x2="20" y2="6" stroke-width="0.25"/>',
      '<line x1="6" y1="7.5" x2="20" y2="7.5" stroke-width="0.25"/>',
      '<line x1="6" y1="9" x2="20" y2="9" stroke-width="0.25"/>',
      '<line x1="46" y1="6" x2="50" y2="6" stroke-width="0.25"/>',
      '<line x1="52" y1="6" x2="56" y2="6" stroke-width="0.25"/>',
      '<line x1="58" y1="6" x2="62" y2="6" stroke-width="0.25"/>',
    ].join('\n')))
    expect(report.findings.map(finding => finding.check)).toEqual(['hatch-orientation-collision'])
    expect(report.findings[0]?.message).toContain('间距未测出')
  })

  it('剖面线族不整齐时取升序相邻间距的中位数作代表间距', () => {
    // 左件的 0° 线落在 y=6/7/17/18/20：相邻间距依次是 1、10、1、2，升序中位数为 1.5；
    // 若按出现顺序取中位（(10+1)/2=5.5）则会与右件的 1 毫米判成不同疏密而漏报。
    const report = checkFigureRendering(svg([
      '<polygon points="0,0 40,0 40,24 0,24" stroke-width="0.5"/>',
      '<polygon points="40,0 80,0 80,24 60,24 40,16" stroke-width="0.5"/>',
      '<line x1="6" y1="6" x2="30" y2="6" stroke-width="0.25"/>',
      '<line x1="6" y1="7" x2="30" y2="7" stroke-width="0.25"/>',
      '<line x1="6" y1="17" x2="30" y2="17" stroke-width="0.25"/>',
      '<line x1="6" y1="18" x2="30" y2="18" stroke-width="0.25"/>',
      '<line x1="6" y1="20" x2="30" y2="20" stroke-width="0.25"/>',
      '<line x1="46" y1="6" x2="70" y2="6" stroke-width="0.25"/>',
      '<line x1="46" y1="7" x2="70" y2="7" stroke-width="0.25"/>',
      '<line x1="46" y1="8" x2="70" y2="8" stroke-width="0.25"/>',
      '<line x1="46" y1="9" x2="70" y2="9" stroke-width="0.25"/>',
      '<line x1="46" y1="10" x2="70" y2="10" stroke-width="0.25"/>',
      '<line x1="46" y1="11" x2="70" y2="11" stroke-width="0.25"/>',
    ].join('\n')))
    expect(report.findings.map(finding => finding.check)).toEqual(['hatch-orientation-collision'])
    expect(report.findings[0]?.message).toContain('间距 1.5 毫米')
    expect(report.findings[0]?.message).toContain('间距 1 毫米')
  })

  it('相邻两件取向相反时（差 90°）不报', () => {
    expect(checkFigureRendering(svg(adjacentHatch(45, 135))).findings).toEqual([])
  })

  it('互为镜像的同一零件两半（取向相同）不报', () => {
    const report = checkFigureRendering(svg([
      '<polygon points="0,0 20,0 20,5 0,10" stroke-width="0.5"/>',
      '<polygon points="0,20 20,20 20,15 0,10" stroke-width="0.5"/>',
      hatchFamily(4, 4, 45, 3, 1),
      hatchFamily(4, 16, 45, 3, -1),
    ].join('\n')))
    expect(report.findings).toEqual([])
  })

  it('尺寸相同但轮廓不互为镜像时仍比较相邻件取向', () => {
    const report = checkFigureRendering(svg([
      '<polygon points="0,0 20,0 20,5 10,5 10,10 0,10" stroke-width="0.5"/>',
      '<polygon points="0,11 20,11 20,16 15,16 15,21 0,21" stroke-width="0.5"/>',
      hatchFamily(4, 2, 45, 3, 1.5),
      hatchFamily(4, 13, 45, 3, 1.5),
    ].join('\n')))
    expect(report.findings.map(finding => finding.check)).toEqual(['hatch-orientation-collision'])
  })

  it('零件内的零散线条不构成剖面线：符号笔画与穿行线不触发取向比较', () => {
    // 与电路图同形：两个相邻符号各有 1–2 条内部笔画，不是剖面线族。
    const report = checkFigureRendering(svg([
      '<rect x="0" y="0" width="20" height="20" stroke-width="0.35"/>',
      '<rect x="20" y="0" width="20" height="20" stroke-width="0.35"/>',
      stroke(6, 10, 0, 8),
      stroke(26, 10, 0, 8),
    ].join('\n')))
    expect(report.findings).toEqual([])
  })

  it('同一材料的两个轮廓（同分组号）取向相同不报：输入约定就是同一零件各给一段', () => {
    expect(checkFigureRendering(svg(adjacentHatch(135, 135, 2))).findings).toEqual([])
  })

  it('分组号不同的相邻两件取向相同仍报出', () => {
    const report = checkFigureRendering(svg([
      '<polygon points="0,0 40,0 40,20 0,20" stroke-width="0.5" data-dsh-hatch-group="0"/>',
      '<polygon points="40,0 80,0 80,20 60,20 40,12" stroke-width="0.5" data-dsh-hatch-group="1"/>',
      hatchFamily(6, 4, 135, 3, 2),
      hatchFamily(46, 4, 135, 3, 2),
    ].join('\n')))
    expect(report.findings.map(finding => finding.check)).toEqual(['hatch-orientation-collision'])
  })

  it('分组号非法（非整数）时该轮廓自成一组，取向相同仍报出', () => {
    const report = checkFigureRendering(svg([
      '<polygon points="0,0 40,0 40,20 0,20" stroke-width="0.5" data-dsh-hatch-group="甲"/>',
      '<polygon points="40,0 80,0 80,20 60,20 40,12" stroke-width="0.5" data-dsh-hatch-group="1.5"/>',
      hatchFamily(6, 4, 135, 3, 2),
      hatchFamily(46, 4, 135, 3, 2),
    ].join('\n')))
    expect(report.findings.map(finding => finding.check)).toEqual(['hatch-orientation-collision'])
  })
})

describe('checkFigureRendering 画布与变换', () => {
  it('墨迹越出画布时报 ink-outside-canvas', () => {
    const report = checkFigureRendering(svg('<polygon points="0,0 140,0 140,20 0,20" stroke-width="0.5"/>'))
    expect(report.findings.map(finding => finding.check)).toEqual(['ink-outside-canvas'])
  })

  it('平移到根组的坐标计入墨迹范围', () => {
    const translated = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 40 20">
  <g transform="translate(38,0)"><polygon points="0,0 10,0 10,10 0,10" stroke-width="0.5"/></g>
</svg>`
    expect(checkFigureRendering(translated).findings.map(finding => finding.check)).toEqual(['ink-outside-canvas'])
  })

  it('并列的兄弟组各按自己的变换换算，平移不相加', () => {
    const siblings = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 40 20">
  <g transform="translate(20,0)"><rect x="0" y="0" width="10" height="10" stroke-width="0.5"/></g>
  <g transform="translate(20,0)"><rect x="0" y="10" width="10" height="10" stroke-width="0.5"/></g>
</svg>`
    expect(checkFigureRendering(siblings).findings).toEqual([])
  })

  it('缩放与旋转按累计矩阵换算到根坐标系量测', () => {
    const scaled = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 210 297">
  <g fill="none" stroke="#000000" transform="translate(25,102.297) scale(1.525)"><polygon points="0,0 10,0 10,10 0,10" stroke-width="0.5"/></g>
</svg>`
    const report = checkFigureRendering(scaled)
    expect(report.findings).toEqual([])
    // 线宽按平均缩放换算：0.5 × 1.525。
    expect(report.strokeWidthMm).toEqual([{ widthMm: 0.763, count: 1 }])
    const overflowing = scaled.replace('translate(25,102.297)', 'translate(25,290)')
    expect(checkFigureRendering(overflowing).findings.map(finding => finding.check)).toEqual(['ink-outside-canvas'])
    const rotated = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 40 20">
  <g fill="none" stroke="#000000" transform="rotate(90 20 10)"><rect x="10" y="0" width="20" height="2" stroke-width="0.5"/></g>
</svg>`
    expect(checkFigureRendering(rotated).findings).toEqual([])
  })

  it('实体、超限与非 SVG 输入被拒绝', () => {
    expect(() => checkFigureRendering('<!ENTITY x "y">')).toThrow(SvgAnnotateError)
    expect(() => checkFigureRendering(svg('<text>1</text>'), { maxBytes: 10 })).toThrow(SvgAnnotateError)
    expect(() => checkFigureRendering('<html></html>')).toThrow(SvgAnnotateError)
  })
})

describe('checkFigureRendering 未量测发现', () => {
  it('样式表、引用元素、不可解析的变换各出一条 not-measured', () => {
    const styled = svg('<line x1="0" y1="0" x2="5" y2="5" stroke-width="0.25"/>').replace('<g ', '<style>.n{stroke-width:1}</style><g ')
    expect(checkFigureRendering(styled).findings.map(finding => finding.check)).toEqual(['not-measured'])
    expect(checkFigureRendering(styled).findings[0]?.message).toContain('样式表')
    const referenced = svg('<use href="#a"/><image href="a.png" width="10" height="10"/>')
    expect(checkFigureRendering(referenced).findings[0]?.message).toContain('未展开')
    const skewed = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 40 20">
  <g transform="skewX(10)"><polygon points="0,0 10,0 10,10 0,10" stroke-width="0.5"/></g>
</svg>`
    const report = checkFigureRendering(skewed)
    expect(report.findings.map(finding => finding.check)).toEqual(['not-measured'])
    // 变换不可换算 ⇒ 该子树整体不进量测，也不谎报「未发现问题」。
    expect(report.strokeWidthMm).toEqual([])
  })

  it('曲线路径按端点弦近似，并说明近似范围', () => {
    const report = checkFigureRendering(svg([
      '<path d="M 10 20 a 5 5 0 0 1 10 0" stroke-width="0.25"/>',
      '<text x="60" y="10" font-size="3.5" text-anchor="middle" fill="#000000" stroke="none">1</text>',
    ].join('\n')))
    expect(report.findings.map(finding => finding.check)).toEqual(['not-measured'])
    expect(report.findings[0]?.message).toContain('曲线段按端点弦近似')
    // 弦被计入量测：取向分布里能看到这条 0° 的弦。
    expect(report.orientationDeg).toEqual([{ orientationDeg: 0, count: 1 }])
  })

  it('定义容器的子元素不渲染也不量测，引用之外的结构仍量测', () => {
    const report = checkFigureRendering(svg([
      '<defs><polygon points="0,0 200,0 200,200 0,200" stroke-width="0.5"/><path d="???"/></defs>',
      '<polygon points="10,10 20,10 20,20 10,20" stroke-width="0.5"/>',
    ].join('\n')))
    expect(report.findings).toEqual([])
    expect(report.strokeWidthMm).toEqual([{ widthMm: 0.5, count: 1 }])
  })

  it('无法解析的路径命令单独报未量测，不影响其余图元', () => {
    const report = checkFigureRendering(svg([
      '<path d="Z 1 2" stroke-width="0.25"/>',
      '<polygon points="10,10 20,10 20,20 10,20" stroke-width="0.5"/>',
    ].join('\n')))
    expect(report.findings.map(finding => finding.check)).toEqual(['not-measured'])
    expect(report.findings[0]?.message).toContain('无法解析的命令')
    expect(report.strokeWidthMm).toEqual([{ widthMm: 0.5, count: 1 }])
  })

  it('量测无缺口时不出 not-measured，逐项量测都参与判定', () => {
    const report = checkFigureRendering(svg('<polygon points="0,0 4,0 4,4" stroke-width="0.5"/>', 'viewBox="0 0 4 4"'))
    expect(report.widthMm).toBeUndefined()
    expect(report.heightMm).toBeUndefined()
    expect(report.findings).toEqual([])
  })
})

describe('checkFigureRendering 解析边界', () => {
  it('跳过退化的图元：点数不足的多边形、坐标缺失的线、非数字坐标', () => {
    const report = checkFigureRendering(svg([
      '<polygon points="1,1 2,2" stroke-width="0.5"/>',
      '<polygon points="a,b c,d e,f" stroke-width="0.5"/>',
      '<line x1="1" y1="1" x2="2" stroke-width="0.25"/>',
      '<polygon points="0,0 10,0 10,10 0,10" stroke-width="0.5"/>',
    ].join('\n')))
    // 只有一个合法多边形进入量测。
    expect(report.strokeWidthMm).toEqual([{ widthMm: 0.5, count: 1 }])
    expect(report.findings).toEqual([])
  })

  it('非数字数值属性按未声明处理，继承祖先取值', () => {
    const report = checkFigureRendering(svg([
      '<polygon points="0,0 10,0 10,10 0,10" stroke-width="abc"/>',
      '<polygon points="0,0 5" stroke-width="0.5"/>',
      '<line x1="0" y1="0" x2="5" stroke-width="0.25"/>',
      '<text x="20" y="5" font-size="0" fill="#000000" stroke="none">9</text>',
    ].join('\n')))
    // stroke-width 非数字 → 取外壳的 0.35；点数不足的多边形与缺 y2 的线被跳过。
    expect(report.strokeWidthMm).toEqual([{ widthMm: 0.35, count: 1 }])
    expect(report.textCount).toBe(1)
  })

  it('恒等缩放与单参数 translate 参与坐标换算', () => {
    const body = '<polygon points="0,0 10,0 10,10 0,10" stroke-width="0.5"/>'
    const translated = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 40 20">
  <g transform="translate(5,5) scale(1)">${body}</g>
</svg>`
    expect(checkFigureRendering(translated).findings).toEqual([])
    const shifted = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="20mm" viewBox="0 0 40 20">
  <g transform="translate(35)">${body}</g>
</svg>`
    expect(checkFigureRendering(shifted).findings.map(finding => finding.check)).toEqual(['ink-outside-canvas'])
  })

  it('相对命令按当前位置累加，绝对命令重置', () => {
    // 同一条折线的绝对与相对写法必须量测一致。
    const absolute = checkFigureRendering(svg('<path d="M 10 10 L 40 10" stroke-width="0.25"/>'))
    const relative = checkFigureRendering(svg('<path d="m 10 10 l 30 0" stroke-width="0.25"/>'))
    expect(relative.orientationDeg).toEqual(absolute.orientationDeg)
    expect(relative.findings).toEqual([])
    // 小写 m 是相对起点，大写 M 是绝对起点：相对写法不会跳到原点。
    const moved = checkFigureRendering(svg('<path d="m 30 20 l 5 0 h 5 v -5 z" stroke-width="0.25"/>'))
    expect(moved.findings).toEqual([])
    // 两条 0° 边（l 与 h）、一条 90° 边（v）与 z 的收口斜边。
    expect(moved.orientationDeg).toEqual([
      { orientationDeg: 0, count: 2 },
      { orientationDeg: 90, count: 1 },
      { orientationDeg: 153.4, count: 1 },
    ])
  })

  it('H/V 只改一个分量：绝对形式与相对形式量测一致', () => {
    // 绝对 H/V 只给一个坐标，另一个分量保持不动（把它当 0 会让之后的坐标全部错位）。
    const absolute = checkFigureRendering(svg('<path d="M 10 20 H 30 V 5" stroke-width="0.25"/>'))
    const relative = checkFigureRendering(svg('<path d="m 10 20 h 20 v -15" stroke-width="0.25"/>'))
    expect(absolute.findings).toEqual([])
    expect(relative.orientationDeg).toEqual(absolute.orientationDeg)
    expect(absolute.orientationDeg).toEqual([
      { orientationDeg: 0, count: 1 },
      { orientationDeg: 90, count: 1 },
    ])
    // 混写（Inkscape 的文字轮廓路径形态）：绝对 V 之后接相对命令，坐标仍从该点累加。
    const mixed = checkFigureRendering(svg('<path d="m 10 20 v 5 V 8 h 4" stroke-width="0.25"/>'))
    expect(mixed.orientationDeg).toEqual([
      { orientationDeg: 90, count: 2 },
      { orientationDeg: 0, count: 1 },
    ])
  })

  it('尺寸不同的相邻件不按镜像排除：取向差 0° 仍报出', () => {
    const report = checkFigureRendering(svg([
      '<polygon points="0,0 40,0 40,20 0,20" stroke-width="0.5"/>',
      '<polygon points="40,0 80,0 80,30 40,30" stroke-width="0.5"/>',
      hatchFamily(10, 6, 135, 3, 3),
      hatchFamily(50, 6, 135, 3, 3),
    ].join('\n')))
    expect(report.findings.map(finding => finding.check)).toEqual(['hatch-orientation-collision'])
  })

  it('只有一件有剖面线时不比较取向，也不报出', () => {
    // 右件带切角（与左件尺寸相同但不互为镜像），故进入取向比较；它没有剖面线。
    const report = checkFigureRendering(svg([
      '<polygon points="0,0 40,0 40,20 0,20" stroke-width="0.5"/>',
      '<polygon points="40,0 80,0 80,20 45,20" stroke-width="0.5"/>',
      hatchFamily(10, 6, 135, 3, 3),
    ].join('\n')))
    expect(report.findings).toEqual([])
  })

  it('尺寸相同的相邻件若不互为镜像，仍按取向比较', () => {
    // 两件同为 40×20 但右件为梯形：不是镜像对，取向相同即报出。
    const report = checkFigureRendering(svg([
      '<polygon points="0,0 40,0 40,20 0,20" stroke-width="0.5"/>',
      '<polygon points="40,0 80,0 80,20 45,20" stroke-width="0.5"/>',
      hatchFamily(10, 6, 135, 3, 3),
      hatchFamily(50, 6, 135, 3, 3),
    ].join('\n')))
    expect(report.findings.map(finding => finding.check)).toEqual(['hatch-orientation-collision'])
  })

  it('竖直方向的点划线被同位置的实线覆盖时同样报出', () => {
    const report = checkFigureRendering(svg([
      '<polygon points="20,4 28,4 28,40 20,40" stroke-width="0.5"/>',
      '<polygon points="12,4 20,4 20,40 12,40" stroke-width="0.5"/>',
      '<line x1="20" y1="4" x2="20" y2="12" stroke-width="0.25"/>',
      '<line x1="20" y1="14" x2="20" y2="14.4" stroke-width="0.25"/>',
      '<line x1="20" y1="16" x2="20" y2="24" stroke-width="0.25"/>',
      '<line x1="20" y1="26" x2="20" y2="26.4" stroke-width="0.25"/>',
      '<line x1="20" y1="28" x2="20" y2="36" stroke-width="0.25"/>',
      '<line x1="20" y1="38" x2="20" y2="38.4" stroke-width="0.25"/>',
    ].join('\n')))
    expect(report.findings.map(finding => finding.check)).toEqual(['centerline-covered'])
    expect(report.findings[0]?.message).toContain('x=20')
  })

  it('点划签名但整行跨度不足时不报', () => {
    const report = checkFigureRendering(svg([
      '<polygon points="2,0 14,0 14,20 2,20" stroke-width="0.5"/>',
      '<line x1="3" y1="0" x2="6" y2="0" stroke-width="0.25"/>',
      '<line x1="6.4" y1="0" x2="6.8" y2="0" stroke-width="0.25"/>',
      '<line x1="7.2" y1="0" x2="7.6" y2="0" stroke-width="0.25"/>',
      '<line x1="8" y1="0" x2="8.4" y2="0" stroke-width="0.25"/>',
      '<line x1="8.8" y1="0" x2="11.8" y2="0" stroke-width="0.25"/>',
    ].join('\n')))
    expect(report.findings).toEqual([])
  })

  it('点划签名但整行跨度不足时不报（零件轮廓的零碎短边）', () => {
    const report = checkFigureRendering(svg([
      '<polygon points="0,0 12,0 12,20 0,20" stroke-width="0.5"/>',
      '<line x1="0" y1="20" x2="2" y2="20" stroke-width="0.25"/>',
      '<line x1="2.4" y1="20" x2="2.9" y2="20" stroke-width="0.25"/>',
      '<line x1="3.3" y1="20" x2="5.3" y2="20" stroke-width="0.25"/>',
      '<line x1="5.7" y1="20" x2="6.2" y2="20" stroke-width="0.25"/>',
      '<line x1="6.6" y1="20" x2="8.6" y2="20" stroke-width="0.25"/>',
      '<line x1="9" y1="20" x2="9.5" y2="20" stroke-width="0.25"/>',
    ].join('\n')))
    expect(report.findings).toEqual([])
  })
})

describe('checkFigureRendering 标号净距', () => {
  /** 字号 4 的「3」：占位框 x∈[78.8,81.2]、y∈[17,20.48]。 */
  const NUMERAL = '<text x="80" y="20" font-size="4" text-anchor="middle" fill="#000000" stroke="none">3</text>'

  /** 一条穿过 figure 的横线（默认跨 x=70–90）。 */
  const rule = (y: number): string => `<line x1="70" y1="${y}" x2="90" y2="${y}" stroke-width="0.25"/>`

  it('净距内报、净距外不报：同一条线挪过 1.5 毫米边界两侧', () => {
    const inside = checkFigureRendering(svg([rule(16), NUMERAL].join('\n')))
    expect(inside.findings.map(finding => finding.check)).toEqual(['text-clearance'])
    // 报出的距离是量测值（框上边界 y=17 到 y=16 恰好 1 毫米），不是固定文案。
    expect(inside.findings[0]?.message).toContain('仅 1 毫米')
    expect(checkFigureRendering(svg([rule(15.4), NUMERAL].join('\n'))).findings).toEqual([])
  })

  it('净距可配：收紧到 0.5 毫米后同一条线不报，放宽后 3.5 毫米外的线也报', () => {
    const atOne = svg([rule(16), NUMERAL].join('\n'))
    expect(checkFigureRendering(atOne, { textClearanceMm: 0.5 }).findings).toEqual([])
    const atThreeAndAHalf = svg([rule(13.5), NUMERAL].join('\n'))
    expect(checkFigureRendering(atThreeAndAHalf).findings).toEqual([])
    expect(checkFigureRendering(atThreeAndAHalf, { textClearanceMm: 4 }).findings.map(finding => finding.check))
      .toEqual(['text-clearance'])
    // 0 关闭该判据，其余判据不受影响。
    expect(checkFigureRendering(atOne, { textClearanceMm: 0 }).findings).toEqual([])
  })

  it('引线不参与净距：止于数字外框的引线不算贴线，穿过别的数字仍算贯穿', () => {
    const stopsAtBox = svg([
      '<line x1="20" y1="20" x2="78.7" y2="20" stroke-width="0.25" data-dsh-role="leader"/>',
      NUMERAL,
    ].join('\n'))
    // 引线止点距外框 0.1 毫米，若按图元处理必然报净距。
    expect(checkFigureRendering(stopsAtBox).findings).toEqual([])
    // 同一条线段不标注引线时按图元处理。
    const unmarked = stopsAtBox.split('\n').map(line => line.replace(' data-dsh-role="leader"', '')).join('\n')
    expect(checkFigureRendering(unmarked).findings.map(finding => finding.check)).toEqual(['text-clearance'])
    // 引线穿过另一个数字的占位框仍是贯穿（引线只豁免净距，不豁免贯穿）。
    const throughOther = svg([
      '<line x1="20" y1="18" x2="90" y2="18" stroke-width="0.25" data-dsh-role="leader"/>',
      NUMERAL,
    ].join('\n'))
    expect(checkFigureRendering(throughOther).findings.map(finding => finding.check)).toEqual(['text-crossed-by-line'])
  })

  it('白色填充是遮挡面：后画的填充盖住线段时不报，先画的不遮挡', () => {
    const fill = '<rect x="60" y="8" width="40" height="24" fill="#ffffff" stroke="none"/>'
    const line = '<line x1="77.5" y1="8" x2="77.5" y2="32" stroke-width="0.25"/>'
    // 填充在文档序里更晚 → 线段在图面上不可见，不报。
    expect(checkFigureRendering(svg([line, fill, NUMERAL].join('\n'))).findings).toEqual([])
    // 填充更早绘制 → 线段画在填充之上，照报。
    expect(checkFigureRendering(svg([fill, line, NUMERAL].join('\n'))).findings.map(finding => finding.check))
      .toEqual(['text-clearance'])
  })

  it('非白填充不做遮挡：只有不透明白色填充才算遮挡面', () => {
    const marker = '<rect x="60" y="8" width="40" height="24" fill="#cccccc" stroke="none"/>'
    const line = '<line x1="77.5" y1="8" x2="77.5" y2="32" stroke-width="0.25"/>'
    expect(checkFigureRendering(svg([line, marker, NUMERAL].join('\n'))).findings.map(finding => finding.check))
      .toEqual(['text-clearance'])
  })

  it('A6 案三处缺陷的等价构造全部报出', () => {
    // ① 标号压剖面线带：三条 45° 之外的剖面线带贴着数字外框（最上面一条距框 1 毫米）。
    const onHatchBand = svg([rule(10), rule(13), rule(16), NUMERAL].join('\n'))
    expect(checkFigureRendering(onHatchBand).findings.map(finding => finding.check)).toEqual(['text-clearance'])
    // ② 标号被竖线贯穿文字盒。
    const pierced = svg(['<line x1="80" y1="10" x2="80" y2="30" stroke-width="0.25"/>', NUMERAL].join('\n'))
    expect(checkFigureRendering(pierced).findings.map(finding => finding.check)).toEqual(['text-crossed-by-line'])
    // ③ 标号压轴线：细点划线在数字外框外 0.6 毫米处通过（长划—点—长划）。
    const onCenterline = svg([
      '<line x1="10" y1="16.4" x2="18" y2="16.4" stroke-width="0.25"/>',
      '<line x1="20" y1="16.4" x2="20.4" y2="16.4" stroke-width="0.25"/>',
      '<line x1="22" y1="16.4" x2="30" y2="16.4" stroke-width="0.25"/>',
      '<line x1="70" y1="16.4" x2="78" y2="16.4" stroke-width="0.25"/>',
      '<line x1="80" y1="16.4" x2="80.4" y2="16.4" stroke-width="0.25"/>',
      '<line x1="82" y1="16.4" x2="90" y2="16.4" stroke-width="0.25"/>',
      NUMERAL,
    ].join('\n'))
    const findings = checkFigureRendering(onCenterline).findings
    expect(findings.map(finding => finding.check)).toEqual(['text-clearance'])
    expect(findings[0]?.message).toContain('仅 0.6 毫米')
  })

  it('已被判为贯穿的文字不另报净距：同一条缺陷只报一次', () => {
    const pierced = svg([rule(18), NUMERAL].join('\n'))
    expect(checkFigureRendering(pierced).findings.map(finding => finding.check)).toEqual(['text-crossed-by-line'])
  })
})

describe('checkFigureRendering 图元叠压', () => {
  it('两个闭合轮廓包围盒部分相交时报 element-overlap，并给出相交区尺寸与位置', () => {
    const report = checkFigureRendering(svg([
      '<rect x="10" y="10" width="30" height="10" stroke-width="0.5"/>',
      '<rect x="34.8" y="8" width="6" height="6" stroke-width="0.5"/>',
    ].join('\n')))
    expect(report.findings.map(finding => finding.check)).toEqual(['element-overlap'])
    expect(report.findings[0]?.message).toContain('图元 #1 与 #2')
    expect(report.findings[0]?.message).toContain('相交 5.2×4 毫米')
    expect(report.findings[0]?.message).toContain('x 34.8–40／y 10–14')
  })

  it('一个轮廓整体含住另一个时不算叠压：有意嵌套（型腔内画零件）', () => {
    const report = checkFigureRendering(svg([
      '<rect x="10" y="10" width="40" height="20" stroke-width="0.5"/>',
      '<circle cx="30" cy="20" r="4" stroke-width="0.5"/>',
    ].join('\n')))
    expect(report.findings).toEqual([])
  })

  it('两条共边的轮廓不算叠压：只擦边接触', () => {
    const report = checkFigureRendering(svg([
      '<polygon points="10,10 40,10 40,20 10,20" stroke-width="0.5"/>',
      '<polygon points="40,10 70,10 70,20 40,20" stroke-width="0.5"/>',
    ].join('\n')))
    expect(report.findings).toEqual([])
  })

  it('同一材料分组号的两个轮廓重叠不报：同一零件的几段', () => {
    const report = checkFigureRendering(svg([
      '<rect x="10" y="10" width="30" height="10" stroke-width="0.5" data-dsh-hatch-group="2"/>',
      '<rect x="34.8" y="8" width="6" height="6" stroke-width="0.5" data-dsh-hatch-group="2"/>',
    ].join('\n')))
    expect(report.findings).toEqual([])
  })

  it('两个完全重合的轮廓照报：同一图元画了两遍不是嵌套', () => {
    const report = checkFigureRendering(svg([
      '<rect x="10" y="10" width="30" height="10" stroke-width="0.5"/>',
      '<rect x="10" y="10" width="30" height="10" stroke-width="0.5"/>',
    ].join('\n')))
    expect(report.findings.map(finding => finding.check)).toEqual(['element-overlap'])
  })

  it('相交尺寸不超过 0.2 毫米的擦边不报', () => {
    const report = checkFigureRendering(svg([
      '<rect x="10" y="10" width="30" height="10" stroke-width="0.5"/>',
      '<rect x="39.9" y="10" width="10" height="10" stroke-width="0.5"/>',
    ].join('\n')))
    expect(report.findings).toEqual([])
  })

  it('开放的折线不参与叠压：连线本来就可以穿过符号', () => {
    const report = checkFigureRendering(svg([
      '<rect x="10" y="10" width="30" height="10" stroke-width="0.5"/>',
      '<polyline points="0,15 60,15" stroke-width="0.25"/>',
    ].join('\n')))
    expect(report.findings).toEqual([])
  })

  it('两侧都是纯填充图元（文字转路径的字形）时不判叠压', () => {
    const report = checkFigureRendering(svg([
      '<rect x="10" y="10" width="30" height="10" stroke="none" fill="#000000"/>',
      '<rect x="34" y="8" width="6" height="14" stroke="none" fill="#000000"/>',
    ].join('\n')))
    expect(report.findings).toEqual([])
  })

  it('一侧是描边轮廓时仍判：实心图元盖住画出来的轮廓同样看不出来', () => {
    const report = checkFigureRendering(svg([
      '<rect x="10" y="10" width="30" height="10" stroke-width="0.5"/>',
      '<rect x="34" y="8" width="6" height="14" stroke="none" fill="#000000"/>',
    ].join('\n')))
    expect(report.findings.map(finding => finding.check)).toEqual(['element-overlap'])
  })
})

describe('checkFigureRendering 字高与字高下限', () => {
  const SMALL = svg([
    '<rect x="10" y="10" width="30" height="12" stroke-width="0.5"/>',
    '<text x="25" y="20" font-size="2" text-anchor="middle" fill="#000000" stroke="none">3</text>',
  ].join('\n'))

  it('给出最小字高量测值（无文字时不给）', () => {
    const measured = checkFigureRendering(SMALL)
    expect(measured.minFontMm).toBeGreaterThan(1)
    expect(measured.minFontMm).toBeLessThan(3)
    expect(checkFigureRendering(svg('<rect x="10" y="10" width="30" height="12" stroke-width="0.5"/>')).minFontMm).toBeUndefined()
  })

  it('给下限时低于下限的文字逐处列出并给出最小值', () => {
    const report = checkFigureRendering(SMALL, { minFontMm: 3 })
    expect(report.findings.map(finding => finding.check)).toEqual(['font-below-minimum'])
    expect(report.findings[0]?.message).toContain('「3」')
    expect(report.findings[0]?.message).toContain('下限是本部署的内控口径')
    expect(report.findings[0]?.message).toContain(`最小 ${String(report.minFontMm)} 毫米`)
  })

  it('字高达标时不报；不给下限时也不报', () => {
    expect(checkFigureRendering(SMALL, { minFontMm: 1 }).findings).toEqual([])
    expect(checkFigureRendering(SMALL).findings).toEqual([])
  })

  it('多于四处时只列出前四处并注明', () => {
    const many = svg(Array.from({ length: 6 }, (_, index) =>
      `<text x="${10 + index * 12}" y="20" font-size="2" text-anchor="middle" fill="#000000" stroke="none">${String(index + 1)}</text>`).join('\n'))
    const report = checkFigureRendering(many, { minFontMm: 3 })
    expect(report.findings[0]?.message).toContain('6 处图面文字')
    expect(report.findings[0]?.message).toContain('等。')
  })
})

describe('scanSvg 解析边界补充', () => {
  it('行内 style 的无冒号声明被跳过，后续声明仍生效', () => {
    const scan = scanSvg(svg('<rect x="0" y="0" width="4" height="4" style="fill;stroke-width:0.5"/>'))
    expect(scan.shapes).toHaveLength(1)
    expect(scan.shapes[0]?.strokeWidthMm).toBe(0.5)
  })

  it('font-size 支持 em、百分比与物理单位，非法文本按未量测记', () => {
    const scan = scanSvg(svg([
      '<g font-size="10">',
      '<text x="0" y="10" style="font-size:2em">A</text>',
      '<text x="20" y="10" style="font-size:150%">B</text>',
      '<text x="40" y="10" style="font-size:3mm">C</text>',
      '<text x="60" y="10" style="font-size:auto">D</text>',
      '<text x="80" y="10" style="font-size:2ex">E</text>',
      '</g>',
    ].join('\n')))
    const height = (index: number): number => {
      const box = scan.texts[index]!.box
      return box.maxY - box.minY
    }
    expect(height(0)).toBeCloseTo(20 * (0.75 + 0.12), 6)
    expect(height(1)).toBeCloseTo(15 * (0.75 + 0.12), 6)
    expect(height(2)).toBeCloseTo((3 / (25.4 / 96)) * (0.75 + 0.12), 5)
    // 无法解析的字号按父级 10 估算，并记入未量测。
    expect(height(3)).toBeCloseTo(10 * (0.75 + 0.12), 6)
    expect(scan.unmeasured.join('\n')).toContain('font-size')
  })

  it('stroke-dasharray 的负值、全零与非数值都按实线处理', () => {
    const scan = scanSvg(svg([
      '<line x1="0" y1="0" x2="10" y2="0" stroke-width="0.5" stroke-dasharray="-1 2"/>',
      '<line x1="0" y1="2" x2="10" y2="2" stroke-width="0.5" stroke-dasharray="0 0"/>',
      '<line x1="0" y1="4" x2="10" y2="4" stroke-width="0.5" stroke-dasharray="auto 2"/>',
      '<line x1="0" y1="6" x2="10" y2="6" stroke-width="0.5" stroke-dasharray="8 2 0.4"/>',
    ].join('\n')))
    expect(scan.shapes).toHaveLength(4)
    expect(scan.shapes.slice(0, 3).every(shape => shape.dashPatternMm === undefined)).toBe(true)
    // 奇数个取值按 SVG 规则重复一遍。
    expect(scan.shapes[3]?.dashPatternMm).toEqual([8, 2, 0.4, 8, 2, 0.4])
  })

  it('非法变换参数使该图元未量测，合法 matrix 参与换算', () => {
    const invalid = scanSvg(svg([
      '<line transform="translate()" x1="0" y1="0" x2="4" y2="0" stroke-width="0.5"/>',
      '<line transform="scale(1 2 3)" x1="0" y1="0" x2="4" y2="0" stroke-width="0.5"/>',
      '<line transform="rotate(10 20)" x1="0" y1="0" x2="4" y2="0" stroke-width="0.5"/>',
      '<line transform="matrix(1 0 0 1 5)" x1="0" y1="0" x2="4" y2="0" stroke-width="0.5"/>',
      '<line transform="translate(a b)" x1="0" y1="0" x2="4" y2="0" stroke-width="0.5"/>',
    ].join('\n')))
    expect(invalid.shapes).toEqual([])
    expect(invalid.unmeasured.join('\n')).toContain('参数非法')

    const shifted = scanSvg(svg('<line transform="matrix(1 0 0 1 5 6)" x1="0" y1="0" x2="4" y2="0" stroke-width="0.5"/>'))
    expect(shifted.shapes[0]?.subpaths[0]?.points).toEqual([[5, 6], [9, 6]])
  })

  it('路径解析覆盖裸数值、非数值参数、未知命令、只含 M 与缺 d', () => {
    const scan = scanSvg(svg([
      '<path d="1 2 L 3 4" stroke-width="0.5"/>',
      '<path d="L 1 ? 2" stroke-width="0.5"/>',
      '<path d="X 1 2" stroke-width="0.5"/>',
      '<path d="L" stroke-width="0.5"/>',
      '<path d="L 1" stroke-width="0.5"/>',
      '<path d="M 1 2" stroke-width="0.5"/>',
      '<path stroke-width="0.5"/>',
      '<path d="L 3 4 L 5 6" stroke-width="0.5"/>',
      '<text x="12" y="12"/>',
    ].join('\n')))
    // 只有最后一条（以 L 开头、隐式从当前点出发）产生几何。
    expect(scan.shapes).toHaveLength(1)
    expect(scan.shapes[0]?.subpaths[0]?.points).toEqual([[0, 0], [3, 4], [5, 6]])
    expect(scan.unmeasured.join('\n')).toContain('无法解析')
  })

  it('M 的后续坐标按 L 处理，曲线末点取最后两个参数', () => {
    const scan = scanSvg(svg([
      '<path d="M 1 2 3 4" stroke-width="0.5"/>',
      '<path d="M 10 10 C 11 11 12 12 13 14" stroke-width="0.5"/>',
      '<path d="M 20 20 Q 21 21 22 24" stroke-width="0.5"/>',
    ].join('\n')))
    expect(scan.shapes.map(shape => shape.subpaths[0]?.points)).toEqual([
      [[1, 2], [3, 4]],
      [[10, 10], [13, 14]],
      [[20, 20], [22, 24]],
    ])
  })

  it('缺 points 的折线、缺 x/y 的矩形与缺 cx/cy 的圆/椭圆按默认值量测', () => {
    const scan = scanSvg(svg([
      '<polyline stroke-width="0.5"/>',
      '<rect width="4" height="4" stroke-width="0.5"/>',
      '<circle r="2" stroke-width="0.5"/>',
      '<ellipse rx="3" ry="2" stroke-width="0.5"/>',
      '<ellipse rx="3" stroke-width="0.5"/>',
    ].join('\n')))
    expect(scan.shapes).toHaveLength(3)
    expect(scan.shapes[0]?.subpaths[0]?.points).toEqual([[0, 0], [4, 0], [4, 4], [0, 4]])
    expect(scan.shapes[1]?.subpaths[0]?.points[0]).toEqual([2, 0])
    expect(scan.shapes[2]?.subpaths[0]?.points[0]).toEqual([3, 0])
  })

  it('直接扫描不带根元素的片段时按 96 dpi 用户单位换算', () => {
    const scan = scanSvg('<line x1="0" y1="0" x2="96" y2="0" stroke-width="0.5"/>')
    expect(scan.widthMm).toBeUndefined()
    expect(scan.shapes).toHaveLength(1)
    // 96 用户单位 = 25.4 毫米，线宽 0.5 用户单位同比换算。
    expect(scan.shapes[0]?.subpaths[0]?.points[1]?.[0]).toBeCloseTo(25.4, 10)
    expect(scan.shapes[0]?.strokeWidthMm).toBeCloseTo(0.5 * (25.4 / 96), 10)
  })
})

describe('checkFigureRendering 遮挡与零长度线段', () => {
  const numeral = '<text x="80" y="20" font-size="4" text-anchor="middle" fill="#000000" stroke="none">3</text>'

  it('线段被更晚的白色填充从中间盖住：按交点切分后取可见段，不误报净距', () => {
    const report = checkFigureRendering(svg([
      '<line x1="77.5" y1="4" x2="77.5" y2="36" stroke-width="0.25"/>',
      '<rect x="60" y="8" width="40" height="24" fill="#ffffff" stroke="none"/>',
      numeral,
    ].join('\n')))
    expect(report.findings).toEqual([])
  })

  it('线段正好压在文字上边界时按 0 毫米净距报出', () => {
    const report = checkFigureRendering(svg([
      '<line x1="70" y1="17" x2="90" y2="17" stroke-width="0.25"/>',
      numeral,
    ].join('\n')))
    expect(report.findings.map(finding => finding.check)).toEqual(['text-clearance'])
    expect(report.findings[0]?.message).toContain('仅 0 毫米')
  })

  it('线段仅擦过文字框边缘（进入深度小于容差）时仍按相交距离 0 报净距', () => {
    const report = checkFigureRendering(svg([
      // 框上边界 y=20.48；线在框内 0.005 毫米处横向穿过左右两条边。
      '<line x1="70" y1="20.475" x2="90" y2="20.475" stroke-width="0.25"/>',
      numeral,
    ].join('\n')))
    expect(report.findings.map(finding => finding.check)).toEqual(['text-clearance'])
    expect(report.findings[0]?.message).toContain('仅 0 毫米')
  })

  it('零长度实线落在净距内时报出；零长度虚线不产生线段', () => {
    const solid = checkFigureRendering(svg([
      '<line x1="77.5" y1="20" x2="77.5" y2="20" stroke-width="0.25"/>',
      numeral,
    ].join('\n')))
    expect(solid.findings.map(finding => finding.check)).toEqual(['text-clearance'])
    expect(solid.findings[0]?.message).toContain('仅 1.3 毫米')

    const dashed = checkFigureRendering(svg([
      '<line x1="10" y1="10" x2="10" y2="10" stroke-width="0.25" stroke-dasharray="2 1"/>',
      numeral,
    ].join('\n')))
    expect(dashed.findings).toEqual([])
  })
})

describe('图型净距分档与阻断判定', () => {
  it('按实测下界给出各图型的净距阈值', () => {
    expect(clearanceMmForFigure('cross_section')).toBe(1.5)
    expect(clearanceMmForFigure('structure')).toBe(1.5)
    expect(clearanceMmForFigure('flowchart')).toBe(1.5)
    expect(clearanceMmForFigure('state_diagram')).toBe(1.5)
    expect(clearanceMmForFigure('block_diagram')).toBe(0.5)
    expect(clearanceMmForFigure('component_hierarchy')).toBe(0.5)
    expect(clearanceMmForFigure('raw_dot')).toBe(0.5)
    expect(clearanceMmForFigure('circuit')).toBe(0.7)
    expect(clearanceMmForFigure('plot')).toBe(0.9)
    expect(clearanceMmForFigure('sequence_diagram')).toBe(0.7)
    expect(clearanceMmForFigure('appearance_view')).toBe(0)
    expect(clearanceMmForFigure('没有这个图型')).toBe(0)
  })

  it('not-measured 是诚实降级，不算阻断级发现', () => {
    const report = checkFigureRendering(svg('<use href="#missing"/>'))
    expect(report.findings.map(finding => finding.check)).toEqual(['not-measured'])
    expect(blockingFindings(report)).toEqual([])
  })

  it('真实缺陷是阻断级发现', () => {
    const report = checkFigureRendering(svg([
      '<line x1="60" y1="5" x2="60" y2="35" stroke-width="0.25"/>',
      '<text x="60" y="22" text-anchor="middle">条件</text>',
    ].join('\n')))
    expect(blockingFindings(report).map(finding => finding.check)).toContain('text-crossed-by-line')
  })
})

describe('节点/边语义分组', () => {
  /** 节点框：x 10–60、y 10–30；标签在框内，距上边约 1 毫米。 */
  const NODE_FRAME = '<polygon points="10,10 60,10 60,30 10,30" stroke-width="0.5"/>'

  it('节点标签排在节点框内不判净距，同位置但不同组仍判', () => {
    const inside = checkFigureRendering(svg(
      `<g class="node">${NODE_FRAME}<text x="35" y="23" text-anchor="middle">标签</text></g>`,
    ), { textClearanceMm: 1.5 })
    expect(inside.findings).toEqual([])

    const outside = checkFigureRendering(svg(
      `<g class="node">${NODE_FRAME}</g><text x="35" y="23" text-anchor="middle">标签</text>`,
    ), { textClearanceMm: 1.5 })
    expect(outside.findings.map(finding => finding.check)).toEqual(['text-clearance'])
  })

  it('无关 class 不建立分组；无 class 的嵌套 g 继承外层节点组', () => {
    const unrelated = checkFigureRendering(svg(
      `<g class="graph">${NODE_FRAME}<text x="35" y="23" text-anchor="middle">标签</text></g>`,
    ), { textClearanceMm: 1.5 })
    expect(unrelated.findings.map(finding => finding.check)).toEqual(['text-clearance'])

    const inherited = checkFigureRendering(svg(
      `<g class="node"><g>${NODE_FRAME}<text x="35" y="23" text-anchor="middle">标签</text></g></g>`,
    ), { textClearanceMm: 1.5 })
    expect(inherited.findings).toEqual([])
  })

  it('边标签被它自己的边穿过不报，被另一条边穿过仍报', () => {
    const edge = [
      '<g class="edge"><line x1="60" y1="5" x2="60" y2="35" stroke-width="0.25"/>',
      '<text x="60" y="22" text-anchor="middle">条件</text></g>',
    ].join('\n')
    expect(checkFigureRendering(svg(edge)).findings).toEqual([])

    const crossedByOther = checkFigureRendering(svg(
      `${edge}\n<line x1="60" y1="5" x2="60" y2="35" stroke-width="0.25"/>`,
    ))
    expect(crossedByOther.findings.map(finding => finding.check)).toEqual(['text-crossed-by-line'])
  })
})

describe('checkFigureRendering 版面利用率', () => {
  it('内容只占画布一角时报 sheet-underfill，且不进阻断集', () => {
    const sparse = svg('<rect x="50" y="15" width="10" height="10" stroke-width="0.25"/>')
    const report = checkFigureRendering(sparse, { minSheetFillRatio: 0.3 })
    expect(report.findings.map(finding => finding.check)).toEqual(['sheet-underfill'])
    expect(report.findings[0]?.advisory).toBe(true)
    // 提示级是软指标：正文没画错，只是可能撑不满纸面，不阻断交付。
    expect(blockingFindings(report)).toEqual([])
  })

  it('内容占满画布时不报', () => {
    const full = svg('<rect x="0" y="0" width="120" height="40" stroke-width="0.25"/>')
    expect(checkFigureRendering(full, { minSheetFillRatio: 0.3 }).findings).toEqual([])
  })

  it('画布内没有可量测图元时不判：没有内容就谈不上利用率', () => {
    expect(checkFigureRendering(svg(''), { minSheetFillRatio: 0.3 }).findings).toEqual([])
  })

  it('画布尺寸为零时不除零：比值按 0 计并报提示', () => {
    // 退化的 width="0mm" 是真实产物（投影比例极小），比值按 0 算，不产出 NaN。
    const degenerate = svg(
      '<rect x="0" y="0" width="1" height="1" stroke-width="0.25"/>',
      'width="0mm" height="0mm" viewBox="0 0 0 0"',
    )
    const report = checkFigureRendering(degenerate, { minSheetFillRatio: 0.3 })
    expect(report.findings.map(finding => finding.check)).toContain('sheet-underfill')
  })

  it('不给下限或给 0 时不判：紧致片段画布本就贴着内容，该判据没有信息量', () => {
    const sparse = svg('<rect x="50" y="15" width="10" height="10" stroke-width="0.25"/>')
    expect(checkFigureRendering(sparse).findings).toEqual([])
    expect(checkFigureRendering(sparse, { minSheetFillRatio: 0 }).findings).toEqual([])
  })
})
