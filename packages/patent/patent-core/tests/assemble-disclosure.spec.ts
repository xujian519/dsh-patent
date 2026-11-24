import { describe, expect, it } from 'vitest'
import { validateSpecDraft } from '@deepseek-ai/dsh-patent-core'
import { DraftValidationError } from '../src/draft/validate.ts'
import {
  DisclosureAssemblyError,
  assembleDisclosureSpecDraft,
} from '../src/draft/assemble-disclosure.ts'

/**
 * 披露链成功终态用文本键，不是 SpecDraft。
 * 说明书正文按 draft-specification 的 Markdown 写出，警告行在章节之后。
 */
function specification(parts: Partial<Record<string, string>>, warnings = false): string {
  const lines = [
    '**说明书草案（一种检测装置）**',
    '技术领域: 机械 · 专利类型: invention · 完整度: 完整',
    '',
    '摘要: 摘要行不作为装配来源。',
    '',
  ]
  for (const name of ['技术领域', '背景技术', '发明内容', '附图说明', '具体实施方式']) {
    const body = parts[name]
    if (body === undefined) continue
    lines.push(`## ${name}`, '', body, '')
  }
  if (warnings) lines.push('**警告**', '- 这条警告不得进入具体实施方式')
  return lines.join('\n')
}

const SPEC_PARTS = {
  技术领域: '本发明涉及机械技术领域，尤其涉及一种检测装置。',
  背景技术: '现有检测装置的检测精度不足。',
  发明内容: '本发明要解决的技术问题是：检测精度不足\n为解决上述技术问题，本发明提供如下技术方案：壳体内容纳传感器',
  附图说明: '图1为整体结构示意图',
  具体实施方式: '实施例1：本实施例提供一种检测装置，包括壳体和传感器。',
} as const

/** 带附图的披露成功终态。`title` 与报告键不得被当成著录项或正文。 */
function disclosureSuccessState(): Record<string, unknown> {
  return {
    caseId: 'CN2026-0001',
    title: '不该采用的名称',
    draft_title: '一种检测装置',
    applicant: '示例申请人',
    inventor: '示例发明人',
    agent: '示例代理机构',
    date: '2026-11-24',
    claims_draft: [
      '1. 一种检测装置，其特征在于，包括壳体和传感器。',
      '2. 根据权利要求1所述的检测装置，其特征在于，所述传感器为光学传感器。',
    ].join('\n\n'),
    abstract: '本发明公开了一种检测装置。关键词：检测装置',
    figure_files: ['patent/figures/fig1.png'],
    specification: specification(SPEC_PARTS, true),
    report: '披露分析报告不得进入草案',
    complete: true,
  }
}

function expectGap(state: Record<string, unknown>, ...fragments: string[]): DisclosureAssemblyError {
  let caught: unknown
  try {
    assembleDisclosureSpecDraft(state)
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(DisclosureAssemblyError)
  const error = caught as DisclosureAssemblyError
  for (const fragment of fragments) {
    expect(error.gaps.some(gap => gap.includes(fragment))).toBe(true)
  }
  return error
}

describe('assembleDisclosureSpecDraft', () => {
  it('把带附图的披露成功终态装配成通过校验的 SpecDraft', () => {
    const draft = assembleDisclosureSpecDraft(disclosureSuccessState())
    expect(validateSpecDraft(draft)).toEqual(draft)
    expect(draft).toEqual({
      meta: {
        caseNumber: 'CN2026-0001',
        title: '一种检测装置',
        applicant: '示例申请人',
        inventor: '示例发明人',
        agent: '示例代理机构',
        date: '2026-11-24',
      },
      claims: [
        '一种检测装置，其特征在于，包括壳体和传感器。',
        '根据权利要求1所述的检测装置，其特征在于，所述传感器为光学传感器。',
      ],
      abstract: ['本发明公开了一种检测装置。关键词：检测装置'],
      figureFiles: ['patent/figures/fig1.png'],
      sections: {
        technicalField: [{ kind: 'paragraph', text: SPEC_PARTS.技术领域 }],
        background: [{ kind: 'paragraph', text: SPEC_PARTS.背景技术 }],
        summary: [{ kind: 'paragraph', text: SPEC_PARTS.发明内容 }],
        drawingDescriptions: [{ kind: 'list', items: ['整体结构示意图'] }],
        embodiment: [{ kind: 'paragraph', text: SPEC_PARTS.具体实施方式 }],
      },
    })
    expect(JSON.stringify(draft)).not.toContain('这条警告不得进入具体实施方式')
    expect(JSON.stringify(draft)).not.toContain('披露分析报告不得进入草案')
    expect(JSON.stringify(draft)).not.toContain('不该采用的名称')
    expect(JSON.stringify(draft)).not.toContain('摘要行不作为装配来源')
  })

  it('无附图且说明书没有附图说明时通过校验', () => {
    const { 附图说明: _omitted, ...parts } = SPEC_PARTS
    const draft = assembleDisclosureSpecDraft({
      ...disclosureSuccessState(),
      figure_files: [],
      specification: specification(parts),
    })
    expect(validateSpecDraft(draft)).toEqual(draft)
    expect(draft.figureFiles).toEqual([])
    expect(draft.sections.drawingDescriptions).toEqual([])
    expect(draft.abstractFigure).toBeUndefined()
  })

  it('保留调用方给出的摘要附图号，并按空行拆开摘要', () => {
    const draft = assembleDisclosureSpecDraft({
      ...disclosureSuccessState(),
      abstract: '第一段。\n\n\n\n第二段。',
      abstractFigure: '1',
      specification: specification({
        ...SPEC_PARTS,
        背景技术: '现有方案一。\n\n\n\n现有方案二。',
      }),
    })
    expect(draft.abstract).toEqual(['第一段。', '第二段。'])
    expect(draft.abstractFigure).toBe('1')
    expect(draft.sections.background).toEqual([
      { kind: 'paragraph', text: '现有方案一。' },
      { kind: 'paragraph', text: '现有方案二。' },
    ])
    expect(validateSpecDraft(draft)).toEqual(draft)
  })

  it('项号之后的续行并入同一项', () => {
    const draft = assembleDisclosureSpecDraft({
      ...disclosureSuccessState(),
      claims_draft: [
        '1. 一种检测装置，其特征在于，',
        '包括壳体和传感器。',
        '',
        '2. 根据权利要求1所述的检测装置，其特征在于，所述传感器为光学传感器。',
      ].join('\n'),
    })
    expect(draft.claims[0]).toBe('一种检测装置，其特征在于，\n包括壳体和传感器。')
    expect(validateSpecDraft(draft)).toEqual(draft)
  })

  it('去掉权利要求的顿号与全角点项号，并去掉附图说明的图号与句末标点', () => {
    const draft = assembleDisclosureSpecDraft({
      ...disclosureSuccessState(),
      claims_draft: '1、一种检测装置，其特征在于，包括壳体。\n\n2．根据权利要求1所述的检测装置，其特征在于，还包括弹簧。',
      specification: specification({
        ...SPEC_PARTS,
        附图说明: '图1为整体结构示意图。',
      }),
    })
    expect(draft.claims).toEqual([
      '一种检测装置，其特征在于，包括壳体。',
      '根据权利要求1所述的检测装置，其特征在于，还包括弹簧。',
    ])
    expect(draft.sections.drawingDescriptions).toEqual([{ kind: 'list', items: ['整体结构示意图'] }])
    expect(validateSpecDraft(draft)).toEqual(draft)
  })

  it('附图说明没有图号前缀时保留描述文字', () => {
    const draft = assembleDisclosureSpecDraft({
      ...disclosureSuccessState(),
      specification: specification({ ...SPEC_PARTS, 附图说明: '整体结构示意图' }),
    })
    expect(draft.sections.drawingDescriptions).toEqual([{ kind: 'list', items: ['整体结构示意图'] }])
  })

  it.each([
    'caseId',
    'draft_title',
    'applicant',
    'inventor',
    'agent',
    'date',
    'claims_draft',
    'specification',
    'abstract',
    'figure_files',
  ] as const)('丢掉 %s 时失败并点名该键', (key) => {
    const { [key]: _dropped, ...state } = disclosureSuccessState()
    expectGap(state, `${key} 缺失`)
  })

  it('同时丢掉 claims_draft 与 specification 时两处缺口都点名', () => {
    const state = disclosureSuccessState()
    delete state.claims_draft
    delete state.specification
    const error = expectGap(state, 'claims_draft 缺失', 'specification 缺失')
    expect(error.gaps.filter(gap => gap.includes('缺失'))).toEqual(expect.arrayContaining([
      expect.stringContaining('claims_draft'),
      expect.stringContaining('specification'),
    ]))
  })

  it.each(['applicant', 'claims_draft', 'specification', 'abstract'] as const)('把 %s 改成空白时失败并点名该键', (key) => {
    expectGap({ ...disclosureSuccessState(), [key]: '  \n' }, `${key} 为空`)
  })

  it('著录项不是字符串时失败，且不用 title 代替 draft_title', () => {
    expectGap({ ...disclosureSuccessState(), applicant: 1 }, 'applicant 必须是字符串')
    const state = disclosureSuccessState()
    delete state.draft_title
    expectGap(state, 'draft_title 缺失')
  })

  it('权利要求缺少项号或去掉项号后为空时失败', () => {
    expectGap(
      { ...disclosureSuccessState(), claims_draft: '一种检测装置，包括壳体。' },
      'claims_draft',
      '缺少项号',
    )
    expectGap(
      { ...disclosureSuccessState(), claims_draft: '1.   ' },
      'claims_draft',
      '去掉项号后为空',
    )
  })

  it('说明书缺少必填章节、重复章节或出现未知章节时失败', () => {
    const { 具体实施方式: _dropped, ...parts } = SPEC_PARTS
    expectGap(
      { ...disclosureSuccessState(), specification: specification(parts) },
      'specification',
      '具体实施方式',
    )
    const duplicated = `${specification(SPEC_PARTS)}\n## 技术领域\n\n另一段。\n`
    expectGap(
      { ...disclosureSuccessState(), specification: duplicated },
      '重复章节',
      '技术领域',
    )
    expectGap(
      { ...disclosureSuccessState(), specification: `${specification(SPEC_PARTS)}\n## 其他\n\n不应进入上一节。\n` },
      '未知章节',
      '其他',
    )
  })

  it('有附图却没有附图说明，或附图说明去掉图号后为空时失败', () => {
    const { 附图说明: _omitted, ...parts } = SPEC_PARTS
    expectGap(
      { ...disclosureSuccessState(), specification: specification(parts) },
      '附图说明',
    )
    expectGap(
      {
        ...disclosureSuccessState(),
        specification: specification({ ...SPEC_PARTS, 附图说明: '图1为。' }),
      },
      '去掉图号后为空',
    )
    expectGap(
      {
        ...disclosureSuccessState(),
        specification: specification({ ...SPEC_PARTS, 技术领域: '  \n' }),
      },
      '技术领域',
      '为空',
    )
    expectGap(
      {
        ...disclosureSuccessState(),
        specification: specification({ ...SPEC_PARTS, 附图说明: '  \n' }),
      },
      '附图说明',
      '为空',
    )
  })

  it('figure_files 不是字符串数组或含空项时失败', () => {
    expectGap({ ...disclosureSuccessState(), figure_files: 'patent/figures/fig1.png' }, 'figure_files 必须是字符串数组')
    expectGap({ ...disclosureSuccessState(), figure_files: ['  '] }, 'figure_files[0] 为空')
    expectGap({ ...disclosureSuccessState(), figure_files: [1] }, 'figure_files[0] 必须是字符串')
  })

  it('摘要附图号给出但为空或不是字符串时失败', () => {
    expectGap({ ...disclosureSuccessState(), abstractFigure: ' ' }, 'abstractFigure 为空')
    expectGap({ ...disclosureSuccessState(), abstractFigure: 1 }, 'abstractFigure 必须是字符串')
  })

  it('附图条数与 figure_files 不一致时失败并点名缺口，不改条数', () => {
    let caught: unknown
    try {
      assembleDisclosureSpecDraft({
        ...disclosureSuccessState(),
        figure_files: ['patent/figures/fig1.png', 'patent/figures/fig2.png'],
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DraftValidationError)
    expect((caught as DraftValidationError).message).toContain('附图说明')
    expect((caught as DraftValidationError).message).toContain('figureFiles')
  })
})
