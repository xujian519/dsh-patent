/**
 * knowledge.db 全文检索引擎基类（case-law-search / knowledge-law-search 共用）。
 *
 * 托管两端共用的骨架：只读打开 + chunk 解压注册 + FTS5 双条件探测、
 * FTS 优先/LIKE 兜底的检索阶梯（runSearch）、粘性降级打点与连接关闭。
 * 检索实现（searchFts/searchFtsKeywords/searchLike）与过滤/回源由子类提供。
 */

import type { DatabaseSync } from 'node:sqlite'
import { openKnowledgeDb } from './db-version.ts'
import { KNOWLEDGE_DB } from './schema-versions.ts'
import { sanitizeSearchText, sqliteHasFts5 } from './fts.ts'
import { registerChunkUncompress } from './chunk-compression.ts'
import { runFtsSearch } from './fts-search.ts'
import { createFtsLadder } from '@deepseek-ai/dsh-knowledge-core'
import type { KnowledgeRuntimeStats } from './knowledge-stats.ts'

/** 引擎构造选项（全部可选；不传时行为与旧签名完全一致）。 */
export type KnowledgeSearchEngineOptions = {
  /** 降级/异常日志出口（不传时静默，与旧行为一致）。 */
  logger?: { warn: (message: string) => void }
  /** 运行时状态聚合（可观测性出口；降级时打点）。 */
  stats?: KnowledgeRuntimeStats
}

/** knowledge.db 全文检索引擎骨架（构造/检索阶梯/降级/关闭共用）。 */
export abstract class KnowledgeFtsSearchBase<TOptions, THit> {
  protected readonly db: DatabaseSync
  protected readonly hasFts: boolean
  /** FTS5 查询曾抛异常（模块缺失等）后置 true，后续查询直接走 LIKE。 */
  protected ftsDegraded = false
  protected readonly logger?: { warn: (message: string) => void } | undefined
  protected readonly stats?: KnowledgeRuntimeStats | undefined

  constructor(dbPath: string, options: KnowledgeSearchEngineOptions = {}) {
    this.logger = options.logger
    this.stats = options.stats
    const opened = openKnowledgeDb(dbPath, KNOWLEDGE_DB, { readOnly: true })
    this.db = opened.db
    // chunk 压缩解压函数（--compress-chunks 产物 BLOB；明文原样返回）。
    registerChunkUncompress(this.db)
    const row = this.db
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='docs_fts' LIMIT 1")
      .get() as { present: number } | undefined
    // 双重条件才启用 FTS：docs_fts 表存在 + 运行时 SQLite 编译了 FTS5。
    this.hasFts = row !== undefined && sqliteHasFts5(this.db)
  }

  protected abstract searchFts(keyword: string, options: TOptions, limit: number): THit[]
  protected abstract searchFtsKeywords(keywords: string[], options: TOptions, limit: number): THit[]
  protected abstract searchLike(keyword: string, options: TOptions, limit: number): THit[]
  /** 降级提示中的引擎标签（如 "case-law" / "法规"）。 */
  protected abstract readonly degradeLabel: string
  /** 降级状态的引擎打点（case-law / 法规 各自的 stats 方法）。 */
  protected abstract markFtsDegraded(): void

  /** FTS5 粘性降级打点（构造期 prepare 捕获与查询期异常共用）。 */
  protected degradeFts(reason: string): void {
    this.ftsDegraded = true
    this.logger?.warn(`[sati] ${this.degradeLabel} FTS5 不可用，已降级 LIKE: ${reason}`)
    this.markFtsDegraded()
  }

  /** FTS5 是否实际可用（表存在 + 运行时支持 + 未被降级）。 */
  get ftsAvailable(): boolean {
    return this.hasFts && !this.ftsDegraded
  }

  /** 执行一次 FTS 优先、LIKE 兜底的检索（trim + 空词短路 + runFtsSearch 阶梯）。 */
  protected runSearch(keyword: string, options: TOptions, limit: number): THit[] {
    // 检索词先去掉 SQLite 文本无法承载的 NUL：FTS5 会报 "unterminated string"，
    // 再被阶梯当作 FTS 故障粘性降级；LIKE 对含 NUL 的模式匹配也不可预期。
    const trimmed = sanitizeSearchText(keyword).trim()
    if (!trimmed) return []
    return runFtsSearch(createFtsLadder(
      { keyword: trimmed, hasFts: this.hasFts, ftsDegraded: this.ftsDegraded },
      options,
      limit,
      {
        searchFts: (kw, opts, cap) => this.searchFts(kw, opts, cap),
        searchFtsKeywords: (kws, opts, cap) => this.searchFtsKeywords(kws, opts, cap),
        searchLike: (kw, opts, cap) => this.searchLike(kw, opts, cap),
        degrade: (reason) => {
          this.degradeFts(reason)
        },
      },
    ))
  }

  /** 关闭底层数据库连接。 */
  close(): void {
    this.db.close()
  }
}
