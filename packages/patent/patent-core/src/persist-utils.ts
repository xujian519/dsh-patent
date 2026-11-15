/**
 * 持久化共享工具（workflow-store / flexible-plan-store 共用）。
 *
 * - assertSafeId：文件路径安全字符校验（防 `..` / 路径分隔符 / 隐藏文件写入）
 * - assertSafePathSegment：单个路径段的校验（允许中文案卷名，仍拒绝分隔符与 `..`）
 * - atomicWriteJson：原子写（先写同目录临时文件再 rename，避免中断/并发产生半写 JSON）
 * - StoredRecordError / parseStoredJsonRecord：磁盘记录的结构错误与顶层对象解析
 * - JsonFileStore：每 id 一个 JSON 文件（`<dir>/<id>.json`）的通用单文件存储——
 *   save/load/list 三接口 + ENOENT 映射，parse 回调注入反序列化/校验
 */

import { mkdir, readFile, readdir } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isJsonRecord } from './llm-json.ts'

/**
 * 持久化记录的结构错误：磁盘内容不满足当前格式时抛出。
 *
 * durable/file 边界必须逐字段校验；错误携带来源文件与记录类型，让调用方能直接
 * 定位损坏的那份记录，而不是把解析失败混同成「记录不存在」或静默回落到默认值。
 */
export class StoredRecordError extends Error {
  /**
   * @param file - 记录所在文件路径。
   * @param recordKind - 记录类型名（如 "checkpoint" / "run"）。
   * @param detail - 具体字段或解析失败原因。
   */
  constructor(
    readonly file: string,
    readonly recordKind: string,
    readonly detail: string,
  ) {
    super(`Invalid ${recordKind} record at ${file}: ${detail}`)
    this.name = 'StoredRecordError'
  }
}

/**
 * 解析一份持久化 JSON 记录，并要求顶层是 JSON 对象。
 * @param raw - 文件原文。
 * @param file - 记录文件路径（进入错误消息）。
 * @param recordKind - 记录类型名（进入错误消息）。
 * @returns 顶层 JSON 对象。
 */
export function parseStoredJsonRecord(raw: string, file: string, recordKind: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new StoredRecordError(file, recordKind, `not valid JSON (${String(error)})`)
  }
  if (!isJsonRecord(value)) {
    throw new StoredRecordError(file, recordKind, 'top-level value must be a JSON object')
  }
  return value
}

/** 安全 id 字符集：字母/数字/点/下划线/连字符，且不允许以点开头。 */
export const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * 校验 id 可直接拼入文件路径；非法抛 RangeError（fail-closed）。
 * @param id - 待校验的标识。
 * @param what - 错误消息中的对象名（如 "caseId" / "runId"）。
 */
export function assertSafeId(id: string, what: string): void {
  if (!SAFE_ID_PATTERN.test(id)) {
    throw new RangeError(
      `Invalid ${what} ${JSON.stringify(id)}: only [A-Za-z0-9._-] allowed and must not start with "."`,
    )
  }
}

/**
 * 校验一个值可直接作为单段路径名：非空、不是 `.`/`..`、不以空格或点结尾、
 * 不含路径分隔符或 NUL。
 *
 * 与 {@link assertSafeId} 的差别是允许中文等非 ASCII 字符：案卷号常写作
 * `CN2024-0001` 或中文案卷名，但仍不得越出 `data/cases/<caseId>/`。
 * 尾部空格和点在 Windows 上会被文件系统忽略，`".. "` 因而可能解析为父目录。
 * @param value - 待校验的路径段。
 * @param what - 错误消息中的对象名（如 "caseId"）。
 */
export function assertSafePathSegment(value: string, what: string): void {
  if (
    value.trim() === '' ||
    value !== value.trim() ||
    value.endsWith('.') ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0')
  ) {
    throw new RangeError(
      `Invalid ${what} ${JSON.stringify(value)}: must be a single path segment without ".." or trailing dots/spaces`,
    )
  }
}

/**
 * 原子写 JSON：委托 `@deepseek-ai/dsh-atomic-write` 的 `writeFileAtomic`，
 * 由该包统一提供 `wx` 独占创建、文件与父目录 fsync、Windows 瞬态重试。
 * @param file - 目标文件路径。
 * @param content - 待写入的文本内容。
 */
export async function atomicWriteJson(file: string, content: string): Promise<void> {
  await writeFileAtomic(file, content, { mode: 0o644 })
}

/**
 * 通用单文件 JSON 存储：每 id 一个 `<dir>/<id>.json` 文件。
 * save 先建目录再原子写；load 缺失（ENOENT）返回 undefined；listIds 只返回
 * 安全字符集的 id（过滤目录里的外来文件，避免 list→load 往返 RangeError）。
 *
 * parse 回调收到文件路径，负责把磁盘内容校验成 `T`；它的错误一律向上传播，
 * 不会被当成「记录不存在」。
 */
export class JsonFileStore<T> {
  constructor(
    private readonly dir: string,
    /**
     * 反序列化回调；`file` 是记录文件路径，供校验器构造带来源的错误。
     * 单参回调（只读 `raw`）仍然兼容。
     */
    private readonly parse: (raw: string, file: string) => T,
    /** assertSafeId 错误消息中的对象名（如 "caseId" / "runId"）。 */
    private readonly what = 'id',
  ) {}

  private fileFor(id: string): string {
    // 防御路径注入：id 直接拼入文件路径，只允许安全字符集，
    // 禁止路径分隔符与 `..`（否则可写出 dir 目录，或写入隐藏文件）。
    assertSafeId(id, this.what)
    return `${this.dir}/${id}.json`
  }

  /**
   * 保存单条记录：先建目录再原子写 `<dir>/<id>.json`。
   * @param id - 记录标识（须通过 assertSafeId 校验）。
   * @param value - 待序列化的记录内容。
   */
  async save(id: string, value: T): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const file = this.fileFor(id)
    await atomicWriteJson(file, JSON.stringify(value, null, 2))
  }

  /**
   * 读取单条记录；文件缺失（ENOENT）时返回 undefined，其余错误照常抛出。
   *
   * ENOENT 映射只覆盖读取本身：parse 在 try 之外调用，校验器抛出的任何错误
   * （即使自带 `code: 'ENOENT'`）都不会被误判成「记录不存在」。
   * @param id - 记录标识。
   * @returns 解析后的记录；文件不存在时为 undefined。
   */
  async load(id: string): Promise<T | undefined> {
    const file = this.fileFor(id)
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    return this.parse(raw, file)
  }

  /**
   * 列出目录中安全字符集的记录 id（过滤外来文件，避免 list→load 往返 RangeError）。
   * @returns 目录中 `.json` 文件名去掉后缀、且命中 SAFE_ID_PATTERN 的 id 列表。
   */
  async listIds(): Promise<string[]> {
    try {
      const files = await readdir(this.dir)
      return files
        .filter(file => file.endsWith('.json'))
        .map(file => file.slice(0, -'.json'.length))
        .filter(id => SAFE_ID_PATTERN.test(id))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
}
