/** `legal_knowledge_search` tool and its optional companion plugin. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { LegalKnowledge } from '../src/index.ts'
import * as ToolPlugin from '../src/tool.ts'
import {
  createLegalKnowledgeSearchTool,
  type LegalKnowledgeSearchOutput,
} from '../src/tool/search.ts'
import type {
  CaseLawRecord,
  GuidingCaseRecord,
  JudicialInterpretationRecord,
  LegalRegulationRecord,
} from '../src/types.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const tempDirs: string[] = []
const contexts: Context[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'legal-knowledge-tool-'))
  tempDirs.push(dir)
  return dir
}

const CASE_LAW: CaseLawRecord = {
  caseId: 'case-1',
  docType: 'judgment',
  caseName: '合同违约纠纷案',
  court: '北京市第一中级人民法院',
  decisionDate: '2023-01-01',
  caseNumber: '(2023)京01民终1号',
  caseType: '民事',
  fullText: '合同违约责任认定',
}

const REGULATION: LegalRegulationRecord = {
  regulationId: 'reg-1',
  regulationName: '中华人民共和国民法典',
  level: '法律',
  effectiveDate: '2021-01-01',
  validity: 'in-force',
  articleNumber: 577,
  articleText: '当事人一方不履行合同义务的，应当承担违约责任。',
}

const EXPIRED: LegalRegulationRecord = {
  regulationId: 'reg-old',
  regulationName: '旧合同法',
  level: '法律',
  effectiveDate: '1999-10-01',
  expiryDate: '2021-01-01',
  validity: 'expired',
  articleNumber: 107,
  articleText: '违约责任。',
}

const INTERPRETATION: JudicialInterpretationRecord = {
  interpretationId: 'interp-1',
  interpretationName: '合同编通则司法解释',
  interpretationType: 'judicial-interpretation',
  issuingBody: '最高人民法院',
  documentNumber: '法释〔2023〕1号',
  effectiveDate: '2023-12-05',
  validity: 'in-force',
  articleNumber: 1,
  articleText: '合同解释规则。',
}

const GUIDING_CASE: GuidingCaseRecord = {
  caseId: 'gc-1',
  guidingCaseNumber: '指导案例1号',
  caseName: '居间合同纠纷案',
  court: '上海市第二中级人民法院',
  decisionDate: '2011-01-01',
  caseType: '民事',
  keyPoints: '居间合同报酬',
  relatedLaws: ['合同法'],
  fullText: '居间合同全文',
}

async function host(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const service = new LegalKnowledge(ctx, { knowledgeDir: tempDir(), useFts5: false })
  service.addCaseLawRecords([CASE_LAW])
  service.addLegalRegulationRecords([REGULATION, EXPIRED])
  service.addJudicialInterpretationRecords([INTERPRETATION])
  service.addGuidingCaseRecords([GUIDING_CASE])
  await ctx.plugin(ToolPlugin)
  return ctx
}

function execute(ctx: Context, args: unknown) {
  return executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: ToolCallId('legal-knowledge-search'),
    name: 'legal_knowledge_search',
    arguments: args,
  })
}

async function run(ctx: Context, args: unknown): Promise<LegalKnowledgeSearchOutput> {
  const result = await execute(ctx, args)
  expect(result.isError).toBe(false)
  return result.value as LegalKnowledgeSearchOutput
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('legal_knowledge_search tool', () => {
  it('registers through the companion plugin', async () => {
    const ctx = await host()
    expect(ctx.tools.schemas().some(schema => schema.name === 'legal_knowledge_search')).toBe(true)
  })

  it('defaults to regulation scope and renders the summary', async () => {
    const output = await run(await host(), { query: '违约' })
    expect(output.scope).toBe('regulation')
    expect(output.count).toBeGreaterThan(0)
    expect(output.hits[0]).toMatchObject({ regulationId: 'reg-1', validity: 'in-force' })
    expect(output.summary).toContain('法规条文')
    expect(output.summary).toContain('官方法源')
  })

  it('searches each result family through its own scope', async () => {
    const ctx = await host()
    const caseLaw = await run(ctx, { query: '合同', scope: 'case_law' })
    expect(caseLaw.hits[0]).toMatchObject({ caseId: 'case-1' })

    const interpretation = await run(ctx, { query: '合同', scope: 'judicial_interpretation' })
    expect(interpretation.hits[0]).toMatchObject({ interpretationId: 'interp-1' })

    const guiding = await run(ctx, { query: '居间', scope: 'guiding_case' })
    expect(guiding.hits[0]).toMatchObject({ caseId: 'gc-1' })
  })

  it('filters expired regulations by as-of date', async () => {
    const ctx = await host()
    const current = await run(ctx, { query: '违约', asOf: '2024-01-01' })
    expect(current.hits.map(hit => 'regulationId' in hit ? hit.regulationId : '')).not.toContain('reg-old')
    const historical = await run(ctx, { query: '违约', asOf: '2010-01-01' })
    expect(historical.hits.map(hit => 'regulationId' in hit ? hit.regulationId : '')).toContain('reg-old')
  })

  it('explains that an empty result is not proof of absence', async () => {
    const output = await run(await host(), { query: '不存在的关键词' })
    expect(output.count).toBe(0)
    expect(output.summary).toContain('不能据此认定')
  })

  it('rejects an empty query and an unknown scope', async () => {
    const ctx = await host()
    const empty = await execute(ctx, { query: '   ' })
    expect(empty.isError).toBe(true)
    expect(empty.error?.message ?? '').toContain('query 不能为空')
    const nulOnly = await execute(ctx, { query: '\u0000' })
    expect(nulOnly.isError).toBe(true)
    expect(nulOnly.error?.message ?? '').toContain('query 不能为空')

    const unknown = await execute(ctx, { query: '合同', scope: 'statute' })
    expect(unknown.isError).toBe(true)
    expect(unknown.error?.message ?? '').toContain('must be one of')
  })


  it('passes the per-scope filters through to the service', async () => {
    const ctx = await host()
    const cases = await run(ctx, {
      query: '合同',
      scope: 'case_law',
      docType: 'judgment',
      court: '北京',
      caseType: '民事',
    })
    expect(cases.hits[0]).toMatchObject({ caseId: 'case-1', court: '北京市第一中级人民法院' })

    const regulations = await run(ctx, { query: '违约', scope: 'regulation', level: '法律', asOf: '   ' })
    expect(regulations.hits[0]).toMatchObject({ regulationId: 'reg-1' })

    const interpretations = await run(ctx, {
      query: '合同',
      scope: 'judicial_interpretation',
      interpretationType: 'judicial-interpretation',
      asOf: '2024-01-01',
    })
    expect(interpretations.hits[0]).toMatchObject({ interpretationId: 'interp-1' })
  })

  it('clamps limits below one up to one', async () => {
    const output = await run(await host(), { query: '违约\u0000', limit: 0 })
    expect(output.query).toBe('违约')
    expect(output.summary).not.toContain('\u0000')
    expect(output.count).toBe(1)
  })

  it('clamps the limit instead of returning unbounded results', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const service = {
      caseLawSearch: () => [],
      legalSearch: (_query: string, options?: { limit?: number }) => {
        expect(options?.limit).toBe(20)
        return []
      },
      judicialInterpretationSearch: () => [],
      guidingCaseSearch: () => [],
    }
    ctx.tools.register(createLegalKnowledgeSearchTool(service))
    const output = await run(ctx, { query: '合同', limit: 500 })
    expect(output.count).toBe(0)
  })
})
