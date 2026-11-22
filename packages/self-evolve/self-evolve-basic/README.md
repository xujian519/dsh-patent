---
description: "The **`BasicSelfEvolveEngine`** is the default provider of `ctx.selfEvolve`. It wires the `failure-patterns` projection unit, triggers evolution loops on idle or explicit request, and commits narrow L1 (skill) and L2 (prompt-section) proposals through reversible Cordis effects."
kind: "package-reference"
---

# @deepseek-ai/dsh-self-evolve-basic

English | [中文](README.zh.md)

## Summary

The **`BasicSelfEvolveEngine`** is the default provider of `ctx.selfEvolve`. It wires the `failure-patterns` projection unit, queues evolution requests that drain at the agent's idle boundary, and commits narrow L1 (skill) and L2 (prompt-section) proposals through reversible Cordis effects.


## Table of Contents

- [Role](#role)
- [Triggers and queue](#triggers-and-queue)
- [Configuration](#configuration)
- [Validation pipeline (Phase 1)](#validation-pipeline-phase-1)
- [Negative results (P1.7b)](#negative-results-p17b)
- [L2 prompt-section persistence](#l2-prompt-section-persistence)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Role

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-self-evolve` | Service Definition: abstract `SelfEvolveEngine` + durable events |
| `@deepseek-ai/dsh-self-evolve-basic` (this) | Service Provider: projection-driven idle-pressure policy + base proposer/validator |
| `@deepseek-ai/dsh-tool-self-evolve` | Consumer: model-facing tools and prompt section |

## Triggers and queue

Four triggers reach the loop. `idle-maintenance` starts when the agent reports `agent/status` `idle` and the session is not a subagent (origin `subagent`, a parent session, or a delegation depth above zero). `pressure` starts on `compaction/start` with a non-null `turn`, so an automatic compaction counts and a manual `/compact` does not. `user-command` starts from `requestEvolve`, which `self_evolve_now` calls; it bypasses `minIntervalMs` and `maxDailyLoopsPerSession` and is never evicted. `validation-retry` starts from the provider itself: one `low-confidence` rejection queues one retry per pattern, bounded by `maxValidationRetriesPerPattern`, and no other rejection reason queues at all.

`requestEvolve` maintains a per-session in-memory FIFO ordered by priority `user-command` > `validation-retry` > `pressure` > `idle-maintenance`. Identical level sets coalesce and return `status: 'coalesced'`; a queue at `maxPendingEvolveRequests` evicts the oldest autonomous request and keeps every explicit one. Each drain starts at most one request, and a request still queued at process exit is lost. The drain re-checks `agent.status === 'idle'` and the session's open state before starting maintenance, and a busy agent leaves the request queued for the next idle boundary.

A completed explicit request sends one follow-up message when `notifyOnExplicitRun` is set and the run proposed or committed anything; autonomous runs never notify.

## Configuration

`BasicSelfEvolveConfig` controls trigger policy, rate limits, default edit surfaces, and validation tolerances:

| Field | Default | Semantics |
|---|---|---|
| `maxDailyLoopsPerSession` | `4` | Maximum autonomous loops started per session per 24-hour window; explicit `user-command` loops bypass it. |
| `triggers` | all enabled | Per-trigger `{ enabled, minIntervalMs }` policy for `idle-maintenance`, `pressure`, `user-command`, and `validation-retry`. |
| `defaultLevels` | `['L1-skill', 'L2-context']` | Edit surfaces proposals may target by default. |
| `minPatternOccurrences` | `2` | Minimum occurrence count before a pattern becomes a proposal target (`tool-runtime` patterns require one extra). |
| `maxProposalsPerLoop` | `2` | Maximum proposals generated per loop. |
| `requireDualVerification` | `true` | Held-in dual-verifier gate (翁荔 challenge 1): when both verifier signals are available, a proposal passes only if replay AND workspace checks pass; single-sided pass is rejected without counting a regression. When either collector produces no signal the dimension counts as missing rather than passing, and the proposal is rejected as `verifier-unavailable`. |
| `minAcceptConfidence` | `0.5` | Acceptance gate: `min(deconstructedScores) × heldInRate × heldOutRate` must reach this value. Any single dimension without a signal caps the product at 0.3, so such proposals are rejected as `verifier-unavailable` before this comparison — no threshold turns missing evidence into an acceptance. |
| `maxHeldOutCases` | `5` | Similar-history events searched and replayed as held-out cases per proposal (P1.3). |
| `heldOutSessionIds` | `[]` | Sessions whose history supplies held-out cases (P1.3). Empty falls back to the proposing session, which is self-confirmation rather than an independent probe; set this to sessions the loop did not steer. |
| `minHeldOutPassRate` | `0.6` | Held-out pass-rate threshold (P1.3): similar-history replays passing at or above this ratio count as held-out-passed. |
| `proposerTarget` | none | Optional `{ provider, model }` routed for the proposer LLM call. |
| `validatorTarget` | none | Optional `{ provider, model }` routed for the validation LLM judge (P1.4). Absent leaves the judge dimension unsignalled, so every proposal is rejected as `verifier-unavailable`. Must differ from `proposerTarget` or load fails. |
| `maxDirtyLinesAddedPerCommit` | `2` | Dirty-line tolerance for the held-in workspace verifier (P1.9b); a replay may add at most this many dirty lines before the gate rejects it as a workspace regression. |
| `workspaceVerifier` | `{ enabled: true }` | Held-in workspace verifier policy (P1.9b): `enabled` is the master switch; `buildCommand` (e.g. `pnpm run build`) is the project build command run after the replay; `gitTimeoutMs` (default 30000) and `buildTimeoutMs` (default 300000) bound the git and build runs. Without a `buildCommand`, the signal stays unavailable and the loop degrades to the weak path. |
| `maxPromptInflationBytesPerWeek` | `2048` | Long-horizon prompt-inflation budget (翁荔 challenge 7), measured in UTF-8 bytes: when live self-evolve L2 sections exceed it, the pruning job archives the oldest to `$DSH_HOME/self-evolve/l2-archive/`, records the retirement in `l2-committed.jsonl`, and disposes their effects until the total fits (P1.9). Sections are ordered by registration age; a usage-based ordering is not implemented. |
| `l4ReapprovalHours` | `24` | L4 re-approval cadence (P2.3): a plugin this provider drove is forced through human approval again when the current proposal differs from the last approved one or the approval is older than this window — even over `approveFutureVersions` grants. |
| `maxStepReflectionsPerTurn` | `1` | Step-reflection throttle (P3.1): a low-budget LLM reflection on a failing step runs at most this many times per turn; `0` disables it. |
| `reflectionMinConfidence` | `0.85` | Minimum model-reported confidence for a step reflection to reinforce a pattern via a `self-evolve/reflection` event (P3.1). |
| `patternFreezeHours` | `24` | Per-pattern proposal freeze (P3.3): after two proposals, a pattern is skipped for this window (diversity-collapse guard). |
| `maxBudgetCharsPerLoop` | `32768` | Per-loop byte budget for LLM calls and searches (P3.4); exceeding it aborts the loop with `budget-exceeded` and closes the bracket with an error. |
| `allowUnverifiedAutonomousRuns` | `false` | Whether autonomous triggers may run when the deployment cannot verify a proposal (no `workspaceVerifier.buildCommand` or no `validatorTarget`). A `user-command` request runs either way and reports `verifier-unavailable`. |
| `maxValidationRetriesPerPattern` | `1` | `validation-retry` reach per pattern; `0` disables the trigger. |
| `maxPendingEvolveRequests` | `8` | Queued requests per session before the oldest autonomous request is dropped. Explicit requests are never dropped. |
| `notifyOnExplicitRun` | `true` | Send a follow-up summary after a completed explicit request that proposed or committed something. |
| `maxNegativeResultRows` | `500` | Retained rows in `negative-results.jsonl`; the file is atomically rewritten to the newest rows past the cap. |
| `maxGlobalPatternRows` | `1000` | Retained rows in `global-patterns.jsonl`, with the same atomic trim. |
| `maxTrackedSessions` | `64` | Per-session rate, reflection, proposal, regression, and retry state retained before least-recently-used eviction. |
| `maxTrackedPatternsPerSession` | `256` | Pattern-keyed entries retained per session for the same maps. |
| `maxLiveSkills` | `32` | Live runtime skills this provider may own; a new L1 commit past the cap is rejected as `apply-failed` rather than evicting a live skill. |

L3 and L4 proposals are not implemented by this base provider; downstream providers can subclass `proposeForPatterns()` and `validateProposal()` safely.

## Validation pipeline (Phase 1)

`validateProposal` runs the Phase 1 pipeline: held-in dual verification (fork replay P1.2 + workspace verifier P1.9b), held-out similarity replay over `sessionQuery.searchEvents` hits (P1.3), the LLM judge over `validatorTarget` (P1.4), and the aggregate confidence gate. The workspace verifier captures the pre-replay baseline, then measures the replay's net git dirty delta (`git diff HEAD --numstat` plus untracked-file lines, excluding harness-owned `.dsh/` paths) and runs the configured `buildCommand`; both must pass within `maxDirtyLinesAddedPerCommit`. Every dimension that produces no signal is capped at the weak rate 0.3 and recorded by name, so a proposal the verifiers could not judge is rejected as `verifier-unavailable` before the threshold comparison — distinct from `low-confidence`, which means they judged it badly. Held-out cases are searched from the proposing session's own history, excluding the pattern's supporting seqs. Rejected proposals land in the negative-results log (P1.7b), and two consecutive same-pattern regressions roll the archived champion back (P1.8).

## Negative results (P1.7b)

Rejected proposals are appended as one JSON line per rejection to `$DSH_HOME/self-evolve/negative-results.jsonl` (`{ts, patternId, proposalId, reason, diagnostic, deconstructedScores?, nextRoundSuggestion}`). `readNegativeResults(patternId, limit)` loads the most recent rows for one pattern, the template proposer summarizes them into its generated prompt-section text so repeated failed approaches are not proposed again, and `readPatterns` enriches each pattern's `verifierMeta.failedProposals` (P1.6).

## L2 prompt-section persistence

An accepted L2 section is appended to `$DSH_HOME/self-evolve/l2-committed.jsonl`, and provider startup re-registers the latest row per section name under the `maxPromptInflationBytesPerWeek` budget. Pruning and rollback append a retirement row for the section name, so a retired section is not restored.

## Model Experience

### Stable self-evolve guidance

#### What the model sees

A stable prompt section registered by `@deepseek-ai/dsh-tool-self-evolve` tells the model when to call `self_evolve_inspect_patterns` and `self_evolve_now`. This provider additionally registers runtime skills and prompt sections for accepted L1/L2 proposals; those contributions are scoped to the provider fiber and unwind on validation failure or disposal.

#### Token effect

Accepted prompt-section proposals append text to the system prompt for subsequent turns. Accepted skill proposals add retrievable skill content that may be included when the skill registry matches the turn context.

#### KV Cache effect

The stable tool-self-evolve prompt section is present on every request while the consumer is loaded, so it participates in the request prefix. Proposal-driven prompt sections and skills are added to the prefix from the turn they commit onward.

## Known Limitations and Deferred Work

- **L1/L2 only** — the provider targets skill (L1) and prompt-section (L2) proposals; L3-workflow and L4-harness requests produce no proposals yet.
- **No commits until all three dimensions are signalled** — the held-in workspace verifier (P1.9b) produces a signal only for a git work tree with `workspaceVerifier.buildCommand` configured; the judge produces one only when `validatorTarget` is set; the held-out probe produces one only when similar non-supporting history exists. Any missing dimension caps the aggregate at the weak rate, which `minAcceptConfidence` (0.5) can never reach, so the shipped default rejects every proposal as `verifier-unavailable`. Enabling all three is an explicit composition step, not the shipped default.
- **Held-out defaults to same-session** — `collectHeldOutSignal` searches the proposing session's own event history unless `heldOutSessionIds` names other sessions, so the default cannot supply an independent distribution; a fresh session with a concentrated failure pattern commonly finds no hit at all.
- **Replay proves exercise, not repair** — `replayCase` requires the child to complete, to have made at least one tool call, and to re-trigger no failure pattern. All three read durable events, but none of them verifies that the original failure is actually fixed: a child that runs the wrong command still passes. Objective judging needs the failure pattern to carry a replayable command with an expected result.
- **L4 is authorized by approval alone** — `validateL4Proposal` records `L4_APPROVAL_SCORES` and pins `confidence: 1`; the aggregate gate does not evaluate L4, and the human approval flow is its only defense.
- **L1 and L2 survive restarts; L3/L4 do not** — an accepted L1 skill is a file under `<cwd>/.dsh/skills/`, and an accepted L2 section is a commit row in `$DSH_HOME/self-evolve/l2-committed.jsonl` replayed at startup. L3 workflow scripts and L4 harness plugins are process-local effects that end with the provider fiber.
- **No keyed end-to-end verification** — proposal effects are reversible commits covered by unit tests; a live `dsh --profile` loop run requires a keyed environment.
- **First-commit rollback writes a tombstone** — rolling back a skill this provider committed first restores the runtime skill and rewrites `.dsh/skills/<name>/SKILL.md` as front-matter-less content, because the `fs` seam has no remove primitive; the skill filesystem ignores that file and logs one scan warning. Rolling back over a champion rewrites the file with the champion's content instead.
- **Queue state is in memory** — a queued request that outlives the process is lost; `self-evolve/start|end` and the tool receipt remain in the session log as the durable record.

### Dev Note

None.
