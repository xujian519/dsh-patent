import { describe, expect, it } from 'vitest'
import { withStageWritingSkills } from '../src/atoms/stage-writing-skills.ts'

describe('withStageWritingSkills', () => {
  it('没有提供者时保持原提示词', () => {
    expect(withStageWritingSkills('正文', undefined, 'claim_strategy')).toBe('正文')
  })
})
