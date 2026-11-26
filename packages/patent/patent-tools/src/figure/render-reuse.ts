/**
 * FreeCAD 投影与剖切的内容复用。
 *
 * 键是 sha256，材料按固定顺序拼接：算法版本、工具名、归一化请求、各模型文件字节的 sha256。
 * 不含路径，也不含 mtime。键文件写在产物旁边（`产物路径.render-key`），成功后最后写入，
 * 因此产物 mtime 不晚于键文件。人改过产物、模型字节变了、或请求变了，键对不上，下次重新调用。
 * @module @deepseek-ai/dsh-patent-tools/figure/render-reuse
 */

import { createHash } from 'node:crypto'
import { readFile, rm, stat } from 'node:fs/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** 键算法版本。纳入字段或算法一变就加 1，旧键不再命中。 */
export const RENDER_REUSE_VERSION = 1

/** 结构线稿命中时追加的提示。不写入收据。 */
export const STRUCTURE_REUSE_WARNING = '复用已有结构线稿，未重新调用 FreeCAD'

/** 剖切展开命中时追加的提示。不写入收据。 */
export const SECTION_REUSE_WARNING = '复用已有剖切几何，未重新调用 FreeCAD'

/** 复用键的材料。`version` 缺省为 {@link RENDER_REUSE_VERSION}。 */
export type RenderReuseKeyInput = {
  /** `structure` 为结构投影，`section-source` 为剖切展开。 */
  tool: 'structure' | 'section-source'
  /** 归一化后的请求（字段顺序不影响键）。 */
  request: unknown
  /** 各模型文件字节的 sha256，顺序与调用顺序一致。 */
  modelHashes: readonly string[]
  /** 键算法版本；缺省 {@link RENDER_REUSE_VERSION}。测试用它让旧键落空。 */
  version?: number
}

/**
 * 计算复用键。
 * @param input - 版本、工具名、请求与模型字节摘要。
 * @returns 64 位十六进制 sha256。
 */
export function renderReuseKey(input: RenderReuseKeyInput): string {
  const payload = JSON.stringify(canonicalize({
    version: input.version ?? RENDER_REUSE_VERSION,
    tool: input.tool,
    request: input.request,
    modelHashes: [...input.modelHashes],
  }))
  return createHash('sha256').update(payload).digest('hex')
}

/**
 * 模型文件字节的 sha256。路径和 mtime 不参与。
 * @param path - 模型文件绝对路径。
 * @returns 64 位十六进制摘要。
 */
export async function hashModelFile(path: string): Promise<string> {
  const bytes = await readFile(path)
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 产物旁边的键文件路径。
 * @param productPath - SVG 或收据路径。
 * @returns 同目录的 `原路径.render-key`。
 */
export function renderKeyPath(productPath: string): string {
  return `${productPath}.render-key`
}

/**
 * 原子写入键文件（只含十六进制键）。
 * @param productPath - 产物路径。
 * @param key - {@link renderReuseKey} 的结果。
 */
export async function writeRenderKey(productPath: string, key: string): Promise<void> {
  await writeFileAtomic(renderKeyPath(productPath), key, { mode: 0o644 })
}

/**
 * 原子写入收据文本。
 * @param path - 收据路径。
 * @param text - JSON 文本。
 */
export async function writeReuseText(path: string, text: string): Promise<void> {
  await writeFileAtomic(path, text, { mode: 0o644 })
}

/**
 * 读取文本；文件不存在时返回 undefined。
 * @param path - 文件路径。
 * @returns 文件文本，或 undefined。
 */
export async function readReuseText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isEnoent(error)) return undefined
    throw error
  }
}

/**
 * 删除复用文件；不存在时忽略。
 * @param path - 收据或键文件路径。
 */
export async function removeReuseFile(path: string): Promise<void> {
  try {
    await rm(path)
  } catch (error) {
    if (isEnoent(error)) return
    throw error
  }
}

/**
 * 产物能否按该键复用：键文件内容一致、产物是非空文件、且产物 mtime 不晚于键文件。
 * @param productPath - SVG 或收据路径。
 * @param key - 本次计算出的键。
 * @returns 三项都成立时为 true。
 */
export async function reusableProduct(productPath: string, key: string): Promise<boolean> {
  try {
    const [keyText, keyStat, productStat] = await Promise.all([
      readFile(renderKeyPath(productPath), 'utf8'),
      stat(renderKeyPath(productPath)),
      stat(productPath),
    ])
    return keyText.trim() === key && productStat.isFile() && productStat.size > 0 && productStat.mtimeMs <= keyStat.mtimeMs
  } catch (error) {
    if (isEnoent(error)) return false
    throw error
  }
}

/**
 * 路径是非空普通文件。不存在时为 false。
 * @param path - 文件路径。
 * @returns 存在、是文件、且字节数大于 0。
 */
export async function nonEmptyFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile() && info.size > 0
  } catch (error) {
    if (isEnoent(error)) return false
    throw error
  }
}

/**
 * 把 JSON 文本读成对象。语法错误、或值不是对象时返回 undefined（收据损坏按未命中）。
 * @param text - JSON 文本。
 * @returns 对象，或 undefined。
 */
export function readJsonRecord(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : undefined
  } catch (error) {
    /* v8 ignore next -- JSON.parse only rejects with SyntaxError */
    if (!(error instanceof SyntaxError)) throw error
    return undefined
  }
}

/**
 * 字符串数组。元素不是字符串、或值不是数组时返回 undefined。
 * @param value - 候选值。
 * @returns 字符串数组，或 undefined。
 */
export function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return undefined
    items.push(item)
  }
  return items
}

/** 对象（不含数组与 null）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** node:fs 的「文件不存在」。其它错误继续抛出。 */
function isEnoent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/**
 * 稳定 JSON：对象键排序，数组保序，丢掉 undefined 字段。
 * @param value - 任意 JSON 值。
 * @returns 可交给 JSON.stringify 的值。
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(item => canonicalize(item))
  if (!isRecord(value)) return value
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    const item = value[key]
    if (item !== undefined) sorted[key] = canonicalize(item)
  }
  return sorted
}
