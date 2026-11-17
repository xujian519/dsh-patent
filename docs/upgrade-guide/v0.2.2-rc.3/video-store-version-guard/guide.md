---
kind: upgrade-guide
description: "Video-mode journal, ledger, and project writes are guarded by the file version they read; a losing writer retries and merges, then reports MEDIA_STORE_CONFLICT."
---

# Video-mode durable writes are version-guarded

English | [中文](guide.zh.md)

## Change

The journal (`tasks.json`), the budget ledger (`budget.json`), and the project document (`project.json`) are now written with the freshness token the writer read. A concurrent writer makes the guarded write fail instead of overwriting the newer file: the mutation re-reads, merges its change, and retries up to three times. A write that keeps losing fails with the new `MEDIA_STORE_CONFLICT` code; project documents keep reporting `MEDIA_PROJECT_CONFLICT`.

Project initialization creates with `createIfAbsent`: initializing an id whose document already exists now fails with `FS_NOT_OBSERVED` instead of replacing it.

`ProjectFileIo`, exported by `@deepseek-ai/dsh-video-mode`, changed shape: `read()` returns `{ text, version }` and `write(text, version)` receives the version to guard against.

## Migration

1. An implementation of `ProjectFileIo` outside this repository must observe the version before reading (`ctx.fs.stat(target)` then `ctx.fs.readText`) and pass it to `ctx.fs.writeText(target, text, { kind: 'replaceIfVersion', version })`. The read order matters: observing after the read would authorize overwriting a change made between the two.
2. A caller that initializes a project twice for the same id now gets `FS_NOT_OBSERVED`. Read and mutate the existing document through `mutateProjectFile` instead.
3. Catch `MEDIA_STORE_CONFLICT` where `MEDIA_STORE_INVALID` is handled: the journal or ledger kept changing under this writer, and the call should be retried rather than treated as corrupt data.
4. The in-process lock is unchanged and remains an optimization: it serializes writers inside one process, while the version guard is what detects another process.
