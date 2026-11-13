import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { loadLawBaselines } from '../src/baseline.ts'
import { createLawVerifyTool, type LawVerifyOutput } from '../src/tool/law-verify.ts'
import type { CitationPolicySet, LawBaseline, LawName } from '../src/types.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const POLICIES: CitationPolicySet = {
  mismatch: 'block',
  unmatched: 'warn',
  outOfRange: 'block',
  notIndexed: 'warn',
  unverified: 'warn',
}

/** The packaged index: transcribed statutes and guideline sections, with the 2026 overrides. */
const shipped = loadLawBaselines()

/** A baseline whose single article is fully verified, for the accepted path. */
const verifiedIndex = new Map<LawName, LawBaseline>([['专利法', {
  law: '专利法',
  document: '中华人民共和国专利法',
  revision: null,
  supersededBy: null,
  staleSections: [],
  versions: [],
  maxArticle: 82,
  maxVerifiedOn: '2026-01-01',
  maxSource: 'fixture',
  articles: [{
    article: 22,
    topics: ['新颖性', '创造性'],
    text: '现行条文',
    sourceDoc: '主席令第五十五号',
    verifiedOn: '2026-01-01',
  }],
  sections: [],
}]])

/** A baseline whose two articles are verified, so one proposition has a wrong home to be attributed to. */
const twoArticleIndex = new Map<LawName, LawBaseline>([['专利法', {
  ...verifiedIndex.get('专利法')!,
  articles: [
    ...verifiedIndex.get('专利法')!.articles,
    {
      article: 26,
      topics: ['说明书充分公开'],
      text: '说明书应当对发明或者实用新型作出清楚、完整的说明。',
      sourceDoc: 'fixture',
      verifiedOn: '2026-01-01',
    },
  ],
}]])

/** The packaged index with one extra section that has neither text nor subsections. */
function withUntranscribedSection(): Map<LawName, LawBaseline> {
  const index = new Map(shipped)
  const guideline = shipped.get('专利审查指南')!
  index.set('专利审查指南', {
    ...guideline,
    sections: [
      ...guideline.sections,
      { path: '第九部分第九章9.9', topics: ['未转录'], text: null, sourceDoc: null, verifiedOn: null },
    ],
  })
  return index
}

async function host(index = shipped, policies = POLICIES): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.tools.register(createLawVerifyTool({ baselines: index, policies }))
  return ctx
}

function execute(ctx: Context, args: unknown) {
  return executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId('law-verify'),
    name: 'law_verify',
    arguments: args,
  })
}

/** Execute and return the canonical output value. */
async function run(ctx: Context, args: unknown): Promise<LawVerifyOutput> {
  const result = await execute(ctx, args)
  expect(result.isError).toBe(false)
  return result.value as LawVerifyOutput
}

describe('law_verify tool', () => {
  it('decides a transcribed statute citation and a transcribed guideline citation alike', async () => {
    const value = await run(await host(), { text: '依据专利法第22条第3款与审查指南第二部分第四章3.2.1.1。' })
    expect(value.findings.map(finding => finding.raw)).toEqual(['专利法第22条第3款', '审查指南第二部分第四章3.2.1.1'])
    expect(value.findings.map(finding => finding.decision)).toEqual(['valid', 'valid'])
    expect(value.blocked).toBe(false)
    expect(value.counts.valid).toBe(2)
    expect(value.findings[0]).toMatchObject({ law: '专利法', article: 22, paragraph: 3 })
    expect(value.findings[1]).toMatchObject({ law: '专利审查指南', sectionPath: '第二部分第四章3.2.1.1' })
  })

  it('uses the latest transcribed guideline revision by default', async () => {
    const value = await run(await host(), { references: ['审查指南第四部分第三章2.1'] })
    expect(value.findings[0]).toMatchObject({ decision: 'valid', policy: 'allow' })
    expect(value.findings[0]?.reason).toContain('2026 年修订版')
  })

  it('reports a guideline section whose indexed sections are not transcribed', async () => {
    const value = await run(await host(withUntranscribedSection()), { references: ['审查指南第九部分第九章9.9'] })
    expect(value.findings[0]).toMatchObject({ decision: 'unverified', policy: 'warn' })
    expect(value.blocked).toBe(false)
    expect(value.counts.unverified).toBe(1)
  })

  it('accepts a citation the index has verified', async () => {
    const value = await run(await host(verifiedIndex), { references: ['专利法第22条第3款'] })
    expect(value.findings[0]).toMatchObject({ decision: 'valid', policy: 'allow' })
    expect(value.blocked).toBe(false)
  })

  it('blocks a citation straight out of the valid article range', async () => {
    const value = await run(await host(verifiedIndex), { references: ['专利法第99条'] })
    expect(value.findings[0]).toMatchObject({ decision: 'out-of-range', policy: 'block' })
    expect(value.blocked).toBe(true)
    expect(value.counts['out-of-range']).toBe(1)
  })

  it('warns on a proposition no entry supports instead of blocking the citation', async () => {
    const value = await run(await host(verifiedIndex), {
      references: ['专利法第22条第3款'],
      proposition: '说明书充分公开',
    })
    expect(value.findings[0]).toMatchObject({ decision: 'unmatched', policy: 'warn' })
    expect(value.blocked).toBe(false)
    expect(value.counts.unmatched).toBe(1)
  })

  it('blocks a proposition another verified article carries, and names it', async () => {
    const value = await run(await host(twoArticleIndex), {
      references: ['专利法第22条第3款'],
      proposition: '说明书充分公开',
    })
    expect(value.findings[0]).toMatchObject({ decision: 'mismatch', policy: 'block' })
    expect(value.findings[0]?.reason).toContain('第 26 条')
    expect(value.blocked).toBe(true)
  })

  it('reports an unparseable reference as an input error instead of skipping it', async () => {
    const ctx = await host()
    const result = await execute(ctx, { references: ['见前述条款'] })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('无法把「见前述条款」解析为单条法条引用')
  })

  it('lists an unreadable paragraph from text and does not check it as the bare article', async () => {
    const value = await run(await host(verifiedIndex), { text: '专利法第22条第十十款' })
    expect(value.findings).toEqual([])
    expect(value.unrecognized).toEqual(['第22条', '第十十款'])
    expect(value.blocked).toBe(false)
  })

  it('rejects an unreadable paragraph passed as a reference', async () => {
    const result = await execute(await host(verifiedIndex), { references: ['专利法第22条第十十款'] })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('无法把「专利法第22条第十十款」解析为单条法条引用')
  })

  it('keeps a malformed citation visible beside a resolved citation of the same article', async () => {
    const value = await run(await host(verifiedIndex), {
      text: '专利法第22条第3款。另见专利法第22条第十十款',
    })
    expect(value.findings).toHaveLength(1)
    expect(value.findings[0]).toMatchObject({ article: 22, paragraph: 3 })
    expect(value.unrecognized).toEqual(['第22条', '第十十款'])
    expect(value.blocked).toBe(false)
  })

  it('reports a call with neither text nor references as an input error', async () => {
    const ctx = await host()
    const result = await execute(ctx, {})
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('至少要给出 text 或 references 之一')
  })

  it('rejects blank text when no references are given, so a zero-byte call cannot satisfy a gate', async () => {
    const ctx = await host()
    for (const text of ['', ' \n\t ']) {
      const result = await execute(ctx, { text })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('text 不能为空白')
    }
  })

  it('still checks explicit references when text is absent or blank', async () => {
    for (const args of [{ references: ['专利法第22条第3款'] }, { text: ' \n', references: ['专利法第22条第3款'] }]) {
      const value = await run(await host(verifiedIndex), args)
      expect(value.findings).toHaveLength(1)
      expect(value.findings[0]).toMatchObject({ decision: 'valid' })
    }
  })

  it('renders a decision table with the unverified warning', async () => {
    const ctx = await host(withUntranscribedSection())
    const result = await execute(ctx, { text: '依据审查指南第九部分第九章9.9。' })
    expect(JSON.stringify(result.content)).toContain('| 引用 | 判定 | 处置 | 说明 |')
    expect(JSON.stringify(result.content)).toContain('存在未核验引用')
  })

  it('renders the blocked warning when a citation is intercepted', async () => {
    const ctx = await host(verifiedIndex)
    const result = await execute(ctx, { references: ['专利法第99条'] })
    expect(JSON.stringify(result.content)).toContain('**存在被拦截的引用**')
  })

  it('renders the no-citation notice for text without references', async () => {
    const ctx = await host()
    const result = await execute(ctx, { text: '本案未引用条文。' })
    expect(JSON.stringify(result.content)).toContain('未在文本中识别到法条引用')
  })

  it('checks the spaced citation style the shipped skills use', async () => {
    const ctx = await host()
    const result = await execute(ctx, { text: '依据《专利法》第 22 条第 3 款，权利要求 1 不具备创造性。' })
    const value = result.value as LawVerifyOutput
    expect(value.findings).toHaveLength(1)
    expect(value.findings[0]).toMatchObject({ article: 22, paragraph: 3, decision: 'valid' })
    expect(value.unrecognized).toEqual([])
    expect(JSON.stringify(result.content)).toContain('《专利法》第二十二条第三款')
  })

  it('renders a citation beyond the Chinese numeral range without throwing', async () => {
    const ctx = await host()
    const result = await execute(ctx, { text: '专利法第1000条。' })
    const value = result.value as LawVerifyOutput
    expect(result.isError).toBe(false)
    expect(value.blocked).toBe(true)
    expect(JSON.stringify(result.content)).toContain('《专利法》第1000条')
  })

  it('checks every coordinated citation and reports the unresolved ones', async () => {
    const ctx = await host()
    const value = await run(ctx, { text: '专利法第22条第5款、第22条第2款、第22条第3款；另见第99条。' })
    expect(value.findings).toHaveLength(3)
    expect(value.findings.map(finding => finding.paragraph)).toEqual([5, 2, 3])
    expect(value.unrecognized).toEqual(['第99条'])
    expect(value.blocked).toBe(false)
  })

  it('reports the item number of a reference', async () => {
    const ctx = await host()
    const value = await run(ctx, { references: ['专利法第22条第3款第2项'] })
    expect(value.findings[0]?.item).toBe(2)
    expect(value.unrecognized).toEqual([])
  })

  it('renders the unresolved-fragment warning', async () => {
    const ctx = await host()
    const result = await execute(ctx, { text: '专利法第22条，另见第99条。' })
    expect(JSON.stringify(result.content)).toContain('未被识别')
  })
})
