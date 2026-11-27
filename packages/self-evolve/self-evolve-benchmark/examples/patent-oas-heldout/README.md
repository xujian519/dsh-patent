# patent-oas-heldout Example Benchmark

English | [中文](README.zh.md)

A held-out companion to the `patent-oas` example benchmark for `@deepseek-ai/dsh-self-evolve-benchmark`, benchmark id `patent-oas-heldout`. Its `benchmark_config.yaml` declares `optimizable: false`, so `optimizeLoop` refuses it after loading and before any snapshot or candidate: the optimizer never sees its statements or per-case scores. Measurement is unaffected — `establishBaseline` runs it like any other benchmark.

## Why it exists

`patent-oas` is both the gate benchmark and the optimization target: the optimize loop reads every case statement and every per-case score, so a rising gate score can mean the agent state was tuned to those seven cases rather than that the work improved. This benchmark is the control measurement: optimize on the dev surface (`patent-oas`), and read this one before and after to see whether the gain transfers to cases the optimizer never saw. The case statements restate two public granted texts from the `patent-oas` corpus record (CN202023432U for the OA case, CN213535478U for the drafting case) in the same self-contained form as the dev cases; the rubrics are hand-written to the same dimension split.

## Cases

| case | task | scored dimensions |
|---|---|---|
| `heldout-oa-answer` | Office-action response over a lock mechanism, two rounds like the dev `oa-answer` (the scripted second review opinion lives in `rounds/02/statement`) | distinguishing features, technical problem, teaching, conclusion and statute, search and format, amendment grounding |
| `heldout-claim-drafting` | Disclosure → claims over a folding box: independent claim + dependent layout | essential features, scope, dependent layout, reference hierarchy, form and support |

Two cases support a directional before/after reading only. They are not a gate, carry no thresholds, and no statistical conclusion is drawn from them; the expert-calibrated set is deferred work.

## Boundary: prompt/history isolation, not a sealed set

`optimizable: false` guarantees only that the optimize loop's prompt surface (statements) and history (per-case scores) never include this benchmark. It does not make the data root unreachable: an agent process with file tools may still read `~/.dsh/self-evolve-benchmark/patent-oas-heldout`. Treat the readings as contamination-resistant, not contamination-proof; a genuinely sealed set lives outside the repository.

## Seeding and measuring

```sh
node seed.mjs [baseDir]
pnpm dsh --profile self-evolve \
  --patch packages/self-evolve/self-evolve-benchmark/examples/patent-oas-heldout/baseline.overlay.yml \
  baseline
```

`seed.mjs` copies `benchmark_config.yaml` verbatim (preserving `optimizable: false`) and each case's `statement`/`rubric` into `<baseDir>/benchmarks/patent-oas-heldout/`; it seeds no agent state, because the measurement reuses the `patent-state` directory the dev benchmark optimizes — the overlay's `agentStateDir` points there, so a before/after pair reads the same state. The protocol: run the baseline once before `optimizeLoop('patent-oas', …)`, run it again after, and compare the two scoreboard entries. Held-out scores never enter gate thresholds and are never an optimize reference.
