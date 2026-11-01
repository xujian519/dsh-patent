# Agent Note: The Mady import assessment for the patent domain found no remaining candidates

Status: implemented

English | [中文](2026-10-06-mady-import-assessment-empty.zh.md)

## Problem

Mady is a Go monolith (`github.com/xujian519/mady`, 1689 `.go` files, 33 packages under `domains/`) that describes itself as an evidence-driven patent case workbench. Its domain layer overlaps this repository's patent domain heavily: a deterministic rule engine, deadline arithmetic, claim charts and pin-cite validation, IPC examination standards, disclosure analysis pipelines, document templates, and approval gates all exist on both sides. Asking which of Mady's capabilities can be brought into `@deepseek-ai/dsh-patent-*` is therefore a question that cannot be answered by listing directories, and answering it consumed a cross-repository reconnaissance pass over both codebases, their git history, and the byte content of their assets.

Parts of this repository already record decisions taken from Mady: [the stage guidance and checker verdict note](2026-09-03-patent-stage-guidance-and-checker-verdict.md) imported the legal frameworks and rejected the trigger-keyword template routing (it ships no checker-verdict parser, since the checker tier produces prose only), and [the Mady rule asset merge boundary note](2026-09-21-mady-rule-asset-merge-boundary.md) fixed which of the 313 upstream rule entries were convertible and which were not. Neither records where the capabilities on the Mady side came from, which is the fact that decides the question.

## Decision

No capability qualifies. Of nine candidate areas, five are already equivalent here and three of those are stronger in this repository: the numeric-range overlap engine adds an `inside_without_endpoint` verdict plus unit-before-connector readings and an LLM cross-check track; pin-cite validation adds a paragraph-existence check that skips rather than fails when the source carries no paragraph markers; the deadline evaluator covers 20 deadline ids across 10 families with a typed `PendingDeadline` carrying a required input and a reason, against upstream's 8 types of which 2 are dead enums, with no holiday roll-forward and a Chinese sentinel string written into a field declared as ISO 8601. The IPC standard set is byte-identical between the repositories, and the evidence rule asset is a strict superset here.

The commit history decides the rest. A Mady commit of 2026-08-28 titled "引入 DeepSeek Harness 三批设计" added `domains/claimchart/pincite.go`, `domains/novelty/numeric_range.go`, `domains/rulekit/verdict.go` and `domains/slop/slop.go`. Those four are ports out of this repository: their presence in Mady is the evidence that the designs already existed here. Importing them would move this repository's own 2026-08 work back into itself. The import ran the other way three times: a 2026-08-17 commit brought in `ipc-standards.yaml` and `evidence-rules.yaml`, a 2026-09-21 commit brought in the infringement kernel with deliberate changes recorded in the JSDoc of `all-elements.ts`, `equivalence.ts` and `risk.ts`, and earlier commits brought the checker engine, the slop engine and the quality evaluator.

This repository is the downstream of the two, and stays that way. Mady is not re-imported.

## Alternatives considered

**Import Mady's agent framework.** Mady runs on `github.com/sky-valley/pi` with its own `agentcore`, its own Pregel `graph` engine, 35 built-in tools, an eight-layer Elm TUI and a Wails desktop shell. This repository runs on Cordis plugins with `agent-loop`, `packages/client` and `packages/core/tools`. Adopting both means two agent runtimes, two tool registries and two session models in one process.

**Import `domains/deadline`, the one area with no port marker.** It is the weaker implementation. Two of its eight types (`DeadlineReexamination`, `DeadlineInvalResponse`) are never appended by the calculator; `deadline_extension.go` is agentcore glue with no holiday or extension logic at all; and its "参见通知书" sentinel is a Chinese string compared by equality inside the `DueDate` field. The 20-id evaluator in `patent-deadline` supersedes it on every axis.

**Import the generic rule abstraction from `domains/rulekit`.** `Rule[T, C]` with a typed context and a base class is a Go generics artefact; TypeScript's structural types already give the same benefit without the abstraction. The engine here takes `text: string` as its context and has no second consumer, so the layer would satisfy "Require a current owner and need" only nominally. The configurable aggregation that looked like the gap is two integer fields, `ShouldBlockedAt` and `InfoRevisionAt`, whose defaults already match the hardcoded thresholds in `checker/engine.ts`.

**Import Mady's 50-point slop scale.** A regression. The 43-point scale with `SLOP_PASS_LINE = 35` is a deliberate design here; adopting 50 requires moving five dimension bases and the pass line together with the `slop_clean` stage's rewind behaviour.

**Import the 15 infringement rules.** Four can produce a finding and all four are covered here more strictly — six equivalence conflicts against one, estoppel and dedication as scored dimensions against bare flags. The remaining 11 are unreachable in Mady: `RuleEngine.Check` collects only `!res.Passed` results and eight of the rules ignore their arguments and return `Passed: true` unconditionally.

**Import the evidence rule asset or the IPC standard asset.** The first is a strict superset here, the second is byte-identical.

## Consequences

A future question about importing from Mady has its answer here, including the commit direction that makes the question non-obvious: the candidate list is not short, it is directionally wrong for four of its entries.

Two of the asset facts this assessment rests on remain unaddressed. Mady holds two byte-identical copies of `ipc-standards.yaml` and neither repository has a gate or a shared generator aligning them with the copy here, so [the empty-card backfill](../bug-fix/2026-10-06-ipc-standards-empty-cards.md) changed one of three copies. Twenty-one cards are empty in the source library itself, in both copies, which no amount of importing changes.

Mady areas this assessment did not read remain open: `domains/analysiskit`, the `graph/pregel.go` implementation, and the parts of `domains/infringement` outside the rule bodies. Mady's own dead code — an unreferenced `evaluate.go`, a `weights:` block its loader does not bind, two slop implementations that both register and share no code — is a cleanup matter in that repository.

## Testing

No code changed with this decision. The assessment rests on file-level comparisons and `git log` over both repositories: a full-file comparison of `evidence-rules.yaml` showing a three-hunk difference whose only substantive change is the more specific condition on DSH's side, a `cmp` of `ipc-standards.yaml` returning exit 0, a byte comparison of `patent-core/src/atoms/handlers/builtin/extract.ts` against Mady's `disclosure/types.go` showing both feature lists flat, a read of all fifteen `Check` method bodies in `domains/infringement/rules.go` with their call sites, and a log separation of the three Mady-to-harness commits from the one harness-to-Mady commit.
