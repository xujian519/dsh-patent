import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { globalAtomRegistry, globalStageHandlerRegistry } from '@deepseek-ai/dsh-patent-core'
import { builtinPatentManifests } from '@deepseek-ai/dsh-patent-workflow'
import * as tool from '../src/index.ts'

/** The 36 tools registered by patent-tools (render_patent_document is owned by dsh-patent-document). */
const EXPECTED_TOOLS = [
  'patent_search',
  'patent_metadata',
  'patent_legal_status',
  'law_search',
  'patent_case_search',
  'patent_wiki_search',
  'patent_kg_query',
  'patent_eval',
  'draft_claims',
  'draft_specification',
  'validate_specification',
  'rule_check',
  'claim_lint',
  'parse_office_action',
  'patent_worker_validate',
  'patent_plan_task',
  'recognize_chemical_structure',
  'patent_analysis_report',
  'claim_chart_build',
  'patent_workflow_run',
  'flexible_plan',
  'triz_contradiction_analysis',
  'analyze_patent_figure',
  'check_patent_figure_consistency',
  'compare_patent_figure_analysis',
  'evaluate_evidence',
  'patent_workflow',
  'search_patent_figure',
  'generate_patent_figure',
  'generate_structure_figure',
  'add_patent_figure_references',
  'verify_patent_figure',
  'patent_pdf_download',
  'knowledge_note_save',
  'workbench_link_patent_case',
  'matter_log_append',
]

/**
 * Atoms a complete composition registers: patent-core's 24 built-ins plus
 * `slop-gate`, `tighten`, `draft-specification`, `spec-check`, `response-check`,
 * `eligibility`, and `legal-gaps` (registered by this package, not by
 * registerBuiltinAtoms).
 */
const REGISTERED_ATOMS = [
  'adversary-model',
  'adversary-review',
  'amendment-basis',
  'approval-gate',
  'citation-check',
  'claim-chart',
  'compare',
  'conflicting-application',
  'coverage',
  'dispute-framing',
  'dispute-framing-refine',
  'draft-claims',
  'draft-specification',
  'eligibility',
  'enablement-report',
  'evidence-check',
  'extract',
  'figure-analysis',
  'groundedness',
  'grounds',
  'keywords',
  'legal-gaps',
  'merge',
  'novelty',
  'numeric-range',
  'oa-parse',
  'pfe-consistency',
  'prior-art-filter',
  'problem-check',
  'reasoning',
  'response-check',
  'response-plan',
  'search',
  'slop-gate',
  'spec-check',
  'tighten',
  'time-baseline',
]

/** Atoms the built-in manifests declare; `compare`/`reasoning` are graph-only. */
const DECLARED_ATOMS = REGISTERED_ATOMS.filter(name => name !== 'compare' && name !== 'reasoning')

describe('@deepseek-ai/dsh-patent-tools registration', () => {
  it('exports the function-plugin surface', () => {
    expect(tool.name).toBe('patent-tools')
    expect(tool.inject).toContain('tools')
    expect(typeof tool.apply).toBe('function')
  })

  it('registers all 35 tools via ctx.plugin (direct mount)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(tool, {})
    // Exact (order-insensitive) match: a missing, extra, or renamed tool fails.
    expect(ctx.tools.schemas().map(s => s.name).sort()).toEqual([...EXPECTED_TOOLS].sort())
  })

  it('unregisters every registered tool when its contributing fiber is disposed (HMR-safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const fiber = await ctx.plugin(tool, {})
    expect(ctx.tools.schemas().map(s => s.name).sort()).toEqual([...EXPECTED_TOOLS].sort())
    await fiber.dispose()
    expect(ctx.tools.schemas().map(s => s.name)).toEqual([])
  })

  it('does not register render_patent_document (owned by dsh-patent-document)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(tool, {})
    const names = ctx.tools.schemas().map(s => s.name)
    expect(names).not.toContain('render_patent_document')
  })

  it('fails plugin load when a built-in manifest targets another guideline revision', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(tool, { guidelineRevision: '2026 年修订版（2026-01-01 施行）' }))
      .rejects.toThrow(/guidelineRevision/)
  })

  it('fails plugin load when a manifest exceeds the configured stage budget', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(tool, { workflowStageBudget: 20 }))
      .rejects.toThrow(/patent_disclosure_v1 的阶段数 24 超出预算 20/)
  })

  it('fails plugin load when a manifest exceeds the configured model-calling stage budget', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await expect(ctx.plugin(tool, { workflowLlmStageBudget: 8 }))
      .rejects.toThrow(/patent_disclosure_v1 的模型调用阶段数 11 超出预算 8/)
  })

  it('accepts budgets raised to the current built-in manifest sizes', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(tool, { workflowStageBudget: 24, workflowLlmStageBudget: 11 })
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('patent_workflow_run')
  })

  it('每个内置 manifest 声明的 atom 在完整组合下都有契约与 handler（跨包注册：六个 patent-tools 原子属本包）', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(tool, {})
    const declared = new Set(
      builtinPatentManifests.flatMap(manifest =>
        manifest.stages.flatMap(stage => (stage.atom === undefined ? [] : [stage.atom])),
      ),
    )
    // 断言集合非空，避免 manifest 全部去掉 atom 后本用例空转变绿。
    expect([...declared].sort()).toEqual(DECLARED_ATOMS)
    for (const name of declared) {
      expect(globalAtomRegistry.lookup(name)?.name).toBe(name)
      expect(globalStageHandlerRegistry.lookup(name)?.name).toBe(name)
    }
  })

  it('flexible_plan 的 atom 参数说明覆盖每个已注册原子（新增原子即须同步说明）', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(tool, {})
    // 完整组合后注册表含 patent-core 的 26 个内置 + 本包注册的 slop-gate、draft-specification、spec-check、response-check、eligibility 与 legal-gaps。
    expect(globalAtomRegistry.list().map(atom => atom.name).sort()).toEqual(REGISTERED_ATOMS)
    for (const atom of globalAtomRegistry.list()) {
      expect(tool.ATOM_PARAM_DESCRIPTION).toContain(atom.name)
    }
  })
})

describe('model route fallback (B4)', () => {
  it('builds a real port from the deployment default route when Config omits provider/model', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }) })
    let streamed = false
    ctx.provide('llm', {
      stream: async function* () {
        streamed = true
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
    await ctx.plugin(tool, {})
    // claim_chart_build needs a model port: with the default route fallback it
    // must reach the llm stream instead of throwing setup_required.
    const def = ctx.tools.get('claim_chart_build')
    expect(def).toBeDefined()
    // 空 LLM 响应会让 claim-chart 降级抛 tool_execution_failed——这正是真实
    // 端口被使用的证据；关键是绝不能抛 setup_required（那是 fail-loud 桩）。
    try {
      await def!.execute({
        claim_text: '1. 一种装置',
        targets: [],
        mode: 'patentability',
      }, {} as never)
    } catch (error) {
      const code = (error as { code?: string }).code
      expect(code).not.toBe('setup_required')
    }
    expect(streamed).toBe(true)
  })
})
