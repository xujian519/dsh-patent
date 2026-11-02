/**
 * `flexible_plan` tool: flexible plan for patent cases (stage-level HITL):
 * create → atomic run → per-stage confirm/rollback, plus runtime
 * add/remove/reorder and complete/abandon. Wires the dsh-patent-workflow
 * flexible-plan state machine with persistence keyed by caseId, and executes
 * unconfirmed stages through runWorkflow exactly like patent_workflow_run.
 * @module @deepseek-ai/dsh-patent-tools/tool/patent-flexible-plan
 */

import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  globalAtomRegistry,
  globalStageHandlerRegistry,
  type StageHandlerRegistry,
  type WorkflowRunResult,
} from '@deepseek-ai/dsh-patent-core'
import {
  FlexiblePlanError,
  JsonFileFlexiblePlanStore,
  abandon,
  addStage,
  complete,
  confirmStage,
  createFlexiblePlan,
  removeStage,
  reorderStages,
  rollbackStage,
  toManifest,
  type FlexiblePlanState,
  type FlexiblePlanStore,
  type FlexibleStage,
} from '@deepseek-ai/dsh-patent-workflow'
import { PatentToolError } from '../error.ts'
import { loggedToolModel } from './internal/model-call-log.ts'
import {
  buildWorkflowProvider,
  buildWorkflowRunContext,
  createChainStageExecutor,
  renderWorkflowResultText,
  renderWorkflowStageLines,
  resolveWorkflowRunsDir,
  runWorkflowWithPersist,
  writeRunArtifacts,
  type WorkflowProviderDeps,
} from './internal/workflow-helpers.ts'

/** The flexible-plan operations. */
export type FlexiblePlanAction =
  | 'create'
  | 'get'
  | 'run'
  | 'confirm'
  | 'rollback'
  | 'add'
  | 'remove'
  | 'reorder'
  | 'complete'
  | 'abandon'

/** A stage definition as supplied by the caller (status/artifacts are filled in). */
export type FlexiblePlanStageInput = {
  /** Unique stage id. */
  id: string
  /** Human-readable stage name. */
  name: string
  /** The stage's goal (becomes the manifest stage description). */
  goal: string
  /** Execution strategy. */
  strategy: 'chain' | 'react' | 'sub_agent'
  /** Optional atom to auto-execute this stage on run. */
  atom?: string
  /** Optional static params passed to the stage handler. */
  params?: Record<string, unknown>
  /** Optional artifact list (default empty). */
  artifacts?: string[]
  /** Optional fact-blackboard constraint ids. */
  constraintIds?: string[]
  /** Optional fact-blackboard article-judgment ids. */
  articleJudgments?: string[]
}

/** Tool input: the operation plus its arguments. */
export type FlexiblePlanToolInput = {
  /** Operation to perform. */
  action: FlexiblePlanAction
  /** Plan key (required for every operation; persists by this id). */
  caseId?: string
  /** Orchestration type (create). */
  caseType?: string
  /** Case input text (create persists it for later runs; run can override it). */
  inputText?: string
  /** Explicit technical field (create; else inferred from inputText). */
  technicalField?: string
  /** Stage definitions (create / add as a list for create). */
  stages?: FlexiblePlanStageInput[]
  /** Single stage definition (add). */
  stage?: FlexiblePlanStageInput
  /** Target stage id (confirm / rollback / remove). */
  stageId?: string
  /** New stage order (reorder, must include all ids). */
  stageIds?: string[]
  /** Abandon reason, kept for audit (abandon). */
  reason?: string
  /** Rollback reason, kept in the RevisionRecord (rollback). */
  rationale?: string
  /** Digest or short summary of the output being replaced (rollback). */
  before?: string
  /** Max prior-art search results for run (default 5). */
  maxResults?: number
  /** When true, run confirms all successful (non-degraded) stages at the end. */
  autoConfirm?: boolean
}

/** Tool canonical result: the plan state, and the run result for run. */
export type FlexiblePlanOutput = {
  /** The operation echoed back. */
  action: FlexiblePlanAction
  /** The plan key. */
  caseId: string
  /** The plan state after the operation (create/get/mutations/run). */
  plan?: FlexiblePlanState
  /** The workflow run result (run only). */
  run?: WorkflowRunResult
  /** Persistence note (run only). */
  persistNote?: string
}

/** Tool dependencies: model port + search (inherited) plus handlers/store/cwd/clock. */
export interface FlexiblePlanToolDeps extends WorkflowProviderDeps {
  /** Stage-handler registry (default: the global registry). */
  handlers?: StageHandlerRegistry
  /** Plan store (default: JsonFileFlexiblePlanStore under `<caseDir>/workflow-runs/flexible-plans/`). */
  store?: FlexiblePlanStore
  /** Working directory (default process.cwd()). */
  cwd?: string
  /** Injectable clock (tests). */
  now?: () => string
}

/**
 * `atom` parameter description: the atoms this build can execute, with the params
 * each one reads. Atoms declared here but absent from the registry fall back to
 * the caller's executor, so the list is the model's only view of what a plan can
 * automate; the registration spec asserts it covers every registered atom.
 */
export const ATOM_PARAM_DESCRIPTION = [
  'Atom name to auto-execute this stage. Available atoms:',
  'approval-gate (params.review_context), claim-chart (params.chart_mode: infringement|invalidity|oa-response|reexamination|patentability),',
  'compare, coverage, dispute-framing, dispute-framing-refine, draft-claims, draft-specification, extract (params.extraction_type, output_key, output_mode: problem_insight), groundedness, pfe-consistency,',
  'grounds (params.ground_program: invalidation|reexamination|design), keywords, merge, novelty, oa-parse, reasoning, response-plan, search,',
  'amendment-basis (params.amended_text_keys, original_text_keys), slop-gate (params.text_keys, char_budget), tighten (params.text_key, plan_key, char_budget), figure-analysis (params.source_key), spec-check (params.mode: spec|claims, text_key, claims_key), citation-check (params.ref_text_keys, prior_art_key), time-baseline (params.filing_date_key, priority_date_key), prior-art-filter (params.publication_date_key, a24_exception_key), conflicting-application (params.conflicting_applications_key, target_date_key, target_filing_date_key), evidence-check (params.evidence_key, deadline_key, reference_date_key, filing_date_key, priority_date_key), eligibility (params.claims_key, text_key), numeric-range (params.claim_text_keys, prior_art_key), problem-check (params.diff_text_keys, feature_keys), response-check (params.response_key, office_action_key, notice_key).',
  'legal-gaps (params.profile: novelty|disclosure|inventiveness|patentability|oa-response|invalidation|reexamination|infringement).',
  'adversary-model (params: none; reads office_action, claims, response_plan, response_plan_summary and calls the model), adversary-review (params: none; deterministic re-check of draft_tightened (falls back to draft), reference_documents or office_action.citations, claims, office_action; writes adversary_review_passed for legal-gaps).',
  'enablement-report (params: none; reads specification, claims_draft and tech_domain, then calls the model to quote embodiments for each independent-claim feature and re-checks the quotes against the specification).',
  'claim-breadth (params: none; reads specification, claims_draft and tech_domain, then calls the model for one record per upper-level generalization and re-checks each quote against the specification).',
  'claim-strategy (params: none; reads pfe_triples/merge_result/novelty_conclusion/prior_art/source_text/tech_domain, or confirmed_features when the caller supplies the table; writes anchor-checked claim_strategy and claim_strategy_report).',
  'draft-claims (params: none; reads claim_strategy, renders the independent claim and dependent tree deterministically, lets a dependent-claim specialist only reorder or supplement dependents, and vetoes the draft on any claim_lint error).',
].join(' ')

/** Stage JSON schema shared by create's stages list and add's single stage. */
const STAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    goal: { type: 'string', required: true },
    strategy: { type: 'string', required: true, enum: ['chain', 'react', 'sub_agent'] },
    atom: { type: 'string', description: ATOM_PARAM_DESCRIPTION },
    params: { type: 'object', additionalProperties: true, description: 'Static params passed to the stage handler.' },
    artifacts: { type: 'array', items: { type: 'string' } },
    constraintIds: { type: 'array', items: { type: 'string' } },
    articleJudgments: { type: 'array', items: { type: 'string' } },
  },
} as const

const ACTIONS_LABEL = 'create / get / run / confirm / rollback / add / remove / reorder / complete / abandon'
const DESCRIPTION = [
  'Flexible plan for patent cases (stage-level HITL). create: build a plan (optional IPC technical-field inference from the disclosure text). run: execute unconfirmed stages (pending + rolled_back) via the atom registry with LLM + prior-art search, exactly like patent_workflow_run. confirm / rollback: freeze or redo one stage; add / remove / reorder: edit stages at runtime; complete / abandon: finish the plan. Plans persist by caseId across calls (unlike patent_plan_task, which is stateless). confirmed stages are frozen, so confirm fixes the output; autoConfirm=true confirms all successful stages at the end of a run.',
].join('\n')
/** Convert a caller-supplied stage into the state-machine stage (status pending). */
function toFlexibleStage(s: FlexiblePlanStageInput): FlexibleStage {
  return {
    id: s.id,
    name: s.name,
    goal: s.goal,
    strategy: s.strategy,
    ...(s.atom !== undefined ? { atom: s.atom } : {}),
    ...(s.params !== undefined ? { params: s.params } : {}),
    status: 'pending',
    artifacts: s.artifacts ?? [],
    constraintIds: s.constraintIds ?? [],
    articleJudgments: s.articleJudgments ?? [],
  }
}

/** Render a plan summary (status/technical field/current stage + stage list). */
function renderPlan(plan: FlexiblePlanState): string {
  const lines = plan.stages.map((s) => {
    const flag = s.status === 'confirmed' ? '✅' : s.status === 'rolled_back' ? '↩️' : '⏳'
    const atomNote = s.atom !== undefined ? ` [atom:${s.atom}]` : ''
    const artifactNote = s.artifacts.length > 0 ? `（产物: ${s.artifacts.length} 项）` : ''
    return `- ${flag} ${s.id}${atomNote}（${s.strategy}）: ${s.goal}${artifactNote}`
  })
  const parts = [`flexible_plan(caseId=${plan.caseId}, caseType=${plan.caseType}, status=${plan.status})`]
  if (plan.technicalField !== undefined) parts.push(`技术领域: ${plan.technicalField}`)
  parts.push(`当前阶段: ${plan.currentStageId ?? '（无待执行阶段）'}`, ...lines)
  return parts.join('\n')
}

/** Load a plan, throwing FlexiblePlanError when it does not exist. */
async function loadPlan(store: FlexiblePlanStore, caseId: string): Promise<FlexiblePlanState> {
  const plan = await store.loadPlan(caseId)
  if (plan === undefined) throw new FlexiblePlanError(`计划 "${caseId}" 不存在（先用 action=create 创建）`)
  return plan
}

/** Default plan store: `<caseDir>/workflow-runs/flexible-plans/`. */
function defaultPlanStore(caseId: string, cwd: string): FlexiblePlanStore {
  const runsDir = resolveWorkflowRunsDir(caseId, cwd)
  return new JsonFileFlexiblePlanStore(join(runsDir, 'flexible-plans'))
}

/** One mutation's validation + state-machine transform. */
type MutationSpec = {
  /** Pre-validation: returns a missing-argument message, or undefined to pass. */
  require?: (input: FlexiblePlanToolInput) => string | undefined
  /** The state-machine mutation (applied after loadPlan). */
  apply: (state: FlexiblePlanState, input: FlexiblePlanToolInput) => FlexiblePlanState
}

const MUTATIONS: Partial<Record<Exclude<FlexiblePlanAction, 'create' | 'get' | 'run'>, MutationSpec>> = {
  confirm: {
    require: i => (i.stageId === undefined ? 'confirm 需要 stageId' : undefined),
    // require 已保证 stageId 存在，apply 不再重查。
    apply: (s, i) => confirmStage(s, i.stageId as string),
  },
  rollback: {
    require: i => (i.stageId === undefined ? 'rollback 需要 stageId' : undefined),
    apply: (s, i) => rollbackStage(s, i.stageId as string, {
      ...(i.rationale !== undefined ? { rationale: i.rationale } : {}),
      ...(i.before !== undefined ? { before: i.before } : {}),
    }),
  },
  add: {
    require: i => (i.stage === undefined ? 'add 需要 stage' : undefined),
    apply: (s, i) => addStage(s, toFlexibleStage(i.stage as FlexiblePlanStageInput)),
  },
  remove: {
    require: i => (i.stageId === undefined ? 'remove 需要 stageId' : undefined),
    apply: (s, i) => removeStage(s, i.stageId as string),
  },
  reorder: {
    require: i => (i.stageIds === undefined ? 'reorder 需要 stageIds（含全部阶段 id）' : undefined),
    apply: (s, i) => reorderStages(s, i.stageIds as string[]),
  },
  complete: {
    apply: s => complete(s),
  },
  abandon: {
    require: i => (i.reason !== undefined && i.reason.trim() !== '' ? undefined : 'abandon 需要 reason（审计留痕）'),
    apply: (s, i) => abandon(s, i.reason as string),
  },
}

/** The appended mutation message for a mutation action. */
function mutationMessage(action: FlexiblePlanAction, input: FlexiblePlanToolInput): string {
  switch (action) {
    case 'confirm':
      return `已确认阶段 "${input.stageId}"。`
    case 'rollback':
      return `已回退到阶段 "${input.stageId}"（其及后续已确认阶段置 rolled_back 保留审计）。`
    case 'add':
      return `已追加阶段 "${input.stage?.id}"。`
    case 'remove':
      return `已删除阶段 "${input.stageId}"。`
    case 'reorder':
      return '已重排阶段顺序。'
    case 'complete':
      return '计划已完成（status=completed）。'
    case 'abandon':
      return '计划已放弃（status=abandoned）。'
    /* v8 ignore next 2 -- every mutation action has a message case above. */
    default:
      return ''
  }
}

/**
 * Render the canonical plan/run value into model-facing prose.
 * @param args - the tool input (for mutation messages).
 * @param value - the plan/run result.
 * @returns the multi-line plan summary or run result.
 */
export function renderFlexiblePlan(args: FlexiblePlanToolInput, value: FlexiblePlanOutput): string {
  const plan = value.plan
  /* v8 ignore next 3 -- every execute return path carries a plan. */
  if (plan === undefined) {
    // 不可达：execute 的每个返回路径都携带 plan。
    return ''
  }
  const run = value.run
  switch (value.action) {
    case 'create':
      return `${renderPlan(plan)}\n已创建并持久化（action=run 执行未确认阶段）。`
    case 'get':
      return renderPlan(plan)
    case 'run': {
      /* v8 ignore next 3 -- every action=run return path carries the run result. */
      if (run === undefined) {
        // 不可达：action=run 的返回恒携带 run。
        return ''
      }
      const interruptNote = run.interrupted
        ? `⏸ 审批门暂停: "${run.interrupted.stageId}"（${run.interrupted.message}）——等待人工确认，后续阶段未执行`
        : undefined
      return renderWorkflowResultText({
        toolName: 'flexible_plan(run)',
        result: run,
        stageLines: renderWorkflowStageLines(run),
        persistNote: value.persistNote ?? '持久化: 未启用',
        checkSection: '',
        ...(interruptNote !== undefined ? { interruptNote } : {}),
      })
    }
    default:
      return `${renderPlan(plan)}\n${mutationMessage(value.action, args)}`
  }
}

/** The provider deps with the model port bound to the calling agent's session. */
function bindModel(
  deps: FlexiblePlanToolDeps,
  exec: Pick<ToolRunContext, 'agent'>,
  manifestId: string,
): FlexiblePlanToolDeps {
  const model = loggedToolModel(exec, deps.model, { callSite: 'flexible_plan', manifestId })
  return model === undefined ? deps : { ...deps, model }
}

/**
 * Build the `flexible_plan` tool.
 * @param deps - model port, search, handler registry, plan store, cwd, clock.
 * @returns a registry-ready tool definition.
 */
export function createFlexiblePlanTool(deps: FlexiblePlanToolDeps = {}): ToolDefinition {
  const cwd = deps.cwd ?? process.cwd()

  return defineTool({
    name: 'flexible_plan',
    description: DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['create', 'get', 'run', 'confirm', 'rollback', 'add', 'remove', 'reorder', 'complete', 'abandon'],
        description: 'Operation: create | get | run | confirm | rollback | add | remove | reorder | complete | abandon.',
      },
      caseId: { type: 'string', required: true, description: 'Plan key (required for every operation; persists by this id).' },
      caseType: { type: 'string', description: 'Orchestration type, e.g. invalidation / infringement / drafting (create).' },
      inputText: { type: 'string', description: 'Case input text (create persists it for later runs; run can override it).' },
      technicalField: { type: 'string', description: 'Explicit technical field (create; else inferred from inputText).' },
      stages: { type: 'array', items: STAGE_SCHEMA, description: 'Stage definitions (create).' },
      stage: { description: 'Single stage definition (add).', ...STAGE_SCHEMA },
      stageId: { type: 'string', description: 'Target stage id (confirm / rollback / remove).' },
      stageIds: { type: 'array', items: { type: 'string' }, description: 'New stage order (reorder, must include all ids).' },
      reason: { type: 'string', description: 'Abandon reason, kept for audit (abandon).' },
      rationale: { type: 'string', description: 'Rollback reason, kept in the revision record (rollback).' },
      before: { type: 'string', description: 'Digest or short summary of the output being replaced (rollback).' },
      maxResults: { type: 'number', description: 'Max prior-art search results for run (default 5).' },
      autoConfirm: { type: 'boolean', description: 'When true, run confirms all successful (non-degraded) stages at the end.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true, enum: ['create', 'get', 'run', 'confirm', 'rollback', 'add', 'remove', 'reorder', 'complete', 'abandon'] },
          caseId: { type: 'string', required: true },
          plan: { type: 'json' },
          run: { type: 'json' },
          persistNote: { type: 'string' },
        },
      },
      render: (args, value) => [
        { type: 'text', text: renderFlexiblePlan(args as unknown as FlexiblePlanToolInput, value as unknown as FlexiblePlanOutput) },
      ],
    },
    async execute(args, exec) {
      const input = args as unknown as FlexiblePlanToolInput
      /* v8 ignore next -- the caseId schema field is required, so it can never be empty here. */
      if (input.caseId === undefined || input.caseId.trim() === '') {
        throw new PatentToolError('invalid_tool_input', 'flexible_plan: caseId 不能为空（计划按 caseId 持久化，跨调用状态）')
      }
      const store = deps.store ?? defaultPlanStore(input.caseId, cwd)
      try {
        const mutation = MUTATIONS[input.action as keyof typeof MUTATIONS]
        if (mutation !== undefined) {
          const missing = mutation.require?.(input)
          if (missing !== undefined) throw new PatentToolError('invalid_tool_input', `flexible_plan: ${missing}`)
          const plan = await loadPlan(store, input.caseId)
          const updated = mutation.apply(plan, input)
          await store.savePlan(updated)
          return { action: input.action, caseId: input.caseId, plan: updated as unknown as JsonValue }
        }

        switch (input.action) {
          case 'create': {
            if (input.caseType === undefined || input.caseType.trim() === '') {
              throw new PatentToolError('invalid_tool_input', 'flexible_plan: create 需要 caseType')
            }
            const plan = createFlexiblePlan(input.caseId, input.caseType, {
              ...(input.inputText !== undefined ? { inputText: input.inputText } : {}),
              ...(input.technicalField !== undefined ? { technicalField: input.technicalField } : {}),
              stages: (input.stages ?? []).map(toFlexibleStage),
              ...(deps.now !== undefined ? { now: deps.now } : {}),
            })
            await store.savePlan(plan)
            return { action: 'create' as const, caseId: input.caseId, plan: plan as unknown as JsonValue }
          }
          case 'get': {
            const plan = await loadPlan(store, input.caseId)
            return { action: 'get' as const, caseId: input.caseId, plan: plan as unknown as JsonValue }
          }
          case 'run': {
            const plan = await loadPlan(store, input.caseId)
            const manifest = toManifest(plan)
            const provider = buildWorkflowProvider(
              bindModel(deps, exec, manifest.id),
              { caseId: input.caseId },
            )
            if (!provider) {
              throw new PatentToolError(
                'setup_required',
                'flexible_plan: 未提供模型客户端（deps.model 缺失），无法执行原子阶段。请在有模型会话中调用。',
              )
            }
            const sourceText = input.inputText ?? plan.inputText ?? ''
            const workflowCtx = buildWorkflowRunContext({
              caseId: input.caseId,
              input: sourceText,
              ...(input.maxResults !== undefined ? { maxResults: input.maxResults } : {}),
            })
            const executor = createChainStageExecutor(provider, 'flexible_plan')
            const { result, persistTarget } = await runWorkflowWithPersist(manifest, workflowCtx, executor, {
              handlers: deps.handlers ?? globalStageHandlerRegistry,
              atoms: globalAtomRegistry,
              provider,
              signal: exec.signal,
              caseId: input.caseId,
              cwd,
            })

            let updated = plan
            if (input.autoConfirm === true) {
              for (const stage of result.stages) {
                /* v8 ignore next -- the chain executor never degrades a stage in this build. */
                if (!stage.degraded) updated = confirmStage(updated, stage.stageId)
              }
              await store.savePlan(updated)
            }
            /* v8 ignore next -- the caseId schema field is required, so run always persists. */
            const persistNote = persistTarget !== undefined
              ? await writeRunArtifacts(persistTarget, manifest, result)
              : '持久化: 未启用'
            return {
              action: 'run' as const,
              caseId: input.caseId,
              plan: updated as unknown as JsonValue,
              run: result as unknown as JsonValue,
              persistNote,
            }
          }
          /* v8 ignore next 5 -- the action schema enum already rejects unknown actions. */
          default:
            throw new PatentToolError(
              'invalid_tool_input',
              `flexible_plan: 未知操作 "${input.action}"（可选: ${ACTIONS_LABEL}）`,
            )
        }
      } catch (err) {
        if (err instanceof PatentToolError) throw err
        throw new PatentToolError('tool_execution_failed', `flexible_plan: ${err instanceof Error ? err.message : String(err)}`)
      }
    },
  })
}
