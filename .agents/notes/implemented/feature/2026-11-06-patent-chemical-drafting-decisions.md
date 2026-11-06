# Agent Note: Chemistry drafting support lands as checks, a rule pack, and patterns

Status: implemented

English | [中文](2026-11-06-patent-chemical-drafting-decisions.zh.md)

## Problem

The chemistry drafting skill at `~/.agents/skills/patent-legal/patent-drafting-chemical` carries eight subdomains of writing guidance, a 33-item defect checklist, a statute map, and six case studies. The repository already wrote `tech_domain: 'chemical'` into the claim and specification tools, but only one deterministic rule read it (`chemical_characterization`, which fires when every characterization technique is absent), `domain_check` rejected `chemical`, the chemistry rule pack was a v1 placeholder without rules, and the writing-pattern corpus had a single Markush entry. The defect checklist was explicitly deferred when the mechanical and software checklists landed. Copying the skill directory would have shipped prose no tool reads, and duplicating its statute map would have created a second authority for citations the law index already owns.

## Decision

The skill's content is split by what can consume it. Deterministic defects become `spec-chemical.ts` and checklist rows; argument-completeness rules become a chemistry rule pack; writing guidance becomes pattern YAML. The source skill directory is not copied.

### The chemical checklist

`domain_check` accepts `chemical` and runs 33 items in source order (`CHEM-DC-001`…`033`). Five items decide from a rule run: `004` embodiment numbering, `005` abstract length and advertising language (needs `abstract`), `008` Markush optional substitution, `011` numeric-range endpoints, and `030` a medical-use method as the claim subject. Sixteen carry `partial`: the rule covers the named part only, so a clean run stays `manual` — for example `014` only sums percentages written as percentages without「余量」, and `024`/`025` only notice absent deposit information, not whether the material had to be deposited. Twelve have no engine rule and stay `manual`, including the genetic-resource disclosure sheet, CPCA registration, and added-matter review.

### Eleven chemistry rules

`spec-chemical.ts` gates every rule on `tech_domain: 'chemical'` because the same words change meaning in other domains (`高温` in metallurgy, `载体` in a catalyst). Subject rules run on independent claims: a treatment or diagnosis method subject reports an error under Article 25.1.3; a use claim that recites a therapeutic effect without the「在制备…药物中的用途」form reports a warning; relative degree words, undefined optional substitution, percentage totals above 100%, and drug claims without an indication report warnings. Disclosure rules read the specification and claims: a parameter value without a unit, broken or repeated embodiment numbers, Markush optional substitution without a substituent list, a herbal prescription without a Latin binomial, biological material without deposit information, and a synergy claim without a comparative example. Only the medical-use subject is an error; the rest are review signals.

### Chemistry rule pack and scope

`rule_check` gains `patent-chemical`. `CHEM-INV-001` requires the three parts of a Markush inventiveness argument (common-structure difference, substituent effect), with premises `马库什`/`通式`/`共同结构`. `CHEM-DIS-001` requires the four deposit elements (unit, date, number, taxonomic designation), with premises `保藏`/`CCTCC`/`CGMCC`/`ATCC`/`DSM` and a 0.9 threshold so 3/4 does not pass. Both rules declare premises because a vocabulary-only replay reports unrelated chemistry text.

### Six chemistry patterns

The corpus grows from 18 to 24: compound and polymer characterization, Markush scope, composition percentages, medical-use claim forms, traditional-medicine prescriptions, and biological deposits with sequence listings. Pattern `source_ref` values cite only indexed entries — Patent Law articles and「审查指南第二部分第十章」. The implementing-regulations baseline indexes selected articles, and Article 27 (deposit, 2023 revision) is not among them, so the pattern cites Article 26.3 plus the guideline; the deterministic message cites Article 27 directly.

## Alternatives considered

**Copy the skill directory into the repository.** Rejected: its routing prose and case studies have no consumer, and its statute map would duplicate the law index.

**Map all 33 items to rules.** Rejected: twelve items need form fields or legal judgement the engines do not have, and a vocabulary rule would report a confident pass they do not support.

**Treat「未命中」as pass for partial items.** Rejected: the same failure the mechanical and software notes guard against — partial coverage is not a clean check.

**Use the old Article 24 citation for deposits.** Rejected: Article 24 is now independent-claim format; the 2023 revision moved deposit to Article 27. Example fixtures follow the current numbering.

## Consequences

- `domain_check` now resolves `tech_domain` from `domain`, so `chemical` runs the chemistry claim and disclosure rules without a separate argument.
- The model-visible tool schemas changed (`domain_check` enum and descriptions, `validate_specification` description, `rule_check` scope description); the patent tool-schema pin was updated in place.
- `writing-patterns` reports 24 patterns and 11 `claim_drafting` patterns; its index is 2,467 characters and the full compile is 34,553 characters.
- Chemistry rules are warning-level except the medical-use subject. A warning-free run means the deterministic checks found nothing, not that the filing complies.

## Testing

`spec-chemical.spec.ts` covers every rule with a positive case and a false-positive guard (a unit present, a range, a Swiss-type use, a defined substituent list, a Latin binomial, a deposit marker, a comparative example). `domain-check.spec.ts` pins the 33-item list, the medical-use error, the percentage total, the Markush hit, and the abstract input gate. `rule-pack.spec.ts` pins both premises and the four-element deposit threshold; `engine-tools.spec.ts` pins the `patent-chemical` scope. The tool-schema pin is `snapshots/session/patent-oa-response/tool-schemas.expected.json`.
