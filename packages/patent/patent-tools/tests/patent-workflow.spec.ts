import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  globalAtomRegistry,
  globalStageHandlerRegistry,
  registerBuiltinAtoms,
  validateWorkflowManifest,
  type WorkflowRunResult,
} from '@deepseek-ai/dsh-patent-core'
import { builtinPatentManifests } from '@deepseek-ai/dsh-patent-workflow'
import { CONSUME_PROJECTION_KEYS } from '../src/tool/internal/consume-projections.ts'
import { slopGateAtom, SlopGateHandler } from '../src/atoms/slop-gate.ts'
import { tightenAtom, TightenHandler } from '../src/atoms/tighten.ts'
import { draftSpecificationAtom, DraftSpecificationHandler } from '../src/atoms/draft-specification.ts'
import { figureAnalysisAtom, FigureAnalysisHandler } from '../src/atoms/figure-analysis.ts'
import { specCheckAtom, SpecCheckHandler } from '../src/atoms/spec-check.ts'
import { responseCheckAtom, ResponseCheckHandler } from '../src/atoms/response-check.ts'
import { eligibilityAtom, EligibilityHandler } from '../src/atoms/eligibility.ts'
import { legalGapsAtom, LegalGapsHandler } from '../src/atoms/legal-gaps.ts'
import {
  createPatentWorkflowTool,
  renderPatentWorkflow,
  type PatentWorkflowOutput,
} from '../src/tool/patent-workflow.ts'
import {
  buildWorkflowProvider,
  resolveRunPersistTarget,
  resolveWorkflowRunsDir,
  stageFlagAndPreview,
  writeRunArtifacts,
} from '../src/tool/internal/workflow-helpers.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

// 镜像生产装配（B1）：内置原子注册进全局注册表，novelty 等 manifest 的 atom
// 阶段才能通过 runWorkflow 的 fail-fast。
registerBuiltinAtoms()
// 本包自有原子由 apply() 注册；测试直接导入工具函数，需同样登记才能覆盖全部 manifest。
globalAtomRegistry.register(slopGateAtom)
globalStageHandlerRegistry.register(new SlopGateHandler())
globalAtomRegistry.register(tightenAtom)
globalStageHandlerRegistry.register(new TightenHandler())
globalAtomRegistry.register(draftSpecificationAtom)
globalStageHandlerRegistry.register(new DraftSpecificationHandler())
globalAtomRegistry.register(figureAnalysisAtom)
globalStageHandlerRegistry.register(new FigureAnalysisHandler())
globalAtomRegistry.register(specCheckAtom)
globalStageHandlerRegistry.register(new SpecCheckHandler())
globalAtomRegistry.register(responseCheckAtom)
globalStageHandlerRegistry.register(new ResponseCheckHandler())
globalAtomRegistry.register(eligibilityAtom)
globalStageHandlerRegistry.register(new EligibilityHandler())
globalAtomRegistry.register(legalGapsAtom)
globalStageHandlerRegistry.register(new LegalGapsHandler())

const exec = { signal: new AbortController().signal } as unknown as Parameters<ToolDefinition['execute']>[1]

const NOVELTY_OUTPUTS = [
  { stageId: 'dispute-framing', text: 'A22.2 / A22.3；权利要求 1' },
  { stageId: 'parse', text: 'parsed' },
  { stageId: 'time_baseline', text: '2024-06-01' },
  { stageId: 'dispute-framing-refine', text: '时间依据已锁定' },
  { stageId: 'generate_keywords', text: 'keywords' },
  { stageId: 'search', text: 'searched' },
  { stageId: 'prior_art_filter', text: 'no excluded prior art' },
  { stageId: 'conflicting_application', text: 'no conflicting application' },
  { stageId: 'compare', text: 'compared' },
  { stageId: 'numeric_range', text: 'no numeric range' },
  { stageId: 'conclude', text: 'concluded' },
  { stageId: 'citation_check', text: 'citations grounded' },
  { stageId: 'legal_gaps', text: 'no legal gaps' },
  { stageId: 'approval', text: 'approved' },
]

describe('patent_workflow', () => {
  const tool = createPatentWorkflowTool()

  it('registers under patent_workflow', () => {
    expect(tool.name).toBe('patent_workflow')
  })

  it('returns found=false for an unknown manifest with the catalog', async () => {
    const value = (await tool.execute({ manifestId: 'nope' }, exec)) as PatentWorkflowOutput
    expect(value.found).toBe(false)
    expect(value.valid).toBe(false)
    expect(value.available).toEqual(expect.arrayContaining(['patent_novelty_v1', 'patent_disclosure_v1']))
  })

  it('assembles per-stage outputs into a completed run record', async () => {
    const value = (await tool.execute({ manifestId: 'patent_novelty_v1', outputs: NOVELTY_OUTPUTS }, exec)) as PatentWorkflowOutput
    expect(value.found).toBe(true)
    expect(value.valid).toBe(true)
    expect(value.completed).toBe(true)
    expect(value.stages).toHaveLength(14)
    expect(value.degradedSteps).toEqual([])
    expect(value.persistNote).toContain('未启用')
  })

  it('marks missing stages degraded', async () => {
    const value = (await tool.execute(
      { manifestId: 'patent_novelty_v1', outputs: [{ stageId: 'parse', text: 'only-parse' }] },
      exec,
    )) as PatentWorkflowOutput
    expect(value.completed).toBe(false)
    expect(value.degradedSteps.length).toBeGreaterThan(0)
  })

  it('degrades every atom stage instead of crashing when recap supplies no atom output', async () => {
    for (const manifest of builtinPatentManifests) {
      const outputs = manifest.stages
        .filter(stage => stage.atom === undefined)
        .map(stage => ({ stageId: stage.id, text: `${stage.id} 收口产出` }))
      const value = (await tool.execute({ manifestId: manifest.id, outputs }, exec)) as PatentWorkflowOutput
      expect(value.found).toBe(true)
      expect(value.valid).toBe(true)
      expect(value.completed).toBe(false)
      expect([...value.degradedSteps].sort()).toEqual(
        manifest.stages.filter(stage => stage.atom !== undefined).map(stage => stage.id).sort(),
      )
    }
  })

  it('persists the degraded atom stages in the recap run record', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-patent-wf-'))
    const cwdTool = createPatentWorkflowTool({ cwd: temp })
    const manifest = builtinPatentManifests.find(m => m.id === 'patent_invalidation_v1')
    if (manifest === undefined) throw new Error('manifest missing')
    const outputs = manifest.stages
      .filter(stage => stage.atom === undefined)
      .map(stage => ({ stageId: stage.id, text: `${stage.id} 收口产出` }))

    const value = (await cwdTool.execute(
      { manifestId: manifest.id, outputs, caseId: 'case-9' },
      exec,
    )) as PatentWorkflowOutput
    expect(value.persistNote).toContain('持久化:')

    const file = join(temp, 'data/cases/case-9/workflow-runs/case-9__patent_invalidation_v1.json')
    const record = JSON.parse(await readFile(file, 'utf8')) as WorkflowRunResult
    expect(record.completed).toBe(false)
    expect(record.degradedSteps).toEqual(expect.arrayContaining(['evidence-check', 'citation-check', 'legal_gaps']))
    for (const stageId of ['evidence-check', 'citation-check', 'legal_gaps']) {
      expect(record.stages.find(stage => stage.stageId === stageId)?.degraded).toBe(true)
    }
  })

  it('renders unknown-manifest and assembled-summary prose', () => {
    const unknown = renderPatentWorkflow({
      manifestId: 'nope',
      found: false,
      valid: false,
      completed: false,
      caseType: '',
      stages: [],
      degradedSteps: [],
      summary: '',
      persistNote: '',
      available: ['patent_novelty_v1'],
    })
    expect(unknown).toContain('未知 manifest "nope"')

    const bareUnknown = renderPatentWorkflow({
      manifestId: 'nope',
      found: false,
      valid: false,
      completed: false,
      caseType: '',
      stages: [],
      degradedSteps: [],
      summary: '',
      persistNote: '',
    })
    expect(bareUnknown).toContain('可用: ')

    const assembled = renderPatentWorkflow({
      manifestId: 'patent_novelty_v1',
      found: true,
      valid: true,
      completed: true,
      caseType: 'novelty_search',
      stages: [{ stageId: 'parse', strategy: 'chain', output: 'parsed', degraded: false, retries: 0 }],
      degradedSteps: [],
      summary: '工作流 patent_novelty_v1（专利新颖性分析）: 1/1 阶段完成',
      persistNote: '持久化: 未启用（未提供 caseId）',
    })
    expect(assembled).toContain('patent_workflow(patent_novelty_v1)')
    expect(assembled).toContain('- ✅ parse (chain): parsed')
    expect(assembled).toContain('完成状态: completed')
  })

  it('defaults the manifest id, omits outputs, and persists with a case id', async () => {
    const defaulted = (await tool.execute({}, exec)) as PatentWorkflowOutput
    expect(defaulted.found).toBe(true)
    expect(defaulted.manifestId).toBe('patent_novelty_v1')
    expect(defaulted.completed).toBe(false)

    temp = await mkdtemp(join(tmpdir(), 'dsh-patent-wf-'))
    const cwdTool = createPatentWorkflowTool({ cwd: temp })
    const persisted = (await cwdTool.execute(
      { manifestId: 'patent_novelty_v1', outputs: NOVELTY_OUTPUTS, caseId: 'case-1' },
      exec,
    )) as PatentWorkflowOutput
    expect(persisted.persistNote).toContain('持久化:')
  })

  it('renders through the registered tool', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.tools.register(createPatentWorkflowTool())
    const signal = new AbortController().signal
    const result = await executeToolFixture(ctx, {
      signal,
      callId: ToolCallId('pw-1'),
      name: 'patent_workflow',
      arguments: { manifestId: 'patent_novelty_v1', outputs: NOVELTY_OUTPUTS },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const text = result.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
    expect(text).toContain('patent_workflow(patent_novelty_v1)')
  })
})

let temp: string | undefined

afterEach(async () => {
  if (temp !== undefined) {
    await rm(temp, { recursive: true, force: true })
    temp = undefined
  }
})

describe('workflow-helpers', () => {
  it('copies writingSkillsForStage onto the assembled provider', () => {
    const writingSkillsForStage = (): string | undefined => 'skills'
    const provider = buildWorkflowProvider({
      model: { stream: async function* () { yield { type: 'done' } } },
      writingSkillsForStage,
    })
    expect(provider?.writingSkillsForStage).toBe(writingSkillsForStage)
  })

  it('resolves the runs dir for absolute, path-like, and plain case ids', () => {
    const cwd = '/base'
    expect(resolveWorkflowRunsDir('/abs/case', cwd)).toBe('/abs/case/workflow-runs')
    expect(resolveWorkflowRunsDir('a/b/case', cwd)).toBe('/base/a/b/case/workflow-runs')
    expect(resolveWorkflowRunsDir('plain', cwd)).toBe('/base/data/cases/plain/workflow-runs')
    const absolute = resolveRunPersistTarget('/abs/case', 'patent_novelty_v1', cwd)
    expect(absolute?.runId).toBe('case__patent_novelty_v1')
    const pathLike = resolveRunPersistTarget('a/b/case', 'patent_novelty_v1', cwd)
    expect(pathLike?.runId).toBe('case__patent_novelty_v1')
    expect(resolveRunPersistTarget(undefined, 'm', cwd)).toBeUndefined()
  })

  it('reports a persist failure instead of throwing', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-patent-wf-'))
    const target = {
      runsDir: temp,
      runId: 'case__patent_novelty_v1',
    }
    const manifest = builtinPatentManifests.find(m => m.id === 'patent_novelty_v1')
    if (manifest === undefined) throw new Error('manifest missing')
    const result = {
      manifestId: 'patent_novelty_v1',
      caseType: 'novelty_search',
      summary: 's',
      completed: true,
      stages: [],
      degradedSteps: [],
      persistWarning: undefined,
    } as unknown as WorkflowRunResult
    const note = await writeRunArtifacts(target, manifest, result)
    expect(note).toContain('持久化:')

    // runsDir pointing at a regular file makes the atomic write fail → the catch path.
    const filePath = join(temp, 'blocker')
    const { writeFile: wf } = await import('node:fs/promises')
    await wf(filePath, 'x')
    const failed = await writeRunArtifacts({ runsDir: filePath, runId: 'x' }, manifest, result)
    expect(failed).toContain('持久化失败:')
  })

  it('formats stage flags and previews', () => {
    expect(stageFlagAndPreview({ stageId: 's', strategy: 'chain', output: '', degraded: false, retries: 0 })).toEqual({ flag: '✅', preview: '(无输出)' })
    expect(stageFlagAndPreview({ stageId: 's', strategy: 'chain', output: '短', degraded: true, retries: 0 })).toEqual({ flag: '⚠️ 降级', preview: '短' })
    const long = stageFlagAndPreview({ stageId: 's', strategy: 'chain', output: '长'.repeat(90), degraded: false, retries: 0 })
    expect(long.preview).toBe(`${'长'.repeat(80)}…（截断，完整内容见 run 记录）`)
  })

  it('atom 阶段的预览上限宽于 executor 阶段（原子输出模型无处可读，需完整呈现）', () => {
    const output = `${'补'.repeat(120)}{"outcome":"not-covered"}`
    const executor = stageFlagAndPreview({ stageId: 's', strategy: 'chain', output, degraded: false, retries: 0 })
    const atom = stageFlagAndPreview({ stageId: 's', strategy: 'chain', atom: 'coverage', output, degraded: false, retries: 0 })
    expect(executor.preview).not.toContain('outcome')
    expect(atom.preview).toContain('outcome')
    expect(atom.preview).not.toContain('截断')
    const huge = stageFlagAndPreview({ stageId: 's', strategy: 'chain', atom: 'coverage', output: 'x'.repeat(2500), degraded: false, retries: 0 })
    expect(huge.preview).toBe(`${'x'.repeat(2000)}…（截断，完整内容见 run 记录）`)
  })
})

describe('consumes 投影名册', () => {
  it('内置 manifest 用到的投影全部已注册（manifest 层 fail-loud 名册与运行期注册表一致）', () => {
    for (const manifest of builtinPatentManifests) {
      expect(() => { validateWorkflowManifest(manifest, { projections: CONSUME_PROJECTION_KEYS }) })
        .not.toThrow()
    }
  })

  it('答复链的 draft 只取解析摘要与对照表结论行，不再全文注入两份结构化产出', () => {
    const draft = builtinPatentManifests
      .find(manifest => manifest.id === 'patent_oa_response_v1')
      ?.stages.find(stage => stage.id === 'draft')
    expect(draft?.consumes).toContain('parse#oa-summary')
    expect(draft?.consumes).toContain('claim-chart#rows')
    // 全文形态不该同时留着：同一份产出注入两遍既重复又抵消投影的意义。
    expect(draft?.consumes).not.toContain('parse')
    expect(draft?.consumes).not.toContain('claim-chart')
  })
})
