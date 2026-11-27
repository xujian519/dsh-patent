/**
 * 语料新鲜度的模型可见表示：`law_search` / `patent_case_search` 与
 * `patent_corpus_status` 共用同一份字段与渲染，避免三处对「哪一版」给出不同读法。
 * @module @deepseek-ai/dsh-patent-tools/tool/internal/corpus
 */

import type { CorpusInfo } from '@deepseek-ai/dsh-patent-knowledge'

/** 语料信息的输出 schema，与 {@link CorpusInfo} 一一对应。 */
export const CORPUS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dbPath: { type: 'string', required: true },
    lastIndexedAt: { type: 'string' },
    version: { type: 'number' },
    versionCreatedAt: { type: 'string' },
    documents: { type: 'number' },
    chunks: { type: 'number' },
    fileModifiedAt: { type: 'string', required: true },
  },
} as const

/**
 * 渲染语料新鲜度的一行：上游索引构建时间、本机副本时间与规模。
 * 两个时间分开写，因为索引可能在几个月前构建、本周才装到本机。
 * @param corpus - 语料信息。
 * @returns 一行模型可见文本。
 */
export function renderCorpusLine(corpus: CorpusInfo): string {
  const indexed = corpus.lastIndexedAt === undefined ? '上游索引时间未记录' : `上游索引 ${corpus.lastIndexedAt}`
  const version = corpus.version === undefined ? '' : ` · 版本 ${corpus.version}`
  const size = corpus.documents === undefined
    ? ''
    : ` · ${corpus.documents} 文档 / ${corpus.chunks ?? '?'} 分块`
  return `语料：${indexed}${version}${size} · 本机副本 ${corpus.fileModifiedAt}`
}
