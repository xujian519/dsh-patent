---
description: "Shipped Chinese legal-law index for the DeepSeek Harness: law-article reference parsing, a per-law index recording each entry's source and verification date, citation verification that never silently passes an unverified article, and the legal_law_verify tool."
kind: "package-reference"
---

# @deepseek-ai/dsh-legal-law

English | [中文](README.zh.md)

## Summary

Shipped Chinese legal-law index for the DeepSeek Harness: law-article reference parsing, a per-law index recording each entry's source and verification date, citation verification that never silently passes an unverified article, and the legal_law_verify tool.

## Table of Contents

- [Why it exists](#why-it-exists)
- [Shipped index](#shipped-index)
- [Citation decision](#citation-decision)
- [Tool](#tool)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="why-it-exists"></a>
## Why it exists

A legal conclusion that cites 《民法典》第 143 条 is only as good as the text behind that number. The index ships with the deployment so the citation can be checked offline: the reference is parsed, the article is looked up, and the decision distinguishes an article that exists from one that does not, and a transcribed article from one nobody has verified. The reference parser, the entry reader, and the proposition test share their mechanics with `@deepseek-ai/dsh-patent-law` through `@deepseek-ai/dsh-law-core` and `@deepseek-ai/dsh-patent-index-asset`; this package owns the legal-domain grammar, assets, and messages.

<a id="shipped-index"></a>
## Shipped index

Each law is one YAML file under `assets/legal-law`, and `manifest.json` lists every one as `[law, document, file]`. A file declares `law`, `document`, `revision`, `maxArticle`, `maxVerifiedOn`, `maxSource`, and an `articles` list; each entry carries `article`, optional `paragraphs`, `topics`, `text`, `sourceDoc`, and `verifiedOn`. The transcription record is all-or-nothing: a `text` requires a `sourceDoc` and a `verifiedOn`, and a source without text is a load error, so a hand-edited index cannot create the fail-open state the verifier avoids.

Plugin load checks that the directory is readable, non-empty, and carries the manifest, and fails the deployment otherwise. The first verification reads the manifest through `createLegalLawIndex().loadNames`, which teaches the parser every law name and document title, and then parses only the laws the citations name; each law is cached, and a failed read leaves the next call free to retry. Both steps take an `AbortSignal`; an abort ends that caller's wait and leaves a read shared with another caller running. `loadLegalLawBaselinesAsync` remains for callers that need the whole corpus and yields the event loop between files; `loadLegalLawBaselines` is its synchronous variant; `parseLegalLawBaseline` parses one file; `findLegalArticle` looks up one article. Any law name an asset declares becomes a citation form, together with the asset's document title as the formal-name alias; `legalLawNames` reports the current set. A `baselineDir` override replaces the packaged directory, so it must carry `manifest.json` next to its YAML files.

<a id="citation-decision"></a>
## Citation decision

`parseLegalLawReference` parses one reference standing alone, `extractLegalLawReferences` extracts every reference in a text (including continuations such as `第 143 条、第 144 条` and `第 2 款、第 3 款`), `formatLegalLawReference` renders the formal form, and `scanUnrecognizedLegalCitations` lists citation-like fragments the parser could not resolve. `verifyLegalCitation` decides one reference as `valid`, `mismatch`, `unmatched`, `out-of-range`, `not-indexed`, or `unverified`; a proposition is matched by topic keywords and by weighted character-pair overlap against the enrolled texts, and a proposition carried by another article is reported as a mismatch naming that article. `resolveLegalCitationPolicy` maps a decision through the deployment's policy set, and `renderLegalCitationRows` renders the decision table the tool returns.

<a id="tool"></a>
## Tool

`legal_law_verify` accepts optional `text` (whose citations are extracted), optional `references` (exact references), and optional `proposition` (what the citations support); at least one of `text` or `references` is required, and a blank `text` without references is an input error. The result carries the findings, a `blocked` flag, per-decision counts, and the `unrecognized` fragments that were not checked.

<a id="model-experience"></a>
## Model Experience

### legal_law_verify tool

#### What the model sees

One registered tool named `legal_law_verify` with the `text`, `references`, and `proposition` parameters above; input that names neither text nor references is an error rather than an empty check. Each finding carries the raw reference, law, article, paragraph or item, decision, policy, and reason; the result also carries `blocked`, decision counts, and `unrecognized`. The tool description states the six decisions, that an unverified article is never reported as checked, and that a reference which is not exactly one reference is an input error.

#### Token effect

Fixed definition cost on every request while the tool is enabled; each result is one short table plus notes, resent only until compaction.

#### KV Cache effect

Append-only; newly visible result prose follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Only seventeen core statutes are transcribed.** 民法典, 刑法, 公司法, 劳动法, 劳动合同法, 民事诉讼法, 刑事诉讼法, 行政诉讼法, 专利法, 商标法, 著作权法, 反不正当竞争法, 个人信息保护法, 行政处罚法, 行政许可法, 行政复议法, and 仲裁法 carry article text, the source file it was copied from, and a transcription date. Every other generated file still carries `text: null`, so a citation to it returns `unverified`. A transcription date records a mechanical copy from that source, not that a qualified person read the text back. The default policy blocks `unverified` and `not-indexed` citations; a deployment with a narrower corpus relaxes that through `Config`.
- **Coverage is a generated corpus, not a reviewed outline.** `assets/legal-law` holds thousands of per-law files whose topics were derived automatically; a law or article the generator missed reports `not-indexed` even though the provision exists. Two known source gaps affect the transcribed set: the corpus omits 刑事诉讼法 article 128, and an amendment article written as `第 N 条之一` is folded into its base article instead of indexed separately. An `unverified` or `not-indexed` result therefore says what this index holds, not what Chinese law contains.
- **Proposition matching is lexical.** Topic keywords and weighted character pairs compare characters only; a proposition reworded around synonyms is reported as `unmatched` and must be read by a person, and boilerplate shared across many articles lowers but does not remove a false match.
- **An item number is reported, not checked, and a missing paragraph list is not narrowed.** The shipped legal index records no `paragraphs` lists, so a citation that names a 款 is not checked against a paragraph count. A citation that names a 项 is decided at article level and the item is echoed. The shared decider skips narrowing when `paragraphs` is absent; it does not report `unverified`, because this deployment's default policy blocks that decision.
- **An unresolved fragment is a warning, not a block.** `unrecognized` lists fragments that were not checked and does not set `blocked` by itself. A 款 or 项 the parser cannot read (`第十十款`, `第十十项`, `第（十十）项`) rejects the whole citation: `text` lists the fragments here, and `references` returns an input error instead. A fragment is dropped from the list only when its span lies inside a resolved citation.
- **Baseline correctness is content-owned.** No runtime observation can prove that an article's text is the current official text; only a recorded source and date can, and the gate checks references and index membership, not legal correctness.

### Dev Note

None.
