---
description: "Function plugin checking law citations against the law index shipped with the package: article and guideline-section reference parsing, a per-law index recording each entry's source and verification date, decisions that never report an unverified article as checked, the law_verify tool, and the model-visible declaration of this deployment's cnlaw legal base."
kind: "package-reference"
---

# @deepseek-ai/dsh-patent-law

English | [中文](README.zh.md)

## Summary

Function plugin checking law citations against the law index shipped with the package: article and guideline-section reference parsing, a per-law index recording each entry's source and verification date, decisions that never report an unverified article as checked, the law_verify tool, and the model-visible declaration of this deployment's cnlaw legal base.

## Table of Contents

- [law_verify tool](#law-verify-tool)
- [Citation decisions and policy](#citation-decisions-and-policy)
- [Law index assets](#law-index-assets)
- [Library API](#library-api)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="law-verify-tool"></a>
## law_verify tool

law_verify reads the citations of a text, or the references passed directly, and decides each one against the index this deployment ships: 《专利法》 and 《专利法实施细则》 by article, 《专利审查指南》 by normalized section path. Each finding carries the decision, the policy the deployment applies to it, and the reason.

The tool exists because citation checking was previously split across four unrelated places — a static topic table in the workflow quality gate, an article ceiling in the rule assets, the `legalBasis` prose of 145 rule files, and a user-level baseline file that is not shipped — so a wrong article number could pass unnoticed. One index, one parser, one decision fixes the reference form; it does not decide whether the law is right, and it says so.

<a id="citation-decisions-and-policy"></a>
## Citation decisions and policy

| Decision | Meaning |
| --- | --- |
| 已核验 (`valid`) | Indexed, transcribed from a recorded source, and the proposition (when given) is carried by the entry: its topic keywords name the proposition, or its transcribed text carries it. |
| 与所引命题不符 (`mismatch`) | Indexed and transcribed, but the cited paragraph does not exist, or the entry does not carry the proposition while another entry of the same law does. |
| 未与条文对应（未判定）(`unmatched`) | Indexed and transcribed, and no entry of the law carries the proposition lexically. |
| 条号超出有效范围 (`out-of-range`) | Beyond the article ceiling **and** that ceiling has itself been verified. |
| 索引中不存在 (`not-indexed`) | Not in the index at all, or the law has no index in this deployment. |
| 条文未转录（未核验）(`unverified`) | Indexed, but its text, its recorded source, or its verification date is still missing; also what an article beyond an unverified ceiling reports, and what a guideline section reports when neither it nor any section under it is transcribed. |

A proposition is matched by two signals, both lexical. The entry's topic keywords are the first: a proposition that names a curated subject passes. The entry's transcribed text is the second: the share of the proposition's character pairs that the text carries, weighted so that pairs the law repeats across many entries count for less, must reach `propositionSupport`. A verbatim citation of an article therefore passes even when the topic list does not name it, which is the case the topics alone got wrong — 《专利法》第 47 条 is registered with the topic 视为自始不存在 while its text reads 「视为自始即不存在」. Neither signal passing means no entry carried the proposition, and `mismatch` is reserved for the case with positive evidence: another entry of the same law does carry it.

The guideline is indexed by section path, and a section contains its subsections, so a citation is decided against the whole section: a proposition a subsection carries supports the citation, and the reason names that subsection; conversely a subsection of the cited section is never reported as the proposition's competing home. An entry that names only a part or a chapter has no text of its own and is decided entirely by the sections under it — citing a chapter is citing all of its sections, so a verbatim quotation of any one of them passes; when no section under it is transcribed, the citation still reports `未核验`.

The five policies are per-decision Config fields (`onMismatch`, `onUnmatched`, `onOutOfRange`, `onNotIndexed`, `onUnverified`), each `block`, `warn`, or `allow`. The shipped default blocks a contradiction or a verified out-of-range number, and warns on a gap in the index and on a proposition nothing decides, so a partially transcribed index stays usable while every gap stays visible.

<a id="law-index-assets"></a>
## Law index assets

`assets/law/` holds one file per document (`cn-patent-law.yaml`, `cn-implementing-regulations.yaml`, `cn-examination-guidelines.yaml`). An entry records the article or section path, the topic keywords used to test a proposition, and where the text came from: `text`, `sourceDoc`, `verifiedOn`. An article ceiling carries its own `maxVerifiedOn`, because a ceiling nobody has verified must not produce an `out-of-range` verdict.

`assets/lineage/cn-patent-law-lineage.yaml` records the five revisions of 《专利法》 (1984 original through the 2020 amendment) and each indexed article's revision history and current status. The plugin loads it alongside the index and hands it to `rule-lock`, so article validity and effective dates come from the lineage record; articles the snapshot does not cover fall back to the index. The snapshot is maintained by hand, on a statute amendment rather than on a schedule: add the new `revisions` entry, update every article the amendment touches, bump `lineageVersion`, and re-record the sources and verification dates. The plugin fails its load when the file is missing or malformed, and the loader tests pin its schema. No refresh pipeline is scheduled — the statute changes on the order of years, so a scheduled fetcher would add monitoring, versioning, and review work without a corresponding accuracy gain; a refresh starts when the legislature amends the law.

The two statutes and the guideline sections are transcribed: each entry carries the text of the article or section it indexes, the document and revision that text was copied from, and the date of the copy. A guideline citation is decided against the cited section and its subsections; only a row whose indexed sections carry no text reports 未核验. A later revision's changed guideline sections are recorded under `versions` as overrides of the base `sections`; verification applies every override up to the latest transcribed revision unless the caller names a `revision`.

```yaml
- law: 专利法
  article: 22
  paragraphs: [1, 2, 3]
  topics: [新颖性, 创造性]
  text: <现行条文>
  sourceDoc: <官方文本标识>
  verifiedOn: 2026-01-01
```

The shipped statutes index all 82 articles of 《专利法》 and all 149 articles of 《专利法实施细则》. A citation this index cannot resolve — a law the deployment does not ship, or a guideline heading the official PDF does not carry — reports 索引中不存在: a gap in this index, not a claim that the number does not exist. The text is a verbatim copy of the official revised text, taken from the deployment's legal corpus and recorded per entry; it has not been read back by a qualified person, and the file header states that.

《专利审查指南》 is indexed as 1,348 rows: the official 2023 PDF's 1,335 numbered headings, plus 13 part or chapter rows that name a container and carry no text of their own (the sections under them carry it). 1,145 headings carry section text of their own; the other 190 exist only to hold subsections. The heading list is the PDF's own: a heading is a 黑体 line that starts with a number, a heading that wraps continues in the same font without a number, and the continuation is joined back to the title. The 1,263 headings added on 2026-11-14 take the heading title as their only topic keyword, mechanically and without per-section review; the 72 headings that predate them keep their curated keyword lists. `tools/guideline-transcript.py` derives the section text mechanically from the official 2023 revision PDF, by the rules its module docstring states: drop the running header, the footer and the statute numbers of the left margin column (法 26.3, 细则 70.2) by coordinate, find a section by its 黑体 heading and take its text up to the next heading of the same part and chapter so subsections keep their own paths and no text is recorded twice, split paragraphs on the first-line indent (x≥170; Part III's pages are set 20 points further left and use x≥150), and drop the lines the source PDF renders twice. `--write` rewrites the `text`/`sourceDoc`/`verifiedOn` fields by those rules and `--check` replays them against the PDF; the PDF is not shipped here, so an absent source is reported as 未核验 rather than passed silently, and the index is the only record of the transcription. The extraction was also compared section by section against two independent local Markdown conversions: 113 of 126 four-gram containment checks came out at 1.000, and every remaining difference was traced to the conversion side (a split chemistry subscript, a dropped lone digit, a margin statute number inside a sentence). The loader enforces the transcription record as all-or-nothing: an entry whose `text` is recorded without `sourceDoc` and `verifiedOn`, or whose source is recorded without `text`, fails the plugin load. `--write-extent` records the PDF's countable extent — 1,335 numbered headings, 1,145 of them carrying body text of their own — in `assets/authority/guideline-extent.yaml`, which is the denominator the coverage report uses.

`versions` currently holds one revision, `2026 年修订版（2026-01-01 施行）`, with 43 sections: the 26 amended sections transcribed from the change table's right column, the eleven sections the revision adds, and the six sections whose numbers moved, carried under their new numbers with their unchanged text; two of the added rows are chapter containers with no text of their own. The 2026 revision deletes 4.2.1.2 「专利局主动退款的情形」 whole — its situations move into 4.2.1.1 items (5) to (7) — and renumbers 4.2.1.3 「不予退款的情形」 to 4.2.1.2 with unchanged text. `staleSections` holds the six paths whose 2023 numbering no longer applies (the five old renumbering paths and the old 4.2.1.3), so verification reports them as superseded instead of accepting the 2023 wording. `verifyCitation` uses the latest transcribed override when no revision is named and the current revision is among the transcribed ones; when `supersededBy` names a revision the index has not transcribed, the base text and its stale marks decide. Naming the 2023 revision uses the base text; naming a revision the index does not carry reports 未核验 rather than falling back.

`assets/authority/authority-baseline.yaml` records the eight core sources a review is measured against: the corpus-relative path, revision, effective date, and SHA-256 of every carrier. `authority-ranks.yaml` records the authority order of the six case types as data. `guideline-changes-2026.yaml` records every change point of the 2026 revision — amended, deleted, renumbered, and added sections — with both column texts of the official change table; `tools/guideline-changes.py` filters the table's marks out of the right column (a red span is an insertion and stays, a blue or struck span is a deletion and goes), so the recorded text is the section as the 2026 revision reads it. `guideline-extent.yaml` records the PDF's heading count. None of these files is loaded at runtime; `law_verify` decides against `assets/law/` alone, and `scripts/patent-authority-metrics.ts` reads them. A deployment without the external corpus reports the carriers as unavailable instead of passing the hash check.

<a id="library-api"></a>
## Library API

- `parseLawReference(text)` / `extractLawReferences(text)` / `formatLawReference(reference)` — the reference forms: `专利法第22条第3款`, `《专利法》第二十二条第三款`, `A22.3`, `细则第112条`, `审查指南第二部分第四章3.2.1.1`. Spaces between Chinese text and digits, full-width digits, surrounding quotation marks, and a coordinated continuation (`专利法第22条、第23条`, `第22条第2款、第3款`) are normalized; a continuation's `raw` is the token alone (`第23条`) because the inherited law is not written there.
- `scanUnrecognizedCitations(text, references)` — the citation-like fragments the parser did not resolve, so a partial extraction is visible instead of reading as a complete check.
- `parseCnNumber(text)` / `formatCnNumber(value)` — Chinese numerals (`一百一十二` ↔ `112`). The parser accepts `〇` and `千` and returns null for a malformed numeral instead of reading a different number.
- `loadLawBaselines(dir?)` / `parseLawBaseline(source, origin)` / `findArticle` / `findSection` — the index, validated fail-loud.
- `verifyCitation(reference, baselines, options)` / `verifyCitations(text, baselines, options)` — decisions.
- `queryValidity(query, baselines, lineage?)` / `decideValidity(reference, baselines, query, lineage?)` — the four-state validity decision; a lineage record overrides the baseline's transcription-based state.
- `loadLawLineageFile(path)` / `parseLawLineage(source, origin)` / `queryArticleLineage` / `queryArticleAtDate` / `queryDiffBetween` / `queryStatusSnapshot` — the shipped lineage snapshot and its point-in-time queries.
- `ruleLockAtom` / `RuleLockHandler` / `lockProvisions` — the `rule-lock` gate. With lineage loaded, `effectiveDate` is the latest revision's effective date; without it, the entry's `verifiedOn` transcription date is the fallback.
- `createOverlapIndex(entries)` / `textOverlap(index, proposition, text)` / `topicOverlap(topics, proposition)` / `PROPOSITION_SUPPORT_DEFAULT` — the two proposition signals.
- `resolveCitationPolicy(finding, policies)` / `renderCitationFindings` / `renderCitationRows` — policy and rendering.

No service is published: the index is a read-only asset and the tool is the in-process consumer. A second consumer imports the library, the way `dsh-patent-core` is consumed as a pure library, rather than resolving a service for a value that never changes at runtime.

<a id="configuration"></a>
## Configuration

Schemastery configuration; `baselineDir` is optional, every policy field defaults.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| baselineDir | string | packaged assets | Directory holding the law-index YAML files. A missing, empty, malformed, or incomplete directory (one of the three documents absent) fails the plugin load. |
| lineageDir | string | packaged assets | Directory holding `cn-patent-law-lineage.yaml`. The snapshot loads at plugin load; a missing or malformed file fails the plugin load rather than degrading rule-lock to baseline-only validity. |
| cnlawEnabled | boolean | `true` | Whether this deployment runs the local cnlaw legal base. `false` declares no base, so the section names the fallback channels instead of an endpoint. |
| cnlawSearchUrl | string | `http://127.0.0.1:8100` | Semantic-search endpoint of the cnlaw base, declared to the model. |
| cnlawGraphUrl | string | `http://127.0.0.1:8001` | Graph/case endpoint of the cnlaw base, declared to the model. |
| onMismatch | `block` \| `warn` \| `allow` | `block` | Treatment of a citation whose proposition a verified entry does not carry while another entry does, or whose cited paragraph does not exist. |
| onUnmatched | `block` \| `warn` \| `allow` | `warn` | Treatment of a citation whose proposition no entry of the law carries. |
| onOutOfRange | `block` \| `warn` \| `allow` | `block` | Treatment of a citation beyond a verified article ceiling. |
| onNotIndexed | `block` \| `warn` \| `allow` | `warn` | Treatment of a citation the index does not hold. |
| onUnverified | `block` \| `warn` \| `allow` | `warn` | Treatment of an indexed entry awaiting transcription. |
| propositionSupport | number | `0.75` | Share of a proposition's weighted character pairs an entry's text must carry before it supports the proposition. |

<a id="model-experience"></a>
## Model Experience

### law_verify tool

#### What the model sees

One registered tool named `law_verify` with optional `text` (whose citations are extracted), optional `references` (exact references), and optional `proposition` (what the citations support); at least one of `text` or `references` is required, and a `text` that is empty or whitespace-only without references is an input error rather than a successful check with no findings. The result is the canonical finding list — raw reference, law, article, paragraph, item, section path, decision, policy, reason — plus a `blocked` flag, decision counts, and the `unrecognized` fragments that were not checked, rendered as a Markdown table followed by the notes a gap, an undecided citation, or a block implies. A citation that continues a preceding one with a coordinator inherits the preceding law and article; a fragment the parser cannot resolve is listed in `unrecognized` rather than silently skipped. The tool description states the six decisions, that an unverified article is never reported as checked, and that a reference which is not exactly one reference is an input error.

#### Token effect

Fixed definition cost on every request while the tool is enabled; each result is one short table plus notes, resent only until compaction.

#### KV Cache effect

Append-only; newly visible result prose follows the reusable request prefix and does not invalidate existing KV-cache entries.

### cnlaw declaration section

#### What the model sees

One static section named `patent-law:cnlaw`, ordered with the other patent-domain sections, stating either the declared endpoints — `cnlawSearchUrl` for `/search`, `/search/decisions`, and `/search/judgments`; `cnlawGraphUrl` for the graph, case, and IPC routes — with the `mcp__cnlaw__*` tools named as the channel that supersedes them where a deployment mounts the bridge, or, with `cnlawEnabled=false`, that this deployment has no base and which channels to verify through instead. The persona and the patent skills address the base as this declaration, so no shipped text names a port. It also declares the guideline channel, because the index holds statutes and decisions only and an endpoint that returns no guideline hit says nothing about whether a cited section exists: the rule text comes from the deployment's external IP knowledge base — `law_search` with scope=guideline (the guideline chapters; scope=law for statute text), `patent_kg_query` (node_type=GuidelineRule) and `patent_wiki_search` for rule cards, `patent_case_search` for decisions applying a rule — and a section no retrieval returns stays 未核验 rather than being reconstructed from memory. The section is registered only where a prompt registry is mounted; the tool works without one.

#### Token effect

Fixed definition cost per request while the plugin is mounted and a prompt registry is present; the text carries no per-turn data.

#### KV Cache effect

Static: the text is computed from Config at plugin load, so it is stable by definition and enters the stable-prefix cache without invalidating existing entries.

## Known Limitations and Deferred Work

- **The transcribed text is a mechanical copy, not a review.** Each statute entry's `text` is a verbatim copy of the official revised text, so a `valid` verdict means the article exists, is transcribed, and carries the citation's proposition — it does not mean a qualified person read the copy back. Re-check the entries a deployment relies on before treating them as reviewed.
- **Most guideline text is the 2023 revision.** Every article and every numbered heading is indexed, and 1,145 headings carry section text. The 2026 revision amended 26 of those sections and deleted one: the 26 carry text transcribed from the change table's right column, and the deleted 4.2.1.2 no longer serves its old text. The 11 added sections and the 6 renumbered sections are carried under their 2026 numbers, and the five old numbering paths are marked stale. Topic keywords for the 1,263 headings added in the full transcription are the heading titles, not a reviewed vocabulary.
- **《专利法》's topics were renumbered to the 2020 revision.** The curated topics for 现有技术抗辩, 不视为侵权, and 合法来源 arrived as 2008-revision article numbers 62/69/70 and now sit at 67/75/77, where the 2020 text carries them; 62 carries the compulsory-licence royalty topics its 2020 text supports.
- **《专利法实施细则》's topics were checked against the transcribed text.** Transcribing the text showed nine of the entries indexed then carrying another article's topics — 第 42 条 held 分案申请, which is 第 48 条, and 第 114 条 held 印花税, which neither the current 细则 article 110 nor the official payment guide charges — so each list was rewritten from the article it indexes.
- **The guideline index's paths and topics were re-checked against the 2023 revision.** Paths arrived from this repository's own citations, and three of them did not name the section they claimed — 技术领域 sat at 2.2.1 where the 2023 revision numbers it 2.2.2, 第九章 wrote 「2.0」 for a revision that writes 「2」, and 第一部分第一章 2.3 is not a section at all — so each row was repointed at the section it names and five topic lists were rewritten from that section's own content. Transcribing the sections corrected one more: the service rules were registered as 「第五部分第二章2.3.1」, where 第五部分第二章 is 专利费用 and the rules sit at 第五部分第六章2.3.1 (the delivery basis `patent-deadline` reports was corrected with it). `guideline-citation-coverage.spec.ts` only holds paths to the index; whether a topic belongs to its section, only the section text can check. `assets/authority/guideline-changes-2026.yaml` records the 2026 revision's 27 amendments (one of them a whole-section deletion), 6 renumberings and 11 additions; the index carries them under `versions` and `staleSections` as the previous bullet states.
- **The invalidation chapter is indexed, and `paragraphs` counts the articles' own 款.** The index holds 第 69-76 条 (invalidity: the request, added grounds and supplemental evidence, the transfer of the request and its designated answer period) together with 第 39 条, 第 49 条, 第 110 条 and 第 113 条, which the shipped tools, the rule assets and the invalidation ground tables cite. A 款 numbers the article's own paragraphs only: the `（一）…` items a 款 lists are 项 inside it, so 第 20 条 has five 款 where its text runs to ten lines. `statute-citation-coverage.spec.ts` uses the same reference parser and scans source, rule, skill, and preset citations (not the transcribed index's own quotations) against the article numbers the index carries; whether that number carries the cited proposition stays the proposition check's question.
- **Proposition matching is lexical, and it is a filter, not a review.** Both signals compare characters: a topic keyword must appear in the proposition or vice versa, or the proposition's character pairs must occur in the transcribed text at or above `propositionSupport`. A proposition reworded around synonyms neither signal lists is reported as 未判定 and must be read by a person; a proposition that shares boilerplate with the law (「国务院专利行政部门」) can still pass against an article the citation did not mean, because the weighting lowers that pair's score without removing it. Topics and the transcribed text must be maintained together.
- **An item number is reported, not checked.** The index records paragraphs, not items; a citation to `第X项` is decided at its article and paragraph level, and the item is echoed in the result. A deployment that must reject a wrong item needs an item-level index or a separate check.
- **An unresolved fragment is a warning, not a block.** `unrecognized` lists citation-like fragments the parser could not resolve; they were not checked and do not set `blocked` by themselves. A caller that treats a non-empty finding table as a complete check must also inspect this list.
- **The compact `A22.3` form is accepted only at a token boundary**, and it is always read as 《专利法》: a deployment that needs the form for another statute would need its own reference reader.
- **A malformed numeral is rejected, not guessed.** `第十十条` and `第十二三条` produce no reference. The same rejection applies to a 款 or 项 the parser cannot read (`第十十款`, `第十十项`, `第（十十）项`, `A22.0`): the parser returns null instead of checking the bare article. In `text`, the fragments are listed in `unrecognized` and do not set `blocked`. In `references`, the tool returns an input error and does not list them there. A fragment is dropped from `unrecognized` only when its span lies inside a resolved citation. The parser accepts the forms the law writes and returns null otherwise, so a typo cannot be read as a different provision.
- **A missing paragraph list is not a failed check.** The 38 transcribed 《专利法》 articles that run to a single 款 omit `paragraphs`, so a citation that names a 款 of one of them is not narrowed. The shared decider does the same in both domains. The legal index records no paragraph lists, and its default policy blocks `unverified`, so a missing list stays a data gap rather than an `unverified` decision.
- **The guideline index is section-path keyed.** A citation written in a form the normalizer does not reproduce (for example a section nested deeper than the captured tail) lands in `not-indexed` rather than being guessed at.
- **`patent-rule` keeps its own citation ceiling.** The patent preset mounts this plugin, so the model runs law_verify first; `patent-rule`'s article ceiling still decides on its own, bounding 《专利法》 article numbers at 82 without holding a row per article. Both accept every number 1–82 now, so the remaining difference is the decision each makes: the rule checks the number alone, this index also checks the transcription and the cited proposition. Delegating the ceiling to this index remains follow-up work.
- **Baseline correctness is content-owned, not runtime-observed.** Baseline correctness is a property of the content, and no runtime observation can falsify it independently; the mechanically checkable parts (references parsing, article and section existence, the article ceiling) are checks the gate runs.
- **The declaration states what the deployment declares, not what is reachable.** Neither endpoint is probed at load, so a declared but stopped base is discovered when a call fails; the persona's fallback discipline covers that case. A deployment that moves the base without updating `cnlawSearchUrl` / `cnlawGraphUrl` keeps declaring the old endpoint.
- **The guideline channel is a declaration, not a check.** The section names the retrieval tools (the knowledge-base search and rule-card tools); the package neither calls them nor verifies that a given guideline section exists there, so a citation is only as settled as the retrieval the model actually runs. An empty retrieval is decisive only for that query.

### Dev Note

None.
