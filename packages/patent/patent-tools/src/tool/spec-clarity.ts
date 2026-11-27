/**
 * Vague-wording check (《专利审查指南》第二部分第二章 2.2.7).
 *
 * The check matches vague quantities in context rather than by substring: 「约束」
 * and 「左右两侧」 are exact technical wording, while 「约 10%」 and 「左右」 after a
 * number are vague. 「例如」 and 「优选」 are drafting aids the guideline explicitly
 * permits, so they are not reported.
 */

import { locationAt } from '@deepseek-ai/dsh-patent-core'
import type { SpecViolation } from './spec-types.ts'

/** A number token the vague quantifier may modify. */
const QUANTITY = '(?:\\d+(?:\\.\\d+)?|[零一二三四五六七八九十百千万两]+|百分之[零一二三四五六七八九十百]+)'

/** Vague quantifiers that only count when attached to a quantity. */
const VAGUE_QUANTITY_RES = [
  new RegExp(`(?:约|大约|大致)(?:为|是)?\\s*${QUANTITY}`, 'g'),
  new RegExp(`${QUANTITY}\\s*左右`, 'g'),
] as const

/**
 * Words that stay vague in context, ordered as written.
 *
 * 「可能」 is vague as a hedge (可能为10%), but 「尽可能」「不可能」 are ordinary
 * wording and 「可能性」 is a noun, so the match is contextual rather than a bare
 * substring — the same distinction the quantity patterns above make.
 */
const VAGUE_WORD_RES = [
  /(?<![尽不])可能(?!性)/g,
  /较好/g,
] as const

/**
 * Report vague wording with the location of its earliest hit.
 *
 * The location comes from the earliest match index, not from searching the hit
 * texts: 「可能」 matched at one offset can appear earlier in the text inside an
 * excluded 「尽可能」, and a substring search would report that line instead.
 * @param text - the specification text.
 * @returns the clarity violation, or empty when no vague wording is present.
 */
export function checkClarity(text: string): SpecViolation[] {
  const hits: string[] = []
  let earliest = Number.POSITIVE_INFINITY
  const record = (matched: string, index: number): void => {
    if (!hits.includes(matched)) hits.push(matched)
    if (index < earliest) earliest = index
  }
  for (const pattern of [...VAGUE_QUANTITY_RES, ...VAGUE_WORD_RES]) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text)) !== null) record(match[0], match.index)
  }
  if (hits.length === 0) return []
  const location = locationAt(text, earliest)
  return [{
    rule: 'clarity',
    family: 'description',
    severity: 'warning',
    message: `说明书包含模糊表述：${hits.join('、')}`,
    suggestion: '用确定的数值、范围或条件替代模糊量；「例如」「优选」本身可以使用，但所举数值应当明确',
    line: location.line,
    matchedSentence: location.matchedSentence,
  }]
}
