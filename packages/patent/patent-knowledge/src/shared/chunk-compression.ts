/**
 * chunks.content 应用级压缩（--compress-chunks 迁移产物）。
 *
 * 背景：chunks 表 144K 行正文 ~510MB（平均 3.7K 字符中文），是 knowledge.db
 * 第二大文本载体。docs_fts 是 contentless 表（索引独立于 chunks.content），
 * 压缩正文不影响 FTS 检索；读取端（判例/法规回源、embedding 锚点）经
 * sati_uncompress() 解压，透明无感知。
 *
 * 存储格式（双态，SQLite 存储类天然区分）：
 *   - 明文：TEXT 存储类，原样返回（knowledgeNoteSave 等写入者兼容）；
 *   - 压缩：BLOB 存储类，前 2 字节魔数 0x53 0x43（"SC"）+ gzip 数据。
 *
 * 检索场景只解压 top-k 命中（10-50 行），gunzip 开销可忽略。
 */

import { DatabaseSync } from 'node:sqlite'
import { gzipSync, gunzipSync } from 'node:zlib'

/** 魔数 "SC"（Sati Compressed）。 */
const MAGIC = [0x53, 0x43] as const

/** 压缩阈值：低于该字符数的小 chunk 压缩收益低（gzip 头开销占比高），保持明文。 */
export const MIN_COMPRESS_CHARS = 800

/**
 * 文本 → 压缩 BLOB（魔数 + gzip）。
 * @param text 待压缩文本。
 * @returns 压缩后的 BLOB（魔数前缀 + gzip）。
 */
export function compressChunk(text: string): Buffer {
  const gz = gzipSync(Buffer.from(text, 'utf8'), { level: 6 })
  const out = Buffer.alloc(gz.length + MAGIC.length)
  out[0] = MAGIC[0]
  out[1] = MAGIC[1]
  gz.copy(out, MAGIC.length)
  return out
}

/**
 * 解压：明文 TEXT 原样返回；压缩 BLOB（魔数）gunzip；异常 BLOB 按 utf8 兜底。
 * 幂等（对明文/压缩结果均可再调用）。
 *
 * 注意：SC 魔数前缀是强约定，但内容可能并非有效 gzip（截断的迁移写入、
 * 巧合以 'SC' 开头的二进制内容）——gunzip 失败时降级 utf8 兜底，保证
 * sati_uncompress() 永不抛错（一行坏数据只影响自身，不拖垮整条检索）。
 * @param data 存储原始值（明文 TEXT 或压缩 BLOB，可为 null）。
 * @returns 解压后的文本。
 */
export function decompressChunk(data: string | Uint8Array | null): string {
  if (data === null) return ''
  if (typeof data === 'string') return data
  if (data.length >= MAGIC.length && data[0] === MAGIC[0] && data[1] === MAGIC[1]) {
    try {
      return gunzipSync(Buffer.from(data.subarray(MAGIC.length))).toString('utf8')
    } catch (error) {
      // 魔数匹配但非有效 gzip（截断写入 / 巧合 'SC' 开头）：吞掉 gunzip 异常，
      // 落到下方统一的 utf8 兜底（避免整条 SQL 查询抛错）。
      void error
    }
  }
  return Buffer.from(data).toString('utf8')
}

/** 命中 chunk 的定位键。 */
export interface ChunkLocation {
  readonly documentId: string
  readonly chunkIndex: number
}

/** 回源调用方需要提供的字段访问方式。 */
export interface ChunkBackfill<Row> {
  /** 预编译的回源语句，参数依次为 chunk_index、document_id。 */
  readonly chunkAt: { get(...params: Array<string | number>): unknown }
  /** 从命中行取定位键（判例命中用驼峰，法规行用下划线列名）。 */
  readonly locate: (row: Row) => ChunkLocation
  /** 该行是否已带正文；为 true 时原样返回。 */
  readonly hasContent: (row: Row) => boolean
  /** 把解压后的正文写入该行的副本。 */
  readonly attach: (row: Row, content: string) => Row
}

/**
 * 延迟解压回源：FTS 主查询不取正文，去重后只对最终返回的行按
 * (document_id, chunk_index) 取回命中 chunk 并解压。
 *
 * 判例与法规两个引擎的命中行字段名不同（`snippet` 与 `content`），但回源
 * 键、缺失行处理与解压方式相同；调用方只描述「怎么定位」与「正文写到哪」。
 * @param rows 已去重的命中行。
 * @param options 回源语句、定位键、已有正文判定与写回方式。
 * @returns 补齐正文的行；回源查不到 chunk 时保留原行。
 */
export function backfillChunkContent<Row>(rows: readonly Row[], options: ChunkBackfill<Row>): Row[] {
  return rows.map((row) => {
    if (options.hasContent(row)) return row
    const { documentId, chunkIndex } = options.locate(row)
    const chunk = options.chunkAt.get(chunkIndex, documentId) as
      | { content: string | Uint8Array | null }
      | undefined
    return chunk === undefined ? row : options.attach(row, decompressChunk(chunk.content))
  })
}

/**
 * 文本 → 压缩 BLOB；长度未达标或压缩后不更小时返回 null。
 * 只压缩一次，写入路径应优先使用本函数（{@link shouldCompress} 只判定、会丢弃结果）。
 * @param text 待压缩文本。
 * @param minChars 压缩阈值（默认 {@link MIN_COMPRESS_CHARS}）。
 * @returns 值得替换时返回压缩 BLOB，否则 null。
 */
export function compressIfSmaller(text: string, minChars = MIN_COMPRESS_CHARS): Buffer | null {
  if (text.length < minChars) return null
  const compressed = compressChunk(text)
  // 压缩后（含魔数）必须更小，否则保留明文。
  return compressed.length < Buffer.byteLength(text, 'utf8') ? compressed : null
}

/**
 * 该文本是否值得压缩（长度达标；压缩后应更小才替换）。
 * 只做判定、不保留结果时使用；需要写入压缩值时用 {@link compressIfSmaller} 避免二次压缩。
 * @param text 待判定文本。
 * @returns 长度达标且压缩后更小时 true。
 */
export function shouldCompress(text: string): boolean {
  return compressIfSmaller(text) !== null
}

/**
 * 注册 sati_uncompress() SQL 函数（deterministic：同一输入恒同输出，SQLite
 * 可缓存）。使用方：case-law-search / knowledge-law-search / embedding-consistency。
 * @param db 目标数据库连接。
 */
export function registerChunkUncompress(db: DatabaseSync): void {
  db.function('sati_uncompress', { deterministic: true }, (value: string | Uint8Array | number | bigint | null | undefined) => {
    if (value === undefined) return ''
    if (value === null || typeof value === 'string' || value instanceof Uint8Array) {
      return decompressChunk(value)
    }
    return String(value)
  })
}
