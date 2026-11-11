import { describe, expect, it } from 'vitest'
import { loadMatrix, loadPrinciples, loadSeparations, validateTrizAssets } from '../src/data.ts'
import type { TrizAssets } from '../src/data.ts'

function shippedAssets(): TrizAssets {
  return {
    matrix: structuredClone(loadMatrix()),
    principles: structuredClone(loadPrinciples()),
    separations: structuredClone(loadSeparations()),
  }
}

/** Run validation once and return the rejection message for the assertions. */
function validationMessage(assets: TrizAssets): string {
  try {
    validateTrizAssets(assets)
  } catch (error) {
    if (error instanceof Error) return error.message
    throw error
  }
  throw new Error('expected validateTrizAssets to reject the asset set')
}

describe('TRIZ asset validation at plugin start', () => {
  it('accepts the shipped assets', () => {
    expect(() => { validateTrizAssets(shippedAssets()) }).not.toThrow()
  })

  it('reports every structural violation with the package name', () => {
    const broken: TrizAssets = {
      matrix: [[[0]], []],
      principles: [
        { no: 1, name: '', description: '' },
        { no: 1, name: '重复编号', description: 'x' },
      ],
      separations: [
        { id: 'same', name: '', description: '', signals: [] },
        { id: 'same', name: '重复 id', description: 'x', signals: ['signal'] },
        { id: 1 as never, name: 'x', description: 'y', signals: ['signal'] },
      ],
    }
    const message = validationMessage(broken)
    expect(message).toMatch(/^@deepseek-ai\/dsh-methodology: invalid TRIZ assets:/)
    expect(message).toMatch(/matrix has 2 rows/)
    expect(message).toMatch(/matrix row 2 has 0 columns/)
    expect(message).toMatch(/matrix cell \(1, 1\) holds 0/)
    expect(message).toMatch(/principles has 2 entries/)
    expect(message).toMatch(/principle 1 repeats/)
    expect(message).toMatch(/principle 1 has an empty or missing name or description/)
    expect(message).toMatch(/separation "same" repeats/)
    expect(message).toMatch(/separation entry 1 has an empty or missing id, name, or description/)
    expect(message).toMatch(/separation entry 3 has an empty or missing id, name, or description/)
    expect(message).toMatch(/separation "same" has no signals/)
  })

  it('rejects a non-array matrix or row', () => {
    const matrix = shippedAssets()
    matrix.matrix = null as never
    expect(validationMessage(matrix)).toMatch(/matrix is not an array/)

    const row = shippedAssets()
    row.matrix = [null as never]
    expect(validationMessage(row)).toMatch(/matrix row 1 is not an array/)
  })

  it('rejects a non-array matrix cell', () => {
    const assets = shippedAssets()
    assets.matrix[0]![0] = null as never
    expect(validationMessage(assets)).toMatch(/matrix cell \(1, 1\) is not an array/)
  })

  it('rejects a non-array principles catalog or a non-object entry', () => {
    const catalog = shippedAssets()
    catalog.principles = null as never
    expect(validationMessage(catalog)).toMatch(/principles is not an array/)

    const entry = shippedAssets()
    entry.principles[0] = null as never
    expect(validationMessage(entry)).toMatch(/principle entry 1 is not an object/)
  })

  it('rejects principle numbers outside 1-40 and reports the gaps', () => {
    const assets = shippedAssets()
    assets.principles = assets.principles.map((principle, index) => ({ ...principle, no: index + 41 }))
    const message = validationMessage(assets)
    expect(message).toMatch(/principle 41 is outside the integers 1-40/)
    expect(message).toMatch(/principles is missing numbers 1, 2, 3/)
  })

  it('rejects a non-array separations catalog or a non-object entry', () => {
    const catalog = shippedAssets()
    catalog.separations = null as never
    expect(validationMessage(catalog)).toMatch(/separations is not an array/)

    const entry = shippedAssets()
    entry.separations[0] = null as never
    expect(validationMessage(entry)).toMatch(/separation entry 1 is not an object/)
  })

  it('rejects missing separation signals', () => {
    const assets = shippedAssets()
    assets.separations[0]!.signals = undefined as never
    expect(validationMessage(assets)).toMatch(/separation "space" has no signals/)
  })

  it('rejects a separation signal that is empty or not a string', () => {
    const assets = shippedAssets()
    assets.separations[0]!.signals = [123 as never, null as never, { text: 'x' } as never]
    const message = validationMessage(assets)
    expect(message).toMatch(/separation "space" signal 1 is empty or not a string/)
    expect(message).toMatch(/separation "space" signal 2 is empty or not a string/)
    expect(message).toMatch(/separation "space" signal 3 is empty or not a string/)

    const empty = shippedAssets()
    empty.separations[0]!.signals = ['']
    expect(validationMessage(empty)).toMatch(/separation "space" signal 1 is empty or not a string/)
  })

  it('rejects an empty separation catalog', () => {
    const assets = shippedAssets()
    assets.separations = []
    expect(validationMessage(assets)).toMatch(/separations has 0 entries, expected 5/)
  })

  it('rejects a non-integer matrix principle above 40', () => {
    const assets = shippedAssets()
    assets.matrix[0]![0] = [1.5, 41]
    expect(validationMessage(assets)).toMatch(/expected an integer 1-40/)
  })
})
