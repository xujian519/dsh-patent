import { describe, expect, it } from 'vitest'
import type { SpecDraft } from '@deepseek-ai/dsh-patent-core'
import { renderSpecDraftSections } from '@deepseek-ai/dsh-patent-document'
import { contentFromDraft, filingTextsFromDraft } from '@deepseek-ai/dsh-patent-filing'

/** 最小可转换 claims-spec 草案（与 patent-document 用例同形）。 */
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
    figureFiles: ['fig1.svg', 'fig2.png'],
    sections: {
      technicalField: [{ kind: 'paragraph', text: '本发明属于日用品技术领域。' }],
      background: [{ kind: 'paragraph', text: '现有保温杯无法显示水温。' }],
      summary: [
        { kind: 'paragraph', text: '本发明提供一种智能保温杯。' },
        { kind: 'list', items: ['可以显示水温；', '可以低温加热。'], ordered: true },
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

describe('表题跨通道对位', () => {
  it('同一份草案在 HTML 与 docx 两条通道产出同一串表题', () => {
    const draft = specDraft()
    draft.sections.embodiment = [
      { kind: 'table', name: '参数表', header: ['k'], rows: [['v']] },
      { kind: 'paragraph', text: '中间段。' },
      { kind: 'table', name: '部件表', header: ['k'], rows: [['x']] },
    ]
    const html = Object.values(renderSpecDraftSections(draft)).join('')
    const htmlCaptions = [...html.matchAll(/<caption>([\s\S]*?)<\/caption>/gu)].map(match => match[1] ?? '')
    const filingCaptions = contentFromDraft(draft).specification
      .filter(node => node.kind === 'p' && node.text?.startsWith('表 ') === true)
      .map(node => node.text ?? '')
    expect(htmlCaptions).toEqual(['表 1 · 参数表', '表 2 · 部件表'])
    expect(filingCaptions).toEqual(htmlCaptions)
  })

  it('HTML 通道转义表名、docx 通道原样，序号与格式仍同形', () => {
    const draft = specDraft()
    draft.sections.embodiment = [
      { kind: 'table', name: 'a<b>', header: ['k'], rows: [['v']] },
    ]
    const html = Object.values(renderSpecDraftSections(draft)).join('')
    expect(html).toContain('<caption>表 1 · a&lt;b&gt;</caption>')
    expect(contentFromDraft(draft).specification.map(node => node.text ?? ''))
      .toContain('表 1 · a<b>')
  })
})

describe('contentFromDraft', () => {
  it('摘要与附图路径按原样传递', () => {
    const content = contentFromDraft(specDraft())
    expect(content.abstract).toEqual(['本发明公开一种智能保温杯，主要用途是恒温饮水。'])
    expect(content.figures).toEqual(['fig1.svg', 'fig2.png'])
  })

  it('权项自动连续编号（「1. 」前缀），模型不带项号', () => {
    const content = contentFromDraft(specDraft())
    expect(content.claims).toEqual([
      '1. 一种智能保温杯，其特征在于，包括杯体、温度显示模块和加热单元。',
      '2. 如权利要求 1 所述的智能保温杯，其特征在于，还包括控制模块。',
    ])
  })

  it('说明书按五部分生成 h3 节点与正文节点', () => {
    const content = contentFromDraft(specDraft())
    const spec = content.specification
    expect(spec[0]).toEqual({ kind: 'h3', text: '技术领域' })
    expect(spec[1]).toEqual({ kind: 'p', text: '本发明属于日用品技术领域。' })
    const headings = spec.filter(node => node.kind === 'h3').map(node => node.text)
    expect(headings).toEqual(['技术领域', '背景技术', '发明内容', '附图说明', '具体实施方式'])
  })

  it('普通部分的列表块每项成一个正文段（docx 通道无列表节点）', () => {
    const content = contentFromDraft(specDraft())
    const summary = content.specification.filter(node => node.kind === 'p').map(node => node.text)
    expect(summary).toContain('可以显示水温；')
    expect(summary).toContain('可以低温加热。')
  })

  it('附图说明列表项生成「图N为……；/。」正文段', () => {
    const content = contentFromDraft(specDraft())
    const texts = content.specification.map(node => node.text ?? '')
    expect(texts).toContain('图1为智能保温杯的整体结构示意图；')
    expect(texts).toContain('图2为加热控制逻辑的模块框图。')
  })

  it('摘要附图号缺省不下传，显式给定时转成 0 起下标', () => {
    expect(contentFromDraft(specDraft()).abstractFigureIndex).toBeUndefined()
    expect(contentFromDraft(specDraft({ abstractFigure: '2' })).abstractFigureIndex).toBe(1)
  })

  it('无附图草案省略附图说明章节与摘要附图下标', () => {
    const draft = specDraft({
      figureFiles: [],
      abstractFigure: '1',
      sections: {
        ...specDraft().sections,
        drawingDescriptions: [],
      },
    })
    const content = contentFromDraft(draft)
    const headings = content.specification.filter(node => node.kind === 'h3').map(node => node.text)
    expect(headings).toEqual(['技术领域', '背景技术', '发明内容', '具体实施方式'])
    expect(content.figures).toEqual([])
    expect(content.abstractFigureIndex).toBeUndefined()
  })

  it('附图说明的图号跨列表块连续编号', () => {
    const draft = specDraft({ figureFiles: ['fig1.svg', 'fig2.png', 'fig3.png'] })
    draft.sections.drawingDescriptions = [
      { kind: 'list', items: ['整体结构示意图'] },
      { kind: 'list', items: ['模块框图', '剖视示意图'] },
    ]
    const texts = contentFromDraft(draft).specification.map(node => node.text ?? '')
    expect(texts).toContain('图1为整体结构示意图；')
    expect(texts).toContain('图2为模块框图；')
    expect(texts).toContain('图3为剖视示意图。')
  })

  it('表格生成「表 N · 名称」表题段与 header+rows 节点', () => {
    const content = contentFromDraft(specDraft())
    const captionIndex = content.specification.findIndex(node => node.text === '表 1 · 附图标记说明')
    expect(captionIndex).toBeGreaterThanOrEqual(0)
    expect(content.specification[captionIndex + 1]).toEqual({
      kind: 'table',
      rows: [['标记', '名称'], ['1', '杯体'], ['2', '杯盖']],
    })
  })

  it('附图说明中的段落块按普通段落渲染', () => {
    const draft = specDraft({ figureFiles: ['fig1.svg'] })
    draft.sections.drawingDescriptions = [
      { kind: 'paragraph', text: '本申请共一幅附图。' },
      { kind: 'list', items: ['整体结构示意图'] },
    ]
    const texts = contentFromDraft(draft).specification.map(node => node.text ?? '')
    expect(texts).toContain('本申请共一幅附图。')
    expect(texts).toContain('图1为整体结构示意图。')
  })

  it('附图说明中的表格也走表题+节点路径（防绕过校验的直接调用方）', () => {
    const draft = specDraft()
    draft.sections.drawingDescriptions = [
      { kind: 'list', items: ['整体结构示意图', '模块框图'] },
      { kind: 'table', name: '附图清单', header: ['图号'], rows: [['图1']] },
    ]
    const content = contentFromDraft(draft)
    const texts = content.specification.map(node => node.text ?? '')
    expect(texts).toContain('表 1 · 附图清单')
  })

  it('表题编号跨表格连续', () => {
    const draft = specDraft()
    draft.sections.embodiment = [
      { kind: 'table', name: '参数表', header: ['k'], rows: [['v']] },
      { kind: 'table', name: '部件表', header: ['k'], rows: [['x']] },
    ]
    const texts = contentFromDraft(draft).specification.map(node => node.text ?? '')
    expect(texts).toContain('表 1 · 参数表')
    expect(texts).toContain('表 2 · 部件表')
  })
})

describe('filingTextsFromDraft', () => {
  it('说明书全文按 h3 标题 + 正文段以空行摊平，与 contentFromDraft 同源', () => {
    const draft = specDraft()
    const { text } = filingTextsFromDraft(draft)
    const expected = contentFromDraft(draft).specification
      .filter(node => node.kind === 'h3' || node.kind === 'p')
      .map(node => (node.kind === 'h3' ? `### ${node.text ?? ''}` : node.text ?? ''))
      .join('\n\n')
    expect(text).toBe(expected)
    expect(text).toContain('### 技术领域')
    expect(text).toContain('图1为智能保温杯的整体结构示意图；')
    // 表格节点不带文字：表体行不进投影，表题段（p 节点）进。
    expect(text).toContain('表 1 · 附图标记说明')
    expect(text).not.toContain('杯盖')
  })

  it('权项带项号逐行、摘要逐段一行、title 取发明名称', () => {
    const texts = filingTextsFromDraft(specDraft())
    expect(texts.claims).toBe([
      '1. 一种智能保温杯，其特征在于，包括杯体、温度显示模块和加热单元。',
      '2. 如权利要求 1 所述的智能保温杯，其特征在于，还包括控制模块。',
    ].join('\n'))
    expect(texts.abstract).toBe('本发明公开一种智能保温杯，主要用途是恒温饮水。')
    expect(texts.title).toBe('一种智能保温杯')
  })

  it('同一草案投影稳定；任一字符变化投影即变', () => {
    const draft = specDraft()
    expect(filingTextsFromDraft(draft)).toEqual(filingTextsFromDraft(specDraft()))
    const changed = specDraft()
    changed.claims = [...changed.claims]
    changed.claims[0] = `${changed.claims[0]}此外还包括密封圈。`
    const before = filingTextsFromDraft(draft)
    const after = filingTextsFromDraft(changed)
    expect(after.claims).not.toBe(before.claims)
    expect(after.text).toBe(before.text)
    expect(after.abstract).toBe(before.abstract)
  })
})

describe('HTML 与 docx 通道一致性', () => {
  it('同一草案的权项编号、表题与附图说明在两通道一致', () => {
    const draft = specDraft()
    const html = renderSpecDraftSections(draft)
    const docx = contentFromDraft(draft)

    // 权项编号：HTML claim-num 序号与 docx 项号前缀一致。
    const htmlClaimNumbers = [...html['claims-body'].matchAll(/<span class="claim-num">(\d+)\.<\/span>/g)].map(m => m[1])
    const docxClaimNumbers = docx.claims.map(claim => claim.slice(0, claim.indexOf('. ')))
    expect(htmlClaimNumbers).toEqual(['1', '2'])
    expect(docxClaimNumbers).toEqual(htmlClaimNumbers)
    for (const [index, claim] of docx.claims.entries()) {
      expect(claim.slice(claim.indexOf('. ') + 2)).toBe(draft.claims[index])
    }

    // 表题：HTML caption 文本与 docx 表题段一致且同序。
    const htmlCaptions = [...html['specification-body'].matchAll(/<caption>(表 \d+ · [^<]+)<\/caption>/g)].map(m => m[1])
    const docxCaptions = docx.specification.filter(node => node.kind === 'p' && /^表 \d+ · /.test(node.text ?? '')).map(node => node.text)
    expect(htmlCaptions).toEqual(['表 1 · 附图标记说明'])
    expect(docxCaptions).toEqual(htmlCaptions)

    // 附图说明：HTML li 文本与 docx 正文段一致。
    const htmlFigures = [...html['specification-body'].matchAll(/<li>(图\d+为[^<]+)<\/li>/g)].map(m => m[1])
    const docxFigures = docx.specification
      .filter(node => node.kind === 'p' && /^(图\d+为)/.test(node.text ?? ''))
      .map(node => node.text ?? '')
    expect(htmlFigures).toEqual(['图1为智能保温杯的整体结构示意图；', '图2为加热控制逻辑的模块框图。'])
    expect(docxFigures).toEqual(htmlFigures)
  })

  it('摘要附图号在两通道指向同一幅：HTML 印图 N，docx 传第 N 张的下标', () => {
    const draft = specDraft({ abstractFigure: '2' })
    const html = renderSpecDraftSections(draft)
    const docx = contentFromDraft(draft)
    expect(html.abstract).toContain('图 <span class="mono">2</span>')
    expect((docx.abstractFigureIndex ?? 0) + 1).toBe(2)
    expect(docx.figures[docx.abstractFigureIndex ?? 0]).toBe(draft.figureFiles[1])
  })
})
