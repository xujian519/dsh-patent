/**
 * Calibrate the shipped deterministic draft checks against revisions a patent
 * attorney actually made, and record the resulting readings of the revised text
 * as a reference range for the draft-quality ledger.
 *
 * The repository cannot ask an examiner or an attorney to score drafts (that is
 * the missing external condition behind the upgrade path), and the committed
 * public-grant corpus in `examples/patent-oas/corpus` is a de-legalized
 * paraphrase of about 450 bytes per item with no claims or specification text,
 * so neither can feed the checks. What is available offline is the attorney's
 * own case file: the same claim set before and after the amendment filed in
 * response to the first office action. Those pairs are evidence of a professional
 * decision that has already happened, so each check gets a directional verdict
 * against it instead of a new model-generated opinion.
 *
 * The measurements reuse the workflow's own gates, so a disagreement means the
 * gate would have said something else about a text a professional shipped. Only
 * the model-free part of the ledger is reachable here: `enablement-report` and
 * `claim-breadth` require a provider, and `pfe-consistency`, `citation-check`,
 * `revision-ledger` consume extracted state that external text never produced.
 *
 * Claim-lint takes no patent-type option, so its utility-model rules fire on
 * invention texts too; the rule-level tally is where that shows up, and a
 * vocabulary rule counts as a reading boundary rather than a violation.
 *
 * Case text stays outside the repository. The artifact this module builds holds
 * only opaque aliases and numbers, and `findCalibrationLeaks` refuses an artifact
 * that carries an application number, a party field, or a run of source text.
 *
 * @see `scripts/verify-patent-draft-calibration.ts` for the command line.
 * @module dsh-scripts/patent-draft-calibration
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { JSON_SCHEMA, load as loadYaml } from 'js-yaml'

import { lintClaimText } from '@deepseek-ai/dsh-patent-core'
import { SlopGateHandler, SpecCheckHandler, SLOP_GATE_PASS_THRESHOLD } from '@deepseek-ai/dsh-patent-tools'
import { reconcileDraftQuality } from '../packages/patent/patent-core/src/quality/ledger.ts'

/** Artifact shape version; a reader that cannot handle it must refuse to verify. */
export const CALIBRATION_SCHEMA_VERSION = 1

/** Where the calibration artifact lives, relative to the repository root. */
export const CALIBRATION_ARTIFACT_FILE = 'packages/self-evolve/evaluation/patent-draft-calibration.json'

/** Command recorded in the artifact; it names no paths, because the corpus is not in the repository. */
export const CALIBRATION_REGENERATE_COMMAND
  = 'tsx scripts/verify-patent-draft-calibration.ts --manifest <cases.yaml> --corpus <case dir> --write'

/**
 * Draft checks compared across a revision pair. `lint-*` and `spec-violations`
 * count findings, so fewer is better. `spec-score` is the spec-check score in 0-1
 * and `slop-total` is the slop-gate total in 0-100, so more is better.
 */
export const CALIBRATION_AXES = [
  'lint-errors',
  'lint-warnings',
  'spec-violations',
  'spec-score',
  'slop-total',
] as const

/** One measured check. */
export type CalibrationAxis = (typeof CALIBRATION_AXES)[number]

/** Whether a rising reading is an improvement for one axis. */
export const AXIS_HIGHER_IS_BETTER: Record<CalibrationAxis, boolean> = {
  'lint-errors': false,
  'lint-warnings': false,
  'spec-violations': false,
  'spec-score': true,
  'slop-total': true,
}

/** Outcome of one check across one revision. */
export type CalibrationDirection = 'improved' | 'unchanged' | 'regressed'

/** Edit size band, using the thresholds the attorney corpus was banded with. */
export type CalibrationBand = 'tweak' | 'surgical' | 'rewrite' | 'replace'

/** One deterministic reading of a single draft text. */
export type DraftReadings = {
  /** Claims parsed out of the text. */
  claimCount: number
  /** Claim-lint findings at error severity. */
  lintErrors: number
  /** Claim-lint findings at warning severity. */
  lintWarnings: number
  /** Spec-check claim-rule violations at any severity. */
  specViolations: number
  /** Claim-lint findings per `rule:severity`, for the rule-level tally. */
  lintRules: Record<string, number>
  /** Spec-check score in 0-1, or 0 when the gate degraded and assessed nothing. */
  specScore: number
  /** Slop-gate total in 0-100, or 0 when the gate degraded and assessed nothing. */
  slopTotal: number
  /** Whether spec-check produced a verdict. */
  specAssessed: boolean
  /** Whether the spec-check verdict passed (no error-severity violation). */
  specPassed: boolean
  /** Whether slop-gate produced a verdict. */
  slopAssessed: boolean
  /** Whether the slop-gate verdict reached its own pass line. */
  slopPassed: boolean
}

/** One before / after pair named by the corpus manifest. */
export type DraftPair = {
  /** Case stem; never written to the artifact. */
  stem: string
  /** Text before the attorney's amendment. */
  pre: string
  /** Text after the attorney's amendment. */
  post: string
}

/** One manifest entry naming the two versions of a case. */
export type DraftPairEntry = {
  /** Case stem, used only to derive the alias. */
  stem: string
  /** File name of the pre-amendment text, relative to the manifest directory. */
  pre: string
  /** File name of the amended text, relative to the manifest directory. */
  post: string
}

/** One calibrated pair. */
export type DraftCase = {
  /** Opaque alias derived from the stem. */
  alias: string
  /** Character-level similarity of the two versions, 0-1. */
  similarity: number
  /** Similarity band. */
  band: CalibrationBand
  /** Readings of the pre-amendment text. */
  pre: DraftReadings
  /** Readings of the amended text. */
  post: DraftReadings
  /** Per-axis movement from pre to post. */
  direction: Record<CalibrationAxis, CalibrationDirection>
}

/** Aggregate movement of one axis across the corpus. */
export type AxisTally = {
  /** Pairs where the reading moved in the direction the professional moved. */
  improved: number
  /** Pairs where the reading did not move. */
  unchanged: number
  /** Pairs where the reading moved the other way. */
  regressed: number
  /** `improved / (improved + regressed)`, or null when nothing moved. */
  agreement: number | null
  /** Median of the per-pair signed deltas, positive meaning improvement. */
  medianDelta: number
}

/** Distribution of one axis over the amended (professional) side. */
export type AxisReference = {
  /** 10th percentile. */
  p10: number
  /** Median. */
  median: number
  /** 90th percentile. */
  p90: number
  /** Share of pairs at or above the gate's own pass line. */
  passRate: number
}

/** Movement of one claim-lint rule across the corpus. */
export type LintRuleTally = {
  /** Rule identifier and severity, formatted `rule:severity`. */
  rule: string
  /** Findings on the pre-amendment side. */
  preFindings: number
  /** Findings on the amended side. */
  postFindings: number
  /** Distinct cases that produced a finding on either side. */
  cases: number
}

/** Counts and ranges derived from the per-case rows. */
export type CalibrationSummary = {
  /** Pairs the artifact was built from. */
  pairs: number
  /** Movement per axis. */
  perAxis: Record<CalibrationAxis, AxisTally>
  /** Reference distribution per axis. */
  reference: Record<CalibrationAxis, AxisReference>
  /** Rule-level claim-lint movement, sorted by rule. */
  lintRules: LintRuleTally[]
}

/** Floors the verification command asserts against the stored rows. */
export type CalibrationThresholds = {
  /** Minimum pairs the corpus must contribute for the calibration to count. */
  minPairs: number
  /** Minimum directional agreement for the axes listed in `agreementAxes`. */
  minAgreement: number
  /** Axes that must reach `minAgreement`. */
  agreementAxes: CalibrationAxis[]
}

/** The committed calibration artifact. */
export type CalibrationArtifact = {
  /** Artifact shape version. */
  schema: number
  /** Command that regenerates the artifact. */
  generatedBy: string
  /** Digest over the sorted pair aliases plus their edit similarity. */
  corpusDigest: string
  /** Axes in report order. */
  axes: CalibrationAxis[]
  /** Per-pair rows, sorted by alias. */
  cases: DraftCase[]
  /** Aggregates recomputable from `cases`. */
  summary: CalibrationSummary
  /** Floors asserted by the verification command. */
  thresholds: CalibrationThresholds
}

/**
 * Read one corpus file.
 * @param path - File path.
 * @returns Normalized text.
 */
function readCorpusFile(path: string): string {
  return stripBom(readFileSync(path, 'utf8'))
}

/**
 * Strip a byte-order mark and normalize line endings.
 * @param text - Raw file content.
 * @returns Text without a leading BOM and without carriage returns.
 */
export function stripBom(text: string): string {
  return text.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n')
}

/**
 * Reduce a draft to the characters that carry its content.
 * @param text - Draft text.
 * @returns Lower-cased text without whitespace or punctuation.
 */
export function contentCharacters(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

/**
 * Measure how close two versions of a draft are.
 *
 * The measure is a character-multiset overlap, not a longest-common-subsequence
 * alignment: it is linear in text length and needs no diff library, and it only
 * has to place a pair in an edit-size band. It therefore reads higher than an
 * alignment-based similarity for reordered text, which is stated wherever the
 * number is reported.
 * @param pre - Text before the amendment.
 * @param post - Text after the amendment.
 * @returns Similarity in 0-1; 1 when both sides carry the same characters.
 */
export function characterSimilarity(pre: string, post: string): number {
  const before = contentCharacters(pre)
  const after = contentCharacters(post)
  if (before.length === 0 || after.length === 0) return before.length === after.length ? 1 : 0
  const counts = new Map<string, number>()
  for (const char of before) counts.set(char, (counts.get(char) ?? 0) + 1)
  let shared = 0
  for (const char of after) {
    const remaining = counts.get(char) ?? 0
    if (remaining > 0) {
      counts.set(char, remaining - 1)
      shared += 1
    }
  }
  return (2 * shared) / (before.length + after.length)
}

/**
 * Place a similarity in an edit-size band.
 * @param similarity - Output of {@link characterSimilarity}.
 * @returns The band whose range contains the value.
 */
export function bandForSimilarity(similarity: number): CalibrationBand {
  if (similarity >= 0.95) return 'tweak'
  if (similarity >= 0.8) return 'surgical'
  if (similarity >= 0.5) return 'rewrite'
  return 'replace'
}

/** Code point of `a`; a digest nibble selects a letter, so an alias never carries digits. */
const ALIAS_BASE = 97

/** Digest bytes behind one alias. */
const ALIAS_BYTES = 5

/**
 * Derive the opaque alias for a corpus stem.
 *
 * The alphabet is letters only so the anonymization scan cannot mistake part of
 * an alias for an application number.
 * @param stem - File stem shared by the two versions.
 * @returns Ten lower-case letters.
 */
export function caseAlias(stem: string): string {
  const bytes = createHash('sha256')
    .update(`dsh-draft-calibration:${stem}`)
    .digest()
    .subarray(0, ALIAS_BYTES)
  let alias = ''
  for (const byte of bytes) {
    alias += String.fromCharCode(ALIAS_BASE + (byte >> 4)) + String.fromCharCode(ALIAS_BASE + (byte & 15))
  }
  return alias
}

/**
 * Parse the corpus manifest that names the pairs.
 *
 * Naming both files of a pair, instead of inferring them from a suffix
 * convention, is deliberate: an office-action amendment has a direction, and a
 * file named `-a` / `-b` does not say which side is the amendment. The batch
 * whose ordering is documented in its design note contributes twelve pairs; a
 * pair found in the same directory but absent from the manifest stays out.
 * @param text - Manifest content.
 * @returns Entries in manifest order.
 * @throws Error when the shape is wrong or a stem or file repeats.
 */
export function parseCalibrationManifest(text: string): DraftPairEntry[] {
  let parsed: unknown
  try {
    parsed = loadYaml(text, { schema: JSON_SCHEMA })
  } catch {
    throw calibrationError('manifest is not valid YAML')
  }
  const root = needRecord(parsed, 'manifest')
  const entries = needList(root, 'pairs', 'manifest')
  const stems = new Set<string>()
  const files = new Set<string>()
  return entries.map((value, index) => {
    const where = `pairs[${index}]`
    const source = needRecord(value, where)
    const entry: DraftPairEntry = {
      stem: needString(source, 'stem', where),
      pre: needString(source, 'pre', where),
      post: needString(source, 'post', where),
    }
    if (entry.pre === entry.post) throw calibrationError(`${where} names the same file on both sides`)
    for (const name of [entry.pre, entry.post]) {
      if (files.has(name)) throw calibrationError(`${where} reuses file ${name}`)
      files.add(name)
    }
    if (stems.has(entry.stem)) throw calibrationError(`${where} repeats stem ${entry.stem}`)
    stems.add(entry.stem)
    return entry
  })
}

/**
 * Read the texts named by a manifest.
 * @param dir - Directory holding the case files.
 * @param entries - Entries from {@link parseCalibrationManifest}.
 * @returns Pairs in manifest order.
 * @throws Error when the directory or a named file is missing, or a name escapes the directory.
 */
export function readCalibrationPairs(dir: string, entries: readonly DraftPairEntry[]): DraftPair[] {
  if (!existsSync(dir)) throw calibrationError(`corpus directory is missing: ${dir}`)
  const root = resolve(dir)
  return entries.map(entry => ({
    stem: entry.stem,
    pre: readContainedFile(root, entry.pre),
    post: readContainedFile(root, entry.post),
  }))
}

/**
 * Read one manifest-referenced file.
 * @param root - Resolved corpus directory.
 * @param name - File name from the manifest.
 * @returns Normalized text.
 */
function readContainedFile(root: string, name: string): string {
  const path = resolve(root, name)
  if (!path.startsWith(root + sep)) throw calibrationError(`manifest file escapes the corpus directory: ${name}`)
  if (!existsSync(path)) throw calibrationError(`manifest file is missing: ${name}`)
  return readCorpusFile(path)
}

/**
 * Run the model-free draft gates over one text.
 * @param text - Claims text of one document version.
 * @returns The readings the calibration compares.
 */
export async function measureDraft(text: string): Promise<DraftReadings> {
  const lint = lintClaimText(text)
  const spec = await new SpecCheckHandler().execute({ state: { mode: 'claims', text, claims: text } })
  const slop = await new SlopGateHandler().execute({ state: { claims_draft: text } })
  const violations = Array.isArray(spec.spec_check_violations) ? spec.spec_check_violations : []
  const lintRules: Record<string, number> = {}
  for (const finding of lint.findings) {
    const key = `${finding.rule}:${finding.severity}`
    lintRules[key] = (lintRules[key] ?? 0) + 1
  }
  const specScore = typeof spec.spec_check_score === 'number' ? spec.spec_check_score : 0
  const slopTotal = typeof slop.slop_score === 'number' ? slop.slop_score : 0
  return {
    claimCount: lint.claims.length,
    lintErrors: lint.errorCount,
    lintWarnings: lint.warningCount,
    specViolations: violations.length,
    lintRules,
    specScore,
    slopTotal,
    specAssessed: typeof spec.spec_check_passed === 'boolean',
    specPassed: spec.spec_check_passed === true,
    slopAssessed: typeof slop.slop_score === 'number',
    slopPassed: slopTotal >= SLOP_GATE_PASS_THRESHOLD,
  }
}

/**
 * Axis reading used for the directional comparison.
 * @param readings - One side's readings.
 * @param axis - Axis to read.
 * @returns The comparable number.
 */
export function axisReading(readings: DraftReadings, axis: CalibrationAxis): number {
  switch (axis) {
    case 'lint-errors':
      return readings.lintErrors
    case 'lint-warnings':
      return readings.lintWarnings
    case 'spec-violations':
      return readings.specViolations
    case 'spec-score':
      return readings.specScore
    case 'slop-total':
      return readings.slopTotal
  }
}

/**
 * Classify one axis across one revision.
 * @param pre - Readings before the amendment.
 * @param post - Readings after the amendment.
 * @param axis - Axis to compare.
 * @returns `improved`, `unchanged`, or `regressed`.
 */
export function directionFor(pre: DraftReadings, post: DraftReadings, axis: CalibrationAxis): CalibrationDirection {
  const before = axisReading(pre, axis)
  const after = axisReading(post, axis)
  if (before === after) return 'unchanged'
  const rose = after > before
  return rose === AXIS_HIGHER_IS_BETTER[axis] ? 'improved' : 'regressed'
}

/**
 * Signed movement of one axis, positive meaning improvement.
 * @param pre - Readings before the amendment.
 * @param post - Readings after the amendment.
 * @param axis - Axis to compare.
 * @returns The delta in the improvement direction; no movement is a plain zero.
 */
export function deltaFor(pre: DraftReadings, post: DraftReadings, axis: CalibrationAxis): number {
  const delta = axisReading(post, axis) - axisReading(pre, axis)
  const signed = AXIS_HIGHER_IS_BETTER[axis] ? delta : -delta
  return signed === 0 ? 0 : signed
}

/**
 * Nearest-rank percentile of pre-sorted values.
 * @param sorted - Values in ascending order.
 * @param rank - Percentile in 0-100.
 * @returns The value at the rank, or 0 for an empty list.
 */
export function percentile(sorted: readonly number[], rank: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1))
  return sorted[index] ?? 0
}

/**
 * Whether one side's readings pass the gate's own line on a given axis.
 * @param readings - One side's readings.
 * @param axis - Axis to test.
 * @returns True when the reading is at or above the pass line.
 */
export function passesAxis(readings: DraftReadings, axis: CalibrationAxis): boolean {
  switch (axis) {
    case 'lint-errors':
      return readings.lintErrors === 0
    case 'lint-warnings':
      return readings.lintWarnings === 0
    case 'spec-violations':
      return readings.specViolations === 0
    case 'spec-score':
      return readings.specPassed
    case 'slop-total':
      return readings.slopPassed
  }
}

/**
 * Aggregate per-case rows.
 * @param cases - Rows to aggregate, in any order.
 * @returns Pair count plus movement and reference distributions per axis.
 */
export function summarizeCases(cases: readonly DraftCase[]): CalibrationSummary {
  return {
    pairs: cases.length,
    perAxis: {
      'lint-errors': tallyAxis(cases, 'lint-errors'),
      'lint-warnings': tallyAxis(cases, 'lint-warnings'),
      'spec-violations': tallyAxis(cases, 'spec-violations'),
      'spec-score': tallyAxis(cases, 'spec-score'),
      'slop-total': tallyAxis(cases, 'slop-total'),
    },
    reference: {
      'lint-errors': referenceAxis(cases, 'lint-errors'),
      'lint-warnings': referenceAxis(cases, 'lint-warnings'),
      'spec-violations': referenceAxis(cases, 'spec-violations'),
      'spec-score': referenceAxis(cases, 'spec-score'),
      'slop-total': referenceAxis(cases, 'slop-total'),
    },
    lintRules: tallyLintRules(cases),
  }
}

/**
 * Tally claim-lint movement rule by rule.
 *
 * A rule that fires on texts a professional shipped without moving across
 * amendments is evidence the rule is miscalibrated, which the coarse axis counts
 * cannot show.
 * @param cases - Rows to aggregate.
 * @returns One row per rule that fired anywhere, sorted by rule.
 */
export function tallyLintRules(cases: readonly DraftCase[]): LintRuleTally[] {
  const rules = new Set<string>()
  for (const entry of cases) {
    for (const key of Object.keys(entry.pre.lintRules)) rules.add(key)
    for (const key of Object.keys(entry.post.lintRules)) rules.add(key)
  }
  return [...rules]
    .sort((left, right) => (left < right ? -1 : 1))
    .map(rule => ({
      rule,
      preFindings: cases.reduce((sum, entry) => sum + (entry.pre.lintRules[rule] ?? 0), 0),
      postFindings: cases.reduce((sum, entry) => sum + (entry.post.lintRules[rule] ?? 0), 0),
      cases: cases.filter(entry => (entry.pre.lintRules[rule] ?? 0) > 0 || (entry.post.lintRules[rule] ?? 0) > 0).length,
    }))
}

/**
 * Count how one axis moved across the corpus.
 * @param cases - Rows to aggregate.
 * @param axis - Axis to tally.
 * @returns The movement counts and the median signed delta.
 */
function tallyAxis(cases: readonly DraftCase[], axis: CalibrationAxis): AxisTally {
  const deltas: number[] = []
  let improved = 0
  let unchanged = 0
  let regressed = 0
  for (const entry of cases) {
    const direction = entry.direction[axis]
    if (direction === 'improved') improved += 1
    else if (direction === 'regressed') regressed += 1
    else unchanged += 1
    deltas.push(deltaFor(entry.pre, entry.post, axis))
  }
  const settled = improved + regressed
  return {
    improved,
    unchanged,
    regressed,
    agreement: settled === 0 ? null : Math.round((improved / settled) * 1000) / 1000,
    medianDelta: percentile(deltas.sort((left, right) => left - right), 50),
  }
}

/**
 * Describe one axis on the amended side of the corpus.
 * @param cases - Rows to aggregate.
 * @param axis - Axis to describe.
 * @returns Percentiles and the pass rate against the gate's own line.
 */
function referenceAxis(cases: readonly DraftCase[], axis: CalibrationAxis): AxisReference {
  const postValues = cases.map(entry => axisReading(entry.post, axis)).sort((left, right) => left - right)
  const passing = cases.filter(entry => passesAxis(entry.post, axis)).length
  return {
    p10: percentile(postValues, 10),
    median: percentile(postValues, 50),
    p90: percentile(postValues, 90),
    passRate: cases.length === 0 ? 0 : Math.round((passing / cases.length) * 1000) / 1000,
  }
}

/**
 * Digest the corpus identity that the artifact stands for.
 * @param cases - Rows, in any order.
 * @returns `sha256:<hex>` over the sorted alias and similarity list.
 */
export function corpusDigest(cases: readonly DraftCase[]): string {
  const lines = cases
    .map(entry => `${entry.alias}:${entry.similarity.toFixed(6)}`)
    .sort((left, right) => (left < right ? -1 : 1))
    .join('\n')
  return `sha256:${createHash('sha256').update(lines).digest('hex')}`
}

/**
 * Classify every axis across one revision.
 * @param pre - Readings before the amendment.
 * @param post - Readings after the amendment.
 * @returns The per-axis movement.
 */
function directionMap(pre: DraftReadings, post: DraftReadings): Record<CalibrationAxis, CalibrationDirection> {
  return {
    'lint-errors': directionFor(pre, post, 'lint-errors'),
    'lint-warnings': directionFor(pre, post, 'lint-warnings'),
    'spec-violations': directionFor(pre, post, 'spec-violations'),
    'spec-score': directionFor(pre, post, 'spec-score'),
    'slop-total': directionFor(pre, post, 'slop-total'),
  }
}

/**
 * Measure every pair and build the artifact rows.
 * @param pairs - Pairs from {@link readCalibrationPairs}.
 * @returns Rows sorted by alias, with aggregates and digest attached.
 */
export async function buildCalibrationCases(pairs: readonly DraftPair[]): Promise<DraftCase[]> {
  const cases: DraftCase[] = []
  for (const pair of pairs) {
    const pre = await measureDraft(pair.pre)
    const post = await measureDraft(pair.post)
    const similarity = characterSimilarity(pair.pre, pair.post)
    cases.push({
      alias: caseAlias(pair.stem),
      similarity: Math.round(similarity * 10000) / 10000,
      band: bandForSimilarity(similarity),
      pre,
      post,
      direction: directionMap(pre, post),
    })
  }
  return cases.sort((left, right) => (left.alias < right.alias ? -1 : left.alias > right.alias ? 1 : 0))
}

/**
 * Build a complete artifact from measured rows.
 * @param cases - Rows from {@link buildCalibrationCases}.
 * @param thresholds - Floors the verification command asserts.
 * @param generatedBy - Command recorded in the artifact.
 * @returns The artifact.
 */
export function buildArtifact(
  cases: readonly DraftCase[],
  thresholds: CalibrationThresholds,
  generatedBy: string,
): CalibrationArtifact {
  return {
    schema: CALIBRATION_SCHEMA_VERSION,
    generatedBy,
    corpusDigest: corpusDigest(cases),
    axes: [...CALIBRATION_AXES],
    cases: [...cases],
    summary: summarizeCases(cases),
    thresholds,
  }
}

/**
 * Read an artifact from JSON text.
 *
 * The committed file is an untrusted boundary, so every field is checked before
 * any aggregate is recomputed from it.
 * @param text - Artifact file content.
 * @returns The parsed artifact.
 * @throws Error naming the first field that does not match the shape.
 */
export function parseCalibrationArtifact(text: string): CalibrationArtifact {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw calibrationError('artifact is not valid JSON')
  }
  const root = needRecord(parsed, 'artifact')
  const schema = needNumber(root, 'schema', 'artifact')
  if (schema !== CALIBRATION_SCHEMA_VERSION) {
    throw calibrationError(`artifact schema ${schema} is not ${CALIBRATION_SCHEMA_VERSION}`)
  }
  return {
    schema,
    generatedBy: needString(root, 'generatedBy', 'artifact'),
    corpusDigest: needString(root, 'corpusDigest', 'artifact'),
    axes: needList(root, 'axes', 'artifact').map((axis, index) =>
      needEnum(axis, `axes[${index}]`, CALIBRATION_AXES),
    ),
    cases: needList(root, 'cases', 'artifact').map((entry, index) => parseCase(entry, `cases[${index}]`)),
    summary: parseSummary(needRecord(root.summary, 'summary')),
    thresholds: parseThresholds(needRecord(root.thresholds, 'thresholds')),
  }
}

/**
 * Parse one case row.
 * @param value - Raw row.
 * @param where - Field path for the error message.
 * @returns The row.
 */
function parseCase(value: unknown, where: string): DraftCase {
  const source = needRecord(value, where)
  return {
    alias: needString(source, 'alias', where),
    similarity: needNumber(source, 'similarity', where),
    band: needEnum(source.band, `${where}.band`, CALIBRATION_BANDS),
    pre: parseReadings(needRecord(source.pre, `${where}.pre`), `${where}.pre`),
    post: parseReadings(needRecord(source.post, `${where}.post`), `${where}.post`),
    direction: parseDirection(needRecord(source.direction, `${where}.direction`), `${where}.direction`),
  }
}

/**
 * Parse one side's readings.
 * @param source - Raw readings object.
 * @param where - Field path for the error message.
 * @returns The readings.
 */
function parseReadings(source: Record<string, unknown>, where: string): DraftReadings {
  return {
    claimCount: needCount(source, 'claimCount', where),
    lintErrors: needCount(source, 'lintErrors', where),
    lintWarnings: needCount(source, 'lintWarnings', where),
    specViolations: needCount(source, 'specViolations', where),
    lintRules: needRuleCounts(source.lintRules, `${where}.lintRules`),
    specScore: needNumber(source, 'specScore', where),
    slopTotal: needNumber(source, 'slopTotal', where),
    specAssessed: needBoolean(source, 'specAssessed', where),
    specPassed: needBoolean(source, 'specPassed', where),
    slopAssessed: needBoolean(source, 'slopAssessed', where),
    slopPassed: needBoolean(source, 'slopPassed', where),
  }
}

/**
 * Parse a direction map.
 * @param source - Raw map.
 * @param where - Field path for the error message.
 * @returns The map.
 */
function parseDirection(source: Record<string, unknown>, where: string): Record<CalibrationAxis, CalibrationDirection> {
  return {
    'lint-errors': needEnum(source['lint-errors'], `${where}.lint-errors`, CALIBRATION_DIRECTIONS),
    'lint-warnings': needEnum(source['lint-warnings'], `${where}.lint-warnings`, CALIBRATION_DIRECTIONS),
    'spec-violations': needEnum(source['spec-violations'], `${where}.spec-violations`, CALIBRATION_DIRECTIONS),
    'spec-score': needEnum(source['spec-score'], `${where}.spec-score`, CALIBRATION_DIRECTIONS),
    'slop-total': needEnum(source['slop-total'], `${where}.slop-total`, CALIBRATION_DIRECTIONS),
  }
}

/**
 * Parse one axis tally.
 * @param source - Raw tally object.
 * @param axis - Axis being read.
 * @returns The tally.
 */
function parseTally(source: Record<string, unknown>, axis: CalibrationAxis): AxisTally {
  const where = `summary.perAxis.${axis}`
  return {
    improved: needCount(source, 'improved', where),
    unchanged: needCount(source, 'unchanged', where),
    regressed: needCount(source, 'regressed', where),
    agreement: source.agreement === null ? null : needNumber(source, 'agreement', where),
    medianDelta: needNumber(source, 'medianDelta', where),
  }
}

/**
 * Parse one axis reference range.
 * @param source - Raw range object.
 * @param axis - Axis being read.
 * @returns The range.
 */
function parseRange(source: Record<string, unknown>, axis: CalibrationAxis): AxisReference {
  const where = `summary.reference.${axis}`
  return {
    p10: needNumber(source, 'p10', where),
    median: needNumber(source, 'median', where),
    p90: needNumber(source, 'p90', where),
    passRate: needNumber(source, 'passRate', where),
  }
}

/**
 * Parse the aggregate block.
 * @param source - Raw summary object.
 * @returns The summary.
 */
function parseSummary(source: Record<string, unknown>): CalibrationSummary {
  const perAxis = needRecord(source.perAxis, 'summary.perAxis')
  const reference = needRecord(source.reference, 'summary.reference')
  return {
    pairs: needCount(source, 'pairs', 'summary'),
    perAxis: {
      'lint-errors': parseTally(needRecord(perAxis['lint-errors'], 'summary.perAxis.lint-errors'), 'lint-errors'),
      'lint-warnings': parseTally(needRecord(perAxis['lint-warnings'], 'summary.perAxis.lint-warnings'), 'lint-warnings'),
      'spec-violations': parseTally(
        needRecord(perAxis['spec-violations'], 'summary.perAxis.spec-violations'),
        'spec-violations',
      ),
      'spec-score': parseTally(needRecord(perAxis['spec-score'], 'summary.perAxis.spec-score'), 'spec-score'),
      'slop-total': parseTally(needRecord(perAxis['slop-total'], 'summary.perAxis.slop-total'), 'slop-total'),
    },
    reference: {
      'lint-errors': parseRange(needRecord(reference['lint-errors'], 'summary.reference.lint-errors'), 'lint-errors'),
      'lint-warnings': parseRange(
        needRecord(reference['lint-warnings'], 'summary.reference.lint-warnings'),
        'lint-warnings',
      ),
      'spec-violations': parseRange(
        needRecord(reference['spec-violations'], 'summary.reference.spec-violations'),
        'spec-violations',
      ),
      'spec-score': parseRange(needRecord(reference['spec-score'], 'summary.reference.spec-score'), 'spec-score'),
      'slop-total': parseRange(needRecord(reference['slop-total'], 'summary.reference.slop-total'), 'slop-total'),
    },
    lintRules: needList(source, 'lintRules', 'summary').map((entry, index) => parseRuleTally(entry, index)),
  }
}

/**
 * Parse one rule-level tally.
 * @param value - Raw tally.
 * @param index - Position in the list, for the error message.
 * @returns The tally.
 */
function parseRuleTally(value: unknown, index: number): LintRuleTally {
  const where = `summary.lintRules[${index}]`
  const source = needRecord(value, where)
  const rule = needString(source, 'rule', where)
  if (!RULE_KEY_PATTERN.test(rule)) throw calibrationError(`${where}.rule is outside the rule vocabulary`)
  return {
    rule,
    preFindings: needCount(source, 'preFindings', where),
    postFindings: needCount(source, 'postFindings', where),
    cases: needCount(source, 'cases', where),
  }
}

/**
 * Parse the declared floors.
 * @param source - Raw thresholds object.
 * @returns The thresholds.
 */
function parseThresholds(source: Record<string, unknown>): CalibrationThresholds {
  const minPairs = needNumber(source, 'minPairs', 'thresholds')
  const minAgreement = needNumber(source, 'minAgreement', 'thresholds')
  if (!Number.isInteger(minPairs) || minPairs < 1) throw calibrationError('thresholds.minPairs is not a positive count')
  if (minAgreement < 0 || minAgreement > 1) throw calibrationError('thresholds.minAgreement is outside 0-1')
  return {
    minPairs,
    minAgreement,
    agreementAxes: needList(source, 'agreementAxes', 'thresholds').map((axis, index) =>
      needEnum(axis, `thresholds.agreementAxes[${index}]`, CALIBRATION_AXES),
    ),
  }
}

/**
 * Require a rule-name to count map.
 * @param value - Raw map.
 * @param where - Field path for the error message.
 * @returns The map.
 */
function needRuleCounts(value: unknown, where: string): Record<string, number> {
  const source = needRecord(value, where)
  const counts: Record<string, number> = {}
  for (const [key, entry] of Object.entries(source)) {
    if (!RULE_KEY_PATTERN.test(key)) throw calibrationError(`${where} has a key outside the rule vocabulary`)
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0) {
      throw calibrationError(`${where}.${key} is not a count`)
    }
    counts[key] = entry
  }
  return counts
}

/** Accepted shape of a claim-lint rule key, so no source text can ride in on a field name. */
const RULE_KEY_PATTERN = /^[a-z][a-z0-9-]*:[a-z]+$/u

/**
 * Test whether a value is a plain object.
 * @param value - Value to test.
 * @returns True for a non-null, non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Fail with the script prefix.
 * @param message - What is wrong.
 * @returns The error to throw.
 */
function calibrationError(message: string): Error {
  return new Error(`patent-draft-calibration: ${message}`)
}

/**
 * Require a plain-object field.
 * @param value - Raw value.
 * @param where - Field path.
 * @returns The object.
 */
function needRecord(value: unknown, where: string): Record<string, unknown> {
  if (!isRecord(value)) throw calibrationError(`${where} is not an object`)
  return value
}

/**
 * Require a string field.
 * @param source - Parent object.
 * @param key - Field name.
 * @param where - Field path.
 * @returns The string.
 */
function needString(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key]
  if (typeof value !== 'string') throw calibrationError(`${where}.${key} is not a string`)
  return value
}

/**
 * Require a count field: a non-negative integer.
 * @param source - Parent object.
 * @param key - Field name.
 * @param where - Field path.
 * @returns The count.
 */
function needCount(source: Record<string, unknown>, key: string, where: string): number {
  const value = needNumber(source, key, where)
  if (!Number.isInteger(value) || value < 0) throw calibrationError(`${where}.${key} is not a count`)
  return value
}

/**
 * Require a finite number field.
 * @param source - Parent object.
 * @param key - Field name.
 * @param where - Field path.
 * @returns The number.
 */
function needNumber(source: Record<string, unknown>, key: string, where: string): number {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw calibrationError(`${where}.${key} is not a number`)
  return value
}

/**
 * Require a boolean field.
 * @param source - Parent object.
 * @param key - Field name.
 * @param where - Field path.
 * @returns The boolean.
 */
function needBoolean(source: Record<string, unknown>, key: string, where: string): boolean {
  const value = source[key]
  if (typeof value !== 'boolean') throw calibrationError(`${where}.${key} is not a boolean`)
  return value
}

/**
 * Require an array field.
 * @param source - Parent object.
 * @param key - Field name.
 * @param where - Field path.
 * @returns The array.
 */
function needList(source: Record<string, unknown>, key: string, where: string): unknown[] {
  const value = source[key]
  if (!Array.isArray(value)) throw calibrationError(`${where}.${key} is not an array`)
  return value
}

/**
 * Require a value from a closed set.
 * @param value - Raw value.
 * @param where - Field path.
 * @param allowed - Accepted values.
 * @returns The value.
 */
function needEnum<T extends string>(value: unknown, where: string, allowed: readonly T[]): T {
  for (const entry of allowed) {
    if (entry === value) return entry
  }
  throw calibrationError(`${where} is not one of ${allowed.join(', ')}`)
}

/** Band values, in report order. */
const CALIBRATION_BANDS = ['tweak', 'surgical', 'rewrite', 'replace'] as const

/** Direction values. */
const CALIBRATION_DIRECTIONS = ['improved', 'unchanged', 'regressed'] as const

/**
 * Collect the artifact fields that can carry text.
 *
 * Everything else is a number, a boolean, or a value from a closed set, so scanning
 * the whole JSON would flag a long digit run inside the hex digest, or inside a
 * similarity, as a piece of source text.
 * @param artifact - Artifact about to be written.
 * @returns Joined strings that would leave the machine.
 */
function leakScanText(artifact: CalibrationArtifact): string {
  const ruleKeys = artifact.cases.flatMap(entry => [
    ...Object.keys(entry.pre.lintRules),
    ...Object.keys(entry.post.lintRules),
  ])
  return [artifact.generatedBy, ...artifact.cases.map(entry => entry.alias), ...ruleKeys].join('\n')
}

/**
 * Find content that must not leave the machine.
 * @param artifact - Artifact about to be written.
 * @returns Labels of leaked identifier patterns and source-text runs.
 */
export function findCalibrationLeaks(artifact: CalibrationArtifact): string[] {
  const leaks: string[] = []
  const text = leakScanText(artifact)
  if (/(?:CN)?\d{9,13}(?:\.\d)?[A-Z]?/u.test(text)) leaks.push('patent or application number')
  for (const label of ['申请号', '申请人', '发明人', '代理机构', '地址']) {
    if (text.includes(label)) leaks.push(`${label} field`)
  }
  const cjkRun = text.match(/[\u4e00-\u9fff]{6,}/u)
  if (cjkRun !== null) leaks.push(`source text run: ${cjkRun[0].slice(0, 6)}`)
  const stems = new Set(artifact.cases.map(entry => entry.alias))
  if (stems.size !== artifact.cases.length) leaks.push('duplicate case alias')
  return leaks
}

/**
 * Check an artifact without touching any corpus.
 *
 * The command line runs this in continuous integration: every aggregate is
 * recomputed from the stored rows, so an edited summary, a renamed case, or a
 * dropped pair is caught even though the corpus is not present. Structural
 * completeness is already proven by {@link parseCalibrationArtifact}, which
 * rejects an artifact missing any axis block.
 * @param artifact - Parsed artifact.
 * @returns Problem descriptions; empty when the artifact is self-consistent.
 */
export function verifyCalibrationArtifact(artifact: CalibrationArtifact): string[] {
  const problems: string[] = []
  if (artifact.schema !== CALIBRATION_SCHEMA_VERSION) {
    problems.push(`artifact schema ${artifact.schema} is not ${CALIBRATION_SCHEMA_VERSION}`)
    return problems
  }
  const sorted = [...artifact.cases].map(entry => entry.alias)
  if (sorted.join(',') !== [...sorted].sort().join(',')) problems.push('cases are not sorted by alias')
  if (artifact.corpusDigest !== corpusDigest(artifact.cases)) problems.push('corpusDigest does not match cases')
  const expected = summarizeCases(artifact.cases)
  if (artifact.summary.pairs !== expected.pairs) problems.push('summary.pairs does not match the rows')
  if (JSON.stringify(artifact.summary.lintRules) !== JSON.stringify(expected.lintRules)) {
    problems.push('summary.lintRules does not match the rows')
  }
  for (const axis of CALIBRATION_AXES) {
    const stored = artifact.summary.perAxis[axis]
    const computed = expected.perAxis[axis]
    if (
      stored.improved !== computed.improved ||
      stored.unchanged !== computed.unchanged ||
      stored.regressed !== computed.regressed ||
      stored.agreement !== computed.agreement ||
      stored.medianDelta !== computed.medianDelta
    ) {
      problems.push(`summary.perAxis.${axis} does not match the rows`)
    }
    const storedReference = artifact.summary.reference[axis]
    const computedReference = expected.reference[axis]
    if (
      storedReference.p10 !== computedReference.p10 ||
      storedReference.median !== computedReference.median ||
      storedReference.p90 !== computedReference.p90 ||
      storedReference.passRate !== computedReference.passRate
    ) {
      problems.push(`summary.reference.${axis} does not match the rows`)
    }
  }
  for (const entry of artifact.cases) {
    if (bandForSimilarity(entry.similarity) !== entry.band) problems.push(`case ${entry.alias} band is stale`)
    for (const axis of CALIBRATION_AXES) {
      if (entry.direction[axis] !== directionFor(entry.pre, entry.post, axis)) {
        problems.push(`case ${entry.alias} direction for ${axis} does not match its readings`)
      }
    }
  }
  if (artifact.summary.pairs < artifact.thresholds.minPairs) {
    problems.push(`${artifact.summary.pairs} pairs is below the declared minimum ${artifact.thresholds.minPairs}`)
  }
  for (const axis of artifact.thresholds.agreementAxes) {
    const agreement = artifact.summary.perAxis[axis].agreement
    if (agreement === null) {
      problems.push(`${axis} is declared but no pair moved it`)
    } else if (agreement < artifact.thresholds.minAgreement) {
      problems.push(`${axis} agreement ${agreement} is below ${artifact.thresholds.minAgreement}`)
    }
  }
  for (const leak of findCalibrationLeaks(artifact)) problems.push(`anonymization: ${leak}`)
  return problems
}

/**
 * Describe how a freshly measured artifact differs from the committed one.
 *
 * Comparison is structural, not textual: the rows carry the evidence, so a
 * difference is reported at the case, axis, or aggregate that moved rather than
 * as a byte diff the reader has to interpret.
 * @param committed - Artifact as stored in the repository.
 * @param measured - Artifact recomputed from the corpus.
 * @returns Problem descriptions; empty when the stored artifact still reproduces.
 */
export function compareArtifacts(committed: CalibrationArtifact, measured: CalibrationArtifact): string[] {
  const problems: string[] = []
  if (committed.generatedBy !== measured.generatedBy) {
    problems.push(`generatedBy changed: ${committed.generatedBy} -> ${measured.generatedBy}`)
  }
  if (JSON.stringify(committed.axes) !== JSON.stringify(measured.axes)) problems.push('axes changed')
  if (JSON.stringify(committed.thresholds) !== JSON.stringify(measured.thresholds)) problems.push('thresholds changed')
  if (committed.corpusDigest !== measured.corpusDigest) {
    problems.push(`corpusDigest changed: ${committed.corpusDigest.slice(0, 18)} -> ${measured.corpusDigest.slice(0, 18)}`)
  }
  const committedRows = new Map(committed.cases.map(entry => [entry.alias, entry]))
  const measuredRows = new Map(measured.cases.map(entry => [entry.alias, entry]))
  for (const alias of committedRows.keys()) {
    if (!measuredRows.has(alias)) problems.push(`case ${alias} is no longer measurable from the corpus`)
  }
  for (const alias of measuredRows.keys()) {
    if (!committedRows.has(alias)) problems.push(`case ${alias} is new in the corpus`)
  }
  for (const [alias, next] of measuredRows) {
    const stored = committedRows.get(alias)
    if (stored === undefined) continue
    if (JSON.stringify(stored) !== JSON.stringify(next)) problems.push(`case ${alias} readings changed`)
  }
  if (JSON.stringify(committed.summary) !== JSON.stringify(measured.summary)) problems.push('summary changed')
  return problems
}

/**
 * Render the artifact for a terminal or a proof block.
 * @param artifact - Verified artifact.
 * @returns Report text with the movement table and the reference range.
 */
export function renderCalibrationReport(artifact: CalibrationArtifact): string {
  const lines: string[] = [
    `# 代理师改稿校准：${artifact.summary.pairs} 对（语料指纹 ${artifact.corpusDigest.slice(0, 18)}…）`,
    '',
    '| 检查轴 | 同向 | 未变 | 反向 | 方向一致率 | 中位增减 | 定稿侧 p10/中位/p90 | 定稿侧通过率 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const axis of artifact.axes) {
    const tally = artifact.summary.perAxis[axis]
    const range = artifact.summary.reference[axis]
    lines.push(
      `| \`${axis}\` | ${tally.improved} | ${tally.unchanged} | ${tally.regressed} | ${
        tally.agreement === null ? 'n/a' : tally.agreement.toFixed(3)
      } | ${tally.medianDelta} | ${range.p10} / ${range.median} / ${range.p90} | ${(range.passRate * 100).toFixed(0)}% |`,
    )
  }
  const bands = artifact.cases.reduce<Record<string, number>>((acc, entry) => {
    acc[entry.band] = (acc[entry.band] ?? 0) + 1
    return acc
  }, {})
  lines.push(
    '',
    '修改幅度（字符多重集相似度，重排会读高，不做跨案绝对比较）：微调 ' +
      `${bands.tweak ?? 0}、手术式 ${bands.surgical ?? 0}、重写 ${bands.rewrite ?? 0}、替换 ${bands.replace ?? 0}。`,
    '账本可折叠部分：spec-check 一侧有判定，enablement-report、claim-breadth、revision-ledger、legal-gaps 在外部文本上为未评估。',
    '',
    '### 权利要求自检逐规则读数（修订前 → 修订后，命中案件数）',
    '',
    '| 规则:严重度 | 修订前 | 修订后 | 命中案件 |',
    '| --- | --- | --- | --- |',
  )
  for (const entry of artifact.summary.lintRules) {
    lines.push(`| \`${entry.rule}\` | ${entry.preFindings} | ${entry.postFindings} | ${entry.cases} |`)
  }
  lines.push(
    '',
    '词表类规则（`process-feature`、`functional-limitation` 等）不分专利类型，实用新型专属措辞也会落在发明专利文本上；'
      + '命中只说明该写法要代理师过一眼，不等于违规。',
  )
  lines.push('')
  return lines.join('\n')
}

/**
 * Fold one side's readings through the draft-quality ledger.
 *
 * Exposed so a test can pin what the ledger says about external text: one of five
 * catalog rows is judged and the rest are listed as unassessed, which is the
 * honest reading and not a score to compare against a workflow run.
 * @param readings - One side's readings.
 * @returns The ledger summary.
 */
export function foldLedgerView(readings: DraftReadings): ReturnType<typeof reconcileDraftQuality> {
  return reconcileDraftQuality({ spec_check_passed: readings.specPassed, slop_score: readings.slopTotal })
}
