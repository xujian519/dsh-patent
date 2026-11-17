import { describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  APPROVAL_GRANTED_KEY,
  InMemoryCheckpointStore,
  JsonFileCheckpointStore,
  StoredRecordError,
  grantApproval,
  runGraphWithCheckpoints,
  type GraphCheckpoint,
  type GraphState,
} from '@deepseek-ai/dsh-patent-core'
import { APPROVAL_GRANTED_NODES_KEY, isGateApproved } from '../../src/atoms/handlers/builtin/gate.ts'
import { GraphBuilder } from '../../src/graph/engine.ts'
import { GraphInterruptError } from '../../src/graph/types.ts'

const node = (key: string, value: unknown) => async (): Promise<GraphState> => ({ [key]: value })

it('InMemoryCheckpointStore: save/load/loadLatest/list', async () => {
  const store = new InMemoryCheckpointStore()
  const cp1: GraphCheckpoint = {
    id: 'g-0',
    graphId: 'g',
    stepIndex: 0,
    state: { a: 1 },
    activeNodes: ['b'],
    createdAt: 1,
  }
  const cp2: GraphCheckpoint = {
    id: 'g-1',
    graphId: 'g',
    stepIndex: 1,
    state: { a: 1, b: 2 },
    activeNodes: ['c'],
    createdAt: 2,
  }
  await store.save(cp1)
  await store.save(cp2)
  expect((await store.load('g-0'))?.state).toEqual({ a: 1 })
  expect(await store.load('missing')).toBeUndefined()
  // loadLatest 取 stepIndex 最大者。
  expect((await store.loadLatest('g'))?.id).toBe('g-1')
  expect(await store.list('g')).toEqual(['g-0', 'g-1'])
})

it('JsonFileCheckpointStore: 序列化 round-trip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sati-cp-'))
  try {
    const store = new JsonFileCheckpointStore(dir)
    const cp: GraphCheckpoint = {
      id: 'g-3',
      graphId: 'g',
      stepIndex: 3,
      state: { features: ['F1'], nested: { deep: true } },
      activeNodes: ['next'],
      createdAt: 42,
    }
    await store.save(cp)
    const loaded = await store.load('g-3')
    expect(loaded).toEqual(cp)
    expect((await store.loadLatest('g'))?.id).toBe('g-3')
    expect(await store.list('g')).toEqual(['g-3'])
    expect(await store.list('other')).toEqual([])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('runGraphWithCheckpoints: 中断后 resume 从正确超步继续', async () => {
  let shouldInterrupt = true
  const builder = new GraphBuilder()
  builder
    .addNode('a', node('a', 1))
    .addNode('gate', async () => {
      if (shouldInterrupt) {
        shouldInterrupt = false
        throw new GraphInterruptError('审批暂停', { review_context: '确认' })
      }
      return { gate_passed: true }
    })
    .addNode('c', node('c', 3))
    .addEdge('a', 'gate')
    .addEdge('gate', 'c')
  const graph = builder.compile('a')
  const store = new InMemoryCheckpointStore()

  // 第一次：gate 中断。
  const first = await runGraphWithCheckpoints(graph, {}, { store, graphId: 'g1' })
  expect(first.result.completed).toBe(false)
  expect(first.result.interrupted?.node).toBe('gate')
  expect(first.checkpointId).toBeTruthy()

  // resume：从最新检查点继续，gate 放行，c 执行。
  const latest = await store.loadLatest('g1')
  expect(latest).toBeTruthy()
  const second = await runGraphWithCheckpoints(graph, {}, { store, graphId: 'g1', resumeFrom: latest! })
  expect(second.result.completed).toBe(true)
  expect(second.result.state.a).toBe(1)
  expect(second.result.state.gate_passed).toBe(true)
  expect(second.result.state.c).toBe(3)
})

it('grantApproval：写入门粒度放行记录后 resume 通过审批门（HITL 闭环）', async () => {
  const builder = new GraphBuilder()
  builder
    .addNode('a', node('a', 1))
    .addNode('gate', async ({ state, nodeName }) => {
      // 引擎必须注入节点名——门粒度判定（放行记录按门 id）依赖它。
      expect(nodeName).toBe('gate')
      if (nodeName === undefined || !isGateApproved(state, nodeName)) {
        throw new GraphInterruptError('审批暂停', { review_context: '确认' })
      }
      return { gate_passed: true }
    })
    .addNode('c', node('c', 3))
    .addEdge('a', 'gate')
    .addEdge('gate', 'c')
  const graph = builder.compile('a')
  const store = new InMemoryCheckpointStore()

  // 第一次：审批门中断，拿到 checkpointId。
  const first = await runGraphWithCheckpoints(graph, {}, { store, graphId: 'g2' })
  expect(first.result.completed).toBe(false)
  expect(first.result.interrupted?.node).toBe('gate')
  expect(first.checkpointId).toBeTruthy()

  // 人工批准：grantApproval 把「该检查点正在等待的门 id」写入 state（非全局布尔）。
  const granted = await grantApproval(store, first.checkpointId!)
  expect(granted).toBeTruthy()
  expect(granted!.state[APPROVAL_GRANTED_NODES_KEY]).toEqual(['gate'])
  // 共享 state 不得出现全局放行布尔（会让一次放行泄漏到后续所有门）。
  expect(granted!.state[APPROVAL_GRANTED_KEY]).toBeUndefined()

  // 幂等：重复批准无副作用，放行记录不变。
  const grantedAgain = await grantApproval(store, first.checkpointId!)
  expect(grantedAgain).toBeTruthy()
  expect(grantedAgain!.state[APPROVAL_GRANTED_NODES_KEY]).toEqual(['gate'])

  // 审批后 resume：审批门放行，后续节点执行（真正通过审批门）。
  const second = await runGraphWithCheckpoints(graph, {}, { store, graphId: 'g2', resumeFrom: granted! })
  expect(second.result.completed).toBe(true)
  expect(second.result.state.gate_passed).toBe(true)
  expect(second.result.state.c).toBe(3)
})

it('grantApproval：批准非门检查点不放行任何门（fail-closed，不静默放行下游）', async () => {
  const builder = new GraphBuilder()
  builder
    .addNode('a', node('a', 1))
    .addNode('gate', async ({ state, nodeName }) => {
      if (nodeName === undefined || !isGateApproved(state, nodeName)) {
        throw new GraphInterruptError('审批暂停', { review_context: '确认' })
      }
      return { gate_passed: true }
    })
    .addNode('c', node('c', 3))
    .addEdge('a', 'gate')
    .addEdge('gate', 'c')
  const graph = builder.compile('a')
  const store = new InMemoryCheckpointStore()
  await runGraphWithCheckpoints(graph, {}, { store, graphId: 'g3' })

  // 批准「入口超步」的检查点（activeNodes = ['a']，没有任何门）→ 放行记录里没有 gate。
  const wrong = await grantApproval(store, 'g3-0')
  expect(wrong).toBeTruthy()
  expect(wrong!.state[APPROVAL_GRANTED_NODES_KEY]).toEqual(['a'])

  const resumed = await runGraphWithCheckpoints(graph, {}, { store, graphId: 'g3', resumeFrom: wrong! })
  expect(resumed.result.completed).toBe(false)
  expect(resumed.result.interrupted?.node).toBe('gate')
  expect(resumed.result.state.gate_passed).toBeUndefined()
})

it('grantApproval：同 run 两道审批门只批准第一道，第二道仍中断（不放行泄漏）', async () => {
  const builder = new GraphBuilder()
  builder
    .addNode('a', node('a', 1))
    .addNode('gate1', async ({ state, nodeName }) => {
      if (nodeName === undefined || !isGateApproved(state, nodeName)) {
        throw new GraphInterruptError('审批暂停 1', { review_context: '第一道' })
      }
      return { gate1_passed: true }
    })
    .addNode('gate2', async ({ state, nodeName }) => {
      if (nodeName === undefined || !isGateApproved(state, nodeName)) {
        throw new GraphInterruptError('审批暂停 2', { review_context: '第二道' })
      }
      return { gate2_passed: true }
    })
    .addNode('c', node('c', 3))
    .addEdge('a', 'gate1')
    .addEdge('gate1', 'gate2')
    .addEdge('gate2', 'c')
  const graph = builder.compile('a')
  const store = new InMemoryCheckpointStore()

  // 第一道门中断 → 批准 → resume 推进到第二道门，第二道门必须仍中断。
  const first = await runGraphWithCheckpoints(graph, {}, { store, graphId: 'g4' })
  expect(first.result.interrupted?.node).toBe('gate1')
  const granted = await grantApproval(store, first.checkpointId!)
  const second = await runGraphWithCheckpoints(graph, {}, { store, graphId: 'g4', resumeFrom: granted! })
  expect(second.result.state.gate1_passed).toBe(true)
  expect(second.result.completed).toBe(false)
  expect(second.result.interrupted?.node).toBe('gate2')
  expect(second.result.state.gate2_passed).toBeUndefined()
  expect(second.checkpointId).toBeTruthy()

  // 再批准第二道门 → resume 走完。
  const granted2 = await grantApproval(store, second.checkpointId!)
  const third = await runGraphWithCheckpoints(graph, {}, { store, graphId: 'g4', resumeFrom: granted2! })
  expect(third.result.completed).toBe(true)
  expect(third.result.state.gate2_passed).toBe(true)
  expect(third.result.state.c).toBe(3)
})

it('grantApproval：检查点不存在返回 undefined', async () => {
  const store = new InMemoryCheckpointStore()
  expect(await grantApproval(store, 'missing')).toBeUndefined()
})

it('runGraphWithCheckpoints: 完成路径亦保存最终态检查点', async () => {
  const builder = new GraphBuilder()
  builder.addNode('a', node('done', true)).addEdge('a', '__end__')
  const graph = builder.compile('a')
  const store = new InMemoryCheckpointStore()
  const { result, checkpointId } = await runGraphWithCheckpoints(graph, {}, { store, graphId: 'g2' })
  expect(result.completed).toBe(true)
  expect(checkpointId).toBeTruthy()
  const cp = await store.load(checkpointId!)
  expect(cp?.activeNodes[0]).toBe('a')
})

it('InMemoryCheckpointStore.loadLatest 返回克隆：外部修改不污染存储', async () => {
  const store = new InMemoryCheckpointStore()
  await store.save({ id: 'c1', graphId: 'g', stepIndex: 1, state: { a: 1 }, activeNodes: ['x'], createdAt: 1 })
  const latest = await store.loadLatest('g')
  expect(latest).toBeDefined()
  if (latest !== undefined) {
    latest.state['a'] = 999
    latest.activeNodes.push('polluted')
  }
  const again = await store.loadLatest('g')
  expect(again?.state).toEqual({ a: 1 })
  expect(again?.activeNodes).toEqual(['x'])
})

describe('JsonFileCheckpointStore：磁盘记录结构校验', () => {
  /** 写一份磁盘记录；文件名即 checkpoint id，内容可任意改坏。 */
  async function writeRecord(dir: string, id: string, content: unknown): Promise<string> {
    const file = join(dir, `${id}.json`)
    await writeFile(file, JSON.stringify(content), 'utf8')
    return file
  }

  /** 读取并断言被拒绝，返回结构化的存储错误。 */
  async function loadError(store: JsonFileCheckpointStore, id: string): Promise<StoredRecordError> {
    try {
      await store.load(id)
    } catch (error) {
      if (error instanceof StoredRecordError) return error
      throw error
    }
    throw new Error(`expected checkpoint "${id}" to be rejected`)
  }

  const valid = { id: 'g-0', graphId: 'g', stepIndex: 0, state: { a: 1 }, activeNodes: ['b'], createdAt: 1 }

  it('缺 state 的记录被拒绝，错误带文件路径与记录类型（issue #601）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sati-cp-bad-'))
    try {
      const store = new JsonFileCheckpointStore(dir)
      const file = await writeRecord(dir, 'g-0', { ...valid, state: undefined })
      const error = await loadError(store, 'g-0')
      expect(error.file).toBe(file)
      expect(error.recordKind).toBe('checkpoint')
      expect(error.detail).toContain('state')
      expect(error.message).toContain(file)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('逐字段拒绝形状不符的记录', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sati-cp-fields-'))
    try {
      const store = new JsonFileCheckpointStore(dir)
      const cases: Array<[string, string, Record<string, unknown>]> = [
        ['graphId 为空串', 'graphId', { graphId: '' }],
        ['graphId 非字符串', 'graphId', { graphId: 7 }],
        ['stepIndex 为字符串', 'stepIndex', { stepIndex: '0' }],
        ['stepIndex 非整数', 'stepIndex', { stepIndex: 1.5 }],
        ['stepIndex 为负', 'stepIndex', { stepIndex: -1 }],
        ['state 为数组', 'state', { state: [] }],
        ['state 为 null', 'state', { state: null }],
        ['activeNodes 非数组', 'activeNodes', { activeNodes: 'b' }],
        ['activeNodes 含非字符串', 'activeNodes', { activeNodes: ['b', 2] }],
        ['createdAt 非数字', 'createdAt', { createdAt: 'now' }],
        ['createdAt 为 null', 'createdAt', { createdAt: null }],
      ]
      for (const [index, [label, field, patch]] of cases.entries()) {
        const id = `bad-${index}`
        await writeRecord(dir, id, { ...valid, ...patch, id })
        const error = await loadError(store, id)
        expect(error.detail, label).toContain(field)
        expect(error.file, label).toBe(join(dir, `${id}.json`))
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('拒绝非法 id：非字符串与空串', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sati-cp-idtype-'))
    try {
      const store = new JsonFileCheckpointStore(dir)
      await writeRecord(dir, 'non-string-id', { ...valid, id: 7 })
      expect((await loadError(store, 'non-string-id')).detail).toContain('id')
      await writeRecord(dir, 'empty-id', { ...valid, id: '' })
      expect((await loadError(store, 'empty-id')).detail).toContain('id')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('记录 id 与文件名不一致时拒绝，防止 grantApproval 回写覆盖另一条记录', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sati-cp-id-'))
    try {
      const store = new JsonFileCheckpointStore(dir)
      await writeRecord(dir, 'a', { ...valid, id: 'b' })
      const error = await loadError(store, 'a')
      expect(error.detail).toContain('id')
      expect(error.file).toBe(join(dir, 'a.json'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('损坏的 JSON 抛结构错误而非 SyntaxError', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sati-cp-json-'))
    try {
      const store = new JsonFileCheckpointStore(dir)
      await writeFile(join(dir, 'broken.json'), '{not json', 'utf8')
      const error = await loadError(store, 'broken')
      expect(error.file).toBe(join(dir, 'broken.json'))
      expect(error.detail).toContain('JSON')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('list / loadLatest 遇损坏记录 fail-loud，不静默跳过', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sati-cp-list-'))
    try {
      const store = new JsonFileCheckpointStore(dir)
      await store.save({ ...valid })
      await writeRecord(dir, 'g-1', { id: 'g-1', graphId: 'g' })
      await expect(store.list('g')).rejects.toThrow(StoredRecordError)
      await expect(store.loadLatest('g')).rejects.toThrow(StoredRecordError)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('接受边界合法值：空 state 与空 activeNodes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sati-cp-min-'))
    try {
      const store = new JsonFileCheckpointStore(dir)
      const minimal: GraphCheckpoint = { id: 'g-9', graphId: 'g', stepIndex: 0, state: {}, activeNodes: [], createdAt: 0 }
      await store.save(minimal)
      expect(await store.load('g-9')).toEqual(minimal)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
