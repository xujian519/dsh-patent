# Agent Note: Disclosure problems and insights come from one extraction call

Status: implemented

English | [中文](2026-10-28-disclosure-extraction-pairs-by-problem.zh.md)

## Problem

`patent_disclosure_v1` ran four independent `extract` calls — problems, features, effects, insight — and `merge` paired them by array index. The insight call's prompt required “逐条按 problems 的顺序对应”, but that call never received `problems`; the ordering was a promise the prompt could not keep. When the model returned insights in a different order or count, `MergeHandler` attached them to the wrong problems or dropped the surplus without a signal.

The four calls also resent the whole disclosure: at the 8,000-character truncation limit their prompts totaled 32,613 characters, of which 24,051 were three repetitions of the same source (73.7%).

## Decision

`extract` gains an `output_mode` parameter whose only value is `problem_insight`. One call returns the pairs, and `ExtractHandler` writes them as `problem_insight` plus a `problems` projection:

```json
{"problem_insight": [{"id": "P1", "problem": "…", "insight": "…"}]}
```

`insight` is optional per entry: a problem without a mechanism-level insight is a normal result, not a failed extraction. `id` is model-assigned, must be unique within the output, and exists for validation and diagnostics; `merge` still assigns `T{n}` so snapshots and violation messages do not track model-chosen names. `parent` is optional and names the upper entry within the same list, which makes that list a forest; [the group parent link](../architecture/2026-11-26-pfie-group-parent-link.md) owns the hierarchy rule and the readings it drives.

Parsing fails the whole stage on a non-array, a non-object entry, a missing or empty `id`/`problem`, a duplicate `id`, a non-string `insight`, or a `parent` that self-references, points at an absent id, or closes a cycle. Keeping the valid entries would let `merge` construct groups from half an extraction while the summary still looked complete.

`merge` prefers `problem_insight`: each entry becomes one `PFETriple` carrying its own problem and insight, with the index-matched feature and effect; surplus features and effects still attach to the last group. When `problem_insight` is absent — legacy state, or a plan that runs only the per-key extractions — the index path remains. When it is present but invalid, merge degrades rather than falling back, so malformed pairing cannot pass as index pairing. `merge_result` ends with `（配对: problem_insight）` or `（配对: index）`, which states in the run record which path produced the groups.

`patent_disclosure_v1` retires `extract_insight` (22 → 21 stages, 10 → 9 model stages). `extract_problem` carries `output_mode: problem_insight`, and both rewind targets (`consistency`, `legal_gaps`) still point at it, so a rewind re-extracts problems and insights in one call.

MTU guidance is injected only when `output_key` is `features`, not when `extraction_type` contains 特征. The text test would have added MTU rules to any stage whose instruction mentioned features, including the paired extraction.

`output_key: 'insight'` remains for plans that extract slots independently; its schema no longer claims problems-order alignment, and `insight` stays in merge's index path for states it writes.

## Alternatives considered

**Keep four calls and inject problems into the insight prompt.** This repairs the promise without saving a call and adds a serial barrier inside the parallel extraction window: insight would wait for problems to finish.

**Merge all four extractions into one call.** It saves the most characters but concentrates the output in one response, risks truncation, forces the MTU rules to be scoped or dropped, and has no repository evidence that one-pass extraction preserves quality.

**Pair by an id repeated across two calls.** Problems and insights would still be generated separately; consistent ids across two independent generations are a weaker guarantee than one generation producing both fields in one entry.

**Fail merge when the `problems` projection and `problem_insight` disagree.** The projection is derived from the pairs in the same handler, so disagreement only comes from stale or hand-edited state; the pair list is authoritative.

## Consequences

A disclosure run makes one fewer model call and sends about a quarter fewer prompt characters; a rewind re-sends three extractions instead of four. A problem and its insight cannot be misaligned by array order because the insight travels in the same entry.

The problem call's output is longer, and malformed pair output degrades the whole extraction instead of losing one insight. The `problems` projection is kept because `draft-specification` and the legal-gap revision collection read `state.problems`.

## Testing

`packages/patent/patent-core/tests/extract-atom.spec.ts` covers the paired output, the `problems` projection, the invalid-entry table, the revision-coverage combination, and the conflicting `output_mode`/`output_key` configuration.

`packages/patent/patent-core/tests/atoms.spec.ts` covers entry-order-independent pairing, precedence over the `problems`/`insight` projections, surplus features and effects, absent insights, the degraded malformed case, and both pairing labels. `workflow/stage-outputs.spec.ts` pins that `problem_insight`, `problems`, and `revision_coverage` are cleared on rewind.

`packages/patent/patent-workflow/tests/manifest-atoms.spec.ts` runs the real extract → merge handoff with pairs returned in reverse order, and `disclosure-extract-cost.spec.ts` pins three calls, one source copy per prompt, and a total below the four-way baseline. `packages/patent/patent-tools/tests/patent-workflow-run.spec.ts` runs the shipped manifest end to end and asserts the three extraction stages and merge do not degrade.

## Related

[The insight slot and the PFIE consistency atom](../architecture/2026-10-17-pfie-insight-slot-and-consistency-atom.md) records why the slot exists; this note records how the disclosure manifest produces and pairs it.
