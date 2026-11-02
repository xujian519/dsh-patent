---
description: "Function plugin giving a patent drafter or agent the writing patterns this deployment applies: the packaged YAML corpus of drafting and office-action situations reaches the model through the query_writing_patterns tool and one writing-patterns:skills system-prompt section carrying a compact `<pattern_index>` of the patterns, and ships as a keyless library API for prompt assembly. Selection is lexical and offline — keyword search, case-feature match, category listing, or the whole library — so the same query always selects the same patterns."
kind: "package-reference"
---

# @deepseek-ai/dsh-writing-patterns

English | [中文](README.zh.md)

## Summary

Function plugin giving a patent drafter or agent the writing patterns this deployment applies: the packaged YAML corpus of drafting and office-action situations reaches the model through the query_writing_patterns tool and one writing-patterns:skills system-prompt section carrying a compact `<pattern_index>` of the patterns, and ships as a keyless library API for prompt assembly. Selection is lexical and offline — keyword search, case-feature match, category listing, or the whole library — so the same query always selects the same patterns.

## Table of Contents

- [query_writing_patterns tool](#query_writing_patterns-tool)
- [Pattern corpus and library API](#pattern-corpus-and-library-api)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## query_writing_patterns tool

query_writing_patterns returns the writing patterns that fit a drafting or office-action situation, compiled into a `<writing_skills>` block. Each pattern covers one situation — claim drafting, specification drafting, disclosure drafting, IPC strategy, embodiment writing, and office-action replies on inventiveness, novelty, and clarity — with ordered steps and the rules to follow or avoid.

Selection order is fixed and reaches no model. A call that sets `query` searches the corpus by keyword; a call that sets features but no query matches those features against pattern names, authored keywords, summaries, and step names, with the category standing in as the case type; a call that sets only `category` lists that category in id order; a call with no argument lists the whole library. `limit` caps the returned count; a narrowed call defaults that cap to the deployment's `matchLimit`, while the argument-free listing always returns the whole library.

Scoring is term containment over the authored fields. A keyword search splits Latin words, adds adjacent-character bigrams for Chinese runs, then adds 3 for a hit in the name, 2.5 for an authored keyword, 2 for the summary, 1.5 for the context, 1 for a step name, 0.5 for a step instruction, a do-rule, or a do-not-rule, and multiplies the total by the pattern's quality. A feature match adds 5 when the category or its Chinese label contains the case type, 3 for a hit in the name, 2.5 for an authored keyword, 2 for the summary, and 1.5 for a step name, then multiplies by quality. Equal scores are ordered by ascending pattern id, so a repeated call returns the same list.

The result carries the selection mode, each matched pattern with its id, category, and name, the library size, and the compiled block; `quality` stays internal as the score multiplier and never reaches the model. A call that matches nothing returns an empty pattern list, an empty `skills`, and a line naming the library size and the way to widen the call.

## Pattern corpus and library API

The corpus ships at `assets/patterns/`, one asset file per pattern with a `.yaml` or `.yml` suffix, and resolves relative to the module through `import.meta.url`, so the source tree and the built package read the same directory. A file declares either one pattern or a `patterns` list of several, with `id`, `name`, `category`, `summary`, optional `sub_category`, `context`, `keywords`, `source_ref`, and `version`, plus `steps`, `examples`, `dos`, `donts`, and `quality`; any other key is rejected rather than dropped. `keywords` are authored search synonyms; `source_ref` records the legal basis and is not compiled into the prompt, while the package's `source-ref` spec resolves every citation against the shipped law index. The first ten are the seed patterns of the MIT-licensed Go project `Mady/domains/writing`: utility-model claim drafting, dependent-claim layering, background technique, invention content, the three-step inventiveness reply, separate-comparison novelty, clarity and support, the disclosure PFE triple, IPC strategy, and embodiment writing. The upstream copyright and permission notice is retained in `NOTICE`. Eight further drafting patterns cover the three-step self-check against the closest prior art, the 26.3 embodiment matrix, article 33 amendment reserves, unity of invention, functional limitations, the software method/device/medium trio, Markush equivalents, and numeric-range fallback. The `invalidation` category carries no shipped pattern: it names invalidation practice so a deployment corpus can target it without a format change, and selecting it in `sectionCategories` indexes nothing extra.

Loading is fail-loud. `loadPatternStore()` reads the packaged directory and `loadPatternStore(patternDir)` reads an explicit one, resolving an explicit override against the working directory; an unreadable directory, a directory without a pattern file, a YAML syntax error, a duplicated id, or a missing, mistyped, out-of-range, or unrecognized field throws `PatternAssetError` naming the file, the field path, and the allowed keys. A category outside the nine known ones fails the same way, because the tool's category enum could never select such a pattern. A missing or zero `quality` takes the ported default of 0.8.

The library API exports the loaded pieces directly: `PatternStore` (`size`, `get`, `all`, `byCategory`, `search`, `match`), `loadPatternCorpus`, `parsePatternFile`, `patternKeywords`, `compileWritingSkills`, `compileWritingPatternIndex`, `escapeXmlText`, and `PATTERN_FILE_SUFFIXES`. `compileWritingSkills` emits the exact `<writing_skills>` block a tool result carries; `compileWritingPatternIndex` emits the compact `<pattern_index>` the prompt section carries. Both are pure functions of the patterns, so a caller can assert the injected text. Mounting the plugin also provides the `writingPatterns` service (`patternsForStage`, `compiledForStage`, `stageIds`) that resolves the stage map described below.

## Configuration

Schemastery configuration, every field optional.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| patternDir | string | packaged asset | Directory holding the pattern YAML files; a relative path resolves against the working directory. Must mirror the packaged layout; a missing or invalid corpus fails the plugin load. |
| matchLimit | number | 5 | Result cap for a search, feature-match, or category call that omits its own limit; an argument-free listing always returns the whole library. The ported source capped a match at 5. |
| registerSection | boolean | true | Register the always-on writing-patterns:skills system-prompt section. |
| sectionCategories | string[] | all nine categories | Categories whose patterns the index section carries; an empty list injects the instruction prose alone. |
| sectionOrder | number | 112 | Position of the injected section in the assembled system prompt, next to the patent-domain TRIZ section at 111. |
| stagePatterns | Record<string, string[]> | none | Pattern ids each workflow stage's prompt receives, keyed by stage id. Every stage lists 3 to 5 ids that exist in the loaded corpus; an unknown or duplicate id, or a count outside that range, fails the plugin load. An atom reads its stage through the `writingPatterns` service; asking for an undeclared stage throws. |

## Model Experience

### query_writing_patterns tool

#### What the model sees

One registered tool named `query_writing_patterns` with four optional parameters: `category` (one of the nine pattern categories), `query` (search keywords), `features` (the technical features of the case), and `limit`. The result renders as the matched patterns — id, category label, and name — followed by the compiled `<writing_skills>` block holding their summary, steps, do-rules, and do-not-rules; a call with no argument lists the whole library regardless of `matchLimit`. A `limit` below 1 comes back as a tool error naming the parameter, and the category enum rejects an unknown category before execution.

#### Token effect

Fixed definition cost on every request while the tool is enabled; each result repeats the selected patterns and their compiled block, so a wider `limit` costs proportionally more until compaction.

#### KV Cache effect

Append-only; newly visible result text follows the reusable request prefix and does not invalidate existing KV-cache entries.

### writing-patterns:skills system prompt section

#### What the model sees

One always-on prompt section named `writing-patterns:skills`, registered at order 112 only while `registerSection` is `true` (the default), carrying the compact `<pattern_index>` of the patterns in `sectionCategories` (every category by default). The index lists each pattern's id, category, and name; its steps and rules arrive through `query_writing_patterns`. Its instruction prose is:

##### Verbatim instruction prose

```markdown
The <pattern_index> block below lists the writing patterns of this deployment by id, category, and name; it is an index, not the pattern text.
Call query_writing_patterns with the case category, the case features, or search keywords to retrieve the matching patterns with their ordered steps and the rules to follow or avoid. When the case at hand is already covered by one of the indexed patterns, retrieve that pattern before drafting.
```

#### Token effect

Fixed cost of the two instruction lines on every request, plus the compact index of the injected categories, which is resent only until compaction; an empty `sectionCategories` leaves the two lines alone, and `registerSection: false` removes the section entirely. At the shipped corpus the index is 1,819 characters against 17,461 characters for compiling the former ten-pattern library in full.

#### KV Cache effect

Prefix-stable while the section text, its order, and the index are unchanged; changing `sectionCategories`, `sectionOrder`, `patternDir`, or a pattern asset rebuilds the index and invalidates reuse from that section onward. `stagePatterns` changes do not touch the section.

## Known Limitations and Deferred Work

- **The shipped corpus is eighteen patterns** — ten seed patterns of the ported project plus eight drafting-stage patterns. Point `patternDir` at a deployment's own directory to replace them; every file there must satisfy the same field rules, or the plugin fails to load.
- **Selection is lexical, never semantic** — Chinese runs are matched through adjacent-character bigrams plus authored `keywords`, so a differently worded question about the same situation can still miss. The last paragraph of the tool result names the library size so a model can tell a narrow library from a narrow query.
- **`quality` is relevance, not legal accuracy** — it multiplies the lexical score and stays out of the tool result; it does not attest that the pattern's rule or citation is correct.
- **`source_ref` is validated at test time, not at load** — the compiler does not put it into the prompt. `tests/source-ref.spec.ts` resolves every citation, including the paragraph number and guideline section, against the shipped law index, but the loader still accepts a corpus whose citation does not resolve.
- **`query` and `features` are scored differently and do not combine** — a call that sets both searches by keyword and ignores the feature match; the feature match exists for a case whose features are known but whose wording is not.
- **The prompt section carries an index, not the pattern text** — the shipped corpus indexes 18 patterns in 1,819 characters; compiling all 18 in full takes 27,234 characters. A model must call `query_writing_patterns` before drafting from a pattern, which costs one tool round-trip that the former always-on block avoided. The recorded `system-prompt.expected.md` snapshot pins the index exactly, so a corpus change that changes it re-records the fixture deliberately.
- **`examples` and the do/don't `example` are parsed but never compiled, and `sub_category` selects but is not compiled** — the compiled block carries each pattern's summary, steps (including a step's own `example`), do-rules, and do-not-rules, matching the ported compiler, and the seed corpus sets no top-level or principle example. `sub_category` takes part in category lookup only. A consumer that renders examples reads them from the store itself.
- **The tool is read-only and state-free** — it reads the corpus loaded at plugin load and writes no durable state or session event of its own; its results reach the log only as ordinary tool results.
- **Stage patterns are a lookup, not an injection** — `stagePatterns` resolves ids per stage and exposes them through `writingPatterns`; it does not edit a workflow manifest or push text into a stage prompt on its own. A consuming atom must ask for its stage, and a stage with no declared map fails that lookup loudly.
- **Assets fail the load, not the call** — an invalid or missing corpus throws `PatternAssetError` while the plugin is mounting, so a deployment never reaches a model with an empty pattern library.

### Dev Note

None.
