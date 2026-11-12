# Agent Note: Generalize Agent Teams into a Domain-Neutral Capability Seam

Status: proposed

English | [中文](2026-08-27-generalize-agent-teams-capability.zh.md)

## Problem

Multi-agent team functionality exists three times in this repository with two incompatible durability models, and the only shipped implementation is locked to the patent domain:

- `packages/team/agent-team` + `packages/team/tool-agent-team` ([placement](../../archived/architecture/2026-08-18-experimental-agent-teams-packages.md)) — a Lead/teammate model whose mailbox and task board live in the Lead's session log, with event fold and invariant replay. Unreleased (experimental release exclusion), mounted only by the headless example, and it has no scheduler.
- `packages/patent/patent-teams` — a formal port of the upstream plugin `NanmiCoder/dsh-agent-teams`, re-scoped to patent: file-backed `.patent-teams/` state, an event-driven scheduler with `attempt`/`attemptId`/`handoffId` revocation, JSONL mailboxes, a composite completion gate, and the only real preset wiring ([wiring](../../implemented/feature/2026-08-23-wire-patent-teams-into-preset.md)).
- The upstream plugin itself (external, MIT, ~1.1k stars) — domain-neutral and more featureful than our port, but outside the repo and outside our seam control.

The other target domains have no team capability at all: the `code` and `document` presets compose agents only through generic `subagent`/`workflow` tools, and the self-media domain lives in the user's ZCode plugin environment (video-agent-kit), not in this repo. Today, adding teams to a second domain means forking patent-teams (nine source files, tool prefix, event names, state directory, UI panel, preset mount) and editing the fork's domain imports.

The patent couplings that a fork would have to rewrite are exactly three: [members.ts](../../../../packages/patent/patent-teams/src/members.ts) statically imports `RoleContract` folding from `dsh-patent-workflow` ([decision](../../implemented/feature/2026-08-23-role-worker-contract-mapping.md)); [service.ts](../../../../packages/patent/patent-teams/src/service.ts) statically imports `roleContract`/`validateWorkerOutput` and `evaluatePatentContent`; the `patentRuleGate` lookup is already an optional `ctx.get` ([gate](../../implemented/feature/2026-08-23-quality-gate-into-teams.md)) — two static imports to invert, one seam already shaped correctly.

The feature sets have also diverged in both directions: the port dropped upstream's staged planning with Approve & Run, the `halted`/`escalated` lifecycle with `agent_teams_resume`, the structured quality task kinds (`requirements`…`integration` with verdicts, acceptance results, repair loops), and named team profiles; the experimental pair has scheduler-free manual delegation and `waitForChange` instead. Every subsequent domain would inherit this drift instead of one converging core.

## Proposal

Extract one domain-neutral agent-teams capability seam that all domains mount, with domain policy plugged in through two declared hooks rather than forks. The file-backed design of patent-teams/upstream becomes the shipped provider; the experimental pair is retired.

### What the upstream research establishes

`dsh-agent-teams` is the reference for the generic core because it already solved domain neutrality for its own scope. Its semantics worth owning:

- Captain/member model over `ctx.subagents.startContinuable()` + `followup()` members, per-member model-route snapshots (`provider`/`model`/`reasoning_effort`, plus a fallback route).
- Event-driven shared scheduler: every idle edge and task mutation attempts one atomic claim for a genuinely idle member; reassignment revokes the old `attemptId` first, so late writes cannot override new results; only cold-restart stragglers get new attempts.
- File state as truth (`<workspace>/.agent-teams/<teamId>/team.json` + `inbox/*.jsonl`), session events (`agent-teams/*`) as the audit/replay mirror — this satisfies our model-visible-⟺-logged rule the same way the shipped port already does.
- Structured quality kinds with verdict-gated completion and automatic repair/review follow-up tasks; human halt (`halted`) distinct from automatic ceiling (`escalated`), resumed only through an explicit `agent_teams_resume`.
- Named profiles in `cordis.patch.yml` (`taskPlanning: captain | seed`, member roster, protocol, review policy) — the config-level composition surface a domain ships instead of code.
- Two-phase staged planning (editable member placeholders and DAG on disk, no sub-sessions until the user clicks Approve & Run).

### Package topology

A new `packages/teams/` group following the [capability-seam](../../../../docs/glossary.md#capability-seam) discipline (Service Definition + provider roles complete; Consumers separate):

- `packages/teams/agent-teams` — the Service Definition `ctx.agentTeams` plus the reference file-backed provider: state, scheduler, mailboxes, member lifecycle over continuable subagents, `agent_teams_*` session events. Generalized from patent-teams with the patent imports removed; package name, tool prefix, event namespace, and state directory (`.agent-teams/`) all drop the `patent` scope.
- `packages/teams/tool-agent-teams` — the tool Consumer: `agent_teams_*` tools, the captain-protocol prompt section, and the member-scope tool-denial policy (`MEMBER_DENIED_TOOLS` generalized to deny the captain-only tools of whatever team toolset is mounted).
- `packages/client/ui-agent-teams` — the UI Consumer generalizing the `ui-patent-teams` event fold; one chat-node panel per team, namespace-neutral.

Splitting the file provider out of `agent-teams` is deliberately deferred: the seam stays one package until provider roles evolve independently (session-log provider, remote provider).

### Domain policy seams

The two static patent imports become declared, config-visible seams on the service:

- **Member persona enrichment** — an optional `memberPersona(role): prompt-section` contribution. Patent mounts role contracts from `dsh-patent-workflow`; other domains mount nothing or their own; the member persona without a contribution is name + role + execution prompt, exactly upstream's shape.
- **Task completion gate** — an optional `taskCompletionGate(task, output): pass | bounce(reason)` contribution replacing the `qualityGate: boolean` + static `evaluatePatentContent` coupling. Patent mounts its evaluate + `patentRuleGate` composite; upstream's structured quality kinds ship as a stock gate provider a coding-domain preset can mount alone. The `contractValidation` record on tasks becomes gate output instead of patent vocabulary.

Composition knowledge stays per-domain where it already works: presets mount the seam behind an `isolate` realm, and skills (the `patent-team-composition` pattern of scenario role packs) plus named profiles carry the roster/DAG knowledge. No domain ships team code.

### Migration and scope

- Patent rebase: `packages/patent/patent-teams` shrinks to a small policy plugin implementing the two hooks over `patent-workflow`/`patent-tools`/`patent-rule`; the patent preset's `isolate.patentTeams` mount renames to the generic service. Pre-release stance applies — old `.patent-teams/` state directories are not migrated.
- Experimental retirement: `packages/team/agent-team` + `tool-agent-team` are deleted, their headless example mounts the generic seam instead, and inbound links (including the `agentTeams` api-catalog key) are repaired in the same change. Their durable ideas — invariant replay over team events, `waitForChange` — are recorded here as candidates to fold into the generic provider later, not as blockers.
- Feature adoption from upstream is phased: P0 is the generic core with the port's current semantics (scheduler, attempt revocation, mailboxes, model snapshots); P1 adds the `halted`/`escalated` lifecycle with `agent_teams_resume` and named profiles; P2 is staged planning with Approve & Run and the overlay activity panel (needs command-surface and client work).
- Domain landings: patent migrates (P0 proof), `code`/`standard` presets gain the seam with the stock quality-kinds gate (P1), `document` mounts it with a composition skill alongside `document_deliver` as the terminal gate (P1). Self-media stays out of this repo until that domain exists here; the seam is what it would mount.

## Alternatives considered

**Generalize the experimental session-log pair instead.** It is ours, invariant-replaying, and keeps all team state under the session log where the model-visible-⟺-logged rule is native. It lost because it has no scheduler, no shipped consumer, no UI path, and no preset wiring, while both battle-tested implementations (upstream with ~1.1k stars, our shipped port) independently chose file-backed state with session events as the audit mirror; adopting it would mean rebuilding the proven half of the feature on the weaker foundation.

**Consume the upstream plugin as an external dependency.** Zero porting cost and upstream maintenance. It lost because a third-party plugin cannot be our capability seam: we do not control its service vocabulary, its host-key compatibility window (it already probes `ctx.httpServer` vs `ctx.webServer` across our rc versions), or its event/session-log fit, and every domain integration here would then depend on an external release cycle.

**Fork patent-teams per domain.** The status-quo path for a second domain. It lost because the fork count grows with every domain and every upstream-class feature (resume, profiles, staged planning) must be re-ported N times; the three coupling points make every fork a rename-and-rewire exercise rather than a configuration exercise.

**Prompt-level composition only (status quo for code/document).** Presets and skills over generic `subagent`/`workflow` tools, no shared durable board. It lost because it has no dependency-aware task claiming, no durable peer mailboxes, and no cross-restart continuity — the capabilities that motivated both existing team implementations.

## Acceptance criteria

- `packages/teams/*` contains no `dsh-patent-*` import; the patent preset mounts the generic seam plus a patent policy plugin, and the ported patent-teams tests and snapshots pass unchanged in behavior.
- A domain-neutral mount exists outside the patent group: the headless example (replacing the experimental pair) runs a fixture team end-to-end, and the standard or code preset mounting is a recorded decision.
- Tool names (`agent_teams_*`), session events (`agent-teams/*`), and the state directory are documented in `docs/subsystems/`; the api-catalog is regenerated; `doc-sync` and the agent-note gates pass.
- The experimental packages are gone, inbound documentation and note links are repaired, and this note records their retirement.

## Risks

- Upstream divergence: the external plugin keeps evolving (its staged planning and overlay panel are ahead of us); owning the seam means choosing deliberately what to adopt, and the phased plan may lag upstream features we want.
- The durability-model debate can reopen: session-log advocates lose the invariant-replay foundation for now; the recorded mitigation is folding replay/invariants into the file provider's event mirror later.
- UI surface cost is real: the chat-node panel is within reach, but upstream's overlay panel, DAG interaction, and staged-plan editor are P2 client work that may never land if demand stays patent-shaped.
- Inherited limits survive generalization: one active team per captain, single-process consistency per team, event-driven scheduling that cannot cold-resume members while the captain is offline. Generalizing the seam does not fix these; it makes them explicit config-documented limits.
- Scope creep: profiles and staged planning are product features, not seam prerequisites; the P0/P1/P2 split exists to keep the seam migration reviewable.
