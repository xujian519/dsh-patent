import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { globalAtomRegistry, registerBuiltinAtoms, StoredRecordError } from '@deepseek-ai/dsh-patent-core'
import type { StageProvider, WorkflowManifest } from '@deepseek-ai/dsh-patent-core'
import {
  InMemoryWorkflowRunStore,
  JsonFileWorkflowRunStore,
  patentNoveltyManifest,
  runWorkflow,
  type WorkflowContext,
  type WorkflowRunStore,
  type WorkflowStage,
} from '@deepseek-ai/dsh-patent-workflow'

// 镜像生产装配（B1）：内置原子注册进全局注册表，novelty 等 manifest 的 atom 阶段才能通过 fail-fast。
registerBuiltinAtoms()
// legal-gaps 的真实注册在 patent-tools apply()；此处注册契约 stub 使内置 manifest 通过校验。
globalAtomRegistry.register({
  name: 'legal-gaps',
  category: 'gate',
  description: 'test stub — 真实注册在 patent-tools apply()',
  inputSchema: [],
  outputSchema: ['legal_gaps_report'],
})

function okExecutor(stage: WorkflowStage, ctx: WorkflowContext): Promise<string> {
  return Promise.resolve('[' + stage.id + '] 完成。输入: ' + (ctx.input ?? ''))
}

/** 原子检索所需的最小 provider：稳定关键词 JSON + 空语料。 */
const emptySearchProvider: StageProvider = {
  callLLM: async () => '{"keywords":["装置"]}',
  search: async () => [],
}

describe('workflow-run stores', () => {
  it('runWorkflow with InMemoryWorkflowRunStore persists the result', async () => {
    const store = new InMemoryWorkflowRunStore()
    const result = await runWorkflow(patentNoveltyManifest, { input: '一种自动化分拣装置' }, okExecutor, { persist: store, approvalGrants: ['approval'] })
    const loaded = await store.loadRun('patent_novelty_v1')
    expect(loaded).toBeDefined()
    expect(loaded).toEqual(result)
    expect(await store.listRuns()).toEqual(['patent_novelty_v1'])
  })

  it('InMemoryWorkflowRunStore honors a custom runId', async () => {
    const store = new InMemoryWorkflowRunStore()
    await runWorkflow(patentNoveltyManifest, {}, okExecutor, { persist: store, runId: 'case-001', approvalGrants: ['approval'] })
    expect((await store.loadRun('case-001'))?.manifestId).toBe('patent_novelty_v1')
    expect(await store.loadRun('patent_novelty_v1')).toBeUndefined()
  })

  it('JsonFileWorkflowRunStore roundtrips through the filesystem', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-wf-'))
    try {
      const store = new JsonFileWorkflowRunStore(dir)
      const result = await runWorkflow(patentNoveltyManifest, {}, okExecutor, { persist: store, approvalGrants: ['approval'] })
      const loaded = await store.loadRun('patent_novelty_v1')
      expect(loaded).toBeDefined()
      expect(loaded).toEqual(result)
      expect(await store.listRuns()).toEqual(['patent_novelty_v1'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('JsonFileWorkflowRunStore returns undefined / empty list for missing runs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-wf-'))
    try {
      const store = new JsonFileWorkflowRunStore(dir)
      expect(await store.loadRun('nope')).toBeUndefined()
      expect(await store.listRuns()).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('runWorkflow without persist does not write anything', async () => {
    const store = new InMemoryWorkflowRunStore()
    await runWorkflow(patentNoveltyManifest, {}, okExecutor)
    expect(await store.listRuns()).toEqual([])
  })

  it('JsonFileWorkflowRunStore rejects runIds with path separators or traversal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-wf-'))
    try {
      const store = new JsonFileWorkflowRunStore(dir)
      const result = await runWorkflow(patentNoveltyManifest, {}, okExecutor)
      for (const bad of ['../evil', 'a/b', 'a\\b', '.hidden', '', '..']) {
        await expect(store.saveRun(result, bad)).rejects.toThrow(RangeError)
        await expect(store.loadRun(bad)).rejects.toThrow(RangeError)
      }
      await store.saveRun(result, 'case-001.run_v2')
      expect(await store.loadRun('case-001.run_v2')).toBeDefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('runWorkflow degrades gracefully when persist saveRun throws', async () => {
    const failingStore: WorkflowRunStore = {
      saveRun: async () => { throw new Error('disk full') },
      loadRun: async () => undefined,
      listRuns: async () => [],
    }
    const result = await runWorkflow(
      patentNoveltyManifest,
      { input: '一种装置', filing_date: '2024-06-01' },
      okExecutor,
      { persist: failingStore, approvalGrants: ['approval'], provider: emptySearchProvider },
    )
    expect(result.completed).toBe(true)
    expect(result.persistWarning ?? '').toMatch(/持久化失败/)
    expect(result.persistWarning ?? '').toMatch(/disk full/)
  })
})

describe('JsonFileWorkflowRunStore：磁盘记录结构校验', () => {
  /** 一份最小的合法运行记录；overrides 里给 undefined 的键会被 JSON.stringify 丢弃。 */
  function runRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      manifestId: 'patent_novelty_v1',
      caseType: 'novelty',
      completed: true,
      stages: [{ stageId: 's1', strategy: 'chain', output: 'ok', degraded: false, retries: 0 }],
      degradedSteps: [],
      summary: 'ok',
      ...overrides,
    }
  }

  const stage = { stageId: 's1', strategy: 'chain', output: 'ok', degraded: false, retries: 0 }
  const receipt = {
    toolCallId: 't1',
    turnId: 'turn-1',
    toolName: 'search',
    args: { query: '分拣装置' },
    success: true,
    write: false,
    citationId: 'D1',
    source: 'prior-art',
  }
  const revision = {
    gapId: 'claim-1',
    rewindTo: 's1',
    requestedBy: 's2',
    round: 1,
    before: 'sha256:aa',
    rationale: '缺口',
    outcome: 'applied',
  }
  const recovery = {
    nextStageIndex: 1,
    state: { input: '交底书', s1: 'ok' },
    rewindCounts: { s1: 1 },
    pendingRevisions: [revision],
  }

  async function writeRun(dir: string, runId: string, content: unknown): Promise<string> {
    const file = join(dir, `${runId}.json`)
    await writeFile(file, JSON.stringify(content), 'utf8')
    return file
  }

  async function loadError(store: JsonFileWorkflowRunStore, runId: string): Promise<StoredRecordError> {
    try {
      await store.loadRun(runId)
    } catch (error) {
      if (error instanceof StoredRecordError) return error
      throw error
    }
    throw new Error(`expected run "${runId}" to be rejected`)
  }

  it('缺 stages 的记录被拒绝，错误带文件路径与记录类型（issue #601）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-wf-bad-'))
    try {
      const store = new JsonFileWorkflowRunStore(dir)
      const file = await writeRun(dir, 'run-1', runRecord({ stages: undefined }))
      const error = await loadError(store, 'run-1')
      expect(error.file).toBe(file)
      expect(error.recordKind).toBe('run')
      expect(error.detail).toContain('stages')
      expect(error.message).toContain(file)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('逐字段拒绝形状不符的记录', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-wf-fields-'))
    try {
      const store = new JsonFileWorkflowRunStore(dir)
      const cases: Array<[string, string, Record<string, unknown>]> = [
        ['manifestId 缺失', 'manifestId', { manifestId: undefined }],
        ['manifestId 为空串', 'manifestId', { manifestId: '' }],
        ['caseType 非字符串', 'caseType', { caseType: 1 }],
        ['completed 非布尔', 'completed', { completed: 'yes' }],
        ['stages 非数组', 'stages', { stages: {} }],
        ['stage 非对象', 'stages', { stages: ['s1'] }],
        ['stage.stageId 为空', 'stageId', { stages: [{ ...stage, stageId: '' }] }],
        ['stage.strategy 非法', 'strategy', { stages: [{ ...stage, strategy: 'linear' }] }],
        ['stage.output 非字符串', 'output', { stages: [{ ...stage, output: 1 }] }],
        ['stage.degraded 非布尔', 'degraded', { stages: [{ ...stage, degraded: 0 }] }],
        ['stage.retries 非整数', 'retries', { stages: [{ ...stage, retries: 1.5 }] }],
        ['stage.retries 为负', 'retries', { stages: [{ ...stage, retries: -1 }] }],
        ['stage.atom 非字符串', 'atom', { stages: [{ ...stage, atom: 1 }] }],
        ['stage.inputScope 含非字符串', 'inputScope', { stages: [{ ...stage, inputScope: [1] }] }],
        ['degradedSteps 含非字符串', 'degradedSteps', { degradedSteps: [1] }],
        ['summary 非字符串', 'summary', { summary: 1 }],
        ['interrupted 非对象', 'interrupted', { interrupted: 'paused' }],
        ['interrupted 缺 stageId', 'stageId', { interrupted: { message: 'm', data: {} } }],
        ['interrupted 缺 message', 'message', { interrupted: { stageId: 'approval', data: {} } }],
        ['interrupted.data 非对象', 'data', { interrupted: { stageId: 'approval', message: 'm', data: [] } }],
        ['persistWarning 非字符串', 'persistWarning', { persistWarning: 1 }],
        ['evidenceLedger 非对象', 'evidenceLedger', { evidenceLedger: 'ledger' }],
        ['evidenceLedger.receipts 非数组', 'receipts', { evidenceLedger: { receipts: {}, digest: 'sha256:abc' } }],
        ['receipt 非对象', 'receipts', { evidenceLedger: { receipts: ['r1'], digest: 'sha256:abc' } }],
        ['receipt 缺 toolCallId', 'toolCallId', { evidenceLedger: { receipts: [{ ...receipt, toolCallId: undefined }], digest: 'sha256:abc' } }],
        ['receipt 缺 turnId', 'turnId', { evidenceLedger: { receipts: [{ ...receipt, turnId: undefined }], digest: 'sha256:abc' } }],
        ['receipt 缺 toolName', 'toolName', { evidenceLedger: { receipts: [{ ...receipt, toolName: undefined }], digest: 'sha256:abc' } }],
        ['receipt args 非对象', 'args', { evidenceLedger: { receipts: [{ ...receipt, args: 'q' }], digest: 'sha256:abc' } }],
        ['receipt args 含非字符串', 'args', { evidenceLedger: { receipts: [{ ...receipt, args: { query: 1 } }], digest: 'sha256:abc' } }],
        ['receipt success 非布尔', 'success', { evidenceLedger: { receipts: [{ ...receipt, success: 'yes' }], digest: 'sha256:abc' } }],
        ['receipt write 非布尔', 'write', { evidenceLedger: { receipts: [{ ...receipt, write: 'no' }], digest: 'sha256:abc' } }],
        ['receipt 缺 citationId', 'citationId', { evidenceLedger: { receipts: [{ ...receipt, citationId: undefined }], digest: 'sha256:abc' } }],
        ['receipt source 非法', 'source', { evidenceLedger: { receipts: [{ ...receipt, source: 'other' }], digest: 'sha256:abc' } }],
        ['receipt path 为空串', 'path', { evidenceLedger: { receipts: [{ ...receipt, path: '' }], digest: 'sha256:abc' } }],
        ['receipt resultText 为空串', 'resultText', { evidenceLedger: { receipts: [{ ...receipt, resultText: '' }], digest: 'sha256:abc' } }],
        ['receipt title 为空串', 'title', { evidenceLedger: { receipts: [{ ...receipt, title: '' }], digest: 'sha256:abc' } }],
        ['receipt publicationDate 为空串', 'publicationDate', { evidenceLedger: { receipts: [{ ...receipt, publicationDate: '' }], digest: 'sha256:abc' } }],
        ['receipt contentHash 为空串', 'contentHash', { evidenceLedger: { receipts: [{ ...receipt, contentHash: '' }], digest: 'sha256:abc' } }],
        ['evidenceLedger.digest 为空', 'digest', { evidenceLedger: { receipts: [receipt], digest: '' } }],
        ['evidenceLedger.incomplete 非布尔', 'incomplete', { evidenceLedger: { receipts: [], digest: 'sha256:abc', incomplete: 'yes' } }],
        ['revisions 非数组', 'revisions', { revisions: 'log' }],
        ['revisions 含非对象项', 'revisions', { revisions: ['r1'] }],
        ['revision.gapId 缺失', 'gapId', { revisions: [{ ...revision, gapId: undefined }] }],
        ['revision.rewindTo 缺失', 'rewindTo', { revisions: [{ ...revision, rewindTo: undefined }] }],
        ['revision.requestedBy 缺失', 'requestedBy', { revisions: [{ ...revision, requestedBy: undefined }] }],
        ['revision.before 缺失', 'before', { revisions: [{ ...revision, before: undefined }] }],
        ['revision.rationale 缺失', 'rationale', { revisions: [{ ...revision, rationale: undefined }] }],
        ['revision.after 非字符串', 'after', { revisions: [{ ...revision, after: 1 }] }],
        ['revision.evidence 非字符串', 'evidence', { revisions: [{ ...revision, evidence: 1 }] }],
        ['revision.at 非字符串', 'at', { revisions: [{ ...revision, at: 1 }] }],
        ['revision.outcome 非法', 'outcome', { revisions: [{ ...revision, outcome: 'skipped' }] }],
        ['revision.round 非正整数', 'round', { revisions: [{ ...revision, round: 0 }] }],
        ['revisionsTruncated 非布尔', 'revisionsTruncated', { revisionsTruncated: 'yes' }],
        ['recovery 非对象', 'recovery', { recovery: 'paused' }],
        ['recovery.nextStageIndex 为负', 'nextStageIndex', { recovery: { ...recovery, nextStageIndex: -1 } }],
        ['recovery.state 非对象', 'state', { recovery: { ...recovery, state: [] } }],
        ['recovery.rewindCounts 非对象', 'rewindCounts', { recovery: { ...recovery, rewindCounts: [] } }],
        ['recovery.rewindCounts 计数为负', 'rewindCounts', { recovery: { ...recovery, rewindCounts: { s1: -1 } } }],
        ['recovery.pendingRevisions 非数组', 'pendingRevisions', { recovery: { ...recovery, pendingRevisions: 'log' } }],
      ]
      for (const [index, [label, field, patch]] of cases.entries()) {
        const runId = `bad-${index}`
        await writeRun(dir, runId, runRecord(patch))
        const error = await loadError(store, runId)
        expect(error.detail, label).toContain(field)
        expect(error.file, label).toBe(join(dir, `${runId}.json`))
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('接受合法边界值：空 output / 空 summary / 空 stages / 审批门中断', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-wf-min-'))
    try {
      const store = new JsonFileWorkflowRunStore(dir)
      const paused = runRecord({
        completed: false,
        stages: [],
        summary: '',
        interrupted: { stageId: 'approval', message: '审批暂停', data: {} },
      })
      await writeRun(dir, 'paused', paused)
      expect(await store.loadRun('paused')).toEqual(paused)

      const emptyOutput = runRecord({
        stages: [{ stageId: 's1', strategy: 'react', output: '', degraded: true, retries: 0 }],
      })
      await writeRun(dir, 'empty-output', emptyOutput)
      expect((await store.loadRun('empty-output'))?.stages[0]?.output).toBe('')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('接受全部可选字段，含旧版弱哈希与完整回退留痕', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-wf-full-'))
    try {
      const store = new JsonFileWorkflowRunStore(dir)
      const fullReceipt = {
        ...receipt,
        path: 'evidence/d1.txt',
        resultText: '摘要',
        title: 'D1',
        publicationDate: '2024-01-01',
        // 旧版 FNV 哈希：格式仍是字符串，不得按 sha256: 前缀拒绝。
        contentHash: 'fnv1a:0123456789abcdef',
      }
      const full = runRecord({
        stages: [{ ...stage, atom: 'extract', inputScope: ['claims'] }],
        persistWarning: '持久化告警',
        evidenceLedger: { receipts: [fullReceipt, receipt], digest: 'sha256:abc', incomplete: true },
        revisions: [revision],
        revisionsTruncated: true,
        recovery,
      })
      await writeRun(dir, 'full', full)
      expect(await store.loadRun('full')).toEqual(full)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('损坏的 JSON 抛结构错误而非 SyntaxError', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-wf-json-'))
    try {
      const store = new JsonFileWorkflowRunStore(dir)
      await writeFile(join(dir, 'broken.json'), '{not json', 'utf8')
      const error = await loadError(store, 'broken')
      expect(error.file).toBe(join(dir, 'broken.json'))
      expect(error.detail).toContain('JSON')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('listRuns 只列文件名，不解析内容', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-wf-list-'))
    try {
      const store = new JsonFileWorkflowRunStore(dir)
      await writeRun(dir, 'corrupt', { nope: true })
      expect(await store.listRuns()).toEqual(['corrupt'])
      await expect(store.loadRun('corrupt')).rejects.toThrow(StoredRecordError)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

it('interrupted run reports incomplete even with requireAllSteps=false', async () => {
  const manifest: WorkflowManifest = {
    id: 'gated_optional',
    name: '审批门',
    caseType: 'x',
    stages: [{ id: 'approval', strategy: 'chain', description: '人工确认', atom: 'approval-gate' }],
    validation: { requireAllSteps: false, maxRetries: 0 },
  }
  const result = await runWorkflow(manifest, {}, okExecutor)
  expect(result.interrupted).toBeDefined()
  expect(result.interrupted!.stageId).toBe('approval')
  expect(result.completed).toBe(false)
})
