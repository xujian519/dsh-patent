import { describe, expect, it } from 'vitest'
import { toJsonArray, toJsonValue } from '../src/tool/internal/json-value.ts'

describe('toJsonValue', () => {
  it('detaches a plain object', () => {
    const source = { name: '权利要求', count: 1, ok: true, extra: null, nested: { tags: ['a'] } }
    const snapshot = toJsonValue(source)
    expect(snapshot).toEqual(source)
    expect(snapshot).not.toBe(source)
  })

  it('omits undefined object properties and rejects values JSON cannot keep', () => {
    expect(toJsonValue({ name: 'a', currentStageId: undefined, nested: { keep: 1, drop: undefined } })).toEqual({
      name: 'a',
      nested: { keep: 1 },
    })
    expect(() => toJsonValue({ n: Number.NaN })).toThrow(/不能无损写入 JSON/)
    expect(() => toJsonValue({ fn() { return 1 } })).toThrow(/不能无损写入 JSON/)
    const cycle: { self?: object } = {}
    cycle.self = cycle
    expect(() => toJsonValue(cycle)).toThrow(/不能无损写入 JSON/)
  })
})

describe('toJsonArray', () => {
  it('detaches an array of records', () => {
    const source = [{ id: 'e1' }, { id: 'e2' }]
    expect(toJsonArray(source)).toEqual(source)
  })

  it('rejects a JSON object', () => {
    expect(() => toJsonArray({ id: 'e1' })).toThrow(/不是可无损写入 JSON 的数组/)
  })
})
