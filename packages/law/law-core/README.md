---
description: "Statute-citation machinery shared by the legal and patent domains: citation text normalization, reference extraction, proposition-overlap scoring, the per-article citation decision, and the citation-verify tool scaffolding."
kind: "package-reference"
---

# @deepseek-ai/dsh-law-core

English | [中文](README.zh.md)

## Summary

Statute-citation machinery shared by the legal and patent domains: citation text normalization, reference extraction, proposition-overlap scoring, the per-article citation decision, and the citation-verify tool scaffolding.

## Table of Contents

- [Why it exists](#why-it-exists)
- [Citation text](#citation-text)
- [Reference extraction](#reference-extraction)
- [Proposition overlap](#proposition-overlap)
- [Article decision](#article-decision)
- [Tool scaffolding](#tool-scaffolding)
- [Consumers](#consumers)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="why-it-exists"></a>
## Why it exists

A legal-domain citation of 《民法典》第 143 条 and a patent-domain citation of 《专利法》第 26 条 run through the same decision rule: look the article up, distinguish an article that exists from one that does not and a transcribed article from an unverified one, then test whether the entry carries the proposition. When that rule lived in the patent domain's core library, the legal domain inherited a dependency on patent naming and patent release mechanics, and every rule change risked drifting between the two domains. This package is the domain-neutral home: the rule lives here exactly once, and each domain keeps only its own reference grammar, indexes, tool names, and messages.

<a id="citation-text"></a>
## Citation text

`normalizeCitationText`, `stripBookMarks`, `trimPunctuation`, `compactCitation`, and `narrowed` normalize a cited string before parsing; `parseCnNumber` reads a Chinese numeral (`一百一十二` → `112`, accepting `〇` and `千`, returning null for a malformed numeral) and `formatCnNumber`/`formatCitationNumber`/`formatArticleCitation` render the canonical forms a finding prints; `articleReferenceIdentity` is the dedupe key one cited article carries per law. `narrowed` returns null when a named 款 or 项 is not a positive integer, so the caller rejects the citation instead of dropping the field.

<a id="reference-extraction"></a>
## Reference extraction

`readArticleContinuations` reads continuation lines (`第九十九条至一百零一条`) into per-article references; `collectReferences` runs a domain grammar over a text and returns the resolved references plus the unresolved candidates; `readStatuteArticleCandidate` parses one bare `第N条…` mention for the unrecognized-reference scan that `scanUnrecognizedReferences` reports.

<a id="proposition-overlap"></a>
## Proposition overlap

`textOverlap` scores the share of a proposition's weighted character pairs an entry's transcribed text carries, and `topicOverlap` matches a proposition against an entry's topic keywords; both signals are deliberately lexical, so a reworded proposition reports as undecided rather than as a contradiction. `createOverlapIndex` builds the per-baseline frequencies once, and `PROPOSITION_SUPPORT_DEFAULT` is the default support threshold.

<a id="article-decision"></a>
## Article decision

`decideArticleCitation` resolves one citation against a law's baseline to `valid`, `mismatch`, `unmatched`, `out-of-range`, `not-indexed`, or `unverified`, with a reason line in the model's language; `articleComparableEntries`, `findCompetingLabels`, `supportMismatchReason`, `transcribedText`, `truncateProposition`, and `formatPercent` are the helpers a domain verify path assembles around it.

<a id="tool-scaffolding"></a>
## Tool scaffolding

`citationVerifyToolOptions`, `citationVerifyParameters`, `citationVerifyExecute`, `citationVerifyOutputSchema`, `citationVerifyRender`, `citationVerifyReport`, `citationReportLines`, `citationFindingSchema`, `citationInputProblem`, `CITATION_FINDING_DECISION_PROPERTIES`, and `CITATION_REPORT_PROPERTIES` build the framework-shaped pieces of a citation-verify tool as plain values. `renderCitationDecisionRows`, `resolveCitationDecisionPolicy`, `countCitationDecisions`, and `missingIndexReason` are the decision table, treatment lookup, decision counts, and missing-index reason both tools share. Each domain package registers the tool under its own name and description and owns the notes that follow the table.

<a id="consumers"></a>
## Consumers

`@deepseek-ai/dsh-legal-law` imports this machinery directly. `@deepseek-ai/dsh-patent-core` re-exports it so the patent domain keeps one import surface, and `@deepseek-ai/dsh-patent-law` consumes it through that re-export. A new statute-citation domain imports this package and never the patent one.

## Known Limitations and Deferred Work

- **No statute data ships here.** Baselines, article entries, and law names are domain data owned by each domain's index packages; this package only computes over the entries a caller hands it.
- **The overlap signals are lexical.** A proposition reworded around a synonym neither the topics nor the transcribed text lists reaches no signal and is reported `unmatched` by design, so a deployment that needs semantic matching must add it in its own verify path rather than here.
- **Paragraph narrowing needs a recorded paragraph list.** `decideArticleCitation` skips the 款 check when an entry omits `paragraphs`. A caller that must reject an unknown 款 supplies the list; a missing list is not reported as `unverified`.
- **Grammars stay per domain.** The legal-law and patent-law reference files keep their own citation grammars, indexes, tool names, and the notes after the decision table. The article decision, the decision table, and the conformance samples in `tests/fixtures/citation-samples.ts` are shared; `CONFORMANCE_POLICIES` records the two default policy sets, which differ on `not-indexed` and `unverified`.

### Dev Note

None.
