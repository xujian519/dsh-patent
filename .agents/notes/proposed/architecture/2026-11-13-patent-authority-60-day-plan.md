# Agent Note: Patent Domain Authority Spine 60-Day Plan

Status: proposed

English | [中文](2026-11-13-patent-authority-60-day-plan.zh.md)

Tracking issue: [#809](https://github.com/xujian519/dsh-patent/issues/809)

## Problem

The patent domain decides citations against an index that covers the statutes the domain happened to cite, not the statutes themselves. Measured on 2026-11-13 against the authoritative copies under `/Users/xujian/projects/宝宸知识库_Raw`:

| Source | Authoritative extent | Shipped index | Coverage |
| --- | --- | --- | --- |
| 《专利法》 (2020 amendment) | 82 articles | 38 articles | 46% |
| 《专利法实施细则》 (2023 revision) | 149 articles | 45 articles | 30% |
| 《专利审查指南》 | 1,096 numbered headings in the official PDF | 85 top-level entries, 70 carrying text | about 6% |
| Patent-related judicial interpretations | 7 documents | 0 | 0% |
| Departmental regulations | 9 documents | 0; `legal-law` carries 《专利代理条例》 with every `text` null | 0% |

Five consequences follow, each observed in the current tree rather than inferred:

- **Revision claims.** The current edition of 《专利审查指南》 is the 2023 revision. The shipped guideline index nevertheless names a 2026 revision, marks three sections stale, and overrides three sections with 2026 text; `current-law.yaml` repeats that claim in its header. An index that describes its own authority base as a revision that does not exist cannot state which text is in force.
- **Scope.** `law_verify` parses 《专利法》, 《专利法实施细则》 and 《专利审查指南》 only. The rule assets carry more than ten citations of judicial interpretations; none of them can be verified, and the same holds for 《民事诉讼法》 and 《民法典》 citations.
- **Demonstrated errors.** `packages/patent/patent-rule/assets/rules/patent/evidence-rules.yaml` cites 《民事诉讼法》 articles 63, 64, 65 and 72–75. Those are the 2017 numbering; the current 2023 revision places the same provisions at articles 66, 67, 68 and 75–78. The file also cites 《专利法》 article 66, which the index does not cover.
- **Anchor gap.** The deadline engine and the fee index hold statutory facts in code and asset comments with no entry in the law index, so nothing verifies them. The thirteen document templates and eight workflow manifests likewise have no recorded inventory of the provisions they implement.
- **Evidence gap.** The domain proves invariants with unit tests but has no evaluation set that measures citation accuracy against the authoritative text.

The index was deliberately built from demand: an entry exists because something cited it. That choice kept the asset small and honest about its gaps, but it makes "authoritative" a property of the citing code rather than of the law. A patent agent that must be authoritative needs the law as the fixed side and the code as the derived side.

## Proposal

### Target definition

Four observable properties define the target state:

- **A1 Traceability.** Every statutory assertion resolves to a document plus an article, paragraph or item, or to a guideline section path.
- **A2 Currency.** Verification defaults to the revision in force, can name a historical revision explicitly, and reports a section as stale rather than verified when its text predates an amendment.
- **A3 Rank.** Two authority orders are data, not prose: prosecution follows 《专利法》 then 《专利法实施细则》 then 《专利审查指南》; infringement litigation follows 《专利法》 then the judicial interpretations, with the guideline as reference only.
- **A4 Refusal.** An assertion without a resolvable source is withdrawn, and an evaluation set demonstrates that this happens.

### Phase 0 — Baseline, D1–D5 (2026-11-14 to 2026-11-18)

- Record the eight core sources with path, revision, effective date and SHA-256, so the review basis is fixed and reproducible.
- Turn the coverage measurement into `scripts/patent-authority-metrics.ts`, emitting a JSON and Markdown matrix.
- Produce an audit report that gives every gap and error a file-and-line location plus the authoritative text it contradicts.
- Draft the authority ranks of A3 as a data file covering the six case types.

Exit: every number in the report is reproducible from the script, every error opens at a concrete line, and the recorded hashes match the files.

### Phase 1 — Authority corpus, D6–D20 (2026-11-19 to 2026-12-03)

[Corpus ownership and 2026 sequencing](2026-11-14-patent-authority-corpus-ownership.md) supersedes two facts below: the official PDF has 1,335 numbered headings, not 1,096, and the 2026 revision is in force, so its changed sections are marked stale rather than removed. The order also changes — change points and denominators land before the transcription, and the stale marking follows it.

D6–D8 are done: all 82 articles of 《专利法》 are transcribed in `assets/law/cn-patent-law.yaml`, at 100% coverage. D9–D12 are done too: all 149 articles of 《专利法实施细则》 are transcribed in `assets/law/cn-implementing-regulations.yaml`, at 100% coverage. D13–D16 are done as well: all 1,335 numbered headings of the official PDF are indexed, 1,145 of them carrying their own section text, and `tools/guideline-transcript.py --check` reproduces every transcription. D17–D18 are partly done: the 5 renumberings and the 11 added sections are carried under their 2026 numbers, and all 27 amended sections plus the 5 old numbering paths are marked stale, so none of them passes as current text; three amended sections have restored 2026 text and 24 still await it.

- D6–D8: transcribe all 82 articles of 《专利法》 with paragraph-level splits, source document and verification date.
- D9–D12: transcribe all 149 articles of 《专利法实施细则》。
- D13–D16: enumerate every numbered heading in the official PDF, then transcribe the sections with the existing `tools/guideline-transcript.py`. That script extracts only paths the index already lists and refuses an entry without curated `topics`, so enumeration and topic assignment are part of this step. The loader rejects two files of the same law (`baseline.ts`), so splitting the index by part requires merging same-law files in the loader first.
- D17–D18: reconcile the revision base. Set the guideline index's base revision to the 2023 revision, remove the 2026 overrides and stale markings, and correct `current-law.yaml`, the asset header and the package README. A new upgrade-guide item records the behavior change, because the shipped override is described in a released guide. Verify the 2023 text of each section whose override is removed against the source PDF.
- D19–D20: index the seven judicial interpretations and nine regulations, plus the 《民事诉讼法》 and 《民法典》 provisions the domain cites, as new document kinds in the existing entry schema.

Exit: 《专利法》 and 《专利法实施细则》 at 100%, every cited guideline section indexed with text, `law_verify` reporting neither `not-indexed` nor `unverified` for a provision in force, and a `--check` mode that reproduces the transcription.

### Phase 2 — Verification loop, D21–D32 (2026-12-04 to 2026-12-15)

- Extend paragraph and item location, and parse cross-law references through the same reference parser.
- Replace the free-text `legalBasis` of all 146 rule entries with structured references carrying law, article, paragraph and proposition, and run each through `law_verify`.
- Correct the demonstrated errors, starting with the four 《民事诉讼法》 citations and the 《专利法》 article 66 citation.
- Wire the index into `rule_check`: the citation ceiling in the rule assets stops deciding on its own, and the delivery gate requires that every citation of a deliverable has passed `law_verify`.

Exit: every rule entry carries structured references, `not-indexed` is zero apart from registered exemptions, and each verification decision has a regression case.

### Phase 3 — Rules and procedure, D33–D46 (2026-12-16 to 2026-12-29)

Align each rule family and procedural engine with its provisions: drafting to articles 26.3, 26.4 and 33; subject matter to articles 2 and 25; novelty and inventiveness to article 22; unity and division to article 31 and rule 48; reexamination and invalidation to rules 41 and 65; designs to article 23; term compensation to article 42; delivery and periods to rules 4, 5, 6 and 7; fees to rule 110.

The thirteen document templates and eight workflow manifests receive an inventory that names the provisions each implements, and the format assertions are tied to that inventory.

Exit: every rule family shows a provision, a rule and a test; every procedural computation has a line-by-line comparison table against its provision.

### Phase 4 — Evaluation, D47–D55 (2026-12-30 to 2027-01-07)

Build thirty golden tasks, five per case type, each carrying the provisions it must cite and the wrong formulations it must not produce. Measure citation accuracy, proposition support, currency, refusal rate and rank-conflict resolution, and compare against the Phase 0 baseline.

Exit: citation accuracy at or above 98%, zero wrong formulations, and a reproducible report.

### Phase 5 — Governance, D56–D60 (2027-01-08 to 2027-01-12)

Write the amendment runbook that carries a statutory change through lineage, index, rules, templates and evaluation. Update the patent subsystem page, the `patent-law` README and the upgrade guide, and move this note to `implemented`.

### Gates and metrics

Three gates are added: `verify-patent-law-coverage` asserts the full-corpus invariants, `verify-patent-law-freshness` asserts revision currency and stale marking, and `verify-patent-rule-citations` asserts that every rule reference resolves and verifies. The two existing citation-coverage tests and the delivery gate stay.

| Metric | Baseline | D60 target |
| --- | --- | --- |
| 《专利法》 article coverage | 46% | 100% |
| 《专利法实施细则》 article coverage | 30% | 100% |
| Guideline section coverage | about 6% | 100% |
| Revision claims consistent with the current edition | 3 stale or overridden sections | 0 |
| Judicial interpretations and regulations indexed | 0 | 7 and 9 |
| Rule references verifiable | about 1% | 100% |
| Known citation errors | 5 located | 0 |
| Golden evaluation tasks | 0 | 30 |

### Rhythm

One primary task and one verification task per day. Every Sunday runs the full gate set and records a metrics snapshot. One branch and one pull request per phase; no direct push to `master`.

## Alternatives considered

**Keep the demand-driven index and add entries as citations appear.** This is the current design and it costs nothing until a citation lands outside the index. It was rejected because the target property is authority over the law, which a demand-driven index cannot reach: the uncovered article is exactly the one nothing has cited yet, and an evaluation set built on citations already made cannot reveal it.

**Transcribe only the statutes and leave the guideline at section summaries.** This halves the work and keeps the asset small. It was rejected because the guideline is the operative text for prosecution, covering 1,096 numbered sections of the official PDF, and a summary cannot support either a proposition check or a stale-section report.

**Fetch statutes from the external cnlaw service at run time.** This removes local transcription entirely. It was rejected because the verification then depends on a service the preset already treats as optional, and the shipped decision vocabulary would have no local index to decide against; the external channels stay as the fallback for text the local index cannot resolve.

**Keep the shipped 2026 overrides and treat the local change table as an in-force amendment.** This preserves the three transcribed sections and the stale markings without any work. It was rejected because the current edition is the 2023 revision: the overrides would make `law_verify` decide against a text that is not in force, and the stale markings would report three current sections as unverified.

## Acceptance criteria

- 《专利法》 82 articles and 《专利法实施细则》 149 articles are indexed with text, source document and verification date, and a generated report reproduces the counts.
- Every guideline section the repository cites resolves to an indexed section carrying text, and the index names the 2023 revision as its base with no override or stale marking naming a revision that is not the current edition.
- Judicial interpretations and departmental regulations cited by the rule assets resolve to indexed text.
- Every rule entry carries structured references, and `rule_check` and the delivery gate decide against the index rather than a local ceiling.
- The known citation errors are corrected and each correction has a regression case.
- The golden evaluation set runs and reports citation accuracy at or above 98% with zero wrong formulations.

## Risks

- **Correcting the revision base reaches further than three sections.** The 2026 revision is named in the asset header, the package README, the code JSDoc, the test fixtures and a released upgrade guide, so the correction also updates tests and shipped documentation. Rules, templates and prompts that quoted the overridden text must be found and reverted, and each removal is verified against the source PDF first.
- **A full guideline transcription is the schedule's largest task.** Every entry needs a non-empty `topics` list, so 1,096 sections require curated topics as well as text, and the loader must merge same-law files before the index can split by part. The asset also grows substantially; marking generated regions keeps review diffs readable.
- **Tightening decisions can break existing gates and snapshots.** Coverage is added before decisions are tightened, and each phase lands as one reviewable change.
- **Transcription accuracy is unproven by construction.** Mechanical extraction is cross-checked by a second pass and a ten-percent human read-back; the verification dates state what was checked, not that a person read every line.
- **One person performs the work.** The schedule assumes two to four hours of review and sign-off per day, with agent sessions doing the bulk transcription; a slower week moves the end date rather than the scope.
