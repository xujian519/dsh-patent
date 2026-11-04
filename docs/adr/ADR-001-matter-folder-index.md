# ADR-001: Matter folder index

English | [中文](ADR-001-matter-folder-index.zh.md)

Status: Accepted. Date: 2026-11-04.

## Summary

A matter (案卷) stays a folder on the operator's machine. The workbench ledger indexes that folder. This record states the accepted decision and does not reopen it.

## Context

Patent work writes the files of one matter: the disclosure, search notes, analysis, drafts, and the append-only `_matter-log.md`. Those files are the matter. A second copy in a cloud store or in `knowledge.db` would split that truth source.

The workbench already stores task metadata. Treating that database, or a separate Cursor or git project per matter, as the matter itself moves file bodies off the operator's disk and multiplies repositories.

## Decision

- The matter truth source is the local work-root folder on the operator's Mac.
- The workbench is a folder index entry only: metadata plus `workspace_path`.
- Matter file bodies do not go to the cloud and do not go into `knowledge.db`.
- One repository holds many matters. Do not create one Cursor project or one git project per matter.
- The work root stays configurable. It is not the only hard-coded path. Its canonical default semantic, and the typical value, is `/Users/xujian/工作`. A matter is that root's `<案号>/` directory plus `_matter-log.md`.
- The ledger is the SQLite database under `~/.dsh/workbench`. `knowledge.db` is not the matter store. A bridge may read projections from the matter folder. Writing those projections back into the matter folder is not the ledger.

## Consequences

- Create a matter in four steps, as the [README](../../README.md) and the [patent quick start](../user/guide/patent-quickstart.md) describe: create the folder under the work root, scan it into the workbench ledger, open this same repository for that matter, and write files onto disk in that folder.
- `workbenchCaseRoot` remains the configuration field for the work root. When it is unset, `workbench_link_patent_case` still falls back to `<cwd>/patent-workspace`. That fallback is not the matter truth source. Set the field to the local work root.
- The `patent-matter` and `patent-workspace-layout` skills describe the work root and the directories inside one matter. They do not require a separate `patent-workspace` tree, and they do not require a repository per matter.

## Out of scope

This decision does not add matter full-text or vector search, cloud sync, or multi-firm sharing. It does not migrate matter file bodies into a database, rewrite the bridge's matter-versus-root-task dual track, or redesign the workbench UI.

## Leftover risks

The following stay open for future ADRs. This record does not expand the product to close them.

- Matters versus root-task dual track. The bridge still projects a matter onto a root task and stage tasks. Which of those rows is authoritative beside `_matter-log.md` is undecided.
- Multi-matter working-directory mismatch. One repository serves many matter folders, and a session working directory can differ from the matter folder being written.
- Local path gates. The unset `workbenchCaseRoot` fallback `<cwd>/patent-workspace`, and any check that accepts only that relative tree, can ignore the configured work root.
