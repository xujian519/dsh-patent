/**
 * 撰写域原子：draft-claims（按策略表确定性渲染权利要求书）。
 *
 * 分工：`claim-strategy` 已决定必要/可选特征、从权树与最接近现有技术；
 * 本原子不再让模型自由撰写全文，而是：
 *
 * 1. 读取 `claim_strategy`（JSON），把特征编号映射回特征文本；
 * 2. 调用 {@link draftClaims} 渲染独立权利要求与多路从权树（B1 的
 *    `dependent_tree`）；
 * 3. 可选的第二步「从权专员」只重排或补充从权，独立权利要求文本保持渲染结果；
 * 4. 最终文本再过 {@link lintClaimText}：任一 error 即否决本轮草稿，不写
 *    `claims_draft`，避免半成品覆盖已确认稿。
 *
 * `slop_clean` 回退到本阶段时，策略表不变，因此特征归属不变；从权专员在带
 * `slop_revision_hint` 时只调整从权表述。
 */

import {
  type ClaimViolation,
  type DependentClaimNode,
  type DraftedClaim,
  type TechDomain,
  PARENT_SCHEMA,
  claimCountViolations,
  draftClaims,
  renderParents,
  validateClaims,
} from '../../../claim-draft/index.ts'
import { lintClaimText, type ClaimLintReport } from '../../../claim-lint/index.ts'
import { tryParseJson } from '../../../llm-json.ts'
import { dataBlock } from '../../../prompt-hygiene.ts'
import { type Atom } from '../../atom.ts'
import {
  type PipelineState,
  type StageExecuteInput,
  type StageHandler,
  getStateString,
} from '../../handler.ts'
import { readAtomTunables } from '../../tunables.ts'
import { callLlm, degraded } from './llm.ts'
import { isTechDomain, readParent } from './claim-json.ts'
import { isRecord, readStateText } from './state-keys.ts'

/** draft-claims 原子：按策略表渲染权利要求书并执行形式否决。 */
export const draftClaimsAtom: Atom = {
  name: 'draft-claims',
  description:
    '按 claim-strategy 的特征表与从权树确定性渲染权利要求书（独权+多路从权），从权专员只重排/补充从权，claim_lint 任一 error 否决本轮草稿',
  category: 'extract',
  inputSchema: [
    'claim_strategy',
    'claim_strategy_report',
    'max_claims',
    'slop_revision_hint',
  ],
  outputSchema: ['claims_draft', 'draft_claims_result', 'review_context'],
  usesModel: true,
}

/** 策略表中的一条特征；渲染只需要编号与文本。 */
type StrategyFeature = {
  id: string
  text: string
  kind?: string
}

/** 策略表中的从权节点。 */
type StrategyNode = {
  number: number
  parent: number | number[]
  feature_id: string
}

/** 已解析的策略表。 */
type ParsedStrategy = {
  invention_name: string
  tech_domain: TechDomain
  essential: StrategyFeature[]
  optional: StrategyFeature[]
  nodes: StrategyNode[]
  prior_art_text: string
}

/** 从权专员输出的一条从权。 */
type SpecialistDependent = {
  number: number
  parent: number | number[]
  feature_id?: string
  text: string
}

/** 从权专员的 JSON Schema。 */
const DEPENDENTS_SCHEMA = {
  type: 'object',
  properties: {
    dependents: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          number: { type: 'integer', description: '从属权利要求编号，从 2 起连续编号' },
          parent: {
            ...PARENT_SCHEMA,
            description: '引用的在先权利要求编号；数组表示择一引用',
          },
          feature_id: { type: 'string', description: '附加特征编号，必须来自可选特征表' },
          text: { type: 'string', description: '本条从权增加的附加技术特征文本' },
        },
        required: ['number', 'parent', 'text'],
      },
    },
    notes: { type: 'string', description: '调整说明（可选，不进入交付正文）' },
  },
  required: ['dependents'],
} as const

/** 从权专员的降级结果：保留确定性草稿并记录原因。 */
type SpecialistOutcome =
  | { applied: true; dependents: SpecialistDependent[] }
  | { applied: false; reason: string }

/**
 * 读取策略表 JSON。
 * @param raw - `state.claim_strategy` 文本。
 * @returns 解析后的策略表，或失败原因。
 */
function parseStrategy(raw: string): ParsedStrategy | string {
  const parsed = tryParseJson(raw)
  if (parsed === undefined) return 'state.claim_strategy 不是 JSON 对象'
  const name = parsed['invention_name']
  if (typeof name !== 'string' || name.trim().length === 0) return 'claim_strategy 缺少 invention_name'
  const essentialRaw = parsed['essential_features']
  if (!Array.isArray(essentialRaw) || essentialRaw.length === 0) {
    return 'claim_strategy.essential_features 为空'
  }
  const essential: StrategyFeature[] = []
  for (const item of essentialRaw) {
    if (!isRecord(item)) return 'claim_strategy.essential_features 含非对象项'
    const id = item['id']
    const text = item['text']
    if (typeof id !== 'string' || typeof text !== 'string' || id.trim() === '' || text.trim() === '') {
      return 'claim_strategy.essential_features 的 id/text 非法'
    }
    essential.push({ id, text })
  }
  const optionalRaw = parsed['optional_features']
  if (!Array.isArray(optionalRaw)) return 'claim_strategy.optional_features 不是数组'
  const optional: StrategyFeature[] = []
  for (const item of optionalRaw) {
    if (!isRecord(item)) return 'claim_strategy.optional_features 含非对象项'
    const id = item['id']
    const text = item['text']
    if (typeof id !== 'string' || typeof text !== 'string' || id.trim() === '' || text.trim() === '') {
      return 'claim_strategy.optional_features 的 id/text 非法'
    }
    const kind = item['kind']
    optional.push({ id, text, ...(typeof kind === 'string' ? { kind } : {}) })
  }
  const treeRaw = parsed['dependent_tree']
  if (!Array.isArray(treeRaw)) return 'claim_strategy.dependent_tree 不是数组'
  const nodes: StrategyNode[] = []
  for (const item of treeRaw) {
    if (!isRecord(item)) return 'claim_strategy.dependent_tree 含非对象项'
    const number = item['number']
    const parent = readParent(item['parent'])
    const featureId = item['feature_id']
    if (typeof number !== 'number' || !Number.isInteger(number) || parent === undefined
      || typeof featureId !== 'string' || featureId.trim() === '') {
      return 'claim_strategy.dependent_tree 的 number/parent/feature_id 非法'
    }
    nodes.push({ number, parent, feature_id: featureId })
  }
  const domain = parsed['tech_domain']
  const priorArt = parsed['prior_art_text']
  return {
    invention_name: name.trim(),
    tech_domain: isTechDomain(domain) ? domain : 'general',
    essential,
    optional,
    nodes,
    prior_art_text: typeof priorArt === 'string' ? priorArt : '',
  }
}

/**
 * 把策略表节点映射成带特征文本的从权树。
 * @param strategy - 已解析的策略表。
 * @returns 引擎输入节点，或首个缺失特征的原因。
 */
function buildTree(strategy: ParsedStrategy): DependentClaimNode[] | string {
  const byId = new Map(strategy.optional.map(feature => [feature.id, feature.text]))
  const nodes: DependentClaimNode[] = []
  for (const node of strategy.nodes) {
    const text = byId.get(node.feature_id)
    if (text === undefined) return `从权 ${String(node.number)} 的 feature_id ${node.feature_id} 不在策略表中`
    nodes.push({ number: node.number, parent: node.parent, text, feature_id: node.feature_id })
  }
  return nodes
}

/**
 * 渲染权利要求正文。
 * @param claims - 已排序的权利要求。
 * @returns `1. …` 形式的全文。
 */
function renderClaims(claims: readonly DraftedClaim[]): string {
  return claims.map(claim => `${String(claim.number)}. ${claim.text}`).join('\n\n')
}

/**
 * 检查从权专员给出的父项是否只引用在先权项。
 *
 * 编号已要求从 2 起连续，因此父项小于本项编号即必然存在。
 * @param parents - 父项。
 * @param number - 本项编号。
 * @returns 合法时返回 undefined，否则返回原因。
 */
function parentProblem(parents: readonly number[], number: number): string | undefined {
  for (const parent of parents) {
    if (parent < 1 || parent >= number) return `从权 ${String(number)} 引用了非在先权 ${String(parent)}`
  }
  return undefined
}

/**
 * 读取并校验从权专员的输出。
 * @param raw - 模型输出 JSON 文本。
 * @param optional - 可选特征表，用于把 feature_id 映射回文本。
 * @returns 从权列表，或失败原因。
 */
function readSpecialistOutput(
  raw: string,
  optional: readonly StrategyFeature[],
): SpecialistDependent[] | string {
  const parsed = tryParseJson(raw)
  if (parsed === undefined) return '从权专员输出不是 JSON 对象'
  const dependentsRaw = parsed['dependents']
  if (!Array.isArray(dependentsRaw)) return '从权专员输出缺少 dependents 数组'
  const byId = new Map(optional.map(feature => [feature.id, feature.text]))
  const dependents: SpecialistDependent[] = []
  for (const [index, item] of dependentsRaw.entries()) {
    if (!isRecord(item)) return `dependents 第 ${index + 1} 项不是对象`
    const number = item['number']
    if (typeof number !== 'number' || !Number.isInteger(number)) {
      return `dependents 第 ${index + 1} 项的 number 不是整数`
    }
    const parent = readParent(item['parent'])
    if (parent === undefined) return `dependents 第 ${index + 1} 项（权${String(number)}）的 parent 非法`
    const text = item['text']
    if (typeof text !== 'string' || text.trim().length === 0) {
      return `dependents 第 ${index + 1} 项（权${String(number)}）缺少 text`
    }
    const featureId = item['feature_id']
    if (featureId !== undefined) {
      if (typeof featureId !== 'string' || !byId.has(featureId)) {
        return `dependents 第 ${index + 1} 项（权${String(number)}）的 feature_id 不在可选特征表中`
      }
    }
    const trimmed = text.trim()
    dependents.push({
      number,
      parent,
      text: trimmed.endsWith('。') ? trimmed : `${trimmed}。`,
      ...(typeof featureId === 'string' ? { feature_id: featureId } : {}),
    })
  }
  const sorted = [...dependents].sort((left, right) => left.number - right.number)
  if (sorted.length === 0) return '从权专员没有返回任何从权'
  for (const [index, dependent] of sorted.entries()) {
    if (dependent.number !== index + 2) {
      return `从权编号必须从 2 起连续，第 ${index + 2} 项实为权${String(dependent.number)}`
    }
    const parents = typeof dependent.parent === 'number' ? [dependent.parent] : dependent.parent
    const problem = parentProblem(parents, dependent.number)
    if (problem !== undefined) return problem
  }
  return sorted
}

/**
 * 把从权专员输出渲染成完整权利要求句。
 * @param dependents - 已校验的从权。
 * @param name - 发明名称。
 * @returns 渲染后的从权列表。
 */
function renderSpecialistDependents(
  dependents: readonly SpecialistDependent[],
  name: string,
): DraftedClaim[] {
  return dependents.map(dependent => ({
    number: dependent.number,
    type: 'dependent',
    refersTo: typeof dependent.parent === 'number' ? dependent.parent : [...dependent.parent],
    text: `根据权利要求${renderParents(dependent.parent)}所述的${name}，其特征在于，还包括：${dependent.text}`,
    ...(dependent.feature_id !== undefined ? { featureId: dependent.feature_id } : {}),
  }))
}

/**
 * 调用从权专员：只重排/补充从权。
 * @param provider - 阶段能力提供者。
 * @param independent - 冻结的独立权利要求文本。
 * @param optional - 可选特征表。
 * @param current - 当前确定性从权。
 * @param revisionHint - 反套话回退提示；非空时只允许调整从权表述。
 * @param temperature - 采样温度。
 * @param signal - 取消信号。
 * @returns 专员输出或降级原因。
 */
async function specializeDependents(
  provider: StageExecuteInput['provider'],
  independent: string,
  optional: readonly StrategyFeature[],
  current: readonly DraftedClaim[],
  revisionHint: string,
  temperature: number,
  signal: AbortSignal | undefined,
): Promise<SpecialistOutcome> {
  const optionalLines = optional
    .map(feature => `${feature.id}${feature.kind !== undefined ? `（${feature.kind}）` : ''} ${feature.text}`)
    .join('\n')
  const currentLines = current.map(claim => `${String(claim.number)}. ${claim.text}`).join('\n')
  const prompt = [
    '你是从属权利要求专员。独立权利要求已冻结，你只能重排或补充从属权利要求。',
    '要求：',
    '- 不得改写、删减或新增独立权利要求；不得新增独立权利要求；',
    '- 每条从权必须引用编号更小的在先权利要求，编号从 2 起连续；',
    '- 附加技术特征只能来自给定可选特征表；text 只写该特征增加的限定，引用句由程序渲染；',
    '- feature_id 必须来自可选特征表，用于把成文回映射到策略表；',
    '- 不得引入可选特征表之外的技术内容。',
    revisionHint.trim().length > 0 ? '- 上一轮反套话评审要求修订：只调整从权表述，不得改变特征归属。' : '',
    '',
    '【冻结的独立权利要求】',
    dataBlock(independent),
    '',
    '【可选特征表】',
    dataBlock(optionalLines),
    '',
    '【当前从权（确定性渲染）】',
    dataBlock(currentLines),
    revisionHint.trim().length > 0 ? `【反套话修订提示】\n${dataBlock(revisionHint)}` : '',
    '',
    '请严格输出 JSON：dependents 为从权数组（number、parent、feature_id、text），notes 可选。',
  ].filter(line => line !== '').join('\n')
  const res = await callLlm(provider, 'draft-claims/dependents', prompt, { schema: DEPENDENTS_SCHEMA, temperature }, signal)
  if (!res.ok) return { applied: false, reason: '从权专员调用失败，保留确定性从权' }
  const read = readSpecialistOutput(res.raw, optional)
  if (typeof read === 'string') return { applied: false, reason: `从权专员输出不可用（${read}），保留确定性从权` }
  return { applied: true, dependents: read }
}

/**
 * 汇总 lint 发现的可读原因。
 * @param report - claim_lint 报告。
 * @returns 前三条 error 的说明。
 */
function lintReason(report: ClaimLintReport): string {
  const errors = report.findings.filter(finding => finding.severity === 'error')
  const listed = errors.slice(0, 3).map(finding => `权${String(finding.claim)} ${finding.rule}: ${finding.message}`)
  return `claim_lint 否决本轮草稿（${String(report.errorCount)} 项 error）：${listed.join('；')}`
}

/**
 * 渲染复核上下文：特征表、从权树与权利要求草稿。
 * @param strategyReport - `claim_strategy_report` 文本。
 * @param claimsText - 权利要求全文。
 * @returns 审批门展示的复核上下文。
 */
function renderReviewContext(strategyReport: string, claimsText: string): string {
  return [
    '披露分析报告、权利要求与说明书草案需人工复核后方可交付。',
    '',
    '【权利要求策略表】',
    strategyReport,
    '',
    '【权利要求草稿】',
    claimsText,
  ].join('\n')
}

/** draft-claims 执行器：读策略表、确定性渲染、从权专员与形式否决。 */
export class DraftClaimsHandler implements StageHandler {
  readonly name = 'draft-claims'
  readonly category = 'extract' as const

  /**
   * 执行 draft-claims 阶段，返回下一管线状态。
   * @param execInput - 阶段执行输入（state 携带策略表与可选修订提示）。
   * @returns 下一管线状态（可能带降级标记）。
   */
  async execute(execInput: StageExecuteInput): Promise<PipelineState> {
    const { state, provider, signal } = execInput
    const tuned = readAtomTunables(state, { temperature: 0.1, promptLimit: 8000 })
    if (!tuned.ok) return degraded('draft-claims', tuned.reason)
    const { temperature } = tuned.tunables
    const raw = readStateText(state, 'claim_strategy')
    if (raw === undefined) return degraded('draft-claims', '输入为空（state.claim_strategy 缺失，需先执行 claim-strategy）')
    const parsed = parseStrategy(raw)
    if (typeof parsed === 'string') return degraded('draft-claims', parsed)
    const tree = buildTree(parsed)
    if (typeof tree === 'string') return degraded('draft-claims', tree)
    const hint = getStateString(state, 'slop_revision_hint')
    const maxClaims = state['max_claims']
    const maxClaimCount = typeof maxClaims === 'number' && Number.isInteger(maxClaims) && maxClaims > 0 ? maxClaims : undefined

    const deterministic = draftClaims({
      invention_name: parsed.invention_name,
      tech_domain: parsed.tech_domain,
      technical_features: parsed.essential.map(feature => feature.text),
      ...(tree.length > 0 ? { dependent_tree: tree } : {}),
      ...(parsed.prior_art_text.trim().length > 0 ? { prior_art: parsed.prior_art_text } : {}),
      ...(maxClaimCount !== undefined ? { max_claims: maxClaimCount } : {}),
    })

    let specialist: SpecialistOutcome = { applied: false, reason: '未配置 LLM，保留确定性从权' }
    const independentClaims = deterministic.claims.slice(0, 1)
    const dependentClaims = deterministic.claims.slice(1)
    let claims = deterministic.claims
    if (provider !== undefined && dependentClaims.length > 0) {
      specialist = await specializeDependents(
        provider,
        independentClaims.map(claim => claim.text).join(''),
        parsed.optional,
        dependentClaims,
        hint,
        temperature,
        signal,
      )
      if (specialist.applied) {
        claims = [...independentClaims, ...renderSpecialistDependents(specialist.dependents, parsed.invention_name)]
      }
    } else if (dependentClaims.length === 0) {
      specialist = { applied: false, reason: '没有从属权利要求，跳过从权专员' }
    }

    const violations: ClaimViolation[] = [
      ...validateClaims(claims),
      ...claimCountViolations(claims.length, maxClaimCount),
    ]
    const blocking = violations.find(violation => violation.severity === 'error')
    if (blocking !== undefined) {
      return degraded('draft-claims', `形式校验否决本轮草稿：${blocking.rule} ${blocking.message}`)
    }

    const claimsText = renderClaims(claims)
    const lint = lintClaimText(claimsText, maxClaimCount !== undefined ? { maxClaims: maxClaimCount } : {})
    if (!lint.passed) return degraded('draft-claims', lintReason(lint))

    const strategyReport = getStateString(state, 'claim_strategy_report')
    const result = {
      strategy: {
        essential: parsed.essential.map(feature => feature.id),
        optional: parsed.optional.map(feature => feature.id),
        dependent_tree: parsed.nodes,
      },
      specialist: specialist.applied ? 'applied' : 'skipped',
      ...(specialist.applied ? {} : { specialist_reason: specialist.reason }),
      violations,
      lint: {
        errors: lint.errorCount,
        warnings: lint.warningCount,
        findings: lint.findings,
      },
      claims,
    }
    return {
      claims_draft: claimsText,
      draft_claims_result: JSON.stringify(result),
      review_context: renderReviewContext(strategyReport, claimsText),
    }
  }
}
