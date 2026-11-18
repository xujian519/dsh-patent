# Agent Note: The filing build accepts its own output

Status: implemented

English | [中文](2026-11-18-filing-build-accepts-its-own-output.zh.md)

## Problem

`build_patent_filing` wrote the DOCX and returned tallies about what it thought it wrote. The defects that survive into a delivered filing are the ones those tallies cannot see: a declared section that carried no content, a missing or wrong header, a numbering gap, figures out of sequence. `verify_patent_filing` reads the finished file and catches exactly those, but it is a second, optional call — the model has to remember it, and the preset's delivery gate can only record that some tool returned `passed: true` in the session, never that the file being delivered is the file that was checked.

## Decision

- `buildFiling` runs `verifyFiling` on the path it just wrote and returns the verdict as `FilingBuildResult.verification`, a required field. Every caller of the engine gets the acceptance result; nothing has to remember to ask for it.
- A failing acceptance run is a successful domain result: the call returns normally, `verification.passed` is false, and the filing stays on disk. This follows the engine's existing position that a non-zero engine exit is still a reported domain outcome, and it keeps the written file and its verdict together — throwing would move "the file exists" into an error message and invite a caller to conclude the build failed.
- An acceptance run that cannot produce a report at all — the child process fails, or its output does not parse — throws `PatentFilingError` naming the written path. The outcome is unknown, and a caller must not be left believing nothing was written.
- `VERIFY_RESULT_SCHEMA` moved to `schemas.ts` and both tools import it, so the build's `verification` field and `verify_patent_filing`'s result cannot drift apart.
- The verification lives in the engine rather than in the tool wrapper because the write and its acceptance are one operation. A wrapper would cover this tool's callers only; the engine covers every consumer of `buildFiling`.

## Alternatives considered

- **Add `verify_patent_filing` to the preset's delivery-gate prerequisites.** The gate would then require the model to call it, but it still proves only that some `verify_patent_filing` run passed in the session — not that it read this build's file.
- **Run the acceptance in `build-patent-filing.ts` after `buildFiling` returns.** It keeps the engine single-purpose, but moves the verdict outside the result type the engine already owns, so a second engine consumer would silently get a filing with no acceptance.
- **Throw when the acceptance run fails.** The filing is already on disk; an error would report a written file as a failed build and lose the assertion detail to an error string.
- **Gate the build on acceptance, refusing to keep a failing file.** Deleting or withholding the file hides the artifact the model needs to inspect, and the defect is in the draft, not in the file's presence.

## Consequences

- Every build starts one more Python child process. The build already requires the packaged interpreter, so this adds no new failure class, and both calls share the configured `timeoutMs`.
- `FilingBuildResult` gains a required field: every consumer and fixture constructs `verification`. The tool schema and its rendered prose gained a verdict line, and a failing verdict renders one line per failed assertion under a head that says the filing is already on disk.
- The model no longer needs a follow-up `verify_patent_filing` call after a build; the call remains for verifying a file the model did not build in this session.

## Testing

- Engine (`packages/patent/patent-filing/tests/engine.spec.ts`): a passing acceptance run returns `verification.passed` and the same path; a failing report returns normally with `verification.passed` false while the file stays on disk; an unparseable report rejects with an error naming the written path. The spawner stand-in writes the `--out` file because the acceptance run reads it.
- Tool (`packages/patent/patent-filing/tests/tools.spec.ts`): the passing render carries `验收：✅ 断言全部通过（…）`; a failing verdict renders the head that says the filing was written plus one line per assertion.
- Composition (`packages/patent/patent-filing/tests/loader-composition.spec.ts`): a build dispatched through the tool runtime under a real Loader returns the acceptance line in model-facing prose.
- Gates: `pnpm run typecheck`, `pnpm run lint`, `pnpm run test:docs`, `pnpm run hygiene`, `pnpm run build`, and `pnpm run test:snapshot -t patent` all pass on this change.
