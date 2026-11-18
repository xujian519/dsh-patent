import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BASELINE_PATH,
  HOST_PATCH_PATH,
  enabledHostRowIds,
  modeBaselineFindings,
  parseModeBaseline,
  personaPrefixBody,
  type ModeBaseline,
  type ModeDeclaration,
  type ModeSource,
} from './verify-preset-mode-baseline.ts'

const AUTHORITY = 'authority.patch.yml'
const DELIVERY = 'delivery.patch.yml'

/** A preset row in the shape the row-block reader recognises. */
function row(id: string): string {
  return `          - id: ${id}\n            name: '@deepseek-ai/dsh-${id}'`
}

/** A persona row carrying a block-scalar prefix. */
function personaRow(body = '你是交付工程师。'): string {
  return [
    '          - id: persona',
    "            name: '@deepseek-ai/dsh-persona'",
    '            config:',
    '              prefix: |-',
    ...body.split('\n').map(line => `                ${line}`),
  ].join('\n')
}

/** A persona row whose prefix is an inline scalar, so it carries no block body. */
function inlinePersonaRow(): string {
  return [
    '          - id: persona',
    "            name: '@deepseek-ai/dsh-persona'",
    '            config:',
    '              prefix: inline',
  ].join('\n')
}

/** A preset file whose rows are the given blocks. */
function preset(file: string, blocks: readonly string[]): ModeSource {
  return { file, source: blocks.join('\n\n') }
}

/** The authority preset: its rows define the shared set. */
const AUTHORITY_PRESET = preset(AUTHORITY, [
  row('preset-authority'),
  personaRow(),
  row('tool-fs'),
  row('tool-goal'),
  row('tool-market'),
])

/** A delivery mode carrying everything the authority carries. */
const COMPLETE_DELIVERY = preset(DELIVERY, [
  row('preset-delivery'),
  personaRow(),
  row('tool-fs'),
  row('tool-goal'),
  row('tool-market'),
])

/** A delivery mode that dropped `tool-fs` and `tool-market`. */
const DROPPED_DELIVERY = preset(DELIVERY, [row('preset-delivery'), personaRow(), row('tool-goal')])

/** A baseline declaration for `delivery.patch.yml`. */
function declaration(overrides: Partial<ModeDeclaration> = {}): ModeDeclaration {
  return {
    class: 'delivery',
    requiredRows: ['persona', 'tool-fs', 'tool-goal'],
    personaMaxChars: 1000,
    forbiddenKeys: [],
    ...overrides,
  }
}

/** A baseline over the authority preset plus a delivery declaration. */
function baseline(delivery: ModeDeclaration): ModeBaseline {
  return { authority: AUTHORITY, modes: { [AUTHORITY]: { class: 'utility' }, [DELIVERY]: delivery } }
}

/** The findings for one delivery declaration, as `<mode>: <detail>` lines. */
function findingsFor(mode: ModeSource, delivery: ModeDeclaration): readonly string[] {
  return modeBaselineFindings([AUTHORITY_PRESET, mode], baseline(delivery))
    .map(finding => `${finding.mode}: ${finding.detail}`)
}

describe('enabledHostRowIds', () => {
  it('reads enabled row ids and skips a row the host disables or comments out', () => {
    const source = [
      '- id: skill-office',
      "  name: '@deepseek-ai/dsh-skill-office'",
      '- id: tool-plugin-manager',
      '  disabled: true',
      '# - id: commented-row',
      '- id: office-kit',
    ].join('\n')
    expect(enabledHostRowIds(source)).toEqual(new Set(['skill-office', 'office-kit']))
  })
})

describe('personaPrefixBody', () => {
  it('reads the block scalar with its indentation removed and trailing blank lines dropped', () => {
    expect(personaPrefixBody(personaRow('第一行\n\n  缩进行\n'))).toBe('第一行\n\n  缩进行')
  })

  it('returns undefined for a row that carries no block-scalar prefix', () => {
    expect(personaPrefixBody(inlinePersonaRow())).toBeUndefined()
    expect(personaPrefixBody(undefined)).toBeUndefined()
  })

  it('stops the scalar where the row indentation returns', () => {
    const block = [
      '          - id: persona',
      '            config:',
      '              prefix: |-',
      '                正文',
      '              suffix: |-',
      '                尾注',
    ].join('\n')
    expect(personaPrefixBody(block)).toBe('正文')
  })
})

describe('parseModeBaseline', () => {
  it('rejects a document that is not an object', () => {
    expect(() => parseModeBaseline('null')).toThrow(/the baseline must be an object$/u)
    expect(() => parseModeBaseline('"text"')).toThrow(/the baseline must be an object$/u)
    expect(() => parseModeBaseline('[]')).toThrow(/the baseline must be an object$/u)
  })

  it('rejects a document missing the authority or the modes record', () => {
    expect(() => parseModeBaseline('{"authority":""}')).toThrow(/non-empty `authority` string/u)
    expect(() => parseModeBaseline('{"authority":"standard.patch.yml"}')).toThrow(/needs a `modes` record/u)
  })

  it('reads a declaration document', () => {
    expect(parseModeBaseline('{"authority":"standard.patch.yml","modes":{}}')).toEqual({
      authority: 'standard.patch.yml',
      modes: {},
    })
  })

  it('rejects a mode whose class is neither delivery nor utility', () => {
    const source = JSON.stringify({ authority: 'a.patch.yml', modes: { 'b.patch.yml': { class: 'occasional' } } })
    expect(() => parseModeBaseline(source)).toThrow(/b\.patch\.yml: class must be "delivery" or "utility"/u)
  })

  it('rejects a declaration whose fields carry the wrong types', () => {
    const of = (declaration: Record<string, unknown>): string =>
      JSON.stringify({ authority: 'a.patch.yml', modes: { 'b.patch.yml': declaration } })
    expect(() => parseModeBaseline(of({ class: 'delivery', requiredRows: 'tool-fs' })))
      .toThrow(/requiredRows must be an array of row ids/u)
    expect(() => parseModeBaseline(of({ class: 'delivery', explainedAbsences: { 'tool-fs': 7 } })))
      .toThrow(/explainedAbsences must map a row id to a reason string/u)
    expect(() => parseModeBaseline(of({ class: 'delivery', personaMaxChars: 0 })))
      .toThrow(/personaMaxChars must be a positive integer/u)
    expect(() => parseModeBaseline(of({ class: 'delivery', forbiddenKeys: 'deliveryGate' })))
      .toThrow(/forbiddenKeys must be an array of row key names/u)
  })
})

describe('modeBaselineFindings', () => {
  it('accepts a delivery mode that carries every authority row', () => {
    expect(findingsFor(COMPLETE_DELIVERY, declaration())).toEqual([])
  })

  it('reports a dropped required row by its id and its preset file', () => {
    const findings = findingsFor(DROPPED_DELIVERY, declaration())
    expect(findings).toEqual([
      `${DELIVERY}: does not carry tool-fs, a required row`,
      `${DELIVERY}: does not carry tool-market, and records no reason for its absence`,
    ])
    expect(findings.join('\n')).toContain('tool-fs')
    expect(findings.join('\n')).toContain(DELIVERY)
  })

  it('reports an authority row the delivery mode dropped with no recorded reason', () => {
    expect(findingsFor(DROPPED_DELIVERY, declaration({ requiredRows: ['persona', 'tool-goal'] }))).toEqual([
      `${DELIVERY}: does not carry tool-fs, and records no reason for its absence`,
      `${DELIVERY}: does not carry tool-market, and records no reason for its absence`,
    ])
  })

  it('accepts a recorded reason for an authority row the mode does not carry', () => {
    expect(findingsFor(DROPPED_DELIVERY, declaration({
      requiredRows: ['persona', 'tool-goal'],
      explainedAbsences: { 'tool-fs': '由宿主行提供', 'tool-market': '由宿主行提供' },
    }))).toEqual([])
  })

  it('rejects a reason that is blank', () => {
    expect(findingsFor(DROPPED_DELIVERY, declaration({
      requiredRows: ['persona', 'tool-goal'],
      explainedAbsences: { 'tool-fs': '   ', 'tool-market': '由宿主行提供' },
    }))).toEqual([`${DELIVERY}: explains tool-fs with no reason`])
  })

  it('rejects an absence reason the host composition contradicts', () => {
    const findings = modeBaselineFindings([AUTHORITY_PRESET, DROPPED_DELIVERY], baseline(declaration({
      requiredRows: ['persona', 'tool-goal'],
      explainedAbsences: { 'tool-fs': '本模式不挂载文件工具', 'tool-market': '由宿主行提供' },
    })), new Set(['tool-fs']))
    expect(findings.map(finding => `${finding.mode}: ${finding.detail}`)).toEqual([
      `${DELIVERY}: explains tool-fs as absent, but ${HOST_PATCH_PATH} carries it enabled`,
    ])
  })

  it('accepts an absence reason for a row the host disables', () => {
    expect(findingsFor(DROPPED_DELIVERY, declaration({
      requiredRows: ['persona', 'tool-goal'],
      explainedAbsences: { 'tool-fs': '由宿主行提供但默认关闭', 'tool-market': '由宿主行提供' },
    }))).toEqual([])
  })

  it('rejects a recorded absence for a row the mode carries again', () => {
    expect(findingsFor(COMPLETE_DELIVERY, declaration({ explainedAbsences: { 'tool-market': '不再需要' } }))).toEqual([
      `${DELIVERY}: carries tool-market again; drop the recorded absence`,
    ])
  })

  it('rejects a row that is both required and explained', () => {
    expect(findingsFor(COMPLETE_DELIVERY, declaration({ explainedAbsences: { 'tool-fs': '外部提供' } }))).toEqual([
      `${DELIVERY}: carries tool-fs again; drop the recorded absence`,
      `${DELIVERY}: both requires and explains tool-fs`,
    ])
  })

  it('rejects a required row the authority preset does not carry', () => {
    expect(findingsFor(COMPLETE_DELIVERY, declaration({ requiredRows: ['tool-missing'] }))).toEqual([
      `${DELIVERY}: requires tool-missing, which ${AUTHORITY} does not carry`,
      `${DELIVERY}: does not carry tool-missing, a required row`,
    ])
  })

  it('rejects a delivery mode with no requiredRows', () => {
    expect(findingsFor(COMPLETE_DELIVERY, { class: 'delivery', personaMaxChars: 1000, forbiddenKeys: [] })).toEqual([
      `${DELIVERY}: is a delivery mode with no requiredRows`,
    ])
  })

  it('rejects a preset that ships without a declaration, and a declaration without a preset', () => {
    const findings = modeBaselineFindings([AUTHORITY_PRESET, COMPLETE_DELIVERY], {
      authority: AUTHORITY,
      modes: { [AUTHORITY]: { class: 'utility' }, 'gone.patch.yml': { class: 'utility' } },
    })
    expect(findings.map(finding => `${finding.mode}: ${finding.detail}`)).toEqual([
      'gone.patch.yml: is declared in the baseline but does not ship',
      `${DELIVERY}: ships without a baseline declaration`,
    ])
  })

  it('rejects an authority preset that does not ship', () => {
    const findings = modeBaselineFindings([COMPLETE_DELIVERY], {
      authority: AUTHORITY,
      modes: { [AUTHORITY]: { class: 'utility' }, [DELIVERY]: declaration() },
    })
    expect(findings.map(finding => `${finding.mode}: ${finding.detail}`)).toEqual([
      `${AUTHORITY}: names an authority preset that does not ship`,
      `${AUTHORITY}: is declared in the baseline but does not ship`,
    ])
  })

  it('rejects a utility mode that declares the delivery floor', () => {
    const findings = modeBaselineFindings([AUTHORITY_PRESET, COMPLETE_DELIVERY], {
      authority: AUTHORITY,
      modes: { [AUTHORITY]: { class: 'utility' }, [DELIVERY]: { class: 'utility', requiredRows: ['persona'] } },
    })
    expect(findings.map(finding => finding.detail)).toContain('declares requiredRows, which a utility mode does not carry')
  })

  it('rejects a preset carrying two preset-declaration rows', () => {
    const doubled = preset(DELIVERY, [
      row('preset-delivery'),
      row('preset-other'),
      personaRow(),
      row('tool-fs'),
      row('tool-goal'),
      row('tool-market'),
    ])
    expect(findingsFor(doubled, declaration())).toEqual([
      `${DELIVERY}: carries 2 preset-declaration rows; a preset declares exactly one`,
    ])
  })

  it('rejects a persona over its ceiling, naming both sizes', () => {
    const long = preset(DELIVERY, [
      row('preset-delivery'),
      personaRow('甲'.repeat(20)),
      row('tool-fs'),
      row('tool-goal'),
      row('tool-market'),
    ])
    expect(findingsFor(long, declaration({ personaMaxChars: 10 }))).toEqual([
      `${DELIVERY}: persona prefix body is 20 characters, over the 10 ceiling`,
    ])
  })

  it('rejects a declared ceiling for a persona row that carries no prefix body', () => {
    const bare = preset(DELIVERY, [
      row('preset-delivery'),
      inlinePersonaRow(),
      row('tool-fs'),
      row('tool-goal'),
      row('tool-market'),
    ])
    expect(findingsFor(bare, declaration())).toEqual([
      `${DELIVERY}: declares personaMaxChars but carries no persona prefix body`,
    ])
  })
})

describe('forbiddenKeys', () => {
  /** A delivery mode whose `doc-template` row carries a gate declaration. */
  const GATED = preset(DELIVERY, [
    row('preset-delivery'),
    personaRow(),
    row('tool-fs'),
    row('tool-goal'),
    row('tool-market'),
    [
      '          - id: doc-template',
      "            name: '@deepseek-ai/dsh-doc-template'",
      '            config:',
      '              deliveryGate:',
      '                - tool: render_doc_template',
    ].join('\n'),
  ])

  it('rejects a delivery mode that carries a forbidden row key, naming the row', () => {
    const findings = findingsFor(GATED, declaration({ forbiddenKeys: ['deliveryGate'] }))
    expect(findings).toHaveLength(1)
    expect(findings[0]).toContain('carries deliveryGate in row doc-template')
    expect(findings[0]).toContain('packages/document/document-deliver/README.md')
  })

  it('accepts the key when the declaration exempts the mode with an empty list', () => {
    expect(findingsFor(GATED, declaration({ forbiddenKeys: [] }))).toEqual([])
  })

  it('does not read a commented-out key as carrying it', () => {
    const commented = preset(DELIVERY, [
      row('preset-delivery'),
      personaRow(),
      row('tool-fs'),
      row('tool-goal'),
      row('tool-market'),
      [
        '          - id: doc-template',
        "            name: '@deepseek-ai/dsh-doc-template'",
        '            config:',
        '              # deliveryGate: deliberately not declared',
        '              styleGuide: assistant-neutral',
      ].join('\n'),
    ])
    expect(findingsFor(commented, declaration({ forbiddenKeys: ['deliveryGate'] }))).toEqual([])
  })

  it('rejects a delivery mode with no forbiddenKeys', () => {
    const { forbiddenKeys: _dropped, ...withoutField } = declaration()
    expect(findingsFor(COMPLETE_DELIVERY, withoutField)).toEqual([
      `${DELIVERY}: is a delivery mode with no forbiddenKeys`,
    ])
  })

  it('rejects a utility mode that declares forbiddenKeys', () => {
    const findings = modeBaselineFindings([AUTHORITY_PRESET, COMPLETE_DELIVERY], {
      authority: AUTHORITY,
      modes: {
        [AUTHORITY]: { class: 'utility' },
        [DELIVERY]: { class: 'utility', forbiddenKeys: ['deliveryGate'] },
      },
    })
    expect(findings.map(finding => finding.detail))
      .toContain('declares forbiddenKeys, which a utility mode does not carry')
  })

  it('holds the shipped baseline to the ruling: the document mode forbids deliveryGate, patent exempts it', () => {
    const shipped = parseModeBaseline(readFileSync(resolve(import.meta.dirname, '..', BASELINE_PATH), 'utf8'))
    expect(shipped.modes['document.patch.yml']?.forbiddenKeys).toEqual(['deliveryGate'])
    // The exemption is the shipped patent mode's own `deliveryGate`, ruled on in
    // the same README the finding points at.
    expect(shipped.modes['patent.patch.yml']?.forbiddenKeys).toEqual([])
  })
})
