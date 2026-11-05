---
description: "Function plugin pricing a Chinese patent case's official fees from the fee index shipped with the package: the items a case owes with each one's counting basis, fee reduction, annual-fee tiers and the late-payment surcharge, and the patent_fees tool, which never states an amount the index cannot support."
kind: "package-reference"
---

# @deepseek-ai/dsh-patent-fees

English | [中文](README.zh.md)

## Summary

Function plugin pricing a Chinese patent case's official fees from the fee index shipped with the package: the items a case owes with each one's counting basis, fee reduction, annual-fee tiers and the late-payment surcharge, and the patent_fees tool, which never states an amount the index cannot support.

## Table of Contents

- [patent_fees tool](#fee-tool)
- [Fee items and counting bases](#fee-items-and-counting-bases)
- [What is recorded and what is not](#what-is-recorded-and-what-is-not)
- [Fee reduction](#fee-reduction)
- [Annual fees and the surcharge](#annual-fees-and-the-surcharge)
- [Library API](#library-api)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="fee-tool"></a>
## patent_fees tool

patent_fees prices one case: it takes the patent type and the steps the case is at, counts each indexed fee item by its basis, applies the case's fee reduction where the index records one, and reports every line with the statutory basis it came from. Each line states whether its amount is verified, and the total is withheld while any applicable line is not verified or any applicable item still needs a case fact.

The tool exists because the patent discipline required fee amounts to be computed by a tool while no tool owned them: the persona and the quality gate both said 费用用工具计算, and the model had nothing to call. It also exists to make a refusal usable: an amount that has not been transcribed is unknown, so the tool hands back the item checklist and names what withholds the sum instead of returning a partial figure that reads as the price.

<a id="fee-items-and-counting-bases"></a>
## Fee items and counting bases

Each item declares the step it is owed at (`trigger`) and how its quantity is counted (`basis`): `per-case`, `per-claim-beyond` and `per-page-beyond` (subtracting the item's `freeUnits`), `per-priority`, `per-annuity-year`, `per-month`. The caller names the case's steps; an item whose step is not named is not priced at all, so the report's coverage is exactly the steps passed in.

```yaml
- id: claims-surcharge
  name: 权利要求附加费
  trigger: filing
  patentTypes: null
  basis: per-claim-beyond
  freeUnits: 10
  amount: '150'
  legalBasis: 专利法实施细则第110条第1款第（一）项
```

<a id="what-is-recorded-and-what-is-not"></a>
## What is recorded and what is not

An item's amount and the dates that support it are transcription content: `amount` (yuan, decimal string), `sourceDoc`, `effectiveFrom`, `verifiedOn`. Three states follow, and the tool reports which one each line is in:

| Status | Meaning |
| --- | --- |
| `verified` | The amount is recorded and so is the date a person checked it against `sourceDoc`. |
| `unverified` | The amount is recorded, its verification date is not. The line shows the figure and says it is unverified. |
| `unrecorded` | No amount is recorded. The line carries applicability and counts and no figure. |

An applicable item whose quantity needs a case fact the call omitted is not a line; it is reported under `pending`, and it keeps the total incomplete just like an unverified line, because summing without it would read as the price of the case.

Most shipped items are `verified`: their amounts come from the fee standard in the National Intellectual Property Administration's payment guide (附件2), each recorded with the document it was copied from and the date of that copy. Fees whose price or rule differs by patent type are separate items — `application-fee` and its `-utility-design` sibling, one annual-fee item per type — because an item states one amount, so a difference by type is a difference between items rather than an amount that drifts with the query.

Two items ship without an amount because the item model cannot state their price: the specification surcharge is charged by page band (50 per page from page 31, 100 per page from page 301) and the extension fee by occurrence (300 per month for a first extension, 2000 for a repeat). They stay `unrecorded` and withhold the total rather than apply one band's price to every unit.

<a id="fee-reduction"></a>
## Fee reduction

`reductions` carries one entry per programme (`individual`, `enterprise`) with `reductionPercent` — the **waived** share, so 85 means 15% is still payable — and `requiresFiling`, which marks a reduction that needs a filed reduction record beforehand. An item joins a reduction only through its own `reducible` flag: `true` joins it, `false` reports that the item is outside the reduction's scope and stays at the full amount, and `null` reports that the scope is not recorded. A year-indexed item also passes `reductionMaxYears`, because a reduction that covers the annual fees from the granted year must not discount the twentieth; a ratio that is not recorded yields no reduced figure at all.

<a id="annual-fees-and-the-surcharge"></a>
## Annual fees and the surcharge

Annual fees are priced one line per patent year. The years come from the caller — `patent_deadlines` owns the dates and reports which years are due — and the amount comes from the item's `tiers` (a year outside the transcribed tiers is reported rather than guessed). A delay on a year adds a surcharge line: `latePayment.monthlyPercent` of that year's full annual fee per started month, up to `latePayment.maxMonths`; past that window the line says so and states no amount, because the fee is no longer payable. When the delayed item records no `latePayment` rule at all, the surcharge line carries no figure and withholds the total, because a missing rule is unknown, not zero.

<a id="library-api"></a>
## Library API

- `loadFeeTable(path?)` / `parseFeeTable(source, origin)` — the index, validated fail-loud.
- `computeFees(table, query, options)` — the priced report: lines, pending items, the reduction outcome, and the total.
- `parseYuan` / `formatFen` / `applyPercent` / `sumFen` — money in integer 分; percentages round half up to the 分.
- `createPatentFeesTool({ table, policy })` — the tool over a loaded index.

No service is published: the index is a read-only asset and the tool is the in-process consumer, so a second consumer imports the library the way `dsh-patent-core` is consumed.

<a id="configuration"></a>
## Configuration

Schemastery configuration; both fields have a default.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| feeTablePath | string | packaged asset | Path of the fee-index YAML file. A missing or malformed file fails the plugin load. |
| failOnUnverified | boolean | `true` | Withhold the total while any applicable line lacks a verified amount or any applicable item is still pending. Turning it off reports a sum over the verified lines only, labelled as partial. |

<a id="model-experience"></a>
## Model Experience

### patent_fees tool

#### What the model sees

One registered tool named `patent_fees` with `patentType` and `triggers` required, and `claims`, `specificationPages`, `priorityClaims`, `annuityYears`, `extensionMonths`, `lateMonths`, and `reduction` optional. The result is the priced lines — id, name, basis, quantity with the basis it was counted from, unit amount, subtotal, payable, status, reduction, legal basis, recorded source, and notes — plus the pending items, the reduction outcome, the total, and the report notes, rendered as a Markdown table followed by the total, the reduction, the pending inputs, and the notes. The tool description states that money is reported only from transcribed amounts, that the total is withheld while any applicable line is not verified or an applicable item is pending, and that an omitted step is not priced.

#### Token effect

Fixed definition cost on every request while the tool is enabled; each result is one table plus a few short sections, resent only until compaction.

#### KV Cache effect

Append-only; newly visible result prose follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **The amounts are a mechanical copy of the official fee standard, not a review.** Each priced item records the document it was copied from and the date of the copy, and the file header states that no qualified person has read the copy back. Re-check an amount against the current standard before invoicing.
- **Two items the index cannot price.** The specification surcharge and the extension fee are charged in bands the item model has no field for, so they ship without an amount and withhold the total whenever they apply. Pricing them exactly needs either a banded price field or the case fact that selects the band.
- **`grant-registration` has no priced item yet.** The index carries no 授权登记费/印花税 row, and the granted-year annual fee needs the grant year. A query naming this trigger reports it under `total.uncoveredTriggers` and withholds the total; it never reports the stage as free. Add the item (with its source and verification date) or map the granted year before relying on a complete total.
- **The annual-fee reduction is approximated by patent year.** The official scope is "the annual fees from the year the patent was granted, for ten years", and the query carries no grant year, so `reductionMaxYears: 10` is a patent-year ceiling. A case granted late reduces more years than this reports.
- **The structural fields were transcribed with the amounts.** `trigger`, `patentTypes`, `basis`, `freeUnits`, `reducible`, `tiers`, and `legalBasis` were re-recorded against the 2023 revision's 实施细则 article 110 and the same fee standard, so the article numbers no longer come from the repository's older statements; verify them against the current announcement before invoicing.
- **Dates belong to `patent_deadlines`.** The tool takes `annuityYears` and `lateMonths` as inputs and computes no date and no started-month count itself, so a caller that has not run `patent_deadlines` cannot learn the years; a delay whose months were counted differently from the deadline package's late-payment window will disagree with it.
- **Percentages round half up to the 分** as an arithmetic convention of this package, stated once in `money.ts`; the official standard does not say how a fractional 分 is handled, and a deployment that must match a published rounding should check the difference on the amounts it bills.
- **A service fee, a foreign office fee, and a fee the index does not carry are out of scope.** The index covers the Chinese fee items it lists; the report says nothing about anything else, and its silence is not a zero.
- **Correctness is content-owned, not runtime-observed.** Whether an amount is right is a property of the content, and no runtime observation can falsify it independently; the mechanically checkable parts (index parsing, quantity arithmetic, the statuses, and the refusal to total) are checks the tool runs.

### Dev Note

None.
