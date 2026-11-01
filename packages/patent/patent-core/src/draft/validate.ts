/**
 * src/draft/validate — 受控草案校验。
 *
 * 草案来自模型工具参数（tool JSON 边界），入口一律为 unknown：校验即窄化，
 * 通过时返回按已校验分量重新组装的草案对象，失败时聚合全部违规一次抛出
 * {@link DraftValidationError}。违规消息面向模型可读：未知键一律列出可用项。
 */

import { asJsonRecord } from '../llm-json.ts'
import {
  SPEC_PART_HEADINGS,
  SPEC_PART_ORDER,
  type DraftBlock,
  type DraftGroundItem,
  type SpecDraft,
  type SpecDraftMeta,
  type SpecPartId,
  type TemplateBlocksSlot,
  type TemplateChoiceOption,
  type TemplateDraft,
  type TemplateDraftSchema,
  type TemplateRowsSlot,
} from './types.ts'

/** 草案校验失败：聚合全部违规，消息面向模型可读。 */
export class DraftValidationError extends Error {
  /** 逐条违规（路径 + 原因）。 */
  readonly violations: string[]

  constructor(violations: string[]) {
    super(`草案校验失败（${violations.length} 项）：\n- ${violations.join('\n- ')}`)
    this.name = 'DraftValidationError'
    this.violations = violations
  }
}

/** claims-spec 草案的顶层可用键。 */
const SPEC_DRAFT_KEYS = ['meta', 'claims', 'abstract', 'figureFiles', 'abstractFigure', 'sections'] as const

/** 模板草案的顶层可用键。 */
const TEMPLATE_DRAFT_KEYS = ['fields', 'sections'] as const

/** meta 的必填键。 */
const META_KEYS = ['caseNumber', 'title', 'applicant', 'inventor', 'agent', 'date'] as const

/** 块类型可用项。 */
const BLOCK_KINDS = ['paragraph', 'list', 'table'] as const

/** paragraph 块可用键。 */
const PARAGRAPH_KEYS = ['kind', 'text'] as const

/** list 块可用键。 */
const LIST_KEYS = ['kind', 'items', 'ordered'] as const

/** table 块可用键。 */
const TABLE_KEYS = ['kind', 'name', 'header', 'rows'] as const

/** 权利要求自带项号的行首形态：`1.`、`3、`、`12．`。 */
const CLAIM_NUMBER_PREFIX = /^\s*\d+\s*[.、．]/

/** 摘要附图号的合法形态：十进制正整数，无前导零（与图号渲染逐字一致）。 */
const ABSTRACT_FIGURE_NUMBER = /^[1-9]\d*$/

/** 表名禁止的行首形态：`表1`、`表 2`。 */
const TABLE_NUMBER_PREFIX = /^\s*表\s*\d/

/** 附图说明列表项禁止的行首形态：`图1为`、`图 2是`、`附图3：`。 */
const DRAWING_ITEM_FIGURE_PREFIX = /^\s*(?:图|附图)\s*(?:\d+|[一二三四五六七八九十百]+)/

/** 附图说明列表项禁止的句末标点：`。`、`；`、`;`。 */
const DRAWING_ITEM_TERMINAL_PUNCTUATION = /[。；;]\s*$/

function available(parts: readonly string[]): string {
  return parts.join('、')
}

/** 记录未知键；返回是否有未知键。 */
function reportUnknownKeys(record: Record<string, unknown>, allowed: readonly string[], path: string, violations: string[]): boolean {
  let unknown = false
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      violations.push(`${path}${path === '' ? '' : '.'}${key} 未知（可用项：${available(allowed)}）`)
      unknown = true
    }
  }
  return unknown
}

/** 非空字符串校验：非字符串或空（含纯空白）返回 undefined 并记违规。 */
function requireNonEmptyString(value: unknown, path: string, violations: string[]): string | undefined {
  if (typeof value !== 'string') {
    violations.push(`${path} 必须是字符串`)
    return undefined
  }
  if (value.trim() === '') {
    violations.push(`${path} 为空`)
    return undefined
  }
  return value
}

/** 读取对象中一个必填非空字符串字段。 */
function readRequiredString(record: Record<string, unknown>, key: string, path: string, violations: string[]): string | undefined {
  if (!Object.hasOwn(record, key)) {
    violations.push(`${path}.${key} 缺失`)
    return undefined
  }
  return requireNonEmptyString(record[key], `${path}.${key}`, violations)
}

/** 读取数组：缺失、非数组记违规；给出 emptyMessage 时空数组也记违规。 */
function readArray(value: unknown, path: string, violations: string[], emptyMessage?: string): unknown[] | undefined {
  if (value === undefined) {
    violations.push(`${path} 缺失`)
    return undefined
  }
  if (!Array.isArray(value)) {
    violations.push(`${path} 必须是数组`)
    return undefined
  }
  if (emptyMessage !== undefined && value.length === 0) {
    violations.push(`${path} ${emptyMessage}`)
    return undefined
  }
  return value as unknown[]
}

/** 读取字符串数组：缺失、非数组、非字符串项、空项均记违规；给出 emptyMessage 时空数组也记违规。 */
function readStringList(
  value: unknown,
  path: string,
  violations: string[],
  emptyMessage: string | undefined = '至少一项',
): string[] | undefined {
  return readStringListWith(path, violations, readArray(value, path, violations, emptyMessage))
}

/** 逐项校验字符串数组并保持数组长度一致。 */
function readStringListWith(path: string, violations: string[], array: unknown[] | undefined): string[] | undefined {
  if (array === undefined) return undefined
  const items: string[] = []
  array.forEach((item, index) => {
    const text = requireNonEmptyString(item, `${path}[${index}]`, violations)
    if (text !== undefined) {
      items.push(text)
    }
  })
  return items.length === array.length ? items : undefined
}

/**
 * 校验块数组；返回窄化后的块数组。
 * @param value - 待校验的块数组（unknown）。
 * @param path - 违规消息中的位置前缀。
 * @param violations - 违规收集器。
 * @returns 窄化后的块数组；存在违规返回 undefined。
 */
function validateBlocks(value: unknown, path: string, violations: string[], allowEmpty = false): DraftBlock[] | undefined {
  const array = readArray(value, path, violations, allowEmpty ? undefined : '至少一个块')
  if (array === undefined) return undefined
  const blocks: DraftBlock[] = []
  array.forEach((item, index) => {
    const block = validateBlock(item, `${path}[${index}]`, violations)
    if (block !== undefined) {
      blocks.push(block)
    }
  })
  return blocks.length === array.length ? blocks : undefined
}

/**
 * 校验单个块；返回窄化后的块。
 * @param value - 待校验的块（unknown）。
 * @param path - 违规消息中的位置前缀。
 * @param violations - 违规收集器。
 * @returns 窄化后的块；存在违规返回 undefined。
 */
function validateBlock(value: unknown, path: string, violations: string[]): DraftBlock | undefined {
  const record = asJsonRecord(value)
  if (record === undefined) {
    violations.push(`${path} 必须是对象`)
    return undefined
  }
  const kind = record.kind
  if (kind !== 'paragraph' && kind !== 'list' && kind !== 'table') {
    violations.push(`${path} 未知块类型 ${JSON.stringify(kind)}（可用项：${available(BLOCK_KINDS)}）`)
    return undefined
  }
  const hasUnknownKeys = reportUnknownKeys(record, kind === 'paragraph' ? PARAGRAPH_KEYS : kind === 'list' ? LIST_KEYS : TABLE_KEYS, path, violations)
  if (kind === 'paragraph') {
    const text = readRequiredString(record, 'text', path, violations)
    if (text === undefined) return undefined
    return hasUnknownKeys ? undefined : { kind, text }
  }
  if (kind === 'list') {
    const items = readStringList(record.items, `${path}.items`, violations)
    if (items === undefined) return undefined
    const ordered = record.ordered
    if (ordered !== undefined && typeof ordered !== 'boolean') {
      violations.push(`${path}.ordered 必须是布尔值`)
      return undefined
    }
    if (hasUnknownKeys) return undefined
    return ordered === undefined ? { kind, items } : { kind, items, ordered }
  }
  return validateTable(record, path, violations, hasUnknownKeys)
}

/**
 * 校验 table 块（kind 已确认）。
 * @param record - 块的 JSON 对象。
 * @param path - 违规消息中的位置前缀。
 * @param violations - 违规收集器。
 * @param unknownKeys - 是否已记录未知键违规。
 * @returns 窄化后的块；存在违规返回 undefined。
 */
function validateTable(record: Record<string, unknown>, path: string, violations: string[], unknownKeys: boolean): DraftBlock | undefined {
  const name = readRequiredString(record, 'name', path, violations)
  const header = readStringList(record.header, `${path}.header`, violations, '至少一列')
  const rowsArray = readArray(record.rows, `${path}.rows`, violations, '至少一行')
  let valid = !unknownKeys
  if (name !== undefined && TABLE_NUMBER_PREFIX.test(name)) {
    violations.push(`${path}.name 不得以「表+数字」开头（编号由渲染器自动生成）：${JSON.stringify(name)}`)
    valid = false
  }
  const rows: string[][] = []
  if (rowsArray !== undefined && header !== undefined) {
    rowsArray.forEach((rowValue, rowIndex) => {
      const row = readStringList(rowValue, `${path}.rows[${rowIndex}]`, violations)
      if (row === undefined) {
        valid = false
        return
      }
      if (row.length !== header.length) {
        violations.push(`${path}.rows[${rowIndex}] 行宽 ${row.length} 与表头 ${header.length} 列不一致`)
        valid = false
        return
      }
      rows.push(row)
    })
  } else if (rowsArray === undefined) {
    valid = false
  }
  if (name === undefined || header === undefined || !valid) return undefined
  return { kind: 'table', name, header, rows }
}

function validateMeta(value: unknown, violations: string[]): SpecDraftMeta | undefined {
  if (value === undefined) {
    violations.push(`meta 缺失（可用项：${available(META_KEYS)}）`)
    return undefined
  }
  const record = asJsonRecord(value)
  if (record === undefined) {
    violations.push('meta 必须是对象')
    return undefined
  }
  let valid = !reportUnknownKeys(record, META_KEYS, 'meta', violations)
  const meta: SpecDraftMeta = { caseNumber: '', title: '', applicant: '', inventor: '', agent: '', date: '' }
  for (const key of META_KEYS) {
    const text = readRequiredString(record, key, 'meta', violations)
    if (text === undefined) {
      valid = false
    } else {
      meta[key] = text
    }
  }
  return valid ? meta : undefined
}

function validateSpecSections(value: unknown, violations: string[]): Record<SpecPartId, DraftBlock[]> | undefined {
  if (value === undefined) {
    violations.push('sections 缺失')
    return undefined
  }
  const record = asJsonRecord(value)
  if (record === undefined) {
    violations.push('sections 必须是对象')
    return undefined
  }
  let valid = !reportUnknownKeys(record, SPEC_PART_ORDER, 'sections', violations)
  const sections: Partial<Record<SpecPartId, DraftBlock[]>> = {}
  for (const partId of SPEC_PART_ORDER) {
    const heading = SPEC_PART_HEADINGS[partId]
    if (!Object.hasOwn(record, partId)) {
      violations.push(`sections.${partId} 缺失（${heading}）`)
      valid = false
      continue
    }
    // 无附图发明可以没有附图说明：该部分允许空数组，其余四部分仍须有内容。
    const blocks = validateBlocks(record[partId], `sections.${partId}`, violations, partId === 'drawingDescriptions')
    if (blocks === undefined) {
      valid = false
      continue
    }
    if (partId !== 'embodiment') {
      blocks.forEach((block, index) => {
        if (block.kind === 'table') {
          violations.push(`sections.${partId}[${index}] 表格仅允许出现在具体实施方式（embodiment）`)
          valid = false
        }
      })
    }
    if (partId === 'drawingDescriptions' && reportDrawingDescriptionItems(blocks, `sections.${partId}`, violations)) {
      valid = false
    }
    sections[partId] = blocks
  }
  return valid ? sections as Record<SpecPartId, DraftBlock[]> : undefined
}

/**
 * 附图说明的列表项只承载描述文字：图号（「图N为」）与句末标点由渲染器生成。
 * 列表项自带其中任何一项都会在成文时重复，因此在校验边界直接拒绝。
 * @param blocks - 附图说明部分的块序列。
 * @param path - 违规消息中的位置前缀。
 * @param violations - 违规收集器。
 * @returns 是否发现违规。
 */
function reportDrawingDescriptionItems(blocks: readonly DraftBlock[], path: string, violations: string[]): boolean {
  let found = false
  blocks.forEach((block, blockIndex) => {
    if (block.kind !== 'list') return
    block.items.forEach((item, itemIndex) => {
      const authored: string[] = []
      if (DRAWING_ITEM_FIGURE_PREFIX.test(item)) authored.push('图号')
      if (DRAWING_ITEM_TERMINAL_PUNCTUATION.test(item)) authored.push('句末标点')
      if (authored.length === 0) return
      found = true
      violations.push(
        `${path}[${blockIndex}].items[${itemIndex}] 自带${authored.join('和')}：请只写图名与描述文字，图号（「图N为」）与句末标点由渲染器生成`,
      )
    })
  })
  return found
}

/**
 * 校验 claims-spec 申请文件草案。
 * @param input - 模型提交的工具参数（unknown，tool JSON 边界）。
 * @returns 按已校验分量组装的 {@link SpecDraft}。
 * @throws {DraftValidationError} 存在任何违规时抛出，聚合全部违规。
 */
export function validateSpecDraft(input: unknown): SpecDraft {
  const violations: string[] = []
  const root = asJsonRecord(input)
  if (root === undefined) {
    throw new DraftValidationError([`草案必须是对象（可用项：${available(SPEC_DRAFT_KEYS)}）`])
  }
  reportUnknownKeys(root, SPEC_DRAFT_KEYS, '', violations)

  const meta = validateMeta(root.meta, violations)
  const claims = readStringList(root.claims, 'claims', violations)
  if (claims !== undefined) {
    claims.forEach((claim, index) => {
      if (CLAIM_NUMBER_PREFIX.test(claim)) {
        violations.push(`claims[${index}] 自带项号（${JSON.stringify(claim.slice(0, 12))}…）：请去掉项号，由渲染器自动编号`)
      }
    })
  }
  const abstractParagraphs = readStringList(root.abstract, 'abstract', violations, '至少一段')
  // 无附图发明的 figureFiles 可以是空数组；逐项仍要求非空。
  const figureFiles = readStringList(root.figureFiles, 'figureFiles', violations, undefined)
  const abstractFigure = root.abstractFigure === undefined
    ? undefined
    : requireNonEmptyString(root.abstractFigure, 'abstractFigure', violations)
  if (abstractFigure !== undefined && figureFiles !== undefined && !inFigureNumberRange(abstractFigure, figureFiles.length)) {
    violations.push(
      `abstractFigure ${JSON.stringify(abstractFigure)} 不是有效附图号（须为 1..${figureFiles.length} 的整数，figureFiles 共 ${figureFiles.length} 项）`,
    )
  }
  const sections = validateSpecSections(root.sections, violations)
  if (figureFiles !== undefined && sections !== undefined) {
    const entries = figureEntryCount(sections.drawingDescriptions)
    if (entries !== figureFiles.length) {
      violations.push(
        `附图说明条目数与 figureFiles 项数不一致：附图说明 ${entries} 条，figureFiles ${figureFiles.length} 项（每幅附图恰一条列表项，渲染为「图N为……」；列表项只写图名与描述文字，不含图号与句末标点）`,
      )
    }
  }

  if (violations.length > 0) throw new DraftValidationError(violations)
  return {
    meta: meta as SpecDraftMeta,
    claims: claims as string[],
    abstract: abstractParagraphs as string[],
    figureFiles: figureFiles as string[],
    ...(abstractFigure !== undefined ? { abstractFigure } : {}),
    sections: sections as Record<SpecPartId, DraftBlock[]>,
  }
}

/** 附图说明部分的附图条目数：列表块项数之和（每项渲染成一条「图N为……」）。 */
function figureEntryCount(blocks: readonly DraftBlock[]): number {
  return blocks.reduce((total, block) => total + (block.kind === 'list' ? block.items.length : 0), 0)
}

/** 摘要附图号是否落在 1..count：十进制正整数、无前导零（与「图 N」的渲染逐字一致）。 */
function inFigureNumberRange(value: string, count: number): boolean {
  if (!ABSTRACT_FIGURE_NUMBER.test(value)) return false
  const number = Number(value)
  return number >= 1 && number <= count
}

/** 列出选项集合：`id（label）` 逐项。 */
function availableOptions(options: readonly TemplateChoiceOption[]): string {
  return available(options.map(option => `${option.id}（${option.label}）`))
}

/** 校验 choice 槽位值；单选接受字符串，多选接受字符串数组（字符串视同单项）。 */
function validateChoiceValue(
  value: unknown,
  path: string,
  slot: { options?: readonly TemplateChoiceOption[]; multiple?: boolean },
  violations: string[],
): string | string[] | undefined {
  const raw: unknown[] = Array.isArray(value) ? value : [value]
  if (Array.isArray(value) && slot.multiple !== true) {
    violations.push(`${path} 是单选槽位，不接受数组（可选项：${slot.options === undefined ? '未声明' : availableOptions(slot.options)}）`)
    return undefined
  }
  if (raw.length === 0) {
    violations.push(`${path} 至少选择一项`)
    return undefined
  }
  const selected: string[] = []
  let valid = true
  for (const [index, item] of raw.entries()) {
    const text = requireNonEmptyString(item, `${path}[${index}]`, violations)
    if (text === undefined) {
      valid = false
      continue
    }
    if (slot.options !== undefined && !slot.options.some(option => option.id === text)) {
      violations.push(`${path} 未知选项 ${JSON.stringify(text)}（可选项：${availableOptions(slot.options)}）`)
      valid = false
      continue
    }
    selected.push(text)
  }
  if (!valid) return undefined
  return slot.multiple === true ? selected : selected[0]
}

/**
 * 校验文本/选项槽位映射；返回窄化后的映射。
 * text 槽值为非空字符串；choice 槽值为选中项 id（多选为 id 数组），未知选项报错并列出可选项。
 */
function validateTemplateFields(
  value: unknown,
  schema: TemplateDraftSchema | undefined,
  violations: string[],
): TemplateDraft['fields'] | undefined {
  if (value === undefined) {
    if (schema?.fields !== undefined) {
      for (const [id, slot] of Object.entries(schema.fields)) {
        if (slot.required === true) violations.push(`fields.${id} 缺失`)
      }
    }
    return undefined
  }
  const record = asJsonRecord(value)
  if (record === undefined) {
    violations.push('fields 必须是对象')
    return undefined
  }
  let valid = true
  const fields: Record<string, string | string[]> = {}
  for (const [id, fieldValue] of Object.entries(record)) {
    const slot = schema?.fields?.[id]
    if (schema !== undefined && slot === undefined) {
      violations.push(`fields.${id} 未知槽位（可用项：${available(Object.keys(schema.fields ?? {}))}）`)
      valid = false
      continue
    }
    if (slot?.kind === 'choice') {
      const selected = validateChoiceValue(fieldValue, `fields.${id}`, slot, violations)
      if (selected === undefined) {
        valid = false
      } else {
        fields[id] = selected
      }
    } else {
      const text = requireNonEmptyString(fieldValue, `fields.${id}`, violations)
      if (text === undefined) {
        valid = false
      } else {
        fields[id] = text
      }
    }
  }
  if (schema?.fields !== undefined) {
    for (const [id, slot] of Object.entries(schema.fields)) {
      if (slot.required === true && !Object.hasOwn(fields, id)) {
        violations.push(`fields.${id} 缺失`)
        valid = false
      }
    }
  }
  return valid ? fields : undefined
}

/**
 * 校验数据行槽位值：非空行数组，每行非空且单元格非空字符串，各行等宽且宽度等于 columns。
 * @param value - 待校验的行数组（unknown）。
 * @param path - 违规消息中的位置前缀。
 * @param columns - 注册表声明的列数。
 * @param violations - 违规收集器。
 * @returns 窄化后的行数组；存在违规返回 undefined。
 */
function validateRows(value: unknown, path: string, columns: number | undefined, violations: string[]): string[][] | undefined {
  const array = readArray(value, path, violations, '至少一行')
  if (array === undefined) return undefined
  const rows: string[][] = []
  let width: number | undefined
  let valid = true
  array.forEach((item, index) => {
    const row = readStringList(item, `${path}[${index}]`, violations, '至少一列')
    if (row === undefined) {
      valid = false
      return
    }
    if (width === undefined) {
      width = row.length
    } else if (row.length !== width) {
      violations.push(`${path}[${index}] 列数 ${row.length} 与首行列数 ${width} 不一致`)
      valid = false
      return
    }
    rows.push(row)
  })
  if (columns !== undefined && width !== undefined && width !== columns) {
    violations.push(`${path} 列数 ${width} 与模板列数 ${columns} 不一致`)
    valid = false
  }
  return valid ? rows : undefined
}

/** 块序列的计量：只覆盖段落与列表（表格块不在正文槽位，见 {@link validateTemplateBlocks}）。 */
interface BlockMeasure {
  /** 可见字符数。 */
  chars: number
  /** 列表项数。 */
  items: number
}

/**
 * 可见字符数：去掉全部空白后按码点计数。
 *
 * 与篇幅预算的口径一致（模型按字数自控、校验按字数兜底），按码点而非 UTF-16 码元，
 * 避免一个生僻字被计成两个字。
 * @param text - 待计数的文本。
 * @returns 可见字符数。
 */
function visibleChars(text: string): number {
  return Array.from(text.replace(/\s+/gu, '')).length
}

/**
 * 校验 blocks 章节槽位值；模板草案不支持表格块（表格仅 claims-spec 支持）。
 *
 * 同时给出该槽位的计量，供 {@link checkBlocksQuota} 判配额——计量与结构校验同一遍完成，
 * 避免为算字数再走一遍块数组。
 * @param value - 槽位值。
 * @param path - 违规消息中的位置前缀。
 * @param violations - 违规收集器。
 * @returns 窄化后的块数组与计量；存在违规返回 undefined。
 */
function validateTemplateBlocks(
  value: unknown,
  path: string,
  violations: string[],
): (BlockMeasure & { blocks: DraftBlock[] }) | undefined {
  const blocks = validateBlocks(value, path, violations)
  if (blocks === undefined) return undefined
  let valid = true
  let chars = 0
  let items = 0
  for (const [index, block] of blocks.entries()) {
    if (block.kind === 'table') {
      violations.push(`${path}[${index}] 表格块仅 claims-spec 支持：表单模板用 rows 数据行槽位`)
      valid = false
      continue
    }
    if (block.kind === 'paragraph') {
      chars += visibleChars(block.text)
      continue
    }
    chars += block.items.reduce((sum, item) => sum + visibleChars(item), 0)
    items += block.items.length
  }
  return valid ? { blocks, chars, items } : undefined
}

/**
 * 校验正文槽位的字符与条目配额；超限的违规文案带槽位 id、实测值、上限与需删减量。
 * @param id - 槽位 id。
 * @param slot - 槽位声明（只读取 `maxChars` / `maxItems`）。
 * @param measure - 该槽位的计量。
 * @param violations - 违规收集器。
 * @returns 是否在配额内。
 */
function checkBlocksQuota(id: string, slot: TemplateBlocksSlot, measure: BlockMeasure, violations: string[]): boolean {
  let within = true
  if (slot.maxChars !== undefined && measure.chars > slot.maxChars) {
    violations.push(
      `sections.${id} 正文 ${measure.chars} 字超出配额（上限 ${slot.maxChars} 字）：请删减 ${measure.chars - slot.maxChars} 字以上`,
    )
    within = false
  }
  if (slot.maxItems !== undefined && measure.items > slot.maxItems) {
    violations.push(
      `sections.${id} 列表 ${measure.items} 项超出配额（上限 ${slot.maxItems} 项）：请合并或删除 ${measure.items - slot.maxItems} 项以上`,
    )
    within = false
  }
  return within
}

/**
 * 校验数据行槽位的行数配额。
 * @param id - 槽位 id。
 * @param slot - 槽位声明（只读取 `maxRows`）。
 * @param rows - 已校验的数据行。
 * @param violations - 违规收集器。
 * @returns 是否在配额内。
 */
function checkRowsQuota(id: string, slot: TemplateRowsSlot, rows: readonly string[][], violations: string[]): boolean {
  if (slot.maxRows === undefined || rows.length <= slot.maxRows) return true
  violations.push(
    `sections.${id} 数据行 ${rows.length} 行超出配额（上限 ${slot.maxRows} 行）：请合并或删除 ${rows.length - slot.maxRows} 行以上`,
  )
  return false
}

/**
 * 校验无效理由节槽位值：每项须有法条、理由名、≥1 个权项号与三段非空正文。
 *
 * 三段正文（事实认定 / 证据分析 / 法条适用与结论）必须分栏提交而不是一整段，因为渲染器按
 * 四段式生成小标题；合成一段会让"事实与评价分离"这条纪律在成品里看不出来。
 * @param value - 槽位值。
 * @param path - 违规消息里的路径。
 * @param violations - 违规收集器。
 * @returns 窄化后的理由项数组；存在违规返回 undefined。
 */
function validateGrounds(value: unknown, path: string, violations: string[]): DraftGroundItem[] | undefined {
  const array = readArray(value, path, violations, '至少一项')
  if (array === undefined) return undefined
  const before = violations.length
  const items: DraftGroundItem[] = []
  array.forEach((item, index) => {
    const record = asJsonRecord(item)
    if (record === undefined) {
      violations.push(`${path}[${index}] 必须是对象`)
      return
    }
    const prefix = `${path}[${index}]`
    const article = readRequiredString(record, 'article', prefix, violations)
    const ground = readRequiredString(record, 'ground', prefix, violations)
    const facts = readRequiredString(record, 'facts', prefix, violations)
    const evidence = readRequiredString(record, 'evidence', prefix, violations)
    const conclusion = readRequiredString(record, 'conclusion', prefix, violations)
    const claimNos = readPositiveIntegerList(record.claimNos, `${prefix}.claimNos`, violations)
    if (
      article === undefined || ground === undefined || facts === undefined
      || evidence === undefined || conclusion === undefined || claimNos === undefined
    ) {
      return
    }
    items.push({ article, ground, claimNos, facts, evidence, conclusion })
  })
  return violations.length === before ? items : undefined
}

/**
 * 校验权利要求序号列表：≥1 项，各项为 ≥1 的整数，去重后升序。
 */
function readPositiveIntegerList(value: unknown, path: string, violations: string[]): number[] | undefined {
  const array = readArray(value, path, violations, '至少一个权利要求序号')
  if (array === undefined) return undefined
  const before = violations.length
  const numbers = new Set<number>()
  array.forEach((item, index) => {
    if (typeof item !== 'number' || !Number.isInteger(item) || item < 1) {
      violations.push(`${path}[${index}] 必须是 ≥1 的整数（权利要求序号）`)
      return
    }
    numbers.add(item)
  })
  return violations.length === before ? [...numbers].sort((a, b) => a - b) : undefined
}

function validateTemplateSections(
  value: unknown,
  schema: TemplateDraftSchema | undefined,
  violations: string[],
): TemplateDraft['sections'] | undefined {
  if (value === undefined) {
    violations.push('sections 缺失')
    return undefined
  }
  if (!Array.isArray(value)) {
    violations.push('sections 必须是数组')
    return undefined
  }
  const sections: TemplateDraft['sections'] = []
  const seen = new Set<string>()
  let valid = true
  value.forEach((item, index) => {
    const record = asJsonRecord(item)
    if (record === undefined) {
      violations.push(`sections[${index}] 必须是对象`)
      valid = false
      return
    }
    const id = readRequiredString(record, 'id', `sections[${index}]`, violations)
    if (id !== undefined) {
      if (seen.has(id)) {
        violations.push(`sections[${index}] 重复槽位 ${JSON.stringify(id)}（可用项：${available([...new Set([...seen, ...Object.keys(schema?.sections ?? {})])])}）`)
        valid = false
      } else {
        seen.add(id)
      }
      if (schema?.sections !== undefined && !Object.hasOwn(schema.sections, id)) {
        violations.push(`sections.${id} 未知槽位（可用项：${available(Object.keys(schema.sections))}）`)
        valid = false
      }
    }
    const slot = id === undefined ? undefined : schema?.sections?.[id]
    if (slot?.kind === 'grounds') {
      if (record.blocks !== undefined || record.rows !== undefined) {
        violations.push(`sections.${id} 是无效理由槽位，不接受 blocks / rows`)
        valid = false
      }
      const grounds = validateGrounds(record.grounds, `sections.${index}.grounds`, violations)
      if (id === undefined || grounds === undefined) {
        valid = false
      } else {
        sections.push({ id, grounds })
      }
      return
    }
    if (slot?.kind === 'rows') {
      if (record.blocks !== undefined) {
        violations.push(`sections.${id} 是数据行槽位，不接受 blocks`)
        valid = false
      }
      if (record.grounds !== undefined) {
        violations.push(`sections.${id} 是数据行槽位，不接受 grounds`)
        valid = false
      }
      const rows = validateRows(record.rows, `sections.${index}.rows`, slot.columns, violations)
      if (id === undefined || rows === undefined) {
        valid = false
      } else {
        if (!checkRowsQuota(id, slot, rows, violations)) valid = false
        sections.push({ id, rows })
      }
      return
    }
    if (record.rows !== undefined) {
      violations.push(`sections.${id} 是正文槽位，不接受 rows（数据行请用 rows 类槽位）`)
      valid = false
      return
    }
    if (record.grounds !== undefined) {
      violations.push(`sections.${id} 是正文槽位，不接受 grounds（理由请用 grounds 类槽位）`)
      valid = false
      return
    }
    const measured = validateTemplateBlocks(record.blocks, `sections[${index}].blocks`, violations)
    if (id === undefined || measured === undefined) {
      valid = false
    } else {
      if (slot !== undefined && !checkBlocksQuota(id, slot, measured, violations)) valid = false
      sections.push({ id, blocks: measured.blocks })
    }
  })
  if (schema?.sections !== undefined) {
    for (const [id, slot] of Object.entries(schema.sections)) {
      if (slot.required === true && !seen.has(id)) {
        violations.push(`sections.${id} 缺失`)
        valid = false
      }
    }
  }
  return valid ? sections : undefined
}

/**
 * 校验文书模板草案；提供 schema 时按槽位集合校验未知键与必填槽位。
 * @param input - 模型提交的工具参数（unknown，tool JSON 边界）。
 * @param schema - 槽位 schema（来自 patent-document 注册表）；缺省时只做结构校验。
 * @returns 按已校验分量组装的 {@link TemplateDraft}。
 * @throws {DraftValidationError} 存在任何违规时抛出，聚合全部违规。
 */
export function validateTemplateDraft(input: unknown, schema?: TemplateDraftSchema): TemplateDraft {
  const violations: string[] = []
  const root = asJsonRecord(input)
  if (root === undefined) {
    throw new DraftValidationError([`草案必须是对象（可用项：${available(TEMPLATE_DRAFT_KEYS)}）`])
  }
  reportUnknownKeys(root, TEMPLATE_DRAFT_KEYS, '', violations)
  const fields = validateTemplateFields(root.fields, schema, violations)
  const sections = validateTemplateSections(root.sections, schema, violations)
  if (violations.length > 0) throw new DraftValidationError(violations)
  return {
    ...(fields !== undefined ? { fields } : {}),
    sections: sections as TemplateDraft['sections'],
  }
}
