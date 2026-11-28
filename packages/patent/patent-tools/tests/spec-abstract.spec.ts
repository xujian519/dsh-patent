import { describe, expect, it } from 'vitest'
import { checkAbstract } from '../src/tool/spec-abstract.ts'

/** 摘要检查的独立用例：只读摘要与摘要附图号，不依赖说明书全文规则。 */

describe('checkAbstract', () => {
  it('引用权利要求时给出 warning，不阻断', () => {
    const violations = checkAbstract({ abstract: '根据权利要求1所述的装置，包括本体。关键词：装置' }, false)
    const claim = violations.find(violation => violation.rule === 'abstract_claim_reference')
    expect(claim).toMatchObject({ family: 'abstract', severity: 'warning' })
  })

  it('附图标记未加括号时报 error，已加括号不报', () => {
    const bare = checkAbstract({ abstract: '本发明包括壳体1与盖板2。关键词：壳体' }, false)
    expect(bare.find(violation => violation.rule === 'abstract_mark_parentheses')?.severity).toBe('error')
    const parenthesized = checkAbstract({ abstract: '本发明包括壳体（1）与盖板(2)。关键词：壳体' }, false)
    expect(parenthesized.some(violation => violation.rule === 'abstract_mark_parentheses')).toBe(false)
  })

  it('图号与数量词不当作未加括号的附图标记', () => {
    for (const abstract of ['如图1所示，装置包括本体。关键词：装置', '本体的长度为2。关键词：长度']) {
      const violations = checkAbstract({ abstract }, false)
      expect(violations.some(violation => violation.rule === 'abstract_mark_parentheses')).toBe(false)
    }
  })

  it('方案与方式编号不当作未加括号的附图标记', () => {
    for (const abstract of [
      '本发明提供方案1，采用壳体（1）与盖板（2）。关键词：装置',
      '本发明采用方式2，设置壳体（1）。关键词：装置',
    ]) {
      const violations = checkAbstract({ abstract }, false)
      expect(violations.some(violation => violation.rule === 'abstract_mark_parentheses')).toBe(false)
    }
  })

  it('商业宣传用语报 error', () => {
    const violations = checkAbstract({ abstract: '本发明世界领先。关键词：装置' }, false)
    expect(violations.find(violation => violation.rule === 'abstract_commercial_advertising')?.severity).toBe('error')
  })

  it('摘要附图号读取请求书字段，并与中文图号对齐', () => {
    const text = '## 附图说明\n图一为整体图。\n图二为剖视图。'
    expect(checkAbstract({ text, abstract: '摘要。关键词：装置', abstract_figure_number: 2 }, true)
      .some(violation => violation.rule === 'abstract_drawing_number')).toBe(false)
    const invalid = checkAbstract({ text, abstract: '摘要。关键词：装置', abstract_figure_number: 3 }, true)
    expect(invalid.find(violation => violation.rule === 'abstract_drawing_number')?.severity).toBe('error')
  })

  it('摘要为空时不产生违规', () => {
    expect(checkAbstract({}, true)).toEqual([])
    expect(checkAbstract({ abstract: '   ' }, true)).toEqual([])
  })
})
