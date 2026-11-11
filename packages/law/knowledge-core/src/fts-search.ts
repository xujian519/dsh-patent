/**
 * FTS5 检索降级阶梯（各 SQLite 知识检索引擎共用）。
 *
 * 阶梯：整句 phrase FTS → 切词 OR FTS → LIKE 兜底；FTS 抛异常或短查询
 * /FTS 不可用时整体走 LIKE（粘性降级由调用方 degrade 回调完成）。
 * @module @deepseek-ai/dsh-knowledge-core/fts-search
 */

import { errorMessage } from '@deepseek-ai/dsh-value'
import { FTS_MIN_RUNES } from './fts.ts'
import { extractLawKeywords } from './keywords.ts'

/** 检索阶梯的输入（引擎注入各路径的查询函数）。 */
export type FtsSearchLadder<T> = {
  /** 已 trim 的非空检索词。 */
  keyword: string
  /** FTS 表是否存在且运行时可用。 */
  hasFts: boolean
  /** 是否已粘性降级（异常后置 true，后续直接 LIKE）。 */
  ftsDegraded: boolean
  /** 整句 FTS 查询。 */
  searchFts: (keyword: string) => T[]
  /** 切词 OR FTS 查询。 */
  searchFtsKeywords: (keywords: string[]) => T[]
  /** LIKE 兜底查询。 */
  searchLike: (keyword: string) => T[]
  /** 降级回调（入参为异常消息）。 */
  degrade: (reason: string) => void
}

/**
 * 执行一次 FTS 优先、LIKE 兜底的检索（含切词降级阶梯）。
 * @param ladder - 检索词、FTS 可用性、三条查询路径与降级回调。
 * @returns 检索结果列表（行或命中，由调用方映射）。
 */
export function runFtsSearch<T>(ladder: FtsSearchLadder<T>): T[] {
  const { keyword, hasFts, ftsDegraded, searchFts, searchFtsKeywords, searchLike, degrade } = ladder
  const runes = Array.from(keyword)
  if (!hasFts || ftsDegraded || runes.length < FTS_MIN_RUNES) {
    return searchLike(keyword)
  }
  let result: T[]
  try {
    // 1. 整句 phrase（短查询命中率高）
    result = searchFts(keyword)
    // 2. 整句无命中时切词 OR 查询（长句/自然语言查询）
    if (result.length === 0) {
      const keywords = extractLawKeywords(keyword)
      if (keywords.length > 0 && keywords[0] !== keyword) {
        result = searchFtsKeywords(keywords)
      }
    }
    // 3. FTS 仍无命中时降级 LIKE
    if (result.length === 0) {
      result = searchLike(keyword)
    }
  } catch (error) {
    degrade(errorMessage(error))
    result = searchLike(keyword)
  }
  return result
}

/** 检索阶梯的查询路径（已绑定选项与结果上限）。 */
export type FtsSearchOps<TOptions, THit> = {
  /** 整句 FTS 查询。 */
  searchFts: (keyword: string, options: TOptions, limit: number) => THit[]
  /** 切词 OR FTS 查询。 */
  searchFtsKeywords: (keywords: string[], options: TOptions, limit: number) => THit[]
  /** LIKE 兜底查询。 */
  searchLike: (keyword: string, options: TOptions, limit: number) => THit[]
  /** 降级回调（入参为异常消息）。 */
  degrade: (reason: string) => void
}

/**
 * 把一个检索引擎的当前状态与查询路径组装成检索阶梯。
 *
 * 各知识库引擎的查询方法签名一致（关键词、选项、上限），阶梯只负责把
 * 它们绑定到一次性检索上，避免每个引擎重复拼装同一个对象。
 * @param state - 检索词、FTS 可用性与粘性降级状态。
 * @param options - 引擎的检索选项。
 * @param limit - 结果上限。
 * @param ops - 三条查询路径与降级回调。
 * @returns 可直接交给 {@link runFtsSearch} 的阶梯。
 */
export function createFtsLadder<TOptions, THit>(
  state: { keyword: string; hasFts: boolean; ftsDegraded: boolean },
  options: TOptions,
  limit: number,
  ops: FtsSearchOps<TOptions, THit>,
): FtsSearchLadder<THit> {
  return {
    keyword: state.keyword,
    hasFts: state.hasFts,
    ftsDegraded: state.ftsDegraded,
    searchFts: keyword => ops.searchFts(keyword, options, limit),
    searchFtsKeywords: keywords => ops.searchFtsKeywords(keywords, options, limit),
    searchLike: keyword => ops.searchLike(keyword, options, limit),
    degrade: ops.degrade,
  }
}
