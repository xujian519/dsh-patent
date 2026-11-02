/**
 * Deterministic claim drafting: feature table → independent claim → dependent
 * claim tree, plus formal validation.
 *
 * The workflow's `draft-claims` atom consumes this module so claim text never
 * comes from free-form model prose; the model-facing `draft_claims` tool in
 * `@deepseek-ai/dsh-patent-tools` is a thin projection over the same engine.
 *
 * @module @deepseek-ai/dsh-patent-core/claim-draft
 */

/** Patent technical domain (mechanical / electrical / chemical / software / general). */
export type TechDomain = 'mechanical' | 'electrical' | 'chemical' | 'software' | 'general'

/** Patent type (invention or utility model). */
export type PatentType = 'invention' | 'utility_model'

/**
 * One dependent claim in an explicit claim tree: its number, the claim(s) it
 * cites, and the additional feature it adds. `feature_id` carries the strategy
 * table's feature id so a caller can map the rendered claim back to that table.
 */
export type DependentClaimNode = {
  /** Claim number, 2 or greater, unique across the tree. */
  number: number
  /** Claim number cited by this claim; an array renders as an alternative citation ("或"). */
  parent: number | readonly number[]
  /** The additional technical feature this claim adds. */
  text: string
  /** Strategy-table feature id this claim's text comes from. */
  feature_id?: string
}

/** Input for deterministic claim drafting. */
export type DraftClaimsInput = {
  /** Invention title. */
  invention_name: string
  /** Technical domain (auto-detected when empty). */
  tech_domain?: TechDomain
  /** Essential technical features (for the independent claim). */
  technical_features: string[]
  /**
   * Optional/additional technical features, rendered as a linear chain of
   * dependent claims. Mutually exclusive with `dependent_tree`.
   */
  optional_features?: string[]
  /**
   * Explicit dependent-claim tree for multi-branch citations. Mutually
   * exclusive with `optional_features`.
   */
  dependent_tree?: readonly DependentClaimNode[]
  /** Closest prior-art description (optional, for the preamble). */
  prior_art?: string
  /**
   * Claim-count ceiling fixed by the drafting instruction (user or case
   * requirement). Exceeding it is an error: a ceiling an instructing party set
   * is an acceptance condition, not a cost trade-off.
   */
  max_claims?: number
}

/** One drafted claim (independent or dependent). */
export type DraftedClaim = {
  number: number
  type: 'independent' | 'dependent'
  text: string
  /** Cited claim number(s); an array is an alternative citation. */
  refersTo?: number | number[]
  /** Strategy-table feature id of a dependent claim built from `dependent_tree`. */
  featureId?: string
}

/** One formal-validity violation found in drafted claims. */
export type ClaimViolation = {
  rule: string
  severity: 'error' | 'warning'
  claimNumber?: number
  message: string
  suggestion?: string
}

/** Output of deterministic claim drafting. */
export type DraftClaimsOutput = {
  invention_name: string
  tech_domain: TechDomain
  claims: DraftedClaim[]
  violations: ClaimViolation[]
  warnings: string[]
}

/** Rejection message for a request that supplies both dependent-claim sources. */
export const CLAIM_SOURCE_EXCLUSIVE_MESSAGE =
  'dependent_tree 与 optional_features 互斥：一次撰写只接受一种从属权利要求来源'

/**
 * Rejected drafting request: the caller supplied mutually exclusive inputs.
 * Tool wrappers may translate it into their own error vocabulary.
 */
export class ClaimDraftError extends Error {
  /**
   * @param message - the rejected combination, naming both inputs.
   */
  constructor(message: string) {
    super(message)
    this.name = 'ClaimDraftError'
  }
}

/** Vague qualifiers (clarity rule). */
const VAGUE_TERMS = ['约', '大致', '可能', '优选', '例如', '大约', '左右']

/** Domain → claim-structure templates. */
const DOMAIN_STRUCT: Record<
  TechDomain,
  { head: (name: string) => string; connector: string; withPriorConnector: string; priorConnector: string }
> = {
  mechanical: { head: name => `一种${name}，`, connector: '其特征在于，包括：', withPriorConnector: '其特征在于，还包括：', priorConnector: '包括：' },
  electrical: { head: name => `一种${name}，`, connector: '其特征在于，包括：', withPriorConnector: '其特征在于，还包括：', priorConnector: '包括：' },
  chemical: { head: name => `一种${name}，`, connector: '其特征在于，包含：', withPriorConnector: '其特征在于，还包含：', priorConnector: '包含：' },
  software: { head: name => `一种${name}的实现方法，`, connector: '其特征在于，包括以下步骤：', withPriorConnector: '其特征在于，还包括以下步骤：', priorConnector: '包括以下步骤：' },
  general: { head: name => `一种${name}，`, connector: '其特征在于，包括：', withPriorConnector: '其特征在于，还包括：', priorConnector: '包括：' },
}

/** Domain keywords → auto-detected technical domain (shared with draft_specification). */
export const DOMAIN_KEYWORDS: Array<{ domain: TechDomain; keywords: string[] }> = [
  { domain: 'chemical', keywords: ['组分', '化合物', '合成', '催化剂', '溶液', '材料组合物', '重量份'] },
  { domain: 'software', keywords: ['步骤', '算法', '数据', '模块', '接口', '处理器执行', '电子设备'] },
  { domain: 'electrical', keywords: ['电路', '电源', '信号', '传感器', '控制器', '芯片', '电压'] },
  { domain: 'mechanical', keywords: ['壳体', '齿轮', '轴承', '支架', '轴', '弹簧', '连接件', '传动'] },
]

/** JSON Schema fragment for a dependent claim's cited parent(s). */
export const PARENT_SCHEMA = {
  oneOf: [
    { type: 'integer' },
    { type: 'array', items: { type: 'integer' } },
  ],
} as const

/**
 * Render one cited claim or an alternative citation of several ("1或2").
 * @param parents - one claim number or several alternative citations.
 * @param separator - text placed between alternative citations.
 * @returns the citation clause's number text.
 */
export function renderParents(parents: number | readonly number[], separator = '或'): string {
  return typeof parents === 'number' ? String(parents) : parents.join(separator)
}

/**
 * Render an explicit dependent-claim tree in ascending claim-number order.
 * @param name - the invention name used in each claim's citation clause.
 * @param nodes - the tree nodes; their numbers are validated afterwards.
 * @returns one drafted claim per node.
 */
function buildDependentTree(name: string, nodes: readonly DependentClaimNode[]): DraftedClaim[] {
  return [...nodes]
    .sort((left, right) => left.number - right.number)
    .map(node => ({
      number: node.number,
      type: 'dependent',
      refersTo: typeof node.parent === 'number' ? node.parent : [...node.parent],
      text: `根据权利要求${renderParents(node.parent)}所述的${name}，其特征在于，还包括：${node.text.trim()}。`,
      ...(node.feature_id !== undefined ? { featureId: node.feature_id } : {}),
    }))
}

/**
 * Render the independent claim from the essential features.
 * @param name - the invention name.
 * @param domain - resolved technical domain.
 * @param features - essential feature texts.
 * @param priorArt - closest prior-art description; empty when absent.
 * @returns the independent claim text.
 */
function buildIndependentClaim(name: string, domain: TechDomain, features: string[], priorArt: string): string {
  const struct = DOMAIN_STRUCT[domain]
  if (features.length === 0) {
    return `${struct.head(name)}${struct.connector}（缺少必要技术特征）`
  }
  const featurePart = features.join('；')
  if (priorArt && priorArt.length > 0) {
    const normalized = normalizePriorArt(priorArt)
    return `${struct.head(name)}${struct.priorConnector}${normalized}；${struct.withPriorConnector}${featurePart}。`
  }
  if (domain === 'software') {
    return `${struct.head(name)}${struct.connector}${features.join('；')}。`
  }
  return `${struct.head(name)}${struct.connector}${featurePart}。`
}

/**
 * Strip trailing punctuation from prior art to avoid "。；" concatenation.
 * @param priorArt - the prior-art description.
 * @returns the description without trailing claim punctuation.
 */
function normalizePriorArt(priorArt: string): string {
  return priorArt.replace(/[。；;，,]+$/, '')
}

/**
 * Resolve the technical domain from an explicit hint, then keywords.
 * @param hint - caller-provided domain; `general` means "detect".
 * @param name - invention name.
 * @param features - essential feature texts.
 * @returns the resolved domain.
 */
export function resolveDomain(hint: TechDomain | undefined, name: string, features: string[]): TechDomain {
  if (hint && hint !== 'general') return hint
  const haystack = `${name} ${features.join(' ')}`
  for (const entry of DOMAIN_KEYWORDS) {
    if (entry.keywords.some(k => haystack.includes(k))) return entry.domain
  }
  return 'general'
}

/**
 * Formal validation: numbering / trailing period / vague terms / illustration refs / circular refs.
 * @param claims - the drafted claims to validate.
 * @returns the violations found, empty when the draft is clean.
 */
export function validateClaims(claims: DraftedClaim[]): ClaimViolation[] {
  const violations: ClaimViolation[] = []
  claims.forEach((c, i) => {
    if (c.number !== i + 1) {
      violations.push({ rule: 'numbering', severity: 'error', claimNumber: c.number, message: `权利要求未按阿拉伯数字顺序编号（应为 ${i + 1} 号）`, suggestion: '请按 1, 2, 3, ... 的顺序重新编号权利要求' })
    }
  })
  for (const c of claims) {
    if (!c.text.endsWith('。')) {
      violations.push({ rule: 'period', severity: 'error', claimNumber: c.number, message: '权利要求未以句号结尾', suggestion: "在权利要求末尾添加'。'" })
    }
    const vagueHits = VAGUE_TERMS.filter(t => c.text.includes(t))
    if (vagueHits.length > 0) {
      violations.push({ rule: 'clarity', severity: 'warning', claimNumber: c.number, message: `权利要求包含模糊限定词: ${vagueHits.join('、')}`, suggestion: "删除'约/大致/可能/优选/例如'等模糊表述" })
    }
    if (/如图[一二三四五六七八九十\d]+所示|如附图/.test(c.text)) {
      violations.push({ rule: 'no_illustration', severity: 'error', claimNumber: c.number, message: "权利要求中不得包含'如图……所示'等引用附图的表述", suggestion: "删除'如图……所示'等表述，或将其替换为技术特征的直接描述" })
    }
    if (c.type === 'dependent' && c.refersTo !== undefined) {
      const parents = typeof c.refersTo === 'number' ? [c.refersTo] : [...c.refersTo]
      if (parents.length === 0) {
        violations.push({ rule: 'missing_reference', severity: 'error', claimNumber: c.number, message: `从属权利要求 ${c.number} 未引用任何权利要求`, suggestion: '为从属权利要求补上被引用的在先权利要求编号' })
      }
      const illegal = parents.filter(parent => parent < 1 || parent >= c.number)
      if (illegal.length > 0) {
        violations.push({ rule: 'circular_reference', severity: 'error', claimNumber: c.number, message: `从属权利要求 ${c.number} 引用了 ${illegal.join('、')}，形成非法引用`, suggestion: '从属权利要求只能引用编号更小的权利要求' })
      }
    }
  }
  return violations
}

/**
 * Count-based formal violations: the drafting instruction's ceiling and the
 * statutory additional-fee threshold.
 * @param count - number of drafted claims.
 * @param maxClaims - ceiling fixed by the drafting instruction; omitted when none was given.
 * @returns the violations found, empty when the count is within both limits.
 */
export function claimCountViolations(count: number, maxClaims?: number): ClaimViolation[] {
  const violations: ClaimViolation[] = []
  if (maxClaims !== undefined && count > maxClaims) {
    violations.push({
      rule: 'claim_count_cap',
      severity: 'error',
      message: `权利要求共 ${count} 项，超过本次撰写指令的项数上限 ${maxClaims} 项`,
      suggestion: `把权利要求压缩到 ${maxClaims} 项以内：将附加技术特征并入独权或合并从属权利要求，不得以上限只是费用起征线为由保留超项`,
    })
  }
  // 10 项是《专利审查指南》的申请附加费起征线（说明书超过 30 页或权利要求超过 10 项），
  // 不是项数上限：细则第一百一十条第一款第（一）项列明该费种，第一百一十二条要求随申请费按期缴足。
  if (count > 10) {
    violations.push({
      rule: 'additional_fee',
      severity: 'warning',
      message: `权利要求共 ${count} 项，超过 10 项：自第 11 项起需按项缴纳申请附加费（细则第一百一十条第一款第（一）项），未按期缴足该费用的申请视为撤回`,
      suggestion: '合并附加技术特征，将权利要求压缩到 10 项以内以规避申请附加费',
    })
  }
  return violations
}

/**
 * Pure entry point: generate a claim draft plus formal validation.
 * @param input - the claim-drafting request.
 * @returns the drafted claims and validation result.
 * @throws ClaimDraftError when `dependent_tree` and `optional_features` are both non-empty.
 */
export function draftClaims(input: DraftClaimsInput): DraftClaimsOutput {
  const name = input.invention_name.trim()
  const domain = resolveDomain(input.tech_domain, name, input.technical_features)
  const essential = input.technical_features.map(f => f.trim()).filter(Boolean)
  const optional = (input.optional_features ?? []).map(f => f.trim()).filter(Boolean)
  const warnings: string[] = []
  if (essential.length === 0) warnings.push('未提供必要技术特征，独立权利要求无法生成完整技术方案')
  if (name.length > 25) warnings.push(`发明名称 ${name.length} 字，超过 25 字限制`)
  const tree = input.dependent_tree
  if (tree !== undefined && tree.length > 0 && optional.length > 0) {
    throw new ClaimDraftError(CLAIM_SOURCE_EXCLUSIVE_MESSAGE)
  }
  const independentText = buildIndependentClaim(name, domain, essential, input.prior_art?.trim() ?? '')
  const dependents: DraftedClaim[] = tree !== undefined && tree.length > 0
    ? buildDependentTree(name, tree)
    : optional.map((feat, idx) => {
      const number = 2 + idx
      const refersTo = number - 1
      return { number, type: 'dependent', refersTo, text: `根据权利要求${refersTo}所述的${name}，其特征在于，还包括：${feat}。` }
    })
  const claims: DraftedClaim[] = [{ number: 1, type: 'independent', text: independentText }, ...dependents]
  const violations = [...validateClaims(claims), ...claimCountViolations(claims.length, input.max_claims)]
  return { invention_name: name, tech_domain: domain, claims, violations, warnings }
}
