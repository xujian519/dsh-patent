import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  caseWorkflowRunsDir,
  globalAtomRegistry,
  globalStageHandlerRegistry,
  registerBuiltinAtoms,
  StageHandlerRegistry,
  type PatentModelPort,
  type RuleEvaluator,
  type WorkflowStageResult,
} from '@deepseek-ai/dsh-patent-core'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobHooks, JobSpec, JobView } from '@deepseek-ai/dsh-jobs'
import { PatentToolError } from '../src/error.ts'
import { buildWorkflowRunContext } from '../src/tool/internal/workflow-helpers.ts'
import {
  createPatentWorkflowRunTool,
  renderWorkflowRun,
  type PatentWorkflowRunOutput,
  type WorkflowRunJobRegistry,
} from '../src/tool/patent-workflow-run.ts'
import { slopGateAtom, SlopGateHandler } from '../src/atoms/slop-gate.ts'
import { tightenAtom, TightenHandler } from '../src/atoms/tighten.ts'
import { draftSpecificationAtom, DraftSpecificationHandler } from '../src/atoms/draft-specification.ts'
import { figureAnalysisAtom, FigureAnalysisHandler } from '../src/atoms/figure-analysis.ts'
import { specCheckAtom, SpecCheckHandler } from '../src/atoms/spec-check.ts'
import { responseCheckAtom, ResponseCheckHandler } from '../src/atoms/response-check.ts'
import { eligibilityAtom, EligibilityHandler } from '../src/atoms/eligibility.ts'
import { legalGapsAtom, LegalGapsHandler } from '../src/atoms/legal-gaps.ts'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

registerBuiltinAtoms()
// slop-gate、tighten、spec-check、response-check、eligibility 与 legal-gaps 依赖本包实现，真实注册在 apply()；
// 测试直接走包内实现，保证 manifest 校验与实际运行路径一致。
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

/** 图模式规则门评估器替身；规则语料的 conformance 由 patent-rule 自身测试覆盖。 */
const stubRuleEvaluator: RuleEvaluator = {
  id: 'test:stub-rules',
  evaluate: () => ({ verdict: 'pass', failures: [], evaluatedRules: 1 }),
}

/**
 * Tool execution context for a call from this spec. `withAgent` adds the
 * calling agent, which the tool reads for job ownership (`owner`) and for
 * binding its model port to a session.
 * @param withAgent - include a calling agent.
 * @returns the execution context the tool body reads.
 */
function toolExec(
  withAgent = false,
  onAppend: (type: string, data: unknown) => void = () => {},
): Parameters<ToolDefinition['execute']>[1] {
  const agent = {
    id: 'sess-1',
    session: { id: 'sess-1', append: (type: string, data: unknown) => { onAppend(type, data) } },
  }
  const context = { signal: new AbortController().signal, ...(withAgent ? { agent } : {}) }
  return context as unknown as Parameters<ToolDefinition['execute']>[1]
}

const exec = toolExec()

function fakeModel(): PatentModelPort {
  return {
    stream: async function* (request) {
      const prompt = request.messages.map(m => m.content).join('\n')
      const text = prompt.includes('problem_insight')
        ? '{"problem_insight": [{"id": "P1", "problem": "p1", "insight": "i1"}]}'
        : '{"features": ["f1"], "problems": ["p1"], "effects": ["e1"]}'
      yield { type: 'delta', text }
      yield { type: 'done' }
    },
  }
}

/** Novelty graph model: answers each atom prompt with JSON its parser accepts. */
function noveltyGraphModel(): PatentModelPort {
  return {
    stream: async function* (request) {
      const prompt = request.messages.map(m => m.content).join('\n')
      let text = '{}'
      if (prompt.includes('完整新颖性分析报告')) {
        text = '新颖性分析报告：权利要求相对于现有技术具备新颖性。'
      } else if (prompt.includes('技术分析助手')) {
        text = '{"features": ["f1"], "problems": ["p1"], "effects": ["e1"]}'
      } else if (prompt.includes('检索关键词')) {
        text = '{"keywords": ["f1"]}'
      } else if (prompt.includes('新颖性分析专家')) {
        text = '{"assessments": [{"feature": "f1", "prior_art": "", "disclosed": false, "reasoning": "未公开"}], "conclusion": "具备新颖性"}'
      }
      yield { type: 'delta', text }
      yield { type: 'done' }
    },
  }
}

const fakeSearch = async () => []

/**
 * 最小 job 注册表替身：捕获 starter 的 hooks，由测试驱动结算；`list` 反映仍在跑的
 * job（结算即从列表移除），供并发防护的用例使用。每个 hook 同时登记进
 * {@link outstanding}，由 teardown 统一结算后再删临时目录。
 */
function fakeJobRegistry(): {
  jobs: WorkflowRunJobRegistry
  started: JobSpec[]
  hooks: JobHooks[]
  progress: string[]
} {
  const started: JobSpec[] = []
  const hooks: JobHooks[] = []
  const progress: string[] = []
  const live = new Map<string, JobView>()
  return {
    started,
    hooks,
    progress,
    jobs: {
      list: () => [...live.values()],
      start: (spec) => {
        started.push(spec)
        const id = JobId(`patent-workflow-${started.length}`)
        live.set(id, {
          id,
          kind: spec.kind,
          label: spec.label,
          status: 'running',
          startedAt: 0,
          output: { total: 0, earliest: 0 },
        })
        const hook = spec.run({ id, append: () => {}, updateProgress: (line) => { progress.push(line) } })
        hooks.push(hook)
        outstanding.push(hook)
        void hook.done.then(() => { live.delete(id) })
        return id
      },
    },
  }
}

/** 受测试控制的模型：首个流调用挂起，直到 release() 被调用。 */
function gatedModel(): { port: PatentModelPort; release: () => void } {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  return {
    release: () => { release() },
    port: {
      stream: async function* () {
        await gate
        yield { type: 'delta', text: '{"features": ["f1"], "problems": ["p1"], "effects": ["e1"]}' }
        yield { type: 'done' }
      },
    },
  }
}

describe('patent_workflow_run', () => {
  it('registers under patent_workflow_run', () => {
    expect(createPatentWorkflowRunTool().name).toBe('patent_workflow_run')
  })

  it('returns ok=false for an unknown manifest with the catalog', async () => {
    const tool = createPatentWorkflowRunTool()
    const value = (await tool.execute({ manifestId: 'nope', input: 'x' }, exec)) as PatentWorkflowRunOutput
    expect(value.ok).toBe(false)
    expect(value.mode).toBe('manifest')
    expect(value.available).toEqual(expect.arrayContaining(['patent_disclosure_v1']))
  })

  it('throws setup_required without a model', async () => {
    const tool = createPatentWorkflowRunTool()
    await expect(
      tool.execute({ manifestId: 'patent_disclosure_v1', input: 'x' }, exec),
    ).rejects.toThrow('未提供模型客户端')
  })

  it('runs the disclosure manifest with injected model + search, pausing at review_gate', async () => {
    const tool = createPatentWorkflowRunTool({ model: fakeModel(), search: fakeSearch })
    const value = (await tool.execute(
      { manifestId: 'patent_disclosure_v1', input: 'technical disclosure' },
      exec,
    )) as PatentWorkflowRunOutput
    expect(value.ok).toBe(true)
    expect(value.mode).toBe('manifest')
    expect(value.manifestId).toBe('patent_disclosure_v1')
    expect(value.interruptNote).toBeDefined()
    expect(value.interruptNote).toContain('review_gate')
    // 配对抽取按新协议接线：问题与发明认知同一次调用产出，三路抽取与 merge 都不降级。
    const stages = (value.stages ?? []) as WorkflowStageResult[]
    for (const stageId of ['extract_problem', 'extract_features', 'extract_effects', 'merge']) {
      expect(stages.find(stage => stage.stageId === stageId)?.degraded, stageId).toBe(false)
    }
    expect(stages.find(stage => stage.stageId === 'extract_problem')?.output).toContain('problem_insight')
  })

  it('disclosure manifest: prior-art filtering drops post-cutoff hits before novelty', async () => {
    const model: PatentModelPort = {
      stream: async function* (request) {
        const prompt = request.messages.map(m => m.content).join('\n')
        yield {
          type: 'delta',
          text: prompt.includes('检索关键词')
            ? '{"keywords":["壳体"]}'
            : '{"features":["f1"],"problems":["p1"],"effects":["e1"]}',
        }
        yield { type: 'done' }
      },
    }
    const search = async () => [
      { title: 'D1 申请日前', publicationDate: '2023-01-01', url: 'https://example.com/d1' },
      { title: 'D2 申请日后', publicationDate: '2024-07-01', url: 'https://example.com/d2' },
    ]
    const tool = createPatentWorkflowRunTool({ model, search })
    const value = (await tool.execute(
      { manifestId: 'patent_disclosure_v1', input: 'technical disclosure', filingDate: '2024-06-01' },
      exec,
    )) as PatentWorkflowRunOutput
    expect(value.ok).toBe(true)
    const stages = (value.stages ?? []) as WorkflowStageResult[]
    expect(stages.find(s => s.stageId === 'time_baseline')?.degraded).toBe(false)
    const filter = stages.find(s => s.stageId === 'prior_art_filter')
    expect(filter?.degraded).toBe(false)
    expect(filter?.output).toContain('保留 1 篇')
    expect(filter?.output).toContain('排除 1 篇')
  })

  it('returns ok=false for an unknown graph checkpoint', async () => {
    const tool = createPatentWorkflowRunTool({
      model: fakeModel(),
      search: fakeSearch,
      ruleEvaluator: stubRuleEvaluator,
    })
    const value = (await tool.execute(
      { graph: 'novelty', input: 'x', resumeCheckpointId: 'nope' },
      exec,
    )) as PatentWorkflowRunOutput
    expect(value.ok).toBe(false)
    expect(value.mode).toBe('graph')
    expect(value.error).toContain('检查点')
  })

  it('run_in_background registers a job and returns its id without running the stages inline', async () => {
    const { jobs, started, hooks } = fakeJobRegistry()
    // caseId 使 manifest 运行把结果写到 <cwd>/data/cases/<id>/workflow-runs；cwd 指向临时目录，
    // 否则产物落进仓库工作树。
    temp = await mkdtemp(join(tmpdir(), 'dsh-patent-wf-'))
    const tool = createPatentWorkflowRunTool({ model: fakeModel(), search: fakeSearch, jobs: () => jobs, cwd: temp })
    const value = (await tool.execute(
      { manifestId: 'patent_disclosure_v1', input: 'technical disclosure', caseId: 'CN2024-0003', run_in_background: true },
      exec,
    )) as PatentWorkflowRunOutput

    expect(value).toMatchObject({
      ok: true,
      mode: 'manifest',
      manifestId: 'patent_disclosure_v1',
      background: true,
      jobId: 'patent-workflow-1',
    })
    expect(value.stages).toBeUndefined()
    expect(started[0]?.kind).toBe('patent-workflow')
    expect(started[0]?.label).toBe('patent_disclosure_v1 (CN2024-0003)')
    expect(renderWorkflowRun(value)).toContain('已在后台启动 job patent-workflow-1')

    // 工作流在 job 自己的信号下跑完，结算结果就是前台调用会返回的那段文本。
    const outcome = await hooks[0]!.done
    expect(outcome.status).toBe('completed')
    expect(outcome.detail).toBe('interrupted')
    expect(outcome.result).toContain('patent_workflow_run(patent_disclosure_v1)')
    expect(outcome.result).toContain('review_gate')

    // 审批门在 legal-gaps 反哺回路之后：放行后即使发生回退也不会跨过该门，运行跑到头。
    const done = fakeJobRegistry()
    const completeTool = createPatentWorkflowRunTool({ model: fakeModel(), search: fakeSearch, jobs: () => done.jobs })
    await completeTool.execute(
      {
        manifestId: 'patent_disclosure_v1',
        input: 'technical disclosure',
        run_in_background: true,
        approveStageIds: ['review_gate'],
      },
      exec,
    )
    await expect(done.hooks[0]!.done).resolves.toMatchObject({ status: 'completed', detail: 'completed' })
  })

  it('a cancelled background job settles killed', async () => {
    const { port, release } = gatedModel()
    const { jobs, hooks } = fakeJobRegistry()
    const tool = createPatentWorkflowRunTool({ model: port, search: fakeSearch, jobs: () => jobs })
    await tool.execute(
      { manifestId: 'patent_disclosure_v1', input: 'technical disclosure', run_in_background: true },
      exec,
    )

    hooks[0]!.cancel()
    release()
    const outcome = await hooks[0]!.done
    expect(outcome.status).toBe('killed')
    expect(outcome.result).toBeUndefined()
  })

  it('a background job whose run fails loud settles failed, owned by the calling agent session', async () => {
    // A stage handler that fails loud (setup_required) propagates out of the run
    // instead of degrading, which is the failure the job must report.
    const handlers = new StageHandlerRegistry()
    handlers.register({
      name: 'extract',
      category: 'extract',
      execute: () => { throw new PatentToolError('setup_required', 'stage handler exploded') },
    })
    const { jobs, started, hooks } = fakeJobRegistry()
    const tool = createPatentWorkflowRunTool({ model: fakeModel(), search: fakeSearch, handlers, jobs: () => jobs })
    await tool.execute(
      { manifestId: 'patent_disclosure_v1', input: 'technical disclosure', run_in_background: true },
      toolExec(true),
    )

    expect(started[0]?.owner).toBe('sess-1')
    expect(started[0]?.label).toBe('patent_disclosure_v1')
    const outcome = await hooks[0]!.done
    expect(outcome).toMatchObject({ status: 'failed', detail: 'stage handler exploded' })
  })

  it('rejects malformed arguments before registering a background job', async () => {
    const { jobs, started } = fakeJobRegistry()
    const tool = createPatentWorkflowRunTool({ model: fakeModel(), search: fakeSearch, jobs: () => jobs })
    await expect(
      tool.execute(
        { manifestId: 'patent_disclosure_v1', input: 'x', priorArt: '{oops', run_in_background: true },
        exec,
      ),
    ).rejects.toThrow('priorArt 必须是 JSON 数组')
    expect(started).toHaveLength(0)
  })

  it('reports stage progress through the job handle as the run advances', async () => {
    const { jobs, hooks, progress } = fakeJobRegistry()
    const tool = createPatentWorkflowRunTool({ model: fakeModel(), search: fakeSearch, jobs: () => jobs })
    await tool.execute(
      { manifestId: 'patent_disclosure_v1', input: 'technical disclosure', run_in_background: true },
      exec,
    )
    await hooks[0]!.done

    // 结算前 job_output 读不到环内容，进展只能经 updateProgress（job_list 的状态行）。
    expect(progress[0]).toMatch(/^1\/\d+ \S+$/)
    expect(progress.some(line => line.includes('review_gate'))).toBe(true)
  })

  it('refuses a second live background run for the same case and manifest', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-patent-wf-'))
    const { jobs, started } = fakeJobRegistry()
    const tool = createPatentWorkflowRunTool({ model: fakeModel(), search: fakeSearch, jobs: () => jobs, cwd: temp })
    const args = {
      manifestId: 'patent_disclosure_v1',
      input: 'technical disclosure',
      caseId: 'CN2024-0001',
      run_in_background: true,
    }
    await tool.execute(args, exec)
    await expect(tool.execute(args, exec)).rejects.toThrow('已有一个后台运行')
    expect(started).toHaveLength(1)
  })

  it('refuses a new run while a previous job for the same case is stopping', async () => {
    const jobs: WorkflowRunJobRegistry = {
      list: () => [{
        id: JobId('patent-workflow-live'),
        kind: 'patent-workflow',
        label: 'patent_disclosure_v1 (CN2024-0009)',
        status: 'stopping',
        startedAt: 0,
        output: { total: 0, earliest: 0 },
      }],
      start: () => {
        throw new Error('must not start')
      },
    }
    const tool = createPatentWorkflowRunTool({ model: fakeModel(), search: fakeSearch, jobs: () => jobs })
    await expect(tool.execute({
      manifestId: 'patent_disclosure_v1',
      input: 'technical disclosure',
      caseId: 'CN2024-0009',
      run_in_background: true,
    }, exec)).rejects.toThrow('已有一个后台运行')
  })

  it('treats a blank date as absent', async () => {
    const tool = createPatentWorkflowRunTool({ model: fakeModel(), search: fakeSearch })
    const value = (await tool.execute({
      manifestId: 'patent_disclosure_v1',
      input: 'technical disclosure',
      filingDate: '   ',
      priorityDate: ' ',
    }, exec)) as PatentWorkflowRunOutput
    expect(value.ok).toBe(true)
  })

  it('starts the same case run again once the previous one settled', async () => {    temp = await mkdtemp(join(tmpdir(), 'dsh-patent-wf-'))
    const { jobs, started, hooks } = fakeJobRegistry()
    const tool = createPatentWorkflowRunTool({ model: fakeModel(), search: fakeSearch, jobs: () => jobs, cwd: temp })
    const args = {
      manifestId: 'patent_disclosure_v1',
      input: 'technical disclosure',
      caseId: 'CN2024-0002',
      run_in_background: true,
    }
    await tool.execute(args, exec)
    await hooks[0]!.done
    await expect(tool.execute(args, exec)).resolves.toMatchObject({ jobId: 'patent-workflow-2' })
    expect(started).toHaveLength(2)
  })

  it('does not constrain background runs that write no case artifacts', async () => {
    const { jobs, started } = fakeJobRegistry()
    const tool = createPatentWorkflowRunTool({ model: fakeModel(), search: fakeSearch, jobs: () => jobs })
    const args = { manifestId: 'patent_disclosure_v1', input: 'technical disclosure', run_in_background: true }
    await tool.execute(args, exec)
    await tool.execute(args, exec)
    expect(started).toHaveLength(2)
  })

  it('run_in_background requires a job registry and rejects the graph path', async () => {
    const withoutJobs = createPatentWorkflowRunTool({ model: fakeModel(), search: fakeSearch })
    await expect(
      withoutJobs.execute({ manifestId: 'patent_disclosure_v1', input: 'x', run_in_background: true }, exec),
    ).rejects.toThrow('未启用后台任务')

    const { jobs } = fakeJobRegistry()
    const withJobs = createPatentWorkflowRunTool({ model: fakeModel(), search: fakeSearch, jobs: () => jobs })
    await expect(
      withJobs.execute({ graph: 'citation-check', input: 'x', run_in_background: true }, exec),
    ).rejects.toThrow('仅支持 manifest 路径')
  })

  it('renders manifest and graph prose', () => {
    const manifest = renderWorkflowRun({
      ok: true,
      mode: 'manifest',
      manifestId: 'patent_disclosure_v1',
      completed: true,
      summary: '工作流 patent_disclosure_v1（技术交底书披露分析）: 1/1 阶段完成',
      stages: [{ stageId: 'extract', strategy: 'sub_agent', output: 'out', degraded: false, retries: 0, atom: 'extract' }],
      degradedSteps: [],
      persistNote: '持久化: 未启用（未提供 caseId）',
    })
    expect(manifest).toContain('patent_workflow_run(patent_disclosure_v1)')
    expect(manifest).toContain('- ✅ extract [atom:extract]: out')

    const graph = renderWorkflowRun({
      ok: true,
      mode: 'graph',
      manifestId: 'patent_novelty',
      graph: 'novelty',
      steps: 3,
      completed: false,
      summary: '',
      stages: [],
      degradedSteps: [],
      persistNote: '持久化: 未启用（未提供 caseId）',
      graphState: { rule_gate: { status: 'pass' }, novelty_report: 'report text' },
      graphDegraded: [],
      checkpointNote: '检查点: patent_novelty-0',
    })
    expect(graph).toContain('图引擎执行 3 超步')
    expect(graph).toContain('规则门 status: pass')
  })

  it('throws PatentToolError for setup and input failures', async () => {
    await expect(createPatentWorkflowRunTool().execute({ input: 'x' }, exec)).rejects.toThrow(PatentToolError)
  })

  it('hands a stage its declared upstream outputs and the separately supplied claims', async () => {
    const prompts: string[] = []
    const model: PatentModelPort = {
      stream: async function* (request) {
        prompts.push(request.messages.map(m => m.content).join('\n'))
        yield { type: 'delta', text: `产出${prompts.length}` }
        yield { type: 'done' }
      },
    }
    const tool = createPatentWorkflowRunTool({ model, search: async () => [] })
    const value = (await tool.execute(
      { manifestId: 'patent_novelty_v1', input: '交底书正文', claims: '1. 一种装置，其特征在于，包括壳体。' },
      exec,
    )) as PatentWorkflowRunOutput
    expect(value.ok).toBe(true)
    // 逐项对比阶段声明了 dispute-framing-refine/parse/search 等依赖，这些产出与权利要求材料都进提示词。
    const compare = prompts.find(p => p.includes('逐项对比技术特征与现有技术'))
    expect(compare).toBeDefined()
    expect(compare).toContain('## 上游阶段产出: dispute-framing-refine')
    expect(compare).toContain('## 上游阶段产出: parse')
    expect(compare).toContain('## 上游阶段产出: search')
    expect(compare).toContain('产出1')
    expect(compare).toContain('## 权利要求书（本次调用的 claims 参数）')
    expect(compare).toContain('1. 一种装置，其特征在于，包括壳体。')
    // parse 不是首个阶段：粗定位产出作为唯一的首轮上游进入提示词。
    const parse = prompts.find(p => p.includes('解析技术交底书'))
    expect(parse).toContain('## 上游阶段产出: dispute-framing')
    expect(parse).not.toContain('## 上游阶段产出: time_baseline')
  })

  it('novelty manifest: filingDate/priorityDate establish the prior-art cutoff', async () => {
    const tool = createPatentWorkflowRunTool({ model: fakeModel(), search: async () => [] })
    const value = (await tool.execute(
      {
        manifestId: 'patent_novelty_v1',
        input: '交底书正文',
        filingDate: '2024-06-01',
        priorityDate: '2023-06-01',
      },
      exec,
    )) as PatentWorkflowRunOutput
    expect(value.ok).toBe(true)
    const stages = (value.stages ?? []) as WorkflowStageResult[]
    const baseline = stages.find(s => s.stageId === 'time_baseline')
    expect(baseline).toBeDefined()
    expect(baseline!.output).toContain('2023-06-01')
    expect(baseline!.output).toContain('优先权日')
    expect(baseline!.degraded).toBe(false)
    expect(value.degradedSteps ?? []).not.toContain('time_baseline')
  })

  it('rejects an unparseable filingDate at the tool input boundary', async () => {
    const tool = createPatentWorkflowRunTool({ model: fakeModel(), search: async () => [] })
    await expect(
      tool.execute({ manifestId: 'patent_novelty_v1', input: 'x', filingDate: '2024-13-01' }, exec),
    ).rejects.toThrow(/filingDate/)
  })

  it('novelty manifest: conflictingApplications runs the A22.2 second-sentence check', async () => {
    const tool = createPatentWorkflowRunTool({ model: fakeModel(), search: async () => [] })
    const value = (await tool.execute(
      {
        manifestId: 'patent_novelty_v1',
        input: '交底书正文',
        filingDate: '2024-06-01',
        conflictingApplications: JSON.stringify([
          {
            applicationNumber: 'CN202310000001',
            publicationNumber: 'CN123456A',
            title: '在先申请',
            filingDate: '2023-01-01',
            publicationDate: '2024-07-01',
            sameInvention: true,
          },
        ]),
      },
      exec,
    )) as PatentWorkflowRunOutput
    expect(value.ok).toBe(true)
    const stages = (value.stages ?? []) as WorkflowStageResult[]
    const check = stages.find(s => s.stageId === 'conflicting_application')
    expect(check).toBeDefined()
    expect(check!.degraded).toBe(false)
    expect(check!.output).toContain('确认 1 件')
    expect(check!.output).toContain('仅用于新颖性判断')
  })

  it('novelty manifest: numeric_range compares claim numbers with supplied priorArt', async () => {
    const tool = createPatentWorkflowRunTool({ model: fakeModel(), search: async () => [] })
    const value = (await tool.execute(
      {
        manifestId: 'patent_novelty_v1',
        input: '交底书正文',
        claims: '1. 一种装置，其特征在于，温度为 50-80℃。',
        priorArt: JSON.stringify([{ title: 'D1', snippet: 'D1 公开温度为 60-90℃。' }]),
      },
      exec,
    )) as PatentWorkflowRunOutput
    expect(value.ok).toBe(true)
    const stages = (value.stages ?? []) as WorkflowStageResult[]
    const check = stages.find(s => s.stageId === 'numeric_range')
    expect(check).toBeDefined()
    expect(check!.degraded).toBe(false)
    expect(check!.output).toContain('破坏新颖性')
    expect(check!.output).toContain('[claim × D1]')
  })

  it('novelty manifest: atomic search feeds prior-art filtering and citation grounding', async () => {
    const prompts: string[] = []
    const model: PatentModelPort = {
      stream: async function* (request) {
        const prompt = request.messages.map(m => m.content).join('\n')
        prompts.push(prompt)
        const text = prompt.includes('检索关键词')
          ? '{"keywords":["阀体","伴热夹套"]}'
          : prompt.includes('生成新颖性分析结论')
            ? '对比文件 D1 公开了全部技术特征，不具备新颖性。'
            : '解析结果：包括阀体与设置在阀体外侧的伴热夹套。'
        yield { type: 'delta', text }
        yield { type: 'done' }
      },
    }
    const search = async () => [
      {
        title: 'D1 阀体结构',
        publicationDate: '2023-01-01',
        url: 'https://example.com/d1',
        snippet: '阀体外侧设置伴热夹套',
      },
      { title: 'D2 后公开', publicationDate: '2024-07-01', url: 'https://example.com/d2' },
    ]
    const tool = createPatentWorkflowRunTool({ model, search })
    const value = (await tool.execute(
      {
        manifestId: 'patent_novelty_v1',
        input: '一种阀体伴热夹套结构',
        filingDate: '2024-06-01',
        approveStageIds: ['approval'],
      },
      exec,
    )) as PatentWorkflowRunOutput
    expect(value.ok).toBe(true)
    expect(value.completed).toBe(true)
    const stages = (value.stages ?? []) as WorkflowStageResult[]
    const searchStage = stages.find(s => s.stageId === 'search')
    expect(searchStage?.atom).toBe('search')
    expect(searchStage?.output).toContain('检索到 2 篇相关文献')
    expect(searchStage?.output).toContain('D1 阀体结构')
    expect(searchStage?.output).toContain('阀体外侧设置伴热夹套')
    const filter = stages.find(s => s.stageId === 'prior_art_filter')
    expect(filter?.degraded).toBe(false)
    expect(filter?.output).toContain('保留 1 篇')
    expect(filter?.output).toContain('排除 1 篇')
    const citation = stages.find(s => s.stageId === 'citation_check')
    expect(citation?.degraded).toBe(false)
    expect(citation?.output).toContain('引用全部接地')
    expect(citation?.output).toContain('D1')
    // 收口阶段只能读到阶段产出文本：检索摘要必须携带命中详情，过滤结论必须可消费。
    const compare = prompts.find(p => p.includes('逐项对比技术特征与现有技术'))
    expect(compare).toContain('D1 阀体结构')
    expect(compare).toContain('## 上游阶段产出: prior_art_filter')
  })

  it('novelty manifest: citation-check rejects a citation to a filtered-out document', async () => {
    const model: PatentModelPort = {
      stream: async function* (request) {
        const prompt = request.messages.map(m => m.content).join('\n')
        const text = prompt.includes('检索关键词')
          ? '{"keywords":["阀体"]}'
          : prompt.includes('生成新颖性分析结论')
            ? '对比文件 D2 公开了全部技术特征。'
            : '解析结果：阀体。'
        yield { type: 'delta', text }
        yield { type: 'done' }
      },
    }
    const search = async () => [
      { title: 'D1 早公开', publicationDate: '2023-01-01', url: 'https://example.com/d1' },
      { title: 'D2 截止日后公开', publicationDate: '2024-07-01', url: 'https://example.com/d2' },
    ]
    const tool = createPatentWorkflowRunTool({ model, search })
    const value = (await tool.execute(
      {
        manifestId: 'patent_novelty_v1',
        input: '一种阀体',
        filingDate: '2024-06-01',
        approveStageIds: ['approval'],
      },
      exec,
    )) as PatentWorkflowRunOutput
    const citation = ((value.stages ?? []) as WorkflowStageResult[])
      .find(s => s.stageId === 'citation_check')
    expect(citation?.degraded).toBe(false)
    expect(citation?.output).toContain('D2')
    expect(citation?.output).toContain('未在检索结果中找到')
  })

  it('inventiveness manifest: time baseline, search, and prior-art filtering feed the three-step method', async () => {
    const prompts: string[] = []
    const model: PatentModelPort = {
      stream: async function* (request) {
        const prompt = request.messages.map(m => m.content).join('\n')
        prompts.push(prompt)
        const text = prompt.includes('检索关键词')
          ? '{"keywords":["壳体","限位凸台"]}'
          : prompt.includes('生成创造性结论')
            ? '对比文件 D1 给出了技术启示，不具备创造性。'
            : '产出：区别特征为限位凸台。'
        yield { type: 'delta', text }
        yield { type: 'done' }
      },
    }
    const search = async () => [
      { title: 'D1 早公开', publicationDate: '2023-01-01', url: 'https://example.com/d1', snippet: '壳体内设置限位凸台' },
      { title: 'D2 后公开', publicationDate: '2024-07-01', url: 'https://example.com/d2' },
    ]
    const tool = createPatentWorkflowRunTool({ model, search })
    const value = (await tool.execute(
      {
        manifestId: 'patent_inventiveness_v1',
        input: '一种装置，包括壳体和限位凸台。',
        filingDate: '2024-06-01',
        approveStageIds: ['approval'],
      },
      exec,
    )) as PatentWorkflowRunOutput
    expect(value.ok).toBe(true)
    expect(value.completed).toBe(true)
    const stages = (value.stages ?? []) as WorkflowStageResult[]
    expect(stages.find(s => s.stageId === 'time_baseline')?.degraded).toBe(false)
    const filter = stages.find(s => s.stageId === 'prior_art_filter')
    expect(filter?.degraded).toBe(false)
    expect(filter?.output).toContain('保留 1 篇')
    expect(filter?.output).toContain('排除 1 篇')
    const citation = stages.find(s => s.stageId === 'citation_check')
    expect(citation?.degraded).toBe(false)
    expect(citation?.output).toContain('引用全部接地')
    const closest = prompts.find(p => p.includes('确定最接近的现有技术'))
    expect(closest).toContain('D1 早公开')
    expect(closest).toContain('## 上游阶段产出: prior_art_filter')
  })

  it('inventiveness manifest: problem_check rejects a problem restating the distinguishing feature', async () => {
    const runWithProblem = async (problem: string): Promise<WorkflowStageResult | undefined> => {
      const model: PatentModelPort = {
        stream: async function* (request) {
          const prompt = request.messages.map(m => m.content).join('\n')
          const output = prompt.includes('实质对比确定区别技术特征')
            ? JSON.stringify({
              distinguishing_features: ['设置限位凸台'],
              actual_technical_problem: problem,
              effect_of_diff: '可靠定位',
            })
            : '产出'
          yield { type: 'delta', text: output }
          yield { type: 'done' }
        },
      }
      const tool = createPatentWorkflowRunTool({ model, search: async () => [] })
      const value = (await tool.execute(
        { manifestId: 'patent_inventiveness_v1', input: '一种装置，包括壳体。' },
        exec,
      )) as PatentWorkflowRunOutput
      expect(value.ok).toBe(true)
      return ((value.stages ?? []) as WorkflowStageResult[]).find(s => s.stageId === 'problem_check')
    }

    const rejected = await runWithProblem('如何设置限位凸台')
    expect(rejected).toBeDefined()
    expect(rejected!.degraded).toBe(false)
    expect(rejected!.output).toContain('未通过')
    expect(rejected!.output).toContain('区别特征自身')

    const accepted = await runWithProblem('如何将装配温度从95℃降至78℃')
    expect(accepted).toBeDefined()
    expect(accepted!.degraded).toBe(false)
    expect(accepted!.output).toContain('通过')
  })

  it('oa-response manifest: response_check flags a missing rejection ground in the draft', async () => {
    const notice =
      '权利要求 1-2 不具备创造性，不符合专利法第22条第3款的规定；权利要求 3 的保护范围不清楚，不符合专利法第26条第4款的规定。'
    const runWithDraft = async (draft: string): Promise<WorkflowStageResult | undefined> => {
      const model: PatentModelPort = {
        stream: async function* (request) {
          const prompt = request.messages.map(m => m.content).join('\n')
          const output = prompt.includes('撰写意见陈述书') ? draft : '{"features":["f1"]}'
          yield { type: 'delta', text: output }
          yield { type: 'done' }
        },
      }
      const tool = createPatentWorkflowRunTool({ model, search: async () => [] })
      const value = (await tool.execute(
        { manifestId: 'patent_oa_response_v1', input: notice },
        exec,
      )) as PatentWorkflowRunOutput
      expect(value.ok).toBe(true)
      return ((value.stages ?? []) as WorkflowStageResult[])
        .find(stage => stage.stageId === 'response_check')
    }

    const missing = await runWithDraft('关于创造性：对比文件 1 与 2 的结合无技术启示。')
    expect(missing).toBeDefined()
    expect(missing!.degraded).toBe(false)
    expect(missing!.output).toContain('未通过')
    expect(missing!.output).toContain('不清楚')

    const covered = await runWithDraft(
      '关于创造性：对比文件 1 与 2 的结合无技术启示。\n关于不清楚：修改权利要求 3 的表述。',
    )
    expect(covered).toBeDefined()
    expect(covered!.degraded).toBe(false)
    expect(covered!.output).toContain('通过')
  })

  it('oa-response manifest: amendment_basis rejects a new feature absent from the original application', async () => {
    const notice = '权利要求 1 不具备创造性，不符合专利法第22条第3款的规定。'
    const originalClaims = '1. 一种装置，包括壳体，其特征在于，所述壳体上设置有散热孔和过滤网。'
    const runWithDraft = async (draft: string): Promise<WorkflowStageResult | undefined> => {
      const model: PatentModelPort = {
        stream: async function* (request) {
          const prompt = request.messages.map(m => m.content).join('\n')
          const output = prompt.includes('撰写意见陈述书') ? draft : '{"features":["f1"]}'
          yield { type: 'delta', text: output }
          yield { type: 'done' }
        },
      }
      const tool = createPatentWorkflowRunTool({ model, search: async () => [] })
      const value = (await tool.execute(
        { manifestId: 'patent_oa_response_v1', input: notice, claims: originalClaims },
        exec,
      )) as PatentWorkflowRunOutput
      expect(value.ok).toBe(true)
      return ((value.stages ?? []) as WorkflowStageResult[])
        .find(stage => stage.stageId === 'amendment_basis')
    }

    const added = await runWithDraft(
      [
        '关于创造性：对比文件 1 未公开散热孔。',
        '修改后权利要求书：',
        '1. 一种装置，包括壳体，其特征在于，所述壳体上设置有散热孔，所述壳体内设置有不锈钢材质的过滤网。',
      ].join('\n'),
    )
    expect(added).toBeDefined()
    expect(added!.degraded).toBe(false)
    expect(added!.output).toContain('未通过')
    expect(added!.output).toContain('不锈钢')

    const supported = await runWithDraft(
      [
        '关于创造性：对比文件 1 未公开散热孔。',
        '修改后权利要求书：',
        '1. 一种装置，包括壳体，其特征在于，所述壳体上设置有散热孔和过滤网。',
      ].join('\n'),
    )
    expect(supported).toBeDefined()
    expect(supported!.degraded).toBe(false)
    expect(supported!.output).toContain('通过')
  })

  it('invalidation manifest: evidence_check rejects a late exhibit and accepts an in-time one', async () => {
    const runWithEvidence = async (evidence: unknown[]): Promise<WorkflowStageResult | undefined> => {
      const tool = createPatentWorkflowRunTool({ model: fakeModel(), search: async () => [] })
      const value = (await tool.execute(
        {
          manifestId: 'patent_invalidation_v1',
          input: '请求人主张权利要求 1 不具备创造性（专利法第22条第3款）。',
          filingDate: '2024-06-01',
          evidenceDeadline: '2024-07-01',
          evidence: JSON.stringify(evidence),
        },
        exec,
      )) as PatentWorkflowRunOutput
      expect(value.ok).toBe(true)
      return ((value.stages ?? []) as WorkflowStageResult[])
        .find(stage => stage.stageId === 'evidence-check')
    }

    const exhibit = {
      title: 'CN101234567A 阀体伴热夹套结构',
      type: '现有技术',
      sourceUri: 'patent:CN101234567A',
      publicationDate: '2023-01-01',
      grounds: ['创造性'],
    }
    const late = await runWithEvidence([{ ...exhibit, submittedAt: '2024-08-01' }])
    expect(late).toBeDefined()
    expect(late!.degraded).toBe(false)
    expect(late!.output).toContain('未通过')
    expect(late!.output).toContain('EVID-TIME-LATE')

    const inTime = await runWithEvidence([{ ...exhibit, submittedAt: '2024-06-15' }])
    expect(inTime).toBeDefined()
    expect(inTime!.degraded).toBe(false)
    expect(inTime!.output).toContain('通过')
  })

  it('invalidation manifest: citation_check grounds D labels from the novelty and inventiveness stages', async () => {
    const runWith = async (conclusion: string, priorArt: unknown[]): Promise<WorkflowStageResult | undefined> => {
      const model: PatentModelPort = {
        stream: async function* () {
          yield { type: 'delta', text: conclusion }
          yield { type: 'done' }
        },
      }
      const tool = createPatentWorkflowRunTool({ model, search: async () => [] })
      const value = (await tool.execute(
        {
          manifestId: 'patent_invalidation_v1',
          input: '请求人主张权利要求 1 不具备新颖性（专利法第22条第2款）。',
          priorArt: JSON.stringify(priorArt),
        },
        exec,
      )) as PatentWorkflowRunOutput
      expect(value.ok).toBe(true)
      return ((value.stages ?? []) as WorkflowStageResult[])
        .find(stage => stage.stageId === 'citation-check')
    }

    const grounded = await runWith('对比文件 1（D1）公开了权利要求 1 的全部技术特征。', [
      { title: 'CN101234567A 阀体伴热夹套结构' },
    ])
    expect(grounded).toBeDefined()
    expect(grounded!.degraded).toBe(false)
    expect(grounded!.output).toContain('引用全部接地')

    const ungrounded = await runWith('US11452699B2 公开了权利要求 1 的全部技术特征。', [
      { title: 'CN101234567A 阀体伴热夹套结构' },
    ])
    expect(ungrounded).toBeDefined()
    expect(ungrounded!.degraded).toBe(false)
    expect(ungrounded!.output).toContain('US11452699B2')
    expect(ungrounded!.output).toContain('未在检索结果中找到对应对比文件')
  })

  it('invalidation manifest: legal_gaps aggregates evidence and ground coverage', async () => {
    const runWithEvidence = async (evidence: unknown[]): Promise<WorkflowStageResult | undefined> => {
      const tool = createPatentWorkflowRunTool({ model: fakeModel(), search: async () => [] })
      const value = (await tool.execute(
        {
          manifestId: 'patent_invalidation_v1',
          input: '请求人主张权利要求 1 不具备创造性（专利法第22条第3款）。',
          filingDate: '2024-06-01',
          evidenceDeadline: '2024-07-01',
          evidence: JSON.stringify(evidence),
        },
        exec,
      )) as PatentWorkflowRunOutput
      expect(value.ok).toBe(true)
      return ((value.stages ?? []) as WorkflowStageResult[])
        .find(stage => stage.stageId === 'legal_gaps')
    }

    const exhibit = {
      title: 'CN101234567A 阀体伴热夹套结构',
      type: '现有技术',
      sourceUri: 'patent:CN101234567A',
      publicationDate: '2023-01-01',
      grounds: ['创造性'],
      submittedAt: '2024-06-15',
    }
    const blocked = await runWithEvidence([{ ...exhibit, submittedAt: '2024-08-01' }])
    expect(blocked).toBeDefined()
    expect(blocked!.degraded).toBe(false)
    expect(blocked!.output).toContain('未通过')
    expect(blocked!.output).toContain('审查指南第四部分第三章4.3.2')

    const passed = await runWithEvidence([exhibit])
    expect(passed).toBeDefined()
    expect(passed!.degraded).toBe(false)
    expect(passed!.output).toContain('无阻断项')
  })

  it('novelty manifest: legal_gaps summarizes time baseline, conflicting applications, and novelty', async () => {
    const tool = createPatentWorkflowRunTool({ model: fakeModel(), search: async () => [] })
    const value = (await tool.execute(
      {
        manifestId: 'patent_novelty_v1',
        input: '一种阀体伴热夹套结构，包括阀体和设置在阀体外侧的伴热夹套。',
        claims: '1. 一种阀体伴热夹套结构，其特征在于，包括阀体和设置在阀体外侧的伴热夹套。',
        filingDate: '2024-06-01',
        approveStageIds: ['approval'],
      },
      exec,
    )) as PatentWorkflowRunOutput
    expect(value.ok).toBe(true)
    const gaps = ((value.stages ?? []) as WorkflowStageResult[])
      .find(stage => stage.stageId === 'legal_gaps')
    expect(gaps).toBeDefined()
    expect(gaps!.degraded).toBe(false)
    expect(gaps!.output).toContain('法条缺口汇总（新颖性分析）')
    expect(gaps!.output).toContain('专利法第22条第5款')
    expect(gaps!.output).toContain('抵触申请')
  })

  it('patentability manifest: legal_gaps reports eligibility and claim support coverage', async () => {
    const tool = createPatentWorkflowRunTool({ model: fakeModel(), search: async () => [] })
    const value = (await tool.execute(
      {
        manifestId: 'patent_patentability_v1',
        input: '一种阀体伴热夹套结构，包括阀体和设置在阀体外侧的伴热夹套。',
        claims: '1. 一种阀体伴热夹套结构，其特征在于，包括阀体和设置在阀体外侧的伴热夹套。',
        approveStageIds: ['approval'],
      },
      exec,
    )) as PatentWorkflowRunOutput
    expect(value.ok).toBe(true)
    const gaps = ((value.stages ?? []) as WorkflowStageResult[])
      .find(stage => stage.stageId === 'legal_gaps')
    expect(gaps).toBeDefined()
    expect(gaps!.degraded).toBe(false)
    expect(gaps!.output).toContain('法条缺口汇总（可专利性分析）')
    expect(gaps!.output).toContain('专利法第2条第2款')
    expect(gaps!.output).toContain('专利法第26条第4款')
    expect(gaps!.output).toContain('未评估')
  })

  it('patentability manifest: time baseline and atomic search feed the filtered claim chart', async () => {
    const prompts: string[] = []
    const model: PatentModelPort = {
      stream: async function* (request) {
        const prompt = request.messages.map(m => m.content).join('\n')
        prompts.push(prompt)
        const text = prompt.includes('检索关键词')
          ? '{"keywords":["阀体","伴热夹套"]}'
          : prompt.includes('把权利要求拆分为编号要素')
            ? JSON.stringify({ elements: [], rows: [] })
            : '解析结果：包括阀体与设置在阀体外侧的伴热夹套。'
        yield { type: 'delta', text }
        yield { type: 'done' }
      },
    }
    const search = async () => [
      {
        title: 'D1 阀体结构',
        publicationDate: '2023-01-01',
        url: 'https://example.com/d1',
        snippet: '阀体外侧设置伴热夹套',
      },
      {
        title: 'D2 后公开',
        publicationDate: '2024-07-01',
        url: 'https://example.com/d2',
        snippet: '申请日之后公开的伴热夹套',
      },
    ]
    const tool = createPatentWorkflowRunTool({ model, search })
    const value = (await tool.execute(
      {
        manifestId: 'patent_patentability_v1',
        input: '一种阀体伴热夹套结构',
        claims: '1. 一种阀体伴热夹套结构，其特征在于，包括阀体和设置在阀体外侧的伴热夹套。',
        filingDate: '2024-06-01',
        approveStageIds: ['approval'],
      },
      exec,
    )) as PatentWorkflowRunOutput
    expect(value.ok).toBe(true)
    const stages = (value.stages ?? []) as WorkflowStageResult[]
    expect(stages.find(stage => stage.stageId === 'time_baseline')?.degraded).toBe(false)
    const filter = stages.find(stage => stage.stageId === 'prior_art_filter')
    expect(filter?.degraded).toBe(false)
    expect(filter?.output).toContain('保留 1 篇')
    expect(filter?.output).toContain('排除 1 篇')
    const draftSpecification = stages.find(stage => stage.stageId === 'draft_specification')
    expect(draftSpecification?.degraded).toBe(false)
    expect(draftSpecification?.output).toContain('## 技术领域')
    const specCheck = stages.find(stage => stage.stageId === 'spec_check')
    expect(specCheck?.degraded).toBe(false)
    expect(specCheck?.output).toContain('说明书合规检查')
    // claim-chart 未显式收到 chart_targets：目标由过滤后的 prior_art 派生，排除的 D2 不进入映射。
    const chartPrompt = prompts.find(prompt => prompt.includes('把权利要求拆分为编号要素'))
    expect(chartPrompt).toContain('D1（对比文件：D1 阀体结构')
    expect(chartPrompt).not.toContain('D2 后公开')
    const gaps = stages.find(stage => stage.stageId === 'legal_gaps')
    expect(gaps?.output).toContain('[通过] 专利法第22条第5款')
    expect(gaps?.output).toContain('[通过] 专利法第24条')
    expect(gaps?.output).toContain('专利法第26条第3款')
  })

  it('rejects a non-array conflictingApplications at the tool input boundary', async () => {
    const tool = createPatentWorkflowRunTool({ model: fakeModel(), search: async () => [] })
    await expect(
      tool.execute(
        { manifestId: 'patent_novelty_v1', input: 'x', conflictingApplications: '{"title":"E1"}' },
        exec,
      ),
    ).rejects.toThrow('conflictingApplications 必须是 JSON 数组')
  })

  it('rejects a non-array evidence list and an unparseable evidence deadline at the input boundary', async () => {
    const tool = createPatentWorkflowRunTool({ model: fakeModel(), search: async () => [] })
    await expect(
      tool.execute(
        { manifestId: 'patent_invalidation_v1', input: 'x', evidence: '{"title":"E1"}' },
        exec,
      ),
    ).rejects.toThrow('evidence 必须是 JSON 数组')
    await expect(
      tool.execute(
        { manifestId: 'patent_invalidation_v1', input: 'x', evidenceDeadline: 'not-a-date' },
        exec,
      ),
    ).rejects.toThrow('evidenceDeadline 不是可识别的日期')
  })

  it('runs the reexamination and invalidation manifests with their own grounds table and chart mode', async () => {
    const prompts: string[] = []
    const model: PatentModelPort = {
      stream: async function* (request) {
        prompts.push(request.messages.map(m => m.content).join('\n'))
        yield { type: 'delta', text: `产出${prompts.length}` }
        yield { type: 'done' }
      },
    }
    const tool = createPatentWorkflowRunTool({ model, search: async () => [] })
    // 同一份驳回决定按两种程序解读：理由表与图表模式都不同。
    const decision =
      '本驳回决定认为权利要求 1 不具备创造性（专利法第22条第3款），且该实用新型专利的修改超出原说明书范围（专利法第33条）。'

    const reexam = (await tool.execute(
      { manifestId: 'patent_reexamination_v1', input: decision },
      exec,
    )) as PatentWorkflowRunOutput
    expect(reexam.ok).toBe(true)
    expect(prompts.some(p => p.includes('场景模式：reexamination'))).toBe(true)
    const reexamNovelty = prompts.find(p => p.includes('新颖性单独对比'))
    expect(reexamNovelty).toContain('## 上游阶段产出: grounds')
    expect(reexamNovelty).toContain('创造性缺陷')
    expect(reexamNovelty).not.toContain('创造性无效')

    prompts.length = 0
    const invalid = (await tool.execute(
      { manifestId: 'patent_invalidation_v1', input: decision },
      exec,
    )) as PatentWorkflowRunOutput
    expect(invalid.ok).toBe(true)
    expect(prompts.some(p => p.includes('场景模式：invalidity'))).toBe(true)
    const invalidNovelty = prompts.find(p => p.includes('新颖性单独对比'))
    expect(invalidNovelty).toContain('创造性无效（不具备创造性）')
    expect(invalidNovelty).not.toContain('创造性缺陷')
  })

  it('throws setup_required for graph mode without a model', async () => {
    await expect(
      createPatentWorkflowRunTool().execute({ graph: 'novelty', input: 'x' }, exec),
    ).rejects.toThrow('未提供模型客户端')
  })

  it('runs the citation-check graph against priorArt JSON and reports grounding', async () => {
    const tool = createPatentWorkflowRunTool({ model: fakeModel(), search: fakeSearch })
    const value = (await tool.execute(
      { graph: 'citation-check', input: '参见对比文件 D1', priorArt: JSON.stringify([{ title: 'D1' }]) },
      exec,
    )) as PatentWorkflowRunOutput
    expect(value.ok).toBe(true)
    expect(value.mode).toBe('graph')
    expect(value.completed).toBe(true)
    const state = value.graphState as { citation_check_grounded?: unknown; citation_check_report?: unknown }
    expect(state.citation_check_grounded).toBe(true)
    expect(state.citation_check_report).toContain('引用全部接地')
  })

  it('marks a resumed graph run with degraded nodes incomplete, matching the manifest path', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-patent-wf-'))
    const failing: PatentModelPort = {
      stream: async function* () { throw new Error('model unavailable') },
    }
    const tool = createPatentWorkflowRunTool({ model: failing, search: fakeSearch, cwd: temp, ruleEvaluator: stubRuleEvaluator })
    const paused = (await tool.execute(
      { graph: 'novelty', input: '技术方案', caseId: 'case-graph' },
      exec,
    )) as PatentWorkflowRunOutput
    expect(paused.interruptNote).toBeDefined()
    expect((paused.graphDegraded ?? []).length).toBeGreaterThan(0)
    expect(paused.checkpointId).toBeDefined()

    const resumed = (await tool.execute(
      { graph: 'novelty', input: '技术方案', caseId: 'case-graph', approveCheckpointId: paused.checkpointId },
      exec,
    )) as PatentWorkflowRunOutput
    expect(resumed.interruptNote).toBeUndefined()
    expect((resumed.graphDegraded ?? []).length).toBeGreaterThan(0)
    expect(resumed.completed).toBe(false)
  })

  it('rejects a non-JSON priorArt at the input boundary', async () => {
    const tool = createPatentWorkflowRunTool({ model: fakeModel(), search: fakeSearch })
    await expect(
      tool.execute({ graph: 'citation-check', input: 'x', priorArt: 'not-json' }, exec),
    ).rejects.toThrow(PatentToolError)
    await expect(
      tool.execute({ graph: 'citation-check', input: 'x', priorArt: 'not-json' }, exec),
    ).rejects.toThrow('priorArt 必须是 JSON 数组')
  })

  it('rejects a non-array priorArt at the input boundary', async () => {
    const tool = createPatentWorkflowRunTool({ model: fakeModel(), search: fakeSearch })
    await expect(
      tool.execute({ graph: 'citation-check', input: 'x', priorArt: '{"title": "D1"}' }, exec),
    ).rejects.toThrow('priorArt 必须是 JSON 数组')
  })

  it('runs a full graph with persisted checkpoints and approval-gate resume', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-patent-wf-'))
    const cwd = temp
    const tool = createPatentWorkflowRunTool({ model: noveltyGraphModel(), search: fakeSearch, cwd, ruleEvaluator: stubRuleEvaluator })
    const value = (await tool.execute(
      { graph: 'novelty', input: 'x', caseId: 'case-1' },
      exec,
    )) as PatentWorkflowRunOutput
    expect(value.ok).toBe(true)
    expect(value.mode).toBe('graph')
    expect(value.checkpointNote).toBeDefined()
    expect(value.interruptNote).toBeDefined()

    // approveCheckpointId on an unknown checkpoint → soft error.
    const approve = (await tool.execute(
      { graph: 'novelty', input: 'x', caseId: 'case-1', approveCheckpointId: 'nope' },
      exec,
    )) as PatentWorkflowRunOutput
    expect(approve.ok).toBe(false)
    expect(approve.error).toContain('检查点')

    // Granting the checkpoint the interrupted run left behind resumes past the gate.
    const granted = (await tool.execute(
      { graph: 'novelty', input: 'x', caseId: 'case-1', approveCheckpointId: 'patent_novelty-6' },
      exec,
    )) as PatentWorkflowRunOutput
    expect(granted.ok).toBe(true)
    expect(granted.completed).toBe(true)
    expect(granted.interruptNote).toBeUndefined()
  })

  it('rejects a corrupted persisted checkpoint instead of silently resuming from the initial state', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-patent-wf-'))
    const cwd = temp
    const tool = createPatentWorkflowRunTool({ model: noveltyGraphModel(), search: fakeSearch, cwd, ruleEvaluator: stubRuleEvaluator })

    // 缺 state 的 checkpoint 正是 issue #601 报告的形状：过去会被当作有效记录，
    // resume 时引擎把 undefined 静默换成初始状态，恢复变成无声重跑。
    const checkpointsDir = join(cwd, caseWorkflowRunsDir('case-1'), 'checkpoints')
    await mkdir(checkpointsDir, { recursive: true })
    const checkpointFile = join(checkpointsDir, 'patent_novelty-0.json')
    await writeFile(checkpointFile, JSON.stringify({ id: 'patent_novelty-0', graphId: 'patent_novelty' }), 'utf8')

    await expect(tool.execute(
      { graph: 'novelty', input: 'x', caseId: 'case-1', resumeCheckpointId: 'patent_novelty-0' },
      exec,
    )).rejects.toThrow(/patent_novelty-0\.json/)
  })

  it('marks a graph run with a handler-returned _error incomplete and keeps internal keys out of state', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-patent-wf-'))
    const base = noveltyGraphModel()
    const failingKeywords: PatentModelPort = {
      stream: async function* (request) {
        const prompt = request.messages.map(m => m.content).join('\n')
        if (prompt.includes('检索关键词')) {
          yield { type: 'delta', text: '不是 JSON' }
          yield { type: 'done' }
          return
        }
        yield* base.stream(request)
      },
    }
    const tool = createPatentWorkflowRunTool({ model: failingKeywords, search: fakeSearch, cwd: temp, ruleEvaluator: stubRuleEvaluator })

    const paused = (await tool.execute(
      { graph: 'novelty', input: 'x', caseId: 'case-degraded' },
      exec,
    )) as PatentWorkflowRunOutput
    expect(paused.interruptNote).toBeDefined()
    expect(JSON.stringify(paused.graphDegraded)).toContain('node_failed')
    expect(paused.graphState).not.toHaveProperty('_error')
    expect(paused.graphState).not.toHaveProperty('_retryable')

    const granted = (await tool.execute(
      { graph: 'novelty', input: 'x', caseId: 'case-degraded', approveCheckpointId: paused.checkpointId },
      exec,
    )) as PatentWorkflowRunOutput
    expect(granted.interruptNote).toBeUndefined()
    expect(granted.completed).toBe(false)
    expect(JSON.stringify(granted.graphDegraded)).toContain('node_failed')
  })

  it('runs the manifest to completion with approved gates and persistence', async () => {
    temp = await mkdtemp(join(tmpdir(), 'dsh-patent-wf-'))
    const tool = createPatentWorkflowRunTool({ model: fakeModel(), search: fakeSearch, cwd: temp })
    const value = (await tool.execute(
      {
        manifestId: 'patent_disclosure_v1',
        input: 'technical disclosure',
        caseId: 'case-2',
        approveStageIds: ['review_gate'],
        maxResults: 3,
        chartTargets: '[]',
      },
      exec,
    )) as PatentWorkflowRunOutput
    expect(value.ok).toBe(true)
    // 审批门被放行且在回退范围之外：不中断，继续执行到收口。
    expect(value.interruptNote).toBeUndefined()
    expect(value.persistNote).toContain('持久化:')
    expect((value.degradedSteps ?? []).length).toBeGreaterThan(0)
  })

  it('disclosure manifest: a slop-heavy draft rewinds via the real slop-gate and exhausts', async () => {
    // 策略表给出可锚定的特征；从权专员固定产出套话条文，真实 SlopGateHandler 判失败
    // → 回退 draft_claims 重跑 → 仍失败 → maxRetries 耗尽降级。
    const strategy = {
      essential_features: [{ id: 'F1', text: 'technical feature', anchor: 'technical' }],
      optional_features: [{ id: 'F2', text: 'disclosure feature', anchor: 'disclosure' }],
      dependent_tree: [{ number: 2, parent: 1, feature_id: 'F2' }],
      prior_art_ref: null,
    }
    const sloppyDependents = [
      '进一步地，此外，值得一提的是，本申请具有显著进步。',
    ]
    const model: PatentModelPort = {
      stream: async function* (request) {
        const prompt = request.messages.map(message => message.content).join('\n')
        const text = prompt.includes('确定特征归属')
          ? JSON.stringify(strategy)
          : prompt.includes('从属权利要求专员')
            ? JSON.stringify({ dependents: [{ number: 2, parent: 1, feature_id: 'F2', text: sloppyDependents[0]! }] })
            : JSON.stringify({ claims: sloppyDependents, notes: '撰写说明' })
        yield { type: 'delta', text }
        yield { type: 'done' }
      },
    }
    const tool = createPatentWorkflowRunTool({ model, search: fakeSearch })
    const value = (await tool.execute(
      { manifestId: 'patent_disclosure_v1', input: 'technical disclosure', approveStageIds: ['review_gate'], maxResults: 3 },
      exec,
    )) as PatentWorkflowRunOutput
    // 耗尽标记只在回退超过 maxRetries 时出现——证明 rewind 真实发生。
    // stages 在输出类型中是 JsonValue[]，运行值为 WorkflowStageResult[]（单向断言合法）。
    const stages = (value.stages ?? []) as WorkflowStageResult[]
    const slopClean = stages.filter(s => s.stageId === 'slop_clean')
    expect(slopClean).toHaveLength(1)
    expect(slopClean[0]!.output).toMatch(/\[WORKFLOW_RETRY_EXHAUSTED\]/)
    expect(slopClean[0]!.degraded).toBe(true)
    // 回退 splice 掉首轮结果，最终轮 draft 保留重跑后的套话草稿。
    const draftClaims = stages.filter(s => s.stageId === 'draft_claims')
    expect(draftClaims).toHaveLength(1)
    expect(draftClaims[0]!.output).toContain('进一步地')
    expect(value.degradedSteps).toContain('slop_clean')
  })

  it('renders graph edge cases and manifest prose', () => {
    // 运行期图状态可含 undefined 值，JsonValue 无法表达该键，故在类型合法的对象上挂载。
    const sparseState: Record<string, JsonValue> = {
      rule_gate: { status: 'pass' },
      payload: { a: 1 },
      long: '长'.repeat(90),
    }
    Object.defineProperty(sparseState, 'note', { value: undefined, enumerable: true })
    const sparse = renderWorkflowRun({
      ok: true,
      mode: 'graph',
      manifestId: 'patent_novelty',
      graph: 'novelty',
      completed: true,
      summary: '',
      stages: [],
      degradedSteps: [],
      graphState: sparseState,
      graphDegraded: [
        { severity: 'info', reason: 'no_model', message: '节点降级', stateKeys: ['x'] },
      ],
      checkpointNote: '检查点: patent_novelty-1',
      persistNote: '持久化: x',
      interruptNote: '⏸ 审批门暂停',
    })
    expect(sparse).toContain('完成状态: completed')
    expect(sparse).toContain('⚠️ 降级标记')
    expect(sparse).toContain('(空)')
    expect(sparse).toContain('payload')
    expect(sparse).toContain('长'.repeat(90).slice(0, 80))

    for (const graphState of [{}, { rule_gate: null }, { rule_gate: { status: 42 } }]) {
      const withoutGate = renderWorkflowRun({
        ok: true,
        mode: 'graph',
        manifestId: 'patent_novelty',
        graph: 'novelty',
        completed: true,
        summary: '',
        stages: [],
        degradedSteps: [],
        graphState,
        graphDegraded: [],
        checkpointNote: '检查点: 无',
      })
      expect(withoutGate).toContain('规则门 status: （未启用）')
    }

    const manifestWithInterrupt = renderWorkflowRun({
      ok: true,
      mode: 'manifest',
      manifestId: 'patent_disclosure_v1',
      completed: false,
      summary: 's',
      stages: [],
      degradedSteps: [],
      persistNote: '',
      interruptNote: '⏸ 审批门暂停',
    })
    expect(manifestWithInterrupt).toContain('⏸ 审批门暂停')

    const manifestBare = renderWorkflowRun({
      ok: true,
      mode: 'manifest',
      manifestId: 'patent_disclosure_v1',
      completed: true,
      summary: 's',
      stages: [],
      degradedSteps: [],
    })
    expect(manifestBare).toContain('完成状态: completed')

    const fallbacks = renderWorkflowRun({
      ok: true,
      mode: 'graph',
      manifestId: 'patent_novelty',
      graph: 'novelty',
      summary: '',
      stages: [],
      degradedSteps: [],
    })
    expect(fallbacks).toContain('（未启用）')
    expect(fallbacks).toContain('检查点: 无')
    expect(fallbacks).toContain('✅ 无降级')

    const failed = renderWorkflowRun({ ok: false, mode: 'manifest', manifestId: 'm', error: '坏' })
    expect(failed).toContain('坏')
    const bareFailed = renderWorkflowRun({ ok: false, mode: 'manifest', manifestId: 'm' })
    expect(bareFailed).toContain('失败')
  })

  it('renders through the registered tool', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.tools.register(createPatentWorkflowRunTool())
    const signal = new AbortController().signal
    const result = await executeToolFixture(ctx, {
      signal,
      callId: ToolCallId('wfr-1'),
      name: 'patent_workflow_run',
      arguments: { manifestId: 'nope', input: 'x' },
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const text = result.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
    expect(text).toContain('未知 manifest')
  })
})

describe('patent_workflow_run — run records', () => {
  it('returns the run evidence ledger and appends run, ledger, and legal-gaps events', async () => {
    const events: Array<{ type: string; data: unknown }> = []
    const tool = createPatentWorkflowRunTool({ model: fakeModel(), search: async () => [] })
    const value = (await tool.execute(
      {
        manifestId: 'patent_novelty_v1',
        input: '交底书正文',
        filingDate: '2024-06-01',
        priorArt: JSON.stringify([
          { title: '对比文件 1', url: 'https://example.test/D1', publicationDate: '2020-01-01' },
        ]),
      },
      toolExec(true, (type, data) => { events.push({ type, data }) }),
    )) as PatentWorkflowRunOutput

    expect(value.ok).toBe(true)
    const ledger = value.evidenceLedger as { receipts: Array<{ citationId: string; source: string }> }
    expect(ledger.receipts.map(receipt => [receipt.citationId, receipt.source])).toEqual([
      ['MATERIAL', 'material'],
      ['D1', 'prior-art'],
    ])
    const runEvents = events.filter(event => event.type === 'patent/workflow-run')
    expect(runEvents).toHaveLength(1)
    expect(runEvents[0]!.data).toMatchObject({ manifestId: 'patent_novelty_v1' })

    const ledgerEvents = events.filter(event => event.type === 'patent/evidence-ledger')
    expect(ledgerEvents).toHaveLength(1)
    expect(ledgerEvents[0]!.data).toMatchObject({ manifestId: 'patent_novelty_v1' })

    const gapEvents = events.filter(event => event.type === 'patent/legal-gaps')
    expect(gapEvents).toHaveLength(1)
    expect(gapEvents[0]!.data).toMatchObject({ manifestId: 'patent_novelty_v1' })
    expect((gapEvents[0]!.data as { report: string }).report).toContain('法条缺口汇总')
  })
})

describe('specification workflow gates', () => {
  const runDisclosure = async (extra: Record<string, unknown>) => {
    const tool = createPatentWorkflowRunTool({ model: fakeModel(), search: fakeSearch })
    return (await tool.execute(
      {
        manifestId: 'patent_disclosure_v1',
        input: '本实施例提供一种检测装置，包括壳体和设置在壳体内的弹簧。',
        approveStageIds: ['review_gate'],
        ...extra,
      },
      exec,
    )) as PatentWorkflowRunOutput
  }

  it('passes a complete invention draft without drawings through spec-check and legal-gaps', async () => {
    const value = await runDisclosure({
      title: '一种检测装置',
      abstract: '摘要内容。关键词：检测。',
      background: '现有检测装置的检测精度不足。',
      patentType: 'invention',
      hasDrawings: false,
    })
    expect(value.ok).toBe(true)
    const stages = (value.stages ?? []) as WorkflowStageResult[]
    const draft = stages.find(stage => stage.stageId === 'draft_specification')
    expect(draft?.output).toContain('现有检测装置的检测精度不足。')
    expect(draft?.output).toContain('专利类型: invention')
    expect(draft?.output).toContain('**说明书草案（一种检测装置）**')
    const specCheck = stages.find(stage => stage.stageId === 'spec_check')
    expect(specCheck?.degraded).toBe(false)
    expect(specCheck?.output).toContain('说明书合规检查（A26.3/A26.4）：通过')
    const gaps = stages.find(stage => stage.stageId === 'legal_gaps')
    expect(gaps?.output).toContain('[通过] 专利法实施细则第20条、第21条')
    expect(gaps?.output).toContain('[未评估] 专利法第26条第3款')
  })

  it('parses the sub-agent figure-analysis output into the array spec-check reads', async () => {
    const fallback = fakeModel()
    const model: PatentModelPort = {
      stream: async function* (request) {
        const prompt = request.messages.map(message => message.content).join('\n')
        if (!prompt.includes('逐图分析附图')) {
          yield* fallback.stream(request)
          return
        }
        yield { type: 'delta', text: '[{"figureNumber":1,"usable":true,"components":[{"refNumber":"1"}]}]' }
        yield { type: 'done' }
      },
    }
    const tool = createPatentWorkflowRunTool({ model, search: fakeSearch })
    const value = await tool.execute({
      manifestId: 'patent_disclosure_v1',
      input: '本实施例提供一种检测装置，包括壳体。',
      approveStageIds: ['review_gate'],
      title: '一种检测装置',
      patentType: 'invention',
      hasDrawings: true,
      figureFiles: ['fig1.svg'],
    }, exec) as PatentWorkflowRunOutput
    const stages = (value.stages ?? []) as WorkflowStageResult[]
    const parsed = stages.find(stage => stage.stageId === 'figure_analysis_parse')
    expect(parsed?.degraded).toBe(false)
    expect(parsed?.output).toContain('"usable": true')
  })

  it('fails a utility model without drawings and blocks the form checkpoint', async () => {
    const value = await runDisclosure({
      title: '一种检测装置',
      background: '现有检测装置的检测精度不足。',
      patentType: 'utility_model',
      hasDrawings: false,
      figureAnalysis: JSON.stringify([
        { figureNumber: 1, usable: true, components: [{ refNumber: '1' }] },
        { usable: true, components: [] },
      ]),
      drawingCount: 1,
      abstractFigureNumber: 1,
      figureFiles: ['fig1.svg'],
    })
    const stages = (value.stages ?? []) as WorkflowStageResult[]
    const specCheck = stages.find(stage => stage.stageId === 'spec_check')
    expect(specCheck?.output).toContain('未通过')
    const gaps = stages.find(stage => stage.stageId === 'legal_gaps')
    expect(gaps?.output).toContain('[未通过] 专利法实施细则第20条、第21条')
  })
})

describe('specification inputs', () => {
  it('maps title, abstract, patent type, drawings and figure analysis into the workflow state', () => {
    const ctx = buildWorkflowRunContext({
      input: '技术交底书',
      title: '一种检测装置',
      abstract: '摘要内容。',
      background: '现有检测装置精度不足。',
      patentType: 'utility_model',
      hasDrawings: true,
      figureAnalysis: [{ figureNumber: 1, usable: true, components: [{ refNumber: '1' }] }],
      figureFiles: ['fig1.svg'],
      drawingCount: 1,
      abstractFigureNumber: 1,
    })
    expect(ctx).toMatchObject({
      title: '一种检测装置',
      abstract: '摘要内容。',
      background: '现有检测装置精度不足。',
      patent_type: 'utility_model',
      has_drawings: true,
      figure_analysis: [{ figureNumber: 1, usable: true, components: [{ refNumber: '1' }] }],
      figure_files: ['fig1.svg'],
      drawing_count: 1,
      abstract_figure_number: 1,
    })
  })

  it('rejects malformed figure-analysis entries at the tool input boundary', async () => {
    const tool = createPatentWorkflowRunTool({ model: fakeModel(), search: fakeSearch })
    const cases: Array<[string, string]> = [
      ['{"usable":true}', 'figureAnalysis 必须是 JSON 数组'],
      ['[null]', 'figureAnalysis[0] 必须是对象'],
      ['[{"usable":"yes","components":[]}]', 'figureAnalysis[0].usable 必须是布尔值'],
      ['[{"usable":true,"figureNumber":0,"components":[]}]', 'figureAnalysis[0].figureNumber 必须是正整数'],
      ['[{"usable":true}]', 'figureAnalysis[0].components 必须是数组'],
      ['[{"usable":true,"components":[null]}]', 'figureAnalysis[0].components[0] 必须是对象'],
      ['[{"usable":true,"components":[{"refNumber":1}]}]', 'figureAnalysis[0].components[0].refNumber 必须是字符串'],
    ]
    for (const [figureAnalysis, message] of cases) {
      await expect(
        tool.execute({ manifestId: 'patent_disclosure_v1', input: 'x', figureAnalysis }, exec),
        message,
      ).rejects.toThrow(message)
    }
  })

  it('rejects non-positive drawing counts and abstract figure numbers', async () => {
    const tool = createPatentWorkflowRunTool({ model: fakeModel(), search: fakeSearch })
    await expect(
      tool.execute({ manifestId: 'patent_disclosure_v1', input: 'x', drawingCount: 0 }, exec),
    ).rejects.toThrow(/drawingCount/)
    await expect(
      tool.execute({ manifestId: 'patent_disclosure_v1', input: 'x', abstractFigureNumber: 0 }, exec),
    ).rejects.toThrow(/abstractFigureNumber/)
  })
})

describe('patent_oa_response_v1 的反套话门（真实原子装配）', () => {
  /** 套话答复：两句话、零证据锚点，正是门要拦的形状。 */
  const BOILERPLATE_DRAFT = [
    '申请人恳请审查员重新考虑本申请的创造性。',
    '',
    '综上所述，本申请具备创造性。',
  ].join('\n')

  /** 合规答复：点明争点、带对比文件段落与事实编号。 */
  const COMPLIANT_DRAFT = [
    '## 一、总体立场',
    '',
    '审查意见对权利要求 1 的创造性异议不能成立。修改后的权利要求 1 已补入温度联动特征，D1 与 D2 均未给出该特征的结合启示，请求在修改文本的基础上继续审查。',
    '',
    '## 三、本案事实',
    '',
    '- F1：权利要求 1 记载「壳体内设置温控腔」。',
    '- F2：权利要求 1 记载温度联动特征，见说明书第 3.1 节。',
    '',
    '## 四、适用规则',
    '',
    '- R1：专利法第 22 条第 3 款，创造性以三步法判断。',
    '',
    '## 五、意见陈述',
    '',
    'D1 段 [0042] 仅公开壳体与加热腔，未公开温度联动特征 F2。',
  ].join('\n')

  /**
   * 按阶段描述分流的最小模型：draft 阶段返回给定正文，tighten 阶段原样交回
   * （本案样例本来就该删的不多），其余阶段返回 JSON 占位。
   * @param draft - draft 阶段产出的答复正文。
   * @param onDraft - 每次 draft 阶段被调用时的回调（用于数回退次数）。
   * @returns 模型端口替身。
   */
  function oaModel(draft: string, onDraft: () => void): PatentModelPort {
    return {
      stream: async function* (request) {
        const prompt = request.messages.map(m => m.content).join('\n')
        const isDraft = prompt.includes('撰写意见陈述书')
        const isTighten = prompt.includes('压进篇幅预算')
        if (isDraft) onDraft()
        yield {
          type: 'delta',
          text: isDraft ? draft : isTighten ? JSON.stringify({ tightened: draft, removed: [] }) : '{}',
        }
        yield { type: 'done' }
      },
    }
  }

  /**
   * 跑一遍 OA 答复链路的 manifest 路径。
   * @param draft - draft 阶段产出的答复正文。
   * @returns 阶段结果列表与 draft 阶段被调用的次数。
   */
  async function runOa(draft: string): Promise<{ stages: WorkflowStageResult[]; draftCalls: number }> {
    let draftCalls = 0
    const tool = createPatentWorkflowRunTool({
      model: oaModel(draft, () => { draftCalls += 1 }),
      search: fakeSearch,
    })
    const value = (await tool.execute(
      { manifestId: 'patent_oa_response_v1', input: '审查意见正文', claims: '权利要求 1' },
      exec,
    )) as PatentWorkflowRunOutput
    return { stages: (value.stages ?? []) as WorkflowStageResult[], draftCalls }
  }

  it('rejects a boilerplate draft, rewinds once, then records the exhausted gate', async () => {
    const { stages, draftCalls } = await runOa(BOILERPLATE_DRAFT)
    const gate = stages.find(stage => stage.stageId === 'slop_gate')
    // 模型两次都给同一段套话：回退一次后信号仍在，门按耗尽处理并保留「需修订」。
    expect(gate?.output).toContain('需修订')
    expect(gate?.output).toContain('通过线 35')
    expect(gate?.degraded).toBe(true)
    // 回退目标就是 draft：原稿只有一次机会，回退后 draft 被重新调用一次。
    expect(draftCalls).toBe(2)
    // 结果里只留重写后的那一稿（回退会 splice 掉旧结果）。
    expect(stages.filter(stage => stage.stageId === 'draft')).toHaveLength(1)
  })

  it('passes a compliant response without rewinding the draft', async () => {
    const { stages, draftCalls } = await runOa(COMPLIANT_DRAFT)
    const gate = stages.find(stage => stage.stageId === 'slop_gate')
    expect(gate?.output).toContain('✅ 通过')
    expect(gate?.degraded).toBe(false)
    // 通过即不触发回退：draft 只被调用一次。
    expect(draftCalls).toBe(1)
  })
})

let temp: string | undefined

/**
 * 本文件启动过的后台 run。带 caseId 的 run 把运行记录写进 `temp`，且是先写兄弟临时
 * 文件再 rename；删除目录时若 run 仍在写，递归删除会在 rename 落地前撞上那个临时文件
 * 而以 ENOTEMPTY 失败。teardown 先等它们结算。
 */
const outstanding: JobHooks[] = []

afterEach(async () => {
  await Promise.all(outstanding.splice(0).map(hook => hook.done))
  if (temp !== undefined) {
    await rm(temp, { recursive: true, force: true })
    temp = undefined
  }
})
