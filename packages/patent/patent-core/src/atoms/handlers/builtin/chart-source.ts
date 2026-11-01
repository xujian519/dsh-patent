/**
 * claim-chart 源文件读取：允许根、真实路径、文本扩展名与大小上限。
 *
 * 模型可控的 `sourcePath` 不直接交给文件系统：先按 cwd 解析并 realpath，再要求
 * 真实路径落在允许根内。符号链接因此按目标路径判定——指向根外即拒绝，指向根内
 * 仍可读取。读取失败返回原因，由调用方归因到引用该源的行，内容不进入提示词。
 *
 * @module @deepseek-ai/dsh-patent-core/atoms/handlers/builtin/chart-source
 */

import { realpath, readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * 允许读取的源文件扩展名（小写）。证据源文通常是抽取后的纯文本；PDF、DOCX 等
 * 二进制格式需先转换，避免把不可解析字节当作原文做 pin-cite/quote 校验。
 */
const TEXT_SOURCE_EXTENSIONS = new Set([
  '.txt',
  '.text',
  '.md',
  '.markdown',
  '.json',
  '.jsonl',
  '.csv',
  '.tsv',
  '.xml',
  '.html',
  '.htm',
  '.yaml',
  '.yml',
  '.log',
  '.rst',
  '.tex',
])

/** claim-chart 源文件读取策略；根与路径均已按真实路径比较。 */
export type ChartSourcePolicy = {
  /** 允许读取的真实根目录；空数组拒绝所有源文件。 */
  roots: readonly string[]
  /** 单个文件的 UTF-8 字节上限。 */
  maxBytes: number
  /** 相对 `sourcePath` 的解析基准。 */
  cwd: string
}

/** 解析允许根的结果。 */
type ChartSourcePolicyResult =
  | { ok: true; policy: ChartSourcePolicy }
  | { ok: false; reason: string }

/** 读取一个源文件的结果；失败原因可归因到引用该源的行。 */
export type ChartSourceReadResult =
  | { ok: true; text: string }
  | { ok: false; reason: string }

/**
 * 解析并校验允许根：每个根必须存在且是目录，返回其真实路径。
 * @param roots - 配置的根；`undefined` 使用 cwd，空数组不添加任何根。
 * @param maxBytes - 单个文件的 UTF-8 字节上限。
 * @param cwd - 相对根与相对源路径的解析基准。
 * @returns 读取策略，或首个非法根的原因。
 */
export async function resolveChartSourcePolicy(
  roots: readonly string[] | undefined,
  maxBytes: number,
  cwd: string,
): Promise<ChartSourcePolicyResult> {
  const candidates = roots ?? [cwd]
  const resolved: string[] = []
  for (const root of candidates) {
    try {
      const real = await realpath(resolve(cwd, root))
      const info = await stat(real)
      if (!info.isDirectory()) {
        return { ok: false, reason: `params.chart_source_roots 不是目录: ${root}` }
      }
      resolved.push(real)
    } catch {
      return { ok: false, reason: `params.chart_source_roots 无法解析: ${root}` }
    }
  }
  return { ok: true, policy: { roots: [...new Set(resolved)], maxBytes, cwd } }
}

/**
 * 读取一个源文件：realpath 后校验允许根、扩展名、普通文件与大小上限。
 * stat 先按磁盘大小拒绝超大文件，读取后再按实际字节数复核，避免 stat 与 read
 * 之间的替换让内容超出上限。
 * @param sourcePath - 目标记录中的源文件路径（相对路径按策略的 cwd 解析）。
 * @param policy - 解析后的读取策略。
 * @returns 文件文本，或不可读/不允许/超限的原因。
 */
export async function readChartSource(
  sourcePath: string,
  policy: ChartSourcePolicy,
): Promise<ChartSourceReadResult> {
  try {
    const real = await realpath(resolve(policy.cwd, sourcePath))
    if (!policy.roots.some(root => isWithinRoot(root, real))) {
      return { ok: false, reason: '不在允许目录' }
    }
    const extension = extname(real).toLowerCase()
    if (extension !== '' && !TEXT_SOURCE_EXTENSIONS.has(extension)) {
      return { ok: false, reason: `不是文本扩展名（${extension}）` }
    }
    const info = await stat(real)
    if (!info.isFile()) return { ok: false, reason: '不是普通文件' }
    if (info.size > policy.maxBytes) {
      return { ok: false, reason: `超过大小上限（${policy.maxBytes} 字节）` }
    }
    const text = await readFile(real, 'utf8')
    if (Buffer.byteLength(text, 'utf8') > policy.maxBytes) {
      return { ok: false, reason: `超过大小上限（${policy.maxBytes} 字节）` }
    }
    return { ok: true, text }
  } catch {
    return { ok: false, reason: '文件不存在或无法读取' }
  }
}

/** 目标真实路径是否等于根或在根目录之下；`..foo` 这类同前缀兄弟目录不算在内。 */
function isWithinRoot(root: string, target: string): boolean {
  const nested = relative(root, target)
  return nested === '' || (nested !== '..' && !nested.startsWith(`..${sep}`) && !isAbsolute(nested))
}
