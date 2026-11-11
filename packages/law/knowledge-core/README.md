---
description: "Knowledge-database query machinery shared by the legal and patent domains: FTS5 helpers and the FTS-to-LIKE degradation ladder, query-text sanitization, query keyword splitting, result-cap normalization, statute validity rules, shared install file operations, and real-path normalization."
kind: "package-reference"
---

# @deepseek-ai/dsh-knowledge-core

English | [中文](README.zh.md)

## Summary

Knowledge-database query machinery shared by the legal and patent domains: FTS5 helpers and the FTS-to-LIKE degradation ladder, query-text sanitization, query keyword splitting, result-cap normalization, statute validity rules, shared install file operations, and real-path normalization.

## Table of Contents

- [Why it exists](#why-it-exists)
- [Full-text search](#full-text-search)
- [Query keywords](#query-keywords)
- [Result caps](#result-caps)
- [Statute validity](#statute-validity)
- [Install file operations](#install-file-operations)
- [Real paths](#real-paths)
- [Consumers](#consumers)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="why-it-exists"></a>
## Why it exists

A legal-domain case-law query and a patent-domain prior-art query run through the same mechanics: sanitize the query text so SQLite can bind it, probe whether the runtime SQLite has FTS5, try the whole phrase, retry with split keywords, fall back to LIKE when neither matches or when FTS5 is missing, and cap the result count the same way. Those mechanics used to live in the patent domain's core library, so the legal domain depended on the patent core package for functions that carry no patent meaning. The engines stay per domain — each keeps its own tables, filters, row mapping, and messages — but the shared mechanics live here exactly once, so a fix lands in one place and both domains inherit it.

<a id="full-text-search"></a>
## Full-text search

`FTS_MIN_RUNES` is the trigram tokenizer's minimum match length, `sqliteHasFts5` probes whether the runtime SQLite compiled FTS5 (a runtime without it raises "no such module: fts5" even when the database holds FTS tables), `escapeFtsPhrase` wraps a term as a quoted FTS5 phrase with embedded quotes doubled, `joinFtsOrTerms` builds the OR expression for split keywords, and `sanitizeSearchText` drops the NUL that would terminate a bound query text. `runFtsSearch` runs the ladder — whole-phrase FTS, then split-keyword FTS, then LIKE — and calls the caller's `degrade` callback with the failure reason when FTS throws, so the caller can make the degradation sticky. `createFtsLadder` binds one engine's three query paths and the result cap into the ladder's input.

<a id="query-keywords"></a>
## Query keywords

`extractLawKeywords` splits a long query on Chinese function words and question words, keeps the fragments of at least `FTS_MIN_RUNES` characters, and returns at most `max` of them. The trigram tokenizer cannot match a shorter fragment, so dropping it is what makes the split-keyword rung useful rather than noisy.

<a id="result-caps"></a>
## Result caps

`resolveResultLimit` truncates a caller-supplied cap, clamps it into `[1, max]`, and falls back to the caller's default when the cap is missing or not finite. SQLite binds a cap as `LIMIT ?`, where a fractional operand is a datatype error and a negative operand means "no limit"; the tool layer and the engines therefore call one implementation so a cap means the same thing on both sides.

<a id="statute-validity"></a>
## Statute validity

`resolveLawValidity` answers whether a statute is visible at a given date, reading the `expired` flag, the effective date, and the expiry date. An `expired=1` flag or an expiry date before the point in time is `expired`; an effective date after it is `not-yet-effective`; any present time column that missed those is `in-force`; three missing columns are `unverified`, because an unverified record is not an effective one. A malformed date counts as a missing column rather than as an in-force record. `isLawVisible` hides the expired and not-yet-effective records and lets the caller decide about the unverified ones, `resolveAsOf` reads the caller's point in time (defaulting to today, and rejecting a malformed date instead of reading it as today), and `todayIsoDate` renders the current UTC date.

<a id="install-file-operations"></a>
## Install file operations

Both knowledge-database install commands copy a source database into the runtime directory, so they share the file mechanics: `prepareTempSibling` creates the output directory and returns a sibling temp path inside it, which keeps the following rename on one filesystem and clears a temp file an interrupted run left behind; `commitTempSibling` replaces the output atomically and records the overwrite; `countTableRows` counts a table and reports -1 when the table is missing; `formatGigabytes` renders the size of the source database.

<a id="real-paths"></a>
## Real paths

`resolveRealPath` normalizes a path to its real form and tolerates a file that does not exist yet: the first existing ancestor is resolved and the missing segments are appended. This is what makes the "source file and target file are the same" check and the working-directory containment check reliable across `./`, `../`, and symlink aliases.

<a id="consumers"></a>
## Consumers

`@deepseek-ai/dsh-legal-knowledge` and `@deepseek-ai/dsh-patent-knowledge` import this package directly. `@deepseek-ai/dsh-patent-core` re-exports it so the patent domain keeps one import surface for callers that already import the core package. A new knowledge-database domain imports this package and never the patent one.

## Known Limitations and Deferred Work

- **No knowledge data ships here.** Databases, tables, filters, row mappings, and result rendering belong to each domain's index package; this package only computes over what a caller hands it.
- **The degradation ladder is synchronous and in-process.** It runs the three rungs in one call and reports the failure to a callback; a caller that needs a timeout or a background retry adds it in its own engine.
- **The validity rule reads three columns.** A corpus that records its own time semantics beyond `expired`, effective date, and expiry date resolves that mapping in its own engine before calling `resolveLawValidity`.
- **The FTS helpers assume the trigram tokenizer.** `FTS_MIN_RUNES` and the keyword split are calibrated for it; a deployment on a different tokenizer supplies its own minimum and split rule.

### Dev Note

None.
