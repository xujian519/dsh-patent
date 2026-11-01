# Agent Note: Patent workflow stage guidance and structured checker verdicts

Status: implemented

English | [中文](2026-09-03-patent-stage-guidance-and-checker-verdict.zh.md)

## Problem

The Mady prompt-system comparison surfaced two landing gaps in the patent domain. First, the legal-operational depth of Mady's task templates (the rejection-type table, three-step boundary conditions, equivalence doctrines such as prosecution-history estoppel and the dedication rule) has nowhere to go: the manifest's atom-less stages are executed by one generic prompt built only from `stage.description`, so per-stage legal frameworks cannot be declared as data. Second, checker-tier workers return free prose, so downstream gating cannot consume a review outcome mechanically — even though the patent-core checker engine already aggregates to the same three levels the templates use.

## Decision

- `WorkflowStage` gains an optional `guidance` field (validated non-empty). The generic chain-stage executor (`createChainStageExecutor` in dsh-patent-tools) splices it between the stage description and the input material. Guidance text lives in `manifests.ts` as typed data; there is no template registry and no trigger routing. Upcoming manifests (OA response, inventiveness, infringement) carry their Mady-derived legal frameworks in this field.
- The checker-verdict parser is not shipped. `#655` deleted `checker-verdict.ts` (`CheckerVerdict`, `parseCheckerVerdict`, `CheckerVerdictParseError`, `CHECKER_VERDICT_REQUIRED_FIELDS`): the checker tier produces prose only, so the model-JSON parser had no production consumer. Whether a review outcome degrades or blocks a task stays the consuming gate's decision.

## Alternatives considered

**Mady's trigger-keyword template routing (`FindPromptByTrigger`).** Rejected: keyword dispatch picks prompts implicitly at runtime, contradicting the explicit-over-implicit rule; this repo's homes for prompts are the typed manifest and the atom handler.

**A separate prompt-template package.** Rejected: manifests and atom handlers already are the typed homes for model-facing prompt text; a parallel template system would duplicate them and drift.

**Enforce `status=pass` iff `issues` is empty inside the parser.** Rejected: that is a gating policy, not a structural property of the payload; the consuming gate (patent-teams task completion, wired in a later step) owns it.

## Consequences

- Manifest validation rejects an empty `guidance` like an empty `atom`; existing manifests are unchanged, so their prompts stay byte-identical until guidance is declared.
- No `SessionEventMap` member changes and no session event carries the prompt text, so there is no `SESSION_FORMAT_VERSION` obligation; no recorded-session snapshot case currently exercises these manifests, so no re-recording was due (one becomes due if a case starts running them).
- Shipped on these seams so far: stage guidance for the OA/inventiveness/infringement manifests (rejection-type table with strategy selection, three-step boundary conditions for missing prior art / software schemes / combinations, equivalence doctrines — prosecution-history estoppel, dedication, prior-art defense — plus the risk-level output requirement), MTU extraction guidance in the extract handler with `[待确认]` anti-hallucination markers (the groundedness scorer treats marked features as below threshold without source support), and claim-chart split requirements (minimal technical unit, method-step order vs. structure connection attention).
- Remaining planned ports: specification self-check rules, and the LLM rewrite layer behind the slop gate.

## Testing

`vitest run` over patent-core, patent-tools, and patent-workflow is green. New cases pin the guidance validation branch, the executor's splice position (with and without guidance), the guidance content of the three manifests, and the handler prompt upgrades (MTU markers on feature extraction only, the `[待确认]` scoring rule, the chart split requirements). The parser cases were deleted with `checker-verdict.ts`.
