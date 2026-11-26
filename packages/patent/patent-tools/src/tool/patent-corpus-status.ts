/**
 * `patent_corpus_status` tool: report which version of the local patent knowledge
 * corpus is installed and how fresh it is, without running a search.
 *
 * A zero-hit search still carries the corpus block, but a report often needs to
 * state "the cited statute/case came from this corpus version" before any query
 * is issued; this tool answers only that question and never reads content.
 * @module @deepseek-ai/dsh-patent-tools/tool/patent-corpus-status
 */

import { existsSync } from 'node:fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { CorpusInfo } from '@deepseek-ai/dsh-patent-knowledge'
import { PatentToolError } from '../error.ts'
import { CORPUS_SCHEMA, renderCorpusLine } from './internal/corpus.ts'
import { knowledgeInstallGuidance } from './internal/knowledge.ts'

/** Injected dependencies of the corpus-status tool. */
export type PatentCorpusStatusDeps = {
  /** Corpus freshness reader (production: ctx.patentKnowledge.corpusInfo). */
  corpusInfo?: () => CorpusInfo
  /** Resolved knowledge.db path, used for the setup-required check. */
  dbPath?: string
}

const INSTALL_GUIDANCE = knowledgeInstallGuidance('本地专利知识库')

const DESCRIPTION = [
  '报告本地专利知识库（knowledge.db：法条、审查指南、判例与知识图谱共用一库）的语料版本与新鲜度：上游索引构建时间、schema 版本、文档/分块数与本地副本时间。',
  '检索命中为空、或报告要写明「所引条文/判例出自哪一版语料」时先查它；它不检索内容，只回答「这是哪一版」。',
].join(' ')

/** Render the corpus facts into model-facing prose. */
function renderStatus(value: CorpusInfo): string {
  return [
    'patent_corpus_status',
    renderCorpusLine(value),
    `数据库：${value.dbPath}`,
    ...(value.versionCreatedAt === undefined ? [] : [`版本创建：${value.versionCreatedAt}`]),
  ].join('\n')
}

/**
 * Build the `patent_corpus_status` tool over an injectable corpus reader.
 * @param deps - the corpus reader plus the resolved knowledge.db path.
 * @returns a registry-ready tool definition.
 */
export function createPatentCorpusStatusTool(deps: PatentCorpusStatusDeps = {}): ToolDefinition {
  return defineTool({
    name: 'patent_corpus_status',
    description: DESCRIPTION,
    parameters: {},
    output: {
      schema: CORPUS_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderStatus(value) }],
    },
    // oxlint-disable-next-line typescript/require-await -- tool contract requires async execute
    async execute() {
      if (deps.corpusInfo === undefined) {
        throw new PatentToolError('setup_required', INSTALL_GUIDANCE, { tool: 'patent_corpus_status' })
      }
      if (deps.dbPath !== undefined && !existsSync(deps.dbPath)) {
        throw new PatentToolError('setup_required', INSTALL_GUIDANCE, { tool: 'patent_corpus_status' })
      }
      try {
        return deps.corpusInfo()
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        throw new PatentToolError('setup_required', `${INSTALL_GUIDANCE}（读取语料信息失败：${detail}）`, {
          tool: 'patent_corpus_status',
          cause: detail,
        })
      }
    },
  })
}
