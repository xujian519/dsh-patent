/**
 * 附图分析索引（持久化）。
 *
 * 附图分析结果（FigureAnalysisResult）以 JSON 文件形式落盘（默认
 * `.sati/figures-index.json`，工作区根目录下），供 search_patent_figure
 * 检索。写入走原子写 + 进程内串行化（见 internal/index-store）。类型与
 * FigureAnalysisResult 同源于 analyze-patent-figure；本模块不依赖工具层。
 * @module @deepseek-ai/dsh-patent-tools/figure/index-store
 */

import { createIndexStore } from '../internal/index-store.ts'
import type { FigureAnalysisResult } from '../tool/analyze-patent-figure.ts'

/** 索引文件版本（结构不兼容时升版，旧文件按空索引处理）。 */
export const FIGURE_INDEX_VERSION = 1 as const

/** 索引文件默认位置（工作区根相对路径，与 Sati 一致）。 */
export const DEFAULT_FIGURE_INDEX_RELATIVE_PATH = '.sati/figures-index.json'

/** 索引条目：一张已分析附图。 */
export type FigureIndexEntry = {
  /** 附图图片路径（工作区相对路径，与 FigureAnalysisResult.imagePath 一致）。 */
  imagePath: string
  /** 分析时间（ISO 8601）。 */
  analyzedAt: string
  /** 附图分析结果。 */
  analysis: FigureAnalysisResult
}

/** 索引加载结果：条目列表 + 非致命异常提示。 */
export type LoadFigureIndexResult = {
  entries: FigureIndexEntry[]
  /** 非致命异常提示（文件损坏/版本不兼容/无效条目被忽略），无则省略。 */
  warning?: string
}

function isFigureIndexEntry(value: unknown): value is FigureIndexEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Partial<FigureIndexEntry>
  // 校验对象来自磁盘 JSON：analysis 显式含 null，使运行时空值检查保持有效（TS 对纯对象类型会窄化掉 null）。
  const analysis = entry.analysis as Partial<FigureAnalysisResult> | null | undefined
  return (
    typeof entry.imagePath === 'string' &&
    typeof entry.analyzedAt === 'string' &&
    typeof analysis === 'object' &&
    analysis !== null &&
    typeof analysis.figureNumber === 'number' &&
    typeof analysis.figureType === 'string' &&
    // 数组字段必须为数组：否则下游检索（components.map 等）会以裸 TypeError 崩溃
    Array.isArray(analysis.components) &&
    Array.isArray(analysis.connections) &&
    Array.isArray(analysis.warnings) &&
    // figureFamily 可缺省（旧条目）；存在时必须为字符串，否则跨图续号按名称匹配会拿到非字符串键
    (analysis.figureFamily === undefined || typeof analysis.figureFamily === 'string') &&
    // drawingStatus 取自磁盘 JSON：静态类型只声明两个字面量，运行时要挡住其它字符串
    (analysis.drawingStatus === undefined || ['proposal', 'drawn'].includes(analysis.drawingStatus))
  )
}

/** 附图索引存储实例（集成器接线 analyze 写入 + search 读取）。 */
export const figureIndexStore = createIndexStore<FigureIndexEntry>({
  version: FIGURE_INDEX_VERSION,
  validateEntry: isFigureIndexEntry,
  entryKey: entry => entry.imagePath,
  compare: (a, b) => a.analysis.figureNumber - b.analysis.figureNumber || a.imagePath.localeCompare(b.imagePath),
  kindLabel: '附图',
})
