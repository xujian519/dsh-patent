/**
 * Front-matter parsing of one template asset, rewritten from `loader.go` of the
 * Go project Mady (`parseDocTemplate`, `extractFrontmatterRaw`).
 *
 * A template asset is a file boundary, so a field the model depends on is
 * validated here and a defect fails the load. The upstream loader silently
 * dropped an unknown format name; this rewrite rejects it, because a dropped
 * format removes a render target the asset asked for. The upstream composition
 * and history fields (`extends`, `shared_vars`, `changelog`) are not carried:
 * nothing composes or projects templates, so an asset carrying them parses with
 * those keys ignored.
 * @module @deepseek-ai/dsh-doc-template/frontmatter
 */

import { parse as parseYaml } from 'yaml'
import {
  DEFAULT_VAR_TYPE,
  DocTemplateError,
  FALLBACK_FORMAT,
  OUTPUT_FORMATS,
  VAR_TYPES,
  type DocTemplate,
  type OutputFormat,
  type VarDefinition,
  type VarType,
} from './types.ts'
import { createVarSchema } from './vars.ts'
import { isRecord } from '@deepseek-ai/dsh-value'

/** Fence opening a front-matter block. */
const FRONTMATTER_FENCE = '---\n'

/** The two halves of a template asset. */
export interface FrontmatterSplit {
  /** The raw YAML header, or the empty string when the asset has none. */
  readonly header: string
  /** The Markdown body after the header. */
  readonly body: string
}

/**
 * Split a template asset into its raw YAML header and its body. An asset whose
 * header is unclosed keeps its whole text as the body, as upstream.
 * @param raw - the asset text, already newline-normalized.
 * @returns the header and the body.
 */
export function splitFrontmatter(raw: string): FrontmatterSplit {
  if (!raw.startsWith(FRONTMATTER_FENCE)) return { header: '', body: raw }
  const rest = raw.slice(FRONTMATTER_FENCE.length)
  const closedWithNewline = rest.indexOf('\n---\n')
  const end = closedWithNewline >= 0 ? closedWithNewline : rest.indexOf('\n---')
  if (end < 0) return { header: '', body: raw }
  const body = rest.slice(end)
  return {
    header: rest.slice(0, end),
    body: body.startsWith('\n---\n') ? body.slice(5) : body.slice(4),
  }
}

/**
 * Whether a parsed YAML value is a plain mapping.
 * @param value - the parsed value.
 * @returns true when the value can be read as a string-keyed mapping.
 */
/**
 * Read one front-matter field that must be a non-blank string.
 * @param value - the raw value.
 * @param label - field path for the error message.
 * @returns the string.
 * @throws DocTemplateError when the value is not a non-blank string.
 */
function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new DocTemplateError('asset-invalid', `模板元数据 ${label} 必须是非空字符串。`)
  }
  return value
}

/**
 * Read one optional front-matter text field; an absent field is the empty string.
 * @param value - the raw value.
 * @param label - field path for the error message.
 * @returns the text, or the empty string when the field is absent.
 * @throws DocTemplateError when the value is present and not a string.
 */
function readText(value: unknown, label: string): string {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string') throw new DocTemplateError('asset-invalid', `模板元数据 ${label} 必须是字符串。`)
  return value
}

/**
 * Read one optional front-matter flag; an absent field is false.
 * @param value - the raw value.
 * @param label - field path for the error message.
 * @returns the boolean.
 * @throws DocTemplateError when the value is present and not a boolean.
 */
function readFlag(value: unknown, label: string): boolean {
  if (value === undefined || value === null) return false
  if (typeof value !== 'boolean') throw new DocTemplateError('asset-invalid', `模板元数据 ${label} 必须是布尔值。`)
  return value
}

/**
 * Read the declared output formats. A template that declares none, or declares
 * an empty list, supports the fallback format only.
 * @param value - the raw `formats` value.
 * @param filePath - template path for error messages.
 * @returns the supported formats in declaration order.
 * @throws DocTemplateError when a declared name is not a render format.
 */
function parseFormats(value: unknown, filePath: string): readonly OutputFormat[] {
  const label = `${filePath}: formats`
  if (value === undefined || value === null) return [FALLBACK_FORMAT]
  if (!Array.isArray(value)) throw new DocTemplateError('asset-invalid', `${label} 必须是格式数组。`)
  const formats = value.map((entry) => {
    const declared = requireText(entry, label)
    const format = OUTPUT_FORMATS.find(candidate => candidate === declared)
    if (format === undefined) {
      throw new DocTemplateError('asset-invalid', `${label} 不支持输出格式 ${JSON.stringify(declared)}（支持 ${OUTPUT_FORMATS.join('/')}）。`)
    }
    return format
  })
  return formats.length === 0 ? [FALLBACK_FORMAT] : formats
}

/**
 * Read one variable type; an undeclared type is the default single-line string.
 * @param value - the raw `type` value.
 * @param label - field path for the error message.
 * @returns the declared type.
 * @throws DocTemplateError when the declaration is not a variable type.
 */
function parseVarType(value: unknown, label: string): VarType {
  const declared = readText(value, label)
  if (declared === '') return DEFAULT_VAR_TYPE
  const type = VAR_TYPES.find(candidate => candidate === declared)
  if (type === undefined) {
    throw new DocTemplateError('asset-invalid', `${label} 必须是 ${VAR_TYPES.join('/')} 之一，实际值 ${JSON.stringify(declared)}。`)
  }
  return type
}

/**
 * Read the declared variables.
 * @param value - the raw `vars` value.
 * @param filePath - template path for error messages.
 * @returns the definitions in declaration order.
 * @throws DocTemplateError when an entry violates the variable contract.
 */
function parseVars(value: unknown, filePath: string): readonly VarDefinition[] {
  const label = `${filePath}: vars`
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new DocTemplateError('asset-invalid', `${label} 必须是变量数组。`)
  return value.map((entry, index) => {
    const entryLabel = `${label}[${String(index)}]`
    if (!isRecord(entry)) throw new DocTemplateError('asset-invalid', `${entryLabel} 必须是对象。`)
    const declaredDefault = entry['default']
    return {
      name: requireText(entry['name'], `${entryLabel}.name`),
      type: parseVarType(entry['type'], `${entryLabel}.type`),
      required: readFlag(entry['required'], `${entryLabel}.required`),
      ...declaredDefault === undefined || declaredDefault === null
        ? {}
        : { default: readText(declaredDefault, `${entryLabel}.default`) },
      description: readText(entry['description'], `${entryLabel}.description`),
    }
  })
}

/**
 * Parse one template asset. Newlines are normalized first, so a CRLF checkout
 * parses identically to an LF one, as upstream.
 * @param source - the asset text.
 * @param filePath - absolute path of the asset, used in errors and stored on the template.
 * @returns the parsed template.
 * @throws DocTemplateError when the asset has no front-matter or violates the template contract.
 */
export function parseTemplate(source: string, filePath: string): DocTemplate {
  const { header, body } = splitFrontmatter(source.replaceAll('\r\n', '\n'))
  if (header === '') {
    throw new DocTemplateError('asset-invalid', `${filePath}: 缺少 YAML front-matter（模板需以 --- 元数据块开头）。`)
  }
  const raw: unknown = parseYaml(header)
  if (!isRecord(raw)) throw new DocTemplateError('asset-invalid', `${filePath}: front-matter 必须是 YAML 对象。`)
  return {
    name: requireText(raw['name'], `${filePath}: name`),
    title: readText(raw['title'], `${filePath}: title`),
    category: readText(raw['category'], `${filePath}: category`),
    description: readText(raw['description'], `${filePath}: description`),
    domain: readText(raw['domain'], `${filePath}: domain`),
    version: readText(raw['version'], `${filePath}: version`),
    language: readText(raw['language'], `${filePath}: language`),
    styleName: readText(raw['style'], `${filePath}: style`),
    useWhen: readText(raw['use_when'], `${filePath}: use_when`),
    supportedFormats: parseFormats(raw['formats'], filePath),
    varSchema: createVarSchema(parseVars(raw['vars'], filePath)),
    filePath,
    body: body.trim(),
  }
}
