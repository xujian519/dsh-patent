import { expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FactBlackboard,
  JsonFileStore,
  RuleEngine,
  atomicWriteJson,
  caseWorkflowRunsDir,
  classifyIpc,
  compileSignal,
  createLlmModelPort,
  runeSlice,
  signalMatches,
  validateWorkflowManifest,
  type ClaimChart,
  type WorkflowManifest,
} from '@deepseek-ai/dsh-patent-core'
import { ConfirmedRuleSet } from '../src/reasoning/fact-blackboard.ts'
import { SyllogismBuilder, assertChain } from '../src/reasoning/syllogism.ts'
import { checkAtomic, extractTechnicalProblem } from '../src/problem/atomicChecker.ts'
import { loadClaimChart, renderChartMarkdown } from '../src/claim-chart/runtime/store.ts'
import type { ReasoningChain } from '../src/reasoning/fact-blackboard.ts'
import type { Syllogism } from '../src/reasoning/syllogism.ts'
import type { GenerateOptions, LlmFailure, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

it('caseWorkflowRunsDir：拼接工作流运行目录', () => {
  expect(caseWorkflowRunsDir('case-1')).toBe('data/cases/case-1/workflow-runs')
})

// ---------------------------------------------------------------------------
// persist-utils：原子写失败清理与 JsonFileStore 边界
// ---------------------------------------------------------------------------

it('atomicWriteJson：写入失败时清理临时文件并重抛', async () => {
  // 目标路径为目录 → rename 失败 → 清理 + 重抛
  const dir = mkdtempSync(join(tmpdir(), 'atomic-fail-'))
  try {
    await expect(atomicWriteJson(dir, 'x')).rejects.toThrow()
    const leftovers = readdirSync(tmpdir()).filter(f => f.includes('atomic-fail'))
    expect(leftovers).toEqual([dir.split('/').pop()])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('JsonFileStore：load 缺失返回 undefined / 目录文件抛错 / listIds 边界', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jfs-'))
  try {
    const store = new JsonFileStore<string>(dir, raw => JSON.parse(raw) as string)
    expect(await store.load('missing')).toBeUndefined()
    await store.save('a1', 'value')
    expect(await store.load('a1')).toBe('value')
    expect(await store.listIds()).toEqual(['a1'])
    // 目录内放置非 JSON 文件与危险文件名 → 过滤
    writeFileSync(join(dir, 'readme.txt'), 'x')
    writeFileSync(join(dir, '..hidden.json'), 'x')
    expect(await store.listIds()).toEqual(['a1'])
    // 非 ENOENT 错误重抛：load 指向目录 → EISDIR
    const dirEntry = join(dir, 'dir-as-file.json')
    mkdirSync(dirEntry)
    await expect(store.load('dir-as-file')).rejects.toThrow()
    // listIds 指向文件 → ENOTDIR
    const fileAsDir = join(dir, 'a1.json')
    const badStore = new JsonFileStore<string>(fileAsDir, raw => JSON.parse(raw) as string)
    await expect(badStore.listIds()).rejects.toThrow()
    // listIds 目录不存在 → ENOENT → []
    const missingDir = join(dir, 'not-created')
    const missingStore = new JsonFileStore<string>(missingDir, raw => raw)
    expect(await missingStore.listIds()).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// model-port：适配器分支
// ---------------------------------------------------------------------------

it('model-port：assistant 消息与 temperature/maxTokens 缺省透传', async () => {
  let captured: GenerateOptions | undefined
  const stream = async function* (options: GenerateOptions): AsyncGenerator<StreamChunk> {
    captured = options
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const port = createLlmModelPort(stream, { provider: 'p', model: 'm' })
  const events = []
  for await (const event of port.stream({ messages: [{ role: 'assistant', content: '答' }] })) {
    events.push(event)
  }
  expect(captured!.messages[0]!.role).toBe('assistant')
  expect(captured!.temperature).toBeUndefined()
  expect(captured!.maxTokens).toBeUndefined()
  expect(events).toEqual([{ type: 'done' }])
})

it('model-port：temperature/maxTokens 透传与 usage 部分字段', async () => {
  let captured: GenerateOptions | undefined
  const stream = async function* (options: GenerateOptions): AsyncGenerator<StreamChunk> {
    captured = options
    yield { type: 'usage', usage: { inputTokens: 5 } as TokenUsage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const port = createLlmModelPort(stream, { provider: 'p', model: 'm', temperature: 0.3, maxTokens: 200 })
  const events = []
  for await (const event of port.stream({ messages: [{ role: 'user', content: 'x' }], temperature: 0.1 })) {
    events.push(event)
  }
  expect(captured!.temperature).toBe(0.1) // 逐调用覆盖端口默认
  expect(captured!.maxTokens).toBe(200)
  expect(events).toEqual([{ type: 'done', usage: { inputTokens: 5 } }])

  const outputOnly = async function* (): AsyncGenerator<StreamChunk> {
    yield { type: 'usage', usage: { outputTokens: 7 } as TokenUsage }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const port2 = createLlmModelPort(outputOnly, { provider: 'p', model: 'm' })
  const events2 = []
  for await (const event of port2.stream({ messages: [{ role: 'user', content: 'x' }] })) events2.push(event)
  expect(events2).toEqual([{ type: 'done', usage: { outputTokens: 7 } }])
})

it('model-port：error finish 无 code 与流缺 finish 的兜底 done', async () => {
  const errorStream = async function* (): AsyncGenerator<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'down' } as LlmFailure } }
  }
  const port = createLlmModelPort(errorStream, { provider: 'p', model: 'm' })
  await expect(async () => {
    for await (const _ of port.stream({ messages: [{ role: 'user', content: 'x' }] })) void _
  }).rejects.toThrow('down')

  const bareStream = async function* (): AsyncGenerator<StreamChunk> {
    yield { type: 'text-delta', index: 0, text: 't' }
  }
  const port2 = createLlmModelPort(bareStream, { provider: 'p', model: 'm' })
  const events = []
  for await (const event of port2.stream({ messages: [{ role: 'user', content: 'x' }] })) events.push(event)
  expect(events).toEqual([{ type: 'delta', text: 't' }, { type: 'done' }])
})

it('model-port：signal 透传至 GenerateOptions', async () => {
  let captured: GenerateOptions | undefined
  const stream = async function* (options: GenerateOptions): AsyncGenerator<StreamChunk> {
    captured = options
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const port = createLlmModelPort(stream, { provider: 'p', model: 'm' })
  const controller = new AbortController()
  for await (const _ of port.stream({ messages: [{ role: 'user', content: 'x' }] }, controller.signal)) void _
  expect(captured!.signal).toBe(controller.signal)
})

// ---------------------------------------------------------------------------
// workflow：manifest 校验 / 信号判定 / WorkflowError
// ---------------------------------------------------------------------------

const validStage = (id: string): WorkflowManifest['stages'][number] =>
  ({ id, strategy: 'chain', description: '阶段' })

it('validateWorkflowManifest：各非法分支抛 WorkflowError', () => {
  const base = (): WorkflowManifest => ({ id: 'm', name: 'n', caseType: 'test', stages: [validStage('s1')] })
  const throws = (manifest: WorkflowManifest, matcher: RegExp): void => {
    expect(() => { validateWorkflowManifest(manifest) }).toThrow(matcher)
  }
  throws({ ...base(), id: '  ' }, /manifest.id/)
  throws({ ...base(), name: '' }, /manifest.name/)
  throws({ ...base(), caseType: '' }, /manifest.caseType/)
  throws({ ...base(), stages: [] }, /至少包含一个阶段/)
  throws({ ...base(), stages: [{ id: 's1', strategy: 'bogus' as never, description: 'd' }] }, /未知策略/)
  expect(() => { validateWorkflowManifest({ ...base(), stages: [{ id: 's1', strategy: 'react', description: 'd' }] }) })
    .not.toThrow()
  throws({ ...base(), stages: [validStage(' ')] }, /stage.id/)
  throws({ ...base(), stages: [validStage('s1'), validStage('s1')] }, /重复的阶段/)
  throws({ ...base(), stages: [{ id: 's1', strategy: 'chain', description: '  ' }] }, /缺少描述/)
  throws({ ...base(), stages: [{ id: 's1', strategy: 'chain', description: 'd', atom: ' ' }] }, /atom/)
  throws({ ...base(), stages: [{ id: 's1', strategy: 'chain', description: 'd', guidance: ' ' }] }, /guidance/)
  expect(() => {
    validateWorkflowManifest({ ...base(), stages: [{ id: 's1', strategy: 'chain', description: 'd', guidance: '三步法边界条件' }] })
  }).not.toThrow()
  expect(() => {
    validateWorkflowManifest({
      ...base(),
      stages: [{ id: 's1', strategy: 'chain', description: 'd', atom: 'some-atom' }],
    }, { atomNames: new Set(['other-atom']) })
  }).toThrow(/未知 atom/)
  throws({ ...base(), stages: [{ id: 's1', strategy: 'chain', description: 'd', retry: { whenOutputMatches: ' ' } }] }, /whenOutputMatches 不能为空/)
  throws({ ...base(), stages: [{ id: 's1', strategy: 'chain', description: 'd', retry: {} }] }, /必须声明 whenOutputMatches 或 whenRevisionRequested/)
  throws({ ...base(), stages: [{ id: 's1', strategy: 'chain', description: 'd', retry: { whenOutputMatches: '[' } }] }, /非法正则/)
  throws({ ...base(), stages: [{ id: 's1', strategy: 'chain', description: 'd', retry: { whenOutputMatches: 'x', rewindTo: 'ghost' } }] }, /不存在的阶段/)
  throws({ ...base(), stages: [{ id: 's1', strategy: 'chain', description: 'd', retry: { whenOutputMatches: 'x', rewindTo: 's1' } }] }, /不能指向自身/)
  throws({ ...base(), stages: [{ id: 's1', strategy: 'chain', description: 'd', retry: { whenOutputMatches: 'x', maxRetries: -1 } }] }, /maxRetries/)
  for (const invalid of [Number.NaN, 1.5, '2' as never]) {
    throws({ ...base(), stages: [{ id: 's1', strategy: 'chain', description: 'd', retry: { whenOutputMatches: 'x', maxRetries: invalid } }] }, /retry.maxRetries 必须为非负整数/)
  }
  expect(() => {
    validateWorkflowManifest({ ...base(), validation: { maxRetries: 0 } })
  }).not.toThrow()
  for (const invalid of [-1, Number.NaN, 1.5, '2' as never]) {
    throws({ ...base(), validation: { maxRetries: invalid } }, /validation.maxRetries 必须为非负整数/)
  }
  // consumes：只能引用已出现过的前序阶段，且不得为空数组或含重复项。
  throws({ ...base(), stages: [{ id: 's1', strategy: 'chain', description: 'd', consumes: [] }] }, /consumes 不能为空数组/)
  throws({ ...base(), stages: [{ id: 's1', strategy: 'chain', description: 'd', consumes: ['ghost'] }] }, /不存在或非前序/)
  throws({
    ...base(),
    stages: [
      { id: 's1', strategy: 'chain', description: 'd' },
      { id: 's2', strategy: 'chain', description: 'd', consumes: ['s2'] },
    ],
  }, /不存在或非前序/)
  throws({
    ...base(),
    stages: [
      { id: 's1', strategy: 'chain', description: 'd' },
      { id: 's2', strategy: 'chain', description: 'd', consumes: ['s1', 's1'] },
    ],
  }, /consumes 有重复/)
  expect(() => {
    validateWorkflowManifest({
      ...base(),
      stages: [
        { id: 's1', strategy: 'chain', description: 'd' },
        { id: 's2', strategy: 'chain', description: 'd', consumes: ['s1'] },
      ],
    })
  }).not.toThrow()
  expect(() => { validateWorkflowManifest(base()) }).not.toThrow()
})

it('validateWorkflowManifest：consumes 的投影语法与投影名册', () => {
  const manifest = (...consumes: string[]): WorkflowManifest => ({
    id: 'm',
    name: 'n',
    caseType: 'test',
    stages: [
      { id: 's1', strategy: 'chain', description: 'd' },
      { id: 's2', strategy: 'chain', description: 'd', consumes },
    ],
  })
  // 投影形态本身合法。
  expect(() => { validateWorkflowManifest(manifest('s1#rows')) }).not.toThrow()
  expect(() => { validateWorkflowManifest(manifest('s1#rows'), { projections: new Set(['s1#rows']) }) }).not.toThrow()
  // 缺阶段 id / 缺投影名。
  expect(() => { validateWorkflowManifest(manifest('#rows')) }).toThrow(/缺少阶段 id/)
  expect(() => { validateWorkflowManifest(manifest('s1#')) }).toThrow(/缺少投影名/)
  expect(() => { validateWorkflowManifest(manifest('s1#  ')) }).toThrow(/缺少投影名/)
  // 同一阶段取两遍（带不带投影都算）是重复。
  expect(() => { validateWorkflowManifest(manifest('s1', 's1#rows')) }).toThrow(/consumes 有重复/)
  // 投影键未注册：给了名册就 fail-loud，没给就只管语法。
  expect(() => { validateWorkflowManifest(manifest('s1#rows'), { projections: new Set(['s1#cells']) }) })
    .toThrow(/未注册的投影/)
  // 阶段 id 里带 # 会让 consumes 的投影拆分错位，直接拒。
  expect(() => {
    validateWorkflowManifest({ id: 'm', name: 'n', caseType: 'test', stages: [{ id: 's#1', strategy: 'chain', description: 'd' }] })
  }).toThrow(/不能包含 "#"/)
})

it('validateWorkflowManifest：guidelineRevision 校验', () => {
  const revision = '2023 年修订版（2024-01-20 施行）'
  const declared: WorkflowManifest = {
    id: 'm',
    name: 'n',
    caseType: 'test',
    guidelineRevision: revision,
    stages: [validStage('s1')],
  }
  expect(() => {
    validateWorkflowManifest(declared, { guidelineRevision: revision })
  }).not.toThrow()
  expect(() => {
    validateWorkflowManifest(declared, { guidelineRevision: '2026 年修订版（2026-01-01 施行）' })
  }).toThrow(/不一致/)
  expect(() => {
    validateWorkflowManifest({ ...declared, guidelineRevision: ' ' }, { guidelineRevision: '2026 年修订版（2026-01-01 施行）' })
  }).toThrow(/不能为空字符串/)
  expect(() => {
    validateWorkflowManifest(declared, { guidelineRevision: ' ' })
  }).toThrow(/期望版本不能为空字符串/)
  expect(() => {
    validateWorkflowManifest(
      { id: 'm', name: 'n', caseType: 'test', stages: [validStage('s1')] },
      { guidelineRevision: '2026 年修订版（2026-01-01 施行）' },
    )
  }).toThrow(/未声明/)
})

it('signalMatches：否定语境/句界/零宽匹配与 compileSignal', () => {
  expect(signalMatches('；不匹配', /不/g)).toBe(false) // 句界分隔
  expect(signalMatches('尚未匹配', /匹配/g)).toBe(false) // 否定语境
  expect(signalMatches('已不匹配', /不/g)).toBe(true) // 直接命中
  expect(signalMatches('不', /(?<=不)/g)).toBe(false) // 零宽匹配回退
  const compiled = compileSignal('回退')
  expect(compiled.flags).toBe('gi')
  expect(signalMatches('需要回退', compiled)).toBe(true)
})

// ---------------------------------------------------------------------------
// atomicChecker / text-utils
// ---------------------------------------------------------------------------

it('extractTechnicalProblem：JSON 转义兜底与平面句式', () => {
  // C:\x 为非法 JSON 转义 → 触发 catch 的替换兜底
  expect(extractTechnicalProblem('"actual_technical_problem": "C:\\x"')).toContain('C:')
  expect(extractTechnicalProblem('实际解决的技术问题是提高效率')).toBe('提高效率')
  expect(extractTechnicalProblem('无问题描述')).toBeUndefined()
})

it('runeSlice：码点截断与省略号', () => {
  expect(runeSlice('abcdef', 3)).toBe('abc')
  expect(runeSlice('中文测试', 2)).toBe('中文')
  expect(runeSlice('abc', 5)).toBe('abc')
  expect(runeSlice('abcdef', 3, true)).toBe('abc…')
})

it('checkAtomic：合规与不合规问题表述', () => {
  expect(checkAtomic('如何在不增加成本的情况下提高散热效率').pass).toBe(true)
  const bound = checkAtomic('通过设置散热鳍片解决散热问题')
  expect(bound.pass).toBe(false)
  expect(bound.diagnostics.length).toBeGreaterThan(0)
})

// ---------------------------------------------------------------------------
// syllogism / fact-blackboard 边界
// ---------------------------------------------------------------------------

it('assertChain：全部通过返回 undefined，非 SyllogismError 穿透', () => {
  const bb = new FactBlackboard({ caseId: 'c', caseType: 't' })
  bb.addRuleConstraint({ articleId: 'A', articleName: '法条', requirement: 'must', description: 'd' })
  bb.addFact({ id: 'F1', source: 'user_text', content: 'x', confidence: 1, extractedAt: 'T' })
  const ok = new SyllogismBuilder('s1')
    .major('法条', 'A', '大前提')
    .minor('事实', 'F1', '小前提')
    .conclusionText('结论')
    .build(bb)
  expect(assertChain(bb, [ok])).toBeUndefined()

  const direct: Syllogism = {
    id: 's2',
    majorPremise: { label: '法条', source: 'statute', refId: 'A', content: 'x' },
    minorPremise: { label: '事实', source: 'case_fact', refId: 'F1', content: 'y' },
    conclusion: 'c',
    factRef: 'F1',
    articleRef: 'A',
    confidence: 0.5,
    validated: false,
  }
  const broken = { getFact: (): never => { throw new Error('boom') } } as unknown as FactBlackboard
  expect(() => assertChain(broken, [direct])).toThrow('boom')
})

it('黑板：chains/addReasoningChain/constraints/getConfirmedRules 与序列化边界', () => {
  const bb = new FactBlackboard({ caseId: 'c', caseType: 't', now: () => 'T1' })
  const chain: ReasoningChain = { id: 'r1', nodes: [], conclusion: 'c', confidence: 0.8 }
  bb.addReasoningChain(chain)
  expect(bb.chains()).toEqual([chain])
  bb.addRuleConstraint({ articleId: 'A', articleName: '法条', requirement: 'must', description: 'd' })
  expect(bb.constraints().length).toBe(1)
  expect(bb.getConfirmedRules()).toBeUndefined()

  const confirmed = new ConfirmedRuleSet([
    { rule: { articleId: 'A', articleName: '法条', requirement: 'must', description: 'd' }, status: 'confirmed' },
  ], 'T2')
  bb.setConfirmedRules(confirmed)
  expect(bb.getConfirmedRules()?.confirmedAt).toBe('T2')
  expect(bb.toJSON()).toContain('"confirmedRules"')

  // 缺省时钟与 technicalField
  const plain = new FactBlackboard({ caseId: 'x', caseType: 'y' })
  plain.lock()
  expect(plain.technicalField).toBe('')
  expect(plain.updatedAt.length).toBeGreaterThan(0)

  const restored = FactBlackboard.fromJSON(JSON.stringify({
    caseId: 'c2',
    caseType: 't2',
    createdAt: 'T3',
    updatedAt: 'T4',
    locked: true,
    facts: [{ id: 'F1', source: 'user_text', content: 'x', confidence: 1, extractedAt: 'T' }],
    reasoningChains: [{ id: 'r1', nodes: [], conclusion: 'c', confidence: 0.8 }],
    ruleConstraints: [{ articleId: 'A', articleName: '法条', requirement: 'must', description: 'd' }],
    articleJudgments: [['A', { articleId: 'A', satisfied: true, reasoning: 'r', confidence: 1, judgedAt: 'T5' }]],
    confirmedRules: { entries: [{ rule: { articleId: 'A', articleName: '法条', requirement: 'must', description: 'd' }, status: 'confirmed' }], confirmedAt: 'T6' },
  }), () => 'NOW')
  expect(restored.technicalField).toBe('')
  expect(restored.getArticleJudgment('A')?.satisfied).toBe(true)
  expect(restored.isLocked()).toBe(true)
  expect(restored.getConfirmedRules()?.confirmedAt).toBe('T6')
  expect(restored.chains().length).toBe(1)
  expect(restored.constraints().length).toBe(1)
})

// ---------------------------------------------------------------------------
// checker：claim 维度 / pathElements / 未知类型 / 报告兜底
// ---------------------------------------------------------------------------

it('checker：claim 分析未知维度跳过与已知维度判定', () => {
  const local = new RuleEngine()
  local.register({
    id: 'CLAIM-X', name: '未知维度', description: 'd', level: 1, severity: 'major', message: 'm',
    checkType: 'patent_claim_analysis', dimensions: ['bogus-dim'], domain: '', fixSuggestion: 's',
  })
  local.register({
    id: 'CLAIM-Y', name: '清楚性', description: 'd', level: 1, severity: 'major', message: 'm',
    checkType: 'patent_claim_analysis', dimensions: ['clarity'], domain: '', fixSuggestion: 's',
  })
  expect(local.evaluate('权利要求清楚、简要', { rules: local.all() })).toEqual([])
  const fails = local.evaluate('无维度内容', { rules: local.all() })
  expect(fails.some(f => f.ruleId === 'CLAIM-Y')).toBe(true)
  expect(fails.some(f => f.ruleId === 'CLAIM-X')).toBe(false)
})

it('checker：pathElements 完整性检查通过/失败', () => {
  const local = new RuleEngine()
  local.register({
    id: 'PATH-1', name: '推理路径', description: 'd', level: 0, severity: 'critical', message: 'm',
    checkType: 'patent_inventiveness', pathElements: [['步骤一', '第一步'], ['步骤二']], domain: '', fixSuggestion: 's',
  })
  local.register({
    id: 'PATH-2', name: '稀疏路径', description: 'd', level: 0, severity: 'critical', message: 'm',
    checkType: 'patent_inventiveness', pathElements: new Array<string[]>(2), domain: '', fixSuggestion: 's',
  })
  expect(local.evaluate('步骤一 步骤二', { rules: [local.get('PATH-1')!] })).toEqual([])
  const fails = local.evaluate('仅有步骤一', { rules: [local.get('PATH-1')!] })
  expect(fails.some(f => f.ruleId === 'PATH-1' && f.message.includes('步骤2'))).toBe(true)
  // 稀疏 pathElements → steps[i] 缺位兜底为空数组 → 步骤缺失
  const sparse = local.evaluate('任意文本', { rules: [local.get('PATH-2')!] })
  expect(sparse.some(f => f.ruleId === 'PATH-2' && f.message.includes('步骤1'))).toBe(true)
})

it('checker：未知 CheckType 抛错；customCheck 空 detail 用 rule.message', () => {
  const local = new RuleEngine()
  expect(() => local.evaluate('x', { rules: [{
    id: 'U', name: 'n', description: 'd', level: 0, severity: 'critical', message: 'm',
    checkType: 'bogus' as never, domain: '', fixSuggestion: 's',
  }] })).toThrow(/unreachable variant in check type/)

  local.register({
    id: 'C1', name: '自定义', description: 'd', level: 1, severity: 'major', message: '兜底消息',
    checkType: 'patent_spec', customCheck: () => ({ passed: false, detail: '' }), domain: '', fixSuggestion: 's',
  })
  const fails = local.evaluate('任何文本', { rules: local.all() })
  expect(fails.find(f => f.ruleId === 'C1')?.message).toBe('兜底消息')
})

// ---------------------------------------------------------------------------
// claim-chart store：缺失/损坏加载与 Markdown 渲染兜底
// ---------------------------------------------------------------------------

it('store：loadClaimChart 缺失/损坏与 renderChartMarkdown 兜底', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-store-'))
  const prevCwd = process.cwd()
  process.chdir(dir)
  try {
    expect(loadClaimChart('case-1', 'missing')).toBeNull()
    const outputs = join(dir, 'data', 'cases', 'case-1', 'outputs')
    mkdirSync(outputs, { recursive: true })
    writeFileSync(join(outputs, 'claim-chart-bad.json'), '{oops')
    expect(loadClaimChart('case-1', 'bad')).toBeNull()
    writeFileSync(join(outputs, 'claim-chart-noshape.json'), '{"rows":[]}')
    expect(loadClaimChart('case-1', 'noshape')).toBeNull()

    const chart: ClaimChart = {
      chartId: 'x', mode: 'invalidity', caseId: 'c',
      elements: [{ id: '1a', claimNo: 1, text: '包括壳体', kind: 'limitation' }],
      targets: [], claimNos: [1],
      claims: [],
      rows: [{
        elementId: '9z', targetId: 'D1', quote: 'q', pinCite: '[D1 段[1]]',
        mapping: 'literal', state: 'literal', verified: false,
      }],
      gaps: [{ elementId: '9z', targetId: 'D1', kind: 'partial', reason: 'r', suggestion: 's' }],
      draftNotice: '免责',
    }
    const md = renderChartMarkdown(chart)
    expect(md).toContain('9z')
    expect(md).toContain('☐')
    // verified 行渲染 ✓
    const verified = renderChartMarkdown({ ...chart, rows: [{ ...chart.rows[0]!, verified: true }] })
    expect(verified).toContain('✓')
    // 无缺口
    const noGap = renderChartMarkdown({ ...chart, gaps: [] })
    expect(noGap).toContain('无缺口')
  } finally {
    process.chdir(prevCwd)
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// ipc：明细域置信度比较
// ---------------------------------------------------------------------------

it('classifyIpc：同部内多明细域取置信度更高者', () => {
  const results = classifyIpc('医药 药物 剂型 食品 饮料')
  expect(results[0]?.section).toBe('A')
  expect(results[0]?.detail).toBe('A61')
})
