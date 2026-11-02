/**
 * `build_patent_filing` 工具：把结构化内容按模板体例成文为 CNIPA 申请文件 .docx。
 * @module @deepseek-ai/dsh-patent-filing/tool/build-patent-filing
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { validateSpecDraft } from '@deepseek-ai/dsh-patent-core'
import type { FilingBuildResult } from '../types.ts'
import { buildFiling } from '../filing/engine.ts'
import type { BuildEngineOptions } from '../filing/engine.ts'
import { contentFromDraft } from '../filing/fromDraft.ts'
import { SECTION_TALLY_SCHEMA } from './schemas.ts'

const DESCRIPTION = [
  '把受控草案按本部署的申请文件模板体例成文为一件 CNIPA 专利申请文件（有附图时 5 节：说明书摘要 / 摘要附图 / 权利要求书 / 说明书 / 说明书附图；无附图发明省略摘要附图与说明书附图两节，为 3 节），并与成品一并给出体例实测与模板指纹。',
  '草案走 draft 参数（required），与 render_patent_document 的 claims-spec 同一份结构（著录项 meta、不带项号的 claims、多段 abstract、figureFiles、摘要附图号 abstractFigure、五部分 sections 块；附图说明部分的列表项即附图条目，条数须等于 figureFiles 项数）；权项项号、附图说明的「图N为……」与表题「表 N · 名称」由本工具按与 HTML 通道相同的算法生成。旧的 content 参数已删除：传 content 会被参数校验以「missing required property draft」拒绝。',
  '正文体例（字体、字号、行距、首行缩进、分节与页眉）由模板决定，调用方只提供内容，不要自己排格式。',
  '说明书是否写 `[NNNN]` 段落编号由 spec 的 numbering 声明决定：声明 paragraph 时按 spec 顺序写入，正文里已带编号的先剥后写、与段落顺序不一致会报错而不是静默覆盖；随包 spec 声明 none，说明书不写段落编号——没有法条要求它。',
  '附图按图序传入 draft.figureFiles，其中 draft.abstractFigure 指定的那张（缺省第 1 张）进「摘要附图」节，全部进「说明书附图」节且每图独占一页；`.svg` 源件先栅格化为位图再入文。无附图发明（指南第二部分第二章 2.3）传 figureFiles: []、drawingDescriptions: []，且不要给 abstractFigure。',
].join(' ')

/** 模板反解体例的 JSON schema。 */
const TEMPLATE_STYLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    sectionCount: { type: 'number', required: true },
    eastAsia: { type: 'string', required: true },
    ascii: { type: 'string', required: true },
    cs: { type: 'string', required: true },
    sizePt: { type: 'number', required: true },
    lineSpacing: { type: 'number', required: true },
    firstLineIndent: { type: 'number', required: true },
    sizesPt: { type: 'array', required: true, items: { type: 'number' } },
    lineSpacings: { type: 'array', required: true, items: { type: 'number' } },
  },
} as const

/** 输出 canonical 值的 JSON schema。 */
const RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    docxPath: { type: 'string', required: true },
    figures: { type: 'array', required: true, items: { type: 'string' } },
    sections: { type: 'array', required: true, items: SECTION_TALLY_SCHEMA },
    numberingTotal: { type: 'number', required: true },
    upstreamNumberingSeen: { type: 'number', required: true },
    templateStyle: { ...TEMPLATE_STYLE_SCHEMA, required: true },
    templateFingerprint: { type: 'string', required: true },
  },
} as const

/** 受控草案参数的 schema；块级约束由 patent-core 的 validateSpecDraft 补足。 */
const DRAFT_PARAM = {
  type: 'object',
  additionalProperties: true,
  description: '受控草案（结构化 JSON，与 render_patent_document 的 claims-spec draft 同一份 SpecDraft 结构）：meta（caseNumber（案卷号，HTML 通道印在抬头编号行与页脚；docx 通道不印）、title/applicant/inventor/agent/date）、claims（不带项号，≥1 项）、abstract（≥1 段）、figureFiles（按图序；无附图发明可为空数组）、abstractFigure（摘要附图号，1..figureFiles 项数，缺省 1；无附图时不要给）、sections（技术领域/背景技术/发明内容/附图说明/具体实施方式五部分的 paragraph/list/table 块；无附图时 drawingDescriptions 为空数组；附图说明部分的列表项即附图条目，条数须等于 figureFiles 项数；表格仅允许出现在具体实施方式）',
} as const

/**
 * 把成文结果渲染为模型可读文本。
 * @param value - 成文结果。
 * @returns 多行路径 + 体例实测 + 分节承载量。
 */
export function renderBuildResult(value: FilingBuildResult): string {
  const style = value.templateStyle
  const lines = [
    `成品：${value.docxPath}`,
    `体例（模板反解）：${style.eastAsia} / ${style.ascii} ${style.sizePt}pt 行距 ${style.lineSpacing} 首行缩进 ${style.firstLineIndent}pt`,
    `分节：${value.sections.map(tally => `${tally.key} ${tally.paragraphs} 段/${tally.figures} 图`).join(' · ')}`,
    `段落编号：${value.numberingTotal} 条（源件已带编号 ${value.upstreamNumberingSeen} 条）`,
    `附图：${value.figures.length} 张`,
    `模板指纹：sha256 ${value.templateFingerprint.slice(0, 16)}…`,
  ]
  return lines.join('\n')
}

/** 工具工厂依赖：subprocess 服务与引擎覆盖。 */
/** 工具工厂依赖：与成文引擎的调用参数同形。 */
export type BuildPatentFilingToolOptions = BuildEngineOptions

/**
 * 构造 `build_patent_filing` 工具。
 * @param options - 工具依赖与引擎覆盖。
 * @returns 可注册的工具定义。
 */
export function createBuildPatentFilingTool(options: BuildPatentFilingToolOptions): ToolDefinition {
  return defineTool({
    name: 'build_patent_filing',
    description: DESCRIPTION,
    parameters: {
      draft: { ...DRAFT_PARAM, required: true, description: `申请文件受控草案。${DRAFT_PARAM.description}` },
      outputName: {
        type: 'string',
        required: true,
        description: '输出文件名主干（不含扩展名），如「②件_权利要求书与说明书」；不得含路径分隔符、`..` 或首尾空白',
      },
      caseId: {
        type: 'string',
        description: '可选案卷号；给出后成品落在 data/cases/<案卷号>/outputs/ 而不是缺省目录',
      },
      outputDir: {
        type: 'string',
        description: '可选显式输出目录（按工作目录解析；真实位置落在工作目录之外的路径会被拒绝）',
      },
    },
    output: {
      schema: RESULT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderBuildResult(value) }],
    },
    async execute(args, exec) {
      // 旧 content 参数已从 schema 删除：执行器的参数校验会以防缺 draft 拒绝，到不了这里。
      const content = contentFromDraft(validateSpecDraft(args.draft))
      return buildFiling(
        {
          content,
          outputName: args.outputName,
          ...(args.caseId !== undefined ? { caseId: args.caseId } : {}),
          ...(args.outputDir !== undefined ? { outputDir: args.outputDir } : {}),
        },
        options,
        process.cwd(),
        exec.signal,
      )
    },
  })
}
