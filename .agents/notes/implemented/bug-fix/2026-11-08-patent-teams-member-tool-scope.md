# Agent Note: Resolve member tool allow lists against the captain's scope

Status: implemented

English | [中文](2026-11-08-patent-teams-member-tool-scope.zh.md)

## Problem

A member is a continuable child of the captain, and both are children of the same preset generation. `memberToolAllowList` built the allow list from the plugin's registration context, whose `restrictableNames()` excludes the preset's own registrations. The member child inherits exactly that layer, so `tools.restrict({ allow })` removed every preset-owned tool. After the 2026-11-08 desktop build, members fell from 156 tools to the seven `mcp__cnlaw__*` tools while their persona still ordered them to claim tasks, and the captain wrote the deliverable itself.

## Decision

`memberToolAllowList(captain.ctx, role)` resolves the list against the captain's session context. `spawnMember` passes `captain.ctx`; the plugin context continues to own `subagents`.

The list is the member baseline intersected with the captain's restrictable set, the mounted `mcp__cnlaw__*` names, the role's declared tools that exist there, and the four coordination tools (`claim_task`, `update_task`, `send_message`, `status`), minus `MEMBER_DENIED_TOOLS`.

The child's ancestor chain is a subset of the captain's: `composeFrom` joins the child to the captain's generation and adds no other parent. A deny name absent from the captain's restrictable set is therefore absent for the child, and `spawnMember` drops it before startup. The full deny list applies when no tools service is reachable. An unknown allowed name still fails at `restrict()`.

The member persona keeps working rules 1–5 and the domain-discipline block verbatim. Rule 9 names only the validators present in the granted surface and disappears when none is granted; an untrimmed member keeps the original text.

## Alternatives considered

**Build the list from the plugin registration context.** That context excludes the preset layer the child inherits, so the list dropped every preset tool.

**Intersect `tools.definitions(scopeOf(ctx))`.** It reads the same layer, but it adds `@deepseek-ai/dsh-scope` as a peer dependency and repeats the scope-symbol lookup that `restrictableNames()` already performs.

**Retry the start after parsing `unknown global tool` from the rejection.** `tools.restrict()` throws a plain `Error`, so the retry identified missing names by message text. A reworded core diagnostic would disable it silently, and the tests constructed the same text. Pre-filtering removes the retry and the message dependency.

**Keep every deny name and fail member creation when one is absent.** A composition without `send_message` would fail `add_member`; the pre-filter tolerates that absence without granting anything extra.

## Consequences

Preset-owned tools and the four coordination tools survive trimming, so a role-scoped member can read, run the shell, claim work, and report. A missing deny tool no longer fails `add_member`, and stays denied wherever it exists. Unknown allowed names still fail loud at member creation.

Only `@deepseek-ai/dsh-patent-teams` changes. Teams created before a desktop build containing this fix keep their existing sessions; archived teams are not migrated. The disclosure workflow, its skill, and `patent_workflow_run` are unchanged.

## Testing

`tests/member-tool-scope.spec.ts` mounts the real registry, binds a captain and a member to one preset layer, and asserts the allow list contains `read`, `bash`, the coordination tools, and the mounted role tool. It applies the list through the child's `restrict()` and checks `schemas()`, proves an allow name the child does not inherit still throws, and checks that a composition without cnlaw keeps the deny-only surface. `members.spec.ts` covers the deny pre-filter and the full deny list without a tools service; `member-tools.spec.ts` pins the list contents.
