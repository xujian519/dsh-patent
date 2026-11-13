/**
 * Load and validate the shipped legal-law index.
 *
 * The index carries what a citation can be decided against: which articles
 * exist, the topic keywords each covers, and the transcription record (`text`,
 * `sourceDoc`, `verifiedOn`). A missing or malformed file fails the plugin
 * load, because a gate that silently runs with no index would report every
 * citation as checked.
 *
 * The directory holds one manifest (`manifest.json`) naming the file behind
 * each law, plus one YAML file per law. {@link createLegalLawIndex} reads the
 * manifest and parses only the laws a citation names; the whole-corpus loaders
 * stay for callers that need every law at once.
 * @module @deepseek-ai/dsh-legal-law/baseline
 */

import { readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  IndexAssetError,
  parseYamlMapping,
  readArticleEntries,
  readOptionalCount,
  readOptionalDate,
  readOptionalString,
  readString,
  type AssetFail,
} from '@deepseek-ai/dsh-patent-index-asset'
import { LEGAL_LAW_MANIFEST_FILE, legalLawBaselineDir, listLegalLawFiles } from './asset-location.ts'
import { rebuildStatutePattern } from './reference.ts'
import type {
  LegalArticleEntry,
  LegalLawBaseline,
  LegalLawIndex,
  LegalLawIndexEntry,
  LegalLawManifest,
  LegalLawName,
} from './types.ts'

/** Thrown when a legal-law index asset is missing, unreadable, or malformed. */
export class LegalLawBaselineError extends IndexAssetError {
  /**
   * @param message - what is wrong with the asset.
   * @param origin - the file the error came from.
   */
  constructor(message: string, origin: string | null) {
    super(message, origin)
    this.name = 'LegalLawBaselineError'
  }
}

/**
 * Law names the reference parser currently recognizes. The initial four are
 * hand-indexed; {@link loadLegalLawBaselines} adds every name a loaded asset
 * declares, so the set grows with the shipped index.
 */
const _knownNames = new Set<LegalLawName>(['民法典', '民事诉讼法', '劳动合同法', '公司法'])

/** Document titles → short law names, so a formal title resolves without a dedicated map entry. */
const _knownAliases = new Map<string, LegalLawName>()

/**
 * Snapshot of the law names the parser recognizes right now.
 *
 * A snapshot keeps callers from mutating the parser's name set through the
 * returned array; call it again after loading another index to see the names
 * that load added.
 * @returns the current names, frozen in insertion order.
 */
export function legalLawNames(): readonly LegalLawName[] {
  return Object.freeze([..._knownNames])
}

/**
 * List the index files a load would parse.
 * @param baselineDir - directory override; defaults to the packaged assets.
 * @returns the resolved directory and its `.yaml` files.
 * @throws LegalLawBaselineError when the directory is unreadable or empty.
 */
function legalLawIndexFiles(baselineDir?: string): string[] {
  const dir = legalLawBaselineDir(baselineDir)
  let files: string[]
  try {
    files = listLegalLawFiles(dir)
  } catch (error) {
    throw new LegalLawBaselineError(`法条索引目录不可读：${dir}（${(error as Error).message}）`, dir)
  }
  if (files.length === 0) throw new LegalLawBaselineError(`法条索引目录下没有 .yaml 文件：${dir}`, dir)
  return files
}

/**
 * Check that the index directory exists, holds at least one `.yaml` file, and
 * ships its manifest, without parsing any of them. Plugin registration uses
 * this so a missing asset fails the deployment while the 72 MB index is parsed
 * only when the tool runs.
 * @param baselineDir - directory override; defaults to the packaged assets.
 * @throws LegalLawBaselineError when the directory is unreadable or empty, or the manifest is missing.
 */
export function assertLegalLawIndexReadable(baselineDir?: string): void {
  legalLawIndexFiles(baselineDir)
  const manifest = join(legalLawBaselineDir(baselineDir), LEGAL_LAW_MANIFEST_FILE)
  try {
    statSync(manifest)
  } catch (error) {
    throw new LegalLawBaselineError(`法条索引清单不可读：${manifest}（${(error as Error).message}）`, manifest)
  }
}

/**
 * Parse the index manifest: one `[law, document, file]` row per law.
 * @param source - the manifest's JSON text.
 * @param origin - the manifest path, used in error messages.
 * @returns the manifest, keyed by law name in the order it lists them.
 * @throws LegalLawBaselineError when the JSON is malformed, a row is not three non-empty strings, or a law or file is listed twice.
 */
export function parseLegalLawManifest(source: string, origin: string): LegalLawManifest {
  const fail: AssetFail = message => new LegalLawBaselineError(message, origin)
  let root: unknown
  try {
    root = JSON.parse(source)
  } catch (error) {
    throw fail(`法条索引清单不是合法 JSON：${(error as Error).message}`)
  }
  if (typeof root !== 'object' || root === null || !('laws' in root)) {
    throw fail('法条索引清单必须声明 laws 数组')
  }
  const rows: unknown = root.laws
  if (!Array.isArray(rows)) throw fail('法条索引清单的 laws 必须是数组')

  const manifest = new Map<LegalLawName, LegalLawIndexEntry>()
  const files = new Set<string>()
  for (const row of rows) {
    const entry = readManifestRow(row, manifest.size, fail)
    if (manifest.has(entry.law)) throw fail(`同一部法律被索引了两次：${entry.law}`)
    if (files.has(entry.file)) throw fail(`同一索引文件被登记了两次：${entry.file}`)
    manifest.set(entry.law, entry)
    files.add(entry.file)
  }
  if (manifest.size === 0) throw fail('法条索引清单没有登记任何法律')
  return manifest
}

/** Read one manifest row, rejecting anything that is not three non-empty strings. */
function readManifestRow(row: unknown, index: number, fail: AssetFail): LegalLawIndexEntry {
  if (!Array.isArray(row)) throw fail(`法条索引清单第 ${index + 1} 条必须是 [law, document, file] 数组`)
  const cells: unknown[] = row
  const [law, document, file] = cells
  if (cells.length !== 3 || typeof law !== 'string' || typeof document !== 'string' || typeof file !== 'string') {
    throw fail(`法条索引清单第 ${index + 1} 条必须是三个字符串 [law, document, file]`)
  }
  if (law.trim() === '' || document.trim() === '' || file.trim() === '') {
    throw fail(`法条索引清单第 ${index + 1} 条有空字段：${JSON.stringify(cells)}`)
  }
  if (!file.endsWith('.yaml') || file.includes('/') || file.includes('\\') || file.startsWith('..')) {
    throw fail(`法条索引清单第 ${index + 1} 条的文件必须是索引目录内的 .yaml 文件：${file}`)
  }
  return { law, document, file }
}

/**
 * Create an index that learns its law names from the manifest and parses a
 * law's file only when a citation names it.
 *
 * One index caches the manifest and every baseline it loaded, so repeated
 * verifications in the same tool instance parse each law at most once. A failed
 * manifest read or file load leaves the next call free to retry.
 * @param baselineDir - directory override; defaults to the packaged assets.
 * @returns the index.
 */
export function createLegalLawIndex(baselineDir?: string): LegalLawIndex {
  const dir = legalLawBaselineDir(baselineDir)
  const baselines = new Map<LegalLawName, LegalLawBaseline>()
  const loading = new Map<LegalLawName, Promise<LegalLawBaseline>>()
  let manifest: Promise<LegalLawManifest> | undefined

  const manifestOf = (): Promise<LegalLawManifest> => {
    manifest ??= readLegalLawManifest(dir).then(
      (loaded) => {
        registerManifestNames(loaded)
        return loaded
      },
      (error: unknown) => {
        manifest = undefined
        throw error
      },
    )
    return manifest
  }

  const manifestFor = async (signal?: AbortSignal): Promise<LegalLawManifest> => {
    throwIfStopped(signal)
    const loaded = await stopWith(manifestOf(), signal)
    throwIfStopped(signal)
    return loaded
  }

  const loadOne = (entry: LegalLawIndexEntry): Promise<LegalLawBaseline> => {
    const cached = baselines.get(entry.law)
    if (cached !== undefined) return Promise.resolve(cached)
    const inFlight = loading.get(entry.law)
    if (inFlight !== undefined) return inFlight
    const file = join(dir, entry.file)
    const pending = (async () => {
      const source = await readIndexFile(file).catch((error: unknown) => {
        throw new LegalLawBaselineError(`法条索引文件不可读：${file}（${(error as Error).message}）`, file)
      })
      const baseline = parseLegalLawBaseline(source, file)
      if (baseline.law !== entry.law || baseline.document !== entry.document) {
        throw new LegalLawBaselineError(
          `法条索引清单与文件不一致：清单登记 ${entry.law}/《${entry.document}》，文件声明 ${baseline.law}/《${baseline.document}》`,
          file,
        )
      }
      baselines.set(baseline.law, baseline)
      return baseline
    })()
    loading.set(entry.law, pending)
    pending.then(
      () => { loading.delete(entry.law) },
      () => { loading.delete(entry.law) },
    )
    return pending
  }

  return {
    async loadNames(signal) {
      const loaded = await manifestFor(signal)
      return Object.freeze([...loaded.keys()])
    },
    async load(laws, signal) {
      const loaded = await manifestFor(signal)
      const found = new Map<LegalLawName, LegalLawBaseline>()
      for (const law of new Set(laws)) {
        throwIfStopped(signal)
        const entry = loaded.get(law)
        if (entry === undefined) continue
        found.set(law, await stopWith(loadOne(entry), signal))
      }
      throwIfStopped(signal)
      return found
    },
  }
}

/**
 * Settle with `work`, or reject with the signal's reason when the caller
 * cancels. The read itself is shared with other callers, so one caller's abort
 * stops only its own wait and leaves the read running for the others.
 * @param work - the shared operation.
 * @param signal - the caller's cancellation.
 * @returns the operation's outcome, or the signal's abort reason.
 */
function stopWith<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return work
  // Callers check first; this keeps an already-cancelled signal from hanging the
  // wait, since an abort event that already fired never reaches the listener.
  throwIfStopped(signal)
  return new Promise<T>((resolve, reject) => {
    const stop = (): void => { reject(asError(signal.reason)) }
    signal.addEventListener('abort', stop, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', stop)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', stop)
        reject(asError(error))
      },
    )
  })
}

/** Throw the caller's abort reason, normalized to an Error. */
function throwIfStopped(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw asError(signal.reason)
}

/** Present a rejection value as an Error; an abort reason may be any value. */
function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason), { cause: reason })
}

/** Read one index file. The read is shared, so it does not take a caller's signal. */
function readIndexFile(file: string): Promise<string> {
  return readFile(file, 'utf8')
}

/** Read the manifest from an index directory. */
async function readLegalLawManifest(dir: string): Promise<LegalLawManifest> {
  const file = join(dir, LEGAL_LAW_MANIFEST_FILE)
  let source: string
  try {
    source = await readIndexFile(file)
  } catch (error) {
    throw new LegalLawBaselineError(`法条索引清单不可读：${file}（${(error as Error).message}）`, file)
  }
  return parseLegalLawManifest(source, file)
}

/**
 * Load every legal-law index file in a directory, keyed by law name.
 * @param baselineDir - directory override; defaults to the packaged assets.
 * @returns the baselines by law name.
 * @throws LegalLawBaselineError when the directory is unreadable, empty, or holds a malformed file.
 */
export function loadLegalLawBaselines(baselineDir?: string): Map<LegalLawName, LegalLawBaseline> {
  const files = legalLawIndexFiles(baselineDir)

  const baselines = new Map<LegalLawName, LegalLawBaseline>()
  for (const file of files) {
    registerBaseline(baselines, parseLegalLawBaseline(readFileSync(file, 'utf8'), file), file)
  }
  finalizeStatutePattern()
  return baselines
}

/**
 * Load the index without holding the event loop for the whole 72 MB parse.
 *
 * The reads are asynchronous and the loop yields every batch, so a Web process
 * can serve other sessions while the first verification loads the corpus. The
 * synchronous {@link loadLegalLawBaselines} remains for callers that already
 * run outside the event loop.
 * @param baselineDir - directory override; defaults to the packaged assets.
 * @param signal - caller cancellation; an abort rejects the load, including during a file read.
 * @returns the baselines by law name.
 * @throws LegalLawBaselineError when the directory is unreadable, empty, or holds a malformed file.
 * @throws the signal's abort reason when the caller cancels.
 */
export async function loadLegalLawBaselinesAsync(
  baselineDir?: string,
  signal?: AbortSignal,
): Promise<Map<LegalLawName, LegalLawBaseline>> {
  const files = legalLawIndexFiles(baselineDir)

  const baselines = new Map<LegalLawName, LegalLawBaseline>()
  for (const file of files) {
    signal?.throwIfAborted()
    const baseline = parseLegalLawBaseline(await readFile(file, { encoding: 'utf8', signal }), file)
    registerBaseline(baselines, baseline, file)
    // Parsing one file is synchronous; yield so other sessions run between files.
    await new Promise<void>(resolve => setImmediate(resolve))
  }
  finalizeStatutePattern()
  return baselines
}

/** Register every law a manifest declares, so the parser recognizes it before any file is parsed. */
function registerManifestNames(manifest: LegalLawManifest): void {
  for (const entry of manifest.values()) {
    _knownNames.add(entry.law)
    registerAlias(entry.law, entry.document)
  }
  finalizeStatutePattern()
}

/** Add one parsed baseline, rejecting duplicate law names and tracking its alias. */
function registerBaseline(
  baselines: Map<LegalLawName, LegalLawBaseline>,
  baseline: LegalLawBaseline,
  file: string,
): void {
  if (baselines.has(baseline.law)) {
    throw new LegalLawBaselineError(`同一部法律被索引了两次：${baseline.law}`, file)
  }
  baselines.set(baseline.law, baseline)
  // Track known law names for discoverability
  _knownNames.add(baseline.law)
  registerAlias(baseline.law, baseline.document)
}

/** Map a document title to its short law name; a formal citation writes the title. */
function registerAlias(law: LegalLawName, document: string): void {
  // The index keys the entry by the short name (会计法) while the title carries
  // the formal one (中华人民共和国会计法), so both forms must resolve.
  const title = document.replace(/（[^）]*）$/u, '').trim()
  if (title !== '' && title !== law) _knownAliases.set(title, law)
}

/** Rebuild the statute-matching regex after a load added names or aliases. */
function finalizeStatutePattern(): void {
  rebuildStatutePattern([..._knownNames], _knownAliases)
}

/**
 * Parse one legal-law index file.
 * @param source - the file's text.
 * @param origin - the file path, used in error messages and findings.
 * @returns the parsed baseline.
 * @throws LegalLawBaselineError when a required field is missing or malformed.
 */
export function parseLegalLawBaseline(source: string, origin: string): LegalLawBaseline {
  const fail: AssetFail = message => new LegalLawBaselineError(message, origin)
  const root = parseYamlMapping(source, '法条索引', fail)
  const law = readString(root, 'law', fail)
  const document = readString(root, 'document', fail)
  const revision = readOptionalString(root, 'revision', fail)
  const maxArticle = readOptionalCount(root, 'maxArticle', fail)
  const maxVerifiedOn = readOptionalDate(root, 'maxVerifiedOn', fail)
  const maxSource = readOptionalString(root, 'maxSource', fail)
  const articles = readArticleEntries(root['articles'], fail)

  if (articles.length === 0) throw fail(`${law} 的索引必须声明至少一个 article`)

  // The file-level ceiling and verification date describe the same corpus the
  // entries belong to. A ceiling below an indexed article, or a verification
  // date older than an entry's, means the header and the body disagree, so the
  // index cannot be trusted as one version.
  const lastArticle = articles.reduce((max, entry) => Math.max(max, entry.article), 0)
  if (maxArticle !== null && maxArticle < lastArticle) {
    throw fail(`${law} 的 maxArticle=${String(maxArticle)} 小于索引中的最大条号 ${String(lastArticle)}`)
  }
  const latestVerifiedOn = articles
    .map(entry => entry.verifiedOn)
    .filter((date): date is string => date !== null)
    .sort()
    .at(-1)
  if (maxVerifiedOn !== null && latestVerifiedOn !== undefined && latestVerifiedOn > maxVerifiedOn) {
    throw fail(`${law} 的 maxVerifiedOn=${maxVerifiedOn} 早于条目的核验日期 ${latestVerifiedOn}`)
  }

  return {
    law,
    document,
    revision,
    maxArticle,
    maxVerifiedOn,
    maxSource,
    articles: [...articles].sort((a, b) => a.article - b.article),
  }
}

/**
 * Find one article in a baseline.
 * @param baseline - the law's baseline.
 * @param article - the article number.
 * @returns the entry, or undefined when the article is not indexed.
 */
export function findLegalArticle(baseline: LegalLawBaseline, article: number): LegalArticleEntry | undefined {
  return baseline.articles.find(entry => entry.article === article)
}
