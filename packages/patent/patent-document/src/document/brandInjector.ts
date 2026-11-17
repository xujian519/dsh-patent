/**
 * 品牌注入：读取 theme.json 并映射为 CSS 变量。
 *
 * assets/templates/patent/*.html 使用 :root 上的 --sati-doc-* 变量；
 * 事务所/白标产品通过 theme.json 的 documents.patent 命名空间覆盖。
 * @module @deepseek-ai/dsh-patent-document/document/brandInjector
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DocumentRenderError } from './errors.ts'
import type { DocumentBrand } from './types.ts'

/** theme.json -> documents.patent 的已知键到 CSS 变量名的映射。 */
export const BRAND_KEY_TO_CSS_VAR: Record<string, string> = {
  firm: '--sati-doc-firm',
  confidential: '--sati-doc-confidential',
  disclaimer: '--sati-doc-disclaimer',
  accent: '--sati-doc-accent',
  accentStrong: '--sati-doc-accent-strong',
  body: '--sati-doc-body',
  muted: '--sati-doc-muted',
  border: '--sati-doc-border',
  headerBg: '--sati-doc-header-bg',
  surface: '--sati-doc-surface',
  zebra: '--sati-doc-zebra',
  danger: '--sati-doc-danger',
  warning: '--sati-doc-warning',
  success: '--sati-doc-success',
  evidence: '--sati-doc-evidence',
  client: '--sati-doc-client',
  model: '--sati-doc-model',
  assumption: '--sati-doc-assumption',
  fontSerif: '--sati-doc-font-serif',
  fontSans: '--sati-doc-font-sans',
  fontMono: '--sati-doc-font-mono',
}

/** 纯字符串值是否需要 CSS 引号（颜色/字体以外的文案类变量）。 */
const QUOTED_VARS = new Set(['--sati-doc-firm', '--sati-doc-confidential', '--sati-doc-disclaimer'])

/**
 * 从任意路径读取 theme.json 并提取 documents.patent 品牌覆盖。
 *
 * 未配置路径是合法默认，返回空覆盖；配置了却读不到、不是合法 JSON，或
 * documents.patent 不是「字符串值对象」时失败关闭——静默使用默认品牌会让
 * 事务所署名与免责声明在交付件里错成默认值，且没有任何提示。
 * @param path - theme.json 路径；缺省时返回空覆盖。
 * @returns documents.patent 命名空间下的品牌键值；没有该命名空间时为空对象。
 * @throws DocumentRenderError when the configured file is absent, unreadable, malformed, or not a string map.
 */
export function loadBrandFromPath(path?: string): DocumentBrand {
  if (path === undefined) return {}
  const abs = resolve(path)
  let raw: string
  try {
    raw = readFileSync(abs, 'utf8')
  } catch (error) {
    throw new DocumentRenderError(`品牌配置不可读：${abs}（${(error as Error).message}）`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new DocumentRenderError(`品牌配置不是合法 JSON：${abs}（${(error as Error).message}）`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DocumentRenderError(`品牌配置顶层必须是对象：${abs}`)
  }
  const patent = (parsed as { documents?: { patent?: unknown } }).documents?.patent
  if (patent === undefined) return {}
  if (typeof patent !== 'object' || patent === null || Array.isArray(patent)) {
    throw new DocumentRenderError(`品牌配置 documents.patent 必须是对象：${abs}`)
  }
  const brand: DocumentBrand = {}
  for (const [key, value] of Object.entries(patent)) {
    if (typeof value !== 'string') {
      throw new DocumentRenderError(`品牌配置 documents.patent.${key} 必须是字符串：${abs}`)
    }
    brand[key] = value
  }
  return brand
}

/**
 * 合并多层品牌覆盖：配置文件 < 显式传入。
 * @param explicit - 显式传入的内联品牌覆盖。
 * @param fromConfig - 从 theme.json 读取的品牌覆盖。
 * @returns 合并后的品牌对象（显式值胜出）。
 */
export function mergeBrand(explicit?: DocumentBrand, fromConfig?: DocumentBrand): DocumentBrand {
  return { ...(fromConfig ?? {}), ...(explicit ?? {}) }
}

/**
 * 将品牌对象编译为一段可注入 HTML <style> 的 CSS 文本。
 * @param brand - 品牌键值对象。
 * @returns :root 作用域的 CSS 规则文本。
 */
export function buildBrandStyle(brand: DocumentBrand): string {
  const lines: string[] = [':root {']
  for (const [key, value] of Object.entries(brand)) {
    const cssVar = BRAND_KEY_TO_CSS_VAR[key]
    // 跳过未知键与空值（空串/纯空白会生成 `--x: ;` 无效声明）。
    if (cssVar === undefined || value === undefined || value.trim() === '') continue
    const formatted = QUOTED_VARS.has(cssVar) ? `"${cssValueEscape(value)}"` : cssValueEscape(value)
    lines.push(`  ${cssVar}: ${formatted};`)
  }
  lines.push('}')
  return lines.join('\n')
}

/**
 * 对 CSS 值做最小转义：未引号值（颜色/字体等）剔除会破坏 CSS 结构的
 * 分号与花括号，并转义反斜杠；引号值额外转义双引号与换行。
 *
 * `<`/`>` 转成 CSS 十六进制转义（`\3C ` / `\3E `）：品牌值来自模型或
 * theme.json，原样保留会让 `</style>` 提前结束 `<style>` 并注入 HTML。
 * 十六进制转义在 CSS 中仍表示同一字符，样式值不受影响。
 * @param value - 原始 CSS 值。
 * @returns 转义后的安全 CSS 值。
 */
function cssValueEscape(value: string): string {
  const withoutBraces = value.replace(/[{};]/g, '').replace(/\\/g, '\\\\').replace(/\n/g, '\\A ')
  return withoutBraces
    .replace(/"/g, '\\"')
    .replace(/</g, '\\3C ')
    .replace(/>/g, '\\3E ')
}
