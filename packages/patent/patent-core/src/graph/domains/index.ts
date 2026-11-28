/**
 * src/patent/graph/domains — 三性领域子图 barrel。
 *
 * 每个子图构建函数返回 GraphBuilder（调用方 compile 后 run），
 * 附提取结论的辅助函数（供工具层/评测读取结构化结果）。
 */

import { buildNoveltyGraph, type BuildNoveltyGraphOptions } from './novelty.ts'
import {
  buildInventivenessGraph,
  extractInventivenessResult,
  type BuildInventivenessGraphOptions,
} from './inventiveness.ts'
import {
  buildEnablementGraph,
  extractEnablementResult,
  detectTechnicalDomain,
  type BuildEnablementGraphOptions,
} from './enablement.ts'
import {
  PATENT_NUMBER_RE,
  buildCitationCheckGraph,
  checkCitations,
  extractCitationCheckResult,
  extractCitationIds,
  extractDocIds,
  type BuildCitationCheckGraphOptions,
} from './citation-check.ts'

export {
  evaluateRuleGate,
  handlerNode,
  llmNode,
  requireRuleEvaluator,
  ruleGateNode,
  collectStateText,
  resolveInput,
} from './shared.ts'
export type {
  LlmNodeOptions,
  RuleGateNodeOptions,
  RuleGateOptions,
  RuleGateState,
  RuleGateStatus,
} from './shared.ts'
export { buildNoveltyGraph, type BuildNoveltyGraphOptions }
export { buildInventivenessGraph, extractInventivenessResult, type BuildInventivenessGraphOptions }
export { buildEnablementGraph, extractEnablementResult, detectTechnicalDomain, type BuildEnablementGraphOptions }
export {
  PATENT_NUMBER_RE,
  buildCitationCheckGraph,
  checkCitations,
  extractCitationCheckResult,
  extractCitationIds,
  extractDocIds,
  type BuildCitationCheckGraphOptions,
}

/** 领域子图注册表（单一数据源：工具层/评测按名取构建函数与入口节点）。 */
export const DOMAIN_GRAPHS = {
  novelty: { build: buildNoveltyGraph, entry: 'extract' },
  inventiveness: { build: buildInventivenessGraph, entry: 'parse' },
  enablement: { build: buildEnablementGraph, entry: 'load' },
  'citation-check': { build: buildCitationCheckGraph, entry: 'check' },
} as const

/** 领域子图名（工具层 graph 参数枚举）。 */
export type DomainGraphName = keyof typeof DOMAIN_GRAPHS
