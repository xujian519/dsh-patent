import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import * as methodology from '../src/index.ts'
import {
  createTrizTool,
  ENGINEERING_PARAMS,
  loadMatrix,
  loadPrinciples,
  loadSeparations,
  lookupMatrixCell,
  paramLabel,
  principleNames,
} from '../src/index.ts'
import { TRIZ_PROMPT_TEXT } from '../src/prompt.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const testToolSignal = new AbortController().signal

/**
 * One empty cell off the diagonal, scanned from the shipped matrix: the
 * matrix has 234 of them, so pinning one cell number would only add a
 * fixture that breaks when the asset changes.
 * @returns the improving/worsening parameter numbers of that cell.
 */
function emptyOffDiagonalCell(): { improving: number; worsening: number } {
  const matrix = loadMatrix()
  for (let worsening = 1; worsening <= matrix.length; worsening += 1) {
    const row = matrix[worsening - 1] ?? []
    for (let improving = 1; improving <= row.length; improving += 1) {
      if (improving !== worsening && (row[improving - 1] ?? []).length === 0) {
        return { improving, worsening }
      }
    }
  }
  throw new Error('the shipped matrix has no empty off-diagonal cell')
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

function execute(host: Context, name: string, args: unknown, callLabel: string) {
  return executeToolFixture(host, { signal: testToolSignal, callId: ToolCallId(callLabel), name, arguments: args })
}

async function setupPlugin(config: Record<string, unknown> = {}): Promise<Context> {
  const host = new Context()
  await host.plugin(SystemPrompt)
  await host.plugin(ToolRuntime)
  await host.plugin(methodology, config)
  return host
}

describe('TRIZ data access', () => {
  it('lookupMatrixCell returns [] for out-of-range or non-integer parameters', () => {
    expect(lookupMatrixCell(14, 0)).toEqual([])
    expect(lookupMatrixCell(0, 14)).toEqual([])
    expect(lookupMatrixCell(40, 1)).toEqual([])
    expect(lookupMatrixCell(1, 40)).toEqual([])
    expect(lookupMatrixCell(1.5, 1)).toEqual([])
    expect(lookupMatrixCell(Number.NaN, 1)).toEqual([])
  })

  it('reads rows as worsening and columns as improving, never the transpose', () => {
    const data = loadMatrix()
    expect(lookupMatrixCell(14, 1)).toEqual(data[0]?.[13])
    expect(lookupMatrixCell(1, 14)).toEqual(data[13]?.[0])
    expect(lookupMatrixCell(14, 1)).not.toEqual(lookupMatrixCell(1, 14))
  })

  it('paramLabel falls back to the number for unknown parameters', () => {
    expect(paramLabel(99)).toBe('99')
  })

  it('principleNames renders unknown ids without a name', () => {
    expect(principleNames([999])).toBe('999')
    expect(principleNames([1, 999])).toBe('1 分割, 999')
  })

  it('lookupMatrixCell resolves classic reference cells', () => {
    expect(lookupMatrixCell(14, 1)).toEqual([1, 8, 40, 15])
    expect(lookupMatrixCell(9, 10)).toEqual([13, 28, 15, 19])
    expect(lookupMatrixCell(3, 15)).toEqual([19])
    expect(lookupMatrixCell(6, 14)).toEqual([40])
    expect(lookupMatrixCell(14, 20)).toEqual([35])
  })

  it('matrix data is 39x39 with 1248 filled cells of principle numbers 1-40', () => {
    const data = loadMatrix()
    expect(data.length).toBe(39)
    let filled = 0
    let diagonalEmpty = 0
    let offDiagonalEmpty = 0
    for (let worsening = 0; worsening < data.length; worsening += 1) {
      const row = data[worsening] as number[][]
      expect(row.length).toBe(39)
      for (let improving = 0; improving < row.length; improving += 1) {
        const cell = row[improving] as number[]
        if (cell.length > 0) filled += 1
        else if (improving === worsening) diagonalEmpty += 1
        else offDiagonalEmpty += 1
        for (const n of cell) {
          expect(n).toBeGreaterThanOrEqual(1)
          expect(n).toBeLessThanOrEqual(40)
        }
      }
    }
    expect(filled).toBe(1248)
    expect(diagonalEmpty).toBe(39)
    expect(offDiagonalEmpty).toBe(234)
  })

  it('records the single duplicated source cell and deduplicates it on read', () => {
    const duplicated = loadMatrix().flat().filter(cell => new Set(cell).size !== cell.length)
    // Casey Perno xls and pytriz both transcribe (improving 19, worsening 9) as
    // [8, 35, 35]; keep the source value, never guess a replacement.
    expect(duplicated).toEqual([[8, 35, 35]])
    expect(lookupMatrixCell(19, 9)).toEqual([8, 35])
  })

  it('matrix diagonal cells are empty physical contradictions', () => {
    const data = loadMatrix()
    for (let i = 0; i < 39; i += 1) {
      expect(data[i]?.[i]).toEqual([])
    }
  })

  it('engineering parameters cover 1-39 in order with matching labels', () => {
    expect(ENGINEERING_PARAMS.map(param => param.no)).toEqual(Array.from({ length: 39 }, (_, index) => index + 1))
    for (const param of ENGINEERING_PARAMS) {
      expect(param.label.length).toBeGreaterThan(0)
      expect(paramLabel(param.no)).toBe(param.label)
    }
  })

  it('principles data holds 40 numbered, named, described entries', () => {
    const data = loadPrinciples()
    expect(data.length).toBe(40)
    expect(new Set(data.map(p => p.no)).size).toBe(40)
    expect(data.map(p => p.no)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1))
    for (const p of data) {
      expect(p.name.length).toBeGreaterThan(0)
      expect(p.description.length).toBeGreaterThan(0)
    }
  })

  it('separation data holds five uniquely identified, actionable entries', () => {
    const data = loadSeparations()
    expect(data.length).toBe(5)
    expect(new Set(data.map(separation => separation.id)).size).toBe(5)
    for (const separation of data) {
      expect(separation.name.length).toBeGreaterThan(0)
      expect(separation.description.length).toBeGreaterThan(0)
      expect(separation.signals.length).toBeGreaterThan(0)
    }
  })
})

describe('dsh-methodology plugin-registered triz tool', () => {
  it('registers the triz tool', async () => {
    const host = await setupPlugin()
    const names = host.tools.schemas().map(schema => schema.name)
    expect(names).toContain('triz')
  })

  it('pins the tool:triz system-prompt text', () => {
    expect(TRIZ_PROMPT_TEXT).toMatchInlineSnapshot(`
      "For patent innovation, design-around, and trade-off analysis, use the triz tool when a task names a technical contradiction or conflict between two engineering parameters.
      Call triz with no arguments to list the 39 classic engineering parameters and the 40 inventive principles.
      Call triz with an improving and a worsening parameter number (1-39) to read that contradiction-matrix cell and its recommended inventive principles.
      triz only reads a matrix cell for two explicit parameter numbers; identifying parameters or contradictions from a disclosure is outside its scope."
    `)
  })

  it('pins the model-facing triz schema', async () => {
    const host = await setupPlugin()
    const schema = host.tools.schemas().find(entry => entry.name === 'triz')
    expect(schema).toMatchInlineSnapshot(`
      {
        "description": "- TRIZ inventive problem solving: the 40 inventive principles and the 39x39 Altshuller contradiction matrix
      - Call with no arguments to list all 39 engineering parameters and 40 principles
      - Call with an improving and a worsening parameter number (1-39) to read that matrix cell and its recommended principles
      - Use for technical contradictions, trade-offs, and patent design-around
      - This tool only reads the matrix for explicit parameter numbers; extracting parameters or contradictions from a document is outside its scope",
        "name": "triz",
        "parameters": {
          "properties": {
            "improving": {
              "description": "Improving engineering parameter number (1-39). Omit it together with worsening to list the full catalog.",
              "type": "integer",
            },
            "worsening": {
              "description": "Worsening engineering parameter number (1-39). Provide it only together with improving.",
              "type": "integer",
            },
          },
          "type": "object",
        },
      }
    `)
  })

  it('marks sibling lookups concurrency-safe', () => {
    expect(createTrizTool().isConcurrencySafe?.({})).toBe(true)
  })

  it('lists the 39 parameters and 40 principles with no arguments', async () => {
    const host = await setupPlugin()
    const result = await execute(host, 'triz', {}, 'catalog')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected triz success')
    const value = result.value as { mode: string; parameters: { number: number }[]; principles: { number: number }[] }
    expect(value.mode).toBe('catalog')
    expect(value.parameters.length).toBe(39)
    expect(value.principles.length).toBe(40)
    expect(value.principles.map(p => p.number)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1))
    const rendered = text(result)
    expect(rendered).toContain('39 engineering parameters')
    expect(rendered).toContain('40 inventive principles')
  })

  it('looks up a contradiction-matrix cell for an improving/worsening pair', async () => {
    const host = await setupPlugin()
    const result = await execute(host, 'triz', { improving: 14, worsening: 1 }, 'lookup')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected triz success')
    const value = result.value as {
      mode: string
      improving: { number: number; label: string }
      worsening: { number: number; label: string }
      recommended: { number: number; name: string }[]
      separations: unknown[]
    }
    expect(value.mode).toBe('lookup')
    expect(value.improving).toEqual({ number: 14, label: '强度' })
    expect(value.worsening).toEqual({ number: 1, label: '运动物体重量' })
    expect(value.recommended.map(p => p.number)).toEqual([1, 8, 40, 15])
    expect(value.recommended.every(p => p.name.length > 0)).toBe(true)
    expect(value.separations).toEqual([])
    const rendered = text(result)
    expect(rendered).toContain('强度 (14)')
    expect(rendered).toContain('运动物体重量 (1)')
    expect(rendered).toContain('1, 8, 40, 15')
  })

  it('fails loudly when exactly one of improving/worsening is given', async () => {
    const host = await setupPlugin()
    const result = await execute(host, 'triz', { improving: 14 }, 'half-pair')
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('both improving and worsening')
  })

  it('returns separation principles for a diagonal physical contradiction', async () => {
    const host = await setupPlugin()
    const result = await execute(host, 'triz', { improving: 5, worsening: 5 }, 'diagonal')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected triz success')
    const value = result.value as {
      mode: string
      recommended: unknown[]
      separations: { name: string; description: string; signals: string[] }[]
    }
    expect(value.mode).toBe('lookup')
    expect(value.recommended).toEqual([])
    expect(value.separations).toHaveLength(5)
    expect(value.separations.map(separation => separation.name)).toEqual([
      'Separation in space',
      'Separation in time',
      'Separation by condition',
      'Separation in direction',
      'Separation between system and subsystem',
    ])
    expect(value.separations.every(separation => separation.description.length > 0 && separation.signals.length > 0)).toBe(true)
    const rendered = text(result)
    expect(rendered).toContain('Recommended principles: none.')
    expect(rendered).toContain('physical contradiction')
    expect(rendered).toContain('Separation in space')
    expect(rendered).toContain('Separation between system and subsystem')
  })

  it('reads an empty off-diagonal cell as a matrix gap, not a physical contradiction', async () => {
    const host = await setupPlugin()
    const cell = emptyOffDiagonalCell()
    const result = await execute(host, 'triz', cell, 'off-diagonal')
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected triz success')
    const value = result.value as { mode: string; recommended: unknown[]; separations: unknown[] }
    expect(value.mode).toBe('lookup')
    expect(value.recommended).toEqual([])
    expect(value.separations).toEqual([])
    const rendered = text(result)
    expect(rendered).toContain('Recommended principles: none.')
    expect(rendered).not.toContain('physical contradiction')
    expect(rendered).not.toContain('Separation principles:')
  })

  it('rejects an improving parameter outside 1-39', async () => {
    const host = await setupPlugin()
    const result = await execute(host, 'triz', { improving: 40, worsening: 1 }, 'bad-improving')
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('improving must be an integer 1-39')
  })

  it('rejects a worsening parameter outside 1-39', async () => {
    const host = await setupPlugin()
    const result = await execute(host, 'triz', { improving: 14, worsening: 0 }, 'bad-worsening')
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('worsening must be an integer 1-39')
  })

  it('render throws for an unknown mode (exhaustive default)', () => {
    const tool = createTrizTool()
    expect(() => tool.output.render({}, { mode: 'bogus' })).toThrow(/未知 TrizOutput mode/)
  })

  it('rejects a lookup output that omits its required fields', () => {
    const tool = createTrizTool()
    expect(validateJsonSchemaValue(tool.output.schema, { mode: 'lookup' }, 'value')).not.toEqual([])
  })

  it('unregisters the tool when its contributing fiber is disposed (HMR-safety)', async () => {
    const host = new Context()
    await host.plugin(SystemPrompt)
    await host.plugin(ToolRuntime)
    const fiber = await host.plugin(methodology, {})
    expect(host.tools.schemas().some(schema => schema.name === 'triz')).toBe(true)
    await fiber.dispose()
    expect(host.tools.schemas().some(schema => schema.name === 'triz')).toBe(false)
  })
})
