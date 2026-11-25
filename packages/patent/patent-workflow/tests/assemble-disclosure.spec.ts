import { describe, expect, it } from 'vitest'
import { DisclosureAssemblyError, validateSpecDraft } from '@deepseek-ai/dsh-patent-core'
import { assembleDisclosureTerminalState } from '../src/workflow/assemble-disclosure.ts'

/** 同包测试从内部模块导入装配函数；夹具保持披露终态的文本键，而不是 SpecDraft。 */
function terminalState(): Record<string, unknown> {
  return {
    caseId: 'CN2026-0001',
    draft_title: '一种检测装置',
    applicant: '示例申请人',
    inventor: '示例发明人',
    agent: '示例代理机构',
    date: '2026-11-24',
    claims_draft: '1. 一种检测装置，其特征在于，包括壳体。',
    abstract: '本发明公开了一种检测装置。',
    figure_files: [],
    specification: [
      '## 技术领域',
      '',
      '本发明涉及一种检测装置。',
      '',
      '## 背景技术',
      '',
      '现有装置精度不足。',
      '',
      '## 发明内容',
      '',
      '本发明提供一种检测装置。',
      '',
      '## 具体实施方式',
      '',
      '实施例1：壳体内容纳传感器。',
      '',
    ].join('\n'),
  }
}

describe('assembleDisclosureTerminalState', () => {
  it('调用装配器，成功终态通过 validateSpecDraft', () => {
    const draft = assembleDisclosureTerminalState(terminalState())
    expect(validateSpecDraft(draft)).toEqual(draft)
    expect(draft.claims).toEqual(['一种检测装置，其特征在于，包括壳体。'])
    expect(draft.sections.drawingDescriptions).toEqual([])
  })

  it('丢掉 claims_draft 时失败并点名该键', () => {
    const state = terminalState()
    delete state.claims_draft
    let caught: unknown
    try {
      assembleDisclosureTerminalState(state)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(DisclosureAssemblyError)
    expect((caught as DisclosureAssemblyError).gaps.some(gap => gap.includes('claims_draft'))).toBe(true)
  })
})
