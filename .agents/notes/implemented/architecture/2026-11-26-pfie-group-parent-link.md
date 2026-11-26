# Agent Note: A parent link turns the PFIE group list into a forest

Status: implemented

English | [中文](2026-11-26-pfie-group-parent-link.zh.md)

## Problem

`patent_disclosure_v1` extracts technical problems as a flat list. A disclosure that states one general concept and then its lower-level realizations still arrives as sibling entries: `merge` numbers them `T1..Tn`, and the reading "this problem is a decomposition of that one" is gone before any later stage runs.

Two downstream judgments need that relation. `pfe-consistency` reported `pfe-problem-without-solution` on an upper group whose features sit in the lower group that implements it, so a correct decomposition read as a gap. `claim-strategy` had no signal about which group is the concept to protect and which is one way of carrying it out, so the independent claim could be written against a lower-level problem and the dependent tree lost the reason it exists.

The [insight-slot note](2026-10-17-pfie-insight-slot-and-consistency-atom.md) made `insight` optional so a plan that extracts none still runs. A hierarchy is the other half of that decision: once a group is cited as a parent, the pipeline asserts a mechanism exists above it, and that slot can no longer be empty by the same tolerance.

## Decision

`ProblemInsightEntry.parent?: string` names the upper entry inside the same paired output that [the pairing decision](../bug-fix/2026-10-28-disclosure-extraction-pairs-by-problem.md) introduced, so grouping costs no additional model call. `parseProblemInsight` requires the references to form a forest — a self-reference, a dangling id, or a cycle fails the whole group exactly as a malformed entry does, and `null` or whitespace reads as top-level. `MergeHandler` rewrites the entry ids onto the groups it emits as `PFETriple.parentId?`.

No container group is synthesized: a triple without `parentId` is a top-level concept, and `readPfeHierarchy` derives `{ roots, maxDepth, children }` from the triples on demand. The index path (`problems[i] ↔ features[i]`) has no parent information, so it reports no hierarchy; `merge_result` states root count and longest chain only on the `problem_insight` path.

`pfe-consistency` now judges coverage over a subtree: `S⊨P` and `I⇒S` hold when the group or any descendant carries features, and an ancestor's detail names its children (`（含子组 T2、T3）`) so a rewind can locate them. Leaf groups keep their previous wording. The closed set gains a fourth id:

| id | predicate |
|---|---|
| `pfe-parent-without-insight` | the group has at least one child and no insight |

Unity is a reading, not a violation. More than one root is a drafting finding that re-running `extract_problem` cannot settle, and `consistency` has one retry to spend, so `roots` and `maxDepth` travel in `pfe_consistency_report` instead of `PFE_CONSISTENCY_VIOLATION_IDS`. `pfe_consistency_summary` mentions the layering only when `maxDepth > 1`, because a clean summary must keep matching none of `不一致|矛盾|缺少|孤立`.

`claim-strategy` declares `pfe_consistency_report` as an input and reads those two numbers rather than walking the parent chain a second time. Its report gains a hierarchy line, and a unity note whenever roots exceed one. Its prompt states the drafting rule: essential features cover every top-level entry, a lower entry's features enter the optional table under the claim that carries its parent, and top-level entries sharing no special technical feature leave one independent claim with the others recorded as division candidates in `notes`.

## Alternatives considered

**Add a model stage that assigns a parent key to each group.** Rejected: it was the original plan, and it costs a stage for grouping information the existing pairing call can emit. One more stage takes `patent_disclosure_v1` from 29 to 30, which moves `DEFAULT_WORKFLOW_STAGE_BUDGET` and needs an upgrade-guide entry; the new atom would also have to join the inventory in `patent-flexible-plan.ts`, whose tool description is pinned in `snapshots/session/patent-oa-response/tool-schemas.expected.json` and would need re-recording with a key.

**Synthesize a `T0` root that owns the top-level groups.** Rejected: a container with no problem, features, or effects trips `pfe-problem-without-solution` on the first pass, so it would need an exclusion everywhere `pfe_triples` is read — the five handlers that consume the value, the draft-review isolation list, and two further atom declarations — for a row that exists only to be pointed at.

**Write `parentId: null` on roots.** Rejected: absence already means "no parent" for every other optional triple field, and an explicit `null` gives readers two states to test for one fact.

**Make multiple roots a violation id.** Rejected: the rewind it would trigger re-extracts problems and insights, which is not how a unity question gets answered, and the retry budget belongs to the violations re-extraction can fix.

**Require an insight on every group.** Rejected: an improvement-type invention legitimately has no mechanism statement, and a mandatory field would degrade plans that never pair problems with insights. The obligation applies only where the hierarchy itself claims a mechanism sits above a group.

## Consequences

The representation is forward-compatible without a migration. A recorded `problem_insight` array without `parent` parses, yields a flat triple list, and produces the violation set and summaries it produced before; only a run whose model output declares parents can produce a `parentId` or the fourth violation id.

Model-visible text grows on the pairing path alone: `extract_problem`'s prompt gains the forest rule and the example key, which keeps its three extraction prompts under the 32,613-character four-call baseline `disclosure-extract-cost.spec.ts` pins for an 8,000-character disclosure. `JSON.stringify(pfe_triples)` feeds the quote stages, so `parentId` reaches those prompts and remains reconstructable from the logged `problem_insight` output that merge read.

Grouping does not reach keyword generation: `formatPfeTriples` renders one flat line per group for the `keywords` and `search` prompts, so those stages keep seeing an unordered list. Extending that renderer is a separate change with its own prompt-budget evidence.

Whether a child really is a lower-level decomposition of its parent is not decidable by a deterministic rule; it stays with the inventor-confirmation step the disclosure-understanding skill requires. The hierarchy line and unity note are drafting prompts for the attorney, and a wrong grouping surfaces as a mis-layered dependent tree, which `draft-review` still reads against A26.4 and A31.1.

## Testing

`packages/patent/patent-core/tests/extract-atom.spec.ts` covers the forest rules at the parser: a non-string, dangling, self-referencing, or cyclic `parent` degrades the stage and names the entry id, while `null` and whitespace drop the key and a valid parent passes through.

`packages/patent/patent-core/tests/atoms.spec.ts` covers the same failures on the merge side, the entry-id to triple-id conversion, the absent key on roots, and that the index path emits no hierarchy clause.

`packages/patent/patent-core/tests/pfe-consistency.spec.ts` covers subtree coverage one and two levels deep, a whole-subtree gap with children named in the detail, the new id isolated from the other three, a leaf group without insight staying unaffected, flat input producing no hierarchy wording, a hand-built cyclic `parentId` terminating, and the handler's `roots`/`maxDepth` report fields with a clean multi-layer summary that still misses the retry signal.

`packages/patent/patent-core/tests/claim-strategy-atom.spec.ts` covers the report rendering for layered, single-layer, absent, and unreadable readings, and the prompt rules. `packages/patent/patent-workflow/tests/manifest-atoms.spec.ts` wires `extract` → `merge` → `pfe-consistency` → `claim-strategy` with one faked model output and pins that `claim-strategy` declares the consistency report as input and runs after it.

`pnpm run typecheck`, the patent suites, and `pnpm run test:snapshot` pass after the change. The `ptc-script-imports` headless replay fails identically with and without this change on the same host and is excluded from that statement.
