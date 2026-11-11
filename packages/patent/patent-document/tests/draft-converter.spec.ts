import { describe, expect, it } from 'vitest'
import type { SpecDraft } from '@deepseek-ai/dsh-patent-core'
import { escapeHtmlText, renderSpecDraftSections } from '@deepseek-ai/dsh-patent-document'

/** 最小可渲染 claims-spec 草案。 */
function specDraft(overrides: Partial<SpecDraft> = {}): SpecDraft {
  return {
    meta: {
      caseNumber: 'CN2026-0001',
      title: '一种智能保温杯',
      applicant: '示例科技有限公司',
      inventor: '张三',
      agent: 'XX 知识产权代理事务所',
      date: '2026-10-09',
    },
    claims: [
      '一种智能保温杯，其特征在于，包括杯体、温度显示模块和加热单元。',
      '如权利要求 1 所述的智能保温杯，其特征在于，还包括控制模块。',
    ],
    abstract: ['本发明公开一种智能保温杯，主要用途是恒温饮水。'],
    figureFiles: ['fig1.svg', 'fig2.svg'],
    sections: {
      technicalField: [{ kind: 'paragraph', text: '本发明属于日用品技术领域。' }],
      background: [{ kind: 'paragraph', text: '现有保温杯无法显示水温。' }],
      summary: [
        { kind: 'paragraph', text: '本发明提供一种智能保温杯。' },
        { kind: 'list', items: ['可以显示水温', '可以低温加热'], ordered: true },
      ],
      drawingDescriptions: [{ kind: 'list', items: ['智能保温杯的整体结构示意图', '加热控制逻辑的模块框图'] }],
      embodiment: [
        { kind: 'paragraph', text: '下面结合附图对本发明作进一步说明。' },
        {
          kind: 'table',
          name: '附图标记说明',
          header: ['标记', '名称'],
          rows: [['1', '杯体'], ['2', '杯盖']],
        },
      ],
    },
    ...overrides,
  }
}

describe('escapeHtmlText', () => {
  it('转义五个 HTML 特殊字符', () => {
    expect(escapeHtmlText('a<b>&"c"\'')).toBe('a&lt;b&gt;&amp;&quot;c&quot;&#39;')
  })

  it('普通中文文本原样返回', () => {
    expect(escapeHtmlText('智能保温杯（1）')).toBe('智能保温杯（1）')
  })
})

describe('renderSpecDraftSections', () => {
  it('著录项与页脚注入 meta 槽位（转义后）', () => {
    const draft = specDraft({ meta: { ...specDraft().meta, title: '一种<a>装置' } })
    const map = renderSpecDraftSections(draft)
    expect(map['meta-case']).toBe('CN2026-0001')
    expect(map['meta-title']).toBe('一种&lt;a&gt;装置')
    expect(map['meta-applicant']).toBe('示例科技有限公司')
    expect(map['meta-inventor']).toBe('张三')
    expect(map['meta-agent']).toBe('XX 知识产权代理事务所')
    expect(map['meta-date']).toBe('2026-10-09')
    expect(map['footer-date']).toBe('2026-10-09')
    expect(map['footer-case']).toBe('CN2026-0001')
  })

  it('权利要求自动编号且转义文本', () => {
    const map = renderSpecDraftSections(specDraft({ claims: ['一种<b>装置', '其特征在于。'] }))
    expect(map['claims-body']).toBe(
      '<div class="claim-item"><span class="claim-num">1.</span>一种&lt;b&gt;装置</div>'
      + '<div class="claim-item"><span class="claim-num">2.</span>其特征在于。</div>',
    )
  })

  it('说明书按五部分生成 h3 与块', () => {
    const map = renderSpecDraftSections(specDraft())
    const spec = map['specification-body']
    expect(spec).toContain('<h3>技术领域</h3><p>本发明属于日用品技术领域。</p>')
    expect(spec).toContain('<h3>背景技术</h3><p>现有保温杯无法显示水温。</p>')
    expect(spec).toContain('<h3>发明内容</h3><p>本发明提供一种智能保温杯。</p>')
    expect(spec).toContain('<ol><li>可以显示水温</li><li>可以低温加热</li></ol>')
    expect(spec.indexOf('<h3>技术领域</h3>')).toBeLessThan(spec.indexOf('<h3>背景技术</h3>'))
    expect(spec.indexOf('<h3>背景技术</h3>')).toBeLessThan(spec.indexOf('<h3>发明内容</h3>'))
    expect(spec.indexOf('<h3>发明内容</h3>')).toBeLessThan(spec.indexOf('<h3>附图说明</h3>'))
    expect(spec.indexOf('<h3>附图说明</h3>')).toBeLessThan(spec.indexOf('<h3>具体实施方式</h3>'))
  })

  it('附图说明由列表块生成「图N为……」且末项句号', () => {
    const map = renderSpecDraftSections(specDraft())
    expect(map['specification-body']).toContain(
      '<ul class="figure-list"><li>图1为智能保温杯的整体结构示意图；</li><li>图2为加热控制逻辑的模块框图。</li></ul>',
    )
  })

  it('附图说明的图号跨列表块连续编号', () => {
    const draft = specDraft()
    draft.sections.drawingDescriptions = [
      { kind: 'list', items: ['整体结构示意图'] },
      { kind: 'list', items: ['模块框图', '剖视示意图'] },
    ]
    const map = renderSpecDraftSections(draft)
    expect(map['specification-body']).toContain('<li>图1为整体结构示意图；</li>')
    expect(map['specification-body']).toContain('<li>图2为模块框图；</li>')
    expect(map['specification-body']).toContain('<li>图3为剖视示意图。</li>')
  })

  it('附图说明中的段落块按普通段落渲染', () => {
    const draft = specDraft()
    draft.sections.drawingDescriptions = [
      { kind: 'paragraph', text: '本申请共两幅附图。' },
      { kind: 'list', items: ['整体结构示意图'] },
    ]
    const map = renderSpecDraftSections(draft)
    expect(map['specification-body']).toContain('<p>本申请共两幅附图。</p>')
    expect(map['specification-body']).toContain('<li>图1为整体结构示意图。</li>')
  })

  it('表格带自动编号表题与表头表体', () => {
    const map = renderSpecDraftSections(specDraft())
    expect(map['specification-body']).toContain(
      '<table><caption>表 1 · 附图标记说明</caption>'
      + '<thead><tr><th>标记</th><th>名称</th></tr></thead>'
      + '<tbody><tr><td>1</td><td>杯体</td></tr><tr><td>2</td><td>杯盖</td></tr></tbody></table>',
    )
  })

  it('表题编号跨表格连续且文本转义', () => {
    const draft = specDraft()
    draft.sections.embodiment = [
      { kind: 'table', name: '参数表', header: ['k'], rows: [['<v>']] },
      { kind: 'table', name: '部件表', header: ['k'], rows: [['x']] },
    ]
    const map = renderSpecDraftSections(draft)
    expect(map['specification-body']).toContain('<caption>表 1 · 参数表</caption>')
    expect(map['specification-body']).toContain('<caption>表 2 · 部件表</caption>')
    expect(map['specification-body']).toContain('<td>&lt;v&gt;</td>')
  })

  it('摘要包含段落与摘要附图号（缺省 1）', () => {
    const map = renderSpecDraftSections(specDraft())
    expect(map.abstract).toBe(
      '<div class="abstract-box"><h3>摘要</h3>'
      + '<p>本发明公开一种智能保温杯，主要用途是恒温饮水。</p>'
      + '<p><strong>摘要附图：</strong>图 <span class="mono">1</span></p></div>',
    )
  })

  it('摘要附图号取显式值', () => {
    const map = renderSpecDraftSections(specDraft({ abstractFigure: '2' }))
    expect(map.abstract).toContain('图 <span class="mono">2</span>')
  })

  it('无附图草案省略附图说明标题与摘要附图行', () => {
    const map = renderSpecDraftSections(specDraft({
      figureFiles: [],
      sections: { ...specDraft().sections, drawingDescriptions: [] },
    }))
    expect(map['specification-body']).not.toContain('<h3>附图说明</h3>')
    expect(map['specification-body']).toContain('<h3>具体实施方式</h3>')
    expect(map.abstract).toBe(
      '<div class="abstract-box"><h3>摘要</h3>'
      + '<p>本发明公开一种智能保温杯，主要用途是恒温饮水。</p></div>',
    )
  })

  it('无序列表渲染 ul，ordered 显式 false 也渲染 ul', () => {
    const map = renderSpecDraftSections(specDraft({
      sections: {
        ...specDraft().sections,
        background: [{ kind: 'list', items: ['甲', '乙'], ordered: false }],
      },
    }))
    expect(map['specification-body']).toContain('<h3>背景技术</h3><ul><li>甲</li><li>乙</li></ul>')
  })

  it('模型文本无法注入标签或占位符', () => {
    const draft = specDraft({
      claims: ['一种<script>alert(1)</script>装置'],
      abstract: ['<img src=x onerror=alert(1)>'],
    })
    const map = renderSpecDraftSections(draft)
    expect(map['claims-body']).not.toContain('<script>')
    expect(map['claims-body']).toContain('&lt;script&gt;')
    expect(map.abstract).not.toContain('<img')
    expect(map.abstract).toContain('&lt;img')
  })
})
