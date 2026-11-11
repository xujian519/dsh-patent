/**
 * 同一份法条引用样例：法律域与专利域各自的 conformance spec 都跑这张表。
 *
 * 按 issue 处置约定，两边的差异只许是「领域数据不同」（法名、基线字段），
 * 「判定规则不同」必须为零——这张表就是该约定的回归护栏：样例、基线内容、
 * 期望判定都在这里定义一次，任何一侧的规则分叉都会让另一侧的 spec 变红。
 */
import type { ArticleDecision, DecisionArticle } from '../../src/index.ts'

/** The article ceiling profile a sample runs against. */
export type ConformanceCeiling = 'verified' | 'unverified'

/** One citation sample both domains run. */
export type ConformanceSample = {
  /** Sample name, for the assertion message. */
  name: string
  /** The article the citation names. */
  article: number
  /** The paragraph the citation narrows to, when it names one. */
  paragraph?: number
  /** The proposition the citation is offered in support of. */
  proposition?: string
  /** The ceiling profile the sample's baseline carries. */
  ceiling: ConformanceCeiling
  /**
   * Whether the deployment's index contains the law. Omitted means it does.
   * A missing law is decided before the article rule, by both verifiers.
   */
  indexed?: boolean
  /** The decision both domains must reach. */
  expected: ArticleDecision
  /** Why the label is what it is, for the reader. */
  note: string
}

/** Verified ceiling values both baselines share. */
export const CONFORMANCE_CEILING = {
  maxArticle: 6,
  maxVerifiedOn: '2026-01-01',
  maxSource: 'conformance-fixture',
} as const

/** Ceiling profile whose ceiling exists but has not been checked against a source. */
export const CONFORMANCE_UNVERIFIED_CEILING = {
  maxArticle: 6,
  maxVerifiedOn: null,
  maxSource: null,
} as const

/**
 * The article content both domains index identically. The texts are written so
 * the lexical signals are deterministic: no character pair is shared between an
 * article and a proposition that must not score, and a quoted proposition only
 * carries pairs of the entry it quotes.
 */
export const CONFORMANCE_ARTICLES: DecisionArticle[] = [
  {
    article: 1,
    topics: ['立法目的'],
    text: '为了规范社会关系中各方的权利义务，保护当事人的合法权益，制定本法。',
    sourceDoc: '官方全文',
    verifiedOn: '2026-01-01',
  },
  {
    article: 2,
    topics: ['适用范围'],
    text: '本法适用于在中华人民共和国境内发生的民事法律关系。',
    sourceDoc: '官方全文',
    verifiedOn: '2026-01-01',
  },
  {
    article: 3,
    topics: ['诚实信用'],
    text: '当事人行使权利、履行义务应当遵循诚实信用原则。',
    sourceDoc: '官方全文',
    verifiedOn: '2026-01-01',
  },
  {
    article: 4,
    topics: ['未转录条目'],
    text: null,
    sourceDoc: null,
    verifiedOn: null,
  },
  {
    article: 5,
    paragraphs: [1, 2],
    topics: ['款号窄化'],
    text: '第一款规定一般规则。第二款规定例外情形。',
    sourceDoc: '官方全文',
    verifiedOn: '2026-01-01',
  },
]

/**
 * The samples, one per reachable decision. Each domain's spec feeds every row
 * through its own verify path and asserts `expected`.
 */
export const CONFORMANCE_SAMPLES: ConformanceSample[] = [
  {
    name: 'valid: transcribed entry, no proposition',
    article: 1,
    ceiling: 'verified',
    expected: 'valid',
    note: '条目已转录核验，没有命题要支撑。',
  },
  {
    name: 'valid: proposition carried by the entry topics',
    article: 1,
    proposition: '本法的立法目的',
    ceiling: 'verified',
    expected: 'valid',
    note: '命题包含条目主题「立法目的」。',
  },
  {
    name: 'valid: proposition quoting the entry text',
    article: 2,
    proposition: '适用于在中华人民共和国境内发生的民事法律关系',
    ceiling: 'verified',
    expected: 'valid',
    note: '命题逐字引用条目文本，字对重合达到阈值。',
  },
  {
    name: 'mismatch: proposition lives on another article',
    article: 1,
    proposition: '诚实信用原则的要求',
    ceiling: 'verified',
    expected: 'mismatch',
    note: '所引第 1 条与命题无共同字对，第 3 条主题命中命题。',
  },
  {
    name: 'mismatch: cited paragraph absent from the entry',
    article: 5,
    paragraph: 3,
    ceiling: 'verified',
    expected: 'mismatch',
    note: '索引载明第 5 条共 2 款，引用窄化到不存在的第 3 款。',
  },
  {
    name: 'unmatched: no entry carries the proposition',
    article: 2,
    proposition: '跨境数据流动的合规义务',
    ceiling: 'verified',
    expected: 'unmatched',
    note: '命题与任何条目的主题和文本都不重合，判为无法判定而非矛盾。',
  },
  {
    name: 'out-of-range: beyond a verified ceiling',
    article: 9,
    ceiling: 'verified',
    expected: 'out-of-range',
    note: '已核验上限 6 条，第 9 条不存在。',
  },
  {
    name: 'unverified: beyond an unverified ceiling',
    article: 9,
    ceiling: 'unverified',
    expected: 'unverified',
    note: '上限本身未核验，超出它只能说明无法判定。',
  },
  {
    name: 'not-indexed: inside the ceiling, absent from the index',
    article: 6,
    ceiling: 'verified',
    expected: 'not-indexed',
    note: '上限为 6 但索引只收 1–5 条，第 6 条不在索引中。',
  },
  {
    name: 'unverified: indexed but not transcribed',
    article: 4,
    ceiling: 'verified',
    expected: 'unverified',
    note: '条目在索引中但文本未转录核验。',
  },
  {
    name: 'valid: named paragraph while the entry lists no paragraphs',
    article: 1,
    paragraph: 9,
    ceiling: 'verified',
    expected: 'valid',
    note: '条目未登记款数时两域都跳过款号窄化。缺列表是数据缺口，不把判定改成 unverified。',
  },
  {
    name: 'not-indexed: the deployment has no baseline for the law',
    article: 1,
    ceiling: 'verified',
    indexed: false,
    expected: 'not-indexed',
    note: '索引里没有这部法律时，两域使用同一句理由，不进入逐条判定。',
  },
]

/** Default per-decision treatment each domain ships. The two sets differ on purpose. */
export const CONFORMANCE_POLICIES = {
  patent: {
    mismatch: 'block',
    unmatched: 'warn',
    outOfRange: 'block',
    notIndexed: 'warn',
    unverified: 'warn',
  },
  legal: {
    mismatch: 'block',
    unmatched: 'warn',
    outOfRange: 'block',
    notIndexed: 'block',
    unverified: 'block',
  },
} as const
