// D14：patent-workflow 的恢复、重复调用与 HITL 审批执行点。
//
// 目录锁定三类契约：
// 1. 审批门暂停后的恢复路径——暂停结果落盘、带放行重跑覆盖同一条记录、不带放行
//    重跑仍停在原门；
// 2. 重复调用——同一 runId 的两次完成运行写入逐字相同的记录，不追加、不累积阶段；
// 3. HITL 在执行点生效——放行只作用于点名的门、拒绝后后续阶段不执行、相邻门逐个
//    取决策、放行名单拼错时运行前拒绝而不是静默忽略。
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ApprovalGateHandler,
  AtomRegistry,
  InterruptStageError,
  StageHandlerRegistry,
  type PipelineState,
  type StageHandler,
} from '@deepseek-ai/dsh-patent-core'
import {
  JsonFileWorkflowRunStore,
  runWorkflow,
  type WorkflowManifest,
  type WorkflowStage,
} from '@deepseek-ai/dsh-patent-workflow'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-wf-recovery-'))
  temporaryDirectories.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function stage(id: string, overrides: Partial<WorkflowStage> = {}): WorkflowStage {
  return { id, strategy: 'chain', description: id, ...overrides }
}

function manifest(id: string, stages: WorkflowStage[]): WorkflowManifest {
  return { id, name: id, caseType: 'test', stages }
}

function atomRegistry(names: string[]): AtomRegistry {
  const atoms = new AtomRegistry()
  for (const name of names) {
    atoms.register({ name, description: name, category: 'extract', inputSchema: [], outputSchema: ['out'] })
  }
  return atoms
}

/** 真实审批门 handler：未放行时抛 InterruptStageError，放行时返回空段。 */
function gateHandlers(): StageHandlerRegistry {
  const handlers = new StageHandlerRegistry()
  handlers.register(new ApprovalGateHandler())
  return handlers
}

const okExecutor = async (s: WorkflowStage): Promise<string> => `[${s.id}] 完成`

/** 起草 → 审批门 → 交付；门禁位于交付之前。 */
function recoveredManifest(): WorkflowManifest {
  return manifest('recovery_v1', [
    stage('draft'),
    stage('gate', { atom: 'approval-gate', params: { review_context: '确认草稿' } }),
    stage('deliver'),
  ])
}

describe('workflow run recovery — paused run and rerun', () => {
  it('persists the paused run, then completes it by rerunning with the gate grant under one record', async () => {
    const dir = await temporaryDirectory()
    const store = new JsonFileWorkflowRunStore(dir)
    const runId = 'case-1__recovery_v1'
    const calls: string[] = []
    const executor = async (s: WorkflowStage): Promise<string> => {
      calls.push(s.id)
      return `[${s.id}] 完成`
    }
    const options = {
      handlers: gateHandlers(),
      atoms: atomRegistry(['approval-gate']),
      persist: store,
      runId,
    }

    const paused = await runWorkflow(recoveredManifest(), { input: '交底书' }, executor, options)
    expect(paused.completed).toBe(false)
    expect(paused.interrupted?.stageId).toBe('gate')
    expect(paused.interrupted?.message).toContain('确认草稿')
    expect(paused.stages.map(result => result.stageId)).toEqual(['draft'])
    expect(paused.summary).toContain('在 "gate" 暂停等待人工确认')

    const pausedRecord = await store.loadRun(runId)
    expect(pausedRecord).toEqual(paused)
    expect(pausedRecord?.interrupted?.stageId).toBe('gate')
    expect(pausedRecord?.completed).toBe(false)

    const resumed = await runWorkflow(recoveredManifest(), { input: '交底书' }, executor, {
      ...options,
      approvalGrants: ['gate'],
    })
    expect(resumed.completed).toBe(true)
    expect(resumed.interrupted).toBeUndefined()
    expect(resumed.stages.map(result => result.stageId)).toEqual(['draft', 'gate', 'deliver'])
    expect(resumed.stages[1]?.output).toBe('APPROVED')

    const resumedRecord = await store.loadRun(runId)
    expect(resumedRecord).toEqual(resumed)
    expect(resumedRecord?.interrupted).toBeUndefined()
    // 同 runId 重跑覆盖旧记录，不追加第二次运行。
    expect(await store.listRuns()).toEqual([runId])
    // 恢复是整次重跑：门前的 draft 再执行一次，交付阶段只在恢复后执行（R-77）。
    expect(calls).toEqual(['draft', 'draft', 'deliver'])
  })

  it('leaves the same paused record byte-identical when rerun without the grant', async () => {
    const dir = await temporaryDirectory()
    const store = new JsonFileWorkflowRunStore(dir)
    const runId = 'case-2__recovery_v1'
    const options = {
      handlers: gateHandlers(),
      atoms: atomRegistry(['approval-gate']),
      persist: store,
      runId,
    }

    const first = await runWorkflow(recoveredManifest(), {}, okExecutor, options)
    const firstText = await readFile(join(dir, `${runId}.json`), 'utf8')
    const second = await runWorkflow(recoveredManifest(), {}, okExecutor, options)
    const secondText = await readFile(join(dir, `${runId}.json`), 'utf8')

    expect(second).toEqual(first)
    expect(secondText).toBe(firstText)
    expect(await store.listRuns()).toEqual([runId])
  })

  it('reloads a paused record through a fresh store instance', async () => {
    const dir = await temporaryDirectory()
    const runId = 'case-3__recovery_v1'
    await runWorkflow(recoveredManifest(), {}, okExecutor, {
      handlers: gateHandlers(),
      atoms: atomRegistry(['approval-gate']),
      persist: new JsonFileWorkflowRunStore(dir),
      runId,
    })

    const reopened = await new JsonFileWorkflowRunStore(dir).loadRun(runId)
    expect(reopened?.completed).toBe(false)
    expect(reopened?.stages.map(result => result.stageId)).toEqual(['draft'])
    expect(reopened?.interrupted).toMatchObject({ stageId: 'gate', message: '确认草稿' })
  })

  it('a pause is incomplete even when the manifest tolerates degraded stages', async () => {
    const tolerant = recoveredManifest()
    tolerant.validation = { requireAllSteps: false }
    const result = await runWorkflow(tolerant, {}, okExecutor, {
      handlers: gateHandlers(),
      atoms: atomRegistry(['approval-gate']),
    })
    expect(result.degradedSteps).toEqual([])
    expect(result.completed).toBe(false)
    expect(result.interrupted?.stageId).toBe('gate')
  })

  it('a persist failure on the paused run still recovers on a later run with a working store', async () => {
    const dir = await temporaryDirectory()
    const runId = 'case-4__recovery_v1'
    const paused = await runWorkflow(recoveredManifest(), {}, okExecutor, {
      handlers: gateHandlers(),
      atoms: atomRegistry(['approval-gate']),
      persist: {
        saveRun: async () => { throw new Error('磁盘已满') },
        loadRun: async () => undefined,
        listRuns: async () => [],
      },
      runId,
    })
    expect(paused.interrupted?.stageId).toBe('gate')
    expect(paused.persistWarning).toContain('磁盘已满')

    const resumed = await runWorkflow(recoveredManifest(), {}, okExecutor, {
      handlers: gateHandlers(),
      atoms: atomRegistry(['approval-gate']),
      persist: new JsonFileWorkflowRunStore(dir),
      runId,
      approvalGrants: ['gate'],
    })
    expect(resumed.completed).toBe(true)
    expect((await new JsonFileWorkflowRunStore(dir).loadRun(runId))?.completed).toBe(true)
  })
})

describe('workflow run recovery — repeated completed runs', () => {
  it('rewrites the same record for two runs with deterministic stages', async () => {
    const dir = await temporaryDirectory()
    const store = new JsonFileWorkflowRunStore(dir)
    const runId = 'case-5__repeat_v1'
    const workflow = manifest('repeat_v1', [stage('a'), stage('b')])
    const calls: string[] = []
    const executor = async (s: WorkflowStage): Promise<string> => {
      calls.push(s.id)
      return `[${s.id}] 完成`
    }

    const first = await runWorkflow(workflow, { input: '同一输入' }, executor, { persist: store, runId })
    const firstText = await readFile(join(dir, `${runId}.json`), 'utf8')
    const second = await runWorkflow(workflow, { input: '同一输入' }, executor, { persist: store, runId })
    const secondText = await readFile(join(dir, `${runId}.json`), 'utf8')

    expect(first.completed).toBe(true)
    expect(second).toEqual(first)
    expect(secondText).toBe(firstText)
    expect(await store.listRuns()).toEqual([runId])
    expect(calls).toEqual(['a', 'b', 'a', 'b'])
  })
})

describe('workflow HITL approval — decision at the execution point', () => {
  /** 记录每个门被询问的次序；默认拒绝，便于断言「一个门只取一个决策」。 */
  function recordingGate(started: string[], approvals: readonly string[]): StageHandler {
    return {
      name: 'approval-gate',
      category: 'gate',
      execute: async ({ state }: { state: PipelineState }): Promise<PipelineState> => {
        const tag = String(state['tag'])
        started.push(tag)
        if (approvals.includes(tag)) return {}
        throw new InterruptStageError('approval-gate', `确认 ${tag}`, { tag })
      },
    }
  }

  function twoGateManifest(): WorkflowManifest {
    return manifest('two_gates_v1', [
      stage('gate_a', { atom: 'approval-gate', params: { tag: 'a' } }),
      stage('gate_b', { atom: 'approval-gate', params: { tag: 'b' } }),
      stage('deliver'),
    ])
  }

  it('asks adjacent approval gates one at a time and stops before the second on refusal', async () => {
    const started: string[] = []
    const handlers = new StageHandlerRegistry()
    handlers.register(recordingGate(started, []))
    const result = await runWorkflow(twoGateManifest(), {}, okExecutor, {
      handlers,
      atoms: atomRegistry(['approval-gate']),
    })
    // 拒绝第一个门后不再询问第二个门：两次人工决策不能并发收集。
    expect(started).toEqual(['a'])
    expect(result.interrupted?.stageId).toBe('gate_a')
    expect(result.stages).toEqual([])
  })

  it('a grant approves only the named gate; the next gate still pauses and later stages do not run', async () => {
    const executed: string[] = []
    const result = await runWorkflow(twoGateManifest(), {}, async (s) => {
      executed.push(s.id)
      return `[${s.id}] 完成`
    }, {
      handlers: gateHandlers(),
      atoms: atomRegistry(['approval-gate']),
      approvalGrants: ['gate_a'],
    })
    expect(result.completed).toBe(false)
    expect(result.interrupted?.stageId).toBe('gate_b')
    expect(result.stages.map(entry => entry.stageId)).toEqual(['gate_a'])
    expect(executed).toEqual([])
  })

  it('rejects a grant naming an unknown stage before executing anything', async () => {
    const executed: string[] = []
    await expect(runWorkflow(recoveredManifest(), {}, async (s) => {
      executed.push(s.id)
      return '[ok]'
    }, {
      handlers: gateHandlers(),
      atoms: atomRegistry(['approval-gate']),
      approvalGrants: ['gtae'],
    })).rejects.toThrow(/approvalGrants.*gtae/)
    expect(executed).toEqual([])
  })

  it('rejects a grant naming a stage that is not an approval gate', async () => {
    await expect(runWorkflow(recoveredManifest(), {}, okExecutor, {
      handlers: gateHandlers(),
      atoms: atomRegistry(['approval-gate']),
      approvalGrants: ['draft'],
    })).rejects.toThrow(/不是本 manifest 的审批门阶段/)
  })

  it('rejects a grant when the manifest declares no approval gate', async () => {
    await expect(runWorkflow(manifest('no_gates_v1', [stage('a')]), {}, okExecutor, {
      approvalGrants: ['a'],
    })).rejects.toThrow(/该 manifest 没有审批门/)
  })
})
