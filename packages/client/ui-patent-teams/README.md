---
description: "The browser plugin that restores the PatentTeams monitor to the Web UI: one durable team card in the chat stream and the fixed Teams conversation view. Both surfaces fold the nine `patent-teams/*` Session events owned by [`dsh-patent-teams`](../../patent/patent-teams/README.md); the interaction vocabulary of the upstream `@nanmicoder/dsh-agent-teams` activity panel (segmented progress, roster, task DAG) is adopted, while its body-portal floating layer and polled host route stay deliberately out — this package replays the session log instead, with no polling and no new host surface."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-patent-teams

English | [中文](README.zh.md)

## Summary

The browser plugin that restores the PatentTeams monitor to the Web UI: one durable team card in the chat stream and the fixed Teams conversation view. Both surfaces fold the nine `patent-teams/*` Session events owned by [`dsh-patent-teams`](../../patent/patent-teams/README.md); the interaction vocabulary of the upstream `@nanmicoder/dsh-agent-teams` activity panel (segmented progress, roster, task DAG) is adopted, while its body-portal floating layer and polled host route stay deliberately out — this package replays the session log instead, with no polling and no new host surface.


## Table of Contents

- [Durable state and replay](#durable-state-and-replay)
- [Presentation and navigation](#presentation-and-navigation)
- [Composition](#composition)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Durable state and replay

`patent-teams/team-created` opens one Context per team keyed by `teamId`; member additions and removals, task creations, status transitions, contract verdicts, gate rejections, mailbox messages, and team deletion update that Context in log order. Both the chat Definition and the view-source Definition run the same reducer from `teams-model.ts`, so the card and the Teams tab are two projections of one fold and cannot disagree. A history tail containing only updates stays pending until an older page supplies the unique start; prepend, complete replay, and live append converge to the same state. A later valid contract verdict clears an earlier degraded one — the latest verdict owns the task view. `patent-teams/team-deleted` marks the team disbanded but keeps its record for review, mirroring the host's on-disk archive. The fold also keeps a capped feed of the eight newest task transitions and mailbox messages per team for the Teams tab.

The Teams tab reads the `patentTeams` view snapshot through a per-session `ConversationViewBuilder` that preserves team-creation order across incremental upserts. Because the fold needs the unique start event, an open whose loaded window holds only the tail keeps paging the session history backwards (the Session face's `loadOlder`, bounded at 400 pages) while no team has materialized — long sessions no longer show a false empty state. While pages remain pending the tab shows a paging state instead of the empty state; a history failure or a page that cannot advance (`historyLoadStatus` reports `error`) stops the drain and falls back to the empty state. Sessions without team records still show an empty state; the tab itself is a fixed entry in every session view (order 30, after Trajectory and Document).

## Presentation and navigation

The card is a controlled disclosure: an active team mounts expanded, completed and disbanded teams mount collapsed, and the row toggles with the full header. The collapsed tail is a member count, a done/total task count, and a state dot plus status copy; the expanded body lists members (name, role, and live activity) and tasks (status, assignee, dependencies, contract-missing and gate-rejected flags). Task statuses outside the closed host vocabulary render as their raw string. A member opens its subagent Session only while every current fact agrees — running, in the ordinary Session list, `origin: 'subagent'`, parented to this Session — the same proof `ui-workflow-run` applies, so a stale fold never becomes a dead button.

The Teams view renders one dashboard block per team: a hero with the team monogram, live status pill, member and message metrics, and a completion ring; a segmented progress bar split into completed, running, and waiting; the roster with a captain strip, per-member gradient avatars derived from member ids, role chips, live states, and the current or last task binding; the task DAG laid out by dependency depth with curved dependency edges where hovering traces and clicking pins the dependency chain, and gate rejections carry a dashed red frame and badge; and the capped recent-activity feed. All copy runs through the bilingual locale dictionary, and animations degrade under `prefers-reduced-motion`.

## Composition

The package registers two Conversation Node Definitions, one view Definition, its locale dictionary, the keyed `patent-teams` Chat renderer, and the `patentTeams` conversation view as Cordis effects. Removing the client entry retracts all contributions. The shipped Web bundle includes the plugin after `ui-workflow-run`; the desktop app inherits it through the same roster.

## Model Experience

None, as this package renders durable Session facts for humans and adds no prompt, tool schema, request content, or model-visible result.

#### KV Cache effect

None.

## Known Limitations and Deferred Work

- Live member activity comes from the ordinary Session list share; a member whose list row has not arrived yet renders idle, and no manual refresh action is offered.
- `patent_teams_*` tool calls still render through the generic tool card; keyed toolviews are deferred until the ui-tool row pattern can be reused without forking its chrome.
- The view covers only teams whose events live in this Session's log; the backwards drain fills the window while no team has appeared, but a cross-session team aggregator still needs a new host query surface.
- No auto-switch to the Teams tab on team creation: the conversation service exposes no per-session snapshot read to gate the switch yet.

### Dev Note
