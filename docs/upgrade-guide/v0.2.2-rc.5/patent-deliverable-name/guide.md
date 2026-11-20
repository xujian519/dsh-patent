---
kind: upgrade-guide
description: "Patent filing and document tools now share one deliverable-name allowlist, and @deepseek-ai/dsh-patent-core replaces assertSafePathSegment with assertPathSegment and assertDeliverableName."
---

# Patent tools share one deliverable-name allowlist

English | [中文](guide.zh.md)

## Change

`build_patent_filing` and `render_patent_document` now validate case ids and output file stems against one allowlist: ASCII letters and digits, `.`, `_`, `-`, `()`, Chinese characters, circled numerals ①–⑳, and `、。《》「」【】（），：；！？·——…“”‘’`. A name is 1–120 characters and may not contain spaces, path separators, NUL, or `..`, nor end with a dot.

For the `build_patent_filing` `caseId` this widens: a Chinese case name that previously failed now resolves to `data/cases/<caseId>/`.

For `build_patent_filing` output names it narrows: characters outside the list, including internal spaces, are now rejected.

Both tools now reject `.` and names ending with a dot, which `render_patent_document` previously accepted.

`@deepseek-ai/dsh-patent-core` no longer exports `assertSafePathSegment`. It exports `assertPathSegment` and `assertDeliverableName` (each takes the value, a label, and a `createError` factory), `resolvePatentOutputDir`, `startSpawnDeadline`, and the `SpawnDeadline` type.

Failure text changed. A rejected name reports `<label> "<value>" 不可用：…`. A filing build whose Python script exits without JSON now names `超时` or `被调用方取消` before falling back to the exit signal or code. `render_patent_document` no longer starts Chrome for an already-cancelled call and returns `已取消：未启动 Chrome`.

## Migration

1. Rename case ids and output names outside the allowlist: replace spaces with `_`, and drop or transliterate characters such as `#`, `*`, `|`, `<`, `>`, `:`, `?`.
2. Remove a trailing dot, or a bare `.`, from any output name; ending in a dot is now an error.
3. Replace `assertSafePathSegment(value, what)` with `assertDeliverableName(value, what, createError)` for file stems or `assertPathSegment(value, what, createError)` for directory segments. Each call supplies its own error constructor, so the thrown type stays the caller's.
4. Replace a local output-directory resolver with `resolvePatentOutputDir(input, cwd, defaultOutputDir, createError)`, and a local timeout controller with `startSpawnDeadline(timeoutMs, callerSignal)`, calling `dispose()` on completion.
5. Match on the new failure text where you assert on it, then run `pnpm run typecheck`.
