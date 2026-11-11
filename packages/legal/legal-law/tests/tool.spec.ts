import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createLegalLawIndex } from '../src/baseline.ts'
import { createLegalLawVerifyTool, type LegalLawVerifyOutput } from '../src/tool/law-verify.ts'
import type { LegalCitationPolicySet, LegalLawBaseline, LegalLawIndex, LegalLawName } from '../src/types.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const POLICIES: LegalCitationPolicySet = {
  mismatch: 'block',
  unmatched: 'warn',
  outOfRange: 'block',
  notIndexed: 'warn',
  unverified: 'warn',
}

// The shipped index parses a law only when a citation names it, so module load
// costs one manifest read on the first shipped-index call.
const shipped = createLegalLawIndex()

const verifiedIndex = new Map<LegalLawName, LegalLawBaseline>([['民法典', {
  law: '民法典',
  document: '中华人民共和国民法典',
  revision: null,
  maxArticle: 1260,
  maxVerifiedOn: '2026-10-23',
  maxSource: 'fixture',
  articles: [{
    article: 143,
    topics: ['民事法律行为', '有效条件'],
    text: '具备下列条件的民事法律行为有效：（一）行为人具有相应的民事行为能力；（二）意思表示真实；',
    sourceDoc: '官方全文',
    verifiedOn: '2026-10-23',
  }],
}]])

const twoArticleIndex = new Map<LegalLawName, LegalLawBaseline>([['民法典', {
  ...verifiedIndex.get('民法典')!,
  articles: [
    ...verifiedIndex.get('民法典')!.articles,
    {
      article: 577,
      topics: ['违约责任'],
      text: '当事人一方不履行合同义务或者履行合同义务不符合约定的，应当承担继续履行、采取补救措施或者赔偿损失等违约责任。',
      sourceDoc: '官方全文',
      verifiedOn: '2026-10-23',
    },
  ],
}]])

async function host(
  index: Map<LegalLawName, LegalLawBaseline> | LegalLawIndex = shipped,
  policies = POLICIES,
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  ctx.tools.register(createLegalLawVerifyTool({ baselines: index, policies }))
  return ctx
}

function execute(ctx: Context, args: unknown) {
  return executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId('legal-law-verify'),
    name: 'legal_law_verify',
    arguments: args,
  })
}

async function run(ctx: Context, args: unknown): Promise<LegalLawVerifyOutput> {
  const result = await execute(ctx, args)
  expect(result.isError).toBe(false)
  return result.value as LegalLawVerifyOutput
}

describe('legal_law_verify tool', () => {
  // host() loads SystemPrompt + ToolRuntime plugins; allow extra time.
  const HOST_TIMEOUT = 15_000

  it('decides a transcribed citation from the verified index', async () => {
    // Use the verifiedIndex fixture which has transcribed text
    const value = await run(await host(verifiedIndex), { text: '根据民法典第143条的规定' })
    expect(value.findings).toHaveLength(1)
    expect(value.findings[0]!.decision).toBe('valid')
    expect(value.findings[0]!.law).toBe('民法典')
    expect(value.findings[0]!.article).toBe(143)
    expect(value.blocked).toBe(false)
  }, HOST_TIMEOUT)

  it('verifies a transcribed entry from the shipped index', async () => {
    // The shipped index transcribes the core statutes, 民法典 among them.
    const value = await run(await host(), { text: '根据民法典第143条的规定' })
    expect(value.findings).toHaveLength(1)
    expect(value.findings[0]!.decision).toBe('valid')
    expect(value.findings[0]!.law).toBe('民法典')
    expect(value.findings[0]!.article).toBe(143)
  }, HOST_TIMEOUT)

  it('reports unverified for an indexed entry whose text is missing', async () => {
    const untranscribed = new Map<LegalLawName, LegalLawBaseline>([['民法典', {
      ...verifiedIndex.get('民法典')!,
      articles: [{ article: 143, topics: [], text: null, sourceDoc: null, verifiedOn: null }],
    }]])
    const value = await run(await host(untranscribed), { text: '根据民法典第143条的规定' })
    expect(value.findings).toHaveLength(1)
    expect(value.findings[0]!.decision).toBe('unverified')
  }, HOST_TIMEOUT)

  it('accepts a citation the verified index has transcribed', async () => {
    const value = await run(await host(verifiedIndex), { references: ['民法典第143条'] })
    expect(value.findings[0]).toMatchObject({ decision: 'valid', policy: 'allow' })
    expect(value.blocked).toBe(false)
  }, HOST_TIMEOUT)

  it('blocks a citation beyond the valid article range', async () => {
    const value = await run(await host(verifiedIndex), { references: ['民法典第9999条'] })
    expect(value.findings[0]).toMatchObject({ decision: 'out-of-range', policy: 'block' })
    expect(value.blocked).toBe(true)
  }, HOST_TIMEOUT)

  it('warns on a proposition no entry supports', async () => {
    const value = await run(await host(verifiedIndex), {
      references: ['民法典第143条'],
      proposition: '劳动合同解除的经济补偿',
    })
    expect(value.findings[0]).toMatchObject({ decision: 'unmatched', policy: 'warn' })
    expect(value.blocked).toBe(false)
  }, HOST_TIMEOUT)

  it('blocks a proposition another verified article carries', async () => {
    const value = await run(await host(twoArticleIndex), {
      references: ['民法典第143条'],
      proposition: '不履行合同义务的违约责任',
    })
    expect(value.findings[0]).toMatchObject({ decision: 'mismatch', policy: 'block' })
    expect(value.blocked).toBe(true)
  }, HOST_TIMEOUT)

  it('reports an unparseable reference as an input error', async () => {
    const ctx = await host()
    const result = await execute(ctx, { references: ['见前述条款'] })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('无法把「见前述条款」解析为单条法条引用')
  }, HOST_TIMEOUT)

  it('lists an unreadable paragraph from text and does not check it as the bare article', async () => {
    const value = await run(await host(verifiedIndex), { text: '民法典第143条第十十款' })
    expect(value.findings).toEqual([])
    expect(value.unrecognized).toEqual(['第143条', '第十十款'])
    expect(value.blocked).toBe(false)
  }, HOST_TIMEOUT)

  it('rejects an unreadable paragraph passed as a reference', async () => {
    const result = await execute(await host(verifiedIndex), { references: ['民法典第143条第十十款'] })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('无法把「民法典第143条第十十款」解析为单条法条引用')
  }, HOST_TIMEOUT)

  it('keeps a malformed citation visible beside a resolved citation of the same article', async () => {
    const value = await run(await host(verifiedIndex), {
      text: '民法典第143条第2款。另见民法典第143条第十十款',
    })
    expect(value.findings).toHaveLength(1)
    expect(value.findings[0]).toMatchObject({ article: 143, paragraph: 2 })
    expect(value.unrecognized).toEqual(['第143条', '第十十款'])
    expect(value.blocked).toBe(false)
  }, HOST_TIMEOUT)

  it('reports a call with neither text nor references as an input error', async () => {
    const ctx = await host()
    const result = await execute(ctx, {})
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('至少要给出 text 或 references 之一')
  }, HOST_TIMEOUT)

  it('rejects blank text when no references are given', async () => {
    const ctx = await host()
    for (const text of ['', ' \n\t ']) {
      const result = await execute(ctx, { text })
      expect(result.isError).toBe(true)
      expect(JSON.stringify(result.content)).toContain('text 不能为空白')
    }
  }, HOST_TIMEOUT)

  it('renders a Markdown decision table', async () => {
    const ctx = await host(verifiedIndex)
    const result = await execute(ctx, { references: ['民法典第143条'] })
    expect(JSON.stringify(result.content)).toContain('| 引用 | 判定 | 处置 | 说明 |')
  }, HOST_TIMEOUT)

  it('renders the blocked warning when a citation is intercepted', async () => {
    const ctx = await host(verifiedIndex)
    const result = await execute(ctx, { references: ['民法典第9999条'] })
    expect(JSON.stringify(result.content)).toContain('**存在被拦截的引用**')
  }, HOST_TIMEOUT)

  it('renders the no-citation notice for text without references', async () => {
    const ctx = await host()
    const result = await execute(ctx, { text: '本案未引用任何法条。' })
    expect(JSON.stringify(result.content)).toContain('未在文本中识别到法条引用')
  }, HOST_TIMEOUT)

  it('reports unrecognized citation fragments', async () => {
    const ctx = await host()
    const result = await execute(ctx, { text: '民法典第143条，另见第999条。' })
    expect(JSON.stringify(result.content)).toContain('未被识别')
  }, HOST_TIMEOUT)

  it('checks multiple citations in a single text', async () => {
    const value = await run(await host(), { text: '民法典第143条和劳动合同法第10条' })
    expect(value.findings.length).toBeGreaterThanOrEqual(2)
  }, HOST_TIMEOUT)

  it('counts decisions correctly', async () => {
    const value = await run(await host(verifiedIndex), {
      references: ['民法典第143条', '民法典第9999条'],
    })
    expect(value.counts.valid).toBe(1)
    expect(value.counts['out-of-range']).toBe(1)
  }, HOST_TIMEOUT)

  it('rejects an unusable call before it reads the index', async () => {
    const reads: string[] = []
    const index: LegalLawIndex = {
      loadNames: async () => {
        reads.push('names')
        return []
      },
      load: async () => {
        reads.push('laws')
        return verifiedIndex
      },
    }
    const ctx = await host(index)
    for (const args of [{}, { text: ' \n\t ' }]) {
      expect((await execute(ctx, args)).isError).toBe(true)
    }
    expect(reads).toEqual([])
  }, HOST_TIMEOUT)

  it('rejects an unparsable reference before it loads a law', async () => {
    const loads: LegalLawName[][] = []
    const index: LegalLawIndex = {
      loadNames: async () => [],
      load: async (laws) => {
        loads.push([...laws])
        return verifiedIndex
      },
    }
    const result = await execute(await host(index), { references: ['见前述条款'] })
    expect(result.isError).toBe(true)
    expect(loads).toEqual([])
  }, HOST_TIMEOUT)

  it('loads only the laws the references name', async () => {
    const loads: LegalLawName[][] = []
    const index: LegalLawIndex = {
      loadNames: async () => [],
      load: async (laws) => {
        loads.push([...laws])
        return verifiedIndex
      },
    }
    await run(await host(index), { text: '根据民法典第143条和劳动合同法第10条' })
    expect(loads).toEqual([['民法典', '劳动合同法']])
  }, HOST_TIMEOUT)

  it('forwards the caller cancellation signal to the index', async () => {
    let seen: AbortSignal | undefined
    const index: LegalLawIndex = {
      loadNames: async (signal) => {
        seen = signal
        return []
      },
      load: async () => verifiedIndex,
    }
    await run(await host(index), { references: ['民法典第143条'] })
    expect(seen).toBeInstanceOf(AbortSignal)
  }, HOST_TIMEOUT)
})
