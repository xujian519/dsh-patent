/**
 * `claim_chart_build` tool: element-level claim-chart evidence grid via the
 * claim-chart atom (ClaimChartHandler). Ported from Sati's claimChart.ts; the
 * engine lives in @deepseek-ai/dsh-patent-core.
 *
 * In `mode: 'infringement'` the result also carries a deterministic conclusion
 * (per accused-product all-elements coverage, equivalence contradictions, and —
 * only when the caller supplies the scoring facts — the weighted risk level).
 * In `mode: 'invalidity'` / `'reexamination'` it carries the per-claim
 * single-reference coverage, the distinguishing features against the primary
 * reference, and the dependent-claim path check. Every conclusion is computed
 * from the chart's row-level mappings and the claim-reference relations derived
 * from the claim text, never from a verdict the caller asserts.
 * @module @deepseek-ai/dsh-patent-tools/tool/claim-chart-build
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  ClaimChartHandler,
  assertSafePathSegment,
  deriveInfringementConclusion,
  renderInvalidityConclusion,
  type AllElementsOutcome,
  type ChartMode,
  type ChartTarget,
  type ClaimChart,
  type DefenseViability,
  type EquivalenceTriplet,
  type EquivalenceContradictionKind,
  type InfringementConclusion,
  type InfringementConclusionInput,
  type InvalidityConclusion,
  type PatentModelPort,
  type StageProvider,
} from '@deepseek-ai/dsh-patent-core'
import { PatentToolError } from '../error.ts'
import { createToolInputReader } from './internal/tool-input.ts'
import { loggedToolModel } from './internal/model-call-log.ts'

/** One claim-chart mapping target (prior art or accused product). */
export type ClaimChartTargetInput = {
  id: string
  kind: 'prior-art' | 'accused-product'
  title?: string
  source_path?: string
}

/** Scoring facts the chart cannot produce (see InfringementScoringFacts). */
type ClaimChartRiskInput = {
  /** 各抗辩的成立可能性；缺省按"无抗辩"处理（不因缺少抗辩分析而降低风险）。 */
  defenses?: DefenseViability[]
  /** 补救风险（0–1），由调用方按案件金额量程归一。 */
  remedyExposureRatio: number
  /** 是否适用禁止反悔原则。 */
  estoppelApplied?: boolean
  /** 是否适用捐献规则。 */
  dedicationApplied?: boolean
  /** 逐要素的等同三要素认定记录；不提供时按等同落格的行一律报缺认定记录。 */
  equivalents?: EquivalenceTriplet[]
}

/** Input for the claim_chart_build tool. */
export type ClaimChartInput = {
  mode: ChartMode
  claim_text: string
  targets: ClaimChartTargetInput[]
  case_id?: string
  /** Infringement scoring facts; omitted means no risk level is computed. */
  risk?: ClaimChartRiskInput
}

/** Output of the claim_chart_build tool. */
export type ClaimChartOutput = {
  chart: ClaimChart
  json_path?: string
  md_path?: string
  gap_count: number
  /** Deterministic conclusion (infringement mode only). */
  infringement_conclusion?: JsonValue
  /** Deterministic conclusion (invalidity / reexamination mode only). */
  invalidity_conclusion?: JsonValue
}

/** Injected model port (the integrator wires a createLlmModelPort over ctx.llm). */
export type ClaimChartBuildDeps = {
  model?: PatentModelPort
}

const DESCRIPTION = '构建权利要求对照表（claim chart）：把权利要求拆分为编号要素，逐要素映射到对比文件或产品证据（每行 pin-cite 引用），并输出 gap list（证据薄弱的要素）。适用于撰写（可专利性布局）、OA 答复、无效/复审、侵权比对等场景。mode=infringement 时另给出确定性结论段：被控产品的全面覆盖判定（逐权项判定，整体取覆盖最佳权项）、等同认定与图表映射的矛盾；提供 risk（抗辩成立可能性与补救比例等可复核事实）时按五维权重给出风险等级。mode=invalidity/reexamination 时另给出确定性结论段：逐权项对比文件的单篇全覆盖判定（从属权项已按引用链并入所引用权项的全部要素）、相对主对比文件的区别特征、从属权项"仅附加特征被覆盖"的法条路径问题与引用关系缺陷。pin-cite 格式 [文档id 段[xxxx] 图n]，例如 [D1 段[0032] 图3]；文档 id 可含空格（如 [产品 A 段[0001]]），段号可写范围（如 [D1 段[0032]-[0034]]），多图写作 图3、图4；目标未提供源文时 pin-cite 留空串。'

/** 覆盖结论的中文说明（描述数据，不是法律结论）。 */
const OUTCOME_LABELS: Record<AllElementsOutcome, string> = {
  literal: '全部要素字面覆盖',
  'construction-dependent': '全部要素字面覆盖，但依赖权利要求解释',
  'equivalence-required': '全部要素已覆盖，其中部分需按等同认定',
  'not-covered': '存在未覆盖要素（缺项）',
  undetermined: '要素表为空，无法判定',
}

/** 等同认定矛盾的中文说明（类型码保留英文，便于与图表/记录对照）。 */
const CONTRADICTION_LABELS: Record<EquivalenceContradictionKind, string> = {
  'doe-without-triplet': '按等同落格但无认定记录',
  'duplicate-triplet': '同一要素与目标有多条认定记录',
  'triplet-denies-doe': '认定记录否定等同但图表按等同落格',
  'doe-without-common-element': '按等同落格但要素无字面相同基础',
  'inventive-effort-required': '认定等同同时认定需创造性劳动',
  'equivalence-not-mapped': '认定等同但未落到图表上',
}

/**
 * Render the deterministic infringement conclusion: per accused product the
 * all-elements outcome with its element breakdown, the equivalence
 * contradictions, and either the risk level or what is missing to compute one.
 * @param conclusion - the derived conclusion.
 * @returns the section lines.
 */
function renderConclusion(conclusion: InfringementConclusion): string[] {
  const lines = ['', '## 确定性结论（程序按行级映射判定，未经模型判断）']
  for (const [index, entry] of conclusion.coverage.entries()) {
    const parts = [
      `字面 ${entry.literalElements.length}`,
      `待解释 ${entry.constructionDependentElements.length}`,
      `需等同 ${entry.equivalenceCandidates.length}`,
      `缺项 ${entry.missingElements.length}`,
    ]
    lines.push(`- 被控产品 ${entry.targetId}: ${OUTCOME_LABELS[entry.outcome]}（要素 ${entry.elementCount} 个，${parts.join('，')}）`)
    if (entry.claims.length > 1) {
      const perClaim = entry.claims.map(claim => `权利要求 ${claim.claimNo} ${claim.outcome}`).join('；')
      lines.push(`  - 逐权项结论: ${perClaim}（整体取覆盖最佳权项）`)
    }
    if (entry.missingElements.length > 0) lines.push(`  - 缺项要素: ${entry.missingElements.join(', ')}`)
    if (entry.equivalenceCandidates.length > 0) {
      lines.push(`  - 需等同认定的要素: ${entry.equivalenceCandidates.join(', ')}`)
    }
    const score = conclusion.scores?.[index]
    if (score !== undefined) {
      lines.push(
        `  - 风险等级: ${score.riskLevel}（加权 ${score.composite.toFixed(3)}／量程 ${score.weightSum}，高 ≥ ${score.thresholds.high.toFixed(3)}，中 ≥ ${score.thresholds.medium.toFixed(3)}）`,
      )
    }
  }
  if (conclusion.scores === undefined) {
    lines.push('- 风险等级: 未计算（评分只用可复核的结构化事实；提供 risk.defenses 与 risk.remedyExposureRatio 后计算）')
  }
  lines.push(`- 等同认定矛盾: ${conclusion.contradictions.length} 条`)
  for (const item of conclusion.contradictions) {
    lines.push(`  - ${item.elementId}→${item.targetId} [${item.kind}] ${CONTRADICTION_LABELS[item.kind]}: ${item.detail}`)
  }
  return lines
}

/** Render the canonical claim-chart value into model-facing prose. */
function renderClaimChart(value: ClaimChartOutput): string {
  const c = value.chart
  const lines = [
    `claim_chart_build: 模式 ${c.mode}，权利要求 ${c.claimNos.join(', ')}，要素 ${c.elements.length} 个，映射行 ${c.rows.length} 行，gap ${c.gaps.length} 个。`,
    '',
  ]
  if (c.gaps.length > 0) {
    lines.push('## Gap list', ...c.gaps.map(g => `- ${g.elementId}→${g.targetId}（${g.kind}）: ${g.reason} → ${g.suggestion}`))
  } else {
    lines.push('## Gap list', '无 gap（全部要素已映射）。')
  }
  if (value.infringement_conclusion !== undefined) {
    lines.push(...renderConclusion(value.infringement_conclusion as unknown as InfringementConclusion))
  }
  if (value.invalidity_conclusion !== undefined) {
    lines.push('', ...renderInvalidityConclusion(value.invalidity_conclusion as InvalidityConclusion, c).split('\n'))
  }
  if (value.json_path !== undefined && value.md_path !== undefined) {
    lines.push('', `落盘: ${value.json_path} + ${value.md_path}`)
  }
  return lines.join('\n')
}

/** 抗辩成立可能性的取值域。 */
const DEFENSE_VIABILITIES: readonly string[] = ['high', 'medium', 'low']

const input = createToolInputReader('claim_chart_build')
const invalidToolInput = input.invalid
const requireString = input.requireString
const requireBoolean = input.requireBoolean

/** 校验映射目标列表；数组元素是模型 JSON，可能为 null、缺 id 或给未知 kind。 */
function parseTargets(raw: unknown): ClaimChartTargetInput[] {
  /* v8 ignore next -- the tool schema rejects a non-array before execute; the guard serves direct callers */
  if (!Array.isArray(raw)) throw invalidToolInput('targets 必须是数组')
  return raw.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw invalidToolInput(`targets[${index}] 必须是对象`)
    }
    const record = entry as Record<string, unknown>
    const id = requireString(record.id, `targets[${index}].id`)
    if (id.trim() === '') throw invalidToolInput(`targets[${index}].id 不能为空`)
    if (record.kind !== 'prior-art' && record.kind !== 'accused-product') {
      throw invalidToolInput(`targets[${index}].kind 必须是 prior-art 或 accused-product`)
    }
    const title = record.title === undefined ? undefined : requireString(record.title, `targets[${index}].title`)
    const sourcePath = record.source_path === undefined
      ? undefined
      : requireString(record.source_path, `targets[${index}].source_path`)
    return {
      id,
      kind: record.kind,
      ...(title === undefined ? {} : { title }),
      ...(sourcePath === undefined ? {} : { source_path: sourcePath }),
    }
  })
}

/** 校验抗辩成立可能性数组；缺省为空（按"无抗辩"处理）。 */
function parseDefenses(raw: unknown): DefenseViability[] {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) throw invalidToolInput('risk.defenses 必须是数组（每项 high|medium|low）')
  return raw.map((entry) => {
    if (typeof entry !== 'string' || !DEFENSE_VIABILITIES.includes(entry)) {
      throw invalidToolInput(`risk.defenses 取值非法: ${JSON.stringify(entry)}（须为 high|medium|low）`)
    }
    return entry as DefenseViability
  })
}

/** 校验等同三要素认定记录（字段名与内核 EquivalenceTriplet 一致）。 */
function parseEquivalents(raw: unknown): EquivalenceTriplet[] {
  if (!Array.isArray(raw)) throw invalidToolInput('risk.equivalents 必须是数组（逐要素等同三要素认定记录）')
  return raw.map((entry) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw invalidToolInput('risk.equivalents 的每一项必须是对象')
    }
    const record = entry as Record<string, unknown>
    return {
      elementId: requireString(record.elementId, 'risk.equivalents[].elementId'),
      targetId: requireString(record.targetId, 'risk.equivalents[].targetId'),
      sameMeans: requireBoolean(record.sameMeans, 'risk.equivalents[].sameMeans'),
      sameFunction: requireBoolean(record.sameFunction, 'risk.equivalents[].sameFunction'),
      sameEffect: requireBoolean(record.sameEffect, 'risk.equivalents[].sameEffect'),
      inventiveEffortRequired: requireBoolean(record.inventiveEffortRequired, 'risk.equivalents[].inventiveEffortRequired'),
      isEquivalent: requireBoolean(record.isEquivalent, 'risk.equivalents[].isEquivalent'),
    }
  })
}

/**
 * Parse the optional `risk` argument into the kernel's conclusion input. The
 * shape is validated field by field: a score computed from a half-parsed fact
 * set would be a number that looks authoritative and is not.
 * @param raw - the raw tool argument.
 * @returns the kernel input, or undefined without a risk argument.
 */
function parseConclusionInput(raw: unknown): InfringementConclusionInput | undefined {
  if (raw === undefined) return undefined
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalidToolInput('risk 必须是对象（{ defenses, remedyExposureRatio, estoppelApplied?, dedicationApplied?, equivalents? }）')
  }
  const input = raw as Record<string, unknown>
  if (typeof input.remedyExposureRatio !== 'number') {
    throw invalidToolInput('risk.remedyExposureRatio 必须是 0–1 的数（按案件金额量程归一）')
  }
  return {
    ...(input.equivalents !== undefined ? { triplets: parseEquivalents(input.equivalents) } : {}),
    scoring: {
      defenses: parseDefenses(input.defenses),
      remedyExposureRatio: input.remedyExposureRatio,
      ...(input.estoppelApplied !== undefined
        ? { estoppelApplied: requireBoolean(input.estoppelApplied, 'risk.estoppelApplied') }
        : {}),
      ...(input.dedicationApplied !== undefined
        ? { dedicationApplied: requireBoolean(input.dedicationApplied, 'risk.dedicationApplied') }
        : {}),
    },
  }
}

/**
 * Build the `claim_chart_build` tool over an injectable model port.
 * @param deps - the model port driving element splitting + mapping.
 * @returns a registry-ready tool definition.
 */
export function createClaimChartBuildTool(deps: ClaimChartBuildDeps = {}): ToolDefinition {
  return defineTool({
    name: 'claim_chart_build',
    description: DESCRIPTION,
    parameters: {
      mode: { type: 'string', required: true, enum: ['infringement', 'invalidity', 'oa-response', 'reexamination', 'patentability'], description: '场景模式：infringement=侵权（被控产品，支持 doe）/invalidity=无效/oa-response=审查意见答复/reexamination=复审/patentability=撰写前可专利性' },
      claim_text: { type: 'string', required: true, description: '权利要求原文（需拆分的权利要求，可含多条）' },
      targets: { type: 'array', required: true, items: { type: 'json' }, description: '映射目标列表（对比文件/被控产品材料），每项 {id, kind: prior-art|accused-product, title?, source_path?}。id 原样出现在 pin-cite 里（格式 [文档id 段[xxxx] 图n]，如 [D1 段[0032] 图3]），可含空格如 "产品 A"；source_path 指向该目标的文本文件时按段号/逐字引用核对引用，源文无 [xxxx] 段号标记（如 Google Patents 转存文本）时只核对逐字引用。' },
      case_id: { type: 'string', description: '案卷 ID（提供时结果落盘 data/cases/<case_id>/outputs/）' },
      risk: { type: 'json', description: '侵权模式的评分事实（可选）：{defenses: (high|medium|low)[], remedyExposureRatio: 0–1, estoppelApplied?, dedicationApplied?, equivalents?: 等同三要素认定记录[]}。不提供时不计算风险等级；评分只用这些可复核事实，工具不接受直接给出的分数或等级。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          chart: { type: 'json', required: true },
          json_path: { type: 'string' },
          md_path: { type: 'string' },
          gap_count: { type: 'integer', required: true },
          infringement_conclusion: { type: 'json' },
          invalidity_conclusion: { type: 'json' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderClaimChart(value as unknown as ClaimChartOutput) }],
    },
    async execute(args, exec) {
      if (args.claim_text.trim().length === 0) {
        throw new PatentToolError('invalid_tool_input', 'claim_text 为空', { tool: 'claim_chart_build' })
      }
      if (args.case_id !== undefined) {
        try {
          assertSafePathSegment(args.case_id, 'case_id')
        } catch (error) {
          throw new PatentToolError(
            'invalid_tool_input',
            /* v8 ignore next -- assertSafePathSegment only throws RangeError */
            error instanceof Error ? error.message : String(error),
            { tool: 'claim_chart_build' },
          )
        }
      }
      const model = loggedToolModel(exec, deps.model, { callSite: 'claim_chart_build' })
      if (model === undefined) {
        throw new PatentToolError('setup_required', '未配置 LLM（模型客户端缺失），无法执行要素拆分与映射', { tool: 'claim_chart_build' })
      }
      const conclusionInput = parseConclusionInput(args.risk)
      const inputTargets = parseTargets(args.targets)
      const targets: ChartTarget[] = inputTargets.map(t => ({
        id: t.id,
        kind: t.kind,
        ...(t.title !== undefined ? { title: t.title } : {}),
        ...(t.source_path !== undefined ? { sourcePath: t.source_path } : {}),
      }))
      const provider: StageProvider = { ...(args.case_id !== undefined ? { caseId: args.case_id } : {}), llm: model }
      const handler = new ClaimChartHandler()
      const state = await handler.execute({
        state: { claim: args.claim_text, chart_targets: JSON.stringify(targets), chart_mode: args.mode },
        provider,
      })
      if (typeof state._error === 'string') {
        throw new PatentToolError('tool_execution_failed', state._error, { tool: 'claim_chart_build' })
      }
      /* v8 ignore next -- the success state always carries a string claim_chart_doc (degraded states carry _error). */
      const doc = typeof state.claim_chart_doc === 'string' ? state.claim_chart_doc : '{}'
      const chart = JSON.parse(doc) as ClaimChart
      const rawPaths = typeof state.claim_chart_paths === 'string' ? state.claim_chart_paths : undefined
      const paths = rawPaths !== undefined ? (JSON.parse(rawPaths) as { jsonPath: string; mdPath: string }) : undefined
      // 结论按模式分派：侵权模式出全面覆盖/等同矛盾/风险等级，无效与复审模式出单篇全覆盖、
      // 区别特征、从属权项法条路径与引用关系问题。两种结论都由行级映射算出，口径各自归内核；
      // 无效与复审的结论由 claim-chart 原子随图表一并算出并存在图表里，此处只取回。
      const conclusion = chart.mode === 'infringement'
        ? deriveInfringementConclusion(chart, conclusionInput)
        : undefined
      const invalidity = chart.invalidityConclusion
      return {
        chart: chart as unknown as JsonValue,
        ...(paths !== undefined ? { json_path: paths.jsonPath, md_path: paths.mdPath } : {}),
        gap_count: chart.gaps.length,
        ...(conclusion !== undefined ? { infringement_conclusion: conclusion as unknown as JsonValue } : {}),
        ...(invalidity !== undefined ? { invalidity_conclusion: invalidity as JsonValue } : {}),
      }
    },
  })
}
