/**
 * 本包的接缝词汇：内容模型、报告类型、错误类与随包资产名。
 * @module @deepseek-ai/dsh-patent-filing/types
 */

import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/**
 * 本包用到的 subprocess 能力：起一个受管子进程并取回它的退出事实。
 *
 * 只收窄到这一个操作，而不是整份 subprocess 服务——本包不解析可执行文件、不开终端、
 * 不管进程生命周期，测试因此不需要重建整个服务。
 */
export type SubprocessSpawner = Pick<SubprocessRuntime, 'spawn'>

/** 说明书主体节点类别：`h3`/`h4` 是法定部分标题，`p` 是正文段，`table` 是表格。 */
export type SpecificationKind = 'h3' | 'h4' | 'p' | 'table'

/**
 * 说明书主体的一个节点，与模型传入的 JSON 同形。
 *
 * `h3`/`h4`/`p` 用 `text`，`table` 用 `rows`；两者都可选，是因为模型工具的 JSON 参数没有
 * 判别式联合。哪个字段必填由 `validateContent` 按 `kind` 建立，调用方依赖该校验。
 */
export interface SpecificationNode {
  /** 节点类别。 */
  kind: SpecificationKind
  /** `h3`/`h4`/`p` 的文本。 */
  text?: string
  /** `table` 的行列；首行为表头，各行等宽。 */
  rows?: string[][]
}

/**
 * 结构化内容模型：成文工具的唯一正式输入。
 *
 * 这是发布前必须通过的校验面——内容来自模型，属于模型/JSON 边界。
 */
export interface FilingContent {
  /** 说明书摘要正文段。 */
  abstract: string[]
  /** 权利要求项，按项序排列，每项含项号与正文。 */
  claims: string[]
  /** 说明书主体，按文档顺序。 */
  specification: SpecificationNode[]
  /**
   * 附图路径，按图序排列。
   * `.svg` 源件先栅格化为 PNG 再入文；`.png`/`.jpg`/`.jpeg` 直接入文。
   */
  figures: string[]
  /** 「摘要附图」节所用图号：`figures` 的 0 起下标；缺省 0，即第 1 张。 */
  abstractFigureIndex?: number
}

/** 一节实际承载的内容量，用于核对内容落进了正确的节。 */
export interface SectionTally {
  /** spec 里的节键。 */
  key: string
  /** 该节的正文段数（表格计一段）。 */
  paragraphs: number
  /** 该节的图片数。 */
  figures: number
}

/** 模板反解出的体例。 */
export interface TemplateStyle {
  /** 模板分节数。 */
  sectionCount: number
  /** 中文字体名。 */
  eastAsia: string
  /** 西文字体名。 */
  ascii: string
  /** 复杂文种字体名。 */
  cs: string
  /** 正文字号（磅）。 */
  sizePt: number
  /** 行距倍数。 */
  lineSpacing: number
  /** 首行缩进（磅）。 */
  firstLineIndent: number
  /** 模板中观测到的全部字号，供不一致时列证。 */
  sizesPt: number[]
  /** 模板中观测到的全部行距，供不一致时列证。 */
  lineSpacings: number[]
}

/** 成文结果。 */
export interface FilingBuildResult {
  /** 写出的 .docx 绝对路径。 */
  docxPath: string
  /** 实际入文的位图路径，按图序。 */
  figures: string[]
  /** 各节承载的内容量。 */
  sections: SectionTally[]
  /** 写入的 `[NNNN]` 段落编号总数。 */
  numberingTotal: number
  /** 从源件读到并核对过的上游编号数（源件不带编号时为 0）。 */
  upstreamNumberingSeen: number
  /** 模板反解出的体例。 */
  templateStyle: TemplateStyle
  /** 本次所用模板的 sha256；与随包模板不一致即说明部署换了模板。 */
  templateFingerprint: string
  /**
   * 成品写出后立刻跑的验收结论。
   *
   * `passed === false` 表示成品已在盘上但未通过断言：成文本身成功，交付前须修正。
   */
  verification: FilingVerifyResult
}

/** 成品验收结果。 */
export interface FilingVerifyResult {
  /** 全部断言是否通过。 */
  passed: boolean
  /** 断言失败明细；空数组即通过。 */
  errors: string[]
  /** 被验收的 .docx 绝对路径。 */
  docxPath: string
  /** 本次所用模板的 sha256。 */
  templateFingerprint: string
  /** 引擎实测摘要（分节、页眉、段落数、权项数、编号区间、表格数、图片数、各节归属）。 */
  info: FilingVerifyInfo
}

/** 引擎实测摘要。 */
export interface FilingVerifyInfo {
  /** 分节数。 */
  sections: number
  /** 各节页眉文本。 */
  headers: string[]
  /** 非空正文段数。 */
  paragraphs: number
  /** 识别到的权利要求项数。 */
  claims: number
  /** 段落编号区间（如 `1..100`），无编号时为 `无`。 */
  numbering: string
  /** 表格数。 */
  tables: number
  /** 内联图片数。 */
  figures: number
  /** 各节实测归属，顺序与 spec 的节序一致。 */
  layout: SectionTally[]
  /** 模板体例实测；引擎未读到模板体例时缺省。 */
  template?: { sections: number; sizes_pt: number[]; line_spacings: number[] }
}

/** 本包的领域错误：输入不合法、资产缺失、解释器缺失或引擎输出不可解析。 */
export class PatentFilingError extends Error {
  override readonly name = 'PatentFilingError'
}
