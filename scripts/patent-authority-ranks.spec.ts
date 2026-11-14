/**
 * Check the authority rank table against the manifests and the recorded sources.
 *
 * The table is a draft, but a draft that names a case type no manifest runs, or
 * ranks a source the baseline does not record, would be cited as authority while
 * pointing at nothing. These cases keep the six case types tied to the eight
 * built-in manifests and every rank to a recorded source id.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { builtinPatentManifests } from '@deepseek-ai/dsh-patent-workflow'
import { IndexAssetError, parseYamlMapping, readMapping, readString, type AssetFail } from '@deepseek-ai/dsh-patent-index-asset'
import { parseAuthorityBaseline, AUTHORITY_BASELINE_PATH, AUTHORITY_RANKS_PATH } from './patent-authority-metrics.ts'

const fail: AssetFail = message => new IndexAssetError(message, AUTHORITY_RANKS_PATH)

/** One parsed case type row. */
interface CaseTypeRow {
  /** Case type id. */
  id: string
  /** Manifest ids the row covers. */
  manifests: string[]
  /** Source ids in rank order. */
  order: string[]
  /** Sources used for reference only. */
  reference: string[]
}

/**
 * Parse the rank table.
 * @param text - the YAML file contents.
 * @returns the case type rows and rule ids.
 */
function parseRanks(text: string): { caseTypes: CaseTypeRow[]; rules: string[] } {
  const root = parseYamlMapping(text, '权威位阶表', fail)
  const rawCaseTypes = root.caseTypes
  if (!Array.isArray(rawCaseTypes) || rawCaseTypes.length === 0) throw fail('caseTypes 必须是非空数组')
  const caseTypes = rawCaseTypes.map((entry, index) => {
    const where = `caseTypes[${index}]`
    const record = readMapping(entry, where, fail)
    const readList = (field: string): string[] => {
      const value = record[field]
      if (value === undefined) return []
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
        throw fail(`${where}.${field} 必须是字符串数组`)
      }
      return value as string[]
    }
    return {
      id: readString(record, 'id', fail),
      manifests: readList('manifests'),
      order: readList('order'),
      reference: readList('reference'),
    }
  })
  const rawRules = root.rules
  if (!Array.isArray(rawRules)) throw fail('rules 必须是数组')
  const rules = rawRules.map((entry, index) => readString(readMapping(entry, `rules[${index}]`, fail), 'id', fail))
  return { caseTypes, rules }
}

const ranks = parseRanks(readFileSync(new URL(`../${AUTHORITY_RANKS_PATH}`, import.meta.url), 'utf8'))
const baseline = parseAuthorityBaseline(readFileSync(new URL(`../${AUTHORITY_BASELINE_PATH}`, import.meta.url), 'utf8'))
const sourceIds = new Set(baseline.sources.map(source => source.id))

describe('authority ranks', () => {
  it('declares the six case types', () => {
    expect(ranks.caseTypes.map(row => row.id)).toEqual([
      'drafting',
      'prosecution-response',
      'reexamination',
      'invalidation',
      'infringement',
      'search-analysis',
    ])
  })

  it('covers every built-in manifest exactly once', () => {
    const covered = ranks.caseTypes.flatMap(row => row.manifests)
    expect([...covered].sort()).toEqual(builtinPatentManifests.map(manifest => manifest.id).sort())
    expect(new Set(covered).size).toBe(covered.length)
  })

  it('ranks only recorded sources', () => {
    for (const row of ranks.caseTypes) {
      for (const id of [...row.order, ...row.reference]) expect(sourceIds.has(id), `${row.id} -> ${id}`).toBe(true)
    }
  })

  it('puts the statute first and keeps the guideline as reference in infringement', () => {
    for (const row of ranks.caseTypes) expect(row.order[0]).toBe('patent-law')
    const infringement = ranks.caseTypes.find(row => row.id === 'infringement')
    expect(infringement?.reference).toEqual(['examination-guidelines'])
    expect(infringement?.order).toContain('patent-infringement-interpretation')
  })

  it('declares the four conflict rules', () => {
    expect(ranks.rules).toEqual([
      'higher-authority-wins',
      'special-provision-wins',
      'later-provision-wins',
      'guideline-never-overrides-statute',
    ])
  })
})
