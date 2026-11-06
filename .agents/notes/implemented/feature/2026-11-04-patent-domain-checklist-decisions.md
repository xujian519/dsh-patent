# Agent Note: Patent domain checklists state what an engine decides and what stays manual

Status: implemented

English | [中文](2026-11-04-patent-domain-checklist-decisions.zh.md)

## Problem

Two checklists carry the last review before a patent application leaves the drafting flow: 30 mechanical drafting defects and 28 software/AI defects. They live outside this repository at `~/.agents/skills/patent-legal/patent-drafting-{mechanical,software}/02-缺陷检查清单.md` (v1.0, 2026-07-19). Their Y/N column answers whether a defect can be written as a regular expression, which is not the question a delivery check asks: a defect no regex can express may still be decided by a structured parser, and a defect a regex matches may have no reliable machine criterion. `claim_lint` and `validate_specification` reported findings without checklist ids, so running both engines left every checklist item's state unstated, and the cheapest mapping — an item inherits "passed" from the absence of its rules' findings — reports a pass for items whose rule covers only part of the defect.

## Decision

`domain_check` in `packages/patent/patent-tools` runs one domain's checklist through `claim_lint` and `validate_specification` and reports every item in checklist order. An item is `pass` when its mapped rules ran and fired nothing, `hit` when one fired (the finding carries engine, rule id, severity, message, and legal basis), and `manual` otherwise. Inputs decide availability: `claims` gates the claim items, `abstract` the abstract item, `patent_type` the utility-model items, and `figure_analysis` counts only when at least one figure is usable — an empty array is what the figure atom writes when analysis was skipped, so it cannot read as "checked, nothing found".

### The three statuses

`manual` has two sources, and neither is a pass. An item with no engine rule is `manual` because its criterion is legal or factual: `MECH-DC-003` (a missing reference number) needs the component list before a mark can be judged missing. An item whose rule covers only part of the defect is `manual` even when the rule fired nothing, and `reason` names the covered part: `MECH-DC-002` compares only `名称（标号）` pairs, so a component called two ways without marks stays open. A missing input produces `manual` naming that field, so a caller who passed only `text` sees why 25 mechanical items stayed open; when a mapped rule fired from another input anyway, `reason` also names it, so the finding is not hidden behind the missing field.

### What each domain decides

Mechanical ships 15 items with engine rules and 15 without. Of the 15 with rules, 9 decide the item (`MECH-DC-001/004/009/010/014/020/021/022/025`) and 6 carry `partial` (`002/013/018/024/026/030`). Software ships 18 with rules and 10 without; 4 decide (`SOFT-DC-004/005/013/014`) and 14 carry `partial`. The classification follows the four classes recorded while mapping the source checklists: existing coverage, missing or partial coverage, a capability no check type expresses, and human judgement.

The software domain adds 7 rules in `packages/patent/patent-tools/src/tool/spec-software.ts`, all gated on `tech_domain: 'software'`: algorithm or program as the claimed subject (`software_algorithm_subject`) and a signal or bitstream carrier (`software_signal_medium`) report errors; a missing technical carrier (`software_no_technical_means`), business-rule vocabulary (`software_business_rule_feature`), undisclosed training data (`software_training_data_disclosure`), undisclosed model structure (`software_model_structure_disclosure`), and an undefined abbreviation (`software_abbreviation_undefined`) report warnings. Each rule is a risk signal, not an exclusion: whether a scheme falls under Patent Law Article 25.1.2 stays a legal judgement, which is why the four eligibility items carry `partial`.

### Domain scopes in rule_check

`rule_check` gains the domain scopes `patent-mechanical` and `patent-software`: the full assets plus that domain's pack under `packages/patent/patent-rule/assets/rules/domains/`. `MECH-INV-001` gains a premise (`等效`, `等同`, `实质相同`, `相同的作用`), so it no longer reports on text that never discusses equivalence — a replay over 66 documents had produced 53 hits, nearly all on unrelated text. The software pack gains `SOFT-INV-001`, the three elements of an eligibility argument (technical problem, technical means, technical effect), with its own premise.

## Alternatives considered

**Write one YAML rule per checklist item.** Rejected: most items need document structure the rule engine does not have (component lists, an embodiment-to-feature map), and a rule that fires on vocabulary alone would report a pass as confidently as a defect.

**Report only error-level findings and call the rest passed.** Rejected: it turns "not checked" into "checked clean", the failure the checklist exists to prevent.

**Treat the source checklist's Y/N column as the automation list.** Rejected: that column asks whether a regex can express the defect. Fourteen of the 30 mechanical items are marked Y, yet several of them have no reliable machine criterion, and several marked N are decidable by the structured parsers already shipped.

**Ship the chemical checklist and the added-matter check in the same change.** Rejected: the issue scopes them out, and neither has an engine behind it.

## Consequences

- An item reports `pass` only when a named rule actually ran, so editing a rule's vocabulary changes which items pass; rule edits must update the checklist tests in the same change.
- The new tool changed the model-visible tool set: the patent scenario tool-schema pin gained `domain_check`, and the patent preset declares 37 model-facing tools instead of 36.
- `manual` items still need the human review the source checklist describes; the tool narrows what must be re-read, not what must be judged.
- `domain_check` derives `tech_domain` from `domain`, so `domain=software` runs the eligibility and disclosure rules without a separate argument. A caller that wants those rules through `validate_specification` alone must declare `tech_domain: 'software'` itself.

## Testing

`packages/patent/patent-tools/tests/domain-check.spec.ts` pins both domains' status counts, the missing-input reasons including `patent_type`, the skipped-analysis empty array, an analysis marked usable without a component list, the section for findings outside the checklist, and the rendered summary. `spec-software.spec.ts` covers each software rule and the false-positive guards (a sentence training people, generic words instead of model structure, an English-only parenthesized expansion). `claim-lint.spec.ts` and `spec-description-extras.spec.ts` pin the dependent-claim exclusion for the step-order and utility-model subject rules. The tool-schema snapshot is `snapshots/session/patent-oa-response/tool-schemas.expected.json`.
