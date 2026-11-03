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
    // 001/025 需要图面标号数据，本次未提供 → manual，不得算通过
    expect(countBy(value.items, 'pass')).toBe(12)
    expect(countBy(value.items, 'manual')).toBe(18)
    expect(itemOf(value, 'MECH-DC-001')?.reason).toContain('附图分析结果')
    // 渲染在无命中时也要给出稳定的段落结构
    const tool: ToolDefinition = createDomainCheckTool()
    const blocks = tool.output.render({}, value) as Array<{ type: string; text?: string }>
    const text = blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
    expect(text).toContain('## 命中（按清单项）\n- 无')
    expect(text).toContain('通过')
  })

  it('提供附图分析结果后图面标号项才算核过，结果不可用时报命中', async () => {
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
    expect(itemOf(unusable, 'MECH-DC-001')?.status).toBe('hit')
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
    expect(itemOf(value, 'MECH-DC-024')?.status).not.toBe('manual')
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
    await expect(tool.execute({ domain: 'chemical', text: SPEC }, {} as never)).rejects.toThrow(/domain.*must be one of/)
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
