# ADR-002: Filing artifact contract

English | [中文](ADR-002-filing-artifact-contract.zh.md)

Status: Accepted. Date: 2026-11-24.

## Summary

A disclosure workflow success terminal state must be assembled by a deterministic assembler into one `SpecDraft` that passes `validateSpecDraft`. The default write root for HTML, PDF, DOCX, and figures is the ADR-001 matter directory. This record states the accepted decision and does not change the assembler or the write paths.

## Context

`patent_disclosure_v1` in `packages/patent/patent-workflow/src/workflow/manifests.ts` keeps text keys such as `claims_draft` and `specification`. Those keys are not a `SpecDraft`. `SpecDraft` and `validateSpecDraft` live in `packages/patent/patent-core/src/draft/`. Leaving assembly to a later hand step, or to a model rewrite, can emit a filing artifact that fails `validateSpecDraft`, or can fill a missing field without naming the gap.

HTML and PDF live in `packages/patent/patent-document/`. DOCX lives in `packages/patent/patent-filing/`. Both use `DEFAULT_OUTPUT_DIR`, which is `<cwd>/.dsh/documents`, when neither an output directory nor a case id is passed. When a case id is passed, `resolvePatentOutputDir` in `packages/patent/patent-core/src/paths.ts` writes `<cwd>/data/cases/<案号>/outputs`. Figures from `packages/patent/patent-tools/src/tool/generate-patent-figure.ts` use the relative directory `patent/figures`. `figureOutputDir` in `packages/patent/patent-tools/src/config.ts` defaults to that same relative directory and resolves it from the workspace root. The matter-root configuration field is `workbenchCaseRoot`. [ADR-001](ADR-001-matter-folder-index.md) already makes the matter directory the truth source. A second tree beside that directory splits the files of one matter. The decision below names the replacement for these defaults.

## Decision

- A disclosure workflow success terminal state must be assembled by a deterministic assembler. The assembler is a pure function, not a model rewrite. The result is a `SpecDraft` that passes `validateSpecDraft`.
- The default write root for outputs (HTML, PDF, and DOCX) and for figures is the ADR-001 matter directory. `workbenchCaseRoot` remains the configuration field for the work root. One matter is that root's `<案号>/` directory.
- The old `data/cases` and `.dsh/documents` locations are allowed only when the caller passes that path explicitly.
- If the matter directory cannot be resolved and there is no explicit override, the write fails. It does not fall back to `<cwd>/.dsh/documents` or `<cwd>/data/cases/<案号>/outputs`.
- The intermediate representation is `SpecDraft` in `packages/patent/patent-core/src/draft/`. It must pass `validateSpecDraft`.
- A workflow may still use text keys such as `claims_draft` and `specification` internally. A success terminal state must be assemblable. Hand-assembling a structure later is not a default step that may be omitted.
- A missing field fails and names the gap. The model must not fill it in.
- Subdirectory names inside the matter directory are the names the `patent-workspace-layout` skill already uses. This decision adds no directory name.

## Consequences

This batch covers the assembler and `validateSpecDraft`, changing the default write root to the matter directory, using old paths only when they are passed explicitly, tests for the acceptance criteria below, and landing this Accepted record. The assembler, the default root, and the tests are later tickets.

Acceptance criteria for later tickets:

1. Calling the assembler with a disclosure-chain success terminal-state fixture must yield a result that passes `validateSpecDraft`. Changing a required field, or dropping a key text key, must fail and name the gap. The call must not emit silently.
2. When a matter directory is resolved and no output directory is passed, artifacts must be written inside that matter directory, not under `<cwd>/.dsh/documents` and not under `<cwd>/data/cases/<案号>/outputs`.
3. Explicitly passing an old path may still write to that old location.
4. If the matter directory cannot be resolved and there is no override, the write must fail. It must not fall back to the old defaults.
5. The same `SpecDraft` through the HTML channel and the DOCX channel must not diverge on claim item numbers, figure numbers, or table titles.

The following are forbidden:

- Making `data/cases` or `.dsh/documents` an implicit default again.
- Using a model rewrite instead of the assembler.
- Writing matter file bodies to the cloud or into `knowledge.db`.
- Creating a parallel `data/cases` or `.dsh/documents` tree beside the matter directory.
- Putting an out-of-scope item into this batch.

## Out of scope

This decision does not change generation algorithms, rewrite output templates, or rewrite the Python drafting engine. It does not merge the HTML renderer and the DOCX renderer. It does not address HITL granularity, utility-model hard caps, docx re-read, or the working-draft red-mark versus filing-draft no-color split.

This decision does not reopen [ADR-001](ADR-001-matter-folder-index.md). The workbench remains an index only. Matter file bodies do not go to the cloud and do not go into `knowledge.db`.

This decision does not change the workbench UI by default. If output paths will appear in a panel, that is a later split.

## Leftover risks

The following stay open. This record does not expand the product to close them.

- Whether the workbench session working directory already equals the matter directory when a matter is opened has not been read through in the workbench.
- Subdirectory names follow the existing layout skill. This record adds no directory name.
- Which terminal-state fields are needed to pass `validateSpecDraft` has not been shown with a fixture. That proof is T2.
- Scripts and tests that depend on the old default paths must switch to an explicit override or to the matter directory. That switch is T3.
