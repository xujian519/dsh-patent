/**
 * PatentTeams for DeepSeek Harness.
 *
 * A host-plane plugin that registers the `patent_teams_*` tools, the
 * {@link PatentTeamsService} capability (ctx.patentTeams), and one usage
 * section into the global system prompt. After installation any session can
 * run multi-agent patent teamwork through natural language: the model creates
 * a team (it becomes the captain), spawns members as durable continuable
 * subagents, breaks the goal into dependency-aware tasks, wakes members with
 * messages, relays reports, and collects results.
 *
 * Installation (bundle): `dsh plugin --profile <name> add @deepseek-ai/dsh-patent-teams`.
 * The bundle patch mounts this plugin row into the host composition; the
 * service and tools register without a realm.
 * @module @deepseek-ai/dsh-patent-teams
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Declaration merge only: makes ctx.llm, ctx.subagents and ctx.systemPrompt visible.
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { PatentTeamsService, type PatentTeamsConfig } from './service.ts'
import { installRetiredMemberGuard } from './members.ts'
import { DEFAULT_MAILBOX_DELIVERY_LEASE_MS } from './mailbox.ts'
import { PATENT_TEAMS_TOOL_NAMES, registerPatentTeamsTools } from './tools.ts'

// Re-export the service class so the Typert catalog projection can render
// `ctx.patentTeams` onto the patent subsystem page (it models a Context key
// only when the key's type symbol is part of the package's public exports).
export { PatentTeamsService, type PatentTeamsConfig } from './service.ts'

export const name = 'patent-teams'
// Only the services the plugin cannot function without. `llm` and `agents`
// are optional runtime dependencies (resolved via ctx.get at use): a team
// can be created, tasked, and reported on before any member spawns, and
// member activity falls back to "unknown" without the agent registry.
export const inject = ['tools', 'systemPrompt', 'subagents']

/** Plugin configuration. */
export interface Config {
  /**
   * State directory name under the captain's workspace; team state lives at
   * `<workspace>/<stateDir>/<teamId>/` (default `.patent-teams`).
   */
  stateDir?: string
  /** `ctx.subagents` provider used to spawn members; must support continuable children and personas (default `spawn`). */
  memberProvider?: string
  /** Optional model override applied to every member. */
  memberModel?: string
  /** Member delegation depth cap (default `1`; `0` forbids delegation entirely). */
  memberMaxDepth?: number
  /** Team size cap in members (default `8`). */
  maxMembers?: number
  /** Prompt-section order for the usage policy (default `117`, after delegation policy). */
  promptSectionOrder?: number
  /** Run the composite quality gate on contract-backed task completion (deployment choice; default `false`). */
  qualityGate?: boolean
  /**
   * Comprehensive-eval score below which the gate calls out the composite score
   * as advisory feedback (0..1; default `0.7`). The bounce decision itself is
   * made by contract fields, content sufficiency, expression quality, and the
   * rule gate — never by the composite score alone.
   */
  passThreshold?: number
  /**
   * How long a live-delivery claim stays exclusive before the message becomes
   * retryable, in milliseconds (positive integer; default 60000).
   */
  mailboxDeliveryLeaseMs?: number
  /**
   * Ask the deployment's approval answerers for a decision on the team plan before
   * `patent_teams_create` creates the team (deployment choice; default `false`). A
   * deployment that turns it on without an answerer refuses the create instead of
   * creating an unapproved team.
   */
  approveCreation?: boolean
  /**
   * Ask for a decision before `patent_teams_delete` archives the team: the captain
   * leads a case but does not close it alone (default `false`).
   */
  approveClosure?: boolean
}

export const Config: z<Config> = z.object({
  stateDir: z.string().default('.patent-teams'),
  memberProvider: z.string().default('spawn'),
  memberModel: z.string(),
  memberMaxDepth: z.natural().default(1),
  maxMembers: z.natural().min(1).default(8),
  promptSectionOrder: z.natural().default(117),
  qualityGate: z.boolean().default(false),
  passThreshold: z.number().min(0.01).max(1).default(0.7),
  mailboxDeliveryLeaseMs: z.natural().min(1).default(DEFAULT_MAILBOX_DELIVERY_LEASE_MS),
  approveCreation: z.boolean().default(false),
  approveClosure: z.boolean().default(false),
})

/** The model-facing usage policy: when and how to drive PatentTeams. */
function usageSectionText(toolNames: string): string {
  return `When the user asks to run something with PatentTeams (e.g. "use PatentTeams to do X"), you are the captain of a multi-agent team. Follow this protocol:
1. Call patent_teams_create with a team name and the goal as description. You become the captain and may lead one team at a time.
2. Call patent_teams_add_member once per role the goal needs, using a registered role id (researcher, drafter, illustrator, ...). Members are durable subagents: they wait for your messages, then work a full turn. By default a member on your current provider/model snapshots your current reasoning effort; a member routed to a different provider or model automatically uses that target model's default effort. Never ask the user to choose these per member; only pass provider/model when the user explicitly requests a different route for that role, and reasoning_effort only when the user explicitly requests a particular effort ("default" explicitly selects the target model's default).
3. Break the goal into tasks with patent_teams_create_task and wire dependencies. Assign role-specific work when useful; unassigned ready work belongs to the shared pool. The scheduler automatically claims one ready task for each truly idle member and wakes it, including across later rounds.
4. Lead by delegation: assign work with patent_teams_create_task, send guidance with patent_teams_send_message, and let idle teammates execute ready work. Then wait with patent_teams_wait and re-read patent_teams_status when it returns — the wait blocks until a task moves, a teammate reports, or a member starts or stops working, so never sleep, poll, or loop on status to pass the time. Do not duplicate a teammate's work merely because its turn is slow.
5. If work is blocked, stale, or needs takeover, always call patent_teams_reassign_task first. Reassign to another idle member, or use assignee=captain before doing it yourself. Reassignment revokes the old attempt and waits for that member to quiesce, preventing late results from overwriting the new attempt.
6. Tasks carry attempt_id capabilities. Members must use the current attempt_id for updates; STALE_ATTEMPT errors mean ownership changed. Keep dispatching and waiting until every required task is terminal and every member is idle/ready.
7. Present the team's results to the user, then patent_teams_delete the team unless the user wants to keep working with it. Deleted teams stay reviewable read-only through patent_teams_archive.

Tools: ${toolNames}`
}

export function apply(ctx: Context, config: Config): void {
  const resolved: PatentTeamsConfig = {
    stateDir: config.stateDir ?? '.patent-teams',
    memberProvider: config.memberProvider ?? 'spawn',
    ...config.memberModel === undefined ? {} : { memberModel: config.memberModel },
    memberMaxDepth: config.memberMaxDepth ?? 1,
    maxMembers: config.maxMembers ?? 8,
    qualityGate: config.qualityGate ?? false,
    passThreshold: config.passThreshold ?? 0.7,
    mailboxDeliveryLeaseMs: config.mailboxDeliveryLeaseMs ?? DEFAULT_MAILBOX_DELIVERY_LEASE_MS,
  }

  // Provider registration is a sibling plugin's effect (`subagent-spawn` /
  // `subagent-fork` rows), which can land after this mount under the Loader's
  // concurrent activation — so capability validation happens at the first
  // member spawn (`spawnMember`), the earliest point the provider list is
  // settled, rather than here.

  // Construct in place: `ctx.plugin(Service)` here would spawn a nested fiber
  // whose store is invisible to this context's property proxy. Constructing
  // registers the service on the current (plugin) fiber, which parent contexts
  // resolve through the fiber chain; the fiber disposes it on unload.
  new PatentTeamsService(ctx, resolved)

  // The host exposes no targeted forget/retire seam, so the plugin owns the
  // per-child retirement boundary: retired members must disappear from
  // `list_agents` and reject `sendMessage` instead of cold-resuming.
  installRetiredMemberGuard(ctx, resolved.stateDir)

  const toolNames = PATENT_TEAMS_TOOL_NAMES.join(', ')
  ctx.systemPrompt.section({
    name: 'patent-teams:usage',
    order: config.promptSectionOrder ?? 117,
    text: usageSectionText(toolNames),
  })

  registerPatentTeamsTools(ctx, {
    approveCreation: config.approveCreation ?? false,
    approveClosure: config.approveClosure ?? false,
  })
}
