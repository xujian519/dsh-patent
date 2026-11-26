# Agent Note: TRIZ contradiction analysis on the inventor side

Status: implemented

English | [中文](2026-09-26-triz-contradiction-analysis-inventor-side.zh.md)

## Problem

The patent preset mounts `@deepseek-ai/dsh-methodology`, whose `triz` tool reads the 40 inventive principles and the 39x39 contradiction matrix — and nothing in the domain used it. `patent-core` held no reference to it, the persona carried no rule for it, and `patent-disclosure-understanding` produced PFE triples, feature numbering, and invention-point grading without ever asking what the disclosure trades away.

The disclosure side therefore had two gaps. It had no structured reading of the trade-offs an inventor made, which is the material for discussing alternative means or a design-around. And it had no list of the engineering parameters the disclosure names without quantifying: a real case's 交底书质量评估 read the technical problem as clear while every effect figure (response time, accuracy, yield gain) was an unverified report number with no test method, so what the inventor had to supply was exactly a parameter-by-parameter gap list that nothing produced.

## Decision

**The inventor side, never the three-step diff.** The `diff` node of `graph/domains/inventiveness.ts` produces `actual_technical_problem`, a statutory concept: it is determined from the distinguishing features relative to the closest prior art, and `checkAtomic` requires it to contain no solution means. A TRIZ contradiction is a design-level trade-off between two engineering parameters and reads as a means; written into that field it fails the `INVENTIVENESS-PROBLEM-*` checks and hands the examiner a routine-trade-off reading of the very argument it was meant to support. The third step's teaching sources are a closed statutory list — improvement motive, combining teaching, common knowledge, logical reasoning and limited experiment — and the 40 principles are not among them, so a principle number argues nothing in an office-action reply. The tool description, the persona's tool section, and the skill all state the boundary.

**Recognition is the model's; every checkable decision is code's.** `extractTrizContradictions` runs one model call under a prompt-level JSON schema and returns the raw result. `buildTrizAnalysis` then accepts only integer parameter numbers 1-39, resolves each pair against the matrix shipped in `methodology` (a diagonal cell is a physical contradiction, an empty off-diagonal cell a transcription gap), takes every parameter and principle name from the shipped assets instead of the model output, and drops any contradiction whose evidence does not locate verbatim in the disclosure text, counting the drops in `dropped_for_evidence`.

**Home.** The engine lives in `patent-core/src/triz/` as pure computation; the parameter table, principles, and matrix stay in `methodology`, which `patent-core` now depends on. The JSON-value narrowing guards that the engine and the tool both need moved into the shared `llm-json.ts`, because the tightened duplication pass flagged the two copies as a clone.

## Consequences

`triz_contradiction_analysis` is the 30th model-facing tool of `patent-tools`; the tool catalog, the preset README, both package READMEs, and the `patent-oa-response` tool-schema snapshot (the `patent-jobs` class's schema owner) move with it.

The output feeds solution exploration and the disclosure gap checklist, and stops there. It produces no problem dependency graph, no hallucination-rate metric, and no cross-document problem merge, and a contradiction pair never enters a delivered document's statutory reasoning. `buildTrizCandidateUnits` also converts each solution direction of a principle-backed contradiction into a `pending-inventor-confirmation` candidate PFIE unit in the tool result; that list is inventor-confirmation material and stays out of `pfe_triples` ([candidate units](2026-11-26-triz-candidate-pfie-units.md)).

331 of the matrix's 1521 cells carry no recommendation — 39 diagonal physical contradictions and 292 off-diagonal transcription gaps — so the tool reports those as gaps rather than inventing a principle, and `unmapped` carries what the model could not map to 1-39 instead of a forced number.

## Alternatives considered

**Feed the contradictions into the `diff` node.** This is the shortest path to "use the tool that is already mounted", and it is the reason this note exists. It loses on the statutory meaning of the field and on the rule that would reject it, as set out under Decision.

**Extend the `triz` tool inside `methodology` with a disclosure entry point.** The package already owns the data, so no new dependency would be needed. It loses because `methodology` is the general reasoning-methodology package (eight components, keyword matching, prompt injection) with no `PatentModelPort` vocabulary, and a disclosure reading is patent-domain work.

**Copy the matrix and parameter table into `patent-core`.** Self-contained, and no cross-package dependency direction to argue about. It loses because `methodology` already ships those assets (`files: ["assets"]`) and a second copy would fork one table into two maintenance paths.

**Accept the parameter numbers the model reports and trust them.** Simpler, and fine whenever the model is right. It loses on the evidence the repository already acts on: a model's self-reported confidence is not an input (`claim-coverage` states the rule for its own verdicts), and an out-of-range number or an invented piece of evidence has to be stopped by code rather than noticed by a reader.

**Ship it as a `patent_disclosure_v1` workflow stage.** It would put the capability on the deterministic pipeline. It is deferred rather than rejected: a stage needs a new atom, which moves the builtin handler count and its tests, and the one current consumer — the disclosure-understanding flow — is served by the tool and the skill.

## Testing

`packages/patent/patent-core/tests/triz/analysis.spec.ts` covers the matrix statuses, number validation, evidence drops, gap merging, and shape tolerance; `extract.spec.ts` covers the port outcomes and the parameter list in the prompt. `packages/patent/patent-tools/tests/triz-contradiction-analysis.spec.ts` executes the tool end to end over a fake port and the transport-level failures.
