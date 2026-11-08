---
description: "Durable multi-agent teams for patent workflow: one captain-led team of continuable subagents with dependency-aware tasks, mailbox messaging, and an event-driven shared-task scheduler. A formal workspace port of the upstream `@nanmicoder/dsh-agent-teams` plugin, re-scoped to the patent domain (`patent_teams_*` tools, `.patent-teams/` state directory, `patent-teams/*` session events) and shaped as a Service Definition (`ctx.patentTeams`) with the tools as its sole Consumer."
kind: "package-reference"
---

# dsh-patent-teams

English | [中文](README.zh.md)

## Summary

Durable multi-agent teams for patent workflow: one captain-led team of continuable subagents with dependency-aware tasks, mailbox messaging, and an event-driven shared-task scheduler. A formal workspace port of the upstream `@nanmicoder/dsh-agent-teams` plugin, re-scoped to the patent domain (`patent_teams_*` tools, `.patent-teams/` state directory, `patent-teams/*` session events) and shaped as a Service Definition (`ctx.patentTeams`) with the tools as its sole Consumer.

## Table of Contents

- [What it mounts](#what-it-mounts)
- [Configuration](#configuration)
- [State model](#state-model)
- [Session events](#session-events)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## What it mounts

- `ctx.patentTeams` — the `PatentTeamsService`: team CRUD, task state machine with attempt revocation, member lifecycle (spawn/interrupt/retire), mailbox persistence, archive-on-delete, and scheduler kicks.
- Twelve `patent_teams_*` tools: `create`, `add_member`, `remove_member`, `create_task`, `reassign_task`, `claim_task`, `update_task`, `send_message`, `wait`, `status`, `archive`, `delete`.
- One system-prompt usage section (`patent-teams:usage`, default order 117) teaching the captain protocol.

## Configuration

```yaml
- id: patent-teams
  config:
    stateDir: .patent-teams      # team state root under the captain's workspace
    memberProvider: spawn        # ctx.subagents provider (continuable + persona + toolFilter)
    memberModel: deepseek-v4     # optional model override for every member
    memberMaxDepth: 1            # member delegation depth cap (0 forbids delegation)
    maxMembers: 8                # team size cap
    promptSectionOrder: 117      # usage-section order
    qualityGate: false           # run the composite quality gate on worker completions
    passThreshold: 0.7           # advisory composite-score threshold (0.01..1)
    mailboxDeliveryLeaseMs: 60000 # live-delivery lease before a claimed message is retried
    approveCreation: false       # ask the approval answerers before creating a team
    approveClosure: false        # ask the approval answerers before archiving the team
```

Two of the twelve tools decide the case rather than the work inside it: `patent_teams_create` opens a team, and `patent_teams_delete` closes it. With `approveCreation` or `approveClosure` on, the tool asks the deployment's `approval` service for one decision before the mutation runs, so a user decision stands between the captain and both ends of a case — the captain leads the work but does not decide alone that a team should exist or that the case is finished. The request names the tool, the exact call, and the reason (the team name and goal on create; the closure on delete), and the approval service writes its own audit pair. A deployment that turns a switch on without an answerer is refused rather than waved through: the seam raises `TeamApprovalError` naming the outcome (`rejected`, `cancelled`, or `unavailable`), and the model sees the failed call. A refusal under a `never` approval policy names the policy as an automatic rejection rather than a user decision. Both switches default to `false`; the patent preset turns both on.

`qualityGate` is opt-in and applies only to tasks created with a `worker` contract. A completion must carry output (submitted now or stored by an earlier update); a missing contract field, insufficient content, or a rule-gate hit bounces the task back to the member with feedback. `passThreshold` controls only when the advisory composite score is called out, not whether the gate bounces.

Each member runs as a continuable child of the captain on the same preset generation. Its tool surface is the shared member baseline (file, shell, job, delegation, team-channel, and validator tools), the `mcp__cnlaw__*` tools the composition mounts, the role's declared tools that exist there, and the four coordination tools (`claim_task`, `update_task`, `send_message`, `status`); the captain-only mutators and the generic `send_message` are denied. A member without a role, or a composition without cnlaw, keeps the deny-only surface. The allow list is resolved against the captain's session context, so the tools the preset itself registers reach the child; deny names the composition does not carry are dropped before startup, and an unknown allowed name still fails member creation.

## State model

Team state lives under `<workspace>/<stateDir>/<teamId>/`:

- `team.json` — the durable `TeamState` record (members, tasks, task sequence).
- `inbox/<agentKey>.jsonl` — one JSONL mailbox per agent (`captain` or a member name).

A workspace-level `<workspace>/<stateDir>/retired-members.json` records the retired member session ids; the mount-time guard filters them from agent listings and rejects resuming them.

Team-record mutations run inside an in-process per-team lock and persist atomically (same-directory temp + rename, with a direct-write fallback for Windows `EPERM`); mailbox appends are single-line `O_APPEND` writes, and `add_member` resolves the member route and starts the child outside the lock (state admission and persistence revalidate inside it) so one spawn never stalls the team's tools. A live-delivery claim is exclusive for `mailboxDeliveryLeaseMs` (default 60 s) before another delivery attempt may retry it. `patent_teams_status` counts those leased messages separately from the ones a delivery attempt may take now (`captain_inbox_leased`, and `leased` on each member inbox; `count` holds the deliverable unread), so a captain can tell an empty inbox from a backlog the live-delivery path has not released yet. `patent_teams_add_member` rejects a role id that `role-contracts.ts` does not register, so a misspelled role cannot spawn a member with no contract. Task status transitions are validated by `TASK_TRANSITIONS`, and a refused transition names the statuses that are allowed next, so a caller that jumped (typically `claimed → completed`) learns the intermediate status to enter instead of retrying blind; every claim carries an `attempt_id` capability that becomes stale after retry or reassignment, so late member updates are rejected. `patent_teams_delete` archives the team directory under `archive/` instead of deleting it, retaining tasks and mailboxes for later review; `patent_teams_archive` reads that archive back (workspace-wide listing plus one-team detail, read-only). An archived team name stays reserved: creating another team with the same name is refused with `TEAM_NAME_ARCHIVED`, so a later delete cannot overwrite the earlier archive.

## Session events

Every state mutation appends one `patent-teams/*` event to the captain's session (types and payloads in `event-types.ts`): `team-created`, `member-added`, `member-removed`, `task-created`, `task-updated`, `task-validated`, `task-gated`, `message-sent`, `team-deleted`. Events are informational records marked `ignorable: true`; durable team state remains authoritative.

## Model Experience

### Request context and condition

#### What the model sees

The usage section is a fixed system-prompt contribution whenever this plugin is mounted, plus the twelve tool schemas in the [generated tool catalog](../../../docs/tool-catalog.md).

##### Verbatim text for this field, when needed

```markdown
When the user asks to run something with PatentTeams (e.g. "use PatentTeams to do X"), you are the captain of a multi-agent team. Follow this protocol:
1. Call patent_teams_create with a team name and the goal as description. You become the captain and may lead one team at a time.
2. Call patent_teams_add_member once per role the goal needs, using a registered role id (researcher, drafter, illustrator, ...). Members are durable subagents: they wait for your messages, then work a full turn. By default a member on your current provider/model snapshots your current reasoning effort; a member routed to a different provider or model automatically uses that target model's default effort. Never ask the user to choose these per member; only pass provider/model when the user explicitly requests a different route for that role, and reasoning_effort only when the user explicitly requests a particular effort ("default" explicitly selects the target model's default).
3. Break the goal into tasks with patent_teams_create_task and wire dependencies. Assign role-specific work when useful; unassigned ready work belongs to the shared pool. The scheduler automatically claims one ready task for each truly idle member and wakes it, including across later rounds.
4. Lead by delegation: assign work with patent_teams_create_task, send guidance with patent_teams_send_message, and let idle teammates execute ready work. Then wait with patent_teams_wait and re-read patent_teams_status when it returns — the wait blocks until a task moves, a teammate reports, or a member starts or stops working, so never sleep, poll, or loop on status to pass the time. Do not duplicate a teammate's work merely because its turn is slow.
5. If work is blocked, stale, or needs takeover, always call patent_teams_reassign_task first. Reassign to another idle member, or use assignee=captain before doing it yourself. Reassignment revokes the old attempt and waits for that member to quiesce, preventing late results from overwriting the new attempt.
6. Tasks carry attempt_id capabilities. Members must use the current attempt_id for updates; STALE_ATTEMPT errors mean ownership changed. Keep dispatching and waiting until every required task is terminal and every member is idle/ready.
7. Present the team's results to the user, then patent_teams_delete the team unless the user wants to keep working with it. Deleted teams stay reviewable read-only through patent_teams_archive.

Tools: patent_teams_create, patent_teams_add_member, patent_teams_remove_member, patent_teams_create_task, patent_teams_reassign_task, patent_teams_claim_task, patent_teams_update_task, patent_teams_send_message, patent_teams_wait, patent_teams_status, patent_teams_archive, patent_teams_delete
```

#### Token effect

Fixed: one usage section (approximately 2.7 KB) plus the twelve tool schemas. Data-dependent parts (team status payloads, assignment prompts, member reports) are bounded: status renders up to 10 mailbox warnings and at most 10 inbox messages per viewer (the captain inbox and a member's own inbox show full message text; a captain's cross-member preview is truncated to 200 characters), and task output is truncated to 300 characters in status and archive renders.

#### KV Cache effect

Prefix-stable: the usage section is constant for a given mount, so it does not invalidate the system-prompt prefix. Session events and team state never enter the prompt; only tool results do, on demand.

## Known Limitations and Deferred Work

- **Web UI is a separate projection** — the upstream plugin's activity-panel and artwork routes are not ported; `dsh-client-ui-patent-teams` folds the `patent-teams/*` session events into a chat card and the Teams view, and the on-disk files plus `patent_teams_status` remain the authoritative inspection paths.
- **Single-process serialization** — state is file-backed and serialized within one DSH process; concurrent processes editing the same team are not coordinated. The member status observer keeps an in-process membership index (fed by `add_member`, `remove_member`, and `delete`) so unrelated agents' status events do not rescan the state directory.
- **One active team per captain** — a captain must end its current team before creating another.
- **Live delivery is best-effort** — if the recipient agent is offline, messages stay durable in the mailbox and are retried at the next status boundary.
- **Waits are in-process** — `patent_teams_wait` observes changes announced by this process only, so a team edited by another DSH process wakes the waiter on its own timeout instead. Nothing about a wait is durable; the call ends with its process, and the caller re-reads team state after it returns either way.
- **An approval switch is only as available as the deployment's answerer** — with `approveCreation` or `approveClosure` on, a deployment that mounts no answerer, or whose approval policy is `never`, refuses the gated call (`unavailable` / `rejected`) instead of creating or closing the team. That is the fail-closed direction on purpose, and it is the reason both switches ship off: a deployment that turns one on must also compose an answerer.

### Dev Note

None.
