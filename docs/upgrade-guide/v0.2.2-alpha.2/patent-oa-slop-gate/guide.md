---
kind: upgrade-guide
description: "The OA chain gains a `slop_gate` stage with a one-shot rewind; the gate takes configurable text keys and a char budget."
---

# The slop gate now covers the answer body

English | [中文](guide.zh.md)

## Change

`patent_oa_response_v1` goes from 13 to 14 stages: `slop_gate` follows `draft`, and the model-backed count stays at four: the gate is deterministic. A later `tighten` makes it 15 stages, five model-backed.

```ts ignore-check
{ id: 'slop_gate', atom: 'slop-gate',
  params: { text_keys: ['draft'], char_budget: OA_RESPONSE_DRAFT_BUDGET.total },
  retry: { whenOutputMatches: '需修订', rewindTo: 'draft', maxRetries: 1 } }
```

A rewind redoes only the draft, not `adversary-review`. The gate rewinds once with its evidence-only hint; a second failure marks the stage `[WORKFLOW_RETRY_EXHAUSTED]` (degraded) instead of looping.

`slop-gate` (`packages/patent/patent-tools`) no longer hard-codes its input: `text_keys` (default `['claims_draft']`) picks the state keys, `char_budget` declares the budget. Without one it behaves as before: the claims chain is unchanged.

Concision dropped its paragraph count: `> 15 paragraphs → 5/8` penalised every eight-section answer. It now compares visible characters to the budget — inside `8`, under 1.25× `6`, under 1.5× `4`, beyond `3`; this dimension only asks whether the text respects its budget.

Four detectors read legal prose as slop:

- **directness** reads the opening *prose*, skipping headings, the biblio header (`申请号：`…), block quotes and markup-only lines — the first 200 raw characters always landed on the header, scoring every answer 4/8. A formulaic plea (「恳请审查员重新考虑」) scores 5 even when it names the issue; dispute words include 「异议」「驳回」.
- **evidence** opens at a neutral 5/10; with a budget the short-paragraph point is dropped and a text citing nothing is capped at 4 — two sentences citing nothing used to collect that bonus.
- **empty_three_step** fires only without an evidence anchor (`D1`, `¶0123`, claim number, statute, `F2`/`P1`, `见 3.1 节`); headings and table delimiters are skipped.
- **passive_voice** skips lines naming the actor before the passive clause; **reason_pile** counts distinct provisions, not citations.

`example.html` changed twice so the reference answer passes its own gate: the position section no longer opens with 「申请人恳请审查员重新考虑…」, and a reply bullet anchors the distinguishing feature as `F2`.

Calibration readings:

| Document | Old gauge | New gauge |
| --- | --- | --- |
| `example.html`, 3.1k chars | 33, fail | 42, pass |
| Snapshot draft, 8.4k chars | 35, pass | 33, fail |
| Two-sentence plea, no citation | 35, pass | 33, fail |

## Migration

1. Re-baseline `slop_score` readings for the OA chain; the claims chain is unchanged.
2. Pass `char_budget` explicitly when wiring the gate elsewhere (same constant as the draft prompt) and point `rewindTo` at the stage producing the judged text.
3. `rewindTo` must not cross an approval gate — validation rejects it; keep the gate before `approval`.
4. Ignore `state.slop_revision_hint`: kept out of `outputSchema` on purpose, so the rewind does not clear it before the draft re-runs.
5. This change re-recorded `patent-oa-chain` and refreshed `patent-oa-response`; re-record with the neighbouring changes, not per stage.
