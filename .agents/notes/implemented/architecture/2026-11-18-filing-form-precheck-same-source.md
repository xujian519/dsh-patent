# Agent Note: The filing's form pre-check reads the draft that gets written

Status: implemented

English | [中文](2026-11-18-filing-form-precheck-same-source.zh.md)

## Problem

`build_patent_filing` writes the DOCX that goes to CNIPA. It validated the draft's structure (`validateSpecDraft`) and nothing else, so the form items the office rejects a filing over — figure marks in parentheses, `图 1` written with a space, an abstract outside the required length — reached the delivered file. The patent preset's delivery gate was given `validate_specification` as a prerequisite, but a delivery gate records that a tool returned a passing result in this session. It cannot record that the text the model validated is the text this call writes: the model can validate a copy, validate first and then rewrite the draft, or pass a different draft to each call.

## Decision

- `@deepseek-ai/dsh-patent-tools` registers a `tools.guard` that denies `build_patent_filing`. Before the call runs, the guard rebuilds the specification from `args.draft` through `contentFromDraft` — the same mapping the DOCX channel uses — and runs `validateSpecification` over that text, the claims, and the abstract. The text being checked is produced by the same mapping as the text being written, so heading lines, claim numbering, and figure numbering cannot diverge between the check and the deliverable.
- Only `error`-severity findings in `structure`, `figures`, `abstract`, `prohibitions`, and `title` deny the call. `description` and `claims` findings do not: embodiment presence, numeric-range endpoints, and feature coverage are substantive drafting judgments that a legitimate specification can fail, and turning them into a delivery blocker would reject filings the office would accept. Those findings stay in the full report the model gets from calling `validate_specification` itself. Warnings never deny.
- A draft that fails `validateSpecDraft` is not denied by the guard. The copy is returned as undefined and the call proceeds to the tool, which already reports every structural defect by field; denying it here would report the same defect twice in two formats.
- The denial lists each rule id, its message, the sentence it matched, and its fix, and states that the denied call wrote no DOCX. A line number would point into the text the guard rebuilds, which the model does not have. The guard runs again on the next call, so a corrected draft passes without any session state to reset.
- `validate_specification` stays in the preset's delivery-gate prerequisites, with evidence on `evaluated` rather than `passed`: the gate proves the session ran the report over real text, not that the report came back clean. `passed` is `errors === 0`, and the `description` and `claims` families judge substance, so requiring it would block a form-clean filing over drafting findings exactly like the guard must not. The guard enforces the form families; the gate guarantees the model has seen the complete report, including warnings and `not_assessed` items that the guard deliberately does not block on.
- The dependency edge is `patent-tools` → `patent-filing`. Reversing it would make the DOCX engine depend on this package's rule assets and, through its peers, on `llm`, `law`, `knowledge`, and `approval`; the form rules and `contentFromDraft` are the only things shared.

## Alternatives considered

- **Move the form rules into `patent-core`** so both packages could import them from a common leaf. The `validate_specification` implementation plus its rule tables are roughly 1200 lines; moving them would either duplicate them or make `patent-core`, the shared vocabulary package, own a specification checker. The extraction was priced and rejected in favour of reusing the existing export.
- **Put the check inside `patent-filing`'s `build_patent_filing`.** That reverses the dependency direction: `patent-filing` would import `patent-tools`'s `validateSpecification`, and through that package's peers pull in the LLM, law, knowledge, and approval packages to write a DOCX.
- **Rely on the preset's delivery gate alone.** The gate proves the session ran a check that reported evaluated text, not which text the filing call writes. This is the gap the note exists to close; the gate stays for the report it forces.
- **Deny on every `error` in the report, including `description` and `claims`.** The `embodiments` rule alone fails a specification that never writes the word "实施例" in a form the rule recognizes, which a legitimate disclosure can do; a delivery blocker on drafting-quality findings would deny filings that are formally correct.

## Consequences

- A filing that violates a form rule cannot be written, even by a model that never calls `validate_specification`. The guard and the preset gate now cover different things and neither is redundant.
- Form rules reach the delivery path through `validate_specification`'s own implementation, so a rule change affects both the reporting tool and the blocker in one place. `FORM_FAMILIES` is an explicit list: a new form rule added under a family outside it will report but not block, and adding that family to the list is a deliberate policy change.
- The package gains a peer and dev dependency on `@deepseek-ai/dsh-patent-filing` and a tsconfig reference; `docs/module-graph.md` and `pnpm-lock.yaml` are regenerated.
- The guard runs on every `build_patent_filing` call, so a specification is scanned twice when the model also runs `validate_specification`. The rule set is in-memory string matching with no I/O, so the second pass costs no I/O and no model tokens.

## Testing

- Unit (`packages/patent/patent-tools/tests/filing-form-audit.spec.ts`, 15 cases): the rebuilt text carries the five heading lines, `图1为…`, `1. ` claim numbering, and the abstract, and drops table rows while keeping the caption paragraph; a correct draft returns no violations; parenthesized figure marks and `图 1` spacing each deny; a paragraph that reads like a heading is not reported as one; the denial text names the rule, the match, the fix, and that no DOCX was written, with the match and fix lines omitted when the violation carries none. Six integration cases mount the real plugin, register a stand-in `build_patent_filing`, and assert denial before execution, a corrected draft reaching the tool, and that a missing, non-object, or structurally invalid `draft` is left to the tool's own argument validation instead of producing a second denial format; one disposes the plugin fiber and asserts the guard no longer denies.
- Preset (`packages/bundle/web-app/tests/patent-preset.spec.ts`): the `build_patent_filing` entry's prerequisite list and the `validate_specification` evidence (`evaluated`, at least one entry) are asserted exactly.
- Gates: `pnpm run typecheck`, `pnpm run lint`, `pnpm run test:docs`, `pnpm run hygiene`, `pnpm run build` (artifacts plus aggregate check), and `pnpm run verify-module-graph` all pass on this change.
