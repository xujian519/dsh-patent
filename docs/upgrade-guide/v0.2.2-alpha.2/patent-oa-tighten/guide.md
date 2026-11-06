---
kind: upgrade-guide
description: "The Office-action chain gained a model-backed `tighten` stage between `draft` and `slop_gate`: answers are cut to the length budget, the cut verified by character count, and downstream stages now read `draft_tightened`."
---

# Office-action answers are now cut to budget before they are checked

English | [中文](guide.zh.md)

## Change

`patent_oa_response_v1` goes from 14 stages to 15: `tighten` runs between `draft` and `slop_gate`, and since it calls the model, model-backed stages go from four to five.

```ts ignore-check
{ id: 'tighten', atom: 'tighten',
  params: { text_key: 'draft', plan_key: 'response-plan', char_budget: OA_RESPONSE_DRAFT_BUDGET.total } }
```

The stage reads the finished answer (`text_key`, default `draft`), the plan (`plan_key`, default `response-plan`) and a budget, and writes three keys: `draft_tightened`, `tighten_report` (a line per removal: what went, why it could go) and `tighten_violations`.

Unlike a prompt-only polish pass, it does not trust the model's account of its work. `visibleChars` — the same measure the slop gate uses, now exported from `slop-engine.ts` so the two cannot drift — is counted before and after. The stage passes only if the result is shorter than the input and inside the budget. An empty result, a longer one, or one still over budget turns into `[WORKFLOW_DEGRADED]`, naming how many characters are still to cut; the over-budget case also writes `tighten_violations`. A response that claims "trimmed" and changed nothing is not accepted as trimmed. A body already inside the budget is returned unchanged, no model called.

The prompt is narrow: delete only, no new argument, no change to fact, rule, evidence or paragraph numbers, section order preserved, a section emptied of content deleted whole, not left as a placeholder. Removal order is restatement of the office action, then restatement of statute, then facts unrelated to the issues, then the second telling of an argument.

Format is tolerated, not enforced: a `{ tightened, removed }` object is used as given, and a bare body is accepted too, the report noting the list was missing. Only the count decides.

Downstream reads moved: the gate judges `draft_tightened`, `response_check` takes `response_key: 'draft_tightened'`, and `adversary-review` reads `draft_tightened`, then `draft`, then `final_draft`. Every one of them falls back, so a degraded `tighten` costs the cut, not the checks.

## Migration

1. Anything counting stages of this chain — dashboards, snapshot expectations, `workflow status` — now sees 15 stages and five model-backed. Both snapshot scenarios were re-recorded, so replays change.
2. A manifest of your own gets no `tighten` for free: add the stage after `draft`, or point `text_key` at your own key.
3. If you read `draft` downstream, read `draft_tightened` and keep `draft` as the fallback; the stage may legitimately degrade.
4. A degraded stage is not a failed run: the workflow completes with `draft` in place of `draft_tightened`. Read `tighten_violations` to see the remaining overrun, then fix the section that caused it.
5. `char_budget` is fed from `OA_RESPONSE_DRAFT_BUDGET.total` (4000 visible characters, an initial calibration). Change it there, not per case; the slot quotas in `patent-oa-slot-quotas` are derived from the same table.
