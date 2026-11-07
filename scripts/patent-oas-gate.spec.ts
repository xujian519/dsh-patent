/**
 * `patent-oas` 问题空间 DAG 与带门槛回归门禁的验收测试。
 *
 * 每条负例对应门禁的一条拒绝路径:金标/DAG 漂移、权重不符、图成环、门槛不可满足、
 * run 记录与金标不符、以及分数回退。正向用例固定聚合口径,免得口径被无声改掉。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import {
  GATE_FILE,
  PATENT_OAS_EXAMPLE_DIR,
  PROBLEM_SPACE_FILE,
  aggregateScoresByRun,
  caseScores,
  caseScoresByRun,
  deltaStandardError,
  caseRoundScores,
  baselineDeclarationFor,
  comparisonSettingProblems,
  evaluateRun,
  executionOf,
  findBaselineDeclaration,
  findCycles,
  formatVerdict,
  goldDigest,
  isOutsideRoot,
  loadGateConfig,
  loadGold,
  loadProblemSpace,
  loadRunRecord,
  mean,
  nodeScores,
  nodeScoresByRun,
  notAssessedNodesOf,
  parseRubricDimensions,
  roundScore,
  scoreSpread,
  surfaceOf,
  textDigest,
  validateGateConfig,
  validateProblemSpace,
  validateRunRecord,
  verdictPassed,
  type BaselineDeclaration,
  type CaseMapping,
  type DeclaredBaseline,
  type DimensionMapping,
  type GateConfig,
  type GoldCase,
  type ProblemSpace,
  type ProblemSpaceNode,
  type RunRecord,
  type SurfacePolicy,
} from './patent-oas-gate-core.ts'
import { acceptBaseline, acceptTarget } from './verify-patent-oas-gold.ts'

const root = resolve(import.meta.dirname, '..')
const exampleDir = resolve(root, PATENT_OAS_EXAMPLE_DIR)
const gatePath = resolve(root, GATE_FILE)
const problemSpacePath = resolve(root, PROBLEM_SPACE_FILE)

const gold = await loadGold(exampleDir)
const space = await loadProblemSpace(problemSpacePath)
const config = await loadGateConfig(gatePath)

const scratchDirs: string[] = []
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

/** 取 case 映射;取不到即测试装置出错,而不是断言失败。 */
function mappingOf(target: ProblemSpace, caseId: string): CaseMapping {
  const mapping = target.cases[caseId]
  if (mapping === undefined) throw new Error(`fixture: 缺少 ${caseId} 的映射`)
  return mapping
}

/** 取维度映射。 */
function dimensionOf(mapping: CaseMapping, index: number): DimensionMapping {
  const dimension = mapping.dimensions[index]
  if (dimension === undefined) throw new Error(`fixture: 缺少维度 ${index} 的映射`)
  return dimension
}

/** 取节点。 */
function nodeOf(target: ProblemSpace, nodeId: string): ProblemSpaceNode {
  const node = target.nodes[nodeId]
  if (node === undefined) throw new Error(`fixture: 缺少节点 ${nodeId}`)
  return node
}

/** 取列表首项;空列表即测试装置出错。 */
function first<T>(values: readonly T[]): T {
  const value = values[0]
  if (value === undefined) throw new Error('fixture: 期望非空列表')
  return value
}

/** 按给定分数构造一次 run 记录;维度名与满分一律取自金标 rubric。 */
function recordFrom(
  cases: readonly GoldCase[],
  score: (caseId: string, index: number) => number,
  runsPerCase = 1,
): RunRecord {
  const record: RunRecord = {
    benchmarkId: 'patent-oas',
    recordedAt: '2026-09-26T00:00:00.000Z',
    runsPerCase,
    cases: cases.map(goldCase => ({
      caseId: goldCase.caseId,
      retrieval: mappingOf(space, goldCase.caseId).retrieval,
      dimensions: parseRubricDimensions(goldCase.rubric).map(dimension => ({
        index: dimension.index,
        label: dimension.label,
        points: dimension.points,
        score: score(goldCase.caseId, dimension.index),
      })),
    })),
  }
  return withGoldRounds(cases, record)
}

/**
 * 给多轮金标补逐轮观测:各轮同分,所有轮与 case 观测共用同一批维度对象,
 * 因此后续补写的 `scores` 和对终局分数的改写会落到每一轮,不必多处同步。
 */
function withGoldRounds(cases: readonly GoldCase[], record: RunRecord): RunRecord {
  for (const goldCase of cases) {
    const extra = goldCase.rounds ?? []
    if (extra.length === 0) continue
    const target = record.cases.find(entry => entry.caseId === goldCase.caseId)
    if (target === undefined) throw new Error(`fixture: 缺少 ${goldCase.caseId}`)
    target.rounds = [1, ...extra.map(entry => entry.round)].map((round) => {
      const scripted = extra.find(entry => entry.round === round)
      return {
        round,
        ...scripted === undefined ? {} : { statementDigest: textDigest(scripted.statement) },
        dimensions: target.dimensions,
        deliverableDigests: Array.from(
          { length: record.runsPerCase },
          (_, run) => textDigest(`${goldCase.caseId} 第 ${round} 轮第 ${run + 1} 次交付物`),
        ),
      }
    })
  }
  return record
}

/** 给每条逐轮观测补权项版本:第 n 轮的取代链深度是 n。 */
function withClaimVersions(record: RunRecord): RunRecord {
  for (const runCase of record.cases) {
    for (const round of runCase.rounds ?? []) {
      round.claimVersions = Array.from({ length: record.runsPerCase }, () => round.round)
    }
  }
  return record
}

/** 造一份逐次观测与均值一致的多次运行记录。 */
function recordWithScores(scores: readonly number[]): RunRecord {
  const record = recordFrom(gold, () => roundScore(mean(scores)), scores.length)
  for (const runCase of record.cases) {
    for (const dimension of runCase.dimensions) dimension.scores = [...scores]
  }
  return record
}

/** 第 2 轮脚本化审查意见。 */
const SECOND_ROUND_STATEMENT = '审查员认为修改后的权利要求 1 仍未克服创造性缺陷,请进一步陈述。'

/** 模拟多轮金标:仅 oa-answer 带第 2 轮审查意见。 */
function multiroundGold(): GoldCase[] {
  return gold.map(entry => entry.caseId === 'oa-answer'
    ? { ...entry, rounds: [{ round: 2, statement: SECOND_ROUND_STATEMENT }] }
    : entry)
}

/** 模拟单轮金标:去掉 oa-answer 的脚本化审查意见。 */
function singleRoundGold(): GoldCase[] {
  return gold.map(entry => entry.caseId === 'oa-answer' ? { ...entry, rounds: [] } : entry)
}

/** 为 oa-answer 补两轮观测;终局维度沿用记录里的分数(即第 2 轮)。 */
function withRounds(record: RunRecord, firstRound: number): RunRecord {
  const target = record.cases.find(entry => entry.caseId === 'oa-answer')
  if (target === undefined) throw new Error('fixture: 缺少 oa-answer')
  target.rounds = [1, 2].map(round => ({
    round,
    ...round === 1 ? {} : { statementDigest: textDigest(SECOND_ROUND_STATEMENT) },
    dimensions: target.dimensions.map(dimension => ({
      index: dimension.index,
      score: round === 1 ? firstRound : dimension.score,
    })),
    deliverableDigests: [textDigest(`round-${round}`)],
  }))
  return record
}

/** 在临时目录造一个只含指定 case 的金标树,返回根目录。 */
function writeGoldTree(caseId: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'patent-oas-gold-'))
  scratchDirs.push(dir)
  const caseDir = join(dir, 'cases', caseId)
  mkdirSync(caseDir, { recursive: true })
  for (const [relative, content] of Object.entries(files)) {
    const path = join(caseDir, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content, 'utf8')
  }
  return dir
}

/** 取 oa-answer 的两轮观测;没有即测试装置出错。 */
function roundsOf(record: RunRecord): NonNullable<RunRecord['cases'][number]['rounds']> {
  const target = record.cases.find(entry => entry.caseId === 'oa-answer')
  if (target?.rounds === undefined) throw new Error('fixture: 缺少 oa-answer 的逐轮观测')
  return target.rounds
}

/** 深拷贝问题空间,供负例改坏后再校验。 */
function cloneSpace(): ProblemSpace {
  return structuredClone(space)
}

/** 在临时目录里落一份 run 记录,返回路径。 */
function writeRecord(record: RunRecord): string {
  return writeRawRecord(record)
}

/** 在临时目录里落一份任意 JSON 值,返回路径。 */
function writeRawRecord(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'patent-oas-gate-'))
  scratchDirs.push(dir)
  const path = join(dir, 'run.json')
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return path
}

/** 在临时目录里落一份 gate 配置(YAML 接受 JSON 文档),返回路径。 */
function writeGate(value: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'patent-oas-gate-config-'))
  scratchDirs.push(dir)
  const path = join(dir, 'gate.yaml')
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return path
}

/** 现有门槛取值,供只改 `baselines` 的配置负例复用。 */
function currentThresholds(): GateConfig['thresholds'] {
  return structuredClone(config.thresholds)
}

/** 把一条记录挂到仓库现有基线声明上,组成 `validateGateConfig` 的一项输入。 */
function declared(record: RunRecord, label: string): DeclaredBaseline {
  return { declaration: first(config.baselines), label, record }
}

/** 以源码启动方式运行门禁脚本。 */
function runGate(...args: string[]): ReturnType<typeof spawnSync> {
  const script = resolve(import.meta.dirname, 'verify-patent-oas-gold.ts')
  return spawnSync(process.execPath, ['--import', import.meta.resolve('tsx/esm'), script, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
  })
}

describe('金标与问题空间 DAG', () => {
  it('金标与 DAG 互相钉住,每个 rubric 维度都有等权映射', () => {
    expect(validateProblemSpace(space, gold)).toEqual([])
    for (const goldCase of gold) {
      const dimensions = parseRubricDimensions(goldCase.rubric)
      const mapping = mappingOf(space, goldCase.caseId)
      for (const dimension of dimensions) {
        const weight = Object.values(dimensionOf(mapping, dimension.index).nodes).reduce((sum, value) => sum + value, 0)
        expect(weight, `${goldCase.caseId}#${dimension.index}`).toBe(dimension.points)
      }
    }
  })

  it('缺少维度映射即失败', () => {
    const broken = cloneSpace()
    delete mappingOf(broken, 'oa-answer').dimensions[3]
    expect(validateProblemSpace(broken, gold).join('\n')).toContain('维度 3')
  })

  it('映射权重与 rubric 满分不符即失败', () => {
    const broken = cloneSpace()
    mappingOf(broken, 'oa-answer').dimensions[1] = { nodes: { 'distinguishing-features': 20 } }
    expect(validateProblemSpace(broken, gold).join('\n')).toContain('映射权重合计 20')
  })

  it('负权重与零权重即失败', () => {
    const negative = cloneSpace()
    mappingOf(negative, 'oa-answer').dimensions[1] = { nodes: { 'distinguishing-features': 35, 'technical-teaching': -5 } }
    expect(validateProblemSpace(negative, gold).join('\n')).toContain('权重 -5 必须为正')
    const zero = cloneSpace()
    mappingOf(zero, 'oa-answer').dimensions[1] = { nodes: { 'distinguishing-features': 30, 'technical-teaching': 0 } }
    expect(validateProblemSpace(zero, gold).join('\n')).toContain('权重 0 必须为正')
  })

  it('映射到未声明的节点即失败', () => {
    const broken = cloneSpace()
    mappingOf(broken, 'oa-answer').dimensions[1] = { nodes: { 'no-such-node': 30 } }
    expect(validateProblemSpace(broken, gold).join('\n')).toContain('未声明的节点 "no-such-node"')
  })

  it('节点没有观测面即失败', () => {
    const broken = cloneSpace()
    broken.nodes['unobservable'] = {
      id: 'unobservable', domain: 'search', label: '无观测面', observable: '无法观测', dependsOn: [],
    }
    expect(validateProblemSpace(broken, gold).join('\n')).toContain('"unobservable" 没有任何 rubric 维度映射')
  })

  it('先决关系成环即失败', () => {
    const broken = cloneSpace()
    nodeOf(broken, 'prior-art-search').dependsOn = ['conclusion-and-statute']
    expect(validateProblemSpace(broken, gold).join('\n')).toContain('先决关系成环')
    expect(findCycles(broken).length).toBeGreaterThan(0)
  })

  it('rubric 满分合计不为 100 即失败', () => {
    const shrunken = gold.map(goldCase => goldCase.caseId === 'oa-answer'
      ? { ...goldCase, rubric: goldCase.rubric.replace('(28 分)', '(20 分)') }
      : goldCase)
    expect(validateProblemSpace(space, shrunken).join('\n')).toContain('映射权重合计 28,rubric 满分为 20')
  })

  it('检索环境只能在 none/oracle/simulation 中取值', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patent-oas-space-'))
    scratchDirs.push(dir)
    const path = join(dir, 'problem-space.yaml')
    writeFileSync(path, readFileSync(problemSpacePath, 'utf8').replace('retrieval: oracle', 'retrieval: unknown'), 'utf8')
    await expect(loadProblemSpace(path)).rejects.toThrow('必须是 none、oracle 或 simulation')
  })

  it('工作流交付物声明必须与 workflow 成对出现,文件名主干与阶段受限', async () => {
    const text = readFileSync(problemSpacePath, 'utf8')
    const seed = (content: string): string => {
      const dir = mkdtempSync(join(tmpdir(), 'patent-oas-space-'))
      scratchDirs.push(dir)
      const path = join(dir, 'problem-space.yaml')
      writeFileSync(path, content, 'utf8')
      return path
    }
    const deliverable = '    workflowDeliverable:\n      artifact: oa-response\n      stages: [draft]\n'
    await expect(loadProblemSpace(seed(text.replace(deliverable, ''))))
      .rejects.toThrow('必须给出 workflowDeliverable')
    await expect(loadProblemSpace(seed(text.replace('artifact: oa-response', 'artifact: OA Response'))))
      .rejects.toThrow('文件名主干只能是小写字母、数字与连字符')
    await expect(loadProblemSpace(seed(text.replace('stages: [draft]', 'stages: []'))))
      .rejects.toThrow('必须是非空阶段 id 数组')
    await expect(loadProblemSpace(seed(text.replace('stages: [draft]', 'stages: [draft, draft]'))))
      .rejects.toThrow('重复列出阶段')
    await expect(loadProblemSpace(seed(text.replace('stages: [draft]', 'stages: [draft, 3]'))))
      .rejects.toThrow('必须是非空阶段 id')
    await expect(loadProblemSpace(seed(text.replace('    workflow: patent_oa_response_v1\n', ''))))
      .rejects.toThrow('没有声明 workflow 的 case 不得给出 workflowDeliverable')
  })
})

describe('金标摘要', () => {
  it('任一 statement 或 rubric 改动都会改变摘要', () => {
    const digest = goldDigest(gold)
    const changedStatement = gold.map(entry => entry.caseId === 'oa-answer' ? { ...entry, statement: `${entry.statement} ` } : entry)
    const changedRubric = gold.map(entry => entry.caseId === 'oa-answer' ? { ...entry, rubric: `${entry.rubric} ` } : entry)
    expect(goldDigest(changedStatement)).not.toBe(digest)
    expect(goldDigest(changedRubric)).not.toBe(digest)
    expect(goldDigest([...gold].reverse())).toBe(digest)
  })

  it('新增后续轮次会改变摘要,单轮 case 的摘要不受影响', () => {
    const digest = goldDigest(gold)
    const multi = goldDigest(multiroundGold())
    expect(multi).not.toBe(digest)
    const single = gold.filter(entry => entry.caseId !== 'oa-answer')
    const singleMulti = multiroundGold().filter(entry => entry.caseId !== 'oa-answer')
    expect(goldDigest(singleMulti)).toBe(goldDigest(single))
  })

  it('后续轮次的数组顺序不影响摘要', () => {
    const rounds = [
      { round: 2, statement: '第 2 轮审查意见' },
      { round: 3, statement: '第 3 轮审查意见' },
    ]
    const ordered = gold.map(entry => entry.caseId === 'oa-answer' ? { ...entry, rounds } : entry)
    const reversed = gold.map(entry => entry.caseId === 'oa-answer' ? { ...entry, rounds: [...rounds].reverse() } : entry)
    expect(goldDigest(reversed)).toBe(goldDigest(ordered))
  })
})

describe('多轮金标布局', () => {
  it('读取 rounds/02/statement 作为第 2 轮审查意见', async () => {
    const dir = writeGoldTree('multi', {
      statement: '第 1 轮任务',
      rubric: first(gold).rubric,
      'rounds/02/statement': SECOND_ROUND_STATEMENT,
    })
    const cases = await loadGold(dir)
    expect(cases).toHaveLength(1)
    expect(first(cases).rounds).toEqual([{ round: 2, statement: SECOND_ROUND_STATEMENT }])
  })

  it('轮次目录不是 02 即拒绝', async () => {
    const dir = writeGoldTree('multi', {
      statement: '第 1 轮任务',
      rubric: first(gold).rubric,
      'rounds/03/statement': '第 3 轮审查意见',
    })
    await expect(loadGold(dir)).rejects.toThrow('只允许 rounds/02')
  })

  it('rounds 下夹带文件即拒绝', async () => {
    const dir = writeGoldTree('multi', {
      statement: '第 1 轮任务',
      rubric: first(gold).rubric,
      'rounds/README.md': '草稿',
      'rounds/02/statement': SECOND_ROUND_STATEMENT,
    })
    await expect(loadGold(dir)).rejects.toThrow('只能包含轮次目录')
  })

  it('第 2 轮目录缺少 statement 或夹带其它内容即拒绝', async () => {
    const missing = writeGoldTree('multi', {
      statement: '第 1 轮任务',
      rubric: first(gold).rubric,
      'rounds/02/rubric': '多余',
    })
    await expect(loadGold(missing)).rejects.toThrow('目录必须恰好含 statement')
    const stray = writeGoldTree('multi', {
      statement: '第 1 轮任务',
      rubric: first(gold).rubric,
      'rounds/02/statement': SECOND_ROUND_STATEMENT,
      'rounds/02/notes.md': '多余',
    })
    await expect(loadGold(stray)).rejects.toThrow('目录必须恰好含 statement')
  })

  it('第 2 轮审查意见为空即拒绝', async () => {
    const dir = writeGoldTree('multi', {
      statement: '第 1 轮任务',
      rubric: first(gold).rubric,
      'rounds/02/statement': '  \n',
    })
    await expect(loadGold(dir)).rejects.toThrow('不得为空')
  })
})

describe('门槛策略', () => {
  it('当前策略可满足,且已记录的金标摘要与金标相符', () => {
    expect(validateGateConfig(config, space, gold, [])).toEqual([])
    expect(config.goldDigest).toBe(goldDigest(gold))
  })

  it('金标摘要过期即失败', () => {
    const stale: GateConfig = { ...config, goldDigest: 'sha256:stale' }
    expect(validateGateConfig(stale, space, gold, []).join('\n')).toContain('goldDigest 与当前金标不符')
  })

  it('未记录金标摘要即失败', () => {
    const missing: GateConfig = { ...config, goldDigest: null }
    expect(validateGateConfig(missing, space, gold, []).join('\n')).toContain('未记录 goldDigest')
  })

  it('门槛取值越界或为负即失败', () => {
    const outOfRange: GateConfig = {
      ...config,
      thresholds: { ...config.thresholds, node: { minScore: 120, maxDrop: -1 } },
    }
    const problems = validateGateConfig(outOfRange, space, gold, []).join('\n')
    expect(problems).toContain('thresholds.node.minScore 120 超出 0–100')
    expect(problems).toContain('thresholds.node.maxDrop -1 不能为负')
  })

  it('逐节点覆盖指向不存在的节点即失败', () => {
    const typo: GateConfig = {
      ...config,
      thresholds: { ...config.thresholds, nodes: { 'distinguishing-feature': { minScore: 75 } } },
    }
    expect(validateGateConfig(typo, space, gold, []).join('\n')).toContain('不存在的节点 "distinguishing-feature"')
  })

  it('基线自身低于门槛即失败', () => {
    const weak = declared(recordFrom(gold, () => 40), 'weak-baseline')
    const problems = validateGateConfig(config, space, gold, [weak]).join('\n')
    expect(problems).toContain('门槛不可能被满足')
  })

  it('基线记录的被测面与声明不符即失败', () => {
    const workflow = recordFrom(gold, () => 90)
    workflow.execution = 'workflow'
    workflow.workflowId = 'patent_oa_response_v1'
    const problems = validateGateConfig(config, space, gold, [declared(workflow, 'prompt-baseline.json')]).join('\n')
    expect(problems).toContain('基线记录与被测面串了')
  })

  it('baselines 缺失、越界或重复声明即失败', async () => {
    await expect(loadGateConfig(writeGate({ benchmarkId: 'patent-oas', thresholds: currentThresholds() })))
      .rejects.toThrow('baselines 必须是非空数组')
    await expect(loadGateConfig(writeGate({
      benchmarkId: 'patent-oas',
      baselines: [{ execution: 'workflow', path: 'x.json' }],
      thresholds: currentThresholds(),
    }))).rejects.toThrow('execution 为 workflow 时必须声明 workflowId')
    await expect(loadGateConfig(writeGate({
      benchmarkId: 'patent-oas',
      baselines: [{ execution: 'prompt', workflowId: 'patent_oa_response_v1', path: 'x.json' }],
      thresholds: currentThresholds(),
    }))).rejects.toThrow('execution 为 prompt 时不得声明 workflowId')
    await expect(loadGateConfig(writeGate({
      benchmarkId: 'patent-oas',
      baselines: [
        { execution: 'prompt', path: 'a.json' },
        { execution: 'prompt', path: 'b.json' },
      ],
      thresholds: currentThresholds(),
    }))).rejects.toThrow('重复声明被测面 prompt')
  })

  it('每条声明的被测面就是它自己的基线', () => {
    expect(config.baselines).toEqual([
      { execution: 'prompt', path: 'packages/self-evolve/evaluation/patent-oas-baseline.json' },
      {
        execution: 'workflow',
        workflowId: 'patent_oa_response_v1',
        path: 'packages/self-evolve/evaluation/patent-oas-workflow-baseline.json',
      },
      {
        execution: 'workflow',
        workflowId: 'patent_disclosure_v1',
        path: 'packages/self-evolve/evaluation/patent-oas-disclosure-workflow-baseline.json',
      },
    ])
  })
})

describe('run 记录校验', () => {
  it('维度名与 rubric 不符即失败', () => {
    const tampered = recordFrom(gold, () => 90)
    const target = tampered.cases.find(entry => entry.caseId === 'oa-answer')
    expect(target).toBeDefined()
    if (target !== undefined) first(target.dimensions).label = '自己编的维度'
    expect(validateRunRecord(tampered, space, gold, 'run.json').join('\n')).toContain('rubric 为「区别特征认定」')
  })

  it('满分与 rubric 不符即失败', () => {
    const tampered = recordFrom(gold, () => 90)
    const target = tampered.cases.find(entry => entry.caseId === 'oa-answer')
    expect(target).toBeDefined()
    if (target !== undefined) first(target.dimensions).points = 99
    expect(validateRunRecord(tampered, space, gold, 'run.json').join('\n')).toContain('满分 99,rubric 为 28')
  })

  it('缺少某个 case 的观测即失败', () => {
    const partial = recordFrom(gold, () => 90)
    partial.cases = partial.cases.filter(entry => entry.caseId !== 'claim-drafting')
    expect(validateRunRecord(partial, space, gold, 'run.json').join('\n')).toContain('缺少 case "claim-drafting" 的观测')
  })

  it('分数越界即失败', () => {
    const outOfRange = recordFrom(gold, (caseId, index) => caseId === 'oa-answer' && index === 1 ? 120 : 90)
    expect(validateRunRecord(outOfRange, space, gold, 'run.json').join('\n')).toContain('超出 0–100')
  })

  it('逐次分数与均值一致即通过,旧记录没有该字段也通过', () => {
    expect(validateRunRecord(recordWithScores([70, 80]), space, gold, 'run.json')).toEqual([])
    expect(validateRunRecord(recordFrom(gold, () => 90), space, gold, 'run.json')).toEqual([])
  })

  it('逐次分数个数与 runsPerCase 不符即失败', () => {
    const record = recordWithScores([70, 80])
    first(first(record.cases).dimensions).scores = [75]
    expect(validateRunRecord(record, space, gold, 'run.json').join('\n')).toContain('有 1 个逐次分数,应为 2')
  })

  it('逐次分数越界即失败', () => {
    const record = recordWithScores([70, 80])
    first(first(record.cases).dimensions).scores = [70, 120]
    expect(validateRunRecord(record, space, gold, 'run.json').join('\n')).toContain('第 2 次分数 120 超出 0–100')
  })

  it('score 与逐次均值不一致即失败', () => {
    const record = recordWithScores([70, 80])
    first(first(record.cases).dimensions).score = 90
    expect(validateRunRecord(record, space, gold, 'run.json').join('\n')).toContain('与逐次分数均值 75 不一致')
  })

  it('记录的检索环境与问题空间声明不符即失败', () => {
    const record = recordFrom(gold, () => 90)
    const target = record.cases.find(entry => entry.caseId === 'oa-answer')
    expect(target).toBeDefined()
    if (target !== undefined) target.retrieval = 'simulation'
    expect(validateRunRecord(record, space, gold, 'run.json').join('\n'))
      .toContain('记录检索环境 simulation,问题空间声明 oracle')
  })

  it('旧记录没有检索环境时仍通过结构校验', () => {
    const record = recordFrom(gold, () => 90)
    for (const runCase of record.cases) delete runCase.retrieval
    expect(validateRunRecord(record, space, gold, 'run.json')).toEqual([])
  })
})

describe('检索设置的可比性', () => {
  it('同设置可比较,跨设置被拒绝', () => {
    const baseline = recordFrom(gold, () => 90)
    expect(comparisonSettingProblems(baseline, baseline, 'run.json')).toEqual([])
    const oracle = structuredClone(baseline)
    const target = oracle.cases.find(entry => entry.caseId === 'oa-answer')
    expect(target).toBeDefined()
    if (target !== undefined) target.retrieval = 'simulation'
    expect(comparisonSettingProblems(oracle, baseline, 'run.json').join('\n'))
      .toContain('case "oa-answer" 的检索环境为 simulation,基线为 oracle')
  })

  it('未记录检索环境的记录不与已声明基线比较', () => {
    const baseline = recordFrom(gold, () => 90)
    const legacy = structuredClone(baseline)
    for (const runCase of legacy.cases) delete runCase.retrieval
    expect(comparisonSettingProblems(legacy, baseline, 'run.json').join('\n'))
      .toContain('检索环境为 未记录,基线为 oracle')
    const legacyBaseline = structuredClone(legacy)
    expect(comparisonSettingProblems(legacy, legacyBaseline, 'run.json')).toEqual([])
  })
})

describe('被测面的可比性', () => {
  const oaAnswer = gold.filter(entry => entry.caseId === 'oa-answer')

  /** 只含 oa-answer 的问题空间:工作流设置目前只有这一个 case 声明了 manifest。 */
  function oaSpace(): ProblemSpace {
    const narrowed = cloneSpace()
    narrowed.cases = { 'oa-answer': mappingOf(narrowed, 'oa-answer') }
    return narrowed
  }

  /** 一条工作流设置的两轮记录:oa-answer 带 workflowId 与逐轮权项版本。 */
  function workflowRecord(runsPerCase = 1): RunRecord {
    const record = withClaimVersions(recordFrom(oaAnswer, () => 90, runsPerCase))
    record.execution = 'workflow'
    record.workflowId = 'patent_oa_response_v1'
    return record
  }

  it('被测面缺省时读作 prompt,workflow 带出 manifest', () => {
    expect(executionOf({})).toBe('prompt')
    expect(surfaceOf({ execution: 'workflow', workflowId: 'patent_oa_response_v1' })).toBe('workflow/patent_oa_response_v1')
    expect(surfaceOf({})).toBe('prompt')
  })

  it('工作流记录带 workflowId 与逐轮权项版本即通过', () => {
    expect(validateRunRecord(workflowRecord(), oaSpace(), oaAnswer, 'run.json')).toEqual([])
  })

  it('提示词记录与旧记录仍通过同一校验', () => {
    expect(validateRunRecord(recordFrom(gold, () => 90), space, gold, 'run.json')).toEqual([])
    const legacy = recordFrom(gold, () => 90)
    delete legacy.execution
    expect(validateRunRecord(legacy, space, gold, 'run.json')).toEqual([])
  })

  it('工作流记录缺 workflowId 或逐轮权项版本即失败', () => {
    const missingManifest = workflowRecord()
    delete missingManifest.workflowId
    expect(validateRunRecord(missingManifest, oaSpace(), oaAnswer, 'run.json').join('\n'))
      .toContain('workflow 设置必须记录 workflowId')
    const missingVersions = workflowRecord()
    for (const round of roundsOf(missingVersions)) delete round.claimVersions
    expect(validateRunRecord(missingVersions, oaSpace(), oaAnswer, 'run.json').join('\n'))
      .toContain('缺少 claimVersions')
  })

  it('提示词记录不该带权项版本,prompt 记录不该带 manifest', () => {
    const record = recordFrom(oaAnswer, () => 90)
    for (const round of roundsOf(record)) round.claimVersions = [1]
    expect(validateRunRecord(record, oaSpace(), oaAnswer, 'run.json').join('\n'))
      .toContain('权项版本只由工作流设置的审计日志复算')
    const withManifest: RunRecord = { ...recordFrom(oaAnswer, () => 90), workflowId: 'patent_oa_response_v1' }
    expect(validateRunRecord(withManifest, oaSpace(), oaAnswer, 'run.json').join('\n'))
      .toContain('prompt 设置记录了 workflowId')
  })

  it('权项版本个数、取值与逐轮前进都受检', () => {
    const short = workflowRecord(2)
    first(roundsOf(short)).claimVersions = [1]
    expect(validateRunRecord(short, oaSpace(), oaAnswer, 'run.json').join('\n')).toContain('个权项版本,应为 2')
    const zero = workflowRecord()
    first(roundsOf(zero)).claimVersions = [0]
    expect(validateRunRecord(zero, oaSpace(), oaAnswer, 'run.json').join('\n')).toContain('必须是 1 起的整数')
    const stuck = workflowRecord()
    const rounds = roundsOf(stuck)
    if (rounds[1] === undefined) throw new Error('fixture: 缺少第 2 轮观测')
    rounds[1].claimVersions = [1]
    expect(validateRunRecord(stuck, oaSpace(), oaAnswer, 'run.json').join('\n')).toContain('修订链未前进')
  })

  it('manifest 与问题空间声明不符即失败', () => {
    const record = workflowRecord()
    record.workflowId = 'patent_infringement_v1'
    expect(validateRunRecord(record, oaSpace(), oaAnswer, 'run.json').join('\n'))
      .toContain('问题空间为它声明的工作流是 patent_oa_response_v1')
    const outside = withClaimVersions(recordFrom(oaAnswer, () => 90))
    outside.execution = 'workflow'
    outside.workflowId = 'patent_oa_response_v1'
    const unowned = cloneSpace()
    delete mappingOf(unowned, 'oa-answer').workflow
    expect(validateRunRecord(outside, unowned, oaAnswer, 'run.json').join('\n'))
      .toContain('按 manifest "patent_oa_response_v1" 采集')
  })

  it('跨被测面拒绝比对,同一被测面放行', () => {
    const prompt = recordFrom(gold, () => 90)
    const workflow = workflowRecord()
    expect(comparisonSettingProblems(structuredClone(workflow), workflow, 'run.json')).toEqual([])
    expect(comparisonSettingProblems({ ...workflow, cases: [...prompt.cases] }, prompt, 'run.json').join('\n'))
      .toContain('被测面为 workflow/patent_oa_response_v1,基线为 prompt')
    const otherManifest = structuredClone(workflow)
    otherManifest.workflowId = 'patent_infringement_v1'
    expect(comparisonSettingProblems(otherManifest, workflow, 'run.json').join('\n'))
      .toContain('基线为 workflow/patent_oa_response_v1')
  })

  it('旧记录与提示词基线仍可比:省略的被测面读作 prompt', () => {
    const baseline = recordFrom(gold, () => 90)
    const explicit: RunRecord = { ...structuredClone(baseline), execution: 'prompt' }
    expect(comparisonSettingProblems(explicit, baseline, 'run.json')).toEqual([])
  })

  it('基线按记录自己的被测面路由', () => {
    const declaredPrompt = first(config.baselines)
    const declaredWorkflow = first(config.baselines.filter(entry => entry.execution === 'workflow'))
    expect(findBaselineDeclaration(config, 'prompt')).toBe(declaredPrompt)
    expect(baselineDeclarationFor(config, recordFrom(gold, () => 90))).toBe(declaredPrompt)
    expect(findBaselineDeclaration(config, 'workflow', 'patent_oa_response_v1')).toBe(declaredWorkflow)
    expect(baselineDeclarationFor(config, workflowRecord())).toBe(declaredWorkflow)
    expect(findBaselineDeclaration(config, 'workflow', 'patent_novelty_v1')).toBeUndefined()
    const promptOnly: GateConfig = { ...config, baselines: [declaredPrompt] }
    expect(baselineDeclarationFor(promptOnly, workflowRecord())).toBeUndefined()
  })

  it('记录的被测面与权项版本随文件往返,越界取值被读侧拒绝', async () => {
    const loaded = await loadRunRecord(writeRecord(workflowRecord()))
    expect(loaded.execution).toBe('workflow')
    expect(loaded.workflowId).toBe('patent_oa_response_v1')
    expect(roundsOf(loaded)[0]?.claimVersions).toEqual([1])
    await expect(loadRunRecord(writeRawRecord({ ...workflowRecord(), execution: 'preset' })))
      .rejects.toThrow('字段 "execution" 必须是 prompt 或 workflow')
    await expect(loadRunRecord(writeRawRecord({
      benchmarkId: 'patent-oas',
      recordedAt: '2026-10-25T00:00:00.000Z',
      runsPerCase: 1,
      cases: [{
        caseId: 'oa-answer',
        dimensions: [],
        rounds: [{ round: 1, dimensions: [], deliverableDigests: [], claimVersions: ['v1'] }],
      }],
    }))).rejects.toThrow('字段 "claimVersions[0]" 必须是有限数')
    await expect(loadRunRecord(writeRawRecord({
      benchmarkId: 'patent-oas',
      recordedAt: '2026-10-25T00:00:00.000Z',
      runsPerCase: 1,
      cases: [{
        caseId: 'oa-answer',
        dimensions: [],
        rounds: [{ round: 1, dimensions: [], deliverableDigests: [], claimVersions: 'v1' }],
      }],
    }))).rejects.toThrow('字段 "claimVersions" 必须是数组')
  })

  it('问题空间的 workflow 声明只能是非空字符串', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'patent-oas-space-'))
    scratchDirs.push(dir)
    const path = join(dir, 'problem-space.yaml')
    writeFileSync(path, readFileSync(problemSpacePath, 'utf8').replace('workflow: patent_oa_response_v1', 'workflow: ""'), 'utf8')
    await expect(loadProblemSpace(path)).rejects.toThrow('字段 "workflow" 不能是空串')
  })

  it('未声明被测面的记录不能被提升为基线', () => {
    const record = recordFrom(gold, () => 90)
    delete record.execution
    const result = runGate('--accept', writeRecord(record))
    expect(result.status, String(result.stderr)).toBe(1)
    expect(String(result.stderr)).toContain('未记录被测面(execution),不能落为基线')
  })

  it('篇幅观测只验自洽:超预算字数必须能由字数与预算复算', async () => {
    const record = recordFrom(gold, () => 90)
    const rounds = roundsOf(record)
    const roundNumber = rounds.length
    const terminal = rounds.at(-1)
    if (terminal === undefined) throw new Error('fixture: 缺少终局轮')
    const observation = {
      proseChars: 4310,
      budget: 4000,
      overBudget: 310,
      paragraphs: 12,
      sections: 5,
      emptySections: 0,
      repeatedSentences: 2,
    }
    terminal.concision = [observation]
    expect(validateRunRecord(record, space, gold, 'run.json')).toEqual([])
    expect(roundsOf(await loadRunRecord(writeRecord(record))).at(-1)?.concision).toEqual([observation])

    terminal.concision = [{ ...observation, overBudget: 300 }]
    expect(validateRunRecord(record, space, gold, 'run.json').join('\n'))
      .toContain(`第 ${roundNumber} 轮第 1 次运行的篇幅观测的 overBudget 为 300,按字数 4310 与预算 4000 应为 310`)

    terminal.concision = [observation, observation]
    expect(validateRunRecord(record, space, gold, 'run.json').join('\n'))
      .toContain(`第 ${roundNumber} 轮有 2 条篇幅观测,应为 1`)

    terminal.concision = [{ proseChars: 100, budget: 4000, paragraphs: 1, sections: 1, emptySections: 0, repeatedSentences: 0 }]
    expect(validateRunRecord(record, space, gold, 'run.json').join('\n'))
      .toContain('只记了 budget 与 overBudget 之一')

    terminal.concision = [{ ...observation, paragraphs: -1 }]
    expect(validateRunRecord(record, space, gold, 'run.json').join('\n'))
      .toContain('的 paragraphs 必须是非负整数,得到 -1')
  })

  it('篇幅观测按轮次归属:单轮 case 记在 case 上,多轮 case 不许记在 case 上', () => {
    const record = recordFrom(gold, () => 90)
    const single = record.cases.find(entry => entry.caseId === 'claim-drafting')
    if (single === undefined) throw new Error('fixture: 缺少 claim-drafting')
    single.concision = [{
      proseChars: 1200,
      paragraphs: 4,
      sections: 2,
      emptySections: 0,
      repeatedSentences: 0,
    }]
    expect(validateRunRecord(record, space, gold, 'run.json')).toEqual([])

    const multiround = record.cases.find(entry => entry.caseId === 'oa-answer')
    if (multiround === undefined) throw new Error('fixture: 缺少 oa-answer')
    multiround.concision = [...single.concision]
    expect(validateRunRecord(record, space, gold, 'run.json').join('\n'))
      .toContain('case "oa-answer" 是多轮 case,篇幅观测记在逐轮观测里,不在 case 上')

    const flat = { paragraphs: 4, sections: 2, emptySections: 0, repeatedSentences: 0 }
    single.concision = [{ ...flat, proseChars: 1200 }, { ...flat, proseChars: 1300 }]
    expect(validateRunRecord(record, space, gold, 'run.json').join('\n'))
      .toContain('case "claim-drafting" 有 2 条篇幅观测,应为 1')
  })

  it('篇幅观测的结构错误在读侧就拒绝,不留到校验层', async () => {
    const base = {
      benchmarkId: 'patent-oas',
      recordedAt: '2026-10-25T00:00:00.000Z',
      runsPerCase: 1,
      cases: [{ caseId: 'oa-answer', dimensions: [], rounds: [{ round: 1, dimensions: [], deliverableDigests: [], concision: 'x' }] }],
    }
    await expect(loadRunRecord(writeRawRecord(base))).rejects.toThrow('rounds[0].concision: 必须是数组')
    const missingField = structuredClone(base)
    const round = missingField.cases[0]?.rounds[0] as Record<string, unknown> | undefined
    if (round === undefined) throw new Error('fixture: 缺少逐轮观测')
    round.concision = [{ proseChars: 100, paragraphs: 1, sections: 1, emptySections: 0 }]
    await expect(loadRunRecord(writeRawRecord(missingField))).rejects.toThrow('字段 "repeatedSentences" 必须是有限数')
  })

  it('没有在 gate.yaml 声明基线的被测面不能落盘,并给出要追加的条目', () => {
    const promptOnly: GateConfig = { ...config, baselines: [first(config.baselines)] }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(acceptTarget(promptOnly, workflowRecord())).toBeUndefined()
    const printed = error.mock.calls.flat().join('\n')
    expect(printed).toContain('baselines 没有声明被测面 workflow/patent_oa_response_v1 的基线')
    expect(printed).toContain('"workflowId":"patent_oa_response_v1"')
    error.mockRestore()
  })

  it('已声明的基线路径都在仓库内且文件已落盘', () => {
    for (const declaration of config.baselines) {
      expect(isOutsideRoot(root, declaration.path), declaration.path).toBe(false)
      expect(existsSync(resolve(root, declaration.path)), declaration.path).toBe(true)
    }
  })
})

describe('逐被测面的评分范围', () => {
  const exempt = ['prior-art-search', 'deliverable-format']

  /** 一条只豁免工作流面两个检索相关节点的评分范围。 */
  const workflowPolicy: SurfacePolicy = {
    execution: 'workflow',
    workflowId: 'patent_oa_response_v1',
    notAssessedNodes: [...exempt],
  }

  /** 第 5 维(检索策略与答复格式)只拿 45 分、其余维度 90 分的工作流记录。 */
  function weakSearchRecord(): RunRecord {
    const record = withClaimVersions(
      recordFrom(gold.filter(entry => entry.caseId === 'oa-answer'), (_caseId, index) => index === 5 ? 45 : 90),
    )
    record.execution = 'workflow'
    record.workflowId = 'patent_oa_response_v1'
    return record
  }

  it('评分范围按被测面命中,提示词面不受影响', () => {
    // 仓库策略当前不豁免任何节点:答复清单的 generate_keywords 阶段让交付物带得出检索策略。
    expect(config.surfaces).toEqual([])
    const scoped: GateConfig = { ...config, surfaces: [workflowPolicy] }
    expect(notAssessedNodesOf(scoped, weakSearchRecord())).toEqual(exempt)
    expect(notAssessedNodesOf(scoped, { execution: 'prompt' })).toEqual([])
    expect(notAssessedNodesOf(config, weakSearchRecord())).toEqual([])
  })

  it('不评的节点从节点、case 与聚合三层一并退出', () => {
    const scoped = evaluateRun(space, { ...config, surfaces: [workflowPolicy] }, weakSearchRecord(), undefined)
    const unscoped = evaluateRun(space, { ...config, surfaces: [] }, weakSearchRecord(), undefined)
    expect(unscoped.cases.map(entry => entry.score)).toEqual([84.15])
    expect(unscoped.nodes.filter(entry => exempt.includes(entry.id)).map(entry => entry.verdict))
      .toEqual(['below-floor', 'below-floor'])
    expect(scoped.cases.map(entry => entry.score)).toEqual([90])
    expect(scoped.aggregateScore).toBe(90)
    expect(scoped.aggregateVerdict).toBe('pass')
    expect(scoped.nodes.map(entry => entry.id)).not.toContain('prior-art-search')
    expect(scoped.notAssessed).toEqual(['deliverable-format', 'prior-art-search'])
    expect(scoped.cases[0]?.rounds?.map(entry => entry.score)).toEqual([90, 90])
  })

  it('判定输出把豁免说出来,读数口径不留暗账', () => {
    const scoped = evaluateRun(space, { ...config, surfaces: [workflowPolicy] }, weakSearchRecord(), undefined)
    expect(formatVerdict(scoped)).toContain('[not-assessed] deliverable-format、prior-art-search')
    expect(formatVerdict(evaluateRun(space, { ...config, surfaces: [] }, weakSearchRecord(), undefined)))
      .not.toContain('not-assessed')
  })

  it('基线自身的可满足性也走同一豁免,换面就不豁免', () => {
    const scopedConfig: GateConfig = { ...config, surfaces: [workflowPolicy] }
    const declaration: BaselineDeclaration = {
      execution: 'workflow',
      workflowId: 'patent_oa_response_v1',
      path: 'packages/self-evolve/evaluation/patent-oas-workflow-baseline.json',
    }
    expect(validateGateConfig(scopedConfig, space, gold, [{ declaration, label: 'workflow-baseline.json', record: weakSearchRecord() }]))
      .toEqual([])
    const asPrompt: RunRecord = { ...weakSearchRecord(), execution: 'prompt' }
    delete asPrompt.workflowId
    expect(validateGateConfig(scopedConfig, space, gold, [{ declaration: first(config.baselines), label: 'prompt-baseline.json', record: asPrompt }]).join('\n'))
      .toContain('自身在 "prior-art-search" 上 below-floor')
  })

  it('评分范围配置的非法取值在加载时拒绝', async () => {
    const base = {
      benchmarkId: 'patent-oas',
      goldDigest: config.goldDigest,
      baselines: config.baselines,
      thresholds: currentThresholds(),
    }
    await expect(loadGateConfig(writeGate({ ...base, surfaces: 'x' }))).rejects.toThrow('surfaces 必须是数组')
    await expect(loadGateConfig(writeGate({ ...base, surfaces: [{ execution: 'prompt', workflowId: 'patent_oa_response_v1', notAssessedNodes: exempt }] })))
      .rejects.toThrow('execution 为 prompt 时不得声明 workflowId')
    await expect(loadGateConfig(writeGate({ ...base, surfaces: [{ execution: 'workflow', notAssessedNodes: exempt }] })))
      .rejects.toThrow('execution 为 workflow 时必须声明 workflowId')
    await expect(loadGateConfig(writeGate({ ...base, surfaces: [{ execution: 'prompt', notAssessedNodes: [] }] })))
      .rejects.toThrow('notAssessedNodes 必须是非空数组')
    await expect(loadGateConfig(writeGate({ ...base, surfaces: [{ execution: 'prompt', notAssessedNodes: ['  '] }] })))
      .rejects.toThrow('必须是非空字符串')
    await expect(loadGateConfig(writeGate({ ...base, surfaces: [{ execution: 'prompt', notAssessedNodes: ['parse', 'parse'] }] })))
      .rejects.toThrow('重复列出节点 parse')
    await expect(loadGateConfig(writeGate({
      ...base,
      surfaces: [{ execution: 'prompt', notAssessedNodes: exempt }, { execution: 'prompt', notAssessedNodes: ['parse'] }],
    }))).rejects.toThrow('surfaces 重复声明被测面 prompt')
    expect((await loadGateConfig(writeGate(base))).surfaces).toEqual([])
  })

  it('豁免指向该面没有的节点、或把该面清空时门禁报出', () => {
    const otherManifest: GateConfig = {
      ...config,
      surfaces: [{ execution: 'workflow', workflowId: 'patent_novelty_v1', notAssessedNodes: exempt }],
    }
    expect(validateGateConfig(otherManifest, space, gold, []).join('\n')).toContain('没有问题空间里可采的 case')
    const dangling: GateConfig = {
      ...config,
      surfaces: [{ execution: 'workflow', workflowId: 'patent_oa_response_v1', notAssessedNodes: ['nope'] }],
    }
    const problems = validateGateConfig(dangling, space, gold, []).join('\n')
    expect(problems).toContain('指向不存在的节点 "nope"')
    expect(problems).toContain('这条豁免不改变任何读数')
    const everything = Object.values(mappingOf(space, 'oa-answer').dimensions)
      .flatMap(entry => Object.keys(entry.nodes))
    const cleared: GateConfig = {
      ...config,
      surfaces: [{ execution: 'workflow', workflowId: 'patent_oa_response_v1', notAssessedNodes: everything }],
    }
    expect(validateGateConfig(cleared, space, gold, []).join('\n')).toContain('豁免了该面全部可评节点')
  })
})

describe('多轮记录校验', () => {
  const multi = multiroundGold()

  it('两轮观测且终局与第 2 轮一致即通过', () => {
    const record = withRounds(recordFrom(multi, () => 90), 60)
    expect(validateRunRecord(record, space, multi, 'run.json')).toEqual([])
  })

  it('多轮 case 缺少逐轮观测即失败', () => {
    const record = recordFrom(multi, () => 90)
    const target = record.cases.find(entry => entry.caseId === 'oa-answer')
    if (target === undefined) throw new Error('fixture: 缺少 oa-answer')
    delete target.rounds
    expect(validateRunRecord(record, space, multi, 'run.json').join('\n')).toContain('是多轮 case,记录缺少逐轮观测')
  })

  it('单轮 case 带逐轮观测即失败', () => {
    const single = singleRoundGold()
    const record = recordFrom(single, () => 90)
    const target = first(record.cases)
    target.rounds = [{
      round: 1,
      dimensions: target.dimensions.map(dimension => ({ index: dimension.index, score: 90 })),
      deliverableDigests: [textDigest('round-1')],
    }]
    expect(validateRunRecord(record, space, gold, 'run.json').join('\n')).toContain('是单轮 case,记录不应带逐轮观测')
  })

  it('轮次数与金标不符即失败', () => {
    const record = withRounds(recordFrom(multi, () => 90), 60)
    roundsOf(record).splice(1)
    expect(validateRunRecord(record, space, multi, 'run.json').join('\n')).toContain('有 1 轮观测,应为 2 轮')
  })

  it('终局维度分数与第 2 轮不一致即失败', () => {
    const record = withRounds(recordFrom(multi, () => 90), 60)
    const second = roundsOf(record)[1]
    if (second === undefined) throw new Error('fixture: 缺少第 2 轮')
    first(second.dimensions).score = 70
    expect(validateRunRecord(record, space, multi, 'run.json').join('\n')).toContain('与终局分数 90 不一致')
  })

  it('审查意见摘要格式非法即失败', () => {
    const record = withRounds(recordFrom(multi, () => 90), 60)
    const second = roundsOf(record)[1]
    if (second === undefined) throw new Error('fixture: 缺少第 2 轮')
    second.statementDigest = 'not-a-digest'
    expect(validateRunRecord(record, space, multi, 'run.json').join('\n')).toContain('不是 sha256:<hex>')
  })

  it('首轮带摘要或第 2 轮缺摘要即失败', () => {
    const withDigest = withRounds(recordFrom(multi, () => 90), 60)
    const firstRound = roundsOf(withDigest)[0]
    if (firstRound === undefined) throw new Error('fixture: 缺少第 1 轮')
    firstRound.statementDigest = textDigest('x')
    expect(validateRunRecord(withDigest, space, multi, 'run.json').join('\n')).toContain('是首轮,不应带 statementDigest')

    const missing = withRounds(recordFrom(multi, () => 90), 60)
    const second = roundsOf(missing)[1]
    if (second === undefined) throw new Error('fixture: 缺少第 2 轮')
    delete second.statementDigest
    expect(validateRunRecord(missing, space, multi, 'run.json').join('\n')).toContain('缺少 statementDigest')
  })

  it('审查意见摘要与金标不符即失败', () => {
    const record = withRounds(recordFrom(multi, () => 90), 60)
    const second = roundsOf(record)[1]
    if (second === undefined) throw new Error('fixture: 缺少第 2 轮')
    second.statementDigest = textDigest('另一份审查意见')
    expect(validateRunRecord(record, space, multi, 'run.json').join('\n')).toContain('与金标审查意见不一致')
  })

  it('金标 rounds 为空时按单轮判定', () => {
    const single = singleRoundGold()
    expect(validateRunRecord(recordFrom(single, () => 90), space, single, 'run.json')).toEqual([])
    const withEmptyRounds = recordFrom(single, () => 90)
    const target = withEmptyRounds.cases.find(entry => entry.caseId === 'oa-answer')
    if (target === undefined) throw new Error('fixture: 缺少 oa-answer')
    target.rounds = []
    expect(validateRunRecord(withEmptyRounds, space, single, 'run.json').join('\n')).toContain('是单轮 case,记录不应带逐轮观测')
  })

  it('终局逐次分数与第 2 轮不一致即失败', () => {
    const record = recordWithScores([90, 90])
    const target = record.cases.find(entry => entry.caseId === 'oa-answer')
    if (target === undefined) throw new Error('fixture: 缺少 oa-answer')
    target.rounds = [1, 2].map(round => ({
      round,
      ...round === 2 ? { statementDigest: textDigest(SECOND_ROUND_STATEMENT) } : {},
      dimensions: target.dimensions.map(dimension => ({
        index: dimension.index,
        score: round === 1 ? 60 : 90,
        scores: round === 1 ? [60, 60] : [80, 100],
      })),
      deliverableDigests: [textDigest(`round-${round}-a`), textDigest(`round-${round}-b`)],
    }))
    expect(validateRunRecord(record, space, multi, 'run.json').join('\n')).toContain('逐次分数与终局逐次分数不一致')
  })

  it('轮次观测含终局维度之外的 index 时拒绝计算总分', () => {
    const record = withRounds(recordFrom(multi, () => 90), 60)
    const second = roundsOf(record)[1]
    if (second === undefined) throw new Error('fixture: 缺少第 2 轮')
    second.dimensions.push({ index: 99, score: 90 })
    expect(() => caseRoundScores(record)).toThrow('终局维度之外的 index 99')
  })

  it('交付物摘要个数与 runsPerCase 不符即失败', () => {
    const record = withRounds(recordFrom(multi, () => 90), 60)
    const firstRound = roundsOf(record)[0]
    if (firstRound === undefined) throw new Error('fixture: 缺少第 1 轮')
    firstRound.deliverableDigests = []
    expect(validateRunRecord(record, space, multi, 'run.json').join('\n')).toContain('有 0 个交付物摘要,应为 1')
  })

  it('逐轮观测结构非法即拒绝读入', async () => {
    const base = { benchmarkId: 'patent-oas', recordedAt: '2026-10-21T00:00:00.000Z', runsPerCase: 1 }
    const rawCase = (rounds: unknown): Record<string, unknown> => ({
      ...base,
      cases: [{ caseId: 'oa-answer', dimensions: [], rounds }],
    })
    await expect(loadRunRecord(writeRawRecord(rawCase({})))).rejects.toThrow('必须是数组')
    await expect(loadRunRecord(writeRawRecord(rawCase([{ round: 2, dimensions: [], deliverableDigests: 'x' }]))))
      .rejects.toThrow('deliverableDigests 必须是数组')
    await expect(loadRunRecord(writeRawRecord(rawCase([{ round: 2, dimensions: {}, deliverableDigests: [] }]))))
      .rejects.toThrow('dimensions 必须是数组')
  })

  it('轮次观测重复或未知维度即失败', () => {
    const duplicated = withRounds(recordFrom(multi, () => 90), 60)
    const duplicatedSecond = roundsOf(duplicated)[1]
    if (duplicatedSecond === undefined) throw new Error('fixture: 缺少第 2 轮')
    const duplicatedDimension = first(duplicatedSecond.dimensions)
    duplicatedSecond.dimensions.push({ ...duplicatedDimension })
    expect(validateRunRecord(duplicated, space, multi, 'run.json').join('\n')).toContain(`重复观测维度 ${duplicatedDimension.index}`)

    const unknown = withRounds(recordFrom(multi, () => 90), 60)
    const unknownSecond = roundsOf(unknown)[1]
    if (unknownSecond === undefined) throw new Error('fixture: 缺少第 2 轮')
    unknownSecond.dimensions.push({ index: 99, score: 90 })
    expect(validateRunRecord(unknown, space, multi, 'run.json').join('\n')).toContain('观测了 rubric 中不存在的维度 99')
  })

  it('从 JSON 读回时保留逐轮观测', async () => {
    const record = withRounds(recordFrom(multi, () => 90), 60)
    const loaded = await loadRunRecord(writeRecord(record))
    expect(roundsOf(loaded)).toEqual(roundsOf(record))
    expect(validateRunRecord(loaded, space, multi, 'run.json')).toEqual([])
  })

  it('报告渲染逐轮总分,门禁仍按终局判定', () => {
    const record = withRounds(recordFrom(multi, () => 90), 60)
    const verdict = evaluateRun(space, config, record, undefined)
    const outcome = first(verdict.cases.filter(entry => entry.id === 'oa-answer'))
    expect(outcome.rounds?.map(entry => entry.score)).toEqual([60, 90])
    expect(outcome.score).toBeCloseTo(90, 10)
    expect(formatVerdict(verdict)).toContain('逐轮 R1 60.0 → R2 90.0')
  })
})

describe('逐次观测的离散度', () => {
  it('case 与节点按逐次观测给出极差与样本标准差', () => {
    const verdict = evaluateRun(space, config, recordWithScores([70, 80]), undefined)
    const caseOutcome = first(verdict.cases.filter(entry => entry.id === 'oa-answer'))
    expect(caseOutcome.spread?.min).toBeCloseTo(70, 10)
    expect(caseOutcome.spread?.max).toBeCloseTo(80, 10)
    expect(caseOutcome.spread?.stdev).toBeCloseTo(10 / Math.SQRT2, 10)
    const node = first(verdict.nodes.filter(entry => entry.id === 'distinguishing-features'))
    expect(node.spread?.min).toBeCloseTo(70, 10)
    expect(node.spread?.max).toBeCloseTo(80, 10)
  })

  it('旧记录与单次运行不产生离散度', () => {
    const verdict = evaluateRun(space, config, recordFrom(gold, () => 90), undefined)
    expect(verdict.cases.every(entry => entry.spread === undefined)).toBe(true)
    expect(verdict.nodes.every(entry => entry.spread === undefined)).toBe(true)
    const single = recordFrom(gold, () => 90)
    expect(caseScoresByRun(single).size).toBe(0)
    expect(nodeScoresByRun(space, single).size).toBe(0)
    expect(scoreSpread([70])).toBeUndefined()
  })

  it('某个维度缺逐次观测时,该 case 与相关节点都不报离散度', () => {
    const record = recordWithScores([70, 80])
    const target = first(record.cases.filter(entry => entry.caseId === 'oa-answer'))
    delete first(target.dimensions).scores
    const verdict = evaluateRun(space, config, record, undefined)
    expect(verdict.cases.find(entry => entry.id === 'oa-answer')?.spread).toBeUndefined()
    expect(verdict.cases.find(entry => entry.id === 'claim-drafting')?.spread).toBeDefined()
  })

  it('报告渲染极差与样本标准差', () => {
    const text = formatVerdict(evaluateRun(space, config, recordWithScores([70, 80]), undefined))
    expect(text).toContain('逐次 70.0–80.0 σ7.07')
  })
})

describe('噪声容限', () => {
  /** 派生一份门槛策略,按需带上或去掉噪声容限倍数。 */
  function withNoise(multiple?: number): GateConfig {
    const thresholds = { ...config.thresholds }
    delete thresholds.noiseMultiple
    return { ...config, thresholds: multiple === undefined ? thresholds : { ...thresholds, noiseMultiple: multiple } }
  }

  it('两侧都留逐次观测时,差的标准误合并本次与基线的波动', () => {
    // [70,80] 的样本标准差是 10/√2,均值标准误是 10/2 = 5;两侧相同时差的标准误是 5√2。
    expect(deltaStandardError([70, 80], [70, 80])).toBeCloseTo(5 * Math.SQRT2, 10)
  })

  it('任一侧缺逐次观测时不报标准误', () => {
    expect(deltaStandardError([70], [70, 80])).toBeUndefined()
    expect(deltaStandardError([70, 80], [90])).toBeUndefined()
    expect(deltaStandardError([], [70, 80])).toBeUndefined()
  })

  it('回退超过 maxDrop 但落在噪声内时判通过,并报出生效容限', () => {
    const baseline = recordWithScores([90, 90])
    const run = recordWithScores([76, 84])
    // 逐次标准差 5.657,两侧标准误合计 4.0,容限取 2.5 × 4.0 = 10.0。
    const tolerated = evaluateRun(space, withNoise(2.5), run, baseline)
    expect(tolerated.aggregateVerdict).toBe('pass')
    expect(verdictPassed(tolerated)).toBe(true)
    const node = first(tolerated.nodes.filter(entry => entry.id === 'claim-essential-features'))
    expect(node.delta).toBeCloseTo(-10, 10)
    expect(node.allowedDrop).toBeCloseTo(10, 10)
    expect(formatVerdict(tolerated)).toContain('容限 10.0')
  })

  it('去掉噪声容限后同一份读数判为回退', () => {
    const verdict = evaluateRun(space, withNoise(), recordWithScores([76, 84]), recordWithScores([90, 90]))
    expect(verdictPassed(verdict)).toBe(false)
    expect(first(verdict.nodes.filter(entry => entry.id === 'claim-essential-features')).verdict).toBe('regressed')
    expect(formatVerdict(verdict)).not.toContain('容限')
  })

  it('零方差拿不到额外容限,仍按 maxDrop 判定', () => {
    const verdict = evaluateRun(space, withNoise(2.5), recordWithScores([80, 80]), recordWithScores([90, 90]))
    const node = first(verdict.nodes.filter(entry => entry.id === 'claim-essential-features'))
    expect(node.verdict).toBe('regressed')
    expect(node.allowedDrop).toBeUndefined()
  })

  it('聚合分的逐次取值只在每个 case 都留观测时成立', () => {
    expect(aggregateScoresByRun(recordFrom(gold, () => 90))).toEqual([])
    expect(aggregateScoresByRun(recordWithScores([70, 80]))).toEqual([70, 80])
    const partial = recordWithScores([70, 80])
    delete first(first(partial.cases).dimensions).scores
    expect(aggregateScoresByRun(partial)).toEqual([])
  })

  it('负数倍数被拒绝', () => {
    const problems = validateGateConfig(withNoise(-1), space, gold, [])
    expect(problems.join('\n')).toContain('thresholds.noiseMultiple -1 不能为负')
  })
})

describe('判定与归因', () => {
  it('节点分按 DAG 权重聚合,跨 case 的同一节点合并计权', () => {
    const run = recordFrom(gold, (caseId, index) => (caseId === 'oa-answer' && index === 1 ? 80 : 60))
    const scores = nodeScores(space, run)
    // oa-answer#1 权重 28 记 80,novelty-creative#2 权重 20 记 60。
    expect(scores.get('distinguishing-features')).toBeCloseTo((80 * 28 + 60 * 20) / 48, 10)
    expect(scores.get('infringement-all-elements')).toBeCloseTo(60, 10)
  })

  it('拆到两个节点的维度分别计入两侧', () => {
    const run = recordFrom(gold, (caseId, index) => (caseId === 'oa-answer' && index === 5 ? 100 : 70))
    const scores = nodeScores(space, run)
    expect(scores.get('prior-art-search')).toBeCloseTo(100, 10)
    expect(scores.get('deliverable-format')).toBeCloseTo(100, 10)
    const scores70 = caseScores(run)
    expect(scores70.find(entry => entry.caseId === 'oa-answer')?.score).toBeCloseTo((28 * 70 + 18 * 70 + 18 * 70 + 13 * 70 + 13 * 100 + 10 * 70) / 100, 10)
  })

  it('回退超过 maxDrop 的节点判为 regressed 并排在最前', () => {
    const baseline = recordFrom(gold, () => 90)
    const run = recordFrom(gold, (caseId, index) =>
      (caseId === 'oa-answer' && index === 1) || (caseId === 'novelty-creative' && index === 2) ? 80 : 90)
    const verdict = evaluateRun(space, config, run, baseline)
    expect(verdictPassed(verdict)).toBe(false)
    expect(first(verdict.nodes).id).toBe('distinguishing-features')
    expect(first(verdict.nodes).verdict).toBe('regressed')
    expect(first(verdict.nodes).delta).toBeCloseTo(-10, 10)
    expect(formatVerdict(verdict)).toContain('[regressed] distinguishing-features')
    expect(verdict.nodes.filter(node => node.verdict === 'pass').length).toBe(Object.keys(space.nodes).length - 1)
  })

  it('case 层抓住被节点均值摊薄的整案掉分', () => {
    const baseline = recordFrom(gold, () => 90)
    const run = recordFrom(gold, (caseId, index) => caseId === 'oa-answer' && index <= 4 ? 84 : 90)
    const verdict = evaluateRun(space, config, run, baseline)
    expect(verdict.cases.find(entry => entry.id === 'oa-answer')?.verdict).toBe('regressed')
    expect(verdict.nodes.every(node => node.verdict === 'pass')).toBe(true)
    expect(verdict.aggregateVerdict).toBe('pass')
    expect(verdictPassed(verdict)).toBe(false)
  })

  it('低于绝对下限判为 below-floor', () => {
    const run = recordFrom(gold, (caseId, index) => caseId === 'claim-drafting' && index === 1 ? 50 : 90)
    const verdict = evaluateRun(space, config, run, undefined)
    expect(verdict.nodes.find(node => node.id === 'claim-essential-features')?.verdict).toBe('below-floor')
    expect(verdictPassed(verdict)).toBe(false)
  })

  it('回退在容忍内且不低于下限时通过', () => {
    const baseline = recordFrom(gold, () => 90)
    const run = recordFrom(gold, () => 88)
    const verdict = evaluateRun(space, config, run, baseline)
    expect(verdict.aggregateVerdict).toBe('pass')
    expect(verdictPassed(verdict)).toBe(true)
    expect(verdict.aggregateBaselineScore).toBeCloseTo(90, 10)
  })

  it('聚合同样受门槛约束', () => {
    const run = recordFrom(gold, () => 72)
    const verdict = evaluateRun(space, config, run, undefined)
    expect(verdict.aggregateScore).toBeCloseTo(72, 10)
    expect(verdict.aggregateVerdict).toBe('below-floor')
    expect(verdictPassed(verdict)).toBe(false)
  })
})

describe('门禁进程', () => {
  it('基线缺席时拒绝放行、记录后报已记录', () => {
    // 基线一旦按 README 记录下来,这条用例必须继续成立,而不是因为「下一步动作」变红。
    const recorded = config.baselines.every(entry => existsSync(resolve(root, entry.path)))
    const result = runGate()
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(String(result.stdout)).toContain(`${Object.keys(space.nodes).length} 节点`)
    if (recorded) {
      expect(result.status, String(result.stderr)).toBe(0)
      expect(String(result.stdout)).toContain('基线已记录')
      return
    }
    expect(result.status, String(result.stderr)).toBe(1)
    expect(String(result.stderr)).toContain('基线未记录')
    expect(String(result.stderr)).toContain('--accept')
  })

  it('基线路径越出仓库即被判定', () => {
    expect(isOutsideRoot('/repo', 'packages/self-evolve/evaluation/baseline.json')).toBe(false)
    expect(isOutsideRoot('/repo', '/etc/baseline.json')).toBe(true)
    expect(isOutsideRoot('/repo', '../../etc/baseline.json')).toBe(true)
    expect(isOutsideRoot('/repo', '../repo-other/baseline.json')).toBe(true)
  })

  it('低于下限的 run 记录以 1 退出并按节点归因', () => {
    const record = writeRecord(recordFrom(gold, () => 10))
    const result = runGate('--run', record)
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status, String(result.stderr)).toBe(1)
    expect(String(result.stdout)).toContain('[below-floor]')
    expect(String(result.stderr)).toContain('未通过门槛')
  })

  it('低于下限的 run 记录不会被提升为基线', () => {
    const result = runGate('--accept', writeRecord(recordFrom(gold, () => 10)))
    expect(result.status, String(result.stderr)).toBe(1)
    expect(String(result.stderr)).toContain('拒绝把')
  })

  it('与金标不符的 run 记录以 1 退出且不进入判定', () => {
    const record = recordFrom(gold, () => 90)
    first(first(record.cases).dimensions).points = 1
    const result = runGate('--run', writeRecord(record))
    expect(result.status, String(result.stderr)).toBe(1)
    expect(String(result.stderr)).toContain('满分 1,rubric 为 30')
  })

  it('记录的内容摘要与金标一致,门禁读到的正是仓库里的金标', () => {
    expect(goldDigest(gold)).toBe(readFileSync(gatePath, 'utf8').match(/^goldDigest: "(.+)"$/mu)?.[1])
  })

  it('带检索环境的记录可被提升为基线', async () => {
    const record = recordFrom(gold, () => 90)
    record.execution = 'prompt'
    const path = writeRecord(record)
    const dir = mkdtempSync(join(tmpdir(), 'patent-oas-baseline-'))
    scratchDirs.push(dir)
    const target = join(dir, 'baseline.json')
    await acceptBaseline({ run: record, label: path, path }, gold, space, config, target)
    const accepted = await loadRunRecord(target)
    expect(accepted.cases.find(entry => entry.caseId === 'oa-answer')?.retrieval).toBe('oracle')
    expect(accepted.cases.find(entry => entry.caseId === 'claim-drafting')?.retrieval).toBe('none')
  })

  it('未记录检索环境的旧记录不能被提升为基线', () => {
    const record = recordFrom(gold, () => 90)
    for (const runCase of record.cases) delete runCase.retrieval
    const result = runGate('--accept', writeRecord(record))
    expect(result.status, String(result.stderr)).toBe(1)
    expect(String(result.stderr)).toContain('未记录检索环境,不能落为基线')
  })
})
