import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { KgNode } from '../patent/types.ts'
import { escapeFtsPhrase, FTS_MIN_RUNES, joinFtsOrTerms, sanitizeSearchText } from './fts.ts'
import { resolveResultLimit } from '@deepseek-ai/dsh-patent-core'
import { LruCache } from './lru-cache.ts'
import { openKnowledgeDb } from './db-version.ts'
import { KNOWLEDGE_DB } from './schema-versions.ts'
import { toNode, type FtsHit, type NodeRow } from './kg/row-mapper.ts'
import { introspectKgStore, type KgSchema } from './kg/schema-introspector.ts'
import { GraphTraversal, type KgNeighbor } from './kg/graph-traversal.ts'

/**
 * 知识图谱只读存储（双 schema 兼容）。
 *
 * 优先 knowledge.db 统一 schema（kg_nodes/kg_edges/kg_nodes_fts，trigram，
 * XiaoNuo 管道产物）；兼容旧 patent_kg.db（nodes/edges/nodes_fts*）。
 *
 * 设计：**按需 SQL 查询 + 有界 LRU 节点缓存**（上限见构造参数），避免将 217MB / 116K 节点
 * 全量加载进内存（Mady 的内存邻接表方案在 Node 侧过重），也避免长会话里缓冲过的节点 id 无界累积。edges 表
 * 已建 (source)/(target)/(relation) 索引，FTS5 表 nodes_fts 提供
 * 关键词检索，查询均在毫秒级。统一 schema 的 kg_nodes_fts（trigram，含 content）在
 * 行数与节点表一致时直接承担整句子串匹配，未命中不再触发全表 LIKE；legacy/短查询/陈旧索引保留回退。
 */

// 类型再导出（定义见 kg/ 子模块，保持 "./kg-store.ts" 导出面不变）
export type { KgSchema }
export type { KgNeighbor }

/** 分词模式的分隔符（空格 + 中文标点）。 */
const OR_SEPARATOR_RE = /[\s，。？！、；：,.;!?]+/
/** 候选词数上限（防超长 query 构造超大 FTS SQL / 多次 LIKE 扫描）。 */
const MAX_OR_TERMS = 8

/**
 * 节点缓存默认上限。图谱有 11 万级节点，而一个长会话查询过的不同 id 没有自然上界，
 * 因此缓存按 LRU 淘汰而不是只读不删；默认值按「一次图遍历可触达的节点量级」取。
 */
export const DEFAULT_NODE_CACHE_MAX_ENTRIES = 1024

/** 关键词搜索选项。 */
export type KgSearchOptions = {
  /** 匹配模式：phrase=整体短语（默认，保持既有行为）；or=分词 OR（多词召回）。 */
  mode?: 'phrase' | 'or'
}

/** 知识图谱只读存储（双 schema 兼容，按需 SQL + 轻量节点缓存）。 */
export class KgStore {
  private readonly db: DatabaseSync
  private readonly nodeCache: LruCache<string, KgNode | undefined>
  /** 生效的 schema：unified=knowledge.db（kg_nodes），legacy=patent_kg.db（nodes）。 */
  private readonly schema: KgSchema
  /** 表结构探测结果：trigram FTS 表优先（scripts/migrate-kg-fts-trigram.mjs 生成），否则 unicode61 旧表；无 FTS 时为 null。 */
  private readonly ftsTable: string | null
  private readonly graphTraversal: GraphTraversal

  // 热路径 prepared statements（prepare 一次反复复用，避免每次执行重新编译 SQL）
  private readonly stmtGetNode: StatementSync
  private readonly stmtLikeSearch: StatementSync
  private readonly stmtFtsSearch: StatementSync | null
  /**
   * OR 模式整句批次：按 rowid 排序保持与 LIKE 全表扫描相同的插入序。
   * trigram 索引覆盖正文时，整句 MATCH 与 LIKE 子串语义等价，可用它替代 66 ms 级全表扫描。
   */
  private readonly stmtFtsPhraseOrdered: StatementSync | null
  /**
   * 统一 schema 的 trigram 索引覆盖正文且行数与节点表一致。
   * 为 true 时，整句 FTS 未命中可直接返回，跳过全表 LIKE；行数一致只能排除部分陈旧，
   * 内容原地更新仍需数据管道重建索引。
   */
  private readonly contentIndexComplete: boolean

  /**
   * @param dbPath - 知识图谱数据库路径。
   * @param options - 节点缓存上限（条目数）；缺省用 {@link DEFAULT_NODE_CACHE_MAX_ENTRIES}。
   */
  constructor(dbPath: string, options: { nodeCacheMaxEntries?: number } = {}) {
    this.nodeCache = new LruCache<string, KgNode | undefined>(
      options.nodeCacheMaxEntries ?? DEFAULT_NODE_CACHE_MAX_ENTRIES,
    )
    const opened = openKnowledgeDb(dbPath, KNOWLEDGE_DB, { readOnly: true })
    this.db = opened.db
    // 构造期任一探测/组装失败都必须先关闭连接，避免失败对象泄漏文件句柄。
    try {
      // 探测 + prepared 组装（schema-introspector）：fail-closed（缺节点/边表抛错）
      // 与 FTS prepare 降级（旧 Node 无 FTS5/trigram）契约由 introspectKgStore 承担。
      const introspected = introspectKgStore(this.db, dbPath)
      this.schema = introspected.schema
      this.ftsTable = introspected.ftsTable
      this.stmtGetNode = introspected.statements.stmtGetNode
      this.stmtLikeSearch = introspected.statements.stmtLikeSearch
      this.stmtFtsSearch = introspected.statements.stmtFtsSearch
      this.stmtFtsPhraseOrdered = this.schema === 'unified' && this.stmtFtsSearch !== null
        ? this.db.prepare(
          'SELECT k.id, k.name, k.title FROM kg_nodes_fts f JOIN kg_nodes k ON k.rowid = f.rowid WHERE kg_nodes_fts MATCH ? ORDER BY k.rowid LIMIT ?',
        )
        : null
      this.contentIndexComplete = this.stmtFtsPhraseOrdered !== null && this.detectContentIndexComplete()
      this.graphTraversal = new GraphTraversal(
        {
          stmtNeighbors: introspected.statements.stmtNeighbors,
          stmtNeighborsByRelation: introspected.statements.stmtNeighborsByRelation,
          stmtListByType: introspected.statements.stmtListByType,
        },
        id => this.getNode(id),
      )
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  /**
   * 当前生效的 schema（诊断用）。
   * @returns 生效的 schema 标识。
   */
  schemaKind(): KgSchema {
    return this.schema
  }

  /**
   * 当前生效的 FTS 模式（诊断用）：trigram 表 / unicode61 旧表 / 无 FTS（LIKE 降级）。
   * @returns 生效的 FTS 模式。
   */
  ftsMode(): 'trigram' | 'unicode61' | 'none' {
    if (this.stmtFtsSearch === null) return 'none'
    // unified schema（kg_nodes_fts）恒为 trigram。
    if (this.schema === 'unified') return 'trigram'
    return this.ftsTable === 'nodes_fts_trigram' ? 'trigram' : 'unicode61'
  }

  /**
   * 探测统一 schema 的 trigram 索引是否覆盖正文并与节点表同步。
   * 行数一致只排除“缺少/多余索引行”；内容原地更新仍需数据管道重建索引。
   * 行数与 content 列都存在时，再取一个有正文的节点做列过滤 MATCH 抽查，
   * 排除“列已声明但正文未写入索引”的管道产物。
   * @returns 索引覆盖 name/title/content 且与 kg_nodes 对齐时 true。
   */
  private detectContentIndexComplete(): boolean {
    const columns = this.db.prepare("SELECT name FROM pragma_table_info('kg_nodes_fts')").all() as Array<{
      name: string
    }>
    if (!columns.some(column => column.name === 'content')) return false
    const fts = this.db.prepare('SELECT COUNT(*) AS c FROM kg_nodes_fts').get() as { c: number }
    const nodes = this.db.prepare('SELECT COUNT(*) AS c FROM kg_nodes').get() as { c: number }
    if (fts.c !== nodes.c) return false
    // 取一段不含空格的正文片段做列过滤抽查；没有可抽查的正文时以行数一致性为准。
    const probe = this.db
      .prepare("SELECT content FROM kg_nodes WHERE content IS NOT NULL AND length(content) >= 8 AND instr(content, ' ') = 0 LIMIT 1")
      .get() as { content: string } | undefined
    if (probe === undefined) return true
    const term = Array.from(probe.content).slice(2, 6).join('')
    const hit = this.db
      .prepare('SELECT 1 AS present FROM kg_nodes_fts WHERE kg_nodes_fts MATCH ? LIMIT 1')
      .get(`content : ${escapeFtsPhrase(term)}`)
    return hit !== undefined
  }

  /**
   * 按 id 查询节点（带缓存）。
   * @param id 节点 id。
   * @returns 匹配节点，不存在时 undefined。
   */
  getNode(id: string): KgNode | undefined {
    if (this.nodeCache.has(id)) return this.nodeCache.get(id)
    const row = this.stmtGetNode.get(id) as NodeRow | undefined
    const node = row ? toNode(row) : undefined
    this.nodeCache.set(id, node)
    return node
  }

  /**
   * 按关键词搜索节点（FTS5 MATCH；短查询或缺失 FTS 时降级 LIKE）。
   * @param keyword 搜索关键词。
   * @param limit 返回数量上限（默认 10；小数截断、非有限值回退默认、下限 1）。
   * @param options 关键词搜索选项（phrase/or 模式）。
   * @returns 匹配的节点列表。
   */
  searchByKeyword(keyword: string, limit = 10, options: KgSearchOptions = {}): KgNode[] {
    // NUL 在 SQLite 文本边界截断查询：FTS5 报 "unterminated string"，LIKE 匹配
    // 不可预期；先去 NUL 再限定条数，避免原始 SQLite 错误与无界扫描。
    const trimmed = sanitizeSearchText(keyword).trim()
    if (!trimmed) return []
    const capped = resolveResultLimit(limit, 10, Number.MAX_SAFE_INTEGER)
    if (options.mode === 'or') return this.searchByKeywordOr(trimmed, capped)

    const runes = Array.from(trimmed)

    let ids: string[]
    const ftsSearch = this.stmtFtsSearch
    if (ftsSearch !== null && runes.length >= FTS_MIN_RUNES) {
      const rows = ftsSearch.all(escapeFtsPhrase(trimmed), capped) as FtsHit[]
      ids = rows.map(r => r.id)
      // FTS 词级匹配未命中且无分隔符时降级 LIKE 子串：unicode61 下长句/短语常无完整 token，
      // 子串匹配比 token 完全匹配宽松（如 "以说明书为依据" 作为 token 不存在时仍可命中正文）。
      // 带分隔符短语的 LIKE（%创造性 三步法%）召回率趋近于零，跳过以避免无谓全表扫描。
      // trigram 索引覆盖正文时整句 MATCH 已具备子串语义，未命中直接返回，跳过 66 ms 级全表扫描。
      if (ids.length === 0 && !this.contentIndexComplete && !OR_SEPARATOR_RE.test(trimmed)) {
        ids = this.likeSearch(trimmed, capped).map(row => row.id)
      }
    } else {
      ids = this.likeSearch(trimmed, capped).map(row => row.id)
    }

    return ids.map(id => this.getNode(id)).filter((n): n is KgNode => n !== undefined)
  }

  /** LIKE 子串检索（name/title/content 任一包含即命中）。 */
  private likeSearch(keyword: string, limit: number): Array<{ id: string }> {
    const pattern = this.likePattern(keyword)
    return this.stmtLikeSearch.all(pattern, pattern, pattern, limit) as Array<{ id: string }>
  }

  /**
   * 多词 LIKE：把多个词条合并为**单次**全表扫描（每词三列 OR），
   * 替代原先每个词条一次全表扫描（最多 8 词 → 最多 8 次 116K 行扫描）。
   * 语义说明：合并查询总 LIMIT 与原实现（每词 LIMIT 后 Set 并集再 slice(0, limit)）
   * 的**最终召回上限一致**（均 ≤ limit），仅候选行序不同（表行序 vs 词序插入序）；
   * 多词场景的主要召回由 FTS 路径承担，LIKE 仅兜底子串命中。
   */
  private likeSearchTerms(terms: string[], limit: number): Array<{ id: string }> {
    const deduped = Array.from(new Set(terms.map(t => t.trim()).filter(Boolean)))
    /* v8 ignore next -- callers only pass non-empty trimmed terms (likeSearchTerms is guarded by mergedTerms.length > 0) */
    if (deduped.length === 0) return []
    if (deduped.length === 1) {
      const single = deduped[0]
      /* v8 ignore start -- the empty-string filter above can never yield an undefined element */
      if (single !== undefined) return this.likeSearch(single, limit)
      return []
      /* v8 ignore stop */
    }
    const clause = deduped
      .map(() => "(name LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\')")
      .join(' OR ')
    const params: Array<string | number> = deduped.flatMap((term) => {
      const pattern = this.likePattern(term)
      return [pattern, pattern, pattern]
    })
    params.push(limit)
    const nodeTable = this.schema === 'unified' ? 'kg_nodes' : 'nodes'
    return this.db.prepare(`SELECT id FROM ${nodeTable} WHERE ${clause} LIMIT ?`).all(...params) as Array<{
      id: string
    }>
  }

  private likePattern(keyword: string): string {
    return `%${keyword.replace(/[%_\\]/g, m => `\\${m}`)}%`
  }

  /**
   * OR 分词检索（多词召回）。
   *
   * 统一 schema 的 kg_nodes_fts 为 trigram，legacy nodes_fts 可能为 unicode61。
   * 本模式在单一入口内完成拆词与召回（调用方无需再分词）：
   *   - trigram 覆盖正文时：无分隔长词先用整句 MATCH（按 rowid 排序）填第一批，
   *     不足 limit 再用窗口子词补充；整句 MATCH 与 LIKE 子串语义等价，末尾的整句 LIKE 兜底可跳过
   *   - unicode61：连续汉字构成单个 token，整句 phrase 基本不命中，先用整体 LIKE 精确子串
   *   - 短词（≤3 字）直接整体：3 字走 FTS，2 字降级 LIKE
   *   - 分隔符拆词：≥3 字词 FTS `"词1" OR "词2"`，2 字词 LIKE；1 字词丢弃
   *     （LIKE %单字% 命中数万节点，纯噪音）
   *   - 无分隔 4+ 字长词：窗口子词补充召回（4-5 字 2 字窗 LIKE / ≥6 字 3 字窗 FTS）
   */
  private searchByKeywordOr(keyword: string, limit: number): KgNode[] {
    const trimmed = keyword.trim()
    /* v8 ignore next -- searchByKeyword already short-circuits on a blank query */
    if (!trimmed) return []
    const chars = Array.from(trimmed)
    const hasSeparators = OR_SEPARATOR_RE.test(trimmed)
    /** trigram 整句语句；非 null 表示整句 MATCH 可替代整句 LIKE。 */
    const trigramPhrase = this.contentIndexComplete ? this.stmtFtsPhraseOrdered : null

    const ids = new Set<string>()
    const ftsTerms: string[] = []
    const likeTerms: string[] = []

    /** 词归入 FTS（≥3 字）或 LIKE（2 字）候选；1 字词丢弃。 */
    const collect = (term: string): void => {
      const runes = Array.from(term.trim())
      if (this.stmtFtsSearch !== null && runes.length >= FTS_MIN_RUNES) ftsTerms.push(term.trim())
      else if (runes.length >= 2) likeTerms.push(term.trim())
    }

    if (!hasSeparators && chars.length <= 3) {
      collect(trimmed)
    } else if (hasSeparators) {
      for (const part of trimmed.split(OR_SEPARATOR_RE)) collect(part)
    } else {
      // 无分隔长词：trigram 用整句 MATCH（子串语义与 LIKE 一致），unicode61 用整体 LIKE。
      if (trigramPhrase !== null) {
        for (const row of trigramPhrase.all(escapeFtsPhrase(trimmed), limit) as FtsHit[]) ids.add(row.id)
      } else {
        for (const row of this.likeSearch(trimmed, limit)) ids.add(row.id)
      }
      // 第一批未填满才用窗口子词补充；已满时窗口结果会被末尾 slice 丢弃。
      if (ids.size < limit) {
        const step = chars.length <= 5 ? 2 : 3
        for (let i = 0; i + step <= chars.length; i += step) {
          collect(chars.slice(i, i + step).join(''))
        }
      }
    }

    if (ftsTerms.length > 0) {
      const match = joinFtsOrTerms(ftsTerms.slice(0, MAX_OR_TERMS))
      const ftsSearch = this.stmtFtsSearch
      /* v8 ignore next 2 -- collect() only fills ftsTerms when stmtFtsSearch is non-null */
      if (ftsSearch !== null) {
        const rows = ftsSearch.all(match, limit) as FtsHit[]
        for (const row of rows) ids.add(row.id)
      }
    }

    const mergedTerms = likeTerms.slice(0, MAX_OR_TERMS)
    if (mergedTerms.length > 0) {
      for (const row of this.likeSearchTerms(mergedTerms, limit)) ids.add(row.id)
    }

    // 兜底：候选词均未命中时整体 LIKE 一次（带分隔符或 trigram 整句已覆盖时跳过）
    if (ids.size === 0 && !hasSeparators && chars.length >= 2 && trigramPhrase === null) {
      for (const row of this.likeSearch(trimmed, limit)) ids.add(row.id)
    }

    const ordered = [...ids].slice(0, limit)
    return ordered.map(id => this.getNode(id)).filter((n): n is KgNode => n !== undefined)
  }

  /**
   * 查询节点的出向邻居（按 relation 过滤可选）。
   * @param nodeId 节点 id。
   * @param relation 关系类型过滤，省略时不限关系。
   * @param limit 返回邻居数量上限。
   * @returns 邻居节点列表。
   */
  getNeighbors(nodeId: string, relation?: string, limit = 20): KgNeighbor[] {
    return this.graphTraversal.getNeighbors(nodeId, relation, limit)
  }

  /**
   * 按类型列出节点（用于图谱浏览/过滤）。
   * @param nodeType 节点类型。
   * @param limit 返回数量上限。
   * @returns 该类型的节点列表。
   */
  listByType(nodeType: string, limit = 50): KgNode[] {
    return this.graphTraversal.listByType(nodeType, limit)
  }

  /**
   * 展开某个节点的邻居（去重后），附带节点详情。
   * @param nodeId 节点 id。
   * @param relation 关系类型过滤，省略时不限关系。
   * @param depth 展开深度。
   * @param limit 每层返回数量上限。
   * @returns 展开得到的邻居节点及其关系列表。
   */
  expandNeighbors(nodeId: string, relation?: string, depth = 2, limit = 20): Array<{ node: KgNode; relation: string }> {
    return this.graphTraversal.expandNeighbors(nodeId, relation, depth, limit)
  }

  /** 关闭数据库连接并清空节点缓存。 */
  close(): void {
    this.nodeCache.clear()
    this.db.close()
  }
}
