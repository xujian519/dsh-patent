---
kind: upgrade-guide
description: "Patent atom and stage-handler registries now return disposers, and `StageError` is removed from `@deepseek-ai/dsh-patent-core`."
---

# Patent registries return disposers; `StageError` is removed

English | [中文](guide.zh.md)

## Change

`AtomRegistry.register`, `StageHandlerRegistry.register`, and the `RegisterAtom` helper now return `() => void`. The disposer removes the entry only while its name still points at that registration, is idempotent, and never deletes a later registration that overrode it. `@deepseek-ai/dsh-patent-tools` wraps its six package atoms and handlers in one `ctx.effect`, so unloading the plugin removes them while `patent-core` builtins stay registered. This guide records the six package atoms registered at v0.2.1-rc.2; atoms added later unload through the same effect and are outside this migration.

`StageError` is no longer exported. Expected stage failures return a `degraded()` fragment; a manual interruption throws `InterruptStageError`; any other exception is handled by the workflow executor's retry/degrade policy.

## Migration

1. Replace fire-and-forget registration with a lifetime:
   ```ts ignore-check
   ctx.effect(() => globalAtomRegistry.register(atom), 'my-plugin: atom')
   ```
   For a pair, collect both disposers and call them in reverse order.
2. Call the returned disposer during teardown if you do not use `ctx.effect`. Keep a disposer only until the registration it created is replaced.
3. Replace `throw new StageError(...)` with `return degraded('<atom>', '<reason>')` for expected failures. Use `InterruptStageError` only for human approval or other intentional interruptions. Remove imports of `StageError`.
4. Confirm: register an atom, dispose the plugin or call the disposer, and check `LookupStageHandler(name)` / `globalAtomRegistry.get(name)` returns `undefined`; `extract` and other `patent-core` builtins remain.
