import { describe, expect, it } from 'vitest'
import { readStagePatterns, stageWritingSkills } from '../src/tool/internal/stage-writing-skills.ts'

describe('stage writing skills lookup', () => {
  const service = {
    stageIds: () => ['claim_strategy'],
    compiledForStage: (stageId: string) => stageId === 'claim_strategy' ? '  <writing_skills/>  ' : '',
  }

  it('reads a service that exposes both methods', () => {
    expect(readStagePatterns(service)?.stageIds()).toEqual(['claim_strategy'])
    expect(stageWritingSkills(readStagePatterns(service), 'claim_strategy')).toBe('<writing_skills/>')
    expect(stageWritingSkills(readStagePatterns(service), 'draft_claims')).toBeUndefined()
    expect(stageWritingSkills(undefined, 'claim_strategy')).toBeUndefined()
    expect(stageWritingSkills({
      stageIds: () => ['claim_strategy'],
      compiledForStage: () => '   ',
    }, 'claim_strategy')).toBeUndefined()
  })

  it('rejects values that are not the lookup', () => {
    expect(readStagePatterns(1)).toBeUndefined()
    expect(readStagePatterns(null)).toBeUndefined()
    expect(readStagePatterns({})).toBeUndefined()
    expect(readStagePatterns({ stageIds: 'claim_strategy' })).toBeUndefined()
    expect(readStagePatterns({ stageIds: () => [] })).toBeUndefined()
    expect(readStagePatterns({ stageIds: () => [], compiledForStage: 'text' })).toBeUndefined()
  })
})
