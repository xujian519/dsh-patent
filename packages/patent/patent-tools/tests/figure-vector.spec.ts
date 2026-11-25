import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VECTOR_BODY_MAX_BYTES,
  VectorFigureError,
  assertVectorFigureSpec,
  escapeXmlAttribute,
  fmt,
  insertSvgDocumentTitle,
  vectorFigureSvg,
} from '../src/figure/vector-figure.ts'
import type { VectorFigureSpec } from '../src/figure/vector-figure.ts'

const spec: VectorFigureSpec = {
  widthMm: 40,
  heightMm: 20.5,
  body: '<rect x="1" y="2" width="10" height="4"/>',
  labels: ['壳体'],
}

describe('vector-figure：矢量附图接缝', () => {
  it('封装为毫米画布 SVG，文本层不参与描边', () => {
    const svg = vectorFigureSvg(spec, '图1 结构')
    expect(svg.startsWith('<?xml')).toBe(true)
    expect(svg).toContain('width="40mm" height="20.5mm" viewBox="0 0 40 20.5"')
    expect(svg).toContain('<title>图1 结构</title>')
    expect(svg).toContain('<g fill="none" stroke="#000000" stroke-width="0.35"')
    expect(svg).toContain('<rect x="1" y="2" width="10" height="4"/>')
    expect(svg.endsWith('</svg>\n')).toBe(true)
  })

  it('无图名时不写入 title', () => {
    expect(vectorFigureSvg(spec)).not.toContain('<title>')
  })

  it('在根 svg 后插入文档标题，不改写节点与图组里的 title', () => {
    const source = [
      '<svg xmlns="http://www.w3.org/2000/svg">',
      '<g id="graph0" class="graph">',
      '<title>G</title>',
      '<g id="node1" class="node"><title>a</title><text>甲</text></g>',
      '</g>',
      '</svg>',
    ].join('\n')
    const titled = insertSvgDocumentTitle(source, 'A&B<C"')
    expect(titled).toContain('<svg xmlns="http://www.w3.org/2000/svg">\n  <title>A&amp;B&lt;C&quot;</title>\n')
    expect(titled).toContain('<title>G</title>')
    expect(titled).toContain('<g id="node1" class="node"><title>a</title>')
    expect(() => insertSvgDocumentTitle('<g></g>', '图')).toThrow('缺少根 svg 开标签')
  })

  it('属性值里的 > 不截断开标签', () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" data-note="a>b"><g/></svg>'
    const titled = insertSvgDocumentTitle(source, '图')
    expect(titled).toBe('<svg xmlns="http://www.w3.org/2000/svg" data-note="a>b">\n  <title>图</title><g/></svg>')
  })

  it('数值格式化去掉尾随零并拒绝非有限数', () => {
    expect(fmt(1.23456)).toBe('1.235')
    expect(fmt(2.5)).toBe('2.5')
    expect(fmt(-0.0001)).toBe('0')
    expect(() => fmt(Number.POSITIVE_INFINITY)).toThrow(VectorFigureError)
    expect(() => fmt(Number.NaN)).toThrow(VectorFigureError)
    expect(() => fmt(Number.NaN)).toThrow('坐标必须是有限数')
  })

  it('错误码随实例返回', () => {
    const error = new VectorFigureError('empty_input', '空')
    expect(error.code).toBe('empty_input')
    expect(error.name).toBe('VectorFigureError')
    expect(error).toBeInstanceOf(Error)
  })

  it('规格校验：尺寸、片段与词语', () => {
    expect(() => { assertVectorFigureSpec({ ...spec, widthMm: 0 }) }).toThrow('画布尺寸必须为正有限数')
    expect(() => { assertVectorFigureSpec({ ...spec, heightMm: Number.NaN }) }).toThrow(VectorFigureError)
    expect(() => { assertVectorFigureSpec({ ...spec, body: '   ' }) }).toThrow('图形片段为空')
    expect(() => {
      assertVectorFigureSpec({ ...spec, body: 'x'.repeat(DEFAULT_VECTOR_BODY_MAX_BYTES + 1) })
    }).toThrow('过大')
    // 上限按 UTF-8 字节计：码元数不超限、字节数超限时同样拒绝。
    expect(() => {
      const body = `<text>${'一'.repeat(DEFAULT_VECTOR_BODY_MAX_BYTES / 2)}</text>`
      assertVectorFigureSpec({ ...spec, body })
    }).toThrow('过大')
    expect(() => { assertVectorFigureSpec({ ...spec, labels: [1 as never] }) }).toThrow('图面词语必须是字符串')
    expect(() => { vectorFigureSvg({ ...spec, body: '' }) }).toThrow(VectorFigureError)
  })

  it('XML 属性转义', () => {
    expect(escapeXmlAttribute('a&b<c>d"e')).toBe('a&amp;b&lt;c&gt;d&quot;e')
  })
})
