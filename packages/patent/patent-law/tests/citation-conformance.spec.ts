import { describe, expect, it } from 'vitest'
import {
  CONFORMANCE_ARTICLES,
  CONFORMANCE_CEILING,
  CONFORMANCE_SAMPLES,
  CONFORMANCE_UNVERIFIED_CEILING,
  type ConformanceCeiling,
} from '@deepseek-ai/dsh-law-core/tests/fixtures/citation-samples.ts'
import { verifyCitation } from '../src/verify.ts'
import type { LawBaseline, LawName, LawReference } from '../src/types.ts'

// 领域数据：法名取自专利域索引；样例表、条目内容与期望判定与法律域同一份
// （见 law-core tests/fixtures/citation-samples.ts），两边只有这里的数据不同。
const LAW: LawName = '专利法'

function baseline(ceiling: ConformanceCeiling): LawBaseline {
  const limits = ceiling === 'verified' ? CONFORMANCE_CEILING : CONFORMANCE_UNVERIFIED_CEILING
  return {
    law: LAW,
    document: '中华人民共和国专利法',
    revision: null,
    supersededBy: null,
    staleSections: [],
    versions: [],
    ...limits,
    articles: [...CONFORMANCE_ARTICLES],
    sections: [],
  }
}

describe('shared citation samples', () => {
  for (const sample of CONFORMANCE_SAMPLES) {
    it(`decides ${sample.expected} — ${sample.name}（${sample.note}）`, () => {
      const reference: LawReference = {
        kind: 'law-article',
        law: LAW,
        article: sample.article,
        ...(sample.paragraph === undefined ? {} : { paragraph: sample.paragraph }),
        raw: `《中华人民共和国专利法》第${sample.article}条`,
      }
      const baselines = new Map([[LAW, baseline(sample.ceiling)]])
      const finding = verifyCitation(reference, baselines, {
        ...(sample.proposition === undefined ? {} : { proposition: sample.proposition }),
      })
      expect(finding.decision).toBe(sample.expected)
    })
  }
})
