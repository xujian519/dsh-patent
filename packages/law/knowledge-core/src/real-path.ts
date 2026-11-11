/**
 * 路径真实形态归一化（供知识库安装与工作目录包含性校验共用）。
 *
 * 对不存在的输出文件无法直接 realpath，因此对第一个存在的祖先目录做
 * realpath，再拼回缺失的路径段；这样 `./`、`../` 与 symlink 别名会归一到
 * 同一个值，同文件守卫与包含性校验才能可靠比较。
 * @module @deepseek-ai/dsh-knowledge-core/real-path
 */

import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * 解析文件路径的真实形态，允许文件本身尚不存在。
 * @param path - 待归一化的路径。
 * @returns 归一化后的绝对路径。
 */
export function resolveRealPath(path: string): string {
  const abs = resolve(path)
  let dir = dirname(abs)
  let suffix = basename(abs)
  // 每轮上移一层，必然终止于存在的根目录。
  while (!existsSync(dir)) {
    suffix = join(basename(dir), suffix)
    dir = dirname(dir)
  }
  return join(realpathSync(dir), suffix)
}
