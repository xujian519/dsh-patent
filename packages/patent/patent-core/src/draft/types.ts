/**
 * src/draft — 受控草案模型（patent 域共享）。
 *
 * 模型不再产出 HTML（标题、表格标记、innerHTML），而是提交结构化草案（本模块的类型）；
 * 标题与表格由转换器按结构生成（by construction），渲染层不再接受模型可控标签。
 * claims-spec 申请文件使用 {@link SpecDraft}，其余模板使用 {@link TemplateDraft}；
 * 两通道（claims-spec HTML/PDF 与 build_patent_filing docx）共用同一份草案。
 */

/** 草案正文块：段落、列表、命名表格三选一。 */
export type DraftBlock =
  | {
    kind: 'paragraph'
    /** 段落文本；非空。 */
    text: string
  }
  | {
    kind: 'list'
    /** 列表项；每项非空，≥1 项。 */
    items: string[]
    /** 有序列表标记；缺省为无序列表。 */
    ordered?: boolean
  }
  | {
    kind: 'table'
    /** 表格名称（不含「表 N」前缀，前缀由渲染器自动编号生成）；不得以「表+数字」开头。 */
    name: string
    /** 表头列；≥1 列，每列非空。 */
    header: string[]
    /** 数据行；≥1 行，行宽与表头一致，单元格非空。 */
    rows: string[][]
  }

/**
 * 无效理由节的一项（按法条组织的理由段）。
 *
 * 节标题由渲染器按 `{节序}.{序} 权利要求 …不具备{理由}（{法条}）` 生成，模型只填三段正文与
 * 结构化事实，不写标题、不写节号——写死理由的小节标题（"4.1 权 1 不具备新颖性"）会让只主张
 * 其他理由的文书被迫编造一段不存在的主张。
 */
export interface DraftGroundItem {
  /** 所依据的法条，如 `专利法第22条第3款`；进节标题的括注。 */
  article: string
  /** 理由名（与理由表标签口径一致），如 `创造性`。 */
  ground: string
  /** 本项针对的权利要求序号；≥1 项，渲染为「权利要求 1、2」。 */
  claimNos: number[]
  /** 事实认定。 */
  facts: string
  /** 证据分析（含 pin-cite）。 */
  evidence: string
  /** 法条适用与结论。 */
  conclusion: string
}

/** claims-spec 五部分章节 id 到中文标题的固定映射（转换器按此生成 h3）。 */export const SPEC_PART_HEADINGS = {
  technicalField: '技术领域',
  background: '背景技术',
  summary: '发明内容',
  drawingDescriptions: '附图说明',
  embodiment: '具体实施方式',
} as const

/** claims-spec 五部分章节 id。 */
export type SpecPartId = keyof typeof SPEC_PART_HEADINGS

/** 五部分章节的固定文档顺序（与 SPEC_PART_HEADINGS 键序一致）。 */
export const SPEC_PART_ORDER: readonly SpecPartId[] = [
  'technicalField',
  'background',
  'summary',
  'drawingDescriptions',
  'embodiment',
]

/** claims-spec 著录项：六项必填非空。 */
export interface SpecDraftMeta {
  /** 案卷号；抬头编号行与页脚共用。 */
  caseNumber: string
  /** 发明名称。 */
  title: string
  /** 申请人。 */
  applicant: string
  /** 发明人。 */
  inventor: string
  /** 代理人 / 代理机构。 */
  agent: string
  /** 撰写日期。 */
  date: string
}

/** claims-spec 申请文件受控草案。 */
export interface SpecDraft {
  /** 著录项（请求书头部与落款共用）。 */
  meta: SpecDraftMeta
  /** 权利要求项；≥1 项，每项非空，不含项号（项号由渲染器自动编号）。 */
  claims: string[]
  /** 摘要段落；≥1 段，每段非空。 */
  abstract: string[]
  /** 附图文件路径，按图序；每项非空。无附图发明（指南第二部分第二章 2.3）可以为空数组。 */
  figureFiles: string[]
  /**
   * 摘要附图号：1..figureFiles 项数的整数；缺省为第 1 幅。
   * 两条通道都按它标注摘要附图（HTML 通道印「摘要附图：图 N」，docx 通道把它放进「摘要附图」节）。
   */
  abstractFigure?: string
  /**
   * 说明书五部分；每部分 ≥1 个非空块，表格块仅允许出现在 embodiment。
   * 附图说明部分的列表项即附图条目（每项渲染成一条「图N为……」），列表项只写图名与描述文字，
   * 不含图号与句末标点；其条数必须等于 figureFiles 项数。
   */
  sections: Record<SpecPartId, DraftBlock[]>
}

/** 选项槽位的一个可选项；id 对应模板 `data-slot="<组>:<id>"` 的选项后缀。 */
export interface TemplateChoiceOption {
  /** 选项 id（草案中引用）。 */
  id: string
  /** 选项的人类可读标签（错误消息列出可选项时展示）。 */
  label: string
}

/** 文本/选项槽位的 schema 声明。 */
export interface TemplateFieldSlot {
  /** 是否必填。 */
  required?: boolean
  /**
   * 槽位类别：`text`（默认）填充 `.fill` 文本；`choice` 渲染 `.cb` 勾选状态，
   * 草案值是选中项的选项 id（多选为 id 数组）。
   */
  kind?: 'text' | 'choice'
  /** `choice` 槽位的可选项集合。 */
  options?: readonly TemplateChoiceOption[]
  /** `choice` 槽位是否允许多选（草案值为数组）；缺省单选。 */
  multiple?: boolean
}

/** 章节槽位的 schema 声明：正文块序列（默认类别）、表格数据行，或按法条组织的理由节。 */
export type TemplateSectionSlot = TemplateBlocksSlot | TemplateRowsSlot | TemplateGroundsSlot

/** 正文块序列槽位（默认类别）：草案值经 {@link DraftBlock} 序列渲染。 */
export interface TemplateBlocksSlot {
  /** 是否必填。 */
  required?: boolean
  /** 槽位类别：`blocks`（默认）。 */
  kind?: 'blocks'
  /**
   * 可见字符上限；缺省不限。
   *
   * 计数口径：段落 `text` 与列表 `items` 去掉全部空白后按码点计数的合计
   * （表格块不在正文槽位，不计入）。超限在校验阶段失败，而不是渲染成成品。
   */
  maxChars?: number
  /** 列表项上限：槽位内各 list 块的 `items` 项数之和；缺省不限。 */
  maxItems?: number
}

/** 表格数据行槽位：草案值为等宽字符串数组，列宽由模板的行模板决定。 */
export interface TemplateRowsSlot {
  /** 是否必填。 */
  required?: boolean
  /** 槽位类别。 */
  kind: 'rows'
  /** 每行宽度必须等于 columns。 */
  columns: number
  /** 数据行上限（不含表头行）；缺省不限。超限在校验阶段失败。 */
  maxRows?: number
}

/** 按法条组织的理由节槽位：草案值为 {@link DraftGroundItem} 序列，节标题与四段式小标题由渲染器生成。 */
export interface TemplateGroundsSlot {
  /** 是否必填。 */
  required?: boolean
  /** 槽位类别。 */
  kind: 'grounds'
  /**
   * 节序前缀，与模板骨架的中文节序对应（如 `4` 对应「四、无效理由」）。
   * 必填：没有前缀的理由节会与骨架的节序脱节，渲染成 `.1`、`.2` 却无人报错。
   */
  groundsPrefix: string
  /**
   * 被主张的权项与理由名之间的关系词，缺省 `不具备`：请求人侧写「权利要求 1 不具备创造性」，
   * 被请求人侧按主题命名小节、写「的」（「权利要求 1 的创造性」）。理由名与法条取自草案，
   * 关系词由模板体例决定。
   */
  groundsRelation?: string
}

/** 模板草案的一个章节槽位：骨架元素 id + 块序列、数据行或无效理由节（三者恰居其一）。 */
export type TemplateDraftSection =
  | { /** 模板骨架中的槽位 id。 */ id: string; /** 槽位内容块；≥1 个非空块；表格块仅 claims-spec 支持。 */ blocks: DraftBlock[]; rows?: never; grounds?: never }
  | { /** 模板骨架中的槽位 id。 */ id: string; /** 数据行（rows 槽位）；≥1 行，各行等宽且单元格非空。 */ rows: string[][]; blocks?: never; grounds?: never }
  | { /** 模板骨架中的槽位 id。 */ id: string; /** 无效理由节（grounds 槽位）；≥1 项，各项三段正文非空。 */ grounds: DraftGroundItem[]; blocks?: never; rows?: never }

/** 其余文书模板受控草案。 */
export interface TemplateDraft {
  /** 文本/选项槽位值；键为槽位 id，text 值为非空字符串，choice 值为选中项 id（多选为数组）。 */
  fields?: Record<string, string | string[]>
  /** 章节槽位；槽位 id 不得重复。 */
  sections: TemplateDraftSection[]
}

/** 模板草案的槽位 schema（由 patent-document 的注册表提供）。 */
export interface TemplateDraftSchema {
  /** 文本/选项槽位；值声明类别与必填。 */
  fields?: Readonly<Record<string, TemplateFieldSlot>>
  /** 章节槽位；值声明类别与必填。 */
  sections?: Readonly<Record<string, TemplateSectionSlot>>
}
