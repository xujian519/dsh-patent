/**
 * src/draft/schema — 受控草案的作者 schema（defineTool 参数，未编译成 JSON Schema）。
 *
 * schema 规定 JSON 类型：列表字段是数组。`validateSpecDraft` / `validateTemplateDraft`
 * 规定体例：非空、项号、附图条数、表格位置、槽位与配额。两边不重复对方的规则。
 * `{ item: ... }` 不是数组，schema 与校验器都拒绝它，调用方不要在校验前拆开这层包装。
 * @module @deepseek-ai/dsh-patent-core/draft/schema
 */

/** 字符串数组属性。描述避免把数组元素说成名为 item 的字段。 */
const STRING_LIST = {
  type: 'array',
  required: true,
  description: 'JSON array of strings. Submit the array itself.',
  items: { type: 'string' },
} as const

/** 段落块。`kind` 的 const 使它与列表、表格互斥。 */
const PARAGRAPH_BLOCK = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', const: 'paragraph', required: true },
    text: { type: 'string', required: true },
  },
} as const

/** 列表块。`ordered` 可选。 */
const LIST_BLOCK = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', const: 'list', required: true },
    items: STRING_LIST,
    ordered: { type: 'boolean' },
  },
} as const

/** 表格块。是否允许出现在某一说明书部分由校验器决定。 */
const TABLE_BLOCK = {
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', const: 'table', required: true },
    name: { type: 'string', required: true },
    header: STRING_LIST,
    rows: {
      type: 'array',
      required: true,
      description: 'JSON array of rows. Each row is a JSON array of strings.',
      items: { type: 'array', items: { type: 'string' } },
    },
  },
} as const

/** 正文块：段落、列表、表格三支，恰好匹配一支。 */
const DRAFT_BLOCK = {
  oneOf: [PARAGRAPH_BLOCK, LIST_BLOCK, TABLE_BLOCK],
} as const

/** 说明书一个部分：块的 JSON 数组。 */
const SPEC_SECTION_PART = {
  type: 'array',
  required: true,
  description: 'JSON array of paragraph, list, or table blocks. Submit the array itself.',
  items: DRAFT_BLOCK,
} as const

/**
 * claims-spec 申请文件草案的作者 schema。
 *
 * 顶层不带参数级 `required`。`oneOf` 分支按值节点编译，分支上的 `required: true` 会被拒绝；
 * 工具在 `parameters.draft` 上声明必填。空数组能否通过由校验器决定。
 */
export const SPEC_DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    meta: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        caseNumber: { type: 'string', required: true },
        title: { type: 'string', required: true },
        applicant: { type: 'string', required: true },
        inventor: { type: 'string', required: true },
        agent: { type: 'string', required: true },
        date: { type: 'string', required: true },
      },
    },
    claims: STRING_LIST,
    abstract: STRING_LIST,
    figureFiles: STRING_LIST,
    abstractFigure: {
      type: 'string',
      description: 'Optional decimal figure number. Omit it when figureFiles is empty.',
    },
    sections: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        technicalField: SPEC_SECTION_PART,
        background: SPEC_SECTION_PART,
        summary: SPEC_SECTION_PART,
        drawingDescriptions: SPEC_SECTION_PART,
        embodiment: SPEC_SECTION_PART,
      },
    },
  },
} as const

/** 模板草案的一个正文槽位。 */
const BLOCKS_SECTION = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    blocks: SPEC_SECTION_PART,
  },
} as const

/** 模板草案的一个数据行槽位。 */
const ROWS_SECTION = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    rows: {
      type: 'array',
      required: true,
      description: 'JSON array of rows. Each row is a JSON array of strings.',
      items: { type: 'array', items: { type: 'string' } },
    },
  },
} as const

/** 无效理由节的一项。 */
const GROUND_ENTRY = {
  type: 'object',
  additionalProperties: false,
  properties: {
    article: { type: 'string', required: true },
    ground: { type: 'string', required: true },
    claimNos: {
      type: 'array',
      required: true,
      description: 'JSON array of claim numbers. Submit the array itself.',
      items: { type: 'integer' },
    },
    facts: { type: 'string', required: true },
    evidence: { type: 'string', required: true },
    conclusion: { type: 'string', required: true },
  },
} as const

/** 模板草案的一个无效理由槽位。 */
const GROUNDS_SECTION = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    grounds: {
      type: 'array',
      required: true,
      description: 'JSON array of reason entries. Submit the array itself.',
      items: GROUND_ENTRY,
    },
  },
} as const

/**
 * 文书模板与表单模板草案的作者 schema。
 *
 * `sections` 是数组，因此与 {@link SPEC_DRAFT_SCHEMA}（`sections` 为对象）互斥。
 * `fields` 的值是字符串或多选字符串数组，作者 schema 只能把该对象标成开放的。
 * 槽位 id、必填和配额仍由 `validateTemplateDraft` 决定。
 */
export const TEMPLATE_DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fields: {
      type: 'object',
      additionalProperties: true,
      description: 'Slot id to a string or a JSON array of strings.',
    },
    sections: {
      type: 'array',
      required: true,
      description: 'JSON array of section entries. Submit the array itself. An empty array is allowed here.',
      items: { oneOf: [BLOCKS_SECTION, ROWS_SECTION, GROUNDS_SECTION] },
    },
  },
} as const
