import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { createDomainCheckTool } from '../src/tool/domain-check.ts'
import type { DomainCheckOutput } from '../src/tool/domain-check.ts'

/** 说明书：与下面的权要共用「壳体/矩形/空心」，避免特征覆盖项把结论带偏。 */
const SPEC = [
  '## 技术领域',
  '本发明涉及一种检测装置。',
  '## 背景技术',
  '现有检测装置存在精度不足的问题。',
  '## 发明内容',
  '本发明提供一种高精度检测装置。',
  '## 附图说明',
  '图1是本发明实施例的结构示意图。',
  '## 具体实施方式',
  '实施例1：如图1所示，本实施例提供一种检测装置，所述检测装置包括壳体，所述壳体为矩形，所述壳体为空心。',
].join('\n')

const PRODUCT_CLAIMS = '1. 一种检测装置，包括壳体，其特征在于，所述壳体为矩形。'

const METHOD_CLAIMS = '1. 一种检测装置的制造方法，其特征在于，包括步骤：下料、折弯。'

/**
 * Run the tool with the given arguments.
 * @param args - model-supplied tool arguments.
 * @returns the tool output.
 */
async function run(args: Record<string, unknown>): Promise<DomainCheckOutput> {
  const tool = createDomainCheckTool()
  return await tool.execute(args, {} as never) as DomainCheckOutput
}

/** Count items by status. */
function countBy(items: DomainCheckOutput['items'], status: 'hit' | 'pass' | 'manual'): number {
  return items.filter(item => item.status === status).length
}

/** Find one checklist item. */
function itemOf(value: DomainCheckOutput, id: string): DomainCheckOutput['items'][number] | undefined {
  return value.items.find(item => item.id === id)
}

describe('domain_check: 机械域清单', () => {
  it('列出全部 30 项，并区分已核通过、未自动化与图面未核', async () => {
    const value = await run({ domain: 'mechanical', text: SPEC, claims: PRODUCT_CLAIMS })
    expect(value.items).toHaveLength(30)
    expect(value.passed).toBe(true)
    expect(countBy(value.items, 'hit')).toBe(0)
    // 001/025 需要图面标号数据、021/022/024 需要专利类型，本次未提供 → manual，不得算通过；
    // 002/013/018/030 的规则只覆盖缺陷的一部分，未命中也是 manual。
    expect(countBy(value.items, 'pass')).toBe(5)
    expect(countBy(value.items, 'manual')).toBe(25)
    expect(itemOf(value, 'MECH-DC-001')?.reason).toContain('附图分析结果')
    expect(itemOf(value, 'MECH-DC-021')?.reason).toContain('patent_type')
    // 渲染在无命中时也要给出稳定的段落结构
    const tool: ToolDefinition = createDomainCheckTool()
    const blocks = tool.output.render({}, value) as Array<{ type: string; text?: string }>
    const text = blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
    expect(text).toContain('## 命中（按清单项）\n- 无')
    expect(text).toContain('通过')
  })

  it('提供可用的附图分析结果后图面标号项才算核过；全部不可用时保持 manual', async () => {
    const clean = await run({
      domain: 'mechanical',
      text: SPEC.replace('图1是本发明实施例的结构示意图。', '图1是结构示意图；图中：1-壳体。'),
      claims: PRODUCT_CLAIMS,
      figure_analysis: [{ usable: true, components: [{ refNumber: '1' }] }],
    })
    expect(itemOf(clean, 'MECH-DC-001')?.status).toBe('pass')
    expect(itemOf(clean, 'MECH-DC-025')?.status).toBe('pass')

    const unusable = await run({
      domain: 'mechanical',
      text: SPEC,
      claims: PRODUCT_CLAIMS,
      figure_analysis: [{ usable: false, components: [{ refNumber: '1' }] }],
    })
    // 分析结果全部不可用时没有标号可核：该项留在 manual，同时引擎给出待人工核对的 warning
    expect(itemOf(unusable, 'MECH-DC-001')?.status).toBe('manual')
    expect(itemOf(unusable, 'MECH-DC-001')?.reason).toContain('附图分析结果')
    const finding = unusable.findings.find(entry => entry.rule === 'figure_mark_consistency')
    expect(finding?.detail).toBeUndefined()
  })

  it('权利要求书正文之外的发现按权利要求书全文标注', async () => {
    const claims = '# 权利要求书\n1. 一种检测装置，其特征在于，包括壳体。\n## 对照表'
    const value = await run({ domain: 'mechanical', text: SPEC, claims })
    const finding = value.findings.find(entry => entry.rule === 'non-claim-content')
    expect(finding?.source).toBe('claim_lint')
    expect(finding?.message).toContain('权利要求书：')
  })

  it('实用新型 + 方法权要命中 MECH-DC-021 并判定未通过', async () => {
    const value = await run({ domain: 'mechanical', text: SPEC, claims: METHOD_CLAIMS, patent_type: 'utility_model' })
    expect(itemOf(value, 'MECH-DC-021')?.status).toBe('hit')
    expect(value.passed).toBe(false)
    expect(value.error_count).toBeGreaterThan(0)
    // 该检查由 validate_specification 的 claims 规则族产出，故来源是 specification
    expect(value.findings.find(finding => finding.rule === 'utility_model_method_claim')?.source).toBe('specification')
  })

  it('未提供 claims 时权项相关项报 manual 并给出原因', async () => {
    const value = await run({ domain: 'mechanical', text: SPEC })
    expect(itemOf(value, 'MECH-DC-009')?.status).toBe('manual')
    expect(itemOf(value, 'MECH-DC-009')?.reason).toContain('未提供 claims')
    // 专利类型缺失时实用新型附图规则不运行，该项必须留在 manual
    expect(itemOf(value, 'MECH-DC-024')?.status).toBe('manual')
    expect(itemOf(value, 'MECH-DC-024')?.reason).toContain('patent_type')
  })

  it('附图分析结果为空数组（分析被跳过）时图面项不判通过', async () => {
    const value = await run({ domain: 'mechanical', text: SPEC, claims: PRODUCT_CLAIMS, figure_analysis: [] })
    expect(itemOf(value, 'MECH-DC-001')?.status).toBe('manual')
    expect(itemOf(value, 'MECH-DC-001')?.reason).toContain('空数组')
    expect(itemOf(value, 'MECH-DC-025')?.status).toBe('manual')
  })

  it('可用但缺组件列表的分析结果按不可用处理，不抛错', async () => {
    const value = await run({ domain: 'mechanical', text: SPEC, claims: PRODUCT_CLAIMS, figure_analysis: [{ usable: true }] })
    expect(itemOf(value, 'MECH-DC-001')?.status).toBe('hit')
    expect(value.findings.find(finding => finding.rule === 'figure_mark_consistency')?.message).toContain('不完整')
  })

  it('声明专利类型后实用新型客体项可核，缺附图项仍因只覆盖一部分保留为 manual', async () => {
    const value = await run({ domain: 'mechanical', text: SPEC, claims: PRODUCT_CLAIMS, patent_type: 'invention' })
    expect(itemOf(value, 'MECH-DC-021')?.status).toBe('pass')
    expect(itemOf(value, 'MECH-DC-022')?.status).toBe('pass')
    expect(itemOf(value, 'MECH-DC-024')?.status).toBe('manual')
    expect(itemOf(value, 'MECH-DC-024')?.reason).toContain('不能据此判定通过')
    expect(countBy(value.items, 'pass')).toBe(7)
    expect(countBy(value.items, 'manual')).toBe(23)
  })

  it('多项从属同时命中 009 与 010', async () => {
    const claims = [
      '1. 一种检测装置，其特征在于，包括壳体。',
      '2. 根据权利要求 1 所述的检测装置，其特征在于，所述壳体为矩形。',
      '3. 根据权利要求 1 和 2 所述的检测装置，其特征在于，所述壳体为空心。',
    ].join('\n')
    const value = await run({ domain: 'mechanical', text: SPEC, claims })
    expect(itemOf(value, 'MECH-DC-009')?.status).toBe('hit')
    expect(itemOf(value, 'MECH-DC-010')?.status).toBe('hit')
  })

  it('不支持的领域与空文本直接报错', async () => {
    const tool = createDomainCheckTool()
    await expect(tool.execute({ domain: 'electrical', text: SPEC }, {} as never)).rejects.toThrow(/domain.*must be one of/)
    await expect(tool.execute({ domain: 'mechanical', text: '  ' }, {} as never)).rejects.toThrow(/text 为空/)
  })
})

describe('domain_check: 模型可见渲染', () => {
  it('渲染概览、命中项与未自动化项', async () => {
    const value = await run({ domain: 'mechanical', text: SPEC, claims: METHOD_CLAIMS, patent_type: 'utility_model' })
    const tool: ToolDefinition = createDomainCheckTool()
    const blocks = tool.output.render({}, value) as Array<{ type: string; text?: string }>
    const text = blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
    expect(text).toContain('domain_check: mechanical 域缺陷清单 30 项')
    expect(text).toContain('## 命中（按清单项）')
    expect(text).toContain('MECH-DC-021')
    expect(text).toContain('## 未自动化（须人工判断，不得视为通过）')
    expect(text).toContain('未通过')
  })

  it('未归入清单项的命中单独成段，而不是只进计数', async () => {
    const claims = '# 权利要求书\n1. 一种检测装置，其特征在于，包括壳体。'
    const value = await run({ domain: 'mechanical', text: SPEC, claims })
    const tool: ToolDefinition = createDomainCheckTool()
    const blocks = tool.output.render({}, value) as Array<{ type: string; text?: string }>
    const text = blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
    const finding = value.findings.find(entry => entry.rule === 'non-claim-content')
    expect(finding).toBeDefined()
    expect(text).toContain('## 其他命中（未归入清单项）')
    expect(text).toContain(`- [${finding?.severity}] ${finding?.message}`)
  })
})

/** 软件域说明书：客体与技术载体齐备。 */
const SOFTWARE_SPEC = [
  '## 技术领域',
  '本发明涉及图像识别。',
  '## 背景技术',
  '现有图像识别方法的准确率不足。',
  '## 发明内容',
  '本发明提供一种图像识别方法。',
  '## 附图说明',
  '图1是本发明实施例的流程图。',
  '## 具体实施方式',
  '实施例1：如图1所示，使用卷积神经网络的特征提取层提取图像特征，训练集与验证集按 8:1 划分。',
].join('\n')

/** 已结合技术领域的软件方法权要。 */
const SOFTWARE_CLAIMS = '1. 一种图像识别方法，其特征在于，包括：获取待识别图像；将所述图像输入预训练的卷积神经网络；输出识别结果。'

describe('domain_check: 软件域清单', () => {
  it('列出全部 28 项，客体项按 tech_domain=software 运行', async () => {
    const value = await run({ domain: 'software', text: SOFTWARE_SPEC, claims: SOFTWARE_CLAIMS })
    expect(value.items).toHaveLength(28)
    expect(countBy(value.items, 'hit')).toBe(0)
    expect(value.passed).toBe(true)
    // 客体项规则已跑但未命中：状态应为 manual 并说明规则只覆盖一部分
    expect(itemOf(value, 'SOFT-DC-006')?.status).toBe('manual')
    expect(itemOf(value, 'SOFT-DC-006')?.reason).toContain('不能据此判定通过')
    expect(itemOf(value, 'SOFT-DC-013')?.status).toBe('pass')
    expect(itemOf(value, 'SOFT-DC-001')?.status).toBe('manual')
  })

  it('纯算法主题权要命中 SOFT-DC-010 并判定未通过', async () => {
    const claims = '1. 一种反向传播算法，其特征在于，包括：计算输出误差；回传梯度。'
    const value = await run({ domain: 'software', text: SOFTWARE_SPEC, claims })
    expect(itemOf(value, 'SOFT-DC-010')?.status).toBe('hit')
    expect(value.passed).toBe(false)
    expect(value.findings.find(finding => finding.rule === 'software_algorithm_subject')?.severity).toBe('error')
  })

  it('未提供 abstract 时摘要项报 manual，提供后才核', async () => {
    const withoutAbstract = await run({ domain: 'software', text: SOFTWARE_SPEC, claims: SOFTWARE_CLAIMS })
    expect(itemOf(withoutAbstract, 'SOFT-DC-005')?.status).toBe('manual')
    expect(itemOf(withoutAbstract, 'SOFT-DC-005')?.reason).toContain('未提供 abstract')

    const withAbstract = await run({
      domain: 'software',
      text: SOFTWARE_SPEC,
      claims: SOFTWARE_CLAIMS,
      abstract: '本发明涉及图像识别，提供一种图像识别方法，提高了识别准确率。',
    })
    expect(itemOf(withAbstract, 'SOFT-DC-005')?.status).toBe('pass')
  })

  it('软件域不套用机械域清单项', async () => {
    const value = await run({ domain: 'software', text: SOFTWARE_SPEC, claims: SOFTWARE_CLAIMS })
    expect(value.items.some(item => item.id.startsWith('MECH-DC-'))).toBe(false)
  })
})

/** 化学域说明书：表征、单位、实施例编号与适应症齐备。 */
const CHEMICAL_SPEC = [
  '## 技术领域',
  '本发明涉及一种药物组合物。',
  '## 背景技术',
  '现有药物组合物的稳定性不足。',
  '## 发明内容',
  '本发明提供一种药物组合物，用于治疗糖尿病。',
  '## 具体实施方式',
  '实施例1：称取化合物 A 20 g 与辅料 80 g，混合制粒；产物经核磁共振氢谱（1H NMR）确证。',
  '实施例2：称取化合物 A 30 g 与辅料 70 g，混合压片。',
].join('\n')

/** 成分合计 100%、写明适应症的化学产品权要。 */
const CHEMICAL_CLAIMS = '1. 一种药物组合物，其特征在于，包含化合物 A 20% 和辅料 80%，用于治疗糖尿病。'

describe('domain_check: 化学域清单', () => {
  it('列出全部 33 项，化学规则按 tech_domain=chemical 运行', async () => {
    const value = await run({ domain: 'chemical', text: CHEMICAL_SPEC, claims: CHEMICAL_CLAIMS })
    expect(value.items).toHaveLength(33)
    expect(value.items.some(item => item.id.startsWith('CHEM-DC-'))).toBe(true)
    expect(value.items.some(item => item.id.startsWith('MECH-DC-') || item.id.startsWith('SOFT-DC-'))).toBe(false)
    expect(value.passed).toBe(true)
    expect(itemOf(value, 'CHEM-DC-004')?.status).toBe('pass')
    expect(itemOf(value, 'CHEM-DC-008')?.status).toBe('pass')
    expect(itemOf(value, 'CHEM-DC-030')?.status).toBe('pass')
    // 只覆盖缺陷一部分的项：未命中也不能判通过
    expect(itemOf(value, 'CHEM-DC-002')?.status).toBe('manual')
    expect(itemOf(value, 'CHEM-DC-031')?.status).toBe('manual')
    expect(itemOf(value, 'CHEM-DC-023')?.status).toBe('manual')
  })

  it('治疗方法主题命中 CHEM-DC-030 并判定未通过', async () => {
    const claims = '1. 一种治疗糖尿病的方法，其特征在于，向患者给予化合物 A。'
    const value = await run({ domain: 'chemical', text: CHEMICAL_SPEC, claims })
    expect(itemOf(value, 'CHEM-DC-030')?.status).toBe('hit')
    expect(value.passed).toBe(false)
    expect(value.findings.find(finding => finding.rule === 'chem_medical_use_method')?.severity).toBe('error')
  })

  it('组合物下限合计超过 100% 命中 CHEM-DC-014', async () => {
    const claims = '1. 一种组合物，其特征在于，包含组分 A 60-80% 和组分 B 50-70%。'
    const value = await run({ domain: 'chemical', text: CHEMICAL_SPEC, claims })
    expect(itemOf(value, 'CHEM-DC-014')?.status).toBe('hit')
    expect(value.findings.find(finding => finding.rule === 'chem_composition_total')?.message).toContain('110%')
  })

  it('马库什「任选取代」未限定取代基命中 CHEM-DC-008', async () => {
    const claims = '1. 一种通式（I）所示的化合物，其特征在于，R1 任选取代。'
    const value = await run({ domain: 'chemical', text: CHEMICAL_SPEC, claims })
    expect(itemOf(value, 'CHEM-DC-008')?.status).toBe('hit')
  })

  it('只传说明书时，缺输入的原因里点明说明书侧的命中', async () => {
    const value = await run({ domain: 'chemical', text: '本发明公开通式（I）化合物，其中 R1 任选取代。' })
    expect(itemOf(value, 'CHEM-DC-008')?.status).toBe('manual')
    expect(itemOf(value, 'CHEM-DC-008')?.reason).toContain('未提供 claims')
    expect(itemOf(value, 'CHEM-DC-008')?.reason).toContain('已命中规则：chem_markush_optional_undefined')
    expect(value.findings.find(finding => finding.rule === 'chem_markush_optional_undefined')?.severity).toBe('warning')
  })

  it('未提供 abstract 时摘要项报 manual，提供后才核', async () => {
    const withoutAbstract = await run({ domain: 'chemical', text: CHEMICAL_SPEC, claims: CHEMICAL_CLAIMS })
    expect(itemOf(withoutAbstract, 'CHEM-DC-005')?.status).toBe('manual')
    expect(itemOf(withoutAbstract, 'CHEM-DC-005')?.reason).toContain('未提供 abstract')

    const withAbstract = await run({
      domain: 'chemical',
      text: CHEMICAL_SPEC,
      claims: CHEMICAL_CLAIMS,
      abstract: '本发明提供一种药物组合物，用于治疗糖尿病，稳定性好。',
    })
    expect(itemOf(withAbstract, 'CHEM-DC-005')?.status).toBe('pass')
  })
})
