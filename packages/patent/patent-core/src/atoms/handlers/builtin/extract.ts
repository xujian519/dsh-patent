/**
 * 提取域原子：extract（结构化抽取，按 output_key 分键或按 output_mode 输出问题—发明认知配对）
 * + merge（PFIE 四路融合）。
 */

import { type Atom } from '../../atom.ts'
import {
  type PipelineState,
  type StageExecuteInput,
  type StageHandler,
  getStateArray,
  getStateString,
} from '../../handler.ts'
import { dataBlock } from '../../../prompt-hygiene.ts'
import { parseJsonStringArray, parseOptionalJsonStringArray } from '../../../llm-json.ts'
import { callLlm, degraded, parseLlmJson, requireLlm, resolveInputText } from './llm.ts'
import { readAtomTunables } from '../../tunables.ts'

// ---------------------------------------------------------------------------
// extract —— 结构化抽取（JSON Schema 约束）
// ---------------------------------------------------------------------------

/** extract 原子：从文本结构化抽取特征/问题/效果。 */
export const extractAtom: Atom = {
  name: 'extract',
  description: '从文本中结构化抽取特征/问题/效果（JSON Schema 约束 LLM 输出），可按法条缺口清单做定向补提',
  category: 'extract',
  inputSchema: ['text', 'extraction_type', 'domain', 'output_key', 'output_mode', 'revision_targets'],
  outputSchema: ['extraction_result', 'features', 'problems', 'effects', 'insight', 'problem_insight', 'revision_coverage'],
  usesModel: true,
}

/** extract 支持的分键输出；无 output_key 时沿用全量 features 模式。 */
const EXTRACT_OUTPUT_KEYS = ['features', 'problems', 'effects', 'insight'] as const

type ExtractOutputKey = (typeof EXTRACT_OUTPUT_KEYS)[number]

/** 判断 output_key 是否属于 extract 的分键输出。 */
function isExtractOutputKey(value: string | undefined): value is ExtractOutputKey {
  return value !== undefined && EXTRACT_OUTPUT_KEYS.some(key => key === value)
}

/**
 * 把问题与其发明认知放在一次调用里产出的模式；`output_mode` 的唯一支持值。
 *
 * 两路分开抽取时，发明认知那一路看不到 problems，只能按数组下标与 problems 对齐；
 * 单次产出的配对数组让对应关系随条目自身传递，merge 不再依赖跨数组下标。
 */
const PROBLEM_INSIGHT_MODE = 'problem_insight'

/** `problem_insight` 模式下模型给出的一条问题—发明认知配对。 */
export type ProblemInsightEntry = {
  /** 模型标注的稳定标识；同一次输出内唯一，供审计与降级诊断引用。 */
  id: string
  /** 要解决的技术问题。 */
  problem: string
  /** 使本组特征组合得以奏效的机制层认知；模型未提炼时缺省。 */
  insight?: string
  /** 本条所隶属的上位问题 id；缺省表示本条即顶层构思。 */
  parent?: string
}

/** `problem_insight` 的严格解析结果。 */
type ProblemInsightResult =
  | { ok: true; values: ProblemInsightEntry[] }
  | { ok: false; reason: string }

/**
 * 读取 `output_mode`：缺省表示未启用配对模式，其余取值必须是 {@link PROBLEM_INSIGHT_MODE}。
 * @param value - `state.output_mode` 的原始值。
 * @returns 是否启用配对模式，或配置错误原因。
 */
function readProblemInsightMode(
  value: unknown,
): { ok: true; enabled: boolean } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true, enabled: false }
  if (typeof value !== 'string') return { ok: false, reason: 'output_mode 不是字符串' }
  if (value !== PROBLEM_INSIGHT_MODE) {
    return { ok: false, reason: `未知的 output_mode：${value}（唯一支持值：${PROBLEM_INSIGHT_MODE}）` }
  }
  return { ok: true, enabled: true }
}

/**
 * 复核配对条目之间的父子引用。引用图必须是森林：merge 直接把 `parent` 落成
 * 四元组之间的父子链，留下悬空引用或环会让下游按层遍历时读到错的组。
 * @param values - 已通过字段校验的配对条目（`id` 在同一次输出内唯一）。
 * @returns 首个问题的原因；引用图是森林时返回 undefined。
 */
function checkPairingGraph(values: readonly ProblemInsightEntry[]): string | undefined {
  const byId = new Map(values.map(entry => [entry.id, entry]))
  for (const entry of values) {
    const parent = entry.parent
    if (parent === undefined) continue
    if (parent === entry.id) return `problem_insight 的 id ${entry.id} 把自己列为上位问题`
    if (!byId.has(parent)) return `problem_insight 的 id ${entry.id} 引用了不存在的上位问题 ${parent}`
  }
  for (const entry of values) {
    if (entry.parent === undefined) continue
    const path: string[] = []
    const onPath = new Set<string>()
    let cursor: ProblemInsightEntry | undefined = entry
    while (cursor !== undefined) {
      if (onPath.has(cursor.id)) return `problem_insight 的父子引用成环：${[...path, cursor.id].join(' → ')}`
      path.push(cursor.id)
      onPath.add(cursor.id)
      cursor = cursor.parent === undefined ? undefined : byId.get(cursor.parent)
    }
  }
  return undefined
}

/**
 * 严格解析 `problem_insight`：整组产出承载交付物，任何一条非法都判整组失败。
 *
 * 保留合法条目、丢掉非法条目会让 merge 用半组问题构造四元组，而摘要看不出缺口；
 * 失败域取整阶段降级，与 problems/effects 的字符串数组解析一致。
 * @param value - LLM 返回的 `problem_insight` 值。
 * @returns 原序配对数组（`id`/`problem` 已去首尾空白，空 insight 与空 parent 视为缺省），或失败原因。
 */
function parseProblemInsight(value: unknown): ProblemInsightResult {
  if (!Array.isArray(value)) return { ok: false, reason: 'problem_insight 不是数组' }
  const values: ProblemInsightEntry[] = []
  const ids = new Set<string>()
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return { ok: false, reason: `problem_insight 数组含非对象项（下标 ${index}）` }
    }
    const record = entry as Record<string, unknown>
    const id = typeof record['id'] === 'string' ? record['id'].trim() : ''
    if (id === '') return { ok: false, reason: `problem_insight 第 ${index + 1} 项缺少非空 id` }
    if (ids.has(id)) return { ok: false, reason: `problem_insight 的 id 重复：${id}` }
    ids.add(id)
    const problem = typeof record['problem'] === 'string' ? record['problem'].trim() : ''
    if (problem === '') {
      return { ok: false, reason: `problem_insight 第 ${index + 1} 项（id ${id}）缺少非空 problem` }
    }
    const rawInsight = record['insight']
    if (rawInsight !== undefined && typeof rawInsight !== 'string') {
      return { ok: false, reason: `problem_insight 第 ${index + 1} 项（id ${id}）的 insight 不是字符串` }
    }
    const insight = typeof rawInsight === 'string' ? rawInsight.trim() : ''
    const rawParent = record['parent']
    if (rawParent !== undefined && rawParent !== null && typeof rawParent !== 'string') {
      return { ok: false, reason: `problem_insight 第 ${index + 1} 项（id ${id}）的 parent 不是字符串或 null` }
    }
    const parent = typeof rawParent === 'string' ? rawParent.trim() : ''
    values.push({
      id,
      problem,
      ...(insight.length > 0 ? { insight } : {}),
      ...(parent.length > 0 ? { parent } : {}),
    })
  }
  const graph = checkPairingGraph(values)
  if (graph !== undefined) return { ok: false, reason: graph }
  return { ok: true, values }
}

/** 单次反哺最多消费的目标数（与 legal-gaps 的产出上限一致）。 */
const MAX_REVISION_TARGETS = 8

/** 规则缺口反哺目标：法条/检查编号与名称。 */
type RevisionTarget = {
  checkId: string
  provision: string
  label: string
}

/**
 * 读取 legal-gaps 反哺清单；非数组、缺字段或超长条目被丢弃。
 * @param value - `state.revision_targets` 的原始值。
 * @returns 最多 {@link MAX_REVISION_TARGETS} 个合法目标。
 */
function parseRevisionTargets(value: unknown): RevisionTarget[] {
  if (!Array.isArray(value)) return []
  const targets: RevisionTarget[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    const checkId = typeof record['checkId'] === 'string' ? record['checkId'].trim() : ''
    const provision = typeof record['provision'] === 'string' ? record['provision'].trim() : ''
    const label = typeof record['label'] === 'string' ? record['label'].trim() : ''
    if (checkId === '' || provision === '' || label === '') continue
    targets.push({ checkId, provision, label })
    if (targets.length >= MAX_REVISION_TARGETS) break
  }
  return targets
}

/** 读取字符串数组并去掉首尾空白与空项。 */
function stringFacts(value: readonly unknown[]): string[] {
  return value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => item.length > 0)
}

/**
 * 读取反哺提取的覆盖结果：只接受字符串数组，缺失或类型不符的条目按「没有补提到事实」
 * 处理。覆盖结果是审计信息，不是提取成功的前提——第二轮模型漏写 `revision_coverage`
 * 时仍应保留已抽取的特征，不能把整轮产出判成降级。
 * @param value - LLM 返回的 `revision_coverage`。
 * @param targets - 本轮反哺目标。
 * @returns 已提供的覆盖映射（按 checkId）。
 */
function parseRevisionCoverage(
  value: unknown,
  targets: readonly RevisionTarget[],
): Record<string, string[]> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const record = value as Record<string, unknown>
  const coverage: Record<string, string[]> = {}
  for (const target of targets) {
    const entry = record[target.checkId]
    if (!Array.isArray(entry)) continue
    coverage[target.checkId] = stringFacts(entry)
  }
  return coverage
}

/** 合并多路提取的覆盖事实：同一检查项的事实取并集，避免后一路覆盖前一路。 */
function mergeRevisionCoverage(
  existing: unknown,
  incoming: Record<string, string[]>,
): Record<string, string[]> {
  const merged: Record<string, string[]> = {}
  if (typeof existing === 'object' && existing !== null && !Array.isArray(existing)) {
    for (const [key, value] of Object.entries(existing)) {
      if (Array.isArray(value)) merged[key] = stringFacts(value)
    }
  }
  for (const [key, value] of Object.entries(incoming)) {
    const prior = merged[key] ?? []
    merged[key] = [...new Set([...prior, ...value])]
  }
  return merged
}

/** 四个分键共享的 JSON 属性声明；Schema 只把当前目标键设为 required。 */
const EXTRACT_PROPERTIES = {
  features: { type: 'array', items: { type: 'string' }, description: '技术特征列表' },
  problems: { type: 'array', items: { type: 'string' }, description: '要解决的技术问题' },
  effects: { type: 'array', items: { type: 'string' }, description: '技术效果' },
  insight: {
    type: 'array',
    items: { type: 'string' },
    description: '发明认知：使特征组合得以奏效的机制层认知',
  },
  problem_insight: {
    type: 'array',
    description: '问题与其发明认知逐条配对；每条给出唯一 id，未提炼出认知时省略 insight',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '本条配对的唯一标识（同一输出内不重复）' },
        problem: { type: 'string', description: '要解决的技术问题' },
        insight: { type: 'string', description: '使该问题相关特征组合得以奏效的机制层认知' },
        parent: {
          type: ['string', 'null'],
          description: '本条所隶属的上位问题 id（同一输出内的另一条）；本条即顶层构思时写 null',
        },
      },
      required: ['id', 'problem'],
    },
  },
} as const

/**
 * 构造当前分键的 JSON Schema：只要求目标键，避免 problems/effects/insight
 * 提取被 features 的 required 约束逼成“必须同时返回特征”。反哺轮次额外要求
 * `revision_coverage`，把「补提了什么」变成可校验的产出。
 * @param outputKey - 分键输出；缺省或未知时按 features 全量模式。
 * @param requiresCoverage - 本轮是否带规则缺口反哺目标。
 * @param problemInsight - 是否为 problems 与 insight 的单次配对输出。
 * @returns 供 LLM 端口使用的对象 Schema。
 */
function extractSchema(
  outputKey: ExtractOutputKey | undefined,
  requiresCoverage: boolean,
  problemInsight: boolean,
): Record<string, unknown> {
  const required = problemInsight
    ? [PROBLEM_INSIGHT_MODE]
    : outputKey === undefined ? ['features'] : [outputKey]
  if (requiresCoverage) required.push('revision_coverage')
  return {
    type: 'object',
    properties: {
      ...EXTRACT_PROPERTIES,
      ...(requiresCoverage
        ? {
          revision_coverage: {
            type: 'object',
            additionalProperties: { type: 'array', items: { type: 'string' } },
            description: '按 checkId 列出本轮补提到的事实；原文没有对应事实时写空数组',
          },
        }
        : {}),
    },
    required,
  }
}

/**
 * 特征抽取的 MTU（最小技术单元）拆分与反幻觉标注规则（移植 Mady feature-extraction
 * 模板，Apache-2.0）。仅注入特征类抽取的提示词；标注随特征文本落串，不改变
 * features 的字符串数组 schema 及其下游消费方（merge/keywords/novelty）。
 */
const FEATURE_MTU_GUIDANCE = [
  'MTU 拆分规则：每条特征必须是最小技术单元——单一技术手段、单一技术效果、可与现有技术独立比对；可再拆分的必须继续拆分。',
  '逐条在句末标注：[必要性:必要|非必要]（以解决技术问题是否必需判断）与 [依赖:<所依赖特征文本|无>]。',
  '原文无法确定的技术含义不得编造；不确定时在句末追加 [待确认] 并简述推测依据。',
].join('\n')

/** extract 执行器：结构化抽取（JSON Schema 约束）。 */
export class ExtractHandler implements StageHandler {
  readonly name = 'extract'
  readonly category = 'extract' as const

  /**
   * 执行 extract 阶段（PFE 抽取），返回下一管线状态。
   * @param execInput - 阶段执行输入（state 与 LLM provider）。
   * @returns 下一管线状态（可能带降级标记）。
   */
  async execute(execInput: StageExecuteInput): Promise<PipelineState> {
    const { state, provider, signal } = execInput
    const tuned = readAtomTunables(state, { temperature: 0, promptLimit: 8000 })
    if (!tuned.ok) return degraded('extract', tuned.reason)
    const { temperature, promptLimit } = tuned.tunables
    const missing = requireLlm(provider, 'extract')
    if (missing) return missing
    const text = resolveInputText(state, ['text', 'extraction_input'], '')
    if (text.trim().length === 0) {
      return degraded('extract', '输入文本为空')
    }
    const extractionType = getStateString(state, 'extraction_type') || '技术特征抽取'
    const domain = getStateString(state, 'domain') || '专利'
    // 按任务分键（经 stage.params.output_key 注入）：各路提取互不覆盖。
    // 缺省时保持旧行为（全量写 features/problems/effects）。
    const outputKey = getStateString(state, 'output_key')
    const targetKey = isExtractOutputKey(outputKey) ? outputKey : undefined
    // 问题与发明认知的单次配对输出：mode 与 output_key 都声明目标键，同时出现即配置矛盾。
    const pairMode = readProblemInsightMode(state['output_mode'])
    if (!pairMode.ok) return degraded('extract', pairMode.reason)
    if (pairMode.enabled && outputKey.trim() !== '') {
      return degraded('extract', `output_mode 与 output_key 不能同时使用（收到 output_key：${outputKey}）`)
    }
    // MTU 规则只属于特征抽取：按结构化的 output_key 判定，不按提示词文本推断。
    const isFeatureExtraction = targetKey === 'features'
    // 规则缺口反哺：legal-gaps 的未评估项经回退保留在 state.revision_targets，
    // 本轮抽取按清单定向补提，并要求逐项回报覆盖结果。
    const revisionTargets = parseRevisionTargets(state['revision_targets'])
    const requiresCoverage = revisionTargets.length > 0
    const prompt = [
      `你是 ${domain} 领域的技术分析助手。任务：${extractionType}。`,
      ...(isFeatureExtraction ? [FEATURE_MTU_GUIDANCE] : []),
      ...(pairMode.enabled
        ? [
          '请从以下文本中提取待解决的技术问题，并为每个问题提炼一条发明认知（使该问题的相关特征组合得以奏效的机制层认知）。严格输出 JSON：',
          `{ "${PROBLEM_INSIGHT_MODE}": [{"id": "P1", "problem": "<技术问题>", "insight": "<发明认知>", "parent": null}] }`,
          'id 在同一输出内唯一；problem 与 insight 必须描述同一个问题。原文不足以提炼发明认知时省略该条的 insight，不得编造原文没有的技术手段。',
          '一个问题只能是另一个问题的下位拆解：把上位问题的 id 写进下位条目的 parent，顶层问题写 null。parent 必须指向同一输出内已给出的 id，不得自指或成环；只有一层构思时全部写 null，不得为了造层级而拆出重复问题。',
        ]
        : [
          targetKey !== undefined
            ? `请从以下文本中提取结构化结果，严格输出 JSON：{ "${targetKey}": [...] }`
            : '请从以下文本中提取结构化结果，严格输出 JSON：',
        ]),
      ...(requiresCoverage
        ? [
          '本轮为规则缺口反哺：以下法条/检查在上一轮未被确定性检查覆盖。',
          ...revisionTargets.map(target => `- [${target.checkId}] ${target.provision} — ${target.label}`),
          '除目标键外，必须另给 "revision_coverage": { "<checkId>": ["支持该法条评估的事实", ...] }；原文没有对应事实的写空数组，不得编造。',
        ]
        : []),
      dataBlock(text.slice(0, promptLimit)),
    ].join('\n')
    const res = await callLlm(
      provider,
      'extract',
      prompt,
      { schema: extractSchema(targetKey, requiresCoverage, pairMode.enabled), temperature },
      signal,
    )
    if (!res.ok) return res.error
    return parseLlmJson(
      res.raw,
      (parsed, raw) => {
        const coverage = requiresCoverage
          ? parseRevisionCoverage(parsed.revision_coverage, revisionTargets)
          : undefined
        const coverageDelta = coverage === undefined
          ? {}
          : { revision_coverage: mergeRevisionCoverage(state['revision_coverage'], coverage) }
        if (pairMode.enabled) {
          const pairs = parseProblemInsight(parsed[PROBLEM_INSIGHT_MODE])
          if (!pairs.ok) return degraded('extract', pairs.reason)
          return {
            extraction_result: raw,
            problem_insight: pairs.values,
            // problems 是派生投影：下游按问题清单读取（draft-specification、legal-gaps 采集）。
            problems: pairs.values.map(entry => entry.problem),
            ...coverageDelta,
          }
        }
        if (targetKey !== undefined) {
          const result = parseJsonStringArray(parsed[targetKey], targetKey)
          if (!result.ok) return degraded('extract', result.reason)
          return { extraction_result: raw, [targetKey]: result.values, ...coverageDelta }
        }
        const features = parseJsonStringArray(parsed.features, 'features')
        if (!features.ok) return degraded('extract', features.reason)
        const problems = parseOptionalJsonStringArray(parsed.problems, 'problems')
        if (!problems.ok) return degraded('extract', problems.reason)
        const effects = parseOptionalJsonStringArray(parsed.effects, 'effects')
        if (!effects.ok) return degraded('extract', effects.reason)
        return {
          extraction_result: raw,
          features: features.values,
          problems: problems.values,
          effects: effects.values,
          ...coverageDelta,
        }
      },
      raw => pairMode.enabled
        ? degraded('extract', `LLM 输出不是 JSON 对象，缺少 ${PROBLEM_INSIGHT_MODE} 数组`)
        : targetKey !== undefined
          ? degraded('extract', `LLM 输出不是 JSON 对象，缺少 ${targetKey} 数组`)
          : { extraction_result: raw },
    )
  }
}

// ---------------------------------------------------------------------------
// merge —— PFIE 四路提取融合（移植 Mady disclosure/graph.go mergeExtractionsNode）
// ---------------------------------------------------------------------------
//
// 确定性实现（无 LLM）：读 extract 的分键产出，按问题构造 PFIE 四元组。
//
// 有 `problem_insight` 时按条目配对：问题、发明认知与父子引用在同一次抽取中生成，
// 对应关系随条目传递，与数组顺序无关。没有该键时退回按索引配对的旧路径（legacy state、
// 只跑分键抽取的自定义计划），旧路径不产生层级。两条路径的多余特征/效果都并入末组；
// 索引路径的配对由构造而非校验，问题多于特征时越界组拿到空特征列表，这正是
// pfe-consistency 判定的结构事实。

/** merge 原子：融合 PFIE 提取结果为四元组。 */
export const mergeAtom: Atom = {
  name: 'merge',
  description: '融合 PFIE 提取结果（问题↔发明认知↔特征↔效果），产出 PFIE 四元组',
  category: 'extract',
  inputSchema: ['features', 'problems', 'effects', 'insight', 'problem_insight'],
  outputSchema: ['pfe_triples', 'merge_result'],
}

/**
 * PFIE 四元组：一个问题与对应的发明认知、特征、效果。
 *
 * `insight` 可选：下游消费方（keywords/novelty/draft-claims）只读问题与特征，未经
 * 问题—发明认知配对抽取的管线不应因为缺发明认知而整体降级。
 */
export type PFETriple = {
  id: string
  problem: string
  /** 发明认知：使本组特征得以奏效的机制层认知；缺省表示本组未提炼。 */
  insight?: string
  /** 上位四元组的 id（merge 由配对条目的 parent 换算）；缺省表示本组即顶层构思。 */
  parentId?: string
  features: string[]
  effects: string[]
}

/** 沿 parentId 链得到的层级读数。 */
export type PfeHierarchy = {
  /** 没有上位四元组的组数（独权应对准的构思个数）。 */
  roots: number
  /** 最长父子链的层数；顶层计为 1，无层级时亦为 1。 */
  maxDepth: number
  /** 每个父组下挂的子组 id，按四元组原序。 */
  children: Map<string, string[]>
}

/**
 * 按 parentId 链给出四元组的层级读数。
 *
 * 配对路径下抽取阶段已把父子引用校验为森林（{@link checkPairingGraph}）；`visited` 只让
 * 直接按字面构造出的环状输入能终止遍历，不在此处判罚。
 * @param triples - PFIE 四元组。
 * @returns 顶层组数、最大层深与父子邻接表。
 */
export function readPfeHierarchy(triples: readonly PFETriple[]): PfeHierarchy {
  const byId = new Map(triples.map(triple => [triple.id, triple]))
  const children = new Map<string, string[]>()
  let roots = 0
  let maxDepth = 1
  for (const triple of triples) {
    if (triple.parentId === undefined) {
      roots += 1
    } else {
      const siblings = children.get(triple.parentId) ?? []
      children.set(triple.parentId, [...siblings, triple.id])
    }
    const visited = new Set<string>([triple.id])
    let cursor = triple.parentId === undefined ? undefined : byId.get(triple.parentId)
    let depth = 1
    while (cursor !== undefined && !visited.has(cursor.id)) {
      visited.add(cursor.id)
      depth += 1
      cursor = cursor.parentId === undefined ? undefined : byId.get(cursor.parentId)
    }
    if (depth > maxDepth) maxDepth = depth
  }
  return { roots, maxDepth, children }
}

/**
 * 把超出锚点数的特征/效果（索引路径另有多余发明认知）并入末组；没有任何组时构造
 * 一个空问题组。两条配对路径共用。
 * @param triples - 已由锚点构造的四元组，原地追加。
 * @param features - 超出锚点数的特征，按原序并入。
 * @param effects - 超出锚点数的效果，按原序并入。
 * @param insights - 索引路径下超出问题数的发明认知，以 `；` 追加到末组。
 */
function appendSurplus(
  triples: PFETriple[],
  features: readonly string[],
  effects: readonly string[],
  insights: readonly string[] = [],
): void {
  if (features.length === 0 && effects.length === 0 && insights.length === 0) return
  const last = triples.at(-1)
  if (last === undefined) {
    triples.push({
      id: 'T1',
      problem: '',
      ...(insights.length > 0 ? { insight: insights.join('；') } : {}),
      features: [...features],
      effects: [...effects],
    })
    return
  }
  last.features.push(...features)
  last.effects.push(...effects)
  if (insights.length > 0) {
    last.insight = [last.insight, ...insights]
      .filter((value): value is string => value !== undefined)
      .join('；')
  }
}

/** merge 执行器：按问题—发明认知配对或索引配对，把提取结果构造成 PFIE 四元组。 */
export class MergeHandler implements StageHandler {
  readonly name = 'merge'
  readonly category = 'extract' as const

  /**
   * 执行 merge 阶段（提取结果配对为 PFIE 四元组），返回下一管线状态。
   * @param input - 阶段执行输入（state）。
   * @returns 下一管线状态（可能带降级标记）。
   */
  // oxlint-disable-next-line typescript/require-await -- StageHandler contract requires async execute
  async execute(input: StageExecuteInput): Promise<PipelineState> {
    const { state } = input
    const features = getStateArray(state, 'features').map(String).filter(Boolean)
    const effects = getStateArray(state, 'effects').map(String).filter(Boolean)
    // 存在即按配对数组合并：给出但非法时降级，不得静默退回索引配对。
    const rawPairs = state[PROBLEM_INSIGHT_MODE]
    const parsedPairs = rawPairs === undefined ? undefined : parseProblemInsight(rawPairs)
    if (parsedPairs !== undefined && !parsedPairs.ok) {
      return degraded('merge', parsedPairs.reason)
    }
    const pairs = parsedPairs?.values
    const problems = pairs === undefined
      ? getStateArray(state, 'problems').map(String).filter(Boolean)
      : pairs.map(entry => entry.problem)
    const insights = getStateArray(state, 'insight').map(String).filter(Boolean)
    if (
      problems.length + features.length + effects.length
      + (pairs === undefined ? insights.length : 0) === 0
    ) {
      return degraded('merge', '四路提取结果均为空（state.problem_insight/features/problems/effects/insight）')
    }
    const pairIndexes = new Map((pairs ?? []).map((pair, index) => [pair.id, index] as const))
    const triples: PFETriple[] = pairs === undefined
      ? problems.map((problem, i) => ({
        id: `T${i + 1}`,
        problem,
        ...(insights[i] !== undefined ? { insight: insights[i] } : {}),
        features: features[i] !== undefined ? [features[i]] : [],
        effects: effects[i] !== undefined ? [effects[i]] : [],
      }))
      : pairs.map((pair, i) => {
        // parent 已在同一次输出内闭合，此处只把条目 id 换成四元组 id。
        const parentIndex = pair.parent === undefined ? undefined : pairIndexes.get(pair.parent)
        return {
          id: `T${i + 1}`,
          problem: pair.problem,
          ...(pair.insight !== undefined ? { insight: pair.insight } : {}),
          ...(parentIndex === undefined ? {} : { parentId: `T${parentIndex + 1}` }),
          features: features[i] !== undefined ? [features[i]] : [],
          effects: effects[i] !== undefined ? [effects[i]] : [],
        }
      })
    // 多于问题数的特征/效果（以及索引路径的多余发明认知）并入最后一个三元组。
    appendSurplus(
      triples,
      features.slice(problems.length),
      effects.slice(problems.length),
      pairs === undefined ? insights.slice(problems.length) : [],
    )
    const insightCount = pairs === undefined
      ? insights.length
      : pairs.filter(pair => pair.insight !== undefined).length
    const pairing = pairs === undefined ? 'index' : PROBLEM_INSIGHT_MODE
    const summary = `PFIE 融合：${problems.length} 个问题 / ${insightCount} 条发明认知 / ${features.length} 个特征 / ${effects.length} 个效果（配对: ${pairing}）`
    // 索引路径没有父子信息可读，不伪造「一层构思」；配对路径额外给出层级读数。
    const hierarchy = pairs === undefined
      ? undefined
      : readPfeHierarchy(triples)
    return {
      pfe_triples: triples,
      merge_result: hierarchy === undefined
        ? summary
        : `${summary}。层级：顶层 ${hierarchy.roots} 组，最长链 ${hierarchy.maxDepth} 层`,
    }
  }
}
