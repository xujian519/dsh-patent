# Agent Note: An Insight slot in the disclosure pipeline and a deterministic PFIE consistency atom

Status: implemented

English | [中文](2026-10-17-pfie-insight-slot-and-consistency-atom.zh.md)

## Problem

`patent-disclosure-understanding` turns a disclosure into a PFE triple — problem, feature, effect — and that triple is the input baseline for search, novelty/inventiveness analysis, and drafting. Two gaps.

Nothing in the pipeline asks why the feature combination works. The mechanism-level understanding that makes the combination non-obvious has no slot, so it exists only in prose no later stage reads.

The `consistency` stage of `patent_disclosure_v1` declares "PFE 一致性检查（特征-效果因果链闭合、无孤立特征）" and declares no `atom`. `runStageOnce` sends a stage without `atom` to the caller's executor, so the check is a free-text self-report with no predicate behind it. `MergeHandler` pairs the extraction runs by array index, which constructs `problem[i] ↔ features[i]` instead of verifying it: a run with more problems than features produces groups whose feature list is empty, and nothing reports that.

The insight slot must not reach the three-step method's "实际解决的技术问题". 《专利审查指南》第二部分第四章 3.2.1.1 requires that problem to be determined against the distinguishing features and to contain no solution means, and `INVENTIVENESS-PROBLEM-SOLUTION-BINDING` already blocks that product through `checkAtomic`. The disclosure layer needs the cause blocked earlier, on a different text.

## Decision

`PFETriple` carries `insight?: string` — the mechanism-level reason a group's features work. It is optional, because `keywords`, `novelty` and `draft-claims` read only the problem and features, and a manifest that runs no insight extraction must not degrade.

`patent_disclosure_v1` produces the insight together with the problem it explains: `extract_problem` runs `extract` with `output_mode: 'problem_insight'`, and the handler writes the paired `problem_insight` array plus a `problems` projection. `MergeHandler` reads each pair as one group, so the insight needs no separate extraction and cannot drift out of problem order; [the pairing decision](../bug-fix/2026-10-28-disclosure-extraction-pairs-by-problem.md) records the change and its cost. `output_key: 'insight'` remains for plans that extract the slot independently, and merge's index path still pairs `insight[i]` with `problem[i]` for states written that way.

The `consistency` stage runs the deterministic atom `pfe-consistency` (`PfeConsistencyHandler`), a pure function over the merged groups. It reports four violation kinds, the closed set `PFE_CONSISTENCY_VIOLATION_IDS`:

| id | predicate |
|---|---|
| `pfe-problem-without-solution` | the group states a problem and neither it nor any descendant carries features (`S⊨P`) |
| `pfe-insight-without-solution` | the group carries an insight and neither it nor any descendant carries features (`I⇒S`) |
| `insight-encroaches-problem` | the group's problem fails `checkAtomic(problem).checks.noSolutionBinding` |
| `pfe-parent-without-insight` | the group has at least one child and no insight |

The descendant clause and the fourth id come from [the group parent link](2026-11-26-pfie-group-parent-link.md); on triples that carry no `parentId` both judges reduce to the single-group reading recorded here.

`insight-encroaches-problem` reuses `checkAtomic`'s no-solution-means predicate instead of adding a second pattern set: one predicate, two layers, two different texts — the disclosure problem here, the three-step problem in `INVENTIVENESS-PROBLEM-SOLUTION-BINDING`.

`consistency` no longer declares `consumes`. Only the no-atom executor's prompt assembly reads `consumes`, so on an atom stage it is dead data; `manifest-atoms.spec.ts` already rejects that combination.

`pfe_consistency_summary` is the atom's first output and therefore the text `workflow.ts` matches against `retry.whenOutputMatches` (`不一致|矛盾|缺少|孤立`). `signalMatches` skips a hit whose preceding 12 characters contain a sentence terminator or a negation word, so the summary opens with a signal word: a violating summary begins `四元组承接缺少结构支撑：…` with the counts and per-item detail after it, and a clean summary contains none of the four words.

The disclosure-understanding skill, the team and worker and role contracts, the patent preset persona, `patent-mode-design.md`, and the template skills that name the input table all read "PFIE 四元组" and name the insight slot. `patent-team-composition` and `docs/patent-workbench-tasks.md` list its four slots.

## Where this takes effect

`patent-disclosure-understanding`, the team contracts and the patent preset ship in `@deepseek-ai/dsh-web-app`; the atom and the manifest ship in `@deepseek-ai/dsh-patent-core` and `@deepseek-ai/dsh-patent-workflow`. The packaged app resolves all of them from `app.asar`, so a repository change reaches a running app only through a rebuild and repackage of the app bundle.

A global-layer skill provider cannot override the bundled skill. `SkillRegistry.collectFresh` merges `[global, ...chainLayers]` with `merged.set`, so a nearer layer replaces a farther layer's entry regardless of rank, and the preset's `skill-filesystem` row mounts in the preset's layer. Rank decides duplicates only within one layer, where that row's `customSkillDirs` root sits at rank 300 — above the user roots at 400 and 500. A same-name skill in `~/.agents/skills` therefore loses to the bundled one, and a differently named skill is a second skill rather than an override.

## Alternatives considered

**Leave the consistency check to the LLM stage.** It was already the arrangement in production and the patent domain's delivery gates measure a success rate of 0 for prompt-only obligations. A stage description is not a predicate, so leaving it in place would have changed nothing measurable.

**Test the insight text for encroachment instead of the problem text.** An insight is expected to name a mechanism (`通过设置限位凸台…`), which fails `noSolutionBinding` by construction, so that predicate would fire on every well-formed insight. The slot confusion to catch is an insight written into the problem slot, which is a property of the problem text.

**Add a `pise` session event and a monotonic guard now.** Deferred rather than rejected: it needs a verdict-bearing event because `deliveryGate` records a successful call rather than a passing verdict, and it is gated behind evidence that the insight slot pays off. That evidence could not be produced (below).

**Deliver to the running app by overriding `preset-patent` from the profile patch.** Rejected for now. A loader patch replaces `config` wholesale and `@deepseek-ai/dsh-agent-preset` is not `cordis:group`, so rows inside its `plugins` list cannot be targeted by id; the override would have to restate the entire preset. That pins the app's preset at its current content and shadows later preset and delivery-gate changes — the app's shipped preset already differs from this checkout by `structuralGate`.

**Make the insight field required.** `MergeHandler` runs for every manifest that extracts PFE, and a required field would degrade or fail runs that never extract an insight, for a slot whose benefit is unmeasured.

## Consequences

The structural limit is deliberate. `I⇒S` and `S⊨P` state field-presence and cross-reference facts; whether a mechanism actually carries a feature, and whether a feature set actually solves a problem, are not decidable by a deterministic rule and stay with the inventor-confirmation step the skill already requires. The atom never blocks on semantics, and its output says so.

`insight` has a producer, a consumer and a test in the shipped manifest. A field that no stage fills would be dead data.

Pairing the insight with its problem inside one extraction costs one model call, not two. A violation rewinds to `extract_problem` once (`maxRetries: 1`), which re-runs the three extractions and `merge`; problems and insights come from the same re-run call. The pairing note owns the prompt-character budget test.

`patent-workflow-run.ts`'s English tool description still summarizes the pipeline as "PFE extraction". That text is pinned in `snapshots/session/patent-oa-response/tool-schemas.expected.json`, and changing it would invalidate a keyless recording; the summary stays true because the pipeline still extracts problem, feature and effect. `flexible_plan`'s atom list does name `pfe-consistency`, because `registration.spec.ts` requires that list to cover every registered atom, and `docs/tool-catalog.md` is regenerated from it.

## Testing

`packages/patent/patent-core/tests/pfe-consistency.spec.ts` covers each violation kind, their isolation from one another, the closed-set drift guard, the degraded paths, and the retry contract: a violating summary matches the signal the manifest declares and a clean one does not.

`packages/patent/patent-workflow/tests/manifest-atoms.spec.ts` pins that `consistency` names the atom, carries no `consumes`, and produces output matching the `whenOutputMatches` it declares, and that `extract_problem` carries the pairing mode before `merge`.

`packages/patent/patent-core/tests/atoms.spec.ts` covers insight pairing, the absent-key case, surplus insights, and a group ending with an empty feature list. `packages/patent/patent-tools/tests/registration.spec.ts` covers the registry and the `flexible_plan` description.

`pnpm run typecheck`, the patent suites, and `pnpm run test:snapshot` pass after the change.

## Deferred

The evidence phase has no qualifying case. Comparing `SPEC-CONTENT-TRIPLE` triggers and rework counts before and after the insight slot needs two to three closed cases holding a disclosure, a finalized claim set and a search report; the available case directories hold at most two of the three, and `patent-workspace/CN2026-0904-01/04-撰写` is empty. The mandatory-attendance stage stays unbuilt until that evidence exists.
