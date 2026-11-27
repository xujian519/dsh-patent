# Agent Note: Argument-quality scoring and a coherent second OA turn in patent-oas

Status: implemented

English | [中文](2026-10-24-patent-oas-argument-quality-scoring.zh.md)

## Problem

Two defects in `patent-oas` made the regression gate track noise instead of deliverable quality. The `novelty-creative` rubric gave full marks on dimensions 4 and 5 only when the deliverable concluded the application was inventive. Runs that argued the D1 + D2 combination was obvious scored 20/30 and 60/100, so `technical-teaching` swung from 74.2 to 69.9 and needed a special floor of 60. Separately, the `oa-answer` round-2 opinion asserted that the applicant had amended claim 1, while the round-1 task allowed a reasoned non-amendment. All three round-1 deliverables chose not to amend, and the round-2 evaluators scored `amendment-grounding` at 35, 50, and 60 (mean 48.3) against a floor of 50, so the gate refused the re-recorded baseline.

## Decision

`novelty-creative` dimensions 4 and 5 score the argument rather than the conclusion. Dimension 4 asks whether D2's technical field and role are correctly identified and whether the combination motivation is argued completely in either direction. Dimension 5 asks for explicit novelty and inventiveness conclusions, consistency with the argument, and correct citations to Article 22.2 and 22.3. The problem-space observables already stated these direction-neutral criteria; the rubric carried the drift.

The `oa-answer` round-2 opinion is conditional: it raises Article 33 only if the first response amended the claims, and `amendment-grounding` accepts a reasoned non-amendment that stays consistent with the first response and the current opinion. The gold digest and baseline were re-recorded on 2026-10-24: aggregate 95.70, `novelty-creative` 98.1, `oa-answer` 92.0, `technical-teaching` 92.2, `amendment-grounding` 83.3.

The workflow surface exposed a second path to the same defect. Its `draft` stage does not receive the previous round's deliverable, and `response-plan` emits `修改超范围→修改` and `权利要求1（从属）：删除` whenever the `claims` parameter carries no claim numbering: `detectIndependentClaims` returns an empty list, so every affected claim is treated as dependent. The capture before the fix followed that machine default, invented a deletion of an unidentified limitation, and hedged with `如审查员认为第一次答复未作修改`; `amendment-grounding` read 58. The `draft` guidance now names the A33 row as a first-round machine default and requires comparing the `claims` parameter with the original claim in the task text. Unchanged claims require `第一次答复未修改权利要求 1，本次亦不修改`, a reason consistent with the first response and the current opinion, and the unchanged claim text; changed claims require per-amendment before/after text and its original-disclosure basis plus the amended or restored full text. Conditional phrasing that covers both branches is forbidden. The re-recorded 2026-11-27 workflow baseline reads aggregate 89.35 and `amendment-grounding` 88 in the revision round.

## Alternatives considered

**Keep conclusion-direction scoring and exclude `novelty-creative`.** Rejected: the task admits two defensible conclusions, and dropping the case hides the distinction between argument quality and the chosen side.

**Require the first round to amend.** Rejected: the first office action raises only Article 22.3, so a reasoned non-amendment is a legitimate response. Having the second opinion invent an amendment made the evaluation incoherent.

**Lower the `amendment-grounding` floor to accept the old measurement.** Rejected: the floor would then read a case defect as model quality and let a real regression through.

**Fix `response-plan` instead of the `draft` guidance.** Rejected for this change: the plan cannot know whether the previous round amended the claims, and preserving claim numbering would only turn `权利要求1（从属）：删除` into `权利要求1（独立）：限缩` — still a machine default, not a finding. The guidance sees both the current `claims` parameter and the task text, so it owns the determination. Revisit the plan if a manifest path ever produces the revision round without a model-backed `draft` stage.

## Consequences

- `technical-teaching` and `amendment-grounding` use the unified node floor of 70; their special floors of 60 and 50 are gone.
- The gate rejects a baseline whose round-2 statement digest differs from the current scripted opinion, so the case edit and re-baseline land together.
- The checked-in baseline comes from two captures under the same profile: the three single-round cases from one capture and `oa-answer` re-captured after the statement edit. Its token totals cover all 96 accepted calls.
- `novelty-creative` no longer treats either defensible conclusion as a failure; a future change that reintroduces direction scoring must re-record the gold digest and the baseline.
- The `patent_oa_response_v1` workflow baseline is declared again in `gate.yaml`; its record carries `evaluationDigest` and the gate judges its final round at 89.35.
