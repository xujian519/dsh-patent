/**
 * The `patent_teams_*` model-facing tools, the sole Consumer of
 * {@link PatentTeamsService}.
 *
 * The captain (the agent that created the team) orchestrates: members are
 * continuable subagents it spawns and wakes. Members share the same tools and
 * drive their own task state: create team → add members → create tasks with
 * dependencies → claim/assign → work → report → status → delete.
 * @module @deepseek-ai/dsh-patent-teams/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { assertNever, type JsonValue } from '@deepseek-ai/dsh-util-values'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { defaultRoleContracts } from '@deepseek-ai/dsh-patent-workflow'
import { callingAgent, type PatentTeamsArchive, type PatentTeamsService, type PatentTeamsStatus } from './service.ts'
import { requireTeamApproval } from './approval.ts'
import { TEAM_WAIT_DEFAULT_MS, TEAM_WAIT_MAX_MS, TEAM_WAIT_MIN_MS } from './team-activity.ts'

/** Every `patent_teams_*` tool name in registration order. */
export const PATENT_TEAMS_TOOL_NAMES = [
  'patent_teams_create',
  'patent_teams_add_member',
  'patent_teams_remove_member',
  'patent_teams_create_task',
  'patent_teams_reassign_task',
  'patent_teams_claim_task',
  'patent_teams_update_task',
  'patent_teams_send_message',
  'patent_teams_wait',
  'patent_teams_status',
  'patent_teams_archive',
  'patent_teams_delete',
] as const

/** Render the status snapshot as compact text for the model. */
function renderStatus(team: PatentTeamsStatus): string {
  const lines: string[] = [
    `Team "${team.team_name}"${team.description ? ` — ${team.description}` : ''}`,
    `Viewing as: ${team.viewer}`,
    `Members (${team.members.length}):`,
    ...team.members.map((member) => {
      const route = member.provider && member.model ? ` · ${member.provider}/${member.model}` : ''
      const effort = member.reasoning_effort ? ` · reasoning ${member.reasoning_effort}` : ''
      const contract = member.role_contract
        ? ` · role: ${member.role_contract.stance} (交付: ${member.role_contract.deliverables})`
        : ''
      return `  - ${member.name} [${member.role}] ${member.status}/${member.activity}${route}${effort}${contract}`
    }),
    `Tasks (${team.tasks.length}):`,
    ...team.tasks.map((task) => {
      const deps = task.dependencies.length > 0 ? ` (deps: ${task.dependencies.join(',')})` : ''
      const output = task.output !== undefined ? `\n      output: ${task.output.slice(0, 300)}` : ''
      const handoff = task.reassigning ? ' (reassigning)' : ''
      const worker = task.worker ? ` · worker: ${task.worker}` : ''
      const validation = task.contract_validation
        ? ` · contract: ${task.contract_validation.valid ? 'ok' : `degraded(${task.contract_validation.missing_hard_fields.join('、')})`}`
        : ''
      const gated = task.gate_feedback && !task.gate_feedback.satisfied
        ? ` · gated ×${task.gate_rejections ?? 1}: ${task.gate_feedback.score.toFixed(2)} (${task.gate_feedback.failures.join('、')})`
        : ''
      return `  - ${task.id} [${task.status}] attempt ${task.attempt}${handoff} ${task.subject} → ${task.assignee || 'unassigned'}${deps}${worker}${validation}${gated}${output}`
    }),
    `Captain inbox (${team.captain_inbox.length}${team.captain_inbox_leased > 0 ? `, ${team.captain_inbox_leased} in delivery` : ''}${team.captain_inbox_omitted > 0 ? `, ${team.captain_inbox_omitted} older omitted` : ''}):`,
    ...team.captain_inbox.map(message => `  - [${message.from}] ${message.content}`),
  ]
  for (const [name, inbox] of Object.entries(team.member_inboxes)) {
    const leased = inbox.leased > 0 ? `, ${inbox.leased} in delivery` : ''
    const omitted = inbox.omitted > 0 ? `, ${inbox.omitted} omitted` : ''
    if (inbox.messages !== undefined) {
      lines.push(`Member inbox ${name} (${inbox.count}${leased}${omitted}):`)
      for (const message of inbox.messages) {
        lines.push(`  - [${message.from}] ${message.content}`)
      }
    } else {
      const latest = inbox.latest === undefined ? '' : ` latest — ${inbox.latest}`
      lines.push(`Member inbox ${name} (${inbox.count}${leased}${omitted}):${latest}`)
    }
  }
  if (team.mailbox_warning_count > 0) {
    lines.push(
      `Mailbox warnings (${team.mailbox_warning_count}; malformed lines were skipped; showing up to 10):`,
      ...team.mailbox_warnings.map(warning => `  - ${warning}`),
    )
  }
  return lines.join('\n')
}

/** Render the archive payload as compact text for the model. */
function renderArchive(archive: PatentTeamsArchive): string {
  switch (archive.mode) {
    case 'list': {
      if (archive.teams.length === 0) return 'No archived teams in this workspace.'
      return [
        `Archived teams (${archive.teams.length}):`,
        ...archive.teams.map(team =>
          `  - ${team.team_id} "${team.team_name}" (${team.completed_tasks}/${team.tasks} tasks completed, ${team.members} members)`),
      ].join('\n')
    }
    case 'detail': {
      const team = archive.team
      return [
        `Archived team "${team.team_name}" (id ${team.team_id})`,
        `Members (${team.members.length}):`,
        ...team.members.map(member => `  - ${member.name}${member.role === '' ? '' : ` [${member.role}]`}`),
        `Tasks (${team.tasks.length}):`,
        ...team.tasks.map((task) => {
          const deps = task.dependencies.length > 0 ? ` (deps: ${task.dependencies.join(',')})` : ''
          const output = task.output !== undefined ? `\n      output: ${task.output.slice(0, 300)}` : ''
          return `  - ${task.id} [${task.status}] ${task.subject} → ${task.assignee || 'unassigned'}${deps}${output}`
        }),
      ].join('\n')
    }
    /* v8 ignore next -- closed-union backstop; the compiler rejects a new archive mode here. */
    default:
      return assertNever(archive, 'patent teams archive mode')
  }
}

/**
 * The `Config` values this tool layer acts on. The service owns the rest of the
 * configuration; these two decide whether a mutation asks for a user decision first.
 */
export interface PatentTeamsToolOptions {
  /** Ask the approval answerers for a decision on the team plan before creating the team. */
  readonly approveCreation: boolean
  /** Ask for a decision before archiving the team (the captain's close of the case). */
  readonly approveClosure: boolean
}

/**
 * Register every `patent_teams_*` tool into the shared tools registry.
 *
 * The four sections run in one fixed order: the registry emits its schemas in
 * insertion order, and that order is the catalog the model sees.
 * @param ctx - the plugin context (injects `tools`); `ctx.patentTeams` must be mounted.
 * @param options - the approval switches this layer gates on.
 */
export function registerPatentTeamsTools(ctx: Context, options: PatentTeamsToolOptions): void {
  const teams: PatentTeamsService = ctx.patentTeams
  registerTeamAndMemberTools(ctx, teams, options)
  registerTaskOwnershipTools(ctx, teams)
  registerTaskAttemptTools(ctx, teams)
  registerReportAndArchiveTools(ctx, teams, options)
}

/**
 * 团队与成员装配：建队（调用方成为队长）、加成员、移成员。
 * @param ctx - the plugin context (injects `tools`).
 * @param teams - the mounted patent teams service the tools delegate to.
 * @param options - the approval switches this layer gates on.
 */
function registerTeamAndMemberTools(ctx: Context, teams: PatentTeamsService, options: PatentTeamsToolOptions): void {
  ctx.tools.register(defineTool({
    name: 'patent_teams_create',
    description: 'Create a new PatentTeams team: you (the calling agent) become the captain. A captain leads one team at a time; create tasks and members afterwards with patent_teams_add_member and patent_teams_create_task.',
    parameters: {
      name: { type: 'string', required: true, description: 'Name for the new team (used as its stable id).' },
      description: { type: 'string', description: 'Team purpose / the goal the team will work on.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          team_id: { type: 'string', required: true },
          team_name: { type: 'string', required: true },
          state_dir: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Team "${value.team_name}" created (id ${value.team_id}) under ${value.state_dir}. You are the captain.`,
      }],
    },
    async execute(args, exec) {
      if (options.approveCreation) {
        await requireTeamApproval(ctx, {
          agent: callingAgent(exec),
          toolName: 'patent_teams_create',
          callId: exec.callId,
          reason: `创建专利团队「${args.name}」${args.description === undefined ? '' : `（目标：${args.description}）`}：团队方案（成员与任务分工）需用户确认后建队`,
          signal: exec.signal,
        })
      }
      return teams.create(callingAgent(exec), args.name, args.description)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'patent_teams_add_member',
    description: 'Add a durable continuable member. By default it snapshots the captain\'s current LLM route and effort. Supply provider/model only for an explicitly requested role-specific route; a changed provider or model automatically uses the target model\'s default effort. Set reasoning_effort only to request one of the target model\'s supported ids explicitly (or "default" to force its default). The member waits for messages, works on assigned tasks, and can message the team.',
    parameters: {
      name: { type: 'string', required: true, description: 'Unique member name inside the team.' },
      role: { type: 'string', description: `Registered role id for the member (one of: ${defaultRoleContracts().map(contract => contract.role).join(', ')}). An unregistered id is rejected.` },
      provider: { type: 'string', description: 'Optional LLM provider route. Use only when the user explicitly requests a different provider; requires model.' },
      model: { type: 'string', description: 'Optional model override. Omit for the captain\'s current model (or the configured memberModel default).' },
      reasoning_effort: { type: 'string', description: 'Optional reasoning effort override: one of the target model\'s supported effort ids, or "default" to force its default. When omitted, the captain\'s effort is inherited only for the same provider/model; a changed route uses the target default.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          member_name: { type: 'string', required: true },
          member_id: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
          reasoning_effort: { type: 'string' },
          status: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Member "${value.member_name}" added (subagent id ${value.member_id}, ${value.provider}/${value.model}${value.reasoning_effort === undefined ? '' : `, reasoning ${value.reasoning_effort}`}, status ${value.status}).`,
      }],
    },
    async execute(args, exec) {
      return teams.addMember(callingAgent(exec), args, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'patent_teams_remove_member',
    description: 'Remove a member safely: revoke its current attempts, return all unfinished owned tasks to the shared pending pool, interrupt its live turn, and mark it removed.',
    parameters: {
      name: { type: 'string', required: true, description: 'Name of the member to remove.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          member_name: { type: 'string', required: true },
          status: { type: 'string', required: true },
          requeued_tasks: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Member "${value.member_name}" removed (status ${value.status}); requeued tasks: ${value.requeued_tasks.join(', ') || 'none'}.`,
      }],
    },
    async execute(args, exec) {
      return teams.removeMember(callingAgent(exec), args.name, exec.signal)
    },
  }))
}

/**
 * 任务归属装配：建任务（可指定预期成员与 worker 契约）、改派/重试/队长接管。
 * @param ctx - the plugin context (injects `tools`).
 * @param teams - the mounted patent teams service the tools delegate to.
 */
function registerTaskOwnershipTools(ctx: Context, teams: PatentTeamsService): void {
  ctx.tools.register(defineTool({
    name: 'patent_teams_create_task',
    description: 'Create a task in your team\'s task list. Tasks can depend on other tasks (dependencies): a task is only claimable once every dependency is completed. Optionally assign it to a member, who still claims it before working.',
    parameters: {
      subject: { type: 'string', required: true, description: 'Brief title for the task.' },
      description: { type: 'string', description: 'What needs to be done, in detail.' },
      dependencies: {
        type: 'array',
        items: { type: 'string' },
        description: 'Task ids this task depends on (must be completed before this task can be claimed).',
      },
      assignee: { type: 'string', description: 'Optional member name this task is intended for. Member names only: the captain is not a member, so never pass "captain" here — use reassign_task(assignee="captain") to move a task to the captain.' },
      worker: { type: 'string', description: 'Optional worker contract the task output is validated against on completion (e.g. patent-search-commander, patent-oa-writer).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          subject: { type: 'string', required: true },
          status: { type: 'string', required: true },
          assignee: { type: 'string' },
          worker: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Task "${value.subject}" created as ${value.task_id} (status ${value.status}${value.assignee ? `, assigned to ${value.assignee}` : ''}${value.worker ? `, worker ${value.worker}` : ''}).`,
      }],
    },
    async execute(args, exec) {
      return teams.createTask(callingAgent(exec), args, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'patent_teams_reassign_task',
    description: 'Atomically retry, reassign, or let the captain take over any unfinished/failed task. The old attempt is revoked before its member is interrupted, so late updates cannot overwrite the new owner. Use assignee="captain" for captain takeover.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'Task to retry/reassign.' },
      assignee: { type: 'string', required: true, description: 'Active member name, or "captain" for captain takeover.' },
      reason: { type: 'string', description: 'Why the task is being retried or reassigned.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          previous_assignee: { type: 'string', required: true },
          assignee: { type: 'string', required: true },
          status: { type: 'string', required: true },
          attempt: { type: 'number', required: true },
          attempt_id: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Task ${value.task_id} reassigned ${value.previous_assignee || 'unassigned'} → ${value.assignee} (attempt ${value.attempt}, status ${value.status}${value.attempt_id ? `, attempt_id ${value.attempt_id}` : ''}).`,
      }],
    },
    async execute(args, exec) {
      return teams.reassignTask(callingAgent(exec), args, exec.signal)
    },
  }))
}

/**
 * 任务执行装配：认领（发放 attempt_id 能力）与应用该能力的更新。
 * @param ctx - the plugin context (injects `tools`).
 * @param teams - the mounted patent teams service the tools delegate to.
 */
function registerTaskAttemptTools(ctx: Context, teams: PatentTeamsService): void {
  ctx.tools.register(defineTool({
    name: 'patent_teams_claim_task',
    description: 'Claim one ready task for a member (or yourself). A member cannot own a second unfinished task. The returned attempt_id is required for that member\'s updates and becomes stale after retry/reassignment.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The task id to claim.' },
      assignee: { type: 'string', description: 'Member to claim for (captain only; defaults to the task\'s assignee). Member names only — "captain" is not a member; omit it to claim as the captain.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          assignee: { type: 'string', required: true },
          attempt: { type: 'number', required: true },
          attempt_id: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Task ${value.task_id} claimed by ${value.assignee} (attempt ${value.attempt}${value.attempt_id ? `, attempt_id ${value.attempt_id}` : ''}, status ${value.status}).`,
      }],
    },
    async execute(args, exec) {
      return teams.claimTask(callingAgent(exec), args)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'patent_teams_update_task',
    description: 'Update a task status/output. Members must supply the current attempt_id returned by claim_task; stale attempts are rejected after takeover/reassignment. Terminal results are immutable. A captain must use reassign_task(assignee="captain") before updating member-owned work.',
    parameters: {
      task_id: { type: 'string', required: true, description: 'The task id to update.' },
      status: {
        type: 'string',
        enum: ['in_progress', 'completed', 'failed', 'cancelled'],
        description: 'New status. Legal moves: pending→claimed, claimed→in_progress, in_progress→completed. A claimed task must enter in_progress before it can be completed; terminal statuses (completed/failed/cancelled) have no way out.',
      },
      output: { type: 'string', description: 'Result summary; set when completing or failing.' },
      attempt_id: { type: 'string', description: 'Current execution capability returned by claim_task (required for members when present on the task).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task_id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          output: { type: 'string' },
          attempt: { type: 'number', required: true },
          attempt_id: { type: 'string' },
          gated: { type: 'boolean' },
          gate_feedback: { type: 'string' },
          gate_rejections: { type: 'number' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.gated === true
          ? `Task ${value.task_id} 未过质量门禁（第 ${value.gate_rejections ?? 1} 次被打回；保持 ${value.status}）:\n${value.gate_feedback ?? ''}`
          : `Task ${value.task_id} attempt ${value.attempt} → ${value.status}${value.gate_rejections !== undefined ? `（累计被打回 ${value.gate_rejections} 次）` : ''}${value.output !== undefined ? `\nOutput: ${value.output}` : ''}`,
      }],
    },
    async execute(args, exec) {
      return teams.updateTask(callingAgent(exec), args, exec.signal)
    },
  }))
}

/**
 * 汇报与收尾装配：消息投递、团队状态快照、归档查询、结束团队。
 * @param ctx - the plugin context (injects `tools`).
 * @param teams - the mounted patent teams service the tools delegate to.
 */
function registerReportAndArchiveTools(ctx: Context, teams: PatentTeamsService, options: PatentTeamsToolOptions): void {
  ctx.tools.register(defineTool({
    name: 'patent_teams_send_message',
    description: 'Send a message to the captain or to a teammate. Messages go straight into the recipient\'s mailbox; when the captain agent is online the plugin also schedules live delivery (member recipients get the message as their next turn; a running captain sees it at the nearest model step). No relay is involved: teammates talk to each other directly.',
    parameters: {
      to: { type: 'string', required: true, description: 'Recipient: "captain" or a member name.' },
      content: { type: 'string', required: true, description: 'The message text.' },
      from: { type: 'string', description: 'Sender (defaults to the caller: the captain, or the calling member).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message_id: { type: 'string', required: true },
          from: { type: 'string', required: true },
          to: { type: 'string', required: true },
          delivered: { type: 'string', required: true, description: 'live (accepted by the live captain), wake (member recipient woken), or mailbox (durable inbox only).' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Message ${value.message_id} ${value.from} → ${value.to} delivered via ${value.delivered}.`,
      }],
    },
    async execute(args, exec) {
      return teams.sendMessage(callingAgent(exec), args, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'patent_teams_wait',
    description: 'Wait until the team\'s next change — a task transition, a teammate report, a roster change, or a member starting or stopping work — and return as soon as it happens. Captain only. After every dispatch, call this once instead of polling: it blocks until work moves, so a timeout means nothing moved in that window (dispatch, take over, or ask the user — do not wait again for the same thing). It never wakes a member. Team state is durable and authoritative: re-read patent_teams_status when the wait returns.',
    parameters: {
      timeout_ms: {
        type: 'integer',
        description: `Wait duration in milliseconds, from ${TEAM_WAIT_MIN_MS} through ${TEAM_WAIT_MAX_MS}. Defaults to ${TEAM_WAIT_DEFAULT_MS}.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          timed_out: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.timed_out
          ? 'No team change within the wait window. Re-read patent_teams_status: nothing advanced on its own, so decide the next dispatch or hand the decision to the user.'
          : 'Team change observed. Re-read patent_teams_status for the authoritative state.',
      }],
    },
    async execute(args, exec) {
      return teams.wait(callingAgent(exec), args.timeout_ms ?? TEAM_WAIT_DEFAULT_MS, exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'patent_teams_status',
    description: 'Team snapshot: members with live activity and tasks with status/assignee/dependencies/output. Captains also see every team mailbox; members see only their own inbox. Read it before dispatching and again after patent_teams_wait returns; it is a point-in-time snapshot, so never poll it in a loop.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{
        type: 'text',
        text: renderStatus(value as unknown as PatentTeamsStatus),
      }],
    },
    async execute(_args, exec) {
      // The schema stays open (additionalProperties) while the service type
      // keeps every field named; the cast bridges the open-output contract.
      return (await teams.status(callingAgent(exec), exec.signal)) as unknown as Record<string, JsonValue>
    },
  }))

  ctx.tools.register(defineTool({
    name: 'patent_teams_archive',
    description: 'List this workspace\'s archived teams (kept by patent_teams_delete), or show one archived team\'s members and tasks in detail. Read-only.',
    parameters: {
      team_id: { type: 'string', description: 'Optional archived team id to show in detail; omit to list archived teams.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {},
      },
      render: (_args, value) => [{
        type: 'text',
        text: renderArchive(value as unknown as PatentTeamsArchive),
      }],
    },
    async execute(args, exec) {
      // Same open-schema bridge as patent_teams_status: the service type keeps
      // every field named while the catalog schema stays open.
      return (await teams.archive(callingAgent(exec), args.team_id)) as unknown as Record<string, JsonValue>
    },
  }))

  ctx.tools.register(defineTool({
    name: 'patent_teams_delete',
    description: 'End your team: interrupts all members (best effort) and archives the team\'s state directory (team file, tasks, mailboxes). Use when the team\'s work is done or abandoned.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          deleted: { type: 'boolean', required: true },
          team_name: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Team "${value.team_name}" deleted.`,
      }],
    },
    async execute(_args, exec) {
      if (options.approveClosure) {
        await requireTeamApproval(ctx, {
          agent: callingAgent(exec),
          toolName: 'patent_teams_delete',
          callId: exec.callId,
          reason: '收口并归档当前专利团队：案件交付需用户放行，队长不得单方收口',
          signal: exec.signal,
        })
      }
      return teams.delete(callingAgent(exec), exec.signal)
    },
  }))
}
