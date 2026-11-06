---
kind: upgrade-guide
description: "claim_chart_build stops before the first model call when a target source file cannot be read, and reports invalid_tool_input."
---

# `claim_chart_build` validates sources before generating

English | [中文](guide.zh.md)

## Change

`claim_chart_build` used to call the model up to three times when a target's `source_path` could not be read — a missing file, a path outside `chart_source_roots`, a non-text extension, or a file over `chart_source_max_bytes` — then failed with `tool_execution_failed`. It now stops before the first model request and raises `PatentToolError` with code `invalid_tool_input`. The message names every unreadable path with its reason and the directory relative paths resolve against.

A target that declares `source_path` but is unreadable now fails the whole call, even when no chart row references it. Charts are never produced with that target's citations unverified.

This affects callers that pass `targets[].source_path`, and any consumer that branches on the tool error code.

## Migration

1. Where you branch on `code`, treat `invalid_tool_input` from `claim_chart_build` as a caller-correctable input problem rather than a tool failure. Retrying the same arguments cannot succeed.
2. Fix the declared path, or add its directory to `chart_source_roots`. Set `chart_source_max_bytes` higher when the file legitimately exceeds the limit, and extract PDF or DOCX sources to text before passing them.
3. Confirm the migration: a call with a bad `source_path` fails immediately, its message lists each failing path, and no `patent/model-call` event is appended for it.
