/**
 * 长查询切词关键词提取（纯函数）。
 *
 * 切词规则与检索阶梯同属知识库查询内核：阶梯按 trigram tokenizer 的下限
 * 要求挑词，切词因此与阶梯放在同一个领域中立包里，各知识库的公开入口保留
 * 同名再导出以维持公开入口。
 * @module @deepseek-ai/dsh-knowledge-core/keywords
 */

import { FTS_MIN_RUNES } from './fts.ts'

/** 长查询切词用的虚词/疑问词（按这些词切分后取 ≥3 字片段）。 */
const SPLIT_WORDS = [
  '的',
  '是',
  '吗',
  '呢',
  '什么',
  '如何',
  '怎么',
  '是否',
  '哪些',
  '一个',
  '一种',
  '以及',
  '如果',
  '那么',
]

/**
 * 把长查询切分为 ≥3 字的关键词片段（trigram tokenizer 要求 3+ 字符）。
 * 例："专利侵权的赔偿标准是什么" → ["专利侵权", "赔偿标准"]
 * @param query - 待切分的查询文本。
 * @param max - 返回关键词数量上限。
 * @returns 切分后的关键词片段列表。
 */
export function extractLawKeywords(query: string, max = 4): string[] {
  let rest = query
  for (const w of SPLIT_WORDS) {
    rest = rest.split(w).join('\n')
  }
  const fragments = rest
    .split(/\s+/)
    .map(f => f.trim())
    .filter(f => Array.from(f).length >= FTS_MIN_RUNES)
  return fragments.slice(0, max)
}
