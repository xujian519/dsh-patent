import { describe, expect, it } from 'vitest'
import { checkChemicalClaimSubjectMatter, checkChemicalDisclosure } from '../src/tool/spec-chemical.ts'

/** Wrap a claim body as claim 1. */
function claim(body: string): string {
  return `1. ${body}`
}

/** The rule ids a violation list reports. */
function rulesOf(violations: Array<{ rule: string }>): string[] {
  return violations.map(violation => violation.rule)
}

describe('checkChemicalClaimSubjectMatter', () => {
  it('非化学域、缺权项与空白权项都不检查', () => {
    expect(checkChemicalClaimSubjectMatter(claim('一种药物组合物'), 'software')).toEqual([])
    expect(checkChemicalClaimSubjectMatter(undefined, 'chemical')).toEqual([])
    expect(checkChemicalClaimSubjectMatter('   ', 'chemical')).toEqual([])
  })

  it('治疗/诊断方法主题报 error', () => {
    const violations = checkChemicalClaimSubjectMatter(claim('一种治疗糖尿病的方法，其特征在于，向患者给予化合物 A。'), 'chemical')
    expect(rulesOf(violations)).toEqual(['chem_medical_use_method'])
    expect(violations[0]?.severity).toBe('error')
    expect(violations[0]?.message).toContain('第二十五条第一款第三项')
  })

  it('用途权项未写成制备药物用途时报 warning，Swiss 型不报', () => {
    const bare = checkChemicalClaimSubjectMatter(claim('一种化合物 A 在治疗糖尿病中的用途，其特征在于，口服给药。'), 'chemical')
    expect(rulesOf(bare)).toContain('chem_second_use_form')

    const swiss = checkChemicalClaimSubjectMatter(claim('一种化合物 A 在制备治疗糖尿病的药物中的用途，其特征在于，所述药物为片剂。'), 'chemical')
    expect(rulesOf(swiss)).not.toContain('chem_second_use_form')
  })

  it('独立权项中的相对表述报 warning', () => {
    const violations = checkChemicalClaimSubjectMatter(claim('一种催化剂，其特征在于，反应温度为较高的 80 ℃。'), 'chemical')
    expect(rulesOf(violations)).toEqual(['chem_relative_term'])
    expect(violations[0]?.message).toContain('较高')
  })

  it('马库什「任选取代」未限定取代基时报 warning，给出「选自」后不报', () => {
    const undefinedSubstituent = checkChemicalClaimSubjectMatter(claim('一种通式（I）所示的化合物，其特征在于，R1 任选取代。'), 'chemical')
    expect(rulesOf(undefinedSubstituent)).toContain('chem_markush_optional_undefined')

    const defined = checkChemicalClaimSubjectMatter(claim('一种通式（I）所示的化合物，其特征在于，R1 选自氢、C1–C6 烷基。'), 'chemical')
    expect(rulesOf(defined)).not.toContain('chem_markush_optional_undefined')
  })

  it('组合物百分含量上限合计超过 100% 时报 warning', () => {
    const violations = checkChemicalClaimSubjectMatter(claim('一种组合物，其特征在于，包含组分 A 60-80% 和组分 B 30-50%。'), 'chemical')
    expect(rulesOf(violations)).toEqual(['chem_composition_total'])
    expect(violations[0]?.message).toContain('130%')
  })

  it('组合物写明「余量」、只有一个百分数或不是组合物时不报', () => {
    const balance = checkChemicalClaimSubjectMatter(claim('一种组合物，其特征在于，包含组分 A 60-80% 和组分 B 30-50%，余量为辅料。'), 'chemical')
    expect(rulesOf(balance)).not.toContain('chem_composition_total')

    const single = checkChemicalClaimSubjectMatter(claim('一种组合物，其特征在于，包含组分 A 60%。'), 'chemical')
    expect(rulesOf(single)).not.toContain('chem_composition_total')

    const compound = checkChemicalClaimSubjectMatter(claim('一种化合物，其特征在于，包含 60% 的 A 和 50% 的 B。'), 'chemical')
    expect(rulesOf(compound)).not.toContain('chem_composition_total')
  })

  it('药物权项未限定适应症时报 warning，制备方法权项不报', () => {
    const missing = checkChemicalClaimSubjectMatter(claim('一种药物组合物，其特征在于，包含化合物 A 和辅料。'), 'chemical')
    expect(rulesOf(missing)).toContain('chem_indication_missing')

    const preparation = checkChemicalClaimSubjectMatter(claim('一种药物组合物的制备方法，其特征在于，包括混合步骤。'), 'chemical')
    expect(rulesOf(preparation)).not.toContain('chem_indication_missing')
  })
})

describe('checkChemicalDisclosure', () => {
  it('非化学域与空文本都不检查', () => {
    expect(checkChemicalDisclosure('温度为 80，', undefined, 'mechanical')).toEqual([])
    expect(checkChemicalDisclosure('   ', undefined, 'chemical')).toEqual([])
  })

  it('参数缺单位时报 warning，带单位或在范围内时不报', () => {
    const missing = checkChemicalDisclosure('反应温度为 80，反应时间为 2 h。', undefined, 'chemical')
    expect(rulesOf(missing)).toEqual(['chem_unit_missing'])
    expect(missing[0]?.message).toContain('温度为 80')
    expect(missing[0]?.line).toBe(1)

    expect(rulesOf(checkChemicalDisclosure('反应温度为 80 ℃。', undefined, 'chemical'))).toEqual([])
    expect(rulesOf(checkChemicalDisclosure('反应温度为 80-100 ℃。', undefined, 'chemical'))).toEqual([])
  })

  it('至多列出三处缺单位表述', () => {
    const text = '温度为 80，压力为 5，时间为 3，浓度为 20，'
    const violations = checkChemicalDisclosure(text, undefined, 'chemical')
    expect(violations[0]?.message).toContain('温度为 80')
    expect(violations[0]?.message).not.toContain('浓度为 20')
  })

  it('实施例编号重复或断裂时报 warning', () => {
    const duplicate = checkChemicalDisclosure('实施例1：方案甲。实施例1：方案乙。', undefined, 'chemical')
    expect(rulesOf(duplicate)).toEqual(['chem_embodiment_numbering'])
    expect(duplicate[0]?.message).toContain('重复')

    const gap = checkChemicalDisclosure('实施例1：方案甲。实施例3：方案乙。', undefined, 'chemical')
    expect(gap[0]?.message).toContain('缺号：2')

    const chinese = checkChemicalDisclosure('实施例一：方案甲。实施例三：方案乙。', undefined, 'chemical')
    expect(chinese[0]?.message).toContain('缺号：2')

    const sequential = checkChemicalDisclosure('实施例1：方案甲。实施例2：方案乙。', undefined, 'chemical')
    expect(sequential).toEqual([])

    const single = checkChemicalDisclosure('实施例1：方案甲。', undefined, 'chemical')
    expect(single).toEqual([])
  })

  it('中文编号支持十位，无法解析或不在 1–99 的编号不检查', () => {
    const tens = checkChemicalDisclosure('实施例十：方案甲。实施例十二：方案乙。', undefined, 'chemical')
    expect(tens[0]?.message).toContain('缺号：11')

    const twenties = checkChemicalDisclosure('实施例二十：方案甲。实施例二十二：方案乙。', undefined, 'chemical')
    expect(twenties[0]?.message).toContain('缺号：21')

    expect(checkChemicalDisclosure('实施例甲：方案。实施例乙：方案。', undefined, 'chemical')).toEqual([])
    expect(checkChemicalDisclosure('实施例一百：方案。实施例一百零一：方案。', undefined, 'chemical')).toEqual([])
  })

  it('说明书声明任选取代但未限定取代基时报 warning', () => {
    const violations = checkChemicalDisclosure('本发明公开通式（I）化合物，其中 R1 任选取代。', undefined, 'chemical')
    expect(rulesOf(violations)).toEqual(['chem_markush_optional_undefined'])

    expect(checkChemicalDisclosure('本发明公开通式（I）化合物，其中 R1 选自氢、C1–C6 烷基。', undefined, 'chemical')).toEqual([])
    expect(checkChemicalDisclosure('本发明公开一种化合物。', undefined, 'chemical')).toEqual([])
    expect(checkChemicalDisclosure('本发明公开通式（I）化合物。', undefined, 'chemical')).toEqual([])
  })

  it('中药处方缺基源时报 warning，给出拉丁学名后不报', () => {
    const missing = checkChemicalDisclosure('中药处方：黄芪 30 g，当归 15 g。', undefined, 'chemical')
    expect(rulesOf(missing)).toEqual(['chem_herb_source'])

    const sourced = checkChemicalDisclosure('中药处方：黄芪（Astragalus membranaceus）30 g。', undefined, 'chemical')
    expect(sourced).toEqual([])

    expect(checkChemicalDisclosure('处方：黄芪，当归。', undefined, 'chemical')).toEqual([])
    expect(checkChemicalDisclosure('一种化合物 30 g。', undefined, 'chemical')).toEqual([])
  })

  it('生物材料缺保藏信息时报 warning，有保藏编号后不报', () => {
    const missing = checkChemicalDisclosure('本发明使用大肠杆菌菌株。', undefined, 'chemical')
    expect(rulesOf(missing)).toEqual(['chem_biological_deposit'])

    const deposited = checkChemicalDisclosure('本发明使用大肠杆菌菌株，保藏编号 CCTCC NO: C2024123。', undefined, 'chemical')
    expect(deposited).toEqual([])

    expect(checkChemicalDisclosure('一种化合物。', undefined, 'chemical')).toEqual([])
  })

  it('生物材料只出现在权项时也检查', () => {
    const violations = checkChemicalDisclosure('本发明涉及一种发酵方法。', claim('一种工程菌，其特征在于，过表达基因 X。'), 'chemical')
    expect(rulesOf(violations)).toEqual(['chem_biological_deposit'])
  })

  it('主张协同但无对比例时报 warning', () => {
    const missing = checkChemicalDisclosure('两者复配具有协同增效作用。', undefined, 'chemical')
    expect(rulesOf(missing)).toEqual(['chem_comparative_example_missing'])

    expect(checkChemicalDisclosure('两者复配，对比例1显示协同增效作用。', undefined, 'chemical')).toEqual([])
    expect(checkChemicalDisclosure('两者混合使用。', undefined, 'chemical')).toEqual([])
  })
})
