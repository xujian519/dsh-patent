/**
 * 附图标记表（作用域级，权威源）。
 *
 * 与 `figure/index-store.ts` 的识图索引是两件事：索引以 `imagePath` 为键、每张图
 * 一条，记的是「这张图被识别出什么」；本表以 `scope`（即出图时的 `figure_family`）
 * 为键、每个作用域一条，记的是「这个案件里某个部件用哪个标号」。生成、回填与校验
 * 三方因此可以读同一份表，「附图标记表是唯一标记源」在存储上成立。
 *
 * 同作用域的写入按文件路径串行（与前一个任务排队），失败不阻塞后续任务；跨进程
 * 并发不在本模块保证范围内——`createIndexStore` 的缓存与队列都是进程级的。
 * @module @deepseek-ai/dsh-patent-tools/figure/numeral-store
 */

import { createIndexStore } from '../internal/index-store.ts'

/** 标号表文件版本（结构不兼容时升版，旧文件按空表处理）。 */
export const FIGURE_NUMERAL_STORE_VERSION = 1 as const

/** 标号表文件默认位置（工作区根相对路径）。 */
export const DEFAULT_FIGURE_NUMERALS_RELATIVE_PATH = '.sati/figure-numerals.json'

/** 标号表的一项：一个部件在一个作用域内固定使用的标号。 */
export type FigureNumeralItem = {
  /** 组件标识（出图输入里的组件 id）。 */
  componentId: string
  /** 部件名称（生成时的标签，用于按名称对齐）。 */
  label: string
  /** 附图标记号。 */
  numeral: string
}

/** 一个作用域的完整标号表。 */
export type FigureNumeralEntry = {
  /** 作用域，取出生图时的 `figure_family`。 */
  scope: string
  /** 该作用域内的全部标号。 */
  numerals: FigureNumeralItem[]
}

/** 合并时被保留旧号而丢弃的新值。 */
export type NumeralMergeConflict = {
  /** 冲突的组件标识。 */
  componentId: string
  /** 表内已有的标号。 */
  kept: string
  /** 本次传入但未写入的标号。 */
  dropped: string
}

/** 合并写入的结果：合并后的完整标号表与被丢弃的冲突值。 */
export type NumeralMergeResult = {
  merged: FigureNumeralItem[]
  conflicts: NumeralMergeConflict[]
}

function isNumeralItem(value: unknown): value is FigureNumeralItem {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Partial<FigureNumeralItem>
  return typeof item.componentId === 'string'
    && typeof item.label === 'string'
    && typeof item.numeral === 'string'
}

function isFigureNumeralEntry(value: unknown): value is FigureNumeralEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Partial<FigureNumeralEntry>
  return typeof entry.scope === 'string'
    && Array.isArray(entry.numerals)
    && entry.numerals.every(isNumeralItem)
}

/** 作用域标号表存储实例。 */
export const figureNumeralStore = createIndexStore<FigureNumeralEntry>({
  version: FIGURE_NUMERAL_STORE_VERSION,
  validateEntry: isFigureNumeralEntry,
  entryKey: entry => entry.scope,
  compare: (left, right) => left.scope.localeCompare(right.scope),
  kindLabel: '附图标号表',
})

/** 同文件合并写的串行队列（与 `createIndexStore.upsert` 同构，按文件路径排队）。 */
const mergeQueues = new Map<string, Promise<unknown>>()

/**
 * 读一个作用域的标号表。
 * @param filePath - 标号表文件绝对路径。
 * @param scope - 作用域（`figure_family`）。
 * @returns 该作用域的标号项；文件缺失或作用域不存在时为空数组。
 */
export async function loadNumerals(filePath: string, scope: string): Promise<FigureNumeralItem[]> {
  const { entries } = await figureNumeralStore.load(filePath)
  const entry = entries.find(candidate => candidate.scope === scope)
  return entry === undefined ? [] : entry.numerals.map(item => ({ ...item }))
}

/**
 * 合并写入一个作用域的标号表。
 *
 * 同一 `componentId` 已有标号时保留表内旧号，本次传入的不同值列入 `conflicts`
 * 而不覆盖：改号是正常操作，调用方可用显式 `numerals` 参数表达意图，合并本身不
 * 替它作决定。
 * @param filePath - 标号表文件绝对路径。
 * @param scope - 作用域（`figure_family`）。
 * @param incoming - 本次要登记的标号项。
 * @returns 合并后的完整标号表与被丢弃的冲突值。
 */
export async function mergeNumerals(
  filePath: string,
  scope: string,
  incoming: readonly FigureNumeralItem[],
): Promise<NumeralMergeResult> {
  const previous = mergeQueues.get(filePath) ?? Promise.resolve()
  const run = previous.then(() => mergeOnce(filePath, scope, incoming))
  // 队列吞掉失败，避免一条失败阻塞后续写入；调用方 await run 感知自身失败。
  const tail = run.catch(() => {})
  mergeQueues.set(filePath, tail)
  try {
    return await run
  } finally {
    // 队尾仍指向本次链时清理该路径队列；失败路径同样清理。
    if (mergeQueues.get(filePath) === tail) mergeQueues.delete(filePath)
  }
}

/** 一次读-合并-写；由 {@link mergeNumerals} 串行调用。 */
async function mergeOnce(
  filePath: string,
  scope: string,
  incoming: readonly FigureNumeralItem[],
): Promise<NumeralMergeResult> {
  const { entries } = await figureNumeralStore.load(filePath)
  const current = entries.find(candidate => candidate.scope === scope)?.numerals ?? []
  const byId = new Map<string, FigureNumeralItem>()
  for (const item of current) byId.set(item.componentId, { ...item })

  const conflicts: NumeralMergeConflict[] = []
  for (const item of incoming) {
    if (item.componentId.trim() === '') continue
    // 生成侧以组件 id 登记，回填侧只有图面标签；两者键空间不同，按 id 找不到时
    // 用标签对齐到同一部件，避免同一部件在表里长出两条互不相认的条目。
    const existing = byId.get(item.componentId) ?? [...byId.values()].find(candidate =>
      item.label.trim() !== '' && candidate.label.trim() === item.label.trim(),
    )
    if (existing === undefined) {
      byId.set(item.componentId, { ...item })
      continue
    }
    if (existing.numeral !== item.numeral) {
      conflicts.push({ componentId: existing.componentId, kept: existing.numeral, dropped: item.numeral })
    }
  }

  const merged = [...byId.values()].sort((left, right) =>
    left.numeral.localeCompare(right.numeral, 'en', { numeric: true }),
  )
  const next = entries.filter(candidate => candidate.scope !== scope)
  next.push({ scope, numerals: merged })
  await figureNumeralStore.save(filePath, next)
  return { merged, conflicts }
}
