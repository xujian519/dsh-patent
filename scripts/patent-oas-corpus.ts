/**
 * 公开授权文本语料的无 key 校验。
 *
 * 这些条目放在 `examples/patent-oas/corpus/`,与 `cases/` 分开:不进金标摘要,
 * 没有 rubric,也不由 `seed.mjs` 复制进基准库。清单写明计划件数;条目数必须与它相等。
 * 代理师改稿的计划数固定为 5,仓库里的件数必须是 0。
 *
 * @module
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { JSON_SCHEMA, load as loadYaml } from 'js-yaml'

/** 校验结果。有问题时件数为 0,避免把不完整清单当成已入库。 */
export interface PublicGrantCorpusStatus {
  /** 违反公开授权文本规则的诊断,空数组表示通过。 */
  readonly problems: readonly string[]
  /** 清单中的去法律化授权文本件数。 */
  readonly grants: number
  /** 各件附图幅数之和。 */
  readonly figures: number
  /** 仓库里的代理师改稿或客户文稿件数。 */
  readonly attorneyRevisions: number
  /** 清单声明、仍未入库的代理师改稿计划件数。 */
  readonly plannedAttorneyRevisions: number
}

/** 代理师改稿的计划件数。真实客户文稿不能入库,这个数不能改成 0 来抹掉缺口。 */
const PLANNED_ATTORNEY_REVISIONS = 5

/** 转述里一旦出现这些说法,就不再是公开授权文本。 */
const FORBIDDEN_STATEMENT_PHRASES = ['客户交底', '客户案卷', '真实交底书', '代理师改稿'] as const

/** 判断一个值是否是普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 读出 Node 文件系统错误的 `code`。 */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = error.code
  return typeof code === 'string' ? code : undefined
}

/** 有问题或尚未读到清单时的空计数。 */
function blank(problems: readonly string[], attorneyRevisions = 0): PublicGrantCorpusStatus {
  return { problems, grants: 0, figures: 0, attorneyRevisions, plannedAttorneyRevisions: 0 }
}

/**
 * 读取并校验一份公开授权文本语料。
 *
 * @param corpusDir `corpus/` 的绝对路径。
 * @returns 诊断与件数。语义问题放进 `problems`,不抛错。
 */
export async function loadPublicGrantCorpus(corpusDir: string): Promise<PublicGrantCorpusStatus> {
  const problems: string[] = []
  let attorneyRevisions = 0
  let rootEntries: { name: string; isDirectory: boolean }[]
  try {
    const entries = await readdir(corpusDir, { withFileTypes: true })
    rootEntries = entries.map(entry => ({ name: entry.name, isDirectory: entry.isDirectory() }))
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') return blank(['corpus/manifest.yaml: 缺少清单'])
    const message = error instanceof Error ? error.message : String(error)
    return blank([`corpus: 无法读取(${message})`])
  }

  for (const entry of rootEntries) {
    if (entry.name === 'manifest.yaml' || entry.name === 'items') continue
    if (/attorney|client|代理|客户/iu.test(entry.name)) {
      attorneyRevisions += 1
      problems.push(`corpus/${entry.name}: 真实客户文稿与代理师改稿未获授权入库`)
      continue
    }
    problems.push(`corpus/${entry.name}: 公开授权语料只允许 manifest.yaml 与 items/`)
  }

  let manifestText: string
  try {
    manifestText = await readFile(join(corpusDir, 'manifest.yaml'), 'utf8')
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') problems.push('corpus/manifest.yaml: 缺少清单')
    else problems.push(`corpus/manifest.yaml: 无法读取(${error instanceof Error ? error.message : String(error)})`)
    return blank(problems, attorneyRevisions)
  }

  let parsed: unknown
  try {
    parsed = loadYaml(manifestText, { schema: JSON_SCHEMA })
  } catch (error: unknown) {
    problems.push(`corpus/manifest.yaml: 不是合法 YAML(${error instanceof Error ? error.message : String(error)})`)
    return blank(problems, attorneyRevisions)
  }
  if (!isRecord(parsed)) {
    problems.push('corpus/manifest.yaml: 清单必须是映射')
    return blank(problems, attorneyRevisions)
  }

  const kind = parsed.kind
  if (kind !== 'public-grant') {
    problems.push(
      kind === 'client' || kind === 'attorney-revision'
        ? `corpus/manifest.yaml: kind 为 ${kind},真实客户文稿未获授权入库`
        : `corpus/manifest.yaml: kind 必须是 public-grant,实际为 ${JSON.stringify(kind)}`,
    )
  }

  const plannedGrants = parsed.plannedDelegalizedGrants
  if (typeof plannedGrants !== 'number' || !Number.isInteger(plannedGrants) || plannedGrants < 1) {
    problems.push('corpus/manifest.yaml: plannedDelegalizedGrants 必须是正整数')
  }
  const plannedAttorney = parsed.plannedAttorneyRevisions
  if (plannedAttorney !== PLANNED_ATTORNEY_REVISIONS) {
    problems.push(`corpus/manifest.yaml: plannedAttorneyRevisions 必须是 ${PLANNED_ATTORNEY_REVISIONS},代理师改稿仍未入库`)
  }

  const rawItems = parsed.items
  if (!Array.isArray(rawItems)) {
    problems.push('corpus/manifest.yaml: items 必须是条目数组')
    return blank(problems, attorneyRevisions)
  }
  if (typeof plannedGrants === 'number' && rawItems.length !== plannedGrants) {
    problems.push(`corpus/manifest.yaml: plannedDelegalizedGrants 为 ${plannedGrants},实际条目 ${rawItems.length}`)
  }

  const items = rawItems.map((item, index) => readItem(item, index, problems))
  const listedIds = items.flatMap(item => item === undefined ? [] : [item.id])
  await checkItemDirectories(corpusDir, listedIds, problems)
  let figures = 0
  for (const item of items) {
    if (item === undefined) continue
    figures += item.figures
    await checkStatement(corpusDir, item, problems)
  }

  if (problems.length > 0) return blank(problems, attorneyRevisions)
  return {
    problems,
    grants: items.length,
    figures,
    attorneyRevisions,
    plannedAttorneyRevisions: PLANNED_ATTORNEY_REVISIONS,
  }
}

/** 清单里通过结构校验的一条授权文本。 */
interface GrantItem {
  readonly id: string
  readonly publication: string
  readonly figures: number
}

/**
 * 读一条清单记录。结构不对时写入 `problems` 并跳过该条。
 *
 * @param item 清单数组中的一项。
 * @param index 该项下标。
 * @param problems 诊断收集处。
 * @returns 可继续核对目录与转述的条目;该条无法核对时为 undefined。
 */
function readItem(item: unknown, index: number, problems: string[]): GrantItem | undefined {
  const where = `corpus/manifest.yaml items[${index}]`
  if (!isRecord(item)) {
    problems.push(`${where}: 必须是映射`)
    return undefined
  }
  const id = readText(item, 'id', where, problems)
  const publication = readText(item, 'publication', where, problems)
  const source = readText(item, 'source', where, problems)
  const title = readText(item, 'title', where, problems)
  const figures = item.figures
  if (typeof figures !== 'number' || !Number.isInteger(figures) || figures < 1) {
    problems.push(`${where}: figures 必须是正整数`)
  }
  if (id === undefined || publication === undefined || source === undefined || title === undefined) return undefined
  if (!/^CN\d+U$/u.test(publication)) {
    problems.push(`${where}: publication 必须是实用新型授权公告号(CN…U)`)
  }
  if (id !== publication.toLowerCase()) {
    problems.push(`${where}: id 必须是公开号的小写,实际为 ${JSON.stringify(id)}`)
  }
  const expectedSource = `https://patents.google.com/patent/${publication}/zh`
  if (source !== expectedSource) {
    problems.push(`${where}: source 必须是 ${expectedSource}`)
  }
  if (typeof figures !== 'number' || !Number.isInteger(figures) || figures < 1) return undefined
  return { id, publication, figures }
}

/**
 * 读一个必填的非空字符串字段。
 *
 * @param source 映射对象。
 * @param key 字段名。
 * @param where 诊断位置。
 * @param problems 诊断收集处。
 * @returns 字段文本;缺失或类型不符时为 undefined。
 */
function readText(
  source: Record<string, unknown>,
  key: string,
  where: string,
  problems: string[],
): string | undefined {
  const value = source[key]
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push(`${where}: 字段 "${key}" 必须是非空字符串`)
    return undefined
  }
  return value
}

/**
 * 核对 `items/` 恰好是清单列出的条目目录。
 *
 * @param corpusDir `corpus/` 的绝对路径。
 * @param listedIds 清单中的条目 id。
 * @param problems 诊断收集处。
 */
async function checkItemDirectories(corpusDir: string, listedIds: readonly string[], problems: string[]): Promise<void> {
  let entries: { name: string; isDirectory: boolean }[]
  try {
    const found = await readdir(join(corpusDir, 'items'), { withFileTypes: true })
    entries = found.map(entry => ({ name: entry.name, isDirectory: entry.isDirectory() }))
  } catch (error: unknown) {
    if (errorCode(error) === 'ENOENT') problems.push('corpus/items: 缺少条目目录')
    else problems.push(`corpus/items: 无法读取(${error instanceof Error ? error.message : String(error)})`)
    return
  }
  const present = new Set(entries.filter(entry => entry.isDirectory).map(entry => entry.name))
  for (const entry of entries) {
    if (!entry.isDirectory) problems.push(`corpus/items/${entry.name}: 条目必须是目录`)
  }
  for (const id of listedIds) {
    if (!present.has(id)) problems.push(`corpus/items/${id}: 缺少条目目录`)
  }
  for (const name of present) {
    if (!listedIds.includes(name)) problems.push(`corpus/items/${name}: 清单没有这个条目`)
  }
  const seen = new Set<string>()
  for (const id of listedIds) {
    if (seen.has(id)) problems.push(`corpus/manifest.yaml: 重复条目 "${id}"`)
    seen.add(id)
  }
}

/**
 * 核对一条转述只引用自己的公开号和附图幅数,并且不是客户文稿。
 *
 * @param corpusDir `corpus/` 的绝对路径。
 * @param item 已通过结构校验的条目。
 * @param problems 诊断收集处。
 */
async function checkStatement(corpusDir: string, item: GrantItem, problems: string[]): Promise<void> {
  const itemDir = join(corpusDir, 'items', item.id)
  let entries: { name: string; isDirectory: boolean }[]
  try {
    const found = await readdir(itemDir, { withFileTypes: true })
    entries = found.map(entry => ({ name: entry.name, isDirectory: entry.isDirectory() }))
  } catch (error: unknown) {
    if (errorCode(error) !== 'ENOENT') {
      problems.push(`corpus/items/${item.id}: 无法读取(${error instanceof Error ? error.message : String(error)})`)
    }
    return
  }
  const files = entries.filter(entry => !entry.isDirectory).map(entry => entry.name).sort()
  const dirs = entries.filter(entry => entry.isDirectory).map(entry => entry.name)
  if (files.join(',') !== 'statement' || dirs.length > 0) {
    const listing = [...files, ...dirs.map(name => `${name}/`)].join(', ')
    problems.push(`corpus/items/${item.id}: 只能有 statement,实际为 [${listing}]`)
    return
  }
  const statement = await readFile(join(itemDir, 'statement'), 'utf8')
  const where = `corpus/items/${item.id}/statement`
  if (!statement.includes(item.publication)) problems.push(`${where}: 必须写明公开号 ${item.publication}`)
  if (!statement.includes('公开授权文本')) problems.push(`${where}: 必须写明公开授权文本`)
  const figurePhrase = `附图${item.figures}幅`
  if (!statement.includes(figurePhrase)) problems.push(`${where}: 必须写明${figurePhrase}`)
  if (!statement.includes('不是客户材料')) problems.push(`${where}: 必须写明不是客户材料`)
  for (const phrase of FORBIDDEN_STATEMENT_PHRASES) {
    if (statement.includes(phrase)) problems.push(`${where}: 不得写成${phrase}`)
  }
}
