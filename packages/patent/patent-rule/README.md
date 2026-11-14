---
description: "Function plugin porting the Sati constitutional rule engine into the DeepSeek Harness: it ships the YAML rule packs as package assets, evaluates text deterministically, registers the EVI-011 evidence-compliance guards as monotonic denies, wires the RuleOutputGate onto tools/post-execute with review routed through ctx.approval, and denies a delivery tool call whose declared prerequisite gate runs have not succeeded earlier in the same session."
kind: "package-reference"
---

# @deepseek-ai/dsh-patent-rule

English | [中文](README.zh.md)

## Summary

Function plugin porting the Sati constitutional rule engine into the DeepSeek Harness: it ships the YAML rule packs as package assets, evaluates text deterministically, registers the EVI-011 evidence-compliance guards as monotonic denies, wires the RuleOutputGate onto tools/post-execute with review routed through ctx.approval, and denies a delivery tool call whose declared prerequisite gate runs have not succeeded earlier in the same session.

## Table of Contents

- [Output gate](#output-gate)
- [Delivery gate](#delivery-gate)
- [EVI-011 evidence guards](#evi-011-evidence-guards)
- [Rule engine (library API)](#rule-engine-library-api)
- [Rule assets](#rule-assets)
- [Applicability premises and quoted text](#applicability-premises-and-quoted-text)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Output gate

On the result of each delivery tool named in `gateToolNames` (`render_patent_document`, `draft_claims`, `draft_specification`, `validate_specification` by default), the plugin runs the rule subset selected by `gateCheckTypes` (`selectGateRules`; default `keyword_blocklist`, including the compliance keyword rules PAT-RISK-001 / PAT-APPROVAL-001 / PAT-ABS-001) through the `RuleOutputGate`. A block-level violation returns a block decision. A review-level violation fires `ctx.get('approval')` and accepts only on `allowed-once`, failing closed when there is no answerer, no agent, or `approvalDisabled` is set. A warn-level hit leaves the result text unchanged — the model has already received it — and rides the decision as `additionalContexts`, so the finding reaches the model at the next step and is recorded in the session log; it also stays in `ctx.logger.warn`. `log` hits stay in the log. Non-matching tools delegate via `next()`.

The check families split by semantics. `keyword_blocklist`, `pattern_analysis`, `citation_analysis`, `quote_repetition`, `empty_section`, and `sentence_repetition` are incident families — a hit is a violation, so they hold on any text and a deployment may widen `gateCheckTypes` to all of them. `structural_analysis` and `synonym_match` are absence families — a missing element is a violation, and a tool result's prose always misses most expected elements, so they never enter the result gate; naming one in `gateCheckTypes` is rejected with a load warning rather than installing a gate that mass-reports. Their execution point is the artifact structural gate below.

The loaded gate is also exposed as `ctx.get('patentRuleGate')` (Context merge, optional — present only while this plugin is mounted), so team consumers such as patent-teams can rule-gate task completion consistently with the post-execute path.

### Artifact structural gate

A deployment may declare `structuralGate` entries: each names a delivery tool, the arguments carrying that tool's artifact text, the absence-based rule ids to judge it by, and optional `whenArgs` for exact-match argument values. The plugin evaluates the artifact text before dispatch through `tools/pre-execute` and denies the call when a block-level rule fires, so a non-conforming artifact is never rendered or written; the denial names the rule, its statement, and its legal basis.

The declaration is per rule id rather than per domain because a domain's absence rules may not suit the artifact's form: `patent_claims` holds CON-301, whose patterns are review words (清楚 / 简要 / 限定 / 必要技术特征) that a plain claim draft never contains. An id that does not resolve, a rule that is not block-level, and an entry that cannot run at all (empty `textArgs`, no usable rule) are reported at load. An entry's `strict: true` raises them as a `StructuralGateConfigError` that fails the plugin load; without it they stay warnings and the entry is dropped. Shipped presets set `strict` so a renamed rule asset cannot disarm the gate silently, while an external deployment keeps the warn-and-drop default so one typo does not keep its whole profile from starting.

An entry is only correct for arguments that carry the artifact itself. `render_patent_document` takes template slot fragments in the controlled `draft`, and the shipped templates already contain the fixed wording (claim sentences, section headings), so a rule whose elements are template-generated fixed wording reports absences the rendered document does not have — that template is not a safe target for such a rule. The shipped `patent` preset enables one rule-specific entry: `PR-OA-007` judges draft-authored argument text (whether the 26.3 answer lands on the statutory standard), which the `draft` argument does carry.

## Delivery gate

A deployment may declare `deliveryGate` entries: each names a delivery tool and the tools that must have completed earlier in the same session without an error and without `blocked: true` before it may run, with optional `whenArgs` (a string matches exactly, a string array is a value set) narrowing the entry to matching calls. An unsatisfied entry denies the call through `ctx.tools.guard()`, a monotonic guard, so no listener ordering or permission rule can turn the denial back into a call. The denial names the missing prerequisite tools, and the model re-invokes them instead of losing the delivery to a silent gap.

An entry may also declare `evidence`: conditions on the prerequisite's canonical result, keyed by that prerequisite's tool name. Each condition names a top-level result field and either an accepted exact value (`equals`, with a string array accepting any member) or a minimum array length (`minItems`). A successful call that does not carry every declared condition stays missing, so a zero-byte `rule_check`, a `law_verify` run that recognized no citation, or another template's workflow closure cannot stand in for the run this delivery owes. The ledger retains only the declared fields, and `deliveryEvidence` extracts them from the result. An entry that declares evidence for a tool it does not require fails at load, because that condition could never be consulted.

The gate exists because a discipline stated only in a prompt is indistinguishable from no discipline in the call record: the run that happened and the run that did not leave the same trace when nothing checks. The ledger records calls that returned successfully, recorded from `tools/post-execute` where the outcome is known — a deny decided before dispatch cannot know whether the call it is about to allow will succeed. Recording and judging are therefore separate: the guard reads a ledger the post-execute listener fills.

The ledger is keyed by the calling agent and by the case id a call names (`caseId`, `case_id`, `case_dir`, or `caseDir`). A prerequisite that names a case satisfies only that case's delivery; a prerequisite that names none is session-scoped and is consulted only when the delivery's case has no case-scoped record of that tool. A call with no agent cannot be attributed to any session, so it is treated as unsatisfied: an unattributable deliverable has no session record to show either. The shipped default declares no entry — which gate runs a delivery owes is the deployment's delivery policy, not this package's.

`render_patent_document` and `build_patent_filing` are the production consumers: the `patent` preset requires `rule_check`, `law_verify`, and `matter_log_append` before any delivery render or submission-format filing, and additionally `patent_workflow_run` for every render template that reaches closure through a manifest — the analysis templates, plus `claims-spec`, whose `patent_disclosure_v1` run ends in a claims draft. The closure entries name the manifest each template requires and require `ok: true`, so a run of another manifest cannot satisfy them. Citation-bearing templates additionally require `law_verify` findings, while application documents and forms may legitimately cite no statute. Two shipped templates stay outside the closure entries: `rectification-response` has no manifest entry, and the delivery skills substitute a per-claim-line rectification record for the run; `right-evaluation-report` re-lays out a report the office already issued when it is used for transcription, so it has no analysis to close.

## EVI-011 evidence guards

`evaluate_evidence` calls are denied by two monotonic guards when an overseas or foreign-language evidence record omits its required notarization, legalization, or translation declaration. The guard condition fields derive from the packaged `evidence-rules.yaml`, falling back to a hardcoded set when the asset is missing. Each guard returns a denial reason string, so no allow result can override it. An `overseas` record can also carry `language`; a non-Chinese language triggers the translation guard alongside the notarization guard, so a foreign-language overseas exhibit cannot satisfy one requirement by declaring only the other.

## Rule engine (library API)

The package re-exports the ported rule engine: `evaluateText`, `evaluateRule`, `groupByAction`, `parseRuleSetFromYaml`, `loadRuleSetFromFile`, `loadRuleSetDir`, `mergeRuleSets`, `applyRuleOverrides`, `loadPatentComplianceRuleSet`, `loadPatentElectricalRuleSet`, `loadPatentFullRuleSet`, `loadActivationOverrides`, `selectGateRules`, `isGateCheckType`, `PATENT_CASE_DOMAINS`, `patentCaseDomains`, `loadRulePack`, `loadSynonymsAsset`, `RuleOutputGate`, the artifact gate's `resolveStructuralGate` / `structuralGateText` / `structuralGateViolations` / `renderStructuralGateDenial` / `StructuralGateConfigError`, and the delivery gate's `DeliveryAttemptLedger` / `deliveryEvidence` / `deliveryGateMissing` / `renderDeliveryGateDenial` / `resolveDeliveryGate` with the `DeliveryEvidenceRequirement` / `DeliveryGateEntry` types, plus the shared `jsonRecord` / `declaredArgsMatch`.

The package also owns the checker corpus (`defaultPatentRules()` and its per-family builders: 71 domain-scoped `CheckRule`s across novelty, inventiveness, infringement, disclosure, claims, spec, invalidity, reexamination, priority, public access, subject matter, and the 24 reasoning-pattern rules) and exposes it through `createCheckerRuleEvaluator()`, the `RuleEvaluator` implementation consumed by the patentability subgraphs' `rule_gate`. The evaluator declares the domains the corpus covers and counts the rules applicable to the requested domains, so the gate still fails closed on unknown domains and empty rule sets. The workflow tool receives it from the plugin wiring; a graph run with the rule gate enabled and no evaluator fails at graph build time.

## Rule assets

Three families live under `assets/rules/patent/`, distinguished by who owns them and how they load.

| Family | Files | Loaded as |
| --- | --- | --- |
| Hand-written compliance | `compliance.yaml`, `electrical-section-h.yaml` | One fixed file name each, by `loadPatentComplianceRuleSet` / `loadPatentElectricalRuleSet` |
| Generated upstream mirrors | `nuo-*.yaml` | By `loadPatentFullRuleSet`, through the explicit `NUO_RULE_FILES` list |
| Hand-merged current-law and gap rules | `current-law.yaml`, `mady-gap-rules.yaml`, `oa-response-form.yaml` | By `loadPatentFullRuleSet`, through the explicit `MERGED_RULE_FILES` list |

`current-law.yaml` bans superseded statute wording in output text: the two-year infringement limitation, the replaced judicial interpretation as the equivalence basis, and attributing utility-model subject matter to the second paragraph of Article 2. Its checks are `pattern_analysis`, so the default output gate does not take them (a deployment that names the family in `gateCheckTypes` does). `mady-gap-rules.yaml` holds upstream rules converted to the engine's check types — bans whose keywords are literal, and completeness checks whose element terms are literal — with every upstream `block` reviewed down to `warn` (`log` for the upstream `info` level). Two of its bans are `keyword_blocklist`, so the output gate picks them up alongside the mirror rules. `oa-response-form.yaml` holds the answer-form checks: count-based argument (`PR-OA-005`), duplicate quotation (`PR-OA-006`), the enablement standard an answer must argue (`PR-OA-007`, `block`), the two dual-input rules (`PR-OA-008/009`, `warn`), and two brevity rules — empty sections (`PR-OA-010`) and repeated conclusions (`PR-OA-011`), both `warn`. `PR-OA-007` is executed by the artifact structural gate before an `oa-response` render. `activation-overrides.yaml` applies to the merged result, so a review conclusion can target either family.

`activation-overrides.yaml` patches by rule id. `action` and `premise` replace their field; `addKeywords`, `negationContext`, and `additionalNegationWords` add to the existing check without restating it, so a review conclusion never creates a second copy of a generated rule. `premise-vocab` holds the shared vocabularies as YAML anchors — one home per subject. Patches that miss (unknown key, unknown id, empty or non-regex premise, negation words behind a closed switch) draw a load warning instead of silently not applying.

### Applicability premises and quoted text

`ConstitutionalRule.premise` is a rule-level regex OR-list: when no pattern matches the text, the rule is not evaluated and reports nothing. Completeness checks (`structural_analysis`, "missing element = violation") only mean something about text that touches their subject, so the reviewed assets give them subject-matter premises — a 26.3-only office-action answer draws no novelty, inventiveness, or claim-drafting findings. Two properties are deliberate: an unsatisfied premise is silence, not a downgrade (downgrading lowers severity and keeps the noise), and a premise names the subject, never the rule's own element terms — where a single-element expectation rule's pattern list is its own subject vocabulary, gating makes it permanent silence, which the patch reasons record per rule.

`keyword_blocklist` accepts `quoteImmune: true`: a match inside a paired quote (`「」`, `『』`, `“”`) is not the author's own statement, so an examiner sentence quoted with 「一定」 no longer reads as the model's absolute claim. Unclosed quotes exempt nothing — the failure direction is detection, not silence. `quote_repetition` (defaults `minLength` 12, `minOccurrences` 2) reports the same quoted span recurring, comparing spans after whitespace and ellipses are normalized: an answer that grows by restating a passage instead of arguing becomes visible. `empty_section` (default `minLevel` 2) reports a heading with no body under it — a parent section that holds only sub-headings is not empty, and `<style>`/`<script>` and code blocks do not count as body; `sentence_repetition` (defaults `minLength` 12, `minOccurrences` 3) reports the author's own sentence written three times, with stylesheets and table delimiter rows excluded from counting. The answer-form rules built on these checks live in `oa-response-form.yaml` and stay out of the default output gate, which takes only `keyword_blocklist`.

### Job scopes

`PATENT_CASE_DOMAINS` maps the job scopes — `patent-drafting` and `patent-analysis` for drafting/patentability work, plus `patent-oa-response`, `patent-invalidation`, `patent-invalidation-defense`, `patent-reexamination`, `patent-infringement` named after the job manifests and exposed through the `rule_check` tool — to the rule `domain` lists each one evaluates. A scope evaluates the common domains (`patent`, `patent_general`) plus its own document and procedure domains and the domains of the clauses it must answer or establish. The union of the scopes covers every domain in the merged set, so no asset domain lacks a job entry point. `patent-drafting` keeps claim/specification and substantive-law domains; `patent-analysis` keeps the analysis domains and drops claim-drafting form rules; the drafting/analysis split is what keeps a clean claim draft from being judged as an OA answer or an invalidation request. Office-action answers, reexamination requests, and invalidation defences share one domain set, because the reexamination reason table is the invalidation table plus the utility-model subject-matter defect and that defect lives in a common domain, and because all three deliverables answer the other side point by point under A33. Invalidation carries that set on the defense side only: the request side drops the answer-practice domain, whose rules answer a claim the other side made and therefore misfire on a request. Infringement carries its own domain plus the procedure domain, so litigation procedure and evidence rules (`JD-PRC-*`) are reachable; examination-procedure rules in the same domain are silenced by their premises. `evaluateText`'s `domain` option takes one domain or a list.

## Configuration

Schemastery configuration.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `rulesDir` | string | packaged assets | Rule-asset root override, mirroring the packaged `assets/rules/` layout. |
| `gateToolNames` | string[] | delivery tools | Tool names whose results run through the output gate. |
| `gateCheckTypes` | string[] | `keyword_blocklist` | Check families the result gate keeps; an absence-based family is rejected with a warning. |
| `structuralGate` | object[] | `[]` | Artifact gate entries (`tool`, `textArgs`, `ruleIds`, optional `whenArgs` and `strict`): a block-level hit on the artifact text denies the call before dispatch; `strict` fails the load instead of dropping an entry that cannot take effect. |
| `deliveryGate` | object[] | `[]` | Delivery gate entries (`tool`, `requires`, optional `whenArgs` and `evidence`): a call whose prerequisite tools have not completed earlier in the same session without an error and without `blocked: true`, or whose declared result evidence is missing or mismatched, is denied by a monotonic guard. |
| `approvalDisabled` | boolean | `false` | Block review-level violations without an approval round-trip. |

## Model Experience

None, as the plugin registers no tool schema or prompt section; its EVI-011 guards and post-execute gate deny or block existing tool calls, dsh-tools renders the denial and block feedback as ordinary error results, and a warn-level hit is model-visible as a `patent-rule-gate` user message admitted at the next step while `log` hits go to the logger only.

#### KV Cache effect

Independent; the plugin appends nothing to the request prefix, so enabling or disabling it never invalidates KV-cache reuse.

## Known Limitations and Deferred Work

- **Asset location differs from Sati** — rules resolve from the packaged `assets/rules/` via `import.meta.url` (with an optional `rulesDir` override); the `SATI_RULES_DIR` environment variable, cwd/workspace-root walking, and the project `.sati/rules.yaml` auto-discovery are dropped. `loadRulePack` accepts only an explicit `manifestPath`.
- **Layered pack default is base only** — `loadRulePack` without a manifest loads only the packaged base pack; domain and override layers require an explicit manifest.
- **The base compliance asset fails loud.** A missing or unreadable `compliance.yaml` raises `PatentRuleAssetError` at load; an empty rule set would let the gate pass through. A single missing or damaged follow-on pack file (`nuo-*.yaml`, `current-law.yaml`, `mady-gap-rules.yaml`, `oa-response-form.yaml`) still warns and is skipped, so one bad pack entry cannot take down the rest.
- **Merged assets cover machine-checkable rules only** — upstream rules whose payload is prose (analysis principles, statutory conditions, decision citations) are not converted into checks and stay outside this package; the conversion set, the check-type mapping, and the boundary are recorded in [the merge-boundary note](../../../.agents/notes/implemented/architecture/2026-09-21-mady-rule-asset-merge-boundary.md).
- **Rules are narrowed by domain, premise, and job scope, not by full document classification** — job scopes separate drafting/analysis from OA, invalidation, reexamination, and infringement work, and a rule's premise silences it on text that never touches its subject; within a scope nothing classifies individual sections, so a rule whose premise matches (an answer quoting the claim text, say) still reports its missing elements.
- **The shipped structural gate entry is template-specific** — the `patent` preset enables `PR-OA-007` on `render_patent_document` with `template=oa-response`, judging the draft-authored argument text. Other absence rules still need an argument that carries the document text in full; template-generated headings and claim wording remain unsafe targets for them.
- **The delivery ledger does not survive a resume** — it is held in the plugin mount and keyed by the live agent object, so a session resumed in a fresh process starts with no record and re-runs the prerequisites even when an earlier run satisfied them. The failure direction is a repeated gate run, not a missing one.
- **A prerequisite counts on a successful call unless it declares `blocked: true` or fails the entry's evidence** — the ledger records that a tool returned without error and without a `blocked: true` result. A `rule_check` whose result reports violations, or a `patent_workflow_run` paused at its review gate, still satisfies the gate unless the entry requires evidence that result does not carry; `law_verify`'s explicit `blocked: true` does not, because that result is the check's own refusal. An entry without `evidence` enforces that the run happened and did not refuse its own result; the delivery report carries the verdict for a human to read.
- **Rule citations are checked against the index** — each packaged rule declares `basisKind`. A `statute` or `guideline` basis is parsed with the same citation parsers `law_verify` uses and must resolve to a transcribed article, paragraph, item, or section; `judgment` and `practice-note` say why the rule has no article number. `citation_analysis` reads its article ceiling from the shipped index instead of a number written in the asset. `citationGate` on `render_patent_document` rejects a draft whose citations fail that check. Matching a proposition to the cited text still needs `law_verify` with the proposition.

### Dev Note

None.
