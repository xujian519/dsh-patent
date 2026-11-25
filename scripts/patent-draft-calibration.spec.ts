import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'

import {
  AXIS_HIGHER_IS_BETTER,
  CALIBRATION_ARTIFACT_FILE,
  CALIBRATION_AXES,
  CALIBRATION_REGENERATE_COMMAND,
  CALIBRATION_SCHEMA_VERSION,
  bandForSimilarity,
  buildArtifact,
  buildCalibrationCases,
  caseAlias,
  characterSimilarity,
  compareArtifacts,
  contentCharacters,
  corpusDigest,
  deltaFor,
  directionFor,
  findCalibrationLeaks,
  foldLedgerView,
  measureDraft,
  parseCalibrationArtifact,
  parseCalibrationManifest,
  percentile,
  readCalibrationPairs,
  renderCalibrationReport,
  stripBom,
  summarizeCases,
  tallyLintRules,
  verifyCalibrationArtifact,
  type CalibrationArtifact,
  type CalibrationAxis,
  type CalibrationDirection,
  type DraftCase,
  type DraftReadings,
} from './patent-draft-calibration.ts'

/** Claims with two definite structural defects: a gap in the numbering and a missing terminator. */
const MESSY_CLAIMS = [
  '1. 一种传动装置，包括：主动齿轮；从动齿轮，用于传递扭矩。',
  '3. 根据权利要求1所述的传动装置，所述主动齿轮为钢制。所述从动齿轮设置在壳体上，以提高传动效率。',
].join('\n')

/** The same two claims after the amendments the band is meant to detect. */
const CLEAN_CLAIMS = [
  '1. 一种传动装置，包括：主动齿轮；从动齿轮，所述从动齿轮与所述主动齿轮啮合。',
  '2. 根据权利要求1所述的传动装置，所述主动齿轮为钢制。',
].join('\n')

/** Readings with no findings and both gates passing. */
const BASE_READINGS: DraftReadings = {
  claimCount: 2,
  lintErrors: 0,
  lintWarnings: 0,
  specViolations: 0,
  lintRules: {},
  specScore: 1,
  slopTotal: 60,
  specAssessed: true,
  specPassed: true,
  slopAssessed: true,
  slopPassed: true,
}

/**
 * One calibrated row built from reading overrides, with directions derived.
 * @param alias - Opaque case alias.
 * @param pre - Fields that differ from a clean pre-amendment reading.
 * @param post - Fields that differ from a clean amended reading.
 * @param similarity - Edit-size similarity.
 * @returns The row.
 */
function makeCase(
  alias: string,
  pre: Partial<DraftReadings> = {},
  post: Partial<DraftReadings> = {},
  similarity = 0.9,
): DraftCase {
  const before: DraftReadings = { ...BASE_READINGS, ...pre }
  const after: DraftReadings = { ...BASE_READINGS, ...post }
  const direction = {
    'lint-errors': directionFor(before, after, 'lint-errors'),
    'lint-warnings': directionFor(before, after, 'lint-warnings'),
    'spec-violations': directionFor(before, after, 'spec-violations'),
    'spec-score': directionFor(before, after, 'spec-score'),
    'slop-total': directionFor(before, after, 'slop-total'),
  }
  return { alias, similarity, band: bandForSimilarity(similarity), pre: before, post: after, direction }
}

/** Thresholds that pass for a one-row corpus. */
function thresholds(overrides: Partial<{ minPairs: number; minAgreement: number; agreementAxes: CalibrationAxis[] }> = {}) {
  return { minPairs: 1, minAgreement: 0.6, agreementAxes: ['lint-errors' as CalibrationAxis], ...overrides }
}

/** Temporary directories created by a test, removed afterwards. */
const roots: string[] = []

/**
 * Create a scratch directory that is removed when the test finishes.
 * @param prefix - Name fragment for the directory.
 * @returns The absolute path.
 */
function scratch(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `dsh-${prefix}-`))
  roots.push(root)
  return root
}

/**
 * Write one corpus file.
 * @param dir - Corpus directory.
 * @param name - File name.
 * @param text - Content.
 */
function writeCase(dir: string, name: string, text: string): void {
  writeFileSync(join(dir, name), text, 'utf8')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('text normalization', () => {
  it('drops a byte-order mark and folds carriage returns', () => {
    expect(stripBom('\uFEFFa\r\nb\r')).toBe('a\nb\n')
    expect(stripBom('plain')).toBe('plain')
  })

  it('keeps letters and digits and drops punctuation and whitespace', () => {
    expect(contentCharacters('1. 一种装置，包括：A；\n')).toBe('1一种装置包括a')
  })
})

describe('characterSimilarity and banding', () => {
  it('reads 1 for identical content and 0 for disjoint content', () => {
    expect(characterSimilarity('权利要求', '权利要求')).toBe(1)
    expect(characterSimilarity('aaa', 'bbb')).toBe(0)
  })

  it('treats two empty sides as equal and one empty side as wholly different', () => {
    expect(characterSimilarity('', '')).toBe(1)
    expect(characterSimilarity('abc', '')).toBe(0)
  })

  it('reads higher than an alignment measure for reordered text', () => {
    // A character multiset ignores order, which is why the band is a size hint.
    expect(characterSimilarity('abcdef', 'fdebca')).toBe(1)
  })

  it('places similarities on the documented band boundaries', () => {
    expect(bandForSimilarity(0.95)).toBe('tweak')
    expect(bandForSimilarity(0.94)).toBe('surgical')
    expect(bandForSimilarity(0.8)).toBe('surgical')
    expect(bandForSimilarity(0.79)).toBe('rewrite')
    expect(bandForSimilarity(0.5)).toBe('rewrite')
    expect(bandForSimilarity(0.49)).toBe('replace')
  })
})

describe('caseAlias', () => {
  it('is stable, letter-only, and distinguishes stems', () => {
    const alias = caseAlias('sofc1')
    expect(alias).toBe(caseAlias('sofc1'))
    expect(alias).toMatch(/^[a-p]{10}$/u)
    expect(caseAlias('sofc2')).not.toBe(alias)
  })
})

describe('parseCalibrationManifest', () => {
  it('reads entries in manifest order', () => {
    const entries = parseCalibrationManifest(
      'pairs:\n  - { stem: b, pre: b-a.txt, post: b-b.txt }\n  - { stem: a, pre: a-a.txt, post: a-b.txt }\n',
    )
    expect(entries.map(entry => entry.stem)).toEqual(['b', 'a'])
    expect(entries[1]).toEqual({ stem: 'a', pre: 'a-a.txt', post: 'a-b.txt' })
  })

  it('rejects a document that is not YAML', () => {
    expect(() => parseCalibrationManifest('pairs: [')).toThrow('manifest is not valid YAML')
  })

  it('rejects a missing pair list', () => {
    expect(() => parseCalibrationManifest('cases: []')).toThrow('manifest.pairs is not an array')
  })

  it('rejects an entry missing a side', () => {
    expect(() => parseCalibrationManifest('pairs:\n  - { stem: a, pre: a.txt }\n')).toThrow('pairs[0].post is not a string')
  })

  it('rejects naming one file on both sides', () => {
    expect(() => parseCalibrationManifest('pairs:\n  - { stem: a, pre: a.txt, post: a.txt }\n'))
      .toThrow('names the same file on both sides')
  })

  it('rejects a repeated stem or a reused file', () => {
    expect(() => parseCalibrationManifest(
      'pairs:\n  - { stem: a, pre: 1.txt, post: 2.txt }\n  - { stem: a, pre: 3.txt, post: 4.txt }\n',
    )).toThrow('pairs[1] repeats stem a')
    expect(() => parseCalibrationManifest(
      'pairs:\n  - { stem: a, pre: 1.txt, post: 2.txt }\n  - { stem: b, pre: 2.txt, post: 3.txt }\n',
    )).toThrow('pairs[1] reuses file 2.txt')
  })

  it('refuses a YAML custom tag rather than evaluating it', () => {
    expect(() => parseCalibrationManifest('pairs: !!js/function "function(){ return [] }"\n')).toThrow()
  })
})

describe('readCalibrationPairs', () => {
  it('reads the named files from the corpus directory', () => {
    const dir = scratch('draft-calibration-corpus')
    writeCase(dir, 'x-pre.txt', MESSY_CLAIMS)
    writeCase(dir, 'x-post.txt', CLEAN_CLAIMS)
    const pairs = readCalibrationPairs(dir, [{ stem: 'x', pre: 'x-pre.txt', post: 'x-post.txt' }])
    expect(pairs).toHaveLength(1)
    expect(pairs[0]?.pre).toBe(MESSY_CLAIMS)
  })

  it('fails on a missing directory, a missing file, and a name that escapes', () => {
    const dir = scratch('draft-calibration-escape')
    writeCase(dir, 'inside.txt', CLEAN_CLAIMS)
    expect(() => readCalibrationPairs(join(dir, 'absent'), [{ stem: 'a', pre: 'inside.txt', post: 'inside.txt' }]))
      .toThrow('corpus directory is missing')
    expect(() => readCalibrationPairs(dir, [{ stem: 'a', pre: 'gone.txt', post: 'inside.txt' }]))
      .toThrow('manifest file is missing: gone.txt')
    const outside = scratch('draft-calibration-outside')
    writeFileSync(join(outside, 'leak.txt'), 'outside the corpus', 'utf8')
    expect(() => readCalibrationPairs(outside, [{ stem: 'a', pre: '../draft-calibration-outside/leak.txt', post: 'leak.txt' }]))
      .toThrow('manifest file escapes the corpus directory')
  })
})

describe('measureDraft', () => {
  it('reports the parsed claims and the per-rule tally', async () => {
    const readings = await measureDraft(MESSY_CLAIMS)
    expect(readings.claimCount).toBe(2)
    expect(readings.lintErrors).toBeGreaterThan(0)
    expect(Object.keys(readings.lintRules).sort()).toEqual(
      Object.entries(readings.lintRules).filter(([, count]) => count > 0).map(([key]) => key).sort(),
    )
    expect(readings.specScore).toBeGreaterThanOrEqual(0)
    expect(readings.specScore).toBeLessThanOrEqual(1)
    expect(readings.slopTotal).toBeGreaterThanOrEqual(0)
  })

  it('counts the sum of rule findings as the error and warning totals', async () => {
    const readings = await measureDraft(MESSY_CLAIMS)
    const errors = Object.entries(readings.lintRules)
      .filter(([key]) => key.endsWith(':error'))
      .reduce((sum, [, count]) => sum + count, 0)
    expect(errors).toBe(readings.lintErrors)
  })
})

describe('direction and delta', () => {
  it('classifies movement by whether it follows the axis preference', () => {
    expect(directionFor(BASE_READINGS, makeReadings({ lintErrors: 3 }), 'lint-errors')).toBe('regressed')
    expect(directionFor(makeReadings({ lintErrors: 3 }), BASE_READINGS, 'lint-errors')).toBe('improved')
    expect(directionFor(BASE_READINGS, makeReadings({ lintErrors: 3 }), 'lint-errors')).toBe('regressed')
    expect(directionFor(BASE_READINGS, makeReadings({ slopTotal: 20 }), 'slop-total')).toBe('regressed')
    expect(directionFor(BASE_READINGS, makeReadings({ specScore: 0.5 }), 'spec-score')).toBe('regressed')
    expect(directionFor(BASE_READINGS, BASE_READINGS, 'spec-score')).toBe('unchanged')
  })

  it('signs the delta so a positive value always means improvement', () => {
    expect(deltaFor(makeReadings({ lintErrors: 4 }), BASE_READINGS, 'lint-errors')).toBe(4)
    expect(deltaFor(BASE_READINGS, makeReadings({ lintWarnings: 2 }), 'lint-warnings')).toBe(-2)
    expect(deltaFor(BASE_READINGS, makeReadings({ slopTotal: 80 }), 'slop-total')).toBe(20)
    expect(AXIS_HIGHER_IS_BETTER['spec-violations']).toBe(false)
  })

  it('keeps every axis in one of three states', () => {
    const states: CalibrationDirection[] = ['improved', 'unchanged', 'regressed']
    expect(states).toContain(directionFor(makeReadings({ specViolations: 1 }), BASE_READINGS, 'spec-violations'))
  })
})

function makeReadings(overrides: Partial<DraftReadings>): DraftReadings {
  return { ...BASE_READINGS, ...overrides }
}

describe('percentile', () => {
  it('uses nearest rank and reports 0 for an empty list', () => {
    expect(percentile([], 50)).toBe(0)
    expect(percentile([1, 2, 3, 4], 50)).toBe(2)
    expect(percentile([1, 2, 3, 4], 90)).toBe(4)
    expect(percentile([1, 2, 3, 4], 10)).toBe(1)
    expect(percentile([7], 0)).toBe(7)
  })
})

describe('summarizeCases', () => {
  it('counts movement and leaves agreement null when nothing moved', () => {
    const cases = [
      makeCase('aaaaaaaaaa', { lintErrors: 5 }, {}, 0.99),
      makeCase('bbbbbbbbbb', {}, {}, 0.6),
    ]
    const summary = summarizeCases(cases)
    expect(summary.pairs).toBe(2)
    expect(summary.perAxis['lint-errors']).toEqual({
      improved: 1, unchanged: 1, regressed: 0, agreement: 1, medianDelta: 0,
    })
    expect(summary.perAxis['slop-total'].agreement).toBeNull()
  })

  it('describes the amended side with percentiles and its own pass rate', () => {
    const cases = [
      makeCase('aaaaaaaaaa', {}, { lintErrors: 0 }, 0.99),
      makeCase('bbbbbbbbbb', {}, { lintErrors: 4 }, 0.6),
      makeCase('cccccccccc', {}, { lintErrors: 9 }, 0.2),
    ]
    const reference = summarizeCases(cases).reference['lint-errors']
    expect(reference).toEqual({ p10: 0, median: 4, p90: 9, passRate: 0.333 })
  })

  it('reports a zero pass rate against the gate line for a failing side', () => {
    const summary = summarizeCases([makeCase('aaaaaaaaaa', {}, { slopTotal: 10, slopPassed: false }, 0.99)])
    expect(summary.reference['slop-total'].passRate).toBe(0)
    expect(summary.reference['spec-score'].passRate).toBe(1)
  })

  it('tallies rules across both sides and counts the cases that fired', () => {
    const cases = [
      makeCase('aaaaaaaaaa', { lintRules: { 'numbering:error': 2 }, lintErrors: 2 }, { lintRules: { 'numbering:error': 1 }, lintErrors: 1 }),
      makeCase('bbbbbbbbbb', { lintRules: { 'terminator:error': 3 }, lintErrors: 3 }, {}),
    ]
    expect(tallyLintRules(cases)).toEqual([
      { rule: 'numbering:error', preFindings: 2, postFindings: 1, cases: 1 },
      { rule: 'terminator:error', preFindings: 3, postFindings: 0, cases: 1 },
    ])
    expect(summarizeCases(cases).lintRules).toHaveLength(2)
  })
})

describe('corpusDigest', () => {
  it('is independent of row order and tracks the similarity', () => {
    const left = makeCase('aaaaaaaaaa', {}, {}, 0.9)
    const right = makeCase('bbbbbbbbbb', {}, {}, 0.5)
    expect(corpusDigest([left, right])).toBe(corpusDigest([right, left]))
    expect(corpusDigest([left, right])).not.toBe(corpusDigest([makeCase('aaaaaaaaaa', {}, {}, 0.91), right]))
    expect(corpusDigest([left])).toMatch(/^sha256:[0-9a-f]{64}$/u)
  })
})

describe('buildCalibrationCases', () => {
  it('measures each pair, bands it, and sorts the rows by alias', async () => {
    const cases = await buildCalibrationCases([
      { stem: 'beta', pre: MESSY_CLAIMS, post: CLEAN_CLAIMS },
      { stem: 'alpha', pre: CLEAN_CLAIMS, post: CLEAN_CLAIMS },
    ])
    expect(cases.map(entry => entry.alias)).toEqual([caseAlias('alpha'), caseAlias('beta')].sort())
    const moved = cases.find(entry => entry.alias === caseAlias('beta'))
    if (moved === undefined) throw new Error('beta pair is missing from the rows')
    expect(moved.direction['lint-errors']).toBe('improved')
    expect(moved.band).toBe(bandForSimilarity(moved.similarity))
    const still = cases.find(entry => entry.alias === caseAlias('alpha'))
    if (still === undefined) throw new Error('alpha pair is missing from the rows')
    expect(still.similarity).toBe(1)
    expect(still.band).toBe('tweak')
  })
})

describe('artifact round trip', () => {
  it('writes and reads an artifact unchanged', () => {
    const artifact = buildArtifact([makeCase('aaaaaaaaaa', { lintErrors: 3 })], thresholds(), CALIBRATION_REGENERATE_COMMAND)
    expect(parseCalibrationArtifact(JSON.stringify(artifact))).toEqual(artifact)
    expect(artifact.schema).toBe(CALIBRATION_SCHEMA_VERSION)
    expect(artifact.axes).toEqual([...CALIBRATION_AXES])
    expect(verifyCalibrationArtifact(artifact)).toEqual([])
    expect(CALIBRATION_ARTIFACT_FILE).toBe('packages/self-evolve/evaluation/patent-draft-calibration.json')
  })

  it('rejects a foreign schema version before reading any row', () => {
    const artifact = buildArtifact([makeCase('aaaaaaaaaa')], thresholds(), CALIBRATION_REGENERATE_COMMAND)
    const text = JSON.stringify({ ...artifact, schema: CALIBRATION_SCHEMA_VERSION + 1 })
    expect(() => parseCalibrationArtifact(text)).toThrow('artifact schema 2 is not 1')
  })

  it('rejects malformed JSON and a non-object root', () => {
    expect(() => parseCalibrationArtifact('{')).toThrow('artifact is not valid JSON')
    expect(() => parseCalibrationArtifact('[]')).toThrow('artifact is not an object')
  })

  const rejections: Array<[string, (json: Record<string, unknown>) => Record<string, unknown>]> = [
    ['a string where a number belongs', (json: Record<string, unknown>) => ({ ...json, schema: 'one' })],
    ['an unknown axis', (json: Record<string, unknown>) => ({ ...json, axes: ['lint-moons'] })],
    ['an unknown band', (json: Record<string, unknown>) => {
      const cases = json.cases as Record<string, unknown>[]
      return { ...json, cases: [{ ...cases[0], band: 'polish' }] }
    }],
    ['an unknown direction', (json: Record<string, unknown>) => {
      const cases = json.cases as Record<string, unknown>[]
      const direction = cases[0]?.direction as Record<string, unknown>
      return { ...json, cases: [{ ...cases[0], direction: { ...direction, 'slop-total': 'sideways' } }] }
    }],
    ['a rule key carrying text', (json: Record<string, unknown>) => {
      const cases = json.cases as Record<string, unknown>[]
      const pre = cases[0]?.pre as Record<string, unknown>
      return { ...json, cases: [{ ...cases[0], pre: { ...pre, lintRules: { '一种装置:error': 1 } } }] }
    }],
    ['a negative count', (json: Record<string, unknown>) => {
      const cases = json.cases as Record<string, unknown>[]
      const pre = cases[0]?.pre as Record<string, unknown>
      return { ...json, cases: [{ ...cases[0], pre: { ...pre, lintErrors: -1 } }] }
    }],
    ['a missing summary block', (json: Record<string, unknown>) => {
      const summary = json.summary as Record<string, unknown>
      return { ...json, summary: { ...summary, perAxis: undefined } }
    }],
    ['a perAxis block for one axis', (json: Record<string, unknown>) => {
      const summary = json.summary as Record<string, unknown>
      const perAxis = { ...(summary.perAxis as Record<string, unknown>) }
      delete perAxis['spec-score']
      return { ...json, summary: { ...summary, perAxis } }
    }],
    ['a reference block for one axis', (json: Record<string, unknown>) => {
      const summary = json.summary as Record<string, unknown>
      const reference = { ...(summary.reference as Record<string, unknown>) }
      delete reference['slop-total']
      return { ...json, summary: { ...summary, reference } }
    }],
    ['a null agreement typed as a number', (json: Record<string, unknown>) => {
      const summary = json.summary as Record<string, unknown>
      const perAxis = summary.perAxis as Record<string, unknown>
      const tally = perAxis['lint-errors'] as Record<string, unknown>
      return { ...json, summary: { ...summary, perAxis: { ...perAxis, 'lint-errors': { ...tally, agreement: 'high' } } } }
    }],
    ['an unknown threshold axis', (json: Record<string, unknown>) => {
      const thresholdsBlock = json.thresholds as Record<string, unknown>
      return { ...json, thresholds: { ...thresholdsBlock, agreementAxes: ['slop-moons'] } }
    }],
  ]
  it.each(rejections)('rejects %s', (_label, mutate) => {
    const artifact = buildArtifact([makeCase('aaaaaaaaaa', { lintErrors: 3 })], thresholds(), CALIBRATION_REGENERATE_COMMAND)
    const json = mutate(JSON.parse(JSON.stringify(artifact)) as Record<string, unknown>)
    expect(() => parseCalibrationArtifact(JSON.stringify(json))).toThrow(/^patent-draft-calibration: /u)
  })
})

describe('findCalibrationLeaks', () => {
  /** An artifact whose recorded command carries arbitrary text, standing in for a leak path. */
  function artifactWithStrings(generatedBy: string, alias = 'aaaaaaaaaa'): CalibrationArtifact {
    return buildArtifact([makeCase(alias)], thresholds(), generatedBy)
  }

  it('accepts a clean artifact whose digest holds a long digit run', () => {
    const artifact = artifactWithStrings(CALIBRATION_REGENERATE_COMMAND)
    // The scan covers the fields that can carry text, not the numeric encoding behind them.
    const numeric = { ...artifact, corpusDigest: `sha256:${'0'.repeat(20)}1234567890123${'a'.repeat(20)}` }
    expect(findCalibrationLeaks(numeric)).toEqual([])
  })

  it('flags an application number and a party field', () => {
    expect(findCalibrationLeaks(artifactWithStrings('cases CN2018101234567 submitted'))).toContain('patent or application number')
    expect(findCalibrationLeaks(artifactWithStrings('申请人某某'))).toContain('申请人 field')
  })

  it('flags a run of source text', () => {
    const leaks = findCalibrationLeaks({
      ...artifactWithStrings(CALIBRATION_REGENERATE_COMMAND),
      cases: [makeCase('权利要求一种装置')],
    })
    expect(leaks.join('\n')).toContain('source text run')
  })

  it('flags a duplicated alias', () => {
    const artifact = buildArtifact(
      [makeCase('aaaaaaaaaa'), makeCase('aaaaaaaaaa')],
      thresholds(),
      CALIBRATION_REGENERATE_COMMAND,
    )
    expect(findCalibrationLeaks(artifact)).toContain('duplicate case alias')
  })
})

describe('verifyCalibrationArtifact', () => {
  /** Two rows that both move in the professional's direction. */
  function corpus(): DraftCase[] {
    return [makeCase('aaaaaaaaaa', { lintErrors: 3 }), makeCase('bbbbbbbbbb', { lintErrors: 2 })]
  }

  it('accepts a self-consistent artifact', () => {
    expect(verifyCalibrationArtifact(buildArtifact(corpus(), thresholds(), CALIBRATION_REGENERATE_COMMAND))).toEqual([])
  })

  it('stops on a foreign schema version', () => {
    const artifact = buildArtifact(corpus(), thresholds(), CALIBRATION_REGENERATE_COMMAND)
    expect(verifyCalibrationArtifact({ ...artifact, schema: 999 })).toEqual(['artifact schema 999 is not 1'])
  })

  it('recomputes the digest', () => {
    const artifact = buildArtifact(corpus(), thresholds(), CALIBRATION_REGENERATE_COMMAND)
    expect(verifyCalibrationArtifact({ ...artifact, corpusDigest: 'sha256:0' }))
      .toContain('corpusDigest does not match cases')
  })

  it('rejects rows that are not sorted by alias', () => {
    const artifact = buildArtifact(corpus(), thresholds(), CALIBRATION_REGENERATE_COMMAND)
    const reversed = [...artifact.cases].reverse()
    expect(verifyCalibrationArtifact({ ...artifact, cases: reversed })).toContain('cases are not sorted by alias')
  })

  it('catches an edited aggregate', () => {
    const artifact = buildArtifact(
      [
        makeCase('aaaaaaaaaa', { lintErrors: 3, lintRules: { 'numbering:error': 3 } }),
        makeCase('bbbbbbbbbb', { lintErrors: 2, lintRules: { 'terminator:error': 2 } }),
      ],
      thresholds({ minPairs: 12 }),
      CALIBRATION_REGENERATE_COMMAND,
    )
    const inflated: CalibrationArtifact = {
      ...artifact,
      summary: {
        ...artifact.summary,
        pairs: 5,
        perAxis: { ...artifact.summary.perAxis, 'lint-errors': { ...artifact.summary.perAxis['lint-errors'], improved: 5, agreement: 1 } },
        reference: { ...artifact.summary.reference, 'lint-errors': { ...artifact.summary.reference['lint-errors'], passRate: 0.5 } },
        lintRules: [],
      },
    }
    const problems = verifyCalibrationArtifact(inflated)
    expect(problems).toContain('summary.pairs does not match the rows')
    expect(problems).toContain('summary.perAxis.lint-errors does not match the rows')
    expect(problems).toContain('summary.reference.lint-errors does not match the rows')
    expect(problems).toContain('summary.lintRules does not match the rows')
    expect(problems).toContain('5 pairs is below the declared minimum 12')
  })

  it('names the axis block whose aggregate moved', () => {
    const artifact = buildArtifact(corpus(), thresholds(), CALIBRATION_REGENERATE_COMMAND)
    const moved = { ...artifact.summary.perAxis['spec-score'], medianDelta: 7 }
    const problems = verifyCalibrationArtifact({
      ...artifact,
      summary: { ...artifact.summary, perAxis: { ...artifact.summary.perAxis, 'spec-score': moved } },
    })
    expect(problems).toContain('summary.perAxis.spec-score does not match the rows')
  })

  it('catches a stale band and a direction that contradicts its readings', () => {
    const row = makeCase('aaaaaaaaaa', { lintErrors: 3 }, {}, 0.9)
    const artifact = buildArtifact([row, makeCase('bbbbbbbbbb', { lintErrors: 2 })], thresholds(), CALIBRATION_REGENERATE_COMMAND)
    const stale: DraftCase = { ...row, band: 'replace' }
    const contradicted: DraftCase = { ...row, direction: { ...row.direction, 'lint-errors': 'regressed' } }
    const problems = verifyCalibrationArtifact({ ...artifact, cases: [stale, contradicted] })
    expect(problems).toContain('case aaaaaaaaaa band is stale')
    expect(problems).toContain('case aaaaaaaaaa direction for lint-errors does not match its readings')
  })

  it('refuses a corpus below the declared pair floor', () => {
    const artifact = buildArtifact(corpus(), thresholds({ minPairs: 12 }), CALIBRATION_REGENERATE_COMMAND)
    expect(verifyCalibrationArtifact(artifact)).toContain('2 pairs is below the declared minimum 12')
  })

  it('refuses a declared axis that no pair moved', () => {
    const artifact = buildArtifact(
      [makeCase('aaaaaaaaaa'), makeCase('bbbbbbbbbb')],
      thresholds({ agreementAxes: ['spec-violations'] }),
      CALIBRATION_REGENERATE_COMMAND,
    )
    expect(verifyCalibrationArtifact(artifact)).toContain('spec-violations is declared but no pair moved it')
  })

  it('refuses an agreement below the declared floor', () => {
    const artifact = buildArtifact(
      [makeCase('aaaaaaaaaa', {}, { lintErrors: 4 }), makeCase('bbbbbbbbbb', { lintErrors: 4 })],
      thresholds({ agreementAxes: ['lint-errors'] }),
      CALIBRATION_REGENERATE_COMMAND,
    )
    expect(verifyCalibrationArtifact(artifact)).toContain('lint-errors agreement 0.5 is below 0.6')
  })
})

describe('compareArtifacts', () => {
  /**
   * A copy of the committed artifact with one row's readings changed.
   * @param artifact - Baseline artifact.
   * @returns The modified copy.
   */
  function changeOneReading(artifact: CalibrationArtifact): CalibrationArtifact {
    const cases = artifact.cases.map((entry, index) => (index === 0 ? { ...entry, post: { ...entry.post, lintErrors: 7 } } : entry))
    return { ...artifact, cases, summary: summarizeCases(cases), corpusDigest: corpusDigest(cases) }
  }

  it('accepts a matching re-measurement', () => {
    const artifact = buildArtifact(
      [makeCase('aaaaaaaaaa', { lintErrors: 3 }), makeCase('bbbbbbbbbb', { lintErrors: 2 })],
      thresholds(),
      CALIBRATION_REGENERATE_COMMAND,
    )
    expect(compareArtifacts(artifact, JSON.parse(JSON.stringify(artifact)) as CalibrationArtifact)).toEqual([])
  })

  it('names the row whose readings moved and the aggregates that follow', () => {
    const committed = buildArtifact(
      [makeCase('aaaaaaaaaa', { lintErrors: 3 }), makeCase('bbbbbbbbbb', { lintErrors: 2 })],
      thresholds(),
      CALIBRATION_REGENERATE_COMMAND,
    )
    const problems = compareArtifacts(committed, changeOneReading(committed))
    expect(problems).toContain('case aaaaaaaaaa readings changed')
    expect(problems).toContain('summary changed')
    expect(problems.some(problem => problem.startsWith('corpusDigest changed'))).toBe(false)
  })

  it('reports a corpus that gained or lost a pair', () => {
    const committed = buildArtifact([makeCase('aaaaaaaaaa'), makeCase('bbbbbbbbbb')], thresholds(), CALIBRATION_REGENERATE_COMMAND)
    const measured = buildArtifact([makeCase('aaaaaaaaaa'), makeCase('cccccccccc')], thresholds(), CALIBRATION_REGENERATE_COMMAND)
    expect(compareArtifacts(committed, measured)).toEqual([
      expect.stringContaining('corpusDigest changed'),
      'case bbbbbbbbbb is no longer measurable from the corpus',
      'case cccccccccc is new in the corpus',
    ])
  })

  it('flags a changed recorded command, axis list, or thresholds', () => {
    const committed = buildArtifact([makeCase('aaaaaaaaaa'), makeCase('bbbbbbbbbb')], thresholds(), CALIBRATION_REGENERATE_COMMAND)
    expect(compareArtifacts(committed, { ...committed, generatedBy: 'tsx other.ts' })).toContain(
      `generatedBy changed: ${CALIBRATION_REGENERATE_COMMAND} -> tsx other.ts`,
    )
    expect(compareArtifacts(committed, { ...committed, axes: ['slop-total'] })).toContain('axes changed')
    expect(compareArtifacts(committed, { ...committed, thresholds: thresholds({ minAgreement: 0.9 }) })).toContain('thresholds changed')
  })
})

describe('renderCalibrationReport', () => {
  it('prints the movement table, the bands, and the rule tally', () => {
    const artifact = buildArtifact(
      [makeCase('aaaaaaaaaa', { lintErrors: 3, lintRules: { 'numbering:error': 3 } }, {}, 0.99), makeCase('bbbbbbbbbb', {}, {}, 0.4)],
      thresholds(),
      CALIBRATION_REGENERATE_COMMAND,
    )
    const report = renderCalibrationReport(artifact)
    expect(report).toContain('`lint-errors` | 1 | 1 | 0 | 1.000 |')
    expect(report).toContain('微调 1')
    expect(report).toContain('替换 1')
    expect(report).toContain('| `numbering:error` | 3 | 0 | 1 |')
    expect(report).toContain('不分专利类型')
    expect(report).toContain('账本可折叠部分')
  })
})

describe('foldLedgerView', () => {
  it('judges only the spec-check row on external text', async () => {
    const summary = foldLedgerView(await measureDraft(CLEAN_CLAIMS))
    expect(summary.verdicts).toHaveLength(5)
    expect(summary.assessed).toBe(1)
    expect(summary.unassessed).toBe(4)
    expect(summary.passedAll).toBe(false)
    expect(summary.verdicts[0]?.status).toBe('passed')
  })
})

describe('the committed artifact', () => {
  it('reproduces from its own rows', () => {
    const text = readFileSync(join(import.meta.dirname, '..', CALIBRATION_ARTIFACT_FILE), 'utf8')
    const artifact = parseCalibrationArtifact(text)
    expect(verifyCalibrationArtifact(artifact)).toEqual([])
    expect(artifact.summary.pairs).toBeGreaterThanOrEqual(artifact.thresholds.minPairs)
    expect(findCalibrationLeaks(artifact)).toEqual([])
    // Every stored file ends with exactly one trailing newline.
    expect(text.endsWith('\n') && !text.endsWith('\n\n')).toBe(true)
  })
})
