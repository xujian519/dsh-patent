/**
 * `rule_check` tool: run the deterministic constitutional rule engine over text
 * and return violations with severity/action/legal basis. Ported from Sati's
 * ruleCheck.ts; the engine and rule assets live in @deepseek-ai/dsh-patent-rule.
 * @module @deepseek-ai/dsh-patent-tools/tool/rule-check
 */

import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  assetRulesRoot,
  evaluateDualRule,
  evaluateText,
  isDualInputCheck,
  loadPatentComplianceRuleSet,
  loadPatentElectricalRuleSet,
  loadPatentFullRuleSet,
  loadRulePack,
  loadRuleSetDir,
  loadSynonymsAsset,
  mergeRuleSets,
  patentCaseDomains,
  summarizeRulePackLayers,
} from '@deepseek-ai/dsh-patent-rule'
import type { RulePackLoadResult } from '@deepseek-ai/dsh-patent-rule'
import { parseOfficeAction } from '@deepseek-ai/dsh-patent-core'
import type { RuleAction, RuleSeverity, RuleSet, RuleViolation } from '@deepseek-ai/dsh-patent-core'
import type { SynonymMap } from '@deepseek-ai/dsh-patent-rule'
import { PatentToolError } from '../error.ts'
import { requireNonBlankText } from './internal/tool-input.ts'
import { evaluatedTexts, EVALUATED_TEXT_SCHEMA, renderEvaluatedTexts } from '../internal/evaluated-input.ts'
import type { EvaluatedText } from '../internal/evaluated-input.ts'

/** Input for the rule_check tool. */
export type RuleCheckInput = {
  /** The text to check. */
  text: string
  /** Rule-set scope (default "patent" = bundled patent compliance rules). */
  scope?: string
  /**
   * 通知书正文（可选）：提供时就地确定性解析，并评估双输入规则（PR-OA-008 驳回理由
   * 覆盖、PR-OA-009 未提条款引用）；未提供时这些规则不评估，结果中显式列出。
   */
  notice?: string
}

/** One rule violation rendered for the tool output; the canonical fields are owned by patent-core. */
export type RuleViolationView = Pick<
  RuleViolation,
  'ruleId' | 'ruleName' | 'severity' | 'action' | 'legalBasis' | 'message' | 'evidence' | 'line' | 'matchedSentence'
>

/** Output of the rule_check tool. */
export type RuleCheckOutput = {
  scope: string
  violations: RuleViolationView[]
  /**
   * 本次自检是否存在 block 级违规。交付前置门禁据此拒绝把一次“跑了但没通过”的
   * 自检记成前置证据；review 级命中仍由交付时的审批通道处置。
   */
  blocked: boolean
  /** Identity of the text this run evaluated, so another run can be compared with it. */
  evaluated: EvaluatedText[]
  /** Layered pack summary (scope=pack only). */
  packHeader?: string
  packWarnings?: string[]
  /** 因未提供 `notice` 而未评估的双输入规则 id。 */
  dualInputSkipped?: string[]
  /** 提供了 `notice`，但当前 scope 没有可评估的双输入规则时的显式提示。 */
  noticeIgnored?: string
}

/** Injectables mirroring Sati's RuleCheckDeps (tests override; defaults use the bundled assets). */
export type RuleCheckDeps = {
  /** scope → RuleSet loader (default: bundled patent compliance rules). */
  loader?: (scope: string) => RuleSet
  /** Synonym map loader (default: bundled rules/patent/synonyms.yaml). */
  synonyms?: () => SynonymMap
  /** Layered rule-pack loader (default: bundled loadRulePack). */
  pack?: () => RulePackLoadResult
}

/** rule_check supported scopes (shared by the description and the runtime error). */
const AVAILABLE_SCOPES = 'patent, patent-electrical, patent-full, patent-mechanical, patent-software, patent-drafting, patent-analysis, patent-oa-response, patent-invalidation, patent-invalidation-defense, patent-reexamination, patent-infringement, pack'

/** Domain pack a `patent-<domain>` scope adds on top of the full assets. */
const DOMAIN_SCOPES: Readonly<Record<string, string>> = {
  'patent-mechanical': 'mechanical',
  'patent-software': 'software',
}

const DESCRIPTION = [
  'Run deterministic constitutional rule checks (keyword blocklist / pattern / structural / citation range / synonym match / quote repetition)',
  'against the given text and return violations with severity, action and legal basis.',
  'Most rules declare an applicability premise: a rule whose premise does not match the text reports nothing, so a document is only checked against the subjects it actually discusses',
  '(an answer that never touches novelty draws no novelty-completeness findings).',
  'Use before publishing compliance-sensitive output (e.g. patent conclusions, legal opinions).',
  "Scopes: 'patent' (general patent compliance), 'patent-electrical' (H-section electrical rules + general compliance),",
  "'patent-full' (every bundled asset: general compliance + nuo mirrors + hand-written merged rules, activation-reviewed),",
  "a job scope 'patent-drafting' (claim/spec drafting) / 'patent-analysis' (patentability, novelty, inventiveness) / 'patent-oa-response' / 'patent-invalidation' / 'patent-invalidation-defense' / 'patent-reexamination' / 'patent-infringement'",
  "(the 'patent-full' assets restricted to that job's rule domains: its own document plus the clauses it must answer or establish),",
  "a domain scope 'patent-mechanical' or 'patent-software' (the full assets plus that domain's rule pack: argument-completeness rules the general assets do not carry),",
  "or 'pack' (layered rule pack assembled from the project manifest .sati/rules.yaml: base + domains + overrides).",
  'With the office-action notice at hand, a job scope also takes notice=通知书正文: the two dual-input rules (PR-OA-008 驳回理由覆盖 / PR-OA-009 未提条款引用) then run against the response; without notice they are listed as unevaluated.',
  'Every result ends with an 评估输入 line giving the character count and digest of the text this run actually read: keep that line when you transcribe the result, so a later run can show whether it read the same text.',
].join(' ')

/** 处置级别排序：先让硬拦截与待审项出现在前，避免 block 被几十条 warn 淹没。 */
const ACTION_RANK: Record<RuleAction, number> = { block: 0, review: 1, warn: 2, log: 3 }
const SEVERITY_RANK: Record<RuleSeverity, number> = { critical: 0, major: 1, minor: 2 }

/**
 * 按处置级别、再按严重度排序违规；同级保持规则集原顺序。
 * @param violations - 待排序的违规视图。
 * @returns 排序后的新数组。
 */
function orderedViolations(violations: readonly RuleViolationView[]): RuleViolationView[] {
  return [...violations].sort((a, b) =>
    ACTION_RANK[a.action] - ACTION_RANK[b.action]
    || SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
}

/** Render the canonical rule-check value into model-facing prose. */
function renderRuleCheck(value: RuleCheckOutput): string {
  const header = value.packHeader !== undefined ? `${value.packHeader}\n` : ''
  const warnings = value.packWarnings !== undefined && value.packWarnings.length > 0 ? `\n加载警告: ${value.packWarnings.join('；')}` : ''
  const evaluated = renderEvaluatedTexts(value.evaluated)
  const skipped = value.dualInputSkipped !== undefined && value.dualInputSkipped.length > 0
    ? `\n双输入规则未评估（未提供 notice）: ${value.dualInputSkipped.join('、')}`
    : ''
  const ignored = value.noticeIgnored !== undefined ? `\n提示: ${value.noticeIgnored}` : ''
  const blocked = value.blocked
    ? '\n门禁结论: 存在 block 级违规，这次自检不能作为交付前置证据；修订后重跑。'
    : ''
  // `text` is a required input, so an evaluation always reports at least one identity.
  const trailer = `${warnings}${skipped}${ignored}${blocked}\n${evaluated}`
  if (value.violations.length === 0) {
    return `${header}rule_check(${value.scope}): 无违规${trailer}`
  }
  const counts = new Map<string, number>()
  for (const violation of value.violations) counts.set(violation.action, (counts.get(violation.action) ?? 0) + 1)
  const breakdown = ['block', 'review', 'warn', 'log']
    .filter(action => (counts.get(action) ?? 0) > 0)
    .map(action => `${action} ${counts.get(action)}`)
    .join(' / ')
  const lines = orderedViolations(value.violations).map((v) => {
    const basis = v.legalBasis ? `（依据：${v.legalBasis}）` : ''
    const evidence = v.evidence.length > 0 ? ` 命中「${v.evidence.join('」「')}」` : ''
    const where = v.line !== undefined && v.matchedSentence !== undefined
      ? `（第 ${v.line} 行「${v.matchedSentence}」）`
      : ''
    return `- [${v.severity}/${v.action}] ${v.ruleId} ${v.ruleName}：${v.message}${evidence}${where}${basis}`
  })
  const summary = `rule_check(${value.scope}): 发现 ${value.violations.length} 条违规（${breakdown}）`
  return `${header}${summary}\n${lines.join('\n')}${trailer}`
}

const VIOLATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ruleId: { type: 'string', required: true },
    ruleName: { type: 'string', required: true },
    severity: { type: 'string', required: true, enum: ['critical', 'major', 'minor'] },
    action: { type: 'string', required: true, enum: ['block', 'review', 'warn', 'log'] },
    legalBasis: { type: 'string' },
    message: { type: 'string', required: true },
    evidence: { type: 'array', required: true, items: { type: 'string' } },
    line: { type: 'number' },
    matchedSentence: { type: 'string' },
  },
} as const

/**
 * Build the `rule_check` tool over injectable rule-set loaders.
 * @param deps - optional loader injections (defaults use the bundled patent-rule assets).
 * @returns a registry-ready tool definition.
 */
export function createRuleCheckTool(deps: RuleCheckDeps = {}): ToolDefinition {
  // One entry per scope: the rule set is fixed for the process (bundled assets or an
  // injected loader), so the keyed cache this used to carry could never invalidate.
  const cache = new Map<string, { ruleSet: RuleSet; pack: RulePackLoadResult | null }>()

  const resolve = (scope: string): { ruleSet: RuleSet; pack: RulePackLoadResult | null } => {
    const isPack = scope === 'pack' && deps.loader === undefined
    const domainScope = DOMAIN_SCOPES[scope]
    const cached = cache.get(scope)
    if (cached !== undefined) return { ruleSet: cached.ruleSet, pack: cached.pack }
    let ruleSet: RuleSet
    let pack: RulePackLoadResult | null = null
    if (isPack) {
      pack = deps.pack ? deps.pack() : loadRulePack()
      ruleSet = pack.ruleSet
    } else if (deps.loader) {
      ruleSet = deps.loader(scope)
    } else if (scope === 'patent') {
      ruleSet = loadPatentComplianceRuleSet().ruleSet
    } else if (scope === 'patent-electrical') {
      ruleSet = loadPatentElectricalRuleSet().ruleSet
    } else if (domainScope !== undefined) {
      // 专利全量 + 该领域规则包：域包不在 loadPatentFullRuleSet 里，插件层的
      // additionalRuleDomains 只影响输出门禁（默认仅 keyword_blocklist），够不到本工具。
      const domainDir = join(assetRulesRoot(), 'domains', domainScope)
      ruleSet = mergeRuleSets([loadPatentFullRuleSet().ruleSet, ...loadRuleSetDir(domainDir).ruleSets])
    } else if (scope === 'patent-full' || patentCaseDomains(scope) !== undefined) {
      ruleSet = loadPatentFullRuleSet().ruleSet
    } else {
      ruleSet = { rules: [] }
    }
    cache.set(scope, { ruleSet, pack })
    return { ruleSet, pack }
  }

  const synonymsCache: SynonymMap = deps.synonyms ? deps.synonyms() : loadSynonymsAsset().synonyms

  return defineTool({
    name: 'rule_check',
    description: DESCRIPTION,
    parameters: {
      text: { type: 'string', required: true, description: 'The text to check.' },
      scope: { type: 'string', description: "Rule set scope. Defaults to 'patent' (4 general compliance rules only; choose a job scope for substantive checks). 'patent-drafting' / 'patent-analysis' cover claim/spec drafting and patentability analysis; 'patent-oa-response' / 'patent-invalidation' / 'patent-invalidation-defense' / 'patent-reexamination' / 'patent-infringement' evaluate the full assets filtered to that job's rule domains; 'patent-mechanical' adds the mechanical domain pack (structural-equivalence argument completeness) and 'patent-software' the software/AI pack (subject-matter argument completeness) on top of the full assets. 'pack' loads the layered rule pack declared by .sati/rules.yaml." },
      notice: { type: 'string', description: '通知书正文（可选）：提供时就地确定性解析，并评估双输入规则 PR-OA-008/009；未提供时结果中显式列出未评估项。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          scope: { type: 'string', required: true },
          violations: { type: 'array', required: true, items: VIOLATION_SCHEMA },
          blocked: { type: 'boolean', required: true },
          evaluated: { type: 'array', required: true, items: EVALUATED_TEXT_SCHEMA },
          packHeader: { type: 'string' },
          packWarnings: { type: 'array', items: { type: 'string' } },
          dualInputSkipped: { type: 'array', items: { type: 'string' } },
          noticeIgnored: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderRuleCheck(value) }],
    },
    // oxlint-disable-next-line typescript/require-await -- tool contract requires async execute
    async execute(args) {
      requireNonBlankText(
        args.text,
        'rule_check',
        'rule_check: text 不能为空白；请传入本次要判定的文本，零字节调用不能作为交付前置证据。',
      )
      const scope = args.scope ?? 'patent'
      const { ruleSet, pack } = resolve(scope)
      if (ruleSet.rules.length === 0) {
        throw new PatentToolError('invalid_tool_input', `rule_check(${scope}): 未加载任何规则（scope 未知或规则集为空）。可用 scope: ${AVAILABLE_SCOPES}`, { tool: 'rule_check', scope })
      }
      // 作业 scope 与 patent-full 同源加载，只在评估期按作业域过滤（规则集本身不变，
      // 故缓存与 pack 路径不受 scope 影响）。
      const domains = patentCaseDomains(scope)
      const evaluation = evaluateText(args.text, ruleSet, synonymsCache, domains === undefined ? undefined : { domain: domains })
      // 双输入规则（PR-OA-008/009 一族）：只在提供 notice 时评估；未提供则显式列出，
      // 不静默跳过——否则「跑了 rule_check」与「双输入规则没跑」在结果上无法区分。
      const dualRules = ruleSet.rules.filter(rule =>
        isDualInputCheck(rule.check.type)
        && (domains === undefined || rule.domain === undefined || domains.includes(rule.domain)))
      const noticeText = args.notice?.trim() ?? ''
      const dualViolations: RuleViolation[] = []
      let dualInputSkipped: string[] | undefined
      let evaluatedNotice: string | undefined
      const noticeIgnored = noticeText.length > 0 && dualRules.length === 0
        ? `scope '${scope}' 没有可评估的双输入规则，notice 未参与判定`
        : undefined
      if (dualRules.length > 0) {
        if (noticeText.length === 0) {
          dualInputSkipped = dualRules.map(rule => rule.id)
        } else {
          const notice = parseOfficeAction(noticeText)
          evaluatedNotice = noticeText
          for (const rule of dualRules) {
            const found = evaluateDualRule(rule, { notice, response: args.text })
            if (found !== null) dualViolations.push(found)
          }
        }
      }
      const packHeader = pack !== null
        ? `规则分层: ${summarizeRulePackLayers(pack.layers)}（清单: ${pack.manifestPath ?? '无，默认 rules/base'}）`
        : undefined
      const violations = [...evaluation.violations, ...dualViolations]
      return {
        scope,
        blocked: violations.some(v => v.action === 'block'),
        violations: violations.map(v => ({
          ruleId: v.ruleId,
          ruleName: v.ruleName,
          severity: v.severity,
          action: v.action,
          ...(v.legalBasis !== undefined ? { legalBasis: v.legalBasis } : {}),
          message: v.message,
          evidence: v.evidence,
          ...(v.line !== undefined ? { line: v.line } : {}),
          ...(v.matchedSentence !== undefined ? { matchedSentence: v.matchedSentence } : {}),
        })),
        evaluated: evaluatedTexts({
          text: args.text,
          ...(evaluatedNotice !== undefined ? { notice: evaluatedNotice } : {}),
        }),
        ...(dualInputSkipped !== undefined ? { dualInputSkipped } : {}),
        ...(noticeIgnored !== undefined ? { noticeIgnored } : {}),
        ...(packHeader !== undefined ? { packHeader } : {}),
        ...(pack !== null && pack.warnings.length > 0 ? { packWarnings: pack.warnings } : {}),
      }
    },
  })
}
