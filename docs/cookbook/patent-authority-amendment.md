---
description: "Carry one patent-law amendment through the change record, the index, the rules, the templates, and the evaluation."
---

# Cookbook: amending the patent authority index

English | [中文](patent-authority-amendment.zh.md)

Use this after a statute, implementing regulation, or examination-guideline amendment reaches the shipped index. The [authority decision](../../.agents/notes/implemented/architecture/2026-11-13-patent-authority-60-day-plan.md) records why the index is the fixed side. The rehearsal command runs the five steps against the 2026 guideline amendment that is already in the tree.

## Steps

1. Record the amendment before changing decisions. For a guideline amendment, update `packages/patent/patent-law/assets/authority/guideline-changes-2026.yaml` so it names the revision and its renumberings. For a statute, update the lineage asset the package already loads. Confirm the file names the revision that is coming into force.

2. Update the index in `packages/patent/patent-law/assets/law/`. Transcribe the new text, point `supersededBy` at the revision that is in force, and add an old path to `staleSections` only when that path's shipped text no longer matches the current edition. Run `pnpm run verify-patent-law-freshness` and `pnpm run verify-patent-law-coverage`.

3. Update every packaged rule whose `legalBasis` cites a changed provision, then run `pnpm exec tsx scripts/verify-patent-rule-citations.ts`. A statute or guideline citation that the index rejects fails the command.

4. Update `packages/patent/patent-law/assets/authority/rule-procedure-alignment.yaml` when a rule family, a procedural computation, a document template, or a workflow manifest implements the changed provision. Run `pnpm exec tsx scripts/verify-patent-rule-alignment.ts`.

5. Add or adjust a task in `packages/patent/patent-law/assets/authority/authority-eval-tasks.yaml` so the new text is a required citation and the retired wording is a refused formulation. Run `pnpm run patent-authority-eval` and `pnpm run patent-authority-closeout`. Citation accuracy stays at or above 98%, and wrong formulations stay at zero.

Confirm the whole path with `pnpm run rehearse-patent-amendment`. It fails when any of the five steps is missing from the packaged 2026 amendment.
