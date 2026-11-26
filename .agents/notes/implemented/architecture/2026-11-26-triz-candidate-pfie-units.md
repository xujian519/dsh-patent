# Agent Note: TRIZ contradictions produce candidate PFIE units held outside the anchored table

Status: implemented

English | [中文](2026-11-26-triz-candidate-pfie-units.zh.md)

## Problem

`triz_contradiction_analysis` ended on the inventor side. It reported verified contradictions with the matrix cell's recommended principles and the model's solution directions, plus the parameter-completeness gaps, and the pipeline kept none of that as input to drafting. A direction worth claiming had to be retyped by the agent into the PFIE table, which is the one table the quote-anchor and groundedness checks read — and a solution direction has no disclosure anchor to verify.

The two kinds of content also disagree about evidence. A contradiction survives only when its `evidence` locates verbatim in the disclosure text, while a direction is a means hypothesis the model proposes for that contradiction. Treating them alike would either drop every direction or admit unanchored text into `pfe_triples`.

## Decision

`buildTrizCandidateUnits(contradictions)` in `packages/patent/patent-core/src/triz/candidates.ts` converts each non-blank solution direction of a contradiction whose matrix cell recommends at least one principle into one `TrizCandidateUnit`: `problem` reuses the verified statement, `insight` names the principles against the improving and worsening parameter names, `effect` states the parameter trade-off the unit resolves, `feature` is the direction text, `principles` and `contradictionEvidence` carry the cell's full recommendation and the verified quote, `id` runs `K1..Kn` across contradictions, and `status` is the single value `TRIZ_CANDIDATE_STATUS` (`pending-inventor-confirmation`).

A contradiction with directions but no principle contributes a `TrizCandidateSkip` (`contradictionId`, `matrixStatus`, `directionCount`) and no unit: a candidate's insight must rest on a named principle, otherwise the unit is the model's guess under a new name. Diagonal cells (physical contradictions) and empty cells (transcription gaps) carry no principles, so both land here.

The change stays on the tool surface. `triz_contradiction_analysis` adds `candidate_units` and `candidate_skips` to its canonical value and its output schema, and its rendered prose adds `## 候选 PFIE 单元（待发明人确认，未进四元组表）` after the contradiction section. No atom, workflow stage, budget, or model call is added, so the `patent_flexible_plan` atom inventory and the `patent_disclosure_v1` stage count are unchanged.

Candidates stay out of the anchored table. No handler reads `candidate_units`, and nothing writes them to `pfe_triples`; the value's `insight` and `feature` carry no anchor by construction. Promotion uses the path that already exists: the inventor confirms the direction, and the caller supplies it to `claim-strategy` as a confirmed feature, with the same list serving the disclosure-amendment checklist the [disclosure-understanding skill](../../../../packages/bundle/web-app/skills/patent/patent-disclosure-understanding/SKILL.md) requires.

## Alternatives considered

**Add a stage that writes candidates into `pfe_triples` behind a `synthetic` flag.** Rejected: it takes `patent_disclosure_v1` from 29 stages to 30, which moves `DEFAULT_WORKFLOW_STAGE_BUDGET` and needs an upgrade-guide entry, and every one of the five `pfe_triples` consumers would have to exclude flagged rows — the same objection the synthesized root record in the [parent-link note](2026-11-26-pfie-group-parent-link.md) answers.

**Leave candidates in prose only, and let the agent write the PFIE rows.** Rejected: the anchoring rule would then rest on prompt wording alone, and a copied row would carry no recorded status for a later reader to distinguish a suggestion from inventor-stated content.

**Carry candidates through `claim-strategy`'s `confirmed_features` input.** Rejected: that input means the inventor confirmed the feature, so passing unconfirmed suggestions through it inverts its meaning; it is where a candidate arrives after confirmation, not before.

**Emit the units only in the rendered text.** Rejected: model-visible content must be reconstructable from the logged value, so the rendered section derives from `candidate_units` exactly as the contradiction section derives from `contradictions`.

## Consequences

The tool description and output schema changed, so `docs/tool-catalog.md` is regenerated and `snapshots/session/patent-oa-response/tool-schemas.expected.json` re-recorded. `pnpm run test:snapshot` refreshes that file without a key (`DSH_SNAPSHOT=refresh`), because no model request is involved. No upgrade guide: the packages are pre-stable, every consumer is in this change, and Session format, `pfe_triples`, and stage counts are untouched.

Conversion is deterministic, so two runs over the same contradictions produce the same units; the remaining non-determinism stays where it already was — which directions the model proposes. `K` numbering depends on contradiction order, so a re-run that finds a different contradiction set renumbers candidates; the stable reference is `contradictionId` plus the direction text.

Confirmation itself stays outside the pipeline. Nothing here can prove an inventor agreed, so the tool result always reports `pending-inventor-confirmation`, and the record of a confirmation belongs to the case file and the amendment checklist as before.

## Testing

`packages/patent/patent-core/tests/triz/candidates.spec.ts` covers one unit per direction with all derived fields, continuous `K` numbering across contradictions, both negative controls (a physical cell and a gap cell with directions produce skips and no units, an empty-principle contradiction without directions produces neither), whitespace-direction filtering, the principle-name fallback to a bare number, and empty input.

`packages/patent/patent-tools/tests/triz-contradiction-analysis.spec.ts` covers the tool path end to end: the canonical `candidate_units` entry and the rendered section for a matrix-recommended contradiction, the skip line and empty `candidate_units` for a diagonal-cell contradiction, the zero-candidate wording for an empty product, and the defensive branch for null entries, a missing id, a non-numeric direction count, and an unknown matrix status.

`pnpm run typecheck`, the patent suites, `pnpm run doc-sync`, `pnpm run build`, and `pnpm run test:snapshot` pass after the change. The `ptc-script-imports` headless replay fails identically with and without this change on the same host and is excluded from that statement.
