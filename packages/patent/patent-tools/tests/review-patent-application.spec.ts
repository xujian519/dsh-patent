import { describe, expect, it } from 'vitest'
import {
  createReviewPatentApplicationTool,
  renderReviewReport,
} from '../src/tool/review-patent-application.ts'
import type {
  ReviewPatentApplicationOutput,
} from '../src/tool/review-patent-application.ts'
import type { ReviewReport, ReviewReportView } from '../src/review/types.ts'

const SPEC = [
  '## 技术领域',
  '本发明涉及一种检测装置。',
  '## 背景技术',
  '现有检测装置存在精度不足的问题。',
  '## 发明内容',
  '本发明提供一种检测装置，包括壳体、盖体和铰链。',
  '## 附图说明',
  '图1是本发明实施例的结构示意图。',
  '## 具体实施方式',
  '实施例1：如图1所示，本实施例提供一种检测装置，包括壳体、盖体和铰链。',
].join('\n')

const CLAIMS = '1. 一种检测装置，其特征在于，包括壳体、盖体和铰链。'
const TWO_CLAIMS = [
  CLAIMS,
  '2. 根据权利要求1所述的检测装置，其特征在于，所述壳体为矩形。',
].join('\n')
const ABSTRACT = '本发明公开一种检测装置，包括壳体、盖体和铰链。'

/**
 * Run the tool with the given arguments.
 * @param args - model-supplied tool arguments.
 * @returns the tool output.
 */
async function run(args: Record<string, unknown>): Promise<ReviewPatentApplicationOutput> {
  const tool = createReviewPatentApplicationTool()
  return await tool.execute(args, {} as never) as ReviewPatentApplicationOutput
}

/** Render a report through the exported renderer. */
function render(value: ReviewPatentApplicationOutput): string {
  return renderReviewReport(value)
}

describe('review_patent_application: 工具边界', () => {
  it('两者都不提供时拒绝调用', async () => {
    const tool = createReviewPatentApplicationTool()
    await expect(tool.execute({}, {} as never)).rejects.toThrow(/至少提供 claims 或 specification/)
    await expect(tool.execute({ claims: '   ', specification: '  ' }, {} as never))
      .rejects.toThrow(/至少提供 claims 或 specification/)
  })

  it('只给权项时声明说明书未评审', async () => {
    const value = await run({ claims: CLAIMS })
    expect(value.reviewed_scope).toEqual({ claims: true, specification: false, figures: false })
    expect(value.findings.some(finding => finding.rule === 'review_scope')).toBe(true)
    expect(value.counts.not_assessed).toBeGreaterThanOrEqual(1)
  })

  it('只给说明书时声明权项未评审', async () => {
    const value = await run({ specification: SPEC })
    expect(value.reviewed_scope).toEqual({ claims: false, specification: true, figures: false })
    expect(value.findings.every(finding => finding.source !== 'claim_lint')).toBe(true)
    expect(value.findings.some(finding => finding.rule === 'review_scope')).toBe(true)
  })

  it('两者都给时记录四个输入指纹', async () => {
    const value = await run({
      claims: CLAIMS,
      specification: SPEC,
      abstract: ABSTRACT,
      title: '一种检测装置',
      patent_type: 'invention',
      has_drawings: true,
      tech_domain: 'mechanical',
      drawing_count: 1,
      abstract_figure_number: 1,
      max_claims: 10,
    })
    expect(value.reviewed_scope).toEqual({ claims: true, specification: true, figures: false })
    expect(value.evaluated.map(entry => entry.field).sort()).toEqual(
      ['abstract', 'claims', 'specification', 'title'].sort(),
    )
  })

  it('给附图证据时评审附图形式并以图号定位', async () => {
    const value = await run({
      claims: CLAIMS,
      has_drawings: true,
      drawing_count: 2,
      figures: [
        { figure_number: 1, office: 'pct', style: 'semantic', has_caption: true },
        { figure_number: 2, office: 'pct', has_caption: false },
      ],
    })
    expect(value.reviewed_scope).toEqual({ claims: true, specification: false, figures: true })
    expect(value.findings.filter(finding => finding.source === 'figure_check').map(finding => finding.rule))
      .toEqual(['figure-color-policy', 'figure-caption-missing'])
    const text = render(value)
    expect(text).toContain('已评审 权利要求+附图')
    expect(text).toContain('附图 1｜figure-color-policy')
  })

  it('附图证据与 has_drawings=false 矛盾时拒绝调用', async () => {
    await expect(run({
      claims: CLAIMS,
      has_drawings: false,
      figures: [{ figure_number: 1, office: 'cnipa', has_caption: true }],
    })).rejects.toThrow(/figures 与 has_drawings 矛盾/)
  })

  it('图号非正整数时拒绝调用', async () => {
    await expect(run({
      claims: CLAIMS,
      figures: [{ figure_number: 0, office: 'cnipa', has_caption: true }],
    })).rejects.toThrow(/figure_number 必须是正整数/)
  })

  it('max_claims 透传触发 claim-count', async () => {
    const value = await run({ claims: TWO_CLAIMS, max_claims: 1 })
    expect(value.findings.some(finding => finding.rule === 'claim-count')).toBe(true)
  })

  it('声明工具名、参数与输出 schema', () => {
    const tool = createReviewPatentApplicationTool()
    expect(tool.name).toBe('review_patent_application')
    expect(tool.description).toContain('确定性评审')
    const parameterSchema = tool.parameters as {
      properties: Record<string, unknown>
    }
    expect(Object.keys(parameterSchema.properties).sort()).toEqual(
      [
        'abstract',
        'abstract_figure_number',
        'claims',
        'drawing_count',
        'figures',
        'has_drawings',
        'max_claims',
        'patent_type',
        'specification',
        'tech_domain',
        'title',
      ].sort(),
    )
    const schema = tool.output.schema as {
      properties: Record<string, unknown>
    }
    expect(schema.properties['findings']).toBeDefined()
    expect(schema.properties['reviewed_scope']).toBeDefined()
    const blocks = tool.output.render({}, {
      passed: true,
      findings: [],
      counts: { error: 0, warning: 0, not_assessed: 0 },
      reviewed_scope: { claims: true, specification: true, figures: false },
      evaluated: [],
    }) as Array<{ type: string; text?: string }>
    expect(blocks.map(block => block.text ?? '').join('')).toContain('申请文件评审：通过')
  })
})

describe('review_patent_application: 渲染', () => {
  const report: ReviewReport = {
    passed: false,
    findings: [
      {
        id: 'F1',
        source: 'claim_lint',
        rule: 'numbering',
        severity: 'error',
        message: '编号断裂',
        locator: { kind: 'claim', claim: 1 },
        evidence: '1.',
        basis: '细则第二十条',
      },
      {
        id: 'F2',
        source: 'spec_check',
        rule: 'clarity',
        severity: 'warning',
        message: '表述模糊',
        locator: { kind: 'section', section: '背景技术' },
        suggestion: '改写为客观描述',
      },
      {
        id: 'F3',
        source: 'review',
        rule: 'review_scope',
        severity: 'info',
        not_assessed: true,
        message: '说明书未提供：说明书形式与充分公开未评审',
        locator: { kind: 'document' },
      },
    ],
    counts: { error: 1, warning: 1, not_assessed: 1 },
    reviewed_scope: { claims: true, specification: false, figures: false },
    evaluated: [],
  }

  it('按严重度分组，并渲染定位、命中与建议', () => {
    const text = render(report)
    expect(text).toContain('申请文件评审：未通过')
    expect(text).toContain('error 1、warning 1；未评估 1 项；已评审 权利要求')
    expect(text).toContain('## 必须修改（error）')
    expect(text).toContain('[F1] 权利要求 1｜numbering：编号断裂（依据：细则第二十条）')
    expect(text).toContain('命中：1.')
    expect(text).toContain('[F2] 说明书·背景技术｜clarity：表述模糊')
    expect(text).toContain('→ 建议：改写为客观描述')
    expect(text).toContain('## 未评估（信息）')
    expect(text).toContain('[F3] 全篇｜review_scope：说明书未提供')
    expect(text).not.toContain('评估输入:')
  })

  it('无 findings 时三段都给出「无」', () => {
    const text = render({
      passed: true,
      findings: [],
      counts: { error: 0, warning: 0, not_assessed: 0 },
      reviewed_scope: { claims: true, specification: true, figures: false },
      evaluated: [],
    })
    expect(text).toContain('申请文件评审：通过（未发现 error）')
    expect(text).toContain('## 必须修改（error）\n- 无')
    expect(text).toContain('## 需要复核（warning）\n- 无')
    expect(text).toContain('## 未评估（信息）\n- 无')
  })

  it('有输入指纹时追加评估输入行', () => {
    const text = render({
      ...report,
      evaluated: [{ field: 'claims', chars: 10, digest: 'sha256:abc' }],
    })
    expect(text).toContain('评估输入: claims 10 字 · sha256:abc')
  })

  it('只评审说明书时结论行只写说明书', () => {
    const text = renderReviewReport({
      passed: true,
      findings: [],
      counts: { error: 0, warning: 0, not_assessed: 0 },
      reviewed_scope: { claims: false, specification: true, figures: false },
      evaluated: [],
    })
    expect(text).toContain('已评审 说明书）')
  })

  it('扁平 locator 缺少载荷时退化为可读占位', () => {
    const flat: ReviewReportView = {
      passed: false,
      findings: [
        {
          id: 'F1',
          source: 'claim_lint',
          rule: 'numbering',
          severity: 'error',
          message: '编号断裂',
          locator: { kind: 'claim' },
        },
        {
          id: 'F2',
          source: 'spec_check',
          rule: 'clarity',
          severity: 'warning',
          message: '表述模糊',
          locator: { kind: 'section' },
        },
      ],
      counts: { error: 1, warning: 1, not_assessed: 0 },
      reviewed_scope: { claims: true, specification: true, figures: false },
      evaluated: [],
    }
    const text = renderReviewReport(flat)
    expect(text).toContain('权利要求 0｜numbering')
    expect(text).toContain('说明书·｜clarity')
  })
})
