/**
 * `patent_kg_query` tool: patent knowledge-graph query (keyword / node id /
 * node-type browse) over knowledge.db kg_nodes/kg_edges. Ported from Sati's
 * patentKgQuery.ts.
 * @module @deepseek-ai/dsh-patent-tools/tool/patent-kg-query
 */

import { existsSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { resolveNodeTypes } from '@deepseek-ai/dsh-patent-knowledge'
import type { KgNode, RelevantHit } from '@deepseek-ai/dsh-patent-knowledge'
import { PatentToolError } from '../error.ts'
import { knowledgeInstallGuidance, truncateSnippet } from './internal/knowledge.ts'
import { resolveResultLimit } from './internal/query-limit.ts'

/** Citation-class relations used for id-mode neighbor expansion. */
const CITE_RELATIONS = ['CITES', 'CITES_LAW', 'FREQUENTLY_CITES', 'REFERENCES'] as const

/** Hit-path ordering (keyword → similar → cites). */
const VIA_ORDER: Record<RelevantHit['via'], number> = { keyword: 0, similar: 1, cites: 2 }

/** Input for the patent_kg_query tool. */
export type PatentKgQueryInput = {
  /** Keyword search (FTS5; short words degrade to LIKE); mutually exclusive with id. */
  query?: string
  /** Node id (e.g. "CASE_005"): node detail + similar/cite neighbors; id takes precedence. */
  id?: string
  /** Browse by node type (Case / SupremeCourtJudgment / ... ; Judgment/LawArticle aliases). */
  node_type?: string
  /** Relation expansion after a keyword hit (default true). */
  expand?: boolean
  /** Attach node content fragments (default false, truncated ~600 chars). */
  include_content?: boolean
  /** Result cap (default 5, max 10). */
  limit?: number
}

/** One graph neighbor of a knowledge-graph node. */
export type PatentKgNeighbor = {
  id: string
  nodeType: string
  name?: string
  title?: string
  relation: string
}

/** One knowledge-graph hit. */
export type PatentKgHit = {
  id: string
  nodeType: string
  name?: string
  title?: string
  /** keyword (direct hit) / similar (similarity expansion) / cites (citation expansion). */
  via?: 'keyword' | 'similar' | 'cites'
  relation?: string
  /** Content fragment when include_content=true. */
  content?: string
  /** Similar/cite neighbors in id mode. */
  neighbors?: PatentKgNeighbor[]
}

/** Output of the patent_kg_query tool. */
export type PatentKgQueryOutput = {
  total: number
  hits: PatentKgHit[]
  dbPath?: string
}

/** Minimal knowledge-graph adapter surface (PatentKgAdapter satisfies it structurally). */
export type KgAdapter = {
  getNode(id: string): KgNode | undefined
  searchRelevant(query: string, options?: { keywordLimit?: number; expandLimit?: number; mode?: 'phrase' | 'or' }): RelevantHit[]
  getSimilarNodes(id: string, limit?: number): Array<{ node: KgNode; relation: string }>
  getNeighbors(id: string, relation?: string, limit?: number): Array<{ targetId: string; relation: string }>
  listByType(type: string, limit?: number): KgNode[]
}

/** Injected knowledge-graph adapter (tests override; production wires a PatentKgAdapter over knowledge.db). */
export type PatentKgQueryDeps = {
  adapter?: KgAdapter
  /** Resolved knowledge.db path, used for the setup-required check and surfaced as the output's `dbPath` field. */
  dbPath?: string
}

const INSTALL_GUIDANCE = knowledgeInstallGuidance('知识图谱')

function toHit(node: KgNode, via: RelevantHit['via'] | undefined, relation: string | undefined, includeContent: boolean): PatentKgHit {
  const content = includeContent && node.content !== undefined ? truncateSnippet(node.content, 600) : undefined
  return {
    id: node.id,
    nodeType: node.nodeType,
    ...(node.name !== undefined ? { name: node.name } : {}),
    ...(node.title !== undefined ? { title: node.title } : {}),
    ...(via !== undefined ? { via } : {}),
    ...(relation !== undefined ? { relation } : {}),
    ...(content !== undefined ? { content } : {}),
  }
}

/** Build one neighbor object from a node plus its relation. */
function toNeighbor(n: KgNode, relation: string): PatentKgNeighbor {
  return {
    id: n.id,
    nodeType: n.nodeType,
    ...(n.name !== undefined ? { name: n.name } : {}),
    ...(n.title !== undefined ? { title: n.title } : {}),
    relation,
  }
}

/** id mode: node detail + similar/cite neighbors. */
function queryById(adapter: KgAdapter, id: string, limit: number, includeContent: boolean): PatentKgQueryOutput {
  const node = adapter.getNode(id)
  if (!node) return { total: 0, hits: [] }
  const neighbors: PatentKgNeighbor[] = []
  const seen = new Set<string>([id])
  for (const { node: n, relation } of adapter.getSimilarNodes(id, limit)) {
    if (seen.has(n.id)) continue
    seen.add(n.id)
    neighbors.push(toNeighbor(n, relation))
  }
  for (const relation of CITE_RELATIONS) {
    for (const neighbor of adapter.getNeighbors(id, relation, limit)) {
      if (seen.has(neighbor.targetId)) continue
      const n = adapter.getNode(neighbor.targetId)
      if (!n) continue
      seen.add(n.id)
      neighbors.push(toNeighbor(n, neighbor.relation))
    }
  }
  return {
    total: 1,
    hits: [{ ...toHit(node, undefined, undefined, includeContent), neighbors: neighbors.slice(0, limit) }],
  }
}

/** keyword mode: FTS5 keyword search + optional relation expansion. */
function queryByKeyword(adapter: KgAdapter, query: string, limit: number, expand: boolean, includeContent: boolean): PatentKgQueryOutput {
  const hits = adapter.searchRelevant(query, { keywordLimit: limit, expandLimit: Math.min(limit * 3, 30), mode: 'or' })
  const top = (expand ? hits : hits.filter(hit => hit.via === 'keyword'))
    .sort((a, b) => VIA_ORDER[a.via] - VIA_ORDER[b.via])
    .slice(0, limit)
  return { total: top.length, hits: top.map(hit => toHit(hit.node, hit.via, hit.relation, includeContent)) }
}

/** type browse mode: list nodes by node_type (alias-expanded, deduped). */
function queryByType(adapter: KgAdapter, nodeType: string, limit: number, includeContent: boolean): PatentKgQueryOutput {
  const types = resolveNodeTypes(nodeType)
  const seen = new Set<string>()
  const nodes: KgNode[] = []
  for (const type of types) {
    for (const node of adapter.listByType(type, limit * 2)) {
      if (seen.has(node.id)) continue
      seen.add(node.id)
      nodes.push(node)
      if (nodes.length >= limit) break
    }
    if (nodes.length >= limit) break
  }
  return { total: nodes.length, hits: nodes.map(node => toHit(node, undefined, undefined, includeContent)) }
}

const DESCRIPTION = '查询专利知识图谱节点（判例/审查规则/法条/概念）。三种模式：① query 关键词检索（FTS5，附相似/引用关系标注）；② id 按节点 id 展开详情与相似/引用邻居；③ node_type 按类型浏览（Case/SupremeCourtJudgment/RegionalCourtJudgment/GuidelineRule/Clause/WikiCard/Concept，支持 Judgment/LawArticle 别名）。与 patent_wiki_search（wiki 卡片正文）和 law_search（法条原文）互补。'

/** Render the canonical kg-query value into model-facing prose. */
function renderKgQuery(value: PatentKgQueryOutput): string {
  if (value.hits.length === 0) {
    return 'patent_kg_query: 0 个节点命中。'
  }
  const rows = value.hits.map((h) => {
    const lines = [`## ${h.title ?? h.name ?? h.id}`]
    lines.push(`**id**: ${h.id} · ${h.nodeType}${h.via ? ` · via ${h.via}` : ''}${h.relation ? ` · ${h.relation}` : ''}`)
    if (h.content) lines.push(h.content)
    if (h.neighbors && h.neighbors.length > 0) {
      lines.push('', '邻居:', ...h.neighbors.map(n => `- ${n.id} (${n.nodeType}) — ${n.relation}`))
    }
    return lines.join('\n')
  })
  return [`**patent_kg_query** — ${value.hits.length} node(s):`, '', rows.join('\n\n---\n\n')].join('\n')
}

const NEIGHBOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    nodeType: { type: 'string', required: true },
    name: { type: 'string' },
    title: { type: 'string' },
    relation: { type: 'string', required: true },
  },
} as const

const HIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    nodeType: { type: 'string', required: true },
    name: { type: 'string' },
    title: { type: 'string' },
    via: { type: 'string', enum: ['keyword', 'similar', 'cites'] },
    relation: { type: 'string' },
    content: { type: 'string' },
    neighbors: { type: 'array', items: NEIGHBOR_SCHEMA },
  },
} as const

/**
 * Build the `patent_kg_query` tool over an injectable knowledge-graph adapter.
 * @param deps - the knowledge-graph adapter plus the resolved knowledge.db path.
 * @returns a registry-ready tool definition.
 */
export function createPatentKgQueryTool(deps: PatentKgQueryDeps): ToolDefinition {
  return defineTool({
    name: 'patent_kg_query',
    description: DESCRIPTION,
    parameters: {
      query: { type: 'string', description: '关键词检索（如 创造性 三步法、Bolar例外、禁止反悔）；与 id 二选一' },
      id: { type: 'string', description: '节点 id（如 CASE_005）；返回节点详情 + 相似/引用邻居；与 query 二选一，id 优先' },
      node_type: { type: 'string', description: '按节点类型浏览（Case/SupremeCourtJudgment/RegionalCourtJudgment/GuidelineRule/Clause/WikiCard/Concept；Judgment=最高法院+地方法院判决，LawArticle=法条条款）' },
      expand: { type: 'boolean', description: '关键词命中后是否做关系扩展（相似/引用），默认 true' },
      include_content: { type: 'boolean', description: '是否附节点正文片段（默认 false，截断约 600 字）' },
      limit: { type: 'number', description: '返回条数上限（默认 5，最大 10）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true },
          hits: { type: 'array', required: true, items: HIT_SCHEMA },
          dbPath: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderKgQuery(value) }],
    },
    // oxlint-disable-next-line typescript/require-await -- tool contract requires async execute
    async execute(args) {
      if (deps.adapter === undefined) {
        throw new PatentToolError('setup_required', INSTALL_GUIDANCE, { tool: 'patent_kg_query' })
      }
      if (deps.dbPath !== undefined && !existsSync(deps.dbPath)) {
        throw new PatentToolError('setup_required', INSTALL_GUIDANCE, { tool: 'patent_kg_query' })
      }
      const limit = resolveResultLimit(args.limit, 5, 10)
      const includeContent = args.include_content === true
      let output: PatentKgQueryOutput
      if (args.id?.trim()) {
        output = queryById(deps.adapter, args.id.trim(), limit, includeContent)
      } else if (args.query?.trim()) {
        output = queryByKeyword(deps.adapter, args.query.trim(), limit, args.expand !== false, includeContent)
      } else if (args.node_type?.trim()) {
        output = queryByType(deps.adapter, args.node_type.trim(), limit, includeContent)
      } else {
        throw new PatentToolError('invalid_tool_input', '请提供 query（关键词）、id（节点）或 node_type（类型浏览）之一。', { tool: 'patent_kg_query' })
      }
      return { ...output, ...(deps.dbPath !== undefined ? { dbPath: deps.dbPath } : {}) }
    },
  })
}
