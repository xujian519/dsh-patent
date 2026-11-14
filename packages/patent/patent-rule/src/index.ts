/**
 * The patent-rule PLUGIN: ports the Sati constitutional rule engine and ships
 * the rule assets, wires the RuleOutputGate onto tools/post-execute with review
 * routed through ctx.approval, and registers the EVI-011 evidence-compliance
 * guards via ctx.tools.guard() as monotonic denies.
 *
 * ## Behavior
 *
 * - Delivery-tool results (render_patent_document / draft_claims /
 *   draft_specification / validate_specification, overridable via
 *   {@link Config.gateToolNames}) run through the RuleOutputGate on the
 *   check families selected by {@link Config.gateCheckTypes} (default: the
 *   keyword_blocklist subset; an absence-based family is rejected with a
 *   warning). A block-level violation returns
 *   `{ kind: 'block' }`; a review-level violation fires `ctx.get('approval')`
 *   and accepts only on `'allowed-once'` (fail-closed with no answerer, no
 *   agent, or `approvalDisabled`). A warn-level hit cannot rewrite the result
 *   the model has already received, so its findings ride the decision as
 *   `additionalContexts` for the next request; `log` hits stay in the log.
 * - A declared structural gate ({@link Config.structuralGate}) denies a
 *   delivery-tool call before dispatch when the artifact text in its arguments
 *   violates a named absence-based rule: those rules cannot judge a tool
 *   result's prose (plain text is always "missing" most expected elements), so
 *   they run on the artifact a production tool is about to render or write.
 * - A declared delivery gate ({@link Config.deliveryGate}) denies a
 *   delivery-tool call whose declared prerequisite calls have not succeeded
 *   earlier in the same session, so a deliverable cannot ship without the gate
 *   runs the delivery discipline requires. Prerequisite calls that return
 *   without an error and without declaring `blocked: true` are recorded from
 *   tools/post-execute, together with the result fields each entry declares as
 *   evidence; a declared field that is missing or mismatched leaves the
 *   prerequisite unsatisfied. The deny is a monotonic guard.
 * - evaluate_evidence calls are denied by two monotonic EVI-011 guards when an
 *   overseas/foreign evidence record omits its required notarization /
 *   legalization / translation declaration.
 * - Non-matching tools delegate via `next()` (waterfall contract).
 *
 * @module @deepseek-ai/dsh-patent-rule
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
// Type-only: makes `ctx.get('approval')` resolve to the ApprovalService
// augmentation. The seam stays optional at runtime.
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type {
  RuleOutputGate as PatentRuleOutputGate,
  RuleOutputGateResult,
  RuleSetValidationIssue,
} from '@deepseek-ai/dsh-patent-core'
import { patentAssetDir } from './asset-location.ts'
import {
  citationGateBlocking,
  renderCitationGateDenial,
  type CitationGateEntry,
} from './runtime/citation-gate.ts'
import { createEvidenceComplianceGuards } from './guard/evidenceComplianceGuards.ts'
import {
  ARTIFACT_GATE_CHECK_TYPES,
  DEFAULT_GATE_CHECK_TYPES,
  GATE_CHECK_TYPES,
  isGateCheckType,
  loadPatentFullRuleSet,
  selectGateRules,
  type GateCheckType,
} from './runtime/patent-compliance.ts'
import { formatViolation, RuleOutputGate } from './runtime/output-gate.ts'
import { loadSynonymsAsset } from './runtime/synonym-engine.ts'
import { loadRulePack, resolvePackDir } from './runtime/rule-pack.ts'
import { loadRuleSetDir, mergeRuleSets } from './runtime/RuleLoader.ts'
import {
  caseKeyOfArguments,
  deliveryEvidence,
  deliveryGateMissing,
  DeliveryAttemptLedger,
  renderDeliveryGateDenial,
  resolveDeliveryGate,
  type DeliveryGateEntry,
  type DeliveryGatePlan,
} from './runtime/delivery-gate.ts'
import {
  renderStructuralGateDenial,
  resolveStructuralGate,
  structuralGateViolations,
  type StructuralGateEntry,
  type StructuralGatePlan,
} from './runtime/structural-gate.ts'

// This plugin's own producer identity for the context it injects. MessageSourceMap
// is merge-extensible: consumers fall through `kind`s they do not know.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'patent-rule-gate': { kind: 'patent-rule-gate' } & ContextFormed
  }
}

// Public library API: the rule engine, loaders, pack assembler, and guards the
// rule_check tool and workflow consumers import alongside the plugin surface.
export {
  evaluateRule,
  evaluateText,
  groupByAction,
  type EvaluateTextOptions,
} from './runtime/RuleEngine.ts'
export {
  applyRuleOverrides,
  asRecord,
  isRuleAction,
  loadRuleSetDir,
  loadRuleSetFromFile,
  mergeRuleSets,
  parseRuleSetFromYaml,
  validateRuleSet,
} from './runtime/RuleLoader.ts'
export {
  DUAL_INPUT_CHECK_TYPES,
  evaluateDualRule,
  isDualInputCheck,
  type DualInputRuleInput,
  type OfficeActionRejections,
} from './runtime/dual-input.ts'
export {
  checkSynonymRequirements,
  hasNegationContext,
  loadSynonymsAsset,
  matchKeyword,
  parseSynonyms,
  type SynonymCheckResult,
  type SynonymMap,
  type SynonymsLoadResult,
} from './runtime/synonym-engine.ts'
export {
  DEFAULT_GATE_CHECK_TYPES,
  GATE_CHECK_TYPES,
  INCIDENT_GATE_CHECK_TYPES,
  ARTIFACT_GATE_CHECK_TYPES,
  isGateCheckType,
  loadActivationOverrides,
  loadPatentComplianceRuleSet,
  loadPatentElectricalRuleSet,
  loadPatentFullRuleSet,
  patentCaseDomains,
  selectGateRules,
  PATENT_CASE_DOMAINS,
  PatentRuleAssetError,
  type ActivationOverrides,
  type GateCheckType,
  type PatentCaseScope,
  type PatentComplianceLoadResult,
} from './runtime/patent-compliance.ts'
export {
  renderStructuralGateDenial,
  resolveStructuralGate,
  structuralGateText,
  structuralGateViolations,
  StructuralGateConfigError,
  type ResolvedStructuralGateEntry,
  type StructuralGateEntry,
  type StructuralGatePlan,
} from './runtime/structural-gate.ts'
export {
  declaredArgsMatch,
  jsonRecord,
  type DeclaredArgValue,
} from './runtime/args-match.ts'
export {
  caseKeyOfArguments,
  deliveryEvidence,
  DeliveryAttemptLedger,
  deliveryGateMissing,
  renderDeliveryGateDenial,
  resolveDeliveryGate,
  type DeliveryEvidence,
  type DeliveryEvidenceRequirement,
  type DeliveryGateEntry,
  type DeliveryGatePlan,
} from './runtime/delivery-gate.ts'
export {
  loadRulePack,
  parseRulePackManifest,
  resolvePackDir,
  resolveRulePackManifestPath,
  summarizeRulePackLayers,
  validatePackManifest,
  type PackManifestIssue,
  type RulePackLoadResult,
  type RulePackManifest,
} from './runtime/rule-pack.ts'
export {
  RuleOutputGate,
  type RuleOutputGateOptions,
} from './runtime/output-gate.ts'
export {
  assetRulesRoot,
  candidatePackDirs,
  candidateRuleDirs,
  patentAssetDir,
  resolveRuleAsset,
} from './asset-location.ts'
export {
  EVIDENCE_COMPLIANCE_TOOL,
  createEvidenceComplianceGuards,
  createForeignTranslationGuard,
  createOverseasNotarizationGuard,
  evi011GuardConditionFields,
} from './guard/evidenceComplianceGuards.ts'
export * from './checker/index.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'patent-rule'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The rule output gate for the loaded rule pack; present only when this plugin is mounted (patent-teams gating). */
    patentRuleGate?: PatentRuleOutputGate
  }
}

/** Require the tool registry (guards + the post-execute waterfall are its extension points). */
export const inject = ['tools']

/** Delivery tools whose results run through the output gate by default. */
const DEFAULT_GATE_TOOL_NAMES = [
  'render_patent_document',
  'draft_claims',
  'draft_specification',
  'validate_specification',
] as const

/** Plugin config. */
export interface Config {
  /**
   * Rule-asset root override, mirroring the packaged assets/rules/ layout
   * (patent/, base/, domains/). Omitted uses the packaged assets.
   */
  rulesDir?: string
  /**
   * Explicit path to a rule-pack manifest (YAML with `base`, `domains`, `overrides`).
   * When set, `loadRulePack` replaces the default `loadPatentFullRuleSet` so
   * non-patent domain rules (e.g. legal) can be loaded alongside the base.
   * Omitted uses the shipped patent-full rule set.
   */
  manifestPath?: string
  /**
   * Additional domain names to load on top of the default patent-full rule set.
   * Each name resolves to `assets/rules/domains/<name>/` (or `<rulesDir>/domains/<name>/`).
   * Useful for presets (e.g. legal) that need the patent base plus extra domain rules
   * without the noise of a full manifest-based load. A domain rule carrying an
   * already-loaded id replaces it and draws a load warning, so a collision between a
   * domain pack and the base set stays visible.
   */
  additionalRuleDomains?: string[]
  /** Tool names whose results run through the output gate. Defaults to the delivery tools. */
  gateToolNames?: string[]
  /**
   * Check families the result gate keeps. Defaults to `keyword_blocklist`
   * (incident: a hit is a violation). Widening to
   * `pattern_analysis` / `citation_analysis` / `quote_repetition` is a
   * deployment choice; the absence-based families (`structural_analysis` /
   * `synonym_match`) are rejected with a warning, because a tool result's prose
   * is always "missing" most expected elements — they run through
   * {@link Config.structuralGate} instead. Widening adds log lines only while
   * the shipped incident-family rules are `action: warn`.
   */
  gateCheckTypes?: string[]
  /**
   * Artifact structural gate: entries naming a tool, the arguments holding its
   * artifact text, and the absence-based rule ids to judge it by. A block-level
   * hit denies the call before dispatch, so a non-conforming artifact is never
   * rendered or written. No entry ships: a template renderer's arguments hold
   * slot fragments, so absence checks on them report defects the rendered
   * document does not have — declare an entry only where the argument is the
   * whole document text. An entry's `strict` turns an id that no longer resolves
   * (or a non-block rule, or an unexecutable entry) into a load-time
   * {@link StructuralGateConfigError} instead of a warning that drops it; shipped
   * presets set it so a renamed rule asset cannot silently disarm the gate.
   */
  structuralGate?: StructuralGateEntry[]
  /**
   * Delivery gate: entries naming a delivery tool and the tools that must have
   * succeeded earlier in the same session before it may run. An unsatisfied
   * entry denies the call through a monotonic guard, so a deliverable cannot
   * ship while the gate runs its discipline requires are missing from the
   * session's call record. `whenArgs` narrows an entry to matching calls, which
   * lets one tool's forms carry different prerequisites. `evidence` requires
   * fields on a prerequisite's result as well, so a zero-byte run or another
   * template's closure cannot stand in for the run this delivery owes. No entry
   * ships: the prerequisites a deployment requires are its delivery policy, not
   * this package's.
   */
  deliveryGate?: DeliveryGateEntry[]
  /**
   * Citation gate: before a listed delivery tool runs, every citation in its
   * text arguments must pass the shipped patent index and, for 民法典 and
   * 民事诉讼法, the legal-law index. A citation that is out of range, absent
   * from the index, unverified, or narrowed to a missing paragraph or item
   * denies the call.
   */
  citationGate?: CitationGateEntry[]
  /** When true, review-level violations block without an approval round-trip (unattended fail-closed). */
  approvalDisabled?: boolean
}

export const Config: z<Config> = z.object({
  rulesDir: z.string(),
  manifestPath: z.string(),
  additionalRuleDomains: z.array(z.string()).default([]),
  gateToolNames: z.array(z.string()).default([...DEFAULT_GATE_TOOL_NAMES]),
  gateCheckTypes: z.array(z.string()).default([...DEFAULT_GATE_CHECK_TYPES]),
  structuralGate: z.array(z.object({
    tool: z.string().required(),
    textArgs: z.array(z.string()).required(),
    ruleIds: z.array(z.string()).required(),
    whenArgs: z.dict(z.string()).default({}),
    strict: z.boolean().default(false),
  })).default([]),
  deliveryGate: z.array(z.object({
    tool: z.string().required(),
    requires: z.array(z.string()).required(),
    whenArgs: z.dict(z.union([z.string(), z.array(z.string())])),
    evidence: z.dict(z.array(z.object({
      field: z.string().required(),
      equals: z.union([z.string(), z.boolean(), z.array(z.string())]),
      minItems: z.number(),
    }))),
  })).default([]),
  citationGate: z.array(z.object({
    tool: z.string().required(),
    textArgs: z.array(z.string()).required(),
    whenArgs: z.dict(z.union([z.string(), z.array(z.string())])),
  })).default([]),
  approvalDisabled: z.boolean().default(false),
})

/** 解析门禁检查族：未知取值与「缺失即违规」族都告警并跳过，其余按声明顺序保留。 */
function resolveGateCheckTypes(declared: readonly string[], warnings: string[]): GateCheckType[] {
  const resolved: GateCheckType[] = []
  for (const value of declared) {
    if (!isGateCheckType(value)) {
      warnings.push(`未知的门禁检查类型 "${value}"（可用：${GATE_CHECK_TYPES.join(' / ')}），已忽略`)
      continue
    }
    if ((ARTIFACT_GATE_CHECK_TYPES as readonly string[]).includes(value)) {
      warnings.push(`门禁检查类型 "${value}" 是「缺失即违规」族，对工具结果全文评测会海量误报；该族只经制品结构门禁（structuralGate，按声明的入参取制品文本）执行，已忽略`)
      continue
    }
    resolved.push(value)
  }
  return resolved
}

/** Extract the concatenated plain-text content of a tool result (empty for non-text blocks). */
function resultText(result: Readonly<ToolExecutionResult>): string {
  let text = ''
  for (const block of result.content) {
    if (block.type === 'text') text += block.text
  }
  return text
}

/** A model-visible one-line summary of the review/block rule ids that fired. */
function hitSummary(result: RuleOutputGateResult): string {
  const ids = [...new Set([...result.blockHits, ...result.reviewHits])]
  // 标签必须来自真正触发 block/review 的违规；取 violations[0] 会把排在前面的
  // warn 规则名贴到审批理由上，模型据此改错规则。
  const first = result.violations.find(v => v.action === 'block' || v.action === 'review')
  /* v8 ignore next -- only called with block/review hits, so a matching violation exists. */
  const label = first ? '（' + first.ruleName + '）' : ''
  /* v8 ignore next -- only called with block/review hits, so ids is non-empty. */
  return ids.length > 0 ? ids.join(', ') + label : '(none)'
}

/**
 * Build the model-visible context for warn-level hits of one gated tool result.
 *
 * A warn hit cannot rewrite the result the model already received, so the
 * finding is carried on the decision instead: the loop admits it at the next
 * step, which both shows it to the model and records it in the session log.
 * @param result - gate outcome for the tool result text.
 * @param toolName - gated tool that produced the result.
 * @returns the context to attach, or `undefined` when no warn-level rule fired.
 */
function warnContext(result: RuleOutputGateResult, toolName: string): UserMessage | undefined {
  const warn = result.violations.filter(violation => violation.action === 'warn')
  if (warn.length === 0) return undefined
  const lines = warn.map(formatViolation)
  const ids = [...new Set(warn.map(v => v.ruleId))]
  return createUserMessage({
    content: [{
      type: 'text',
      text: '⚠️ 专利合规提示（warn 级）：' + toolName + ' 的产出命中以下规则，'
        + '请在后续修改中处理：\n' + lines.join('\n'),
    }],
    source: {
      kind: 'patent-rule-gate',
      form: 'notice',
      summary: boundContextSummary(toolName + ' 命中 warn 级规则 ' + ids.join(', ')),
    },
  })
}

/**
 * Attach the warn context to a decision without changing that decision.
 * @param decision - this plugin's own block decision, or the decision the rest of the waterfall returned.
 * @param warn - context from {@link warnContext}, if any.
 * @returns the same decision with the context prepended to its own contexts.
 */
function attachWarn(decision: PostToolDecision, warn: UserMessage | undefined): PostToolDecision {
  if (warn === undefined) return decision
  return { ...decision, additionalContexts: [warn, ...decision.additionalContexts ?? []] }
}

/**
 * Register the patent-rule contribution.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - validated {@link Config}.
 */
/**
 * Whether a prerequisite result declares its own block.
 *
 * A tool can return successfully while refusing the result it checked
 * (`law_verify` returns `blocked: true`). The delivery gate records a passing
 * run, not merely a non-error one, so such a call does not satisfy the gate.
 * @param value - the canonical tool result value.
 * @returns true when the result carries `blocked: true`.
 */
function isBlockedResult(value: unknown): boolean {
  return typeof value === 'object'
    && value !== null
    && (value as { blocked?: unknown }).blocked === true
}

export function apply(ctx: Context, config: Config): void {
  const gateToolNames = new Set(config.gateToolNames ?? DEFAULT_GATE_TOOL_NAMES)
  const approvalDisabled = config.approvalDisabled === true

  // Rule loading strategy:
  // 1. manifestPath → full loadRulePack (layered base+domains+overrides)
  // 2. additionalRuleDomains → patent-full + extra domain dirs
  // 3. default → patent-full only
  let ruleSet: import('@deepseek-ai/dsh-patent-core').RuleSet
  let warnings: string[]
  if (config.manifestPath) {
    const result = loadRulePack({
      manifestPath: config.manifestPath,
      ...(config.rulesDir !== undefined ? { rulesDir: config.rulesDir } : {}),
    })
    ruleSet = result.ruleSet
    warnings = result.warnings
  } else {
    const base = loadPatentFullRuleSet(config.rulesDir)
    ruleSet = base.ruleSet
    warnings = base.warnings
    for (const domain of config.additionalRuleDomains ?? []) {
      const domainDir = resolvePackDir(domain, config.rulesDir)
      if (domainDir === null) {
        warnings.push(`附加规则域 "${domain}" 未找到，跳过`)
        continue
      }
      const { ruleSets: domainSets, warnings: domainWarnings } = loadRuleSetDir(domainDir)
      warnings.push(...domainWarnings.map(w => w.message))
      if (domainSets.length > 0) {
        // 同名 id 的域规则会覆盖基础规则集且不改变判定结果，静默覆盖等于部署配错而无人知。
        const mergeIssues: RuleSetValidationIssue[] = []
        ruleSet = mergeRuleSets([ruleSet, ...domainSets], mergeIssues)
        warnings.push(...mergeIssues.map(issue => issue.message))
      }
    }
  }
  const gateCheckTypes = resolveGateCheckTypes(config.gateCheckTypes ?? DEFAULT_GATE_CHECK_TYPES, warnings)
  const structuralGate: StructuralGatePlan = resolveStructuralGate(ruleSet, config.structuralGate ?? [])
  warnings.push(...structuralGate.warnings)
  const deliveryGate: DeliveryGatePlan = resolveDeliveryGate(config.deliveryGate ?? [])
  warnings.push(...deliveryGate.warnings)
  const synonyms = loadSynonymsAsset(config.rulesDir)
  warnings.push(...synonyms.warnings)
  for (const warning of warnings) ctx.logger.warn('patent-rule: ' + warning)
  const gate = new RuleOutputGate(selectGateRules(ruleSet, gateCheckTypes), { synonyms: synonyms.synonyms })
  // Expose the same gate to team-consumers (e.g. patent-teams) so a task
  // completion can be rule-gated consistently with the tools/post-execute path.
  ctx.provide('patentRuleGate', gate)

  // EVI-011 evidence-compliance guards: monotonic deny (no allow result), so no
  // allow/ask permission rule can override them.
  const ruleDirs = [patentAssetDir(config.rulesDir)]
  for (const guard of createEvidenceComplianceGuards(ruleDirs)) {
    ctx.tools.guard(guard)
  }

  // 制品结构门禁：在调用前判定入参里的制品文本。「缺失即违规」的规则不能作用于工具
  // 结果全文，只能在制品进入渲染/落盘之前拦下——这是它们唯一的硬执行点。
  if (structuralGate.entries.length > 0) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      const violations = structuralGateViolations(structuralGate, exec.name, exec.arguments, synonyms.synonyms)
      if (violations.length === 0) return next()
      return { kind: 'deny', reason: renderStructuralGateDenial(exec.name, violations) }
    })
  }

  const citationGate = config.citationGate ?? []
  if (citationGate.length > 0) {
    ctx.on('tools/pre-execute', async (exec, next) => {
      const blocking = citationGateBlocking(citationGate, exec.name, exec.arguments)
      if (blocking.length === 0) return next()
      return { kind: 'deny', reason: renderCitationGateDenial(exec.name, blocking) }
    })
  }

  // 交付前置门禁：纪律（先跑哪个闸门才能出件）在此处成为执行点。台账只记成功返回的
  // 调用，判定与登记分开——调用前的 guard 只能看到「即将调用」，看不到结果。
  const deliveryLedger = new DeliveryAttemptLedger()
  const gatedTools = new Set(deliveryGate.entries.map(entry => entry.tool))
  const requiredTools = new Set(deliveryGate.entries.flatMap(entry => entry.requires))
  if (deliveryGate.entries.length > 0) {
    ctx.tools.guard((exec) => {
      if (!gatedTools.has(exec.name)) return undefined
      const missing = deliveryGateMissing(deliveryGate, deliveryLedger, exec.agent, exec.name, exec.arguments)
      return missing.length === 0 ? undefined : renderDeliveryGateDenial(exec.name, missing)
    })
  }

  ctx.on('tools/post-execute', async (exec: ToolExecution, result, next): Promise<PostToolDecision> => {
    // 登记的是「跑过且通过」：工具成功返回、未自带 blocked:true，且下游 post-execute
    // 没有把它改成 block。记录必须发生在 next() 之后——在调用前登记会把一条马上被
    // 输出门禁或下游监听器拦下的调用也记成前置证据。
    const agent = exec.agent
    const shouldRecord = !result.isError
      && !isBlockedResult(result.value)
      && requiredTools.has(exec.name)
    const recordIfPassed = (decision: PostToolDecision): PostToolDecision => {
      if (shouldRecord && decision.kind !== 'block' && agent) {
        deliveryLedger.record(
          agent,
          exec.name,
          caseKeyOfArguments(exec.arguments),
          deliveryEvidence(result.value, deliveryGate.evidenceFields.get(exec.name)),
        )
      }
      return decision
    }

    if (!gateToolNames.has(exec.name) || result.isError) return recordIfPassed(await next())
    const text = resultText(result)
    if (text.trim().length === 0) return recordIfPassed(await next())

    const gateResult = gate.process(text)
    const warn = warnContext(gateResult, exec.name)
    // log 级命中只进日志：它既不改写结果，也不进入下一轮上下文，但“计算后丢弃”
    // 会让审计看不到规则跑过；在早退（block/review）之前记录，任何处置都留痕。
    const logHits = [...new Set(gateResult.violations.filter(v => v.action === 'log').map(v => v.ruleId))]
    if (logHits.length > 0) {
      ctx.logger.info('patent-rule: ' + exec.name + ' 命中 log 级规则 ' + logHits.join(', '))
    }
    if (gateResult.blockHits.length > 0) {
      return attachWarn({
        kind: 'block',
        feedback: [{ type: 'text', text: '专利输出门禁拦截 ' + exec.name + '：命中强制规则 ' + hitSummary(gateResult) }],
      }, warn)
    }
    // warn/log 命中不改变结果文本：门禁只硬拦截 block、经审批放行 review。
    // warn 级命中改写不了模型已收到的结果，改为随决策附到下一次请求（模型可见且入日志）；
    // log 级只留日志，避免"计算后丢弃"的静默。
    if (warn !== undefined) {
      ctx.logger.warn('patent-rule: ' + exec.name + ' 命中 warn 级规则 ' + gateResult.warnHits.join(', '))
    }
    if (gateResult.reviewHits.length === 0) return attachWarn(recordIfPassed(await next()), warn)

    const reason = '专利输出门禁请求审批 ' + exec.name + '：命中待审规则 ' + hitSummary(gateResult)
    const approval = ctx.get('approval')
    // fail-closed：无审批通道（未配/无 agent/approvalDisabled）时按拦截处理。
    if (approvalDisabled || exec.agent === undefined || approval === undefined) {
      return attachWarn({
        kind: 'block',
        feedback: [{ type: 'text', text: reason + '（无审批通道，按拦截处理）' }],
      }, warn)
    }
    let outcome: ApprovalOutcome
    try {
      outcome = await approval.request({
        agent: exec.agent,
        toolName: exec.name,
        callId: exec.callId,
        reason,
        signal: exec.signal,
      })
    } catch (error) {
      // 审批通道自身异常时保持 fail-closed；抛出会把结果变成未定义的错误路径，
      // 模型也拿不到“该改哪条规则”的可操作反馈。
      return attachWarn({
        kind: 'block',
        feedback: [{
          type: 'text',
          text: reason + '（审批通道异常，按拦截处理：' + (error as Error).message + '）',
        }],
      }, warn)
    }
    if (outcome !== 'allowed-once') {
      return attachWarn({
        kind: 'block',
        feedback: [{ type: 'text', text: reason + '（审批未通过，按拦截处理）' }],
      }, warn)
    }
    return attachWarn(recordIfPassed(await next()), warn)
  })
}
