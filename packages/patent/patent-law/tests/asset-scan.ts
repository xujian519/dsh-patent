/**
 * 随包资产与源码的扫描范围。
 *
 * 「仓库自己引用了哪些法条、哪些指南节」这类覆盖面断言都要遍历同一批文件，而扫描范围
 * 写错的后果是断言空过，所以范围只在这里定义一次、由各组断言共用。
 * @module dsh-patent-law/tests/asset-scan
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 仓库根目录。 */
const REPO_ROOT = join(import.meta.dirname, '../../../..')

/** 被扫描的目录：随包资产与源码所在处，不含测试、构建产物与依赖目录。 */
const SCAN_ROOTS: readonly string[] = ['packages/patent', 'packages/bundle/web-app']

/** 只扫描这些路径片段下的文件：随包资产、被装载的源码，以及随包技能与预设。 */
const INCLUDED_SEGMENTS: readonly string[] = ['/assets/', '/src/', '/skills/', '/presets/']

/** 扫描时跳过的路径片段。 */
const EXCLUDED_SEGMENTS: readonly string[] = ['/lib/', '/node_modules/', '/tests/']

/** 可扫描的文本扩展名。 */
const SCANNED_EXTENSIONS = new Set(['.ts', '.md', '.yaml', '.yml', '.json', '.html'])

/** 一个被扫描的文件：仓库相对路径与正文。 */
export type ScannedFile = {
  /** 相对仓库根的路径，用于报告。 */
  file: string
  /** 文件正文。 */
  text: string
}

/**
 * 读取扫描范围内的每个文件。
 * @returns 按仓库相对路径排序的文件列表。
 */
export function scannedFiles(): ScannedFile[] {
  const files: ScannedFile[] = []
  for (const root of SCAN_ROOTS) {
    for (const path of collect(join(REPO_ROOT, root), [])) {
      files.push({ file: path.slice(REPO_ROOT.length + 1), text: readFileSync(path, 'utf8') })
    }
  }
  return files.sort((a, b) => a.file.localeCompare(b.file))
}

/**
 * 递归列出待扫描文件。
 * @param dir - 起始目录。
 * @param out - 累积结果。
 * @returns 绝对路径列表。
 */
function collect(dir: string, out: string[]): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(dir, entry)
    if (EXCLUDED_SEGMENTS.some(segment => path.includes(segment))) continue
    if (statSync(path).isDirectory()) {
      collect(path, out)
      continue
    }
    const dot = entry.lastIndexOf('.')
    if (dot < 0) continue
    if (!SCANNED_EXTENSIONS.has(entry.slice(dot))) continue
    // The scope predicates read repository-relative paths: an absolute path whose
    // checkout directory happens to be named `src` would match `/src/` everywhere
    // and scan the whole tree.
    const file = path.slice(REPO_ROOT.length + 1)
    if (!INCLUDED_SEGMENTS.some(segment => file.includes(segment))) continue
    out.push(path)
  }
  return out
}
