import { describe, expect, it } from 'vitest'
import {
  checkAbstractHeading,
  checkFigureMarkParentheses,
  checkFigureNumberSpacing,
  checkHeadingSet,
  checkParagraphNumbering,
  checkSectionOrder,
  checkSpecStyle,
  SPEC_SECTION_HEADINGS,
} from '../src/tool/spec-style.ts'
import { draftSpecification, renderDraftSpecification } from '../src/tool/draft-specification.ts'
import { validateSpecification } from '../src/tool/validate-specification.ts'

const IN_ORDER = [
  '## 技术领域',
  '本发明涉及一种检测装置。',
  '## 背景技术',
  '现有检测装置存在精度不足的问题。',
  '## 发明内容',
  '本发明提供一种高精度检测装置。',
  '## 附图说明',
  '图1是本发明实施例的结构示意图。',
  '## 具体实施方式',
  '实施例1：如图1所示，本实施例提供一种检测装置，包括壳体1。',
].join('\n')

describe('SPEC_SECTION_HEADINGS', () => {
  it('names the five parts of 专利法实施细则第二十条 in order', () => {
    expect(SPEC_SECTION_HEADINGS).toEqual(['技术领域', '背景技术', '发明内容', '附图说明', '具体实施方式'])
  })
})

describe('checkHeadingSet', () => {
  it('accepts the five parts and the document wrapper', () => {
    expect(checkHeadingSet(IN_ORDER)).toEqual([])
    expect(checkHeadingSet(`# 说明书\n\n${IN_ORDER}`)).toEqual([])
  })

  it('says nothing about an empty text', () => {
    expect(checkHeadingSet('   ')).toEqual([])
  })

  it('reports every heading outside the five parts, with the first one located', () => {
    const text = ['## 技术领域', '本发明涉及一种检测装置。', '## 要解决的技术问题', '提高精度。', '### 实施例一：整体构造', '包括壳体。'].join('\n')
    const [v, ...rest] = checkHeadingSet(text)
    expect(rest).toEqual([])
    expect(v?.rule).toBe('heading_set')
    expect(v?.severity).toBe('error')
    expect(v?.message).toContain('2 个规定之外的标题')
    expect(v?.message).toContain('要解决的技术问题')
    expect(v?.message).toContain('实施例一：整体构造')
    expect(v?.line).toBe(3)
    expect(v?.matchedSentence).toBe('要解决的技术问题')
  })

  it('reports a repeated section heading at its second occurrence', () => {
    const text = [
      '## 技术领域', '本发明涉及一种检测装置。',
      '## 技术领域', '本发明涉及另一种检测装置。',
      '## 技术领域', '本发明涉及第三种检测装置。',
    ].join('\n')
    const [v, ...rest] = checkHeadingSet(text)
    expect(rest).toEqual([])
    expect(v?.rule).toBe('heading_duplicate')
    expect(v?.severity).toBe('error')
    expect(v?.message).toContain('技术领域')
    expect(v?.suggestion).toContain('技术领域')
    expect(v?.line).toBe(3)
    expect(v?.matchedSentence).toBe('技术领域')
  })
})

describe('checkSectionOrder', () => {
  it('accepts the required order', () => {
    expect(checkSectionOrder(IN_ORDER)).toEqual([])
  })

  it('stays silent while a part is missing, leaving that to the sections rule', () => {
    expect(checkSectionOrder('## 技术领域\n本发明涉及一种检测装置。')).toEqual([])
  })

  it('reports the parts in the order they actually appear', () => {
    const swapped = IN_ORDER.replace('## 背景技术', '## 发明内容').replace('## 发明内容\n本发明提供', '## 背景技术\n本发明提供')
    const v = checkSectionOrder(swapped).find(x => x.rule === 'section_order')
    expect(v?.severity).toBe('error')
    expect(v?.message).toContain('顺序不符')
    expect(v?.suggestion).toContain('技术领域、背景技术、发明内容、附图说明、具体实施方式')
  })
})

describe('checkFigureMarkParentheses', () => {
  it('reports a parenthesized mark and proposes the unbracketed form', () => {
    const text = '所述多参量数据采集模块（1）具有采集信号输出端。'
    const [v] = checkFigureMarkParentheses(text)
    expect(v?.rule).toBe('figure_mark_parentheses')
    expect(v?.severity).toBe('error')
    expect(v?.message).toContain('多参量数据采集模块（1）')
    expect(v?.suggestion).toContain('多参量数据采集模块1')
    expect(v?.line).toBe(1)
  })

  it('quotes the name the mark labels, not the sentence before it', () => {
    const [v] = checkFigureMarkParentheses('所述壳体（3）的内部设有控制器。')
    expect(v?.message).toContain('壳体（3）')
    expect(v?.suggestion).toBe('改写为「壳体3」，把标记直接跟在技术名称后')
  })

  it('cuts a longer context at the last boundary word', () => {
    const [v] = checkFigureMarkParentheses('本实施例提供的装置包括与所述模块（1）连接的底座。')
    expect(v?.message).toContain('模块（1）')
    expect(v?.suggestion).toContain('模块1')
  })

  it('falls back to the whole window when the boundary cut leaves one character', () => {
    const [v] = checkFigureMarkParentheses('所述连接件（4）固定到底座。')
    expect(v?.message).toContain('连接件（4）')
    expect(v?.suggestion).toContain('连接件4')
  })

  it('reports each distinct mark once, in text order', () => {
    const text = '模块（1）与模块（1）连接，还有单元（2）。'
    expect(checkFigureMarkParentheses(text).map(v => v.message)).toEqual([
      expect.stringContaining('模块（1）'),
      expect.stringContaining('单元（2）'),
    ])
  })

  it('leaves enumerations and references alone', () => {
    expect(checkFigureMarkParentheses('实施例（1）给出方案，图（2）标注位置。')).toEqual([])
  })
})

describe('checkFigureNumberSpacing', () => {
  it('reports a spaced figure number and proposes the closed form', () => {
    const [v] = checkFigureNumberSpacing('如图 1 所示，包括壳体。')
    expect(v?.rule).toBe('figure_number_spacing')
    expect(v?.severity).toBe('error')
    expect(v?.message).toContain('图 1')
    expect(v?.suggestion).toContain('图1')
  })

  it('covers Chinese numerals and reports each distinct number once', () => {
    expect(checkFigureNumberSpacing('见图 二与图 二。').map(v => v.suggestion)).toEqual([expect.stringContaining('图二')])
  })

  it('stays silent when figure numbers are written closed', () => {
    expect(checkFigureNumberSpacing('如图1所示，图2为剖面图。')).toEqual([])
  })
})

describe('checkParagraphNumbering', () => {
  it('warns once on the first paragraph number', () => {
    const [v] = checkParagraphNumbering('[0001] 本实用新型涉及一种检测装置。')
    expect(v?.rule).toBe('paragraph_numbering')
    expect(v?.severity).toBe('warning')
    expect(v?.message).toContain('[0001]')
    expect(v?.line).toBe(1)
  })

  it('stays silent when the text carries no paragraph number', () => {
    expect(checkParagraphNumbering(IN_ORDER)).toEqual([])
  })
})

describe('checkAbstractHeading', () => {
  it('stays silent without an abstract', () => {
    expect(checkAbstractHeading(undefined)).toEqual([])
    expect(checkAbstractHeading('')).toEqual([])
  })

  it('stays silent on a heading-free abstract', () => {
    expect(checkAbstractHeading('本实用新型公开了一种检测装置。')).toEqual([])
  })

  it('reports a heading inside the abstract', () => {
    const [v] = checkAbstractHeading('## 摘要\n本实用新型公开了一种检测装置。')
    expect(v?.rule).toBe('abstract_heading')
    expect(v?.severity).toBe('error')
    expect(v?.section).toBe('摘要')
  })
})

describe('checkSpecStyle', () => {
  it('aggregates every style family', () => {
    const text = ['# 说明书', ...IN_ORDER.split('\n'), '所述壳体（1）与如图 2 所示的部件连接。'].join('\n')
    expect(checkSpecStyle(text, '## 摘要\n本实用新型公开了一种检测装置。').map(v => v.rule)).toEqual([
      'figure_mark_parentheses',
      'figure_number_spacing',
      'abstract_heading',
    ])
  })
})

describe('validateSpecification style integration', () => {
  it('carries the style violations into the report and the score', () => {
    const text = ['## 技术领域', '本发明涉及一种检测装置。', '## 背景技术', '现有检测装置精度不足。', '## 发明内容', '本发明提供一种高精度检测装置。', '## 附图说明', '图1是结构示意图。', '## 具体实施方式', '实施例1：所述壳体（1）与如图 1 所示的部件连接。'].join('\n')
    const out = validateSpecification({ text, patent_type: 'invention' })
    expect(out.passed).toBe(false)
    expect(out.violations.map(v => v.rule)).toEqual(['figure_mark_parentheses', 'figure_number_spacing'])
    expect(out.score).toBeLessThan(1)
  })

  it('accepts the headings a drafted specification renders', () => {
    const rendered = renderDraftSpecification(draftSpecification({ title: '一种装置', background: '现有技术中，检测装置精度不足。' }))
    expect(validateSpecification({ text: rendered }).violations.filter(v => v.rule === 'heading_set')).toEqual([])
  })
})
