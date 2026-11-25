import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CALIBRATION_REGENERATE_COMMAND,
  buildArtifact,
  buildCalibrationCases,
  parseCalibrationArtifact,
  parseCalibrationManifest,
  readCalibrationPairs,
  verifyCalibrationArtifact,
  type CalibrationArtifact,
} from './patent-draft-calibration.ts'
import { main, parseArgs } from './verify-patent-draft-calibration.ts'

/** Claims with a numbering gap and a missing terminator. */
const MESSY_CLAIMS = [
  '1. 一种传动装置，包括：主动齿轮；从动齿轮，用于传递扭矩。',
  '3. 根据权利要求1所述的传动装置，所述主动齿轮为钢制。',
].join('\n')

/** The same claims with both structural defects repaired. */
const CLEAN_CLAIMS = [
  '1. 一种传动装置，包括：主动齿轮；从动齿轮，所述从动齿轮与所述主动齿轮啮合。',
  '2. 根据权利要求1所述的传动装置，所述主动齿轮为钢制。',
].join('\n')

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
 * Build a synthetic corpus, its manifest, and an unused artifact path.
 * @returns Paths to pass as `--corpus`, `--manifest`, and `--artifact`.
 */
function makeCorpus(): { dir: string; manifest: string; artifact: string } {
  const dir = scratch('draft-calibration-cli-corpus')
  writeFileSync(join(dir, 'gear-a.txt'), MESSY_CLAIMS, 'utf8')
  writeFileSync(join(dir, 'gear-b.txt'), CLEAN_CLAIMS, 'utf8')
  const parent = scratch('draft-calibration-cli-manifest')
  const manifest = join(parent, 'cases.yaml')
  writeFileSync(manifest, 'pairs:\n  - { stem: gear, pre: gear-a.txt, post: gear-b.txt }\n', 'utf8')
  return { dir, manifest, artifact: join(parent, 'artifact.json') }
}

/**
 * Run the command with its output captured.
 * @param args - Command line arguments.
 * @returns The exit code and the captured lines.
 */
async function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    return { code: await main(args), out: log.mock.calls.map(call => String(call[0])).join('\n'), err: error.mock.calls.map(call => String(call[0])).join('\n') }
  } finally {
    log.mockRestore()
    error.mockRestore()
  }
}

/**
 * Measure a synthetic corpus the way the command does.
 * @param corpus - Corpus directory and manifest.
 * @returns The artifact built from the measurement.
 */
async function measuredArtifact(corpus: { dir: string; manifest: string }): Promise<CalibrationArtifact> {
  const entries = parseCalibrationManifest(readFileSync(corpus.manifest, 'utf8'))
  const cases = await buildCalibrationCases(readCalibrationPairs(corpus.dir, entries))
  return buildArtifact(cases, { minPairs: 1, minAgreement: 0.5, agreementAxes: ['lint-errors'] }, CALIBRATION_REGENERATE_COMMAND)
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('parseArgs', () => {
  it('defaults to stored-only verification', () => {
    expect(parseArgs([])).toEqual({
      help: false, write: false, manifest: undefined, corpus: undefined, artifact: undefined, thresholds: undefined,
    })
  })

  it('reads every flag', () => {
    const options = parseArgs([
      '--manifest', 'cases.yaml', '--corpus', 'texts', '--write', '--artifact', 'other.json',
      '--min-pairs', '12', '--min-agreement', '0.6', '--agreement-axes', 'lint-errors,slop-total',
    ])
    expect(options.write).toBe(true)
    expect(options.manifest).toBe('cases.yaml')
    expect(options.corpus).toBe('texts')
    expect(options.artifact).toBe('other.json')
    expect(options.thresholds).toEqual({ minPairs: 12, minAgreement: 0.6, agreementAxes: ['lint-errors', 'slop-total'] })
  })

  it('treats -h as help', () => {
    expect(parseArgs(['-h']).help).toBe(true)
  })

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['--recalibrate'])).toThrow('未知选项：--recalibrate')
  })

  it('rejects a flag with no value or a value that is another flag', () => {
    expect(() => parseArgs(['--manifest'])).toThrow('--manifest 需要一个值')
    expect(() => parseArgs(['--corpus', '--write'])).toThrow('--corpus 需要一个值')
  })

  it('rejects a partial threshold set', () => {
    expect(() => parseArgs(['--min-pairs', '12'])).toThrow('要一起给出')
    expect(() => parseArgs(['--min-agreement', '0.6', '--agreement-axes', 'spec-score'])).toThrow('要一起给出')
  })

  it('rejects a pair count that is not a positive integer', () => {
    expect(() => parseArgs(['--min-pairs', '0'])).toThrow('--min-pairs 需要正整数')
    expect(() => parseArgs(['--min-pairs', '2.5'])).toThrow('--min-pairs 需要正整数')
    expect(() => parseArgs(['--min-pairs', 'many'])).toThrow('--min-pairs 需要正整数')
  })

  it('rejects an agreement rate outside 0-1', () => {
    expect(() => parseArgs(['--min-agreement', '1.5'])).toThrow('--min-agreement 需要 0-1 的比率')
    expect(() => parseArgs(['--min-agreement', '-0.2'])).toThrow('--min-agreement 需要 0-1 的比率')
  })

  it('rejects an unknown axis or an empty axis list', () => {
    expect(() => parseArgs(['--agreement-axes', 'lint-moons'])).toThrow('含未知检查轴 lint-moons')
    expect(() => parseArgs(['--agreement-axes', ' , '])).toThrow('需要至少一条检查轴')
  })
})

describe('main stored-only', () => {
  it('prints the usage and succeeds', async () => {
    const result = await run(['--help'])
    expect(result.code).toBe(0)
    expect(result.out).toContain('校验代理师改稿校准产物')
  })

  it('refuses while the artifact is absent', async () => {
    const path = join(scratch('draft-calibration-cli-missing'), 'absent.json')
    const result = await run(['--artifact', path])
    expect(result.code).toBe(1)
    expect(result.err).toContain('不存在')
    expect(result.err).toContain('--write')
  })

  it('accepts a self-consistent artifact and prints the report', async () => {
    const corpus = makeCorpus()
    writeFileSync(corpus.artifact, JSON.stringify(await measuredArtifact(corpus), null, 2), 'utf8')
    const result = await run(['--artifact', corpus.artifact])
    expect(result.err).toBe('')
    expect(result.code).toBe(0)
    expect(result.out).toContain('已提交件自洽')
    expect(result.out).toContain('| 检查轴 | 同向 | 未变 | 反向 |')
  })

  it('fails when a stored aggregate no longer matches its rows', async () => {
    const corpus = makeCorpus()
    const artifact = await measuredArtifact(corpus)
    const tampered = { ...artifact, summary: { ...artifact.summary, pairs: 99 } }
    writeFileSync(corpus.artifact, JSON.stringify(tampered, null, 2), 'utf8')
    const result = await run(['--artifact', corpus.artifact])
    expect(result.code).toBe(1)
    expect(result.err).toContain('summary.pairs does not match the rows')
  })

  it('propagates a shape error naming the field', async () => {
    const corpus = makeCorpus()
    writeFileSync(corpus.artifact, JSON.stringify({ schema: 7 }), 'utf8')
    await expect(run(['--artifact', corpus.artifact])).rejects.toThrow('artifact schema 7 is not 1')
  })
})

describe('main with a corpus', () => {
  it('refuses a one-sided corpus pair declaration', async () => {
    const path = join(scratch('draft-calibration-cli-oneway'), 'artifact.json')
    const result = await run(['--write', '--artifact', path])
    expect(result.code).toBe(1)
    expect(result.err).toContain('--manifest 与 --corpus 要一起给出')
  })

  it('refuses to invent thresholds for a first write', async () => {
    const corpus = makeCorpus()
    const path = join(scratch('draft-calibration-cli-fresh'), 'artifact.json')
    const result = await run(['--manifest', corpus.manifest, '--corpus', corpus.dir, '--artifact', path])
    expect(result.code).toBe(1)
    expect(result.err).toContain('首次落盘要给出 --min-pairs')
  })

  it('writes when the measurement clears the declared floors', async () => {
    const corpus = makeCorpus()
    const dir = scratch('draft-calibration-cli-write')
    const path = join(dir, 'artifact.json')
    const result = await run([
      '--manifest', corpus.manifest, '--corpus', corpus.dir, '--artifact', path, '--write',
      '--min-pairs', '1', '--min-agreement', '0.5', '--agreement-axes', 'lint-errors',
    ])
    expect(result.err).toBe('')
    expect(result.code).toBe(0)
    expect(result.out).toContain('已写入')
    const stored = parseCalibrationArtifact(readFileSync(path, 'utf8'))
    expect(stored.summary.pairs).toBe(1)
    expect(stored.thresholds).toEqual({ minPairs: 1, minAgreement: 0.5, agreementAxes: ['lint-errors'] })
    expect(verifyCalibrationArtifact(stored)).toEqual([])
  })

  it('refuses to write a corpus that is below its own floor', async () => {
    const corpus = makeCorpus()
    const result = await run([
      '--manifest', corpus.manifest, '--corpus', corpus.dir, '--artifact', corpus.artifact, '--write',
      '--min-pairs', '9', '--min-agreement', '0.5', '--agreement-axes', 'lint-errors',
    ])
    expect(result.code).toBe(1)
    expect(result.err).toContain('1 pairs is below the declared minimum 9')
    let exists = true
    try {
      readFileSync(corpus.artifact, 'utf8')
    } catch {
      exists = false
    }
    expect(exists).toBe(false)
  })

  it('reports a re-measurement that matches, line by line', async () => {
    const corpus = makeCorpus()
    writeFileSync(corpus.artifact, JSON.stringify(await measuredArtifact(corpus), null, 2), 'utf8')
    const result = await run(['--manifest', corpus.manifest, '--corpus', corpus.dir, '--artifact', corpus.artifact])
    expect(result.code).toBe(0)
    expect(result.out).toContain('语料重测与已提交件逐行一致')
  })

  it('reports which row moved when the checks changed', async () => {
    const corpus = makeCorpus()
    const artifact = await measuredArtifact(corpus)
    const row = artifact.cases[0]
    if (row === undefined) throw new Error('fixture row missing')
    const stale = { ...artifact, cases: [{ ...row, post: { ...row.post, lintErrors: row.post.lintErrors + 2 } }] }
    writeFileSync(corpus.artifact, JSON.stringify(stale, null, 2), 'utf8')
    const result = await run(['--manifest', corpus.manifest, '--corpus', corpus.dir, '--artifact', corpus.artifact])
    expect(result.code).toBe(1)
    expect(result.err).toContain(`case ${row.alias} readings changed`)
    expect(result.err).toContain('本次测量与已提交件不一致')
  })

  it('surfaces a manifest that names a file twice', async () => {
    const corpus = makeCorpus()
    writeFileSync(corpus.manifest, 'pairs:\n  - { stem: a, pre: gear-a.txt, post: gear-b.txt }\n  - { stem: b, pre: gear-a.txt, post: gear-b.txt }\n', 'utf8')
    await expect(run(['--manifest', corpus.manifest, '--corpus', corpus.dir, '--artifact', corpus.artifact, '--write',
      '--min-pairs', '1', '--min-agreement', '0.5', '--agreement-axes', 'lint-errors'])).rejects.toThrow('reuses file gear-a.txt')
  })
})
