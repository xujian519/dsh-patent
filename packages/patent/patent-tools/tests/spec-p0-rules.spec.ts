import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { checkClarity } from '../src/tool/spec-clarity.ts'
import {
  checkDrawingCount,
  checkFigureDescriptionName,
  checkFigureNumberDuplicate,
  checkFigureNumberSequence,
  checkFigureReferenceMissing,
  declaresNoDrawings,
  drawingEntries,
  drawingSectionHasFigures,
  figureNumbersIn,
  getDrawingSection,
  hasFigureNumberSuffix,
  knownFigureNumbers,
  parseFigureNumber,
  withoutDrawingSection,
} from '../src/tool/spec-figure-marks.ts'
import { checkEmptySections, checkPlaceholderContent, sectionBodies } from '../src/tool/spec-placeholder.ts'
import { checkSpecProhibitions, checkTitle, COMMERCIAL_ADVERTISING_TERMS } from '../src/tool/spec-prohibitions.ts'
import { checkStructure, inferHasDrawings, requiredSections } from '../src/tool/spec-structure.ts'
import { validateSpecification } from '../src/tool/validate-specification.ts'

const FOUR_PARTS = [
  '## 技术领域',
  '本发明涉及一种检测装置。',
  '## 背景技术',
  '现有检测装置存在精度不足的问题。',
  '## 发明内容',
  '本发明提供一种高精度检测装置。',
  '## 具体实施方式',
  '实施例1：本实施例提供一种检测装置，包括壳体。',
].join('\n')

describe('figure number parsing', () => {
  it('parses Arabic and Chinese numbers, including hundreds', () => {
    expect(parseFigureNumber('12')).toBe(12)
    expect(parseFigureNumber('十一')).toBe(11)
    expect(parseFigureNumber('二十')).toBe(20)
    expect(parseFigureNumber('三百零五')).toBe(305)
    expect(parseFigureNumber('一百')).toBe(100)
    expect(parseFigureNumber('百')).toBeUndefined()
    expect(parseFigureNumber('甲')).toBeUndefined()
    expect(parseFigureNumber('9'.repeat(400))).toBeUndefined()
  })

  it('reads figure numbers in text order', () => {
    expect(figureNumbersIn('图1与图三、图01')).toEqual([1, 3, 1])
  })

  it('parses drawing entries and strips connectors', () => {
    expect(drawingEntries('图1为整体结构图；图2：剖视图；图一：主视图')).toEqual([
      { number: 1, name: '整体结构图' },
      { number: 2, name: '剖视图' },
      { number: 1, name: '主视图' },
    ])
    expect(drawingEntries('图1。')).toEqual([{ number: 1, name: '' }])
  })

  it('reads one entry per figure label in comma-separated and range listings', () => {
    expect(drawingEntries('图1为A，图2为B。').map(entry => entry.number)).toEqual([1, 2])
    expect(drawingEntries('图1至图3分别为结构图、剖视图和放大图。').map(entry => entry.number)).toEqual([1, 2, 3])
    expect(drawingEntries('图2为图1中A处的放大图。')).toEqual([{ number: 2, name: '图1中A处的放大图' }])
  })

  it('finds the drawing section only when it is a heading', () => {
    expect(getDrawingSection(FOUR_PARTS)).toBe('')
    expect(getDrawingSection('## 附图说明\n图1为结构图。')).toBe('图1为结构图。')
    expect(drawingSectionHasFigures(FOUR_PARTS)).toBe(false)
    expect(drawingSectionHasFigures('## 附图说明\n图1为结构图。')).toBe(true)
    expect(declaresNoDrawings('## 附图说明\n本申请无附图。')).toBe(true)
    expect(declaresNoDrawings(FOUR_PARTS)).toBe(false)
    expect(withoutDrawingSection(FOUR_PARTS)).toBe(FOUR_PARTS)
    expect(withoutDrawingSection('## 附图说明\n图1为A。\n## 具体实施方式\n如图1所示。')).toContain('具体实施方式')
  })
})

describe('figure sequence checks', () => {
  it('skips the sequence check when no drawing section or no number exists', () => {
    expect(checkFigureNumberSequence(FOUR_PARTS)).toEqual([])
    expect(checkFigureNumberSequence('## 附图说明\n无附图。')).toEqual([])
  })

  it('accepts contiguous numbers and reports gaps', () => {
    expect(checkFigureNumberSequence('## 附图说明\n图1为A。\n图2为B。')).toEqual([])
    const gap = checkFigureNumberSequence('## 附图说明\n图1为A。\n图3为C。')
    expect(gap[0]).toMatchObject({ rule: 'figure_number_sequence', severity: 'error', family: 'figures' })
    expect(gap[0]?.message).toContain('缺少图2')
  })

  it('reads a comma-separated drawing description as separate figures', () => {
    const text = '## 附图说明\n图1为整体结构示意图，图2为局部放大示意图。'
    expect(checkFigureNumberSequence(text)).toEqual([])
    expect(checkDrawingCount(text, 2)).toEqual([])
    expect(checkFigureReferenceMissing(`${text}\n## 具体实施方式\n如图1和图2所示。`)).toEqual([])
  })

  it('expands a figure-number range instead of reporting missing figures', () => {
    const text = '## 附图说明\n图1至图3分别为结构图、剖视图和放大图。'
    expect(checkFigureNumberSequence(text)).toEqual([])
    expect(checkDrawingCount(text, 3)).toEqual([])
    expect(checkFigureReferenceMissing(`${text}\n## 具体实施方式\n如图2所示。`)).toEqual([])
  })

  it('reports duplicate numbers', () => {
    expect(checkFigureNumberDuplicate('## 附图说明\n图1为A。\n图2为B。')).toEqual([])
    const duplicate = checkFigureNumberDuplicate('## 附图说明\n图1为A。\n图1为B。')
    expect(duplicate[0]?.message).toContain('图1')
  })

  it('reports body references absent from the drawing description', () => {
    expect(checkFigureReferenceMissing(FOUR_PARTS)).toEqual([])
    expect(checkFigureReferenceMissing('## 附图说明\n图1为A。\n## 具体实施方式\n如图1所示。')).toEqual([])
    const missing = checkFigureReferenceMissing('## 附图说明\n图1为A。\n## 具体实施方式\n如图2所示。')
    expect(missing[0]?.message).toContain('图2')
  })

  it('reports an entry without a figure name', () => {
    expect(checkFigureDescriptionName('## 附图说明\n图1为结构图。')).toEqual([])
    const missing = checkFigureDescriptionName('## 附图说明\n图1。')
    expect(missing[0]?.rule).toBe('figure_description_name')
    expect(missing[0]?.message).toContain('图1未写明图名')
  })

  it('compares the declared drawing count with the entries', () => {
    const text = '## 附图说明\n图1为A。\n图2为B。'
    expect(checkDrawingCount(text, undefined)).toEqual([])
    expect(checkDrawingCount(text, 2)).toEqual([])
    const mismatch = checkDrawingCount(text, 3)
    expect(mismatch[0]?.message).toContain('3 幅')
    expect(mismatch[0]?.message).toContain('2 幅')
  })

  it('detects letter-suffixed figure numbers', () => {
    expect(hasFigureNumberSuffix('图1A为局部图。')).toBe(true)
    expect(hasFigureNumberSuffix('图1为整体图。')).toBe(false)
  })

  it('prefers analyzed figure numbers over the drawing section', () => {
    const analysis = [{ figureNumber: 4, usable: true, components: [] }]
    expect(knownFigureNumbers('## 附图说明\n图1为A。', analysis)).toEqual([4])
    expect(knownFigureNumbers('## 附图说明\n图一为A。\n图二为B。')).toEqual([1, 2])
  })
})

describe('section bodies and placeholders', () => {
  it('ignores non-headings, unknown headings and keeps the last section body', () => {
    const text = ['# 说明书', '## 技术领域', '内容。', '## 自定义', '无关。', '## 具体实施方式', '实施例1。'].join('\n')
    expect(sectionBodies(text)).toEqual([
      { name: '技术领域', line: 2, body: '内容。' },
      { name: '具体实施方式', line: 6, body: '实施例1。' },
    ])
    expect(sectionBodies('没有标题')).toEqual([])
  })

  it('reports every placeholder marker', () => {
    const text = '【撰写指引】内容\n待补充\nTODO\nTBD'
    const violations = checkPlaceholderContent(text)
    expect(violations.map(v => v.rule)).toEqual(['placeholder_content', 'placeholder_content', 'placeholder_content', 'placeholder_content'])
    expect(checkPlaceholderContent('完整文本')).toEqual([])
  })

  it('reports empty sections', () => {
    const violations = checkEmptySections('## 技术领域\n\n## 具体实施方式\n实施例1。')
    expect(violations).toHaveLength(1)
    expect(violations[0]?.section).toBe('技术领域')
    expect(checkEmptySections(FOUR_PARTS)).toEqual([])
  })
})

describe('prohibitions and title', () => {
  it('reports claim citations, advertising, and internal markers', () => {
    const text = '如权利要求1所述的装置，世界领先，AI 辅助生成。'
    const violations = checkSpecProhibitions(text)
    expect(violations.map(v => v.rule)).toEqual(['claim_citation_phrase', 'commercial_advertising', 'internal_leakage'])
    expect(violations.every(v => v.family === 'prohibitions')).toBe(true)
  })

  it('reports nothing in clean text', () => {
    expect(checkSpecProhibitions('本发明提供一种检测装置。')).toEqual([])
  })

  it('checks title length, marks, advertising and model numbers', () => {
    expect(checkTitle('')).toEqual([])
    expect(checkTitle('一种检测装置')).toEqual([])
    expect(checkTitle('一'.repeat(26))[0]).toMatchObject({ rule: 'title_length', severity: 'warning' })
    expect(checkTitle('一'.repeat(41))[0]).toMatchObject({ rule: 'title_length', severity: 'error' })
    expect(checkTitle('检测装置®')[0]?.rule).toBe('title_prohibited_word')
    expect(checkTitle('世界领先的检测装置')[0]?.rule).toBe('title_prohibited_word')
    expect(checkTitle('检测装置 XR-200')[0]?.message).toContain('型号')
  })

  it('shares the advertising word list with rule CON-COMP-0105', () => {
    const asset = readFileSync(
      fileURLToPath(new URL('../../patent-rule/assets/rules/patent/nuo-compliance-enforceable.yaml', import.meta.url)),
      'utf8',
    )
    const block = /- id: CON-COMP-0105[\s\S]*?keywords:\n((?: {8}- .+\n?)+)/.exec(asset)
    const keywords = (block?.[1] ?? '').split('\n').map(line => line.replace(/^\s*- /, '').trim()).filter(Boolean)
    expect(keywords).toEqual([...COMMERCIAL_ADVERTISING_TERMS])
  })
})

describe('structure by patent type and drawings', () => {
  const present = (text: string): Set<string> => new Set(sectionBodies(text).map(section => section.name))

  it('computes required sections from type and drawings', () => {
    expect(requiredSections('invention', false)).toEqual(['技术领域', '背景技术', '发明内容', '具体实施方式'])
    expect(requiredSections('invention', true)).toContain('附图说明')
    expect(requiredSections('utility_model', false)).toContain('附图说明')
  })

  it('infers drawings from analysis, the drawing section, a declaration, or body references', () => {
    expect(inferHasDrawings(FOUR_PARTS, [{ usable: true, components: [] }])).toBe(true)
    expect(inferHasDrawings('## 附图说明\n图1为A。')).toBe(true)
    expect(inferHasDrawings('## 附图说明\n本申请无附图。\n## 具体实施方式\n如图1所示。')).toBe(false)
    expect(inferHasDrawings(FOUR_PARTS)).toBe(false)
  })

  it('passes an invention without drawings and fails a utility model without drawings', () => {
    const invention = checkStructure({ patent_type: 'invention' }, FOUR_PARTS, present(FOUR_PARTS))
    expect(invention.violations).toEqual([])
    const utility = checkStructure({ patent_type: 'utility_model' }, FOUR_PARTS, present(FOUR_PARTS))
    expect(utility.violations.map(v => v.rule)).toContain('utility_model_drawings')
  })

  it('warns when the patent type is assumed and reports the empty text', () => {
    expect(checkStructure({}, FOUR_PARTS, present(FOUR_PARTS)).violations[0]?.rule).toBe('patent_type_assumed')
    const empty = checkStructure({ patent_type: 'invention' }, '', new Set())
    expect(empty.violations[0]?.message).toContain('text 为空')
  })

  it('reports a drawing section without figures and declared-no-drawings references', () => {
    const text = '## 技术领域\n内容。\n## 背景技术\n内容。\n## 发明内容\n内容。\n## 附图说明\n待定。\n## 具体实施方式\n如图1所示。'
    const section = checkStructure({ patent_type: 'invention', has_drawings: true }, text, present(text))
    expect(section.violations.map(v => v.rule)).toContain('drawing_section_without_drawings')
    const declared = checkStructure({ patent_type: 'invention', has_drawings: false }, text, present(text))
    expect(declared.violations.map(v => v.rule)).toContain('declared_no_drawings_with_refs')
    const noRefs = checkStructure({ patent_type: 'invention', has_drawings: false }, FOUR_PARTS, present(FOUR_PARTS))
    expect(noRefs.violations).toEqual([])
  })

  it('reports missing required sections', () => {
    const text = '## 技术领域\n内容。'
    const result = checkStructure({ patent_type: 'invention', has_drawings: true }, text, present(text))
    expect(result.violations.find(v => v.rule === 'sections')?.message).toContain('背景技术')
  })
})

describe('clarity in context', () => {
  it('does not flag exact technical wording or permitted drafting aids', () => {
    expect(checkClarity('约束条件为两侧受力，左右两侧对称，例如采用钢材，优选铝合金。')).toEqual([])
  })

  it('flags vague quantities and vague words', () => {
    expect(checkClarity('温度约 10%，厚度 5%左右，可能较好。')[0]?.rule).toBe('clarity')
    expect(checkClarity('约10%和约10%')[0]?.message).toContain('约10')
  })
})

describe('P0 acceptance through validateSpecification', () => {
  it('fails a placeholder-only draft', () => {
    const text = [
      '## 技术领域', '【撰写指引】写技术领域。',
      '## 背景技术', '【撰写指引】写背景技术。',
      '## 发明内容', '【撰写指引】写发明内容。',
      '## 具体实施方式', '【撰写指引】写实施例。',
    ].join('\n')
    const out = validateSpecification({ text, patent_type: 'invention' })
    expect(out.passed).toBe(false)
    expect(out.violations.filter(v => v.rule === 'placeholder_content')).toHaveLength(1)
  })

  it('passes a four-part invention without drawings', () => {
    const out = validateSpecification({ text: FOUR_PARTS, patent_type: 'invention' })
    expect(out.violations.find(v => v.rule === 'sections')).toBeUndefined()
    expect(out.passed).toBe(true)
    expect(out.not_assessed.map(item => item.id)).toContain('enablement')
    expect(out.not_assessed.map(item => item.id)).not.toContain('figure-analysis')
  })

  it('fails a utility model without drawings', () => {
    const out = validateSpecification({ text: FOUR_PARTS, patent_type: 'utility_model' })
    expect(out.violations.find(v => v.rule === 'utility_model_drawings')?.severity).toBe('error')
  })

  it('reports figure gaps, missing references and half-width parentheses', () => {
    const text = [
      '## 技术领域', '本发明涉及一种装置。',
      '## 背景技术', '背景。',
      '## 发明内容', '内容。',
      '## 附图说明', '图1为整体图。\n图3为局部图。',
      '## 具体实施方式', '实施例1：如图9所示，壳体(1)固定。',
    ].join('\n')
    const out = validateSpecification({ text, patent_type: 'invention' })
    const rules = out.violations.map(v => v.rule)
    expect(rules).toContain('figure_number_sequence')
    expect(rules).toContain('figure_reference_missing')
    expect(rules).toContain('figure_mark_parentheses')
  })

  it('reads optional inputs without a text field', () => {
    const out = validateSpecification({
      has_drawings: true,
      figure_analysis: [],
      abstract_figure_number: 2,
      abstract: '摘要内容。关键词：检测。',
    })
    expect(out.violations.find(v => v.rule === 'sections')).toBeDefined()
    expect(out.not_assessed.map(item => item.id)).toContain('figure-analysis')
  })

  it('does not flag 约束 or 左右两侧 as vague wording', () => {
    const text = `${FOUR_PARTS}\n约束条件与左右两侧对称布置。`
    const out = validateSpecification({ text, patent_type: 'invention' })
    expect(out.violations.find(v => v.rule === 'clarity')).toBeUndefined()
  })

  it('reports claim citations and advertising in the specification', () => {
    const text = `${FOUR_PARTS}\n如权利要求1所述的装置，采用世界领先工艺。`
    const rules = validateSpecification({ text, patent_type: 'invention' }).violations.map(v => v.rule)
    expect(rules).toContain('claim_citation_phrase')
    expect(rules).toContain('commercial_advertising')
  })

  it('checks abstract claim references, marks, advertising and figure number', () => {
    const out = validateSpecification({
      text: `${FOUR_PARTS}\n## 附图说明\n图1为整体图。`,
      patent_type: 'invention',
      has_drawings: true,
      abstract: '根据权利要求1所述的装置，壳体1，世界领先。关键词：检测。',
      abstract_figure_number: 9,
    })
    const rules = out.violations.map(v => v.rule)
    expect(rules).toContain('abstract_claim_reference')
    expect(rules).toContain('abstract_mark_parentheses')
    expect(rules).toContain('abstract_commercial_advertising')
    expect(rules).toContain('abstract_drawing_number')
  })

  it('lists letter-suffixed figure numbers as not assessed', () => {
    const out = validateSpecification({
      text: `${FOUR_PARTS}\n## 附图说明\n图1A为整体图。`,
      patent_type: 'invention',
      has_drawings: true,
    })
    expect(out.not_assessed.map(item => item.id)).toContain('figure-number-suffix')
  })
})
