import { describe, expect, it } from 'vitest'
import {
  findAntecedentGaps,
  lintClaimText,
  lintClaimText as lintFromPackageRoot,
  parseClaimDocument,
  referencedTerms,
  type ClaimLintReport,
} from '@deepseek-ai/dsh-patent-core'

/** 按权项号与规则排序的摘要，规避同一项内规则执行顺序对断言的影响。 */
function summary(report: ClaimLintReport): Array<[string, number | null, string]> {
  return report.findings
    .map(entry => [entry.rule, entry.claim, entry.severity] as [string, number | null, string])
    .sort((left, right) => (left[1] ?? 0) - (right[1] ?? 0) || left[0].localeCompare(right[0]))
}

/** 取某条规则的全部发现。 */
function findingsOf(report: ClaimLintReport, rule: string) {
  return report.findings.filter(entry => entry.rule === rule)
}

// 案卷 CN2026-KN-001 的权利要求正文（与 04-撰写/CN2026-KN-001_权利要求书.md 逐字一致）。
const CASE_CLAIMS = `1. 一种转子，包括转子铁芯和永磁体，所述转子铁芯的周向上均布有沿轴向延伸的磁钢槽，每只所述磁钢槽内设有一只所述永磁体，相邻两只所述磁钢槽内的永磁体构成一对，同一对中的两只所述永磁体的同名磁极相对，相邻两只所述磁钢槽之间的铁芯部分构成极靴，所述极靴的径向外表面构成所述转子铁芯外圆的一部分，其特征在于，所述极靴的径向外表面包括位于周向中央的中央段和位于该中央段周向两侧的侧段，所述中央段的外径大于所述侧段的外径；所述极靴内设有一对隔磁槽，该一对隔磁槽分别自两个所述侧段向所述极靴的内部延伸。
2. 根据权利要求 1 所述的转子，其特征在于，所述磁钢槽的径向外端与所述转子铁芯的外圆之间设有隔磁桥，所述隔磁桥为所述磁钢槽的径向外端与所述转子铁芯的外圆之间的铁芯部分，所述隔磁桥的径向厚度小于所述极靴的周向宽度，且小于所述永磁体沿其充磁方向的厚度。
3. 根据权利要求 1 所述的转子，其特征在于，所述磁钢槽在其径向外端设有扩宽部，所述极靴在其径向外表面处的周向宽度小于所述磁钢槽在其径向外端处的周向宽度。
4. 根据权利要求 1 所述的转子，其特征在于，所述磁钢槽的槽壁与所述永磁体之间设有嵌入该二者之间的块体，所述块体与所述槽壁及所述永磁体均贴合。
5. 根据权利要求 1 所述的转子，其特征在于，所述一对隔磁槽相对于所述极靴的周向中心线对称设置。
6. 根据权利要求 4 所述的转子，其特征在于，与所述块体相贴合的部分所述磁钢槽的槽壁为平面，所述块体为与该平面贴合的平板状。
7. 根据权利要求 1 所述的转子，其特征在于，所述永磁体的轴向两端分别设有限位件，所述限位件与所述永磁体的端面抵接。
8. 根据权利要求 1 所述的转子，其特征在于，所述转子铁芯包括沿轴向层叠的多个冲片。
9. 一种电机，包括定子和转子，其特征在于，所述转子为权利要求 1 所述的转子。
10. 根据权利要求 9 所述的电机，其特征在于，所述定子的内圆为圆形，所述气隙沿径向的尺寸的变化由所述极靴的径向外表面产生。`

describe('lintClaimText: 案卷 CN2026-KN-001', () => {
  const report = lintClaimText(CASE_CLAIMS)

  it('解析出 10 项权利要求，独权为权 1 与权 9', () => {
    expect(report.claims).toHaveLength(10)
    expect(report.claims.filter(claim => claim.independent).map(claim => claim.number)).toEqual([1, 9])
  })

  it('只报出三处：权 1 复合术语、权 10 缺引用基础与功能性限定', () => {
    expect(summary(report)).toEqual([
      ['antecedent-basis', 1, 'warning'],
      ['antecedent-basis', 10, 'error'],
      ['functional-limitation', 10, 'warning'],
    ])
  })

  it('权 10 的「气隙」缺在先引入，且被判定为阻断级', () => {
    const gap = findingsOf(report, 'antecedent-basis').find(entry => entry.claim === 10)
    expect(gap?.message).toContain('气隙')
    expect(report.passed).toBe(false)
    expect(report.errorCount).toBe(1)
    expect(report.warningCount).toBe(2)
  })

  it('权 9 经交叉引用接上权 1，故「极靴」不报缺引用基础', () => {
    expect(findingsOf(report, 'antecedent-basis').map(entry => entry.claim)).not.toContain(9)
  })
})

describe('parseClaimDocument', () => {
  it('拼接折行、跳过空行，并按顿号/句点切分项号', () => {
    const document = parseClaimDocument('1、一种装置，包括\n壳体，\n\n其特征在于，\n2．根据权利要求 1 所述的装置。')
    expect(document.claims.map(claim => claim.text)).toEqual([
      '一种装置，包括壳体，其特征在于，',
      '根据权利要求 1 所述的装置。',
    ])
    expect(document.claims.map(claim => claim.number)).toEqual([1, 2])
  })

  it('项内的编号列表不会被当成新的一项', () => {
    const document = parseClaimDocument('1. 一种装置，包括：\n1）壳体；\n（2）转轴。')
    expect(document.claims).toHaveLength(1)
    expect(document.extraneous).toEqual([])
  })

  it('标题、引用块、表格、分隔线、加粗分隔与图片行归入正文之外', () => {
    const document = parseClaimDocument(
      '# 权利要求书\n> 说明\n| a | b |\n---\n***\n![图](x.png)\n1. 一种装置。',
    )
    expect(document.claims).toHaveLength(1)
    expect(document.extraneous.map(entry => entry.line)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('权利要求之后出现的普通段落同样归入正文之外', () => {
    const document = parseClaimDocument('1. 一种装置。\n\n## 对照表\n新权 2 引自权 1。')
    expect(document.claims).toHaveLength(1)
    expect(document.extraneous.map(entry => entry.text)).toEqual(['## 对照表', '新权 2 引自权 1。'])
  })

  it('择一限定的区间引用仍按从属权项解析', () => {
    const document = parseClaimDocument([
      '1. 一种装置。',
      '2. 一种装置。',
      '3. 一种装置。',
      '4. 根据权利要求 1 至 3 中任一项所述的装置，其特征在于，还包括壳体。',
      '5. 根据权利要求 1 或 2 中任意一项所述的装置，其特征在于，还包括壳体。',
      '6. 根据权利要求 1 至 3 之一所述的装置，其特征在于，还包括壳体。',
      '7. 根据权利要求 1 至 3 中任一权利要求所述的装置，其特征在于，还包括壳体。',
    ].join('\n'))
    expect(document.claims.map(claim => claim.references))
      .toEqual([[], [], [], [1, 2, 3], [1, 2], [1, 2, 3], [1, 2, 3]])
    expect(document.claims[3]?.independent).toBe(false)
    expect(document.claims[3]?.subject).toBe('装置')
  })

  it('跨度异常的引用区间不展开，只保留端点', () => {
    const document = parseClaimDocument(
      '1. 一种装置。\n2. 根据权利要求 1 至 999999999 所述的装置，其特征在于，还包括壳体。',
    )
    expect(document.claims[1]?.references).toEqual([1, 999999999])
  })

  it('识别区间、顿号、全角数字与「或」并列的引用号', () => {
    const document = parseClaimDocument(
      '1. 一种装置。\n2. 一种装置。\n3. 一种装置。\n4. 根据权利要求 1 至 ３ 所述的装置。\n5. 根据权利要求 2、4 所述的装置。',
    )
    expect(document.claims[3]?.references).toEqual([1, 2, 3])
    expect(document.claims[4]?.references).toEqual([2, 4])
  })

  it('交叉引用去重升序，排除自指与本项已引用的权项', () => {
    const [crossed] = parseClaimDocument(
      '9. 一种电机，所述转子为权利要求 ３ 所述的转子，所述定子为权利要求 1 所述的定子，本项即权利要求 9 所述。',
    ).claims
    expect(crossed?.crossReferences).toEqual([1, 3])
    const [dependent] = parseClaimDocument(
      '1. 一种装置。\n2. 根据权利要求 1 所述的装置，其特征在于，所述壳体同权利要求 1 所述的壳体。',
    ).claims.slice(1)
    expect(dependent?.crossReferences).toEqual([])
  })

  it('正文中的交叉引用与引用部分的引用分开记录', () => {
    const [claim] = parseClaimDocument('9. 一种电机，所述转子为权利要求 1 所述的转子。').claims
    expect(claim?.independent).toBe(true)
    expect(claim?.references).toEqual([])
    expect(claim?.crossReferences).toEqual([1])
  })

  it('主题名称：从权取自「所述」，独权取自「一种」', () => {
    const document = parseClaimDocument('1. 一种磁隙致密转子，包括铁芯。\n2. 根据权利要求 1 所述的转子，其特征在于，还包括永磁体。')
    expect(document.claims[0]?.subject).toBe('磁隙致密转子')
    expect(document.claims[1]?.subject).toBe('转子')
  })

  it('独权不以「一种」开头时主题名称为空串', () => {
    const [claim] = parseClaimDocument('1. 转子，包括铁芯。').claims
    expect(claim?.subject).toBe('')
  })
})

describe('referencedTerms', () => {
  it('按虚词截断取被指代术语', () => {
    expect(referencedTerms('所述极靴的径向外表面与所述气隙沿径向的尺寸').map(entry => entry.term))
      .toEqual(['极靴', '气隙'])
  })

  it('跳过「所述的」这类短于两字的残段', () => {
    expect(referencedTerms('根据权利要求 1 所述的转子')).toEqual([])
  })

  it('术语长度封顶为 8 字', () => {
    expect(referencedTerms('所述铁磁钢槽壁板平直段')[0]?.term).toBe('铁磁钢槽壁板平直')
  })
})

describe('findAntecedentGaps', () => {
  it('组成部分已引入的复合术语降为 warning', () => {
    const gaps = findAntecedentGaps('所述转子铁芯外圆的一部分。', '包括转子铁芯和永磁体。')
    expect(gaps).toEqual([{
      term: '转子铁芯外圆',
      evidence: '所述转子铁芯外圆的一部分。',
      severity: 'warning',
      message: '「所述转子铁芯外圆」的整体术语没有在先引入，其中「转子铁芯」已引入；建议写成「所述转子铁芯的…」以明确指代的整体。',
    }])
  })

  it('既无整体也无组成部分时判 error，且同一术语只报一次', () => {
    const gaps = findAntecedentGaps('所述气隙沿径向的尺寸与所述气隙的宽度。', '')
    expect(gaps).toHaveLength(1)
    expect(gaps[0]?.severity).toBe('error')
  })

  it('前文已引入的术语不报', () => {
    expect(findAntecedentGaps('所述气隙沿径向变化。', '')).toHaveLength(1)
    expect(findAntecedentGaps('设有气隙，所述气隙沿径向变化。', '')).toEqual([])
  })
})

describe('lintClaimText: 结构性规则', () => {
  it('编号断裂报 numbering', () => {
    const report = lintClaimText('1. 一种装置。\n3. 一种装置。')
    expect(findingsOf(report, 'numbering').map(entry => entry.claim)).toEqual([3])
  })

  it('引用不存在的权项报 reference-direction', () => {
    const report = lintClaimText('1. 一种装置。\n2. 根据权利要求 5 所述的装置，其特征在于，还包括壳体。')
    expect(findingsOf(report, 'reference-direction')[0]?.message).toContain('不存在的权利要求 5')
  })

  it('引用在后的权项报 reference-direction', () => {
    const report = lintClaimText('1. 根据权利要求 2 所述的装置，其特征在于，还包括壳体。\n2. 一种装置。')
    expect(findingsOf(report, 'reference-direction').map(entry => entry.message).join())
      .toContain('在后的权利要求 2')
  })

  it('多项从属用「和」并列、或引用另一项多项从属时报 multiple-dependent', () => {
    const report = lintClaimText([
      '1. 一种装置。',
      '2. 一种装置。',
      '3. 根据权利要求 1 和 2 所述的装置，其特征在于，还包括壳体。',
      '4. 根据权利要求 1 或 2 所述的装置，其特征在于，还包括壳体。',
      '5. 根据权利要求 4 所述的装置，其特征在于，还包括转轴。',
    ].join('\n'))
    const messages = findingsOf(report, 'multiple-dependent').map(entry => entry.claim)
    expect(messages).toEqual([3, 5])
  })

  it('择一引用接上引用链，不误报引用基础', () => {
    const report = lintClaimText([
      '1. 一种转子，包括转子铁芯和永磁体，所述转子铁芯设有磁钢槽，其特征在于，所述磁钢槽内设有所述永磁体。',
      '2. 根据权利要求 1 所述的转子，其特征在于，所述磁钢槽的槽壁为平面。',
      '3. 根据权利要求 2 所述的转子，其特征在于，所述槽壁设有隔磁桥。',
      '4. 根据权利要求 1 至 3 中任一项所述的转子，其特征在于，所述永磁体为钕铁硼。',
    ].join('\n'))
    expect(findingsOf(report, 'antecedent-basis')).toEqual([])
    expect(report.passed).toBe(true)
  })

  it('引用链上重复出现的权项只拼接一次', () => {
    const report = lintClaimText([
      '1. 一种装置，包括壳体。',
      '2. 根据权利要求 1 所述的装置，其特征在于，所述壳体为方形。',
      '3. 根据权利要求 1 或 2 所述的装置，其特征在于，所述壳体为圆形。',
    ].join('\n'))
    expect(report.claims[2]?.references).toEqual([1, 2])
    expect(findingsOf(report, 'antecedent-basis')).toEqual([])
  })

  it('主题名称与被引用权项不一致时报 subject-consistency（包含关系为 warning）', () => {
    const report = lintClaimText([
      '1. 一种磁隙致密转子，包括铁芯。',
      '2. 根据权利要求 1 所述的转子，其特征在于，还包括永磁体。',
      '3. 根据权利要求 1 所述的定子，其特征在于，还包括绕组。',
    ].join('\n'))
    const findings = findingsOf(report, 'subject-consistency')
    expect(findings.map(entry => [entry.claim, entry.severity])).toEqual([[2, 'warning'], [3, 'error']])
  })

  it('从权缺少引导词报 warning，限定部分为空报 error', () => {
    const report = lintClaimText([
      '1. 一种装置。',
      '2. 根据权利要求 1 所述的装置，所述壳体为方形。',
      '3. 根据权利要求 1 所述的装置，其特征在于，。',
    ].join('\n'))
    const findings = findingsOf(report, 'dependent-limitation')
    expect(findings.map(entry => [entry.claim, entry.severity])).toEqual([[2, 'warning'], [3, 'error']])
  })

  it('独权的两部分式缺省与重复分别为 warning', () => {
    const report = lintClaimText('1. 一种装置，包括壳体。\n2. 一种装置，其特征在于，包括壳体，其特征在于，包括转轴。')
    expect(findingsOf(report, 'two-part-form').map(entry => [entry.claim, entry.message.includes('2 处')]))
      .toEqual([[1, false], [2, true]])
  })

  it('句号缺失、重复、或不在结尾时报 terminator', () => {
    const report = lintClaimText('1. 一种装置\n2. 一种装置。还包括壳体。\n3. 一种装置。壳体；')
    const messages = findingsOf(report, 'terminator').map(entry => entry.message)
    expect(messages[0]).toContain('没有以句号结尾')
    expect(messages[1]).toContain('2 个句号')
    expect(messages[2]).toContain('项内而非结尾')
  })

  it('引用说明书或附图报 external-reference', () => {
    const report = lintClaimText('1. 一种装置，其特征在于，如说明书第 3 段所述，壳体为方形。')
    expect(findingsOf(report, 'external-reference')[0]?.severity).toBe('error')
    expect(findingsOf(lintClaimText('1. 一种装置，其特征在于，如图 2 所示，壳体为方形。'), 'external-reference'))
      .toHaveLength(1)
  })
})

describe('lintClaimText: 用语规则', () => {
  it('功能性限定逐类命中', () => {
    expect(findingsOf(lintClaimText('1. 一种装置，其特征在于，所述盖件用于封闭所述壳体。'), 'functional-limitation'))
      .toHaveLength(1)
    expect(findingsOf(lintClaimText('1. 一种装置，其特征在于，所述间隙的变化由所述凸起产生。'), 'functional-limitation'))
      .toHaveLength(1)
    expect(findingsOf(lintClaimText('1. 一种装置，其特征在于，设有凸起，以便增大摩擦。'), 'functional-limitation'))
      .toHaveLength(1)
    expect(findingsOf(lintClaimText('1. 一种装置，其特征在于，设有凸起，能够提高摩擦。'), 'functional-limitation'))
      .toHaveLength(1)
    expect(findingsOf(lintClaimText('1. 一种装置，其特征在于，设有凸起，起到增大摩擦的作用。'), 'functional-limitation'))
      .toHaveLength(1)
  })

  it('前序部分的「用于」不算功能性限定', () => {
    expect(findingsOf(lintClaimText('1. 一种用于封闭壳体的盖件，包括本体。'), 'functional-limitation')).toEqual([])
  })

  it('工艺方法特征报 process-feature，「层叠」不报', () => {
    expect(findingsOf(lintClaimText('1. 一种装置，其特征在于，所述壳体由冲压制成。'), 'process-feature')).toHaveLength(1)
    expect(findingsOf(lintClaimText('1. 一种装置，其特征在于，所述铁芯包括沿轴向层叠的冲片。'), 'process-feature')).toEqual([])
  })

  it('方法权要列举步骤而未声明顺序时报 step-order', () => {
    const ambiguous = '1. 一种螺栓的制造方法，其特征在于，包括步骤：热镦粗、搓丝。'
    const found = findingsOf(lintClaimText(ambiguous), 'step-order')
    expect(found).toHaveLength(1)
    expect(found[0]?.severity).toBe('warning')
    expect(found[0]?.basis).toContain('第二十六条第四款')
  })

  it('已声明顺序、产品权要或未列举步骤时不报 step-order', () => {
    expect(findingsOf(lintClaimText('1. 一种制造方法，其特征在于，依次包括步骤：热镦粗、搓丝。'), 'step-order')).toEqual([])
    expect(findingsOf(lintClaimText('1. 一种制造方法，其特征在于，包括步骤，步骤顺序不限：热镦粗、搓丝。'), 'step-order')).toEqual([])
    expect(findingsOf(lintClaimText('1. 一种螺栓，其特征在于，包括步骤式装配的螺栓本体。'), 'step-order')).toEqual([])
    expect(findingsOf(lintClaimText('1. 一种螺栓的制造方法，其特征在于，热镦粗后搓丝。'), 'step-order')).toEqual([])
    // 从属项的主题读作「所述方法」，重复的是独权主题：顺序声明只在独权里作出。
    expect(findingsOf(lintClaimText([
      '1. 一种制造方法，其特征在于，依次包括步骤：热镦粗、搓丝。',
      '2. 根据权利要求 1 所述的方法，其特征在于，包括步骤：清洗、烘干。',
    ].join('\n')), 'step-order')).toEqual([])
  })

  it('不产生技术效果的内容与商业宣传用语分别命中', () => {
    expect(findingsOf(lintClaimText('1. 一种装置，其特征在于，所述外壳设有商标。'), 'non-technical-feature')).toHaveLength(1)
    expect(findingsOf(lintClaimText('1. 一种装置，其特征在于，所述外壳为国内首创的结构。'), 'commercial-language'))
      .toHaveLength(1)
  })
})

describe('lintClaimText: 文档级规则', () => {
  it('正文之外的内容报 non-claim-content', () => {
    const report = lintClaimText('# 权利要求书\n1. 一种装置。\n## 对照表')
    const findings = findingsOf(report, 'non-claim-content')
    expect(findings[0]?.claim).toBeNull()
    expect(findings[0]?.severity).toBe('error')
    expect(findings[0]?.message).toContain('2 行')
  })

  it('超出项数上限报 claim-count，未给出上限时不检查', () => {
    const text = '1. 一种装置。\n2. 一种装置。'
    expect(findingsOf(lintClaimText(text, { maxClaims: 1 }), 'claim-count')[0]?.severity).toBe('warning')
    expect(findingsOf(lintClaimText(text), 'claim-count')).toEqual([])
  })
})

describe('导出面', () => {
  it('报告中的权项与单独解析的结果一致', () => {
    expect(lintFromPackageRoot(CASE_CLAIMS).claims).toEqual(parseClaimDocument(CASE_CLAIMS).claims)
  })

  it('每条发现都带法条依据', () => {
    expect(lintClaimText(CASE_CLAIMS).findings.every(entry => entry.basis.length > 0)).toBe(true)
  })
})
