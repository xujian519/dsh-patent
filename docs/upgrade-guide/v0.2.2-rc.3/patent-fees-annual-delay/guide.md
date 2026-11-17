---
kind: upgrade-guide
description: "patent_fees reports the annual-fee surcharge as pending when one lateMonths covers several patent years."
---

# One annual-fee delay per `patent_fees` call

English | [中文](guide.zh.md)

## Change

`patent_fees` and `computeFees` used to apply one `lateMonths` to every year in `annuityYears`, so pricing years 4 and 5 with `lateMonths: 3` returned two three-month surcharges and a total marked complete, although the two fees fall due twelve months apart. A call that names more than one year together with `lateMonths` now returns no surcharge line: the report lists `annual-fee-late-payment` under `pending`, requiring `lateMonths` for each year, and withholds the total, while each year's annual fee stays priced.

## Migration

1. Split a multi-year `patent_fees` call that carries `lateMonths` into one call per delayed year, for example `annuityYears: [4], lateMonths: 3` and then `annuityYears: [5], lateMonths: 1`.
2. Confirm with `pnpm exec vitest run packages/patent/patent-fees/tests/compute.spec.ts packages/patent/patent-fees/tests/deadline-consistency.spec.ts`.
