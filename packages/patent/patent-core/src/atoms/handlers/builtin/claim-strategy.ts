/**
 * 撰写域原子：claim-strategy（权利要求策略表，成文前的特征归属决策）。
 *
 * 模型只决定「哪些特征进独权、哪些进从权、怎么分层」，文本随后由
 * {@link draftClaims} 确定性渲染。本原子把决策固化成一张带原文锚点的表：
 *
 * - 每条特征必须给出来自 `source_text` 的逐字摘录，经 {@link locateQuote} 复核；
 *   任一特征没有命中原文即阶段失败，不降级成空表继续写；
 * - `prior_art_ref` 只接受 `novelty_conclusion` 或已过滤文献中出现过的编号，
 *   否则失败；文献未点名最接近现有技术时写 `null`；
 * - 从权树由模型给出，`draftClaims` 负责循环引用与编号校验；
 * - 调用方注入 `confirmed_features` 时按同一校验读取该表，不再调用模型改写归属。
 *
 * 输出 `claim_strategy` 为 JSON（不进交付正文），`claim_strategy_report` 供
 * `review_gate` 人工复核。
 */

import { type AnchorRange, type AnchorReason, locateQuote } from '../../../anchor/index.ts'
import type { TechDomain } from '../../../claim-draft/index.ts'
import { PARENT_SCHEMA, resolveDomain } from '../../../claim-draft/index.ts'
import { readJsonString, tryParseJson } from '../../../llm-json.ts'
import { dataBlock } from '../../../prompt-hygiene.ts'
import { type Atom } from '../../atom.ts'
import {
  type PipelineState,
  type StageExecuteInput,
  type StageHandler,
  getStateArray,
  getStateString,
} from '../../handler.ts'
import { readAtomTunables } from '../../tunables.ts'
import { callLlm, degraded, requireLlm } from './llm.ts'
import { isTechDomain, readParent } from './claim-json.ts'
import { isRecord, readStateText } from './state-keys.ts'

/** 可选特征在从权中的用途；`fallback` 为未写用途时的缺省。 */
export type ClaimFeatureKind = 'fallback' | 'preferred' | 'range'

/** 一条已复核原文锚点的策略特征。 */
export type ClaimStrategyFeature = {
  /** 特征编号，全表唯一（如 `F1`）。 */
  id: string
  /** 特征文本。 */
  text: string
  /** 用于复核的原文摘录。 */
  anchor: string
  /** PFIE 特征编号，用于把策略特征回映射到提取结果。 */
  source_feature_id?: string
  /** 可选特征的用途；必要特征不出现。 */
  kind?: ClaimFeatureKind
  /** 锚点判定来源。 */
  anchor_reason: AnchorReason
  /** 摘录在 `source_text` 中的命中区间（`end` 为开区间）。 */
  anchor_range: AnchorRange | undefined
}

/** 从权树节点：编号、父项与附加特征编号。 */
export type ClaimStrategyNode = {
  /** 从属权利要求编号（2 起）。 */
  number: number
  /** 引用的在先权利要求编号；数组表示择一引用。 */
  parent: number | number[]
  /** 本节点增加的附加特征编号，必须指向可选特征。 */
  feature_id: string
}

/** 策略表：成文前的特征归属与从权分层。 */
export type ClaimStrategy = {
  /** 发明名称，取自状态而非模型自由发挥。 */
  invention_name: string
  /** 技术领域。 */
  tech_domain: TechDomain
  /** 必要特征（进入独立权利要求）。 */
  essential_features: ClaimStrategyFeature[]
  /** 可选特征（进入从属权利要求或作为备选）。 */
  optional_features: ClaimStrategyFeature[]
  /** 从权树；为空时按可选特征顺序生成线性链。 */
  dependent_tree: ClaimStrategyNode[]
  /** 最接近现有技术编号；文献未点名时为 null。 */
  prior_art_ref: string | null
  /** 该编号对应的文献标题/描述；无匹配时与编号相同或为空。 */
  prior_art_text: string
}

/** 调用方确认过的特征表；字段与模型输出同构，但不再由模型改写归属。 */
export type ConfirmedClaimStrategy = {
  /** 必要特征。 */
  essential_features: ConfirmedFeature[]
  /** 可选特征；缺省为空。 */
  optional_features?: ConfirmedFeature[]
  /** 从权树；缺省时按可选特征顺序生成线性链。 */
  dependent_tree?: ClaimStrategyNode[]
  /** 最接近现有技术编号；缺省为 null。 */
  prior_art_ref?: string | null
}

/** 调用方确认的单条特征。 */
export type ConfirmedFeature = {
  /** 特征编号，全表唯一。 */
  id: string
  /** 特征文本。 */
  text: string
  /** 来自 `source_text` 的逐字摘录。 */
  anchor: string
  /** PFIE 特征编号。 */
  source_feature_id?: string
  /** 可选特征的用途。 */
  kind?: ClaimFeatureKind
}

/** claim-strategy 原子：带原文锚点的特征归属与从权分层。 */
export const claimStrategyAtom: Atom = {
  name: 'claim-strategy',
  description:
    '权利要求策略：逐条给出必要/可选特征与原文锚点、从权树与最接近现有技术编号，锚点未命中或文献编号编造即阶段失败',
  category: 'extract',
  inputSchema: [
    'pfe_triples',
    'merge_result',
    'features',
    'novelty_conclusion',
    'prior_art',
    'source_text',
    'tech_domain',
    'title',
    'invention_title',
    'confirmed_features',
  ],
  outputSchema: ['claim_strategy', 'claim_strategy_report'],
  usesModel: true,
}

/** 模型输出的单条特征。 */
type ModelFeature = {
  id: string
  text: string
  anchor: string
  source_feature_id?: string
  kind?: ClaimFeatureKind
}

/** 可选特征用途的合法取值。 */
const FEATURE_KINDS: readonly ClaimFeatureKind[] = ['fallback', 'preferred', 'range']

/**
 * 类型守卫：判断是否为合法的可选特征用途。
 * @param value - 待判断的值。
 * @returns 是否为 {@link ClaimFeatureKind}。
 */
function isFeatureKind(value: unknown): value is ClaimFeatureKind {
  return typeof value === 'string' && FEATURE_KINDS.includes(value as ClaimFeatureKind)
}

/** D 类文献编号（如 `D1`）；其余文献号按普通子串比对。 */
const D_REFERENCE = /^D\d+$/i

/** 策略表 JSON Schema。 */
const CLAIM_STRATEGY_SCHEMA = {
  type: 'object',
  properties: {
    essential_features: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '特征编号，全表唯一，如 F1' },
          text: { type: 'string', description: '特征文本，用于独立权利要求' },
          anchor: { type: 'string', description: '技术交底书原文摘录，逐字引用' },
          source_feature_id: { type: 'string', description: 'PFIE 特征编号（可选）' },
        },
        required: ['id', 'text', 'anchor'],
      },
    },
    optional_features: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '特征编号，全表唯一，如 F4' },
          text: { type: 'string', description: '附加技术特征文本' },
          anchor: { type: 'string', description: '技术交底书原文摘录，逐字引用' },
          source_feature_id: { type: 'string', description: 'PFIE 特征编号（可选）' },
          kind: {
            type: 'string',
            enum: [...FEATURE_KINDS],
            description: '备用方案、优选方案或数值范围',
          },
        },
        required: ['id', 'text', 'anchor'],
      },
    },
    dependent_tree: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          number: { type: 'integer', description: '从属权利要求编号（2 起）' },
          parent: {
            ...PARENT_SCHEMA,
            description: '引用的在先权利要求编号；数组表示择一引用',
          },
          feature_id: { type: 'string', description: '附加特征编号，必须指向 optional_features' },
        },
        required: ['number', 'parent', 'feature_id'],
      },
    },
    prior_art_ref: {
      type: ['string', 'null'],
      description: '最接近现有技术编号（如 D1）；交底书/检索结果未点名时写 null',
    },
    notes: { type: 'string', description: '策略说明（可选，不进入交付正文）' },
  },
  required: ['essential_features', 'optional_features', 'dependent_tree', 'prior_art_ref'],
} as const

/**
 * 转义正则元字符。
 * @param text - 原文。
 * @returns 可安全嵌入正则的字面量。
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 判断编号是否在文本中被点名；D 类编号要求词边界，避免 `D1` 命中 `D10`。
 * @param text - 检索文本。
 * @param reference - 待查编号。
 * @returns 是否出现。
 */
function mentionsReference(text: string, reference: string): boolean {
  const needle = reference.trim()
  if (D_REFERENCE.test(needle)) {
    return new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(needle)}(?![0-9])`, 'i').test(text)
  }
  return text.toLowerCase().includes(needle.toLowerCase())
}

/**
 * 读取发明名称：显式标题优先，其次原文首行。
 * @param state - 阶段执行态。
 * @param source - 交底书原文。
 * @returns 发明名称；两处都为空时用「技术方案」。
 */
function resolveInventionName(state: PipelineState, source: string): string {
  const explicit = getStateString(state, 'title').trim() || getStateString(state, 'invention_title').trim()
  if (explicit.length > 0) return explicit
  // 调用方保证 source 非空（readStateText 已裁剪并拒绝空串），首行必然存在。
  const newline = source.indexOf('\n')
  const firstLine = (newline < 0 ? source : source.slice(0, newline)).trim()
  const candidate = firstLine.replace(/^#{1,6}\s*/, '')
  return candidate.length <= 25 ? candidate : '技术方案'
}

/**
 * 读取一条特征；字段缺失或类型不符时返回可展示的原因。
 * @param record - 模型或调用方给出的对象项。
 * @param index - 数组下标，用于错误文案。
 * @param optional - 是否读取可选特征（多一个 `kind` 字段）。
 * @returns 解析后的特征，或失败原因。
 */
function readFeature(record: Record<string, unknown>, index: number, optional: boolean): ModelFeature | string {
  const label = optional ? 'optional_features' : 'essential_features'
  const id = readJsonString(record['id'])
  if (id === undefined) return `${label} 第 ${index + 1} 项缺少非空 id`
  const text = readJsonString(record['text'])
  if (text === undefined) return `${label} 第 ${index + 1} 项（${id}）缺少非空 text`
  const anchor = readJsonString(record['anchor'])
  if (anchor === undefined) return `${label} 第 ${index + 1} 项（${id}）缺少非空 anchor`
  const sourceFeatureId = readJsonString(record['source_feature_id'])
  if (optional) {
    const kind = record['kind']
    if (kind !== undefined && !isFeatureKind(kind)) {
      return `${label} 第 ${index + 1} 项（${id}）的 kind 不是 ${FEATURE_KINDS.join('/')}`
    }
    return {
      id,
      text,
      anchor,
      ...(sourceFeatureId !== undefined ? { source_feature_id: sourceFeatureId } : {}),
      ...(kind !== undefined ? { kind } : {}),
    }
  }
  return { id, text, anchor, ...(sourceFeatureId !== undefined ? { source_feature_id: sourceFeatureId } : {}) }
}

/**
 * 读取特征数组。
 * @param value - 待解析的数组。
 * @param optional - 是否按可选特征解析。
 * @returns 解析后的数组，或首个失败原因。
 */
function readFeatureList(value: unknown, optional: boolean): ModelFeature[] | string {
  const label = optional ? 'optional_features' : 'essential_features'
  if (!Array.isArray(value)) return `${label} 不是数组`
  const features: ModelFeature[] = []
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) return `${label} 第 ${index + 1} 项不是对象`
    const read = readFeature(item, index, optional)
    if (typeof read === 'string') return read
    features.push(read)
  }
  return features
}

/**
 * 读取从权树节点。
 * @param value - 待解析的数组。
 * @returns 解析后的节点，或首个失败原因。
 */
function readTree(value: unknown): ClaimStrategyNode[] | string {
  if (!Array.isArray(value)) return 'dependent_tree 不是数组'
  const nodes: ClaimStrategyNode[] = []
  for (const [index, item] of value.entries()) {
    if (!isRecord(item)) return `dependent_tree 第 ${index + 1} 项不是对象`
    const number = item['number']
    if (typeof number !== 'number' || !Number.isInteger(number)) {
      return `dependent_tree 第 ${index + 1} 项的 number 不是整数`
    }
    const parent = readParent(item['parent'])
    if (parent === undefined) return `dependent_tree 第 ${index + 1} 项（权${String(number)}）的 parent 非法`
    const featureId = readJsonString(item['feature_id'])
    if (featureId === undefined) return `dependent_tree 第 ${index + 1} 项（权${String(number)}）缺少 feature_id`
    nodes.push({ number, parent, feature_id: featureId })
  }
  return nodes
}

/**
 * 复核一条特征的原文锚点。
 * @param feature - 模型或调用方给出的特征。
 * @param source - 交底书原文。
 * @returns 带命中区间的策略特征，或未命中原因。
 */
function anchorFeature(
  feature: ModelFeature,
  optional: boolean,
  source: string,
): { ok: true; feature: ClaimStrategyFeature } | { ok: false; reason: string } {
  const anchor = locateQuote(feature.anchor, source)
  if (!anchor.matched) {
    return { ok: false, reason: `${optional ? '可选' : '必要'}特征 ${feature.id} 摘录未在交底书原文中命中` }
  }
  return {
    ok: true,
    feature: {
      ...feature,
      anchor_reason: anchor.reason,
      anchor_range: anchor.range,
    },
  }
}

/**
 * 解析并复核策略表；模型输出与调用方 `confirmed_features` 共用同一条路径。
 * @param raw - 待解析的策略对象。
 * @param source - 交底书原文。
 * @param novelty - 新颖性结论。
 * @param priorArt - 已过滤文献数组。
 * @param name - 发明名称。
 * @param domainHint - `state.tech_domain`。
 * @returns 完整策略表，或首个失败原因。
 */
function buildStrategy(
  raw: Record<string, unknown>,
  source: string,
  novelty: string,
  priorArt: unknown[],
  name: string,
  domainHint: string,
): { ok: true; strategy: ClaimStrategy } | { ok: false; reason: string } {
  const essentialRaw = readFeatureList(raw['essential_features'], false)
  if (typeof essentialRaw === 'string') return { ok: false, reason: essentialRaw }
  if (essentialRaw.length === 0) return { ok: false, reason: 'essential_features 为空：独立权利要求没有必要特征' }
  const optionalRaw = raw['optional_features'] === undefined
    ? []
    : readFeatureList(raw['optional_features'], true)
  if (typeof optionalRaw === 'string') return { ok: false, reason: optionalRaw }
  const treeRaw = raw['dependent_tree']
  const tree = treeRaw === undefined ? [] : readTree(treeRaw)
  if (typeof tree === 'string') return { ok: false, reason: tree }

  const seenIds = new Set<string>()
  const essential: ClaimStrategyFeature[] = []
  for (const feature of essentialRaw) {
    if (seenIds.has(feature.id)) return { ok: false, reason: `特征编号重复：${feature.id}` }
    seenIds.add(feature.id)
    const anchored = anchorFeature(feature, false, source)
    if (!anchored.ok) return { ok: false, reason: anchored.reason }
    essential.push(anchored.feature)
  }
  const optional: ClaimStrategyFeature[] = []
  for (const feature of optionalRaw) {
    if (seenIds.has(feature.id)) return { ok: false, reason: `特征编号重复：${feature.id}` }
    seenIds.add(feature.id)
    const anchored = anchorFeature(feature, true, source)
    if (!anchored.ok) return { ok: false, reason: anchored.reason }
    optional.push(anchored.feature)
  }

  const optionalIds = new Set(optional.map(feature => feature.id))
  const nodes = tree.length > 0
    ? tree
    : optional.map((feature, index) => ({ number: index + 2, parent: index + 1, feature_id: feature.id }))
  const nodeNumbers = new Set<number>()
  for (const node of nodes) {
    if (node.number < 2) return { ok: false, reason: `从权编号 ${String(node.number)} 小于 2` }
    if (nodeNumbers.has(node.number)) return { ok: false, reason: `从权编号重复：${String(node.number)}` }
    nodeNumbers.add(node.number)
    if (!optionalIds.has(node.feature_id)) {
      return { ok: false, reason: `从权 ${String(node.number)} 的 feature_id ${node.feature_id} 不在 optional_features 中` }
    }
  }
  for (const node of nodes) {
    const parents = typeof node.parent === 'number' ? [node.parent] : node.parent
    for (const parent of parents) {
      if (parent === node.number) return { ok: false, reason: `从权 ${String(node.number)} 引用了自身` }
      if (parent > node.number) return { ok: false, reason: `从权 ${String(node.number)} 引用了在后的权 ${String(parent)}` }
      if (parent !== 1 && !nodeNumbers.has(parent)) {
        return { ok: false, reason: `从权 ${String(node.number)} 引用了不存在的权 ${String(parent)}` }
      }
    }
  }

  const priorArtValue = raw['prior_art_ref']
  if (priorArtValue !== null && priorArtValue !== undefined && typeof priorArtValue !== 'string') {
    return { ok: false, reason: 'prior_art_ref 既不是字符串也不是 null' }
  }
  const priorArtRef = typeof priorArtValue === 'string' ? priorArtValue.trim() : ''
  const priorArtText = JSON.stringify(priorArt)
  if (priorArtRef.length > 0 && !mentionsReference(novelty, priorArtRef) && !mentionsReference(priorArtText, priorArtRef)) {
    return {
      ok: false,
      reason: `prior_art_ref ${priorArtRef} 不在 novelty_conclusion 或已过滤文献中：不得编造文献编号`,
    }
  }

  const ref = priorArtRef.length > 0 ? priorArtRef : null
  return {
    ok: true,
    strategy: {
      invention_name: name,
      tech_domain: resolveDomain(
        isTechDomain(domainHint) ? domainHint : undefined,
        name,
        essential.map(feature => feature.text),
      ),
      essential_features: essential,
      optional_features: optional,
      dependent_tree: nodes,
      prior_art_ref: ref,
      prior_art_text: ref === null ? '' : resolvePriorArtText(ref, priorArt),
    },
  }
}

/**
 * 找到编号对应的文献描述，供独立权利要求前序部分引用。
 * @param reference - 文献编号。
 * @param priorArt - 已过滤文献数组。
 * @returns 命中条目的标题；未命中时返回编号本身。
 */
function resolvePriorArtText(reference: string, priorArt: unknown[]): string {
  for (const entry of priorArt) {
    if (!isRecord(entry)) continue
    const title = readJsonString(entry['title'])
    if (title !== undefined && mentionsReference(title, reference)) return title
  }
  return reference
}

/**
 * 读取调用方注入的 `confirmed_features`。
 * @param value - 状态值；对象或 JSON 字符串。
 * @returns 解析后的对象，或失败原因；未注入时返回 undefined。
 */
function readConfirmed(value: unknown): Record<string, unknown> | string | undefined {
  if (value === undefined) return undefined
  if (isRecord(value)) return value
  if (typeof value !== 'string') return 'confirmed_features 既不是对象也不是 JSON 字符串'
  const parsed = tryParseJson(value)
  return isRecord(parsed) ? parsed : 'confirmed_features 不是 JSON 对象'
}

/**
 * 渲染策略表报告：特征归属、原文锚点、从权树与现有技术编号。
 * @param strategy - 已复核的策略表。
 * @returns 供人工复核的中文报告。
 */
export function renderClaimStrategyReport(strategy: ClaimStrategy): string {
  const lines = [`权利要求策略表：必要特征 ${String(strategy.essential_features.length)} 项，可选特征 ${String(strategy.optional_features.length)} 项，从权 ${String(strategy.dependent_tree.length)} 项`]
  lines.push('必要特征：')
  for (const feature of strategy.essential_features) {
    lines.push(`- ${feature.id}「${feature.text}」锚点 ${feature.anchor_reason}`)
  }
  if (strategy.optional_features.length > 0) {
    lines.push('可选特征：')
    for (const feature of strategy.optional_features) {
      const kind = feature.kind === undefined ? '' : `（${feature.kind}）`
      lines.push(`- ${feature.id}${kind}「${feature.text}」锚点 ${feature.anchor_reason}`)
    }
  }
  if (strategy.dependent_tree.length > 0) {
    lines.push('从权树：')
    for (const node of strategy.dependent_tree) {
      const parents = typeof node.parent === 'number' ? String(node.parent) : node.parent.join(' 或 ')
      lines.push(`- 权利要求${String(node.number)} → 引用${parents}（${node.feature_id}）`)
    }
  }
  lines.push(strategy.prior_art_ref === null
    ? '最接近现有技术：未点名（prior_art_ref = null）'
    : `最接近现有技术：${strategy.prior_art_ref}`)
  return lines.join('\n')
}

/** claim-strategy 执行器：调用模型（或读取确认表）并复核锚点与文献编号。 */
export class ClaimStrategyHandler implements StageHandler {
  readonly name = 'claim-strategy'
  readonly category = 'extract' as const

  /**
   * 执行权利要求策略阶段。
   * @param input - 阶段执行输入（state 携带交底书、PFIE、新颖性结论与已过滤文献）。
   * @returns `claim_strategy` / `claim_strategy_report`，或降级片段。
   */
  async execute(input: StageExecuteInput): Promise<PipelineState> {
    const { state, provider, signal } = input
    const tuned = readAtomTunables(state, { temperature: 0.1, promptLimit: 12000 })
    if (!tuned.ok) return degraded('claim-strategy', tuned.reason)
    const { temperature, promptLimit } = tuned.tunables
    const source = readStateText(state, 'source_text')
    if (source === undefined) return degraded('claim-strategy', '输入为空（state.source_text 缺失）')
    const novelty = getStateString(state, 'novelty_conclusion')
    const priorArt = getStateArray(state, 'prior_art')
    const name = resolveInventionName(state, source)
    const domain = getStateString(state, 'tech_domain')
    const confirmed = readConfirmed(state['confirmed_features'])
    if (typeof confirmed === 'string') return degraded('claim-strategy', confirmed)

    let raw: Record<string, unknown>
    if (confirmed !== undefined) {
      raw = confirmed
    } else {
      const missing = requireLlm(provider, 'claim-strategy')
      if (missing) return missing
      const pfeTriples = getStateArray(state, 'pfe_triples')
      const pfeFeatures = getStateArray(state, 'features')
      const pfe = pfeTriples.length > 0
        ? JSON.stringify(pfeTriples, null, 2)
        : pfeFeatures.length > 0
          ? JSON.stringify(pfeFeatures, null, 2)
          : getStateString(state, 'merge_result')
      const priorArtText = priorArt.length > 0 ? JSON.stringify(priorArt, null, 2) : '(无已过滤文献)'
      const prompt = [
        '你是专利代理师，负责在撰写权利要求正文前确定特征归属与从权分层。',
        '只做决定，不写权利要求正文；正文随后由确定性渲染器按你的策略表生成。',
        '要求：',
        '- 必要特征：解决技术问题不可缺少的特征，全部进入独立权利要求；不得混入实施例细节；',
        '- 可选特征：优选方案、备用方案或数值范围，进入从属权利要求；',
        '- anchor 必须逐字摘录技术交底书原文，用于程序复核；摘录不得改写、拼接或转述；',
        '- dependent_tree 给出每条从权的编号、父项（数组表示择一引用）与 feature_id；',
        '- prior_art_ref 只写新颖性结论或已过滤文献中出现的编号；没有点名最接近现有技术时写 null。',
        '',
        '【发明名称】',
        dataBlock(name),
        '',
        '【PFIE 参考】',
        dataBlock(pfe.slice(0, promptLimit)),
        '',
        novelty.trim().length > 0 ? `【新颖性结论】\n${dataBlock(novelty.slice(0, 2000))}` : '',
        '',
        '【已过滤文献】',
        dataBlock(priorArtText.slice(0, 4000)),
        '',
        '【技术交底书原文】',
        dataBlock(source.slice(0, promptLimit)),
        '',
        '请严格输出 JSON：essential_features、optional_features、dependent_tree、prior_art_ref，notes 可选。',
      ].filter(line => line !== '').join('\n')
      const res = await callLlm(
        provider,
        'claim-strategy',
        prompt,
        { schema: CLAIM_STRATEGY_SCHEMA, temperature },
        signal,
      )
      if (!res.ok) return res.error
      const parsed = tryParseJson(res.raw)
      if (parsed === undefined) return degraded('claim-strategy', '模型输出不是 JSON 对象')
      raw = parsed
    }

    const built = buildStrategy(raw, source, novelty, priorArt, name, domain)
    if (!built.ok) return degraded('claim-strategy', built.reason)
    return {
      claim_strategy: JSON.stringify(built.strategy),
      claim_strategy_report: renderClaimStrategyReport(built.strategy),
    }
  }
}
