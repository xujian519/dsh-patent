---
description: "Shipped-index asset format for the patent domain: the YAML mapping step, the strict field readers, the source and verification fields every transcribed entry records, and the load error a malformed index raises."
kind: "package-reference"
---

# @deepseek-ai/dsh-patent-index-asset

English | [中文](README.zh.md)

## Summary

Shipped-index asset format for the patent domain: the YAML mapping step, the strict field readers, the source and verification fields every transcribed entry records, and the load error a malformed index raises.

## Table of Contents

- [Why it exists](#why-it-exists)
- [Field readers](#field-readers)
- [Recorded source](#recorded-source)
- [Error contract](#error-contract)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="why-it-exists"></a>
## Why it exists

`@deepseek-ai/dsh-patent-law` and `@deepseek-ai/dsh-patent-fees` each ship a YAML index that a person transcribes by hand and the plugin reads at load; both refuse a malformed field instead of coercing it, and both record where every entry came from. Sharing one implementation is what keeps that rule from drifting between them — a second copy would let the two indexes disagree about what `null` means without either gate noticing.

<a id="field-readers"></a>
## Field readers

Each reader either returns the value the asset declared or refuses the file with a message naming the field: `parseYamlMapping(source, label, fail)` for the root mapping, `readString`, `readOptionalString`, `readOptionalDate` (`YYYY-MM-DD`), `readCount` (a positive integer), `readOptionalCount`, `readOptionalBoolean`, `readEnum` (a closed set), and `readMapping`.

`readOptional*` returns null for an absent field rather than a default, so a caller keeps the three states apart: absent, present-and-empty, and present. An amount or an article number that nobody has transcribed stays absent until someone records it.

`readEntryTopics` returns each topic keyword trimmed. A topic is matched against a proposition as written, so `[" 新颖性 "]` would never match; the keyword itself keeps its spelling.

<a id="recorded-source"></a>
## Recorded source

`readRecordedSource(entry, fail)` reads the two fields every entry of a shipped index carries beside its content: `sourceDoc` (the official document the value came from) and `verifiedOn` (the date a person checked it against that document). Both are null until someone transcribes the entry, which is what lets a consumer tell a transcribed value from a remembered one. An index may add fields of its own beside them — `@deepseek-ai/dsh-patent-fees` adds `effectiveFrom`.

<a id="error-contract"></a>
## Error contract

`IndexAssetError` carries the file the problem came from in `origin`. Readers take an `AssetFail` — a factory the caller binds to one file — instead of an error class, so each index package keeps its own catchable error type (`LawBaselineError`, `FeeTableError`) while sharing the field rules; both extend `IndexAssetError`.

<a id="model-experience"></a>
## Model Experience

None, as the library is pure validation over an asset file; every model-facing schema and result is owned by the indexes that consume it.

#### KV Cache effect

Independent; the library contributes no model-visible content, so it never populates or invalidates a reusable KV-cache prefix.

## Known Limitations and Deferred Work

- **No schema for the asset beyond field types** — the readers check a field's type and shape, not whether a key is spelled the way the consumer expects; a mistyped key reads as an absent field, so each index package's own tests pin the field set its shipped asset uses.
- **Dates are validated as text** — `readOptionalDate` accepts `YYYY-MM-DD` and does not reject a date that never existed on the calendar; a consumer that needs a real calendar day parses it through its own date module.
- **No plugin, no service, no state** — the package registers nothing; a host composes it by importing it, and it is not a row in any preset.

### Dev Note

None.
