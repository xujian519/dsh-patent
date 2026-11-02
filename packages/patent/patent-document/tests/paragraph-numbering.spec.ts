import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderPatentDocument } from '@deepseek-ai/dsh-patent-document'
import { applyParagraphNumbering, parseNumberExemplar } from '../src/document/paragraphNumbering.ts'
import { unusedSubprocess } from './helpers.ts'

/** 段落编号在本包只对模板声明过的元素生效；这些用例钉住声明语义与边界。 */
describe('parseNumberExemplar', () => {
  it('从方括号四位形态解析出前后缀与补零宽度', () => {
    expect(parseNumberExemplar('[0001]')).toEqual({ prefix: '[', suffix: ']', width: 4 })
  })

  it('接受无括号形态与中文前后缀', () => {
    expect(parseNumberExemplar('0001')).toEqual({ prefix: '', suffix: '', width: 4 })
    expect(parseNumberExemplar('第0001段')).toEqual({ prefix: '第', suffix: '段', width: 4 })
  })

  it('不含数字段时返回 undefined', () => {
    expect(parseNumberExemplar('')).toBeUndefined()
    expect(parseNumberExemplar('paragraph')).toBeUndefined()
  })
})

describe('applyParagraphNumbering', () => {
  const wrap = (inner: string, attr = 'data-paragraph-numbering="[0001]"'): string =>
    `<body><section id="s" ${attr}>${inner}</section></body>`

  it('按文档顺序给 p 连续编号，标题不占号', () => {
    const { html, numbered, scopes } = applyParagraphNumbering(
      wrap('<h3>技术领域</h3><p>甲</p><p>乙</p><h4>实施例</h4><p>丙</p>'),
    )
    expect(scopes).toBe(1)
    expect(numbered).toBe(3)
    expect(html).toContain('<p>[0001] 甲</p>')
    expect(html).toContain('<p>[0002] 乙</p>')
    expect(html).toContain('<p>[0003] 丙</p>')
    expect(html).not.toContain('<h3>[000')
    expect(html).not.toContain('<h4>[000')
  })

  it('给 li 编号，但表格内容与纯图片段落不占号', () => {
    const { html, numbered } = applyParagraphNumbering(
      wrap(
        '<p>甲</p>'
        + '<table><tr><td><p>表内</p></td></tr></table>'
        + '<p><img src="a.png" alt=""></p>'
        + '<p>   </p>'
        + '<ul><li>乙</li><li>丙</li></ul>',
      ),
    )
    expect(numbered).toBe(3)
    expect(html).toContain('<p>[0001] 甲</p>')
    expect(html).toContain('<td><p>表内</p></td>')
    expect(html).toContain('<p><img src="a.png" alt=""></p>')
    expect(html).toContain('<li>[0002] 乙</li>')
    expect(html).toContain('<li>[0003] 丙</li>')
  })

  it('编号写在开标签之后、段内行内标记之前', () => {
    const { html } = applyParagraphNumbering(wrap('<p><strong>注：</strong>内容</p>'))
    expect(html).toContain('<p>[0001] <strong>注：</strong>内容</p>')
  })

  it('幂等：已带编号的内容被剥掉后重写，不叠加', () => {
    const source = wrap('<p>[0001] 甲</p><p>[0002] 乙</p>')
    const once = applyParagraphNumbering(source).html
    const twice = applyParagraphNumbering(once).html
    expect(twice).toBe(once)
    expect(once).not.toContain('[0001] [0001]')
  })

  it('重排既有编号：模型写错序号时按实际顺序纠正', () => {
    const { html } = applyParagraphNumbering(wrap('<p>[0007] 甲</p><p>[0007] 乙</p>'))
    expect(html).toContain('<p>[0001] 甲</p>')
    expect(html).toContain('<p>[0002] 乙</p>')
  })

  it('尊重模板声明的其它补零宽度', () => {
    const { html } = applyParagraphNumbering(wrap('<p>甲</p><p>乙</p>', 'data-paragraph-numbering="[1]"'))
    expect(html).toContain('<p>[1] 甲</p>')
    expect(html).toContain('<p>[2] 乙</p>')
  })

  it('声明元素带其它属性时仍取声明属性的值', () => {
    const { html } = applyParagraphNumbering(
      '<body><section id="s" class="doc" data-paragraph-numbering="第0001段"><p>甲</p></section></body>',
    )
    expect(html).toContain('<p>第0001段 甲</p>')
  })

  it('嵌套声明时外层已覆盖本区，内层不再单独编号', () => {
    const { html, numbered, scopes } = applyParagraphNumbering(
      '<body><section id="outer" data-paragraph-numbering="[0001]">'
      + '<div id="inner" data-paragraph-numbering="[1]"><p>甲</p></div>'
      + '</section></body>',
    )
    expect(scopes).toBe(1)
    expect(numbered).toBe(1)
    expect(html).toContain('<p>[0001] 甲</p>')
  })

  it('声明元素没有配对闭合标签时按未声明处理', () => {
    const source = '<section data-paragraph-numbering="[0001]"><p>甲</p>'
    expect(applyParagraphNumbering(source)).toEqual({ html: source, numbered: 0, scopes: 0 })
  })

  it('未声明编号的 HTML 原样返回', () => {
    const source = '<body><section id="s"><p>甲</p></section></body>'
    expect(applyParagraphNumbering(source)).toEqual({ html: source, numbered: 0, scopes: 0 })
  })

  it('形态无法解析时按未声明处理', () => {
    const source = wrap('<p>甲</p>', 'data-paragraph-numbering="段落"')
    expect(applyParagraphNumbering(source)).toEqual({ html: source, numbered: 0, scopes: 0 })
  })
})

describe('renderPatentDocument 段落编号', () => {
  it('随包的 claims-spec 模板默认不声明编号，渲染结果不含字面编号', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-doc-numbering-'))
    try {
      const result = await renderPatentDocument(
        {
          template: 'claims-spec',
          outputName: 'numbering',
          outputDir: dir,
          format: 'html',
          draft: {
            meta: { caseNumber: 'CN2026-0001', title: '一种装置', applicant: '示例申请人', inventor: '示例发明人', agent: '示例代理', date: '2026-10-09' },
            claims: ['一种装置，其特征在于，包括示例部件。'],
            abstract: ['本发明公开一种装置。'],
            figureFiles: ['fig1.svg'],
            sections: {
              technicalField: [{ kind: 'paragraph', text: '本发明属于医疗器械领域。' }],
              background: [{ kind: 'paragraph', text: '现有技术存在不足。' }],
              summary: [{ kind: 'paragraph', text: '本发明提供一种装置。' }],
              drawingDescriptions: [{ kind: 'list', items: ['整体结构示意图'] }],
              embodiment: [{ kind: 'paragraph', text: '下面结合附图说明。' }],
            },
          },
        },
        dir,
        { subprocess: unusedSubprocess() },
      )
      expect(existsSync(result.htmlPath)).toBe(true)
      const html = readFileSync(result.htmlPath, 'utf8')
      expect(html).toContain('<p>本发明属于医疗器械领域。</p>')
      expect(html).toContain('<p>现有技术存在不足。</p>')
      expect(html).toContain('<p>本发明提供一种装置。</p>')
      // 模板注释里保留了声明用法的示例字面量，因此只断言段落本身未被编号。
      expect(html).not.toMatch(/<p>\[\d{4}\]/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
