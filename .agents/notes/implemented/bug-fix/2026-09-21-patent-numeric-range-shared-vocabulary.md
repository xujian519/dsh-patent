# Agent Note: One numeric-range vocabulary for specification validation and novelty analysis

Status: implemented

English | [中文](2026-09-21-patent-numeric-range-shared-vocabulary.zh.md)

## Problem

"Numerical range" is a vocabulary the patent domain needs in two places, and it was written twice with three disagreements between the copies. The novelty track's `packages/patent/patent-core/src/novelty/numeric-range.ts` matched a range whose unit is optional and read the unit from the text after the match, accepting the connectors `- – — ~ ～ 至 到`. The specification validator built its pattern from its own `UNITS` alternation and required a trailing unit, accepting only `~ ～ 至 - —`. Their unit normalization differed as well: the novelty side normalized `℃ / °c / °`, the tool side `℃ / °C / °` and not `°c`.

Each disagreement sent the two production consumers to opposite conclusions on the same sentence. `patent-core/src/graph/domains/novelty.ts` consumes the novelty-side extraction to build graph evidence for the novelty stage; the specification validator consumes the tool-side extraction to report on a draft.

- `温度为20℃至90℃`: the unit sits between the digits and the connector, so the novelty pattern did not match and the text degraded to the weak plain-number path — two strong numeric points instead of one range. The specification side recognized one range.
- `重量比50-80`: the specification pattern required a trailing unit and therefore did not recognize the range at all. The novelty side recognized it.
- `25°c`: normalized on the novelty side, neither normalized nor matched as a unit on the specification side.

The severity follows from which consumer is wrong, not from the size of the divergence: the novelty side feeds an examination conclusion, so a range that becomes two points changes which comparisons the novelty node can make.

## Decision

`packages/patent/patent-core/src/novelty/numeric-vocabulary.ts` owns the vocabulary, which both sides import from `@deepseek-ai/dsh-patent-core`.

- **`NUMERIC_RANGE_SEPARATOR_CLASS`** — the connector character class `~～至到–—-`, written for embedding in a larger pattern, with the hyphen last so it cannot be read as a range.
- **`NUMERIC_ANY_UNIT_ALTERNATION`** — the combined Chinese, Latin, and symbol unit alternation, longest spelling first so `5mg` cannot be read as `m` and `0.1-2MPa` cannot be read as `m`. It carries Chinese units such as `毫米` and the temperature spellings `°C`, `℃`, `°c`, and `°`.
- **`normalizeNumericUnit`** — the normalization, folding all four temperature spellings to `°` and returning every other unit unchanged.

Each side keeps its own pattern and its own acceptance rule on top of that vocabulary. The novelty side builds `RANGE_PATTERN` in `numeric-range.ts` from the shared class and combined alternation and stays permissive about the trailing unit, because a unitless range written through the connector is still novelty evidence. The specification side builds its pattern in `packages/patent/patent-tools/src/tool/spec-numeric.ts` and keeps the trailing unit required, because endpoint and midpoint coverage compares single values of the same unit and needs the range unit stated.

## Verification

`pnpm exec vitest run packages/patent/patent-core/tests/novelty/numeric-range.spec.ts packages/patent/patent-tools/tests/validate-specification.spec.ts` passes. `SHARED_VOCABULARY_CASES` in the specification suite holds twelve texts and asserts, per text, that the novelty extraction and the specification extraction return the same range boundaries and the same normalized unit, with the specification side's trailing-unit requirement as an explicit field of each case rather than an accident of its pattern. The cases pin literal boundaries and units, not the shared constants, so a connector set, unit table, or normalization that changes what either side reads fails the suite.

## Alternatives considered

**Make the specification parser import the novelty parser directly.** Rejected: the two sites need different acceptance — the specification side genuinely requires a unit, because a unitless comparison in a draft is a drafting defect worth reporting, while the novelty side must stay permissive so it does not lose evidence. Sharing the syntax while keeping each site's constraint is the smaller change than sharing one parser and parameterizing its strictness at every call.

**Leave both patterns and add a test that pins their then-current difference.** Rejected: the difference was not a contract anyone chose. Pinning it would have documented a defect and made the next divergence look intentional.

**Have the novelty side adopt the specification pattern.** Rejected: requiring a trailing unit on the novelty side would drop unitless ranges from novelty evidence — a silent loss of evidence in the consumer whose output carries examination weight.

## Consequences

The shared vocabulary removes a class of divergence rather than one instance: a connector, a unit spelling, or a normalization rule the two sides must agree on has one definition, and the only remaining difference between the sides is the constraint each genuinely needs. Both sides accept Chinese units and the connectors `–` and `—`; the specification side alone requires a trailing unit.

The stronger shape the proposal preferred — one shared range pattern — did not ship. Each site keeps its own pattern, which is the variant the proposal recorded as its fallback, so the agreement suite carries the whole guarantee rather than the pattern construction. That is why the case table records literal boundaries and normalized units instead of deriving them from the constants: a shared pattern would have made the two sites agree by construction, and without it the test is the only thing that notices a drift.

Adding a third consumer means importing the same vocabulary values and keeping its own acceptance rule; it does not mean a new vocabulary.
