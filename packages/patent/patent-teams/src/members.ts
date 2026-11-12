/**
 * Member subagent lifecycle: spawn a continuable child per member, deliver
 * messages into its FIFO inbox, and observe its activity.
 *
 * Members are durable continuable subagents of the captain, so a member keeps
 * its conversation across turns and across harness restarts: the captain
 * wakes it with {@link ctx.subagents.sendMessage}, it works through its turn
 * (updating team state through the `patent_teams_*` tools), and becomes idle
 * again. Its final assistant message is not readable programmatically, so the
 * member persists its report into the captain's mailbox and the task records,
 * which the captain reads through `patent_teams_status`.
 * @module dsh-patent-teams/members
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
// Declaration merge only: makes ctx.subagents visible.
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { workerDeliverables, workerToolList, type RoleContract } from '@deepseek-ai/dsh-patent-workflow'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { join } from 'node:path'
import { readRetiredMemberIds } from './state.ts'
import type { TeamMember, TeamState } from './types.ts'

/**
 * Tools a member never receives: the captain-only PatentTeams mutators, plus
 * the generic `send_message`.
 *
 * Denying `send_message` also suppresses the subagent runtime's
 * "send your result with `send_message(...)`" guidance, which it appends to a
 * continuable child's initial prompt only while that child's registry carries
 * the tool. Unsuppressed, that instruction competes with the member's
 * reporting channel: `patent_teams_send_message` is the only path that writes
 * the team mailbox, the `patent-teams/message-sent` event, and the dashboard.
 * Members keep `subagent_fork`, so this deny removes only the ability to steer
 * a member's own children, never the ability to have them; across nine recorded
 * member sessions members delegated zero times. Reintroduce `send_message` when
 * that steering is needed — the runtime's background-delegation guidance names
 * `subagent_fork` in every member prompt, so the pressure is live even unused.
 *
 * A composition may not carry every name: {@link spawnMember} drops the names
 * absent from the captain's restrictable set before starting the member, so a
 * missing tool never fails member creation and the deny stays in force wherever
 * the tool exists. An unknown allowed name stays fatal at `restrict()`.
 */
export const MEMBER_DENIED_TOOLS = [
  'patent_teams_create',
  'patent_teams_add_member',
  'patent_teams_remove_member',
  'patent_teams_reassign_task',
  'patent_teams_create_task',
  'patent_teams_delete',
  'send_message',
] as const

/**
 * Tools every member needs to take work and report it. They stay in every
 * allow list because a member without them cannot follow its persona; a
 * composition that genuinely lacks one fails member creation at `restrict()`.
 */
const MEMBER_COORDINATION_TOOLS = [
  'patent_teams_claim_task',
  'patent_teams_update_task',
  'patent_teams_send_message',
  'patent_teams_status',
] as const

/** Self-check validators the member persona names only when they were granted. */
const VALIDATOR_TOOLS = ['patent_worker_validate', 'validate_specification', 'rule_check'] as const

/**
 * Tools every member keeps regardless of role: file access, the shell, skill
 * loading, image reads, background jobs, delegation, the member-side team
 * channel, and the self-check validators the persona requires.
 *
 * The list is grounded in recorded member sessions rather than in the role
 * contracts: `bash` was the most-used tool for every role, and each role used
 * at least one tool its contract does not name.
 */
export const BASELINE_MEMBER_TOOLS = [
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'bash',
  'read_image',
  'skill',
  'todo_write',
  'job_list',
  'job_output',
  'job_kill',
  'subagent_fork',
  ...MEMBER_COORDINATION_TOOLS,
  'patent_worker_validate',
  'rule_check',
  'validate_specification',
  // The persona instructs every member to price deadlines and annuities with
  // these, and no role contract declares them.
  'patent_deadlines',
  'patent_fees',
] as const

/**
 * Resolve the tool allow-list for one member, or `undefined` to keep the
 * deny-only surface.
 *
 * Pass the captain's session context. The list is applied to the member child
 * through `tools.restrict()`, and both the captain and the member are children
 * of the same preset generation, so the preset's own registrations are
 * restrictable from the captain. The plugin registration context excludes that
 * layer, which would strip every preset-owned tool from the child.
 *
 * Trimming fails open. A member without a role, an unregistered role, or a
 * composition without the cnlaw MCP tools the persona requires all fall back
 * to deny-only. Names absent from the inherited surface are dropped rather than
 * passed to `tools.restrict()`, which rejects unknown names at member creation;
 * the coordination tools are the exception, because a member without them
 * cannot follow its persona.
 * @param ctx - the captain's session context carrying the tools service.
 * @param role - the member's registered role id, when it has one.
 * @returns the granted tool names, or `undefined` for the deny-only fallback.
 */
export function memberToolAllowList(ctx: Context, role: string | undefined): string[] | undefined {
  if (role === undefined) return undefined
  const declared = workerToolList(role)
  if (declared.length === 0) return undefined
  // Optional read: a composition without the tools service keeps the deny-only surface.
  const tools = ctx.get('tools')
  if (tools === undefined) return undefined
  const restrictable = tools.restrictableNames()
  // The persona requires verifying statutes through cnlaw before citing them;
  // without that MCP surface a trimmed member would be told to use a tool it lacks.
  const lawTools = [...restrictable].filter(name => name.startsWith('mcp__cnlaw__'))
  if (lawTools.length === 0) return undefined
  const baseline = BASELINE_MEMBER_TOOLS.filter(name => restrictable.has(name))
  const roleTools = declared.filter(name => restrictable.has(name))
  const granted = new Set<string>([...baseline, ...lawTools, ...roleTools, ...MEMBER_COORDINATION_TOOLS])
  for (const name of MEMBER_DENIED_TOOLS) granted.delete(name)
  return [...granted]
}

/**
 * Restore the SessionId brand on a value that round-tripped through the
 * durable team file. The brand is erased by JSON serialization; the value
 * originated from `startContinuable`/`agent.id`, so this cast is the boundary
 * restoration, not a new assertion.
 */
function brandedSessionId(value: string): SessionId {
  return value as SessionId
}

/** Runtime knobs for member spawning, resolved from plugin config. */
export interface MemberRuntimeConfig {
  /** Registered `ctx.subagents` provider name (must support continuable + persona). */
  provider: string
  /** Child delegation depth cap (0 forbids delegation entirely). */
  maxDepth?: number
}

/** Durable provider/model/reasoning snapshot for one member. */
interface MemberLlmSelection {
  /** Registered LLM provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort, absent when the target has no explicit/default effort. */
  reasoningEffort?: string
}

/** Optional member-level route requested by the captain. */
interface MemberLlmSelectionRequest {
  /** Explicit LLM provider route; requires an explicit model. */
  provider?: string
  /** Explicit model id; otherwise the plugin default or captain model is used. */
  model?: string
  /** Plugin-level member model default. */
  defaultModel?: string
  /** Explicit reasoning effort; "default" selects the target model's default effort. */
  reasoningEffort?: string
}

const MEMBER_LABEL_PREFIX = 'patent-teams:'

/**
 * Resolve one member's complete model selection. Ordinary members snapshot the
 * captain's current request route and reasoning effort. When provider or model
 * changes, effort is intentionally omitted so the target model materializes
 * its own default instead of receiving an adapter-owned id from another route.
 * An explicit effort overrides either policy; the sentinel "default" also
 * selects the target model's default. The final effort is validated against
 * the target model before a child is created.
 * @param ctx - registrant context with the llm route and model registry.
 * @param captain - the parent agent whose route and effort the member snapshots.
 * @param request - the member's requested provider/model/effort selection.
 * @param signal - optional abort signal for the selection resolution.
 * @returns the member's complete llm selection.
 */
export async function resolveMemberLlmSelection(
  ctx: Context,
  captain: Agent,
  request: MemberLlmSelectionRequest,
  signal?: AbortSignal,
): Promise<MemberLlmSelection> {
  const explicitProvider = request.provider?.trim()
  const explicitModel = request.model?.trim()
  const defaultModel = request.defaultModel?.trim()
  const explicitEffort = request.reasoningEffort?.trim()
  if (request.provider !== undefined && explicitProvider === '') {
    throw new Error('member LLM provider must not be empty')
  }
  if (request.model !== undefined && explicitModel === '') {
    throw new Error('member model must not be empty')
  }
  if (request.defaultModel !== undefined && defaultModel === '') {
    throw new Error('configured memberModel must not be empty')
  }
  if (request.reasoningEffort !== undefined && explicitEffort === '') {
    throw new Error('member reasoning effort must not be empty')
  }
  if (explicitProvider !== undefined && explicitModel === undefined) {
    throw new Error('an explicit member LLM provider requires an explicit member model')
  }

  const current = captain.session.requestHeader()?.config
  const currentProvider = current?.provider ?? captain.options.provider
  const currentModel = current?.model ?? captain.options.model
  const provider = explicitProvider ?? currentProvider
  const model = explicitModel ?? defaultModel ?? currentModel
  if (provider === undefined || model === undefined) {
    throw new Error('cannot resolve the member LLM route from the current captain session')
  }

  // Effort ids belong to one exact provider/model capability. Preserve the
  // captain's effort only on the same route; a changed route must resolve its
  // own default. Explicit effort still wins, while "default" forces that
  // target-default behavior even when the route did not change.
  const sameRoute = provider === currentProvider && model === currentModel
  const reasoningEffort = explicitEffort === undefined
    ? sameRoute
      ? current?.reasoningEffort
      : undefined
    : explicitEffort === 'default'
      ? undefined
      : ReasoningEffortId(explicitEffort)
  const llm = ctx.get('llm')
  if (llm === undefined) {
    throw new Error('patent-teams: llm service is not available; cannot resolve the member LLM route')
  }
  const resolved = await llm.resolveCallConfig({
    provider,
    model,
    ...reasoningEffort === undefined
      ? {}
      : { reasoningEffort },
  }, signal)
  return {
    provider: resolved.provider,
    model: resolved.model,
    ...resolved.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: String(resolved.reasoningEffort) },
  }
}

/**
 * The member's system prompt (persona), shadowing the deployment persona for
 * that child. Self-contained: it replaces the whole persona section. When a
 * team role contract is given it is folded in as a dedicated role section
 * (the role's stance, required deliverables, tool list, forbidden actions, and
 * HITL flag), so a member knows its scope beyond the generic working rules.
 * The domain-discipline block is carried here because the shadowing discards
 * the deployment persona that holds it, so a member would otherwise see none
 * of the search-before-conclusion, source_path, or disclaimer rules.
 * @param team - the team the member joined.
 * @param member - the member record (name/role are read before spawning).
 * @param stateDir - configured state directory, so the member can locate the
 *   team files with its own file tools.
 * @param roleContract - the team role's contract, when the member carries a role.
 * @param grantedTools - the tools this member was actually granted, when the
 *   team runtime trimmed its surface; the role section then names them instead
 *   of the contract's declaration.
 * @returns the member's system prompt (persona).
 */
export function memberPersona(
  team: TeamState,
  member: TeamMember,
  stateDir: string,
  roleContract?: RoleContract,
  grantedTools?: readonly string[],
): string {
  const roleLine = member.role ? ` with the role: ${member.role}` : ''
  // The role section names only what the role adds; the shared baseline and the
  // MCP law tools are listed once below, so the contract block stays readable.
  const roleTools = grantedTools?.filter(name =>
    !BASELINE_MEMBER_TOOLS.includes(name as (typeof BASELINE_MEMBER_TOOLS)[number]) && !name.startsWith('mcp__'))
  const contractBlock = roleContract === undefined ? '' : roleSection(roleContract, roleTools)
  const grantedBlock = grantedTools === undefined ? '' : `\nGranted tools: ${grantedTools.join('、')}\n`
  return `You are ${member.name}, a member of the multi-agent team "${team.name}" running inside DeepSeek Harness PatentTeams. The captain leads the team; you are a worker member${roleLine}.

Team context:
- Team id: ${team.id}
- Your name inside the team (use it as \`from\`/identity): ${member.name}
- The team state lives under ${stateDir}/${team.id}/ (team.json and inbox/*.jsonl). You may inspect these files read-only for diagnostics, but never edit them directly; use the patent_teams_* tools so JSON escaping and concurrent updates stay safe.
- The captain and your teammates reach you through messages. Each message you receive is a new turn: act on it and end your turn with a concise reply.
${contractBlock}${grantedBlock}
Domain discipline (non-negotiable; a short task brief does not suspend it):
- 检索先于结论：新颖性/创造性判断必须先有检索证据与对比文件，禁止凭记忆断言某方案是或不是现有技术。
- 无来源即撤回：法条、判例、对比文件、日期、数字一律给出 source_path（文件路径 / URL / 对比文件号+段落）；拿不出来源就删除该断言。
- 法条先核验再引用：走 cnlaw 的 MCP 工具（mcp__cnlaw__*），或系统提示的 cnlaw 声明段给出的语义检索端点（REST，curl -sG "<cnlaw 语义检索端点>/search" --data-urlencode "q=…"）；按权威度排序（法条 > 审查指南 > 判例 > 书籍）；条号不确定时先查证。
- 逐特征比对：权利要求分析按「特征 → 对比文件对应内容 → 结论」逐项给出，不用"整体上相似"这类不可追溯表述。
- 数字与期限用工具：期限、年费走 patent_deadlines；页数、字数、项数以工具或脚本计数为准，不心算。
- 对外交付件带免责声明："本分析由 AI 辅助生成，不构成正式法律意见。专利申请和专利性判断应由具备资质的专利代理人或专利律师确认。"

Working rules:
1. When you receive a task assignment, call patent_teams_claim_task with the task id. Keep the returned attempt_id: include it in every patent_teams_update_task call for that execution attempt. Then mark the task in_progress.
2. Work thoroughly with your available tools; do not cut corners.
3. When finished, call patent_teams_update_task with the same attempt_id, status=completed, and a concise \`output\` summarizing what you did and the key results. A \`STALE_ATTEMPT\` rejection means the captain reassigned or took over the task; stop touching that task and wait for new work.
4. Report to the captain only with patent_teams_send_message (to=captain): it is the channel that persists into the team mailbox and shows up in the team log and dashboard. Report when you complete a task or hit a blocker. Do not send team messages with any other tool.
5. To ask a teammate something, use patent_teams_send_message with to=<teammate name>; the message lands in their mailbox and wakes them directly — teammates talk to each other without the captain in the loop. The same applies to the captain (to=captain).
6. After your turn becomes idle, the shared task scheduler may assign your next ready task automatically. Never claim a second task while you still own unfinished work.
7. You are a worker: do not create or delete teams, reassign tasks, or add/remove members — that is the captain's job.
8. Blocked means report, not retry: when a tool errors, material is missing, access is denied, or the same call fails twice, stop and report the blocker to the captain (what you tried, what you need). Do not repeat a failing call, and do not route around a patent-domain tool with shell or ad-hoc python scripts: bypass artifacts are not indexed, not re-runnable by others, and count as work not done.
${selfCheckRule(grantedTools)}`
}

/**
 * The self-check rule for the persona. A trimmed member is told to run only the
 * validators it actually received; a member whose surface was not trimmed keeps
 * the rule verbatim, and one that received no validator drops the rule instead
 * of being ordered to call a tool it lacks.
 * @param grantedTools - the granted surface, or `undefined` when it was not trimmed.
 * @returns the rendered rule, or an empty string when no validator is granted.
 */
function selfCheckRule(grantedTools?: readonly string[]): string {
  if (grantedTools === undefined) {
    return '9. Self-check before you submit: run the validators your role contract names (patent_worker_validate / validate_specification / rule_check and any task-specific check), fix what they report, and put the self-check conclusion into `output`. An unself-checked deliverable is not finished.'
  }
  const validators = VALIDATOR_TOOLS.filter(name => grantedTools.includes(name))
  if (validators.length === 0) return ''
  return `9. Self-check before you submit: run the validators your role contract names (${validators.join(' / ')} and any task-specific check), fix what they report, and put the self-check conclusion into \`output\`. An unself-checked deliverable is not finished.`
}

/**
 * Render one team role's contract as a guide section for the persona.
 * @param contract - the role's contract.
 * @param grantedTools - the granted surface, when it was trimmed; otherwise the
 *   contract's declared tools are shown.
 * @returns the rendered section.
 */
function roleSection(contract: RoleContract, grantedTools?: readonly string[]): string {
  const deliverables = workerDeliverables(contract.role)
  const tools = grantedTools === undefined ? workerToolList(contract.role).join('、') : grantedTools.join('、')
  const toolsLine = tools === '' ? '' : `\n- Tools: ${tools}`
  const forbidden = contract.forbiddenActions.join('、')
  const hitl = contract.triggersHITL
    ? 'deliverables need human confirmation before the final output'
    : 'deliverables can be completed directly'
  return `Role contract:
- Role: ${contract.name} (${contract.role})
- Stance: [${contract.stance}] ${contract.description}
- Required deliverables: ${deliverables}${toolsLine}
- Forbidden: ${forbidden}
- HITL: ${hitl}`
}

/**
 * The initial user message delivered when the member is created.
 * @param team - the team the member joined.
 * @returns the initial welcome message.
 */
export function memberWelcome(team: TeamState): string {
  return `You have joined the team "${team.name}" as a member. The captain will send you tasks and messages; wait for instructions. Current team status: ${team.tasks.length} task(s), none assigned to you yet.`
}

/**
 * Spawn one member as a durable continuable subagent of the captain and fill
 * `member.id` with its child session id. On failure nothing is persisted.
 * @param ctx - the plugin context (injects `subagents`).
 * @param config - member runtime knobs.
 * @param llmSelection - resolved provider/model/reasoning snapshot.
 * @param captain - the exact live captain agent (the calling agent).
 * @param team - the team record (read-only here).
 * @param member - the member draft whose `id` is filled on success.
 * @param stateDir - configured state directory (for the persona).
 * @param signal - caller cancellation, forwarded to the start.
 * @param roleContract - the team role's contract, folded into the persona when present.
 */
export async function spawnMember(
  ctx: Context,
  config: MemberRuntimeConfig,
  llmSelection: MemberLlmSelection,
  captain: Agent,
  team: TeamState,
  member: TeamMember,
  stateDir: string,
  signal: AbortSignal,
  roleContract?: RoleContract,
): Promise<void> {
  // Fail loud at the first use: provider registration is a sibling plugin's
  // effect and may settle after this plugin mounts. Capability checks here
  // mirror what startContinuable would reject, with an actionable error.
  const provider = ctx.subagents.getProvider(config.provider)
  if (provider === undefined) {
    throw new Error(
      `patent-teams: no subagent provider "${config.provider}" is registered — `
      + 'check that the subagent provider row (e.g. subagent-spawn) is mounted in the composition',
    )
  }
  if (provider.prepareContinuable === undefined) {
    throw new Error(`patent-teams: provider "${config.provider}" does not support continuable members`)
  }
  if (!provider.capabilities.persona) {
    throw new Error(`patent-teams: provider "${config.provider}" cannot apply a member persona`)
  }
  if (!provider.capabilities.toolFilter) {
    throw new Error(`patent-teams: provider "${config.provider}" cannot restrict captain-only tools for members`)
  }
  const label = `${MEMBER_LABEL_PREFIX}${team.id}:${member.name}`
  // A role-scoped member gets only its role tools plus the shared baseline; an
  // unqualified or unregistered role keeps the deny-only surface it had before.
  // Resolve against the captain, not this plugin context: the child inherits the
  // captain's preset layer, which the registration context cannot see.
  const grantedTools = memberToolAllowList(captain.ctx, member.role)
  // The child inherits the captain's preset layer, so a deny name the captain
  // cannot restrict is absent for the child too. Dropping it keeps a missing
  // `send_message` from failing member creation while the deny stays in force
  // wherever the tool exists.
  const restrictable = captain.ctx.get('tools')?.restrictableNames()
  const deny = restrictable === undefined
    ? [...MEMBER_DENIED_TOOLS]
    : MEMBER_DENIED_TOOLS.filter(name => restrictable.has(name))
  const toolFilter: { allow?: string[]; deny: string[] } = grantedTools === undefined
    ? { deny }
    : { allow: grantedTools, deny }
  // The route rides the creation request: the manager seeds it into the
  // child's durable descriptor, so fresh composition and cold resume both
  // restore provider/model without a per-child setup hook.
  const start = await ctx.subagents.startActivation({
    provider: config.provider,
    label,
    delivery: 'parent',
    prompt: [{ type: 'text', text: memberWelcome(team) }],
    parent: captain,
    persona: memberPersona(team, member, stateDir, roleContract, grantedTools),
    toolFilter,
    agentOptions: {
      provider: llmSelection.provider,
      model: llmSelection.model,
      // The child runs on the resolved route, so its effort must ride the
      // same request; resolving it here but omitting it would silently run
      // at the parent's effort while status/output report the explicit one.
      ...llmSelection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(llmSelection.reasoningEffort) },
    },
    ...config.maxDepth !== undefined ? { maxDepth: config.maxDepth } : {},
    signal,
  })
  member.id = start.childId
}

/**
 * Deliver one message to a member as its next FIFO turn. Best effort: a
 * failure (member gone or not continuable) is logged and reported as `false`
 * so the caller can decide (mailbox delivery still happened).
 *
 * Any team sender can route through this helper: the captain is the direct
 * parent of every member, and the caller passes the captain's live Agent
 * (its own when the captain calls, the registry-resolved one when a member
 * sends) — mirroring the Claude Code mailbox model where the writer writes
 * the target's inbox and the target picks it up on its own.
 * @param ctx - the plugin context (injects `subagents`).
 * @param captain - the exact live captain agent (the member's direct parent).
 * @param childId - the member's durable child session id.
 * @param text - the message content.
 * @param signal - caller cancellation, forwarded to the delivery.
 * @returns whether the member inbox accepted the message.
 */
export async function deliverToMember(
  ctx: Context,
  captain: Agent,
  childId: string,
  text: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    await ctx.subagents.sendMessage(captain, brandedSessionId(childId), [{ type: 'text', text }], {
      signal,
    })
    return true
  } catch (error: unknown) {
    ctx.logger.warn(`patent-teams: send to member ${childId} failed: ${String(error)}`)
    return false
  }
}

/**
 * Request cancellation of one live member's current turn. Best effort, fire
 * and return; the target may keep running until it observes the signal.
 * @param ctx - the plugin context (injects `subagents`).
 * @param captain - the exact live captain agent (the member's parent).
 * @param childId - the member's durable child session id.
 */
export function interruptMember(ctx: Context, captain: Agent, childId: string): void {
  try {
    ctx.subagents.interrupt(brandedSessionId(childId), { kind: 'ancestor', agent: captain })
  } catch (error: unknown) {
    ctx.logger.warn(`patent-teams: interrupt of member ${childId} failed: ${String(error)}`)
  }
}

/**
 * Wait until one member's live turn finishes, or the caller abandons the wait.
 *
 * Reassignment and removal interrupt the member first and then wait for
 * quiescence, so an update from the old attempt cannot land after the handoff
 * and be attributed to the new one.
 * @param ctx - the plugin context (injects `agents`).
 * @param member - the member whose turn must finish; a member that is not live is already idle.
 * @param signal - caller cancellation that abandons the wait.
 */
export async function waitForMemberIdle(ctx: Context, member: TeamMember, signal: AbortSignal): Promise<void> {
  // v8 ignore next -- durable state validation rejects members with empty ids before they can be waited on
  if (member.id === '') return
  const live = ctx.get('agents')?.get(brandedSessionId(member.id))
  if (live === undefined) return
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('task reassignment was cancelled')
  }
  let onAbort!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('task reassignment was cancelled'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    await Promise.race([live.whenIdle(), aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** Resolve one live parent's workspace-scoped retirement index. */
async function retiredForParent(ctx: Context, parentId: SessionId, stateDir: string): Promise<Set<string>> {
  const parent = ctx.get('agents')?.get(parentId)
  return parent === undefined
    ? new Set()
    : readRetiredMemberIds(join(parent.session.header.cwd ?? process.cwd(), stateDir))
}

/**
 * Install the missing per-child retirement boundary above Harness rc.6.
 *
 * Upstream `interrupt()` deliberately preserves continuable sessions and the
 * upstream seam exposes no targeted forget/retire method. The durable
 * PatentTeams index therefore guards both public continuation boundaries:
 * retired rows disappear from `list_agents`, which enumerates the tree through
 * `listDescendants`, and a direct `sendMessage()` is rejected before it can
 * cold-resume the member. Exact ids keep unrelated subagents untouched;
 * transcripts remain in persistence for archived-team review.
 * @param ctx - registrant context carrying the subagent registry.
 * @param stateDir - configured state directory, where retired ids persist.
 */
export function installRetiredMemberGuard(ctx: Context, stateDir: string): void {
  const runtime = ctx.subagents
  ctx.effect(() => {
    // The saved originals are restored on dispose; the .call receivers are explicit.
    // oxlint-disable-next-line typescript/unbound-method
    const listDescendants = runtime.listDescendants
    // oxlint-disable-next-line typescript/unbound-method
    const sendMessage = runtime.sendMessage

    const guardedDescendants: typeof runtime.listDescendants = async (rootId, signal) => {
      const [entries, retired] = await Promise.all([
        listDescendants.call(runtime, rootId, signal),
        retiredForParent(ctx, rootId, stateDir),
      ])
      return entries.filter(entry => !retired.has(entry.id))
    }
    const guardedSend: typeof runtime.sendMessage = async (sender, targetId, content, options) => {
      const retired = await readRetiredMemberIds(join(sender.session.header.cwd ?? process.cwd(), stateDir))
      if (retired.has(targetId)) {
        throw new SubagentError(
          `PatentTeams member "${targetId}" was retired and cannot be resumed`,
          'NOT_RESUMABLE',
        )
      }
      return sendMessage.call(runtime, sender, targetId, content, options)
    }

    runtime.listDescendants = guardedDescendants
    runtime.sendMessage = guardedSend
    return () => {
      if (runtime.listDescendants === guardedDescendants) runtime.listDescendants = listDescendants
      if (runtime.sendMessage === guardedSend) runtime.sendMessage = sendMessage
    }
  }, 'patent-teams: retired member guard')
}

/**
 * Snapshot each direct continuable child's real driver activity under the
 * captain's session. The catalog reports session residency only, so live
 * children are refined through the Agent registry exactly like Harness's
 * shipped `list_agents` tool.
 * @param ctx - the plugin context (injects `subagents`).
 * @param captainSessionId - the captain's session id.
 * @returns child id → activity, missing entries are unknown children.
 */
export async function memberActivity(
  ctx: Context,
  captainSessionId: string,
): Promise<Map<string, 'running' | 'idle' | 'ready'>> {
  const captain = brandedSessionId(captainSessionId)
  const entries = await ctx.subagents.listDescendants(captain)
  const activity = new Map<string, 'running' | 'idle' | 'ready'>()
  for (const entry of entries) {
    if (entry.parentId !== captain) continue
    const live = ctx.get('agents')?.get(entry.id)
    activity.set(entry.id, live === undefined ? 'ready' : live.status)
  }
  return activity
}
