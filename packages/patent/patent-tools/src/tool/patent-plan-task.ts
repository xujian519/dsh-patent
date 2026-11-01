/**
 * `patent_plan_task` tool: human-in-the-loop plan state machine for patent
 * tasks. Wire the dsh-patent-workflow plantask library (PlanTaskStateMachine,
 * syncPlanToTasks, replanTasks, TRANSITIONS) with fail-closed input validation
 * and canonical results. Stateless: the caller passes the current state on
 * every call.
 * @module @deepseek-ai/dsh-patent-tools/tool/patent-plan-task
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { assertNever, type JsonValue } from '@deepseek-ai/dsh-util-values'
import {
  ISSUE_BLOCKING_GRADES,
  ISSUE_DISPOSITIONS,
  ISSUE_KINDS,
  loadIssueDispositions,
  PlanTaskSemanticError,
  PlanTaskStateMachine,
  replanTasks,
  resolveDocketIssue,
  syncPlanToTasks,
  TRANSITIONS,
  type DocketIssue,
  type DocketIssueDraft,
  type PlanTask,
  type PlanTaskState,
} from '@deepseek-ai/dsh-patent-workflow'
import { PatentToolError } from '../error.ts'

/** The three plantask operations. */
export type PatentPlanTaskAction = 'transition' | 'sync' | 'replan'

/**
 * Case-docket entry supplied on a transition: a draft plus the close state a
 * previous call reported, so an item stays closed instead of reopening each
 * call. Omitted `disposition`/`blocking` take the kind's asset default.
 */
type PatentPlanTaskIssue = DocketIssueDraft & {
  /** Current close state (defaults to open). */
  status?: DocketIssue['status']
  /** Round that opened the item (defaults to the call's `round`). */
  round_opened?: number
}

/** Tool input: the operation plus the state/tasks it needs. */
export type PatentPlanTaskInput = {
  /** Operation to perform. */
  action: PatentPlanTaskAction
  /** Current state (transition; defaults to planning). */
  currentState?: string
  /** Target state (transition). */
  to?: string
  /** Plan steps to sync into tasks (sync/replan). */
  planSteps?: string[]
  /** Previously synced tasks (replan: preserve completed steps by hash). */
  previousTasks?: PlanTask[]
  /** Current task list (transition to executing: must be synced first). */
  tasks?: PlanTask[]
  /** Feedback driving replanning (transition to replanning). */
  feedback?: string
  /** Case-docket entries the transition guards read (transition only). */
  issues?: PatentPlanTaskIssue[]
  /** Planning round opening the drafted issues (required when `issues` is given, 1-based). */
  round?: number
  /** Completed planning rounds (with maxRounds, bounds replanning). */
  rounds?: number
  /** Allowed planning rounds (with rounds, bounds replanning). */
  maxRounds?: number
}

/** Tool canonical result: the operation outcome plus derived task state. */
export type PatentPlanTaskOutput = {
  /** Whether the operation succeeded (false carries an input error). */
  ok: boolean
  /** The operation echoed back. */
  action: PatentPlanTaskAction
  /** Transition: the state the call started from. */
  from?: PlanTaskState
  /** Transition: the resulting state. */
  state?: PlanTaskState
  /** sync/replan: the ordered task list. */
  tasks?: PlanTask[]
  /** replan: task ids preserved from the previous plan (hash-matched completed). */
  preserved?: string[]
  /** sync/replan: task ids to (re)execute. */
  toRun?: string[]
  /** transition: the resolved case-docket entries, for the caller to persist. */
  issues?: DocketIssue[]
  /** Fail-closed reason (only when ok is false). */
  error?: string
}

const DESCRIPTION = [
  'Human-in-the-loop plan state machine for patent tasks. transition: whitelist-checked state changes (planning → awaiting_approval → executing → awaiting_feedback → replanning → finished). sync: turn plan steps into ordered tasks with blockedBy deps. replan: hash-compare completed steps for incremental resume. Fail-closed on illegal transitions and missing semantic preconditions (executing needs tasks and no open blocking docket issue, replanning needs feedback, no open terminal docket issue, and a planning round below maxRounds). Docket entries passed with a transition are resolved against the shipped kind → disposition table, so an omitted disposition/blocking takes the kind default. Stateless: pass the current state and docket on every call.',
].join('\n')

/**
 * Validate a round number at the model-JSON boundary.
 * @param value - the supplied round.
 * @param field - parameter name used in the failure message.
 * @returns the validated round.
 */
function requireRound(value: number | undefined, field: string): number {
  if (value === undefined) {
    throw new PatentToolError('invalid_tool_input', `${field} 需要 round（开启条目的规划轮次，1 起）`)
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new PatentToolError('invalid_tool_input', `${field} 必须是正整数（1 起）`)
  }
  return value
}

/**
 * Resolve docket drafts against the shipped disposition table.
 * @param drafts - drafts supplied with the transition.
 * @param round - planning round opening the drafts.
 * @returns complete docket entries in input order.
 */
function resolveIssues(drafts: readonly PatentPlanTaskIssue[], round: number | undefined): DocketIssue[] {
  const openedIn = requireRound(round, 'issues')
  const dispositions = loadIssueDispositions()
  return drafts.map(({ status, round_opened, ...draft }) => {
    const resolved = resolveDocketIssue(draft, requireRound(round_opened ?? openedIn, 'issues[].round_opened'), dispositions)
    return status === undefined ? resolved : { ...resolved, status }
  })
}
/**
 * Render the canonical plantask value into model-facing prose.
 * @param value - the plantask result.
 * @returns the multi-line result summary.
 */
export function renderPlanTask(value: PatentPlanTaskOutput): string {
  if (!value.ok) return `patent_plan_task: ${value.error ?? '失败'}`
  switch (value.action) {
    case 'transition': {
      const head = `patent_plan_task: ${value.from} → ${value.state} ✅`
      const issues = value.issues ?? []
      if (issues.length === 0) return head
      const lines = issues.map(issue => `- ${issue.id} ${issue.kind}/${issue.blocking}/${issue.status}: ${issue.summary}`)
      return `${head}\n案卷条目 ${issues.length} 条\n${lines.join('\n')}`
    }
    case 'sync': {
      const tasks = value.tasks ?? []
      const lines = tasks.map(
        t => `- ${t.id} ${t.status}${t.blockedBy ? `（依赖 ${t.blockedBy.join(',')}）` : ''}: ${t.description}`,
      )
      return `patent_plan_task: 同步 ${tasks.length} 个任务\n${lines.join('\n')}\n待执行: ${(value.toRun ?? []).join(', ')}`
    }
    case 'replan': {
      const preservedList = value.preserved ?? []
      const preserved = preservedList.length > 0
        ? `保留已完成: ${preservedList.join(', ')}`
        : '无保留步骤'
      return `patent_plan_task: 重规划 → ${(value.tasks ?? []).length} 个任务\n${preserved}\n需执行: ${(value.toRun ?? []).join(', ') || '（全部已完成）'}`
    }
    /* v8 ignore next -- closed-union backstop; the compiler rejects a new plan task action here. */
    default:
      return assertNever(value.action, 'plan task action')
  }
}

/**
 * Build the `patent_plan_task` tool. Pure state-machine wiring; no LLM, search,
 * or persistence.
 * @returns a registry-ready tool definition.
 */
export function createPatentPlanTaskTool(): ToolDefinition {
  return defineTool({
    name: 'patent_plan_task',
    description: DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['transition', 'sync', 'replan'],
        description: 'Operation: transition | sync | replan.',
      },
      currentState: { type: 'string', description: 'Current state (required for transition).' },
      to: { type: 'string', description: 'Target state (required for transition).' },
      planSteps: { type: 'array', items: { type: 'string' }, description: 'Plan steps (sync/replan).' },
      previousTasks: {
        type: 'array',
        description: 'Previous task list (replan, optional: preserve completed steps).',
        items: { type: 'object', additionalProperties: true },
      },
      tasks: {
        type: 'array',
        description: 'Current task list (transition to executing, required: sync first).',
        items: { type: 'object', additionalProperties: true },
      },
      feedback: { type: 'string', description: 'Feedback driving replanning (transition to replanning, required).' },
      issues: {
        type: 'array',
        description: 'Case-docket entries read by the transition guards; omitted disposition/blocking take the kind default.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Stable id within the case.' },
            summary: { type: 'string', required: true, description: 'One-line defect or pending decision.' },
            kind: { type: 'string', required: true, enum: [...ISSUE_KINDS], description: 'Issue kind, which selects the default disposition and blocking grade.' },
            disposition: { type: 'string', enum: [...ISSUE_DISPOSITIONS], description: 'How the item closes (default from the kind).' },
            blocking: { type: 'string', enum: [...ISSUE_BLOCKING_GRADES], description: 'Impact on dispatch and rounds (default from the kind).' },
            status: { type: 'string', enum: ['open', 'closed'], description: 'Current close state (default open).' },
            round_opened: { type: 'number', description: 'Round that opened the item (default round).' },
            anchor: { type: 'string', description: 'Optional locator: claim, paragraph, or file path.' },
          },
        },
      },
      round: { type: 'number', description: 'Planning round opening the issues (required with issues, 1-based).' },
      rounds: { type: 'number', description: 'Completed planning rounds; with maxRounds it bounds replanning.' },
      maxRounds: { type: 'number', description: 'Allowed planning rounds; with rounds it bounds replanning.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          action: { type: 'string', required: true, enum: ['transition', 'sync', 'replan'] },
          from: { type: 'string' },
          state: { type: 'string' },
          tasks: { type: 'array' },
          preserved: { type: 'array', items: { type: 'string' } },
          toRun: { type: 'array', items: { type: 'string' } },
          issues: { type: 'array', items: { type: 'object', additionalProperties: true } },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderPlanTask(value as unknown as PatentPlanTaskOutput) }],
    },
    // oxlint-disable-next-line typescript/require-await -- tool contract requires async execute
    async execute(args) {
      const input = args as unknown as PatentPlanTaskInput
      switch (input.action) {
        case 'transition': {
          const from = (input.currentState ?? 'planning') as PlanTaskState
          const to = input.to as PlanTaskState
          const validStates = new Set(Object.keys(TRANSITIONS))
          if (!validStates.has(from) || !validStates.has(to)) {
            throw new PatentToolError(
              'invalid_tool_input',
              `非法状态 "${from}" 或 "${to}"（合法: ${[...validStates].join(' / ')}）`,
            )
          }
          const machine = new PlanTaskStateMachine(from)
          if (!machine.canTransition(to)) {
            throw new PatentToolError('invalid_tool_input', `非法状态迁移 ${from} → ${to}（请检查 TRANSITIONS 白名单）`)
          }
          const issues = input.issues === undefined ? undefined : resolveIssues(input.issues, input.round)
          try {
            const next = machine.transition(to, {
              ...(input.tasks !== undefined ? { tasks: input.tasks } : {}),
              ...(input.feedback !== undefined ? { feedback: input.feedback } : {}),
              ...(issues !== undefined ? { issues } : {}),
              ...(input.rounds !== undefined ? { rounds: input.rounds } : {}),
              ...(input.maxRounds !== undefined ? { maxRounds: input.maxRounds } : {}),
            })
            return {
              ok: true,
              action: 'transition' as const,
              from,
              state: next,
              ...(issues !== undefined ? { issues } : {}),
            }
          } catch (err) {
            /* v8 ignore next -- the canTransition pre-check above rules out every non-semantic transition error. */
            if (err instanceof PlanTaskSemanticError) {
              throw new PatentToolError('invalid_tool_input', err.message)
            }
            /* v8 ignore next -- the canTransition pre-check above rules out every other transition error. */
            throw new PatentToolError('tool_execution_failed', err instanceof Error ? err.message : String(err))
          }
        }
        case 'sync': {
          const steps = input.planSteps ?? []
          if (steps.length === 0) throw new PatentToolError('invalid_tool_input', 'sync 需要 planSteps 非空')
          const result = syncPlanToTasks(steps)
          return { ok: true, action: 'sync' as const, tasks: result.tasks as unknown as JsonValue[], preserved: [], toRun: result.toRun }
        }
        case 'replan': {
          const steps = input.planSteps ?? []
          if (steps.length === 0) throw new PatentToolError('invalid_tool_input', 'replan 需要 planSteps 非空')
          const result = replanTasks(input.previousTasks ?? [], steps)
          return { ok: true, action: 'replan' as const, tasks: result.tasks as unknown as JsonValue[], preserved: result.preserved, toRun: result.toRun }
        }
        /* v8 ignore next 5 -- the action schema enum already rejects unknown actions. */
        default:
          throw new PatentToolError(
            'invalid_tool_input',
            `未知操作 "${String(input.action)}"（可选: transition / sync / replan）`,
          )
      }
    },
  })
}
