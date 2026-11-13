import { describe, expect, it } from 'vitest'
import { findArticle, loadLawBaselines } from '../src/baseline.ts'
import { createOverlapIndex, PROPOSITION_SUPPORT_DEFAULT, textOverlap, topicOverlap } from '../src/support.ts'
import {
  DEFAULT_CITATION_POLICY,
  renderCitationFindings,
  renderCitationRows,
  resolveCitationPolicy,
  verifyCitation,
  verifyCitations,
} from '../src/verify.ts'
import type { ArticleEntry, CitationPolicySet, LawBaseline, LawName, LawReference, SectionEntry } from '../src/types.ts'

const VERIFIED_ARTICLE: ArticleEntry = {
  article: 22,
  paragraphs: [1, 2, 3],
  topics: ['新颖性', '创造性'],
  text: '现行条文',
  sourceDoc: '主席令第五十五号',
  verifiedOn: '2026-01-01',
}

const UNVERIFIED_ARTICLE: ArticleEntry = {
  article: 5,
  topics: ['期限'],
  text: null,
  sourceDoc: null,
  verifiedOn: null,
}

const VERIFIED_SECTION: SectionEntry = {
  path: '第二部分第四章3.2',
  topics: ['创造性', '三步法'],
  text: '指南正文',
  sourceDoc: '审查指南 2023',
  verifiedOn: '2026-01-01',
}

const UNVERIFIED_SECTION: SectionEntry = {
  path: '第五部分第七章2.1',
  topics: ['期限'],
  text: null,
  sourceDoc: null,
  verifiedOn: null,
}

/** A statute with a verified ceiling and one verified plus one unverified article. */
function statute(overrides: Partial<LawBaseline> = {}): LawBaseline {
  return {
    law: '专利法',
    document: '中华人民共和国专利法',
    revision: null,
    supersededBy: null,
    staleSections: [],
    versions: [],
    maxArticle: 82,
    maxVerifiedOn: '2026-01-01',
    maxSource: 'fixture',
    articles: [VERIFIED_ARTICLE, UNVERIFIED_ARTICLE],
    sections: [],
    ...overrides,
  }
}

/** The index under test: a verified ceiling, an unverified ceiling, and the guideline. */
function baselines(): Map<LawName, LawBaseline> {
  return new Map<LawName, LawBaseline>([
    ['专利法', statute()],
    ['专利法实施细则', statute({
      law: '专利法实施细则',
      maxArticle: null,
      maxVerifiedOn: null,
      articles: [UNVERIFIED_ARTICLE],
    })],
    ['专利审查指南', {
      law: '专利审查指南',
      document: '专利审查指南',
      revision: null,
      supersededBy: null,
      staleSections: [],
      versions: [],
      maxArticle: null,
      maxVerifiedOn: null,
      maxSource: null,
      articles: [],
      sections: [VERIFIED_SECTION, UNVERIFIED_SECTION],
    }],
  ])
}

/** The verified article with its paragraph list removed. */
function withoutParagraphs(entry: ArticleEntry): ArticleEntry {
  const copy: ArticleEntry = { ...entry }
  delete copy.paragraphs
  return copy
}

/** Build a statute reference for the fixtures. */
function articleRef(article: number, paragraph?: number, law: '专利法' | '专利法实施细则' = '专利法'): LawReference {
  return {
    kind: 'law-article',
    law,
    article,
    ...(paragraph === undefined ? {} : { paragraph }),
    raw: `${law}第${article}条`,
  }
}

/** Build a guideline reference for the fixtures. */
function sectionRef(path: string): LawReference {
  return { kind: 'guideline-section', law: '专利审查指南', path, raw: `审查指南${path}` }
}

describe('verifyCitation on statutes', () => {
  it('passes an article whose text is verified', () => {
    const finding = verifyCitation(articleRef(22), baselines())
    expect(finding.decision).toBe('valid')
    expect(finding.reason).toContain('主席令第五十五号')
  })

  it('passes a proposition the entry carries and reports one it does not as undecided', () => {
    expect(verifyCitation(articleRef(22), baselines(), { proposition: '不具备创造性' }).decision).toBe('valid')
    // The fixture law holds no other article carrying this proposition, so a
    // lexical comparison cannot say the citation is wrong — only that nothing
    // here supports it.
    const unmatched = verifyCitation(articleRef(22), baselines(), { proposition: '说明书充分公开' })
    expect(unmatched.decision).toBe('unmatched')
    expect(unmatched.reason).toContain('低于支撑阈值')
    expect(unmatched.reason).toContain('没有条目支撑')
  })

  it('reports a proposition another article carries as a mismatch and names it', () => {
    const index = new Map<LawName, LawBaseline>([['专利法', statute({
      articles: [
        { ...VERIFIED_ARTICLE, topics: ['新颖性', '创造性'] },
        {
          article: 26,
          topics: ['说明书充分公开'],
          text: '说明书应当对发明或者实用新型作出清楚、完整的说明，以所属技术领域的技术人员能够实现为准。',
          sourceDoc: 'fixture',
          verifiedOn: '2026-01-01',
        },
      ],
    })]])
    const finding = verifyCitation(articleRef(22), index, { proposition: '说明书充分公开' })
    expect(finding.decision).toBe('mismatch')
    expect(finding.reason).toContain('第 26 条')
  })

  it('reports a cited paragraph the verified article does not have', () => {
    const finding = verifyCitation(articleRef(22, 9), baselines())
    expect(finding.decision).toBe('mismatch')
    expect(finding.reason).toContain('共 3 款')
  })

  it('skips the paragraph check when the entry does not list its paragraphs', () => {
    const index = new Map<LawName, LawBaseline>([['专利法', statute({
      articles: [withoutParagraphs(VERIFIED_ARTICLE)],
    })]])
    expect(verifyCitation(articleRef(22, 9), index).decision).toBe('valid')
  })

  it('reports an indexed article whose text has not been transcribed', () => {
    const finding = verifyCitation(articleRef(5, undefined, '专利法实施细则'), baselines())
    expect(finding.decision).toBe('unverified')
    expect(finding.reason).toContain('尚未转录核验')
  })

  it('reports an article beyond a verified ceiling as out of range', () => {
    const finding = verifyCitation(articleRef(99), baselines())
    expect(finding.decision).toBe('out-of-range')
    expect(finding.reason).toContain('共 82 条')
  })

  it('only reports an unverified ceiling as unverified, never as out of range', () => {
    const index = new Map<LawName, LawBaseline>([['专利法', statute({ maxVerifiedOn: null })]])
    const finding = verifyCitation(articleRef(99), index)
    expect(finding.decision).toBe('unverified')
    expect(finding.reason).toContain('该上限本身尚未核验')
  })

  it('reports an article the index does not hold', () => {
    expect(verifyCitation(articleRef(78), baselines()).decision).toBe('not-indexed')
  })

  it('reports a law this deployment does not index', () => {
    const finding = verifyCitation(articleRef(22), new Map<LawName, LawBaseline>())
    expect(finding.decision).toBe('not-indexed')
    expect(finding.reason).toContain('没有随包索引')
  })
})

describe('verifyCitation on guideline sections', () => {
  it('passes a verified section and reports an unsupported proposition as undecided', () => {
    expect(verifyCitation(sectionRef('第二部分第四章3.2'), baselines()).decision).toBe('valid')
    const unmatched = verifyCitation(sectionRef('第二部分第四章3.2'), baselines(), { proposition: '外观设计相同判断' })
    expect(unmatched.decision).toBe('unmatched')
  })

  it('reports a proposition another section carries as a mismatch and names it', () => {
    const baseline = baselines().get('专利审查指南')
    const index = new Map<LawName, LawBaseline>([['专利审查指南', {
      ...baseline!,
      sections: [
        ...baseline!.sections,
        {
          path: '第四部分第三章4.4.1',
          topics: ['文件的转送'],
          text: '合议组根据案件审查需要将有关文件转送有关当事人。需要指定答复期限的，该指定答复期限一般为一个月。',
          sourceDoc: 'fixture',
          verifiedOn: '2026-01-01',
        },
      ],
    }]])
    const finding = verifyCitation(sectionRef('第二部分第四章3.2'), index, { proposition: '文件的转送' })
    expect(finding.decision).toBe('mismatch')
    expect(finding.reason).toContain('第四部分第三章4.4.1')
  })

  it('accepts a section whose text carries the proposition without naming a topic', () => {
    const baseline = baselines().get('专利审查指南')!
    const index = new Map<LawName, LawBaseline>([['专利审查指南', {
      ...baseline,
      sections: [{
        path: '第四部分第三章4.4.1',
        topics: ['文件的转送'],
        text: '合议组根据案件审查需要将有关文件转送有关当事人。需要指定答复期限的，该指定答复期限一般为一个月。',
        sourceDoc: 'fixture',
        verifiedOn: '2026-01-01',
      }],
    }]])
    // 指南索引如今只有主题词、没有节文本，因此每条指南引用都报「未核验」；一旦按本节转录，
    // 逐字引用该节的命题就会因文本承载而通过，即便主题词没点到它。
    const proposition = '需要指定答复期限的，该指定答复期限一般为一个月'
    expect(topicOverlap(['文件的转送'], proposition)).toBe(false)
    expect(verifyCitation(sectionRef('第四部分第三章4.4.1'), index, { proposition }).decision).toBe('valid')
  })

  it('reports an indexed section whose content has not been transcribed', () => {
    const finding = verifyCitation(sectionRef('第五部分第七章2.1'), baselines())
    expect(finding.decision).toBe('unverified')
    expect(finding.reason).toContain('尚未转录核验')
  })

  it('reports a section the index does not hold', () => {
    expect(verifyCitation(sectionRef('第九部分第九章9.9'), baselines()).decision).toBe('not-indexed')
  })
})

describe('verifyCitations', () => {
  it('decides every reference in a text, in order', () => {
    const findings = verifyCitations('依据专利法第22条第3款与专利法第99条。', baselines())
    expect(findings.map(finding => finding.decision)).toEqual(['valid', 'out-of-range'])
  })

  it('returns nothing for text without a reference', () => {
    expect(verifyCitations('本案未引用条文。', baselines())).toEqual([])
  })
})

describe('resolveCitationPolicy', () => {
  const policies: CitationPolicySet = {
    mismatch: 'warn',
    unmatched: 'block',
    outOfRange: 'block',
    notIndexed: 'allow',
    unverified: 'warn',
  }
  const reference = articleRef(22)

  it('maps each decision to its policy and always allows a valid citation', () => {
    expect(resolveCitationPolicy({ raw: 'r', reference, decision: 'valid', reason: '' }, policies)).toBe('allow')
    expect(resolveCitationPolicy({ raw: 'r', reference, decision: 'mismatch', reason: '' }, policies)).toBe('warn')
    expect(resolveCitationPolicy({ raw: 'r', reference, decision: 'unmatched', reason: '' }, policies)).toBe('block')
    expect(resolveCitationPolicy({ raw: 'r', reference, decision: 'out-of-range', reason: '' }, policies)).toBe('block')
    expect(resolveCitationPolicy({ raw: 'r', reference, decision: 'not-indexed', reason: '' }, policies)).toBe('allow')
    expect(resolveCitationPolicy({ raw: 'r', reference, decision: 'unverified', reason: '' }, policies)).toBe('warn')
  })

  it('blocks a mismatch or an out-of-range citation by default, and only warns on an undecided one', () => {
    expect(DEFAULT_CITATION_POLICY).toEqual({
      mismatch: 'block',
      unmatched: 'warn',
      outOfRange: 'block',
      notIndexed: 'warn',
      unverified: 'warn',
    })
  })
})

describe('rendering', () => {
  it('renders each finding with the law reference and its treatment', () => {
    const report = renderCitationFindings(verifyCitations('依据专利法第22条第3款。', baselines()), DEFAULT_CITATION_POLICY)
    expect(report).toContain('| 《专利法》第二十二条第三款 | 已核验 | 放行 |')
    expect(report.split('\n')).toHaveLength(3)
  })

  it('renders a blocked citation with the written form of its reference', () => {
    const report = renderCitationFindings(verifyCitations('依据专利法第99条。', baselines()), DEFAULT_CITATION_POLICY)
    expect(report).toContain('| 《专利法》第九十九条 | 条号超出有效范围 | 拦截 |')
  })

  it('escapes a pipe in a cell so the table stays a table', () => {
    const report = renderCitationRows([{
      label: '《专利法》第二十二条',
      decision: 'valid',
      policy: 'allow',
      reason: 'a|b',
    }])
    expect(report).toContain('a\\|b')
  })

  it('states that no citation was found instead of reporting success', () => {
    expect(renderCitationRows([])).toContain('未在文本中识别到法条引用')
  })
})

describe('stale guideline sections', () => {
  const container: SectionEntry = {
    path: '第四部分第三章',
    topics: ['无效宣告'],
    text: null,
    sourceDoc: null,
    verifiedOn: null,
  }
  const stale: SectionEntry = {
    path: '第四部分第三章2.1',
    topics: ['一事不再理'],
    text: '修改前正文',
    sourceDoc: 'fixture',
    verifiedOn: '2026-01-01',
  }
  const current: SectionEntry = {
    path: '第二部分第一章1.1',
    topics: ['主题'],
    text: '现行正文',
    sourceDoc: 'fixture',
    verifiedOn: '2026-01-01',
  }
  const baseline: LawBaseline = {
    law: '专利审查指南',
    document: '专利审查指南',
    revision: '2023 年修订版（2024-01-20 施行）',
    supersededBy: '2026 年修订版（2026-01-01 施行）',
    staleSections: [{ path: '第四部分第三章2.1', reason: '2026 年修订版已修改本节' }],
    versions: [],
    maxArticle: null,
    maxVerifiedOn: null,
    maxSource: null,
    articles: [],
    sections: [container, stale, current],
  }
  const index = new Map<LawName, LawBaseline>([['专利审查指南', baseline]])

  it('reports a citation to the stale section as unverified, naming the superseding revision', () => {
    const finding = verifyCitation(sectionRef('第四部分第三章2.1'), index)
    expect(finding.decision).toBe('unverified')
    expect(finding.reason).toContain('2026 年修订版')
    expect(finding.reason).toContain('2026 年修订版已修改本节')
  })

  it('names the stale section without a superseding revision when none is declared', () => {
    const unnamed = new Map<LawName, LawBaseline>([['专利审查指南', { ...baseline, supersededBy: null }]])
    const finding = verifyCitation(sectionRef('第四部分第三章2.1'), unnamed)
    expect(finding.decision).toBe('unverified')
    expect(finding.reason).toContain('新版《专利审查指南》')
  })

  it('treats a parent citation that covers the stale section as unverified', () => {
    expect(verifyCitation(sectionRef('第四部分第三章'), index).decision).toBe('unverified')
  })

  it('leaves an unaffected section verifiable', () => {
    expect(verifyCitation(sectionRef('第二部分第一章1.1'), index).decision).toBe('valid')
  })
})

describe('versioned guideline sections', () => {
  const BASE = '2023 年修订版（2024-01-20 施行）'
  const CURRENT = '2026 年修订版（2026-01-01 施行）'
  const container: SectionEntry = {
    path: '第四部分第三章',
    topics: ['无效宣告'],
    text: null,
    sourceDoc: null,
    verifiedOn: null,
  }
  const base: SectionEntry = {
    path: '第四部分第三章2.1',
    topics: ['一事不再理'],
    text: '以同样的理由和证据再次提出无效宣告请求的，不予受理和审理。',
    sourceDoc: '审查指南 2023',
    verifiedOn: '2026-10-17',
  }
  const revised: SectionEntry = {
    path: '第四部分第三章2.1',
    topics: ['一事不再理'],
    text: '以相同或者实质相同的理由和证据再次提出无效宣告请求的，不予受理和审理。',
    sourceDoc: '审查指南 2026 修改对照表',
    verifiedOn: '2026-10-17',
  }
  const stillStale: SectionEntry = {
    path: '第四部分第三章3.3',
    topics: ['无效宣告'],
    text: '旧版正文',
    sourceDoc: '审查指南 2023',
    verifiedOn: '2026-10-17',
  }
  /** The revised section plus the base text it replaces. */
  const baseline: LawBaseline = {
    law: '专利审查指南',
    document: '专利审查指南',
    revision: BASE,
    supersededBy: CURRENT,
    staleSections: [{ path: '第四部分第三章2.1', reason: '2026 年修订版已修改本节' }],
    versions: [{ revision: CURRENT, sections: [revised] }],
    maxArticle: null,
    maxVerifiedOn: null,
    maxSource: null,
    articles: [],
    sections: [container, base],
  }
  const index = new Map<LawName, LawBaseline>([['专利审查指南', baseline]])
  /** A revision that transcribed one of two stale sections. */
  const partial = new Map<LawName, LawBaseline>([['专利审查指南', {
    ...baseline,
    staleSections: [
      { path: '第四部分第三章2.1', reason: '2026 年修订版已修改本节' },
      { path: '第四部分第三章3.3', reason: '2026 年修订版已修改本节' },
    ],
    sections: [container, base, stillStale],
  }]])

  it('uses the latest transcribed override when no revision is named', () => {
    const finding = verifyCitation(sectionRef('第四部分第三章2.1'), index)
    expect(finding.decision).toBe('valid')
    expect(finding.reason).toContain('2026 修改对照表')
  })

  it('uses the last declared version when several are transcribed', () => {
    const next: SectionEntry = {
      ...revised,
      text: '2027 年的理由和证据表述',
      sourceDoc: '审查指南 2027',
      verifiedOn: '2027-01-01',
    }
    const multi = new Map<LawName, LawBaseline>([['专利审查指南', {
      ...baseline,
      versions: [
        { revision: CURRENT, sections: [revised] },
        { revision: '2027 年修订版', sections: [next] },
      ],
    }]])
    const finding = verifyCitation(sectionRef('第四部分第三章2.1'), multi)
    expect(finding.decision).toBe('valid')
    expect(finding.reason).toContain('审查指南 2027')
  })

  it('keeps an earlier revision when a later one names another section', () => {
    const later: SectionEntry = {
      path: '第四部分第三章3.3',
      topics: ['无效宣告'],
      text: '2027 年的证据规则',
      sourceDoc: '审查指南 2027',
      verifiedOn: '2027-01-01',
    }
    const multi = new Map<LawName, LawBaseline>([['专利审查指南', {
      ...baseline,
      supersededBy: '2027 年修订版',
      versions: [
        { revision: CURRENT, sections: [revised] },
        { revision: '2027 年修订版', sections: [later] },
      ],
    }]])
    const finding = verifyCitation(sectionRef('第四部分第三章2.1'), multi)
    expect(finding.decision).toBe('valid')
    expect(finding.reason).toContain('2026 修改对照表')
  })

  it('uses the transcribed version when no superseding revision is named', () => {
    const unnamed = new Map<LawName, LawBaseline>([['专利审查指南', { ...baseline, supersededBy: null }]])
    const finding = verifyCitation(sectionRef('第四部分第三章2.1'), unnamed)
    expect(finding.decision).toBe('valid')
    expect(finding.reason).toContain('2026 修改对照表')
  })

  it('keeps the base text and stale marks when the current revision is not transcribed', () => {
    const future = new Map<LawName, LawBaseline>([['专利审查指南', {
      ...baseline,
      supersededBy: '2027 年修订版',
    }]])
    const finding = verifyCitation(sectionRef('第四部分第三章2.1'), future)
    expect(finding.decision).toBe('unverified')
    expect(finding.reason).toContain('2027 年修订版')
  })

  it('decides a section a version adds', () => {
    const added: SectionEntry = {
      path: '第四部分第三章3.4',
      topics: ['新增审查事项'],
      text: '新增节正文',
      sourceDoc: '审查指南 2026',
      verifiedOn: '2026-10-17',
    }
    const withAdded = new Map<LawName, LawBaseline>([['专利审查指南', {
      ...baseline,
      versions: [{ revision: CURRENT, sections: [revised, added] }],
    }]])
    const finding = verifyCitation(sectionRef('第四部分第三章3.4'), withAdded)
    expect(finding.decision).toBe('valid')
    expect(finding.entry?.sourceDoc).toBe('审查指南 2026')
  })

  it('decides against the base revision when it is named', () => {
    expect(verifyCitation(sectionRef('第四部分第三章2.1'), index, { revision: BASE }).decision).toBe('unverified')
  })

  it('decides against the named revision', () => {
    const finding = verifyCitation(sectionRef('第四部分第三章2.1'), index, { revision: CURRENT })
    expect(finding.decision).toBe('valid')
    expect(finding.reason).toContain('2026 修改对照表')
  })

  it('reports a revision the index does not carry instead of falling back', () => {
    const finding = verifyCitation(sectionRef('第四部分第三章2.1'), index, { revision: '2025 年修订版' })
    expect(finding.decision).toBe('unverified')
    expect(finding.reason).toContain('2025 年修订版')
  })

  it('lets a parent citation use the revised subsection', () => {
    const finding = verifyCitation(sectionRef('第四部分第三章'), index, {
      proposition: '相同或者实质相同的理由和证据',
    })
    expect(finding.decision).toBe('valid')
  })

  it('keeps a stale section without an override unverified', () => {
    expect(verifyCitation(sectionRef('第四部分第三章3.3'), partial).decision).toBe('unverified')
  })

  it('uses the shipped 2026 overrides for the three transcribed sections', () => {
    const shipped = new Map<LawName, LawBaseline>([['专利审查指南', loadLawBaselines().get('专利审查指南')!]])
    for (const path of ['第二部分第一章4.4', '第四部分第三章2.1', '第四部分第三章3.3']) {
      const current = verifyCitation(sectionRef(path), shipped)
      expect(current.decision).toBe('valid')
      expect(current.entry?.sourceDoc).toContain('2026 年修订版')
      expect(verifyCitation(sectionRef(path), shipped, { revision: BASE }).decision).toBe('unverified')
    }
  })
})

describe('entries without a recorded source', () => {
  /** A verified article and section that carry no source document. */
  const withoutSource = new Map<LawName, LawBaseline>([
    ['专利法', statute({
      articles: [{ ...VERIFIED_ARTICLE, sourceDoc: null }],
    })],
    ['专利审查指南', {
      law: '专利审查指南',
      document: '专利审查指南',
      revision: null,
      supersededBy: null,
      staleSections: [],
      versions: [],
      maxArticle: null,
      maxVerifiedOn: null,
      maxSource: null,
      articles: [],
      sections: [{ ...VERIFIED_SECTION, sourceDoc: null }],
    }],
  ])

  it('reports an entry whose source is missing as unverified', () => {
    expect(verifyCitation(articleRef(22), withoutSource).decision).toBe('unverified')
    expect(verifyCitation(sectionRef('第二部分第四章3.2'), withoutSource).decision).toBe('unverified')
  })
})

describe('proposition reporting', () => {
  it('truncates a long proposition in the reason', () => {
    const proposition = '区别技术特征'.repeat(10)
    const finding = verifyCitation(articleRef(22), baselines(), { proposition })
    expect(finding.decision).toBe('unmatched')
    expect(finding.reason).toContain('…')
  })

  it('treats a blank proposition as no proposition', () => {
    expect(verifyCitation(articleRef(22), baselines(), { proposition: '   ' }).decision).toBe('valid')
  })
})

describe('the packaged index', () => {
  it('accepts a verbatim clause whose topic keywords do not name it', () => {
    const shipped = loadLawBaselines()
    const entry = findArticle(shipped.get('专利法')!, 47)!
    // 第 47 条的文本写「视为自始即不存在」，索引为该条登记的主题词写「视为自始不存在」，
    // 字面互不包含：只看主题词会把这条正确的引用判成不符。
    const proposition = '宣告无效的专利权视为自始即不存在'
    expect(topicOverlap(entry.topics, proposition)).toBe(false)
    expect(verifyCitation(articleRef(47), shipped, { proposition }).decision).toBe('valid')
    const unlisted = '专为科学研究和实验而使用有关专利'
    const experiment = findArticle(shipped.get('专利法')!, 75)!
    expect(topicOverlap(experiment.topics, unlisted)).toBe(false)
    expect(verifyCitation(articleRef(75), shipped, { proposition: unlisted }).decision).toBe('valid')
  })

  it('reports a boilerplate-heavy proposition under the wrong article as a mismatch naming the right one', () => {
    const shipped = loadLawBaselines()
    const referencing = articleRef(71, undefined, '专利法实施细则')
    const proposition = '国务院专利行政部门不予受理'
    const finding = verifyCitation(referencing, shipped, { proposition })
    expect(finding.decision).toBe('mismatch')
    expect(finding.reason).toContain('第 70 条')
  })

  it('moves a paraphrase between undecided and supported with the support threshold', () => {
    const shipped = loadLawBaselines()
    const entry = findArticle(shipped.get('专利法')!, 47)!
    const index = createOverlapIndex(shipped.get('专利法')!.articles.map(article => ({
      label: `第 ${article.article} 条`,
      topics: article.topics,
      text: article.text,
    })))
    // A paraphrase that shares wording with the article without quoting it: no
    // topic names it, and the overlap lands between undecided and supported.
    const proposition = '专利权被宣告无效后，该专利视为从未存在过'
    const overlap = textOverlap(index, proposition, entry.text ?? '')
    expect(topicOverlap(entry.topics, proposition)).toBe(false)
    expect(overlap).toBeGreaterThan(0.2)
    expect(overlap).toBeLessThan(PROPOSITION_SUPPORT_DEFAULT)
    expect(verifyCitation(articleRef(47), shipped, { proposition }).decision).toBe('unmatched')
    expect(verifyCitation(articleRef(47), shipped, { proposition, supportThreshold: overlap }).decision).toBe('valid')
  })

  it('decides a shipped statute citation against its transcribed text', () => {
    const shipped = loadLawBaselines()
    expect(verifyCitation(articleRef(22), shipped).decision).toBe('valid')
    expect(verifyCitation(articleRef(22, undefined, '专利法实施细则'), shipped).decision).toBe('valid')
    // The invalidation chapter is indexed, so the citations the invalidation
    // tools make resolve against its text rather than reporting a gap.
    expect(verifyCitation(articleRef(71, undefined, '专利法实施细则'), shipped).decision).toBe('valid')
    // A verified article ceiling turns a fabricated number into a blocked
    // decision instead of a report that nothing here can say.
    expect(verifyCitation(articleRef(99), shipped).decision).toBe('out-of-range')
    // An article that exists but is not indexed is a gap in the index, not a
    // claim that the number does not exist.
    expect(verifyCitation(articleRef(50, undefined, '专利法实施细则'), shipped).decision).toBe('not-indexed')
  })

  it('holds the invalidation chapter the 2023 revision numbers', () => {
    const baseline = loadLawBaselines().get('专利法实施细则')
    const articles = [69, 70, 71, 72, 73, 74, 75, 76]
    expect(baseline?.articles.filter(entry => articles.includes(entry.article)).map(entry => entry.article))
      .toEqual(articles)
    // 第 71 条 (增加理由或补充证据) and 第 72 条 (转送与指定期限答复) carry the two
    // invalidation periods the deadline tool reports.
    expect(findArticle(baseline!, 71)?.text).toContain('可以在提出无效宣告请求之日起1个月内增加理由或者补充证据')
    expect(findArticle(baseline!, 72)?.text).toContain('转送文件通知书')
    expect(findArticle(baseline!, 75)?.text).toContain('指定的期限不得延长')
  })

  it('rejects a proposition that belongs to another article of the invalidation chapter', () => {
    const shipped = loadLawBaselines()
    const supplement = articleRef(71, undefined, '专利法实施细则')
    expect(verifyCitation(supplement, shipped, { proposition: '在提出无效宣告请求之日起1个月内增加理由或者补充证据' }).decision)
      .toBe('valid')
    expect(verifyCitation(supplement, shipped, { proposition: '国务院专利行政部门不予受理' }).decision)
      .toBe('mismatch')
  })

  it('decides a proposition against the article the index attaches those topics to', () => {
    const shipped = loadLawBaselines()
    const cases = [
      // 实施细则第 42 条 holds the recusal rule; 分案申请 is 第 48 条.
      [42, '初步审查、实质审查、复审和无效宣告程序中审查人员应当回避', 'valid'],
      [42, '分案申请应当在原申请的基础上提出', 'mismatch'],
      // 第 62 条 holds the patentability-evaluation report; 复审请求 is 第 65 条.
      [62, '专利权评价报告请求书应当写明专利申请号或者专利号', 'valid'],
      [62, '复审请求书应当说明理由', 'mismatch'],
      // 第 114 条 holds the registration fee; 印花税 is not a fee the schedule charges.
      [114, '办理登记手续时应当缴纳授予专利权当年的年费', 'valid'],
    ] as const
    for (const [article, proposition, decision] of cases) {
      expect(verifyCitation(articleRef(article, undefined, '专利法实施细则'), shipped, { proposition }).decision)
        .toBe(decision)
    }
  })

  it('transcribes the sections the index registers, leaving parts and chapters to their sections', () => {
    const shipped = loadLawBaselines()
    const sections = shipped.get('专利审查指南')?.sections ?? []
    const transcribed = sections.filter(section => section.text !== null)
    expect(transcribed.length).toBeGreaterThan(40)
    expect(transcribed.every(section => section.sourceDoc !== null && section.verifiedOn !== null)).toBe(true)
    // A part or chapter carries no text of its own; its sections are what a
    // citation to one is decided by.
    expect(sections.filter(section => section.text === null).map(section => section.path))
      .toContain('第二部分第二章')
    expect(verifyCitation(sectionRef('第四部分第三章4.4.1'), shipped, {
      proposition: '当事人提交的意见陈述书及其附件应当一式两份',
    }).decision).toBe('valid')
  })

  it('holds the sections the 2023 revision numbers rather than the repository\u2019s earlier labels', () => {
    const shipped = loadLawBaselines()
    const text = (path: string): string | null | undefined =>
      shipped.get('专利审查指南')?.sections.find(section => section.path === path)?.text
    // 2023 指南把「技术领域」放在 2.2.2（2.2.1 是名称），第九章第 2 节写作「2」而不是
    // 「2.0」，第一部分第一章第 2 节没有子节。转录后的节正文是这两件事的证据：
    // 路径指向的节存在，且该节讲的是它标题所称的内容。
    expect(text('第二部分第二章2.2.2')).toContain('发明或者实用新型的技术领域应当是要求保护的')
    expect(text('第二部分第九章2')).toContain('审查应当针对要求保护的解决方案')
    expect(verifyCitation(sectionRef('第二部分第二章2.2.2'), shipped).decision).toBe('valid')
    expect(verifyCitation(sectionRef('第二部分第九章2'), shipped).decision).toBe('valid')
    expect(verifyCitation(sectionRef('第二部分第二章2.2.1'), shipped).decision).toBe('not-indexed')
    expect(verifyCitation(sectionRef('第二部分第九章2.0'), shipped).decision).toBe('not-indexed')
    expect(verifyCitation(sectionRef('第一部分第一章2.3'), shipped).decision).toBe('not-indexed')
  })

  it('decides a section by what its subsections say', () => {
    const shipped = loadLawBaselines()
    // 第四部分第三章4.4 的正文只有审查方式一段，指定答复期限的规则在 4.4.1。
    const citation = verifyCitation(sectionRef('第四部分第三章4.4'), shipped, {
      proposition: '需要指定答复期限的，该指定答复期限一般为一个月',
    })
    expect(citation.decision).toBe('valid')
    expect(citation.reason).toContain('第四部分第三章4.4.1')
  })

  it('accepts a proposition only a subsection carries, instead of reporting a competing home', () => {
    const shipped = loadLawBaselines()
    // 同一条引用反过来用时：命题落在 4.4.1，而 4.4 覆盖它，因此不能把 4.4.1 当作
    // 命题的另一个归宿而拦截。
    const citation = verifyCitation(sectionRef('第四部分第三章4.4'), shipped, {
      proposition: '当事人期满未答复的，视为当事人已得知转送文件中所涉及的事实、理由和证据，并且未提出反对意见',
    })
    expect(citation.decision).toBe('valid')
    expect(topicOverlap(['无效宣告', '审查方式'], '当事人期满未答复的')).toBe(false)
  })

  it('decides a section-level container by a subsection it covers', () => {
    const shipped = loadLawBaselines()
    // 第二部分第二章3.1 只登记主题词，正文在其子节 3.1.2。
    const citation = verifyCitation(sectionRef('第二部分第二章3.1'), shipped, {
      proposition: '必要技术特征是指，发明或者实用新型为解决其技术问题所不可缺少的技术特征',
    })
    expect(citation.decision).toBe('valid')
    expect(citation.reason).toContain('第二部分第二章3.1.2')
  })

  it('lets a text-less container pass on its own topic keywords', () => {
    const container: SectionEntry = {
      path: '第二部分第二章3.1',
      topics: ['三步法'],
      text: null,
      sourceDoc: null,
      verifiedOn: null,
    }
    const subsection: SectionEntry = {
      path: '第二部分第二章3.1.2',
      topics: ['独立权利要求'],
      text: '与三步法无关的正文',
      sourceDoc: 'fixture',
      verifiedOn: '2026-01-01',
    }
    const index = new Map<LawName, LawBaseline>([['专利审查指南', {
      law: '专利审查指南',
      document: '专利审查指南',
      revision: null,
      supersededBy: null,
      staleSections: [],
      versions: [],
      maxArticle: null,
      maxVerifiedOn: null,
      maxSource: null,
      articles: [],
      sections: [container, subsection],
    }]])
    const citation = verifyCitation(sectionRef('第二部分第二章3.1'), index, { proposition: '三步法' })
    expect(citation.decision).toBe('valid')
    expect(citation.reason).toContain('主题词')
  })

  it('passes a container citation without a proposition, naming its subsections', () => {
    const shipped = loadLawBaselines()
    const citation = verifyCitation(sectionRef('第二部分第二章'), shipped)
    expect(citation.decision).toBe('valid')
    expect(citation.reason).toContain('判定依据其下各节')
  })

  it('decides a chapter by its sections when the chapter carries no text of its own', () => {
    const shipped = loadLawBaselines()
    const citation = verifyCitation(sectionRef('第二部分第二章'), shipped, {
      proposition: '实施例是对发明或者实用新型的优选的具体实施方式的举例说明',
    })
    expect(citation.decision).toBe('valid')
    expect(citation.reason).toContain('本节正文未单独转录')
  })

  it('does not report a subsection as a competing home for the section that covers it', () => {
    // 第二部分第二章3.1 没有自己的正文、只有主题词，且被所引的 第二部分第二章 覆盖；
    // 命题命中它的主题词时，它不能成为「命题的另一个归宿」，否则会误拦该章引用。
    const index = new Map<LawName, LawBaseline>([['专利审查指南', {
      law: '专利审查指南',
      document: '专利审查指南',
      revision: null,
      supersededBy: null,
      staleSections: [],
      versions: [],
      maxArticle: null,
      maxVerifiedOn: null,
      maxSource: null,
      articles: [],
      sections: [
        { path: '第二部分第二章', topics: ['说明书'], text: '说明书应当满足要求。', sourceDoc: 'fixture', verifiedOn: '2026-01-01' },
        { path: '第二部分第二章3.1', topics: ['三步法'], text: null, sourceDoc: null, verifiedOn: null },
        { path: '第四部分第三章4.4.1', topics: ['三步法'], text: null, sourceDoc: null, verifiedOn: null },
      ],
    }]])
    const finding = verifyCitation(sectionRef('第二部分第二章'), index, { proposition: '三步法' })
    expect(finding.decision).toBe('mismatch')
    expect(finding.reason).toContain('第四部分第三章4.4.1')
    expect(finding.reason).not.toContain('第二部分第二章3.1')
  })

  it('does not treat a longer number as a subsection of the cited one', () => {
    // 「2.10」不是「2.1」的子节：按前缀比对会把它当子节，于是命题由另一节承载时
    // 反而被判成成立。
    const index = new Map<LawName, LawBaseline>([['专利审查指南', {
      law: '专利审查指南',
      document: '专利审查指南',
      revision: null,
      supersededBy: null,
      staleSections: [],
      versions: [],
      maxArticle: null,
      maxVerifiedOn: null,
      maxSource: null,
      articles: [],
      sections: [
        { path: '第二部分第九章2.1', topics: ['审查基准'], text: '本节的正文。', sourceDoc: 'fixture', verifiedOn: '2026-01-01' },
        { path: '第二部分第九章2.10', topics: ['审查示例'], text: '本示例部分的正文。', sourceDoc: 'fixture', verifiedOn: '2026-01-01' },
      ],
    }]])
    expect(verifyCitation(sectionRef('第二部分第九章2.1'), index, { proposition: '本示例部分的正文' }).decision)
      .toBe('mismatch')
    expect(verifyCitation(sectionRef('第二部分第九章2.10'), index, { proposition: '本示例部分的正文' }).decision)
      .toBe('valid')
  })

  it('names the chapter that carries a proposition instead of the cited one', () => {
    const shipped = loadLawBaselines()
    const citation = verifyCitation(sectionRef('第二部分第二章'), shipped, {
      proposition: '进入当事人认可的电子系统的日期与通知书和决定的发文日不一致时，该通知书和决定的发文日推定为送达日',
    })
    expect(citation.decision).toBe('mismatch')
    expect(citation.reason).toContain('第五部分第六章2.3.1')
  })

  it('reports a container section whose sections do not carry the proposition', () => {
    const shipped = loadLawBaselines()
    // 第二部分第二章 只登记了章一级条目：章正文未单独转录，命题由该章各节判定。
    const citation = verifyCitation(sectionRef('第二部分第二章'), shipped, {
      proposition: '本章规定了基因序列的保藏要求',
    })
    expect(citation.decision).toBe('unmatched')
    expect(citation.reason).toContain('节正文未转录')
  })

  it('reports a section whose indexed sections are not transcribed', () => {
    const shipped = loadLawBaselines()
    const citation = verifyCitation(sectionRef('第二部分第十章'), shipped)
    expect(citation.decision).toBe('unverified')
    expect(citation.reason).toContain('尚未转录核验')
  })

  it('attaches each guideline topic list to the section it indexes', () => {
    const shipped = loadLawBaselines()
    const topics = (path: string): string[] | undefined =>
      shipped.get('专利审查指南')?.sections.find(section => section.path === path)?.topics
    // 这些行原先挂的是别节的标签：2.3 是说明书附图而不是说明书撰写要求，
    // 2.1 是现有技术而不是章名，4.1 是审查的文本而不是答复。
    expect(topics('第二部分第二章2.3')).toEqual(['附图', '附图标记'])
    expect(topics('第二部分第三章2.1')).toEqual(['现有技术'])
    expect(topics('第二部分第八章4.1')).toEqual(['审查文本', '主动修改'])
    expect(topics('第四部分第三章4.4')).toEqual(['无效宣告', '审查方式'])
    expect(topics('第五部分第七章2.1')).toEqual(['期限', '起算日'])
  })
})
