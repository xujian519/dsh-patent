/**
 * 附图分析引擎接缝（FigureAnalysisEngine）。
 *
 * 引擎把「已入库的图片附件引用 + 上下文」解析为结构化附图分析结果；图片
 * 门控、附件入库与索引写入不经过引擎，由 analyze_patent_figure 工具层负责，
 * 因此分析模式切换不改变门控与结果契约。默认提供者是单步引擎（一次模型
 * 调用，包装 analyze_patent_figure 的既有单步逻辑，由工具层在未注入引擎时
 * 构造）；本模块提供 two-step 引擎：在同一视觉路由上做「结构抽取 → 附图
 * 说明生成」两次模型调用，第一步不可解析时降级为 best-effort 结果 + 警告
 * 而不抛错。
 * @module @deepseek-ai/dsh-patent-tools/figure/analysis-engine
 */

import { collectPortText, tryParseJson } from '@deepseek-ai/dsh-patent-core'
import type { PatentModelPort } from '@deepseek-ai/dsh-patent-core'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import {
  FIGURE_SPEC_GUIDE,
  FIGURE_SCHEMA_CORE,
  formatContext,
  normalizeFigureAnalysis,
} from '../tool/analyze-patent-figure.ts'
import type { FigureAnalysisResult } from '../tool/analyze-patent-figure.ts'

/** 附图分析请求（图片已由工具层入库；引擎不做门控与文件 IO）。 */
export type FigureAnalysisRequest = {
  /** 附图图片附件引用（durable ref，随两次模型请求共同发送）。 */
  image: ImageAttachmentRef
  /** 附图编号（图N）。 */
  figureNumber: number
  /** 附图图片路径（进入提示词）。 */
  imagePath: string
  /** 权利要求/技术方案上下文（图文对齐用）。 */
  claimContext?: string | undefined
  /** 发明名称（附图说明句式用）。 */
  inventionName?: string | undefined
  /** 模型标识（写入结果的 modelUsed）。 */
  modelUsed: string
}

/** 附图分析引擎：把图片附件引用 + 上下文解析为结构化结果。 */
export type FigureAnalysisEngine = {
  /** 引擎标识（single-step=一次模型调用；two-step=结构抽取+说明生成两次调用）。 */
  readonly kind: 'single-step' | 'two-step'
  /**
   * 分析一张附图。
   * @param request - 图片附件引用与上下文。
   * @param signal - 取消信号。
   * @param model - 本次调用的模型端口（工具按调用绑定会话后再传入，故引擎不持有端口）。
   * @returns 结构化附图分析结果；模型传输失败按原始错误抛出（工具层统一映射错误码）。
   */
  analyze(request: FigureAnalysisRequest, signal: AbortSignal, model: PatentModelPort): Promise<FigureAnalysisResult>
}

/** 两步分析第一步（结构抽取）输出 JSON Schema（组合 schema 去除 figure_description）。 */
const STRUCTURE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...FIGURE_SCHEMA_CORE,
    warnings: { type: 'array', items: { type: 'string' }, description: '无法识别或标号异常的区域' },
  },
  required: ['figure_type', 'overall_description', 'confidence', 'components', 'connections', 'warnings'],
} as const

/** 第一步（结构抽取）提示词：只要结构与标号，不要附图说明文字。 */
function buildStructureExtractionPrompt(request: FigureAnalysisRequest): string {
  return [
    `你是一位资深专利代理师与专利审查专家。请对这张专利说明书附图（图${request.figureNumber}）做结构抽取，图片已随本请求提供。`,
    '',
    `附图文件：${request.imagePath}`,
    `发明名称：${request.inventionName?.trim() || '（未提供）'}`,
    '',
    '只做结构抽取：识别附图类型、组件及其附图标记、组件间连接关系；不要生成附图说明文字。权利要求/技术方案上下文仅用于图文对齐与术语校正，不得用于补充图面不存在的信息；图面与上下文冲突时以图面为准并在 warnings 中注明。',
    '',
    '【专利附图规范要点】',
    FIGURE_SPEC_GUIDE,
    formatContext(request.claimContext),
    '',
    '【输出要求】',
    '- 组件标号与图面阿拉伯数字一致；无标号部件用 U1/U2… 编号并在 warnings 注明"未标注"；',
    '- 图面可见但标号模糊、被遮挡或无法确认的部件，不得臆造编号，在 warnings 注明"无法确认"。',
    '',
    '严格输出 JSON：只输出一个 JSON 对象；不要用 markdown 代码围栏；不要输出 JSON 以外的任何文字；所有键与字符串使用双引号。',
    JSON.stringify(STRUCTURE_SCHEMA, null, 2),
  ].join('\n')
}

/** 第二步（说明生成）提示词：基于第一步结构 + 图面撰写专利格式附图说明。 */
function buildDescriptionGenerationPrompt(request: FigureAnalysisRequest, structure: FigureAnalysisResult): string {
  return [
    `你是一位资深专利代理师。请基于已抽取的附图结构与图面，撰写图${request.figureNumber}的专利格式附图说明。图片已随本请求提供。`,
    '',
    `附图文件：${request.imagePath}`,
    `发明名称：${request.inventionName?.trim() || '（未提供）'}（未知时用「装置」代替）`,
    '',
    '【第一步结构抽取结果（JSON）】',
    JSON.stringify(
      {
        figure_type: structure.figureType,
        overall_description: structure.overallDescription,
        components: structure.components.map(c => ({ ref_number: c.refNumber, name: c.name, kind: c.kind, description: c.description })),
        connections: structure.connections.map(c => ({ source: c.source, target: c.target, kind: c.kind, description: c.description })),
      },
      null,
      2,
    ),
    '',
    '【专利附图规范要点】',
    FIGURE_SPEC_GUIDE,
    '',
    '【输出要求】',
    '- 只输出附图说明文字本身，句式：图N是本发明实施例提供的{发明名称}的{附图类型}；图中：1-…；2-…；',
    '- 标号列表必须与第一步结构抽取结果一致，不得增删或改号；',
    '- 不要输出 JSON、markdown 代码围栏或说明文字以外的任何内容。',
  ].join('\n')
}

/**
 * 构建 two-step 分析引擎：结构抽取 → 说明生成，两次调用走同一次调用传入的视觉路由。
 *
 * 引擎不持有模型端口：端口按调用由工具绑定会话后传入（工具内的调用落 `patent/model-call`
 * 事件，见 `loggedToolModel`），组合点构造的引擎因此不会绕开会话日志。
 * @returns FigureAnalysisEngine 实例。
 */
export function createTwoStepAnalysisEngine(): FigureAnalysisEngine {
  return {
    kind: 'two-step',
    async analyze(request, signal, model) {
      const normalizeOptions = {
        imagePath: request.imagePath,
        figureNumber: request.figureNumber,
        inventionName: request.inventionName,
        modelUsed: request.modelUsed,
      }
      const structureRaw = await collectPortText(
        model,
        buildStructureExtractionPrompt(request),
        signal,
        { images: [request.image] },
      )
      // 第一步不可解析：跳过第二步，按空组件 best-effort 降级 + 警告，不抛错。
      if (tryParseJson(structureRaw) === undefined) {
        const degraded = normalizeFigureAnalysis(structureRaw, normalizeOptions)
        degraded.warnings.push('附图结构未能识别：本次结果按无组件返回，未生成附图说明；请核对图片清晰度后重试')
        return degraded
      }
      const structure = normalizeFigureAnalysis(structureRaw, normalizeOptions)
      const descriptionRaw = await collectPortText(
        model,
        buildDescriptionGenerationPrompt(request, structure),
        signal,
        { images: [request.image] },
      )
      const description = descriptionRaw.trim()
      return description === '' ? structure : { ...structure, figureDescription: description }
    },
  }
}
