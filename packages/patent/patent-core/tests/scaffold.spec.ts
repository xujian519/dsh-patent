import { describe, expect, it } from 'vitest'
import * as Pkg from '@deepseek-ai/dsh-patent-core'

describe('@deepseek-ai/dsh-patent-core surface', () => {
  it('exports the atoms registry + builtin handler vocabulary', () => {
    expect(typeof Pkg.registerBuiltinAtoms).toBe('function')
    expect(typeof Pkg.AtomRegistry).toBe('function')
    expect(typeof Pkg.StageHandlerRegistry).toBe('function')
    expect(typeof Pkg.InterruptStageError).toBe('function')
    expect(typeof Pkg.LookupStageHandler).toBe('function')
  })

  it('exports the ModelPort adapter', () => {
    expect(typeof Pkg.createLlmModelPort).toBe('function')
    expect(typeof Pkg.collectPortText).toBe('function')
  })

  it('exports the rule protocol + text utilities', () => {
    expect(typeof Pkg.hasNegationContext).toBe('function')
    expect(typeof Pkg.parseCnNumber).toBe('function')
    expect(typeof Pkg.tryParseJson).toBe('function')
  })

  it('exports the controlled draft model + validators', () => {
    expect(typeof Pkg.validateSpecDraft).toBe('function')
    expect(typeof Pkg.validateTemplateDraft).toBe('function')
    expect(typeof Pkg.DraftValidationError).toBe('function')
    expect(typeof Pkg.numberedFigureDescriptions).toBe('function')
    expect(Pkg.SPEC_PART_HEADINGS.embodiment).toBe('具体实施方式')
    expect(Pkg.SPEC_PART_ORDER).toEqual(['technicalField', 'background', 'summary', 'drawingDescriptions', 'embodiment'])
    expect(Pkg.SPEC_DRAFT_SCHEMA.type).toBe('object')
    expect(Pkg.TEMPLATE_DRAFT_SCHEMA.type).toBe('object')
  })

  it('exports the IPC classifier + standards loader', () => {
    expect(typeof Pkg.classifyIpc).toBe('function')
    expect(typeof Pkg.classifyIpcTop).toBe('function')
    expect(typeof Pkg.loadIpcStandards).toBe('function')
    expect(typeof Pkg.queryIpcStandards).toBe('function')
  })

  it('exports the claim-chart + persistence helpers', () => {
    expect(typeof Pkg.validateElements).toBe('function')
    expect(typeof Pkg.detectGaps).toBe('function')
    expect(typeof Pkg.JsonFileStore).toBe('function')
    expect(typeof Pkg.atomicWriteJson).toBe('function')
    expect(typeof Pkg.caseOutputsDir).toBe('function')
  })
})
