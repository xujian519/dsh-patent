/**
 * Shared types of the law baseline: the reference forms the model and the rule
 * assets use, the indexed entries an asset file declares, and the verdict a
 * citation receives.
 * @module @deepseek-ai/dsh-patent-law/types
 */

import type { DecisionArticle } from '@deepseek-ai/dsh-patent-core'

/**
 * Patent judicial interpretations, named by their official titles. Their text is
 * indexed article by article like a statute; the title is long because it is the
 * name a citation uses.
 */
export type InterpretationName =
  | '最高人民法院关于审理专利授权确权行政案件适用法律若干问题的规定（一）'
  | '最高人民法院关于审理专利纠纷案件适用法律问题的若干规定'
  | '最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释'
  | '最高人民法院关于审理侵犯专利权纠纷案件应用法律若干问题的解释（二）'
  | '最高人民法院关于审理涉专利权评价报告案件适用法律问题的批复'
  | '最高人民法院关于审理申请注册的药品相关的专利权纠纷民事案件适用法律若干问题的规定'
  | '最高人民法院关于审理侵害知识产权民事纠纷案件适用惩罚性赔偿的解释'

/** Departmental regulations and standards the index covers, by their official titles. */
export type RegulationName =
  | '专利代理管理办法'
  | '专利实施强制许可办法'
  | '专利权质押登记办法'
  | '专利标识标注办法'
  | '专利行政执法办法'
  | '关于规范专利申请行为的若干规定'
  | '用于专利程序的生物材料保藏办法'
  | '专利申请号标准'

/** Law documents the index covers. */
export type LawName = '专利法' | '专利法实施细则' | '专利审查指南' | InterpretationName | RegulationName

/** Statute whose text is indexed article by article. */
export type StatuteName = '专利法' | '专利法实施细则' | InterpretationName | RegulationName

/**
 * A reference to one article of a statute, optionally narrowed to a paragraph
 * and an item.
 */
export type LawArticleReference = {
  kind: 'law-article'
  law: StatuteName
  /** Article number, as an integer. */
  article: number
  /** Paragraph (款) number when the reference names one. */
  paragraph?: number
  /** Item (项) number when the reference names one. */
  item?: number
  /** The reference exactly as it appeared in the source text. */
  raw: string
}

/**
 * A reference to one section of 专利审查指南, whose division is a part and a
 * chapter rather than an article number.
 */
export type GuidelineReference = {
  kind: 'guideline-section'
  law: '专利审查指南'
  /** Normalized section path, e.g. `第二部分第四章3.2.1.1`. */
  path: string
  /** The reference exactly as it appeared in the source text. */
  raw: string
}

/** Any reference the baseline can resolve. */
export type LawReference = LawArticleReference | GuidelineReference

/**
 * One indexed article. `text`, `sourceDoc`, and `verifiedOn` record where the
 * article text came from and when that copy was checked against that source:
 * until the article is transcribed from an official source and the copy is
 * recorded, the entry is indexed but unverified. Who performed the check is a
 * property of the shipped asset, and the asset states it.
 */
export type ArticleEntry = DecisionArticle

/** One indexed guideline section, with the same source and verification fields as an article. */
export type SectionEntry = {
  /** Normalized section path. */
  path: string
  /** Topic keywords a proposition can name; one of the two signals a proposition is matched by. */
  topics: string[]
  /** Section text, or null while it has not been transcribed. */
  text: string | null
  /** Official source the text was taken from, or null while unverified. */
  sourceDoc: string | null
  /** Date the entry's text was checked against `sourceDoc`, or null while it has not been transcribed. */
  verifiedOn: string | null
}

/**
 * One guideline section whose indexed text predates the revision that
 * supersedes it. The record makes the stale text machine-readable: a citation
 * covering the section is reported as unverified instead of passing as current
 * law.
 */
export type StaleSection = {
  /** Normalized section path whose indexed text is stale. */
  path: string
  /** Why the indexed text is stale. */
  reason: string
}

/**
 * Sections one later revision changes. A version overrides the matching paths
 * of `LawBaseline.sections` and may add paths the base revision did not index.
 * Sections it does not name keep the base text.
 */
export type GuidelineVersion = {
  /** Revision these sections state, e.g. `2026 年修订版（2026-01-01 施行）`. */
  revision: string
  /** Sections this revision changes or adds. */
  sections: SectionEntry[]
}

/** One law document's index. */
export type LawBaseline = {
  law: LawName
  /** Document title. */
  document: string
  /** Revision the index targets, or null while it has not been stated. */
  revision: string | null
  /**
   * Revision that supersedes the indexed text, or null when the index targets
   * the current revision. When set, citations to `staleSections` are reported
   * as unverified rather than valid.
   */
  supersededBy: string | null
  /** Guideline sections whose indexed text predates `supersededBy`; empty for statutes. */
  staleSections: StaleSection[]
  /**
   * Revisions that change or add guideline sections, as transcribed overrides
   * of `sections`, declared oldest first; empty for statutes and while no later
   * revision has been transcribed. Verification applies every entry up to the
   * target revision when the current revision is transcribed, unless the caller
   * names a revision.
   */
  versions: GuidelineVersion[]
  /**
   * Highest article number the law has, or null while it has not been verified.
   * A reference beyond a verified ceiling is out of range; beyond an unverified
   * ceiling it is only unverified.
   */
  maxArticle: number | null
  /** Date `maxArticle` was checked against `maxSource`, or null. */
  maxVerifiedOn: string | null
  /** Where the ceiling came from. */
  maxSource: string | null
  /** Indexed articles, ascending by article number. */
  articles: ArticleEntry[]
  /** Indexed guideline sections; empty for a statute. */
  sections: SectionEntry[]
}

/** Verdict for one citation. */
export type CitationDecision =
  /** Indexed, text verified, and the proposition (when given) matches. */
  | 'valid'
  /** Indexed and verified, but the claimed proposition does not match the entry. */
  | 'mismatch'
  /** Indexed and verified, but neither the entry nor any other matches the proposition lexically. */
  | 'unmatched'
  /** Beyond the law's verified article ceiling. */
  | 'out-of-range'
  /** Not present in the index at all. */
  | 'not-indexed'
  /** Indexed, but its text, its recorded source, or its verification date is missing. */
  | 'unverified'

/** One citation's verdict, with the reason and the entry it was decided against. */
export type CitationFinding = {
  /** The reference as written. */
  raw: string
  /** The parsed reference. */
  reference: LawReference
  decision: CitationDecision
  /** Why the decision was reached, in the model's language. */
  reason: string
  /** The indexed entry the decision used, when one was found. */
  entry?: ArticleEntry | SectionEntry
}

/** How a decision is turned into a tool result. */
export type CitationPolicy = 'block' | 'warn' | 'allow'

/** Per-decision policy, so a deployment chooses which gaps may pass. */
export type CitationPolicySet = {
  /**
   * Policy for `mismatch`: the entry itself does not carry the proposition, and
   * either the cited paragraph does not exist or another entry of the same law
   * does carry it.
   */
  mismatch: CitationPolicy
  /** Policy for `unmatched`: no entry of the law carries the proposition, so nothing here decides it. */
  unmatched: CitationPolicy
  /** Policy for `out-of-range`. */
  outOfRange: CitationPolicy
  /** Policy for `not-indexed`. */
  notIndexed: CitationPolicy
  /** Policy for `unverified`. */
  unverified: CitationPolicy
}

/**
 * Four-state validity of a legal provision: whether the cited text is still in
 * force, has been superseded by a later revision, has been repealed, or cannot
 * be decided from the shipped index.
 */
export type ValidityState = 'active' | 'revised' | 'repealed' | 'unverified'

/**
 * Input for a validity query against the citator. The `provision` is the
 * human-readable citation text; `asOf` and `revision` narrow the decision
 * when the caller knows the relevant time or guideline version.
 */
export type ValidityQuery = {
  /** Citation text, e.g. `专利法第22条第2款` or `审查指南第二部分第四章3.2.1.1`. */
  provision: string
  /** Decision date (YYYY-MM-DD); reserved for future time-aware repeal checks. */
  asOf?: string
  /** Guideline revision to decide against, e.g. `2026 年修订版（2026-01-01 施行）`. */
  revision?: string
}

/**
 * The result of a validity query: the parsed reference, the four-state verdict,
 * the reason, and the indexed entry when one was found.
 */
export type ValidityResult = {
  /** The parsed reference. */
  reference: LawReference
  /** The four-state validity verdict. */
  state: ValidityState
  /** Why the verdict was reached, in the model's language. */
  reason: string
  /** The indexed entry the verdict used, when one was found. */
  entry?: ArticleEntry | SectionEntry
  /** Revision history entries when the provision has been through versions. */
  revisionHistory?: Array<{ revision: string; effectiveDate: string }>
}

/** One revision record of an article. */
export type ArticleRevision = {
  /** Revision identifier, e.g. `2008-amendment`. */
  revision: string
  /** Effective date (YYYY-MM-DD). */
  effectiveDate: string
  /** Article text in this revision. Null means carried from the previous revision. */
  text: string | null
  /** Whether this revision substantively changed the article. */
  changed: boolean
  /** Revision source description (e.g. legislative body). */
  source?: string
}

/** Cross-revision lineage record for a single article. */
export type ArticleLineage = {
  /** Article number (using the latest revision's numbering). */
  articleId: number
  /** Article title summary. */
  title: string | null
  /** Current four-state validity. */
  currentStatus: ValidityState
  /** Revision history in chronological order. */
  revisionHistory: ArticleRevision[]
}

/** One revision descriptor in the revision catalogue. */
export type RevisionDescriptor = {
  /** Revision identifier. */
  id: string
  /** Human-readable revision label. */
  label: string
  /** Effective date (YYYY-MM-DD). */
  effectiveDate: string
  /** Revision source (legislative body or session). */
  source: string
}

/** Complete lineage snapshot for one statute. */
export type LawLineageSnapshot = {
  /** Statute name. */
  law: StatuteName
  /** Full document title. */
  document: string
  /** Schema version of the lineage format. */
  lineageVersion: string
  /** Revision catalogue. */
  revisions: RevisionDescriptor[]
  /** Per-article lineage records. */
  articles: ArticleLineage[]
}
