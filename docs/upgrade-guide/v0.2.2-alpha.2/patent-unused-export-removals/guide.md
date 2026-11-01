---
kind: upgrade-guide
description: "Six zero-consumer public exports disappear from the patent packages, and patent_plan_task accepts case-docket entries."
---

# Patent packages drop unused public exports

English | [中文](guide.zh.md)

## Change

`@deepseek-ai/dsh-patent-workflow` no longer exports `CheckerVerdict`, `parseCheckerVerdict`, `CheckerVerdictParseError`, `CHECKER_VERDICT_REQUIRED_FIELDS`, or the `checker-verdict.ts` module: no shipped checker worker produced the JSON that parser accepted. `@deepseek-ai/dsh-patent-core` no longer exports `RuleEngine.rankResults`, `RankedRiskItem`, `SEVERITY_WEIGHTS`, or `STATUTE_WEIGHTS`. `@deepseek-ai/dsh-patent-tools` no longer exports `extractAbstractDrawingNumber` or `BASE_SECTIONS`. `isElectricalIpc` and `isElectricalCase` disappear from `@deepseek-ai/dsh-patent-workflow`.

`patent_plan_task` now accepts case-docket entries: `issues` (each with `id`, `summary`, `kind`, and optional `disposition`, `blocking`, `status`, `round_opened`, `anchor`), `round` (required with `issues`), `rounds`, and `maxRounds`. A transition resolves each draft against the shipped kind → disposition table, echoes the resolved `issues`, and refuses `executing` while a blocking entry is open or `replanning` while a terminal entry is open or the cap is reached.

Anyone importing the removed symbols, or dispatching and replanning tasks through `patent_plan_task`, is affected.

## Migration

1. Drop imports of the removed symbols. Use `SPEC_SECTION_HEADINGS` (or `requiredSections()`) instead of `BASE_SECTIONS`, `parseFigureNumber` and `knownFigureNumbers` instead of `extractAbstractDrawingNumber`, and the IPC classification that `inferTechnicalField` already returns instead of `isElectricalIpc` and `isElectricalCase`.
2. For a ranked risk list, rank in your own consumer from `RuleEngine.evaluate()` results; severity and statute weights no longer ship.
3. Replace `parseCheckerVerdict` with the review outcome your checker worker returns, and validate it at your own model-JSON boundary.
4. When a plan carries case-docket entries, pass `issues` with a 1-based `round`, and carry each item's `status` and `round_opened` back on the next transition; closing a blocking item is what unblocks `executing`.
5. Run `pnpm exec vitest run packages/patent/patent-core packages/patent/patent-workflow packages/patent/patent-tools` and confirm your build typechecks after the import changes.
