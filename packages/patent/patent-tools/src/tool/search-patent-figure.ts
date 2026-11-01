/**
 * `search_patent_figure` tool: keyword search over the analyzed figure index
 * (produced by analyze_patent_figure). Ported from Sati's searchPatentFigure.ts.
 *
 * The Sati vector/hybrid retrieval path (EmbeddingClient) is not ported — dsh
 * ships keyword-only retrieval. The index file (\`.sati/figures-index.json\`) is
 * loaded through the injected \`loadIndex\` dep (the integrator wires
 * figureIndexStore.load); the tool itself is free of filesystem I/O.
 * @module @deepseek-ai/dsh-patent-tools/tool/search-patent-figure
 */

import { basename } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { PatentToolError } from '../error.ts'
import { FIGURE_TYPE_NAMES } from './analyze-patent-figure.ts'
import type { FigureComponent, FigureType } from './analyze-patent-figure.ts'
import type { FigureIndexEntry, LoadFigureIndexResult } from '../figure/index-store.ts'

/** Input for the search_patent_figure tool. */
export type SearchPatentFigureInput = {
  /** 检索关键词（技术特征/部件名/附图标记；空串 = 按附图编号列出已分析附图，条数受 limit 约束）。 */
  query: string
  /** 返回条数上限（默认 5，最大 10）。 */
  limit?: number
}

/** One analyzed-figure search result. */
type SearchPatentFigureResultItem = {
  figureNumber: number
  figureType: FigureType
  /** 附图图片路径（工作区相对路径）。 */
  imagePath: string
  /** 相关度 0-1（空查询 = 列表模式，usable ? 1 : 0.5）。 */
  score: number
  usable: boolean
  overallDescription: string
  figureDescription: string
  components: FigureComponent[]
  warnings: string[]
}

/** Output of the search_patent_figure tool. */
export type SearchPatentFigureOutput = {
  query: string
  /** 返回条数。 */
  total: number
  /** 索引内附图总数。 */
  indexedCount: number
  /** 检索方式（当前仅 keyword；向量/混合检索未接入）。 */
  method: 'keyword'
  /** 非致命说明，无则省略。 */
  note?: string
  /** 引导提示（空索引/无匹配），无则省略。 */
  hint?: string
  results: SearchPatentFigureResultItem[]
}

/** Injected figure-index loader (tests override; production wires ctx.storage). */
export type SearchPatentFigureDeps = {
  /** Load the analyzed figure index (empty entries when absent). */
  loadIndex: () => Promise<LoadFigureIndexResult>
}

const ASCII_TOKEN_RE = /[a-zA-Z0-9_]+/g
const CJK_CHAR_RE = /[\u3400-\u9fff]/g

/**
 * 分词：ASCII 词元（小写）+ CJK 单字 + 相邻二元组。
 * @param text - 待分词的文本。
 * @returns 词元列表。
 */
export function tokenizeFigureText(text: string): string[] {
  const tokens: string[] = []
  for (const match of text.toLowerCase().matchAll(ASCII_TOKEN_RE)) tokens.push(match[0])
  const chars = text.match(CJK_CHAR_RE) ?? []
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]
    /* v8 ignore next -- match() returns a dense array; chars[i] is always defined. */
    if (ch === undefined) continue
    tokens.push(ch)
    if (i + 1 < chars.length) {
      const next = chars[i + 1]
      /* v8 ignore next -- guarded by i + 1 < chars.length, so next is always defined. */
      if (next !== undefined) tokens.push(ch + next)
    }
  }
  return tokens
}

/**
 * 将附图索引条目拼成可检索的图档文本（编号/类型/描述/组件/连接/附图说明/文件名）。
 * @param entry - 附图索引条目。
 * @returns 可检索的图档文本。
 */
function buildFigureDocumentText(entry: FigureIndexEntry): string {
  const analysis = entry.analysis
  const parts = [
    `图${analysis.figureNumber}`,
    FIGURE_TYPE_NAMES[analysis.figureType],
    analysis.overallDescription,
    ...analysis.components.map(component => `${component.refNumber} ${component.name} ${component.description}`),
    ...analysis.connections.map(connection => `${connection.source} ${connection.target} ${connection.description}`),
    analysis.figureDescription,
  ]
  parts.push(basename(entry.imagePath))
  return parts.join('\n')
}

/** 文档频率（含自身）反推 idf。 */
function computeIdf(docTokens: string[][]): Map<string, number> {
  const df = new Map<string, number>()
  for (const tokens of docTokens) {
    for (const token of new Set(tokens)) {
      df.set(token, (df.get(token) ?? 0) + 1)
    }
  }
  const total = docTokens.length
  const idf = new Map<string, number>()
  for (const [token, count] of df) {
    idf.set(token, Math.log(1 + total / (1 + count)))
  }
  return idf
}

/** 词项向量：idf × (1 + ln(1+tf))。 */
function termVector(tokens: string[], idf: Map<string, number>): Map<string, number> {
  const tf = new Map<string, number>()
  for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1)
  const vector = new Map<string, number>()
  for (const [token, count] of tf) {
    const weight = idf.get(token)
    if (weight === undefined) continue
    vector.set(token, weight * (1 + Math.log(1 + count)))
  }
  return vector
}

function sparseCosine(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0
  let normA = 0
  let normB = 0
  for (const [token, value] of a) {
    dot += value * (b.get(token) ?? 0)
    normA += value * value
  }
  for (const value of b.values()) normB += value * value
  if (normA === 0 || normB === 0) return 0
  return Math.max(0, dot / (Math.sqrt(normA) * Math.sqrt(normB)))
}

/** 空查询/全符号查询：按附图编号列出（usable 得分 1，否则 0.5）。 */
function listHits(entries: FigureIndexEntry[], limit: number): Array<{ entry: FigureIndexEntry; score: number }> {
  return entries
    .map(entry => ({ entry, score: entry.analysis.usable ? 1 : 0.5 }))
    .sort(
      (a, b) =>
        a.entry.analysis.figureNumber - b.entry.analysis.figureNumber ||
        a.entry.imagePath.localeCompare(b.entry.imagePath),
    )
    .slice(0, limit)
}

/**
 * 关键词检索附图索引条目（idf 加权余弦，0-1）。空查询走列表模式；零分条目过滤。
 * @param entries - the analyzed figure entries.
 * @param query - the search keywords (empty = list mode).
 * @param limit - max hits (>= 1).
 * @returns ranked hits in descending score order.
 */
export function retrieveFiguresKeyword(
  entries: FigureIndexEntry[],
  query: string,
  limit: number,
): Array<{ entry: FigureIndexEntry; score: number }> {
  if (entries.length === 0) return []
  const trimmed = query.trim()
  const documents = entries.map(buildFigureDocumentText)
  const queryTokens = tokenizeFigureText(trimmed)
  if (queryTokens.length === 0) return listHits(entries, limit)
  const docTokens = documents.map(tokenizeFigureText)
  const idf = computeIdf(docTokens)
  const queryVector = termVector(queryTokens, idf)
  const scores = docTokens.map(tokens => sparseCosine(queryVector, termVector(tokens, idf)))
  /* v8 ignore next -- scores is 1:1 with entries (both derive from documents), so the nullish fallback never fires. */
  const scored = entries.map((entry, index) => ({ entry, score: scores[index] ?? 0 }))
  return scored
    .filter(hit => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.analysis.figureNumber - b.entry.analysis.figureNumber)
    .slice(0, limit)
}

/**
 * Render the canonical search value into model-facing Markdown.
 * @param value - the figure search output to render.
 * @returns the rendered Markdown.
 */
export function renderSearchFigure(value: SearchPatentFigureOutput): string {
  if (value.results.length === 0) {
    return `search_patent_figure: 0 张附图命中。${value.hint ? `\n\n提示：${value.hint}` : ''}`
  }
  const rows = value.results.map((r) => {
    const lines = [
      `## 图${r.figureNumber}（${FIGURE_TYPE_NAMES[r.figureType]} · score ${r.score.toFixed(2)}${r.usable ? '' : ' · 需人工确认'}）`,
      `**image**: ${r.imagePath}`,
      r.overallDescription,
      '',
      r.figureDescription,
    ]
    if (r.components.length > 0) {
      lines.push('', '组件：' + r.components.map(c => `${c.refNumber} ${c.name}`).join('、'))
    }
    if (r.warnings.length > 0) {
      lines.push('', '**警告**', ...r.warnings.map(w => `- ${w}`))
    }
    return lines.join('\n')
  })
  return [`**search_patent_figure** — ${value.results.length} result(s):`, '', rows.join('\n\n---\n\n')].join('\n')
}

const RESULT_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    figureNumber: { type: 'integer', required: true },
    figureType: { type: 'string', required: true },
    imagePath: { type: 'string', required: true },
    score: { type: 'number', required: true },
    usable: { type: 'boolean', required: true },
    overallDescription: { type: 'string', required: true },
    figureDescription: { type: 'string', required: true },
    components: { type: 'array', required: true },
    warnings: { type: 'array', required: true },
  },
} as const

/**
 * Result cap applied when a call omits its own `limit`.
 */
const DEFAULT_RESULT_LIMIT = 5

/**
 * Upper bound on `limit`: one call returns at most this many figures in
 * argument-free listing mode, whatever the caller asks for.
 */
const MAX_RESULT_LIMIT = 10

/**
 * Build the `search_patent_figure` tool over an injected index loader.
 * @param deps - the figure-index loader.
 * @returns a registry-ready tool definition.
 */
export function createSearchPatentFigureTool(deps: SearchPatentFigureDeps): ToolDefinition {
  return defineTool({
    name: 'search_patent_figure',
    description: '检索已分析的专利附图：按技术特征、部件名称或附图标记关键词返回最相关附图及其分析结果——附图编号、类型、组件与标号、附图说明。撰写说明书/具体实施方式时用于确认技术特征对应的附图与标记。索引由 analyze_patent_figure 写入（见 Config.figureIndexFile）。当前仅关键词检索（向量/语义检索未接入）。',
    parameters: {
      query: { type: 'string', required: true, description: '检索关键词（技术特征/部件名/附图标记；空串 = 按附图编号列出已分析附图，条数受 limit 约束）' },
      limit: { type: 'number', description: `返回条数上限（默认 ${String(DEFAULT_RESULT_LIMIT)}，最大 ${String(MAX_RESULT_LIMIT)}）` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          total: { type: 'integer', required: true },
          indexedCount: { type: 'integer', required: true },
          method: { type: 'string', required: true, enum: ['keyword'] },
          note: { type: 'string' },
          hint: { type: 'string' },
          results: { type: 'array', required: true, items: RESULT_ITEM_SCHEMA },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderSearchFigure(value as unknown as SearchPatentFigureOutput) }],
    },
    async execute(args) {
      let loaded: LoadFigureIndexResult
      try {
        loaded = await deps.loadIndex()
      } catch (error) {
        // 配置类失败（未接线的 fail-loud 桩）保留 setup_required 码，供按码路由的调用方判别。
        if (error instanceof PatentToolError && error.code === 'setup_required') throw error
        throw new PatentToolError(
          'tool_execution_failed',
          `读取附图索引失败：${error instanceof Error ? error.message : String(error)}`,
          { tool: 'search_patent_figure' },
        )
      }
      const limit = Math.min(Math.max(args.limit ?? DEFAULT_RESULT_LIMIT, 1), MAX_RESULT_LIMIT)
      const query = args.query
      const hits = retrieveFiguresKeyword(loaded.entries, query, limit)
      const results: SearchPatentFigureResultItem[] = hits.map((hit) => {
        const analysis = hit.entry.analysis
        return {
          figureNumber: analysis.figureNumber,
          figureType: analysis.figureType,
          imagePath: analysis.imagePath,
          score: hit.score,
          usable: analysis.usable,
          overallDescription: analysis.overallDescription,
          figureDescription: analysis.figureDescription,
          components: analysis.components,
          warnings: analysis.warnings,
        }
      })

      let hint: string | undefined
      if (loaded.warning !== undefined) {
        hint = loaded.warning
      } else if (loaded.entries.length === 0) {
        hint = '附图索引为空：尚未分析任何附图，先调用 analyze_patent_figure 写入索引。'
      } else if (results.length === 0 && query.trim() !== '') {
        hint = '未检索到匹配附图，可尝试更换关键词，或先分析更多附图。'
      }

      const output: SearchPatentFigureOutput = {
        query,
        total: results.length,
        indexedCount: loaded.entries.length,
        method: 'keyword',
        ...(hint === undefined ? {} : { hint }),
        results,
      }
      return output
    },
  })
}
