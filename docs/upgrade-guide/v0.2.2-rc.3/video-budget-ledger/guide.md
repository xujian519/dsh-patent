---
kind: upgrade-guide
description: "The video-mode budget ledger moves out of the project directory into ledgerDir, and readLedger and appendLedgerEntry take that directory."
---

# Video budget ledger leaves the project directory

English | [中文](guide.zh.md)

## Change

Settled CNY charges no longer live in `budget.json` beside the project document. `@deepseek-ai/dsh-video-mode` stores them under its `ledgerDir` setting, one file per resolved project path. The default directory is `~/.dsh/video-mode/ledgers`. A configured directory inside the session workspace is rejected. The publication uses a `workspace-write` policy rooted at `ledgerDir`, so file tools confined to the session workspace cannot change the ledger.

`readLedger` and `appendLedgerEntry` now take that absolute directory. An existing project `budget.json` is copied the first time the host file is absent. Later edits to `budget.json` do not change the budget gate. `ui-video-studio` still reads the project file and can show a stale total. The version guard on ledger writes is unchanged.

## Migration

1. Pass the directory into the two store functions: `readLedger(ctx, projectPath, ledgerDir, cwd, signal)` and `appendLedgerEntry(ctx, projectPath, entry, ledgerDir, cwd, signal)`.
2. Set `ledgerDir` on the `video-mode` plugin to an absolute path outside the session workspace, or leave it unset to use `~/.dsh/video-mode/ledgers`.
3. Settle one CNY charge, replace the project `budget.json` with an empty ledger, and confirm the next generation is still refused with `MEDIA_BUDGET_EXCEEDED`.
