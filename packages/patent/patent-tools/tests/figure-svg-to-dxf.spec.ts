import { describe, expect, it } from 'vitest'
import { scanSvg } from '../src/figure/render-check-scan.ts'
import { SvgDxfError, svgToDxf } from '../src/figure/svg-to-dxf.ts'

const PAGE = 'width="100mm" height="50mm" viewBox="0 0 100 50"'

function svg(body: string, page = PAGE): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" ${page}>${body}</svg>`
}

/** TEXT 实体的组码。同一组码只出现一次。 */
function textGroups(dxf: string, content: string): Map<string, string> {
  const marker = `\n1\n${content}\n`
  const at = dxf.indexOf(marker)
  expect(at).toBeGreaterThan(0)
  const start = dxf.lastIndexOf('\n0\nTEXT\n', at)
  const end = dxf.indexOf('\n0\n', at + marker.length)
  const body = dxf.slice(start + '\n0\nTEXT\n'.length, end)
  const rows = body.split('\n').filter(row => row !== '')
  const groups = new Map<string, string>()
  for (let index = 0; index < rows.length; index += 2) {
    const code = rows[index]
    const value = rows[index + 1]
    if (code !== undefined && value !== undefined) groups.set(code, value)
  }
  return groups
}

function lineOf(dxf: string): { x1: number; y1: number; x2: number; y2: number } {
  const match = /0\nLINE\n8\n0\n10\n([^\n]+)\n20\n([^\n]+)\n11\n([^\n]+)\n21\n([^\n]+)/.exec(dxf)
  expect(match).not.toBeNull()
  return {
    x1: Number(match?.[1]),
    y1: Number(match?.[2]),
    x2: Number(match?.[3]),
    y2: Number(match?.[4]),
  }
}

describe('svgToDxf', () => {
  it('writes a horizontal line, a polyline, editable text, and a flattened curve', () => {
    const { dxf, warnings } = svgToDxf(svg(`
      <line x1="0" y1="10" x2="10" y2="10" stroke="#000" fill="none"/>
      <rect x="0" y="20" width="8" height="4" fill="none" stroke="#000"/>
      <text x="1" y="40" font-size="3.5">壳体</text>
      <path d="M0 0 C10 0 10 10 20 0" fill="none" stroke="#000"/>
    `))
    expect(dxf).toContain('$ACADVER')
    expect(dxf).toContain('AC1032')
    expect(dxf).toContain('$INSUNITS')
    expect(dxf).toContain('\n70\n4\n')
    expect(dxf).toContain('壳体')
    expect(dxf).not.toContain('C10 0')
    const line = lineOf(dxf)
    expect(Math.hypot(line.x2 - line.x1, line.y2 - line.y1)).toBeCloseTo(10, 2)
    expect(line.y1).toBeCloseTo(line.y2, 5)
    expect(dxf).toContain('LWPOLYLINE')
    expect(dxf).toContain('\n40\n3.5\n')
    const label = textGroups(dxf, '壳体')
    expect(label.get('10')).toBe('1')
    expect(label.get('20')).toBe('10')
    expect(label.get('72')).toBeUndefined()
    expect(label.get('11')).toBeUndefined()
    expect(label.get('50')).toBeUndefined()
    expect(warnings).toEqual(['曲线已折线化'])
  })

  it('writes text-anchor as DXF justification and rotation in Y-up degrees', () => {
    const middle = textGroups(svgToDxf(svg('<text x="50" y="40" font-size="3.5" text-anchor="middle">图1</text>')).dxf, '图1')
    expect(middle.get('10')).toBe('50')
    expect(middle.get('20')).toBe('10')
    expect(middle.get('72')).toBe('1')
    expect(middle.get('11')).toBe('50')
    expect(middle.get('21')).toBe('10')
    expect(middle.get('73')).toBeUndefined()
    expect(middle.get('50')).toBeUndefined()

    const end = textGroups(svgToDxf(svg('<text x="80" y="10" font-size="3.5" text-anchor="end">右</text>')).dxf, '右')
    expect(end.get('72')).toBe('2')
    expect(end.get('11')).toBe('80')
    expect(end.get('21')).toBe('40')
    expect(end.get('50')).toBeUndefined()

    const inherited = textGroups(
      svgToDxf(svg('<g text-anchor="end"><text x="80" y="10" font-size="3.5">右</text></g>')).dxf,
      '右',
    )
    expect(inherited.get('72')).toBe('2')
    expect(inherited.get('11')).toBe('80')

    const upward = textGroups(
      svgToDxf(svg('<text x="10" y="20" font-size="3.5" text-anchor="middle" transform="rotate(-90 10 20)">温</text>')).dxf,
      '温',
    )
    expect(upward.get('72')).toBe('1')
    expect(upward.get('11')).toBe('10')
    expect(upward.get('21')).toBe('30')
    expect(Number(upward.get('50'))).toBeCloseTo(90, 3)

    const downward = textGroups(
      svgToDxf(svg('<text x="10" y="20" font-size="3.5" transform="rotate(90 10 20)">温</text>')).dxf,
      '温',
    )
    expect(downward.get('72')).toBeUndefined()
    expect(Number(downward.get('50'))).toBeCloseTo(-90, 3)

    const tilted = textGroups(
      svgToDxf(svg('<text x="10" y="20" font-size="3.5" transform="rotate(30 10 20)">斜</text>')).dxf,
      '斜',
    )
    expect(Number(tilted.get('50'))).toBeCloseTo(-30, 3)
    expect(tilted.get('10')).toBe('10')
    expect(tilted.get('20')).toBe('30')
  })

  it('warns once for a painted fill and not for white, none, or text', () => {
    const painted = svgToDxf(svg('<rect x="0" y="0" width="4" height="4" fill="#000" stroke="#000"/>'))
    expect(painted.warnings).toContain('DXF 未写入填充')
    const plain = svgToDxf(svg(`
      <rect x="0" y="0" width="2" height="2" fill="none"/>
      <rect x="3" y="0" width="2" height="2" fill="transparent"/>
      <rect x="6" y="0" width="2" height="2" fill="white"/>
      <rect x="9" y="0" width="2" height="2" fill="#fff"/>
      <rect x="12" y="0" width="2" height="2" fill="#ffffff"/>
      <rect x="15" y="0" width="2" height="2" fill="rgb(255,255,255)"/>
      <rect x="18" y="0" width="2" height="2" fill="rgb(100%, 100%, 100%)"/>
      <text x="1" y="10" font-size="3" fill="#000">字</text>
      <g fill="#000"><line x1="0" y1="1" x2="2" y2="1" stroke="#000"/></g>
    `))
    expect(plain.warnings).toEqual(['DXF 未写入填充'])
  })

  it('emits CIRCLE for a circle and a polyline for an ellipse', () => {
    const circle = svgToDxf(svg('<circle cx="20" cy="20" r="5" fill="none" stroke="#000"/>'))
    expect(circle.dxf).toContain('\nCIRCLE\n')
    expect(circle.dxf).not.toContain('LWPOLYLINE')
    const ellipse = svgToDxf(svg('<ellipse cx="20" cy="20" rx="8" ry="3" fill="none" stroke="#000"/>'))
    expect(ellipse.dxf).toContain('LWPOLYLINE')
    expect(ellipse.dxf).not.toContain('\nCIRCLE\n')
  })

  it('flattens the curve commands without the endpoint-chord note', () => {
    const body = '<path fill="none" stroke="#000" d="M0 0 C10 20 20 20 30 0 S40 -20 50 0 Q60 20 70 0 T90 0 A5 5 0 0 1 100 0 A1 1 0 1 0 40 0 A0 0 0 0 1 45 0 A0.01 0.01 0 0 1 46 0 c2 2 4 0 6 0 A4 4 0 1 1 60 0"/>'
    const converted = svgToDxf(svg(body, 'width="120mm" height="40mm" viewBox="0 0 120 40"'))
    expect(converted.warnings).toContain('曲线已折线化')
    expect(converted.dxf).toContain('LWPOLYLINE')
    const tight = scanSvg(svg(body, 'width="120mm" height="40mm" viewBox="0 0 120 40"'), { curveToleranceMm: 1e-9 })
    expect(tight.unmeasured.join('\n')).not.toContain('端点弦')
    expect((tight.shapes[0]?.subpaths[0]?.points.length ?? 0)).toBeGreaterThan(8)
    const chord = scanSvg(svg('<path fill="none" d="M0 0 C10 0 10 10 20 0"/>'))
    expect(chord.unmeasured.join('\n')).toContain('端点弦')
  })

  it('keeps straight paths unflattened, drops a zero-height text, and covers the arc edge cases', () => {
    const straight = svgToDxf(svg('<path d="M0 0 L10 0" fill="none" stroke="#000"/>'))
    expect(straight.warnings).toEqual([])
    expect(straight.dxf).toContain('\nLINE\n')

    const marked = svgToDxf(svg(`
      <defs><marker id="arrow" markerWidth="4" markerHeight="4"><path d="M0 0 L4 2"/></marker></defs>
      <line x1="1" y1="1" x2="10" y2="1" stroke="#000" marker-end="url(#arrow)"/>
    `))
    expect(marked.warnings).toContain('`marker-start/mid/end` 端头（箭头）的墨迹未量测')

    const collapsed = Array.from({ length: 24 }, () => '5,5').join(' ')
    const flatCircle = svgToDxf(svg(`<polygon points="${collapsed}" fill="none" stroke="#000"/>`))
    expect(flatCircle.dxf).not.toContain('\nCIRCLE\n')
    expect(flatCircle.dxf).toContain('LWPOLYLINE')

    const flatText = svgToDxf(svg('<text x="1" y="10" font-size="4" transform="scale(1 0)">扁</text>'))
    expect(flatText.dxf).not.toContain('扁')
    expect(flatText.dxf).not.toContain('\nTEXT\n')

    const page = 'width="40mm" height="40mm" viewBox="0 0 40 40"'
    const arcs = svgToDxf(svg(`
      <path fill="none" stroke="#000" d="M0 0 A5 0 0 0 1 10 0"/>
      <path fill="none" stroke="#000" d="M0 0 A0 5 0 0 1 10 0"/>
      <path fill="none" stroke="#000" d="M10 10 A5 5 0 0 1 10 10"/>
      <path fill="none" stroke="#000" d="M0 0 A5 5 0 0 0 10 0"/>
      <path fill="none" stroke="#000" d="M0 0 A5 5 0 0 1 0 10"/>
      <path fill="none" stroke="#000" d="M0 0 A5 5 15 0 0 10 0"/>
      <path fill="none" stroke="#000" d="M0 0 A10 4 0 1 1 10 0"/>
      <path fill="none" stroke="#000" d="M0 0 C5 5 -5 5 0 0"/>
    `, page))
    expect(arcs.warnings).toContain('曲线已折线化')
    expect(arcs.dxf).not.toContain('NaN')
    expect(arcs.dxf).toContain('LWPOLYLINE')

    const tight = scanSvg(svg(
      '<path fill="none" d="M0 0 C0 10 10 10 10 0 Q0 10 10 0"/>',
      'width="20mm" height="20mm" viewBox="0 0 20 20"',
    ), { curveToleranceMm: 0 })
    expect((tight.shapes[0]?.subpaths[0]?.points.length ?? 0)).toBeGreaterThan(1000)

    const tiny = scanSvg(svg(
      '<path fill="none" d="M0 0 A0.2 0.2 0 0 0 0.1 0"/>',
      'width="20mm" height="20mm" viewBox="0 0 20 20"',
    ), { curveToleranceMm: 2 })
    expect((tiny.shapes[0]?.subpaths[0]?.points.length ?? 0)).toBeGreaterThan(1)

    const capped = scanSvg(svg(
      '<path fill="none" d="M0 0 A5 5 0 0 1 10 0"/>',
      'width="20mm" height="20mm" viewBox="0 0 20 20"',
    ), { curveToleranceMm: 0 })
    expect((capped.shapes[0]?.subpaths[0]?.points.length ?? 0)).toBeGreaterThan(1000)
  })

  it('rejects image, foreignObject, use, a bad viewBox, a bad transform, and a missing page size', () => {
    const cases: Array<[string, string]> = [
      [svg('<image href="a.png" width="10" height="10"/>'), 'analyze_patent_figure'],
      [svg('<svg:image href="a.png"/>'), 'analyze_patent_figure'],
      [svg('<!-- <image href="a.png"/> --><line x1="0" y1="0" x2="1" y2="0"/>'), 'LINE'],
      [svg('<foreignObject width="10" height="10"/>'), 'foreignObject'],
      [svg('<use href="#a"/>'), '<use>'],
      [svg('<line x1="0" y1="0" x2="1" y2="0"/>', 'width="10mm" height="10mm" viewBox="nope"'), 'viewBox'],
      [svg('<line x1="0" y1="0" x2="1" y2="0" transform="skewX(10)"/>'), '变换'],
      ['<svg xmlns="http://www.w3.org/2000/svg"><line x1="0" y1="0" x2="1" y2="0"/></svg>', '画布尺寸'],
    ]
    for (const [source, fragment] of cases) {
      if (fragment === 'LINE') {
        expect(svgToDxf(source).dxf).toContain('LINE')
        continue
      }
      expect(() => svgToDxf(source)).toThrow(SvgDxfError)
      expect(() => svgToDxf(source)).toThrow(new RegExp(fragment))
    }
  })

})
