/**
 * The document preset names one writing style on both sides of the guide/gate
 * pairing: `doc-template.styleGuide` is the style whose guide the model is told
 * to write against, and `document_deliver.defaultStyle` is the style the quality
 * gate checks the delivered bytes against. Leaving either side unset hands it a
 * package default, so a rename that touched one row would silently split one
 * style into two behaviour sets — the model avoids words the gate accepts, or the
 * gate refuses words the model was never told about.
 *
 * This spec reads the preset the bundle ships. It does not re-check that the
 * named style exists: both packages fail their own load when it does not.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEntryYaml } from '@deepseek-ai/cordis-plugin-include'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
/** The bundle's shipped `document` preset declaration. */
const DOCUMENT_PRESET = join(REPO_ROOT, 'packages/bundle/web-app/presets/document.patch.yml')

/** One preset row: the fields this spec reads off a plugin entry. */
interface PresetRow {
  id?: unknown
  name?: unknown
  disabled?: unknown
  config?: unknown
}

/**
 * Find the row with `id` in a preset document.
 *
 * Entry lists nest three ways — a patch row's `insert`, a group row's `config`,
 * and the declared preset's `config.plugins` — so the search descends through
 * every value instead of the three keys by name.
 * @param node - a preset node, list, or scalar.
 * @param id - the row id to find.
 * @returns the row, or undefined when the document has no such row.
 */
function findRow(node: unknown, id: string): PresetRow | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findRow(child, id)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof node !== 'object' || node === null) return undefined
  const row = node as Record<string, unknown>
  if (row['id'] === id) return row
  for (const value of Object.values(row)) {
    const found = findRow(value, id)
    if (found !== undefined) return found
  }
  return undefined
}

/** Load the shipped document preset and return the row with `id`. */
async function rowOf(id: string): Promise<PresetRow | undefined> {
  const source = await readFile(DOCUMENT_PRESET, 'utf8')
  return findRow(parseEntryYaml(source), id)
}

/** The `config` object of a row, or an empty object when it declares none. */
function configOf(row: PresetRow | undefined): Record<string, unknown> {
  const config = row?.config
  return typeof config === 'object' && config !== null ? config as Record<string, unknown> : {}
}

describe('document preset style pairing', () => {
  it('enables both the guide row and the gate row', async () => {
    const guide = await rowOf('doc-template')
    const gate = await rowOf('tool-document-deliver')
    expect(guide?.name).toBe('@deepseek-ai/dsh-doc-template')
    expect(gate?.name).toBe('@deepseek-ai/dsh-document-deliver')
    expect(guide?.disabled).toBeUndefined()
    expect(gate?.disabled).toBeUndefined()
  })

  it('names the same non-empty style for the injected guide and the quality gate', async () => {
    const guideStyle = configOf(await rowOf('doc-template'))['styleGuide']
    const gateStyle = configOf(await rowOf('tool-document-deliver'))['defaultStyle']
    expect(typeof guideStyle).toBe('string')
    expect(guideStyle).not.toBe('')
    expect(gateStyle).toBe(guideStyle)
  })
})

/**
 * A delivery mode mounts the clock row (the P1 footer item in
 * `document-quality-gate` requires a document name, date, and version, and the
 * persona's "unsourced facts are withdrawn" rule covers the dates and versions
 * a document carries), the reminder tools, and both halves of the goal pair:
 * `command-goal` with `tool-goal`, since the web patch ships its own
 * `command-goal` row disabled and leaves the human command to the preset.
 * `scripts/preset-mode-baseline.json` holds every delivery mode to the shared
 * row set; this spec keeps the rows named here from disappearing behind a
 * policy edit.
 */
describe('document preset delivery rows', () => {
  it('mounts the clock, the reminder tools, and the goal command beside the goal tool', async () => {
    for (const [id, name] of [
      ['time-context', '@deepseek-ai/dsh-time-context'],
      ['tool-schedule', '@deepseek-ai/dsh-tool-schedule'],
      ['command-goal', '@deepseek-ai/dsh-command-goal'],
      ['tool-goal', '@deepseek-ai/dsh-tool-goal'],
    ] as const) {
      const row = await rowOf(id)
      expect(row?.name, `${id} row`).toBe(name)
      expect(row?.disabled, `${id} row`).toBeUndefined()
    }
  })

  it('declares no per-child composition the delegation tool rejects', async () => {
    for (const id of ['tool-subagent', 'tool-subagent-fork']) {
      const config = configOf(await rowOf(id))
      // `dsh-tool-subagent` fails its mount on either field; a preset carrying
      // one can never compose a new Session in this mode.
      expect(config['persona'], `${id} persona`).toBeUndefined()
      expect(config['toolFilter'], `${id} toolFilter`).toBeUndefined()
    }
  })
})
