/**
 * 事实黑板（移植自 Mady domains/reasoning/fact_blackboard.go）。
 *
 * 法务推理的共享事实记忆：多步骤推理（如五步工作法）各阶段把提取的事实、
 * 推理链、规则约束、法条判定写入黑板，下游阶段消费。软丢弃（DiscardedAt）
 * 支持回退追溯；Lock 后任何修改抛错（程序员误用防护）。
 *
 * TS 单线程无需互斥锁，但保留 locked 语义与 Go 版对齐。
 */

import { isJsonRecord } from '../llm-json.ts'

export type FactCategory = 'technical' | 'legal' | 'procedural' | 'temporal'

/** 单条事实（对齐 Mady FactEntry）。 */
export type FactEntry = {
  id: string
  /** 来源：user_text | file | cnipa_query | manual。 */
  source: string
  content: string
  filePath?: string
  confidence: number
  extractedAt: string
  /** 软丢弃时间（回溯用；非空 = 已丢弃）。 */
  discardedAt?: string
  category?: FactCategory
  tags?: string[]
}

/** 规则约束的强制级别。 */
export type Requirement = 'must' | 'should' | 'note'

/** 规则约束（从法条/审查指南抽取，计划必须满足）。 */
export type RuleConstraint = {
  articleId: string
  articleName: string
  requirement: Requirement
  description: string
  applicableStages?: string[]
}

/** 人工确认状态。 */
export type RuleConfirmation = 'confirmed' | 'modified' | 'rejected'

/** 规则 + 人工确认状态（modified 时用 Modified 覆盖原规则）。 */
export type ConfirmedRuleEntry = {
  rule: RuleConstraint
  status: RuleConfirmation
  modified?: RuleConstraint
  feedback?: string
  confirmedAt?: string
}

/** 人工确认规则集的不可变快照（rejected 条目保留审计但隔离）。 */
export class ConfirmedRuleSet {
  constructor(
    public readonly entries: ConfirmedRuleEntry[],
    public readonly confirmedAt: string,
  ) {}

  /**
   * 下游阶段只消费 confirmed/modified 条目（modified 用编辑版）。
   * @returns 生效的规则约束列表（rejected 条目被隔离不返回）。
   */
  activeConstraints(): RuleConstraint[] {
    const out: RuleConstraint[] = []
    for (const entry of this.entries) {
      if (entry.status === 'confirmed') out.push(entry.rule)
      else if (entry.status === 'modified' && entry.modified !== undefined) out.push(entry.modified)
      // rejected：保留审计，隔离不消费
    }
    return out
  }
}

/** 法条判定（结论 + 依据）。 */
export type ArticleJudgment = {
  articleId: string
  satisfied: boolean
  reasoning: string
  confidence: number
  judgedAt: string
}

/** 推理链节点与链（结论 + 支持/矛盾证据引用）。 */
export type ReasoningChainNode = {
  step: number
  type: string
  content: string
  factRefs: string[]
}

/** 推理链：节点序列 + 结论 + 置信度。 */
export type ReasoningChain = {
  id: string
  nodes: ReasoningChainNode[]
  conclusion: string
  confidence: number
}

/** 事实黑板构造选项。 */
export type FactBlackboardOptions = {
  caseId: string
  caseType: string
  technicalField?: string
  createdAt?: string
  now?: () => string
}

/**
 * 事实黑板。所有变更方法在 Lock 后抛错（防误用，对齐 Mady checkNotLocked）。
 */
export class FactBlackboard {
  /** 案例标识。 */
  readonly caseId: string
  /** 案例类型。 */
  readonly caseType: string
  /** 技术领域（可为空字符串）。 */
  readonly technicalField: string
  /** 创建时间。 */
  readonly createdAt: string
  /** 最近变更时间。 */
  updatedAt: string
  /** 是否已锁定（锁定后任何修改抛错）。 */
  locked = false

  private readonly facts: FactEntry[] = []
  private readonly reasoningChains: ReasoningChain[] = []
  private readonly ruleConstraints: RuleConstraint[] = []
  private readonly articleJudgments = new Map<string, ArticleJudgment>()
  private confirmedRules: ConfirmedRuleSet | undefined
  private readonly now: () => string

  constructor(options: FactBlackboardOptions) {
    const ts = options.now !== undefined ? options.now() : new Date().toISOString()
    this.caseId = options.caseId
    this.caseType = options.caseType
    this.technicalField = options.technicalField ?? ''
    this.createdAt = options.createdAt ?? ts
    this.updatedAt = ts
    this.now = options.now ?? (() => new Date().toISOString())
  }

  private touch(): void {
    this.updatedAt = this.now()
  }

  private checkNotLocked(): void {
    if (this.locked) throw new Error('factBlackboard: attempt to mutate a locked blackboard')
  }

  /** 锁定黑板：之后任何变更方法抛错（防误用）。 */
  lock(): void {
    this.locked = true
    this.touch()
  }

  /**
   * 查询锁定状态。
   * @returns 黑板是否已锁定。
   */
  isLocked(): boolean {
    return this.locked
  }

  // -------------------------------------------------------------------------
  // Facts
  // -------------------------------------------------------------------------

  /**
   * 全部事实（含已丢弃）的深拷贝。
   * @returns 全部事实列表。
   */
  allFacts(): FactEntry[] {
    return structuredClone(this.facts)
  }

  /**
   * 仅未丢弃的事实（深拷贝：外部修改不得绕过 Lock 防护）。
   * @returns 未丢弃的事实列表。
   */
  activeFacts(): FactEntry[] {
    return structuredClone(this.facts.filter(f => f.discardedAt === undefined))
  }

  /**
   * 添加一条事实（深拷贝后入列）。
   * @param fact - 待添加的事实条目。
   */
  addFact(fact: FactEntry): void {
    this.checkNotLocked()
    this.facts.push(structuredClone(fact))
    this.touch()
  }

  /**
   * 按 id 查询事实（深拷贝）。默认不返回已丢弃的事实：软丢弃后仍允许它支撑
   * 三段论，等于让回溯删掉的事实继续生效。需要读取历史时显式传 `includeDiscarded`。
   * @param id - 事实标识。
   * @param options - `includeDiscarded` 为 true 时同时匹配已丢弃的事实。
   * @returns 匹配的事实条目；不存在或已丢弃（未要求包含）时为 undefined。
   */
  getFact(id: string, options?: { includeDiscarded?: boolean }): FactEntry | undefined {
    const includeDiscarded = options?.includeDiscarded === true
    const fact = this.facts.find(f => f.id === id && (includeDiscarded || f.discardedAt === undefined))
    return fact !== undefined ? structuredClone(fact) : undefined
  }

  /**
   * 软丢弃（回溯时保留历史，IsDiscarded 语义）。
   * @param id - 待丢弃的事实标识。
   */
  discardFact(id: string): void {
    this.checkNotLocked()
    const fact = this.facts.find(f => f.id === id)
    if (fact !== undefined && fact.discardedAt === undefined) {
      fact.discardedAt = this.now()
      this.touch()
    }
  }

  // -------------------------------------------------------------------------
  // Reasoning chains
  // -------------------------------------------------------------------------

  /**
   * 全部推理链的深拷贝。
   * @returns 全部推理链列表。
   */
  chains(): ReasoningChain[] {
    return structuredClone(this.reasoningChains)
  }

  /**
   * 添加一条推理链。
   * @param chain - 待添加的推理链。
   */
  addReasoningChain(chain: ReasoningChain): void {
    this.checkNotLocked()
    this.reasoningChains.push(chain)
    this.touch()
  }

  // -------------------------------------------------------------------------
  // Rule constraints & confirmed set
  // -------------------------------------------------------------------------

  /**
   * 全部规则约束的深拷贝。
   * @returns 全部规则约束列表。
   */
  constraints(): RuleConstraint[] {
    return structuredClone(this.ruleConstraints)
  }

  /**
   * 添加一条规则约束。
   * @param constraint - 待添加的规则约束。
   */
  addRuleConstraint(constraint: RuleConstraint): void {
    this.checkNotLocked()
    this.ruleConstraints.push(constraint)
    this.touch()
  }

  /**
   * 整体替换规则约束列表。
   * @param constraints - 新的规则约束列表。
   */
  setRuleConstraints(constraints: RuleConstraint[]): void {
    this.checkNotLocked()
    this.ruleConstraints.length = 0
    this.ruleConstraints.push(...constraints)
    this.touch()
  }

  /**
   * 人工确认的规则集（Stage ② 后）；未确认时为 undefined。
   * @returns 人工确认规则集；未确认时为 undefined。
   */
  getConfirmedRules(): ConfirmedRuleSet | undefined {
    return this.confirmedRules
  }

  /**
   * 设置人工确认的规则集。
   * @param ruleSet - 待设置的确认规则集。
   */
  setConfirmedRules(ruleSet: ConfirmedRuleSet): void {
    this.checkNotLocked()
    this.confirmedRules = ruleSet
    this.touch()
  }

  /**
   * 下游阶段消费的规则约束：确认后只用 active 条目，未确认时回退原始约束。
   * @returns 当前生效的规则约束列表。
   */
  confirmedRuleConstraints(): RuleConstraint[] {
    return this.confirmedRules !== undefined ? this.confirmedRules.activeConstraints() : [...this.ruleConstraints]
  }

  // -------------------------------------------------------------------------
  // Article judgments
  // -------------------------------------------------------------------------

  /**
   * 写入（覆盖）一条法条判定。
   * @param judgment - 待写入的法条判定。
   */
  setArticleJudgment(judgment: ArticleJudgment): void {
    this.checkNotLocked()
    this.articleJudgments.set(judgment.articleId, judgment)
    this.touch()
  }

  /**
   * 按法条 ID 查询判定。
   * @param articleId - 法条标识。
   * @returns 匹配的法条判定；不存在时为 undefined。
   */
  getArticleJudgment(articleId: string): ArticleJudgment | undefined {
    return this.articleJudgments.get(articleId)
  }

  // -------------------------------------------------------------------------
  // 序列化（JSON 可持久化，供检查点/恢复）
  // -------------------------------------------------------------------------

  /**
   * 序列化为 JSON 文本（供检查点/恢复）。
   * @returns 黑板状态的 JSON 字符串。
   */
  toJSON(): string {
    return JSON.stringify({
      caseId: this.caseId,
      caseType: this.caseType,
      technicalField: this.technicalField,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      locked: this.locked,
      facts: this.facts,
      reasoningChains: this.reasoningChains,
      ruleConstraints: this.ruleConstraints,
      articleJudgments: [...this.articleJudgments.entries()],
      confirmedRules:
        this.confirmedRules !== undefined
          ? { entries: this.confirmedRules.entries, confirmedAt: this.confirmedRules.confirmedAt }
          : undefined,
    })
  }

  /**
   * 反序列化（now 可选：注入自定义时钟保持时间确定性，缺省用真实时钟）。
   * @param text - 待解析的 JSON 文本。
   * @param now - 可选时钟注入；缺省用真实时钟。
   * @returns 反序列化得到的黑板实例。
   */
  static fromJSON(text: string, now?: () => string): FactBlackboard {
    const parsed: unknown = JSON.parse(text)
    if (!isJsonRecord(parsed)) {
      throw new Error('fact blackboard 记录损坏：顶层不是 JSON 对象')
    }
    // 持久化边界：缺字段时 `for...of undefined` 会抛原始 TypeError，恢复方拿不到
    // "这是损坏记录"的信号；先按字段校验，错误信息直接点名坏在哪里。
    const requireArray = (key: string): void => {
      if (!Array.isArray(parsed[key])) throw new Error(`fact blackboard 记录损坏：${key} 不是数组`)
    }
    const data = parsed as {
      caseId: string
      caseType: string
      technicalField?: string
      createdAt: string
      updatedAt: string
      locked: boolean
      facts: FactEntry[]
      reasoningChains: ReasoningChain[]
      ruleConstraints: RuleConstraint[]
      articleJudgments: Array<[string, ArticleJudgment]>
      confirmedRules?: { entries: ConfirmedRuleEntry[]; confirmedAt: string }
    }
    requireArray('facts')
    requireArray('reasoningChains')
    requireArray('ruleConstraints')
    requireArray('articleJudgments')
    const bb = new FactBlackboard({
      caseId: data.caseId,
      caseType: data.caseType,
      ...(data.technicalField !== undefined ? { technicalField: data.technicalField } : {}),
      createdAt: data.createdAt,
      ...(now !== undefined ? { now } : {}),
    })
    bb.updatedAt = data.updatedAt
    bb.locked = data.locked
    for (const fact of data.facts) bb.facts.push(fact)
    for (const chain of data.reasoningChains) bb.reasoningChains.push(chain)
    for (const constraint of data.ruleConstraints) bb.ruleConstraints.push(constraint)
    for (const [id, judgment] of data.articleJudgments) bb.articleJudgments.set(id, judgment)
    if (data.confirmedRules !== undefined) {
      bb.confirmedRules = new ConfirmedRuleSet(data.confirmedRules.entries, data.confirmedRules.confirmedAt)
    }
    return bb
  }
}
