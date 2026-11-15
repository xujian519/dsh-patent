import { describe, expect, it } from 'vitest'
import { DraftSpecificationHandler } from '../src/atoms/draft-specification.ts'
import { buildAmendmentReserve, renderAmendmentReserveReport } from '../src/tool/amendment-reserve.ts'
import { draftSpecification, renderDraftSpecification } from '../src/tool/draft-specification.ts'

const CLAIMS = [
  '1. 一种壳体，其特征在于，包括铝合金壳体。',
  '2. 根据权利要求1所述的壳体，其特征在于，所述壳体由螺栓连接。',
].join('\n')

const STRUCTURAL = '壳体可由铝合金壳体替换为工程塑料壳体，螺栓连接关系不变。'
const STEP = '先固定再焊接可改为先焊接再固定。'
const BOUNDS = '加热温度为80℃至95℃。'

describe('buildAmendmentReserve', () => {
  it('records a gap and does not invent a missing alternative', () => {
    const source = [
      '权利要求1',
      `结构等同：${STRUCTURAL}`,
      `步骤替换：${STEP}`,
      '等同结构：还可以采用其他等效结构。',
    ].join('\n')

    const result = buildAmendmentReserve({ sourceText: source, claimsText: CLAIMS })

    expect(result.status).toBe('failed')
    expect(result.gaps).toEqual([{ claim_no: 1, kind: '数值上下界', reason: 'missing' }])
    expect(result.indexText).not.toContain('80℃')
    expect(result.indexText).not.toContain('还可以采用其他等效结构')
    expect(result.entries.map(entry => entry.kind)).toEqual(['结构等同', '步骤替换'])
  })

  it('indexes three source slices and the embodiment that contains each one', () => {
    const source = [
      '权利要求1',
      `结构等同：${STRUCTURAL}`,
      `步骤替换：${STEP}`,
      `数值上下界：${BOUNDS}`,
      `实施例2：${STRUCTURAL}`,
      `实施例3：${STEP}`,
      `实施方式4：${BOUNDS}`,
    ].join('\n')

    const result = buildAmendmentReserve({ sourceText: source, claimsText: CLAIMS })

    expect(result.status).toBe('passed')
    expect(result.gaps).toEqual([])
    expect(result.entries).toEqual([
      { claim_no: 1, kind: '结构等同', embodiment_index: 2, quote: STRUCTURAL },
      { claim_no: 1, kind: '步骤替换', embodiment_index: 3, quote: STEP },
      { claim_no: 1, kind: '数值上下界', embodiment_index: 4, quote: BOUNDS },
    ])
    expect(result.indexText).toBe([
      `权利要求1｜结构等同｜实施例2｜${STRUCTURAL}`,
      `权利要求1｜步骤替换｜实施例3｜${STEP}`,
      `权利要求1｜数值上下界｜实施例4｜${BOUNDS}`,
    ].join('\n'))
  })

  it('drops a caller quote that is not in the disclosure and keeps the source wording', () => {
    const source = `实施例2：${STRUCTURAL.replace('，', ',')}`
    const invented = '壳体可以改用任意材料。'
    const result = buildAmendmentReserve({
      sourceText: source,
      claimsText: CLAIMS,
      reserves: [
        { claim_no: 1, kind: '结构等同', quote: STRUCTURAL },
        { claim_no: 1, kind: '步骤替换', quote: invented },
        { claim_no: 1, kind: '数值上下界', quote: '   ' },
      ],
    })

    expect(result.status).toBe('failed')
    expect(result.entries).toEqual([
      { claim_no: 1, kind: '结构等同', embodiment_index: 2, quote: STRUCTURAL.replace('，', ',') },
    ])
    expect(result.gaps).toEqual([
      { claim_no: 1, kind: '步骤替换', reason: 'anchor-not-found' },
      { claim_no: 1, kind: '数值上下界', reason: 'empty' },
    ])
    expect(result.indexText).not.toContain(invented)
    expect(result.indexText).toContain(STRUCTURAL.replace('，', ','))
  })

  it('does not require the three alternatives on a dependent claim', () => {
    const source = [
      '权利要求1 结构等同：' + STRUCTURAL,
      '权利要求1 步骤替换：' + STEP,
      '权利要求1 数值上下界：' + BOUNDS,
      '权利要求2 结构等同：从权不要求另两条。',
    ].join('\n')
    const result = buildAmendmentReserve({ sourceText: source, claimsText: CLAIMS })
    expect(result.status).toBe('passed')
    expect(result.entries).toEqual([
      { claim_no: 1, kind: '结构等同', quote: STRUCTURAL },
      { claim_no: 1, kind: '步骤替换', quote: STEP },
      { claim_no: 1, kind: '数值上下界', quote: BOUNDS },
    ])
    expect(result.indexText).not.toContain('从权不要求另两条')
  })

  it('leaves the check unassessed when the claims have no numbers', () => {
    const result = buildAmendmentReserve({
      sourceText: `结构等同：${STRUCTURAL}`,
      claimsText: '一种壳体。',
    })
    expect(result).toMatchObject({ status: 'not-assessed', entries: [], gaps: [], indexText: '' })
  })

  it('records an empty labeled line and omits an embodiment number when none contains the quote', () => {
    const source = [
      '权利要求1',
      '结构等同：',
      `步骤替换：${STEP}`,
      `数值上下界：${BOUNDS}`,
    ].join('\n')
    const result = buildAmendmentReserve({ sourceText: source, claimsText: CLAIMS })
    expect(result.gaps).toContainEqual({ claim_no: 1, kind: '结构等同', reason: 'empty' })
    expect(result.entries.find(entry => entry.kind === '步骤替换')?.embodiment_index).toBeUndefined()
    expect(result.indexText).toContain(`权利要求1｜步骤替换｜${STEP}`)
  })

  it('checks every independent claim', () => {
    const claims = [
      '1. 一种壳体，其特征在于，包括铝合金壳体。',
      '2. 一种涂装方法，其特征在于，先焊接再固定。',
    ].join('\n')
    const source = [
      `权利要求1 结构等同：${STRUCTURAL}`,
      `权利要求1 步骤替换：${STEP}`,
      `权利要求1 数值上下界：${BOUNDS}`,
    ].join('\n')
    const result = buildAmendmentReserve({ sourceText: source, claimsText: claims })
    expect(result.status).toBe('failed')
    expect(result.gaps).toEqual([
      { claim_no: 2, kind: '结构等同', reason: 'missing' },
      { claim_no: 2, kind: '步骤替换', reason: 'missing' },
      { claim_no: 2, kind: '数值上下界', reason: 'missing' },
    ])
  })

  it('ignores a kind line written before any claim heading and keeps the first repeat', () => {
    const source = [
      '结构等同：不应记到权1的另一句。',
      '权利要求1',
      `结构等同：${STRUCTURAL}`,
      '结构等同：后写的一句不采用。',
      `步骤替换：${STEP}`,
      `数值上下界：${BOUNDS}`,
    ].join('\n')
    const result = buildAmendmentReserve({ sourceText: source, claimsText: CLAIMS })
    expect(result.status).toBe('passed')
    expect(result.entries.find(entry => entry.kind === '结构等同')?.quote).toBe(STRUCTURAL)
    expect(result.indexText).not.toContain('不应记到权1的另一句')
    expect(result.indexText).not.toContain('后写的一句不采用')
  })

  it('leaves the check unassessed when every numbered claim is dependent', () => {
    const result = buildAmendmentReserve({
      sourceText: `权利要求2 结构等同：${STRUCTURAL}`,
      claimsText: '2. 根据权利要求1所述的壳体，其特征在于，包括螺栓。',
    })
    expect(result.status).toBe('not-assessed')
    expect(result.indexText).not.toContain(STRUCTURAL)
  })

  it('names an empty label and an unlocated quote without writing a replacement', () => {
    const report = renderAmendmentReserveReport({
      status: 'failed',
      entries: [],
      gaps: [
        { claim_no: 1, kind: '结构等同', reason: 'empty' },
        { claim_no: 1, kind: '步骤替换', reason: 'anchor-not-found' },
      ],
      indexText: '',
    })
    expect(report).toBe([
      '33 条替代实施方式：未通过',
      '权利要求1 结构等同：标签后没有可定位的正文',
      '权利要求1 步骤替换：摘录未命中交底原文',
    ].join('\n'))
  })
})

describe('draftSpecification amendment reserve', () => {
  const source = [
    '权利要求1',
    `结构等同：${STRUCTURAL}`,
    `步骤替换：${STEP}`,
    `实施例2：${STRUCTURAL}`,
  ].join('\n')

  it('writes located alternatives into the embodiment section and does not invent the missing one', () => {
    const out = draftSpecification({
      title: '壳体',
      technical_solution: source,
      source_text: source,
      claims: CLAIMS,
    })
    const section = out.sections.find(item => item.name === '具体实施方式')
    expect(section?.content).toContain('实施例索引')
    expect(section?.content).toContain(`权利要求1｜结构等同｜实施例2｜${STRUCTURAL}`)
    expect(section?.content).toContain(STEP)
    expect(section?.content).not.toContain('80℃')
    expect(out.amendment_reserve.status).toBe('failed')
    expect(out.warnings).toContain('权利要求1的数值上下界未在交底原文中定位')
    expect(renderDraftSpecification(out)).not.toContain('80℃')
  })

  it('leaves the draft unchanged when claims are absent', () => {
    const out = draftSpecification({ title: '壳体', technical_solution: source, source_text: source })
    expect(out.amendment_reserve.status).toBe('not-assessed')
    expect(out.sections.find(item => item.name === '具体实施方式')?.content).not.toContain('实施例索引')
    expect(out.warnings.some(warning => warning.includes('替代'))).toBe(false)
  })
})

describe('DraftSpecificationHandler amendment reserve', () => {
  it('records the gap for review and does not rewrite a missing alternative', async () => {
    const source = [
      '权利要求1',
      `结构等同：${STRUCTURAL}`,
      `步骤替换：${STEP}`,
    ].join('\n')
    const out = await new DraftSpecificationHandler().execute({
      state: { title: '壳体', source_text: source, claims_draft: CLAIMS },
    })
    expect(out['amendment_reserve_passed']).toBe(false)
    expect(String(out['specification'])).not.toContain('80℃')
    expect(String(out['amendment_reserve_report'])).toContain('权利要求1 数值上下界：交底原文没有这条替代')
    expect(out['amendment_reserve_gaps']).toEqual([
      { claim_no: 1, kind: '数值上下界', reason: 'missing' },
    ])
  })

  it('omits the boolean when the claims cannot be parsed', async () => {
    const out = await new DraftSpecificationHandler().execute({
      state: { title: '壳体', source_text: '一种壳体。' },
    })
    expect(out['amendment_reserve_passed']).toBeUndefined()
    expect(String(out['amendment_reserve_report'])).toContain('未执行')
  })

  it('records a pass when every independent claim locates three alternatives', async () => {
    const source = [
      '权利要求1',
      `结构等同：${STRUCTURAL}`,
      `步骤替换：${STEP}`,
      `数值上下界：${BOUNDS}`,
      `实施例2：${STRUCTURAL}`,
    ].join('\n')
    const out = await new DraftSpecificationHandler().execute({
      state: { title: '壳体', source_text: source, claims_draft: CLAIMS },
    })
    expect(out['amendment_reserve_passed']).toBe(true)
    expect(String(out['amendment_reserve_report'])).toContain('33 条替代实施方式：通过')
    expect(String(out['amendment_reserve_report'])).toContain(`权利要求1｜数值上下界｜${BOUNDS}`)
    expect(out['amendment_reserve_gaps']).toEqual([])
    expect(String(out['specification'])).toContain('实施例索引')
    expect(String(out['specification'])).not.toContain('还可以采用其他等效结构')
  })
})
