/**
 * 知识库安装的共用文件操作。
 *
 * 两个知识库安装命令（patent-knowledge:install / legal-knowledge:install）都把
 * 源库裁剪进运行时目录：先写同目录临时文件，成功后原子替换输出。这里收拢
 * 临时文件准备、提交与结果统计。
 * @module @deepseek-ai/dsh-patent-core/knowledge/install-fs
 */

import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

/**
 * 读取表的行数。
 * @param db - 已打开的数据库连接。
 * @param table - 表名。
 * @returns 行数；表缺失或查询失败时为 -1。
 */
export function countTableRows(db: DatabaseSync, table: string): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number }
    return row.c
  } catch {
    return -1
  }
}

/**
 * 把字节数渲染为 GB 文本。
 * @param bytes - 字节数。
 * @returns 两位小数的 GB 文本。
 */
export function formatGigabytes(bytes: number): string {
  return `${(bytes / 1073741824).toFixed(2)} GB`
}

/**
 * 准备输出路径与同目录临时文件。
 *
 * 临时文件放在输出目录内，保证随后的 rename 不跨文件系统；上一次中断留下的
 * 同名临时文件会先被清除。
 * @param output - 输出文件路径。
 * @returns 临时文件路径。
 */
export function prepareTempSibling(output: string): string {
  mkdirSync(dirname(resolve(output)), { recursive: true })
  const temp = `${resolve(output)}.tmp-${process.pid}`
  if (existsSync(temp)) rmSync(temp)
  return temp
}

/**
 * 用临时文件原子替换输出。
 * @param temp - 已写好的临时文件。
 * @param output - 输出文件路径。
 * @param log - 日志出口；覆盖已有输出时记录一行。
 */
export function commitTempSibling(temp: string, output: string, log: (line: string) => void): void {
  if (existsSync(output)) {
    log(`输出已存在，覆盖: ${output}`)
    rmSync(output)
  }
  renameSync(temp, output)
}
