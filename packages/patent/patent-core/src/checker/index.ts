/**
 * src/patent/checker — dual-track 确定性规则检查引擎。
 *
 * 引擎与规则门端口随本包发布，规则语料由规则包提供（当前为
 * `@deepseek-ai/dsh-patent-rule` 的 71 条 checker 规则）。使用示例：
 * ```ts
 * import { RuleEngine, aggregate } from "./checker/index.ts";
 * const engine = new RuleEngine();
 * engine.registerMany(rules); // rules 由规则包注入
 * const failures = engine.evaluate(text, { domain: "patent_novelty" });
 * const verdict = aggregate(failures); // "pass" | "needs_revision" | "blocked"
 * ```
 */

export type {
  CheckRule,
  CheckType,
  RuleCheckResult,
  RuleEngineOptions,
  RuleLevel,
  Severity,
  Verdict,
} from './types.ts'
export { LevelMust, LevelQuality, LevelShould } from './types.ts'

export {
  RuleEngine,
  aggregate,
  formatRuleResults,
  matchKeyword,
  matchKeywordsAll,
  matchKeywordsAny,
} from './engine.ts'

export {
  type RuleEvaluator,
  type RuleGateAssessment,
  type RuleGateRequest,
} from './evaluator.ts'

export * from './constants.ts'
