import { describe, expect, it } from 'vitest'
import {
  createFlexiblePlan,
  formatTechnicalField,
  inferTechnicalField,
} from '@deepseek-ai/dsh-patent-workflow'
import type { IpcClassification } from '@deepseek-ai/dsh-patent-core'

describe('flexible-plan IPC technical-field inference', () => {
  it('formatTechnicalField: with detail outputs section + class', () => {
    const c: IpcClassification = {
      section: 'H', confidence: 0.9, matchedKeywords: ['电路', '集成电路'], detail: 'H01', detailConfidence: 0.85,
    }
    expect(formatTechnicalField(c)).toBe('H H01:电学-H01')
  })

  it('formatTechnicalField: without detail outputs only the section', () => {
    const c: IpcClassification = { section: 'A', confidence: 0.82, matchedKeywords: ['医药'] }
    expect(formatTechnicalField(c)).toBe('A:人类生活必需')
  })

  it('formatTechnicalField: an unknown section falls back to the raw section code', () => {
    const c: IpcClassification = { section: 'X', confidence: 0.8, matchedKeywords: [], detail: 'X01' }
    expect(formatTechnicalField(c)).toBe('X X01:X-X01')
    const bare: IpcClassification = { section: 'Z', confidence: 0.8, matchedKeywords: [] }
    expect(formatTechnicalField(bare)).toBe('Z:Z')
  })

  it('inferTechnicalField: electrical text infers section H', () => {
    const field = inferTechnicalField('本发明涉及一种集成电路芯片和半导体电路，用于无线通信系统中的射频信号放大与调制解调。')
    expect(field).toBeTruthy()
    expect(field!.startsWith('H')).toBe(true)
  })

  it('inferTechnicalField: empty text returns undefined', () => {
    expect(inferTechnicalField('')).toBeUndefined()
    expect(inferTechnicalField('   ')).toBeUndefined()
  })

  it('inferTechnicalField: low confidence returns undefined', () => {
    const fakeClassifier = (): IpcClassification => ({ section: 'B', confidence: 0.5, matchedKeywords: [] })
    expect(inferTechnicalField('abc', fakeClassifier)).toBeUndefined()
  })

  it('createFlexiblePlan: infers technicalField from inputText when not specified', () => {
    const plan = createFlexiblePlan('case-001', 'invalidation', {
      inputText: '本案涉及一种开关电源控制电路，包括变压器、MOSFET和反馈网络。',
    })
    expect(plan.technicalField).toBeTruthy()
    expect(plan.technicalField!.startsWith('H')).toBe(true)
  })

  it('createFlexiblePlan: explicit technicalField wins over inference', () => {
    const plan = createFlexiblePlan('case-002', 'invalidation', {
      inputText: '本案涉及一种开关电源控制电路。',
      technicalField: 'G06:计算',
    })
    expect(plan.technicalField).toBe('G06:计算')
  })

  it('createFlexiblePlan: no field when nothing to infer and not specified', () => {
    const plan = createFlexiblePlan('case-003', 'invalidation', {})
    expect(plan.technicalField).toBeUndefined()
  })

  it('createFlexiblePlan: injectable classifier', () => {
    const fakeClassifier = (): IpcClassification => ({
      section: 'H', confidence: 0.95, matchedKeywords: ['电路'], detail: 'H01', detailConfidence: 0.9,
    })
    const plan = createFlexiblePlan('case-004', 'drafting', { inputText: 'ignored', classifier: fakeClassifier })
    expect(plan.technicalField).toBe('H H01:电学-H01')
  })
})
