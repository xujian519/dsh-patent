# Agent Note: Noise-aware thresholds for the patent-oas regression gate

Status: implemented

English | [中文](2026-11-07-patent-oas-noise-aware-thresholds.zh.md)

## Problem

[The 2026-09-26 note](2026-09-26-patent-oas-problem-space-gate.md) gave the gate a fixed allowed drop: 5 for a node, 3 for a case and for the aggregate. It compared one fresh capture against one recorded baseline, so the threshold assumed both numbers were measured precisely enough for a 5-point difference to mean something.

The 2026-11-07 capture, which added the invalidation and reexamination cases, rejected three units: `claim-form-and-support` at 88.7 against 94.1, `technical-problem` at 91.8 against 97.1, and the `claim-drafting` case at 94.7 against 98.0. Nothing in the benchmark had changed — the profile, the statements, and the rubrics were byte-identical to the baseline's. Repeating the measurement showed that the threshold, not the deliverable, was the problem. The same `claim-drafting` dimension — form and specification support — measured 80.0, 94.0 and 86.7 across three captures on separate days, with within-capture sample standard deviations up to 10. A five-point drop is one to two standard errors of the difference, so whichever unit the day's noise landed on, the gate rejected it: with 32 graded units, a false alarm rate in that range fails some unit on most captures. The baseline's own record shows the same instability from the other side: dimensions that read `[100, 100, 100]` on 2026-11-02 read `[100, 100, 88]` on 2026-11-07.

## Decision

**The allowed drop is measured in noise units.** `gate.yaml` may set `thresholds.noiseMultiple: k`, and the allowed drop for a node, a case, or the aggregate becomes `max(maxDrop, k × SE_Δ)`, where `SE_Δ = sqrt(SE_current² + SE_baseline²)` and each `SE = stdev / sqrt(n)` over that record's per-run scores. Both sides must carry complete per-run scores; a side that does not falls back to `maxDrop`, so a record predating `scores` keeps its old reading. Because the allowance is a maximum, a unit whose runs agree exactly — most dimensions read 100 on every run — keeps the fixed threshold. The verdict prints the effective allowance whenever it exceeds `maxDrop`, so a passing unit that dropped further than `maxDrop` still says so.

**`k = 2.5`.** This number was chosen after the capture above, and the ordering is stated rather than hidden: it was not pre-registered. What keeps it from being a search for a passing threshold is that it is one number applied to every node, case, and aggregate, that it never tightens the result below `maxDrop`, and that the capture which motivated it is the capture that becomes the new baseline — so the rule's first use is to judge data that no later comparison depends on. From the next capture onward the multiple is fixed in `gate.yaml` and the baseline carries the measured variance, which is the pre-registered form this decision ought to have had.

## Alternatives considered

**Raise `maxDrop` to larger fixed numbers.** Rejected: nodes differ by an order of magnitude in measurement precision, and one constant would be too loose for the units that repeat exactly and too tight for the ones that swing. The rule has to read the record, and the record already stores what it needs.

**Raise `--runs` within a capture.** Rejected: the dominant noise is between captures, not within one. Three captures of the same dimension differed by 14 points while each capture's own three runs agreed far more closely; averaging more runs inside one capture cannot reach variance that lives between them.

**Exempt the two failing nodes through the surface policy.** Rejected: an exemption removes a node from case and aggregate weighting, so the gate would stop seeing it rather than judge it, and neither reading was below its absolute floor.

**Re-record and keep the fixed thresholds.** Rejected: the next capture would reject a different unit for the same reason, and the baseline would be re-recorded whenever the dice landed badly — which is the practice the fixed threshold was meant to prevent.

**Compare against a rolling mean of several captures.** Rejected as wider than the problem: it changes the record format and the promotion path, and a rolling mean of noisy captures would carry a variance the gate still has to interpret.

## Consequences

- `pnpm run verify-patent-oas-gold` accepts a drop up to the noise allowance, and prints `容限 <n>` on that line. A unit that keeps the fixed threshold prints nothing, so the extra room is visible wherever it is granted.
- The 2026-11-07 baseline (seven cases, aggregate 96.43) is recorded from the capture that motivated this rule. `claim-form-and-support` at 88.7 and `technical-problem` at 91.8 are now the references, and their measured variance is what the next comparison reads.
- A unit whose baseline was recorded tightly but whose next capture is noisy gets a wide allowance. That is the correct reading — the comparison genuinely cannot resolve the difference — but it means a real regression can hide behind newly noisy measurement until the baseline is re-recorded.
- `thresholds.noiseMultiple` is optional; a config without it behaves exactly as before, and `scripts/patent-oas-gate.spec.ts` pins both the allowance and the fallback, including the case where only one side has per-run scores.
