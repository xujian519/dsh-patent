/**
 * Verify the attorney-revision calibration artifact, with no corpus in the repository.
 *
 * The artifact records how the shipped model-free draft checks moved across claim
 * sets a patent attorney actually amended, plus the resulting reading of the amended
 * side. Two things can go wrong after it is written, and they need different evidence
 * to catch, so the command has two modes.
 *
 * Without a corpus (what continuous integration runs), the stored rows are the only
 * input: every aggregate, the digest, the band of each row, and the declared floors are
 * recomputed from them, so an edited summary, a dropped pair, or a renamed alias fails
 * even though the texts are absent. A missing artifact fails too — a gate that skips
 * when its own baseline is gone reads as green and proves nothing.
 *
 * With `--manifest` and `--corpus`, the texts are re-measured and compared with the
 * stored rows, which is the only way to catch a drift inside the checks themselves.
 * `--write` replaces the artifact from that measurement after the leak scan and the
 * threshold check pass, so an under-counted corpus never lands as a baseline. Thresholds
 * carry over from the stored artifact unless all three flags are given together: lowering
 * a floor is a reviewable edit, not a side effect of re-measuring.
 *
 * Case text stays outside the repository. `generatedBy` names no path, aliases are
 * opaque, and the anonymity scan inside {@link verifyCalibrationArtifact} refuses an
 * artifact that carries an application number, a party field, or a run of source text.
 *
 * Usage:
 *   tsx scripts/verify-patent-draft-calibration.ts
 *   tsx scripts/verify-patent-draft-calibration.ts --manifest <cases.yaml> --corpus <case dir>
 *   tsx scripts/verify-patent-draft-calibration.ts --manifest <cases.yaml> --corpus <case dir> --write \
 *     [--min-pairs N --min-agreement X --agreement-axes a,b]
 *
 * @module dsh-scripts/verify-patent-draft-calibration
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  CALIBRATION_ARTIFACT_FILE,
  CALIBRATION_AXES,
  CALIBRATION_REGENERATE_COMMAND,
  buildArtifact,
  buildCalibrationCases,
  compareArtifacts,
  parseCalibrationArtifact,
  parseCalibrationManifest,
  readCalibrationPairs,
  renderCalibrationReport,
  verifyCalibrationArtifact,
  type CalibrationArtifact,
  type CalibrationAxis,
  type CalibrationThresholds,
} from './patent-draft-calibration.ts'

const defaultArtifactPath = resolve(import.meta.dirname, '..', CALIBRATION_ARTIFACT_FILE)

/** Command line as parsed. */
type Options = {
  /** Print usage and succeed. */
  help: boolean
  /** Replace the stored artifact from the measurement. */
  write: boolean
  /** Manifest naming the pairs; absent means stored-only verification. */
  manifest: string | undefined
  /** Directory holding the case files. */
  corpus: string | undefined
  /** Artifact location other than the committed one. */
  artifact: string | undefined
  /** Fully specified thresholds, or absent to inherit the stored ones. */
  thresholds: CalibrationThresholds | undefined
}

/** Usage text naming the modes and flags. */
const HELP = `verify-patent-draft-calibration: 校验代理师改稿校准产物

  (无参数)                        只校验已提交件：重算聚合、指纹、逐行档位与门槛
  --manifest <cases.yaml>         与仓外语料重算并比对
  --corpus <dir>                  改稿文本所在目录（与 --manifest 同时给出）
  --write                         按本次测量覆写已提交件（先过泄漏扫描与门槛）
  --artifact <path>               读写指定位置的产物，而不是仓内已提交件
  --min-pairs N --min-agreement X --agreement-axes a,b
                                  三条一起给出才生效，否则沿用已提交件里的门槛

产物：${CALIBRATION_ARTIFACT_FILE}
语料不进仓；产物只含不透明别名与数字。`

/**
 * Parse one command line.
 * @param args Arguments after the script path.
 * @returns The resolved options.
 * @throws Error on an unknown flag, a missing value, or a partial threshold set.
 */
export function parseArgs(args: readonly string[]): Options {
  let help = false
  let write = false
  let manifest: string | undefined
  let corpus: string | undefined
  let artifact: string | undefined
  let minPairs: number | undefined
  let minAgreement: number | undefined
  let agreementAxes: CalibrationAxis[] | undefined
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? ''
    switch (argument) {
      case '--help':
      case '-h':
        help = true
        break
      case '--write':
        write = true
        break
      case '--manifest':
        manifest = needValue(argument, args[index + 1])
        index += 1
        break
      case '--corpus':
        corpus = needValue(argument, args[index + 1])
        index += 1
        break
      case '--artifact':
        artifact = needValue(argument, args[index + 1])
        index += 1
        break
      case '--min-pairs':
        minPairs = needPositiveInteger(argument, needValue(argument, args[index + 1]))
        index += 1
        break
      case '--min-agreement':
        minAgreement = needRate(argument, needValue(argument, args[index + 1]))
        index += 1
        break
      case '--agreement-axes':
        agreementAxes = needAxes(needValue(argument, args[index + 1]))
        index += 1
        break
      default:
        throw new Error(`未知选项：${argument}`)
    }
  }
  const given = [minPairs, minAgreement, agreementAxes].filter(entry => entry !== undefined).length
  if (given > 0 && given < 3) throw new Error('--min-pairs、--min-agreement、--agreement-axes 要一起给出')
  if (minPairs === undefined || minAgreement === undefined || agreementAxes === undefined) {
    return { help, write, manifest, corpus, artifact, thresholds: undefined }
  }
  return {
    help,
    write,
    manifest,
    corpus,
    artifact,
    thresholds: { minPairs, minAgreement, agreementAxes },
  }
}

/**
 * Read the value that follows a flag.
 * @param argument - Flag being parsed.
 * @param value - Next token, if any.
 * @returns The token.
 * @throws Error when the flag was given last or its value looks like another flag.
 */
function needValue(argument: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('--')) throw new Error(`${argument} 需要一个值`)
  return value
}

/**
 * Parse a pair count.
 * @param argument - Flag being parsed.
 * @param value - Raw token.
 * @returns The positive integer.
 */
function needPositiveInteger(argument: string, value: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${argument} 需要正整数`)
  return parsed
}

/**
 * Parse an agreement rate.
 * @param argument - Flag being parsed.
 * @param value - Raw token.
 * @returns The rate in 0-1.
 */
function needRate(argument: string, value: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`${argument} 需要 0-1 的比率`)
  return parsed
}

/**
 * Parse the comma-separated axis list.
 * @param value - Raw token.
 * @returns The axes.
 * @throws Error on an empty list or an axis the artifact does not measure.
 */
function needAxes(value: string): CalibrationAxis[] {
  const axes: CalibrationAxis[] = []
  for (const name of value.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0)) {
    const axis = CALIBRATION_AXES.find(entry => entry === name)
    if (axis === undefined) throw new Error(`--agreement-axes 含未知检查轴 ${name}；可选：${CALIBRATION_AXES.join(', ')}`)
    axes.push(axis)
  }
  if (axes.length === 0) throw new Error('--agreement-axes 需要至少一条检查轴')
  return axes
}

/**
 * Read and parse an artifact file.
 * @param path - Artifact location.
 * @returns The artifact, or undefined when the file is absent.
 */
async function readStored(path: string): Promise<CalibrationArtifact | undefined> {
  try {
    return parseCalibrationArtifact(await readFile(path, 'utf8'))
  } catch (error) {
    if (isFileMissing(error)) return undefined
    throw error
  }
}

/**
 * Tell a missing file apart from a malformed artifact.
 * @param error - Thrown value.
 * @returns True for an ENOENT from the filesystem.
 */
function isFileMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
}

/**
 * Report the problems found in one or more artifacts.
 * @param problems - Problem descriptions.
 */
function reportProblems(problems: readonly string[]): void {
  for (const problem of problems) console.error(`verify-patent-draft-calibration: ${problem}`)
}

/**
 * Verify a stored artifact without touching any corpus.
 * @param path - Artifact location.
 * @returns Process exit code.
 */
async function verifyStoredOnly(path: string): Promise<number> {
  const stored = await readStored(path)
  if (stored === undefined) {
    console.error(
      `verify-patent-draft-calibration: ${path} 不存在；`
        + '基线缺失不放行。用 `--manifest <cases.yaml> --corpus <dir> --write` 从仓外语料落一份。',
    )
    return 1
  }
  const problems = verifyCalibrationArtifact(stored)
  if (problems.length > 0) {
    reportProblems(problems)
    return 1
  }
  console.log(
    `verify-patent-draft-calibration: 已提交件自洽（${stored.summary.pairs} 对，语料指纹 ${stored.corpusDigest.slice(0, 18)}…），`
      + `门槛 minPairs=${stored.thresholds.minPairs} minAgreement=${stored.thresholds.minAgreement}`
      + ` 轴 ${stored.thresholds.agreementAxes.join(', ') || '无'}。`,
  )
  console.log(renderCalibrationReport(stored))
  return 0
}

/**
 * Re-measure the corpus and compare, or write.
 * @param options - Parsed options carrying the corpus paths.
 * @param path - Artifact location to compare against or write to.
 * @returns Process exit code.
 */
async function measureCorpus(options: Options, path: string): Promise<number> {
  if (options.manifest === undefined || options.corpus === undefined) {
    console.error('verify-patent-draft-calibration: --manifest 与 --corpus 要一起给出')
    return 1
  }
  const manifestText = await readFile(resolve(process.cwd(), options.manifest), 'utf8')
  const entries = parseCalibrationManifest(manifestText)
  const pairs = readCalibrationPairs(resolve(process.cwd(), options.corpus), entries)
  const cases = await buildCalibrationCases(pairs)
  const stored = await readStored(path)
  let thresholds: CalibrationThresholds
  if (options.thresholds !== undefined) thresholds = options.thresholds
  else if (stored !== undefined) thresholds = stored.thresholds
  else {
    console.error(
      `verify-patent-draft-calibration: ${path} 不存在，门槛无从沿用；`
        + '首次落盘要给出 --min-pairs、--min-agreement、--agreement-axes。',
    )
    return 1
  }
  const measured = buildArtifact(cases, thresholds, CALIBRATION_REGENERATE_COMMAND)
  // The anonymity scan runs inside verifyCalibrationArtifact, so a leaking measurement
  // is refused before anything is rendered or written.
  const selfProblems = verifyCalibrationArtifact(measured)
  if (selfProblems.length > 0) {
    reportProblems(selfProblems)
    return 1
  }
  console.log(renderCalibrationReport(measured))
  if (!options.write) {
    if (stored === undefined) {
      console.error(
        `verify-patent-draft-calibration: ${path} 不存在，无从比对；确认读数后加 --write 落盘。`,
      )
      return 1
    }
    const storedProblems = verifyCalibrationArtifact(stored)
    const problems = [...storedProblems, ...compareArtifacts(stored, measured)]
    if (problems.length > 0) {
      reportProblems(problems)
      console.error('verify-patent-draft-calibration: 本次测量与已提交件不一致；检查改动的是门禁还是语料，再决定是否 --write')
      return 1
    }
    console.log('verify-patent-draft-calibration: 语料重测与已提交件逐行一致')
    return 0
  }
  await writeFile(path, `${JSON.stringify(measured, null, 2)}\n`, 'utf8')
  console.log(
    `verify-patent-draft-calibration: 已写入 ${path}`
      + `（${measured.summary.pairs} 对，语料指纹 ${measured.corpusDigest.slice(0, 18)}…）`,
  )
  return 0
}

/**
 * Run the command.
 * @param args - Command line arguments after the script path.
 * @returns Process exit code.
 */
export async function main(args: readonly string[]): Promise<number> {
  const options = parseArgs(args)
  if (options.help) {
    console.log(HELP)
    return 0
  }
  const path = options.artifact === undefined ? defaultArtifactPath : resolve(process.cwd(), options.artifact)
  if (options.manifest !== undefined || options.corpus !== undefined || options.write) return measureCorpus(options, path)
  return verifyStoredOnly(path)
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`verify-patent-draft-calibration: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  })
}
