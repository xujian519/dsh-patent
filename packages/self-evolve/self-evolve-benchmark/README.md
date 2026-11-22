---
description: "The **`BenchmarkEvolveEngine`** is the provider of `ctx.selfEvolveBenchmark`. It adds a quantitative target dimension to the self-evolve capability: a benchmark is a bounded set of cases, each scored against a private rubric, and the provider optimizes the agent state under a strict improve-or-rollback policy backed by whole-state snapshot versioning. This complements `ctx.selfEvolve`, which mines failure patterns from the session stream, with an objective score a loop can chase."
kind: "package-reference"
---

# @deepseek-ai/dsh-self-evolve-benchmark

English | [中文](README.zh.md)

## Summary

The **`BenchmarkEvolveEngine`** is the provider of `ctx.selfEvolveBenchmark`. It adds a quantitative target dimension to the self-evolve capability: a benchmark is a bounded set of cases, each scored against a private rubric, and the provider optimizes the agent state under a strict improve-or-rollback policy backed by whole-state snapshot versioning. This complements `ctx.selfEvolve`, which mines failure patterns from the session stream, with an objective score a loop can chase.


## Table of Contents

- [Role](#role)
- [Configuration](#configuration)
- [Public API](#public-api)
- [On-disk layout](#on-disk-layout)
- [Optimization loop (C1 + C3)](#optimization-loop-c1--c3)
- [Statement/rubric separation (C2)](#statementrubric-separation-c2)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Role

| Package | Role |
|---|---|
| `@deepseek-ai/dsh-self-evolve` | Service Definition: abstract `SelfEvolveEngine` + durable events |
| `@deepseek-ai/dsh-self-evolve-basic` | Service Provider: projection-driven idle-pressure evolution over failure patterns |
| `@deepseek-ai/dsh-self-evolve-benchmark` (this) | Service Provider: benchmark-driven target evolution with snapshot versioning |

## Configuration

`BenchmarkEvolveConfig` controls where benchmark data lives and the defaults the public methods fall back to:

| Field | Default | Semantics |
|---|---|---|
| `baseDir` | `~/.dsh/self-evolve-benchmark` | Data root for benchmark stores and snapshots (`$DSH_HOME` overrides `~/.dsh`). |
| `agentStateDir` | required | Agent-state directory snapshotted before each candidate round and restored on rejection. Construction rejects a relative path, a path that is not a directory, and a path equal to `baseDir`, `cwd`, the home directory, or a filesystem root; a non-empty directory must carry the `.self-evolve-benchmark` marker. |
| `runsPerCase` | `1` | Runs per case when a method does not specify one. |
| `maxRoundsPerLoop` | `1` | Default maximum candidate rounds per optimize loop. |
| `targetScore` | none | Default score goal for optimize loops; absent disables early acceptance. |
| `minImprovement` | `0` | Minimum aggregate gain over the reference an optimize round must reach to be accepted. `0` admits any strict gain; construction rejects a negative or non-finite value. |

## Public API

All work routes through a `BenchmarkEngineCore` whose seams are injected; the real defaults run over the `fork` subagent provider.

| Method | Contract |
|---|---|
| `runBenchmark(benchmarkId, options)` | Evaluate every case × `runsPerCase` against the current agent state and persist the aggregated `ScoreboardEntry`. |
| `establishBaseline(benchmarkId, options)` | A single-run benchmark entry, the reference an optimize loop must strictly beat. |
| `optimizeLoop(benchmarkId, options)` | Optimize under improve-or-rollback, accepting a round only at a gain of at least `minImprovement` (default 0, any strict gain); without a reference entry (explicit or latest scoreboard) it fails loud. |
| `readScoreboard(benchmarkId)` | All persisted entries for a benchmark, oldest first. |

The service is programmatic only, so the package also subpath-exports a function plugin at `@deepseek-ai/dsh-self-evolve-benchmark/baseline-driver`. Mount it beside the provider to run one baseline from a profile without an interactive session: it waits for the loader, creates one idle parent Agent for the `fork` seams, calls `establishBaseline` with the profile's current model selection, prints the scoreboard entry as JSON on stdout, and requests process exit — code 1 with a `dsh:` diagnostic on stderr when the run rejects. Its config takes `benchmarkId` (required) and `runsPerCase` (default 1). [examples/patent-oas](examples/patent-oas/README.md) ships the overlay that boots it over the shipped `self-evolve` profile.

## On-disk layout

```
<baseDir>/
├── benchmarks/<id>/
│   ├── benchmark_config.yaml   # { title }
│   ├── <caseId>/statement      # public task text — the only input a target agent sees
│   ├── <caseId>/rubric         # private scoring standard — a physically separate file
│   └── scoreboard.yaml         # versioned entry history
└── snapshots/v<version>.tar.gz # whole agent-state snapshot, excluding .vault.toml
```

## Optimization loop (C1 + C3)

Each round of `optimizeLoop` mints a fresh snapshot version (versions only increase and never recycle), packs the current agent state, proposes one candidate against the reference using only the public statement surface, applies it, evaluates the full matrix, and accepts the round only when the candidate score beats the reference by at least `minImprovement` — its default of 0 admits any strict gain. The default apply seam forks an applier that returns the files to write — the child inherits the parent session's `workspace-write` sandbox, which denies writes under the home directory — and the seam writes those files inside the harness process after rejecting an absolute, `..`, or home-relative path. The seam digests the agent-state directory before and after the write; an answer whose content matches the current files leaves the digest unchanged and fails the round, so the loop never scores an unchanged state. A rejected candidate is rolled back to its snapshot, and a round that throws between snapshot and acceptance restores that snapshot before the error propagates. Rollback restores the snapshot's contents and removes files the rejected candidate created, while keeping `.vault.toml` and the `.self-evolve-benchmark` marker; archive entries are validated against absolute paths, `..`, and path traversal before extraction. Snapshot minting and scoreboard appends take the benchmark-level file lock, so concurrent writers see a complete previous or next file rather than a partial one. A case id or benchmark id loaded from disk must be a safe path segment (`^[A-Za-z0-9][A-Za-z0-9._-]*$`), and an evaluator score must be a finite number within 0–100 — it is rejected as a typed error rather than clamped.

## Statement/rubric separation (C2)

A case's `statement` is the only benchmark content a target or optimizing agent ever sees; the `rubric` is private and stored as a physically different file. The optimizer prompt states that the scoring standard is absent and instructs the child to stop and report contamination if it ever sees one, and `publicBenchmarkView`/`assertNoPrivateLeak` mechanically strip and guard the private vocabulary (`rubric`, `rubrics`, `gold`, `goldAnswer`, `expectedAnswer`) from optimizer-facing surfaces. The evaluator is the only role allowed to receive the rubric.

## Model Experience

### Default seam prompts

#### What the model sees

The provider registers no stable prompt section or tool schema; every model-visible contribution comes from the child requests its default seams fork. Each case run first forks one executor subagent told it is a task executor, handed the `statement` and the agent-state directory's guidance, and instructed to produce the deliverable text directly. The engine then forks one evaluator subagent told it is a benchmark evaluator and handed the `statement`, the deliverable, the private `rubric` (legitimate here, and only here), and an instruction to output exactly one JSON object with a numeric `score`. Each optimize round forks one optimizer handed only the reference score and the joined public statements — explicitly told the context contains no rubric — and one applier handed the candidate and the agent-state directory, told it may only read that directory, and asked to return the files to write.

#### Token effect

`runBenchmark` and `establishBaseline` spend one executor and one evaluator request per case run. Each optimize round spends one optimizer request, one applier request, and one executor and one evaluator request per case run, plus one filesystem snapshot. An evaluator answer with no recoverable JSON object costs one extra evaluator request.

#### KV Cache effect

These child prompts are request-local: their content varies with each case, round, and reference, so they never form a stable prefix for the parent request. The parent request prefix is unaffected by this provider.

## Known Limitations and Deferred Work

- **Live runtime required for the default seams** — execution, evaluation, proposal, and apply fork a child over `ctx.subagents`, which needs the `fork` provider and a live parent agent resolved through a `sessionId`; without them the loop fails loud rather than degrading. Consumers without the subagent runtime must inject their own seams.
- **Only an unparseable evaluator answer is re-forked** — an evaluator reply with no recoverable JSON object is retried once and then fails the round; every other child failure (ending before `completed`, a missing or out-of-range score, an applier that changed nothing) fails immediately. The executor's deliverable is free text (no JSON wrapper); only the evaluator must emit JSON.
- **Single-run scores carry multi-point noise** — three repeated evaluations of one unchanged agent state scored 94, 100, and 98 on the same case, so a per-case difference of a few points can be noise. Decide candidate quality with a `runsPerCase` of at least 3 compared by mean, evaluate the reference under the same `runsPerCase`, and set `minImprovement` above the observed noise; the defaults of `runsPerCase: 1` and `minImprovement: 0` accept a round on any strict aggregate gain and cannot tell a real gain from noise on their own.
- **Snapshot versions never recycle** — monotonic `max + 1` minting is deliberate (a rejected round's archive stays on disk as evidence), so long-lived loops accumulate archives until the caller prunes them.
- **No UI or CLI surface** — this is a programmatic service; nothing in `dsh` exposes it yet.
- **No keyed end-to-end verification** — the default seams are exercised through unit tests that mock the subagent runtime; a live `dsh --profile` loop run requires a keyed environment.
- **Live parent agent must be resolvable by session id** — the engine threads a `sessionId` through the seams, not a direct agent reference; callers that hold an `Agent` must map it to a session first.

### Dev Note

None.
