import { expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claimChartAtom, ClaimChartHandler, DEGRADED_CODE_KEY } from '@deepseek-ai/dsh-patent-core'
import type { StageProvider } from '@deepseek-ai/dsh-patent-core'
import type { ClaimChart } from '@deepseek-ai/dsh-patent-core'
import { loadClaimChart } from '@deepseek-ai/dsh-patent-core'

const CLAIM = '1. 一种过滤装置，包括壳体和滤芯，所述滤芯含有活性炭。'

const readFilePaths = vi.hoisted(() => [] as string[])

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    readFile: (async (path: string, encoding: BufferEncoding) => {
      readFilePaths.push(path)
      return actual.readFile(path, encoding)
    }) as typeof actual.readFile,
  }
})

function goodChart(): unknown {
  return {
    elements: [
      { id: '1a', claimNo: 1, text: '包括壳体', kind: 'limitation' },
      { id: '1b', claimNo: 1, text: '和滤芯', kind: 'limitation' },
      { id: '1c', claimNo: 1, text: '所述滤芯含有活性炭', kind: 'limitation' },
    ],
    rows: [
      { elementId: '1a', targetId: 'D1', quote: '壳体', pinCite: '[D1 段[0032]]', mapping: 'literal' },
      { elementId: '1b', targetId: 'D1', quote: '滤芯', pinCite: '[D1 段[0032]]', mapping: 'literal' },
      { elementId: '1c', targetId: 'D1', quote: '', pinCite: '[D1 段[0032]]', mapping: 'not-found' },
    ],
  }
}

function badChart(): unknown {
  const c = goodChart() as { elements: Array<Record<string, unknown>>; rows: unknown[] }
  c.elements[0]!.text = '包括外壳' // 改写要素 → 校验失败
  return c
}

function badPinChart(): unknown {
  const c = goodChart() as { elements: unknown[]; rows: Array<Record<string, unknown>> }
  c.rows[0]!.pinCite = '[D1 段[9999]]' // 段号 9999 不在源文 → pin-cite 校验失败
  return c
}

function badQuoteChart(): unknown {
  const c = goodChart() as { elements: unknown[]; rows: Array<Record<string, unknown>> }
  c.rows[0]!.quote = '源文中不存在的引用' // quote 不在源文 → 引用校验失败
  return c
}

function malformedChart(): unknown {
  // 字段级 malformed：要素缺 text + null 项、行 null + 缺 quote —— 不应崩溃，应打回重做
  return {
    elements: [{ id: '1a', claimNo: 1, kind: 'limitation' }, null],
    rows: [null, { elementId: '1b', targetId: 'D1', pinCite: '[D1 段[0032]]', mapping: 'literal' }],
  }
}

const SOURCE_TEXT = '[0032]\n壳体与滤芯。\n[0033]\n活性炭滤芯。\n'

it('atom 契约声明按模式派生目标所读的输入键', () => {
  expect(claimChartAtom.inputSchema).toEqual(['claim', 'chart_targets', 'chart_mode', 'office_action', 'prior_art'])
})

it('合法 chart 产出 claim_chart_doc + gap_list', async () => {
  let calls = 0
  const provider: StageProvider = {
    callLLM: async () => {
      calls += 1
      return JSON.stringify(goodChart())
    },
  }
  const handler = new ClaimChartHandler()
  const state = await handler.execute({
    state: {
      claim: CLAIM,
      chart_targets: JSON.stringify([{ id: 'D1', kind: 'prior-art', title: '对比文件1' }]),
      chart_mode: 'invalidity',
    },
    provider,
  })
  expect(calls).toBe(1)
  expect(typeof state.claim_chart_doc).toBe('string')
  const doc = JSON.parse(state.claim_chart_doc as string) as ClaimChart
  expect(doc.gaps.length).toBe(1)
  expect(doc.gaps[0]!.elementId).toBe('1c')
  const gaps = JSON.parse(state.gap_list as string) as ClaimChart['gaps']
  expect(gaps.length).toBe(1)
})

it('拆分要求含 MTU 原子性与方法/结构权利要求注意项', async () => {
  const prompts: string[] = []
  const provider: StageProvider = {
    callLLM: async (prompt: string) => {
      prompts.push(prompt)
      return JSON.stringify(goodChart())
    },
  }
  const handler = new ClaimChartHandler()
  await handler.execute({
    state: {
      claim: CLAIM,
      chart_targets: JSON.stringify([{ id: 'D1', kind: 'prior-art', title: '对比文件1' }]),
      chart_mode: 'invalidity',
    },
    provider,
  })
  expect(prompts[0]).toContain('最小技术单元')
  expect(prompts[0]).toContain('方法权利要求注意各步骤的逻辑顺序与执行主体')
  expect(prompts[0]).toContain('结构权利要求注意部件的连接关系与空间位置')
})

it('非法要素打回重做：第一次坏输出 + 第二次好输出 = 成功且重做 prompt 含错误', async () => {
  const prompts: string[] = []
  let calls = 0
  const provider: StageProvider = {
    callLLM: async (prompt: string) => {
      calls += 1
      prompts.push(prompt)
      return calls === 1 ? JSON.stringify(badChart()) : JSON.stringify(goodChart())
    },
  }
  const handler = new ClaimChartHandler()
  const state = await handler.execute({
    state: {
      claim: CLAIM,
      chart_targets: JSON.stringify([{ id: 'D1', kind: 'prior-art', title: '对比文件1' }]),
      chart_mode: 'invalidity',
    },
    provider,
  })
  expect(calls).toBe(2)
  expect(prompts[1]!.includes('校验失败')).toBeTruthy()
  expect(typeof state.claim_chart_doc).toBe('string')
})

it('重做超过 2 次仍失败 → 降级输出', async () => {
  const provider: StageProvider = {
    callLLM: async () => JSON.stringify(badChart()),
  }
  const handler = new ClaimChartHandler()
  const state = await handler.execute({
    state: { claim: CLAIM, chart_targets: '[]', chart_mode: 'invalidity' },
    provider,
  })
  expect(typeof state._error).toBe('string')
  expect((state._error as string).includes('claim-chart')).toBeTruthy()
})

it('权利要求原文编号重复或跳号 → 不调用 LLM，直接降级', async () => {
  let calls = 0
  const provider: StageProvider = {
    callLLM: async () => {
      calls += 1
      return JSON.stringify(goodChart())
    },
  }
  const handler = new ClaimChartHandler()
  const duplicate = await handler.execute({
    state: {
      claim: '1. 一种装置，包括壳体。\n1. 根据权利要求1所述的装置，还包括滤芯。',
      chart_targets: '[]',
    },
    provider,
  })
  expect(duplicate._error as string).toContain('权利要求编号结构非法')
  expect(duplicate._error as string).toContain('重复')
  const skipped = await handler.execute({
    state: {
      claim: '1. 一种装置，包括壳体。\n3. 根据权利要求1所述的装置，还包括滤芯。',
      chart_targets: '[]',
    },
    provider,
  })
  expect(skipped._error as string).toContain('权利要求编号结构非法')
  expect(skipped._error as string).toContain('跳号')
  expect(calls).toBe(0)
})

it('字段级 malformed 输出（缺 text/null 项）→ 打回重做而非崩溃', async () => {
  const prompts: string[] = []
  let calls = 0
  // 元素模式（targets 空）下好输出 = elements-only（rows 空数组，M2 语义）。
  const elementsOnly = { elements: (goodChart() as { elements: unknown[] }).elements, rows: [] }
  const provider: StageProvider = {
    callLLM: async (prompt: string) => {
      calls += 1
      prompts.push(prompt)
      return calls === 1 ? JSON.stringify(malformedChart()) : JSON.stringify(elementsOnly)
    },
  }
  const handler = new ClaimChartHandler()
  const state = await handler.execute({
    state: { claim: CLAIM, chart_targets: '[]', chart_mode: 'invalidity' },
    provider,
  })
  expect(calls).toBe(2) // 未崩溃，进入打回重做
  expect(prompts[1]!.includes('校验失败')).toBeTruthy()
  expect(typeof state.claim_chart_doc).toBe('string')
})

it('pin-cite 段号错误（sourcePath 提供）→ 打回重做 → 第二次好输出成功', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-src-'))
  const sourcePath = join(dir, 'd1.txt')
  writeFileSync(sourcePath, SOURCE_TEXT, 'utf8')
  try {
    const prompts: string[] = []
    let calls = 0
    const provider: StageProvider = {
      callLLM: async (prompt: string) => {
        calls += 1
        prompts.push(prompt)
        return calls === 1 ? JSON.stringify(badPinChart()) : JSON.stringify(goodChart())
      },
    }
    const handler = new ClaimChartHandler()
    const state = await handler.execute({
      state: {
        claim: CLAIM,
        chart_source_roots: [dir],
        chart_targets: JSON.stringify([{ id: 'D1', kind: 'prior-art', title: '对比文件1', sourcePath }]),
        chart_mode: 'invalidity',
      },
      provider,
    })
    expect(calls).toBe(2)
    expect(prompts[1]!.includes('段号')).toBeTruthy()
    expect(typeof state.claim_chart_doc).toBe('string')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('quote 不在源文（sourcePath 提供）→ 打回重做 → 第二次好输出成功', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-src-'))
  const sourcePath = join(dir, 'd1.txt')
  writeFileSync(sourcePath, SOURCE_TEXT, 'utf8')
  try {
    const prompts: string[] = []
    let calls = 0
    const provider: StageProvider = {
      callLLM: async (prompt: string) => {
        calls += 1
        prompts.push(prompt)
        return calls === 1 ? JSON.stringify(badQuoteChart()) : JSON.stringify(goodChart())
      },
    }
    const handler = new ClaimChartHandler()
    const state = await handler.execute({
      state: {
        claim: CLAIM,
        chart_source_roots: [dir],
        chart_targets: JSON.stringify([{ id: 'D1', kind: 'prior-art', title: '对比文件1', sourcePath }]),
        chart_mode: 'invalidity',
      },
      provider,
    })
    expect(calls).toBe(2)
    expect(prompts[1]!.includes('引用文本在源文中不存在')).toBeTruthy()
    expect(typeof state.claim_chart_doc).toBe('string')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('parseTargets 归一化：source_path（snake_case）target 触发 pin-cite 校验（不静默跳过）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-src-'))
  const sourcePath = join(dir, 'd1.txt')
  writeFileSync(sourcePath, SOURCE_TEXT, 'utf8')
  const prompts: string[] = []
  let calls = 0
  try {
    const provider: StageProvider = {
      callLLM: async (prompt) => {
        prompts.push(prompt)
        calls += 1
        return JSON.stringify(calls === 1 ? badPinChart() : goodChart())
      },
    }
    const handler = new ClaimChartHandler()
    const state = await handler.execute({
      state: {
        claim: CLAIM,
        chart_source_roots: [dir],
        // 外部契约字段：source_path（非内核 sourcePath）——归一化后 pin-cite 校验必须生效
        chart_targets: JSON.stringify([{ id: 'D1', kind: 'prior-art', title: '对比文件1', source_path: sourcePath }]),
        chart_mode: 'invalidity',
      },
      provider,
    })
    // 段号 9999 不在源文 → 第一次输出校验失败触发打回重做（归一化前会静默跳过校验直接成功）
    expect(calls).toBe(2)
    expect(prompts[0]!).toMatch(/段号|pinCite|定位|不在|存在/)
    expect(typeof state.claim_chart_doc).toBe('string') // 第二次好输出成功
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('parseTargets 归一化：kind=product → accused-product（doe 行合法，anticipation 行报错）', async () => {
  const prompts: string[] = []
  let calls = 0
  const provider: StageProvider = {
    callLLM: async (prompt) => {
      prompts.push(prompt)
      calls += 1
      if (calls === 1) {
        // 第一次输出：anticipation 行（仅 prior-art 目标合法）→ product 归一化后不是 prior-art → 校验失败
        return JSON.stringify({
          elements: (goodChart() as { elements: unknown[] }).elements,
          rows: [
            { elementId: '1a', targetId: 'P1', quote: '壳体', pinCite: '', mapping: 'anticipation' },
            { elementId: '1b', targetId: 'P1', quote: '', pinCite: '', mapping: 'literal' },
          ],
        })
      }
      // 第二次输出：doe 行（侵权模式下合法）→ 成功
      return JSON.stringify({
        elements: (goodChart() as { elements: unknown[] }).elements,
        rows: [
          { elementId: '1a', targetId: 'P1', quote: '壳体', pinCite: '', mapping: 'doe' },
          { elementId: '1b', targetId: 'P1', quote: '滤芯', pinCite: '', mapping: 'literal' },
          { elementId: '1c', targetId: 'P1', quote: '', pinCite: '', mapping: 'not-found' },
        ],
      })
    },
  }
  const handler = new ClaimChartHandler()
  const state = await handler.execute({
    state: {
      claim: CLAIM,
      chart_targets: JSON.stringify([{ id: 'P1', kind: 'product', title: '被控产品A' }]),
      chart_mode: 'infringement',
    },
    provider,
  })
  expect(calls).toBe(2)
  expect(prompts[1]!).toMatch(/仅适用于 prior-art/) // 重做 prompt 含错误：anticipation 行被拒（product ≠ prior-art）
  expect(prompts[0]!).toMatch(/被控产品A/) // 基础 prompt 中 kind 渲染为"被控产品"分支
  const doc = JSON.parse(state.claim_chart_doc as string) as ClaimChart
  expect(doc.mode).toBe('infringement')
  expect(doc.targets[0]!.kind).toBe('accused-product') // 归一化为内核 kind
  expect(doc.rows[0]!.mapping).toBe('doe') // doe 行合法通过
})

it('引用完整性：行引用了不存在的 elementId/targetId → 打回重做', async () => {
  const prompts: string[] = []
  let calls = 0
  const provider: StageProvider = {
    callLLM: async (prompt) => {
      prompts.push(prompt)
      calls += 1
      if (calls === 1) {
        const c = goodChart() as { elements: unknown[]; rows: Array<Record<string, unknown>> }
        c.rows[0]!.elementId = '9z' // 幻觉出的未知要素
        c.rows[1]!.targetId = 'D9' // 幻觉出的未知目标
        return JSON.stringify(c)
      }
      return JSON.stringify(goodChart())
    },
  }
  const handler = new ClaimChartHandler()
  const state = await handler.execute({
    state: {
      claim: CLAIM,
      chart_targets: JSON.stringify([{ id: 'D1', kind: 'prior-art', title: '对比文件1' }]),
      chart_mode: 'invalidity',
    },
    provider,
  })
  expect(calls).toBe(2)
  expect(prompts[1]!).toMatch(/不存在的要素 9z/)
  expect(prompts[1]!).toMatch(/不存在的目标 D9/)
  expect(typeof state.claim_chart_doc).toBe('string') // 第二次好输出成功
})

it('sourcePath 文件不存在 → 调用模型前中止（不消耗重做），错误码归调用方输入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-src-'))
  const sourcePath = join(dir, 'missing.txt') // 不存在
  let calls = 0
  try {
    const provider: StageProvider = {
      callLLM: async () => {
        calls += 1
        return JSON.stringify(goodChart())
      },
    }
    const handler = new ClaimChartHandler()
    const state = await handler.execute({
      state: {
        claim: CLAIM,
        chart_source_roots: [dir],
        chart_targets: JSON.stringify([{ id: 'D1', kind: 'prior-art', title: '对比文件1', sourcePath }]),
        chart_mode: 'invalidity',
      },
      provider,
    })
    expect(typeof state._error).toBe('string')
    expect((state._error as string).includes(sourcePath)).toBeTruthy() // 降级错误含目标路径
    expect(state[DEGRADED_CODE_KEY]).toBe('invalid_tool_input')
    // 源文不可读不是模型能修的错误：一次模型调用都不该发生。
    expect(calls).toBe(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('多个目标中一个源文不可读 → 整次中止，不产出部分图表', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-src-partial-'))
  const readable = join(dir, 'd1.txt')
  const missing = join(dir, 'missing.txt')
  writeFileSync(readable, SOURCE_TEXT, 'utf8')
  let calls = 0
  try {
    const state = await new ClaimChartHandler().execute({
      state: {
        claim: CLAIM,
        chart_source_roots: [dir],
        chart_targets: JSON.stringify([
          { id: 'D1', kind: 'prior-art', sourcePath: readable },
          { id: 'D2', kind: 'prior-art', sourcePath: missing },
        ]),
        chart_mode: 'invalidity',
      },
      provider: {
        callLLM: async () => {
          calls += 1
          return JSON.stringify(goodChart())
        },
      },
    })
    expect(state.claim_chart_doc).toBeUndefined()
    expect(state[DEGRADED_CODE_KEY]).toBe('invalid_tool_input')
    expect(state._error as string).toContain(missing)
    expect(calls).toBe(0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('多个目标共享同一 sourcePath 时只读取一次源文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-dup-'))
  const sourcePath = join(dir, 'd1.txt')
  writeFileSync(sourcePath, SOURCE_TEXT, 'utf8')
  readFilePaths.length = 0
  try {
    const provider: StageProvider = {
      callLLM: async () => JSON.stringify({
        elements: [{ id: '1a', claimNo: 1, text: '包括壳体', kind: 'limitation' }],
        rows: [
          { elementId: '1a', targetId: 'D1', quote: '壳体', pinCite: '[D1 段[0032]]', mapping: 'literal' },
          { elementId: '1a', targetId: 'D2', quote: '滤芯', pinCite: '[D2 段[0032]]', mapping: 'literal' },
        ],
      }),
    }
    const state = await new ClaimChartHandler().execute({
      state: {
        claim: CLAIM,
        chart_source_roots: [dir],
        chart_targets: JSON.stringify([
          { id: 'D1', kind: 'prior-art', sourcePath },
          { id: 'D2', kind: 'prior-art', sourcePath },
        ]),
        chart_mode: 'invalidity',
      },
      provider,
    })
    expect(state._error).toBeUndefined()
    // 读取发生在 realpath 之后的真实路径上（校验与读取之间不重新经过符号链接）。
    expect(readFilePaths.filter(path => path === realpathSync(sourcePath))).toHaveLength(1)
    const chart = JSON.parse(String(state.claim_chart_doc)) as { rows: unknown[] }
    expect(chart.rows).toHaveLength(2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('sourcePath 不在 chart_source_roots → 调用模型前中止，内容不进入提示词', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-src-denied-'))
  const root = join(dir, 'allowed')
  mkdirSync(root)
  const outside = join(dir, 'outside.txt')
  writeFileSync(outside, SOURCE_TEXT, 'utf8')
  const prompts: string[] = []
  try {
    const state = await new ClaimChartHandler().execute({
      state: {
        claim: CLAIM,
        chart_source_roots: [root],
        chart_targets: JSON.stringify([{ id: 'D1', kind: 'prior-art', sourcePath: outside }]),
        chart_mode: 'invalidity',
      },
      provider: {
        callLLM: async (prompt) => {
          prompts.push(prompt)
          return JSON.stringify(goodChart())
        },
      },
    })
    expect(typeof state._error).toBe('string')
    expect(state._error as string).toContain('不在允许目录')
    expect(state._error as string).toContain(outside)
    expect(state[DEGRADED_CODE_KEY]).toBe('invalid_tool_input')
    expect(prompts).toEqual([])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('空 chart_source_roots 拒绝所有源文件，不表示任意路径', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-src-empty-'))
  const sourcePath = join(dir, 'd1.txt')
  writeFileSync(sourcePath, SOURCE_TEXT, 'utf8')
  try {
    const state = await new ClaimChartHandler().execute({
      state: {
        claim: CLAIM,
        chart_source_roots: [],
        chart_targets: JSON.stringify([{ id: 'D1', kind: 'prior-art', sourcePath }]),
        chart_mode: 'invalidity',
      },
      provider: { callLLM: async () => JSON.stringify(goodChart()) },
    })
    expect(typeof state._error).toBe('string')
    expect(state._error as string).toContain('不在允许目录')
    expect(state[DEGRADED_CODE_KEY]).toBe('invalid_tool_input')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('未配置根时只读取 cwd 内的相对源路径', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-src-cwd-'))
  writeFileSync(join(dir, 'd1.txt'), SOURCE_TEXT, 'utf8')
  const prevCwd = process.cwd()
  process.chdir(dir)
  try {
    const prompts: string[] = []
    const state = await new ClaimChartHandler().execute({
      state: {
        claim: CLAIM,
        chart_targets: JSON.stringify([{ id: 'D1', kind: 'prior-art', sourcePath: 'd1.txt' }]),
        chart_mode: 'invalidity',
      },
      provider: {
        callLLM: async (prompt) => {
          prompts.push(prompt)
          return JSON.stringify(goodChart())
        },
      },
    })
    expect(state._error).toBeUndefined()
    expect(typeof state.claim_chart_doc).toBe('string')
    expect(prompts[0]).not.toContain(SOURCE_TEXT)
  } finally {
    process.chdir(prevCwd)
    rmSync(dir, { recursive: true, force: true })
  }
})

it('chart_source_max_bytes 生效：超过上限的源文件在调用模型前中止', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-src-size-'))
  const sourcePath = join(dir, 'd1.txt')
  writeFileSync(sourcePath, SOURCE_TEXT, 'utf8')
  try {
    const state = await new ClaimChartHandler().execute({
      state: {
        claim: CLAIM,
        chart_source_roots: [dir],
        chart_source_max_bytes: 5,
        chart_targets: JSON.stringify([{ id: 'D1', kind: 'prior-art', sourcePath }]),
        chart_mode: 'invalidity',
      },
      provider: { callLLM: async () => JSON.stringify(goodChart()) },
    })
    expect(typeof state._error).toBe('string')
    expect(state._error as string).toContain('超过大小上限（5 字节）')
    expect(state[DEGRADED_CODE_KEY]).toBe('invalid_tool_input')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('非法源文件配置在模型调用前降级', async () => {
  let calls = 0
  const provider: StageProvider = {
    callLLM: async () => {
      calls += 1
      return JSON.stringify(goodChart())
    },
  }
  const handler = new ClaimChartHandler()
  const badRoots = await handler.execute({
    state: { claim: CLAIM, chart_source_roots: 'not-a-list' },
    provider,
  })
  expect(badRoots._error as string).toContain('chart_source_roots')
  const badBytes = await handler.execute({
    state: { claim: CLAIM, chart_source_max_bytes: 0 },
    provider,
  })
  expect(badBytes._error as string).toContain('chart_source_max_bytes')
  const missingRoot = await handler.execute({
    state: {
      claim: CLAIM,
      chart_source_roots: [join(tmpdir(), `dsh-missing-root-${process.pid}-${Date.now()}`)],
    },
    provider,
  })
  expect(missingRoot._error as string).toContain('无法解析')
  expect(calls).toBe(0)
})

it('caseId 提供时落盘 json，verified 行在重跑时保留', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-atom-'))
  const prevCwd = process.cwd()
  process.chdir(dir)
  try {
    const caseId = 'case-1'
    const chartId = 'chart-invalidity' // 按 mode 命名（M1 修复）
    const handler = new ClaimChartHandler()
    // 第一次运行：caseId 提供 → 落盘
    const p1: StageProvider = { caseId, callLLM: async () => JSON.stringify(goodChart()) }
    await handler.execute({
      state: {
        claim: CLAIM,
        chart_targets: JSON.stringify([{ id: 'D1', kind: 'prior-art', title: '对比文件1' }]),
        chart_mode: 'invalidity',
      },
      provider: p1,
    })
    // 人工核验第 1 行（1a→D1）
    const saved = loadClaimChart(caseId, chartId)
    expect(saved).toBeTruthy()
    saved!.rows[0]!.verified = true
    const { saveClaimChart } = await import('@deepseek-ai/dsh-patent-core')
    await saveClaimChart(saved!, caseId)
    const again = loadClaimChart(caseId, chartId)
    expect(again?.rows[0]?.verified).toBe(true) // verified 行可持久化往返
    // 第二次运行 handler（同 caseId）：loadClaimChart 合并 verified —— 已验证行保留、未验证行仍 false
    const p2: StageProvider = { caseId, callLLM: async () => JSON.stringify(goodChart()) }
    await handler.execute({
      state: {
        claim: CLAIM,
        chart_targets: JSON.stringify([{ id: 'D1', kind: 'prior-art', title: '对比文件1' }]),
        chart_mode: 'invalidity',
      },
      provider: p2,
    })
    const merged = loadClaimChart(caseId, chartId)
    expect(merged?.rows[0]?.verified).toBe(true) // 1a→D1 核验标记重跑保留（内容一致）
    expect(merged?.rows[1]?.verified).toBe(false) // 1b→D1 未核验仍 false
    expect(merged?.rows[2]?.verified).toBe(false)
  } finally {
    process.chdir(prevCwd)
    rmSync(dir, { recursive: true, force: true })
  }
})

it('重跑产出内容变化的行，verified 不迁移（M1 内容指纹）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-atom-'))
  const prevCwd = process.cwd()
  process.chdir(dir)
  try {
    const caseId = 'case-1'
    const chartId = 'chart-invalidity'
    const handler = new ClaimChartHandler()
    await handler.execute({
      state: {
        claim: CLAIM,
        chart_targets: JSON.stringify([{ id: 'D1', kind: 'prior-art', title: '对比文件1' }]),
        chart_mode: 'invalidity',
      },
      provider: { caseId, callLLM: async () => JSON.stringify(goodChart()) },
    })
    const saved = loadClaimChart(caseId, chartId)!
    saved.rows[0]!.verified = true
    const { saveClaimChart } = await import('@deepseek-ai/dsh-patent-core')
    await saveClaimChart(saved, caseId)
    // 重跑：1a 行 mapping 从 literal 变为 not-found（内容变化，人工核验应作废）
    const changed = goodChart() as { rows: Array<Record<string, unknown>> }
    changed.rows[0]!.mapping = 'not-found'
    changed.rows[0]!.quote = ''
    await handler.execute({
      state: {
        claim: CLAIM,
        chart_targets: JSON.stringify([{ id: 'D1', kind: 'prior-art', title: '对比文件1' }]),
        chart_mode: 'invalidity',
      },
      provider: { caseId, callLLM: async () => JSON.stringify(changed) },
    })
    const merged = loadClaimChart(caseId, chartId)
    expect(merged?.rows[0]?.verified).toBe(false) // 内容变化 → 旧核验作废
    expect(merged?.rows[1]?.verified).toBe(false)
  } finally {
    process.chdir(prevCwd)
    rmSync(dir, { recursive: true, force: true })
  }
})

it('同 caseId 不同 mode 落盘互不覆盖（chartId 按 mode 区分）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cc-atom-'))
  const prevCwd = process.cwd()
  process.chdir(dir)
  try {
    const caseId = 'case-1'
    const handler = new ClaimChartHandler()
    await handler.execute({
      state: {
        claim: CLAIM,
        chart_targets: JSON.stringify([{ id: 'D1', kind: 'prior-art', title: '对比文件1' }]),
        chart_mode: 'invalidity',
      },
      provider: { caseId, callLLM: async () => JSON.stringify(goodChart()) },
    })
    await handler.execute({
      state: {
        claim: CLAIM,
        chart_targets: JSON.stringify([{ id: 'D1', kind: 'prior-art', title: '对比文件1' }]),
        chart_mode: 'patentability',
      },
      provider: { caseId, callLLM: async () => JSON.stringify(goodChart()) },
    })
    const invalidity = loadClaimChart(caseId, 'chart-invalidity')
    const patentability = loadClaimChart(caseId, 'chart-patentability')
    expect(invalidity).toBeTruthy()
    expect(patentability).toBeTruthy()
    expect(invalidity!.mode).toBe('invalidity')
    expect(patentability!.mode).toBe('patentability')
    expect(loadClaimChart(caseId, 'chart-1')).toBeNull() // 旧 chart-1 命名不再产生
  } finally {
    process.chdir(prevCwd)
    rmSync(dir, { recursive: true, force: true })
  }
})

it('元素模式（chart_targets 为空）产出幻影 rows → 打回重做（M2）', async () => {
  const prompts: string[] = []
  let calls = 0
  // 第一次输出带 rows（targetId D1 无对应目标），第二次好输出 rows 为空数组
  const goodElementsOnly = { elements: (goodChart() as { elements: unknown[] }).elements, rows: [] }
  const provider: StageProvider = {
    callLLM: async (prompt: string) => {
      calls += 1
      prompts.push(prompt)
      return calls === 1 ? JSON.stringify(goodChart()) : JSON.stringify(goodElementsOnly)
    },
  }
  const handler = new ClaimChartHandler()
  const state = await handler.execute({
    state: { claim: CLAIM, chart_targets: '[]', chart_mode: 'invalidity' },
    provider,
  })
  expect(calls).toBe(2)
  expect(prompts[1]!).toMatch(/不得产出映射行/)
  const doc = JSON.parse(state.claim_chart_doc as string) as ClaimChart
  expect(doc.rows.length).toBe(0) // 幻影 rows 未进入 chart
})

it('无 sourcePath 时 pin-cite 格式非法仍打回重做（m4 格式校验无条件）', async () => {
  const prompts: string[] = []
  let calls = 0
  const badFormatChart = goodChart() as { rows: Array<Record<string, unknown>> }
  badFormatChart.rows[0]!.pinCite = '[D1 段[0032]' // 缺右括号：格式非法
  const provider: StageProvider = {
    callLLM: async (prompt: string) => {
      calls += 1
      prompts.push(prompt)
      return calls === 1 ? JSON.stringify(badFormatChart) : JSON.stringify(goodChart())
    },
  }
  const handler = new ClaimChartHandler()
  const state = await handler.execute({
    state: {
      claim: CLAIM,
      chart_targets: JSON.stringify([{ id: 'D1', kind: 'prior-art', title: '对比文件1' }]),
      chart_mode: 'invalidity',
    },
    provider,
  })
  expect(calls).toBe(2)
  expect(prompts[1]!).toMatch(/pin-cite 格式非法/)
  expect(typeof state.claim_chart_doc).toBe('string')
})

it('未提供源文的目标在提示里标注，其行留空 quote/pinCite 即通过校验', async () => {
  const prompts: string[] = []
  const chart = goodChart() as { rows: Array<Record<string, unknown>> }
  for (const row of chart.rows) {
    row.quote = ''
    row.pinCite = ''
  }
  const provider: StageProvider = {
    callLLM: async (prompt: string) => {
      prompts.push(prompt)
      return JSON.stringify(chart)
    },
  }
  const handler = new ClaimChartHandler()
  const state = await handler.execute({
    state: {
      claim: CLAIM,
      chart_targets: JSON.stringify([{ id: 'D1', kind: 'prior-art', title: '对比文件1' }]),
      chart_mode: 'invalidity',
    },
    provider,
  })
  expect(prompts).toHaveLength(1) // 空 pin-cite 不触发打回重做
  expect(prompts[0]!).toMatch(/D1（对比文件：对比文件1，未提供源文）/)
  expect(prompts[0]!).toMatch(/一律留空串/)
  const doc = JSON.parse(state.claim_chart_doc as string) as ClaimChart
  expect(doc.rows.map(row => row.pinCite)).toEqual(['', '', ''])
})

it('oa-response 模式：未手传 chart_targets 时由 office_action 派生对比文件目标', async () => {
  let prompt = ''
  const provider: StageProvider = {
    callLLM: async (p: string) => {
      prompt = p
      return JSON.stringify({
        elements: [{ id: '1a', claimNo: 1, text: '包括壳体', kind: 'limitation' }],
        rows: [{ elementId: '1a', targetId: 'CN112345678A', quote: '', pinCite: '', mapping: 'anticipation' }],
      })
    },
  }
  const handler = new ClaimChartHandler()
  const state = await handler.execute({
    state: {
      claim: CLAIM,
      chart_mode: 'oa-response',
      office_action: JSON.stringify({
        rejectionType: 'inventiveness',
        rejectionTypes: ['inventiveness'],
        citations: [{ documentNumber: 'CN112345678A', relevancy: 'Y', claimsAffected: [1] }],
        affectedClaims: [1],
        examinerArguments: [],
      }),
    },
    provider,
  })
  expect(prompt).toContain('CN112345678A')
  const doc = JSON.parse(state.claim_chart_doc as string) as ClaimChart
  expect(doc.targets).toEqual([{ id: 'CN112345678A', kind: 'prior-art' }])
  expect(doc.mode).toBe('oa-response')
})

it('patentability 模式：未手传 chart_targets 时由过滤后的 prior_art 派生目标', async () => {
  let prompt = ''
  const provider: StageProvider = {
    callLLM: async (p: string) => {
      prompt = p
      return JSON.stringify({ elements: (goodChart() as { elements: unknown[] }).elements, rows: [] })
    },
  }
  const handler = new ClaimChartHandler()
  const state = await handler.execute({
    state: {
      claim: CLAIM,
      chart_mode: 'patentability',
      prior_art: [
        { dLabel: 'D1', title: '对比文件1' },
        { title: '无标号条目' },
        { dLabel: 'D1', title: '重复条目' },
        { dLabel: 'D3', title: '   ' },
        'not-an-object',
        null,
        { dLabel: 'D4', title: 42 },
      ],
    },
    provider,
  })
  expect(prompt).toContain('D1（对比文件：对比文件1')
  expect(prompt).toContain('D2（对比文件：无标号条目')
  expect(prompt).toContain('D3（对比文件')
  expect(prompt).toContain('D4（对比文件')
  expect(prompt).not.toContain('重复条目')
  const doc = JSON.parse(state.claim_chart_doc as string) as ClaimChart
  expect(doc.targets).toEqual([
    { id: 'D1', kind: 'prior-art', title: '对比文件1' },
    { id: 'D2', kind: 'prior-art', title: '无标号条目' },
    { id: 'D3', kind: 'prior-art' },
    { id: 'D4', kind: 'prior-art' },
  ])
})

it('patentability 模式：prior_art 不是数组时不造目标', async () => {
  let prompt = ''
  const provider: StageProvider = {
    callLLM: async (p: string) => {
      prompt = p
      return JSON.stringify({ elements: (goodChart() as { elements: unknown[] }).elements, rows: [] })
    },
  }
  const handler = new ClaimChartHandler()
  const state = await handler.execute({
    state: { claim: CLAIM, chart_mode: 'patentability', prior_art: 'not-an-array' },
    provider,
  })
  expect(prompt).toContain('只拆分要素')
  const doc = JSON.parse(state.claim_chart_doc as string) as ClaimChart
  expect(doc.targets).toEqual([])
})

it('oa-response 模式：手传 chart_targets 优先（派生不覆盖显式输入）', async () => {
  const provider: StageProvider = { callLLM: async () => JSON.stringify(goodChart()) }
  const handler = new ClaimChartHandler()
  const state = await handler.execute({
    state: {
      claim: CLAIM,
      chart_mode: 'oa-response',
      chart_targets: JSON.stringify([{ id: 'D1', kind: 'prior-art', title: '对比文件1' }]),
      office_action: JSON.stringify({
        rejectionType: 'inventiveness',
        rejectionTypes: ['inventiveness'],
        citations: [{ documentNumber: 'CN112345678A', claimsAffected: [1] }],
        affectedClaims: [1],
        examinerArguments: [],
      }),
    },
    provider,
  })
  const doc = JSON.parse(state.claim_chart_doc as string) as ClaimChart
  expect(doc.targets.map(target => target.id)).toEqual(['D1'])
})

it('oa-response 模式：无解析产出时回落"只拆要素"（不造目标）', async () => {
  let prompt = ''
  const provider: StageProvider = {
    callLLM: async (p: string) => {
      prompt = p
      return JSON.stringify({ elements: (goodChart() as { elements: unknown[] }).elements, rows: [] })
    },
  }
  const handler = new ClaimChartHandler()
  const state = await handler.execute({
    state: { claim: CLAIM, chart_mode: 'oa-response' },
    provider,
  })
  expect(prompt).toContain('只拆分要素')
  const doc = JSON.parse(state.claim_chart_doc as string) as ClaimChart
  expect(doc.targets).toEqual([])
})

it('非法 chart_mode 降级并列出取值域，且不调用模型', async () => {
  let calls = 0
  const provider: StageProvider = {
    callLLM: async () => {
      calls += 1
      throw new Error('非法 mode 应在调用模型前降级')
    },
  }
  const state = await new ClaimChartHandler().execute({
    state: { claim: CLAIM, chart_mode: 'bogus' },
    provider,
  })
  expect(String(state._error)).toContain('[claim-chart] chart_mode 非法')
  expect(String(state._error)).toContain('"bogus"')
  expect(String(state._error)).toContain('infringement / invalidity / oa-response / reexamination / patentability')
  expect(calls).toBe(0)
})

it('空白 chart_mode 使用缺省 invalidity', async () => {
  const provider: StageProvider = {
    callLLM: async () => JSON.stringify({ elements: (goodChart() as { elements: unknown[] }).elements, rows: [] }),
  }
  const state = await new ClaimChartHandler().execute({
    state: { claim: CLAIM, chart_mode: '   ' },
    provider,
  })
  const doc = JSON.parse(state.claim_chart_doc as string) as ClaimChart
  expect(doc.mode).toBe('invalidity')
})
