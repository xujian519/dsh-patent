import { describe, expect, it } from 'vitest'
import { findLegalArticle, createLegalLawIndex } from '../src/baseline.ts'
import { createLegalOverlapIndex, legalTextOverlap, legalTopicOverlap } from '../src/support.ts'
import {
  DEFAULT_LEGAL_CITATION_POLICY,
  renderLegalCitationFindings,
  renderLegalCitationRows,
  resolveLegalCitationPolicy,
  verifyLegalCitation,
  verifyLegalCitations,
} from '../src/verify.ts'
import type { LegalArticleEntry, LegalCitationDecision, LegalCitationFinding, LegalCitationPolicySet, LegalLawBaseline, LegalLawName, LegalLawReference } from '../src/types.ts'

const VERIFIED_ARTICLE: LegalArticleEntry = {
  article: 143,
  paragraphs: [1, 2],
  topics: ['民事法律行为', '有效条件'],
  text: '具备下列条件的民事法律行为有效：（一）行为人具有相应的民事行为能力；（二）意思表示真实；',
  sourceDoc: '官方全文',
  verifiedOn: '2026-10-23',
}

const UNVERIFIED_ARTICLE: LegalArticleEntry = {
  article: 577,
  topics: ['违约责任'],
  text: null,
  sourceDoc: null,
  verifiedOn: null,
}

function civilCodeBaseline(overrides: Partial<LegalLawBaseline> = {}): LegalLawBaseline {
  return {
    law: '民法典',
    document: '中华人民共和国民法典',
    revision: null,
    maxArticle: 1260,
    maxVerifiedOn: '2026-10-23',
    maxSource: 'fixture',
    articles: [VERIFIED_ARTICLE, UNVERIFIED_ARTICLE],
    ...overrides,
  }
}

function baselines(): Map<LegalLawName, LegalLawBaseline> {
  return new Map<LegalLawName, LegalLawBaseline>([
    ['民法典', civilCodeBaseline()],
    ['劳动合同法', civilCodeBaseline({
      law: '劳动合同法',
      document: '中华人民共和国劳动合同法',
      maxArticle: 98,
      articles: [UNVERIFIED_ARTICLE],
    })],
  ])
}

function articleRef(article: number, paragraph?: number, law: LegalLawName = '民法典'): LegalLawReference {
  return {
    kind: 'law-article',
    law,
    article,
    ...(paragraph === undefined ? {} : { paragraph }),
    raw: `民法典第${article}条`,
  }
}

describe('verifyLegalCitation', () => {
  it('returns valid for a verified article without proposition', () => {
    const finding = verifyLegalCitation(articleRef(143), baselines())
    expect(finding.decision).toBe('valid')
    expect(finding.entry).toBeDefined()
  })

  it('returns unverified for an article whose text is null', () => {
    const finding = verifyLegalCitation(articleRef(577), baselines())
    expect(finding.decision).toBe('unverified')
  })

  it('returns out-of-range for an article beyond the verified ceiling', () => {
    const finding = verifyLegalCitation(articleRef(9999), baselines())
    expect(finding.decision).toBe('out-of-range')
  })

  it('returns not-indexed when the law is not in the baselines', () => {
    const ref: LegalLawReference = { kind: 'law-article', law: '公司法', article: 1, raw: '公司法第1条' }
    const finding = verifyLegalCitation(ref, baselines())
    expect(finding.decision).toBe('not-indexed')
  })

  it('returns mismatch when the proposition matches another entry', () => {
    const extraEntry: LegalArticleEntry = {
      article: 1165,
      topics: ['过错侵权责任'],
      text: '行为人因过错侵害他人民事权益造成损害的，应当承担侵权责任。',
      sourceDoc: '官方全文',
      verifiedOn: '2026-10-23',
    }
    const index = baselines()
    index.set('民法典', civilCodeBaseline({ articles: [VERIFIED_ARTICLE, extraEntry, UNVERIFIED_ARTICLE] }))
    const finding = verifyLegalCitation(articleRef(143), index, { proposition: '过错侵权责任的承担' })
    expect(finding.decision).toBe('mismatch')
  })

  it('returns valid when the topic matches the proposition', () => {
    const finding = verifyLegalCitation(articleRef(143), baselines(), { proposition: '民事法律行为的有效条件' })
    expect(finding.decision).toBe('valid')
  })

  it('reports a paragraph mismatch', () => {
    const finding = verifyLegalCitation(articleRef(143, 5), baselines())
    expect(finding.decision).toBe('mismatch')
    expect(finding.reason).toContain('款')
  })
})

describe('verifyLegalCitations', () => {
  it('extracts and verifies every reference in a text', () => {
    const text = '根据民法典第143条，民事法律行为有效。同时民法典第577条规定了违约责任。'
    const findings = verifyLegalCitations(text, baselines())
    expect(findings).toHaveLength(2)
    expect(findings[0]!.decision).toBe('valid')
    expect(findings[1]!.decision).toBe('unverified')
  })

  it('returns an empty array when no citations are found', () => {
    expect(verifyLegalCitations('没有引用的文本', baselines())).toEqual([])
  })
})

describe('resolveLegalCitationPolicy', () => {
  it('returns allow for valid findings', () => {
    const finding = verifyLegalCitation(articleRef(143), baselines())
    expect(resolveLegalCitationPolicy(finding, DEFAULT_LEGAL_CITATION_POLICY)).toBe('allow')
  })

  it('returns the configured policy for mismatch', () => {
    const policies: LegalCitationPolicySet = { ...DEFAULT_LEGAL_CITATION_POLICY, mismatch: 'warn' }
    const extraEntry: LegalArticleEntry = {
      article: 1165,
      topics: ['过错侵权责任'],
      text: '行为人因过错侵害他人民事权益造成损害的，应当承担侵权责任。',
      sourceDoc: '官方',
      verifiedOn: '2026-10-23',
    }
    const index = baselines()
    index.set('民法典', civilCodeBaseline({ articles: [VERIFIED_ARTICLE, extraEntry, UNVERIFIED_ARTICLE] }))
    const finding = verifyLegalCitation(articleRef(143), index, { proposition: '过错侵权责任的承担' })
    expect(resolveLegalCitationPolicy(finding, policies)).toBe('warn')
  })

  it('blocks citations it cannot check by default', () => {
    expect(DEFAULT_LEGAL_CITATION_POLICY.unverified).toBe('block')
    expect(DEFAULT_LEGAL_CITATION_POLICY.notIndexed).toBe('block')
  })

  it('maps every decision to its policy slot (F-LEG-010)', () => {
    // 锁死 resolveCitationDecisionPolicy 的五决策→五策略映射。
    // 任意换 policies 字段值，每个 decision 应走到各自的槽。
    const policies: LegalCitationPolicySet = {
      mismatch: 'allow',
      unmatched: 'warn',
      outOfRange: 'block',
      notIndexed: 'allow',
      unverified: 'warn',
    }
    const mk = (decision: LegalCitationDecision): LegalCitationFinding => ({
      raw: 'mock',
      reference: { law: '民法典', lawId: 'civil-code', article: 1 },
      decision,
      reason: '测试',
    })
    expect(resolveLegalCitationPolicy(mk('mismatch'), policies)).toBe('allow')
    expect(resolveLegalCitationPolicy(mk('unmatched'), policies)).toBe('warn')
    expect(resolveLegalCitationPolicy(mk('out-of-range'), policies)).toBe('block')
    expect(resolveLegalCitationPolicy(mk('not-indexed'), policies)).toBe('allow')
    expect(resolveLegalCitationPolicy(mk('unverified'), policies)).toBe('warn')
    // valid 永远 allow，不受 policies 影响。
    expect(resolveLegalCitationPolicy(mk('valid'), policies)).toBe('allow')
  })
})

describe('renderLegalCitationFindings', () => {
  it('renders a Markdown table', () => {
    const findings = verifyLegalCitations('民法典第143条', baselines())
    const report = renderLegalCitationFindings(findings, DEFAULT_LEGAL_CITATION_POLICY)
    expect(report).toContain('| 引用 |')
    expect(report).toContain('已核验')
  })

  it('reports when no citations are found', () => {
    const report = renderLegalCitationRows([])
    expect(report).toContain('未在文本中识别到法条引用')
  })
})

describe('legalTopicOverlap', () => {
  it('matches when a topic appears in the proposition', () => {
    expect(legalTopicOverlap(['违约责任'], '关于违约责任的承担')).toBe(true)
  })

  it('does not match unrelated topics', () => {
    expect(legalTopicOverlap(['知识产权'], '关于违约责任')).toBe(false)
  })

  it('does not match an empty proposition', () => {
    expect(legalTopicOverlap(['违约责任'], '')).toBe(false)
  })
})

describe('legalTextOverlap', () => {
  it('returns 1 when the text equals the proposition', () => {
    const entries = [{ label: 'test', topics: [], text: '相同文本' }]
    const index = createLegalOverlapIndex(entries)
    expect(legalTextOverlap(index, '相同文本', '相同文本')).toBe(1)
  })

  it('returns 0 for an empty proposition', () => {
    const entries = [{ label: 'test', topics: [], text: '一些文本内容' }]
    const index = createLegalOverlapIndex(entries)
    expect(legalTextOverlap(index, '', '一些文本内容')).toBe(0)
  })
})

describe('createLegalLawIndex (integration)', () => {
  it('loads a cited law from the shipped index and finds its articles', async () => {
    const shipped = await createLegalLawIndex().load(['民法典'])
    // The auto-generated index covers 民法典 with all 1260 articles
    const civilCode = shipped.get('民法典')
    expect(civilCode).toBeDefined()
    const article143 = findLegalArticle(civilCode!, 143)
    expect(article143).toBeDefined()
    // Auto-generated entries have text: null until verified
    // The key check is that the article is indexed
    expect(article143!.article).toBe(143)
  })
})
