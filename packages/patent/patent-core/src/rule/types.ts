/**
 * 宪法规则引擎 — 协议层（类型契约）。
 *
 * 引入自 BCIP codex-patent-constitutional 的设计：以声明式规则（YAML）描述
 * "AI 在生成/执行时必须遵守的约束"，由引擎逐条对文本做确定性检查。
 *
 * 规则生命周期：资产 YAML（rules/**）→ RuleLoader 加载校验 → RuleEngine 评估
 * → 按 action 分发到输出门禁（review/warn）或工具拦截（block）。
 */

export type RuleSeverity = 'critical' | 'major' | 'minor'

/**
 * 规则动作语义：
 *   - block  ：强制拦截（工具调用前拒绝；输出门禁中视为最高级违规）
 *   - review ：挂起人工审批（输出门禁 → DeferredPersist 语义）
 *   - warn   ：仅追加提示，不阻断
 *   - log    ：仅记录，不改变行为
 */
export type RuleAction = 'block' | 'warn' | 'review' | 'log'

/** 检查类型标识（对齐 BCIP RuleCheck 的 tagged enum 设计）。 */
export type RuleCheckType =
  | 'keyword_blocklist'
  | 'pattern_analysis'
  | 'structural_analysis'
  | 'citation_analysis'
  | 'synonym_match'
  | 'quote_repetition'
  | 'empty_section'
  | 'sentence_repetition'
  | 'notice_ground_coverage'
  | 'unraised_statute_citation'

/**
 * keyword_blocklist — 关键词黑名单。
 * 每个条目为一组用 `|` 分隔的关键词（OR 语义），文本命中任意一组即违规。
 * 示例：["赌博|博彩|赌场", "克隆人|人类胚胎"]
 */
export type KeywordBlocklistCheck = {
  type: 'keyword_blocklist'
  keywords: string[]
  /** 否定语境过滤：命中位置前出现 "防止/避免/不用于/排除" 等否定词时放行（"防止赌博"不排除）。 */
  negationContext?: boolean
  /**
   * 领域紧邻前缀词：本域专有的复合主题前缀（如安防主题的「防/反/抑制/检测」）。
   *
   * 与 `negationContext` 正交：本字段只提供词，**不**开启过滤——必须同时声明
   * `negationContext: true`，否则放行词不生效（该组合在加载校验期告警，不静默吞掉）。
   *
   * 语义是**紧邻**，与 `negationContext` 的 24 字窗口词不同：只在该词紧接命中位置
   * 之前时豁免——「防窃听」的「防」与其后的「窃听」合成一个复合主题。隔开若干字就
   * 不再是同一个词，故不走窗口：那会让「检测用户行为，诱导其参与赌博」中的
   * 「检测」旁路放行红线命中（公序良俗告警静默丢失）。后缀式写法（如「窃听检测」
   * 中的「检测」）同样不在豁免范围内。
   *
   * 领域词走本字段而不加进共享默认词表，是因为后者是**全局**词表：加一个词会同时放大
   * 所有否定语境规则（PAT-RISK-001 / PAT-ABS-001 / INV-EVIDENCE-001 …）的放行面。
   */
  additionalNegationWords?: string[]
  /**
   * 引文豁免：命中位置落在成对引号（`「」` / `『』` / `“”`）的引述范围内时放行。
   *
   * 用于规则词是**被引述内容**而非本模型断言的情形：答复书逐字引用审查意见
   * （如通知书的「需要一定的时间」）时，命中的是审查员的措辞，不是申请人自己的
   * 绝对化断言。未闭合的引号不产生豁免（宁可误报，不静默放行红线）。
   */
  quoteImmune?: boolean
  /** 命中时覆盖的严重级别（缺省用规则级 severity）。 */
  severityIfFound?: RuleSeverity
}

/** pattern_analysis — 正则模式分析（case-insensitive）。 */
export type PatternAnalysisCheck = {
  type: 'pattern_analysis'
  patterns: string[]
  /** 最少命中次数（缺省 1）。 */
  minMatches?: number
}

/** structural_analysis — 结构要素分析：requiresAll 中每个要素须命中其 patterns 之一。 */
export type StructuralElement = {
  /** 要素名，如 "technical_means" / "technical_problem" / "technical_effect"。 */
  element: string
  description?: string
  patterns: string[]
}

/** structural_analysis 检查：requiresAll 中每个要素须命中其 patterns 之一。 */
export type StructuralAnalysisCheck = {
  type: 'structural_analysis'
  requiresAll: StructuralElement[]
  /** 最低置信度 0-1 = 命中要素数 / 总要素数；低于则违规（对齐 BCIP min_confidence）。 */
  minConfidence?: number
}

/**
 * citation_analysis — 法条引用范围核验：引用条号不得超过该法的条号上限。
 * 随包规则不写死上限，评估时改读法条索引的 `maxArticle`；测试夹具仍可写 `max`。
 * 没有主题相关性判定；声明 `topics` 的规则会在加载期被拒绝。
 */
export type CitationAnalysisCheck = {
  type: 'citation_analysis'
  /** 法条名 → 可选的显式上限。缺省时用索引里的 `maxArticle`。 */
  statutes: Record<string, { max?: number }>
}

/**
 * synonym_match — 同义词展开要素分析（移植自 Mady CheckRule 的 RequiredElements）。
 * requirements 中每个要素的 keywords 任一命中（关键词本身 OR 其同义词，否定语境豁免）
 * 即视为满足；与 structural_analysis 的差异在于是同义词语义匹配而非正则。
 * 同义词表资产：rules/patent/synonyms.yaml（由消费方注入 SynonymMap）。
 */
export type SynonymMatchCheck = {
  type: 'synonym_match'
  requirements: SynonymRequirement[]
  /** 最低置信度 0-1 = 命中要素数 / 总要素数；低于则违规。 */
  minConfidence?: number
}

/** synonym_match 的单条要素（element + keywords；keywords 中任一命中即满足）。 */
export type SynonymRequirement = {
  element: string
  description?: string
  keywords: string[]
}

/**
 * quote_repetition — 引文重复检测。
 *
 * 成对引号（`「」` / `『』` / `“”`）内的引述片段达到 `minLength` 时统计出现次数，
 * 同一片段（忽略空白与省略号后逐字相同）出现达到 `minOccurrences` 次即违规。
 * 用于答复类文书的「重复引证」缺陷：同一段原文被反复整段复述，篇幅增长而论证不增。
 */
export type QuoteRepetitionCheck = {
  type: 'quote_repetition'
  /** 计入统计的引文最短长度（字符；缺省 12）。 */
  minLength?: number
  /** 同一引文重复出现多少次即违规（缺省 2）。 */
  minOccurrences?: number
}

/**
 * notice_ground_coverage — 双输入检查：答复正文对通知书各条驳回理由的覆盖。
 *
 * 需要「通知书解析结果 + 答复正文」两项输入（`rule_check` 的 `notice` 入参）；
 * 单文本评估一律跳过（`evaluateRule` 返回 null），由 `evaluateDualRule` 执行。
 */
export type NoticeGroundCoverageCheck = {
  type: 'notice_ground_coverage'
}

/**
 * unraised_statute_citation — 双输入检查：答复引用通知书未提出的驳回条款。
 *
 * 与 {@link NoticeGroundCoverageCheck} 同属双输入族（判据需要通知书已提条款作对照）；
 * 通知书未识别到具体条款时不评估，避免把"没解析出来"当成"没提出"。
 */
export type UnraisedStatuteCitationCheck = {
  type: 'unraised_statute_citation'
}

/**
 * empty_section — 空节检测：小节标题后没有正文。
 *
 * 同时识别两种标题语法：Markdown ATX（`## 标题`）与 HTML（`<h2>标题</h2>`）。一个
 * 标题到下一个标题之间（或到文末）去掉标签、列表/引用标记与表格分隔行后若无可见
 * 文字，或整段只是「无」一类占位语，即为空节。只含子标题的父节不算空——正文全在
 * 子节里是正常的层级结构。
 *
 * 与 `pattern_analysis` 的分工：本检查需要「标题 ↔ 正文」的配对关系，正则拿不到行
 * 锚点（引擎按无 `m` 标志编译，`^`/`$` 只锚全文首尾），写出来的模式会把相邻标题
 * 误当成空节，或漏掉标题后只有占位语的形态。
 */
export type EmptySectionCheck = {
  type: 'empty_section'
  /** 计入判定的最低标题层级（1-6，缺省 2：文档总标题不算小节）。 */
  minLevel?: number
  /**
   * 视同「没有正文」的占位语，逐字相等才算命中（缺省「无」「无内容」「本节无内容」
   * 「暂无」「略」「N/A」「—」）。比较前两侧都去空白、括号与句末标点，"（无）。"与
   * "无"是同一项。不收「不适用」：带理由的「不适用」是有内容的答复。
   */
  placeholders?: string[]
}

/**
 * sentence_repetition — 同一句话（通常是一个结论）在全文反复出现。
 *
 * 按句末标点与换行切句，长度达标的句子按「去掉空白与强调标记后逐字相同」归并，
 * 同一句出现达到阈值即违规。与 `quote_repetition` 的区别：后者只统计成对引号内的
 * 引述片段（重复引证），本检查统计作者自己的句子（换词不改事、同一结论写三遍）。
 */
export type SentenceRepetitionCheck = {
  type: 'sentence_repetition'
  /** 计入统计的最短句长（字符；缺省 12）。 */
  minLength?: number
  /** 同一句出现多少次即违规（缺省 3）。 */
  minOccurrences?: number
}

/** 全部检查类型的判别联合（tagged enum）。 */
export type RuleCheck =
  | KeywordBlocklistCheck
  | PatternAnalysisCheck
  | StructuralAnalysisCheck
  | CitationAnalysisCheck
  | SynonymMatchCheck
  | QuoteRepetitionCheck
  | EmptySectionCheck
  | SentenceRepetitionCheck
  | NoticeGroundCoverageCheck
  | UnraisedStatuteCitationCheck

/** 单条宪法规则（对齐 BCIP ConstitutionalRule）。 */
export type ConstitutionalRule = {
  /** 唯一规则编号，如 "CON-101"。 */
  id: string
  name: string
  description?: string
  /** 适用领域（patent / general 等），用于按域过滤规则。 */
  domain?: string
  /** 生命周期阶段（自由文本，如 "申请前" / "撰写"）。当前只作资产元数据，不参与评估过滤。 */
  phase?: string
  severity: RuleSeverity
  action: RuleAction
  /** 法律/规范依据原文。 */
  legalBasis?: string
  /**
   * Why `legalBasis` is or is not a statute citation.
   * `statute` and `guideline` carry citations `law_verify` must resolve.
   * `judgment` and `practice-note` explain the absence of an article number.
   * `exempt` is a registered exception from the index.
   */
  basisKind?: 'statute' | 'guideline' | 'judgment' | 'practice-note' | 'exempt'
  /**
   * 适用前提（正则，任一命中即评估该规则；大小写不敏感；缺省始终评估）。
   *
   * 「缺失即违规」的完整性规则（structural_analysis / synonym_match）只在文本触及
   * 规则主题时才有意义：文本根本没讨论新颖性时，「缺少单独对比」不是缺陷，是规则
   * 不适用。此前这类规则靠 action 降级（block→warn/log）压噪音，但降级不消除噪音
   * ——48 条不适用规则的「要素不完整」仍会淹没真正需要处理的命中，让自检结果不可用。
   * premise 把「该不该评估」与「违规级别」分开：前提不满足 = 不评估（不产生违规），
   * 前提满足 = 按 action 出结果。
   *
   * 前提词表取**主题词汇**（该规则所约束的法律问题或文书主题），不是规则自身要素的
   * 复述：要素是判定标准，前提是话题入口。前提过宽等于没门禁，过窄会让规则在应
   * 生效时沉默——两者都由加载期校验（正则语法与灾难性回溯）与资产评审保证。
   */
  premise?: string[]
  check: RuleCheck
}

/** 规则集（一个 YAML 文件 = 一个 RuleSet）。 */
export type RuleSet = {
  version?: string
  rules: ConstitutionalRule[]
}

/** 单条违规记录。 */
export type RuleViolation = {
  ruleId: string
  ruleName: string
  severity: RuleSeverity
  action: RuleAction
  /** 法律/规范依据原文（透传自规则）。 */
  legalBasis?: string
  /** 面向用户/模型的说明（中文）。 */
  message: string
  /** 命中的原文证据片段。 */
  evidence: string[]
  /**
   * 被检查文本中最早一处计入本次违规的命中所在行号（1 基）。缺项与聚合类检查没有字面
   * 命中，`quote_repetition` 的证据带重复次数、不是原文子串，故都缺省。
   */
  line?: number
  /** 上述命中所在的句子（超长时按命中位置居中截断）；缺省条件与 `line` 相同。 */
  matchedSentence?: string
}

/** 一次评估的结果。 */
export type RuleEvaluation = {
  violations: RuleViolation[]
}

/** 规则集校验问题（加载期诊断）。 */
export type RuleSetValidationIssue = {
  source?: string
  ruleId?: string
  message: string
}

/** 加载器结果：规则集 + 跳过文件警告。 */
export type LoadedRuleSet = {
  ruleSet: RuleSet
  source: string
  warnings: RuleSetValidationIssue[]
}

/**
 * 规则驱动输出门禁的判定结果。
 *
 * `text` 为处理后的文本（warn/block 提示已追加）；`violations` 含全部违规
 * （含 log 级）；`needsApproval` 表示存在 review/block 级违规，需人工审批。
 * `warnHits`/`reviewHits`/`blockHits` 为各 action 命中的规则 id；`evaluation`
 * 保留完整评估结果供调用方审计。
 */
export interface RuleOutputGateResult {
  /** 处理后的文本（已追加 warn/block 提示）。 */
  text: string
  /** 全部违规（含 log 级）。 */
  violations: RuleViolation[]
  /** 是否存在 review/block 级违规（需人工审批）。 */
  needsApproval: boolean
  /** warn 级命中的规则 id。 */
  warnHits: string[]
  /** review 级命中的规则 id。 */
  reviewHits: string[]
  /** block 级命中的规则 id。 */
  blockHits: string[]
  /** 完整评估（含 log 分组）。 */
  evaluation: RuleEvaluation
}

/**
 * 规则驱动的输出门禁接缝。持有 RuleSet 的门禁实现（dsh-patent-rule 的
 * RuleOutputGate 类）满足该结构；消费方（tools/post-execute 接线与
 * patent-teams 的任务收口检查）经运行时注入。
 */
export interface RuleOutputGate {
  /** 评估并处理一段输出文本。 */
  process(text: string): RuleOutputGateResult
}
