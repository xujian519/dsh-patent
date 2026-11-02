import { describe, expect, it } from 'vitest'
import { DraftSpecificationHandler } from '../src/atoms/draft-specification.ts'
import { draftSpecification, renderDraftSpecification } from '../src/tool/draft-specification.ts'
import { buildEmbodimentBlocks, numberFeatures } from '../src/tool/spec-blocks.ts'
import { validateSpecification } from '../src/tool/validate-specification.ts'

const handler = new DraftSpecificationHandler()
const run = (state: Record<string, unknown>) => handler.execute({ state })

describe('numberFeatures', () => {
  it('assigns stable identifiers in input order and drops duplicates', () => {
    expect(numberFeatures([' 壳体1 ', '弹簧2', '壳体1', ''])).toEqual([
      { id: 'F1', text: '壳体1' },
      { id: 'F2', text: '弹簧2' },
    ])
  })

  it('returns an empty table for absent features', () => {
    expect(numberFeatures(undefined)).toEqual([])
  })
})

describe('buildEmbodimentBlocks', () => {
  it('splits the source at embodiment headings and cites matching features and marks', () => {
    const source = [
      '本发明提供一种检测装置。',
      '实施例1：壳体1内设置弹簧2，弹簧2抵接传感器3。',
      '实施例2：壳体1内对称设置两个弹簧2。',
    ].join('\n')
    const build = buildEmbodimentBlocks({
      sourceText: source,
      features: numberFeatures(['壳体1', '弹簧2']),
      figureMarks: [
        { figure_number: 1, ref_number: '1' },
        { figure_number: 1, ref_number: '2' },
        { figure_number: 2, ref_number: '3' },
      ],
    })
    expect(build.dropped).toEqual([])
    expect(build.blocks.map(block => block.heading)).toEqual([
      undefined,
      '实施例1：壳体1内设置弹簧2，弹簧2抵接传感器3。',
      '实施例2：壳体1内对称设置两个弹簧2。',
    ])
    expect(build.blocks[1]?.feature_ids).toEqual(['F1', 'F2'])
    expect(build.blocks[1]?.figure_marks).toEqual([
      { figure_number: 1, ref_number: '1' },
      { figure_number: 1, ref_number: '2' },
      { figure_number: 2, ref_number: '3' },
    ])
    expect(build.blocks[2]?.figure_marks).toEqual([
      { figure_number: 1, ref_number: '1' },
      { figure_number: 1, ref_number: '2' },
    ])
    expect(build.warnings).toEqual([])
  })

  it('drops an explicit embodiment whose excerpt is absent from the source', () => {
    const build = buildEmbodimentBlocks({
      sourceText: '本实施例提供一种检测装置，包括壳体1。',
      embodiments: ['本实施例提供一种检测装置，包括壳体1。', '本实施例采用另一种未记载的结构。'],
    })
    expect(build.blocks).toHaveLength(1)
    expect(build.dropped).toEqual([
      { text: '本实施例采用另一种未记载的结构。', reason: 'anchor-not-found' },
    ])
    expect(build.warnings).toEqual(['具体实施方式丢弃 1 个未命中原文或为空的实施例块'])
  })

  it('drops empty blocks instead of rendering them', () => {
    const build = buildEmbodimentBlocks({
      sourceText: '本实施例提供一种检测装置。',
      embodiments: ['  ', '本实施例提供一种检测装置。'],
    })
    expect(build.dropped).toEqual([{ text: '', reason: 'empty' }])
    expect(build.blocks).toHaveLength(1)
  })

  it('warns when a block cites neither a feature nor a figure mark', () => {
    const build = buildEmbodimentBlocks({
      sourceText: '实施例1：一种未编号的结构。',
      features: numberFeatures(['壳体1']),
      figureMarks: [{ figure_number: 1, ref_number: '9' }],
    })
    expect(build.warnings).toEqual([
      '实施例 1 未匹配到 PFIE 特征，未标注特征编号',
      '实施例 1 未匹配到附图标记',
    ])
  })

  it('keeps the legacy single block when the source has no embodiment heading', () => {
    const build = buildEmbodimentBlocks({ sourceText: '一种检测装置，包括壳体1。' })
    expect(build.blocks).toHaveLength(1)
    expect(build.blocks[0]?.heading).toBeUndefined()
    expect(build.blocks[0]?.anchor_reason).toBe('exact')
  })

  it('returns no blocks when neither a source nor explicit embodiments exist', () => {
    expect(buildEmbodimentBlocks({})).toEqual({ blocks: [], dropped: [], warnings: [] })
  })

  it('returns no blocks for a whitespace-only source', () => {
    expect(buildEmbodimentBlocks({ sourceText: '   \n  ' })).toEqual({ blocks: [], dropped: [], warnings: [] })
  })

  it('keeps a heading-only embodiment block', () => {
    const build = buildEmbodimentBlocks({ sourceText: '实施例1：' })
    expect(build.blocks).toHaveLength(1)
    expect(build.blocks[0]?.heading).toBe('实施例1：')
    expect(build.blocks[0]?.text).toBe('实施例1：')
  })

  it('joins a heading line with the body line below it', () => {
    const build = buildEmbodimentBlocks({
      sourceText: '实施例1：\n壳体1内设置弹簧2。',
      features: numberFeatures(['壳体1']),
    })
    expect(build.blocks[0]?.text).toBe('实施例1：\n壳体1内设置弹簧2。')
    expect(build.blocks[0]?.feature_ids).toEqual(['F1'])
  })

  it('accepts explicit embodiments without a source text', () => {
    const build = buildEmbodimentBlocks({ embodiments: ['本实施例提供一种检测装置。'] })
    expect(build.blocks).toHaveLength(1)
    expect(build.blocks[0]?.anchor_reason).toBe('exact')
    expect(build.dropped).toEqual([])
  })
})

describe('draftSpecification embodiment blocks', () => {
  it('renders citations and omits dropped excerpts', () => {
    const source = '实施例1：壳体1内设置弹簧2，弹簧2抵接传感器3。'
    const out = draftSpecification({
      title: '一种检测装置',
      technical_solution: source,
      source_text: source,
      technical_problem: '检测精度不足',
      beneficial_effects: '提高检测精度',
      background: '现有检测装置精度不足。',
      features: ['壳体1', '弹簧2'],
      figure_marks: [{ figure_number: 1, ref_number: '1' }, { figure_number: 1, ref_number: '2' }],
      embodiments: [source, '原文没有的实施例。'],
    })
    const text = renderDraftSpecification(out)
    expect(text).toContain('实施例1：壳体1内设置弹簧2')
    expect(text).toContain('对应特征 F1、F2')
    expect(text).toContain('附图标记 1、2（图1）')
    expect(text).not.toContain('原文没有的实施例')
    expect(out.embodiment_blocks).toHaveLength(1)
    expect(out.dropped_embodiment_blocks).toEqual([{ text: '原文没有的实施例。', reason: 'anchor-not-found' }])
    expect(out.complete).toBe(true)
    expect(Array.from(out.abstract).length).toBeLessThanOrEqual(300)
  })

  it('keeps the citation lines clear of figure-mark and spacing violations', () => {
    const source = '实施例1：壳体1内设置弹簧2，弹簧2抵接传感器3。'
    const out = draftSpecification({
      title: '一种检测装置',
      technical_solution: source,
      source_text: source,
      technical_problem: '检测精度不足',
      beneficial_effects: '提高检测精度',
      background: '现有检测装置精度不足。',
      drawing_descriptions: ['整体结构示意图'],
      features: ['壳体1', '弹簧2'],
      figure_marks: [{ figure_number: 1, ref_number: '1' }, { figure_number: 1, ref_number: '2' }],
      embodiments: [source],
    })
    const violations = validateSpecification({
      text: renderDraftSpecification(out),
      patent_type: 'invention',
    }).violations.filter(violation => violation.rule === 'figure_mark_parentheses'
      || violation.rule === 'figure_number_spacing')
    expect(violations).toEqual([])
  })

  it('keeps the section incomplete when every block is dropped', () => {
    const out = draftSpecification({
      title: '一种检测装置',
      source_text: '原文只记载了壳体1。',
      embodiments: ['原文没有的实施例。'],
    })
    expect(out.embodiment_blocks).toEqual([])
    expect(out.complete).toBe(false)
    expect(out.missing_inputs).toContain('具体实施方式')
    expect(out.sections.find(section => section.name === '具体实施方式')?.placeholder).toBe(true)
  })
})

describe('DraftSpecificationHandler embodiment blocks', () => {
  it('reads PFIE features and usable figure marks from the workflow state', async () => {
    const out = await run({
      title: '检测装置',
      source_text: [
        '实施例1：壳体1内设置弹簧2，弹簧2抵接传感器3。',
        '实施例2：壳体1上设置传感器3。',
      ].join('\n'),
      features: ['壳体1', '弹簧2', 42],
      figure_analysis: [
        { figureNumber: 1, usable: true, components: [{ refNumber: '1' }, { refNumber: '2' }] },
        { figureNumber: 2, usable: false, components: [{ refNumber: '3' }] },
      ],
      has_drawings: true,
    })
    const blocks = out.embodiment_blocks as Array<{
      feature_ids: string[]
      figure_marks: Array<{ figure_number: number; ref_number: string }>
    }>
    expect(blocks).toHaveLength(2)
    expect(blocks[0]?.feature_ids).toEqual(['F1', 'F2'])
    expect(blocks[0]?.figure_marks).toEqual([
      { figure_number: 1, ref_number: '1' },
      { figure_number: 1, ref_number: '2' },
    ])
    expect(blocks[1]?.figure_marks).toEqual([{ figure_number: 1, ref_number: '1' }])
    expect(String(out.specification)).toContain('（对应特征 F1、F2；附图标记 1、2（图1））')
    expect(out.dropped_embodiment_blocks).toEqual([])
  })

  it('ignores malformed figure-analysis entries and defaults the figure number', async () => {
    const out = await run({
      title: '检测装置',
      source_text: '实施例1：壳体7与弹簧8连接。',
      features: ['壳体7'],
      figure_analysis: [
        null,
        { usable: true, components: [null, { refNumber: 5 }, { refNumber: '7' }] },
        { figureNumber: 0, usable: true, components: [{ refNumber: ' ' }, { refNumber: '7' }] },
        { figureNumber: '3', usable: true, components: 'not-an-array' },
        { figureNumber: 4, usable: true },
      ],
    })
    const blocks = out.embodiment_blocks as Array<{
      figure_marks: Array<{ figure_number: number; ref_number: string }>
    }>
    expect(blocks[0]?.figure_marks).toEqual([
      { figure_number: 2, ref_number: '7' },
      { figure_number: 3, ref_number: '7' },
    ])
  })

  it('deduplicates marks repeated across entries', async () => {
    const out = await run({
      title: '检测装置',
      source_text: '实施例1：壳体1与弹簧1连接。',
      features: ['壳体1'],
      figure_analysis: [
        { figureNumber: 1, usable: true, components: [{ refNumber: '1' }] },
        { figureNumber: 1, usable: true, components: [{ refNumber: '1' }] },
      ],
    })
    const blocks = out.embodiment_blocks as Array<{
      figure_marks: Array<{ figure_number: number; ref_number: string }>
    }>
    expect(blocks[0]?.figure_marks).toEqual([{ figure_number: 1, ref_number: '1' }])
  })
})
