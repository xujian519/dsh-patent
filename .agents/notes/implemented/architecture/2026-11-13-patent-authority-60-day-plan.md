# Agent Note: Patent Domain Authority Spine 60-Day Plan

Status: implemented

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

Five consequences follow, each observed in the tree on that date rather than inferred:

- **Revision claims.** That measurement treated the 2023 text as the only edition in force and read the index's 2026 overrides as a revision that did not exist. 局令第84号, published on 2025-11-13, put the 2026 revision into force on 2026-01-01. The false premise is part of the problem the decision corrects.
- **Scope.** `law_verify` parses 《专利法》, 《专利法实施细则》 and 《专利审查指南》 only. The rule assets carry more than ten citations of judicial interpretations; none of them can be verified, and the same holds for 《民事诉讼法》 and 《民法典》 citations.
- **Demonstrated errors.** `packages/patent/patent-rule/assets/rules/patent/evidence-rules.yaml` cites 《民事诉讼法》 articles 63, 64, 65 and 72–75. Those are the 2017 numbering; the current 2023 revision places the same provisions at articles 66, 67, 68 and 75–78. The file also cites 《专利法》 article 66, which the index does not cover.
- **Anchor gap.** The deadline engine and the fee index hold statutory facts in code and asset comments with no entry in the law index, so nothing verifies them. The thirteen document templates and eight workflow manifests likewise have no recorded inventory of the provisions they implement.
- **Evidence gap.** The domain proves invariants with unit tests but has no evaluation set that measures citation accuracy against the authoritative text.

The index was deliberately built from demand: an entry exists because something cited it. That choice kept the asset small and honest about its gaps, but it makes "authoritative" a property of the citing code rather than of the law. A patent agent that must be authoritative needs the law as the fixed side and the code as the derived side.

## Decision

The shipped index is the fixed side. `packages/patent/patent-law/assets/law/` carries 《专利法》 82/82, 《专利法实施细则》 149/149, all 1,335 numbered headings of 《专利审查指南》, seven judicial interpretations, and eight departmental regulations. The Shandong local measure stays out. 《民法典》 and 《民事诉讼法》 stay in `legal-law`.

The guideline base text is the 2023 revision. `supersededBy` names `2026 年修订版（2026-01-01 施行）`. `versions` carries the sections transcribed from the official change table, including renumbered and added sections. `staleSections` holds the six old paths. A citation of a path the current transcription does not replace is `unverified`. The official PDF has 1,335 numbered headings, not the 1,096 count taken from the lossy knowledge-base markdown.

Rule entries carry `basisKind`. Statute and guideline citations verify against the index, and the exemption list is empty. `citationGate` refuses an unverified citation before `render_patent_document`. Implementing Regulations article 41 is withdrawal, so reexamination cites Patent Law article 41 and Implementing Regulations article 65, and invalidation cites article 69. Article 7 is a secrecy rule and produces no period.

`rule-procedure-alignment.yaml` binds each rule family, each procedural computation, the thirteen templates, and the eight manifests to a provision, a rule, and a test. `authority-eval-tasks.yaml` holds thirty tasks, five for each of the six case types. The scorer does not call a model. Citation accuracy on that set is 100%, and wrong formulations are zero.

An amendment follows the [runbook](../../../../docs/cookbook/patent-authority-amendment.md) through the change record, the index, the rules, the templates, and the evaluation. `scripts/verify-patent-law-coverage.ts` and `scripts/verify-patent-law-freshness.ts` hold the corpus and currency invariants. `reports/patent-authority-closeout.md` pairs each Phase 0 metric with the measurement.

## Alternatives considered

**Keep the demand-driven index and add entries as citations appear.** This costs nothing until a citation lands outside the index. It was rejected because the target property is authority over the law, which a demand-driven index cannot reach: the uncovered article is exactly the one nothing has cited yet, and an evaluation set built on citations already made cannot reveal it.

**Transcribe only the statutes and leave the guideline at section summaries.** This halves the work and keeps the asset small. It was rejected because the guideline is the operative text for prosecution, covering 1,335 numbered headings of the official PDF, and a summary cannot support either a proposition check or a stale-section report.

**Fetch statutes from the external cnlaw service at run time.** This removes local transcription entirely. It was rejected because the verification then depends on a service the preset already treats as optional, and the shipped decision vocabulary would have no local index to decide against; the external channels stay as the fallback for text the local index cannot resolve.

**Stop at the three 2026 section overrides and treat that as the whole amendment.** That was the tree on 2026-11-13. It was rejected because 局令第84号 amends more than those three sections and renumbers others. The index carries the change table's amended, added, and renumbered sections and marks the old paths stale. It does not claim the knowledge base holds a consolidated 2026 text.

## Consequences

Callers of `verifyCitation` decide against this index, including `unverified` for a stale guideline path the current transcription does not replace. The upgrade guide in v0.2.1-rc.1 that described only three 2026 sections is the record of that release. The current guide is [patent-authority-index](../../../../docs/upgrade-guide/v0.2.2-rc.2/patent-authority-index/guide.md).

The metrics script still lists rule bases that name no article, and this closeout does not rewrite that list. The deadline engine does not compute the fourteen-year total term for a new drug. The certified-copy fee has no transcribed amount. Topic keywords on the bulk guideline transcription remain the section titles.
