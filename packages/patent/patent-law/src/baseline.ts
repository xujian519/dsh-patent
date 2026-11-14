/**
 * Load and validate the shipped law index.
 *
 * The index carries what a citation can be decided against: which articles and
 * guideline sections exist, the topic keywords each covers, and the transcription
 * record (`text`, `sourceDoc`, `verifiedOn`). A missing or malformed file fails
 * the plugin load, because a gate that silently runs with no index would report
 * every citation as checked.
 * @module @deepseek-ai/dsh-patent-law/baseline
 */

import { readFileSync } from 'node:fs'
import {
  IndexAssetError,
  checkRecordedSource,
  parseYamlMapping,
  readArticleEntries,
  readEntryTopics,
  readMapping,
  readOptionalCount,
  readOptionalDate,
  readOptionalString,
  readRecordedSource,
  readString,
  type AssetFail,
} from '@deepseek-ai/dsh-patent-index-asset'
import { lawBaselineDir, listLawFiles } from './asset-location.ts'
import type {
  ArticleEntry,
  GuidelineVersion,
  LawBaseline,
  LawName,
  SectionEntry,
  StaleSection,
} from './types.ts'

/** Thrown when a law-index asset is missing, unreadable, or malformed. */
export class LawBaselineError extends IndexAssetError {
  /**
   * @param message - what is wrong with the asset.
   * @param origin - the file the error came from.
   */
  constructor(message: string, origin: string | null) {
    super(message, origin)
    this.name = 'LawBaselineError'
  }
}

/** Law documents an index file may declare. */
export const LAW_NAMES: readonly LawName[] = [
  '专利法',
  '专利法实施细则',
  '专利审查指南',
  '最高人民法院关于审理专利授权确权行政案件适用法律若干问题的规定（一）',
  '最高人民法院关于审理专利纠纷案件适用法律问题的若干规定',
  '最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释',
  '最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释（二）',
  '最高人民法院关于审理涉专利权评价报告案件适用法律问题的批复',
  '最高人民法院关于审理申请注册的药品相关的专利权纠纷民事案件适用法律若干问题的规定',
  '最高人民法院关于审理侵害知识产权民事纠纷案件适用惩罚性赔偿的解释',
  '专利代理管理办法',
  '专利实施强制许可办法',
  '专利权质押登记办法',
  '专利标识标注办法',
  '专利行政执法办法',
  '关于规范专利申请行为的若干规定',
  '用于专利程序的生物材料保藏办法',
  '专利申请号标准',
]

/**
 * Load every law-index file in a directory, keyed by law name.
 * @param baselineDir - directory override; defaults to the packaged assets.
 * @returns the baselines by law name.
 * @throws LawBaselineError when the directory is unreadable, empty, or holds a malformed file.
 */
export function loadLawBaselines(baselineDir?: string): Map<LawName, LawBaseline> {
  const dir = lawBaselineDir(baselineDir)
  let files: string[]
  try {
    files = listLawFiles(dir)
  } catch (error) {
    throw new LawBaselineError(`法条索引目录不可读：${dir}（${(error as Error).message}）`, dir)
  }
  if (files.length === 0) throw new LawBaselineError(`法条索引目录下没有 .yaml 文件：${dir}`, dir)

  const baselines = new Map<LawName, LawBaseline>()
  for (const file of files) {
    const baseline = parseLawBaseline(readFileSync(file, 'utf8'), file)
    if (baselines.has(baseline.law)) {
      throw new LawBaselineError(`同一部法律被索引了两次：${baseline.law}`, file)
    }
    baselines.set(baseline.law, baseline)
  }
  // A directory missing one document would load, and every citation to that
  // document would report not-indexed instead of failing the deployment.
  const missing = LAW_NAMES.filter(name => !baselines.has(name))
  if (missing.length > 0) {
    throw new LawBaselineError(`法条索引缺少：${missing.join('、')}`, dir)
  }
  return baselines
}

/**
 * Parse one law-index file.
 * @param source - the file's text.
 * @param origin - the file path, used in error messages and findings.
 * @returns the parsed baseline.
 * @throws LawBaselineError when a required field is missing or malformed.
 */
export function parseLawBaseline(source: string, origin: string): LawBaseline {
  const fail: AssetFail = message => new LawBaselineError(message, origin)
  const root = parseYamlMapping(source, '法条索引', fail)
  const law = readString(root, 'law', fail)
  if (!isLawName(law)) throw fail(`未知的法律名称：${law}`)
  const document = readString(root, 'document', fail)
  const revision = readOptionalString(root, 'revision', fail)
  const supersededBy = readOptionalString(root, 'supersededBy', fail)
  const maxArticle = readOptionalCount(root, 'maxArticle', fail)
  const maxVerifiedOn = readOptionalDate(root, 'maxVerifiedOn', fail)
  const maxSource = readOptionalString(root, 'maxSource', fail)
  const articles = readArticleEntries(root['articles'], fail)
  const sections = readSections(root['sections'], fail)
  // Only the guideline carries section-level revisions and staleness; a statute
  // declares its superseding revision through `revision` alone.
  const staleSections = law === '专利审查指南'
    ? readStaleSections(root['staleSections'], fail, sections)
    : []
  const versions = law === '专利审查指南'
    ? readVersions(root['versions'], fail, revision)
    : []

  if (law === '专利审查指南') {
    if (articles.length > 0) throw fail('审查指南的索引只能声明 sections，不能声明 articles')
    if (sections.length === 0) throw fail('审查指南的索引必须声明至少一个 section')
  } else {
    if (sections.length > 0) throw fail(`${law} 的索引只能声明 articles，不能声明 sections`)
    if (articles.length === 0) throw fail(`${law} 的索引必须声明至少一个 article`)
    if (root['staleSections'] !== undefined && root['staleSections'] !== null) {
      throw fail(`${law} 的索引不能声明 staleSections`)
    }
    if (root['versions'] !== undefined && root['versions'] !== null) {
      throw fail(`${law} 的索引不能声明 versions`)
    }
  }

  return {
    law,
    document,
    revision,
    supersededBy,
    staleSections,
    versions,
    maxArticle,
    maxVerifiedOn,
    maxSource,
    articles: [...articles].sort((a, b) => a.article - b.article),
    sections: [...sections].sort((a, b) => a.path.localeCompare(b.path)),
  }
}

/**
 * Find one article in a baseline.
 * @param baseline - the law's baseline.
 * @param article - the article number.
 * @returns the entry, or undefined when the article is not indexed.
 */
export function findArticle(baseline: LawBaseline, article: number): ArticleEntry | undefined {
  return baseline.articles.find(entry => entry.article === article)
}

/**
 * Find one guideline section in a baseline.
 * @param baseline - the guideline baseline.
 * @param path - the normalized section path.
 * @returns the entry, or undefined when the section is not indexed.
 */
export function findSection(baseline: LawBaseline, path: string): SectionEntry | undefined {
  return baseline.sections.find(entry => entry.path === path)
}

/** True when a string names a law this package indexes. */
function isLawName(value: string): value is LawName {
  return (LAW_NAMES as readonly string[]).includes(value)
}

/** Read the guideline section list, rejecting duplicate paths. */
function readSections(value: unknown, fail: AssetFail): SectionEntry[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw fail('字段 sections 必须是数组')
  const seen = new Set<string>()
  return value.map((item) => {
    const entry = readMapping(item, 'sections 的每一项', fail)
    const path = readString(entry, 'path', fail)
    if (seen.has(path)) throw fail(`section path 重复：${path}`)
    seen.add(path)
    const text = readOptionalString(entry, 'text', fail)
    const source = readRecordedSource(entry, fail)
    checkRecordedSource(text, source, fail, path)
    return {
      path,
      topics: readEntryTopics(entry['topics'], fail, path),
      text,
      ...source,
    }
  })
}

/**
 * Read the stale-section records. A record must name an indexed section, so a
 * section path typo fails the load instead of silently leaving stale text
 * passing as current.
 */
function readStaleSections(value: unknown, fail: AssetFail, sections: readonly SectionEntry[]): StaleSection[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw fail('字段 staleSections 必须是数组')
  const indexed = new Set(sections.map(section => section.path))
  const seen = new Set<string>()
  return value.map((item) => {
    const entry = readMapping(item, 'staleSections 的每一项', fail)
    const path = readString(entry, 'path', fail)
    const reason = readString(entry, 'reason', fail)
    if (!indexed.has(path)) throw fail(`staleSections 引用了不存在的 section: ${path}`)
    if (seen.has(path)) throw fail(`staleSections 路径重复：${path}`)
    seen.add(path)
    return { path, reason }
  })
}

/**
 * Read revision-specific section overrides. A version must name a revision
 * different from the base one and carry at least one section; duplicate
 * revisions or duplicate paths inside one version fail the load.
 */
function readVersions(
  value: unknown,
  fail: AssetFail,
  baseRevision: string | null,
): GuidelineVersion[] {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw fail('字段 versions 必须是数组')
  const revisions = new Set<string>()
  return value.map((item) => {
    const entry = readMapping(item, 'versions 的每一项', fail)
    const revision = readString(entry, 'revision', fail)
    if (revision === baseRevision) throw fail(`versions 的 revision 不能与基础 revision 相同：${revision}`)
    if (revisions.has(revision)) throw fail(`versions 的 revision 重复：${revision}`)
    revisions.add(revision)
    const sections = readSections(entry['sections'], fail)
    if (sections.length === 0) throw fail(`versions ${revision} 必须至少声明一个 section`)
    // A later revision may add a section the base revision did not have, so a
    // path absent from the base index is an addition rather than an error.
    return { revision, sections: [...sections].sort((a, b) => a.path.localeCompare(b.path)) }
  })
}
