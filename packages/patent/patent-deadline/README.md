---
description: "Function plugin computing the Chinese patent statutory and designated deadlines of one case: the period arithmetic and delivery rules of 专利法实施细则 (periods counted from the dispatch date), a shipped State Council holiday calendar for rest-day roll-forward, and the patent_deadlines tool."
kind: "package-reference"
---

# @deepseek-ai/dsh-patent-deadline

English | [中文](README.zh.md)

## Summary

Function plugin computing the Chinese patent statutory and designated deadlines of one case: the period arithmetic and delivery rules of 专利法实施细则 (periods counted from the dispatch date), a shipped State Council holiday calendar for rest-day roll-forward, and the patent_deadlines tool.

## Table of Contents

- [patent_deadlines tool](#patent_deadlines-tool)
- [Period and delivery arithmetic (library API)](#period-and-delivery-arithmetic-library-api)
- [Work calendar asset](#work-calendar-asset)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="patent_deadlines-tool"></a>
## patent_deadlines tool

patent_deadlines reports the deadline set of one case from its patent category, filing date, whether it claims priority, the notices it has received, and the case dates that start a period of their own (the grant publication date, a marketing approval date, an invalidation request date). Each entry carries its reported end date, the period's own end date, remaining days, status, and the article it comes from.

Two inputs are deliberate rather than inferred. **Whether the case claims priority** is supplied by the agent or the human handling the case: it decides whether the substantive-examination request is counted from the priority date (the start the office uses in practice) or from the filing date, so a half-filled record must not flip it silently — a priority date without a claim, or a claim without a date, fails the call. **The roll-forward criterion** selects between the statutory reading and the un-rolled one; both end dates are always returned.

Periods that a notice starts — registration and divisional filing at the grant notice, reexamination at the rejection decision, and the office-action, reexamination-notice, and invalidation periods at the delivered document — are reported as pending entries naming the exact notice delivery record still missing. The tool never approximates them from the filing date. A notice recorded with an incomplete delivery record (for example an electronic notice with neither a dispatch nor an entry date) is also reported as pending, naming the missing field, instead of failing the whole query. Annual fees are numbered from the granted patent year, so they too wait for the grant publication date; they stop at the last year of the patent term, and `paidThroughYear` omits fees already recorded as paid. Each annual fee carries its six-month surcharge window: the window starts on the fee's reported (rolled) due date and ends six months later, rolled under the same criterion, with a `calendarCaveat` when that end year has no loaded arrangement.

The designated first office-action period defaults by procedure: four months in substantive examination for an invention, two months in preliminary examination for a utility model or a design. A notice may record `stage` (`substantive` or `preliminary`) to override that default: an invention can also receive a preliminary-examination action, while a substantive stage applies only to an invention. The reexamination-notice answer defaults to one month. A notice may record `designatedMonths`, and only the office-action, reexamination-notice, and invalidation-transfer kinds accept it: the entry into substantive examination (three months), the rejection decision (three months), and the grant notice (two months) start periods the law fixes, so a designated length on those kinds fails the query and names the article. PCT fees are two distinct periods: the application fee, publication printing fee, and any surcharge are entry formalities within the 30-month entry period counted from the priority date (32 months with the grace fee), while the priority claim fee runs two months from the recorded national-phase entry date and stays pending until that date is supplied. Term compensation and new-drug compensation exist only for an invention, priority restoration and addition only for an invention or utility model, and the PCT national phase does not apply to a design; a query that asserts otherwise fails rather than dropping the entry. A design filed before 2021-06-01 keeps the 10-year term of the earlier 专利法第42条, while one filed on or after that day has 15 years.

<a id="period-and-delivery-arithmetic-library-api"></a>
## Period and delivery arithmetic (library API)

The package re-exports the ported rules for direct callers:

- `periodEnd(start, period)` — 细则第5条: the start day is not counted, a month or year period ends on the corresponding day of its last month, and a month with no corresponding day ends on its last day. `1999-12-31` plus two months is `2000-02-29`.
- `resolveDeliveryMode(request)` — an omitted mode means electronic delivery.
- `resolveDeliveryDate(request)` — 细则第4条 as revised and the 2023 审查指南: a designated or statutory period is counted from the delivery date, which for electronic delivery is the day the document enters the electronic system and, absent evidence of a later day, the dispatch date it is presumed to be — so the period runs from the dispatch date and carries no 15-day extension. Postal delivery is the evidenced receipt date, otherwise 15 days after dispatch; direct delivery is the hand-over day; service by announcement is one month after publication.
- `WorkCalendar.rollForward(date)` — an end date on a statutory holiday or moved weekly rest day moves to the first working day after it.
- `evaluateDeadlines(query, options)` — assembles the whole set, applies the requested roll-forward criterion, and dates every entry against an explicit `today`.
- `renderDeadlineReport(report, meta)` — the Markdown the tool returns.

All of these are keyless pure functions except the calendar loaders.

<a id="work-calendar-asset"></a>
## Work calendar asset

`assets/work-calendar/cn-holidays.yaml` transcribes the State Council's holiday arrangements, recording both the days off and the weekend days moved to working days. Each year cites the notice it came from. The shipped file covers 2025 (国办发明电〔2024〕12号) and 2026 (国办发明电〔2025〕7号); a new year is appended once its arrangement is published.

A date whose year has no loaded arrangement is not assumed to be a working day: the entry keeps its un-rolled end date and carries a `calendarCaveat` naming the uncovered year, so a report never presents a rest-day roll-forward that was never verified. The un-rolled criterion consults no calendar at all.

<a id="configuration"></a>
## Configuration

Schemastery configuration, every field optional.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| calendarDir | string | packaged asset | Directory holding `cn-holidays.yaml`; must mirror the packaged layout. A missing or invalid file fails the plugin load. |
| reminderLeadDays | number | 30 | Non-negative integer. Warn when an end date falls within this many days. A firm policy, not a legal period. |
| annuityHorizonYears | number | 2 | Years of future annual fees to report, counted from the report day. A policy choice, capped by the patent term. |
| timeZone | string | Asia/Shanghai | IANA zone in which "today" is read. An unusable zone fails the plugin load. |
| provideService | boolean | false | Publish the `patentDeadline` service (see below). Off by default so the agent-preset mount stays tool-only. |
| exposeTool | boolean | true | Register the `patent_deadlines` tool. A service-only root mount sets this to false so no second model-facing tool appears. |

At least one mount role must be enabled: setting both `provideService` and `exposeTool` to false fails the plugin load. A service-only mount does not require the tools service.

<a id="patentdeadline-service"></a>
## `patentDeadline` service (root mount)

A plugin mounted inside an agent preset writes to that preset's isolated tool registry, so a sibling plugin at the profile root — the patent workbench's deadline board, for example — cannot reach the evaluator through the tool registry. A deployment that needs that access registers this package a second time **at the profile root** with `provideService: true` and `exposeTool: false`:

```yaml
- id: patent-deadline-service
  name: '@deepseek-ai/dsh-patent-deadline'
  config: { provideService: true, exposeTool: false }
```

That row publishes the evaluator as the root-scoped `patentDeadline` service without adding a second model-facing tool; the preset row keeps its default `exposeTool: true` for the agent. Registering one package in two rows is safe — only a duplicate loader entry *id* is fatal, and the two rows carry distinct ids.

The service is a pass-through to the pure functions, so no period, delivery, or rest-day rule is restated:

- `evaluate(query, options?)` — the same `DeadlineQuery`/`DeadlineReport` as `evaluateDeadlines`, with `query.today` supplied by the caller so a report is reproducible. `options.reminderLeadDays` overrides the built-in horizon for one call.
- `periodEnd(start, period)`, `resolveDeliveryDate(request)`, `describePatentKind(kind)` — the library functions above.
- `calendarCoverage()` — `{ years }`, the years the loaded arrangement covers. A consumer uses this to warn that an end date's year is unverified instead of showing a roll-forward that was never checked.

Dates cross the boundary as `{ year, month, day }` objects, so a consumer never re-parses the calendar. A consumer probes the service (`ctx.get('patentDeadline')`) rather than injecting it, so it still loads when the deployment has not wired the service.

## Model Experience

### patent_deadlines tool

#### What the model sees

One registered tool named `patent_deadlines` with a required `patentType` enum (`invention`, `utility-model`, `design`), `filingDate`, and `claimsPriority`, plus optional `priorityDate`, `isPctNationalPhase`, `nationalPhaseEntryDate`, `authorizationPublicationDate`, `marketingApprovalDate`, `termCompensationYears`, `invalidationRequestDate`, `paidThroughYear`, `restDayRule`, and `notices` (each with a document kind, a delivery mode defaulting to electronic, the matching delivery date, an optional designated length in months, and for a first office action an optional `stage`). A notice kind a case receives more than once (`office-action-subsequent`, `reexamination-notice`) may be supplied several times and yields one entry per record, the first under the plain id and the rest under `<id>-2`, `<id>-3`; every other kind is issued once in a case, and a second record of it is a tool error rather than a silent override. The invalidation period for adding grounds or evidence (细则第71条) counts from `invalidationRequestDate` and stays pending, naming that input, until the case records it. The result renders as a Markdown table of computed deadlines with the reported and un-rolled end dates, remaining days, status, and legal basis, followed by the delivery rule that started each notice-driven period, the pending entries that name the missing notice delivery, the unverified-calendar warning, and the recovery and extension rules that apply once something is overdue. A `claimsPriority`/`priorityDate` contradiction comes back as a tool error naming both fields.

#### Token effect

Fixed definition cost on every request while the tool is enabled; each result is one short table plus a pending list, resent only until compaction.

#### KV Cache effect

Append-only; newly visible result prose follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **The holiday calendar ships 2025-2026 only** — an end date beyond those years is reported un-rolled with a `calendarCaveat`. Extend the shipped asset (or point `calendarDir` at your own) before relying on a far-future end date that lands on a weekend. The un-rolled criterion (`restDayRule: 'omit'`) is unaffected.
- **The un-rolled criterion is for recording the period, not for acting** — it reports each period's own end date for records whose subject is the period itself; answering, paying, and filing deadlines still carry the statutory roll-forward.
- **The granted patent year is derived from the grant publication date** — the entry for each annual fee assumes the standard case where the granted year is the patent year containing that date, so fees for a case granted before its first annuity year are not modelled.
- **Paid annual fees need `paidThroughYear`** — without it, every fee inside the report horizon is reported, including historical fees that the case file may already record as paid; the input omits all years up to and including the one given.
- **Recovery and extension are advice, not rows** — 细则第6条 recovery windows and the guideline's two-month extension are stated in the report when a recoverable entry is overdue, but they are not computed as their own deadlines because they start from a lapse notice this tool does not take as input. The report states that the patent term and the priority window are excluded from recovery (细则第6条第5款). The extension sentence names its exception: a period the Office designates in an invalidation proceeding cannot be extended (细则第75条).
- **The current day is not a tool input** — it is read from the host clock in `timeZone` (default Asia/Shanghai), so the "as of" date follows the patent office's calendar and a model cannot date a report against an invented day.
- **Patent-term compensation amounts are not computed** — the request deadline for 专利法第42条第2款 and 第3款 is reported, and a granted compensation length is supplied as `termCompensationYears`; calculating that length under 细则第78条、第82条 is out of scope.
- **Priority is a claim, not a derivation** — the tool states the start date it used but does not judge whether a priority claim is valid or timely; that is the case file's question.
- **No case-record integration** — notices are supplied per call; nothing here reads or writes a case file.

### Dev Note

None.

This package publishes no invariant companion: it holds no persistent state or events, every export is a pure function over an explicit query, and the only asset it reads is validated fail-loud at plugin load.
