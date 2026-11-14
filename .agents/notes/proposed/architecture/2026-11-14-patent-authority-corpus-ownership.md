# Agent Note: Patent Authority Corpus Ownership and 2026 Sequencing

Status: proposed

English | [中文](2026-11-14-patent-authority-corpus-ownership.zh.md)

Tracking issue: [#811](https://github.com/xujian519/dsh-patent/issues/811)

## Problem

[The 60-day plan](2026-11-13-patent-authority-60-day-plan.md) sets out to index the law itself: 82 articles of 《专利法》 (Patent Law), 149 articles of the Implementing Regulations, and every numbered heading of 《专利审查指南》 (Examination Guidelines). Three facts make the plan's phase 1 unexecutable as written.

**The corpus already has two owners and they disagree.** `@deepseek-ai/dsh-legal-law` ships 7,910 law documents from a manifest, including 《专利法》 at 82/82 articles with text, 《民事诉讼法》 at 306/306 with text, 《民法典》 at 1,260/1,260 with text, and 4 of the 7 patent judicial interpretations — with every article's `text` null for the interpretations it does carry. Its 《专利法实施细则》 file records `maxArticle: 149` while holding articles 1–100 and 110–149: articles 101–109 are missing. `@deepseek-ai/dsh-patent-law` ships the same 实施细则 law name at 45 articles with text. Two indexes answer the same citation differently depending on which preset the session loaded.

**The guideline denominator was not reproducible.** The plan counts 1,096 numbered headings. Counting the official PDF with the shipped extraction rules yields 1,335, of which 1,145 carry body text of their own and 190 are structural headings (a heading followed immediately by another heading). Part III alone contributed 0 headings until 2026-11-14, because the extraction script used one body-column threshold for the whole PDF and Part III's pages are set 20 points further left.

**The 2026 revision cannot be transcribed mechanically.** The current edition took effect on 2026-01-01 (局令第84号). The knowledge base holds the 2023 full text and the official change table, not a 2026 consolidated text. The change table's text layer emits deleted and inserted wording as one run of body text: for 《专利审查指南》第四部分第三章2.1 it prints 「以同样的相同或者实质相同的理由」, where the first word is struck through and the second inserted. A parser can locate every change point and record both columns, and cannot state the in-force wording. Fifty-seven change points are listed; the change table names 27 sections with an amended body, 5 renumberings, and 11 added sections.

## Proposal

**Ownership.** `patent-law` owns 《专利法》, 《专利法实施细则》 and 《专利审查指南》 and transcribes them fully. `legal-law` owns every other document, including 民法典, 民事诉讼法, the judicial interpretations and the departmental regulations. `patent-law` does not copy a `legal-law` document into its own index. A patent session that cites outside the three patent documents loads `legal-law` alongside `patent-law`; the two tools keep their own decision vocabulary because the two indexes are loaded from different assets.

**One correction to `legal-law` first.** Its 实施细则 file gains articles 101–109 or drops the law name, so the same law is never described two ways. Its interpretations keep `text: null` until somebody transcribes them; a null text is reported as unverified, which is the honest state.

**The 2026 revision enters the index in three separable records.**

- `guideline-changes-2026.yaml` records every change point: the 2023 path, the change kind, and the two column texts. It is review evidence, and it is what `staleSections` is derived from once the sections are indexed.
- `staleSections` names every indexed section whose text the 2026 revision amended, renumbered or replaced. The loader rejects a stale record that names an unindexed section, so this step follows the full transcription rather than preceding it.
- `versions` carries only sections whose 2026 wording a person reconstructed from the change table's marks. Today that is three sections. The field is not a place to paste the change table's right column.

**Coverage denominators come from the documents.** `guideline-extent.yaml` records 1,335 headings, 1,145 of them with body text, counted by the same script that transcribes. The statute denominators stay `maxArticle`, verified against the authoritative copies.

**Order.** Denominate and map first, transcribe second, mark stale third: coverage numbers a reviewer can recompute, change points a reviewer can check against the table, then the text, then the staleness that depends on the text being present.

## Alternatives considered

**Copy 民法典 and 民事诉讼法 into `patent-law`.** Rejected: the same text would ship twice, the two copies would drift, and the patents-only index would grow by roughly 550 KB of articles the domain cites a handful of times. `legal-law` already carries both with text.

**Transcribe the 2023 guideline and mark only the three known changed sections stale.** Rejected: the change table's 27 amended sections would then be reported as verified against 2023 wording, so a citation to a provision the 2026 revision rewrote would come back `valid`. Today's 70-section index exposes three sections to that error; a full transcription would expose twenty-seven.

**Derive the 2026 wording by deleting the struck-through runs.** Rejected: the text layer does not mark which run is the deletion. The three reconstructed sections were applied by hand and their wording differs from the table's raw right column at the first changed phrase.

**Split the guideline index by part before teaching the loader to merge same-law files.** Rejected as a prerequisite: 1.2 MB in one file is reviewable, and the merge is a separate change with its own duplicate-path risk. Splitting stays a follow-up if the single file becomes unreadable.

## Acceptance criteria

- Every coverage number is recomputed by `scripts/patent-authority-metrics.ts` from `guideline-extent.yaml` and `maxArticle`, with no figure taken from planning prose.
- Every 2026 change point, renumbering and addition is recorded in `guideline-changes-2026.yaml`, and each recorded path resolves to a heading in the 2023 PDF or is marked added.
- `patent-law` and `legal-law` agree on the article count of every law they both name.
- A citation to a section the 2026 revision amended reports `unverified` with a reason naming the revision, rather than `valid`.

## Risks

- The 2026 change table's 第五部分第二章 numbering could not be read unambiguously: the table prints the old and new numbers on one line with a shared prefix, and the section that follows `4.2.1.2` is printed as `4.2.1.32`. The two sections are recorded without a renumbering claim until someone checks the printed page.
- Full guideline transcription needs curated `topics` for roughly a thousand sections, and topic keywords are one of the two signals a proposition is matched by. Generated topics would make propositions match sections they do not belong to.
- `mismatch` blocks delivery, and the 0.75 support threshold was measured on 45 transcribed 实施细则 articles. Whether it holds for 1,145 guideline sections is unmeasured.
