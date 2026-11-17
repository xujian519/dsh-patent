import { expect, it } from 'vitest'
import type { GraphState } from '@deepseek-ai/dsh-patent-core'
import { GraphMergeError, mergeWithSchema } from '../../src/graph/merge.ts'

const results = (entries: Array<[string, GraphState]>): Array<{ node: string; delta: GraphState }> =>
  entries.map(([node, delta]) => ({ node, delta }))

it('mergeWithSchema LWW: 节点名字典序后者覆盖（确定性）', () => {
  const state: GraphState = {}
  // "a_node" < "b_node"：字典序后者 b_node 胜出。
  mergeWithSchema(
    state,
    results([
      ['b_node', { key: 'b' }],
      ['a_node', { key: 'a' }],
    ]),
    {},
  )
  expect(state.key).toBe('b')
})

it('mergeWithSchema LWW: 节点名按 UTF-16 码位序排序，与区域设置无关', () => {
  const state: GraphState = {}
  // en-US 的 localeCompare 认为 "a_node" < "B_node"；码位序相反（"B" = 66 < "a" = 97）。
  mergeWithSchema(
    state,
    results([
      ['a_node', { key: 'lower' }],
      ['B_node', { key: 'upper' }],
    ]),
    {},
  )
  expect(state.key).toBe('lower')
})

it('mergeWithSchema LWW: 同名节点保持输入顺序（稳定排序）', () => {
  const state: GraphState = {}
  mergeWithSchema(
    state,
    results([
      ['n1', { key: 1 }],
      ['n1', { key: 2 }],
    ]),
    {},
  )
  expect(state.key).toBe(2)
})

it('mergeWithSchema LWW: 未注册 key 回落 last_write_wins', () => {
  const state: GraphState = { k: 1 }
  mergeWithSchema(state, results([['n1', { k: 2 }]]), { other: 'append' })
  expect(state.k).toBe(2)
})

it('mergeWithSchema append: 追加到已有数组', () => {
  const state: GraphState = { list: ['a'] }
  mergeWithSchema(state, results([['n1', { list: 'b' }]]), { list: 'append' })
  expect(state.list).toEqual(['a', 'b'])
})

it('mergeWithSchema append: 既有单值保留为一个元素', () => {
  const state: GraphState = { list: 'x' }
  mergeWithSchema(state, results([['n1', { list: 'b' }]]), { list: 'append' })
  expect(state.list).toEqual(['x', 'b'])
})

it('mergeWithSchema append: 既有 undefined 视为空数组', () => {
  const state: GraphState = {}
  mergeWithSchema(state, results([['n1', { list: 'b' }]]), { list: 'append' })
  expect(state.list).toEqual(['b'])
})

it('mergeWithSchema union: 既有单值保留并参与去重', () => {
  const state: GraphState = { list: 'seed' }
  mergeWithSchema(
    state,
    results([
      ['n1', { list: 'b' }],
      ['n2', { list: ['seed', 'c'] }],
    ]),
    { list: 'union' },
  )
  expect(state.list).toEqual(['seed', 'b', 'c'])
})

it('mergeWithSchema union: 数组合并去重保持顺序', () => {
  const state: GraphState = { list: ['a', 'b'] }
  mergeWithSchema(
    state,
    results([
      ['n1', { list: ['b', 'c'] }],
      ['n2', { list: 'a' }],
    ]),
    { list: 'union' },
  )
  expect(state.list).toEqual(['a', 'b', 'c'])
})

it('mergeWithSchema merge_map: map 浅合并', () => {
  const state: GraphState = { m: { x: 1 } }
  mergeWithSchema(state, results([['n1', { m: { y: 2 } }]]), { m: 'merge_map' })
  expect(state.m).toEqual({ x: 1, y: 2 })
})

it('mergeWithSchema fail_on_conflict: 同 key 重复写入抛错', () => {
  const state: GraphState = { k: 1 }
  expect(() => { mergeWithSchema(state, results([['n1', { k: 2 }]]), { k: 'fail_on_conflict' }) }).toThrow(GraphMergeError)
})

it('mergeWithSchema fail_on_conflict: 首次写入不冲突', () => {
  const state: GraphState = {}
  mergeWithSchema(state, results([['n1', { k: 2 }]]), { k: 'fail_on_conflict' })
  expect(state.k).toBe(2)
})

it('mergeWithSchema: 未知 reducer 抛错', () => {
  const state: GraphState = {}
  expect(() => { mergeWithSchema(state, results([['n1', { k: 1 }]]), { k: 'bogus' as never }) }).toThrow(/unreachable variant in graph reducer/)
})
